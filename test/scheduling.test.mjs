// Scheduling and acceptance contract tests.
//
// These cover the parts of the interaction loop that a chat UI cannot show you:
// lane priority, per-agent serialization, the watchdog escape, and the durable
// acceptance record's three lookup outcomes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunScheduler } from '../src/scheduler.mjs';
import { AcceptanceLedger, inputDigest } from '../src/acceptance.mjs';

function fakeClock() {
  let now = 1_000_000;
  const timers = [];
  return {
    now: () => now,
    schedule: (ms, fn) => {
      const timer = { at: now + ms, fn, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      if (timer) timer.cancelled = true;
    },
    advance(ms) {
      now += ms;
      for (const t of [...timers]) {
        if (!t.cancelled && t.at <= now) {
          t.cancelled = true;
          t.fn();
        }
      }
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test('user lane runs before background regardless of arrival order', async () => {
  const clock = fakeClock();
  const s = new RunScheduler({ clock });
  const order = [];
  let release;
  const gate = new Promise((r) => {
    release = r;
  });

  s.enqueue('a', async () => {
    order.push('first');
    await gate;
  });
  await tick();
  s.enqueue('a', async () => order.push('background'), { lane: 'background' });
  s.enqueue('a', async () => order.push('user'), { lane: 'user' });
  s.enqueue('a', async () => order.push('agent'), { lane: 'agent' });

  release();
  await tick();
  await tick();
  await tick();
  assert.deepEqual(order, ['first', 'user', 'agent', 'background']);
});

test('a direct message jumps ahead of a queued group-member turn', async () => {
  const clock = fakeClock();
  const s = new RunScheduler({ clock });
  const order = [];
  let release;
  const gate = new Promise((r) => {
    release = r;
  });

  s.enqueue('a', async () => {
    order.push('active');
    await gate;
  });
  await tick();
  s.enqueue('a', async () => order.push('group'), { lane: 'user', source: 'group-member' });
  s.enqueue('a', async () => order.push('direct'), { lane: 'user', source: 'user' });

  release();
  await tick();
  await tick();
  assert.deepEqual(order, ['active', 'direct', 'group']);
});

test('one turn per agent: the second prompt waits for the first to settle', async () => {
  const clock = fakeClock();
  const s = new RunScheduler({ clock });
  let active = 0;
  let maxConcurrent = 0;
  const job = async () => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
  };
  const a = s.enqueue('bot', job);
  const b = s.enqueue('bot', job);
  const c = s.enqueue('bot', job);
  await Promise.all([a, b, c]);
  assert.equal(maxConcurrent, 1);
});

test('different agents run independently', async () => {
  const clock = fakeClock();
  const s = new RunScheduler({ clock });
  const started = [];
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  s.enqueue('bot-a', async () => {
    started.push('a');
    await gate;
  });
  s.enqueue('bot-b', async () => started.push('b'));
  await tick();
  assert.deepEqual(started.sort(), ['a', 'b']);
  release();
});

test('watchdog trips after watchdogMs, then abandons the run after grace', async () => {
  const clock = fakeClock();
  const events = [];
  const s = new RunScheduler({
    clock,
    watchdogMs: 1000,
    watchdogGraceMs: 500,
    telemetry: { onWatchdog: (e) => events.push(e.stage) },
  });
  let releaseActive;
  const activeGate = new Promise((r) => {
    releaseActive = r;
  });
  s.enqueue('bot', async () => {
    await activeGate;
  });
  await tick();
  let ranAfterEscape = false;
  const second = s.enqueue('bot', async () => {
    ranAfterEscape = true;
  }, { lane: 'user' });

  clock.advance(1000);
  assert.ok(events.includes('trip'), 'watchdog must trip when a user turn waits too long');

  clock.advance(500);
  assert.ok(events.includes('escape'), 'grace must end in an escape, not a deadlock');
  // The enqueued promise resolves when the turn settles; it carries no value.
  await second;
  assert.equal(ranAfterEscape, true, 'the queued user turn actually ran after the escape');

  releaseActive();
  await tick();
  await tick();
  assert.ok(events.includes('late_settle'), 'the abandoned run settles late and is reported as such');
  s.dispose();
});

test('dispose cancels queued work instead of hanging', async () => {
  const clock = fakeClock();
  const s = new RunScheduler({ clock });
  let cancelled = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  s.enqueue('bot', async () => {
    await gate;
  });
  await tick();
  const queued = s.enqueue('bot', async () => 'never', { onCancelled: () => (cancelled += 1) });
  s.dispose();
  await queued;
  assert.equal(cancelled, 1);
  release();
});

test('diagnostics report lane depths and the active phase', async () => {
  const clock = fakeClock();
  const s = new RunScheduler({ clock });
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  s.enqueue('bot', async () => {
    await gate;
  });
  await tick();
  s.enqueue('bot', async () => {}, { lane: 'background' });
  s.enqueue('bot', async () => {}, { lane: 'user' });
  const [row] = s.getDiagnostics();
  assert.equal(row.agentId, 'bot');
  assert.equal(row.depthUser, 1);
  assert.equal(row.depthBackground, 1);
  assert.equal(row.active.lane, 'user');
  assert.equal(row.active.phase, 'running');
  release();
});

test('acceptance ledger persists an admitted prompt and answers lookups', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-accept-'));
  const ledger = new AcceptanceLedger(root);
  const admitted = ledger.record({ clientNonce: 'n1', prompt: 'hello', agentId: 'agent-1' });
  assert.equal(admitted.replayed, false);
  assert.equal(admitted.record.inputDigest, inputDigest('hello'));

  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'send-acceptance.json'), 'utf8'));
  assert.equal(onDisk.records.length, 1);
  assert.equal(onDisk.records[0].clientNonce, 'n1');
  assert.equal(onDisk.records[0].status, 'accepted');

  const found = ledger.lookup({ clientNonce: 'n1' });
  assert.equal(found.outcome, 'found');
  assert.equal(found.record.agentId, 'agent-1');

  const missing = ledger.lookup({ clientNonce: 'never-seen' });
  assert.equal(missing.outcome, 'not-found');

  fs.rmSync(root, { recursive: true, force: true });
});

