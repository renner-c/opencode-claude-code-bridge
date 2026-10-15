import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeTransport as createBridgeTransportBase } from '../transport.mjs';
// Existing strict-preflight cases remain opt-in diagnostic coverage.
const createBridgeTransport=(options={})=>createBridgeTransportBase({verifyUsage:true,...options});

test('default account-disabled policy sends only the model POST, never a usage query',async()=>{
  let calls=0;const f=createBridgeTransportBase({credentialLoader:async()=>({accessToken:'sk-ant-oatSYNTHETICACCOUNT123',expiresAt:Date.now()+3600000}),fetchImpl:async(url,init)=>{
    calls++;assert.equal(new URL(url).pathname,'/v1/messages');assert.equal(init.method,'POST');return Response.json({model:'claude-sonnet-5-5',content:[]});
  }});
  const r=await f('https://api.anthropic.com/v1/messages',{method:'POST',body:JSON.stringify({model:'claude-sonnet-5-5',messages:[],system:[]})});
  assert.equal(r.status,200);assert.equal(calls,1);
});
import { getBridgeCredential } from '../auth.mjs';

test('an explicit usage-endpoint authentication refusal stays latched',async()=>{
  let calls=0;const f=createBridgeTransport({credentialLoader:async()=>({accessToken:'sk-ant-oatSYNTHETICAUTH123',expiresAt:Date.now()+3600000}),fetchImpl:async()=>{calls++;return new Response('{}',{status:401});}});
  const body=JSON.stringify({model:'claude-sonnet-5-5',messages:[],system:[]});
  const first=await f('https://api.anthropic.com/v1/messages',{method:'POST',body});
  assert.equal((await first.json()).error.type,'authentication_error');
  assert.equal(f.state().stopped,true);
  await f('https://api.anthropic.com/v1/messages',{method:'POST',body});assert.equal(calls,1);
});

test('Keychain lookup uses the real account home, not an isolated native test HOME',async()=>{
  const previous=process.env.HOME;process.env.HOME='/owned-isolated-home';let options;
  try{
    await getBridgeCredential({env:{},now:1000,run:async(_bin,_args,opts)=>{options=opts;return{stdout:JSON.stringify({claudeAiOauth:{accessToken:'sk-ant-oatSYNTHETICKEYCHAIN123',expiresAt:200000}})};}});
    assert.equal(Object.hasOwn(options.env,'HOME'),false);
    assert.equal(process.env.HOME,'/owned-isolated-home');
  }finally{if(previous===undefined)delete process.env.HOME;else process.env.HOME=previous;}
});
import { monitorSse } from '../sse.mjs';

const cred = async () => Object.freeze({ accessToken: 'sk-ant-oatfixture_token_123456', expiresAt: Date.now() + 120_000 });
const request = (body, url = 'https://api.anthropic.com/v1/messages') => new Request(url, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'native-placeholder', cookie: 'ignored' }, body: JSON.stringify(body)
});

test('credential getter accepts explicit token only with finite future expiry and freezes result', async () => {
  const value = await getBridgeCredential({ env: { CLAUDE_BRIDGE_ACCESS_TOKEN: 'sk-ant-oatfixture_token_123456', CLAUDE_BRIDGE_EXPIRES_AT: '200000' }, now: 1000 });
  assert.deepEqual(value, { accessToken: 'sk-ant-oatfixture_token_123456', expiresAt: 200_000_000 });
  assert.equal(Object.isFrozen(value), true);
  await assert.rejects(getBridgeCredential({ env: { CLAUDE_BRIDGE_ACCESS_TOKEN: 'sk-ant-oatfixture_token_123456' }, now: 1000 }), /authentication_error/);
  await assert.rejects(getBridgeCredential({ env: { CLAUDE_BRIDGE_ACCESS_TOKEN: 'sk-ant-api03_not-oauth-token', CLAUDE_BRIDGE_EXPIRES_AT: '200000' }, now: 1000 }), /authentication_error/);
  await assert.rejects(getBridgeCredential({ env: { CLAUDE_BRIDGE_ACCESS_TOKEN: 'sk-ant-oatfixture_token_123456', CLAUDE_BRIDGE_EXPIRES_AT: '61' }, now: 1000 }), /authentication_error/);
  await assert.rejects(getBridgeCredential({ env: { CLAUDE_BRIDGE_ACCESS_TOKEN: 'sk-ant-oatfixture_token_123456', CLAUDE_BRIDGE_EXPIRES_AT: '946684800000' }, now: Date.now() }), /authentication_error/);
});

