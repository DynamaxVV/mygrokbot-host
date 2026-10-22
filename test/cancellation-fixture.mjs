// Isolated provider and lifecycle helpers for cancellation regressions only.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHost } from '../src/host.mjs';
import { setAgentBinding } from '../src/providers/bindings.mjs';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
export async function waitFor(fn, message = 'condition', ms = 2500) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${message}`);
}
export async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-cancellation-'));
  const scripts = new Map(), requests = [], held = new Set();
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const prompt = [...body.messages].reverse().find((m) => m.role === 'user')?.content;
      const script = scripts.get(prompt);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      if (script === 'hold') {
        send({ content: 'waiting' });
        held.add(res);
        res.on('close', () => held.delete(res));
        return;
      }
      if (Array.isArray(script) && body.messages.at(-1)?.role !== 'tool') {
        send({ tool_calls: script.map((call, index) => ({ index, id: call.id ?? `fixture-call-${++seq}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) });
        send({}, 'tool_calls');
      } else {
        send({ content: 'finished' });
        send({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { res.destroy(error); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = createHost({ root, seed: false });
  const agents = [];
  function bot(name = `Cancellation ${agents.length}`) {
    const agent = host.roster.create({ name });
    setAgentBinding(root, agent.id, { modelId: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    agents.push(agent);
    return agent.id;
  }
  t.after(async () => {
    // Drain/close before validating and deleting the single root we created.
    await host.close();
    for (const res of held) res.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    const absolute = path.resolve(root);
    assert.equal(absolute, root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('mgb-cancellation-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return {
    host, root, scripts, requests, bot,
    send: (agentId, prompt, script) => { if (script !== undefined) scripts.set(prompt, script); return host.engine.admit({ agentId, prompt }); },
    run: (run) => host.engine.getRun(run.runId),
    entries: (agentId) => host.roster.store(agentId).readAll(),
    parked: (run) => waitFor(() => host.engine.execution.listInteractions().find((a) => a.runId === run.runId && a.state === 'pending'), 'parked interaction'),
    done: async (run) => { await waitFor(() => ['done', 'error', 'interrupted'].includes(host.engine.getRun(run.runId)?.state), 'terminal run'); await host.engine.scheduler.drain(); return host.engine.getRun(run.runId); },
  };
}
