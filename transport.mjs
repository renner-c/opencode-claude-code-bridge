import { createHash, randomUUID } from 'node:crypto';
import { getBridgeCredential } from './auth.mjs';
import { monitorSse } from './sse.mjs';

const API_ORIGIN = 'https://api.anthropic.com';
const CLI_VERSION = '2.1.291';
const CLI_BUILD_ID = '835';
const ENTRYPOINT = 'sdk-cli';
const BILLING_PREFIX = 'x-anthropic-billing-header:';
const IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const STOPPED = 'bridge_stopped';
const REQUIRED_BETA = ['claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'thinking-token-count-2026-05-13', 'context-management-2025-06-27', 'prompt-caching-scope-2026-01-05', 'advisor-tool-2026-03-01', 'effort-2025-11-24', 'extended-cache-ttl-2025-04-11'];

const SAFE_MESSAGES = {
  bridge_stopped: { usage_blocked: 'Extra Usage is enabled. Turn it off before making another request.', billing_or_eligibility_error: 'Billing or eligibility was refused. Resolve account eligibility before making another request.', authentication_error: 'Authentication was refused. Renew the authorized Claude Code credential.', provider_redirect_refused: 'The provider redirected the request, so the bridge stopped for safety.' },
  usage_unavailable: 'Usage status could not be verified. This request was not sent; make a new request when usage status can be verified.',
  usage_blocked: 'Usage status is unknown or Extra Usage is enabled. This request was not sent; verify Extra Usage is off.',
  authentication_error: 'Authentication was refused. Renew the authorized Claude Code credential; no alternate credential was tried.',
  billing_or_eligibility_error: 'Billing or eligibility was refused. Resolve account eligibility before making another request.',
  provider_cooldown: 'The provider recently reported a temporary failure. Wait until the cooldown expires, then make a new explicit request.',
  provider_unavailable: 'The provider could not be reached. Make a new request later.',
  provider_error: 'The provider request failed. Check the request and try a new request later.',
  overloaded_error: 'The provider is temporarily overloaded. Wait briefly, then make a new request.',
  rate_limit_error: 'The provider rate limit was reached. Wait before making another explicit request.',
  invalid_request: 'The request format is invalid. Check the request and model.',
  unsupported_model: 'The requested model is unsupported. Check the model name.',
  unsupported_request: 'The destination or method is unsupported.',
  provider_redirect_refused: 'The provider redirected the request, so the bridge stopped for safety.'
};
const safeError = (type, status, reason) => {
  const message = type === 'bridge_stopped' ? SAFE_MESSAGES.bridge_stopped[reason] ?? 'The bridge is stopped for safety. Resolve the reported refusal before making another request.' : SAFE_MESSAGES[type] ?? 'The provider request was refused. Check the request and make a new explicit request.';
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } });
};

function headerValue(source, name) {
  try { return new Headers(source).get(name); } catch { return null; }
}

function betaHeader(input, init) {
  const supplied = headerValue(init?.headers, 'anthropic-beta') ?? headerValue(input instanceof Request ? input.headers : null, 'anthropic-beta') ?? '';
  const flags = supplied.split(',').map(flag => flag.trim()).filter(Boolean);
  if (flags.some(flag => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(flag))) return null;
  return [...new Set([...REQUIRED_BETA, ...flags])].join(',');
}

function officialHeaders(sessionId, token, beta) {
  return new Headers({
    authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json',
    'user-agent': `claude-cli/${CLI_VERSION} (external, ${ENTRYPOINT})`, 'x-app': 'cli',
    'x-claude-code-session-id': sessionId, 'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true', 'x-stainless-lang': 'js',
    'x-stainless-package-version': '0.94.0',
    'x-stainless-os': process.platform === 'darwin' ? 'MacOS' : process.platform === 'linux' ? 'Linux' : 'Windows',
    'x-stainless-arch': process.arch === 'arm64' ? 'arm64' : process.arch,
    'x-stainless-runtime': 'node', 'x-stainless-runtime-version': process.version,
    'x-stainless-retry-count': '0', 'x-stainless-timeout': '600', 'anthropic-beta': beta,
  });
}