test('credential getter invokes only the fixed Keychain service and returns no extra fields', async () => {
  let invocation;
  const value = await getBridgeCredential({ env: {}, now: 1000, run: async (...args) => {
    invocation = args;
    return { stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oatfixture_token_123456', expiresAt: 200000, refreshToken: 'must-not-return' }, accessToken: 'sk-ant-oatroot_token_123456', expiresAt: 200000 }) };
  } });
  assert.deepEqual(invocation.slice(0, 2), ['/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w']]);
  assert.deepEqual(Object.keys(value).sort(), ['accessToken', 'expiresAt']);
  await assert.rejects(getBridgeCredential({ env: {}, now: 1000, run: async () => ({ stdout: JSON.stringify({ accessToken: 'sk-ant-oatroot_token_123456', expiresAt: 200000000 }) }) }), /authentication_error/);
});

test('preserves host system, history, tools, arguments, and tool choice exactly', async () => {
  const hostBlock = 'Full OpenCode + Claude policy: never delete critical boundaries or rewrite cwd /Users/example.';
  const tools = [
    { name: 'task', description: 'task', input_schema: { type: 'object', properties: { subagent_type: { type: 'string' }, task_id: { type: 'string' }, command: { type: 'string' }, custom: { type: 'object' } }, additionalProperties: true } },
    { name: 'mcp_custom', description: 'custom', input_schema: { type: 'object', additionalProperties: true } },
    { name: 'Agent', description: 'custom named Agent', input_schema: { type: 'object', properties: { any: { type: 'string' } } } },
  ];
  const args = { subagent_type: 'Explore', task_id: 'id-7', command: 'keep', nested: { camelCase: true }, quoted: '"file_path" activeForm' };
  const messages = [{ id: 'm-1', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'task', input: args }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '"hello"' }] }];
  let outgoing;
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async (url, init) => {
    if (url.endsWith('/api/oauth/usage')) return Response.json({ extra_usage: { is_enabled: false } });
    outgoing = JSON.parse(init.body);
    return Response.json({ ok: true });
  } });
  const body = { model: 'claude-sonnet-4-5', max_tokens: 777, output_config: { effort: 'max' }, system: [{ type: 'text', text: hostBlock, cache_control: { type: 'ephemeral' } }], messages, tools, tool_choice: { type: 'tool', name: 'task' }, metadata: { user_id: 'host-metadata' }, custom: { untouched: true } };
  await transport(request(body));
  assert.deepEqual(outgoing.system.slice(2), body.system);
  assert.deepEqual(outgoing.messages, messages);
  assert.deepEqual(outgoing.tools, tools);
  assert.deepEqual(outgoing.tool_choice, body.tool_choice);
  assert.deepEqual(outgoing.metadata, body.metadata);
  assert.deepEqual(outgoing.custom, body.custom);
  assert.equal(outgoing.model, body.model);
  assert.equal(outgoing.max_tokens, 777);
  assert.equal(outgoing.output_config.effort, 'max');
  assert.match(outgoing.system[0].text, /^x-anthropic-billing-header:/);
  assert.match(outgoing.system[1].text, /Claude Agent SDK/);
});

test('uses one OFF usage preflight per generation and strips SDK key/cookie credentials', async () => {
  const calls = [];
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/api/oauth/usage') ? Response.json({ extra_usage: { is_enabled: false } }) : new Response('{}');
  } });
  await transport(request({ model: 'claude-opus-4-5', max_tokens: 200, system: [], messages: [], tools: [] }));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(calls[1].init.headers.get('authorization'), 'Bearer sk-ant-oatfixture_token_123456');
  assert.equal(calls[1].init.headers.get('content-type'), 'application/json');
  assert.match(calls[0].init.headers.get('anthropic-beta'), /oauth-2025-04-20/);
  assert.equal(calls[1].init.headers.has('x-api-key'), false);
  assert.equal(calls[1].init.headers.has('cookie'), false);
});

