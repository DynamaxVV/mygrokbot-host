import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJSON, inputDigest } from '../src/execution.mjs';
import { inputDigest as legacyDigest } from '../src/acceptance.mjs';
import { fixture, until, delay, TEST_TIMEOUT } from './task-fixture.mjs';

const options = { timeout: TEST_TIMEOUT };

test('canonical JSON recursively sorts every object and hashes the complete request', options, () => {
  const input = { z: [{ b: 2, a: 1 }], '2': 'two', '10': 'ten', a: { y: null, x: true }, omitted: undefined };
  const canonical = '{"10":"ten","2":"two","a":{"x":true,"y":null},"z":[{"a":1,"b":2}]}';
  assert.equal(canonicalJSON(input), canonical);
  assert.equal(inputDigest(input), createHash('sha256').update(canonical).digest('hex'));
  assert.equal(inputDigest({ b: 2, a: 1 }), inputDigest({ a: 1, b: 2 }));
  assert.notEqual(inputDigest([1, 2]), inputDigest([2, 1]));
  assert.throws(() => canonicalJSON(undefined), TypeError);
});

test('prompt nonce fingerprints target, attachments, reply, conversation and execution inputs', options, async (t) => {
  const f = await fixture(t);
  const a = f.bot('A'); const b = f.bot('B');
  f.host.engine.schedule = () => {};
  const args = { agentId: a.id, prompt: 'full input', clientNonce: 'canonical', attachmentPaths: ['first.png'], replyTo: { id: 'message', meta: { z: 1, a: 2 } } };
  const first = f.host.engine.admit(args);
  const replay = f.host.engine.admit({ ...args, agentId: 'A', replyTo: { meta: { a: 2, z: 1 }, id: 'message' } });
  assert.equal(replay.runId, first.runId);
  assert.equal(replay.replayed, true);
  for (const patch of [
    { agentId: b.id }, { attachmentPaths: ['other.png'] }, { attachmentPaths: ['first.png', 'second.png'] },
    { replyTo: { id: 'other' } }, { prompt: 'changed' }, { trigger: 'peer' }, { lane: 'agent' },
    { source: 'agent' }, { viaProxy: true }, { hidden: true }, { conversationId: `task:isolated` },
    { taskId: 'another-task' }, { sourceMessageId: 'another-source' }, { contextPrompt: true },
  ]) assert.throws(() => f.host.engine.admit({ ...args, ...patch }), { code: 'send/nonce-digest-mismatch' }, JSON.stringify(patch));
  const original = f.host.engine.execution.getAdmission('prompt', 'canonical');
  const expected = { agentId: a.id, conversationId: `dm:${a.id}`, prompt: args.prompt, attachmentPaths: args.attachmentPaths, replyTo: args.replyTo,
    trigger: 'user', lane: 'user', source: 'user', viaProxy: false, hidden: false, taskId: null, sourceMessageId: null, contextPrompt: false };
  assert.equal(original.inputDigest, inputDigest(expected));
  assert.equal(f.host.engine.execution.listRuns().length, 1);
  assert.equal(f.host.roster.store(a.id).readAll().filter((e) => e.clientNonce === 'canonical').length, 1);
});

test('nested transaction errors poison the outer transaction even when caught; callbacks roll back', options, async (t) => {
  const f = await fixture(t); const store = f.host.engine.execution;
  const callbacks = [];
  assert.throws(() => store.transaction(() => {
    store.saveTask({ id: 'outer' });
    store.afterCommit(() => callbacks.push('outer'));
    try { store.transaction(() => { store.saveTask({ id: 'inner' }); store.afterCommit(() => callbacks.push('inner')); throw new Error('nested failure'); }); } catch {}
    store.saveTask({ id: 'after-catch' });
  }), /nested failure/);
  assert.deepEqual(store.listTasks(), []);
  assert.deepEqual(callbacks, []);
  store.transaction(() => store.saveTask({ id: 'fresh' }));
  assert.equal(store.getTask('fresh').id, 'fresh');
});

