const FRAME_LIMIT = 2 * 1024 * 1024;
const encoder = new TextEncoder();

function classifyError(type, message) {
  if (/extra[\s_-]*usage|credits?|payment|billing|eligib/i.test(message ?? '') || /billing|eligib/i.test(type ?? '')) return 'billing_or_eligibility_error';
  if (/overload/i.test(type ?? '')) return 'overloaded_error';
  if (/invalid_request/i.test(type ?? '')) return 'invalid_request_error';
  if (/not_found/i.test(type ?? '')) return 'not_found_error';
  if (/api_error/i.test(type ?? '')) return 'api_error';
  if (/rate.?limit/i.test(type ?? '')) return 'rate_limit_error';
  if (/auth/i.test(type ?? '')) return 'authentication_error';
  return 'provider_error';
}

function terminalFrame(frame) {
  const text = new TextDecoder().decode(frame);
  const isErrorEvent = text.split(/\r?\n/).some(line => line.trim() === 'event: error');
  const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
  if (!data || data === '[DONE]') return isErrorEvent ? 'provider_error' : null;
  try {
    const parsed = JSON.parse(data);
    const type = parsed?.error?.type ?? parsed?.type;
    if (parsed?.type !== 'error' && !parsed?.error && !isErrorEvent) return null;
    return classifyError(type, parsed?.error?.message ?? parsed?.message);
  } catch { return isErrorEvent ? 'provider_error' : null; }
}

function scalarEvent(frame) {
  const text = new TextDecoder().decode(frame);
  const data = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
  if (!data || data === '[DONE]') return null;
  try {
    const event = JSON.parse(data);
    const usage = event?.usage ?? event?.message?.usage ?? event?.delta?.usage;
    const summary = {};
    if (typeof event?.model === 'string') summary.actualModel = event.model;
    if (typeof event?.message?.model === 'string') summary.actualModel = event.message.model;
    if (usage && typeof usage === 'object') {
      for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
        if (Number.isFinite(usage[key])) summary[key] = usage[key];
      }
    }
    if (event?.type === 'content_block_start' && event?.content_block?.type === 'tool_use') summary.toolCallCountDelta = 1;
    if (event?.type === 'content_block_start' && event?.content_block?.type === 'thinking') summary.reasoningStarted = true;
    if (event?.type === 'content_block_delta' && (event?.delta?.type === 'text_delta' || typeof event?.delta?.text === 'string') && typeof event?.delta?.text === 'string' && event.delta.text.length > 0) summary.firstTextObserved = true;
    if (event?.type === 'content_block_delta' && ['thinking_delta', 'signature_delta'].includes(event?.delta?.type) && typeof event?.delta?.thinking === 'string' && event.delta.thinking.length > 0) summary.reasoningStarted = true;
    return Object.keys(summary).length ? summary : null;
  } catch { return null; }
}

function genericError(type) {
  const message = ({ billing_or_eligibility_error: 'Usage or billing eligibility was refused. Confirm usage is disabled and resolve account eligibility before retrying.', authentication_error: 'Authentication was refused. Renew the authorized Claude Code credential; no alternate credential was tried.', rate_limit_error: 'The provider rate limit was reached. Wait before making another explicit request.', overloaded_error: 'The provider is temporarily overloaded. Wait briefly, then make a new request.', invalid_request_error: 'The provider rejected this request. Check the request format and model.', not_found_error: 'The requested provider resource was not found. Check the model or endpoint.', api_error: 'The provider reported a temporary API error. Wait briefly, then make a new request.', provider_error: 'The provider request failed. Check the request and try a new request later.' })[type] ?? 'Claude bridge request was refused.';
  return encoder.encode(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message } })}\n\n`);
}

function frameEnd(bytes) {
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 10 && bytes[i + 1] === 10) return i + 2;
    if (i + 3 < bytes.length && bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i + 4;
  }
  return -1;
}

/** Pass through ordinary SSE frame bytes exactly; redact terminal error frames before exposing them. */
export function monitorSse(response, { onTerminalError, onEof, onMetadata } = {}) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let buffered = new Uint8Array(0);
  let terminal = false;
  let canceled = false;
  const stream = new ReadableStream({
    async pull(controller) {
      if (terminal) { controller.close(); return; }
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffered.length) {
              const type = terminalFrame(buffered);
              if (type) {
                terminal = true;
                try { await onTerminalError?.(type); } catch {}
                controller.enqueue(genericError(type));
              } else controller.enqueue(buffered);
            }
            try { await onEof?.(); } catch {}
            controller.close();
            return;
          }
          const joined = new Uint8Array(buffered.length + value.length);
          joined.set(buffered); joined.set(value, buffered.length); buffered = joined;
          let end;
          while ((end = frameEnd(buffered)) !== -1) {
            if (end > FRAME_LIMIT) {
              terminal = true;
              try { await onTerminalError?.('provider_error'); } catch {}
              try { await reader.cancel(); } catch {}
              canceled = true;
              controller.enqueue(genericError('provider_error'));
              controller.close();
              return;
            }
            const frame = buffered.slice(0, end);
            buffered = buffered.slice(end);
            const type = terminalFrame(frame);
            if (type) {
              terminal = true;
              try { await onTerminalError?.(type); } catch {}
              try { await reader.cancel(); } catch {}
              canceled = true;
              controller.enqueue(genericError(type));
              controller.close();
              return;
            }
            try { await onMetadata?.(scalarEvent(frame)); } catch {}
            controller.enqueue(frame);
          }
          if (buffered.length > FRAME_LIMIT) {
            terminal = true;
            try { await onTerminalError?.('provider_error'); } catch {}
            try { await reader.cancel(); } catch {}
            canceled = true;
            controller.enqueue(genericError('provider_error'));
            controller.close();
            return;
          }
          if (buffered.length === 0) return;
        }
      } catch {
        if (!canceled) {
          terminal = true;
          try { await reader.cancel(); } catch {}
          try { await onTerminalError?.('provider_error'); } catch {}
          controller.enqueue(genericError('provider_error'));
          controller.close();
        }
      }
    },
    async cancel(reason) {
      terminal = true;
      try { await reader.cancel(reason); } catch {}
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
