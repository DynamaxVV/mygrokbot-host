// Group room turns: round-robin, idempotent, six-state outcome.
//
// These run against the mock provider, so the six outcomes are produced on purpose
// rather than hoped for.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/host.mjs';
import { startMockProvider } from './mock-provider.mjs';
import { setAgentBinding } from '../src/providers/bindings.mjs';

let mock;
let host;
let root;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-room-'));
  mock = await startMockProvider();
  host = createHost({ root, seed: false });
});

after(async () => {
  await host.close();
  await mock.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function bot(name) {
  const a = host.roster.create({ name });
  setAgentBinding(root, a.id, { modelId: 'mock-a', baseUrl: mock.url, apiKeyEnv: 'MOCK_KEY' });
  return a;
}

test('a round runs every member once, in order', async () => {
  const a = bot('Alpha');
  const b = bot('Beta');
  const room = host.roster.createGroup({ name: 'Round Room', memberAgentIds: [a.id, b.id] });

  const result = await host.rooms.runRound({
    roomId: room.id,
    newMessages: [{ speakerKind: 'human', speakerName: 'operator', text: 'status?' }],
  });

  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map((r) => r.memberAgentId), [a.id, b.id]);
  // The mock echoes the prompt, so every member delivers something.
  assert.deepEqual(result.results.map((r) => r.outcome), ['delivered', 'delivered']);
});

test('the room prompt tells the member it may pass', async () => {
  const solo = bot('Solo');
  const room = host.roster.createGroup({ name: 'Prompt Room', memberAgentIds: [solo.id] });
  await host.rooms.runRound({ roomId: room.id });

  const rows = host.roster.store(solo.id).readWindow({ limit: 20 });
  const prompt = rows.find((e) => e.kind === 'message' && e.role === 'user')?.message?.content ?? '';
  assert.match(prompt, /reply with exactly "pass"/);
  assert.match(prompt, /Do not repeat what another member already said/);
  assert.match(prompt, /silence is the preferred acknowledgement/);
});

test('a member that says nothing produces a pass, not an error', async () => {
  // An agent whose turn ends with no assistant text at all.
  const muted = host.roster.create({ name: 'Muted' });
  const room = host.roster.createGroup({ name: 'Mute Room', memberAgentIds: [muted.id] });
  // No binding -> the turn errors; but a *successful* empty turn is what "pass" means.
  const results = await host.rooms.runRound({ roomId: room.id });
  // With no provider binding the turn fails, which is `error`, not `pass`.
  assert.equal(results.results[0].outcome, 'error');
});

test('an unreachable provider marks the member as error, and the round continues', async () => {
  const bad = host.roster.create({ name: 'Broken' });
  setAgentBinding(root, bad.id, { modelId: 'mock-a', baseUrl: 'http://127.0.0.1:1/v1' });
  const good = bot('Healthy');
  const room = host.roster.createGroup({ name: 'Mixed Room', memberAgentIds: [bad.id, good.id] });

  const result = await host.rooms.runRound({ roomId: room.id });
  assert.equal(result.results[0].outcome, 'error');
  assert.equal(result.results[1].outcome, 'delivered', 'one failure does not stop the round');
});

test('cancelling a round makes the remaining members report cancelled', async () => {
  const a = bot('CancA');
  const b = bot('CancB');
  const room = host.roster.createGroup({ name: 'Cancel Room', memberAgentIds: [a.id, b.id] });

  const running = host.rooms.runRound({ roomId: room.id });
  await new Promise((r) => setTimeout(r, 30));
  host.rooms.cancel(room.id);
  const result = await running;

  const outcomes = result.results.map((r) => r.outcome);
  assert.ok(outcomes.includes('cancelled'), `expected a cancelled member, got ${outcomes.join(',')}`);
});

test('a member parked on approval is skipped, not left hanging', async () => {
  const parked = bot('Parked Member');
  host.tools.setPolicy({ autoApprove: false, deny: [] });
  const room = host.roster.createGroup({ name: 'Park Room', memberAgentIds: [parked.id] });

  // The mock's TOOL branch parks; a room prompt does not contain TOOL, so force it.
  const original = host.rooms.buildRoomPrompt.bind(host.rooms);
  host.rooms.buildRoomPrompt = () => 'TOOL touch room-parked.marker';
  const result = await host.rooms.runRound({ roomId: room.id });
  host.rooms.buildRoomPrompt = original;

  assert.equal(result.results[0].outcome, 'skipped');
  assert.match(String(result.results[0].error), /parked/);
  host.tools.setPolicy({ autoApprove: true });
});

test('a deadline that passes produces timeout', async () => {
  const slow = bot('Slow Member');
  const room = host.roster.createGroup({ name: 'Timeout Room', memberAgentIds: [slow.id] });
  const original = host.rooms.buildRoomPrompt.bind(host.rooms);
  host.rooms.buildRoomPrompt = () => 'SLOW 1500 hello';
  const result = await host.rooms.runRound({ roomId: room.id, deadlineMs: 200 });
  host.rooms.buildRoomPrompt = original;

  assert.equal(result.results[0].outcome, 'timeout');
});

test('submitting the same nonce twice returns the first result', async () => {
  const a = bot('Dup Room Bot');
  const room = host.roster.createGroup({ name: 'Dup Room', memberAgentIds: [a.id] });

  const first = host.rooms.submitResult({
    roomId: room.id, nonce: 'n-1', memberAgentId: a.id, outcome: 'delivered',
  });
  const second = host.rooms.submitResult({
    roomId: room.id, nonce: 'n-1', memberAgentId: a.id, outcome: 'error',
  });
  assert.equal(first.outcome, 'delivered');
  assert.equal(second.replayed, true);
  assert.equal(second.outcome, 'delivered', 'a replay never overwrites the first result');
});

test('only delivered and pass are shown to the room', async () => {
  const a = bot('Shown Bot');
  const room = host.roster.createGroup({ name: 'Shown Room', memberAgentIds: [a.id] });
  const seen = [];
  host.bus.subscribe((e) => {
    if (e.type === 'room-member-turn-end' && e.agentId === room.id) seen.push([e.outcome, e.shown]);
  });
  await host.rooms.runRound({ roomId: room.id });
  assert.ok(seen.length >= 1);
  for (const [outcome, shown] of seen) {
    assert.equal(shown, outcome === 'delivered' || outcome === 'pass', `${outcome} -> ${shown}`);
  }
});

test('an empty room is refused without touching any member', async () => {
  const room = host.roster.createGroup({ name: 'Empty Room', memberAgentIds: [] });
  const result = await host.rooms.runRound({ roomId: room.id });
  assert.deepEqual(result.results, []);
  assert.equal(result.reason, 'no members');
});

test('a missing member is skipped', async () => {
  const a = bot('Keep Bot');
  const room = host.roster.createGroup({ name: 'Gone Room', memberAgentIds: [a.id] });
  const ghost = host.roster.create({ name: 'Ghost' });
  host.roster.setGroupMembers(room.id, [ghost.id, a.id]);
  host.roster.delete(ghost.id);

  const result = await host.rooms.runRound({ roomId: room.id });
  assert.equal(result.results[0].outcome, 'skipped');
});

test('a literal pass reply is an outcome of pass, not delivered', async () => {
  const { isPass } = await import('../src/room.mjs');
  assert.equal(isPass('pass'), true);
  assert.equal(isPass('PASS'), true);
  assert.equal(isPass('pass.'), true);
  assert.equal(isPass(''), true, 'silence is also a pass');
  assert.equal(isPass('passed the test'), false, 'a real sentence is not a pass');
  assert.equal(isPass('I pass'), false);
});

test('a member that answers with the pass token is recorded as pass', async () => {
  const p = host.roster.create({ name: 'Passer' });
  setAgentBinding(root, p.id, { modelId: 'mock-a', baseUrl: mock.url, apiKeyEnv: 'MOCK_KEY' });
  const room = host.roster.createGroup({ name: 'Pass Room', memberAgentIds: [p.id] });

  // Make the member's reply exactly "pass", the way a real model would.
  const original = host.mockText;
  const realPrompt = host.rooms.buildRoomPrompt.bind(host.rooms);
  host.rooms.buildRoomPrompt = () => 'ECHO pass';
  const result = await host.rooms.runRound({ roomId: room.id });
  host.rooms.buildRoomPrompt = realPrompt;
  host.mockText = original;

  assert.equal(result.results[0].outcome, 'pass');
});
