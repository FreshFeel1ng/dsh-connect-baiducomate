'use strict';

const crypto = require('node:crypto');

const { log } = require('./logger');
const {
  MODEL_CACHE_MS,
  UPSTREAM_TIMEOUT_MS,
  IDLE_AFTER_END_MS,
  IDLE_BEFORE_END_MS,
} = require('./constants');

const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Transport failures that are worth another attempt; a programmer error is not. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/**
 * Abort signal that fires on the caller's cancellation or after `ms`.
 *
 * Every request to Comate needs one: the SDK's `fetch` waits forever by
 * default, so a wedged deployment would hang a chat instead of failing it.
 * @param parent - the caller's signal, when there is one.
 * @param ms - deadline in milliseconds.
 * @returns the derived signal plus a `done` cleanup.
 */
function withDeadline(parent, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Number(ms) || UPSTREAM_TIMEOUT_MS));
  timer.unref?.();
  const onAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      parent?.removeEventListener?.('abort', onAbort);
    },
  };
}

/** A timed request, reported as an upstream failure rather than a bare abort. */
function timedOut(stage, ms, parent) {
  if (parent?.aborted) return null;
  return new UpstreamError(`${stage} timed out after ${ms} ms`, 504);
}

function isAbortError(error) {
  return error?.name === 'AbortError';
}

/** Failure raised while talking to the Comate backend. */
class UpstreamError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.body = body;
  }
}

function upstreamError(stage, status, body) {
  return new UpstreamError(`${stage} -> ${status} ${String(body || '').slice(0, 300)}`, status, body);
}

/**
 * Client for Comate's private deployment: model listing, conversation/task
 * creation, and the SSE execute endpoint.
 */
class ComateClient {
  constructor(config) {
    this.config = config;
    this.models = [];
    this.modelsAt = 0;
  }

  get modelCount() {
    return this.models.length;
  }

  headers(extra) {
    const { config } = this;
    return {
      'Content-Type': 'application/json',
      'Accept-Language': 'zh-CN,zh',
      'X-Source': 'COMATE',
      'login-name': encodeURIComponent(config.license),
      'Uuap-login-name': encodeURIComponent(config.license),
      'plugin-version': `${config.ide}-${config.pluginVersion}`,
      'x-skip-fcnap': 'yes',
      ...extra,
    };
  }

  async requestJson(pathname, body, extraHeaders, signal) {
    const deadline = withDeadline(signal, this.config.upstreamTimeoutMs);
    let response;
    try {
      response = await fetch(`${this.config.apiHost}${pathname}`, {
        method: 'POST',
        headers: this.headers(extraHeaders),
        body: JSON.stringify(body),
        signal: deadline.signal,
      });
    } catch (error) {
      const timeout = isAbortError(error) ? timedOut(pathname, this.config.upstreamTimeoutMs, signal) : null;
      if (timeout) throw timeout;
      throw error;
    } finally {
      deadline.done();
    }
    const text = await response.text();
    if (!response.ok) throw upstreamError(pathname, response.status, text);
    return text ? JSON.parse(text) : {};
  }

  async fetchModels(force = false, signal) {
    const now = Date.now();
    if (!force && this.models.length > 0 && now - this.modelsAt < MODEL_CACHE_MS) {
      return this.models;
    }
    const query = new URLSearchParams({
      key: this.config.license,
      type: 'ZULU',
      repoName: '',
      loopVersion: 'v2',
      zuluVersion: this.config.pluginVersion,
      source: 'plugin',
    });
    const deadline = withDeadline(signal, this.config.upstreamTimeoutMs);
    let response;
    let text;
    try {
      response = await fetch(`${this.config.apiHost}/api/v2/api/models/available?${query}`, {
        headers: this.headers(),
        signal: deadline.signal,
      });
      text = await response.text();
    } catch (error) {
      const timeout = isAbortError(error) ? timedOut('models', this.config.upstreamTimeoutMs, signal) : null;
      if (timeout) throw timeout;
      throw error;
    } finally {
      deadline.done();
    }
    if (!response.ok) throw upstreamError('models', response.status, text);
    const payload = text ? JSON.parse(text) : {};
    this.models = Array.isArray(payload.data) ? payload.data : [];
    this.modelsAt = now;
    return this.models;
  }

  async supportsImage(modelId, signal) {
    const models = await this.fetchModels(false, signal).catch(() => []);
    const entry = models.find((model) => model.modelId === modelId);
    return entry?.supportImage === true;
  }