test('expired credentials fail before usage or generation HTTP', async () => {
  let calls = 0;
  const transport = createBridgeTransport({ credentialLoader: async () => ({ accessToken: 'fake', expiresAt: 1 }), fetchImpl: async () => { calls++; } });
  const response = await transport(request({ model: 'claude-sonnet-4-5' }));
  assert.equal((await response.json()).error.type, 'authentication_error');
  assert.equal(calls, 0);
});

test('unknown or enabled extra usage fails closed without generation', async () => {
  for (const usage of [{}, { extra_usage: { is_enabled: true } }]) {
    let calls = 0;
    const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async () => { calls++; return Response.json(usage); } });
    const response = await transport(request({ model: 'claude-sonnet-4-5' }));
    assert.equal((await response.json()).error.type, 'usage_blocked');
    assert.equal(calls, 1);
  }
});

test('transient usage preflight failure refuses only this request; next explicit request rechecks OFF', async () => {
  let usage = 0, generation = 0;
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async url => {
    if (!url.endsWith('/api/oauth/usage')) { generation++; return Response.json({ ok: true }); }
    usage++;
    return usage === 1 ? Response.json({ message: 'private' }, { status: 503 }) : Response.json({ extra_usage: { is_enabled: false } });
  } });
  assert.equal((await transport(request({ model: 'claude-sonnet-4-5' }))).status, 503);
  assert.equal(generation, 0);
  assert.equal((await transport(request({ model: 'claude-sonnet-4-5' }))).status, 200);
  assert.equal(usage, 2);
  assert.equal(generation, 1);
});

test('transient SSE overload does not permanently stop later explicit request', async () => {
  let now = 1000, usage = 0, generation = 0;
  const transport = createBridgeTransport({ credentialLoader: cred, now: () => now, fetchImpl: async url => {
    if (url.endsWith('/api/oauth/usage')) { usage++; return Response.json({ extra_usage: { is_enabled: false } }); }
    generation++;
    return generation === 1
      ? new Response('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"private"}}\n\n', { headers: { 'content-type': 'text/event-stream' } })
      : Response.json({ ok: true });
  } });
  assert.match(await (await transport(request({ model: 'claude-sonnet-4-5' }))).text(), /overloaded_error/);
  now += 301_000;
  assert.equal((await transport(request({ model: 'claude-sonnet-4-5' }))).status, 200);
  assert.equal(usage, 2);
  assert.equal(generation, 2);
});

test('local invalid model does not poison a subsequent valid request', async () => {
  let generations = 0;
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async url => url.endsWith('/api/oauth/usage') ? Response.json({ extra_usage: { is_enabled: false } }) : (generations++, Response.json({ ok: true })) });
  assert.equal((await transport(request({ model: 'not-a-model' }))).status, 400);
  assert.equal((await transport(request({ model: 'claude-sonnet-4-5' }))).status, 200);
  assert.equal(generations, 1);
});

test('response body passes through and downstream cancellation propagates', async () => {
  let canceled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"partial_json":"{\\"x\\":1}"}}\r\n\r\n')); }, cancel() { canceled = true; } });
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async (url) => url.endsWith('/api/oauth/usage') ? Response.json({ extra_usage: { is_enabled: false } }) : new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await transport(request({ model: 'claude-sonnet-4-5' }));
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: {"type":"content_block_delta","delta":{"partial_json":"{\\"x\\":1}"}}\r\n\r\n');
  await reader.cancel();
  assert.equal(canceled, true);
});

