import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskDispatcher } from '../src/tasks.mjs';
import { fixture, until, delay, gate, tool, lastUser, TEST_TIMEOUT } from './task-fixture.mjs';

const options = { timeout: TEST_TIMEOUT };
const hasResult = (body) => body.messages.some((m) => typeof m.content === 'string' && /\[task:task:.*\] (completed|cancelled|failed)/.test(m.content));
const delegated = (body) => String(lastUser(body)).startsWith('Delegated task from ');
const count = (f, model) => f.mock.requests.filter((request) => request.body.model === model).length;

function parentScript(targets) {
  return (body) => {
    if (delegated(body)) return { text: `CHILD RESULT ${body.model}: actual result body` };
    if (hasResult(body)) return { text: `PARENT SUMMARY: ${body.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')}` };
    if (body.messages.some((m) => m.role === 'tool')) return { text: 'Waiting for child work.' };
    return { calls: targets.map((to, i) => tool('delegate_task', { to, objective: `Compute ${i}`, expectedOutput: 'actual result body' }, `delegate-${i}`)) };
  };
}

test('child final response resumes and summarizes its parent with full result text and no new user message', options, async (t) => {
  const f = await fixture(t, parentScript(['Child'])); const parent = f.bot('Parent'); f.bot('Child');
  const accepted = f.host.engine.admit({ agentId: parent.id, prompt: 'delegate and summarize', clientNonce: 'parent' });
  const done = await f.state('parent');
  assert.equal(done.runId, accepted.runId);
  assert.match(done.resultText, /PARENT SUMMARY/);
  assert.match(done.resultText, /CHILD RESULT Child: actual result body/);
  const [task] = f.host.tasks.list();
  assert.equal(task.state, 'completed');
  assert.equal(task.resultText, 'CHILD RESULT Child: actual result body');
  assert.deepEqual(done.consumedTaskIds, [task.id]);
  assert.equal(count(f, 'Parent'), 3);
  assert.equal(count(f, 'Child'), 1);
  assert.equal(f.host.roster.store(parent.id).readAll().filter((e) => e.role === 'user' && !e.contextOnly && e.clientNonce === 'parent').length, 1);
  const resume = f.mock.requests.filter((r) => r.body.model === 'Parent').at(-1).body;
  assert.ok(resume.messages.some((m) => String(m.content).includes('CHILD RESULT Child: actual result body')));
});

test('out-of-order and duplicate child completion delivers each body and resumes the parent only once', options, async (t) => {
  const a = gate(); const b = gate();
  const base = parentScript(['Child-A', 'Child-B']);
  const f = await fixture(t, async (body) => {
    if (body.model === 'Child-A') { await a.promise; return { text: 'RESULT-A-unique' }; }
    if (body.model === 'Child-B') { await b.promise; return { text: 'RESULT-B-unique' }; }
    return base(body);
  });
  f.beforeClose(() => { a.release(); b.release(); });
  const parent = f.bot('Parent'); f.bot('Child-A'); f.bot('Child-B');
  f.host.engine.admit({ agentId: parent.id, prompt: 'two parallel children', clientNonce: 'two' });
  await f.state('two', 'waiting-children');
  await until(() => f.mock.requests.some((r) => r.body.model === 'Child-A') && f.mock.requests.some((r) => r.body.model === 'Child-B'), 'both child requests');
  b.release();
  const second = await until(() => f.host.tasks.list().find((task) => task.state === 'completed'), 'second child completion');
  assert.equal(second.toBotId, f.host.roster.resolve('Child-B'));
  const secondRun = f.host.engine.execution.getRun(second.runId);
  f.host.tasks.onRunState(secondRun);
  f.host.tasks.onRunState({ ...secondRun, state: 'running', resultText: 'stale result' });
  f.host.engine.maybeResumeParent(second.parentRunId);
  assert.equal(f.run('two').state, 'waiting-children');
  assert.equal(count(f, 'Parent'), 2);
  a.release();
  const done = await f.state('two');
  for (const task of f.host.tasks.list()) {
    const run = f.host.engine.execution.getRun(task.runId);
    f.host.tasks.onRunState(run); f.host.tasks.onRunState({ ...run, state: 'queued' });
    f.host.engine.maybeResumeParent(done.runId);
  }
  await delay(40);
  assert.match(done.resultText, /RESULT-A-unique/); assert.match(done.resultText, /RESULT-B-unique/);
  assert.equal(count(f, 'Parent'), 3);
  assert.equal(new Set(done.consumedTaskIds).size, 2);
  const entries = f.host.roster.store(parent.id).readAll().filter((entry) => entry.contextOnly);
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 2);
  assert.ok(f.host.tasks.list().every((task) => task.state === 'completed'));
});

