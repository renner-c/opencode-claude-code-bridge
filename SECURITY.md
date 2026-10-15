# Security

Report vulnerabilities privately to the repository maintainer before public disclosure. Never include OAuth tokens, Keychain output, private prompts, account data, or production request captures in reports.

The plugin requires `CLAUDE_BRIDGE_CONFIRM_EXTRA_USAGE_DISABLED=1` at startup as an explicit user acknowledgement. This is not verified against the account. Normal transport makes no usage-status GET; requests go to the fixed Anthropic Messages endpoint. The bridge refuses redirects and unsafe destinations, sanitizes provider errors, and stops on terminal authentication/billing/eligibility refusals. It does not retry, refresh credentials, or fall back to another key/provider. None of these controls guarantees vendor eligibility, subscription treatment, or absence of charges. Stop using it if a billing/eligibility refusal occurs; do not turn on Extra Usage as a troubleshooting step.

On macOS the runtime reads the fixed Claude Code Keychain service; elsewhere it reads only the documented token/expiry environment variables. Keep those values out of files, arguments, logs, and bug reports. The official Claude Code client alone renews tokens. The bridge sends CLI-compatible identity/header additions; this is protocol compatibility behavior, not vendor endorsement. Native login and OS consent remain user-owned.

Tests use synthetic fixtures and mocked fetch calls. They do not access network endpoints, call Keychain, read real credentials, or make real provider requests.

`npm run check:release` rejects unexpected repository files, symlinks, and common credential/private-path patterns. Its explicit synthetic fixture exceptions apply only to tests. This bounded heuristic does not inspect Git history, detect all personal information, or replace a security review.
