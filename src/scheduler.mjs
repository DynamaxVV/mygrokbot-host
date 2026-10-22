// Per-agent priority lanes. Cancellation never releases an executing task's lane.
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

  // Observability must never break the serialization or completion paths.
  emit(name, event) {
    try { Promise.resolve(this.telemetry[name]?.(event)).catch(() => {}); } catch { /* telemetry only */ }
  }

  enqueue(agentId, task, { lane = 'user', source = 'user', acceptedAtMs, ackToken, runId, abort, onCancelled } = {}) {
    const queue = this.queueFor(agentId);
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const item = { lane, source, acceptedAtMs, ackToken, runId, abort, onCancelled, task, resolve, reject, promise, enqueuedAtMs: this.clock.now() };
    if (this.disposed) {
      this.cancelPending(queue, item, 'scheduler disposed');
      return promise;
    }
    if (lane === 'user') queue.pendingUser.push(item);
    else if (lane === 'agent') queue.pendingAgent.push(item);
    else queue.pendingBackground.push(item);
    let pendingAhead = queue.pendingUser.length + queue.pendingAgent.length + queue.pendingBackground.length - 1;
    if (lane === 'user') pendingAhead = queue.pendingUser.length - 1;
    else if (lane === 'agent') pendingAhead = queue.pendingUser.length + queue.pendingAgent.length - 1;
    this.emit('onAccepted', { agentId, lane, source, runId, ackToken, position: (queue.active ? 1 : 0) + pendingAhead,
      depthUser: queue.pendingUser.length, depthAgent: queue.pendingAgent.length, depthBackground: queue.pendingBackground.length, hasActive: queue.active != null });
    this.armWatchdog(agentId, queue);
    void Promise.resolve().then(() => this.pump(agentId));
    return promise;
  }

  async drain(agentId) {
    // Re-snapshot after every completion: tasks and cancellation hooks can enqueue.
    for (;;) {
      const queues = agentId == null ? [...this.queues.values()] : [this.queues.get(agentId)].filter(Boolean);
      const pending = queues.flatMap((queue) => [
        ...(queue.active ? [queue.active.settled] : []), ...queue.cancelling,
        ...queue.pendingUser.map((i) => i.promise), ...queue.pendingAgent.map((i) => i.promise), ...queue.pendingBackground.map((i) => i.promise),
      ]);
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  getDiagnostics() {
    const now = this.clock.now();
    const out = [];
    for (const [agentId, queue] of this.queues) {
      const depthUser = queue.pendingUser.length, depthAgent = queue.pendingAgent.length, depthBackground = queue.pendingBackground.length;
      const active = queue.active;
      if (!depthUser && !depthAgent && !depthBackground && !active) continue;
      out.push({ agentId, depthUser, depthAgent, depthBackground, depthTotal: depthUser + depthAgent + depthBackground + (active ? 1 : 0),
        ...(queue.pendingUser[0] ? { oldestPendingUserAgeMs: now - queue.pendingUser[0].enqueuedAtMs } : {}),
        ...(active ? { active: { lane: active.item.lane, source: active.item.source, runId: active.item.runId, ackToken: active.item.ackToken, runtimeMs: now - active.startedAtMs, phase: active.phase } } : {}) });
    }
    return out;
  }

  cancelPending(queue, item, reason) {
    queue.cancelling.add(item.promise);
    void Promise.resolve().then(() => item.onCancelled?.(reason, item)).then(item.resolve, item.reject)
      .finally(() => queue.cancelling.delete(item.promise));
  }

  requestAbort(active, reason) {
    if (active.cancelRequested) return;
    active.cancelRequested = true;
    active.phase = 'interrupted';
    try {
      Promise.resolve(active.item.abort?.(reason)).catch((error) => { active.abortError = error; });
    } catch (error) { active.abortError = error; }
  }

  cancel(agentId, predicate = () => true, reason = 'cancelled') {
    const queue = this.queues.get(agentId);
    if (!queue) return 0;
    // Evaluate before mutation so a throwing predicate cannot lose queued tasks.
    const matches = new Set([...queue.pendingUser, ...queue.pendingAgent, ...queue.pendingBackground,
      ...(queue.active ? [queue.active.item] : [])].filter(predicate));
    for (const lane of ['pendingUser', 'pendingAgent', 'pendingBackground']) {
      const removed = queue[lane].filter((item) => matches.has(item));
      queue[lane] = queue[lane].filter((item) => !matches.has(item));
      for (const item of removed) this.cancelPending(queue, item, reason);
    }
    if (queue.active && matches.has(queue.active.item)) this.requestAbort(queue.active, reason);
    if (!queue.pendingUser.length) this.disarmWatchdog(queue);
    return matches.size;
  }

  dispose(reason = 'scheduler disposed') {
    this.disposed = true;
    for (const [agentId, queue] of this.queues) {
      this.disarmWatchdog(queue);
      this.cancel(agentId, () => true, reason);
    }
  }

  async shutdown(reason = 'scheduler shutdown') {
    this.dispose(reason);
    await this.drain();
  }

  queueFor(agentId) {
    if (!this.queues.has(agentId)) this.queues.set(agentId, {
      pendingUser: [], pendingAgent: [], pendingBackground: [], active: null, generationCounter: 0, cancelling: new Set(),
    });
    return this.queues.get(agentId);
  }

  pump(agentId) {
    if (this.disposed) return;
    const queue = this.queues.get(agentId);
    if (!queue || queue.active) return;
    const next = queue.pendingUser.length ? takeNextUserTask(queue.pendingUser)
      : queue.pendingAgent.length ? queue.pendingAgent.shift() : queue.pendingBackground.shift();
    if (!next) { this.disarmWatchdog(queue); return; }
    let markSettled;
    const settled = new Promise((res) => { markSettled = res; });
    const active = { item: next, startedAtMs: this.clock.now(), generation: ++queue.generationCounter, settled, phase: 'running' };
    queue.active = active;
    this.emit('onDequeued', { agentId, lane: next.lane, source: next.source, runId: next.runId, ackToken: next.ackToken,
      queueWaitMs: active.startedAtMs - next.enqueuedAtMs,
      ...(next.acceptedAtMs != null ? { acceptedToRunMs: active.startedAtMs - next.acceptedAtMs } : {}),
      jumpedBackground: next.lane === 'background' ? 0 : queue.pendingBackground.length,
      depthUser: queue.pendingUser.length, depthAgent: queue.pendingAgent.length, depthBackground: queue.pendingBackground.length });
    this.disarmWatchdog(queue);
    this.armWatchdog(agentId, queue);
    void Promise.resolve().then(() => next.task()).then(
      () => this.onTaskSettled(agentId, queue, active),
      (error) => this.onTaskSettled(agentId, queue, active, { error }),
    ).finally(markSettled);
  }

  forceRelease(agentId, reason = 'forced release') {
    const active = this.queues.get(agentId)?.active;
    if (!active) return false;
    this.requestAbort(active, reason);
    this.emit('onWatchdog', { agentId, stage: 'cancel_requested', reason, runId: active.item.runId, ackToken: active.item.ackToken });
    return true;
  }

  onTaskSettled(agentId, queue, active, failure) {
    if (failure) active.item.reject(failure.error);
    else active.item.resolve();
    if (queue.active !== active) return;
    queue.active = null;
    this.disarmWatchdog(queue);
    this.pump(agentId);
  }

  waitedBehindActiveMs(queue) {
    const head = queue.pendingUser[0], active = queue.active;
    return !head || !active ? null : this.clock.now() - Math.max(head.enqueuedAtMs, active.startedAtMs);
  }

  armWatchdog(agentId, queue) {
    if (this.disposed || queue.watchdogTimer != null || queue.graceTimer != null || queue.active?.phase !== 'running') return;
    const waited = this.waitedBehindActiveMs(queue);
    if (waited == null) return;
    queue.watchdogTimer = this.clock.schedule(Math.max(0, this.watchdogMs - waited), () => {
      queue.watchdogTimer = undefined;
      this.onWatchdogFired(agentId, queue);
    });
  }

  disarmWatchdog(queue) {
    if (queue.watchdogTimer != null) this.clock.cancel(queue.watchdogTimer);
    if (queue.graceTimer != null) this.clock.cancel(queue.graceTimer);
    queue.watchdogTimer = queue.graceTimer = undefined;
  }

  onWatchdogFired(agentId, queue) {
    if (this.disposed) return;
    const active = queue.active, head = queue.pendingUser[0];
    const waited = this.waitedBehindActiveMs(queue);
    if (!active || !head || waited == null) return;
    if (waited < this.watchdogMs) { this.armWatchdog(agentId, queue); return; }
    this.requestAbort(active, 'watchdog timeout');
    this.emit('onWatchdog', { agentId, stage: 'trip', activeLane: active.item.lane, activeSource: active.item.source,
      runId: active.item.runId, ackToken: active.item.ackToken, activeRuntimeMs: this.clock.now() - active.startedAtMs, waitingUserAgeMs: this.clock.now() - head.enqueuedAtMs });
    queue.graceTimer = this.clock.schedule(this.watchdogGraceMs, () => {
      queue.graceTimer = undefined;
      this.escapeWedgedRun(agentId, queue, active);
    });
  }

  escapeWedgedRun(agentId, queue, active) {
    if (this.disposed || queue.active !== active) return;
    active.phase = 'stuck';
    this.emit('onWatchdog', { agentId, stage: 'stuck', activeLane: active.item.lane, activeSource: active.item.source,
      runId: active.item.runId, ackToken: active.item.ackToken, activeRuntimeMs: this.clock.now() - active.startedAtMs,
      ...(queue.pendingUser[0] ? { waitingUserAgeMs: this.clock.now() - queue.pendingUser[0].enqueuedAtMs } : {}) });
  }
}
