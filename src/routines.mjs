// Routines (automations): a saved prompt + a cron schedule, one folder per routine.
//
// File format copied from the real harness so a box snapshot imports cleanly:
//   <agent>/automations/<slug>/automation.json
//     { name, prompt, schedule: "m h dom mon dow", enabled, provenance, createdAt, lastRunAt }
//   <agent>/automations/<slug>/runs.json
//     [{ id, trigger: "schedule"|"manual", startedAt, finishedAt, status, detail }]
//
// Execution model: a due routine admits a prompt into the agent's normal turn
// queue and its answer lands in the transcript. There is no separate execution
// path — that is the point, and it is why a routine result is auditable.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJsonAtomicLoose } from './paths.mjs';

const MAX_RUNS = 40;
const TRIGGER_MAX_GROUP_LISTENERS = 16;

// The deployed host parses trigger members of these types (parseTriggerMember).
// Only the ones that can be driven locally are executable here; the rest are
// accepted, stored, and reported as not-yet-wired rather than silently dropped.
export const TRIGGER_TYPES = [
  'cron',
  'webhook',
  'email',
  'slack',
  'github',
  'origin',
  'microsoftTeams',
  'linear',
  'sentry',
  'pagerduty',
];

// Triggers this host can actually fire on its own.
export const EXECUTABLE_TRIGGERS = new Set(['cron', 'webhook']);

export function normalizeTrigger(value) {
  // A group trigger groups several listeners: {type:"group", listeners:[...]}.
  if (Array.isArray(value)) return { type: 'group', listeners: value.map(normalizeMember).filter(Boolean) };
  if (!value || typeof value !== 'object') return null;
  if (value.type === 'group') {
    const listeners = (Array.isArray(value.listeners) ? value.listeners : [])
      .map(normalizeMember)
      .filter(Boolean)
      .slice(0, TRIGGER_MAX_GROUP_LISTENERS);
    return listeners.length ? { type: 'group', listeners } : null;
  }
  return normalizeMember(value);
}

function normalizeMember(member) {
  if (!member || typeof member !== 'object') return null;
  if (!TRIGGER_TYPES.includes(member.type)) return null;
  if (member.type === 'cron') {
    const schedule = typeof member.schedule === 'string' ? member.schedule.trim() : '';
    if (!/^\S+ \S+ \S+ \S+ \S+$/.test(schedule)) return null;
    return { type: 'cron', schedule, ...(member.chosen ? { chosen: member.chosen } : {}) };
  }
  // Non-cron members are stored as given; the local host cannot fire them yet.
  return { ...member };
}

export function triggerIdentity(trigger) {
  if (!trigger) return '';
  return trigger.type === 'cron' ? `cron:${trigger.schedule}` : JSON.stringify(trigger);
}

export function isExecutableTrigger(trigger) {
  if (!trigger) return false;
  if (trigger.type === 'group') return trigger.listeners.some((m) => EXECUTABLE_TRIGGERS.has(m.type));
  return EXECUTABLE_TRIGGERS.has(trigger.type);
}

export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'routine';
}

