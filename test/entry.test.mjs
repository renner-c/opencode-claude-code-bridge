import test from 'node:test';
import assert from 'node:assert/strict';
import plugin, * as exports from '../entry.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('OpenCode entry exports only a default plugin and accepts host ABI arguments', async () => {
  assert.deepEqual(Object.keys(exports), ['default']);
  const before = process.env.CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED;
  process.env.CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED = '1';
  let hooks;
  try { hooks = await plugin({ client: { host: true } }, { credentialLoader: async () => { throw Error('not injectable'); } }); }
  finally { if (before === undefined) delete process.env.CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED; else process.env.CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED = before; }
  assert.equal(typeof hooks.config, 'function');
  assert.equal(typeof hooks['chat.params'], 'function');
  const config = {};
  hooks.config(config);
  assert.equal(config.provider['claude-code'].options.maxRetries, 0);
});

test('entry refuses plugin startup unless user explicitly confirms Extra Usage is disabled', async () => {
  const before = process.env.CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED;
  delete process.env.CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED;
  try {
    await assert.rejects(plugin({}, {}), /extra_usage_confirmation_required/);
    process.env.CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED = 'true';
    await assert.rejects(plugin({}, {}), /extra_usage_confirmation_required/);
    process.env.CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED = '1';
    const hooks = await plugin({}, {});
    assert.equal(typeof hooks.config, 'function');
  } finally {
    if (before === undefined) delete process.env.CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED;
    else process.env.CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED = before;
  }
});

test('config snippet is a correct file URL and includes provider and model setup', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(process.execPath, ['bin/config-snippet.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(config.plugin, [pathToFileURL(fileURLToPath(new URL('../entry.mjs', import.meta.url))).href]);
  assert.equal(config.provider['claude-code'].npm, '@ai-sdk/anthropic');
  assert.equal(config.provider['claude-code'].options.apiKey, 'claude-subscription-only');
  assert.deepEqual(config.provider['claude-code'].models.sonnet.variants, { medium: {}, high: {} });
  assert.equal(config.model, 'claude-code/sonnet');
});
