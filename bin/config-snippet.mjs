#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';

const entry = pathToFileURL(fileURLToPath(new URL('../entry.mjs', import.meta.url))).href;
const config = {
  $schema: 'https://opencode.ai/config.json',
  plugin: [entry],
  model: 'claude-code/sonnet',
  provider: {
    'claude-code': {
      npm: '@ai-sdk/anthropic',
      options: { apiKey: 'claude-subscription-only', baseURL: 'https://api.anthropic.com/v1', maxRetries: 0 },
      models: {
        sonnet: {
          id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', reasoning: true, tool_call: true,
          variants: { medium: {}, high: {} },
        },
      },
    },
  },
};
process.stdout.write(JSON.stringify(config, null, 2) + '\n');