test('afterCommit runs at depth zero, allows new transactions, reports committed errors and runs siblings', options, async (t) => {
  const f = await fixture(t); const store = f.host.engine.execution; const calls = [];
  assert.throws(() => store.transaction(() => {
    store.saveTask({ id: 'committed' });
    store.afterCommit(() => { assert.equal(store._depth, 0); store.transaction(() => store.saveTask({ id: 'callback-write' })); calls.push(1); throw new Error('postcommit'); });
    store.transaction(() => store.afterCommit(() => calls.push(2)));
    assert.deepEqual(calls, []);
  }), (error) => error.code === 'execution/postcommit-failed' && error.committed === true && error.phase === 'postcommit' && error.errors[0].message === 'postcommit');
  assert.deepEqual(calls, [1, 2]);
  assert.ok(store.getTask('committed'));
  assert.ok(store.getTask('callback-write'));
  store.afterCommit(() => calls.push(3));
  assert.deepEqual(calls, [1, 2, 3]);
});

test('async transaction functions and thenables are rejected without committing writes', options, async (t) => {
  const f = await fixture(t); const store = f.host.engine.execution;
  assert.throws(() => store.transaction(async () => store.saveTask({ id: 'async' })), /Async transactions/);
  assert.throws(() => store.transaction(() => { store.saveTask({ id: 'thenable' }); return { then() {} }; }), /Async transactions/);
  assert.deepEqual(store.listTasks(), []);
});

test('outbox IDs are immutable, ordered and ack tombstones survive a fresh Host', options, async (t) => {
  const f = await fixture(t); const bot = f.bot(); let store = f.host.engine.execution;
  const delivery = { id: 'outbox-one', agentId: bot.id, entry: { id: 'inbox-one', kind: 'message', message: { type: 'text', content: 'one' }, conversationId: `dm:${bot.id}` }, event: null };
  assert.equal(store.queueDelivery(delivery).replayed, false);
  assert.equal(store.queueDelivery({ ...delivery, entry: { ...delivery.entry, message: { content: 'one', type: 'text' } } }).replayed, true);
  assert.equal(store.queueDelivery({ ...delivery, event: { type: 'different' } }).code, 'delivery/id-input-mismatch');
  store.queueDelivery({ ...delivery, id: 'outbox-two', entry: { ...delivery.entry, id: 'inbox-two' } });
  assert.deepEqual(store.pendingDeliveries().map((d) => d.id), ['outbox-one', 'outbox-two']);
  f.host.engine.flushDeliveries();
  assert.deepEqual(store.pendingDeliveries(), []);
  await f.restart(); store = f.host.engine.execution;
  assert.equal(store.queueDelivery(delivery).replayed, true);
  f.host.engine.flushDeliveries();
  assert.deepEqual(store.pendingDeliveries(), []);
  assert.equal(f.host.roster.store(bot.id).readAll().filter((entry) => entry.id === 'inbox-one').length, 1);
  assert.equal(store.db.prepare('SELECT acked FROM outbox WHERE id = ?').get('outbox-one').acked, 1);
});

test('fresh Host preserves done state and nonce replay never sends another HTTP request', options, async (t) => {
  const f = await fixture(t, () => ({ text: 'persisted final body' })); const bot = f.bot();
  const args = { agentId: bot.id, prompt: 'done survives', clientNonce: 'done' };
  const accepted = f.host.engine.admit(args);
  const done = await f.state('done');
  assert.equal(done.resultText, 'persisted final body');
  await f.restart();
  assert.equal(f.run('done').state, 'done');
  assert.equal(f.host.engine.admit(args).runId, accepted.runId);
  assert.equal(f.run('done').finishedAtMs, done.finishedAtMs);
  await delay(40);
  assert.equal(f.mock.requests.length, 1);
});

