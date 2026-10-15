# Installation and setup

## 1. Authenticate and acknowledge

Use the official Claude Code client to authenticate and renew its OAuth credential. Do not copy tokens into config files, shell command arguments, issue reports, or logs. Before enabling this plugin, verify directly in your account settings that Extra Usage is disabled. Then set `CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED=1` in the environment inherited by OpenCode. For example, set it through your normal OS/service environment mechanism before launching OpenCode; avoid putting credentials in launch arguments. The value is an explicit user acknowledgement only—the bridge does not check account settings remotely.

The bridge never refreshes credentials. On macOS it invokes `/usr/bin/security` for the fixed `Claude Code-credentials` Keychain service and reads only the OAuth access token and expiry. On Windows/Linux and macOS fallback environments, supply both `CLAUDE_BRIDGE_ACCESS_TOKEN` and `CLAUDE_BRIDGE_EXPIRES_AT` to the OpenCode process environment; expiry accepts Unix seconds or milliseconds. Do not put those values in OpenCode JSON. Environment-token mode is not a CLI login-file reader and the official Claude Code client remains responsible for renewal. Native login/Keychain consent remains user-controlled.

## 2. Add the plugin and provider

With Node.js 20+ in the repository root, run:

```sh
node bin/config-snippet.mjs
```

This prints a JSON configuration example with an absolute file URL for this checkout, a `claude-code` provider, the `@ai-sdk/anthropic` adapter, a deliberately non-secret `claude-subscription-only` placeholder key, one model, and medium/high variants. It is read-only: no network, credential access, or config write. Merge those fields into your existing OpenCode config rather than replacing the file. The provider/model configuration is necessary on a fresh OpenCode install; the plugin URL alone does not register a selectable model. Adjust the model ID and model key to a current supported versioned Claude ID.

The global config is normally `~/.config/opencode/opencode.json` (or `.jsonc`); the repository's static example is a template, not a config that loads automatically. Append the printed URL to your existing `plugin` array. Do not leave another plugin that owns the same `claude-code` provider enabled alongside this one.

The output conforms to OpenCode's provider/model configuration shape in its public schema at https://opencode.ai/config.json. Config schema support does not guarantee compatibility with every host runtime or provider SDK version. Restart OpenCode after editing configuration and setting the acknowledgement environment.

## 3. Select and verify

Select `claude-code/sonnet` (or your configured model key) in OpenCode. The bridge only modifies that provider. Do not copy a whole sample config over your own; preserve existing permissions, default model, agent bindings, plugins, and MCP configuration. The bridge does not set a default model itself—the generated example does so only as an explicit setup choice.

After verifying Extra Usage is disabled, a CLI launch on macOS/Linux can use this non-secret acknowledgement:

```sh
CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED=1 opencode
```

In PowerShell, set `$env:CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED = '1'` before launching `opencode`. A desktop app must inherit the variable too; launching it from a dock or launcher may not inherit your shell environment. Quit safely and relaunch from an environment you control. Do not dismiss or automate OS/Keychain consent prompts.

No live verification is performed by the setup command. Your first prompt is a real provider request and may consume account capacity. Start with a harmless short prompt only after reviewing the warnings.

## Troubleshooting and removal

- `extra_usage_confirmation_required`: confirm the account setting, then supply the acknowledgement to the actual OpenCode process and restart.
- `authentication_error`: use official Claude Code normally so it renews its own login, then make a new request. A status-only check may not renew it. The adapter does not refresh tokens. If a remote refusal is latched, restart OpenCode after resolving the cause.
- Billing/eligibility refusal: stop. Do not enable Extra Usage, use a paid key, or keep retrying as a workaround.
- Temporary overload/rate limit: wait for the cooldown and make a new explicit request; there are no automatic retries.
- To remove: remove this plugin's URL and the provider/model entries you added (and change a default model if you set one), then restart. Do not delete unrelated settings or the official client's credentials.

## Compatibility and verification

The original managed workflow was exercised against a real OpenCode **1.18.35** installation on its development host, including native plugin hooks and mocked transport regression checks. The separately packaged test suite is offline/hermetic and is not a new live provider or billing certification. CI targets Node.js 20 and 22 on Ubuntu, macOS, and Windows; those runners validate mocked behavior and do not validate platform credential stores. macOS Keychain behavior is platform-specific. Other OSes' environment-token mode is not independently certified here. No live generation or cross-platform end-to-end result is claimed.

Packaging verification also checked configuration and model resolution in an isolated **OpenCode 1.19.0** process without a prompt, plus the registered entry's hooks separately. The packed artifact's tests and setup generator passed after extraction to a path containing spaces and non-ASCII characters. These checks are not a fresh end-to-end subscription request.
