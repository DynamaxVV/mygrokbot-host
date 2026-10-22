// Isolated concurrency review. Production sources are loaded unmodified.
// Engine dependencies use in-memory stores, a scripted transport, and virtual timers.
// No model, shell child, user config, or application filesystem effects run here.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RunScheduler } from '../../src/scheduler.mjs';
import { EventBus } from '../../src/bus.mjs';
import { RoomTurns } from '../../src/room.mjs';
import * as entries from '../../src/entries.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const results = [];
const tick = () => new Promise(setImmediate);
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function clock() {
  let now = 1_000_000;
  const timers = [];
  return { now: () => now, timers, schedule(ms, fn) { const t = { at: now + ms, fn, cancelled: false, unref() {} }; timers.push(t); return t; }, cancel(t) { if (t) t.cancelled = true; }, advance(ms) { now += ms; for (const t of [...timers]) if (!t.cancelled && t.at <= now) { t.cancelled = true; t.fn(); } } };
}
function memStore() {
  const rows = [];
  return { rows, hideWrites: false,
    appendEntry(e) { const row = { ...e, ...(this.hideWrites ? { hidden: true } : {}) }; rows.push(row); return row; },
    getEntry(id) { return rows.find(e => e.id === id); },
    updateEntry(id, fn) { const i = rows.findIndex(e => e.id === id); if (i >= 0) rows[i] = fn(rows[i]); return rows[i]; },
    readAll() { return [...rows]; },
    readWindow({ limit = 50 } = {}) { return [...rows].reverse().slice(0, limit); },
  };
}
class MemLedger {
  constructor() { this.records = new Map(); }
  record({ clientNonce, prompt, agentId }) { const old = this.records.get(clientNonce); if (old) return { replayed: true, record: old }; const record = { clientNonce, agentId, acceptedAtMs: Date.now(), status: 'accepted' }; this.records.set(clientNonce, record); return { record, replayed: false }; }
  update(_slot, nonce, patch) { const r = this.records.get(nonce); Object.assign(r, patch); return r; }
  lookup({ clientNonce }) { const record = this.records.get(clientNonce); return record ? { outcome: 'found', record } : { outcome: 'not-found' }; }
}
async function synthetic(exports, context) {
  const names = Object.keys(exports);
  const m = new vm.SyntheticModule(names, function() { for (const name of names) this.setExport(name, exports[name]); }, { context });
  return m;
}
async function makeEngine({ streamFactory = async function* () { yield { type: 'text', text: 'ok' }; }, execute = async () => ({ result: 'ok' }) } = {}) {
  const timers = clock();
  const context = vm.createContext({ console, AbortController, Buffer, Date, setTimeout: (fn, ms) => timers.schedule(ms, fn), clearTimeout: t => timers.cancel(t) });
  const source = fs.readFileSync(path.join(root, 'src/engine.mjs'), 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: 'review:engine' });
  await module.link(async spec => {
    if (spec === './providers/bindings.mjs') return synthetic({ resolveBinding: () => ({ modelId: 'synthetic', baseUrl: 'http://fixture.invalid', parameters: [] }) }, context);
    if (spec === './providers/transport.mjs') return synthetic({ streamChat: options => streamFactory(options) }, context);
    if (spec === './acceptance.mjs') return synthetic({ AcceptanceLedger: MemLedger, inputDigest: () => 'fixture' }, context);
    if (spec === 'node:fs') return synthetic({ default: new Proxy({}, { get() { throw Error('production filesystem access blocked by harness'); } }) }, context);
    const url = spec.startsWith('.') ? pathToFileURL(path.resolve(root, 'src', spec)).href : spec;
    const actual = await import(url);
    return synthetic(actual, context);
  });
  await module.evaluate();
  const stores = new Map();
  const roster = { resolve: id => id, profile: () => ({}), summary: id => ({ id, name: id }), readMemoryAll: () => '', store(id) { if (!stores.has(id)) stores.set(id, memStore()); return stores.get(id); } };
  const bus = new EventBus(); const events = []; bus.subscribe(e => events.push(e));
  const engine = new module.namespace.TurnEngine({ p: { root: dir, workspace: dir, logs: dir }, roster, catalog: { list: () => [] }, tools: { execute }, bus });
  engine.buildMessages = () => [{ role: 'user', content: 'fixture' }];
  engine.writeProvenance = () => {};
  engine.appendWorkLog = () => {};
  engine.scheduler.clock = clock();
  return { engine, stores, roster, bus, events, timers, schedulerClock: engine.scheduler.clock };
}
async function check(name, fn) { const detail = await fn(); results.push({ name, passed: true, ...detail }); console.log(`PASS ${name} ${JSON.stringify(detail)}`); }

