import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgePlugin } from '../plugin.mjs';

test('plugin injects transport only into claude-code and preserves unrelated config', async () => {
  const config = { provider: { 'claude-code': { npm: 'old', options: { old: true }, models: { sonnet: { id: 'claude-sonnet-5-5' } } }, openai: { models: { gpt: {} } } }, agent: { build: { model: { providerID: 'claude-code', modelID: 'claude-sonnet-5-5', variant: 'high' } } }, mcp: { local: { type: 'local' } }, permission: { edit: 'deny' } };
  const before = structuredClone(config);
  let loads = 0;
  const plugin = await createBridgePlugin({ credentialLoader: async () => { loads++; return { accessToken: 'sk-ant-oatfixture_token_123456', expiresAt: Date.now() + 120000 }; }, fetchImpl: async () => Response.json({ extra_usage: { is_enabled: false } }) });
  await plugin.config(config);
  assert.equal(config.provider['claude-code'].npm, '@ai-sdk/anthropic');
  assert.equal(config.provider['claude-code'].options.apiKey, 'claude-subscription-only');
  assert.equal(config.provider['claude-code'].options.baseURL, 'https://api.anthropic.com/v1');
  assert.equal(config.provider['claude-code'].options.maxRetries, 0);
  assert.equal(typeof config.provider['claude-code'].options.fetch, 'function');
  assert.deepEqual(config.provider['claude-code'].models, before.provider['claude-code'].models);
  assert.deepEqual({ ...config, provider: { ...config.provider, 'claude-code': before.provider['claude-code'] } }, before);
  assert.equal(loads, 0);
});

test('native hook ABI mutates output; only claude-code uses selected variant and params', async () => {
  const plugin = await createBridgePlugin({ credentialLoader: async () => { throw new Error('must wait for fetch'); }, fetchImpl: async () => new Response('{}') });
  const config = { agent: { build: { variant: 'medium' } } };
  await plugin.config(config);
  const headersOutput = { headers: { keep: 'yes' } };
  await plugin['chat.headers']({ model: { providerID: 'claude-code' }, message: { model: { providerID: 'claude-code', variant: 'high' } } }, headersOutput);
  assert.equal(headersOutput.headers['x-opencode-bridge-effort'], 'high');
  const noopHeaders = { headers: { untouched: true } };
  await plugin['chat.headers']({ model: { providerID: 'openai' }, message: { model: { providerID: 'openai', variant: 'high' } } }, noopHeaders);
  assert.deepEqual(noopHeaders, { headers: { untouched: true } });
  const paramsOutput = { options: { custom: true, reasoningEffort: 'invalid-openai-marker' } };
  await plugin['chat.params']({ model: { providerID: 'claude-code' }, message: { model: { providerID: 'claude-code', variant: 'high' } } }, paramsOutput);
  assert.deepEqual(paramsOutput.options.thinking, { type: 'adaptive' });
  assert.deepEqual(paramsOutput.options.output_config, { effort: 'high' });
  assert.equal('reasoningEffort' in paramsOutput.options, false);
  const noop = { options: { reasoningEffort: 'high', custom: true } };
  await plugin['chat.params']({ model: { providerID: 'openai' }, message: { model: { providerID: 'openai' } } }, noop);
  assert.deepEqual(noop, { options: { reasoningEffort: 'high', custom: true } });
  assert.throws(() => plugin['chat.params']({ model: { providerID: 'claude-code' }, message: { model: { providerID: 'claude-code', variant: 'xhigh' } } }, { options: { output_config: { effort: 'xhigh' } } }), /invalid_claude_effort/);
});