test('fragmented CRLF UTF-8 SSE frames pass through byte-identically and metadata excludes content', async () => {
  const wire = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"雪"}}\r\n\r\n';
  const bytes = new TextEncoder().encode(wire);
  const events = [];
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
  const output = await monitorSse(response, { onMetadata: value => events.push(value) }).text();
  assert.equal(output, wire);
  assert.equal(events.some(event => event?.firstTextObserved), true);
  assert.equal(JSON.stringify(events).includes('雪'), false);
});

test('JSON response is byte-identical', async () => {
  const raw = '{ "content" : ["quoted\\ntext", {"type":"tool_use","input":{"x":1}}] }';
  let generationCalls = 0;
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async (url) => {
    if (url.endsWith('/api/oauth/usage')) return Response.json({ extra_usage: { is_enabled: false } });
    generationCalls++;
    return new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const response = await transport(request({ model: 'claude-haiku-4-5-20251001' }));
  assert.equal(await response.text(), raw);
  assert.equal(generationCalls, 1);
});

test('redirect response is refused and never followed', async () => {
  let generationCalls = 0;
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async (url) => {
    if (url.endsWith('/api/oauth/usage')) return Response.json({ extra_usage: { is_enabled: false } });
    generationCalls++;
    return new Response(null, { status: 302, headers: { location: 'https://example.invalid/steal' } });
  } });
  const response = await transport(request({ model: 'claude-sonnet-4-5' }));
  assert.equal(response.status, 502);
  assert.equal(generationCalls, 1);
});

test('rejects URL smuggling and invalid beta before reading credentials', async () => {
  let credentials = 0, network = 0;
  const transport = createBridgeTransport({ credentialLoader: async () => { credentials++; return cred(); }, fetchImpl: async (url) => { network++; return url.endsWith('/api/oauth/usage') ? Response.json({ extra_usage: { is_enabled: false } }) : Response.json({}); } });
  for (const url of [
    'https://api.anthropic.com/v1/messages?beta=false',
    'https://api.anthropic.com/v1/messages?beta=true&beta=false',
    'https://api.anthropic.com/v1/messages#fragment',
  ]) {
    const response = await transport(request({ model: 'claude-sonnet-4-5' }, url));
    assert.equal(response.status, 400);
  }
  const credentialUrl = await transport('https://user:pass@api.anthropic.com/v1/messages', { method: 'POST', body: '{}' });
  assert.equal(credentialUrl.status, 400);
  const betaHeaderRequest = await transport(new Request('https://api.anthropic.com/v1/messages', { method: 'POST', headers: [['content-type', 'application/json'], ['anthropic-beta', 'custom-flag']], body: JSON.stringify({ model: 'claude-sonnet-4-5' }) }));
  assert.equal(betaHeaderRequest.status, 200);
  assert.equal(credentials, 1);
  assert.equal(network, 2);
});

test('preserves caller effort levels and rejects invalid or conflicting private effort before HTTP', async () => {
  let calls = 0;
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async (url, init) => {
    calls++;
    return url.endsWith('/api/oauth/usage') ? Response.json({ extra_usage: { is_enabled: false } }) : Response.json(JSON.parse(init.body).output_config);
  } });
  for (const effort of ['low', 'medium', 'high', 'max']) {
    await transport(request({ model: 'claude-sonnet-4-5', output_config: { effort } }));
  }
  assert.equal(calls, 8);
  const bad = await transport(request({ model: 'claude-sonnet-4-5', output_config: { effort: 'xhigh' } }));
  assert.equal(bad.status, 400);
  assert.equal(calls, 8);
  const conflict = await transport(new Request('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-bridge-effort': 'high' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', output_config: { effort: 'low' } }) }));
  assert.equal(conflict.status, 400);
  assert.equal(calls, 8);
  const internal = await transport(new Request('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-opencode-bridge-effort': 'high' }, body: JSON.stringify({ model: 'claude-sonnet-4-5' }) }));
  assert.deepEqual(await internal.json(), { effort: 'high' });
  assert.equal(calls, 10);
});

