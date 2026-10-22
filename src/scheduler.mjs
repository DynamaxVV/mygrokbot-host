// Run scheduler — one FIFO queue per agent, three priority lanes, watchdog escape.
//
// Rebuilt from the deployed host's run-scheduler.ts. The behaviours that actually
// define the interaction loop:
//
//   1. Lanes. user > agent > background. A human message never waits behind a
//      routine or a subagent, but it can wait behind another human message.
//   2. Per-agent serialization. One active turn per agent, full stop. This is why
//      two prompts to the same bot queue instead of interleaving.
//   3. group-member deprioritization. Within the user lane, a group-chat member
//      turn gives way to a direct message (takeNextUserTask).
//   4. Watchdog. If a user turn has waited `watchdogMs` behind an active run, the
//      active run is marked interrupted, and after `watchdogGraceMs` it is
//      *abandoned* (the queue moves on) rather than left wedged forever. The
//      abandoned run keeps its own settled promise as a "zombie" so a late finish
//      cannot resurrect it.
//
// Defaults from the real host: watchdog 120s, grace 30s.

export const RUN_WATCHDOG_DEFAULT_MS = 120_000;
export const RUN_WATCHDOG_GRACE_DEFAULT_MS = 30_000;

export const LANES = ['user', 'agent', 'background'];

function takeNextUserTask(pending) {
  if (!pending.length) return undefined;
  const preferred = pending.findIndex((item) => item.source !== 'group-member');
  return pending.splice(preferred === -1 ? 0 : preferred, 1)[0];
}

export class RunScheduler {
  constructor({ watchdogMs = RUN_WATCHDOG_DEFAULT_MS, watchdogGraceMs = RUN_WATCHDOG_GRACE_DEFAULT_MS, telemetry = {}, clock = null } = {}) {
    this.watchdogMs = watchdogMs;
    this.watchdogGraceMs = watchdogGraceMs;
    this.telemetry = telemetry;
    this.clock = clock ?? { now: () => Date.now(), schedule: (ms, fn) => setTimeout(fn, ms), cancel: (t) => clearTimeout(t) };
    this.queues = new Map();
    this.disposed = false;
  }

  enqueue(agentId, task, { lane = 'user', source = 'user', acceptedAtMs = undefined, ackToken = undefined, onCancelled = undefined } = {}) {
    if (this.disposed) {
      return Promise.resolve().then(() => onCancelled?.());
    }
    const queue = this.queueFor(agentId);
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const item = {
      lane,
      source,
      enqueuedAtMs: this.clock.now(),
      ...(acceptedAtMs != null ? { acceptedAtMs } : {}),
      ...(ackToken != null ? { ackToken } : {}),
      ...(onCancelled != null ? { onCancelled } : {}),
      task,
      resolve,
      reject,
      promise,
    };
    if (lane === 'user') queue.pendingUser.push(item);
    else if (lane === 'agent') queue.pendingAgent.push(item);
    else queue.pendingBackground.push(item);

    let pendingAhead = queue.pendingUser.length + queue.pendingAgent.length + queue.pendingBackground.length - 1;
    if (lane === 'user') pendingAhead = queue.pendingUser.length - 1;
    else if (lane === 'agent') pendingAhead = queue.pendingUser.length + queue.pendingAgent.length - 1;

    this.telemetry.onAccepted?.({
      agentId,
      lane,
      source,
      position: (queue.active != null ? 1 : 0) + pendingAhead,
      depthUser: queue.pendingUser.length,
      depthAgent: queue.pendingAgent.length,
      depthBackground: queue.pendingBackground.length,
      hasActive: queue.active != null,
    });

    this.armWatchdog(agentId, queue);
    void Promise.resolve().then(() => this.pump(agentId));
    return promise;
  }

  async drain(agentId) {
    const queue = this.queues.get(agentId);
    if (!queue) return;
    const snapshot = [
      ...(queue.active != null ? [queue.active.settled] : []),
      ...queue.zombies,
      ...queue.pendingUser.map((i) => i.promise),
      ...queue.pendingAgent.map((i) => i.promise),
      ...queue.pendingBackground.map((i) => i.promise),
    ];
    await Promise.allSettled(snapshot);
  }

