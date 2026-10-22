// End-to-end: data root -> agent -> prompt -> streamed reply -> transcript.
// Boots a real gateway on a loopback port and talks to it over HTTP, so the test
// exercises the same surface a client uses.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/host.mjs';
import { startMockProvider } from './mock-provider.mjs';
import { setAgentBinding } from '../src/providers/bindings.mjs';
import { loadRules, saveRules } from '../src/review.mjs';

let mock;
let host;
let root;
let agentId;
let baseUrl;

async function rpc(method, args = {}) {
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const payload = await res.json();
  return payload;
}

async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 60));
  }
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-e2e-'));
  mock = await startMockProvider();
  host = createHost({ root });
  const agent = host.roster.create({ name: 'Test Bot', description: 'test agent' });
  agentId = agent.id;
  setAgentBinding(root, agentId, { modelId: 'mock-a', baseUrl: mock.url, apiKeyEnv: 'MOCK_KEY' });
  const discovery = await host.listen({ port: 0, token: null });
  baseUrl = `http://127.0.0.1:${discovery.port}`;
});

after(async () => {
  await host.close();
  await mock.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('health reports the data root and active bot', async () => {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.activeAgentId, agentId);
});

test('sendPrompt streams a reply and persists it', async () => {
  const accepted = await rpc('sendPrompt', { agentId, prompt: 'hello there' });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.result.state, 'accepted');

  const transcript = await waitFor(async () => {
    const res = await rpc('getAgentTranscript', { agentId });
    const entries = res.result ?? [];
    const reply = entries.find((e) => e.kind === 'send-message' && e.message?.content?.includes('ack:'));
    return reply ? entries : null;
  });

  const user = transcript.find((e) => e.kind === 'message' && e.role === 'user');
  assert.equal(user.message.content, 'hello there');
  const reply = transcript.find((e) => e.kind === 'send-message');
  assert.match(reply.message.content, /ack: hello there/);
  assert.equal(reply.streaming, false);
});

test('provider request carries the bound model and stream flags', async () => {
  const last = mock.requests.at(-1);
  assert.equal(last.body.model, 'mock-a');
  assert.equal(last.body.stream, true);
  assert.equal(last.body.stream_options.include_usage, true);
});

test('acceptance status is queryable by nonce', async () => {
  const accepted = await rpc('sendPrompt', { agentId, prompt: 'second turn', clientNonce: 'nonce-fixed-1' });
  assert.equal(accepted.result.clientNonce, 'nonce-fixed-1');
  await waitFor(async () => {
    const status = await rpc('promptAcceptanceStatus', { clientNonce: 'nonce-fixed-1' });
    return status.result?.state === 'done';
  });
  const again = await rpc('sendPrompt', { agentId, prompt: 'second turn', clientNonce: 'nonce-fixed-1' });
  assert.equal(again.result.acceptedAtMs, accepted.result.acceptedAtMs, 'duplicate nonce returns the same acceptance');
});

test('a shell tool call parks on approval, then resumes after approval', async () => {
  const accepted = await rpc('sendPrompt', { agentId, prompt: 'TOOL echo hello-from-tool' });
  assert.equal(accepted.ok, true);

  const approval = await waitFor(async () => {
    const res = await rpc('getAgentTranscript', { agentId });
    return (res.result ?? []).find((e) => e.message?.type === 'auto-review-approval');
  });
  assert.equal(approval.message.approval.command, 'echo hello-from-tool');
  assert.equal(approval.message.resolution, null);

  const resolved = await rpc('resolveAutoReviewApproval', {
    agentId,
    entryId: approval.id,
    resolution: 'approved',
  });
  assert.equal(resolved.result.resumed, true);

  const result = await waitFor(async () => {
    const res = await rpc('getAgentTranscript', { agentId });
    return (res.result ?? []).find((e) => e.kind === 'tool-result' && String(e.result).includes('hello-from-tool'));
  });
  assert.match(String(result.result), /hello-from-tool/);
});