function destination(input) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : input instanceof URL ? input.href : input); }
  catch { throw new Error('unsupported_destination'); }
  const beta = url.searchParams.getAll('beta');
  if (url.username || url.password || url.hash || url.origin !== API_ORIGIN || url.pathname !== '/v1/messages' || [...url.searchParams.keys()].some(key => key !== 'beta') || beta.length > 1 || (beta.length === 1 && beta[0] !== 'true')) throw new Error('unsupported_destination');
  if (!beta.length) url.searchParams.set('beta', 'true');
  return url;
}

function validateEffort(body, internalEffort) {
  if (internalEffort !== undefined && !['medium', 'high'].includes(internalEffort)) return false;
  const config = body.output_config;
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) return false;
  const effort = config?.effort;
  if (effort !== undefined && !['low', 'medium', 'high', 'max'].includes(effort)) return false;
  if (internalEffort && effort && internalEffort !== effort) return false;
  if (internalEffort && effort === undefined) {
    body.output_config ??= {};
    body.output_config.effort = internalEffort;
  }
  return true;
}

function billingFingerprint(messages) {
  const user = Array.isArray(messages) ? messages.find(item => item?.role === 'user') : null;
  const text = typeof user?.content === 'string' ? user.content : Array.isArray(user?.content) ? user.content.find(item => item?.type === 'text' && typeof item.text === 'string')?.text ?? '' : '';
  if (!text) return null;
  const chars = [4, 7, 20].map(index => text[index] || '0').join('');
  return createHash('sha256').update(`59cf53e54c78${chars}${CLI_VERSION}`).digest('hex').slice(0, 3);
}

function billingBlock(sessionId, messages) {
  const cch = createHash('sha256').update(sessionId).digest('hex').slice(0, 5);
  const suffix = billingFingerprint(messages) ?? CLI_BUILD_ID;
  return `${BILLING_PREFIX} cc_version=${CLI_VERSION}.${suffix}; cc_entrypoint=${ENTRYPOINT}; cch=${cch};`;
}

async function bodyOf(input, init) {
  if (init?.body !== undefined) return typeof init.body === 'string' ? init.body : null;
  return input instanceof Request ? input.clone().text() : null;
}

function terminalHttpClass(response, code, message) {
  if (response.status === 401) return 'authentication_error';
  if (response.status === 429 || code === 'rate_limit_error') return 'rate_limit_error';
  if ([402, 403].includes(response.status) || /billing|eligib|extra[\s_-]*usage|credits?|payment/i.test(`${code ?? ''} ${message ?? ''}`)) return 'billing_or_eligibility_error';
  return null;
}