  getDiagnostics() {
    const now = this.clock.now();
    const out = [];
    for (const [agentId, queue] of this.queues) {
      const depthUser = queue.pendingUser.length;
      const depthAgent = queue.pendingAgent.length;
      const depthBackground = queue.pendingBackground.length;
      const active = queue.active;
      if (depthUser === 0 && depthAgent === 0 && depthBackground === 0 && active == null) continue;
      const oldestUser = queue.pendingUser[0];
      out.push({
        agentId,
        depthUser,
        depthAgent,
        depthBackground,
        depthTotal: depthUser + depthAgent + depthBackground + (active != null ? 1 : 0),
        ...(oldestUser != null ? { oldestPendingUserAgeMs: now - oldestUser.enqueuedAtMs } : {}),
        ...(active != null
          ? { active: { lane: active.item.lane, source: active.item.source, runtimeMs: now - active.startedAtMs, phase: active.phase } }
          : {}),
      });
    }
    return out;
  }

  dispose() {
    this.disposed = true;
    for (const queue of this.queues.values()) {
      if (queue.watchdogTimer != null) this.clock.cancel(queue.watchdogTimer);
      if (queue.graceTimer != null) this.clock.cancel(queue.graceTimer);
      queue.watchdogTimer = undefined;
      queue.graceTimer = undefined;
      for (const item of [...queue.pendingUser.splice(0), ...queue.pendingAgent.splice(0), ...queue.pendingBackground.splice(0)]) {
        void Promise.resolve().then(item.onCancelled).then(item.resolve, item.reject);
      }
    }
  }

  queueFor(agentId) {
    const existing = this.queues.get(agentId);
    if (existing) return existing;
    const created = {
      pendingUser: [],
      pendingAgent: [],
      pendingBackground: [],
      active: null,
      generationCounter: 0,
      zombies: new Set(),
    };
    this.queues.set(agentId, created);
    return created;
  }

  pump(agentId) {
    if (this.disposed) return;
    const queue = this.queues.get(agentId);
    if (!queue || queue.active != null) return;
    let next;
    if (queue.pendingUser.length > 0) next = takeNextUserTask(queue.pendingUser);
    else if (queue.pendingAgent.length > 0) next = queue.pendingAgent.shift();
    else next = queue.pendingBackground.shift();
    if (next == null) {
      this.disarmWatchdog(queue);
      return;
    }
    const generation = ++queue.generationCounter;
    let markSettled;
    const settled = new Promise((res) => {
      markSettled = res;
    });
    const active = { item: next, startedAtMs: this.clock.now(), generation, settled, markSettled, phase: 'running' };
    queue.active = active;

    const jumpedBackground = next.lane === 'background' ? 0 : queue.pendingBackground.length;
    this.telemetry.onDequeued?.({
      agentId,
      lane: next.lane,
      source: next.source,
      queueWaitMs: active.startedAtMs - next.enqueuedAtMs,
      ...(next.acceptedAtMs != null ? { acceptedToRunMs: active.startedAtMs - next.acceptedAtMs } : {}),
      jumpedBackground,
      depthUser: queue.pendingUser.length,
      depthAgent: queue.pendingAgent.length,
      depthBackground: queue.pendingBackground.length,
    });

    this.disarmWatchdog(queue);
    this.armWatchdog(agentId, queue);

    let taskPromise;
    try {
      taskPromise = next.task();
    } catch (error) {
      taskPromise = Promise.reject(error);
    }
    void taskPromise.then(
      () => {
        this.onTaskSettled(agentId, queue, active, undefined);
        markSettled();
      },
      (error) => {
        this.onTaskSettled(agentId, queue, active, { error });
        markSettled();
      },
    );
  }