test('a replayed nonce with different text is a conflict, not a second turn', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-accept2-'));
  const ledger = new AcceptanceLedger(root);
  ledger.record({ clientNonce: 'n1', prompt: 'original', agentId: 'agent-1' });
  const again = ledger.record({ clientNonce: 'n1', prompt: 'original', agentId: 'agent-1' });
  assert.equal(again.replayed, true);
  assert.equal(again.conflict, false);

  const conflict = ledger.record({ clientNonce: 'n1', prompt: 'different', agentId: 'agent-1' });
  assert.equal(conflict.replayed, true);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.rejectionCode, 'send/nonce-digest-mismatch');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a corrupt ledger degrades to unknown-durability, never a false not-found', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-accept3-'));
  fs.writeFileSync(path.join(root, 'send-acceptance.json'), '{not json');
  const ledger = new AcceptanceLedger(root);
  const lookup = ledger.lookup({ clientNonce: 'anything' });
  assert.equal(lookup.outcome, 'unknown-durability');
  const quarantined = fs.readdirSync(root).filter((f) => f.startsWith('send-acceptance.json.corrupt-'));
  assert.equal(quarantined.length, 1, 'the corrupt file is quarantined, not silently dropped');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a routine can carry a group of triggers and still fire on cron', async () => {
  const fs2 = fs;
  const root = fs2.mkdtempSync(path.join(os.tmpdir(), 'mgb-trig-'));
  const { createHost } = await import('../src/host.mjs');
  const host = createHost({ root });
  const agent = host.roster.create({ name: 'Trig Bot' });
  const routine = host.routines.create({
    agentId: agent.id,
    name: 'Multi',
    prompt: 'do it',
    trigger: {
      type: 'group',
      listeners: [
        { type: 'cron', schedule: '0 8 * * *' },
        { type: 'webhook', source: 'deploy' },
        { type: 'github', repo: 'acme/app', events: ['push'] },
      ],
    },
  });
  assert.equal(routine.trigger.listeners.length, 3);

  const at = new Date('2026-10-21T08:00:30+08:00');
  const fired = host.routines.tick(at, 'Asia/Shanghai');
  assert.ok(fired.some((f) => f.slug === 'multi'));

  // A webhook event fires the same routine through the non-cron path.
  const byHook = host.routines.fireExternal({ source: 'deploy' });
  assert.ok(byHook.some((f) => f.slug === 'multi'));

  // An unrelated source does not.
  const unrelated = host.routines.fireExternal({ source: 'something-else' });
  assert.equal(unrelated.length, 0);

  host.roster.closeStores();
  fs2.rmSync(root, { recursive: true, force: true });
});