  async uploadImage(url, signal) {
    const maxBytes = this.config.imageMaxBytes || 20 * 1024 * 1024;
    let buffer;
    let mime;
    if (url.startsWith('data:')) {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (!match) throw new UpstreamError('invalid image data URL', 400);
      mime = match[1];
      buffer = Buffer.from(match[2], 'base64');
    } else {
      // A remote image is downloaded under the same deadline as every other
      // call, and its size is checked before the bytes are all in memory.
      const deadline = withDeadline(signal, this.config.upstreamTimeoutMs);
      try {
        const response = await fetch(url, { signal: deadline.signal });
        if (!response.ok) throw new UpstreamError(`image fetch -> ${response.status}`, 400);
        const declared = Number(response.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new UpstreamError(`image too large: ${declared} bytes`, 400);
        }
        mime = (response.headers.get('content-type') || 'image/png').split(';')[0];
        buffer = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        const timeout = isAbortError(error) ? timedOut('image fetch', this.config.upstreamTimeoutMs, signal) : null;
        if (timeout) throw timeout;
        throw error;
      } finally {
        deadline.done();
      }
    }
    if (!SUPPORTED_IMAGE_MIMES.has(mime)) {
      throw new UpstreamError(`unsupported image type: ${mime}`, 400);
    }
    if (buffer.length > maxBytes) {
      throw new UpstreamError(`image too large: ${buffer.length} bytes`, 400);
    }

    const extension = mime.split('/')[1].replace('jpeg', 'jpg');
    const name = `image-${Date.now()}.${extension}`;
    const deadline = withDeadline(signal, this.config.upstreamTimeoutMs);
    let response;
    let text;
    try {
      response = await fetch(
        `${this.config.apiHost}/api/aidevops/autocomate/rest/autowork/v1/file/upload`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({
            fileName: name,
            contentType: mime,
            scene: 'Composer',
            fileData: buffer.toString('base64'),
          }),
          signal: deadline.signal,
        },
      );
      text = await response.text();
    } catch (error) {
      const timeout = isAbortError(error) ? timedOut('file/upload', this.config.upstreamTimeoutMs, signal) : null;
      if (timeout) throw timeout;
      throw error;
    } finally {
      deadline.done();
    }
    if (!response.ok) throw upstreamError('file/upload', response.status, text);
    const payload = text ? JSON.parse(text) : {};
    const id = payload?.data?.id;
    if (!id) throw new UpstreamError(`image upload failed: ${String(text).slice(0, 200)}`, 502);
    return { id, name, url };
  }

  async createSession(signal) {
    const { config } = this;
    const traceId = crypto.randomUUID();
    const conversation = await this.requestJson(
      '/api/aidevops/autocomate/rest/autowork/v2/conversation',
      {
        agentId: config.agentId,
        username: config.username,
        ide: config.ide,
        ideVersion: config.ideVersion,
        pluginVersion: config.pluginVersion,
      },
      { 'x-trace-id': traceId },
      signal,
    );
    const conversationId = conversation?.data?.id;
    if (!conversationId) {
      throw new UpstreamError(`conversation create failed: ${JSON.stringify(conversation)}`, 502);
    }
    const task = await this.requestJson(
      '/api/aidevops/autocomate/rest/autowork/v2/task',
      {
        agentInfo: { isProjectAgent: false, agentName: config.agentName },
        agentId: config.agentId,
        conversationId,
        signal: {},
        username: config.username,
        ide: config.ide,
        ideVersion: config.ideVersion,
        pluginVersion: config.pluginVersion,
      },
      { 'x-trace-id': traceId },
      signal,
    );
    const taskId = task?.data?.taskId;
    if (!taskId) throw new UpstreamError(`task create failed: ${JSON.stringify(task)}`, 502);
    log('session.created', { conversationId, taskId });
    return {
      conversationId,
      taskId,
      traceId,
      started: false,
      created: Date.now(),
      lastUsed: Date.now(),
      toolNames: new Map(),
      toolCatalogHash: '',
      contextHash: '',
      systemPromptHash: '',
    };
  }

  async execute(session, body, options = {}) {
    const retries = options.retries ?? 2;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let emitted = false;
      const wrapped = {
        ...options,
        onEvent: (type) => {
          emitted = true;
          options.onEvent?.(type);
        },
        onText: (delta) => {
          emitted = true;
          options.onText?.(delta);
        },
        onReasoning: (delta) => {
          emitted = true;
          options.onReasoning?.(delta);
        },
      };
      try {
        return await this.executeOnce(session, body, wrapped);
      } catch (error) {
        lastError = error;
        if (emitted || options.signal?.aborted) throw error;
        if (!this.isRetryable(error) || attempt === retries) throw error;
        const delay = 1000 * (attempt + 1);
        log('execute.retry', { attempt: attempt + 1, delay, error: String(error.message || error) });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw lastError;
  }

  /**
   * Whether another attempt can plausibly succeed.
   *
   * Only transport failures and the upstream's own throttle/outage signals
   * qualify. Retrying a `TypeError` from this code (or a malformed JSON body)
   * just repeated the same bug three times and hid it behind three delays.
   * @param error - the failure from one attempt.
   * @returns true when a retry is worth the quota.
   */
  isRetryable(error) {
    if (error?.name === 'AbortError') return false;
    if (error instanceof UpstreamError) {
      return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600);
    }
    const code = error?.cause?.code || error?.code;
    return typeof code === 'string' && TRANSIENT_CODES.has(code);
  }

  async executeOnce(session, body, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || this.config.upstreamTimeoutMs);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();

    let response;
    try {
      response = await fetch(`${this.config.apiHost}/api/aidevops/autocomate/rest/autowork/v2/execute`, {
        method: 'POST',
        headers: this.headers({
          'x-trace-id': session.traceId,
          'x-query-id': crypto.randomUUID(),
        }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      if (error.name === 'AbortError') throw error;
      throw new UpstreamError(`execute fetch failed: ${error.message}`, 502);
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      throw upstreamError('execute', response.status, text);
    }

    const state = {
      content: '',
      reasoning: '',
      toolUses: new Map(),
      ended: false,
      stopHit: false,
      usage: null,
      sawEvent: false,
    };

    const decoder = new TextDecoder();
    let buffer = '';
    const reader = response.body.getReader();
    let idleTimer = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const idleMs = state.ended
        ? this.config.idleAfterEndMs || IDLE_AFTER_END_MS
        : this.config.idleBeforeEndMs || IDLE_BEFORE_END_MS;
      idleTimer = setTimeout(() => reader.cancel().catch(() => {}), idleMs);
    };

    try {
      while (true) {
        armIdle();
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let event;
          try {
            event = JSON.parse(raw);
          } catch {
            continue;
          }
          state.sawEvent = true;
          if (handleEvent(event, state, options)) {
            state.stopHit = true;
            reader.cancel().catch(() => {});
            break;
          }
        }
        if (state.stopHit) break;
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      reader.cancel().catch(() => {});
    }
    return state;
  }
}