test('SSE terminal billing errors are sanitized, latched, and prevent the next dispatch', async () => {
  let generation = 0;
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async (url) => {
    if (url.endsWith('/api/oauth/usage')) return Response.json({ extra_usage: { is_enabled: false } });
    generation++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: error\r\ndata: {"type":"error","error":{"type":"billing_error","message":"secret sk-ant-oatPRIVATE123"}}\r\n\r\n'));
      controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const response = await transport(request({ model: 'claude-sonnet-4-5' }));
  const text = await response.text();
  assert.doesNotMatch(text, /PRIVATE123/);
  assert.equal(generation, 1);
  const blocked = await transport(request({ model: 'claude-sonnet-4-5' }));
  assert.equal((await blocked.json()).error.type, 'bridge_stopped');
  assert.equal(generation, 1);
});

test('malformed SSE error frames fail closed without exposing their data', async () => {
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async url => url.endsWith('/api/oauth/usage')
    ? Response.json({ extra_usage: { is_enabled: false } })
    : new Response('event: error\ndata: {"message":"secret malformed-private"}\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await transport(request({ model: 'claude-sonnet-4-5' }));
  const result = await response.text();
  assert.doesNotMatch(result, /malformed-private/);
  assert.match(result, /provider_error/);
});

test('SSE frame above the bounded 2 MiB limit fails closed instead of truncating', async () => {
  let canceled = false;
  const upstream = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1).fill(120)); }, cancel() { canceled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  const safe = await monitorSse(upstream).text();
  assert.match(safe, /provider_error/);
  assert.doesNotMatch(safe, /x{100}/);
  assert.equal(canceled, true);
});

test('unsupported destination never reaches fetch', async () => {
  let calls = 0;
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async () => { calls++; } });
  const response = await transport(request({ model: 'claude-sonnet-4-5' }, 'https://example.invalid/v1/messages'));
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('refusal responses are sanitized and stop future generations', async () => {
  let generation = 0;
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl: async (url) => {
    if (url.endsWith('/api/oauth/usage')) return Response.json({ extra_usage: { is_enabled: false } });
    generation++;
    return new Response('{"error":{"message":"private detail"}}', { status: 403 });
  } });
  const first = await transport(request({ model: 'claude-sonnet-4-5' }));
  assert.equal(first.status, 403);
  assert.doesNotMatch(await first.text(), /private detail/);
  const stopped = await transport(request({ model: 'claude-sonnet-4-5' }));
  assert.equal((await stopped.json()).error.type, 'bridge_stopped');
  assert.equal(generation, 1);
});

test('HTTP billing refusal is latched from safe error message classification and carries attempt id', async () => {
  const calls = [];
  let usageCalls = 0;
  const attempts = new WeakMap();
  const fetchImpl = async url => {
    if (url.endsWith('/api/oauth/usage')) { usageCalls++; return Response.json({ extra_usage: { is_enabled: false } }); }
    calls.push(url);
    const response = Response.json({ error: { type: 'invalid_request_error', message: 'Extra Usage required; secret sk-ant-oatPRIVATE' } }, { status: 400 });
    attempts.set(response, `attempt-${calls.length}`);
    return response;
  };
  fetchImpl.attemptIdFor = response => attempts.get(response);
  const events = [];
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl, metadata: async event => { await Promise.resolve(); events.push(event); } });
  const first = await transport(request({ model: 'claude-sonnet-4-5' }));
  assert.equal((await first.json()).error.type, 'billing_or_eligibility_error');
  assert.equal(calls.length, 1);
  assert.equal(usageCalls, 1);
  const second = await transport(request({ model: 'claude-sonnet-4-5' }));
  assert.equal((await second.json()).error.type, 'bridge_stopped');
  assert.equal(calls.length, 1);
  assert.equal(events[0].attemptId, 'attempt-1');
  assert.equal(events[0].terminalKind, 'billing');
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|Extra Usage/);
});