/** Fetch-compatible @ai-sdk/anthropic transport (configured by the caller as provider id claude-code). */
export function createBridgeTransport({ credentialLoader = getBridgeCredential, fetchImpl = globalThis.fetch, metadata, verifyUsage = false, now = Date.now, monotonicNow = () => performance.now() } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl_required');
  let stop = null;
  let cooldownUntil = 0;
  const sessionId = randomUUID();
  const bridgeFetch = async function bridgeFetch(input, init = {}) {
    const request = input instanceof Request ? input : null;
    const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
    let url;
    try { url = destination(input); } catch { return safeError('unsupported_request', 400); }
    if (method !== 'POST') return safeError('unsupported_request', 400);
    if (stop) return safeError(STOPPED, 403, stop.reason);
    if (cooldownUntil > now()) return safeError('provider_cooldown', 429, 'The provider recently reported a temporary failure. Wait until the short cooldown expires, then make a new explicit request.');

    let rawBody;
    try { rawBody = await bodyOf(input, init); } catch { return safeError('invalid_request', 400); }
    if (typeof rawBody !== 'string') return safeError('invalid_request', 400);
    let payload;
    try { payload = JSON.parse(rawBody); } catch { return safeError('invalid_request', 400); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.model !== 'string' || !/^claude-(?:opus|sonnet|haiku)-\d+-\d+(?:-\d+)?$/i.test(payload.model)) return safeError('unsupported_model', 400);
    if (typeof payload.system === 'string') payload.system = [{ type: 'text', text: payload.system }];
    if (payload.system !== undefined && (!Array.isArray(payload.system) || payload.system.some(block => !block || typeof block !== 'object' || Array.isArray(block) || block.type !== 'text' || typeof block.text !== 'string'))) return safeError('invalid_request', 400);
    const beta = betaHeader(input, init);
    if (!beta) return safeError('invalid_request', 400);
    const internalEffort = headerValue(init.headers, 'x-opencode-bridge-effort') ?? headerValue(request?.headers, 'x-opencode-bridge-effort') ?? undefined;
    if (!validateEffort(payload, internalEffort)) return safeError('invalid_request', 400);
    const hostBlocks = payload.system ?? [];
    payload.system = [{ type: 'text', text: billingBlock(sessionId, payload.messages) }, { type: 'text', text: IDENTITY }, ...hostBlocks];
    const generationBody = JSON.stringify(payload);

    let credential;
    try { credential = await credentialLoader(); } catch { return safeError('authentication_error', 401); }
    if (!credential || !/^sk-ant-oat[a-zA-Z0-9_-]{8,}$/.test(credential.accessToken) || !Number.isFinite(credential.expiresAt) || credential.expiresAt <= now() + 60_000) return safeError('authentication_error', 401);
    const headers = officialHeaders(sessionId, credential.accessToken, beta);
    const accept = headerValue(init.headers, 'accept') ?? headerValue(request?.headers, 'accept');
    if (accept) headers.set('accept', accept);

    // Optional diagnostic polling is opt-in, never a dependency of normal model requests or a paid fallback.
    if (verifyUsage) {
    try {
      const usage = await fetchImpl(`${API_ORIGIN}/api/oauth/usage`, {
        method: 'GET', headers: new Headers({ authorization: headers.get('authorization'), accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' }),
        redirect: 'error', signal: init.signal ?? request?.signal,
      });
      if (usage.redirected || (usage.status>=300&&usage.status<400) || (usage.url && (new URL(usage.url).origin !== API_ORIGIN || new URL(usage.url).pathname !== '/api/oauth/usage'))) {stop={reason:'provider_redirect_refused'};return safeError('provider_redirect_refused',502);}
      if(usage.status===401){stop={reason:'authentication_error'};return safeError('authentication_error',401);}
      if(usage.status===402||usage.status===403){stop={reason:'billing_or_eligibility_error'};return safeError('billing_or_eligibility_error',usage.status);}
      if (usage.status < 200 || usage.status >= 300) return safeError('usage_unavailable', 503);
      const usageData = await usage.json().catch(() => null);
      if (usageData?.extra_usage?.is_enabled !== false) {
        if (usageData?.extra_usage?.is_enabled === true) stop = { reason: 'usage_blocked' };
        return safeError('usage_blocked', 403);
      }
    } catch { return safeError('usage_unavailable', 503); }
    }

    if (stop) return safeError(STOPPED, 403, stop.reason);
    if (credential.expiresAt <= now() + 60_000) return safeError('authentication_error', 401);
    const generationStartedAt = monotonicNow();
    let response;
    try { response = await fetchImpl(url.href, { method: 'POST', headers, body: generationBody, redirect: 'error', signal: init.signal ?? request?.signal }); }
    catch { return safeError('provider_unavailable', 502); }
    let attemptId = null;
    try { attemptId = await fetchImpl.attemptIdFor?.(response) ?? null; } catch {}
    const emitMetadata = async event => {
      if (!metadata) return;
      try { await metadata(Object.freeze({ attemptId, ...event })); } catch {}
    };
    if ((response.status >= 300 && response.status < 400) || response.redirected || (response.url && (new URL(response.url).origin !== API_ORIGIN || new URL(response.url).pathname !== '/v1/messages'))) { stop = { reason: 'provider_redirect_refused' }; await emitMetadata({ status: response.status, model: payload.model, errorType: 'provider_redirect_refused', terminalKind: 'provider_error' }); return safeError('provider_redirect_refused', 502); }
    let providerCode, providerMessage;
    if (!response.ok || response.status === 404) {
      try {
        const parsed = await response.clone().json();
        providerCode = parsed?.error?.type;
        providerMessage = typeof parsed?.error?.message === 'string' ? parsed.error.message : undefined;
      } catch {}
    }
    const terminalClass = terminalHttpClass(response, providerCode, providerMessage);
    if (terminalClass) {
      if (terminalClass !== 'rate_limit_error') stop = { reason: terminalClass };
      else {
        const retryAfter = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 300) cooldownUntil = Math.max(cooldownUntil, now() + retryAfter * 1000);
      }
      const classification = terminalClass === 'billing_or_eligibility_error' ? { errorType: terminalClass, terminalKind: 'billing' } : { errorType: terminalClass, terminalKind: terminalClass === 'rate_limit_error' ? 'rate_limit' : 'authentication' };
      await emitMetadata({ status: response.status, model: payload.model, ...classification });
      return safeError(terminalClass, response.status);
    }
    if (providerCode === 'model_not_found') {
      await emitMetadata({ status: response.status, model: payload.model, errorType: 'unsupported_model' });
      return safeError('unsupported_model', response.status);
    }
    if (response.status === 404) {
      await emitMetadata({ status: response.status, model: payload.model, errorType: ['not_found_error', 'model_not_found'].includes(providerCode) ? 'unsupported_model' : 'provider_error' });
      return safeError(['not_found_error', 'model_not_found'].includes(providerCode) ? 'unsupported_model' : 'provider_error', 404);
    }
    if (!response.ok) {
      await emitMetadata({ status: response.status, model: payload.model, errorType: 'provider_error' });
      return safeError('provider_error', response.status);
    }
    if (response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
      let firstTextAt, firstReasoningAt, firstToolAt;
      let toolCallCount = 0;
      return monitorSse(response, { onTerminalError(type) {
        if (type === 'billing_or_eligibility_error' || type === 'authentication_error') stop = { reason: type };
        else if (type === 'rate_limit_error' || type === 'overloaded_error' || type === 'api_error' || type === 'provider_error') cooldownUntil = Math.max(cooldownUntil, now() + 30_000);
        const billing = type === 'billing_or_eligibility_error';
        return emitMetadata({ status: response.status, model: payload.model, errorType: type, ...(billing ? { terminalKind: 'billing' } : { terminalKind: type === 'rate_limit_error' ? 'rate_limit' : 'provider_error' }) });
      }, onMetadata(event) {
        if (!event) return;
        if (event.firstTextObserved && firstTextAt === undefined) firstTextAt = Math.max(0, monotonicNow() - generationStartedAt);
        else if (event.firstTextObserved) delete event.firstTextObserved;
        if (event.reasoningStarted && firstReasoningAt === undefined) firstReasoningAt = Math.max(0, monotonicNow() - generationStartedAt);
        else if (event.reasoningStarted) delete event.reasoningStarted;
        if (event.toolCallCountDelta && firstToolAt === undefined) firstToolAt = Math.max(0, monotonicNow() - generationStartedAt);
        if (Number.isFinite(event.toolCallCountDelta)) toolCallCount += event.toolCallCountDelta;
        const observable = event.actualModel || event.input_tokens !== undefined || event.output_tokens !== undefined || event.cache_read_input_tokens !== undefined || event.cache_creation_input_tokens !== undefined || event.firstTextObserved || event.reasoningStarted || event.toolCallCountDelta;
        if (!observable) return;
        return emitMetadata({ status: response.status, model: payload.model, ...event, toolCallCount, ...(firstTextAt === undefined ? {} : { firstTextMs: firstTextAt }), ...(firstReasoningAt === undefined ? {} : { firstReasoningMs: firstReasoningAt }), ...(firstToolAt === undefined ? {} : { firstToolMs: firstToolAt }) });
      }, onEof() {
        return emitMetadata({ status: response.status, model: payload.model, eofElapsedMs: Math.max(0, monotonicNow() - generationStartedAt), toolCallCount });
      } });
    }
    if (metadata) {
      try {
        const result = await response.clone().json();
        const usage = result?.usage;
        const usageFields = {};
        for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) if (Number.isFinite(usage?.[key])) usageFields[key] = usage[key];
        const blockTypes = Array.isArray(result?.content) ? result.content.map(block => block?.type).filter(type => type === 'tool_use' || type === 'thinking' || type === 'text') : [];
        await emitMetadata({ status: response.status, model: payload.model, elapsedMs: Math.max(0, monotonicNow() - generationStartedAt), ...(typeof result?.model === 'string' ? { actualModel: result.model } : {}), ...usageFields, toolCallCount: blockTypes.filter(type => type === 'tool_use').length, reasoningStarted: blockTypes.includes('thinking'), firstTextObserved: blockTypes.includes('text') });
      } catch { await emitMetadata({ status: response.status, model: payload.model, elapsedMs: Math.max(0, monotonicNow() - generationStartedAt) }); }
    }
    return response;
  };
  bridgeFetch.state = () => Object.freeze({ stopped: Boolean(stop), ...(stop ? { reason: stop.reason } : {}), ...(cooldownUntil > now() ? { cooldownExpiresAt: cooldownUntil } : {}) });
  return bridgeFetch;
}

export { CLI_VERSION, CLI_BUILD_ID };
