'use strict';

/**
 * Structured one-line logs. Every call is a JSON object so the output can be
 * piped into a log collector without parsing prose.
 */
function log(event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

/** Keep the first/last characters of a secret when a diagnostic needs it. */
function redact(value) {
  if (typeof value !== 'string') return value;
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : '***';
}

module.exports = { log, redact };