test('delegating to the same Bot yields its scheduler slot and completes without deadlock', options, async (t) => {
  const f = await fixture(t, parentScript(['Parent'])); const parent = f.bot('Parent');
  f.host.engine.admit({ agentId: parent.id, prompt: 'delegate to self', clientNonce: 'same-bot' });
  const done = await f.state('same-bot');
  assert.match(done.resultText, /CHILD RESULT Parent: actual result body/);
  assert.equal(f.host.tasks.list()[0].state, 'completed');
  assert.equal(f.host.tasks.list()[0].fromBotId, f.host.tasks.list()[0].toBotId);
  assert.equal(f.mock.requests.length, 4);
});

test('child approval wait is pending, never completed and never resumes its parent early', options, async (t) => {
  const base = parentScript(['Child']);
  const f = await fixture(t, (body) => body.model === 'Child'
    ? { calls: [tool('shell', { command: 'echo approval-only' }, 'approval-tool')] }
    : base(body));
  const parent = f.bot('Parent'); const child = f.bot('Child');
  f.host.engine.admit({ agentId: parent.id, prompt: 'approval child', clientNonce: 'approval-parent' });
  await f.state('approval-parent', 'waiting-children');
  const task = await until(() => f.host.tasks.list().find((item) => item.state === 'waiting'), 'waiting child task');
  const run = f.host.engine.execution.getRun(task.runId);
  assert.equal(run.state, 'awaiting-approval');
  assert.equal(task.resultText, undefined);
  assert.equal(f.host.tasks.hasPending(task.parentRunId), true);
  assert.equal(count(f, 'Parent'), 2);
  assert.equal(f.host.engine.hasPendingApproval(child.id), true);
  const card = f.host.roster.store(child.id).readAll().find((e) => e.message?.type === 'auto-review-approval');
  assert.ok(card);
  assert.equal(f.host.engine.visibleEntries(child.id).some((entry) => entry.id === card.id), true);
  f.host.engine.cancelRun(task.parentRunId, 'test cleanup');
  await until(() => f.host.tasks.get(task.id).state === 'cancelled', 'approval child cancelled');
});

test('parent cancellation propagates through descendants and waits for an unreturned child tool before settling it', options, async (t) => {
  const entered = gate(); const release = gate();
  const f = await fixture(t, (body) => {
    if (body.model === 'Leaf') return { calls: [tool('test_blocking_effect', {}, 'blocked-effect')] };
    if (body.messages.some((m) => m.role === 'tool')) return { text: 'Waiting.' };
    return { calls: [tool('delegate_task', { to: body.model === 'Root' ? 'Middle' : 'Leaf', objective: 'nested work' }, `nested-${body.model}`)] };
  });
  f.beforeClose(() => release.release());
  const parent = f.bot('Root'); f.bot('Middle'); f.bot('Leaf');
  const original = f.host.tools.execute.bind(f.host.tools);
  f.host.tools.execute = async (args) => {
    if (args.call.name !== 'test_blocking_effect') return original(args);
    entered.release();
    // Model a tool whose effect has started and which deliberately ignores abort
    // until its worker returns. Cancellation must not invent a terminal result.
    await release.promise;
    return { result: 'effect worker returned' };
  };
  f.host.engine.admit({ agentId: parent.id, prompt: 'nested cancellation', clientNonce: 'cancel-root' });
  await until(() => f.host.tasks.list().some((task) => task.depth === 2 && task.state === 'running'), 'running grandchild');
  await Promise.race([entered.promise, delay(2000).then(() => { throw new Error('blocking tool not entered'); })]);
  await f.state('cancel-root', 'waiting-children');
  const leaf = f.host.tasks.list().find((task) => task.depth === 2);
  assert.equal(f.host.engine.cancelRun(f.run('cancel-root').runId, 'parent stopped'), true);
  await until(() => f.host.engine.execution.getRun(leaf.runId).state === 'cancelling', 'leaf cancellation in progress');
  assert.equal(f.host.tasks.get(leaf.id).state, 'running');
  assert.equal(f.host.tasks.get(leaf.id).settledAtMs, undefined);
  assert.equal(f.host.engine.execution.getRun(leaf.runId).finishedAtMs, undefined);
  release.release();
  await until(() => f.host.tasks.list().every((task) => task.state === 'cancelled'), 'all descendants actually terminated');
  assert.equal(f.run('cancel-root').state, 'interrupted');
  assert.ok(f.host.tasks.list().every((task) => task.cancelReason === 'parent stopped'));
  assert.equal(count(f, 'Root'), 2);
  assert.equal(count(f, 'Leaf'), 1);
});