test('accepted queue checkpoint restarts exactly once across repeated recovery calls', options, async (t) => {
  const f = await fixture(t); const bot = f.bot();
  f.host.engine.schedule = () => {};
  const queued = f.host.engine.admit({ agentId: bot.id, prompt: 'queued work', clientNonce: 'queued' });
  assert.equal(queued.state, 'accepted');
  assert.equal(f.mock.requests.length, 0);
  await f.restart();
  f.host.engine.recover(); f.host.engine.recover();
  await f.state('queued');
  assert.equal(f.mock.requests.length, 1);
  assert.equal(f.host.engine.execution.listRuns().length, 1);
});

for (const state of ['running', 'cancelling']) test(`${state} effect-unknown checkpoint becomes needs-reconciliation without re-execution`, options, async (t) => {
  const f = await fixture(t); const bot = f.bot();
  f.host.engine.schedule = () => {};
  const run = f.host.engine.admit({ agentId: bot.id, prompt: 'uncertain effect', clientNonce: state });
  f.host.engine.execution.saveRun({ ...run, state, remainingCalls: [{ id: 'effect', name: 'shell', args: { command: 'touch effect-marker' } }] });
  f.host.roster.store(bot.id).appendEntry({ id: 'partial', kind: 'send-message', runId: run.runId, streaming: true, conversationId: `dm:${bot.id}`, message: { type: 'text', content: 'partial' } });
  await f.restart();
  assert.equal(f.run(state).state, 'needs-reconciliation');
  assert.match(f.run(state).error, /not replayed/);
  assert.equal(f.host.roster.store(bot.id).getEntry('partial').partial, true);
  assert.equal(f.host.roster.store(bot.id).getEntry('partial').streaming, false);
  await delay(40);
  assert.equal(f.mock.requests.length, 0);
  assert.equal(fs.existsSync(path.join(f.host.p.workspace, 'effect-marker')), false);
});

test('legacy ledger migration preserves source bytes and original digest, marks missing runs for reconciliation', options, async (t) => {
  const f = await fixture(t); const bot = f.bot(); await f.closeHost();
  const file = path.join(f.root, 'send-acceptance.json');
  const record = { accountSlot: 'host', clientNonce: 'old', agentId: bot.id, inputDigest: legacyDigest('old text'), status: 'accepted', acceptedAtMs: 123, echoEntryId: 'old-echo', extra: { keep: true } };
  const bytes = JSON.stringify({ records: [record], historyGaps: { evictionHorizonMs: 11 } }, null, 2);
  fs.writeFileSync(file, bytes);
  f.open();
  const migrated = f.host.engine.execution.getLegacyAdmission('old');
  for (const [key, value] of Object.entries(record)) assert.deepEqual(migrated[key], value);
  assert.equal(migrated.legacyInputDigest, record.inputDigest);
  assert.equal(migrated.needs_reconciliation, true);
  assert.equal(f.run('old').state, 'needs-reconciliation');
  assert.equal(f.host.engine.admit({ agentId: bot.id, prompt: 'old text', clientNonce: 'old' }).state, 'needs-reconciliation');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(f.host.engine.execution.listRuns().length, 0);
  assert.equal(f.mock.requests.length, 0);
  const replay = f.host.engine.execution.migrateLegacy();
  assert.equal(replay.imported, 0); assert.equal(replay.skipped, 1);
});