test('an unrecognized trigger shape is refused, not silently stored', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-trig2-'));
  const { createHost } = await import('../src/host.mjs');
  const host = createHost({ root });
  const agent = host.roster.create({ name: 'Bad Trig' });
  assert.throws(
    () => host.routines.create({ agentId: agent.id, name: 'X', prompt: 'p', trigger: { type: 'nonsense' } }),
    /not a recognized shape/,
  );
  host.roster.closeStores();
  fs.rmSync(root, { recursive: true, force: true });
});

test('auto-review: three resolutions, standing always, and staleness', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-review-'));
  const { loadRules, saveRules, evaluate, resolve, StaleApprovalError } = await import('../src/review.mjs');

  // Ceilings take precedence over rules.
  saveRules(root, { version: 1, ceilings: { shell: 'NEVER' }, alwaysAllow: [], allowInstructions: [], blockInstructions: [] });
  assert.equal(evaluate({ root, tool: 'shell', command: 'ls' }).decision, 'deny');

  saveRules(root, { version: 1, ceilings: { shell: 'ALWAYS' }, alwaysAllow: [], allowInstructions: [], blockInstructions: [] });
  assert.equal(evaluate({ root, tool: 'shell', command: 'rm -rf /' }).decision, 'allow');

  // ASK is the default: block rules win over allow rules.
  saveRules(root, {
    version: 1,
    ceilings: { shell: 'ASK' },
    alwaysAllow: [],
    allowInstructions: ['shell:ls*'],
    blockInstructions: ['shell:rm*'],
  });
  assert.equal(evaluate({ root, tool: 'shell', command: 'ls -la' }).decision, 'allow');
  assert.equal(evaluate({ root, tool: 'shell', command: 'rm x' }).decision, 'deny');
  assert.equal(evaluate({ root, tool: 'shell', command: 'echo hi' }).decision, 'ask');

  // `always` persists a standing rule that later short-circuits to allow.
  const entry = {
    timestampMs: Date.now(),
    message: { type: 'auto-review-approval', approval: { requestId: 'r1', command: 'echo hi' } },
  };
  const outcome = resolve({ root, resolution: 'always', tool: 'shell', command: 'echo hi', entry, expectedRequestId: 'r1' });
  assert.equal(outcome.approved, true);
  assert.equal(outcome.standingRule, true);
  assert.equal(loadRules(root).alwaysAllow.length, 1);
  assert.equal(evaluate({ root, tool: 'shell', command: 'echo hi' }).decision, 'allow');

  // A settled card cannot be resolved again.
  const settled = {
    timestampMs: Date.now(),
    message: { type: 'auto-review-approval', approval: { requestId: 'r2' }, resolution: 'approved' },
  };
  assert.throws(
    () => resolve({ root, resolution: 'approved', tool: 'shell', command: 'x', entry: settled }),
    StaleApprovalError,
  );
  // Neither can a card whose request id no longer matches.
  assert.throws(
    () => resolve({ root, resolution: 'approved', tool: 'shell', command: 'x', entry, expectedRequestId: 'other' }),
    StaleApprovalError,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('pending approval cards are expired at startup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-expire-'));
  const { createHost } = await import('../src/host.mjs');
  const host = createHost({ root, seed: false });
  const agent = host.roster.create({ name: 'E Bot' });
  const store = host.roster.store(agent.id);
  store.appendEntry({
    kind: 'send-message',
    id: 'send-approval-1',
    message: { type: 'auto-review-approval', approval: { requestId: 'r1', command: 'echo x' }, resolution: null },
    timestampMs: Date.now(),
  });
  const expired = host.expirePendingApprovals();
  assert.equal(expired, 1);
  const after = store.getEntry('send-approval-1');
  assert.equal(after.message.resolution, 'expired');
  host.roster.closeStores();
  fs.rmSync(root, { recursive: true, force: true });
});

test('a card older than the 10-minute TTL is stale', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-ttl-'));
  const { resolve, isCardLive, StaleApprovalError, APPROVAL_TTL_MS } = await import('../src/review.mjs');
  assert.equal(APPROVAL_TTL_MS, 600_000);

  const old = {
    timestampMs: Date.now() - APPROVAL_TTL_MS - 1000,
    message: { type: 'auto-review-approval', approval: { requestId: 'r1', command: 'x' } },
  };
  assert.equal(isCardLive(old), false);
  assert.throws(
    () => resolve({ root, resolution: 'approved', tool: 'shell', command: 'x', entry: old }),
    StaleApprovalError,
  );

  const fresh = { timestampMs: Date.now(), message: { type: 'auto-review-approval', approval: { requestId: 'r2', command: 'x' } } };
  assert.equal(isCardLive(fresh), true);
  fs.rmSync(root, { recursive: true, force: true });
});
