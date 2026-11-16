'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const { log } = require('./logger');
const { MAX_BODY_BYTES, KEEPALIVE_MS } = require('./constants');
const {
  collectRound,
  composeHistoryQuery,
  collectLastUserImages,
  sessionKey,
  sha256,
} = require('./messages');
const {
  availableToolNames,
  toolSchemas,
  toolCatalogContext,
  buildToolCalls,
} = require('./tools');
const {
  buildExecuteBody,
  usageFrom,
  createCompletionId,
  completionPayload,
} = require('./openai');
const { UpstreamError } = require('./upstream');

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendError(response, status, message, type = 'invalid_request_error', code = null) {
  sendJson(response, status, { error: { message, type, code } });
}

function writeSse(response, data) {
  if (response.writableEnded) return;
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error(`request body too large (limit ${limit} bytes)`), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function openAiErrorFromUpstream(error) {
  if (error instanceof UpstreamError) {
    if (error.status === 401 || error.status === 403) {
      return [error.status, 'Comate rejected the credential; check config.license', 'authentication_error', 'invalid_api_key'];
    }
    if (error.status === 429) {
      return [429, 'Comate rate limit exceeded', 'rate_limit_error', 'rate_limit_exceeded'];
    }
    if (error.status >= 500) {
      return [502, `Comate upstream error: ${error.message}`, 'server_error', 'upstream_error'];
    }
    return [400, error.message, 'invalid_request_error', error.code || 'upstream_error'];
  }
  if (Number(error?.statusCode) >= 400) {
    return [
      Number(error.statusCode),
      String(error.message || error),
      'invalid_request_error',
      error.code || 'invalid_request',
    ];
  }
  return [502, String(error?.message || error), 'server_error', 'upstream_error'];
}

function normalizeStop(stop) {
  if (Array.isArray(stop)) return stop.map(String).filter(Boolean);
  if (typeof stop === 'string' && stop) return [stop];
  return [];
}

/**
 * Build the HTTP server from its dependencies. The entry point owns process
 * lifecycle; this module owns routing and the OpenAI-facing behavior.
 */
function createShimServer({ config, client, sessions }) {
  function authorize(request, response) {
    if (!config.authToken) return true;
    const header = request.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token === config.authToken) return true;
    sendError(response, 401, 'invalid shim token', 'authentication_error', 'invalid_api_key');
    return false;
  }

  async function handleModels(response) {
    let models;
    try {
      models = await client.fetchModels();
    } catch (error) {
      sendJson(response, 502, { error: { message: String(error.message || error), type: 'server_error' } });
      return;
    }
    sendJson(response, 200, {
      object: 'list',
      data: models.map((entry) => ({
        id: entry.modelId,
        object: 'model',
        created: 0,
        owned_by: 'comate',
        name: entry.displayName,
        context_window: entry.maxInputTokens,
        max_tokens: entry.maxOutputTokens,
        supports_image: entry.supportImage === true,
      })),
    });
  }

  async function handleModel(response, id) {
    let models;
    try {
      models = await client.fetchModels();
    } catch (error) {
      // An upstream outage is not "this model does not exist"; reporting 404
      // would have clients drop a perfectly valid model id.
      sendJson(response, 502, {
        error: {
          message: `Comate model catalog unavailable: ${String(error.message || error)}`,
          type: 'server_error',
          code: 'upstream_error',
        },
      });
      return;
    }
    const entry = models.find((model) => model.modelId === id);
    if (!entry) {
      sendError(response, 404, `model not found: ${id}`, 'invalid_request_error', 'model_not_found');
      return;
    }
    sendJson(response, 200, {
      id: entry.modelId,
      object: 'model',
      created: 0,
      owned_by: 'comate',
      name: entry.displayName,
      context_window: entry.maxInputTokens,
      max_tokens: entry.maxOutputTokens,
      supports_image: entry.supportImage === true,
    });
  }

  async function handleChat(request, response, requestId) {
    const startedAt = Date.now();
    const raw = await readBody(request, config.maxBodyBytes);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      sendError(response, 400, 'request body must be valid JSON', 'invalid_request_error', 'invalid_json');
      return;
    }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (messages.length === 0) {
      sendError(response, 400, 'messages must be a non-empty array', 'invalid_request_error', 'invalid_messages');
      return;
    }

    const requestedModel = body.model || 'auto';
    let modelKey = requestedModel;
    if (requestedModel === 'auto') {
      modelKey = config.modelKey;
    } else {
      let models = [];
      try {
        models = await client.fetchModels();
      } catch {
        // Discovery failure must not block a configured model.
      }
      if (models.length > 0 && !models.some((model) => model.modelId === requestedModel)) {
        sendError(
          response,
          404,
          `model not found: ${requestedModel}. Use GET /v1/models for the available ids.`,
          'invalid_request_error',
          'model_not_found',
        );
        return;
      }
    }

    let round = collectRound(messages);
    round.tools = Array.isArray(body.tools) ? body.tools : [];
    const available = availableToolNames(body.tools);
    const schemas = toolSchemas(body.tools);
    const key = sessionKey(messages, requestedModel);

    sessions.prune();
    let session = sessions.get(key);
    if (!session) {
      session = await client.createSession();
      sessions.set(key, session);
      if (round.kind === 'tool-results') {
        round = { ...round, kind: 'query', query: composeHistoryQuery(messages, ''), recovered: true };
      }
    }
    if (!session.started && round.kind === 'query' && !round.recovered) {
      round = { ...round, query: composeHistoryQuery(messages, round.query) };
    }

    // Re-send the client tool catalog whenever the tool set changes, so an
    // existing Comate task learns about MCP tools added mid-session.
    const toolCatalog = toolCatalogContext(body.tools, config);
    const toolCatalogHash = toolCatalog ? sha256(toolCatalog) : '';
    if (toolCatalog && (!session.started || session.toolCatalogHash !== toolCatalogHash)) {
      round.toolCatalog = toolCatalog;
    }

    const contextText = config.forwardContext ? round.contextInstructions : '';
    const contextHash = contextText ? sha256(contextText) : '';
    if (!contextText || (session.started && session.contextHash === contextHash)) {
      round.contextInstructions = '';
    }

    // dsh's authoritative system prompt. The execute API has no `system`
    // field, so the prompt rides as a highest-priority context and a short
    // per-turn reminder asks the model to ignore conflicting Comate identity.
    const systemPromptText = round.systemPrompt || '';
    const systemPromptHash = systemPromptText ? sha256(systemPromptText) : '';
    if (
      config.overrideSystemPrompt &&
      systemPromptText &&
      (!session.started || session.systemPromptHash !== systemPromptHash)
    ) {
      round.systemOverride = systemPromptText;
    }

    // Multimodal: Comate accepts IMAGE contexts containing uploaded file ids.
    const imageUrls = collectLastUserImages(messages);
    if (imageUrls.length > 0) {
      if (!config.uploadImages) {
        sendError(response, 400, 'image input is disabled on this shim', 'invalid_request_error', 'unsupported_image_input');
        return;
      }
      if (imageUrls.length > config.maxImages) {
        sendError(response, 400, `too many images: ${imageUrls.length} (max ${config.maxImages})`, 'invalid_request_error', 'too_many_images');
        return;
      }
      if (requestedModel === 'auto') {
        sendError(response, 400, 'select an image-capable model instead of auto', 'invalid_request_error', 'unsupported_image_input');
        return;
      }
      if (!(await client.supportsImage(requestedModel))) {
        sendError(response, 400, `model ${requestedModel} does not declare image input`, 'invalid_request_error', 'unsupported_image_input');
        return;
      }
      try {
        round.images = await Promise.all(imageUrls.map((url) => client.uploadImage(url)));
      } catch (error) {
        sendError(response, 400, String(error.message || error), 'invalid_request_error', 'image_upload_failed');
        return;
      }
    }

    // OpenAI request controls have no direct execute fields; reminders carry
    // the constraint and the response is validated below.
    const choice = body.tool_choice;
    const forbidTools = choice === 'none';
    const requiredName =
      choice && typeof choice === 'object' && choice.type === 'function' ? choice.function?.name || '' : '';
    const requireTools = choice === 'required' || Boolean(requiredName);
    const constrained = forbidTools || requireTools;
    const baseReminder = forbidTools
      ? 'Do not call any tools in this turn. Answer with text only.'
      : requiredName
        ? `You must call the client tool "${requiredName}" in this turn. Do not answer with plain text or another tool.`
        : requireTools
          ? 'You must call one of the available client tools in this turn. Do not answer with plain text.'
          : '';
    const oneToolReminder = body.parallel_tool_calls === false ? 'Call at most one tool in this turn.' : '';
    const imageHint =
      imageUrls.length > 0
        ? 'The user attached an image. Use read_image with the attachment path to inspect it; do not use read or shell for image files.'
        : '';
    round.reminder = [baseReminder, oneToolReminder, imageHint].filter(Boolean).join('\n');
    round.maxTokens = Number(body.max_tokens || body.max_completion_tokens || 0) || 0;
    const stopSequences = normalizeStop(body.stop);
    if (forbidTools) round.toolCatalog = '';

    const executeBody = buildExecuteBody({ config, session, round, modelKey });
    const stream = body.stream === true;
    const liveStream = stream && !constrained && stopSequences.length === 0;
    const abort = new AbortController();
    let clientClosed = false;
    response.on('close', () => {
      if (!response.writableEnded) {
        clientClosed = true;
        abort.abort();
      }
    });

    log('chat.start', {
      requestId,
      model: requestedModel,
      round: round.kind,
      tools: available.size,
      stream,
      session: `${session.conversationId}/${session.taskId}`,
      workspace: round.workspacePath || config.workspacePath,
      context: round.contextInstructions ? 'forwarded' : '-',
      override: round.systemOverride ? 'forwarded' : '-',
      reminder: round.reminder ? 'yes' : '-',
      images: round.images ? round.images.length : 0,
      stop: stopSequences.length,
      toolsChoice: typeof choice === 'string' ? choice : choice?.type || '-',
      query: String(round.query || '').slice(0, 120),
    });

    let sseOpen = false;
    let keepalive = null;
    const startSse = () => {
      if (sseOpen || response.writableEnded) return;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      sseOpen = true;
      writeSse(response, {
        id: response.locals.completionId,
        object: 'chat.completion.chunk',
        created: response.locals.created,
        model: requestedModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      keepalive = setInterval(() => {
        if (!response.writableEnded) response.write(': keepalive\n\n');
      }, KEEPALIVE_MS);
      keepalive.unref?.();
    };

    const run = (bodyToSend, live) =>
      client.execute(session, bodyToSend, {
        signal: abort.signal,
        stopSequences,
        onText: (delta) => {
          if (!live) return;
          startSse();
          writeSse(response, {
            id: response.locals.completionId,
            object: 'chat.completion.chunk',
            created: response.locals.created,
            model: requestedModel,
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
          });
        },
        onReasoning: (delta) => {
          if (!live || !config.emitReasoning) return;
          startSse();
          writeSse(response, {
            id: response.locals.completionId,
            object: 'chat.completion.chunk',
            created: response.locals.created,
            model: requestedModel,
            choices: [{ index: 0, delta: { reasoning_content: delta }, finish_reason: null }],
          });
        },
      });

    const violatesChoice = (calls) => {
      if (forbidTools) return calls.length > 0;
      if (requiredName) return !calls.some((call) => call.function.name === requiredName);
      if (requireTools) return calls.length === 0;
      return false;
    };

    try {
      let state;
      try {
        state = await run(executeBody, liveStream);
        state.availableTools = available;
        state.toolSchemas = schemas;
        session.started = true;
        let toolCalls = buildToolCalls(state, config);

        if (constrained && violatesChoice(toolCalls)) {
          const strongReminder = forbidTools
            ? 'Retry. Tool calls are forbidden in this turn; reply with text only.'
            : requiredName
              ? `Retry. You must call the client tool "${requiredName}" now; do not reply with text.`
              : 'Retry. You must call one of the available client tools now; do not reply with text.';
          round.reminder = [round.reminder, strongReminder].filter(Boolean).join('\n');
          state = await run(buildExecuteBody({ config, session, round, modelKey }), false);
          state.availableTools = available;
          state.toolSchemas = schemas;
          toolCalls = buildToolCalls(state, config);
          if (violatesChoice(toolCalls)) {
            throw Object.assign(
              new Error(`tool_choice constraint violated: ${JSON.stringify(choice)}`),
              { statusCode: 400, code: 'tool_choice_violation' },
            );
          }
        }
        state.toolCalls = toolCalls;
      } catch (error) {
        if (clientClosed) {
          log('chat.aborted', { requestId });
          if (!response.writableEnded) response.end();
          return;
        }
        throw error;
      }

      let toolCalls = state.toolCalls;
      if (body.parallel_tool_calls === false && toolCalls.length > 1) {
        toolCalls = toolCalls.slice(0, 1);
      }

      session.toolCatalogHash = toolCatalogHash;
      session.contextHash = contextHash;
      session.systemPromptHash = systemPromptHash;
      sessions.touch(session);
      for (const unit of state.toolUses.values()) session.toolNames.set(unit.id, unit.name);
      sessions.scheduleSave();
      if (!state.content && toolCalls.length === 0) {
        throw Object.assign(new Error('Comate returned an empty assistant turn'), {
          statusCode: 502,
          code: 'empty_response',
        });
      }

      const usage = usageFrom(state);
      const finishReason = state.stopHit ? 'stop' : toolCalls.length > 0 ? 'tool_calls' : 'stop';
      if (stream) {
        startSse();
        if (!liveStream && state.content) {
          writeSse(response, {
            id: response.locals.completionId,
            object: 'chat.completion.chunk',
            created: response.locals.created,
            model: requestedModel,
            choices: [{ index: 0, delta: { content: state.content }, finish_reason: null }],
          });
        }
        if (toolCalls.length > 0) {
          writeSse(response, {
            id: response.locals.completionId,
            object: 'chat.completion.chunk',
            created: response.locals.created,
            model: requestedModel,
            choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
          });
        }
        writeSse(response, {
          id: response.locals.completionId,
          object: 'chat.completion.chunk',
          created: response.locals.created,
          model: requestedModel,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage,
        });
        writeSse(response, {
          id: response.locals.completionId,
          object: 'chat.completion.chunk',
          created: response.locals.created,
          model: requestedModel,
          choices: [],
          usage,
        });
        response.write('data: [DONE]\n\n');
        response.end();
      } else {
        sendJson(response, 200, completionPayload({
          model: requestedModel,
          state,
          toolCalls,
          finishReason,
          emitReasoning: config.emitReasoning,
        }));
      }

      log('chat.done', {
        requestId,
        durationMs: Date.now() - startedAt,
        content: state.content.length,
        toolCalls: toolCalls.length,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        // Raw counters, so the cached-vs-prompt question is answerable from a log.
        rawUsage: state.usage ?? null,
      });
    } catch (error) {
      const [status, message, type, code] = openAiErrorFromUpstream(error);
      log('chat.error', {
        requestId,
        status,
        message: String(error.message || error).slice(0, 300),
      });
      if (sseOpen) {
        writeSse(response, { error: { message, type, code } });
        response.write('data: [DONE]\n\n');
        response.end();
      } else {
        sendError(response, status, message, type, code);
      }
    } finally {
      if (keepalive) clearInterval(keepalive);
    }
  }

  const server = http.createServer((request, response) => {
    let url;
    try {
      url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    } catch {
      // A malformed target or Host header used to throw inside this listener,
      // which is an uncaught exception: one request killed the shim. Answer 400
      // and keep serving.
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: { message: 'malformed request target', type: 'invalid_request_error', code: 'bad_request' } }));
      return;
    }
    const requestId = `req_${crypto.randomBytes(4).toString('hex')}`;
    response.locals = {
      completionId: createCompletionId(),
      created: Math.floor(Date.now() / 1000),
    };

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      response.end();
      return;
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        upstream: config.apiHost,
        sessions: sessions.size,
        models: client.modelCount,
      });
      return;
    }

    if (url.pathname.startsWith('/v1/') && !authorize(request, response)) return;

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      handleModels(response).catch((error) => sendError(response, 502, String(error.message || error)));
      return;
    }

    const modelMatch = /^\/v1\/models\/(.+)$/.exec(url.pathname);
    if (request.method === 'GET' && modelMatch) {
      handleModel(response, decodeURIComponent(modelMatch[1])).catch((error) =>
        sendError(response, 502, String(error.message || error)),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      handleChat(request, response, requestId).catch((error) => {
        log('chat.unhandled', { requestId, message: String(error.message || error) });
        if (!response.headersSent) {
          const status = Number(error.statusCode) >= 400 ? Number(error.statusCode) : 500;
          sendError(response, status, String(error.message || error), 'invalid_request_error', 'invalid_request');
        } else {
          response.end();
        }
      });
      return;
    }

    sendError(response, 404, 'not found', 'invalid_request_error', 'not_found');
  });

  server.on('error', (error) => {
    log('server.error', { message: String(error.message || error) });
  });

  return server;
}

module.exports = { createShimServer };
