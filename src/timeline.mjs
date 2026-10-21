// Timeline ordering with pending sends.
//
// Ported from tweb (Telegram Web K, GPL-3.0):
//   components/chat/bubbleTimelineOrder.ts   — the total order
//   components/chat/bubbleGroups.ts          — getLateSendPosition / raiseLaterSends
//   lib/appManagers/appMessagesIdsManager.ts — temp ids are serverId + 0.0001
//
// The problem tweb solves: a message gets a temporary id when sent and a real id when
// the server confirms. If two sends go out back to back and the *second* is confirmed
// first, the first sits above it at its old temp id and the chat visibly jumps. tweb
// moves every un-confirmed send that came after the confirmed one to just behind it.
//
// **Here that race does not exist, and this file says so instead of pretending.**
// Admission is synchronous and serialized: `admit()` appends the user row and gets a
// monotonic `seq` before any turn runs, and each agent's turns run one at a time
// (run-scheduler). So a pending row can never be overtaken by a later *user* row.
//
// What remains real is a narrower case: a row written while a turn is in flight (an
// approval card, a widget, a peer message) has a higher seq than the assistant reply
// that the running turn is still streaming. Those are not sends, so they must not be
// reordered at all — `orderWithPending` returns transcript order unless a caller
// explicitly marks rows pending, and the engine only marks *user* rows.

/** tweb: const BEHIND_SENT = 0.00005; — how far behind a confirmed send the rest go. */
export const BEHIND_SENT = 0.00005;

/** tweb: generateTempMessageId = serverId + 0.0001 */
export const TEMP_ID_OFFSET = 0.0001;

/**
 * A timeline key is made once and compared field by field. tweb's comment is worth
 * keeping: choosing the field per pair (ids for two history messages, dates once a
 * pending one is involved) is *not* an order — it allows a < b < c < a, and the
 * binary search then files bubbles anywhere.
 */
export function makeTimelineKey({ day, position, deferred = false, date, order = 0, mid, pending = false }) {
  return {
    day,
    position,
    deferred: deferred ? 1 : 0,
    date,
    order: deferred ? order : 0,
    mid,
    pending,
  };
}

export function compareTimelineKeys(a, b) {
  return (
    a.day - b.day ||
    a.position - b.position ||
    a.deferred - b.deferred ||
    a.date - b.date ||
    a.order - b.order ||
    a.mid - b.mid
  );
}

/** A stable numeric id per entry, so two rows never share a tiebreaker. */
export function midFor(entry) {
  const seq = Number(entry.seq);
  if (Number.isFinite(seq)) return seq;
  let h = 0;
  for (const ch of String(entry.id ?? '')) h = (h * 31 + ch.charCodeAt(0)) % 0x7fffffff;
  return h;
}

export function dayOf(ms) {
  const d = new Date(ms ?? 0);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

/**
 * Order the rows for display. `pending` marks rows that are accepted but not yet
 * settled (no confirmation has come back for them).
 *
 * tweb's two rules, both kept:
 *   1. position wins over date, so a confirmed row is never dragged below an
 *      un-confirmed one that arrived later;
 *   2. a pending row's position is derived, not its own id: if a later row has
 *      already taken a server position, the pending row sits just behind it.
 */
export function orderWithPending(rows, { isPending = () => false } = {}) {
  const items = rows.map((entry) => ({
    entry,
    mid: midFor(entry),
    date: entry.timestampMs ?? 0,
    pending: isPending(entry),
  }));

  // Confirmed positions, in mid order. These are the anchors pending rows hang off.
  const confirmed = items.filter((i) => !i.pending).sort((a, b) => a.mid - b.mid);
  const confirmedMids = confirmed.map((i) => ({ tempMid: i.mid, sentMid: i.mid, position: i.mid }));
  const confirmedSet = new Set(confirmed.map((i) => i.mid));

  // tweb's changedMids: tempId -> mid, i.e. "this send was overtaken by that one".
  // An overtake requires a confirmed row whose mid is *above* the pending row's,
  // which in this host can only happen for rows admitted out of order — which
  // admission forbids. The map therefore stays empty in practice; it is kept because
  // it is what makes the order total if a future caller does admit concurrently.
  const changedMids = new Map();
  for (const p of items.filter((i) => i.pending)) {
    // An overtake means a confirmed row was admitted *before* this pending one but
    // carries a higher mid — the server confirmed out of order. Signed by date: the
    // confirmed row must be older than the pending one.
    const overtaker = confirmedMids.find((c) => c.sentMid > p.mid && confirmedDate(c.sentMid) < p.date);
    if (overtaker) changedMids.set(p.mid, overtaker.sentMid);
  }
  function confirmedDate(mid) {
    return items.find((i) => i.mid === mid)?.date ?? 0;
  }

  const positionOf = (item) => {
    if (!item.pending) return item.mid;
    let sentPosition;
    for (const [tempMid, sentMid] of changedMids) {
      if (tempMid < item.mid && sentMid > item.mid && (sentPosition === undefined || sentMid > sentPosition)) {
        sentPosition = sentMid;
      }
    }
    return sentPosition === undefined ? item.mid : sentPosition + BEHIND_SENT;
  };

  // raiseLaterSends: when a send is confirmed at `position`, later pending sends that
  // were standing above it move behind it. With serialized admission no pending row
  // stands above a later confirmed one, so this normally moves nothing.
  const raised = new Map();
  for (const c of confirmed) {
    for (const p of items) {
      if (!p.pending) continue;
      if (p.mid > c.mid && positionOf(p) <= c.mid) raised.set(p.mid, c.mid + BEHIND_SENT);
    }
  }

  const keyed = items.map((item) => {
    const position = raised.get(item.mid) ?? positionOf(item);
    return {
      item,
      key: makeTimelineKey({
        day: dayOf(item.date),
        position,
        date: item.date,
        mid: item.mid,
        pending: item.pending,
      }),
    };
  });

  keyed.sort((a, b) => compareTimelineKeys(a.key, b.key));
  return keyed.map(({ item }) => ({ entry: item.entry, pending: item.pending }));
}

/** tweb: generateTempMessageId = serverId + 0.0001, so it sorts just after the server id. */
export function tempIdFor(serverMid) {
  return Number((serverMid + TEMP_ID_OFFSET).toFixed(4));
}


/**
 * tweb's `changedMids`, as a small reversible table.
 *
 * When a send is accepted it only has a client nonce; the transcript row it becomes
 * has an entry id. The client renders by entry id, so if it renders the nonce first
 * it has to be able to swap the key in place instead of rebuilding the node — that is
 * exactly what tweb does with `ChatBubbles.changedMids` (tempId -> mid) when
 * `message_sent` arrives.
 *
 * Kept deliberately tiny: a bounded map plus a resolve function, no DOM knowledge.
 */
export class ChangedMids {
  constructor(limit = 512) {
    this.limit = limit;
    this.map = new Map();
  }

  /** Record that the row known as `tempId` is really `mid`. */
  set(tempId, mid) {
    this.map.set(tempId, mid);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return this;
  }

  /** Follow a chain, so a temp id that was itself remapped still resolves. */
  resolve(id) {
    let current = id;
    const seen = new Set();
    while (this.map.has(current) && !seen.has(current)) {
      seen.add(current);
      current = this.map.get(current);
    }
    return current;
  }

  has(id) {
    return this.map.has(id);
  }

  /** Ids the client should re-key, newest last. */
  entries() {
    return [...this.map.entries()];
  }

  get size() {
    return this.map.size;
  }
}