  // Release the lane when the task demonstrably will not settle on its own (an aborted
  // turn parked on an await that ignores the signal). Without this the queue stays
  // blocked and every later send sits in "running" with no turn.
  forceRelease(agentId, reason = 'forced release') {
    const queue = this.queues.get(agentId);
    const active = queue?.active;
    if (!active) return false;
    queue.active = null;
    this.disarmWatchdog(queue);
    try { active.item.reject(new Error(reason)); } catch { /* already settled */ }
    active.markSettled?.();
    this.telemetry.onWatchdog?.({ agentId, stage: 'forced_release', reason });
    this.pump(agentId);
    return true;
  }

  onTaskSettled(agentId, queue, active, failure) {
    if (failure === undefined) active.item.resolve();
    else active.item.reject(failure.error);

    if (queue.active?.generation !== active.generation) {
      this.telemetry.onWatchdog?.({
        agentId,
        stage: 'late_settle',
        activeLane: active.item.lane,
        activeSource: active.item.source,
        activeRuntimeMs: this.clock.now() - active.startedAtMs,
      });
      return;
    }
    queue.active = null;
    this.disarmWatchdog(queue);
    this.pump(agentId);
  }

  waitedBehindActiveMs(queue) {
    const head = queue.pendingUser[0];
    const active = queue.active;
    if (head == null || active == null) return null;
    return this.clock.now() - Math.max(head.enqueuedAtMs, active.startedAtMs);
  }

  armWatchdog(agentId, queue) {
    if (this.disposed) return;
    if (queue.watchdogTimer != null || queue.graceTimer != null) return;
    const waitedMs = this.waitedBehindActiveMs(queue);
    if (waitedMs == null) return;
    const remaining = Math.max(0, this.watchdogMs - waitedMs);
    queue.watchdogTimer = this.clock.schedule(remaining, () => {
      queue.watchdogTimer = undefined;
      this.onWatchdogFired(agentId, queue);
    });
  }

  disarmWatchdog(queue) {
    if (queue.watchdogTimer != null) this.clock.cancel(queue.watchdogTimer);
    queue.watchdogTimer = undefined;
    if (queue.graceTimer != null) this.clock.cancel(queue.graceTimer);
    queue.graceTimer = undefined;
  }

  onWatchdogFired(agentId, queue) {
    if (this.disposed) return;
    const active = queue.active;
    const head = queue.pendingUser[0];
    if (active == null || head == null) return;
    const waited = this.waitedBehindActiveMs(queue);
    if (waited == null) return;
    if (waited < this.watchdogMs) {
      this.armWatchdog(agentId, queue);
      return;
    }
    const waitingUserAgeMs = this.clock.now() - head.enqueuedAtMs;
    active.phase = 'interrupted';
    this.telemetry.onWatchdog?.({
      agentId,
      stage: 'trip',
      activeLane: active.item.lane,
      activeSource: active.item.source,
      activeRuntimeMs: this.clock.now() - active.startedAtMs,
      waitingUserAgeMs,
    });
    queue.graceTimer = this.clock.schedule(this.watchdogGraceMs, () => {
      queue.graceTimer = undefined;
      this.escapeWedgedRun(agentId, queue, active);
    });
  }

  // Give up on the wedged run and let the queue move. The abandoned run is tracked
  // as a zombie so a late settle is reported but changes nothing.
  escapeWedgedRun(agentId, queue, active) {
    if (this.disposed) return;
    if (queue.active?.generation !== active.generation) return;
    const waitingHead = queue.pendingUser[0];
    this.telemetry.onWatchdog?.({
      agentId,
      stage: 'escape',
      activeLane: active.item.lane,
      activeSource: active.item.source,
      activeRuntimeMs: this.clock.now() - active.startedAtMs,
      ...(waitingHead != null ? { waitingUserAgeMs: this.clock.now() - waitingHead.enqueuedAtMs } : {}),
      ...(active.item.ackToken != null ? { ackToken: active.item.ackToken } : {}),
    });
    active.item.resolve();
    queue.zombies.add(active.settled);
    void active.settled.then(() => queue.zombies.delete(active.settled));
    queue.active = null;
    this.pump(agentId);
  }
}
