/**
 * Turn one assembled harness request into the "round" the shared core already
 * understands. `src/openai.js#buildExecuteBody` consumes this shape, so the
 * plugin adds block-aware reading here and reuses every byte of the Comate
 * request assembly the HTTP shim uses.
 *
 * Roles on the wire (dsh v2 message vocabulary):
 * - `system`   — the rendered system prompt, one or more messages.
 * - `user`     — a real turn, or producer context (`source.form` is set).
 * - `assistant`— text plus `tool-call` blocks.
 * - `tool`     — one `ToolResultMessage` per call, carrying `toolCallId`.
 * - `developer`— tool-addition/removal bookkeeping; this route declares the
 *                complete tool list every request, so these are ignored.
 */

import messagesModule from '../src/messages.js';

const { sha256 } = messagesModule;

const MAX_CONTEXT_INSTRUCTIONS = 8000;
const MAX_HISTORY_ENTRIES = 12;
const MAX_HISTORY_ENTRY_CHARS = 1200;
const MAX_HISTORY_CHARS = 12000;

/** Flatten one message's content blocks into model-visible text. */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text);
    else if (block?.type === 'image') parts.push('[image]');
    else if (block?.type === 'file') parts.push('[file]');
  }
  return parts.join('\n');
}

/** True for a turn the user actually typed, not a producer's context injection. */
export function isRealUserInput(message) {
  return message?.role === 'user' && !message.source?.form;
}

function imageBlocksOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'image' && block.offloaded !== true);
}

function toolCallBlocksOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block?.type === 'tool-call');
}

const WORKSPACE_PATTERNS = [
  /Current working directory:\s*"([^"]+)"/i,
  /Workspace Path:\s*\n-\s*([^\n\r]+)/i,
  /workspacePath"?\s*[:=]\s*"([^"]+)"/i,
];

/**
 * dsh carries the real workspace in its runtime-context injection. Comate needs
 * it per request, otherwise the agent sees whatever directory dsh was launched
 * from.
 */
function extractWorkspace(messages) {
  for (const message of messages) {
    if (message.role === 'system') continue;
    const text = textOf(message.content);
    for (const pattern of WORKSPACE_PATTERNS) {
      const match = pattern.exec(text);
      if (match) return match[1].trim();
    }
  }
  return '';
}

function collectContextInstructions(messages) {
  const parts = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (message.source?.form === 'instructions') parts.push(textOf(message.content));
  }
  return parts.join('\n\n').slice(0, MAX_CONTEXT_INSTRUCTIONS);
}

function collectHistory(messages) {
  const entries = [];
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') continue;
    if (message.role === 'user') {
      if (!isRealUserInput(message)) continue;
      const text = textOf(message.content);
      if (text.trim()) entries.push({ role: 'user', text });
      continue;
    }
    if (message.role === 'assistant') {
      const parts = [];
      const text = textOf(message.content);
      if (text) parts.push(text);
      for (const call of toolCallBlocksOf(message.content)) {
        parts.push(`[tool call] ${call.name}(${call.arguments})`);
      }
      if (parts.length > 0) entries.push({ role: 'assistant', text: parts.join('\n') });
      continue;
    }
    if (message.role === 'tool') entries.push({ role: 'tool', text: textOf(message.content) });
  }
  return entries;
}

/**
 * Replay the visible history inside the query. Comate keeps its own task on the
 * server; when that task is missing (plugin restart, branch, TTL expiry) this
 * is what keeps the agent from starting over.
 */
export function composeHistoryQuery(messages, currentQuery) {
  let entries = collectHistory(messages);
  if (currentQuery) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].role === 'user' && entries[index].text === currentQuery) {
        entries.splice(index, 1);
        break;
      }
    }
  }
  entries = entries.slice(-MAX_HISTORY_ENTRIES).map((entry) => ({
    ...entry,
    text: entry.text.length > MAX_HISTORY_ENTRY_CHARS ? `${entry.text.slice(0, MAX_HISTORY_ENTRY_CHARS)}…` : entry.text,
  }));
  if (entries.reduce((total, entry) => total + entry.text.length, 0) > MAX_HISTORY_CHARS) {
    entries = entries.slice(-6);
  }
  if (entries.length === 0) return currentQuery;
  const block = entries.map((entry) => `[${entry.role}]\n${entry.text}`).join('\n\n');
  const request =
    currentQuery || 'Continue the task using the tool results above. Do not repeat completed tool calls.';
  return `Earlier conversation in this session (context):\n${block}\n\nCurrent user request:\n${request}`;
}

