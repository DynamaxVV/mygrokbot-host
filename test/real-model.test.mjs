// Opt-in real-model check. Skipped unless MGB_REAL_BASE / MGB_REAL_KEY are set, so the
// default suite stays offline and deterministic.
//
//   MGB_REAL_BASE=http://192.168.49.201:3425/v1 MGB_REAL_MODEL=workbuddy/hy3 \
//   MGB_REAL_KEY=... node --test test/real-model.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHost } from '../src/host.mjs';
import { setAgentBinding } from '../src/providers/bindings.mjs';
import { loadRules, saveRules } from '../src/review.mjs';

const BASE = process.env.MGB_REAL_BASE;
const KEY = process.env.MGB_REAL_KEY;
const MODEL = process.env.MGB_REAL_MODEL ?? 'workbuddy/hy3';
const live = Boolean(BASE && KEY);

function makeHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-real-'));
  process.env.MGB_REAL_KEY_ENV = KEY;
  const host = createHost({ root, seed: false });
  const bot = host.roster.create({ name: 'Real Bot' });
  setAgentBinding(root, bot.id, { modelId: MODEL, baseUrl: BASE, apiKeyEnv: 'MGB_REAL_KEY_ENV' });
  return { host, bot, root };
}

async function until(host, nonce, states, ms = 180_000) {
  const t0 = Date.now();
  for (;;) {
    const st = host.engine.acceptanceStatus(nonce);
    if (states.includes(st.state)) return st;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${states}, last=${st.state}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

test('a real turn streams reasoning and text', { skip: !live && 'MGB_REAL_BASE/MGB_REAL_KEY not set' }, async () => {
  const { host, bot, root } = makeHost();
  try {
    const acc = host.engine.admit({ agentId: bot.id, prompt: 'Reply with exactly: LIVE-OK' });
    const final = await until(host, acc.clientNonce, ['done', 'error']);
    assert.equal(final.state, 'done');
    assert.ok(final.usage?.total_tokens > 0, 'the provider reported usage');

    const rows = host.roster.store(bot.id).readAll();
    const reply = rows.find((e) => e.kind === 'send-message');
    assert.match(String(reply.message.content), /LIVE-OK/);
    assert.ok(rows.some((e) => e.kind === 'reasoning'), 'reasoning_content is persisted');
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a real turn calls a tool and reports its output', { skip: !live && 'no real endpoint' }, async () => {
  const { host, bot, root } = makeHost();
  try {
    host.tools.setPolicy({ autoApprove: true });
    saveRules(root, { ...loadRules(root), ceilings: { shell: 'ALWAYS' } });
    const acc = host.engine.admit({
      agentId: bot.id,
      prompt: 'Run the shell command `echo live-tool` and report its exact output.',
    });
    await until(host, acc.clientNonce, ['done', 'error']);

    const outline = host.engine;
    const rows = host.roster.store(bot.id).readAll();
    const call = rows.find((e) => e.kind === 'tool-call');
    const result = rows.find((e) => e.kind === 'tool-result');
    assert.equal(call?.name, 'shell');
    assert.match(String(result?.result), /live-tool/);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a real turn parks on approval and resumes after it', { skip: !live && 'no real endpoint' }, async () => {
  const { host, bot, root } = makeHost();
  try {
    host.tools.setPolicy({ autoApprove: false, deny: [] });
    saveRules(root, {
      ...loadRules(root),
      isEnabled: true,
      ceilings: { shell: 'ASK' },
      allowInstructions: [],
      blockInstructions: [],
      alwaysAllow: [],
    });
    const acc = host.engine.admit({ agentId: bot.id, prompt: 'Run `echo live-approval` and report the output.' });
    const parked = await until(host, acc.clientNonce, ['awaiting-approval', 'error']);
    assert.equal(parked.state, 'awaiting-approval');

    const out = await host.engine.resolveApproval({
      agentId: bot.id,
      entryId: parked.approvalEntryId,
      resolution: 'approved',
    });
    assert.equal(out.resumed, true);
    await until(host, out.clientNonce, ['done', 'error']);
    assert.deepEqual(host.engine.pendingEntryIds(bot.id), []);
  } finally {
    await host.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