test('overlapping response metadata remains bound to the response attempt id', async () => {
  const attempts = new WeakMap();
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/api/oauth/usage')) return Response.json({ extra_usage: { is_enabled: false } });
    const model = JSON.parse(init.body).model;
    const response = Response.json({ model: `actual-${model}`, usage: { output_tokens: model.length }, content: [{ type: 'text', text: 'private text' }] });
    attempts.set(response, `attempt-for-${model}`);
    await new Promise(resolve => setTimeout(resolve, model.includes('sonnet') ? 5 : 1));
    return response;
  };
  fetchImpl.attemptIdFor = response => attempts.get(response);
  const events = [];
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl, metadata: async event => { await Promise.resolve(); events.push(event); } });
  await Promise.all([transport(request({ model: 'claude-sonnet-4-5' })), transport(request({ model: 'claude-opus-4-5' }))]);
  assert.equal(events.length, 2);
  assert.deepEqual(new Set(events.map(event => event.attemptId)), new Set(['attempt-for-claude-sonnet-4-5', 'attempt-for-claude-opus-4-5']));
  assert.ok(events.every(event => event.actualModel === `actual-${event.model}`));
  assert.doesNotMatch(JSON.stringify(events), /private text/);
});

test('split SSE billing error is sanitized before forwarding and metadata awaits attempt-bound observers', async () => {
  const attempts = new WeakMap();
  let usageCalls = 0, credentialCalls = 0;
  const fetchImpl = async url => {
    if (url.endsWith('/api/oauth/usage')) { usageCalls++; return Response.json({ extra_usage: { is_enabled: false } }); }
    const encoder = new TextEncoder();
    const parts = ['event: error\r\ndata: {"type":"error","error":{"type":"invalid_request_error","message":"Extra Usage required secret sk-ant-oatPRIVATE"}}\r\n\r\n'];
    const response = new Response(new ReadableStream({ start(controller) { const bytes = encoder.encode(parts[0]); controller.enqueue(bytes.slice(0, 32)); controller.enqueue(bytes.slice(32)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    attempts.set(response, 'stream-attempt');
    return response;
  };
  fetchImpl.attemptIdFor = response => attempts.get(response);
  const events = [];
  const transport = createBridgeTransport({ credentialLoader: async () => { credentialCalls++; return cred(); }, fetchImpl, metadata: async event => { await Promise.resolve(); events.push(event); } });
  const result = await (await transport(request({ model: 'claude-sonnet-4-5' }))).text();
  assert.match(result, /billing_or_eligibility_error/);
  assert.doesNotMatch(result, /PRIVATE|Extra Usage/);
  assert.equal(events[0].attemptId, 'stream-attempt');
  assert.equal(events[0].terminalKind, 'billing');
  const blocked = await transport(request({ model: 'claude-sonnet-4-5' }));
  assert.equal((await blocked.json()).error.type, 'bridge_stopped');
  assert.equal(usageCalls, 1);
  assert.equal(credentialCalls, 1);
});

test('SSE TTFT includes dispatch-to-headers delay and deduplicates first-text metadata', async () => {
  let clock = 0;
  const attempts = new WeakMap();
  const fetchImpl = async url => {
    if (url.endsWith('/api/oauth/usage')) return Response.json({ extra_usage: { is_enabled: false } });
    await new Promise(resolve => setTimeout(resolve, 5));
    clock = 50;
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-4-5"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"b"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
    ].join('');
    const response = new Response(new ReadableStream({ pull(controller) { clock = 80; controller.enqueue(new TextEncoder().encode(frames)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    attempts.set(response, 'ttft-attempt');
    return response;
  };
  fetchImpl.attemptIdFor = response => attempts.get(response);
  const events = [];
  const transport = createBridgeTransport({ credentialLoader: cred, fetchImpl, monotonicNow: () => clock, metadata: async event => { await Promise.resolve(); events.push(event); } });
  const response = await transport(request({ model: 'claude-sonnet-4-5' }));
  await response.text();
  const firstText = events.filter(event => event.firstTextObserved);
  assert.equal(firstText.length, 1);
  assert.equal(firstText[0].firstTextMs, 80);
  assert.ok(events.some(event => event.actualModel === 'claude-sonnet-4-5'));
  assert.ok(events.some(event => event.output_tokens === 7));
  assert.ok(events.every(event => event.attemptId === 'ttft-attempt'));
});