/**
 * Shape dsh's `ToolSchema[]` like OpenAI tool definitions, which is what the
 * shared catalog/mapping helpers in `src/tools.js` read.
 */
export function asOpenAiTools(toolSchemas) {
  return (toolSchemas || [])
    .filter((tool) => typeof tool?.name === 'string' && tool.name.length > 0)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.parameters || {},
      },
    }));
}

/**
 * Pick the round Comate should execute next.
 * @param messages - `GenerateOptions.messages`.
 * @returns `{ kind: 'query' }` for a fresh user turn, `{ kind: 'tool-results' }`
 *   when the request ends with the tool results the harness just produced.
 */
export function collectRound(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systemPrompt = list
    .filter((message) => message.role === 'system')
    .map((message) => textOf(message.content))
    .filter(Boolean)
    .join('\n\n');
  const contextInstructions = collectContextInstructions(list);
  const workspacePath = extractWorkspace(list);

  const last = list[list.length - 1];
  if (last?.role === 'tool') {
    const results = [];
    let index = list.length - 1;
    while (index >= 0 && list[index].role === 'tool') {
      results.unshift(list[index]);
      index -= 1;
    }
    let assistant = null;
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      if (list[cursor].role === 'assistant' && toolCallBlocksOf(list[cursor].content).length > 0) {
        assistant = list[cursor];
        break;
      }
    }
    return {
      kind: 'tool-results',
      // The shared assembler reads OpenAI-shaped results and calls, so the
      // block vocabulary stops here.
      results: results.map((message) => ({
        tool_call_id: message.toolCallId,
        content: textOf(message.content),
      })),
      assistant: assistant === null ? null : { tool_calls: asToolCalls(assistant) },
      systemPrompt,
      contextInstructions,
      workspacePath,
    };
  }

  let query = '';
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (isRealUserInput(list[index])) {
      query = textOf(list[index].content);
      break;
    }
  }
  return { kind: 'query', query, systemPrompt, contextInstructions, workspacePath };
}

/**
 * OpenAI-shaped `tool_calls` for the assistant turn that produced these results,
 * so `buildExecuteBody` can recover each call's name and arguments.
 */
export function asToolCalls(assistant) {
  if (!assistant) return [];
  return toolCallBlocksOf(assistant.content).map((block, index) => ({
    index,
    id: block.id,
    type: 'function',
    function: { name: block.name, arguments: block.arguments },
  }));
}

/**
 * Images attached to the newest real user turn. Earlier history images are not
 * re-uploaded on every round.
 * @param messages - `GenerateOptions.messages`.
 * @returns the durable image attachment refs to upload for this request.
 */
export function collectLastUserImages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (list[list.length - 1]?.role === 'tool') return [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message.role !== 'user') continue;
    const images = imageBlocksOf(message.content);
    if (images.length > 0) return images.map((block) => block.attachment);
    if (isRealUserInput(message) && textOf(message.content).trim()) return [];
  }
  return [];
}

/**
 * Namespace the durable session by the harness session it belongs to. The
 * runtime stamps `sessionId` on conversation requests; auxiliary one-shot calls
 * (compaction, titles) fall back to a content hash so they still find a task.
 */
export function sessionKeyFor(options, systemPrompt) {
  const sessionId = options.sessionId;
  if (typeof sessionId === 'string' && sessionId.length > 0) return `${sessionId}::${options.model}`;
  const firstUser = (options.messages || []).find((message) => isRealUserInput(message));
  return sha256(`${options.model}\n${systemPrompt}\n${textOf(firstUser?.content)}`);
}
