// Bounded, durable child delegation. Admission is local-only and synchronous;
// the engine owns execution scheduling and post-crash recovery.
import { createHash } from 'node:crypto';

export const DEFAULT_TASK_LIMITS = Object.freeze({ maxActive: 4, maxDepth: 2, maxTasks: 12 });
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs-reconciliation']);
const RUN_STATES = new Map([
  ['queued', 'queued'], ['accepted', 'queued'], ['running', 'running'],
  ['waiting', 'waiting'], ['waiting-children', 'waiting'],
  ['waiting-approval', 'waiting'], ['awaiting-approval', 'waiting'],
  ['waiting-answer', 'waiting'], ['awaiting-answer', 'waiting'],
  ['waiting-input', 'waiting'], ['waiting-user', 'waiting'],
  ['waiting_approval', 'waiting'], ['waiting_answer', 'waiting'],
  ['waiting_children', 'waiting'], ['parked', 'waiting'],
  ['done', 'completed'], ['error', 'failed'], ['interrupted', 'cancelled'],
  ['reconciliation', 'needs-reconciliation'], ['needs-reconciliation', 'needs-reconciliation'],
  ['needs_reconciliation', 'needs-reconciliation'],
]);

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw failure('task/invalid-input', `${label} must be a nonempty string`);
  return value;
}
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function brief(task) {
  return { taskId: task.id, agentId: task.toBotId, state: task.state, depth: task.depth };
}
function synchronous(value, operation) {
  if (value && typeof value.then === 'function') {
    throw failure('task/async-transaction-hook', `${operation} must be synchronous`);
  }
  return value;
}