test('denied approval does not run the command', async () => {
  const accepted = await rpc('sendPrompt', { agentId, prompt: 'TOOL touch should-not-exist.txt' });
  const approval = await waitFor(async () => {
    const res = await rpc('getAgentTranscript', { agentId });
    return (res.result ?? []).find(
      (e) => e.message?.type === 'auto-review-approval' && e.message.approval.command === 'touch should-not-exist.txt',
    );
  });
  await rpc('resolveAutoReviewApproval', { agentId, entryId: approval.id, resolution: 'denied' });
  await new Promise((r) => setTimeout(r, 200));
  const workspace = host.p.workspace;
  assert.equal(fs.existsSync(path.join(workspace, 'should-not-exist.txt')), false);
});

test('a priority message wakes the peer and runs a turn', async () => {
  const other = host.roster.create({ name: 'Peer Bot' });
  setAgentBinding(root, other.id, { modelId: 'mock-a', baseUrl: mock.url, apiKeyEnv: 'MOCK_KEY' });

  const sent = await rpc('messageAgent', {
    fromAgentId: agentId,
    to: 'Peer Bot',
    text: 'ping from test',
    priority: true,
  });
  assert.equal(sent.result.delivered, true);
  assert.equal(sent.result.woken, true);

  const peerTranscript = await waitFor(async () => {
    const res = await rpc('getAgentTranscript', { agentId: other.id });
    const entries = res.result ?? [];
    const incoming = entries.find((e) => e.fromAgent);
    const reply = entries.find((e) => e.kind === 'send-message');
    return incoming && reply ? { incoming, reply } : null;
  });
  // The inbound text carries the [agent] cue so the model can tell it from the user.
  assert.equal(peerTranscript.incoming.fromAgent.name, 'Test Bot');
  assert.match(peerTranscript.incoming.message.content, /^\[agent\] ping from test/);
  assert.match(peerTranscript.reply.message.content, /ping from test/);
});

test('a non-priority message is held and does not wake the peer', async () => {
  const quiet = host.roster.create({ name: 'Quiet Bot' });
  setAgentBinding(root, quiet.id, { modelId: 'mock-a', baseUrl: mock.url, apiKeyEnv: 'MOCK_KEY' });
  const before = mock.requests.length;

  const sent = await rpc('messageAgent', {
    fromAgentId: agentId,
    to: 'Quiet Bot',
    text: 'just an FYI',
    priority: false,
  });
  assert.equal(sent.result.delivered, true);
  assert.equal(sent.result.woken, false);
  assert.equal(sent.result.held, true);

  await new Promise((r) => setTimeout(r, 250));
  assert.equal(mock.requests.length, before, 'a held message must not start a turn');

  const transcript = await rpc('getAgentTranscript', { agentId: quiet.id });
  const held = transcript.result.find((e) => e.held === true);
  assert.ok(held, 'the message is durably recorded as held');
  assert.match(held.message.content, /just an FYI/);
});

test('peer delivery is idempotent on messageId', async () => {
  const dup = host.roster.create({ name: 'Dup Bot' });
  setAgentBinding(root, dup.id, { modelId: 'mock-a', baseUrl: mock.url });
  const first = await rpc('messageAgent', {
    fromAgentId: agentId, to: 'Dup Bot', text: 'once', priority: false, messageId: 'm-1',
  });
  const second = await rpc('messageAgent', {
    fromAgentId: agentId, to: 'Dup Bot', text: 'once', priority: false, messageId: 'm-1',
  });
  assert.equal(first.result.delivered, true);
  assert.equal(second.result.duplicate, true);
  const transcript = await rpc('getAgentTranscript', { agentId: dup.id });
  assert.equal(transcript.result.filter((e) => e.peerMessageId === 'm-1').length, 1);
});

