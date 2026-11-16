'use strict';

module.exports = {
  SESSION_TTL_MS: 60 * 60 * 1000,
  MAX_SESSIONS: 200,
  MODEL_CACHE_MS: 5 * 60 * 1000,
  UPSTREAM_TIMEOUT_MS: 10 * 60 * 1000,
  // Comate thinks before it speaks: a large context can stay silent for
  // minutes. Cancelling at 60 s turned those turns into empty retries that
  // burned quota, so the default waits three minutes and is configurable.
  IDLE_AFTER_END_MS: 3000,
  IDLE_BEFORE_END_MS: 180000,
  KEEPALIVE_MS: 15000,
  // Request bodies carry base64 images, so this sits above `imageMaxBytes`:
  // config-core raises it further when a larger image ceiling is configured.
  MAX_BODY_BYTES: 32 * 1024 * 1024,
};
