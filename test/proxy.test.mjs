// Server agent proxy: routing, refusal semantics, and fallback discipline.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/host.mjs';
import { startMockProvider } from './mock-provider.mjs';
import { setAgentBinding } from '../src/providers/bindings.mjs';
import { ServerAgentProxy, ProxyRefusedError } from '../src/proxy.mjs';

let mock;
let host;
let root;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-proxy-'));
  mock = await startMockProvider();
  host = createHost({ root, seed: false });
});

after(async () => {
  await host.close();
  await mock.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function bot(name, harness) {
  const a = host.roster.create({ name, harness });
  setAgentBinding(root, a.id, { modelId: 'mock-a', baseUrl: mock.url, apiKeyEnv: 'MOCK_KEY' });
  return a;
}

test('only a temporal agent is proxied', () => {
  const local = bot('Local One', 'local');
  const remote = bot('Remote One', 'temporal');
  const retired = bot('Retired One', 'box');
  assert.equal(host.proxy.isProxiedAgent(local.id), false);
  assert.equal(host.proxy.isProxiedAgent(remote.id), true);
  assert.equal(host.proxy.isProxiedAgent(retired.id), false, 'box is not proxied; it is retired');
  assert.equal(host.proxy.isProxiedAgent('nope'), false);
});

test('a proxied sendPrompt reports proxied and is accepted', async () => {
  const remote = bot('Remote Send', 'temporal');
  const out = await host.gateway.methods.sendPrompt({
    agentId: remote.id,
    prompt: 'hello from the proxy path',
  });
  assert.equal(out.proxied, true);
  assert.equal(out.accepted, true);
  assert.match(out.clientNonce, /[0-9a-f-]{36}/);
});

test('acceptance status for a proxied agent goes through the proxy', async () => {
  const remote = bot('Remote Status', 'temporal');
  const sent = await host.gateway.methods.sendPrompt({ agentId: remote.id, prompt: 'status please' });
  const st = await host.gateway.methods.promptAcceptanceStatus({
    agentId: remote.id,
    clientNonce: sent.clientNonce,
  });
  assert.equal(st.proxied, true);
  assert.equal(st.outcome, 'found');
  assert.ok(['accepted', 'running', 'done'].includes(st.state));
});

test('a local agent is not proxied even when the proxy is configured', async () => {
  const local = bot('Local Send', 'local');
  const out = await host.gateway.methods.sendPrompt({ agentId: local.id, prompt: 'local path' });
  assert.equal(out.proxied, undefined);
  assert.equal(out.state, 'accepted');
});

test('a transport failure is a typed refusal, never a local fallback', async () => {
  const remote = bot('Remote Fail', 'temporal');
  const failing = new ServerAgentProxy({
    roster: host.roster,
    transport: { performAction: async () => ({ status: 'error', error: 'server said no' }) },
  });
  await assert.rejects(
    () => failing.act({ method: 'sendPrompt', args: { agentId: remote.id, prompt: 'x' } }),
    (err) => err instanceof ProxyRefusedError && err.kind === 'remote_refusal',
  );
  // The agent's own transcript must stay untouched: the server owns it.
  const rows = host.roster.store(remote.id).readAll({ includeToolCalls: false });
  assert.equal(rows.filter((e) => e.kind === 'message').length, 0);
});

test('a timeout is classified as a timeout', async () => {
  const remote = bot('Remote Slow', 'temporal');
  const slow = new ServerAgentProxy({
    roster: host.roster,
    transport: { performAction: () => new Promise(() => {}) },
  });
  await assert.rejects(
    () => slow.act({ method: 'sendPrompt', args: { agentId: remote.id, prompt: 'x' }, timeoutMs: 30 }),
    (err) => err instanceof ProxyRefusedError && err.kind === 'timeout',
  );
});

test('fallback is opt-in per call site and only where the server cannot serve', async () => {
  const remote = bot('Remote Fallback', 'temporal');
  const refusing = new ServerAgentProxy({
    roster: host.roster,
    transport: { performAction: async () => ({ status: 'error', error: 'unimplemented' }) },
  });
  let fellBack = false;
  await refusing.act({
    method: 'startFreshConversation',
    args: { id: remote.id },
    fallback: () => {
      fellBack = true;
      return null;
    },
  });
  assert.equal(fellBack, true);

  // Without a fallback the same refusal throws.
  await assert.rejects(
    () => refusing.act({ method: 'startFreshConversation', args: { id: remote.id } }),
    ProxyRefusedError,
  );
});

test('no transport configured refuses loudly', async () => {
  const remote = bot('Remote NoTransport', 'temporal');
  const bare = new ServerAgentProxy({ roster: host.roster, transport: null });
  await assert.rejects(
    () => bare.act({ method: 'sendPrompt', args: { agentId: remote.id, prompt: 'x' } }),
    (err) => err.kind === 'no_transport',
  );
});

test('getProxyStatus lists the temporal agents', async () => {
  const status = await host.gateway.methods.getProxyStatus();
  assert.equal(status.configured, true);
  assert.ok(status.proxiedAgents.length >= 1);
  for (const a of status.proxiedAgents) {
    assert.equal(host.roster.profile(a.id).harness, 'temporal');
  }
});

test('route reports proxied alongside the harness decision', async () => {
  const remote = bot('Remote Route', 'temporal');
  const route = await host.gateway.methods.getAgentRoute({ agentId: remote.id });
  assert.equal(route.harness, 'temporal');
  assert.equal(route.proxied, true);
  assert.equal(route.runnable, false, 'the local engine still refuses to run it');
});
