// Agent roster: profile.json + settings.json + store.db + memory/ + automations/
// One directory per agent uuid under <root>/agents/. This is the same shape the
// real sand-host uses, including the active-agent.json pointer.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureAgentDirs, readJson, writeJson } from './paths.mjs';
import { openAgentStore } from './db.mjs';

export const DEFAULT_PROFILE = {
  name: 'New Bot',
  description: '有自己的一台电脑，可以把活从你手上接过去。',
  title: '',
  avatarShape: 'blob',
  avatarColor: 'blue',
  namedBy: 'user',
  harness: 'local',
};

export const DEFAULT_AGENT_SETTINGS = {
  notifyOnAgentUpdates: true,
  hiddenFromSidebar: false,
  draftingDisabled: false,
};

export class Roster {
  constructor(p) {
    this.p = p;
    this._stores = new Map();
  }

  list() {
    if (!fs.existsSync(this.p.agents)) return [];
    return fs
      .readdirSync(this.p.agents, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[0-9a-f-]{36}$/i.test(d.name))
      .map((d) => this.summary(d.name))
      .filter(Boolean)
      .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
  }

  exists(id) {
    return fs.existsSync(this.p.agentProfile(id));
  }

  profile(id) {
    return readJson(this.p.agentProfile(id), null);
  }

  settings(id) {
    return { ...DEFAULT_AGENT_SETTINGS, ...(readJson(this.p.agentSettings(id), {}) ?? {}) };
  }

  summary(id) {
    const profile = this.profile(id);
    if (!profile) return null;
    const store = this.store(id);
    const metadata = store.getKV('metadata', {}) ?? {};
    const entries = store.readWindow({ limit: 1 });
    const last = entries[0] ?? null;
    return {
      id,
      name: profile.name,
      isGroup: profile.isGroup === true,
      ...(profile.isGroup === true ? { memberIds: this.groupMembers(id) } : {}),
      description: profile.description ?? '',
      title: profile.title ?? '',
      avatarShape: profile.avatarShape ?? '',
      avatarColor: profile.avatarColor ?? '',
      harness: profile.harness ?? 'local',
      createdAtMs: metadata.createdAtMs ?? fs.statSync(this.p.agentDir(id)).birthtimeMs,
      lastActivityMs: last?.timestampMs ?? metadata.createdAtMs ?? 0,
      settings: this.settings(id),
    };
  }

  store(id) {
    let store = this._stores.get(id);
    if (!store) {
      ensureAgentDirs(this.p, id);
      store = openAgentStore(this.p.agentStore(id));
      this._stores.set(id, store);
    }
    return store;
  }

  closeStores() {
    for (const store of this._stores.values()) store.close();
    this._stores.clear();
  }

  // harness: "local" (runs here), "temporal" (server-hosted, refuses locally),
  // or "box" (retired local path). Kept explicit so route() can answer honestly.
  // A group is a roster entry with isGroup + memberIds, matching the real host's
  // group.json shape ({version, memberIds}) stored beside profile.json.
  createGroup({ name, description = '', memberAgentIds = [], id = randomUUID() } = {}) {
    if (!name) throw new Error('group needs a name');
    const members = [...new Set(memberAgentIds)];
    for (const m of members) {
      if (!this.exists(m)) throw new Error(`no such member: ${m}`);
    }
    ensureAgentDirs(this.p, id);
    const profile = {
      ...DEFAULT_PROFILE,
      name,
      description,
      isGroup: true,
      avatarShape: 'hex',
      avatarColor: 'violet',
    };
    writeJson(this.p.agentProfile(id), profile);
    writeJson(this.p.agentSettings(id), DEFAULT_AGENT_SETTINGS);
    writeJson(path.join(this.p.agentDir(id), 'group.json'), { version: 1, memberIds: members });
    const store = this.store(id);
    store.setKV('metadata', { agentId: id, name, isGroup: true, createdAtMs: Date.now(), mode: 'local' });
    store.appendEntry({
      kind: 'event',
      id: `event-${randomUUID()}`,
      event: { type: 'created', by: 'user', isGroup: true, members },
      timestampMs: Date.now(),
    });
    return this.summary(id);
  }

  groupMembers(id) {
    return readJson(path.join(this.p.agentDir(id), 'group.json'), { memberIds: [] })?.memberIds ?? [];
  }

  setGroupMembers(id, memberAgentIds) {
    const members = [...new Set(memberAgentIds)];
    for (const m of members) {
      if (!this.exists(m)) throw new Error(`no such member: ${m}`);
    }
    fs.mkdirSync(this.p.agentDir(id), { recursive: true });
    writeJson(path.join(this.p.agentDir(id), 'group.json'), { version: 1, memberIds: members });
    return { id, memberIds: members };
  }

