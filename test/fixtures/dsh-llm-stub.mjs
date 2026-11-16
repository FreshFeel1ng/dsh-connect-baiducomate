/**
 * Stand-in for `@deepseek-ai/dsh-llm`, used only by the plugin-entry test.
 * It reproduces the surface `lib/index.mjs` imports, so the entry can be loaded
 * and driven without a dsh installation.
 */

export class LlmError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = 'LlmError';
    this.code = code;
  }
}

export class LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: provider };
  }

  providerRetryPolicy() {
    return undefined;
  }

  listModels() {
    return Promise.resolve([]);
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model });
  }

  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) };
  }

  stream() {
    throw new Error('the stub base class streams nothing');
  }
}

export function resolveImageAttachmentAccess() {
  return undefined;
}