await check('watchdog telemetry does not abort; escape overlaps a live tool', async () => {
  const gate = deferred(); let toolActive = false; let secondWhileTool = false; let calls = 0;
  const h = await makeEngine({ streamFactory: async function* () { calls++; if (calls === 1) yield { type: 'tool_calls', calls: [{ id: 't1', name: 'fixture_tool', args: '{}' }] }; else { secondWhileTool ||= toolActive; yield { type: 'text', text: 'second' }; } }, execute: async () => { toolActive = true; await gate.promise; toolActive = false; return { result: 'done' }; } });
  h.engine.scheduler.watchdogMs = 10; h.engine.scheduler.watchdogGraceMs = 5;
  h.engine.admit({ agentId: 'a', prompt: 'first' }); await tick();
  const oldController = h.engine.aborts.get('a');
  h.engine.admit({ agentId: 'a', prompt: 'second' });
  h.schedulerClock.advance(10); const abortedAtTrip = oldController.signal.aborted;
  h.schedulerClock.advance(5); await tick();
  assert.equal(abortedAtTrip, false); assert.equal(secondWhileTool, true);
  gate.resolve(); await tick(); await h.engine.scheduler.drain('a');
  const stages = h.events.filter(e => e.type === 'queue-watchdog').map(e => e.stage);
  assert(stages.includes('late_settle'));
  return { abortedAtTrip, secondWhileTool, stages };
});

await check('forceRelease permits overlap and drain loses released unresolved task', async () => {
  const s = new RunScheduler({ clock: clock() }); const old = deferred(); const current = deferred();
  let active = 0; let maximum = 0; const job = gate => async () => { maximum = Math.max(maximum, ++active); await gate.promise; active--; };
  const p1 = s.enqueue('a', job(old)).catch(() => {}); await tick();
  const p2 = s.enqueue('a', job(current)); s.forceRelease('a');
  assert.equal(maximum, 2); current.resolve(); await p2; await tick();
  let drained = false; await s.drain('a').then(() => { drained = true; });
  assert.equal(drained, true); assert.equal(active, 1);
  old.resolve(); await p1; await tick();
  return { maximum, drainedWhileOldActive: drained };
});

await check('patch E still pumps before exit; enqueue currently discards abort options', async () => {
  const c = clock(); const s = new RunScheduler({ clock: c }); const old = deferred(); const next = deferred();
  let active = 0; let maximum = 0; let aborted = false; let quarantined = false;
  const p1 = s.enqueue('a', async () => { maximum = Math.max(maximum, ++active); await old.promise; active--; }, { abort: () => { aborted = true; } }); await tick();
  const item = s.queues.get('a').active.item; const enqueueStoredAbort = typeof item.abort === 'function';
  // Emulate fixing the missing enqueue contract, so the ordering bug is independent.
  item.abort = () => { aborted = true; }; item.quarantine = () => { quarantined = true; };
  const p2 = s.enqueue('a', async () => { maximum = Math.max(maximum, ++active); await next.promise; active--; });
  const q = s.queues.get('a'); const oldActive = q.active;
  function releaseWithAbort(agentId, queue, current, reason) {
    try { current.item.abort?.(reason); } catch {}
    const graceMs = this.abortGraceMs ?? 2_000;
    this.clock.schedule(graceMs, () => { current.item.quarantine?.(); });
    queue.active = null;
    queue.zombies.add(current.settled);
    void current.settled.then(() => queue.zombies.delete(current.settled));
    this.pump(agentId);
  }
  releaseWithAbort.call(s, 'a', q, oldActive, 'fixture');
  assert.equal(enqueueStoredAbort, false); assert.equal(aborted, true); assert.equal(maximum, 2); assert.equal(quarantined, false);
  old.resolve(); next.resolve(); await Promise.all([p1, p2]); s.dispose();
  return { enqueueStoredAbort, aborted, maximum, quarantinedWhenSecondStarts: false };
});

