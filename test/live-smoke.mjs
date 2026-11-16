/**
 * Live smoke test: one real Comate conversation driven through the plugin
 * adapter, with no HTTP shim and no dsh. Consumes Comate quota.
 *
 *   npm run test:live               # uses ./config.json
 *   COMATE_API_HOST=... COMATE_LICENSE=... npm run test:live
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionStore } from '../src/sessions.js';
import { ComateClient } from '../src/upstream.js';
import { resolvePluginConfig } from '../lib/config.mjs';
import { createComateAdapter } from '../lib/adapter.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

class LlmError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
  }
}

class LlmAdapter {
  stream() {
    throw new Error('not used by this script');
  }
}

function loadConfig() {
  const file = path.join(root, 'config.json');
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return resolvePluginConfig(raw).config;
}

function text(value) {
  return [{ type: 'text', text: value }];
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

async function main() {
  const config = loadConfig();
  if (!config.apiHost || !config.license) {
    console.error('live smoke needs apiHost and license: ./config.json or COMATE_API_HOST + COMATE_LICENSE');
    process.exit(2);
  }
  const sessionsFile = path.join(os.tmpdir(), `comate-live-${process.pid}`, 'sessions.json');
  fs.mkdirSync(path.dirname(sessionsFile), { recursive: true });
  const sessions = new SessionStore({ file: sessionsFile, ttlMs: config.sessionTtlMs, max: 4 });
  const client = new ComateClient(config);
  const adapter = createComateAdapter({
    LlmAdapter,
    LlmError,
    providerId: 'comate',
    config,
    configError: null,
    client,
    sessions,
    log,
    readImage: async () => {
      throw new LlmError('no image in this script', 'UNSUPPORTED_CONTENT');
    },
  });

  const models = await adapter.listModels('comate');
  log('models', { count: models.length, first: models[0]?.id });
  if (models.length === 0) throw new Error('Comate returned no models');

  const systemMessage = { id: 'sys', role: 'system', source: { kind: 'system-prompt' }, content: text('Answer in one short sentence.') };
  const sessionId = 'live-smoke';

  const first = [];
  const started = Date.now();
  for await (const chunk of adapter.stream({
    provider: 'comate',
    model: 'auto',
    sessionId,
    messages: [
      systemMessage,
      { id: 'u1', role: 'user', source: { kind: 'user' }, content: text('Reply with exactly the word PONG and nothing else.') },
    ],
  })) {
    first.push(chunk);
  }
  const firstText = first
    .filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
    .map((chunk) => chunk.block.text)
    .join('');
  log('turn1', {
    ms: Date.now() - started,
    chunks: first.length,
    text: firstText.slice(0, 80),
    finish: first.at(-1)?.reason,
    usage: first.find((chunk) => chunk.type === 'usage')?.usage,
  });
  if (!/pong/i.test(firstText)) throw new Error(`turn 1 did not answer PONG: ${firstText}`);

  // Same harness session: the adapter must reuse the Comate conversation/task.
  const second = [];
  for await (const chunk of adapter.stream({
    provider: 'comate',
    model: 'auto',
    sessionId,
    messages: [
      systemMessage,
      { id: 'u1', role: 'user', source: { kind: 'user' }, content: text('Reply with exactly the word PONG and nothing else.') },
      { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'comate', model: 'auto' }, content: text(firstText) },
      { id: 'u2', role: 'user', source: { kind: 'user' }, content: text('What word did you just say? Reply with that single word.') },
    ],
  })) {
    second.push(chunk);
  }
  const secondText = second
    .filter((chunk) => chunk.type === 'block-end' && chunk.block.type === 'text')
    .map((chunk) => chunk.block.text)
    .join('');
  log('turn2', { chunks: second.length, text: secondText.slice(0, 80), finish: second.at(-1)?.reason });
  if (!secondText.trim()) throw new Error('turn 2 returned no text');

  sessions.save();
  const persisted = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
  log('sessions', { keys: Object.keys(persisted).length });
  if (Object.keys(persisted).length !== 1) throw new Error('expected exactly one persisted Comate session');
  log('live.ok', { turns: 2 });
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'live.failed', message: String(error?.message || error), code: error?.code }));
  process.exit(1);
});