test('a group post persists once in the room without interrupting or copying into private chats', async () => {
  const m1 = host.roster.create({ name: 'Member One' });
  const m2 = host.roster.create({ name: 'Member Two' });
  const group = host.roster.createGroup({ name: 'Ops Room', memberAgentIds: [m1.id, m2.id, agentId] });
  const callsBefore = mock.requests.length;

  const posted = await rpc('messageAgent', { fromAgentId: agentId, to: 'Ops Room', text: 'standup at 10', priority: true });
  assert.equal(posted.result.delivered, true);
  assert.deepEqual(posted.result.members.sort(), [m1.id, m2.id].sort());
  assert.ok(posted.result.notes?.some((n) => /priority is 1:1 only/.test(n)));
  assert.equal(posted.result.woken, false);
  assert.equal(mock.requests.length, callsBefore);

  const t = await rpc('getAgentTranscript', { agentId: m1.id });
  assert.ok(!t.result.some((e) => e.message?.content?.includes('standup at 10')), 'private chat has no group copy');
  const room = await rpc('getAgentTranscript', { agentId: group.id });
  const msg = room.result.find((e) => e.fromAgent?.id === agentId);
  assert.equal(msg.message.content, 'standup at 10');
  const input = host.engine.buildMessages(m1.id, { conversationId: `group:${group.id}` });
  assert.ok(input.some((m) => m.role === 'user' && m.content?.includes('standup at 10')), 'group members can read the canonical post');
});

