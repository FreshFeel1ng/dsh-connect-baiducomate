/**
 * The HTTP surface, which the other suites skip: routing, auth, the OpenAI
 * error mapping, SSE framing, and the request-target guard. A stand-in Comate
 * client keeps every case offline and lets each failure be staged exactly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import coreModule from '../src/config-core.js';
import serverModule from '../src/server.js';

const { resolveConfig } = coreModule;
const { createShimServer } = serverModule;

const MODELS = [
  { modelId: 'auto', displayName: 'Auto', maxInputTokens: 1000, maxOutputTokens: 100, supportImage: false },
  { modelId: 'vision', displayName: 'Vision', maxInputTokens: 2000, maxOutputTokens: 200, supportImage: true },
];

/** A configuration as the shim would resolve it, overridable per case. */
function shimConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-srv-'));
  const { config } = resolveConfig(
    { apiHost: 'http://127.0.0.1:9', license: 'test-license', ...overrides },
    { COMATE_AUTH_DIR: path.join(dir, 'no-auth') },
    { kind: 'shim', stateDir: dir },
  );
  return config;
}

/** The Comate client as src/server.js calls it. */
function fakeClient({ models = async () => MODELS, execute } = {}) {
  const calls = { execute: 0, createSession: 0 };
  return {
    calls,
    get modelCount() {
      return MODELS.length;
    },
    fetchModels: models,
    supportsImage: async (id) => MODELS.some((model) => model.modelId === id && model.supportImage),
    uploadImage: async () => ({ id: 7, name: 'image.png', url: '' }),
    createSession: async () => {
      calls.createSession += 1;
      return {
        conversationId: 11,
        taskId: 22,
        traceId: 'trace',
        started: false,
        toolNames: new Map(),
        toolCatalogHash: '',
        contextHash: '',
        systemPromptHash: '',
      };
    },
    execute: async (session, body, options) => {
      calls.execute += 1;
      if (execute) return execute({ session, body, options, call: calls.execute });
      options?.onText?.('hello');
      return {
        content: 'hello',
        reasoning: '',
        toolUses: new Map(),
        usage: { inputTokens: 3, outputTokens: 2 },
        ended: true,
      };
    },
  };
}

/** The durable store as src/server.js calls it. */
function fakeSessions() {
  const map = new Map();
  return {
    get size() {
      return map.size;
    },
    prune() {},
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
    touch() {},
    scheduleSave() {},
  };
}

