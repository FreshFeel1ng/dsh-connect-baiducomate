/**
 * Offline checks for the adapter's request conversion and stream translation.
 * A fake Comate client stands in for the network, so this runs anywhere.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import openaiModule from '../src/openai.js';
import { resolvePluginConfig } from '../lib/config.mjs';
import { collectRound, asOpenAiTools, asToolCalls, collectLastUserImages, sessionKeyFor } from '../lib/round.mjs';

const { buildExecuteBody } = openaiModule;

/** Minimal harness error stand-in; the real class comes from @deepseek-ai/dsh-llm. */
class LlmErrorStub extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
  }
}

/** Minimal LlmAdapter stand-in; the real base class comes from @deepseek-ai/dsh-llm. */
class LlmAdapterStub {
  providerInfo(provider) {
    return { provider };
  }

  listModels() {
    return Promise.resolve([]);
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  stream() {
    throw new Error('not implemented by the stub');
  }
}

function text(value) {
  return [{ type: 'text', text: value }];
}

function session(id) {
  return {
    conversationId: 1,
    taskId: 2,
    traceId: 'trace',
    started: false,
    created: Date.now(),
    lastUsed: Date.now(),
    toolNames: new Map(),
    toolCatalogHash: '',
    contextHash: '',
    systemPromptHash: '',
    ...id === undefined ? {} : { conversationId: id },
  };
}

const fakeSessions = {
  get: () => undefined,
  set: () => {},
  touch: () => {},
  prune: () => {},
  scheduleSave: () => {},
};

function deps(client, config) {
  return {
    LlmAdapter: LlmAdapterStub,
    LlmError: LlmErrorStub,
    providerId: 'comate',
    config,
    configError: null,
    client,
    sessions: fakeSessions,
    log: () => {},
    readImage: async () => 'data:image/png;base64,AAAA',
  };
}

function fakeClient(state) {
  return {
    modelCount: 1,
    calls: [],
    async fetchModels() {
      return [{ modelId: 'm1', displayName: 'Model One', maxInputTokens: 100000, supportImage: true }];
    },
    async createSession() {
      return session();
    },
    async supportsImage() {
      return true;
    },
    async uploadImage(url) {
      return { id: 'img-1', name: 'image.png', url };
    },
    async execute(_session, body, options) {
      this.calls.push(body);
      for (const delta of state.deltas || []) options.onText?.(delta);
      for (const delta of state.reasoningDeltas || []) options.onReasoning?.(delta);
      return {
        content: state.content ?? '',
        reasoning: state.reasoning ?? '',
        toolUses: state.toolUses ?? new Map(),
        usage: state.usage ?? null,
        ended: true,
        stopHit: false,
      };
    },
  };
}

async function collect(iterable) {
  const chunks = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

test('a user turn becomes a query with the system prompt as an override', async () => {
  const { config } = resolvePluginConfig({ apiHost: 'http://host:9359', license: 'lic' }, {});
  const client = fakeClient({ deltas: ['Hello', ' world'], content: 'Hello world', usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3 } });
  const { createComateAdapter } = await import('../lib/adapter.mjs');
  const adapter = createComateAdapter(deps(client, config));
  const messages = [
    { id: 's1', role: 'system', source: { kind: 'system-prompt' }, content: text('You are dsh.') },
    { id: 'u1', role: 'user', source: { kind: 'user' }, content: text('Write a haiku') },
  ];

  const chunks = await collect(adapter.stream({ provider: 'comate', model: 'auto', messages }));

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  );
  assert.deepEqual(chunks[3].block, { type: 'text', text: 'Hello world' });
  assert.deepEqual(chunks[4].usage, { inputTokens: 10, outputTokens: 2, totalTokens: 15, cacheReadTokens: 3 });
  assert.deepEqual(chunks[5].reason, { kind: 'stop' });

  const body = client.calls[0];
  assert.equal(body.query, 'Write a haiku');
  assert.equal(body.isUserQuery, true);
  assert.equal(body.isFirstQuery, true);
  assert.ok(body.contexts.some((context) => context.content.includes('You are dsh.')));
  assert.ok(body.systemReminder.includes('system_override'));
});

