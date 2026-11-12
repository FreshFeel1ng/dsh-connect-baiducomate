'use strict';

const fs = require('node:fs');

const { log } = require('./logger');

/**
 * Durable map of dsh conversation hash -> Comate conversation/task.
 * Persisted so a shim restart does not lose the server-side task mapping.
 */
class SessionStore {
  constructor({ file, ttlMs, max }) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.max = max;
    this.sessions = new Map();
    this.saveTimer = null;
  }

  get size() {
    return this.sessions.size;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      for (const [key, session] of Object.entries(raw)) {
        if (!session?.conversationId || !session?.taskId) continue;
        if (now - (session.lastUsed || session.created || 0) > this.ttlMs) continue;
        this.sessions.set(key, {
          conversationId: session.conversationId,
          taskId: session.taskId,
          traceId: session.traceId,
          started: session.started === true,
          created: session.created || now,
          lastUsed: session.lastUsed || now,
          toolNames: new Map(Object.entries(session.toolNames || {})),
          toolCatalogHash: session.toolCatalogHash || '',
          contextHash: session.contextHash || '',
          systemPromptHash: session.systemPromptHash || '',
        });
      }
      log('sessions.loaded', { count: this.sessions.size });
    } catch (error) {
      if (error.code !== 'ENOENT') log('sessions.load_failed', { message: String(error.message || error) });
    }
  }

  get(key) {
    return this.sessions.get(key);
  }

  set(key, session) {
    this.sessions.set(key, session);
    this.scheduleSave();
  }

  touch(session) {
    session.lastUsed = Date.now();
    this.scheduleSave();
  }

  prune() {
    const now = Date.now();
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (now - (session.lastUsed || session.created) > this.ttlMs) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    while (this.sessions.size > this.max) {
      const oldest = [...this.sessions.entries()].sort(
        (a, b) => (a[1].lastUsed || a[1].created) - (b[1].lastUsed || b[1].created),
      )[0];
      if (!oldest) break;
      this.sessions.delete(oldest[0]);
      removed += 1;
    }
    if (removed > 0) {
      log('sessions.pruned', { removed, remaining: this.sessions.size });
      this.scheduleSave();
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
    this.saveTimer.unref?.();
  }

  save() {
    try {
      const record = {};
      for (const [key, session] of this.sessions) {
        record[key] = {
          conversationId: session.conversationId,
          taskId: session.taskId,
          traceId: session.traceId,
          started: session.started,
          created: session.created,
          lastUsed: session.lastUsed,
          toolNames: Object.fromEntries(session.toolNames),
          toolCatalogHash: session.toolCatalogHash || '',
          contextHash: session.contextHash || '',
          systemPromptHash: session.systemPromptHash || '',
        };
      }
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(record, null, 2));
      try {
        fs.renameSync(temp, this.file);
      } catch {
        // Windows can refuse rename-over-existing while an indexer holds the file.
        fs.copyFileSync(temp, this.file);
        fs.unlinkSync(temp);
      }
    } catch (error) {
      log('sessions.save_failed', { message: String(error.message || error) });
    }
  }
}

module.exports = { SessionStore };
