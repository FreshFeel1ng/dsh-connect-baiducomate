/**
 * Offline checks for the argument translator. Comate streams parameter values
 * as text, so the interesting cases are values dsh would reject on shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import toolsModule from '../src/tools.js';

const { sanitizeInput, buildToolCalls, DEFAULT_TOOL_MAP } = toolsModule;

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    questions: { type: 'array', items: { type: 'object' } },
    multi_select: { type: 'boolean' },
  },
};

function schemasFor(name, schema) {
  return new Map([[name, schema]]);
}

const config = { argumentAliases: {}, toolMap: DEFAULT_TOOL_MAP };

test('repairs a JSON-encoded array argument into a real array', () => {
  const questions = [{ id: 'status', question: '卡住时状态？', options: [{ label: 'A' }] }];
  const input = { questions: JSON.stringify(questions), multi_select: 'false' };
  const out = sanitizeInput('ask_user_question', input, schemasFor('ask_user_question', ASK_SCHEMA), config);

  assert.ok(Array.isArray(out.questions), 'questions must be an array');
  assert.deepEqual(out.questions, questions);
  assert.equal(out.multi_select, false);
});

test('repairs a JSON-encoded object argument into a real object', () => {
  const schema = { type: 'object', properties: { config: { type: 'object', properties: {} } } };
  const out = sanitizeInput('weird_tool', { config: '{"a":1}' }, schemasFor('weird_tool', schema), config);
  assert.deepEqual(out.config, { a: 1 });
});

test('leaves well-shaped arrays and objects untouched', () => {
  const questions = [{ id: 'q' }];
  const out = sanitizeInput('ask_user_question', { questions }, schemasFor('ask_user_question', ASK_SCHEMA), config);
  assert.equal(out.questions, questions);
});

test('honours union types such as ["array","null"]', () => {
  const schema = { type: 'object', properties: { files: { type: ['array', 'null'] } } };
  const out = sanitizeInput('present', { files: '[{"path":"a"}]' }, schemasFor('present', schema), config);
  assert.deepEqual(out.files, [{ path: 'a' }]);
});

test('drops empty values declared as array or object', () => {
  const out = sanitizeInput('ask_user_question', { questions: '', multi_select: 'true' }, schemasFor('ask_user_question', ASK_SCHEMA), config);
  assert.equal('questions' in out, false);
  assert.equal(out.multi_select, true);
});

test('forwards an unparsable string instead of swallowing it', () => {
  const truncated = '[{"id":"status","question":"截断的';
  const out = sanitizeInput('ask_user_question', { questions: truncated }, schemasFor('ask_user_question', ASK_SCHEMA), config);
  assert.equal(out.questions, truncated);
});

test('still coerces scalars and renames aliases', () => {
  const schema = { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } } };
  const out = sanitizeInput('read', { file: 'a.txt', offset: '12', limit: '5' }, schemasFor('read', schema), config);
  assert.deepEqual(out, { file_path: 'a.txt', offset: 12, limit: 5 });
});

test('emitted tool-call arguments carry the array, not a string', () => {
  const questions = [{ id: 'status', options: [{ label: 'A' }] }];
  const state = {
    availableTools: new Set(['ask_user_question']),
    toolSchemas: schemasFor('ask_user_question', ASK_SCHEMA),
    toolUses: new Map([['call-1', { id: 'call-1', name: 'ask_user_question', input: { questions: JSON.stringify(questions) } }]]),
  };
  const [call] = buildToolCalls(state, config);
  const parsed = JSON.parse(call.function.arguments);
  assert.ok(Array.isArray(parsed.questions), 'arguments.questions must survive as an array');
  assert.deepEqual(parsed.questions, questions);
});
