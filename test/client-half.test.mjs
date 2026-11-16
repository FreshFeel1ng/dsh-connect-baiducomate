/**
 * The browser half, loaded the way dsh loads it (`window.__ModuleLoader__`),
 * with a minimal hook runtime and slot registry stood in. No DOM: the contract
 * checked here is the registration keys, the controls each field gets, and what
 * a save actually sends to the Host.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/**
 * Just enough React to drive the component: a hook slot array that survives a
 * re-render, so a state change is observable the way a real renderer shows it.
 */
function createRuntime() {
  const hooks = [];
  let cursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
      const set = (next) => {
        hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next;
      };
      return [hooks[slot], set];
    },
    useEffect() {
      /* the subscriptions are not exercised here; `subscribe` is asserted separately */
    },
  };

  /** Render a component once, resetting the hook cursor. */
  const render = (Component, props) => {
    cursor = 0;
    return Component(props);
  };

  return { React, render, hooks };
}

/** Evaluate lib/client.js against a module-loader stub and return its exports. */
function loadClient(runtime) {
  let factory;
  vm.runInNewContext(SOURCE, {
    window: {
      __ModuleLoader__: {
        load: (definition) => {
          factory = definition.factory;
        },
      },
    },
    console,
  }, { filename: 'lib/client.js' });
  assert.equal(typeof factory, 'function', 'the bundle must register itself with the module loader');
  return factory((id) => {
    if (id === 'react') return runtime.React;
    throw new Error(`unexpected require: ${id}`);
  });
}

/** A snapshot of an accepted settings entry. */
function snapshot(overrides = {}) {
  return {
    status: 'ready',
    value: { apiHost: 'http://comate.example:9359', license: '', displayName: 'Comate' },
    base: undefined,
    user: { license: 'stored' },
    revision: 7,
    writable: true,
    ...overrides,
  };
}

/** A slot registry that records what the bundle registers, plus a live form. */
function fakeContext({ withForms = true, snap = snapshot(), accept = true } = {}) {
  const registrations = [];
  const mutations = [];
  const subscribers = [];
  const form = {
    getSnapshot: () => snap,
    subscribe: (listener) => {
      subscribers.push(listener);
      return () => {};
    },
    mutate: (ops, revision) => {
      mutations.push({ ops: JSON.parse(JSON.stringify(ops)), revision });
      return Promise.resolve(accept);
    },
  };
  const ctx = {
    registrations,
    mutations,
    subscribers,
    form,
    slots: {
      inject: (_name, callback) => {
        callback();
      },
      register: (options, Component) => {
        registrations.push({ options, Component });
        return () => {};
      },
    },
    get: (id) => (id === 'configForms' && withForms ? { get: () => form } : undefined),
  };
  return ctx;
}

/** Every element in a tree, expanding the stateless child components it contains. */
function elements(tree) {
  const found = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    found.push(node);
    // A child component renders here the way a renderer would call it: it holds no hooks of its own.
    if (typeof node.type === 'function') {
      walk(node.type(node.props));
      return;
    }
    (node.children || []).forEach(walk);
  };
  walk(tree);
  return found;
}

/** Flatten an element tree's text, for asserting on copy. */
function textOf(tree) {
  return elements(tree)
    .filter((node) => typeof node.children !== 'undefined')
    .flatMap((node) => node.children.filter((child) => typeof child === 'string' || typeof child === 'number'))
    .join(' ');
}

test('the bundle exports the client plugin contract', () => {
  const runtime = createRuntime();
  const client = loadClient(runtime);
  assert.equal(client.inject.length, 1);
  assert.equal(client.inject[0], 'slots');
  assert.equal(typeof client.apply, 'function');
});

test('it registers the form under the row key and the bundle key', () => {
  const runtime = createRuntime();
  const client = loadClient(runtime);
  const ctx = fakeContext();
  client.apply(ctx);

  const names = ctx.registrations.map((entry) => entry.options.name).sort();
  assert.equal(names.join(','), 'plugins.bundle.config,plugins.row.config');

  const row = ctx.registrations.find((entry) => entry.options.name === 'plugins.row.config');
  assert.equal(row.options.key, 'dsh-connect-baiducomate#comate');
  const bundle = ctx.registrations.find((entry) => entry.options.name === 'plugins.bundle.config');
  assert.equal(bundle.options.key, 'dsh-connect-baiducomate');
  assert.equal(typeof row.Component, 'function');
});

test('the summary says whether a deployment is configured yet', () => {
  const runtime = createRuntime();
  const client = loadClient(runtime);
  const page = client.__internals.ConfigPage;

  assert.match(textOf(page({ view: 'summary', form: { state: snapshot() } })), /已配置|configured/);
  assert.match(textOf(page({ view: 'summary', form: { state: snapshot({ value: {} }) } })), /没有填|No deployment/);
});