await check('room deadline does not release same-bot scheduler lane', async () => {
  const s = new RunScheduler({ clock: clock() }); const gate = deferred(); const statuses = new Map(); let started = 0;
  const engine = { admit({ agentId, clientNonce, lane, source }) { const a = { agentId, clientNonce, state: 'accepted' }; statuses.set(clientNonce, a); s.enqueue(agentId, async () => { started++; a.state = 'running'; await gate.promise; a.state = 'done'; }, { lane, source }); return a; }, acceptanceStatus: nonce => statuses.get(nonce) };
  const roster = { resolve: id => id, profile: () => ({}), groupMembers: () => ['a'], exists: () => true };
  const r = new RoomTurns({ roster, engine, bus: new EventBus() });
  const first = await r.runRound({ roomId: 'room', deadlineMs: -1 }); await tick();
  const second = await r.runRound({ roomId: 'room', deadlineMs: -1 }); await tick();
  const q = s.queues.get('a');
  assert.equal(first.results[0].outcome, 'timeout'); assert.equal(second.results[0].outcome, 'timeout'); assert.equal(started, 1); assert.equal(q.pendingBackground.length, 1); assert(q.active);
  const pending = q.pendingBackground.length; gate.resolve(); await s.drain('a'); s.dispose();
  return { first: first.results[0].outcome, second: second.results[0].outcome, startedBeforeRelease: 1, pendingBackground: pending };
});

await check('approval execution bypasses scheduler; a live card runs without a parked run', async () => {
  let busy = false; let overlap = false; let calls = 0;
  const h = await makeEngine({ execute: async args => { calls++; overlap = busy; assert.equal(args.signal, undefined); return { result: 'approved fake effect' }; } });
  h.engine.runTurn = async () => {};
  const gate = deferred(); const active = h.engine.scheduler.enqueue('a', async () => { busy = true; await gate.promise; busy = false; }); await tick();
  const store = h.roster.store('a');
  store.appendEntry(entries.toolCallEntry({ name: 'shell', args: { command: 'fixture' }, callId: 'call', status: 'awaiting-approval', turnId: 'old-turn' }));
  const card = entries.approvalEntry({ requestId: 'req-call', command: 'fixture' }); store.appendEntry(card);
  assert.equal(h.engine.parked.size, 0);
  const result = await h.engine.resolveApproval({ agentId: 'a', entryId: card.id, resolution: 'approved' });
  assert.equal(overlap, true); assert.equal(calls, 1); assert.equal(result.resumed, true);
  gate.resolve(); await active; await h.engine.scheduler.drain('a');
  return { effectExecutedDuringOtherRun: overlap, parkedRunRequired: false, continuationQueued: result.resumed };
});

await check('interrupt leaves suspended approval actionable', async () => {
  let calls = 0; const h = await makeEngine({ execute: async () => { calls++; return { result: 'fixture' }; } }); h.engine.runTurn = async () => {};
  const store = h.roster.store('a'); const old = { agentId: 'a', clientNonce: 'n-old', state: 'awaiting-approval' };
  h.engine.acceptances.set(old.clientNonce, old); h.engine.parked.set('a', { acceptance: old, turnId: 'old' });
  store.appendEntry(entries.toolCallEntry({ name: 'shell', args: { command: 'fixture' }, callId: 'call', status: 'awaiting-approval' })); const card = entries.approvalEntry({ requestId: 'req-call', command: 'fixture' }); store.appendEntry(card);
  h.engine.interrupt('a'); const stateAfterInterrupt = old.state;
  await h.engine.resolveApproval({ agentId: 'a', entryId: card.id, resolution: 'approved' }); await h.engine.scheduler.drain('a');
  assert.equal(stateAfterInterrupt, 'awaiting-approval'); assert.equal(calls, 1);
  return { stateAfterInterrupt, effectRanAfterStop: calls === 1 };
});

