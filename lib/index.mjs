/**
 * dsh plugin entry: registers one `comate` LLM route served by a Baidu Comate
 * private deployment.
 *
 * ```yaml
 * - id: comate
 *   name: dsh-connect-baiducomate
 *   config:
 *     apiHost: http://comate.example.internal:9359
 *     license: !!js process.env.COMATE_LICENSE
 * ```
 *
 * The row lives in this package's `cordis.patch.yml`, so `dsh plugin add`
 * activates it. Model ids, context windows, and image support come from the
 * Comate catalog at request time; nothing about the model list is hard-coded.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { LlmAdapter, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';

import { SessionStore } from '../src/sessions.js';
import { ComateClient } from '../src/upstream.js';
import { resolvePluginConfig, plainRowConfig, PROVIDER_ID } from './config.mjs';
import { createComateAdapter } from './adapter.mjs';
import { Config } from './schema.mjs';

export { Config };

export const name = 'comate';

/** The adapter registry this plugin adds a route to. */
export const inject = ['llm'];

/**
 * Structured one-line diagnostics, the same shape the HTTP shim prints, routed
 * through the host logger so it lands in the dsh log stream.
 * @param ctx - the plugin context.
 * @returns a `log(event, fields)` function.
 */
function createLogger(ctx) {
  return (event, fields = {}) => {
    const payload = { scope: 'comate', event, ...fields };
    try {
      if (typeof ctx.logger?.info === 'function') {
        ctx.logger.info(JSON.stringify(payload));
        return;
      }
    } catch {
      // A host without a logger still gets the console fallback below.
    }
    console.log(JSON.stringify({ time: new Date().toISOString(), ...payload }));
  };
}

/**
 * Read one durable image attachment as a data URL, which is what the Comate
 * upload endpoint accepts. dsh stores the normalized bytes; the plugin never
 * touches the original user file.
 * @param ctx - the plugin context, for the attachment and fs services.
 * @param getConfig - the current route config; called per image, so a settings
 *   save changes the size ceiling without a restart.
 * @param log - the structured logger.
 * @returns a function taking one `ImageAttachmentRef`.
 */
function createImageReader(ctx, getConfig, log) {
  return async (ref) => {
    const config = getConfig();
    const attachments = ctx.get('attachments');
    if (attachments === undefined) {
      throw new LlmError('Comate image input requires the durable attachment service', 'UNSUPPORTED_CONTENT');
    }
    const access = resolveImageAttachmentAccess(
      attachments,
      (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    );
    if (access === undefined) {
      throw new LlmError('Comate image input could not resolve the attachment bytes', 'UNSUPPORTED_CONTENT');
    }
    const bytes = await fsp.readFile(access.readonlyPath);
    if (bytes.length > config.imageMaxBytes) {
      throw new LlmError(
        `image too large: ${bytes.length} bytes (max ${config.imageMaxBytes})`,
        'UNSUPPORTED_CONTENT',
      );
    }
    log('image.read', { bytes: bytes.length, mediaType: ref.mediaType });
    return `data:${ref.mediaType || 'image/png'};base64,${bytes.toString('base64')}`;
  };
}

/**
 * Mount the route.
 *
 * The row's config fields are declared `volatile()` in `./schema.mjs`, so dsh
 * hands over live references instead of a frozen snapshot: the form in
 * Settings → Plugins writes the profile patch, and the next request reads the
 * new value through `snapshot()`. Nothing here needs a restart, which is what
 * lets a user fill in `apiHost` and `license` from the UI instead of editing
 * YAML by hand.
 *
 * @param ctx - the plugin context; `ctx.llm` is available because of `inject`.
 * @param rowConfig - this loader row's `config`, volatile fields included.
 */
export function apply(ctx, rowConfig = {}) {
  const log = createLogger(ctx);

  // Our own page owns the form, so dsh must not also generate one from the schema.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });

  let live = null;
  /** The durable mapping, replaced by `sessions.invalidated` when the deployment moves. */
  let sessions = null;
  /**
   * The config as it stands right now.
   * @returns `{ config, error, client }` for the current settings.
   */
  const snapshot = () => {
    const plain = plainRowConfig(rowConfig);
    const fingerprint = JSON.stringify(plain);
    if (live !== null && live.fingerprint === fingerprint) return live;

    const { config, error } = resolvePluginConfig(plain);
    const identity = [config.apiHost, config.license, config.username, config.device].join('\u0000');
    const moved = live !== null && live.identity !== identity;
    // A client caches the model catalog, so keep it across edits that do not
    // move the deployment or the credential.
    const client = live !== null && !moved ? live.client : new ComateClient(config);
    const changed = live === null
      ? []
      : Object.keys(plain).filter((key) => JSON.stringify(live.plain[key]) !== JSON.stringify(plain[key]));

    live = { config, error, client, fingerprint, identity, plain };
    if (changed.length > 0) {
      log('config.applied', {
        upstream: config.apiHost || '-',
        model: config.modelKey,
        changed,
        error: error ? error.message : null,
      });
    }
    // Task ids belong to the deployment that issued them: sending them to a new
    // one fails every turn until the TTL expires, so drop them with the move.
    if (moved && sessions !== null) {
      log('sessions.invalidated', {
        dropped: sessions.clear(),
        upstream: config.apiHost || '-',
        reason: 'deployment identity changed',
      });
    }
    return live;
  };

  const initial = snapshot();
  if (initial.error) {
    // The route still mounts: a broken deployment must not stop dsh from
    // booting, and the error surfaces on the first request instead.
    log('config.invalid', { message: initial.error.message });
  }

  fs.mkdirSync(path.dirname(initial.config.sessionsFile), { recursive: true });
  sessions = new SessionStore({
    file: initial.config.sessionsFile,
    ttlMs: initial.config.sessionTtlMs,
    max: initial.config.maxSessions,
  });
  sessions.load();
  const adapter = createComateAdapter({
    LlmAdapter,
    LlmError,
    providerId: PROVIDER_ID,
    sessions,
    log,
    readImage: createImageReader(ctx, () => snapshot().config, log),
    // Getters, not values: the adapter reads these per request, so a settings
    // save reaches the next turn without remounting the plugin.
    get config() {
      return snapshot().config;
    },
    get configError() {
      return snapshot().error;
    },
    get client() {
      return snapshot().client;
    },
  });

  ctx.effect(() => () => sessions.save());
  try {
    ctx.llm.registerAdapter([PROVIDER_ID], adapter);
  } catch (registrationError) {
    log('llm.register_failed', {
      provider: PROVIDER_ID,
      message: String(registrationError?.message || registrationError),
      hint: 'remove the leftover llm-pi-ai "comate" provider from the profile patch; a route is owned by exactly one adapter',
    });
    throw registrationError;
  }
  log('llm.registered', {
    provider: PROVIDER_ID,
    displayName: initial.config.displayName,
    upstream: initial.config.apiHost || '-',
    workspace: initial.config.workspacePath,
    sessionsFile: initial.config.sessionsFile,
    models: initial.client.modelCount,
  });
  initial.client.fetchModels().then(
    (models) => log('models.loaded', { count: models.length }),
    (fetchError) => log('models.load_failed', { message: String(fetchError?.message || fetchError) }),
  );
}

export default { name, inject, apply, Config };
