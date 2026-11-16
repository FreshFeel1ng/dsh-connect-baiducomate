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
const schemaStubUrl = new URL('./fixtures/schemastery-stub.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: stubUrl, shortCircuit: true };
    if (specifier === '@deepseek-ai/schemastery') return { url: schemaStubUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const entry = await import('../lib/index.mjs');

/** The smallest cordis context the entry actually uses. */
function fakeContext() {
  const registered = [];
  const effects = [];
  const lines = [];
  const configured = [];
  return {
    registered,
    effects,
    lines,
    configured,
    logger: { info: (line) => lines.push(line) },
    get: () => undefined,
    effect: (fn) => {
      effects.push(fn());
    },
    inject: (_services, callback) => {
      callback({
        effect: (fn) => {
          effects.push(fn());
        },
        settings: {
          configure: (policy) => {
            configured.push(policy);
            return () => {};
          },
        },
      });
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

  // One effect disposes the session store, one registers the page policy.
  assert.equal(ctx.effects.length, 2);
  assert.equal(typeof ctx.effects[0], 'function');
  assert.deepEqual(ctx.configured, [{ auto: false }]);

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

test('the exported Config is what dsh builds the plugin form from', () => {
  const schema = entry.Config.toJSON();
  assert.equal(schema.type, 'object');
  for (const key of ['apiHost', 'license', 'displayName', 'modelKey', 'workspacePath', 'emitReasoning', 'forwardTools', 'uploadImages']) {
    const field = schema.dict[key];
    assert.ok(field, `expected a ${key} field`);
    assert.equal(field.meta.volatile, true, `${key} must be editable at runtime`);
  }
  assert.equal(schema.dict.license.meta.role, 'secret', 'license must never be read back');
  assert.equal(schema.dict.emitReasoning.type, 'boolean');
  assert.equal(schema.meta.loose, true, 'fields outside the form must survive a save');
  assert.equal(entry.default.Config, entry.Config);
});

test('a settings save reaches the next request without a remount', () => {
  const ctx = fakeContext();
  const sessionsFile = path.join(os.tmpdir(), `comate-entry-live-${process.pid}`, 'sessions.json');
  const apiHost = { value: 'http://first.example:9359', get() { return this.value; } };
  const license = { value: 'license-one', get() { return this.value; } };
  entry.apply(ctx, { apiHost, license, sessionsFile });

  const adapter = ctx.registered[0].adapter;
  assert.equal(adapter.providerInfo('comate').name, 'Comate');

  apiHost.value = 'http://second.example:9359';
  license.value = 'license-two';
  // Any request re-reads the live references; a provider info call is the cheapest one.
  adapter.providerInfo('comate');

  const applied = ctx.lines
    .map((text) => JSON.parse(text))
    .filter((payload) => payload.event === 'config.applied');
  assert.equal(applied.length, 1, 'expected exactly one applied-config diagnostic');
  assert.equal(applied[0].upstream, 'http://second.example:9359');
  assert.deepEqual(applied[0].changed.sort(), ['apiHost', 'license']);
  assert.equal(applied[0].error, null);
});