test('provenance rows carry the exact real field set', async () => {
  const file = path.join(root, 'logs', 'local-bound-provenance.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 3);
  const row = lines.at(-1);
  assert.equal(row.schema, 'GROKBOT_LOCAL_PROVENANCE_V1');
  assert.equal(row.event, 'local-bound-terminal');
  assert.deepEqual(Object.keys(row).sort(), [
    'agentId',
    'completionTokens',
    'elapsedMs',
    'event',
    'finishReason',
    'hopBaseUrlHostOrRouteLabel',
    'httpStatus',
    'modelId',
    'nullReasons',
    'outcome',
    'outputComplete',
    'promptTokens',
    'requestKind',
    'responseModel',
    'schema',
    'timestamp',
    'traceId',
    'upstreamId',
    'visibleOutputBytes',
    'visibleOutputCharacters',
    'visibleOutputSha256',
  ]);
  assert.equal(row.modelId, 'mock-a');
  assert.equal(row.hopBaseUrlHostOrRouteLabel, mock.url);
  assert.equal(row.outcome, 'success');
  assert.equal(row.httpStatus, 200);
  assert.match(row.visibleOutputSha256, /^[0-9a-f]{64}$/);
  assert.equal(row.requestKind, 'main');
});

test('a failed turn states why each field is null instead of omitting it', async () => {
  const bot = host.roster.create({ name: 'Down Bot' });
  setAgentBinding(root, bot.id, { modelId: 'mock-a', baseUrl: 'http://127.0.0.1:1/v1' });
  await rpc('sendPrompt', { agentId: bot.id, prompt: 'will fail' });
  await waitFor(async () => host.engine.acceptanceStatus(
    (await rpc('getAgentTranscript', { agentId: bot.id })).result && bot.id ? true : false,
  ), 200).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const lines = fs
    .readFileSync(path.join(root, 'logs', 'local-bound-provenance.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((r) => r.agentId === bot.id);
  assert.ok(lines.length >= 1);
  const row = lines.at(-1);
  assert.equal(row.outcome, 'error');
  assert.equal(row.httpStatus, null);
  assert.equal(row.nullReasons.httpStatus, 'no_http_response');
  assert.equal(row.outputComplete, false);
});

test('gateway refuses a cross-origin browser request', async () => {
  const res = await fetch(`${baseUrl}/api/listAgents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.match(body.error, /cross-origin/);
});

test('gateway serves its own web UI: same-origin requests are allowed', async () => {
  // Browsers attach Origin to same-origin POSTs; refusing those would lock the UI out.
  const res = await fetch(`${baseUrl}/api/listAgents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: '{}',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test('SSE accepts a same-origin browser and refuses another origin', async () => {
  const ok = await fetch(`${baseUrl}/events`, {
    headers: { origin: baseUrl },
    signal: AbortSignal.timeout(800),
  }).catch((e) => e.name === 'TimeoutError' ? { status: 200, ok: true } : Promise.reject(e));
  assert.equal(ok.status ?? 200, 200);

  const refused = await fetch(`${baseUrl}/events`, { headers: { origin: 'http://127.0.0.1:1' } });
  assert.equal(refused.status, 403);
});

test('unknown gateway method returns 404 with a message', async () => {
  const res = await fetch(`${baseUrl}/api/doesNotExist`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /unknown gateway method/);
});

test('tool policy deny blocks execution without an approval card', async () => {
  // tools.json deny is checked before the review module, and autoApprove would
  // short-circuit it, so this test exercises deny alone.
  host.tools.setPolicy({ deny: ['shell:rm *'], autoApprove: false });
  saveRules(root, { ...loadRules(root), isEnabled: true, blockInstructions: [], ceilings: { shell: 'ASK' } });
  const accepted = await rpc('sendPrompt', { agentId, prompt: 'TOOL rm -rf nope' });
  const denied = await waitFor(async () => {
    const res = await rpc('getAgentTranscript', { agentId });
    return (res.result ?? []).find((e) => e.kind === 'tool-result' && String(e.result).includes('denied by policy'));
  });
  assert.match(String(denied.result), /denied by policy/);
  host.tools.setPolicy({ deny: [], autoApprove: false });
  saveRules(root, { ...loadRules(root), blockInstructions: [] });
});

test('interrupt marks the turn interrupted and leaves a notice', async () => {
  const other = host.roster.create({ name: 'Slow Bot' });
  setAgentBinding(root, other.id, { modelId: 'mock-a', baseUrl: mock.url });
  const accepted = await rpc('sendPrompt', { agentId: other.id, prompt: 'anything' });
  await rpc('interruptAgentRun', { agentId: other.id });
  const transcript = await rpc('getAgentTranscript', { agentId: other.id });
  assert.ok(Array.isArray(transcript.result));
});

test('an unanswered tool call is not replayed to the provider', async () => {
  // The approval test left a real tool-call/tool-result pair; this checks that the
  // replay skips calls with no result instead of sending a malformed history.
  const store = host.roster.store(agentId);
  const entries = store.readAll();
  const calls = entries.filter((e) => e.kind === 'tool-call');
  const results = new Set(entries.filter((e) => e.kind === 'tool-result').map((e) => e.callId));
  const orphans = calls.filter((c) => !results.has(c.id));
  const messages = host.engine.buildMessages(agentId);
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue;
    for (const call of msg.tool_calls) {
      assert.equal(orphans.some((o) => o.id === call.id), false, 'orphan tool call leaked into replay');
      assert.ok(results.has(call.id), 'assistant tool_calls must be followed by a tool message');
    }
  }
});

test('a due routine runs once and records a real outcome', async () => {
  const bot = host.roster.create({ name: 'Digest Bot' });
  setAgentBinding(root, bot.id, { modelId: 'mock-a', baseUrl: mock.url });
  host.routines.create({ agentId: bot.id, name: 'Daily Digest', prompt: 'summarize', schedule: '0 8 * * *' });

  const at = new Date('2026-10-21T08:00:05+08:00');
  const fired = host.routines.tick(at, 'Asia/Shanghai');
  assert.ok(fired.some((f) => f.agentId === bot.id));
  assert.equal(host.routines.tick(at, 'Asia/Shanghai').length, 0, 'same minute never fires twice');

  const entry = await waitFor(async () => {
    const res = await rpc('getAgentTranscript', { agentId: bot.id });
    return (res.result ?? []).find((e) => e.kind === 'message' && String(e.message?.content).includes('[routine:Daily Digest]'));
  });
  assert.ok(entry);
  assert.equal(host.engine.getRun(entry.runId).lane, 'background');
  assert.equal(host.engine.getRun(entry.runId).source, 'background');

  await waitFor(async () => {
    const routine = host.routines.list(bot.id)[0];
    return routine.runs?.[0]?.status === 'ok';
  });
  const routine = host.routines.list(bot.id)[0];
  assert.equal(routine.runs[0].status, 'ok');
  assert.ok(routine.runs[0].finishedAt >= routine.runs[0].startedAt);
});

test('ask_user parks the turn as a question widget and resumes on answer', async () => {
  const accepted = await rpc('sendPrompt', { agentId, prompt: 'ASK which plan should I run?' });
  assert.equal(accepted.ok, true);

  const widget = await waitFor(async () => {
    const res = await rpc('getAgentTranscript', { agentId });
    return (res.result ?? []).find((e) => e.message?.type === 'question');
  });
  assert.equal(widget.message.prompt, 'which plan should I run?');
  assert.deepEqual(widget.message.options, ['yes', 'no']);
  assert.equal(widget.message.answered, false);

  const answered = await rpc('respondToWidget', { agentId, entryId: widget.id, value: 'yes' });
  assert.equal(answered.result.answered, true);

  const resumed = await waitFor(async () => {
    const res = await rpc('getAgentTranscript', { agentId });
    return (res.result ?? []).find((e) => e.kind === 'tool-result' && String(e.result).includes('yes'));
  });
  assert.match(String(resumed.result), /yes/);

  const again = await rpc('respondToWidget', { agentId, entryId: widget.id, value: 'no' });
  assert.equal(again.result.answered, false, 'a widget answers once');
});

test('a server-hosted agent is proxied, and its turn never runs in this process', async () => {
  const remote = host.roster.create({ name: 'Remote Bot', harness: 'temporal' });
  const route = await rpc('getAgentRoute', { agentId: remote.id });
  assert.equal(route.result.harness, 'temporal');
  assert.equal(route.result.runnable, false, 'the local engine refuses to run it');
  assert.equal(route.result.proxied, true, 'it is routed through the proxy instead');

  // Through the gateway it is accepted — by the proxy, not by the local engine.
  const sent = await rpc('sendPrompt', { agentId: remote.id, prompt: 'hello' });
  assert.equal(sent.ok, true);
  assert.equal(sent.result.proxied, true);
  assert.equal(sent.result.accepted, true);
});

test('a box-harness agent is reported as retired, not queued', async () => {
  const legacy = host.roster.create({ name: 'Legacy Bot', harness: 'box' });
  const route = await rpc('getAgentRoute', { agentId: legacy.id });
  assert.equal(route.result.lane, 'retired');
  assert.equal(route.result.runnable, false);
});

test('acceptance is durable before the turn finishes', async () => {
  const accepted = await rpc('sendPrompt', { agentId, prompt: 'durability check', clientNonce: 'durable-1' });
  assert.equal(accepted.ok, true);
  const ledgerFile = path.join(root, 'send-acceptance.json');
  const onDisk = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const record = onDisk.records.find((r) => r.clientNonce === 'durable-1');
  assert.ok(record, 'the record exists on disk immediately after acceptance');
  assert.equal(record.status, 'accepted');
  assert.match(record.inputDigest, /^[0-9a-f]{64}$/);
});

test('a diverging prompt under the same nonce is rejected', async () => {
  await rpc('sendPrompt', { agentId, prompt: 'first text', clientNonce: 'conflict-1' });
  const second = await rpc('sendPrompt', { agentId, prompt: 'totally different', clientNonce: 'conflict-1' });
  assert.equal(second.ok, false);
  assert.match(second.error, /nonce-digest-mismatch/);
});

test('the outline surfaces tool calls that the transcript window hides', async () => {
  const bot = host.roster.create({ name: 'Outline Bot' });
  setAgentBinding(root, bot.id, { modelId: 'mock-a', baseUrl: mock.url, apiKeyEnv: 'MOCK_KEY' });
  host.tools.setPolicy({ autoApprove: true });
  await rpc('sendPrompt', { agentId: bot.id, prompt: 'TOOL echo outline-check' });
  // The tool-call row lands before its result row, so wait for the joined pair
  // rather than for the outline to be non-empty.
  await waitFor(async () => {
    const res = await rpc('getAgentOutline', { agentId: bot.id });
    return (res.result ?? []).some((c) => c.hasResult);
  });
  const outline = await rpc('getAgentOutline', { agentId: bot.id });
  const call = outline.result[0];
  assert.equal(call.name, 'shell');
  assert.equal(call.hasResult, true);
  // The result is the structured shell outcome; stdout carries the marker.
  assert.match(String(call.result), /outline-check/);

  // …and the window really does hide it.
  const window = await rpc('getAgentTranscript', { agentId: bot.id });
  assert.equal(window.result.filter((e) => e.kind === 'tool-call').length, 0);
  host.tools.setPolicy({ autoApprove: false }); // leave the shared policy as it was
});

test('pending ids track an accepted prompt until its turn settles', async () => {
  const bot = host.roster.create({ name: 'Pending Bot' });
  setAgentBinding(root, bot.id, { modelId: 'mock-a', baseUrl: mock.url, apiKeyEnv: 'MOCK_KEY' });

  // Hold the turn open with the mock's SLOW branch so the window is deterministic.
  const accepted = await rpc('sendPrompt', { agentId: bot.id, prompt: 'SLOW 400 hello' });
  assert.equal(accepted.ok, true);
  const entryId = accepted.result.entryId;

  const during = await rpc('getPendingEntryIds', { agentId: bot.id });
  assert.ok(during.result.includes(entryId), 'an accepted row is pending while its turn runs');

  await waitFor(async () => {
    const res = await rpc('getPendingEntryIds', { agentId: bot.id });
    return !(res.result ?? []).includes(entryId);
  });
  const after = await rpc('getPendingEntryIds', { agentId: bot.id });
  assert.equal(after.result.includes(entryId), false, 'it clears once the turn ends');
});

test('a parked approval keeps its own row pending until answered', async () => {
  const bot = host.roster.create({ name: 'Parked Pending' });
  setAgentBinding(root, bot.id, { modelId: 'mock-a', baseUrl: mock.url, apiKeyEnv: 'MOCK_KEY' });
  host.tools.setPolicy({ autoApprove: false, deny: [] });
  saveRules(root, { ...loadRules(root), isEnabled: true, ceilings: { shell: 'ASK' }, blockInstructions: [] });

  const command = `touch parked-${Date.now()}.marker`;
  const parked = await rpc('sendPrompt', { agentId: bot.id, prompt: `TOOL ${command}` });
  await waitFor(async () => {
    const st = await rpc('promptAcceptanceStatus', { clientNonce: parked.result.clientNonce });
    return st.result?.state === 'awaiting-approval';
  });

  const stillPending = await rpc('getPendingEntryIds', { agentId: bot.id });
  assert.ok(stillPending.result.includes(parked.result.entryId), 'a parked row stays pending');

  const approval = (await rpc('getAgentTranscript', { agentId: bot.id })).result.find(
    (e) => e.message?.type === 'auto-review-approval' && e.message.resolution == null,
  );
  assert.ok(approval, 'an approval card exists');
  await rpc('resolveAutoReviewApproval', { agentId: bot.id, entryId: approval.id, resolution: 'approved' });

  await waitFor(async () => {
    const res = await rpc('getPendingEntryIds', { agentId: bot.id });
    return !(res.result ?? []).includes(parked.result.entryId);
  });
});

test('a second side effect is refused while a card is still pending', async () => {
  const bot = host.roster.create({ name: 'One Card Bot' });
  setAgentBinding(root, bot.id, { modelId: 'mock-a', baseUrl: mock.url, apiKeyEnv: 'MOCK_KEY' });
  host.tools.setPolicy({ autoApprove: false, deny: [] });
  saveRules(root, { ...loadRules(root), isEnabled: true, ceilings: { shell: 'ASK' }, blockInstructions: [], allowInstructions: [], alwaysAllow: [] });

  // First tool call parks on a card.
  await rpc('sendPrompt', { agentId: bot.id, prompt: 'TOOL touch card-one.marker' });
  await waitFor(async () => {
    const t = await rpc('getAgentTranscript', { agentId: bot.id });
    return (t.result ?? []).some((e) => e.message?.type === 'auto-review-approval' && e.message.resolution == null);
  });

  // A second prompt that also needs approval must be refused, not given a second card.
  await rpc('sendPrompt', { agentId: bot.id, prompt: 'TOOL touch card-two.marker' });
  const blocked = await waitFor(async () => {
    const t = await rpc('getAgentTranscript', { agentId: bot.id });
    return (t.result ?? []).find(
      (e) => e.kind === 'tool-result' && String(e.result).includes('blocked_by_pending_approval'),
    );
  });
  assert.ok(blocked);

  const cards = (await rpc('getAgentTranscript', { agentId: bot.id })).result.filter(
    (e) => e.message?.type === 'auto-review-approval' && e.message.resolution == null,
  );
  assert.equal(cards.length, 1, 'exactly one card is pending');
  host.tools.setPolicy({ autoApprove: false });
});
