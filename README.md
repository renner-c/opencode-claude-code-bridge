# OpenCode Claude Code Bridge

A local OpenCode plugin that routes the `claude-code` provider's Anthropic Messages transport through Claude Code's OAuth credential. It is an adapter for an existing authenticated Claude Code account, not an OAuth client, official Anthropic integration, or guarantee of subscription eligibility or zero charges.

**Unofficial compatibility path:** this plugin emulates CLI-compatible request identity. Anthropic's documented third-party integration route uses API-key authentication; this OAuth path is not a supported third-party API contract, may stop working without notice, and may not be eligible under your account terms. Review the vendor's current terms before use. Working requests do not establish vendor approval or billing treatment.

**Before enabling:** personally verify Extra Usage is disabled in your account settings, then set `CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED=1` in the OpenCode process environment. The plugin refuses startup without this explicit acknowledgement. This is a user attestation, not a remote status check or guarantee; normal requests do not issue a usage-status GET. If billing/eligibility is refused, the bridge stops rather than retrying or choosing another provider.

## Quick start

Requires Node.js 20+, OpenCode, and an account authenticated with official Claude Code. Clone/download this repository to a stable local path:

```sh
git clone https://github.com/renner-c/opencode-claude-code-bridge.git
cd opencode-claude-code-bridge
node bin/config-snippet.mjs
```

Merge the printed `plugin`, `provider`, and optional default `model` examples into your OpenCode config, preserving your existing settings. Set the acknowledgement environment variable as described above, authenticate using the official Claude Code client, and restart OpenCode. No npm installation or publication is needed for this local-file setup. See [INSTALLATION.md](INSTALLATION.md) for details and [examples/opencode.json](examples/opencode.json) for a static template.

The generated example sets provider ID `claude-code`, uses `@ai-sdk/anthropic` with a non-secret placeholder API key, and configures one versioned model with `medium` and `high` variants. Edit model IDs to models your account and host support. The bridge accepts versioned Claude Opus, Sonnet, and Haiku IDs, optionally with a date suffix. The host's supported variants are version-dependent; the bridge passes medium/high selections and accepts Anthropic low/medium/high/max effort values from the request.

## Runtime behavior

- Only requests addressed by OpenCode to provider `claude-code` are changed. The plugin does not choose defaults or alter other providers, tools, permissions, MCP servers, or agents.
- Host system instructions, tools, tool arguments/results, and tool choice are retained. The bridge adds a billing-protocol block and the Claude Agent SDK identity block required by the compatible transport. These identity/header additions deliberately resemble CLI-compatible protocol behavior; they do not mean this is the official Claude Code client or vendor-endorsed software.
- No retries, fallback routing, credential refresh, or default usage-status polling. Unsafe destinations, redirects, and terminal billing/authentication refusals fail closed.
- Credential material is memory-only. On macOS, the bridge reads the fixed `Claude Code-credentials` Keychain item. On other OSes, it supports only the `CLAUDE_BRIDGE_ACCESS_TOKEN` plus `CLAUDE_BRIDGE_EXPIRES_AT` environment variables; it does not read CLI login files or implement a login flow. Only the official client renews tokens.

See [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [bridge-origin.json](bridge-origin.json) for security, development, and provenance notes.

## Offline checks

```sh
npm test
npm run check
npm run check:release
npm pack --dry-run
```

These use synthetic fixtures, not your Claude account. The hygiene check is a bounded heuristic, not a guarantee that every kind of secret or personal information can be detected.
