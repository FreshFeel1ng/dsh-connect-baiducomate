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
import { resolvePluginConfig, PROVIDER_ID } from './config.mjs';
import { createComateAdapter } from './adapter.mjs';

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
 * @param config - the normalized route config.
 * @param log - the structured logger.
 * @returns a function taking one `ImageAttachmentRef`.
 */
function createImageReader(ctx, config, log) {
  return async (ref) => {
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
 * @param ctx - the plugin context; `ctx.llm` is available because of `inject`.
 * @param rowConfig - this loader row's `config`.
 */
export function apply(ctx, rowConfig = {}) {
  const log = createLogger(ctx);
  const { config, error } = resolvePluginConfig(rowConfig);
  if (error) {
    // The route still mounts: a broken deployment must not stop dsh from
    // booting, and the error surfaces on the first request instead.
    log('config.invalid', { message: error.message });
  }

  fs.mkdirSync(path.dirname(config.sessionsFile), { recursive: true });
  const sessions = new SessionStore({
    file: config.sessionsFile,
    ttlMs: config.sessionTtlMs,
    max: config.maxSessions,
  });
  sessions.load();
  const client = new ComateClient(config);
  const adapter = createComateAdapter({
    LlmAdapter,
    LlmError,
    providerId: PROVIDER_ID,
    config,
    configError: error,
    client,
    sessions,
    log,
    readImage: createImageReader(ctx, config, log),
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
    displayName: config.displayName,
    upstream: config.apiHost || '-',
    workspace: config.workspacePath,
    sessionsFile: config.sessionsFile,
    models: client.modelCount,
  });
  client.fetchModels().then(
    (models) => log('models.loaded', { count: models.length }),
    (fetchError) => log('models.load_failed', { message: String(fetchError?.message || fetchError) }),
  );
}

export default { name, inject, apply };