async function admissionFixture(t, limits) {
  const f = await fixture(t); const parent = f.bot('Parent'); const child = f.bot('Child');
  f.host.engine.schedule = () => {};
  const run = f.host.engine.admit({ agentId: parent.id, prompt: 'bounded task family', clientNonce: 'limits-parent' });
  if (limits) f.host.engine.tasks = f.host.tasks = new TaskDispatcher({ engine: f.host.engine, store: f.host.engine.execution, roster: f.host.roster, bus: f.host.bus, limits });
  return { f, parent, child, run, create: (callId, patch = {}) => f.host.tasks.create({ parent: run, callId, to: child.id, objective: 'work', ...patch }) };
}

test('maxActive rejects new live tasks but permits another after a real terminal transition', options, async (t) => {
  const { f, create } = await admissionFixture(t, { maxActive: 1 });
  const first = await create('first');
  await assert.rejects(create('second'), { code: 'task/max-active', limit: 1 });
  assert.equal(f.host.tasks.list().length, 1);
  const task = f.host.tasks.get(first.taskId);
  f.host.engine.saveRun({ ...f.host.engine.execution.getRun(task.runId), state: 'done', resultText: 'complete' });
  assert.equal((await create('second')).state, 'queued');
  assert.equal(f.host.tasks.list().length, 2);
});

test('maxTasks counts settled tasks across the whole root family', options, async (t) => {
  const { f, create } = await admissionFixture(t, { maxTasks: 1 });
  const first = await create('first'); const task = f.host.tasks.get(first.taskId);
  f.host.engine.saveRun({ ...f.host.engine.execution.getRun(task.runId), state: 'done', resultText: 'complete' });
  await assert.rejects(create('second'), { code: 'task/max-tasks', limit: 1 });
  assert.equal(f.host.tasks.list().length, 1);
});

test('maxDepth rejects descendants beyond the allowed task depth without admitting a run', options, async (t) => {
  const { f, child, create } = await admissionFixture(t, { maxDepth: 1 });
  const first = await create('first'); const task = f.host.tasks.get(first.taskId);
  const childRun = f.host.engine.execution.getRun(task.runId);
  const runs = f.host.engine.execution.listRuns().length;
  await assert.rejects(f.host.tasks.create({ parent: childRun, callId: 'grandchild', to: child.id, objective: 'deeper' }), { code: 'task/max-depth', limit: 1 });
  assert.equal(f.host.engine.execution.listRuns().length, runs);
  assert.equal(f.host.tasks.list().length, 1);
});

test('delegation replay uses the original call identity before limits, roster changes or input validation', options, async (t) => {
  const { f, child, create } = await admissionFixture(t, { maxTasks: 1 });
  const first = await create('first');
  f.host.roster.update(child.id, { harness: 'temporal' });
  const replay = await create('first', { to: 'does-not-exist', objective: null });
  assert.deepEqual(replay, first);
  assert.equal(f.host.tasks.list().length, 1);
  assert.equal(f.host.engine.execution.listRuns().length, 2);
});

for (const harness of ['temporal', 'box', 'remote-unknown']) test(`nonlocal delegate target ${harness} returns typed unavailable and never falls back`, options, async (t) => {
  const { f, child, create } = await admissionFixture(t);
  f.host.roster.update(child.id, { harness });
  let proxyCalls = 0;
  f.host.proxy.act = async () => { proxyCalls++; throw new Error('fallback must not run'); };
  await assert.rejects(create('nonlocal'), { code: 'task/agent-unavailable' });
  assert.equal(f.host.tasks.list().length, 0);
  assert.equal(f.host.engine.execution.listRuns().length, 1);
  assert.equal(proxyCalls, 0);
  assert.equal(f.mock.requests.length, 0);
});

