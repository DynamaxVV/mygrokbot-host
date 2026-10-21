// Unit tests: provider maps, cron matching, bindings, skills, and importing a
// real sand-data snapshot exported from a cloud box.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyProviderReasoningControls, routeNameForModel, param } from '../src/providers/maps.mjs';
import { cronMatches, slugify } from '../src/routines.mjs';
import { resolveBinding, setAgentBinding, removeAgentBinding, loadBindings } from '../src/providers/bindings.mjs';
import { parseFrontmatter } from '../src/skills.mjs';
import { createHost } from '../src/host.mjs';

test('grok map: maxMode wins, then fast, then effort', () => {
  const body = {};
  assert.equal(applyProviderReasoningControls(body, { modelId: 'grok-4.6', maxMode: true }), 'grok');
  assert.equal(body.reasoning_effort, 'xhigh');

  const body2 = {};
  applyProviderReasoningControls(body2, { modelId: 'grok-4.6', parameters: [{ id: 'effort', value: 'max' }] });
  assert.equal(body2.reasoning_effort, 'xhigh');

  const body3 = {};
  applyProviderReasoningControls(body3, {
    modelId: 'grok-4.6',
    maxMode: true,
    parameters: [{ id: 'fast', value: true }],
  });
  assert.equal(body3.reasoning_effort, 'xhigh', 'maxMode outranks fast');

  const body4 = {};
  applyProviderReasoningControls(body4, { modelId: 'grok-4.6', parameters: [{ id: 'fast', value: true }] });
  assert.equal(body4.reasoning_effort, 'low');
});

test('unknown provider is an explicit no-op, never a guess', () => {
  const body = { model: 'some-local-model' };
  assert.equal(applyProviderReasoningControls(body, { modelId: 'some-local-model' }), 'none');
  assert.deepEqual(body, { model: 'some-local-model' });
});

test('deepseek thinking fills defaults but never overwrites the caller', () => {
  const body = { thinking: { type: 'enabled' }, max_tokens: 1024 };
  applyProviderReasoningControls(body, { modelId: 'deepseek-v4', parameters: [{ id: 'thinking', value: true }] });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.max_tokens, 1024, 'explicit max_tokens survives');
});

test('qwen honours an explicit thinking=false', () => {
  const body = {};
  applyProviderReasoningControls(body, { modelId: 'qwen3-max', parameters: [{ id: 'thinking', value: false }] });
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
});

test('gemini slug rewrite only touches the verified tiered family', () => {
  const body = { model: 'gemini-3.6-flash' };
  applyProviderReasoningControls(body, { modelId: 'gemini-3.6-flash', parameters: [{ id: 'effort', value: 'max' }] });
  assert.equal(body.model, 'gemini-3.6-flash-high');

  const other = { model: 'gemini-3.7-pro' };
  applyProviderReasoningControls(other, { modelId: 'gemini-3.7-pro', parameters: [{ id: 'effort', value: 'max' }] });
  assert.equal(other.model, 'gemini-3.7-pro');
});

test('route labels are stable', () => {
  assert.equal(routeNameForModel('grok-4.6'), 'grok');
  assert.equal(routeNameForModel('claude-opus-5.5'), 'claude');
  assert.equal(routeNameForModel('glm-5.3-flash'), 'glm');
  assert.equal(routeNameForModel('gpt-5.2'), 'openai');
  assert.equal(routeNameForModel('weird'), 'openai-compatible');
});

test('param helper finds values and tolerates junk', () => {
  assert.equal(param([{ id: 'effort', value: 'high' }], 'effort'), 'high');
  assert.equal(param(null, 'effort'), undefined);
  assert.equal(param([null, { id: 'x' }], 'effort'), undefined);
});

test('cron matcher handles steps, lists, ranges and weekday', () => {
  const date = new Date('2026-10-21T08:00:00+08:00'); // Wednesday
  assert.equal(cronMatches('0 8 * * *', date, 'Asia/Shanghai'), true);
  assert.equal(cronMatches('1 8 * * *', date, 'Asia/Shanghai'), false);
  assert.equal(cronMatches('*/15 * * * *', new Date('2026-10-21T08:45:00+08:00'), 'Asia/Shanghai'), true);
  assert.equal(cronMatches('0 8 * * 3', date, 'Asia/Shanghai'), true);
  assert.equal(cronMatches('0 8 * * 1', date, 'Asia/Shanghai'), false);
  assert.equal(cronMatches('0 8 21 10 *', date, 'Asia/Shanghai'), true);
  assert.equal(cronMatches('0 0 * * *', date, 'UTC'), true, 'same instant, other zone');
  assert.equal(cronMatches('bogus', date, 'Asia/Shanghai'), false);
});

test('slugify produces stable folder names', () => {
  assert.equal(slugify('Daily Digest 08:08'), 'daily-digest-08-08');
  assert.equal(slugify('!!!'), 'routine');
});

