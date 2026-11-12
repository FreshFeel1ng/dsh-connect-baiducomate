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
    const response = await fetch(`${this.config.apiHost}${pathname}`, {
      method: 'POST',
      headers: this.headers(extraHeaders),
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw upstreamError(pathname, response.status, text);
    return text ? JSON.parse(text) : {};
  }

  async fetchModels(force = false) {
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
    const response = await fetch(`${this.config.apiHost}/api/v2/api/models/available?${query}`, {
      headers: this.headers(),
    });
    const text = await response.text();
    if (!response.ok) throw upstreamError('models', response.status, text);
    const payload = text ? JSON.parse(text) : {};
    this.models = Array.isArray(payload.data) ? payload.data : [];
    this.modelsAt = now;
    return this.models;
  }

  async supportsImage(modelId) {
    const models = await this.fetchModels().catch(() => []);
    const entry = models.find((model) => model.modelId === modelId);
    return entry?.supportImage === true;
  }

  async uploadImage(url) {
    const maxBytes = this.config.imageMaxBytes || 20 * 1024 * 1024;
    let buffer;
    let mime;
    if (url.startsWith('data:')) {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (!match) throw new UpstreamError('invalid image data URL', 400);
      mime = match[1];
      buffer = Buffer.from(match[2], 'base64');
    } else {
      const response = await fetch(url);
      if (!response.ok) throw new UpstreamError(`image fetch -> ${response.status}`, 400);
      buffer = Buffer.from(await response.arrayBuffer());
      mime = (response.headers.get('content-type') || 'image/png').split(';')[0];
    }
    if (!SUPPORTED_IMAGE_MIMES.has(mime)) {
      throw new UpstreamError(`unsupported image type: ${mime}`, 400);
    }
    if (buffer.length > maxBytes) {
      throw new UpstreamError(`image too large: ${buffer.length} bytes`, 400);
    }

    const extension = mime.split('/')[1].replace('jpeg', 'jpg');
    const name = `image-${Date.now()}.${extension}`;
    const response = await fetch(
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
      },
    );
    const text = await response.text();
    if (!response.ok) throw upstreamError('file/upload', response.status, text);
    const payload = text ? JSON.parse(text) : {};
    const id = payload?.data?.id;
    if (!id) throw new UpstreamError(`image upload failed: ${String(text).slice(0, 200)}`, 502);
    return { id, name, url };
  }

  async createSession() {
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

  isRetryable(error) {
    if (error?.name === 'AbortError') return false;
    if (error instanceof UpstreamError) {
      return error.status === 429 || (error.status >= 500 && error.status < 600);
    }
    return true;
  }

  async executeOnce(session, body, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs || UPSTREAM_TIMEOUT_MS);
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
      const idleMs = state.ended ? IDLE_AFTER_END_MS : IDLE_BEFORE_END_MS;
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

function mergePartial(target, partial) {
  if (!partial || typeof partial !== 'object') return target;
  for (const [key, value] of Object.entries(partial)) {
    const current = target[key];
    if (typeof value === 'string' && typeof current === 'string') {
      target[key] = current + value;
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
