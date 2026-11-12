'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { DEFAULT_TOOL_MAP } = require('./tools');

/**
 * Load and validate config.json, with environment overrides and a fallback to
 * the credential the Comate CLI stores after `zulu login`.
 */
function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) {
    fail(`missing ${configPath}; copy config.example.json and fill it in`);
  }
  const file = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const config = {
    port: Number(process.env.COMATE_PORT || file.port || 8790),
    host: process.env.COMATE_HOST || file.host || '127.0.0.1',
    apiHost: (process.env.COMATE_API_HOST || file.apiHost || '').replace(/\/+$/, ''),
    license: process.env.COMATE_LICENSE || file.license || '',
    username: process.env.COMATE_USERNAME || file.username || '',
    device: process.env.COMATE_DEVICE || file.device || '',
    ide: file.ide || 'zulucli',
    ideVersion: file.ideVersion || '1.7.7',
    pluginVersion: file.pluginVersion || '4.12.0',
    agentId: Number(file.agentId || 1),
    agentName: file.agentName || 'Agent',
    modelKey: file.modelKey || 'auto',
    workspacePath: process.env.COMATE_WORKSPACE || file.workspacePath || process.cwd(),
    authToken: process.env.COMATE_SHIM_TOKEN || file.authToken || '',
    emitReasoning: file.emitReasoning === true,
    forwardSystemPrompt: file.forwardSystemPrompt === true,
    overrideSystemPrompt: file.overrideSystemPrompt !== false,
    forwardContext: file.forwardContext !== false,
    forwardTools: file.forwardTools !== false,
    forwardAllTools: file.forwardAllTools === true,
    forwardToolLimit: Number(file.forwardToolLimit || 20),
    uploadImages: file.uploadImages !== false,
    imageMaxBytes: Number(file.imageMaxBytes || 20 * 1024 * 1024),
    maxImages: Number(file.maxImages || 8),
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

  if (!config.apiHost) fail('config.apiHost is required');
  if (!/^https?:\/\//i.test(config.apiHost)) fail(`config.apiHost must be an http(s) URL: ${config.apiHost}`);
  if (!config.license) fail('config.license is required (or COMATE_LICENSE)');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    fail(`invalid port: ${config.port}`);
  }
  if (!Number.isFinite(config.forwardToolLimit) || config.forwardToolLimit < 1) {
    fail(`invalid forwardToolLimit: ${config.forwardToolLimit}`);
  }
  if (!Number.isInteger(config.agentId) || config.agentId < 1) {
    fail(`invalid agentId: ${config.agentId}`);
  }

  config.username = config.username || config.license;
  config.device = config.device || crypto.randomUUID();
  return config;
}

function readCliLicense() {
  const authDir = process.env.COMATE_AUTH_DIR || path.join(os.homedir(), '.comate');
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

function fail(message) {
  console.error(`[comate-shim] ${message}`);
  process.exit(1);
}

module.exports = { loadConfig };