await check('widget answer binds the latest unresolved ask_user, not the supplied card', async () => {
  const h = await makeEngine(); h.engine.runTurn = async () => {};
  const store = h.roster.store('a');
  store.appendEntry(entries.toolCallEntry({ name: 'ask_user', args: { prompt: 'older' }, callId: 'older', status: 'awaiting-answer', turnId: 'turn-older' }));
  const olderCard = entries.widgetEntry({ widgetId: 'older-widget', prompt: 'older' }); store.appendEntry(olderCard);
  store.appendEntry(entries.toolCallEntry({ name: 'ask_user', args: { prompt: 'newer' }, callId: 'newer', status: 'awaiting-answer', turnId: 'turn-newer' }));
  store.appendEntry(entries.widgetEntry({ widgetId: 'newer-widget', prompt: 'newer' }));
  const newer = { agentId: 'a', state: 'awaiting-answer', hidden: true }; h.engine.parked.set('a', { acceptance: newer, turnId: 'turn-newer' });
  const answered = await h.engine.answerWidget({ agentId: 'a', entryId: olderCard.id, value: 'older answer' }); await h.engine.scheduler.drain('a');
  const result = store.rows.find(e => e.kind === 'tool-result'); const resumed = h.engine.acceptances.get(answered.clientNonce);
  assert.equal(result.callId, 'newer'); assert.equal(store.getEntry('older').status, 'awaiting-answer'); assert.equal(newer.state, 'done'); assert.equal(resumed.hidden, undefined);
  return { suppliedCard: 'older-widget', resultBoundCall: result.callId, unrelatedParkedState: newer.state, resumedHidden: resumed.hidden ?? null };
});

await check('success timer stays live; its idle callback throws ReferenceError', async () => {
  const h = await makeEngine(); const a = { agentId: 'a', state: 'accepted', clientNonce: 'n', entryId: 'prompt' };
  await h.engine.runTurn({ agentId: 'a', acceptance: a }); assert.equal(a.state, 'done');
  const timer = h.timers.timers[0]; assert.equal(timer.cancelled, false);
  let callbackError; try { timer.fn(); } catch (e) { callbackError = String(e); }
  assert.match(callbackError, /acceptances is not defined/);
  return { stateBeforeTimer: 'done', timerCancelledOnDone: false, callbackError };
});

await check('old completed turn timer aborts a newer turn controller', async () => {
  const h = await makeEngine(); const old = { agentId: 'a', state: 'accepted', clientNonce: 'old', entryId: 'prompt' };
  await h.engine.runTurn({ agentId: 'a', acceptance: old });
  const newerController = new AbortController(); h.engine.aborts.set('a', newerController); h.engine.running.set('a', { turnId: 'newer' });
  h.timers.timers[0].fn();
  assert.equal(newerController.signal.aborted, true); assert.equal(h.engine.running.has('a'), false);
  return { newerControllerAborted: true, newerRunningDeleted: true, oldAcceptanceState: old.state };
});

await check('park and abort branches leak hideWrites; approved resume reads wrong nesting', async () => {
  const h = await makeEngine({ streamFactory: async function* () { yield { type: 'tool_calls', calls: [{ id: 'ask', name: 'ask_user', args: '{}' }] }; }, execute: async () => ({ needsWidget: { prompt: 'fixture', options: [] } }) });
  const a = { agentId: 'a', state: 'accepted', clientNonce: 'n', entryId: 'prompt', hidden: true };
  await h.engine.runTurn({ agentId: 'a', acceptance: a }); assert.equal(a.state, 'awaiting-answer'); const store = h.roster.store('a');
  assert.equal(store.hideWrites, true); assert.equal(h.timers.timers[0].cancelled, false);
  const parked = h.engine.parked.get('a'); assert.equal(parked.hidden, undefined); assert.equal(parked.acceptance.hidden, true);
  const leakAtPark = store.hideWrites; store.hideWrites = false;
  await h.engine.runTurn({ agentId: 'a', acceptance: { agentId: 'a', state: 'accepted', clientNonce: 'n2', entryId: 'p2', hidden: true, abortRequested: true } });
  assert.equal(store.hideWrites, true);
  return { hideWritesLeakedAtPark: leakAtPark, hideWritesLeakedAtAbort: store.hideWrites, patchDParkedHidden: parked.hidden ?? null, actualHidden: parked.acceptance.hidden };
});