// Five-field cron matcher in a named time zone, no dependency.
export function cronMatches(schedule, date, timeZone) {
  const parts = String(schedule ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fields = cronFields(date, timeZone);
  return parts.every((expr, i) => fieldMatches(expr, fields[i]));
}

function cronFields(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    minute: '2-digit',
    hour: '2-digit',
    day: '2-digit',
    month: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return [
    Number(parts.minute),
    Number(parts.hour) % 24,
    Number(parts.day),
    Number(parts.month),
    weekdayMap[parts.weekday] ?? 0,
  ];
}

function fieldMatches(expr, value) {
  if (expr === '*') return true;
  for (const chunk of expr.split(',')) {
    const [range, stepRaw] = chunk.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo;
    let hi;
    if (range === '*') {
      lo = 0;
      hi = 59;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(range);
      hi = lo;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
    for (let v = lo; v <= hi; v += step) {
      if (v === value) return true;
    }
  }
  return false;
}

export class Routines {
  constructor({ p, roster, engine, log = () => {} }) {
    this.p = p;
    this.roster = roster;
    this.engine = engine;
    this.log = log;
    this.timer = null;
    this.lastTickMinute = new Map(); // slug -> "YYYY-MM-DDTHH:mm" fired marker
    this.pendingRuns = new Map(); // runId -> {agentId, slug}
  }

  dir(agentId, slug) {
    return path.join(this.p.agentAutomations(agentId), slug);
  }

  list(agentId) {
    const dir = this.p.agentAutomations(agentId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.read(agentId, d.name))
      .filter(Boolean);
  }

  read(agentId, slug) {
    const file = path.join(this.dir(agentId, slug), 'automation.json');
    const config = readJson(file, null);
    if (!config) return null;
    const runs = readJson(path.join(this.dir(agentId, slug), 'runs.json'), []) ?? [];
    return { slug, ...config, runs: runs.slice(0, MAX_RUNS) };
  }

  write(agentId, slug, config) {
    fs.mkdirSync(this.dir(agentId, slug), { recursive: true });
    writeJsonAtomicLoose(path.join(this.dir(agentId, slug), 'automation.json'), config);
    return this.read(agentId, slug);
  }

  // `schedule` is the cron shorthand; `trigger` accepts the full member shape
  // (including a group of listeners). Both serialize to automation.json.
  create({ agentId, name, prompt, schedule, trigger, enabled = true }) {
    if (!name || !prompt) throw new Error('routine needs name and prompt');
    let normalized;
    if (trigger !== undefined) {
      normalized = normalizeTrigger(trigger);
      if (!normalized) throw new Error('trigger is not a recognized shape (see TRIGGER_TYPES)');
    } else {
      normalized = normalizeTrigger({ type: 'cron', schedule });
      if (!normalized) throw new Error('schedule must be a five-field cron expression, e.g. "0 8 * * *"');
    }
    const slug = slugify(name);
    if (fs.existsSync(this.dir(agentId, slug))) throw new Error(`routine already exists: ${slug}`);
    const cronMember = normalized.type === 'cron' ? normalized : null;
    return this.write(agentId, slug, {
      name,
      prompt,
      ...(cronMember ? { schedule: cronMember.schedule } : {}),
      trigger: normalized,
      enabled,
      provenance: 'user',
      createdAt: Date.now(),
      lastRunAt: null,
    });
  }

  // Fire every routine whose trigger matches an inbound external event.
  // Webhook is the only non-cron trigger wired locally; it matches on `source`.
  fireExternal({ source, payload = null }) {
    const fired = [];
    for (const agent of this.roster.list()) {
      for (const routine of this.list(agent.id)) {
        if (routine.enabled === false) continue;
        const trigger = routine.trigger ?? (routine.schedule ? { type: 'cron', schedule: routine.schedule } : null);
        if (!trigger) continue;
        const members = trigger.type === 'group' ? trigger.listeners : [trigger];
        const hit = members.some(
          (m) => m.type === 'webhook' && (m.source == null || m.source === source),
        );
        if (!hit) continue;
        this.fire(agent.id, routine.slug, 'event', source);
        fired.push({ agentId: agent.id, slug: routine.slug, source });
      }
    }
    return fired;
  }

  update({ agentId, slug, patch }) {
    const current = this.read(agentId, slug);
    if (!current) throw new Error(`no such routine: ${slug}`);
    const { runs, slug: _slug, ...config } = current;
    return this.write(agentId, slug, { ...config, ...patch });
  }

  remove({ agentId, slug }) {
    const dir = this.dir(agentId, slug);
    if (!fs.existsSync(dir)) throw new Error(`no such routine: ${slug}`);
    fs.rmSync(dir, { recursive: true, force: true });
    return { removed: slug };
  }

  runNow({ agentId, slug }) {
    const routine = this.read(agentId, slug);
    if (!routine) throw new Error(`no such routine: ${slug}`);
    this.fire(agentId, slug, 'manual');
    return { fired: true, slug, trigger: 'manual' };
  }

  fire(agentId, slug, trigger, detail = null) {
    const routine = this.read(agentId, slug);
    if (!routine) return null;
    const runId = `run-${randomUUID()}`;
    const startedAt = Date.now();
    const acceptance = this.engine.admit({
      agentId,
      prompt: `[routine:${routine.name}] ${routine.prompt}`,
      clientNonce: runId,
      trigger: `routine:${trigger}`,
    });
    this.writeRun(agentId, slug, {
      id: runId,
      trigger,
      startedAt,
      finishedAt: null,
      status: 'running',
      ...(detail ? { detail } : {}),
    });
    this.update({ agentId, slug, patch: { lastRunAt: startedAt } });
    this.pendingRuns.set(runId, { agentId, slug, startedAt, trigger });
    this.log('routine.fire', { agentId, slug, trigger, runId });
    return { runId, acceptance };
  }

  // Bind the routine run records to real turn outcomes: a routine is only "ok"
  // once its turn actually finished. No polling, no invented status.
  observe(bus) {
    bus.subscribe((event) => {
      const runId = event.clientNonce;
      if (!runId) return;
      const pending = this.pendingRuns.get(runId);
      if (!pending) return;
      if (event.type === 'turn-end' || event.type === 'turn-error' || event.type === 'turn-interrupted') {
        const status = event.type === 'turn-end' ? 'ok' : event.type === 'turn-interrupted' ? 'error' : 'error';
        this.writeRun(pending.agentId, pending.slug, {
          id: runId,
          trigger: pending.trigger ?? 'schedule',
          startedAt: pending.startedAt,
          finishedAt: Date.now(),
          status,
          ...(event.type === 'turn-end' ? { detail: `${event.elapsedMs}ms` } : { detail: event.error ?? 'interrupted' }),
        });
        this.pendingRuns.delete(runId);
      }
    });
  }

  writeRun(agentId, slug, run) {
    const file = path.join(this.dir(agentId, slug), 'runs.json');
    const existing = readJson(file, []) ?? [];
    const next = [{ ...run }, ...existing.filter((r) => r.id !== run.id)].slice(0, MAX_RUNS);
    writeJsonAtomicLoose(file, next);
  }

  // One tick: fire every enabled routine whose cron matches this minute.
  tick(now = new Date(), timeZone = 'UTC') {
    const fired = [];
    const minute = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
    for (const agent of this.roster.list()) {
      for (const routine of this.list(agent.id)) {
        if (routine.enabled === false) continue;
        const trigger = routine.trigger ?? (routine.schedule ? { type: 'cron', schedule: routine.schedule } : null);
        const cronMembers =
          trigger == null
            ? []
            : trigger.type === 'group'
              ? trigger.listeners.filter((m) => m.type === 'cron')
              : trigger.type === 'cron'
                ? [trigger]
                : [];
        if (!cronMembers.some((m) => cronMatches(m.schedule, now, timeZone))) continue;
        const key = `${agent.id}:${routine.slug}`;
        if (this.lastTickMinute.get(key) === minute) continue;
        this.lastTickMinute.set(key, minute);
        this.fire(agent.id, routine.slug, 'schedule');
        fired.push({ agentId: agent.id, slug: routine.slug });
      }
    }
    return fired;
  }

  start({ intervalMs = 30_000, timeZone = 'UTC' } = {}) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick(new Date(), timeZone);
      } catch (err) {
        this.log('routine.tick.error', { error: String(err.message) });
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
