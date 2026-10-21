// Bubble grouping, checked against tweb's rule (bubbleGroups.ts: canItemsBeGrouped).
//
// The window is 121 seconds — not a round number, and not a guess. Sibling bubbles
// of the same sender inside that window form one visual group whose inner corners
// are flattened to 5px (tweb: $bubble-border-radius-medium) while the outer stay 15px.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const GROUP_WINDOW_MS = 121 * 1000;
const dayKey = (ms) => new Date(ms).toDateString();
function senderKey(e) {
  if (e.kind === 'message' && e.role === 'user') return e.fromAgent ? `bot:${e.fromAgent.id}` : 'me';
  if (e.kind === 'send-message' && e.message?.type === 'text') return 'bot';
  return null;
}
function annotate(list) {
  const keyed = list.map((e) => ({ entry: e, key: senderKey(e) }));
  return keyed.map((cur, i) => {
    const prev = keyed[i - 1], next = keyed[i + 1];
    const same = (a, b) => a && b && a.key != null && a.key === b.key &&
      Math.abs((b.entry.timestampMs ?? 0) - (a.entry.timestampMs ?? 0)) < GROUP_WINDOW_MS &&
      dayKey(a.entry.timestampMs ?? 0) === dayKey(b.entry.timestampMs ?? 0);
    const jp = same(prev, cur), jn = same(cur, next);
    return !jp && !jn ? 'single' : !jp ? 'start' : jn ? 'mid' : 'end';
  });
}
const bot = (t) => ({ kind: 'send-message', message: { type: 'text' }, timestampMs: t });
const base = Date.now();

const cases = [
  ['two within 121s group', [bot(base), bot(base + 120_000)], ['start', 'end']],
  ['exactly 121s does not', [bot(base), bot(base + 121_000)], ['single', 'single']],
  ['three in a row', [bot(base), bot(base + 1000), bot(base + 2000)], ['start', 'mid', 'end']],
  ['gap splits', [bot(base), bot(base + 200_000), bot(base + 201_000)], ['single', 'start', 'end']],
];
for (const [name, list, want] of cases) {
  test(name, () => {
    assert.deepEqual(annotate(list), want);
  });
}

test('a different sender always breaks the group', () => {
  const a = { kind: 'send-message', message: { type: 'text' }, timestampMs: base };
  const b = { kind: 'message', role: 'user', message: { type: 'text' }, timestampMs: base + 1000 };
  assert.deepEqual(annotate([a, b, a]), ['single', 'single', 'single']);
});

test('a date boundary breaks the group even inside the window', () => {
  const d1 = new Date('2026-10-20T23:59:30').getTime();
  const d2 = new Date('2026-10-21T00:00:30').getTime();
  assert.ok(Math.abs(d2 - d1) < GROUP_WINDOW_MS, 'still within 121s');
  assert.deepEqual(annotate([bot(d1), bot(d2)]), ['single', 'single']);
});

