import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fixture, waitFor, delay, deferred } from './cancellation-fixture.mjs';

const shell = (command, id) => ({ name: 'shell', args: { command }, ...(id ? { id } : {}) });
const question = (prompt, id) => ({ name: 'ask_user', args: { prompt, options: ['yes', 'no'] }, ...(id ? { id } : {}) });
const write = (file) => ({ name: 'write_file', args: { path: file, content: 'remaining batch ran' } });
const opts = { timeout: 7000 };

for (const mode of ['watchdog', 'forceRelease']) {
  test(`${mode}: real ToolRuntime retains its lane until an uncooperative hook exits; drain waits`, opts, async (t) => {
    const f = await fixture(t), agentId = f.bot();
    const gate = deferred();
    let entered = false, signal;
    f.host.tools.onMessageUser = async (args) => { entered = true; signal = args.signal; await gate.promise; return { delivered: true }; };
    t.after(() => gate.resolve());
    const scheduler = f.host.engine.scheduler;
    scheduler.watchdogMs = 30;
    scheduler.watchdogGraceMs = 20;
    const first = f.send(agentId, 'uncooperative', [{ name: 'message_user', args: { text: 'hold' } }]);
    try {
      await waitFor(() => entered, 'tool hook');
      const second = f.send(agentId, 'successor');
      if (mode === 'forceRelease') assert.equal(scheduler.forceRelease(agentId), true);
      await waitFor(() => signal.aborted, 'abort signal');
      if (mode === 'watchdog') await waitFor(() => scheduler.getDiagnostics()[0]?.active?.phase === 'stuck', 'stuck phase');
      await delay(60);
      assert.equal(f.requests.some((r) => r.messages.some((m) => m.role === 'user' && m.content === 'successor')), false);
      assert.equal(f.run(second).state, 'accepted');
      assert.equal(f.run(first).state, 'cancelling');
      let drained = false;
      const drain = scheduler.drain().then(() => { drained = true; });
      await delay(20);
      assert.equal(drained, false);
      gate.resolve();
      await drain;
      assert.equal(f.run(first).state, 'interrupted');
      assert.equal(f.run(second).state, 'done');
      assert.equal(f.host.engine.watchdogs.size, 0);
    } finally { gate.resolve(); }
  });
}

