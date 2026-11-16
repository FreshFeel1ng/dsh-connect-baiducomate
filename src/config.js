'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { readCliLicense, resolveConfig } = require('./config-core');

/**
 * Load and validate `config.json` for the HTTP shim.
 *
 * The shim owns its process, so an unusable configuration is fatal here; the
 * dsh plugin uses the same resolution (see `lib/config.mjs`) but reports the
 * problem instead of exiting. Field names, defaults, and coercion all live in
 * `config-core.js` so the two forms cannot drift apart.
 */

function fail(message) {
  console.error(`[comate-shim] ${message}`);
  process.exit(1);
}

/**
 * @param configPath - absolute path of `config.json`.
 * @param env - environment overrides.
 * @returns the normalized config, or exits the process with the first problem.
 */
function loadConfig(configPath, env = process.env) {
  if (!fs.existsSync(configPath)) {
    fail(`missing ${configPath}; copy config.example.json and fill it in`);
  }
  let file;
  try {
    file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    fail(`${configPath} is not valid JSON: ${String(error.message || error)}`);
  }

  const { config, problems } = resolveConfig(file, env, { kind: 'shim', stateDir: path.dirname(configPath) });
  if (problems.length > 0) fail(problems[0]);
  return config;
}

module.exports = { loadConfig, readCliLicense };
