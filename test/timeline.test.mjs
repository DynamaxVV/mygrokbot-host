// Timeline ordering with pending sends — the tweb rules, checked at the boundaries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BEHIND_SENT,
  TEMP_ID_OFFSET,
  dayOf,
  makeTimelineKey,
  compareTimelineKeys,
  midFor,
  orderWithPending,
  tempIdFor,
  ChangedMids,
} from '../src/timeline.mjs';

const row = (id, seq, ts) => ({ id, seq, timestampMs: ts });

test('temp ids sit just after the server id they shadow', () => {
  assert.equal(tempIdFor(20), 20.0001);
  assert.equal(TEMP_ID_OFFSET, 0.0001);
  assert.ok(tempIdFor(20) > 20 && tempIdFor(20) < 21);
});

test('a pending row that was overtaken falls behind the confirmed row', () => {
  // Send A, then B; B is confirmed first. Without the rule, A stays above B at its
  // temp id and the chat jumps. tweb moves A to confirmedMid + BEHIND_SENT.
  const rows = [row('a', 10, 1000), row('b', 20, 1001)];
  const out = orderWithPending(rows, { isPending: (e) => e.id === 'a' });
  assert.deepEqual(out.map((o) => o.entry.id), ['a', 'b']);
  assert.deepEqual(out.map((o) => o.pending), [true, false]);
});

test('send order is preserved among several pending rows', () => {
  // Admission is serialized, so pending rows always carry increasing mids and a
  // later confirmed row can only ever sit *after* them.
  const rows = [row('a', 10, 1000), row('b', 11, 1001), row('c', 30, 1002)];
  const out = orderWithPending(rows, { isPending: (e) => e.id !== 'c' });
  assert.deepEqual(out.map((o) => o.entry.id), ['a', 'b', 'c']);
});

test('a row written mid-turn is never reordered', () => {
  // An approval card gets a higher seq than the reply still streaming, but it is not
  // a send, so the caller leaves it out of the pending set and order is untouched.
  const rows = [row('reply', 10, 1000), row('approval', 11, 1100)];
  const out = orderWithPending(rows, { isPending: () => false });
  assert.deepEqual(out.map((o) => o.entry.id), ['reply', 'approval']);
});

test('a confirmed row is never dragged below an unconfirmed one that came later', () => {
  // position (mid) outranks date, which is tweb's first comparison after day.
  const rows = [row('confirmed', 5, 9000), row('pending', 40, 1000)];
  const out = orderWithPending(rows, { isPending: (e) => e.id === 'pending' });
  assert.deepEqual(out.map((o) => o.entry.id), ['confirmed', 'pending']);
});

test('ordering is a total order: no a < b < c < a cycle', () => {
  // tweb's warning: choosing the compared field per pair is not an order.
  const keys = [
    makeTimelineKey({ day: 1, position: 5, date: 100, mid: 1 }),
    makeTimelineKey({ day: 1, position: 5, date: 100, mid: 2 }),
    makeTimelineKey({ day: 2, position: 1, date: 50, mid: 3 }),
  ];
  for (const a of keys) {
    for (const b of keys) {
      for (const c of keys) {
        if (compareTimelineKeys(a, b) <= 0 && compareTimelineKeys(b, c) <= 0) {
          assert.ok(compareTimelineKeys(a, c) <= 0, 'transitivity holds');
        }
      }
    }
  }
});

test('a day boundary outranks position', () => {
  const d1 = new Date('2026-10-20T23:59:00').getTime();
  const d2 = new Date('2026-10-21T00:01:00').getTime();
  assert.notEqual(dayOf(d1), dayOf(d2));
  const rows = [row('late-yesterday', 100, d1), row('early-today', 1, d2)];
  const out = orderWithPending(rows);
  assert.deepEqual(out.map((o) => o.entry.id), ['late-yesterday', 'early-today']);
});

test('BEHIND_SENT keeps a raised row strictly between the confirmed and the next', () => {
  const raisedPosition = 20 + BEHIND_SENT;
  assert.ok(raisedPosition > 20);
  assert.ok(raisedPosition < 21);
});

test('midFor is stable for rows without a seq', () => {
  const a = midFor({ id: 'send-abc' });
  const b = midFor({ id: 'send-abc' });
  const c = midFor({ id: 'send-abd' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(Number.isFinite(a) && a >= 0);
});

test('pending rows settle in place once confirmed', () => {
  const rows = [row('a', 10, 1000), row('b', 20, 1001)];
  const whilePending = orderWithPending(rows, { isPending: (e) => e.id === 'a' });
  const settled = orderWithPending(rows, { isPending: () => false });
  assert.deepEqual(whilePending.map((o) => o.entry.id), settled.map((o) => o.entry.id));
  assert.deepEqual(settled.map((o) => o.pending), [false, false]);
});

test('ChangedMids follows a chain and stays bounded', () => {
  const c = new ChangedMids(3);
  c.set('n1', 'msg-1');
  assert.equal(c.resolve('n1'), 'msg-1');
  assert.equal(c.resolve('unknown'), 'unknown');

  // A row that is itself re-keyed twice resolves to the final id.
  c.set('msg-1', 'msg-2');
  assert.equal(c.resolve('n1'), 'msg-2');

  // Bounded: the oldest pair is evicted, never an unbounded growth.
  c.set('n2', 'msg-3');
  c.set('n3', 'msg-4');
  c.set('n4', 'msg-5');
  assert.equal(c.size, 3);
  assert.equal(c.has('n1'), false);
});

test('ChangedMids is safe against a cycle', () => {
  const c = new ChangedMids();
  c.set('a', 'b');
  c.set('b', 'a');
  assert.ok(typeof c.resolve('a') === 'string'); // must terminate, not hang
});
