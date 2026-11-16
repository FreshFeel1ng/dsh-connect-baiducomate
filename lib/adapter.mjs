/**
 * The dsh LLM adapter for a Baidu Comate private deployment.
 *
 * dsh drives the agent loop: it sends the assembled conversation, keeps the
 * tools, and executes them locally. Comate runs its own agent loop server-side,
 * so this adapter owns the conversation/task mapping and translates both
 * directions:
 *
 *   dsh message blocks ──▶ execute body ──▶ Comate SSE ──▶ StreamChunk
 *
 * Everything reusable lives in the shared core (`src/`): the SSE client, the
 * durable session store, the tool mapping, and the request assembly the HTTP
 * shim already ships. The class factory keeps this module free of a static
 * `@deepseek-ai/dsh-llm` import, so the core can be tested without dsh loaded.
 */

import toolsModule from '../src/tools.js';
import openaiModule from '../src/openai.js';
import messagesModule from '../src/messages.js';
import { collectLastUserImages, collectRound, asOpenAiTools, composeHistoryQuery, sessionKeyFor } from './round.mjs';

const { availableToolNames, toolSchemas, toolCatalogContext, buildToolCalls } = toolsModule;
const { buildExecuteBody } = openaiModule;
const { sha256 } = messagesModule;

/**
 * Bridge between Comate's push callbacks and the pull an async generator needs.
 * Deltas are queued as they arrive; `finish`/`fail` end the iteration.
 */