/**
 * Fold one streamed parameter fragment into the accumulated input.
 *
 * Comate streams parameter values as text, so strings accumulate. An event that
 * re-sends the whole value instead of a fragment (the end-of-call event does,
 * on some deployments) would otherwise double the arguments — a value that
 * starts with everything accumulated so far is that re-send, not a fragment.
 */
function mergePartial(target, partial) {
  if (!partial || typeof partial !== 'object') return target;
  for (const [key, value] of Object.entries(partial)) {
    const current = target[key];
    if (typeof value === 'string' && typeof current === 'string') {
      if (value === '') continue;
      if (value === current) continue;
      target[key] = value.length > current.length && value.startsWith(current) ? value : current + value;
    } else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      target[key] = mergePartial(current, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function findStopSequence(text, stops) {
  let best = null;
  for (const stop of stops || []) {
    if (!stop) continue;
    const index = text.indexOf(stop);
    if (index !== -1 && (best === null || index < best.index)) best = { index, stop };
  }
  return best;
}

function handleEvent(event, state, options) {
  const content = event?.content;
  if (!content) return false;
  const detail = content.detail || {};
  options.onEvent?.(content.type);

  if (detail.delta) {
    state.content += detail.delta;
    if (options.stopSequences?.length) {
      const hit = findStopSequence(state.content, options.stopSequences);
      if (hit) {
        state.content = state.content.slice(0, hit.index);
        state.toolUses.clear();
        return true;
      }
    } else {
      options.onText?.(detail.delta);
    }
  }
  if (detail.reasoningDelta) {
    state.reasoning += detail.reasoningDelta;
    options.onReasoning?.(detail.reasoningDelta);
  }

  if (Array.isArray(detail.toolUse)) {
    for (const unit of detail.toolUse) {
      if (!unit?.id) continue;
      const existing = state.toolUses.get(unit.id) || { id: unit.id, name: unit.name, input: {} };
      if (unit.name) existing.name = unit.name;
      mergePartial(existing.input, unit.input);
      state.toolUses.set(unit.id, existing);
    }
  }

  if (content.type === 'TOKEN_USAGE' && detail.usage) state.usage = detail.usage;
  if (detail.end === true) state.ended = true;
  if (content.type === 'FUNCTION_CALL_END' && detail.end) state.ended = true;
  return false;
}

module.exports = { ComateClient, UpstreamError };