test('legacy hidden turn siblings stay isolated, with a readable pre-migration SQLite backup', options, async (t) => {
  const f = await fixture(t); const bot = f.bot(); const file = f.host.p.agentStore(bot.id); await f.closeHost();
  const db = new DatabaseSync(file);
  const rows = [
    { id: 'old-public', kind: 'message', role: 'user', message: { type: 'text', content: 'PUBLIC' } },
    { id: 'old-hidden', kind: 'message', hidden: true, turnId: 'legacy-turn', message: { type: 'text', content: 'PRIVATE-HIDDEN' } },
    { id: 'old-sibling', kind: 'send-message', turnId: 'legacy-turn', message: { type: 'text', content: 'PRIVATE-SIBLING' } },
  ];
  db.prepare('DELETE FROM kv WHERE key = ?').run('conversationSchemaVersion');
  for (const row of rows) db.prepare('INSERT INTO transcript_entries(seq,id,entry) VALUES ((SELECT COALESCE(MAX(seq),0)+1 FROM transcript_entries),?,?)').run(row.id, JSON.stringify(row));
  db.close();
  f.open();
  const store = f.host.roster.store(bot.id);
  assert.equal(store.getEntry('old-public').conversationId, `dm:${bot.id}`);
  for (const id of ['old-hidden', 'old-sibling']) {
    assert.equal(store.getEntry(id).conversationId, `legacy:unknown:${bot.id}`);
    assert.equal(store.getEntry(id).legacyUnclassified, true);
  }
  assert.deepEqual(f.host.engine.visibleEntries(bot.id).filter((e) => e.id.startsWith('old-')).map((e) => e.id), ['old-public']);
  const messages = JSON.stringify(f.host.engine.buildMessages(bot.id));
  assert.match(messages, /PUBLIC/); assert.doesNotMatch(messages, /PRIVATE-HIDDEN|PRIVATE-SIBLING/);
  const backupFile = `${file}.pre-conversations-v2`;
  assert.equal(fs.existsSync(backupFile), true);
  const backup = new DatabaseSync(backupFile, { readOnly: true });
  try {
    assert.deepEqual(JSON.parse(backup.prepare('SELECT entry FROM transcript_entries WHERE id = ?').get('old-hidden').entry), rows[1]);
  } finally { backup.close(); }
});

test('peer delivery deduplication persists across new Host and detects message body conflict', options, async (t) => {
  const f = await fixture(t); const from = f.bot('From'); const to = f.bot('To');
  const args = { fromAgentId: from.id, to: to.id, text: 'exactly once', messageId: 'peer-fixed', priority: false };
  assert.equal((await f.host.engine.sendToAgent(args)).held, true);
  await f.restart();
  const duplicate = await f.host.engine.sendToAgent(args);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(f.host.engine.sendToAgent({ ...args, text: 'changed' }), { code: 'send/nonce-digest-mismatch' });
  assert.equal(f.host.roster.store(to.id).readAll().filter((e) => e.peerMessageId === 'peer-fixed').length, 1);
  assert.equal(f.mock.requests.length, 0);
});

for (const boundary of ['before-wake', 'after-wake-admission']) test(`priority peer half-commit recovers ${boundary} without duplicate delivery or wake`, options, async (t) => {
  const f = await fixture(t); const from = f.bot('From'); const to = f.bot('To'); const engine = f.host.engine;
  if (boundary === 'before-wake') engine.ensurePeerWake = async () => { throw new Error('simulated wake crash'); };
  else {
    const original = engine.execution.updateAdmission.bind(engine.execution);
    engine.execution.updateAdmission = (scope, ...args) => { if (scope.startsWith('peer:')) throw new Error('simulated receipt crash'); return original(scope, ...args); };
  }
  await assert.rejects(engine.sendToAgent({ fromAgentId: from.id, to: to.id, text: 'priority payload', priority: true, messageId: 'priority-half' }), /simulated/);
  if (boundary === 'after-wake-admission') await f.state(`peer-wake:${to.id}:priority-half`);
  assert.equal(engine.execution.getAdmission(`peer:${to.id}`, 'priority-half').woken, false);
  await f.restart();
  await f.state(`peer-wake:${to.id}:priority-half`);
  await until(() => f.host.engine.execution.getAdmission(`peer:${to.id}`, 'priority-half').woken, 'persisted peer wake receipt');
  f.host.engine.recover();
  await delay(40);
  assert.equal(f.mock.requests.length, 1);
  assert.equal(f.host.roster.store(to.id).readAll().filter((e) => e.peerMessageId === 'priority-half').length, 1);
  assert.equal(f.host.engine.execution.listRuns().filter((run) => run.trigger === 'peer').length, 1);
});