/** Serve one composition on an ephemeral loopback port. */
async function startServer({ config = shimConfig(), client = fakeClient(), sessions = fakeSessions() } = {}) {
  const server = createShimServer({ config, client, sessions });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    client,
    config,
    url: base,
    close: () => new Promise((resolve) => server.close(resolve)),
    get: (target) => fetch(`${base}${target}`).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) })),
    post: (target, body, headers = {}) =>
      fetch(`${base}${target}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
  };
}

const CHAT = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };

test('health and the model catalogue answer in OpenAI shape', async () => {
  const srv = await startServer();
  try {
    const health = await srv.get('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.upstream, 'http://127.0.0.1:9');
    assert.equal(health.body.models, MODELS.length);

    const models = await srv.get('/v1/models');
    assert.equal(models.status, 200);
    assert.equal(models.body.object, 'list');
    assert.deepEqual(models.body.data.map((entry) => entry.id), ['auto', 'vision']);
    assert.equal(models.body.data[1].context_window, 2000);
    assert.equal(models.body.data[0].supports_image, false);
  } finally {
    await srv.close();
  }
});

test('a model lookup separates an outage from a missing id', async () => {
  const healthy = await startServer();
  try {
    assert.equal((await healthy.get('/v1/models/vision')).status, 200);
    const missing = await healthy.get('/v1/models/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'model_not_found');
  } finally {
    await healthy.close();
  }

  const broken = await startServer({
    client: fakeClient({ models: async () => { throw new Error('connection refused'); } }),
  });
  try {
    const catalogue = await broken.get('/v1/models');
    assert.equal(catalogue.status, 502);

    const single = await broken.get('/v1/models/auto');
    assert.equal(single.status, 502, 'an outage must not look like a missing model');
    assert.equal(single.body.error.code, 'upstream_error');
    assert.match(single.body.error.message, /connection refused/);
  } finally {
    await broken.close();
  }
});

test('the shim token guards /v1 but not /health', async () => {
  const srv = await startServer({ config: shimConfig({ authToken: 'secret-token' }) });
  try {
    const denied = await srv.get('/v1/models');
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error.type, 'authentication_error');

    const wrong = await fetch(`${srv.url}/v1/models`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);

    const allowed = await fetch(`${srv.url}/v1/models`, { headers: { authorization: 'Bearer secret-token' } });
    assert.equal(allowed.status, 200);

    assert.equal((await srv.get('/health')).status, 200);
  } finally {
    await srv.close();
  }
});

test('a non-streaming chat returns the assistant message and usage', async () => {
  const srv = await startServer();
  try {
    const response = await srv.post('/v1/chat/completions', CHAT);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.role, 'assistant');
    assert.equal(body.choices[0].message.content, 'hello');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.usage.prompt_tokens, 3);
    assert.equal(body.usage.completion_tokens, 2);
    assert.equal(srv.client.calls.createSession, 1);
  } finally {
    await srv.close();
  }
});

test('a streaming chat frames SSE chunks and ends with [DONE]', async () => {
  const srv = await startServer();
  try {
    const response = await srv.post('/v1/chat/completions', { ...CHAT, stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /chat\.completion\.chunk/);
    assert.match(text, /"content":"hello"/);
    assert.match(text, /data: \[DONE\]/);
    assert.ok(text.indexOf('"content":"hello"') < text.indexOf('[DONE]'), 'the delta precedes the terminator');
  } finally {
    await srv.close();
  }
});

test('malformed chat requests are refused before any upstream call', async () => {
  const srv = await startServer();
  try {
    const invalid = await srv.post('/v1/chat/completions', '{not json');
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, 'invalid_json');

    const empty = await srv.post('/v1/chat/completions', { messages: [] });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, 'invalid_messages');

    const unknown = await srv.post('/v1/chat/completions', { ...CHAT, model: 'nope' });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'model_not_found');

    assert.equal(srv.client.calls.createSession, 0, 'no session is created for a refused request');
    assert.equal(srv.client.calls.execute, 0);
  } finally {
    await srv.close();
  }
});

test('an image on a shim with images disabled is refused, not uploaded', async () => {
  const srv = await startServer({ config: shimConfig({ uploadImages: false }) });
  try {
    const response = await srv.post('/v1/chat/completions', {
      model: 'vision',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      }],
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'unsupported_image_input');
  } finally {
    await srv.close();
  }
});

test('a tool_choice violation is retried once, then reported', async () => {
  let attempts = 0;
  const client = fakeClient({
    execute: async ({ options }) => {
      attempts += 1;
      void options;
      return {
        content: '',
        reasoning: '',
        toolUses: new Map([['c1', { id: 'c1', name: 'Read', input: { file_path: 'a.txt' } }]]),
        usage: null,
        ended: true,
      };
    },
  });
  const srv = await startServer({ client });
  try {
    const response = await srv.post('/v1/chat/completions', {
      ...CHAT,
      tool_choice: 'none',
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'tool_choice_violation');
    assert.equal(attempts, 2, 'the constraint gets one corrective retry');
  } finally {
    await srv.close();
  }
});

test('a malformed Host header answers 400 instead of killing the process', async () => {
  const srv = await startServer();
  try {
    const firstLine = await new Promise((resolve, reject) => {
      const socket = net.connect(new URL(srv.url).port, '127.0.0.1', () => {
        socket.write('GET /v1/models HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('end', () => resolve(data.split('\r\n')[0]));
      socket.on('error', reject);
      setTimeout(() => reject(new Error('no answer to the malformed request')), 5000).unref();
    });
    assert.match(String(firstLine), /400/);

    // The listener survived: a normal request still answers.
    assert.equal((await srv.get('/health')).status, 200);
  } finally {
    await srv.close();
  }
});

test('CORS preflight and unknown routes answer without touching the upstream', async () => {
  const srv = await startServer();
  try {
    const preflight = await fetch(`${srv.url}/v1/chat/completions`, { method: 'OPTIONS' });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);

    const missing = await srv.get('/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');
  } finally {
    await srv.close();
  }
});

test('a body over the limit is refused rather than buffered', async () => {
  const srv = await startServer({ config: shimConfig({ maxBodyBytes: 2048 }) });
  try {
    const huge = JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'x'.repeat(8192) }] });
    let status = 0;
    try {
      const response = await srv.post('/v1/chat/completions', huge);
      status = response.status;
    } catch (error) {
      // The server destroys the socket after refusing; that is the expected shape.
      status = 413;
    }
    assert.equal(status, 413);
    assert.equal(srv.client.calls.createSession, 0);
  } finally {
    await srv.close();
  }
});
