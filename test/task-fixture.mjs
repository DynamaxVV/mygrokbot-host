// Independent real-Host/SQLite fixture; intentionally does not use shared mocks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHost } from '../src/host.mjs';
import { setAgentBinding } from '../src/providers/bindings.mjs';

export const TEST_TIMEOUT = 12_000;
const PREFIX = 'mgb-regression-5e72a8a1-';
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function within(promise, timeout, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out during ${label}`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
export async function until(fn, message = 'condition', timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${message}`);
}
export function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}
export const tool = (name, args, id = `script-${name}`) => ({ id, name, args });
export function lastUser(body) {
  return [...body.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
}
export async function scriptedProvider(script = () => ({ text: 'final response' })) {
  const requests = [];
  const errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
        res.writeHead(404).end(); return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const request = { body, headers: req.headers, index: requests.length };
      requests.push(request);
      const answer = await script(body, request, requests) ?? {};
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (answer.calls) {
        send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: answer.calls.map((call, index) => ({
          index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
        })) } }] });
      } else send({ choices: [{ index: 0, delta: { role: 'assistant', content: answer.text ?? 'final response' } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: answer.calls ? 'tool_calls' : 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    requests, errors,
    url: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
export async function fixture(t, script) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const resolvedRoot = fs.realpathSync(root);
  const tempParent = fs.realpathSync(os.tmpdir());
  const mock = await scriptedProvider(script);
  const hosts = new Set();
  const beforeClose = [];
  let host;
  const f = {
    root, mock,
    beforeClose(fn) { beforeClose.push(fn); },
    get host() { return host; },
    open() {
      host = createHost({ root, seed: false });
      hosts.add(host);
      return host;
    },
    async closeHost() {
      if (host && hosts.has(host)) { await within(host.close(), 5000, 'Host.close'); hosts.delete(host); }
    },
    async restart() { await f.closeHost(); return f.open(); },
    bot(name = 'Parent', profile = {}) {
      const bot = host.roster.create({ name, ...profile });
      setAgentBinding(root, bot.id, { modelId: name, baseUrl: mock.url, apiKeyEnv: 'MGB_REGRESSION_UNUSED_KEY' });
      return bot;
    },
    run(nonce) { return host.engine.acceptanceStatus(nonce); },
    async state(nonce, state = 'done') {
      return until(() => { const run = f.run(nonce); return run.state === state && run; }, `${nonce} -> ${state}`);
    },
  };
  t.after(async () => {
    // Always close Host/SQLite before validating and deleting this test's root.
    for (const callback of beforeClose) callback();
    for (const item of hosts) await within(item.close(), 5000, 'Host teardown');
    await within(mock.close(), 2000, 'HTTP mock teardown');
    assert.deepEqual(mock.errors, [], 'HTTP scripted handler errors');
    assert.equal(path.isAbsolute(root), true);
    assert.equal(fs.realpathSync(root), resolvedRoot);
    assert.equal(path.dirname(resolvedRoot), tempParent);
    assert.equal(path.basename(resolvedRoot).startsWith(PREFIX), true);
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  });
  f.open();
  return f;
}
