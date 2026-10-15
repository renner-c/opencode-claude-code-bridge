import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeTransport } from '../transport.mjs';
import { getBridgeCredential } from '../auth.mjs';
import { monitorSse } from '../sse.mjs';

const token = 'sk-ant-oatfixture_token_123456';
const credential = async () => ({ accessToken: token, expiresAt: Date.now() + 120_000 });
const request = (body, url = 'https://api.anthropic.com/v1/messages') => new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'native-placeholder', cookie: 'ignored' }, body: JSON.stringify(body),
});

test('default request path sends only one fixed Messages POST and does not query usage', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return Response.json({ ok: true }); };
  const fetch = createBridgeTransport({ credentialLoader: credential, fetchImpl });
  const response = await fetch(request({ model: 'claude-sonnet-5-5', messages: [], system: [] }));
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
});

test('credential refusal prevents all network calls and malformed destinations are refused', async () => {
  let calls = 0;
  const fetch = createBridgeTransport({ credentialLoader: async () => { throw Error('private'); }, fetchImpl: async () => { calls++; } });
  assert.equal((await fetch(request({ model: 'claude-sonnet-5-5' }))).status, 401);
  assert.equal((await fetch(request({ model: 'claude-sonnet-5-5' }, 'https://example.invalid/v1/messages'))).status, 400);
  assert.equal(calls, 0);
});

test('generated authorization replaces SDK key and cookie; host content survives with compatibility identity additions', async () => {
  let sent;
  const tools = [{ name: 'task', input_schema: { type: 'object', additionalProperties: true } }];
  const messages = [{ role: 'user', content: 'synthetic prompt' }];
  const system = [{ type: 'text', text: 'synthetic host policy' }];
  const fetch = createBridgeTransport({ credentialLoader: credential, fetchImpl: async (_url, init) => { sent = init; return Response.json({ ok: true }); } });
  await fetch(request({ model: 'claude-sonnet-5-5', messages, system, tools }));
  const headers = new Headers(sent.headers);
  const body = JSON.parse(sent.body);
  assert.equal(headers.get('authorization'), `Bearer ${token}`);
  assert.equal(headers.has('x-api-key'), false);
  assert.equal(headers.has('cookie'), false);
  assert.deepEqual(body.messages, messages);
  assert.deepEqual(body.tools, tools);
  assert.deepEqual(body.system.slice(2), system);
  assert.match(body.system[0].text, /^x-anthropic-billing-header:/);
  assert.match(body.system[1].text, /Claude Agent SDK/);
});

test('redirect, method, unsupported model, and URL query smuggling never dispatch upstream', async () => {
  let calls = 0;
  const fetch = createBridgeTransport({ credentialLoader: credential, fetchImpl: async () => { calls++; return Response.json({}); } });
  assert.equal((await fetch('https://api.anthropic.com/v1/messages', { method: 'GET' })).status, 400);
  assert.equal((await fetch(request({ model: 'not-a-model' }))).status, 400);
  assert.equal((await fetch(request({ model: 'claude-sonnet-5-5' }, 'https://api.anthropic.com/v1/messages?beta=false'))).status, 400);
  assert.equal(calls, 0);
});

test('terminal authentication/billing refusal is sanitized and latched', async () => {
  let calls = 0;
  const fetch = createBridgeTransport({ credentialLoader: credential, fetchImpl: async () => {
    calls++;
    return new Response('{"error":{"type":"invalid_request_error","message":"billing eligibility secret-token"}}', { status: 400 });
  } });
  const first = await fetch(request({ model: 'claude-sonnet-5-5' }));
  assert.equal((await first.json()).error.type, 'billing_or_eligibility_error');
  const second = await fetch(request({ model: 'claude-sonnet-5-5' }));
  assert.equal((await second.json()).error.type, 'bridge_stopped');
  assert.equal(calls, 1);
});

test('credential loader accepts only complete future OAuth environment credential and fixed macOS keychain service', async () => {
  const value = await getBridgeCredential({ env: { CLAUDE_BRIDGE_ACCESS_TOKEN: token, CLAUDE_BRIDGE_EXPIRES_AT: '200000' }, now: 1000 });
  assert.deepEqual(value, { accessToken: token, expiresAt: 200_000_000 });
  await assert.rejects(getBridgeCredential({ env: { CLAUDE_BRIDGE_ACCESS_TOKEN: token }, now: 1000 }));
  let invoked;
  const run = async (...args) => { invoked = args; return { stdout: JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: 200000 } }) }; };
  // Injected runner exercises the fixed Keychain command on every CI platform;
  // no platform's real credential store is read.
  await getBridgeCredential({ env: {}, now: 1000, run });
  assert.deepEqual(invoked.slice(0, 2), ['/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']]);
});

test('SSE passes ordinary bytes unchanged and replaces terminal error content with safe message', async () => {
  const ordinary = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"snow"}}\n\n';
  const normal = await monitorSse(new Response(ordinary, { headers: { 'content-type': 'text/event-stream' } })).text();
  assert.equal(normal, ordinary);
  const malicious = 'event: error\ndata: {"type":"error","error":{"type":"billing_error","message":"private-token"}}\n\n';
  const safe = await monitorSse(new Response(malicious, { headers: { 'content-type': 'text/event-stream' } })).text();
  assert.doesNotMatch(safe, /private-token/);
  assert.match(safe, /billing_or_eligibility_error/);
});

test('usage preflight is strictly opt-in; enabled or unknown status blocks generation', async () => {
  for (const usage of [{}, { extra_usage: { is_enabled: true } }]) {
    let calls = 0;
    const fetch = createBridgeTransport({ credentialLoader: credential, verifyUsage: true, fetchImpl: async url => {
      calls++;
      return url.endsWith('/api/oauth/usage') ? Response.json(usage) : Response.json({ ok: true });
    } });
    const response = await fetch(request({ model: 'claude-sonnet-5-5' }));
    assert.equal((await response.json()).error.type, 'usage_blocked');
    assert.equal(calls, 1);
  }
});