test('tool results come back as toolUseResults under the Comate tool name', async () => {
  const { config } = resolvePluginConfig({ apiHost: 'http://host:9359', license: 'lic' }, {});
  const fake = { ...fakeSessions, get: () => session() };
  fake.get = () => ({ ...session(), started: true, toolNames: new Map([['c1', 'Read']]) });
  const client = fakeClient({ deltas: ['done'], content: 'done' });
  const { createComateAdapter } = await import('../lib/adapter.mjs');
  const adapter = createComateAdapter({ ...deps(client, config), sessions: fake });
  const messages = [
    { id: 'u1', role: 'user', source: { kind: 'user' }, content: text('Read the file') },
    {
      id: 'a1',
      role: 'assistant',
      source: { kind: 'model', provider: 'comate', model: 'auto' },
      content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"D:/w/a.txt"}' }],
    },
    { id: 't1', role: 'tool', toolCallId: 'c1', source: { kind: 'tool' }, content: text('file body') },
  ];

  await collect(adapter.stream({ provider: 'comate', model: 'auto', messages }));

  const body = client.calls[0];
  assert.equal(body.isUserQuery, false);
  assert.deepEqual(body.toolUseResults, [
    { id: 'c1', name: 'Read', success: true, params: { file_path: 'D:/w/a.txt' }, message: 'file body' },
  ]);
});

