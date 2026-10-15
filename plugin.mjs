import { createBridgeTransport } from './transport.mjs';

const PROVIDER = 'claude-code';
const EFFORTS = new Set(['medium', 'high']);

function providerOf(input) {
  return input?.model?.providerID ?? input?.message?.model?.providerID ?? input?.providerID ?? input?.provider;
}

function selectedVariant(input, config) {
  const candidate = input?.message?.model?.variant ?? input?.message?.variant ?? input?.output?.options?.effort ?? input?.output?.variant ?? input?.agent?.variant ?? config?.agent?.[typeof input?.agent === 'string' ? input.agent : input?.agent?.name]?.variant ?? input?.model?.variant;
  return EFFORTS.has(candidate) ? candidate : undefined;
}

export async function createBridgePlugin({ credentialLoader, fetchImpl, metadata } = {}) {
  const bridgeFetch = createBridgeTransport({ credentialLoader, fetchImpl, metadata });
  let config;
  return {
    config(current) {
      config = current;
      current.provider ??= {};
      const provider = current.provider[PROVIDER] ??= {};
      provider.npm = '@ai-sdk/anthropic';
      provider.options = { ...(provider.options ?? {}), apiKey: 'claude-subscription-only', baseURL: 'https://api.anthropic.com/v1', maxRetries: 0, fetch: bridgeFetch };
    },
    'chat.headers'(input, output) {
      if (providerOf(input) !== PROVIDER) return;
      const effort = selectedVariant(input, config);
      if (effort) { output.headers ??= {}; output.headers['x-opencode-bridge-effort'] = effort; }
    },
    'chat.params'(input, output) {
      if (providerOf(input) !== PROVIDER) return;
      output.options ??= {};
      const options = output.options;
      const explicit = options.output_config?.effort ?? options.effort;
      if (explicit !== undefined && !['low', 'medium', 'high', 'max'].includes(explicit)) throw new Error('invalid_claude_effort');
      const variant = input?.message?.model?.variant ?? input?.message?.variant;
      if (variant !== undefined && !EFFORTS.has(variant)) throw new Error('invalid_claude_effort');
      const effort = ['low', 'medium', 'high', 'max'].includes(explicit) ? explicit : selectedVariant(input, config);
      if (options.thinking === undefined) options.thinking = { type: 'adaptive' };
      if (effort && options.output_config?.effort === undefined) options.output_config = { ...(options.output_config ?? {}), effort };
      delete options.reasoningEffort;
    },
  };
}