test('bindings merge default + agent, key comes from env only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-bind-'));
  const env = { MY_KEY: 'sk-test' };
  setAgentBinding(root, 'agent-1', { modelId: 'grok-4.6', baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'MY_KEY' });
  const binding = resolveBinding(root, 'agent-1', env);
  assert.equal(binding.modelId, 'grok-4.6');
  assert.equal(binding.apiKey, 'sk-test');
  assert.equal(binding.bound, true);

  const raw = loadBindings(root);
  assert.equal(JSON.stringify(raw).includes('sk-test'), false, 'the key never lands in the binding file');

  removeAgentBinding(root, 'agent-1');
  assert.equal(loadBindings(root).agents['agent-1'], undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('frontmatter parser keeps the body intact', () => {
  const { attributes, body } = parseFrontmatter('---\nname: demo\ndescription: >-\n  a test skill\n---\n# Body\n\ntext\n');
  assert.equal(attributes.name, 'demo');
  assert.match(attributes.description, /a test skill/);
  assert.match(body, /^# Body/);
});

test('host seeds a skill catalog on first run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-host-'));
  const host = createHost({ root });
  const skills = host.catalog.list();
  assert.ok(skills.length >= 5);
  const routines = host.catalog.get('routines');
  assert.ok(routines.body.length > 100);
  host.roster.closeStores();
  fs.rmSync(root, { recursive: true, force: true });
});

test('routine folder layout matches the harness format', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-routine-'));
  const host = createHost({ root });
  const agent = host.roster.create({ name: 'R Bot' });
  const routine = host.routines.create({
    agentId: agent.id,
    name: 'Daily Digest',
    prompt: 'Summarize yesterday.',
    schedule: '0 8 * * *',
  });
  const file = path.join(root, 'agents', agent.id, 'automations', routine.slug, 'automation.json');
  assert.ok(fs.existsSync(file));
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(config.name, 'Daily Digest');
  assert.equal(config.schedule, '0 8 * * *');
  assert.equal(config.enabled, true);
  assert.equal(config.provenance, 'user');
  host.roster.closeStores();
  fs.rmSync(root, { recursive: true, force: true });
});

// Import a real box snapshot: the layout the host writes must be readable as-is.
test('imports a sand-data snapshot exported from a cloud box', (t) => {
  const snapshot = '/Users/vv/Code/opengrok/.staging/sand-d/sand-data';
  if (!fs.existsSync(snapshot)) {
    t.skip('snapshot not staged');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-import-'));
  fs.cpSync(snapshot, root, { recursive: true, filter: (src) => !src.includes('/plugins/cache/') });

  const host = createHost({ root, seed: false });
  const agents = host.roster.list();
  assert.ok(agents.length >= 8, `expected the snapshot roster, got ${agents.length}`);
  const names = agents.map((a) => a.name).sort();
  assert.ok(names.includes('Nas Bot'));
  assert.ok(names.includes('vv Bot'));

  const active = host.roster.activeId();
  assert.equal(active, '04d7a890-b621-45ec-9e57-b16ddf16ce5c'.replace('b16ddf16ce5c', 'b16ddf26ce5c'));

  // The snapshot's own history is preserved: name-change events still read back.
  const bot = agents.find((a) => a.name === 'Nas Bot');
  const entries = host.roster.store(bot.id).readAll();
  assert.ok(entries.some((e) => e.event?.type === 'name-changed'));

  // Mem, ok: memory files written by the box are visible through the roster API.
  const memory = host.roster.readMemoryAll('08de04be-d9b6-439a-9685-fa6de5f46eb6');
  assert.equal(typeof memory, 'string');

  host.roster.closeStores();
  fs.rmSync(root, { recursive: true, force: true });
});

test('switching model keeps the endpoint', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-bind2-'));
  setAgentBinding(root, 'a', { modelId: 'workbuddy/hy3', baseUrl: 'http://192.168.49.201:3425/v1' });
  setAgentBinding(root, 'a', { modelId: 'auto/glm-5.3' });
  const b = resolveBinding(root, 'a', {});
  assert.equal(b.modelId, 'auto/glm-5.3');
  assert.equal(b.baseUrl, 'http://192.168.49.201:3425/v1', 'the endpoint is a setting, not a cache');
  fs.rmSync(root, { recursive: true, force: true });
});

test('agent names resolve case- and space-insensitively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgb-resolve-'));
  const host = createHost({ root, seed: false });
  const { roster } = host;
  const nas = roster.create({ name: 'Nas Bot' });
  roster.create({ name: 'Github Bot' });
  for (const ref of ['Nas Bot', 'nas bot', 'nas', 'NAS', 'nasbot', ' nAsBoT ']) {
    assert.equal(roster.resolve(ref), nas.id, `${ref} should resolve to Nas Bot`);
  }
  assert.equal(roster.resolve(nas.id.slice(0, 8)), nas.id);
  assert.throws(() => roster.resolve('nothing-here'), /cannot resolve agent/);
  roster.closeStores();
  fs.rmSync(root, { recursive: true, force: true });
});