test('the page renders one control per declared field, with the secret masked', () => {
  const runtime = createRuntime();
  const client = loadClient(runtime);
  const ctx = fakeContext();
  client.apply(ctx);
  const row = ctx.registrations.find((entry) => entry.options.name === 'plugins.row.config');

  const tree = runtime.render(row.Component, { view: 'page', form: { state: ctx.form.getSnapshot(), mutate: ctx.form.mutate } });
  const inputs = elements(tree).filter((node) => node.type === 'input').map((node) => node.props);

  assert.equal(inputs.filter((input) => input.type !== 'checkbox').length, 5, 'five string fields');
  assert.equal(inputs.filter((input) => input.type === 'checkbox').length, 3, 'three switches');
  assert.equal(inputs[0].type, 'text');
  assert.equal(inputs[1].type, 'password', 'license is a secret control');
  assert.match(String(inputs[1].placeholder), /已保存|stored/, 'a stored secret reads as set without being echoed');
});

test('saving sends only the drafts, fenced by the revision the page read', async () => {
  const runtime = createRuntime();
  const client = loadClient(runtime);
  const ctx = fakeContext();
  client.apply(ctx);
  const row = ctx.registrations.find((entry) => entry.options.name === 'plugins.row.config');
  const props = { view: 'page', form: { state: ctx.form.getSnapshot(), mutate: ctx.form.mutate } };

  const inputsOf = (tree) => elements(tree).filter((node) => node.type === 'input').map((node) => node.props);
  const buttonsOf = (tree) => elements(tree).filter((node) => node.type === 'button').map((node) => node.props);

  let tree = runtime.render(row.Component, props);
  inputsOf(tree)[0].onChange({ target: { value: 'http://192.168.1.10:9359' } });
  inputsOf(tree)[2].onChange({ target: { value: 'Comate 内网' } });

  tree = runtime.render(row.Component, props);
  const save = buttonsOf(tree).find((button) => button.disabled === false);
  assert.ok(save, 'the save button becomes available once something changed');
  save.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(ctx.mutations.length, 1);
  assert.equal(ctx.mutations[0].revision, 7);
  assert.equal(
    ctx.mutations[0].ops.map((op) => `${op.op}:${op.path.join('.')}`).sort().join(','),
    'set:apiHost,set:displayName',
    'an untouched secret is never restated',
  );

  tree = runtime.render(row.Component, props);
  assert.match(textOf(tree), /已保存|Saved/);
});

test('a refused save keeps the draft and says so', async () => {
  const runtime = createRuntime();
  const client = loadClient(runtime);
  const ctx = fakeContext({ accept: false });
  client.apply(ctx);
  const row = ctx.registrations.find((entry) => entry.options.name === 'plugins.row.config');
  const props = { view: 'page', form: { state: ctx.form.getSnapshot(), mutate: ctx.form.mutate } };

  const inputsOf = (tree) => elements(tree).filter((node) => node.type === 'input').map((node) => node.props);
  const buttonsOf = (tree) => elements(tree).filter((node) => node.type === 'button').map((node) => node.props);

  let tree = runtime.render(row.Component, props);
  inputsOf(tree)[0].onChange({ target: { value: 'http://192.168.1.11:9359' } });
  tree = runtime.render(row.Component, props);
  buttonsOf(tree).find((button) => button.disabled === false).onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));

  tree = runtime.render(row.Component, props);
  assert.match(textOf(tree), /拒绝|refused/);
  // The draft is still there: the field still shows what was typed, not the Host value.
  assert.equal(inputsOf(tree)[0].value, 'http://192.168.1.11:9359');
});

test('an invalid URL blocks the save instead of sending it', () => {
  const runtime = createRuntime();
  const client = loadClient(runtime);
  const ctx = fakeContext();
  client.apply(ctx);
  const row = ctx.registrations.find((entry) => entry.options.name === 'plugins.row.config');
  const props = { view: 'page', form: { state: ctx.form.getSnapshot(), mutate: ctx.form.mutate } };

  const inputsOf = (tree) => elements(tree).filter((node) => node.type === 'input').map((node) => node.props);
  const buttonsOf = (tree) => elements(tree).filter((node) => node.type === 'button').map((node) => node.props);

  let tree = runtime.render(row.Component, props);
  inputsOf(tree)[0].onChange({ target: { value: '192.168.1.10:9359' } });
  tree = runtime.render(row.Component, props);

  assert.equal(buttonsOf(tree)[0].disabled, true, 'save stays disabled');
  assert.match(textOf(tree), /http:\/\/|https:\/\//);
  assert.equal(ctx.mutations.length, 0);
});

test('the host URL is the one field the page validates itself, and a stored secret reads as set', () => {
  const runtime = createRuntime();
  const client = loadClient(runtime);
  const { validateHost, isStored } = client.__internals;

  assert.equal(validateHost('http://192.168.1.10:9359'), null);
  assert.equal(validateHost('https://comate.example'), null);
  assert.equal(validateHost(''), 'missingHost');
  assert.equal(validateHost('192.168.1.10:9359'), 'invalidHost');
  assert.equal(validateHost('ftp://comate.example'), 'invalidHost');

  assert.equal(isStored(snapshot(), 'license'), true);
  assert.equal(isStored(snapshot(), 'apiHost'), false);
  assert.equal(isStored(null, 'license'), false);
});