  create(profileInput = {}, { id = randomUUID(), activate = true } = {}) {
    const profile = { ...DEFAULT_PROFILE, ...profileInput };
    ensureAgentDirs(this.p, id);
    writeJson(this.p.agentProfile(id), profile);
    writeJson(this.p.agentSettings(id), DEFAULT_AGENT_SETTINGS);
    fs.writeFileSync(this.p.agentMemoryProfile(id), `# ${profile.name}\n\n`, 'utf8');
    const store = this.store(id);
    store.setKV('metadata', {
      agentId: id,
      name: profile.name,
      latestRootBlobId: '',
      mode: 'local',
      createdAtMs: Date.now(),
    });
    store.setKV('hiddenEntryRepairVersion', 1);
    store.appendEntry({
      kind: 'event',
      id: `event-${randomUUID()}`,
      event: { type: 'created', by: profile.namedBy ?? 'user' },
      timestampMs: Date.now(),
    });
    if (activate) this.setActive(id);
    return this.summary(id);
  }

  update(id, patch) {
    const profile = this.profile(id);
    if (!profile) throw new Error(`no such agent: ${id}`);
    const next = { ...profile, ...patch };
    writeJson(this.p.agentProfile(id), next);
    const store = this.store(id);
    const metadata = store.getKV('metadata', {}) ?? {};
    store.setKV('metadata', { ...metadata, name: next.name });
    if (patch.name && patch.name !== profile.name) {
      store.appendEntry({
        kind: 'event',
        id: `event-${randomUUID()}`,
        event: { type: 'name-changed', from: profile.name, to: next.name },
        timestampMs: Date.now(),
      });
    }
    return this.summary(id);
  }

  updateSettings(id, patch) {
    const next = { ...this.settings(id), ...patch };
    writeJson(this.p.agentSettings(id), next);
    return next;
  }

  delete(id) {
    const store = this._stores.get(id);
    if (store) {
      store.close();
      this._stores.delete(id);
    }
    fs.rmSync(this.p.agentDir(id), { recursive: true, force: true });
    if (this.activeId() === id) {
      const remaining = this.list();
      if (remaining[0]) this.setActive(remaining[0].id);
      else fs.rmSync(this.p.activeAgent, { force: true });
    }
    return { deleted: id };
  }

  activeId() {
    return readJson(this.p.activeAgent, {})?.activeAgentId ?? this.list()[0]?.id ?? null;
  }

  setActive(id) {
    writeJson(this.p.activeAgent, { activeAgentId: id });
    return id;
  }

  resolve(ref) {
    if (!ref) return this.activeId();
    if (this.exists(ref)) return ref;

    const all = this.list();
    const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const key = norm(ref);
    // "Nas Bot" and "nas" and "nasbot" must be the same bot: models address each other
    // by whatever short name they remember, and an exact-match rule dropped those calls.
    const squash = (v) => norm(v).replace(/[\s_-]+/g, '');
    const sq = squash(ref);

    // 1. exact name, case/space-insensitive
    const exact = all.filter((a) => norm(a.name) === key);
    if (exact.length === 1) return exact[0].id;

    // 2. name with spaces/punctuation removed ("nasbot" -> "Nas Bot")
    const squashed = all.filter((a) => squash(a.name) === sq);
    if (squashed.length === 1) return squashed[0].id;

    // 3. the whole reference appears in the name, or the name appears in it
    const contains = all.filter((a) => {
      const n = squash(a.name);
      return n.includes(sq) || sq.includes(n);
    });
    if (contains.length === 1) return contains[0].id;

    // 4. id prefix
    const prefix = all.filter((a) => a.id.startsWith(ref));
    if (prefix.length === 1) return prefix[0].id;

    // Ambiguous or unknown: report the candidates so the model can correct itself
    // instead of silently messaging the wrong bot.
    if (contains.length > 1) {
      throw new Error(
        `ambiguous agent: ${ref} matches ${contains.map((a) => a.name).join(', ')}`,
      );
    }
    throw new Error(`cannot resolve agent: ${ref}`);
  }

  // ---- memory -----------------------------------------------------------
  readMemory(id) {
    const file = this.p.agentMemoryProfile(id);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }

  // Replace the profile memory file outright — the editable view in the UI writes here.
  // Kept separate from appendMemory so the append-only log stays append-only.
  writeMemory(id, text) {
    const file = this.p.agentMemoryProfile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = String(text ?? '');
    fs.writeFileSync(file, body, 'utf8');
    return file;
  }

  appendMemory(id, text, { kind = 'note' } = {}) {
    const stamp = new Date().toISOString();
    const file = kind === 'profile' ? this.p.agentMemoryProfile(id) : this.logFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `\n- [${kind}] ${stamp} ${text.trim()}\n`, 'utf8');
    return file;
  }

  logFile(id) {
    const dir = this.p.agentMemoryLog(id);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${new Date().toISOString().slice(0, 10)}.md`);
  }

  readMemoryAll(id) {
    const parts = [this.readMemory(id)];
    const logDir = this.p.agentMemoryLog(id);
    if (fs.existsSync(logDir)) {
      for (const f of fs.readdirSync(logDir).sort()) {
        if (f.endsWith('.md')) parts.push(fs.readFileSync(path.join(logDir, f), 'utf8'));
      }
    }
    return parts.filter(Boolean).join('\n');
  }
}
