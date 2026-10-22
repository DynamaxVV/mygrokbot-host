// Private regression fixture: real host + SQLite + isolated scripted SSE provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHost } from '../src/host.mjs';
import { setAgentBinding } from '../src/providers/bindings.mjs';

export const terminal = new Set(['done', 'error', 'interrupted', 'needs-reconciliation']);
export async function until(check, description = 'condition', ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}
export function barrier() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}
export const userText = (body) => String([...body.messages].reverse().find((row) => row.role === 'user')?.content ?? '');
export const encoded = (value) => JSON.stringify(value);

export async function fixture(t, { script = null } = {}) {
  const prefix = 'mgb-conversation-regression-';
  const tempDir = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempDir, prefix));
  const requests = [], gates = new Set();
  let seq = 0, host;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) return res.writeHead(404).end();
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const record = { body, index: requests.length, startedAt: Date.now(), finishedAt: null };
      requests.push(record);
      const plan = await script?.(body, record) ?? {};
      if (plan.gate) { gates.add(plan.gate); await plan.gate.promise; gates.delete(plan.gate); }
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const send = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
      if (plan.tool) {
        const tool = plan.tool;
        send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `script-call-${++seq}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args ?? {}) } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ choices: [{ index: 0, delta: { role: 'assistant', content: plan.text ?? `RESULT:${body.model}:${record.index}` } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      send({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
      record.finishedAt = Date.now();
      res.end('data: [DONE]\n\n');
    } catch (error) { if (!res.destroyed) res.writeHead(500).end(String(error)); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${server.address().port}/v1`;
  host = createHost({ root, seed: false });
  let url;
  const startGateway = async () => {
    const info = await host.gateway.listen({ port: 0 });
    url = `http://127.0.0.1:${info.port}`;
  };
  await startGateway();
  const f = {
    root, requests, providerUrl,
    get host() { return host; },
    bot(name, extra = {}) {
      const bot = host.roster.create({ name, ...extra });
      setAgentBinding(root, bot.id, { modelId: `script-${name}`, baseUrl: providerUrl });
      return bot;
    },
    group(name, bots) { return host.roster.createGroup({ name, memberAgentIds: bots.map((bot) => bot.id) }); },
    async rpc(method, args = {}, { status = 200 } = {}) {
      const response = await fetch(`${url}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(5000) });
      const body = await response.json();
      assert.equal(response.status, status, `${method}: ${JSON.stringify(body)}`);
      if (status !== 200) return body;
      assert.equal(body.ok, true, `${method}: ${JSON.stringify(body)}`);
      return body.result;
    },
    async send(agent, prompt, extra = {}) { return f.rpc('sendPrompt', { agentId: agent.id, prompt, ...extra }); },
    async settled(nonce) { return until(() => { const run = host.engine.acceptanceStatus(nonce); return terminal.has(run.state) && run; }, `run ${nonce} terminal`); },
    async groupSettled(nonce) { return until(() => { const admission = host.rooms.admission(nonce); return admission?.targets.every((target) => terminal.has(target.state) || target.state === 'skipped') && admission; }, `group ${nonce} terminal`); },
    async rows(agent) { return f.rpc('getAgentTranscriptAll', { agentId: agent.id }); },
    async restart() { await host.close(); host = createHost({ root, seed: false }); await startGateway(); },
  };
  t.after(async () => {
    for (const gate of gates) gate.release();
    await host.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const absolute = path.resolve(root);
    assert.equal(absolute, root);
    assert.equal(path.dirname(absolute), tempDir);
    assert.ok(path.basename(absolute).startsWith(prefix));
    assert.equal(fs.realpathSync(absolute), absolute);
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return f;
}
