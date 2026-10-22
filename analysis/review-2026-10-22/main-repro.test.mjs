// Evidence probes against the unmodified d498dd8 runtime.
// Passing assertions mean the behavior was observed, not that it is correct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHost } from '../../src/host.mjs';
import { setAgentBinding } from '../../src/providers/bindings.mjs';
import { AcceptanceLedger } from '../../src/acceptance.mjs';
import { startMockProvider } from '../../test/mock-provider.mjs';

const outDir = path.dirname(fileURLToPath(import.meta.url));
const observations = [];
function evidence(id, observed) {
  observations.push({ id, observed });
  fs.writeFileSync(path.join(outDir, 'main-observations.json'), JSON.stringify(observations, null, 2) + '\n');
  console.log(`${id}: ${JSON.stringify(observed)}`);
}
const textOf = (rows) => JSON.stringify(rows);
const tick = () => new Promise((r) => setImmediate(r));
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function removeFixture(root) {
  const absolute = fs.realpathSync(root);
  assert.equal(path.dirname(absolute), outDir, 'cleanup must stay under the evidence directory');
  assert.ok(path.basename(absolute).startsWith('fixture-'), 'cleanup only targets generated fixtures');
  fs.rmSync(absolute, { recursive: true });
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(outDir, 'fixture-'));
  const mock = await startMockProvider();
  const host = createHost({ root, seed: false });
  function bot(name) {
    const b = host.roster.create({ name });
    setAgentBinding(root, b.id, { modelId: 'mock-a', baseUrl: mock.url, apiKeyEnv: 'REVIEW_NO_KEY' });
    return b;
  }
  t.after(async () => {
    for (const id of host.roster.list().map((a) => a.id)) await host.engine.scheduler.drain(id);
    for (const timer of host.engine.watchdogs.values()) clearTimeout(timer);
    host.engine.scheduler.dispose();
    await host.close();
    await mock.close();
    removeFixture(root);
  });
  return { root, mock, host, bot };
}

test('E01 normal createGroup path returns success without delivering or writing room post', async (t) => {
  const { host, bot } = await fixture(t);
  const a = bot('Sender'), b = bot('Receiver');
  const room = host.roster.createGroup({ name: 'NormalRoom', memberAgentIds: [a.id, b.id] });
  const before = host.roster.store(room.id).maxSeq();
  const receipt = await host.engine.sendToAgent({ fromAgentId: a.id, to: room.id, text: 'BOT_POST_SENTINEL', priority: true });
  const got = host.roster.store(b.id).readAll().some((e) => e.message?.content?.includes('BOT_POST_SENTINEL'));
  assert.equal(receipt.delivered, true);
  assert.deepEqual(receipt.members, []);
  assert.equal(got, false);
  assert.equal(host.roster.store(room.id).maxSeq(), before);
  evidence('E01', { receiptSuccess: receipt.delivered, recipientCount: receipt.members.length, receiverSawPost: got, roomPostWritten: false });
});

test('E02 group input includes private history; addressed prompts are persisted but excluded next group run', async (t) => {
  const { host, mock, bot } = await fixture(t);
  const a = bot('ContextBot');
  const room = host.roster.createGroup({ name: 'ContextRoom', memberAgentIds: [a.id] });
  host.engine.admit({ agentId: a.id, prompt: 'ECHO PRIVATE_HISTORY_SENTINEL' });
  await host.engine.scheduler.drain(a.id);
  await host.engine.postFromOperator({ groupId: room.id, text: 'GROUP_FIRST_SENTINEL' });
  await host.engine.scheduler.drain(a.id);
  const firstGroupInput = textOf(mock.requests.at(-1).body.messages);
  const rows = host.roster.store(a.id).readAll();
  const persisted = rows.filter((e) => e.kind === 'message' && e.message?.content?.includes('GROUP_FIRST_SENTINEL'));
  await host.engine.postFromOperator({ groupId: room.id, text: 'GROUP_SECOND_SENTINEL' });
  await host.engine.scheduler.drain(a.id);
  const secondInput = textOf(mock.requests.at(-1).body.messages);
  assert.ok(firstGroupInput.includes('PRIVATE_HISTORY_SENTINEL'));
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].hidden, true);
  assert.equal(secondInput.includes('GROUP_FIRST_SENTINEL'), false);
  evidence('E02', { privateHistoryInGroupInput: true, addressedPromptStored: true, addressedPromptHidden: true, priorGroupInNextInput: false });
});

