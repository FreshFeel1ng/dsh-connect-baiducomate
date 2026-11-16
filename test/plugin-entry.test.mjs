/**
 * Verifies the dsh-facing entry point: the module a bundle patch row mounts.
 * `@deepseek-ai/dsh-llm` is redirected to a local stand-in, because the real one
 * lives inside the dsh installation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const stubUrl = new URL('./fixtures/dsh-llm-stub.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: stubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const entry = await import('../lib/index.mjs');

/** The smallest cordis context the entry actually uses. */
function fakeContext() {
  const registered = [];
  const effects = [];
  const lines = [];
  return {
    registered,
    effects,
    lines,
    logger: { info: (line) => lines.push(line) },
    get: () => undefined,
    effect: (fn) => {
      effects.push(fn());
    },
    llm: {
      registerAdapter: (providers, adapter) => {
        registered.push({ providers, adapter });
        return () => {};
      },
    },
  };
}

test('the entry exports the cordis plugin contract', () => {
  assert.equal(entry.name, 'comate');
  assert.deepEqual(entry.inject, ['llm']);
  assert.equal(typeof entry.apply, 'function');
  assert.equal(entry.default.name, 'comate');
});

test('apply registers exactly one comate route and logs structured lines', () => {
  const ctx = fakeContext();
  const sessionsFile = path.join(os.tmpdir(), `comate-entry-${process.pid}`, 'sessions.json');
  entry.apply(ctx, { apiHost: 'http://127.0.0.1:1', license: 'license-for-test', sessionsFile });

  assert.equal(ctx.registered.length, 1);
  assert.deepEqual(ctx.registered[0].providers, ['comate']);
  assert.equal(ctx.registered[0].adapter.providerInfo('comate').name, 'Comate');

  // One effect disposes the session store; registration itself is the other side.
  assert.equal(ctx.effects.length, 1);
  assert.equal(typeof ctx.effects[0], 'function');

  const events = ctx.lines.map((line) => JSON.parse(line).event);
  assert.ok(events.includes('llm.registered'));
});

test('a row without deployment values still mounts, and reports the problem', () => {
  const ctx = fakeContext();
  const sessionsFile = path.join(os.tmpdir(), `comate-entry-bad-${process.pid}`, 'sessions.json');
  entry.apply(ctx, { sessionsFile });

  assert.equal(ctx.registered.length, 1);
  const line = ctx.lines.map((text) => JSON.parse(text)).find((payload) => payload.event === 'config.invalid');
  assert.ok(line, 'expected a config.invalid diagnostic');
  assert.match(line.message, /apiHost/);
});
