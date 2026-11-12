'use strict';

const crypto = require('node:crypto');

/**
 * dsh sends the full conversation on every request. These helpers pick the
 * round Comate should execute and reconstruct context when a Comate task is
 * missing (shim restart or a branched dsh session).
 */

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text || '';
        if (part?.type === 'image_url' || part?.type === 'image') return '[image]';
        return '';
      })
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

// dsh appends several context messages with role "user" after the real input.
const CONTEXT_PREFIXES = [
  '<system-reminder>',
  'Current runtime context.',
  'Time sampled while preparing turn',
];

function isContextText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  return CONTEXT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * dsh embeds the real workspace in its runtime-context user message. Comate
 * needs it per request, otherwise the agent sees the shim's static workspace.
 */
function extractWorkspace(messages) {
  const patterns = [
    /Current working directory:\s*"([^"]+)"/i,
    /Workspace Path:\s*\n-\s*([^\n\r]+)/i,
    /workspacePath"?\s*[:=]\s*"([^"]+)"/i,
  ];
  for (const message of messages || []) {
    const text = messageText(message.content);
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (match) return match[1].trim();
    }
  }
  return '';
}

/**
 * dsh carries workspace instructions (CLAUDE.md and similar) in user-role
 * context messages. Comate should see them too, or project rules silently
 * stop applying.
 */
function collectContextInstructions(messages) {
  const parts = [];
  for (const message of messages || []) {
    if (message.role !== 'user') continue;
    const text = messageText(message.content);
    if (!isContextText(text)) continue;
    if (/workspace instructions|Instructions from:|CLAUDE\.md/i.test(text)) {
      parts.push(text);
    }
  }
  return parts.join('\n\n').slice(0, 8000);
}

/**
 * Images attached to the latest real user turn, as data URLs or http(s) URLs.
 * Earlier history images are not re-uploaded on every round.
 */
function collectLastUserImages(messages) {
  const list = messages || [];
  const fromContent = (content) => {
    const urls = [];
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'image_url') {
          const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
          if (url) urls.push(url);
        } else if (part?.type === 'image' && part.source?.data) {
          urls.push(`data:${part.source.media_type || 'image/png'};base64,${part.source.data}`);
        }
      }
    }
    const text = messageText(content);
    const dataUrlPattern = /data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+/gi;
    const matches = text.match(dataUrlPattern);
    if (matches) urls.push(...matches);
    return [...new Set(urls)];
  };

  // Tool-result rounds: images may be returned by read_image or a browser tool.
  for (let index = list.length - 1; index >= 0 && list[index].role === 'tool'; index -= 1) {
    const urls = fromContent(list[index].content);
    if (urls.length > 0) return urls;
  }
  // A tool-result round must not re-upload the original user attachment.
  if (list[list.length - 1]?.role === 'tool') return [];

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (message.role !== 'user') continue;
    const urls = fromContent(message.content);
    if (urls.length > 0) return urls;
    if (messageText(message.content).trim() && !isContextText(messageText(message.content))) return [];
  }
  return [];
}

function collectHistoryEntries(messages) {
  const entries = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      const text = messageText(message.content);
      if (!isContextText(text)) entries.push({ role: 'user', text });
      continue;
    }
    if (message.role === 'assistant') {
      const parts = [];
      const text = messageText(message.content);
      if (text) parts.push(text);
      for (const call of message.tool_calls || []) {
        parts.push(`[tool call] ${call.function?.name}(${call.function?.arguments})`);
      }
      if (parts.length > 0) entries.push({ role: 'assistant', text: parts.join('\n') });
      continue;
    }
    if (message.role === 'tool') {
      entries.push({ role: 'tool', text: messageText(message.content) });
    }
  }
  return entries;
}

/**
 * Replay the visible history inside the query. Used when Comate has no task
 * for this conversation, so the agent still sees the original task.
 */
function composeHistoryQuery(messages, currentQuery) {
  let entries = collectHistoryEntries(messages);
  if (currentQuery) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].role === 'user' && entries[index].text === currentQuery) {
        entries.splice(index, 1);
        break;
      }
    }
  }
  entries = entries.slice(-12).map((entry) => ({
    ...entry,
    text: entry.text.length > 1200 ? `${entry.text.slice(0, 1200)}…` : entry.text,
  }));
  if (entries.reduce((total, entry) => total + entry.text.length, 0) > 12000) {
    entries = entries.slice(-6);
  }
  if (entries.length === 0) return currentQuery;
  const block = entries.map((entry) => `[${entry.role}]\n${entry.text}`).join('\n\n');
  const request =
    currentQuery || 'Continue the task using the tool results above. Do not repeat completed tool calls.';
  return `Earlier conversation in this session (context):\n${block}\n\nCurrent user request:\n${request}`;
}

function collectRound(messages) {
  const systemPrompt = messages
    .filter((message) => message.role === 'system')
    .map((message) => messageText(message.content))
    .filter(Boolean)
    .join('\n\n');
  const contextInstructions = collectContextInstructions(messages);

  const last = messages[messages.length - 1] || {};
  if (last.role === 'tool') {
    const results = [];
    let index = messages.length - 1;
    while (index >= 0 && messages[index].role === 'tool') {
      results.unshift(messages[index]);
      index -= 1;
    }
    let assistant = null;
    for (let i = index; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant' && Array.isArray(messages[i].tool_calls)) {
        assistant = messages[i];
        break;
      }
    }
    return {
      kind: 'tool-results',
      results,
      assistant,
      systemPrompt,
      contextInstructions,
      workspacePath: extractWorkspace(messages),
      tools: [],
    };
  }

  let query = '';
  if (last.role === 'user') {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role !== 'user') continue;
      const text = messageText(messages[index].content);
      if (!isContextText(text)) {
        query = text;
        break;
      }
    }
  }
  return {
    kind: 'query',
    query,
    systemPrompt,
    contextInstructions,
    workspacePath: extractWorkspace(messages),
    tools: [],
  };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function sessionKey(messages, model) {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => messageText(message.content))
    .join('\n');
  const firstUser = messages.find(
    (message) => message.role === 'user' && !isContextText(messageText(message.content)),
  );
  return crypto
    .createHash('sha256')
    .update(`${model}\n${system}\n${messageText(firstUser?.content)}`)
    .digest('hex');
}

module.exports = {
  messageText,
  isContextText,
  collectHistoryEntries,
  composeHistoryQuery,
  collectRound,
  extractWorkspace,
  collectContextInstructions,
  collectLastUserImages,
  sessionKey,
  sha256,
};
