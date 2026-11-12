'use strict';

/**
 * Composition root. Configuration, the Comate client, the durable session
 * store, and the HTTP server live in ./src; this file only wires them up and
 * owns the process lifecycle.
 */

const path = require('node:path');

const { loadConfig } = require('./src/config');
const { log, redact } = require('./src/logger');
const { SessionStore } = require('./src/sessions');
const { ComateClient } = require('./src/upstream');
const { createShimServer } = require('./src/server');
const { SESSION_TTL_MS, MAX_SESSIONS } = require('./src/constants');

const config = loadConfig(path.join(__dirname, 'config.json'));

const sessions = new SessionStore({
  file: path.join(__dirname, 'sessions.json'),
  ttlMs: SESSION_TTL_MS,
  max: MAX_SESSIONS,
});
sessions.load();

const client = new ComateClient(config);
const server = createShimServer({ config, client, sessions });

server.listen(config.port, config.host, () => {
  log('shim.start', {
    url: `http://${config.host}:${config.port}`,
    upstream: config.apiHost,
    workspace: config.workspacePath,
    license: redact(config.license),
    models: client.modelCount,
  });
  client.fetchModels().then(
    (models) => log('models.loaded', { count: models.length }),
    (error) => log('models.load_failed', { message: String(error.message || error) }),
  );
});

function shutdown(signal) {
  log('shim.stop', { signal });
  sessions.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
