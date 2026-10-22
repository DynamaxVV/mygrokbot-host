// Rooms own durable dispatch plans and presentation, never member execution state.
import { randomUUID, createHash } from 'node:crypto';
import { userMessageEntry } from './entries.mjs';
import { groupConversation, TERMINAL_RUN_STATES, WAITING_RUN_STATES } from './conversation.mjs';

export const OUTCOMES = ['delivered', 'pass', 'skipped', 'timeout', 'cancelled', 'error'];
export const SHOWN_OUTCOMES = new Set(['delivered', 'pass']);
export function isPass(text) {
  const t = String(text ?? '').trim();
  return !t || /^[\s"'`*_]*pass[\s"'`*_.!]*$/i.test(t);
}
const copy = (value) => JSON.parse(JSON.stringify(value));
const fail = (code, message = code) => Object.assign(new Error(message), { code, status: 409 });
const resultKey = (room, member, nonce) => JSON.stringify([room, member, nonce]);
const settled = (target) => TERMINAL_RUN_STATES.has(target.state) || target.state === 'skipped';

export class RoomTurns {
  constructor({ roster, engine, bus, proxy = null, log = () => {}, defaultDeadlineMs = 180_000 }) {
    Object.assign(this, { roster, engine, bus, proxy, log, defaultDeadlineMs });
    this.execution = engine.execution;
    this.turns = new Map();
    this.seen = new Map(); // bounded presentation cache; durable runs remain authoritative
    this.history = [];
    this.parents = new Map(); // member nonce -> group admission nonce
    this.dispatching = new Map();
    this.rounds = new Map();
    this.observers = new Map();
    this.cancelling = new Map();
    this.closed = false;
    this.closePromise = null;
    this.recovering = null;
  }
  assertOpen() { if (this.closed || this.engine._closing) throw fail('host/closing'); }
  roomId(id) {
    const room = this.roster.resolve(id);
    if (!this.roster.profile(room)?.isGroup) throw fail('room/not-group');
    return room;
  }
  isProxied(memberId) { return this.roster.profile(memberId)?.harness === 'temporal' || Boolean((this.proxy ?? this.engine.proxy)?.isProxiedAgent(memberId)); }
  validMember(memberId) { return this.roster.exists(memberId) && !this.roster.profile(memberId)?.isGroup; }
  admission(nonce) { return this.execution.getAdmission('group', nonce); }
  remember(record) {
    for (const target of record.targets ?? []) this.parents.set(target.clientNonce, record.clientNonce);
    return record;
  }
  selectedMembers(room, text, onlyMemberIds) {
    const members = [...new Set(this.roster.groupMembers(room))];
    if (onlyMemberIds != null) {
      const selected = new Set();
      for (const id of Array.isArray(onlyMemberIds) ? onlyMemberIds : []) {
        try { selected.add(this.roster.resolve(id)); } catch { /* invalid selections never broaden fanout */ }
      }
      return { members: members.filter((id) => selected.has(id)), mentioned: true };
    }
    const peers = members.map((id) => ({ id, name: this.roster.profile(id)?.name ?? id })).sort((a, b) => b.name.length - a.name.length);
    const pattern = peers.map((p) => p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const selected = new Set();
    if (pattern) {
      const re = new RegExp(`@(${pattern})`, 'g');
      const body = String(text);
      for (const match of body.matchAll(re)) {
        const next = body[match.index + match[0].length];
        if (next && !/[\s,，.!?。！？:：]/.test(next)) continue;
        const peer = peers.find((p) => p.name === match[1]);
        if (peer) selected.add(peer.id);
      }
    }
    return { members: selected.size ? members.filter((id) => selected.has(id)) : members, mentioned: selected.size > 0 };
  }
  async post({ groupId, text, clientNonce = null, onlyMemberIds = null, attachmentPaths = [], replyTo = null, strategy = 'fanout' }) {
    this.assertOpen();
    const room = this.roomId(groupId);
    const nonce = clientNonce ?? randomUUID();
    const body = String(text ?? '');
    if (!['fanout', 'round_robin', 'coordinated'].includes(strategy)) throw fail('room/unknown-strategy');
    const input = { groupId: room, target: room, text: body, mentions: onlyMemberIds, attachmentPaths, replyTo, strategy };
    const selection = this.selectedMembers(room, body, onlyMemberIds);
    if (strategy === 'coordinated' && !selection.mentioned && selection.members.length) {
      const main = this.engine.hostSettings?.()?.mainAgentId;
      selection.members = [selection.members.includes(main) ? main : selection.members[0]];
    }
    const entry = { ...userMessageEntry({ text: body, clientNonce: nonce, attachmentPaths, replyTo }),
      schemaVersion: 2, conversationId: groupConversation(room), hidden: false,
      speaker: { kind: 'human', id: 'operator', name: 'operator' } };
    const admitted = this.admitGroup({ room, nonce, input, entry, members: selection.members,
      source: selection.mentioned ? 'group-mention' : 'group-member', strategy });
    const record = this.remember(admitted.record);
    if (strategy === 'round_robin') {
      if (!admitted.replayed) this.startRound(record).catch((error) => this.log('room.round.error', { room, nonce, error: error.message }));
    } else await this.dispatchPlan(record.clientNonce);
    return this.receipt(this.closed ? record : this.admission(nonce) ?? record, admitted.replayed);
  }
  receipt(record, replayed = false) {
    return { accepted: true, agentId: record.groupId, groupId: record.groupId, conversationId: record.conversationId,
      clientNonce: record.clientNonce, entryId: record.entryId, acceptedAtMs: record.acceptedAtMs,
      members: record.members, state: record.state, strategy: record.strategy, ...(replayed ? { replayed: true } : {}) };
  }
  admitGroup({ room, nonce, input, entry = null, members, source = 'group-member', strategy, roundOptions = null }) {
    this.assertOpen();
    const conversationId = groupConversation(room);
    const group = this.roster.profile(room) ?? {};
    const peers = members.map((id) => ({ id, name: this.roster.profile(id)?.name ?? id, description: this.roster.profile(id)?.description ?? '' }));
    const targets = members.map((memberId) => {
      const contextPrompt = strategy === 'round_robin';
      const prompt = contextPrompt
        ? this.buildRoomPrompt({ group, memberId, peers, newMessages: roundOptions?.newMessages ?? [], isWindingDown: roundOptions?.isWindingDown ?? false })
        : input.text;
      return { memberId, clientNonce: `group:${nonce}:${memberId}`, proxied: this.isProxied(memberId), confirmed: false,
        state: this.validMember(memberId) ? 'planned' : 'skipped',
        args: { agentId: memberId, prompt, clientNonce: `group:${nonce}:${memberId}`,
          conversationId, sourceMessageId: contextPrompt ? null : entry?.id ?? null,
          hidden: true, lane: 'user', source, trigger: 'group', attachmentPaths: input.attachmentPaths ?? [],
          replyTo: input.replyTo ?? null, contextPrompt, inputThroughSeq: null } };
    });
    const record = { groupId: room, conversationId, clientNonce: nonce, entryId: entry?.id ?? null,
      acceptedAtMs: Date.now(), members, targets, strategy, source, input: copy(input),
      roundId: strategy === 'round_robin' ? randomUUID() : null, roundOptions, state: targets.length ? 'accepted' : 'done' };
    return this.execution.transaction(() => {
      const admitted = this.execution.admit({ scope: 'group', nonce, input, record });
      if (admitted.conflict) throw fail(admitted.code);
      if (admitted.replayed) return admitted;
      this.remember(record);
      if (entry) this.engine.queueEntry(room, entry);
      this.execution.afterCommit(() => this.prepareSource(nonce));
      if (strategy !== 'round_robin') {
        for (const target of targets) {
          if (target.proxied || settled(target)) continue;
          const route = this.engine.route?.(target.memberId);
          if (route?.runnable === false) {
            this.updateTarget(nonce, target.clientNonce, { state: 'error', error: route.reason ?? 'member unavailable' });
            continue;
          }
          const acceptance = this.engine.admit(target.args);
          this.updateTarget(nonce, target.clientNonce, this.acceptedPatch(acceptance));
        }
      }
      this.updateTarget(nonce, null, {});
      admitted.record = this.admission(nonce);
      return admitted;
    });
  }
  prepareSource(nonce) {
    this.engine.flushDeliveries();
    const record = this.admission(nonce);
    if (!record || !record.entryId) return record;
    const source = this.roster.store(record.groupId).getEntry(record.entryId);
    if (!source) return record;
    const targets = record.targets.map((target) => ({ ...target,
      args: { ...target.args, inputThroughSeq: record.strategy === 'round_robin' ? target.args.inputThroughSeq : source.seq } }));
    return this.execution.updateAdmission('group', nonce, { inputThroughSeq: source.seq, targets });
  }
  acceptedPatch(acceptance) {
    const result = { ...(acceptance?.record ?? {}), ...(acceptance ?? {}) };
    if (!result.runId) throw fail('room/missing-run-id', 'Member admission has no durable runId');
    return { confirmed: true, runId: result.runId, entryId: result.entryId ?? null, state: result.state ?? 'accepted',
      ...(result.resultText != null ? { resultText: result.resultText } : {}),
      ...(result.resultEntryId != null ? { resultEntryId: result.resultEntryId } : {}),
      ...(result.finishedAtMs != null ? { finishedAtMs: result.finishedAtMs } : {}),
      ...(result.turnId ? { turnId: result.turnId } : {}) };
  }
  updateTarget(nonce, memberNonce, patch) {
    return this.execution.transaction(() => {
      const record = this.admission(nonce);
      if (!record) return null;
      const targets = record.targets.map((target) => target.clientNonce === memberNonce ? { ...target, ...patch } : target);
      let state = 'accepted';
      if (targets.every(settled)) state = targets.some((t) => ['error', 'interrupted', 'needs-reconciliation'].includes(t.state)) ? 'error' : 'done';
      else if (targets.some((t) => WAITING_RUN_STATES.has(t.state))) state = 'waiting';
      else if (targets.some((t) => ['running', 'cancelling'].includes(t.state))) state = 'running';
      return this.execution.updateAdmission('group', nonce, { targets, state });
    });
  }
  onRunState(run) {
    let nonce = this.parents.get(run.clientNonce);
    if (!nonce && run.conversationId?.startsWith('group:')) {
      for (const row of this.execution.listAdmissions('group')) {
        const record = this.remember(row.record);
        if (record.targets.some((target) => target.clientNonce === run.clientNonce)) { nonce = record.clientNonce; break; }
      }
    }
    if (!nonce) return;
    this.updateTarget(nonce, run.clientNonce, { confirmed: true, runId: run.runId, state: run.state,
      ...(run.resultText != null ? { resultText: run.resultText } : {}),
      ...(run.resultEntryId != null ? { resultEntryId: run.resultEntryId } : {}), ...(run.error ? { error: run.error } : {}) });
  }
  async dispatchTarget(nonce, memberNonce, { round = false } = {}) {
    const key = JSON.stringify([nonce, memberNonce]);
    if (this.dispatching.has(key)) return this.dispatching.get(key);
    const job = (async () => {
      this.assertOpen();
      let record = this.admission(nonce);
      let target = record?.targets.find((t) => t.clientNonce === memberNonce);
      if (!target || settled(target) || target.confirmed) return target;
      if (record.entryId && record.inputThroughSeq == null) {
        this.prepareSource(nonce);
        record = this.admission(nonce);
        target = record.targets.find((t) => t.clientNonce === memberNonce);
        if (record.inputThroughSeq == null) throw fail('room/source-projection-pending');
      }
      if (target.cancelRequested && !target.dispatchAttempted) {
        this.updateTarget(nonce, memberNonce, { state: 'skipped', reason: 'cancelled before dispatch' });
        return this.admission(nonce).targets.find((t) => t.clientNonce === memberNonce);
      }
      if (target.proxied !== this.isProxied(target.memberId)) throw fail('room/member-route-changed');
      if (target.proxied && !(this.engine.proxy ?? this.proxy)?.isProxiedAgent(target.memberId)) throw fail('room/proxy-unavailable');
      if (!this.validMember(target.memberId)) {
        this.updateTarget(nonce, memberNonce, { state: 'skipped', reason: 'member missing or nested group' });
        return this.admission(nonce).targets.find((t) => t.clientNonce === memberNonce);
      }
      if (round) {
        target = { ...target, args: { ...target.args, inputThroughSeq: this.roster.store(record.groupId).maxSeq() } };
        this.updateTarget(nonce, memberNonce, { args: target.args });
      }
      this.updateTarget(nonce, memberNonce, { dispatchAttempted: true, lastDispatchAtMs: Date.now() });
      try {
        const acceptance = await this.engine.dispatchAdmission(copy(target.args));
        this.updateTarget(nonce, memberNonce, this.acceptedPatch(acceptance));
        const accepted = this.admission(nonce).targets.find((t) => t.clientNonce === memberNonce);
        if (accepted.cancelRequested) await this.requestCancel(nonce, memberNonce, accepted.cancelReason);
        return this.admission(nonce).targets.find((t) => t.clientNonce === memberNonce);
      } catch (error) {
        this.updateTarget(nonce, memberNonce, { dispatchError: String(error.message ?? error), lastDispatchAtMs: Date.now() });
        throw error;
      }
    })();
    this.dispatching.set(key, job);
    try { return await job; } finally { if (this.dispatching.get(key) === job) this.dispatching.delete(key); }
  }
  async dispatchPlan(nonce) {
    if (this.closed || this.engine._closing) return;
    const record = this.admission(nonce);
    if (!record) return;
    await Promise.all(record.targets.filter((target) => !target.confirmed && !settled(target)).map(async (target) => {
      try { await this.dispatchTarget(nonce, target.clientNonce); }
      catch (error) { this.log('room.dispatch.pending', { groupId: record.groupId, clientNonce: target.clientNonce, error: error.message }); }
    }));
    if (this.closed || this.engine._closing) return;
    for (const target of this.admission(nonce).targets) {
      if (!target.proxied || !target.confirmed) continue;
      if (target.state === 'done' && target.resultText != null) {
        try { this.mirrorRemoteResult({ ...target, agentId: target.memberId, parentNonce: nonce }, target); }
        catch (error) { this.log('room.mirror.pending', { nonce: target.clientNonce, error: error.message }); }
      } else if (!settled(target) || target.state === 'done') this.observeMember(nonce, target);
    }
  }
  observeMember(parentNonce, target) {
    const key = JSON.stringify([parentNonce, target.clientNonce]);
    if (this.closed || this.engine._closing || this.observers.has(key)) return;
    const job = (async () => {
      let first = true;
      while (!this.closed && !this.engine._closing) {
        const current = this.admission(parentNonce)?.targets.find((t) => t.clientNonce === target.clientNonce);
        if (!current || (settled(current) && (!first || current.state !== 'done'))) return;
        first = false;
        try {
          const status = await this.memberStatus({ ...current, agentId: current.memberId, parentNonce });
          if (TERMINAL_RUN_STATES.has(status.state)) return;
        }
        catch (error) {
          if (this.closed || this.engine._closing) return;
          this.updateTarget(parentNonce, target.clientNonce, { statusError: String(error.message ?? error) });
        }
        if (this.closed || this.engine._closing) return;
        await new Promise((resolve) => { const timer = setTimeout(resolve, 500); timer.unref?.(); });
      }
    })().finally(() => { if (this.observers.get(key) === job) this.observers.delete(key); });
    this.observers.set(key, job);
    job.catch((error) => this.log('room.observe.pending', { parentNonce, error: error.message }));
  }
  async postBot({ fromAgentId, groupId, text, images = [], priority = false, messageId = null, signal = null, effectPermit = null }) {
    this.assertOpen();
    signal?.throwIfAborted();
    if (effectPermit) await effectPermit();
    signal?.throwIfAborted();
    this.assertOpen();
    const room = this.roomId(groupId);
    const from = this.roster.resolve(fromAgentId);
    const nonce = messageId ?? randomUUID();
    const input = { fromAgentId: from, groupId: room, text: String(text ?? ''), images, priority };
    const author = this.roster.profile(from) ?? {};
    const entry = { kind: 'send-message', id: `room-${randomUUID()}`, messageId: nonce, schemaVersion: 2,
      conversationId: groupConversation(room), hidden: false, fromAgent: { id: from, name: author.name ?? from },
      speaker: { kind: 'bot', id: from, name: author.name ?? from }, message: { type: 'text', content: input.text }, timestampMs: Date.now() };
    const receipt = { delivered: true, groupId: room, roomEntryId: entry.id, entryId: entry.id,
      members: this.roster.groupMembers(room).filter((id) => id !== from), woken: false,
      notes: [
        'Group posts do not wake members.',
        ...(priority ? ['priority is 1:1 only — this post did not interrupt members'] : []),
        ...(images.length ? ['the attached image(s) were NOT delivered — group messages are text-only'] : []),
      ] };
    const admitted = this.execution.transaction(() => {
      signal?.throwIfAborted();
      const result = this.execution.admit({ scope: 'group-peer', nonce, input, record: receipt });
      if (result.conflict) throw fail(result.code);
      if (!result.replayed) {
        this.engine.queueEntry(room, entry);
        this.execution.afterCommit(() => this.engine.flushDeliveries());
      }
      signal?.throwIfAborted();
      return result;
    });
    return { ...admitted.record, ...(admitted.replayed ? { duplicate: true, replayed: true } : {}) };
  }
  async runRound({ roomId, newMessages = [], isWindingDown = false, deadlineMs = null }) {
    this.assertOpen();
    const room = this.roomId(roomId);
    const members = [...new Set(this.roster.groupMembers(room))];
    if (!members.length) return { roomId: room, results: [], reason: 'no members' };
    const nonce = randomUUID();
    const text = newMessages.map((message) => `[${message.speakerKind ?? 'human'}:${message.speakerName ?? 'operator'}] ${String(message.text ?? '')}`).join('\n');
    const entry = newMessages.length ? { ...userMessageEntry({ text, clientNonce: nonce }), schemaVersion: 2,
      conversationId: groupConversation(room), hidden: false, speaker: { kind: 'human', id: 'operator', name: 'operator' } } : null;
    const input = { groupId: room, target: room, text, mentions: null, attachmentPaths: [], replyTo: null,
      strategy: 'round_robin', newMessages, isWindingDown, deadlineMs };
    const admitted = this.admitGroup({ room, nonce, input, entry, members, strategy: 'round_robin', roundOptions: { newMessages, isWindingDown, deadlineMs } });
    return this.startRound(this.remember(admitted.record));
  }
  startRound(record) {
    this.assertOpen();
    if (this.rounds.has(record.clientNonce)) return this.rounds.get(record.clientNonce);
    const promise = this.executeRound(record).finally(() => {
      if (this.rounds.get(record.clientNonce) === promise) this.rounds.delete(record.clientNonce);
    });
    this.rounds.set(record.clientNonce, promise);
    return promise;
  }
  async executeRound(record) {
    const room = record.groupId;
    if (this.turns.has(room)) this.cancel(room);
    const turn = { id: record.roundId ?? randomUUID(), roomId: room, clientNonce: record.clientNonce,
      startedAt: Date.now(), cancelled: false, activeMemberNonce: null };
    this.turns.set(room, turn);
    const results = [];
    try {
      for (const target of record.targets) {
        const cached = this.seen.get(resultKey(room, target.memberId, target.clientNonce));
        if (cached) {
          results.push(cached);
          if (cached.outcome === 'cancelled') turn.cancelled = true;
          continue;
        }
        if (!this.isCurrent(turn)) {
          const current = this.admission(record.clientNonce).targets.find((t) => t.clientNonce === target.clientNonce);
          if (!current.confirmed && !current.dispatchAttempted) this.updateTarget(record.clientNonce, target.clientNonce, { state: 'skipped', cancelRequested: true, reason: 'round cancelled before admission' });
          results.push(this.record(room, target.memberId, target.clientNonce, 'cancelled', { reason: 'superseded or cancelled' }));
          continue;
        }
        const deadline = Date.now() + (record.roundOptions?.deadlineMs ?? this.defaultDeadlineMs);
        turn.activeMemberNonce = target.clientNonce;
        const result = await this.runMemberTurn({ turn, room, memberId: target.memberId, nonce: target.clientNonce, deadline });
        results.push(result);
        if (result.outcome === 'cancelled') turn.cancelled = true;
        turn.activeMemberNonce = null;
      }
      this.execution.updateAdmission('group', record.clientNonce, { roundFinishedAtMs: Date.now(), roundResults: results, roundCancelled: turn.cancelled });
      this.bus.publish({ type: 'room-round-end', agentId: room, conversationId: groupConversation(room), turnId: turn.id, results });
      return { roomId: room, turnId: turn.id, results };
    } finally {
      if (this.turns.get(room) === turn) this.turns.delete(room);
    }
  }
  isCurrent(turn) { return !this.closed && !this.engine._closing && !turn.cancelled && this.turns.get(turn.roomId) === turn; }
  async runMemberTurn({ turn, room, memberId, nonce, deadline }) {
    if (!this.validMember(memberId)) {
      this.updateTarget(turn.clientNonce, nonce, { state: 'skipped', reason: 'member missing or nested group' });
      return this.record(room, memberId, nonce, 'skipped', { reason: 'member missing or nested group' });
    }
    if (!this.isCurrent(turn)) return this.record(room, memberId, nonce, 'cancelled', { reason: 'superseded' });
    const startedAt = Date.now();
    this.bus.publish({ type: 'room-member-turn-start', agentId: room, conversationId: groupConversation(room), memberAgentId: memberId, nonce });
    try {
      const dispatch = this.dispatchTarget(turn.clientNonce, nonce, { round: true });
      const accepted = await this.waitForDispatch(dispatch, deadline, () => this.isCurrent(turn));
      if (accepted.stop) {
        await this.requestCancel(turn.clientNonce, nonce, accepted.stop);
        return this.record(room, memberId, nonce, accepted.stop, { elapsed: Date.now() - startedAt, cancellationRequested: true });
      }
      const target = accepted.target;
      if (target?.state === 'skipped') return this.record(room, memberId, nonce, 'skipped', { reason: target.reason ?? 'member unavailable' });
      const outcome = await this.awaitMember({ ...target, clientNonce: nonce, agentId: memberId, parentNonce: turn.clientNonce }, deadline, () => this.isCurrent(turn));
      if (outcome.state === 'timeout' || outcome.state === 'cancelled') await this.requestCancel(turn.clientNonce, nonce, outcome.state);
      return this.record(room, memberId, nonce, outcome.state, { elapsed: Date.now() - startedAt, runId: target.runId,
        ...(outcome.resultText != null ? { resultText: outcome.resultText } : {}), ...(outcome.resultEntryId ? { resultEntryId: outcome.resultEntryId } : {}),
        ...(outcome.error ? { error: outcome.error } : {}), ...(['timeout', 'cancelled'].includes(outcome.state) ? { cancellationRequested: true } : {}) });
    } catch (error) {
      if (!this.isCurrent(turn)) {
        await this.requestCancel(turn.clientNonce, nonce, 'cancelled');
        return this.record(room, memberId, nonce, 'cancelled', { reason: 'superseded', cancellationRequested: true });
      }
      return this.record(room, memberId, nonce, 'error', { error: String(error?.message ?? error) });
    }
  }
  async waitForDispatch(promise, deadline, isCurrent) {
    let ready = false;
    let target;
    let failure;
    promise.then((value) => { target = value; ready = true; }, (error) => { failure = error; ready = true; });
    for (;;) {
      if (!isCurrent()) return { stop: 'cancelled' };
      if (Date.now() >= deadline) return { stop: 'timeout' };
      if (ready) { if (failure) throw failure; return { target }; }
      await new Promise((resolve) => setTimeout(resolve, Math.min(120, Math.max(1, deadline - Date.now()))));
    }
  }
  async memberStatus(acceptance) {
    const raw = acceptance.proxied
      ? await (this.proxy ?? this.engine.proxy).act({ method: 'promptAcceptanceStatus', args: { agentId: acceptance.agentId, clientNonce: acceptance.clientNonce, runId: acceptance.runId } })
      : await this.engine.acceptanceStatus(acceptance.clientNonce);
    const status = { ...(raw?.record ?? {}), ...(raw ?? {}) };
    // Closing waits for these reads, but a late network reply must not create new work.
    if (this.closed || this.engine._closing) return status;
    if (acceptance.runId && status.runId && status.runId !== acceptance.runId) throw fail('room/result-run-mismatch');
    if (TERMINAL_RUN_STATES.has(status.state) && !status.runId) throw fail('room/result-run-missing');
    if (acceptance.proxied && status.state === 'done') this.mirrorRemoteResult(acceptance, status);
    if (acceptance.parentNonce && status.state) this.updateTarget(acceptance.parentNonce, acceptance.clientNonce, {
      state: status.state, ...(status.resultText != null ? { resultText: status.resultText } : {}), ...(status.resultEntryId ? { resultEntryId: status.resultEntryId } : {}) });
    return status;
  }
  mirrorRemoteResult(acceptance, status) {
    const text = String(status.resultText ?? '');
    if (isPass(text) || this.closed || this.engine._closing) return;
    const record = this.admission(acceptance.parentNonce);
    if (!record || !status.runId) return;
    const answerId = `answer-${createHash('sha256').update(status.runId).digest('hex').slice(0, 32)}`;
    const existing = this.roster.store(record.groupId).getEntry(answerId);
    const pending = this.execution.pendingDeliveries().some((delivery) => delivery.agentId === record.groupId && delivery.entry?.id === answerId);
    if (!existing && !pending) {
      this.execution.transaction(() => {
        this.engine.queueGroupAnswer({ ...status, runId: status.runId, agentId: acceptance.agentId,
          conversationId: record.conversationId, finishedAtMs: status.finishedAtMs ?? record.acceptedAtMs }, text);
        this.execution.afterCommit(() => this.engine.flushDeliveries());
      });
    } else if (pending) this.engine.flushDeliveries();
  }
  async awaitMember(acceptance, deadline, isCurrent) {
    for (;;) {
      if (!isCurrent()) return { state: 'cancelled' };
      if (Date.now() >= deadline) return { state: 'timeout' };
      const reply = await this.waitForDispatch(this.memberStatus(acceptance), deadline, isCurrent);
      if (reply.stop) return { state: reply.stop };
      const st = reply.target;
      if (!isCurrent()) return { state: 'cancelled' };
      if (st.state === 'done') {
        const resultText = String(st.resultText ?? '');
        if (!isPass(resultText)) {
          const record = this.admission(acceptance.parentNonce);
          const answerId = st.publicResultEntryId ?? `answer-${createHash('sha256').update(st.runId).digest('hex').slice(0, 32)}`;
          if (record && !this.roster.store(record.groupId).getEntry(answerId)) {
            this.engine.flushDeliveries();
            await new Promise((resolve) => setTimeout(resolve, Math.min(120, Math.max(1, deadline - Date.now()))));
            continue;
          }
        }
        return { state: isPass(resultText) ? 'pass' : 'delivered', resultText, resultEntryId: st.resultEntryId ?? null };
      }
      if (st.state === 'error' || st.state === 'needs-reconciliation') return { state: 'error', error: st.error ?? st.state };
      if (st.state === 'interrupted' || st.state === 'cancelled') return { state: 'cancelled', error: st.error ?? st.state };
      if (WAITING_RUN_STATES.has(st.state)) return { state: 'skipped', error: `member parked on ${st.state}` };
      await new Promise((resolve) => setTimeout(resolve, Math.min(120, Math.max(1, deadline - Date.now()))));
    }
  }
  async requestCancel(parentNonce, memberNonce, reason = 'cancelled') {
    const record = this.updateTarget(parentNonce, memberNonce, { cancelRequested: true, cancelReason: reason });
    const target = record?.targets.find((t) => t.clientNonce === memberNonce);
    if (!target?.runId) return { cancellationRequested: true, pendingAdmission: true };
    const key = JSON.stringify([parentNonce, memberNonce]);
    if (!this.cancelling.has(key)) {
      // Acknowledging the request is distinct from the executor reaching a terminal state.
      const job = Promise.resolve().then(() => target.proxied
        ? (this.proxy ?? this.engine.proxy).act({ method: 'interruptAgentRun', args: { id: target.memberId, agentId: target.memberId, runId: target.runId } })
        : this.engine.cancelRun(target.runId, `room ${reason}`))
        .then(() => this.updateTarget(parentNonce, memberNonce, { cancellationAcknowledged: true }))
        .catch((error) => {
          this.updateTarget(parentNonce, memberNonce, { cancellationError: String(error.message ?? error) });
          this.log('room.cancel.pending', { runId: target.runId, error: error.message });
        }).finally(() => { if (this.cancelling.get(key) === job) this.cancelling.delete(key); });
      this.cancelling.set(key, job);
      job.catch((error) => this.log('room.cancel.pending', { runId: target.runId, error: error.message }));
    }
    return { cancellationRequested: true, runId: target.runId, pending: true };
  }
  recover() {
    if (this.closed || this.engine._closing) return Promise.resolve({ recovered: 0, closed: true });
    if (this.recovering) return this.recovering;
    const job = this.recoverAdmissions().catch((error) => {
      this.log('room.recovery.pending', { error: error.message });
      return { recovered: 0, pending: true, error: error.message };
    }).finally(() => { if (this.recovering === job) this.recovering = null; });
    this.recovering = job;
    return job;
  }
  async recoverAdmissions() {
    this.engine.flushDeliveries();
    const records = this.execution.listAdmissions('group').map((row) => this.remember(row.record));
    for (const record of records) {
      if (this.closed || this.engine._closing) break;
      for (const target of record.targets) {
        if (this.closed || this.engine._closing) break;
        if (!target.proxied && target.confirmed && target.runId) {
          const run = this.engine.getRun(target.runId);
          if (run) this.onRunState(run);
        }
        if (target.cancelRequested && !target.confirmed && target.dispatchAttempted) {
          try { await this.dispatchTarget(record.clientNonce, target.clientNonce); }
          catch (error) { this.log('room.recovery.pending', { nonce: target.clientNonce, error: error.message }); }
        }
        const currentTarget = this.admission(record.clientNonce).targets.find((t) => t.clientNonce === target.clientNonce);
        if (currentTarget.cancelRequested && currentTarget.runId && !settled(currentTarget)) await this.requestCancel(record.clientNonce, target.clientNonce, currentTarget.cancelReason);
      }
      if (this.closed || this.engine._closing) break;
      const current = this.admission(record.clientNonce);
      if (current.strategy === 'round_robin') {
        if (!current.roundCancelled && (!current.roundFinishedAtMs || current.targets.some((target) => !target.confirmed && !settled(target)))) this.startRound(current).catch((error) => this.log('room.recovery.pending', { nonce: current.clientNonce, error: error.message }));
      } else await this.dispatchPlan(current.clientNonce);
    }
    return { recovered: records.length };
  }
  buildRoomPrompt({ group, memberId, peers, newMessages, isWindingDown }) {
    const others = peers.filter((p) => p.id !== memberId).map((p) => `${p.name} (${p.id})`);
    const lines = [
      `You are in the group chat "${group.name ?? 'room'}".`, group.description ? `Room purpose: ${group.description}` : '',
      others.length ? `Other members: ${others.join(', ')}.` : 'You are the only member.', '',
      'This is a room turn, not a private chat. Rules:',
      '- Reply only if you have something worth adding. If not, reply with exactly "pass" and nothing else.',
      '- You are speaking to the room, not to one person.', '- Do not repeat what another member already said.',
      '- Do not acknowledge with pleasantries; silence is the preferred acknowledgement.', '',
    ];
    if (newMessages?.length) {
      lines.push('Since your last turn:');
      for (const m of newMessages) lines.push(`  [${m.speakerKind}:${m.speakerName}] ${m.text}`);
    } else lines.push('There are no new messages since your last turn.');
    if (isWindingDown) lines.push('', 'The room is winding down: keep it short, or pass.');
    return lines.join('\n');
  }
  record(room, memberId, nonce, outcome, extra = {}) {
    const key = resultKey(room, memberId, nonce);
    if (nonce && this.seen.has(key)) return { ...this.seen.get(key), replayed: true };
    const entry = { roomId: room, nonce, memberAgentId: memberId, outcome: OUTCOMES.includes(outcome) ? outcome : 'error', at: Date.now(), ...extra };
    if (nonce) this.seen.set(key, entry);
    if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value);
    this.history.push(entry);
    if (this.history.length > 500) this.history.shift();
    this.bus.publish({ type: 'room-member-turn-end', agentId: room, conversationId: groupConversation(room), memberAgentId: memberId, nonce, outcome: entry.outcome, shown: SHOWN_OUTCOMES.has(entry.outcome) });
    this.log('room.member.outcome', { room, memberId, outcome: entry.outcome, ...extra });
    return entry;
  }
  submitResult({ roomId, nonce, memberAgentId, outcome, error = null }) {
    return this.record(this.roomId(roomId), memberAgentId, nonce, outcome, error ? { error } : {});
  }
  cancel(roomId) {
    const room = this.roomId(roomId);
    const turn = this.turns.get(room);
    if (!turn) return { cancelled: false, reason: 'no active room turn' };
    turn.cancelled = true;
    this.execution.updateAdmission('group', turn.clientNonce, { roundCancelled: true });
    if (turn.activeMemberNonce) this.requestCancel(turn.clientNonce, turn.activeMemberNonce, 'cancelled').catch((error) => this.log('room.cancel.pending', { error: error.message }));
    this.bus.publish({ type: 'room-round-cancelled', agentId: room, conversationId: groupConversation(room), turnId: turn.id, cancellationRequested: true });
    return { cancelled: true, cancellationRequested: true, turnId: turn.id };
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const roomId of [...this.turns.keys()]) this.cancel(roomId);
    this.closePromise = (async () => {
      for (;;) {
        const jobs = [...this.rounds.values(), ...this.dispatching.values(), ...this.cancelling.values(), ...this.observers.values(), ...(this.recovering ? [this.recovering] : [])];
        if (!jobs.length) break;
        await Promise.allSettled(jobs);
      }
    })();
    return this.closePromise;
  }
  diagnostics() { return { closed: this.closed, activeRooms: [...this.turns.keys()], recent: this.history.slice(-20) }; }
}