await check('stream abort does not cancel in-flight tool effect', async () => {
  const gate = deferred(); let effect = false; let receivedSignal = 'not called';
  const h = await makeEngine({ streamFactory: async function* () { yield { type: 'tool_calls', calls: [{ id: 'tool', name: 'fixture_tool', args: '{}' }] }; }, execute: async args => { receivedSignal = args.signal; await gate.promise; effect = true; return { result: 'done' }; } });
  const accepted = h.engine.admit({ agentId: 'a', prompt: 'fixture' }); await tick();
  const controller = h.engine.aborts.get('a'); const stopped = h.engine.interrupt('a');
  assert.equal(stopped.streaming, true); assert.equal(controller.signal.aborted, true); assert.equal(effect, false);
  gate.resolve(); await h.engine.scheduler.drain('a');
  assert.equal(effect, true); assert.equal(h.engine.acceptanceStatus(accepted.clientNonce).state, 'interrupted');
  return { controllerAborted: true, toolReceivedSignal: receivedSignal ?? null, sideEffectAfterInterrupt: effect, finalState: 'interrupted' };
});

await check('ToolRuntime shell never passes signal or retains child; pre-aborted write still mutates stub', async () => {
  const context = vm.createContext({ console }); const writes = []; let shellOptions; let shellDone;
  const stubFs = { mkdirSync() {}, writeFileSync(...args) { writes.push(args); } };
  const source = fs.readFileSync(path.join(root, 'src/tools.mjs'), 'utf8'); const module = new vm.SourceTextModule(source, { context, identifier: 'review:tools' });
  await module.link(async spec => {
    if (spec === 'node:fs') return synthetic({ default: stubFs }, context);
    if (spec === 'node:child_process') return synthetic({ execFile: (_bin, _args, opts, done) => { shellOptions = opts; shellDone = done; return { kill() { throw Error('unexpected kill'); } }; } }, context);
    if (spec === './paths.mjs') return synthetic({ readJson: () => ({ autoApprove: true }), writeJsonAtomicLoose() {} }, context);
    if (spec === './review.mjs') return synthetic({ evaluate: () => ({ decision: 'allow' }) }, context);
    return synthetic(await import(spec), context);
  }); await module.evaluate();
  const tools = new module.namespace.ToolRuntime({ p: { workspace: dir }, roster: {}, root: dir, env: {} }); const controller = new AbortController(); controller.abort();
  await tools.execute({ agentId: 'a', call: { name: 'write_file', args: { path: 'stub-only.txt', content: 'fixture' } }, signal: controller.signal });
  const shellPromise = tools.execute({ agentId: 'a', call: { name: 'shell', args: { command: 'synthetic-no-child' } }, signal: controller.signal });
  assert.equal(shellOptions.signal, undefined); assert.equal(writes.length, 1); shellDone(null, 'fixture', ''); await shellPromise;
  return { preAbortedWritePerformedInMemory: true, shellSignalProvided: false, actualChildSpawned: false, actualFileWritten: false };
});

fs.writeFileSync(path.join(dir, 'concurrency-review-results.json'), JSON.stringify({ sourceHead: 'd498dd83dca901d8d2a7db6a40e1ecabc9e9a7c4', isolation: 'actual source, injected transport/stores/timers/fs/execFile; no model or real tool effects', cases: results }, null, 2) + '\n');
console.log(`Completed ${results.length} isolated cases.`);