function live(pid) {
  try {
    process.kill(pid, 0);
    const stat = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).trim();
    return stat.length > 0 && !/^[ZX]/.test(stat);
  } catch (error) {
    if (error.code === 'ESRCH' || error.status === 1) return false;
    throw error;
  }
}
async function shellTree(t, { background = false, timeout = false } = {}) {
  const f = await fixture(t), agentId = f.bot();
  f.host.tools.setPolicy({ autoApprove: true });
  const controller = new AbortController();
  const ws = f.host.tools.workspace(agentId);
  // All process output and PIDs live under our isolated generated workspace.
  const command = background
    ? 'echo $$ > parent.pid; sleep 20 </dev/null >/dev/null 2>&1 & echo $! > child.pid; exit 0'
    : 'echo $$ > parent.pid; sleep 20 & echo $! > child.pid; wait';
  const realSetTimeout = globalThis.setTimeout;
  let timeoutArmed = false;
  if (timeout) globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 600_000) { timeoutArmed = true; return realSetTimeout(fn, 250, ...args); }
    return realSetTimeout(fn, ms, ...args);
  };
  const work = f.host.tools.execute({ agentId, call: shell(command), signal: controller.signal });
  // Attach immediately so an abort cannot become an unhandled rejection.
  const settled = work.then((value) => ({ value }), (error) => ({ error }));
  let pids = [];
  try {
    await waitFor(() => fs.existsSync(path.join(ws, 'child.pid')), 'shell PIDs');
    pids = ['parent.pid', 'child.pid'].map((file) => Number(fs.readFileSync(path.join(ws, file), 'utf8').trim()));
    assert.ok(pids.every((pid) => Number.isInteger(pid) && pid > 1));
    assert.equal(live(pids[1]), true);
    if (background) await waitFor(() => !live(pids[0]), 'parent exit');
    let completed = false;
    settled.then(() => { completed = true; });
    await delay(40);
    assert.equal(completed, false, 'owned descendants keep shell pending after parent exits');
    if (timeout) assert.equal(timeoutArmed, true);
    else controller.abort('test cancellation');
    const result = await settled;
    if (timeout) {
      assert.equal(result.value.result.exitCode, 1);
      assert.match(result.value.result.stderr, /timed out/);
    } else assert.equal(result.error?.name, 'AbortError');
    for (const pid of pids) assert.equal(live(pid), false, `owned PID ${pid} exited before settlement`);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    controller.abort('fixture cleanup');
    await settled;
    // Emergency cleanup applies only to exact PIDs created by this fixture.
    for (const pid of pids) if (live(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}
test('shell cancellation waits for both process-group parent and child exit', opts, (t) => shellTree(t));
test('a normally exited shell retains cancellation over redirected background descendants', opts, (t) => shellTree(t, { background: true }));
test('a normally exited shell retains timeout over redirected background descendants', opts, (t) => shellTree(t, { background: true, timeout: true }));

test('preaborted file and memory tools leave existing content and memory unchanged', opts, async (t) => {
  const f = await fixture(t), agentId = f.bot();
  const ws = f.host.tools.workspace(agentId);
  fs.writeFileSync(path.join(ws, 'existing.txt'), 'original');
  const before = f.host.roster.readMemoryAll(agentId);
  const signal = AbortSignal.abort('already cancelled');
  for (const call of [write('new/nested.txt'), { name: 'write_file', args: { path: 'existing.txt', content: 'overwritten' } }, { name: 'update_memory', args: { text: 'must never be persisted' } }]) {
    await assert.rejects(f.host.tools.execute({ agentId, call, signal }), { name: 'AbortError' });
  }
  assert.equal(fs.readFileSync(path.join(ws, 'existing.txt'), 'utf8'), 'original');
  assert.equal(fs.existsSync(path.join(ws, 'new')), false);
  assert.equal(f.host.roster.readMemoryAll(agentId), before);
});

for (const ending of ['complete', 'park', 'interrupt']) {
  test(`${ending} clears its timer and cannot time out a subsequent long stream`, opts, async (t) => {
    const f = await fixture(t), agentId = f.bot();
    f.host.engine.hostSettings = () => ({ maxTurnMinutes: 0.003 });
    const first = f.send(agentId, 'old segment', ending === 'park' ? [question('wait')] : ending === 'interrupt' ? 'hold' : undefined);
    if (ending === 'park') { await f.parked(first); await f.host.engine.scheduler.drain(); }
    else if (ending === 'interrupt') {
      await waitFor(() => f.requests.length && f.host.engine.watchdogs.size === 1, 'stream starts');
      f.host.engine.interrupt(agentId, { runId: first.runId });
      await f.done(first);
    } else await f.done(first);
    assert.equal(f.host.engine.watchdogs.size, 0);
    f.host.engine.hostSettings = () => ({ maxTurnMinutes: 1 });
    const next = f.send(agentId, 'new long stream', 'hold');
    await waitFor(() => f.run(next).state === 'running' && f.host.engine.watchdogs.size === 1, 'new stream');
    await delay(240);
    assert.equal(f.run(next).state, 'running', 'the old segment deadline must not cancel a new segment');
    assert.equal(f.host.engine.watchdogs.size, 1);
    f.host.engine.interrupt(agentId);
    await f.done(next);
    assert.equal(f.host.engine.watchdogs.size, 0);
  });
}

test('approval belongs to its exact bot/card, resumes through the queue, and approved is single use', opts, async (t) => {
  const f = await fixture(t), a = f.bot('Approver A'), b = f.bot('Approver B');
  const command = 'printf approved >> approval-count.txt';
  const first = f.send(a, 'approval a', [shell(command, 'approval-a-call')]);
  const other = f.send(b, 'approval b', [shell(command, 'approval-b-call')]);
  const cardA = await f.parked(first), cardB = await f.parked(other);
  await f.host.engine.scheduler.drain();
  await assert.rejects(f.host.engine.resolveApproval({ agentId: b, entryId: cardA.id, resolution: 'approved' }), /stale/);
  assert.equal(f.host.engine.execution.getInteraction(cardB.id).state, 'pending');
  const gate = deferred();
  let occupied = false;
  f.host.engine.scheduler.enqueue(a, async () => { occupied = true; await gate.promise; });
  try {
    await waitFor(() => occupied, 'occupied lane');
    await f.host.engine.resolveApproval({ agentId: a, entryId: cardA.id, resolution: 'approved' });
    await delay(50);
    assert.equal(f.run(first).state, 'accepted');
    assert.equal(fs.existsSync(path.join(f.host.p.workspace, 'approval-count.txt')), false);
    gate.resolve();
    await f.done(first);
    assert.equal(f.run(other).state, 'awaiting-approval');
    assert.equal(fs.readFileSync(path.join(f.host.p.workspace, 'approval-count.txt'), 'utf8'), 'approved');
    await assert.rejects(f.host.engine.resolveApproval({ agentId: a, entryId: cardA.id, resolution: 'approved' }), /stale/);
    const again = f.send(a, 'approval a again', [shell(command)]);
    await f.parked(again);
    await f.host.engine.resolveApproval({ agentId: b, entryId: cardB.id, resolution: 'denied' });
    assert.equal(fs.readFileSync(path.join(f.host.p.workspace, 'approval-count.txt'), 'utf8'), 'approved');
  } finally { gate.resolve(); }
});

for (const kind of ['approval', 'question']) {
  test(`stop invalidates a parked ${kind} and its remaining batch`, opts, async (t) => {
    const f = await fixture(t), agentId = f.bot();
    const run = f.send(agentId, `stopped ${kind}`, [kind === 'approval' ? shell('printf bad > stopped-shell.txt') : question('stop?'), write('stopped-batch.txt')]);
    const card = await f.parked(run);
    f.host.engine.interrupt(agentId);
    await f.host.engine.scheduler.drain();
    await assert.rejects(kind === 'approval'
      ? f.host.engine.resolveApproval({ agentId, entryId: card.id, resolution: 'approved' })
      : f.host.engine.answerWidget({ agentId, entryId: card.id, value: 'yes' }), /stale/);
    assert.equal(f.run(run).state, 'interrupted');
    assert.equal(fs.existsSync(path.join(f.host.p.workspace, 'stopped-shell.txt')), false);
    assert.equal(fs.existsSync(path.join(f.host.p.workspace, 'stopped-batch.txt')), false);
  });
}

test('questions answered in reverse order retain exact run/call IDs', opts, async (t) => {
  const f = await fixture(t), agentId = f.bot();
  const first = f.send(agentId, 'first question', [question('first?', 'question-first')]);
  const card1 = await f.parked(first);
  const second = f.send(agentId, 'second question', [question('second?', 'question-second')]);
  const card2 = await f.parked(second);
  await f.host.engine.answerWidget({ agentId, entryId: card2.id, value: 'second answer' });
  await f.done(second);
  assert.equal(f.run(first).state, 'awaiting-answer');
  await f.host.engine.answerWidget({ agentId, entryId: card1.id, value: 'first answer' });
  await f.done(first);
  for (const [callId, run, answer] of [['question-first', first, 'first answer'], ['question-second', second, 'second answer']]) {
    const results = f.entries(agentId).filter((e) => e.kind === 'tool-result' && e.callId === callId);
    assert.equal(results.length, 1);
    assert.equal(results[0].runId, run.runId);
    assert.deepEqual(JSON.parse(results[0].result), { answer });
  }
});

for (const kind of ['approval', 'question']) {
  test(`stop after deciding ${kind} cancels its queued continuation before any effect`, opts, async (t) => {
    const f = await fixture(t), agentId = f.bot();
    const run = f.send(agentId, `queued stop ${kind}`, [kind === 'approval' ? shell('printf bad > queued-shell.txt') : question('continue?'), write('queued-batch.txt')]);
    const card = await f.parked(run);
    await f.host.engine.scheduler.drain();
    const gate = deferred();
    let occupied = false;
    f.host.engine.scheduler.enqueue(agentId, async () => { occupied = true; await gate.promise; });
    try {
      await waitFor(() => occupied, 'occupied lane');
      if (kind === 'approval') await f.host.engine.resolveApproval({ agentId, entryId: card.id, resolution: 'approved' });
      else await f.host.engine.answerWidget({ agentId, entryId: card.id, value: 'yes' });
      assert.equal(f.run(run).state, 'accepted');
      f.host.engine.interrupt(agentId, { runId: run.runId });
      gate.resolve();
      await f.host.engine.scheduler.drain();
      assert.equal(f.run(run).state, 'interrupted');
      assert.equal(fs.existsSync(path.join(f.host.p.workspace, 'queued-shell.txt')), false);
      assert.equal(fs.existsSync(path.join(f.host.p.workspace, 'queued-batch.txt')), false);
      assert.equal(f.host.engine.execution.getInteraction(card.id).state, 'cancelled');
    } finally { gate.resolve(); }
  });
}

test('a single approval does not authorize the identical next shell in the same batch', opts, async (t) => {
  const f = await fixture(t), agentId = f.bot();
  const command = 'printf x >> single-approval.txt';
  const run = f.send(agentId, 'repeated shell batch', [shell(command), shell(command)]);
  const first = await f.parked(run);
  await f.host.engine.resolveApproval({ agentId, entryId: first.id, resolution: 'approved' });
  const second = await waitFor(() => f.host.engine.execution.listInteractions().find((a) => a.runId === run.runId && a.id !== first.id && a.state === 'pending'), 'second approval');
  assert.notEqual(first.callId, second.callId);
  assert.equal(fs.readFileSync(path.join(f.host.p.workspace, 'single-approval.txt'), 'utf8'), 'x');
  await f.host.engine.resolveApproval({ agentId, entryId: second.id, resolution: 'approved' });
  assert.equal((await f.done(run)).state, 'done');
  assert.equal(fs.readFileSync(path.join(f.host.p.workspace, 'single-approval.txt'), 'utf8'), 'xx');
});

for (const kind of ['approval', 'question']) {
  test(`${kind} resumption executes every remaining tool in the original batch`, opts, async (t) => {
    const f = await fixture(t), agentId = f.bot();
    const run = f.send(agentId, `batch ${kind}`, [kind === 'approval' ? shell('printf first > batch-shell.txt') : question('continue?'), write('batch-second.txt'), write('batch-third.txt')]);
    const card = await f.parked(run);
    assert.equal(fs.existsSync(path.join(f.host.p.workspace, 'batch-second.txt')), false);
    if (kind === 'approval') await f.host.engine.resolveApproval({ agentId, entryId: card.id, resolution: 'approved' });
    else await f.host.engine.answerWidget({ agentId, entryId: card.id, value: 'yes' });
    assert.equal((await f.done(run)).state, 'done');
    for (const file of ['batch-second.txt', 'batch-third.txt']) assert.equal(fs.readFileSync(path.join(f.host.p.workspace, file), 'utf8'), 'remaining batch ran');
    const results = f.entries(agentId).filter((e) => e.runId === run.runId && e.kind === 'tool-result');
    assert.equal(results.length, 3);
    assert.equal(new Set(results.map((e) => e.callId)).size, 3);
  });
}
