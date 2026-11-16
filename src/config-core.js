'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { DEFAULT_TOOL_MAP } = require('./tools');
const constants = require('./constants');

/**
 * One resolution path for both forms of this project.
 *
 * The HTTP shim reads `config.json` and exits on a bad value; the dsh plugin
 * reads a Loader row and must never stop the host from booting. Everything
 * except that policy lives here, so the two cannot drift: same field names,
 * same defaults, same coercion, same validation list.
 */

/** Marker for a value the caller must replace with something usable. */
const REQUIRED = Symbol('required');

const DEFAULTS = {
  ide: 'zulucli',
  ideVersion: '1.7.7',
  pluginVersion: '4.12.0',
  agentId: 1,
  agentName: 'Agent',
  modelKey: 'auto',
  displayName: 'Comate',
  emitReasoning: false,
  overrideSystemPrompt: true,
  forwardSystemPrompt: false,
  forwardContext: true,
  forwardTools: true,
  forwardAllTools: false,
  forwardToolLimit: 20,
  uploadImages: true,
  imageMaxBytes: 20 * 1024 * 1024,
  maxImages: 8,
  upstreamTimeoutMs: constants.UPSTREAM_TIMEOUT_MS,
  idleBeforeEndMs: constants.IDLE_BEFORE_END_MS,
  idleAfterEndMs: constants.IDLE_AFTER_END_MS,
};

const SHIM_DEFAULTS = {
  port: 8790,
  host: '127.0.0.1',
  authToken: '',
  maxBodyBytes: constants.MAX_BODY_BYTES,
};

const PLUGIN_DEFAULTS = {
  sessionTtlMs: constants.SESSION_TTL_MS,
  maxSessions: constants.MAX_SESSIONS,
};

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

function pickBoolean(fallback, ...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return fallback;
}