test('E03 two queued rooms overwrite agent groupOrigin and misroute the first answer', async (t) => {
  const { host, bot } = await fixture(t);
  const a = bot('SharedBot');
  const r1 = host.roster.createGroup({ name: 'RoomOne', memberAgentIds: [a.id] });
  const r2 = host.roster.createGroup({ name: 'RoomTwo', memberAgentIds: [a.id] });
  const gate = deferred();
  const holding = host.engine.scheduler.enqueue(a.id, () => gate.promise);
  await tick();
  await host.engine.postFromOperator({ groupId: r1.id, text: 'TASK_ONE_SENTINEL' });
  await host.engine.postFromOperator({ groupId: r2.id, text: 'TASK_TWO_SENTINEL' });
  gate.resolve();
  await holding;
  await host.engine.scheduler.drain(a.id);
  const answers = (r) => host.roster.store(r.id).readAll().filter((e) => e.kind === 'send-message' && e.fromAgent?.id === a.id);
  const first = answers(r1), second = answers(r2);
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
  assert.ok(second[0].message.content.includes('TASK_ONE_SENTINEL'));
  evidence('E03', { roomOneAnswers: first.length, roomTwoAnswers: second.length, taskOneAnswerInRoomTwo: true, taskTwoAnswerDelivered: false });
});

test('E04 group nonce retries write and execute twice and group fanout uses user source', async (t) => {
  const { host, mock, bot } = await fixture(t);
  const a = bot('RetryBot');
  const room = host.roster.createGroup({ name: 'RetryRoom', memberAgentIds: [a.id] });
  const queueEvents = [];
  host.bus.subscribe((e) => { if (e.type === 'queue-accepted' && e.agentId === a.id) queueEvents.push(e); });
  const one = await host.engine.postFromOperator({ groupId: room.id, text: 'RETRY_SENTINEL', clientNonce: 'same-room-nonce' });
  const two = await host.engine.postFromOperator({ groupId: room.id, text: 'RETRY_SENTINEL', clientNonce: 'same-room-nonce' });
  await host.engine.scheduler.drain(a.id);
  const posts = host.roster.store(room.id).readAll().filter((e) => e.role === 'user' && e.clientNonce === 'same-room-nonce');
  assert.notEqual(one.entryId, two.entryId);
  assert.equal(posts.length, 2);
  assert.equal(mock.requests.length, 2);
  assert.ok(queueEvents.every((e) => e.source === 'user'));
  evidence('E04', { sameNonceRoomPosts: posts.length, modelCalls: mock.requests.length, queueSources: queueEvents.map((e) => e.source) });
});

test('E05 private admission during a normal hidden group run is hidden even without approval', async (t) => {
  const { host, bot } = await fixture(t);
  const a = bot('IntakeBot');
  const room = host.roster.createGroup({ name: 'IntakeRoom', memberAgentIds: [a.id] });
  let privateAdmission;
  const off = host.bus.subscribe((e) => {
    if (e.type === 'turn-start' && e.agentId === a.id && e.hidden && !privateAdmission) {
      privateAdmission = host.engine.admit({ agentId: a.id, prompt: 'PRIVATE_DURING_GROUP', clientNonce: 'private-during-group' });
    }
  });
  await host.engine.postFromOperator({ groupId: room.id, text: 'GROUP_BUSY' });
  await host.engine.scheduler.drain(a.id);
  off();
  const row = host.roster.store(a.id).getEntry(privateAdmission.entryId);
  assert.equal(row.hidden, true);
  evidence('E05', { approvalNeededToTrigger: false, privateIntakeHiddenDuringGroup: row.hidden });
});