function createDeltaQueue() {
  const items = [];
  const waiters = [];
  let done = false;
  let failure = null;
  let result = null;
  const wake = () => {
    for (const resolve of waiters.splice(0)) resolve();
  };
  return {
    push(item) {
      if (done) return;
      items.push(item);
      wake();
    },
    finish(state) {
      if (done) return;
      done = true;
      result = state;
      wake();
    },
    fail(error) {
      if (done) return;
      done = true;
      failure = error;
      wake();
    },
    async * drain() {
      while (true) {
        while (items.length > 0) yield items.shift();
        if (done) {
          if (failure) throw failure;
          return result;
        }
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
  };
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

/** Milliseconds since the request started, for the structured log line. */
function elapsed(startedAt) {
  return Date.now() - startedAt;
}

/**
 * Map a Comate or transport failure onto the provider-neutral failure
 * vocabulary dsh routes on (`RATE_LIMIT`, `SERVER`, `TIMEOUT`, …).
 * @param LlmError - the harness error class supplied by the host.
 * @param error - the thrown upstream or transport error.
 * @param aborted - whether the caller's signal had already aborted.
 * @returns the error to throw out of `stream()`.
 */
function toLlmError(LlmError, error, aborted) {
  if (error instanceof LlmError) return error;
  const status = Number(error?.status);
  if (aborted) return new LlmError('Comate request aborted', 'ABORTED', { cause: error });
  if (isAbortError(error)) return new LlmError('Comate request timed out', 'TIMEOUT', { cause: error });
  if (status === 401 || status === 403) {
    return new LlmError(
      'Comate rejected the credential; check the plugin row license (or COMATE_LICENSE / `zulu login`)',
      'INVALID_CREDENTIAL',
      { cause: error },
    );
  }
  if (status === 429) return new LlmError('Comate rate limit exceeded', 'RATE_LIMIT', { cause: error });
  if (status >= 500) return new LlmError(`Comate upstream error: ${error?.message || error}`, 'SERVER', { cause: error });
  return new LlmError(`Comate request failed: ${error?.message || error}`, 'TRANSPORT', { cause: error });
}

function usageChunk(state) {
  const usage = state?.usage || {};
  const cached = Number(usage.cachedInputTokens ?? usage.cacheRead ?? 0) || 0;
  const input = Number(usage.inputTokens ?? usage.promptTokens ?? 0) || 0;
  const output = Number(usage.outputTokens ?? usage.completionTokens ?? 0) || 0;
  return {
    type: 'usage',
    usage: {
      inputTokens: input,
      outputTokens: output,
      totalTokens: input + cached + output,
      ...(cached > 0 ? { cacheReadTokens: cached } : {}),
    },
  };
}

/**
 * Model catalog lookup shared by `listModels` and `resolveModel`. A discovery
 * failure leaves the route usable for explicitly named models: Comate remains
 * the authority on which ids it accepts.
 */
function catalogOf(deps) {
  return deps.client.fetchModels().catch((error) => {
    deps.log('models.load_failed', { message: String(error?.message || error) });
    return [];
  });
}

function modelInfo(provider, entry) {
  const image = entry.supportImage === true;
  const contextWindow = Number(entry.maxInputTokens);
  return {
    provider,
    id: entry.modelId,
    name: entry.displayName || entry.modelId,
    inputModalities: image ? ['text', 'image'] : ['text'],
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { context: { contextWindow } } : {}),
  };
}

/**
 * Build the request one round needs: session lookup, catalog/context/system
 * bookkeeping, images, and the reminder lines Comate has no field for.
 * @returns the execute body plus the facts the caller reports and stores.
 */
async function prepareRound(deps, options, modelKey) {
  const { config, client, sessions } = deps;
  const round = collectRound(options.messages);
  round.tools = asOpenAiTools(options.tools);
  const available = availableToolNames(round.tools);
  const schemas = toolSchemas(round.tools);
  const key = sessionKeyFor(options, round.systemPrompt);

  sessions.prune();
  let session = sessions.get(key);
  let recovered = false;
  if (!session) {
    session = await client.createSession();
    sessions.set(key, session);
    if (round.kind === 'tool-results') {
      recovered = true;
      round.kind = 'query';
      round.query = composeHistoryQuery(options.messages, '');
      round.results = [];
    }
  }
  if (!session.started && round.kind === 'query' && !recovered) {
    round.query = composeHistoryQuery(options.messages, round.query);
  }

  // Re-send the client tool catalog whenever the tool set changes, so an
  // existing Comate task learns about MCP tools added mid-session.
  const toolCatalog = toolCatalogContext(round.tools, config);
  const toolCatalogHash = toolCatalog ? sha256(toolCatalog) : '';
  if (toolCatalog && (!session.started || session.toolCatalogHash !== toolCatalogHash)) {
    round.toolCatalog = toolCatalog;
  }

  const contextText = config.forwardContext ? round.contextInstructions : '';
  const contextHash = contextText ? sha256(contextText) : '';
  round.contextInstructions = !contextText || (session.started && session.contextHash === contextHash) ? '' : contextText;

  // The execute API has no `system` field, so dsh's authoritative prompt rides
  // as a highest-priority context plus a one-line reminder.
  const systemPromptText = round.systemPrompt || '';
  const systemPromptHash = systemPromptText ? sha256(systemPromptText) : '';
  if (config.overrideSystemPrompt && systemPromptText && (!session.started || session.systemPromptHash !== systemPromptHash)) {
    round.systemOverride = systemPromptText;
  }

  const images = collectLastUserImages(options.messages);
  if (images.length > 0) {
    const { LlmError } = deps;
    if (!config.uploadImages) throw new LlmError('image input is disabled on this Comate route', 'UNSUPPORTED_CONTENT');
    if (images.length > config.maxImages) {
      throw new LlmError(`too many images: ${images.length} (max ${config.maxImages})`, 'UNSUPPORTED_CONTENT');
    }
    if (!(await client.supportsImage(modelKey))) {
      throw new LlmError(`model ${modelKey} does not declare image input`, 'UNSUPPORTED_CONTENT');
    }
    round.images = await Promise.all(images.map(async (ref) => client.uploadImage(await deps.readImage(ref))));
  }

  const noTools = round.tools.length === 0;
  round.reminder = [
    noTools ? 'Do not call any tools in this turn. Answer with text only.' : '',
    images.length > 0
      ? 'The user attached an image. Use read_image with the attachment path to inspect it; do not use read or shell for image files.'
      : '',
  ].filter(Boolean).join('\n');
  round.maxTokens = Number(options.maxTokens) > 0 ? Number(options.maxTokens) : 0;

  return {
    session,
    key,
    round,
    available,
    schemas,
    toolCatalog,
    hashes: { toolCatalogHash, contextHash, systemPromptHash },
    body: buildExecuteBody({ config, session, round, modelKey }),
  };
}

/**
 * Stream one request, translating Comate's SSE events into the harness
 * `StreamChunk` protocol.
 */
async function* streamRound(deps, options) {
  const { LlmError, config, client, sessions, log } = deps;
  const startedAt = Date.now();
  if (deps.configError) throw new LlmError(deps.configError.message, deps.configError.code);

  const requested = typeof options.model === 'string' && options.model.length > 0 ? options.model : config.modelKey;
  const modelKey = requested === 'auto' ? config.modelKey : requested;
  const models = await catalogOf(deps);
  if (models.length > 0 && modelKey !== 'auto' && !models.some((entry) => entry.modelId === modelKey)) {
    throw new LlmError(`Comate has no model "${modelKey}"; check the model list on the Models page`, 'UNKNOWN_MODEL');
  }

  const stopSequences = Array.isArray(options.stop) ? options.stop.filter(Boolean) : [];
  let prepared;
  try {
    prepared = await prepareRound(deps, options, modelKey);
  } catch (error) {
    throw toLlmError(LlmError, error, options.signal?.aborted === true);
  }
  const { session, round, available, schemas, hashes, body } = prepared;

  log('chat.start', {
    source: 'plugin',
    model: requested,
    round: round.kind,
    tools: available.size,
    session: `${session.conversationId}/${session.taskId}`,
    workspace: round.workspacePath || config.workspacePath,
    context: round.contextInstructions ? 'forwarded' : '-',
    override: round.systemOverride ? 'forwarded' : '-',
    images: round.images ? round.images.length : 0,
    stop: stopSequences.length,
    query: String(round.query || '').slice(0, 120),
  });

  const queue = createDeltaQueue();
  const live = stopSequences.length === 0;
  const execution = client.execute(session, body, {
    signal: options.signal,
    stopSequences,
    onText: (delta) => {
      if (live) queue.push({ kind: 'text', text: delta });
    },
    onReasoning: (delta) => {
      if (live && config.emitReasoning) queue.push({ kind: 'reasoning', text: delta });
    },
  });
  execution.then(
    (state) => queue.finish(state),
    (error) => queue.fail(error),
  );

  let nextIndex = 0;
  let textIndex = -1;
  let textBuffer = '';
  let reasoningIndex = -1;
  let reasoningBuffer = '';
  let state;

  try {
    const iterator = queue.drain();
    while (true) {
      const step = await iterator.next();
      if (step.done) {
        state = step.value;
        break;
      }
      const delta = step.value;
      if (delta.kind === 'text') {
        if (textIndex < 0) {
          textIndex = nextIndex;
          nextIndex += 1;
          yield { type: 'block-start', index: textIndex, blockType: 'text' };
        }
        textBuffer += delta.text;
        yield { type: 'text-delta', index: textIndex, text: delta.text };
      } else if (delta.kind === 'reasoning') {
        if (reasoningIndex < 0) {
          reasoningIndex = nextIndex;
          nextIndex += 1;
          yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' };
        }
        reasoningBuffer += delta.text;
        yield { type: 'reasoning-delta', index: reasoningIndex, text: delta.text };
      }
    }
  } catch (error) {
    throw toLlmError(LlmError, error, options.signal?.aborted === true);
  }

  // Buffered mode: the client applied the stop sequences, so only the final
  // text is emitted, never the truncated deltas.
  if (!live && state.content) {
    if (textIndex < 0) {
      textIndex = nextIndex;
      nextIndex += 1;
      yield { type: 'block-start', index: textIndex, blockType: 'text' };
    }
    textBuffer = state.content;
    yield { type: 'text-delta', index: textIndex, text: state.content };
  }
  if (!config.emitReasoning && state.reasoning && reasoningIndex < 0) {
    // Reasoning is off by configuration; nothing to replay.
    reasoningBuffer = '';
  }
  if (reasoningIndex >= 0) {
    yield { type: 'block-end', index: reasoningIndex, block: { type: 'reasoning', text: reasoningBuffer } };
  }
  if (textIndex >= 0) {
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuffer } };
  }

  const toolCalls = buildToolCalls({ ...state, availableTools: available, toolSchemas: schemas }, config);
  for (const call of toolCalls) {
    const index = nextIndex;
    nextIndex += 1;
    yield { type: 'block-start', index, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index, id: call.id, name: call.function.name, argumentsDelta: call.function.arguments };
    yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments } };
  }

  session.started = true;
  session.toolCatalogHash = hashes.toolCatalogHash;
  session.contextHash = hashes.contextHash;
  session.systemPromptHash = hashes.systemPromptHash;
  for (const unit of state.toolUses.values()) session.toolNames.set(unit.id, unit.name);
  sessions.touch(session);
  sessions.scheduleSave();

  log('chat.done', {
    source: 'plugin',
    durationMs: elapsed(startedAt),
    content: textBuffer.length,
    toolCalls: toolCalls.length,
    promptTokens: state?.usage?.inputTokens ?? 0,
    completionTokens: state?.usage?.outputTokens ?? 0,
  });

  if (!textBuffer && reasoningBuffer.length === 0 && toolCalls.length === 0) {
    yield usageChunk(state);
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'Comate returned an empty assistant turn', code: 'EMPTY_RESPONSE' },
      },
    };
    return;
  }

  yield usageChunk(state);
  yield { type: 'finish', reason: toolCalls.length > 0 ? { kind: 'tool-calls' } : { kind: 'stop' } };
}

/**
 * Create the adapter instance the host registers for the `comate` route.
 * @param deps - the harness classes plus the resolved config, shared client,
 *   durable sessions, image reader, and structured logger.
 * @returns a ready `LlmAdapter`.
 */
export function createComateAdapter(deps) {
  const { LlmAdapter } = deps;
  const provider = deps.providerId || 'comate';

  return new (class ComateAdapter extends LlmAdapter {
    providerInfo(id) {
      return { id, name: deps.config.displayName || 'Comate' };
    }

    listModels(id) {
      if (deps.configError) return Promise.reject(new deps.LlmError(deps.configError.message, deps.configError.code));
      return catalogOf(deps).then((models) => models.map((entry) => modelInfo(id || provider, entry)));
    }

    resolveModel(id, model, _signal) {
      if (deps.configError) return Promise.reject(new deps.LlmError(deps.configError.message, deps.configError.code));
      return catalogOf(deps).then((models) => {
        const entry = models.find((candidate) => candidate.modelId === model);
        if (!entry) return { provider: id || provider, id: model, name: model, inputModalities: ['text'] };
        return modelInfo(id || provider, entry);
      });
    }

    stream(options) {
      return streamRound(deps, options);
    }
  })();
}