/** The credential `zulu login` stores, used only when no license is configured. */
function readCliLicense(env = process.env) {
  const authDir = env.COMATE_AUTH_DIR || path.join(os.homedir(), '.comate');
  const candidates = [path.join(authDir, 'cli-login.json'), path.join(authDir, 'login-user.json')];
  for (const file of candidates) {
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      const license = record.license || record.key || record.token;
      if (license) {
        return {
          license,
          username: record.username || record.userName || record.name || '',
          device: record.device || record.deviceId || '',
        };
      }
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * One stable device id per installation.
 *
 * A fresh UUID every boot looks like a new machine to Comate, which is the
 * wrong signal for anything the deployment attributes per device (and it made
 * every restart look like a fresh client). The id lives next to the state it
 * belongs to and is created with the first launch.
 * @param file - absolute path of the device record.
 * @returns the stored id, a freshly written one, or a throwaway on failure.
 */
function readOrCreateDevice(file) {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // missing or unreadable: create below
  }
  const device = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${device}\n`, { mode: 0o600 });
  } catch {
    // An unwritable home is not worth failing a boot over.
  }
  return device;
}

/** Short, non-reversible bucket id so one deployment's sessions never land in another's file. */
function bucketOf(apiHost) {
  return crypto.createHash('sha256').update(apiHost || 'unconfigured').digest('hex').slice(0, 8);
}

/**
 * Resolve one raw configuration into the normalized shape both forms share.
 * @param raw - `config.json` contents, or a Loader row's `config`.
 * @param env - environment overrides (`process.env` in production).
 * @param options - `kind` picks the caller-specific fields; `stateDir` is where
 *   the device id and the session file live; `now` is injectable for tests.
 * @returns `{ config, problems }`; `problems` is empty when the route can serve.
 */
function resolveConfig(raw = {}, env = process.env, options = {}) {
  const kind = options.kind === 'shim' ? 'shim' : 'plugin';
  const file = raw && typeof raw === 'object' ? raw : {};
  const stateDir = options.stateDir || path.join(os.homedir(), '.dsh', 'dsh-connect-baiducomate');
  const problems = [];

  const config = {
    kind,
    apiHost: pickString(env.COMATE_API_HOST, file.apiHost).replace(/\/+$/, ''),
    license: pickString(env.COMATE_LICENSE, file.license),
    username: pickString(env.COMATE_USERNAME, file.username),
    device: pickString(env.COMATE_DEVICE, file.device),
    ide: pickString(file.ide, DEFAULTS.ide),
    ideVersion: pickString(file.ideVersion, DEFAULTS.ideVersion),
    pluginVersion: pickString(file.pluginVersion, DEFAULTS.pluginVersion),
    agentId: pickNumber(DEFAULTS.agentId, file.agentId),
    agentName: pickString(file.agentName, DEFAULTS.agentName),
    modelKey: pickString(file.modelKey, DEFAULTS.modelKey),
    displayName: pickString(file.displayName, DEFAULTS.displayName),
    workspacePath: pickString(env.COMATE_WORKSPACE, file.workspacePath, options.workspaceFallback),
    emitReasoning: pickBoolean(DEFAULTS.emitReasoning, file.emitReasoning),
    overrideSystemPrompt: pickBoolean(DEFAULTS.overrideSystemPrompt, file.overrideSystemPrompt),
    forwardSystemPrompt: pickBoolean(DEFAULTS.forwardSystemPrompt, file.forwardSystemPrompt),
    forwardContext: pickBoolean(DEFAULTS.forwardContext, file.forwardContext),
    forwardTools: pickBoolean(DEFAULTS.forwardTools, file.forwardTools),
    forwardAllTools: pickBoolean(DEFAULTS.forwardAllTools, file.forwardAllTools),
    forwardToolLimit: pickNumber(DEFAULTS.forwardToolLimit, file.forwardToolLimit),
    uploadImages: pickBoolean(DEFAULTS.uploadImages, file.uploadImages),
    imageMaxBytes: pickNumber(DEFAULTS.imageMaxBytes, file.imageMaxBytes),
    maxImages: pickNumber(DEFAULTS.maxImages, file.maxImages),
    upstreamTimeoutMs: pickNumber(DEFAULTS.upstreamTimeoutMs, env.COMATE_TIMEOUT_MS, file.upstreamTimeoutMs),
    idleBeforeEndMs: pickNumber(DEFAULTS.idleBeforeEndMs, env.COMATE_IDLE_BEFORE_END_MS, file.idleBeforeEndMs),
    idleAfterEndMs: pickNumber(file.idleAfterEndMs, DEFAULTS.idleAfterEndMs),
    installedCommands: file.installedCommands,
    notInstalledCommands: file.notInstalledCommands,
    toolMap: { ...DEFAULT_TOOL_MAP, ...(file.toolMap || {}) },
    argumentAliases: file.argumentAliases || {},
  };

  if (!config.license) {
    const fallback = readCliLicense(env);
    if (fallback) {
      config.license = fallback.license;
      config.username = config.username || fallback.username;
      config.device = config.device || fallback.device;
    }
  }

  if (kind === 'shim') {
    config.port = pickNumber(SHIM_DEFAULTS.port, env.COMATE_PORT, file.port);
    config.host = pickString(env.COMATE_HOST, file.host, SHIM_DEFAULTS.host);
    config.authToken = pickString(env.COMATE_SHIM_TOKEN, file.authToken);
    // Bodies carry base64 images, so the *default* sits above the image
    // ceiling: a 20 MB image is ~26.7 MB of JSON by the time it arrives. An
    // explicit `maxBodyBytes` is still honoured — it is the operator's call.
    const floor = Math.ceil((config.imageMaxBytes * 4) / 3) + 1024 * 1024;
    config.maxBodyBytes = pickNumber(
      Math.max(SHIM_DEFAULTS.maxBodyBytes, floor),
      env.COMATE_MAX_BODY_BYTES,
      file.maxBodyBytes,
    );
    if (config.authToken && !/^https?:\/\//i.test(`http://${config.host}`)) {
      problems.push(`config.host is not a valid listen address: ${config.host}`);
    }
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      problems.push(`invalid port: ${config.port}`);
    }
    if (!Number.isFinite(config.forwardToolLimit) || config.forwardToolLimit < 1) {
      problems.push(`invalid forwardToolLimit: ${config.forwardToolLimit}`);
    }
    if (!Number.isInteger(config.agentId) || config.agentId < 1) {
      problems.push(`invalid agentId: ${config.agentId}`);
    }
  } else {
    config.sessionTtlMs = pickNumber(PLUGIN_DEFAULTS.sessionTtlMs, file.sessionTtlMs);
    config.maxSessions = pickNumber(PLUGIN_DEFAULTS.maxSessions, file.maxSessions);
    // Bucket the durable Comate task mapping by deployment: pointing the plugin
    // at another server must not send that server the other one's task ids.
    config.sessionsFile = pickString(
      file.sessionsFile,
      path.join(stateDir, `sessions-${bucketOf(config.apiHost)}.json`),
    );
  }

  config.username = config.username || config.license;
  config.workspacePath = config.workspacePath || process.cwd();
  config.device = config.device || readOrCreateDevice(path.join(stateDir, 'device'));
  config.deviceFile = path.join(stateDir, 'device');

  if (!config.apiHost) {
    problems.push('config.apiHost is required (your Comate deployment URL, e.g. http://host:9359)');
  } else if (!/^https?:\/\//i.test(config.apiHost)) {
    problems.push(`config.apiHost must be an http(s) URL: ${config.apiHost}`);
  }
  if (!config.license) {
    problems.push('config.license is required (or COMATE_LICENSE, or `zulu login`)');
  }

  return { config, problems };
}

module.exports = {
  DEFAULTS,
  REQUIRED,
  bucketOf,
  pickBoolean,
  pickNumber,
  pickString,
  readCliLicense,
  readOrCreateDevice,
  resolveConfig,
};
