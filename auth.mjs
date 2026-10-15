import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TOKEN_PATTERN = /^sk-ant-oat[a-zA-Z0-9_-]{8,}$/;
function normalizeExpiry(value) { const expiry = Number(value); if (!Number.isFinite(expiry)) return NaN; return expiry < 1e11 ? expiry * 1000 : expiry; }

/** Load short-lived OAuth credential into memory; never refresh or persist it. */
export async function getBridgeCredential({ env = process.env, now = Date.now(), run = execFileAsync } = {}) {
  let accessToken = env.CLAUDE_BRIDGE_ACCESS_TOKEN;
  let expiresAt = normalizeExpiry(env.CLAUDE_BRIDGE_EXPIRES_AT);
  if (accessToken !== undefined || env.CLAUDE_BRIDGE_EXPIRES_AT !== undefined) {
    if (!accessToken || !Number.isFinite(expiresAt)) throw new Error('authentication_error');
  } else {
    try {
      const result = await run('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, env: { PATH: '/usr/bin:/bin' } });
      const credential = JSON.parse(String(typeof result === 'string' ? result : result?.stdout ?? ''));
      accessToken = credential?.claudeAiOauth?.accessToken;
      expiresAt = normalizeExpiry(credential?.claudeAiOauth?.expiresAt);
    } catch { throw new Error('authentication_error'); }
  }
  if (typeof accessToken !== 'string' || !TOKEN_PATTERN.test(accessToken) || !Number.isFinite(expiresAt) || expiresAt <= now + 60_000) throw new Error('authentication_error');
  return Object.freeze({ accessToken, expiresAt });
}