test('E06 hidden approval leaks hideWrites and denial throws after partial mutation', async (t) => {
  const { host, bot } = await fixture(t);
  const a = bot('ApprovalBot');
  const ac = host.engine.admit({ agentId: a.id, prompt: 'TOOL echo review-pending-only', hidden: true });
  await host.engine.scheduler.drain(a.id);
  const parked = host.engine.acceptanceStatus(ac.clientNonce);
  assert.equal(parked.state, 'awaiting-approval');
  assert.equal(host.roster.store(a.id).hideWrites, true);
  host.engine.admit({ agentId: a.id, prompt: 'PRIVATE_DURING_PARK', clientNonce: 'private-during-park' });
  await host.engine.scheduler.drain(a.id);
  const row = host.roster.store(a.id).readAll().find((e) => e.clientNonce === 'private-during-park');
  assert.equal(row.hidden, true);
  let denialError = '';
  try { await host.engine.resolveApproval({ agentId: a.id, entryId: parked.approvalEntryId, resolution: 'denied' }); }
  catch (e) { denialError = e.message; }
  assert.match(denialError, /turnId is not defined/);
  evidence('E06', { parkedState: parked.state, privateWhileParkedHidden: row.hidden, denialError, storeHiddenAfterDenial: host.roster.store(a.id).hideWrites });
});

test('E07 completed run state is lost when the host is reconstructed', async (t) => {
  const { host, root, bot } = await fixture(t);
  const a = bot('RestartBot');
  const ac = host.engine.admit({ agentId: a.id, prompt: 'ECHO RESTART_SENTINEL', clientNonce: 'restart-sentinel' });
  await host.engine.scheduler.drain(a.id);
  assert.equal(host.engine.acceptanceStatus(ac.clientNonce).state, 'done');
  const reloaded = createHost({ root, seed: false });
  try {
    const after = reloaded.engine.acceptanceStatus(ac.clientNonce);
    assert.equal(after.state, 'accepted');
    evidence('E07', { beforeReconstruction: 'done', afterReconstruction: after.state, admissionDurable: after.durable });
  } finally { reloaded.engine.scheduler.dispose(); await reloaded.close(); }
});

test('E08 peer duplicate suppression is lost on reconstruction', async (t) => {
  const { host, root, bot } = await fixture(t);
  const a = bot('PeerA'), b = bot('PeerB');
  await host.engine.sendToAgent({ fromAgentId: a.id, to: b.id, text: 'PEER_SENTINEL', priority: false, messageId: 'stable-peer-id' });
  const reloaded = createHost({ root, seed: false });
  try {
    const receipt = await reloaded.engine.sendToAgent({ fromAgentId: a.id, to: b.id, text: 'PEER_SENTINEL', priority: false, messageId: 'stable-peer-id' });
    const count = reloaded.roster.store(b.id).readAll().filter((e) => e.peerMessageId === 'stable-peer-id').length;
    assert.equal(count, 2);
    assert.notEqual(receipt.duplicate, true);
    evidence('E08', { sameMessageIdRowsAfterReconstruction: count, duplicateDetected: receipt.duplicate === true });
  } finally { reloaded.engine.scheduler.dispose(); await reloaded.close(); }
});

test('E09 same nonce and same text to a different bot is treated as replay to the first bot', async () => {
  const root = fs.mkdtempSync(path.join(outDir, 'fixture-ledger-'));
  const ledger = new AcceptanceLedger(root);
  ledger.record({ clientNonce: 'cross-bot-nonce', prompt: 'same-text', agentId: 'bot-a' });
  const second = ledger.record({ clientNonce: 'cross-bot-nonce', prompt: 'same-text', agentId: 'bot-b' });
  assert.equal(second.replayed, true);
  assert.equal(second.conflict, false);
  assert.equal(second.record.agentId, 'bot-a');
  evidence('E09', { secondTarget: 'bot-b', replayedTarget: second.record.agentId, conflict: second.conflict });
  removeFixture(root);
});