test('child admission failure rolls back task, run, outbox and all scheduling callbacks together', options, async (t) => {
  const { f, create } = await admissionFixture(t);
  const store = f.host.engine.execution;
  const before = { runs: store.listRuns(), outbox: store.db.prepare('SELECT * FROM outbox ORDER BY seq').all() };
  const admit = f.host.engine.admit.bind(f.host.engine);
  let schedules = 0;
  f.host.engine.schedule = () => { schedules++; };
  f.host.engine.admit = (args) => { admit(args); throw new Error('crash after child admission before outer commit'); };
  await assert.rejects(create('rollback'), /before outer commit/);
  assert.deepEqual(store.listTasks(), []);
  assert.deepEqual(store.listRuns(), before.runs);
  assert.deepEqual(store.db.prepare('SELECT * FROM outbox ORDER BY seq').all(), before.outbox);
  assert.equal(schedules, 0);
  assert.equal(f.mock.requests.length, 0);
});

test('all approval/question waiting aliases keep child tasks pending', options, async (t) => {
  const { f, create } = await admissionFixture(t);
  const first = await create('wait'); const task = f.host.tasks.get(first.taskId);
  const run = f.host.engine.execution.getRun(task.runId);
  for (const state of ['awaiting-approval', 'waiting-approval', 'awaiting-answer', 'waiting-input', 'waiting-user', 'waiting_children', 'parked']) {
    f.host.tasks.onRunState({ ...run, state });
    assert.equal(f.host.tasks.get(task.id).state, 'waiting', state);
    assert.equal(f.host.tasks.hasPending(task.parentRunId), true, state);
    assert.equal(f.host.tasks.get(task.id).settledAtMs, undefined, state);
  }
});

for (const checkpoint of ['accepted', 'running', 'cancelling']) test(`fresh Host recovers delegated ${checkpoint} checkpoint and resumes its waiting parent`, options, async (t) => {
  const f = await fixture(t, (body) => ({ text: body.model === 'Child' ? 'RECOVERED CHILD BODY' : `RECOVERED PARENT ${body.messages.map((m) => m.content ?? '').join('\n')}` }));
  const parent = f.bot('Parent'); const child = f.bot('Child');
  f.host.engine.schedule = () => {};
  const parentRun = f.host.engine.admit({ agentId: parent.id, prompt: 'recovery parent', clientNonce: `parent-${checkpoint}` });
  const admitted = await f.host.tasks.create({ parent: parentRun, callId: `recover-${checkpoint}`, to: child.id, objective: 'recover child' });
  const task = f.host.tasks.get(admitted.taskId);
  const childRun = f.host.engine.execution.getRun(task.runId);
  f.host.engine.saveRun({ ...parentRun, state: 'waiting-children' });
  if (checkpoint !== 'accepted') f.host.engine.saveRun({ ...childRun, state: checkpoint, remainingCalls: [{ id: 'unconfirmed-effect', name: 'shell', args: { command: 'echo must-not-replay' } }] });
  await f.restart();
  f.host.engine.recover();
  const done = await f.state(`parent-${checkpoint}`);
  assert.deepEqual(done.consumedTaskIds, [task.id]);
  if (checkpoint === 'accepted') {
    assert.equal(f.host.tasks.get(task.id).state, 'completed');
    assert.match(done.resultText, /RECOVERED CHILD BODY/);
    assert.equal(count(f, 'Child'), 1);
  } else {
    assert.equal(f.host.tasks.get(task.id).state, 'needs-reconciliation');
    assert.equal(f.host.engine.execution.getRun(task.runId).state, 'needs-reconciliation');
    assert.match(done.resultText, /needs-reconciliation/);
    assert.match(done.resultText, /not replayed/);
    assert.equal(count(f, 'Child'), 0);
  }
  assert.equal(count(f, 'Parent'), 1);
  assert.equal(f.host.tasks.list().length, 1);
});
