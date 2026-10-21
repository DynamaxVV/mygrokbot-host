// Group room turns: one member at a time, with a six-state outcome.
//
// Ported from the deployed host's group-chat-glue.ts (runGroupMemberTurn /
// runTemporalGroupMemberTurn). The rules that matter:
//
//   1. ROUND-ROBIN, one turn at a time. A room turn hands the floor to one member,
//      waits for its result, then hands it to the next. Members never run in
//      parallel inside a room.
//   2. A nonce per member turn, and the result is idempotent on (member, nonce).
//      A late or duplicated delivery must not post twice.
//   3. `isRoomTurnCurrent()` gates everything after an await: a room turn that has
//      been superseded reports `cancelled`, never a stale post.
//   4. Only `delivered` and `pass` are shown. `pass` means "nothing worth saying",
//      which is a legitimate, non-error result. `skipped` / `timeout` / `cancelled`
//      / `error` are recorded but produce no post.
//
// The six outcomes (SAND_GATEWAY_ROOM_MEMBER_TURN_OUTCOMES):
//   delivered | pass | skipped | timeout | cancelled | error

import { randomUUID } from 'node:crypto';

export const OUTCOMES = ['delivered', 'pass', 'skipped', 'timeout', 'cancelled', 'error'];

/** Did the member decline to speak? Silence, or the literal pass token the prompt asks for. */
export function isPass(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  // Accept "pass", "PASS", "pass." and the quoted forms a model may emit.
  return /^[\s"'`*_]*pass[\s"'`*_.!]*$/i.test(t);
}
export const SHOWN_OUTCOMES = new Set(['delivered', 'pass']);

export class RoomTurns {
  constructor({ roster, engine, bus, proxy = null, log = () => {}, defaultDeadlineMs = 180_000 }) {
    this.roster = roster;
    this.engine = engine;
    this.bus = bus;
    // A room may contain server-hosted members; their turn goes through the proxy,
    // the same guard every other method uses.
    this.proxy = proxy;
    this.log = log;
    this.defaultDeadlineMs = defaultDeadlineMs;
    this.turns = new Map(); // roomId -> current turn context
    this.seen = new Map(); // `${roomId}\0${nonce}` -> result, for idempotency
    this.history = []; // bounded log of member turns
  }

  // Start a room turn: every member speaks once, in order. Resolves when the round
  // finishes; individual member results are also published on the bus.
  async runRound({ roomId, newMessages = [], isWindingDown = false, deadlineMs = null }) {
    const room = this.roster.resolve(roomId);
    const group = this.roster.profile(room) ?? {};
    const memberIds = this.roster.groupMembers(room);
    if (!memberIds.length) return { roomId: room, results: [], reason: 'no members' };

    const turn = {
      id: randomUUID(),
      roomId: room,
      startedAt: Date.now(),
      generation: (this.turns.get(room)?.generation ?? 0) + 1,
      cancelled: false,
    };
    this.turns.set(room, turn);

    const peers = memberIds.map((id) => {
      const p = this.roster.profile(id) ?? {};
      return { id, name: p.name ?? id, description: p.description ?? '' };
    });

    const results = [];
    for (const memberId of memberIds) {
      if (turn.cancelled || this.turns.get(room)?.generation !== turn.generation) {
        results.push({ memberAgentId: memberId, outcome: 'cancelled', nonce: null });
        continue;
      }
      const nonce = randomUUID();
      const deadline = Date.now() + (deadlineMs ?? this.defaultDeadlineMs);
      const result = await this.runMemberTurn({
        turn,
        room,
        group,
        memberId,
        peers,
        newMessages,
        isWindingDown,
        nonce,
        deadline,
      });
      results.push(result);
      if (result.outcome === 'cancelled') break;
    }

    this.turns.delete(room);
    this.bus.publish({ type: 'room-round-end', agentId: room, turnId: turn.id, results });
    return { roomId: room, turnId: turn.id, results };
  }

  // One member's turn. Returns the outcome object; never throws for an expected stop.
  async runMemberTurn({ turn, room, group, memberId, peers, newMessages, isWindingDown, nonce, deadline }) {
    const isCurrent = () => !turn.cancelled && this.turns.get(room)?.generation === turn.generation;

    // The member is gone, or it is a group nested in a group: nothing to show.
    if (!this.roster.exists(memberId)) {
      return this.record(room, memberId, nonce, 'skipped', { reason: 'member missing' });
    }
    if (!isCurrent()) {
      return this.record(room, memberId, nonce, 'cancelled', { reason: 'superseded' });
    }

    this.bus.publish({ type: 'room-member-turn-start', agentId: room, memberAgentId: memberId, nonce });
    const startedAt = Date.now();

    let memberTurnSeen = false;
    const unsubscribe = this.bus.subscribe((event) => {
      if (event.agentId === memberId && event.clientNonce === nonce) memberTurnSeen = true;
    });

    try {
      const prompt = this.buildRoomPrompt({ group, memberId, peers, newMessages, isWindingDown });
      const acceptance = this.proxy?.isProxiedAgent(memberId)
        ? await this.admitViaProxy({ memberId, prompt, nonce, room })
        : this.engine.admit({
            agentId: memberId,
            prompt,
            clientNonce: nonce,
            trigger: `room:${room}`,
            lane: 'background',
            source: 'group-member',
          });

      const outcome = await this.awaitMember(acceptance, deadline, () => isCurrent());
      const elapsed = Date.now() - startedAt;

      if (!isCurrent()) {
        return this.record(room, memberId, nonce, 'cancelled', { elapsed, reason: 'superseded' });
      }
      return this.record(room, memberId, nonce, outcome.state, {
        elapsed,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
    } catch (error) {
      if (!isCurrent()) {
        return this.record(room, memberId, nonce, 'cancelled', { reason: 'superseded' });
      }
      return this.record(room, memberId, nonce, 'error', { error: String(error?.message ?? error) });
    } finally {
      unsubscribe();
    }
  }

  // A server-hosted member: hand the prompt to the proxy and shape its reply into the
  // same acceptance-like object the local path produces.
  async admitViaProxy({ memberId, prompt, nonce, room }) {
    const forwarded = await this.proxy.act({
      method: 'sendPrompt',
      args: { agentId: memberId, prompt, clientNonce: nonce },
    });
    return {
      clientNonce: forwarded.clientNonce ?? nonce,
      agentId: memberId,
      state: forwarded.accepted ? 'accepted' : 'error',
      trigger: `room:${room}`,
      proxied: true,
    };
  }

  // Wait for a member's turn to settle, then decide which of the six outcomes it is.
  async awaitMember(acceptance, deadline, isCurrent) {
    for (;;) {
      if (!isCurrent()) return { state: 'cancelled' };
      const st = acceptance.proxied && this.proxy
        ? await this.proxy
            .act({ method: 'promptAcceptanceStatus', args: { agentId: acceptance.agentId, clientNonce: acceptance.clientNonce } })
            .then((r) => ({ state: r.state ?? (r.outcome === 'not-found' ? 'unknown' : 'running') }))
            .catch((e) => ({ state: 'error', error: e.message }))
        : this.engine.acceptanceStatus(acceptance.clientNonce);

      if (st.state === 'done') {
        // A pass is either silence or the literal word the prompt asks for. The real
        // model does the latter, so recognising only "" would misreport every pass as
        // a delivered message that happens to say "pass".
        const said = this.lastAssistantText(acceptance.agentId);
        return { state: isPass(said) ? 'pass' : said ? 'delivered' : 'pass' };
      }
      if (st.state === 'error') return { state: 'error', error: st.error ?? 'turn failed' };
      if (st.state === 'interrupted') return { state: 'cancelled', error: 'interrupted' };
      if (st.state === 'awaiting-approval' || st.state === 'awaiting-answer') {
        // A member parked on an interaction cannot finish inside a room turn.
        return { state: 'skipped', error: `member parked on ${st.state}` };
      }
      if (Date.now() > deadline) return { state: 'timeout' };

      await new Promise((r) => setTimeout(r, 120));
    }
  }

  lastAssistantText(agentId) {
    const rows = this.roster.store(agentId).readWindow({ limit: 40 });
    const reply = rows.find((e) => e.kind === 'send-message' && e.message?.type === 'text');
    return String(reply?.message?.content ?? '').trim();
  }

  // The prompt a member sees. It states the room, who else is in it, what was said
  // since its last turn, and that silence is a valid answer.
  buildRoomPrompt({ group, memberId, peers, newMessages, isWindingDown }) {
    const others = peers.filter((p) => p.id !== memberId).map((p) => `${p.name} (${p.id})`);
    const lines = [
      `You are in the group chat "${group.name ?? 'room'}".`,
      group.description ? `Room purpose: ${group.description}` : '',
      others.length ? `Other members: ${others.join(', ')}.` : 'You are the only member.',
      '',
      'This is a room turn, not a private chat. Rules:',
      '- Reply only if you have something worth adding. If not, reply with exactly "pass" and nothing else.',
      '- You are speaking to the room, not to one person.',
      '- Do not repeat what another member already said.',
      '- Do not acknowledge with pleasantries; silence is the preferred acknowledgement.',
      '',
    ];
    if (newMessages?.length) {
      lines.push('Since your last turn:');
      for (const m of newMessages) {
        lines.push(`  [${m.speakerKind}:${m.speakerName}] ${m.text}`);
      }
    } else {
      lines.push('There are no new messages since your last turn.');
    }
    if (isWindingDown) lines.push('', 'The room is winding down: keep it short, or pass.');
    return lines.filter((l) => l !== undefined).join('\n');
  }

  record(room, memberId, nonce, outcome, extra = {}) {
    const entry = {
      roomId: room,
      nonce,
      memberAgentId: memberId,
      outcome: OUTCOMES.includes(outcome) ? outcome : 'error',
      at: Date.now(),
      ...extra,
    };
    if (nonce) this.seen.set(`${room}\u0000${nonce}`, entry);
    if (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value);
    this.history.push(entry);
    if (this.history.length > 500) this.history.shift();
    this.bus.publish({
      type: 'room-member-turn-end',
      agentId: room,
      memberAgentId: memberId,
      nonce,
      outcome: entry.outcome,
      shown: SHOWN_OUTCOMES.has(entry.outcome),
    });
    this.log('room.member.outcome', { room, memberId, outcome: entry.outcome, ...extra });
    return entry;
  }

  // Idempotent hand-in of a result, for a caller (or a retry) that computes it itself.
  submitResult({ roomId, nonce, memberAgentId, outcome, error = null }) {
    const room = this.roster.resolve(roomId);
    const key = `${room}\u0000${nonce}`;
    const existing = this.seen.get(key);
    if (existing) return { ...existing, replayed: true };
    return this.record(room, memberAgentId, nonce, outcome, error ? { error } : {});
  }

  cancel(roomId) {
    const room = this.roster.resolve(roomId);
    const turn = this.turns.get(room);
    if (!turn) return { cancelled: false, reason: 'no active room turn' };
    turn.cancelled = true;
    this.bus.publish({ type: 'room-round-cancelled', agentId: room, turnId: turn.id });
    return { cancelled: true, turnId: turn.id };
  }

  diagnostics() {
    return {
      activeRooms: [...this.turns.keys()],
      recent: this.history.slice(-20),
    };
  }
}
