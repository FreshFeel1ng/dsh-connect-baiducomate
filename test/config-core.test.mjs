/**
 * Offline checks for the shared configuration resolver: the defaults both forms
 * inherit, the device id that has to survive a restart, and the per-deployment
 * bucketing of the durable session file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import coreModule from '../src/config-core.js';

const { resolveConfig, bucketOf, readOrCreateDevice } = coreModule;

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-cfg-${name}-`));
}

/** An environment that never reaches the real `~/.comate` of the machine running the test. */
function isolatedEnv(dir, extra = {}) {
  return { COMATE_AUTH_DIR: path.join(dir, 'no-auth'), ...extra };
}

test('both forms accept the same row fields and share their defaults', () => {
  const dir = tempDir('shared');
  const raw = { apiHost: 'http://comate.example:9359', license: 'lic', sessionsFile: path.join(dir, 'sessions.json') };

  const plugin = resolveConfig(raw, isolatedEnv(dir), { kind: 'plugin', stateDir: dir });
  const shim = resolveConfig(raw, isolatedEnv(dir), { kind: 'shim', stateDir: dir });

  assert.deepEqual(plugin.problems, []);
  assert.deepEqual(shim.problems, []);
  for (const key of ['apiHost', 'license', 'modelKey', 'forwardTools', 'uploadImages', 'emitReasoning', 'upstreamTimeoutMs']) {
    assert.deepEqual(plugin.config[key], shim.config[key], `${key} must match across forms`);
  }
  // Only the caller-specific fields differ.
  assert.equal(plugin.config.displayName, 'Comate');
  assert.equal(shim.config.port, 8790);
  assert.deepEqual(plugin.config.sessionsFile, raw.sessionsFile);
});

test('a missing deployment is reported, not thrown', () => {
  const dir = tempDir('problems');
  const { config, problems } = resolveConfig({}, isolatedEnv(dir), { kind: 'plugin', stateDir: dir });

  assert.equal(problems.length, 2, 'apiHost and license are both missing');
  assert.match(problems[0], /apiHost/);
  assert.match(problems[1], /license/);
  assert.equal(config.apiHost, '');
  assert.ok(config.sessionsFile, 'a config file path is still produced');

  const badUrl = resolveConfig({ apiHost: 'comate.example:9359', license: 'l' }, isolatedEnv(dir), { kind: 'plugin', stateDir: dir });
  assert.match(badUrl.problems[0], /http\(s\)/);
});

test('the device id survives a restart instead of looking like a new machine', () => {
  const dir = tempDir('device');
  const first = resolveConfig({ apiHost: 'http://a:1', license: 'l' }, isolatedEnv(dir), { kind: 'plugin', stateDir: dir });
  const second = resolveConfig({ apiHost: 'http://a:1', license: 'l' }, isolatedEnv(dir), { kind: 'plugin', stateDir: dir });

  assert.equal(first.config.device, second.config.device);
  assert.equal(fs.readFileSync(path.join(dir, 'device'), 'utf8').trim(), first.config.device);
});

test('an explicit device wins over the stored one, and a new file is created once', () => {
  const dir = tempDir('device-explicit');
  const explicit = resolveConfig({ apiHost: 'http://a:1', license: 'l', device: 'fixed-device' }, isolatedEnv(dir), {
    kind: 'plugin',
    stateDir: dir,
  });
  assert.equal(explicit.config.device, 'fixed-device');

  const file = path.join(dir, 'recreated-device');
  assert.equal(readOrCreateDevice(file), readOrCreateDevice(file));
});

test('session files are bucketed by deployment, so tasks never cross servers', () => {
  const dir = tempDir('bucket');
  const one = resolveConfig({ apiHost: 'http://one:9359', license: 'l' }, isolatedEnv(dir), { kind: 'plugin', stateDir: dir });
  const two = resolveConfig({ apiHost: 'http://two:9359', license: 'l' }, isolatedEnv(dir), { kind: 'plugin', stateDir: dir });
  const again = resolveConfig({ apiHost: 'http://one:9359', license: 'l' }, isolatedEnv(dir), { kind: 'plugin', stateDir: dir });

  assert.equal(one.config.sessionsFile, again.config.sessionsFile);
  assert.notEqual(one.config.sessionsFile, two.config.sessionsFile);
  assert.match(one.config.sessionsFile, new RegExp(bucketOf('http://one:9359')));
});

test('a base64 body for a maximum-size image still fits the shim body limit', () => {
  const dir = tempDir('body');
  const raw = { apiHost: 'http://a:1', license: 'l', imageMaxBytes: 20 * 1024 * 1024 };
  const { config } = resolveConfig(raw, isolatedEnv(dir), { kind: 'shim', stateDir: dir });

  const base64 = Math.ceil((20 * 1024 * 1024 * 4) / 3);
  assert.ok(config.maxBodyBytes > base64, `body limit ${config.maxBodyBytes} must exceed ${base64}`);
});

test('environment overrides win, including the new timeout knobs', () => {
  const dir = tempDir('env');
  const env = isolatedEnv(dir, {
    COMATE_API_HOST: 'http://from-env:9359',
    COMATE_LICENSE: 'env-license',
    COMATE_TIMEOUT_MS: '1234',
    COMATE_IDLE_BEFORE_END_MS: '4321',
    COMATE_MAX_BODY_BYTES: '1048576',
  });
  const { config } = resolveConfig({ apiHost: 'http://from-file:1', license: 'file-license' }, env, {
    kind: 'shim',
    stateDir: dir,
  });

  assert.equal(config.apiHost, 'http://from-env:9359');
  assert.equal(config.license, 'env-license');
  assert.equal(config.upstreamTimeoutMs, 1234);
  assert.equal(config.idleBeforeEndMs, 4321);
  assert.equal(config.maxBodyBytes, 1048576);
});

test('a trailing slash on the deployment address is stripped once', () => {
  const dir = tempDir('slash');
  const { config } = resolveConfig({ apiHost: 'http://a:9359///', license: 'l' }, isolatedEnv(dir), { kind: 'plugin', stateDir: dir });
  assert.equal(config.apiHost, 'http://a:9359');
});
