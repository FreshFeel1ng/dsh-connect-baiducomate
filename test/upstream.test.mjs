/**
 * Offline checks for the Comate client against a local stand-in server: the
 * streamed-parameter merge, the deadline every call now carries, what counts as
 * retryable, and session creation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import coreModule from '../src/config-core.js';
import upstreamModule from '../src/upstream.js';

const { ComateClient, UpstreamError } = upstreamModule;
const { resolveConfig } = coreModule;

/** Start a stand-in Comate deployment on an ephemeral loopback port. */
async function startComate(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function clientFor(apiHost, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-up-'));
  const { config } = resolveConfig(
    { apiHost, license: 'test-license', ...overrides },
    { COMATE_AUTH_DIR: path.join(dir, 'no-auth') },
    { kind: 'shim', stateDir: dir },
  );
  return new ComateClient(config);
}

function sseHandler(events) {
  return (request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  };
}

const session = {
  conversationId: 1,
  taskId: 2,
  traceId: 'trace',
  started: false,
  toolNames: new Map(),
  toolCatalogHash: '',
  contextHash: '',
  systemPromptHash: '',
};

test('a full value re-sent at call end does not double the arguments', async () => {
  const comate = await startComate(sseHandler([
    { content: { type: 'FUNCTION_CALL_START', detail: { toolUse: [{ id: 'c1', name: 'Read', input: { file_path: '/a' } }] } } },
    { content: { type: 'PARAMS_APPEND', detail: { toolUse: [{ id: 'c1', input: { file_path: '/b' } }] } } },
    // The end event restates everything accumulated so far.
    { content: { type: 'FUNCTION_CALL_END', detail: { end: true, toolUse: [{ id: 'c1', input: { file_path: '/a/b' } }] } } },
  ]));
  try {
    const client = clientFor(comate.url);
    const state = await client.execute(session, { query: 'x' }, { retries: 0 });
    assert.equal(state.toolUses.get('c1').input.file_path, '/a/b');
  } finally {
    await comate.close();
  }
});

test('a genuine fragment sequence still accumulates', async () => {
  const comate = await startComate(sseHandler([
    { content: { type: 'FUNCTION_CALL_START', detail: { toolUse: [{ id: 'c2', name: 'Write', input: {} }] } } },
    { content: { type: 'PARAMS_APPEND', detail: { toolUse: [{ id: 'c2', input: { file_path: 'C:/a' } }] } } },
    { content: { type: 'PARAMS_APPEND', detail: { toolUse: [{ id: 'c2', input: { file_path: '.txt' } }] } } },
    { content: { type: 'FUNCTION_CALL_END', detail: { end: true } } },
  ]));
  try {
    const client = clientFor(comate.url);
    const state = await client.execute(session, { query: 'x' }, { retries: 0 });
    assert.equal(state.toolUses.get('c2').input.file_path, 'C:/a.txt');
  } finally {
    await comate.close();
  }
});

test('a silent deployment fails on the deadline instead of hanging the caller', async () => {
  let release;
  const stuck = new Promise((resolve) => {
    release = resolve;
  });
  const comate = await startComate(() => {
    // Never answers: the deadline has to end the wait.
  });
  try {
    const client = clientFor(comate.url, { upstreamTimeoutMs: 60 });
    const startedAt = Date.now();
    await assert.rejects(
      () => client.fetchModels(false),
      (error) => {
        assert.ok(error instanceof UpstreamError);
        assert.equal(error.status, 504);
        assert.match(error.message, /models timed out/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 5000, 'the deadline fired promptly');
  } finally {
    await comate.close();
    release();
  }
});

test('session creation posts both steps and returns the ids', async () => {
  const seen = [];
  const comate = await startComate((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      seen.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      const payload = request.url.endsWith('/conversation') ? { data: { id: 41 } } : { data: { taskId: 42 } };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  try {
    const client = clientFor(comate.url);
    const created = await client.createSession();
    assert.equal(created.conversationId, 41);
    assert.equal(created.taskId, 42);
    assert.equal(created.started, false);
    assert.equal(seen.length, 2);
    assert.match(seen[0].path, /\/conversation$/);
    assert.match(seen[1].path, /\/task$/);
    assert.equal(seen[1].body.conversationId, 41);
  } finally {
    await comate.close();
  }
});

test('only transport failures and upstream throttle/outage are retryable', () => {
  const client = clientFor('http://127.0.0.1:1');

  assert.equal(client.isRetryable(new UpstreamError('boom', 500)), true);
  assert.equal(client.isRetryable(new UpstreamError('boom', 429)), true);
  assert.equal(client.isRetryable(new UpstreamError('boom', 408)), true);
  assert.equal(client.isRetryable(new UpstreamError('bad request', 400)), false);
  assert.equal(client.isRetryable(new UpstreamError('no credential', 401)), false);

  const reset = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
  assert.equal(client.isRetryable(reset), true);

  const typo = new TypeError('undefined is not a function');
  assert.equal(client.isRetryable(typo), false, 'a programming error must surface immediately');

  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
  assert.equal(client.isRetryable(aborted), false);
});

test('an upstream 500 is reported with its status, not as a transport mystery', async () => {
  const comate = await startComate((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(500, { 'Content-Type': 'text/plain' });
      response.end('upstream exploded');
    });
  });
  try {
    const client = clientFor(comate.url);
    await assert.rejects(
      () => client.execute(session, { query: 'x' }, { retries: 0 }),
      (error) => {
        assert.ok(error instanceof UpstreamError);
        assert.equal(error.status, 500);
        return true;
      },
    );
  } finally {
    await comate.close();
  }
});