export class TaskDispatcher {
  constructor({ engine, store, bus, roster, limits = {} }) {
    if (!engine || !store || !roster) throw new TypeError('TaskDispatcher requires engine, store and roster');
    this.engine = engine;
    this.store = store;
    this.bus = bus;
    this.roster = roster;
    this.limits = Object.freeze({ ...DEFAULT_TASK_LIMITS, ...limits });
    for (const name of Object.keys(DEFAULT_TASK_LIMITS)) {
      if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < 0) {
        throw new TypeError(`${name} must be a nonnegative safe integer`);
      }
    }
  }

  async create({ parent, callId, to, objective, expectedOutput = '' }) {
    if (!parent || typeof parent !== 'object') throw failure('task/invalid-parent', 'A live parent acceptance is required');
    const parentRunId = text(parent.runId, 'parent.runId');
    text(callId, 'callId');
    // Tuple encoding prevents separator collisions in client-generated IDs.
    const id = `task:${createHash('sha256').update(JSON.stringify([parentRunId, callId])).digest('hex')}`;
    return this.store.transaction(() => {
      // Replay precedes destination/input validation and limit checks. A retry
      // always returns the original durable task, even after roster changes.
      const existing = this.store.getTask(id);
      if (existing) return brief(existing);
      text(parent.agentId, 'parent.agentId');
      text(parent.conversationId, 'parent.conversationId');
      text(to, 'to'); text(objective, 'objective');
      if (typeof expectedOutput !== 'string') throw failure('task/invalid-input', 'expectedOutput must be a string');
      let target;
      try { target = this.roster.resolve(to); }
      catch (error) { throw failure('task/agent-not-found', error.message, { to }); }
      const profile = this.roster.profile(target);
      if (!profile) throw failure('task/agent-not-found', `Unknown agent: ${to}`);
      if (profile.isGroup === true) throw failure('task/group-target', 'Delegation requires an individual agent');
      const route = this.engine.route(target);
      if (!route?.runnable || route.lane !== 'local' || !['local', null, undefined].includes(profile.harness)) {
        throw failure('task/agent-unavailable', route?.reason || 'Delegation requires a runnable local agent', { route });
      }
      const ancestor = parent.taskId ? this.store.getTask(parent.taskId) : null;
      if (parent.taskId && !ancestor) throw failure('task/parent-not-found', 'Parent task does not exist');
      if (ancestor && (ancestor.runId !== parentRunId || ancestor.toBotId !== parent.agentId)) {
        throw failure('task/invalid-parent', 'Parent acceptance does not belong to its task');
      }
      if (ancestor && TERMINAL.has(ancestor.state)) throw failure('task/parent-settled', 'Parent task is already settled');
      const rootId = ancestor?.rootId ?? parentRunId;
      const depth = ancestor ? ancestor.depth + 1 : 1;
      if (!Number.isSafeInteger(depth) || depth > this.limits.maxDepth) {
        throw failure('task/max-depth', 'Delegation depth limit reached', { limit: this.limits.maxDepth });
      }
      const family = this.store.listTasks().filter((task) => task.rootId === rootId);
      if (family.length >= this.limits.maxTasks) throw failure('task/max-tasks', 'Root task count limit reached', { limit: this.limits.maxTasks });
      if (family.filter((task) => !TERMINAL.has(task.state)).length >= this.limits.maxActive) {
        throw failure('task/max-active', 'Root active task limit reached', { limit: this.limits.maxActive });
      }
      const now = Date.now();
      const task = {
        id, callId, parentTaskId: ancestor?.id ?? null, parentRunId, rootId,
        fromBotId: parent.agentId, toBotId: target,
        returnConversationId: parent.conversationId,
        objective, expectedOutput, depth, state: 'queued', runId: null,
        createdAtMs: now, updatedAtMs: now,
      };
      this.store.saveTask(task);
      const prompt = [
        `Delegated task from ${parent.agentId}.`,
        `Task ID: ${id}`, `Objective:\n${objective}`,
        expectedOutput ? `Expected output:\n${expectedOutput}` : '',
        'Return the result in your final response. The host delivers it to the parent task.',
      ].filter(Boolean).join('\n\n');
      // This MUST use the same ExecutionStore transaction for run and outbox.
      // admit schedules local work; do not dispatch again here.
      const admission = synchronous(this.engine.admit({
        agentId: target, prompt, clientNonce: `delegate:${id}`,
        conversationId: `task:${id}`, taskId: id,
        lane: 'agent', source: 'agent', trigger: 'delegate', hidden: true,
      }), 'engine.admit');
      if (!admission || admission.conflict || admission.status === 'rejected') {
        throw failure(admission?.code || 'task/admission-rejected', 'Child run admission was rejected');
      }
      task.runId = text(admission.runId, 'admission.runId');
      // admit may synchronously notify onRunState; retain that transition.
      const current = this.store.getTask(id);
      this.store.saveTask({ ...task, ...current, runId: task.runId, updatedAtMs: Date.now() });
      const run = this.store.getRun(task.runId);
      if (run) this.onRunState(run);
      return brief(this.store.getTask(id));
    });
  }

  onRunState(run) {
    if (!run || typeof run !== 'object' || typeof run.runId !== 'string') return null;
    return this.store.transaction(() => {
      const task = run.taskId ? this.store.getTask(run.taskId) : this.store.listTasks().find((item) => item.runId === run.runId);
      if (!task || TERMINAL.has(task.state)) return task ?? null;
      if (task.runId && task.runId !== run.runId) throw failure('task/run-mismatch', 'Task is bound to a different run');
      const state = RUN_STATES.get(run.state);
      const now = Date.now();
      // Unknown states preserve the task state; binding alone is still durable.
      const next = { ...task, runId: run.runId, ...(state ? { state } : {}), updatedAtMs: now };
      if (state && TERMINAL.has(state)) {
        next.settledAtMs = now;
        for (const field of ['error', 'result', 'output', 'resultText', 'resultEntryId', 'usage', 'finishedAtMs', 'cancelReason']) {
          if (run[field] !== undefined) next[field] = copy(run[field]);
        }
        // Completion delivery belongs to the engine's durable outbox handler.
        // If it fails, the state transition rolls back and can be retried.
        if (typeof this.engine.onChildTaskSettled !== 'function') {
          throw failure('task/settlement-unavailable', 'engine.onChildTaskSettled must be installed before task settlement');
        }
        this.store.saveTask(next);
        synchronous(this.engine.onChildTaskSettled(copy(next)), 'engine.onChildTaskSettled');
      } else this.store.saveTask(next);
      return next;
    });
  }

  childrenForRun(parentRunId) {
    text(parentRunId, 'parentRunId');
    return this.store.listTasks().filter((task) => task.parentRunId === parentRunId);
  }
  hasPending(parentRunId) {
    return this.childrenForRun(parentRunId).some((task) => !TERMINAL.has(task.state));
  }

  // Request cancellation descendants-first. A successful request is not proof
  // of termination: only persisted terminal run state may settle the task.
  // Return the cancellation promise so callers can await and handle failures.
  async cancelChildren(parentRunId, reason = 'parent cancelled') {
    text(parentRunId, 'parentRunId');
    const visited = new Set();
    const requested = [];
    const visit = async (runId) => {
      if (visited.has(runId)) return;
      visited.add(runId);
      for (const snapshot of this.childrenForRun(runId)) {
        if (snapshot.runId) await visit(snapshot.runId);
        const task = this.store.getTask(snapshot.id);
        if (!task || TERMINAL.has(task.state)) continue;
        if (!task.runId) throw failure('task/missing-run', 'Pending child task has no run recovery point', { taskId: task.id });
        if (typeof this.engine.cancelRun !== 'function') throw failure('task/cancellation-unavailable', 'engine.cancelRun is unavailable');
        const result = await this.engine.cancelRun(task.runId, reason, { cascade: false });
        const run = this.store.getRun(task.runId);
        if (run && TERMINAL.has(RUN_STATES.get(run.state))) this.onRunState(run);
        if (result === false || result?.cancelled === false) continue;
        // The returned task may remain queued/running/waiting while cancellation
        // is in progress. onRunState will settle it after actual termination.
        requested.push(this.store.getTask(task.id));
      }
    };
    await visit(parentRunId);
    return requested;
  }
  get(id) { return this.store.getTask(text(id, 'taskId')); }
  list() { return this.store.listTasks(); }
}
