/**
 * Plugin-side configuration. The shim reads config.json and exits the process
 * on a bad value; a dsh plugin must not do that, so this module resolves the
 * cordis row config plus environment and `zulu login` fallbacks into the same
 * normalized shape, reporting the first fatal problem instead of exiting.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

import tools from '../src/tools.js';
import shimConfig from '../src/config.js';
import constants from '../src/constants.js';

const { DEFAULT_TOOL_MAP } = tools;
const { readCliLicense } = shimConfig;

/** Provider route registered with `ctx.llm.registerAdapter()`. */
export const PROVIDER_ID = 'comate';

/** Failure carrying the cordis-independent reason a route cannot serve yet. */
function configFailure(message) {
  return Object.assign(new Error(message), { code: 'INVALID_CONFIG' });
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function pickNumber(fallback, ...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return fallback;
}

function defaultSessionsFile() {
  return path.join(os.homedir(), '.dsh', 'dsh-connect-baiducomate', 'sessions.json');
}

/**
 * Resolve one plugin row's config into the normalized shape the shared core
 * expects. Never throws: a route that cannot serve reports `error`, and the
 * adapter turns that into a stable `LlmError` only when a request needs it, so
 * a broken Comate deployment cannot stop dsh from booting.
 * @param raw - the row's `config`, already merged with schema defaults.
 * @param env - environment overrides, `process.env` in production.
 * @returns the normalized config plus the first fatal problem, if any.
 */
export function resolvePluginConfig(raw = {}, env = process.env) {
  const file = raw && typeof raw === 'object' ? raw : {};
  const config = {
    apiHost: pickString(env.COMATE_API_HOST, file.apiHost).replace(/\/+$/, ''),
    license: pickString(env.COMATE_LICENSE, file.license),
    username: pickString(env.COMATE_USERNAME, file.username),
    device: pickString(env.COMATE_DEVICE, file.device),
    ide: pickString(file.ide, 'zulucli'),
    ideVersion: pickString(file.ideVersion, '1.7.7'),
    pluginVersion: pickString(file.pluginVersion, '4.12.0'),
    agentId: pickNumber(1, file.agentId),
    agentName: pickString(file.agentName, 'Agent'),
    modelKey: pickString(file.modelKey, 'auto'),
    displayName: pickString(file.displayName, 'Comate'),
    workspacePath: pickString(env.COMATE_WORKSPACE, file.workspacePath, process.cwd()),
    emitReasoning: file.emitReasoning === true,
    overrideSystemPrompt: file.overrideSystemPrompt !== false,
    forwardSystemPrompt: file.forwardSystemPrompt === true,
    forwardContext: file.forwardContext !== false,
    forwardTools: file.forwardTools !== false,
    forwardAllTools: file.forwardAllTools === true,
    forwardToolLimit: pickNumber(20, file.forwardToolLimit),
    uploadImages: file.uploadImages !== false,
    imageMaxBytes: pickNumber(20 * 1024 * 1024, file.imageMaxBytes),
    maxImages: pickNumber(8, file.maxImages),
    sessionTtlMs: pickNumber(constants.SESSION_TTL_MS, file.sessionTtlMs),
    maxSessions: pickNumber(constants.MAX_SESSIONS, file.maxSessions),
    sessionsFile: pickString(file.sessionsFile, defaultSessionsFile()),
    installedCommands: file.installedCommands,
    notInstalledCommands: file.notInstalledCommands,
    toolMap: { ...DEFAULT_TOOL_MAP, ...(file.toolMap || {}) },
    argumentAliases: file.argumentAliases || {},
  };

  if (!config.license) {
    const fallback = readCliLicense();
    if (fallback) {
      config.license = fallback.license;
      config.username = config.username || fallback.username;
      config.device = config.device || fallback.device;
    }
  }
  config.username = config.username || config.license;
  config.device = config.device || crypto.randomUUID();

  let error = null;
  if (!config.apiHost) error = configFailure('config.apiHost is required (your Comate deployment URL, e.g. http://host:9359)');
  else if (!/^https?:\/\//i.test(config.apiHost)) error = configFailure(`config.apiHost must be an http(s) URL: ${config.apiHost}`);
  else if (!config.license) error = configFailure('config.license is required (or COMATE_LICENSE, or `zulu login`)');

  return { config, error };
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