test('Comate tool_use becomes a dsh tool-call block with mapped name and args', async () => {
  const { config } = resolvePluginConfig({ apiHost: 'http://host:9359', license: 'lic' }, {});
  const client = fakeClient({
    content: 'Reading.',
    toolUses: new Map([['c9', { id: 'c9', name: 'Read', input: { path: 'D:/w/a.png' } }]]),
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const { createComateAdapter } = await import('../lib/adapter.mjs');
  const adapter = createComateAdapter(deps(client, config));
  const messages = [
    { id: 'u1', role: 'user', source: { kind: 'user' }, content: text('look at the image') },
  ];
  const tools = [
    { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
    { name: 'read_image', description: 'Read an image', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
  ];

  const chunks = await collect(adapter.stream({ provider: 'comate', model: 'auto', messages, tools }));
  const block = chunks.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call').block;

  assert.equal(block.id, 'c9');
  assert.equal(block.name, 'read_image');
  assert.deepEqual(JSON.parse(block.arguments), { file_path: 'D:/w/a.png' });
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' });
});

test('an empty Comate turn reports EMPTY_RESPONSE instead of a silent stop', async () => {
  const { config } = resolvePluginConfig({ apiHost: 'http://host:9359', license: 'lic' }, {});
  const client = fakeClient({ content: '', usage: { inputTokens: 5, outputTokens: 0 } });
  const { createComateAdapter } = await import('../lib/adapter.mjs');
  const adapter = createComateAdapter(deps(client, config));
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: text('hi') }];

  const chunks = await collect(adapter.stream({ provider: 'comate', model: 'auto', messages }));

  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE');
});

test('listModels and resolveModel read capacities from the Comate catalog', async () => {
  const { config } = resolvePluginConfig({ apiHost: 'http://host:9359', license: 'lic' }, {});
  const { createComateAdapter } = await import('../lib/adapter.mjs');
  const adapter = createComateAdapter(deps(fakeClient({}), config));

  assert.deepEqual(await adapter.listModels('comate'), [
    {
      provider: 'comate',
      id: 'm1',
      name: 'Model One',
      inputModalities: ['text', 'image'],
      context: { contextWindow: 100000 },
    },
  ]);
  assert.deepEqual(await adapter.resolveModel('comate', 'm1'), {
    provider: 'comate',
    id: 'm1',
    name: 'Model One',
    inputModalities: ['text', 'image'],
    context: { contextWindow: 100000 },
  });
  assert.equal(adapter.providerInfo('comate').id, 'comate');
});

test('a missing deployment config fails the request, not the boot', async () => {
  const { config, error } = resolvePluginConfig({}, {});
  assert.ok(error instanceof Error);
  const { createComateAdapter } = await import('../lib/adapter.mjs');
  const adapter = createComateAdapter({ ...deps(fakeClient({}), config), configError: error });
  const messages = [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: text('hi') }];

  await assert.rejects(
    collect(adapter.stream({ provider: 'comate', model: 'auto', messages })),
    (thrown) => thrown.code === 'INVALID_CONFIG',
  );
});

test('round reading keeps producer context out of the user query', () => {
  const messages = [
    { id: 'u1', role: 'user', source: { kind: 'user' }, content: text('refactor the parser') },
    { id: 'u2', role: 'user', source: { kind: 'user', form: 'snapshot' }, content: text('Current working directory: "D:\\w\\repo"\nTime sampled') },
    { id: 'u3', role: 'user', source: { kind: 'user', form: 'instructions' }, content: text('Always run the tests.') },
  ];

  const round = collectRound(messages);
  assert.equal(round.kind, 'query');
  assert.equal(round.query, 'refactor the parser');
  assert.equal(round.workspacePath, 'D:\\w\\repo');
  assert.equal(round.contextInstructions, 'Always run the tests.');
  assert.equal(sessionKeyFor({ model: 'auto', sessionId: 's-1', messages }, round.systemPrompt), 's-1::auto');
});

test('an auxiliary title call gets its own task, never the agent session', () => {
  const agentMessages = [{ id: 'u1', role: 'user', source: { kind: 'user' }, content: text('add a remark field') }];
  const titleMessages = [{ id: 'u1', role: 'user', source: { kind: 'dsh-session-title-llm' }, content: text('Generate the session title') }];
  const agentKey = sessionKeyFor({ model: 'auto', sessionId: 's-1', messages: agentMessages }, 'sys');
  const titleKey = sessionKeyFor({ model: 'auto', sessionId: 's-1', messages: titleMessages }, 'title sys');

  assert.equal(agentKey, 's-1::auto');
  assert.notEqual(titleKey, agentKey);
  assert.equal(titleKey, sessionKeyFor({ model: 'auto', sessionId: 's-1', messages: titleMessages }, 'title sys'));
});

test('images ride only with the newest real user turn', () => {
  const ref = { attachmentId: 'a1', mediaType: 'image/png', bytes: 4, width: 1, height: 1 };
  const withImage = [
    { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'what is this' }, { type: 'image', attachment: ref }] },
  ];
  assert.deepEqual(collectLastUserImages(withImage), [ref]);

  const afterTool = [
    ...withImage,
    { id: 't1', role: 'tool', toolCallId: 'c1', source: { kind: 'tool' }, content: text('ok') },
  ];
  assert.deepEqual(collectLastUserImages(afterTool), []);
});

test('buildExecuteBody consumes the converted round unchanged', () => {
  const { config } = resolvePluginConfig({ apiHost: 'http://host:9359', license: 'lic' }, {});
  const round = {
    kind: 'query',
    query: 'hi',
    systemPrompt: 'sys',
    systemOverride: 'sys',
    contextInstructions: '',
    workspacePath: 'D:/w',
    reminder: '',
    maxTokens: 0,
    tools: asOpenAiTools([{ name: 'glob', description: 'g', parameters: {} }]),
  };
  const body = buildExecuteBody({ config, session: session(), round, modelKey: 'auto' });
  assert.equal(body.query, 'hi');
  assert.equal(body.modelKey, 'auto');
  assert.equal(asToolCalls(null).length, 0);
});
