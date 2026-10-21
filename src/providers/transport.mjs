// OpenAI-compatible streaming transport (chat/completions + SSE).
//
// Kept deliberately close to the reference hop session's contract:
//   POST {baseUrl}/chat/completions
//   body: { model, messages, tools, stream: true, stream_options: { include_usage: true } }
//   events: text deltas, reasoning deltas, tool_call deltas, finish reason, usage
//
// Emits an async iterable of events so the turn engine never buffers a whole reply.

import { applyProviderReasoningControls, routeNameForModel } from './maps.mjs';

function trimSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

export function completionsUrl(baseUrl) {
  const base = trimSlash(baseUrl);
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

function parseSseChunk(buffer) {
  const events = [];
  let idx;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length) events.push(dataLines.join('\n'));
  }
  return { events, rest: buffer };
}

function collectToolCalls(map) {
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

export async function* streamChat({
  baseUrl,
  apiKey,
  modelId,
  messages,
  tools,
  maxMode = false,
  parameters = [],
  signal,
  extraHeaders = {},
  fetchImpl = fetch,
}) {
  const body = {
    model: modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const route = applyProviderReasoningControls(body, { modelId, baseUrl, maxMode, parameters });

  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'user-agent': 'mygrokbot/0.1',
    ...extraHeaders,
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const url = completionsUrl(baseUrl);
  const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    const err = new Error(`provider ${res.status}: ${text.slice(0, 400) || res.statusText}`);
    err.status = res.status;
    err.route = route;
    throw err;
  }

  yield {
    type: 'route',
    route,
    url,
    model: body.model,
    httpStatus: res.status,
    upstreamId: res.headers.get('x-request-id') ?? null,
    responseModel: null,
  };

  const toolCalls = new Map();
  let seenUpstreamId = null;
  let usage = null;
  let finishReason = null;
  let buffer = '';
  const decoder = new TextDecoder();

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const parsed = parseSseChunk(buffer);
    buffer = parsed.rest;
    for (const data of parsed.events) {
      if (data === '[DONE]') {
        if (toolCalls.size) yield { type: 'tool_calls', calls: collectToolCalls(toolCalls) };
        yield { type: 'done', finishReason, usage };
        return;
      }
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (payload.id && !seenUpstreamId) {
        seenUpstreamId = payload.id;
        yield { type: 'upstream', upstreamId: payload.id, responseModel: payload.model ?? null };
      }
      if (payload.usage) usage = payload.usage;
      const choice = payload.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content };
      if (delta.reasoning) yield { type: 'reasoning', text: delta.reasoning };
      if (typeof delta.content === 'string' && delta.content.length) {
        yield { type: 'text', text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const key = tc.index ?? 0;
        const current = toolCalls.get(key) ?? { id: tc.id ?? `call-${key}`, name: '', args: '' };
        if (tc.id) current.id = tc.id;
        if (tc.function?.name) current.name = tc.function.name;
        if (tc.function?.arguments) current.args += tc.function.arguments;
        toolCalls.set(key, current);
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  if (toolCalls.size) yield { type: 'tool_calls', calls: collectToolCalls(toolCalls) };
  yield { type: 'done', finishReason, usage };
}

export { routeNameForModel };
