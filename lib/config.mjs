/**
 * Plugin-side configuration. The HTTP shim reads `config.json` and exits the
 * process on a bad value; a dsh plugin must not do that, so this module resolves
 * the cordis row config plus environment and `zulu login` fallbacks into the
 * same normalized shape, reporting the first fatal problem instead of exiting.
 *
 * Field names, defaults, and validation live in `../src/config-core.js`, which
 * the shim uses too.
 */

import path from 'node:path';
import os from 'node:os';

import core from '../src/config-core.js';

const { readCliLicense, resolveConfig } = core;

/** Provider route registered with `ctx.llm.registerAdapter()`. */
export const PROVIDER_ID = 'comate';

/** Where the durable session mapping and the device id live by default. */
function defaultStateDir() {
  return path.join(os.homedir(), '.dsh', 'dsh-connect-baiducomate');
}

/** Failure carrying the cordis-independent reason a route cannot serve yet. */
function configFailure(message) {
  return Object.assign(new Error(message), { code: 'INVALID_CONFIG' });
}

/**
 * Unwrap one configuration value. A field declared `volatile()` in the Config
 * schema arrives as a live reference (`{ get() }`) rather than a plain value, so
 * every read has to go through it to see a settings save.
 * @param value - a row config entry, volatile or not.
 * @returns the value as it stands right now.
 */
export function liveValue(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/**
 * Copy a row config with every volatile reference resolved.
 * @param raw - the row's `config` as the loader passes it to `apply`.
 * @returns a detached, plain copy.
 */
export function plainRowConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const plain = {};
  for (const [key, value] of Object.entries(source)) plain[key] = liveValue(value);
  return plain;
}

/**
 * Resolve one plugin row's config into the normalized shape the shared core
 * expects. Never throws: a route that cannot serve reports `error`, and the
 * adapter turns that into a stable `LlmError` only when a request needs it, so
 * a broken Comate deployment cannot stop dsh from booting.
 * @param raw - the row's `config`, volatile references included.
 * @param env - environment overrides, `process.env` in production.
 * @returns the normalized config plus the first fatal problem, if any.
 */
export function resolvePluginConfig(raw = {}, env = process.env) {
  const plain = plainRowConfig(raw);
  // A custom session file moves the device id next to it, so one deployment's
  // state never lands in another's directory.
  const stateDir = typeof plain.sessionsFile === 'string' && plain.sessionsFile.length > 0
    ? path.dirname(plain.sessionsFile)
    : defaultStateDir();
  const { config, problems } = resolveConfig(plain, env, { kind: 'plugin', stateDir });
  return { config, error: problems.length > 0 ? configFailure(problems[0]) : null };
}

/**
 * The dsh tools the Comate server tools already cover, used to decide which
 * client-only tools travel in the `<client_tools>` catalog.
 * @param config - normalized plugin config.
 * @returns the mapped dsh tool names.
 */
export function builtinToolNames(config) {
  return new Set(Object.values(config.toolMap));
}

export { readCliLicense };
