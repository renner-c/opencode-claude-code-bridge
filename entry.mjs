import { createBridgePlugin } from './plugin.mjs';

// OpenCode calls plugins with (hostContext, pluginOptions). Neither is an
// injectable runtime dependency; dependencies are deliberately fixed here.
export default async function ClaudeCodeBridgePlugin(_context, _options) {
  if (process.env.CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED !== '1') {
    throw new Error('extra_usage_confirmation_required: set CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED=1 only after verifying Extra Usage is disabled');
  }
  return createBridgePlugin();
}
