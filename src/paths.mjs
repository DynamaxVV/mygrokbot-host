// Path resolution for the MyGrokbot data root.
//
// Mirrors the layout the real Grok Bot cloud host uses under /home/box/sand-data
// so that a snapshot taken from a box can be dropped in and mostly understood:
//
//   <root>/gateway.json              discovery file: {port,pid,startedAt,scheme,host,token}
//   <root>/host-secrets.json         {machineId}
//   <root>/host.lock                 pid of the owning host
//   <root>/settings.json             host settings (account scopes, review policy, tz)
//   <root>/agents/active-agent.json  {"activeAgentId": "..."}
//   <root>/agents/<uuid>/profile.json
//   <root>/agents/<uuid>/settings.json
//   <root>/agents/<uuid>/store.db    kv | blobs | transcript_entries | automation_completion_inbox
//   <root>/agents/<uuid>/memory/profile.md
//   <root>/agents/<uuid>/memory/log/*.md
//   <root>/agents/<uuid>/automations/<slug>/automation.json
//   <root>/agents/<uuid>/attachments/
//   <root>/agents/<uuid>/assets/
//   <root>/workspace/                ONE shared workspace, like the box's /workspace
//   <root>/managed-skills/cache.json  + managed-skills/skills/<slug>/SKILL.md
//   <root>/plugin-skills/cache.json
//   <root>/logs/*.jsonl
//   <root>/search-index.db
//   <root>/secrets/

import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const DATA_ROOT_ENV = 'MGB_DATA_ROOT';
export const DEFAULT_DIRNAME = '.mygrokbot';

export function resolveDataRoot(env = process.env) {
  const override = env[DATA_ROOT_ENV]?.trim();
  if (override && path.isAbsolute(override)) return override;
  return path.join(env.MGB_HOME || homedir(), DEFAULT_DIRNAME);
}

export function paths(root = resolveDataRoot()) {
  const agents = path.join(root, 'agents');
  return {
    root,
    agents,
    activeAgent: path.join(agents, 'active-agent.json'),
    gateway: path.join(root, 'gateway.json'),
    hostSecrets: path.join(root, 'host-secrets.json'),
    hostLock: path.join(root, 'host.lock'),
    settings: path.join(root, 'settings.json'),
    featureFlags: path.join(root, 'sand-feature-flag-overrides.json'),
    managedSkills: path.join(root, 'managed-skills'),
    managedSkillsCache: path.join(root, 'managed-skills', 'cache.json'),
    managedSkillsDir: path.join(root, 'managed-skills', 'skills'),
    pluginSkillsCache: path.join(root, 'plugin-skills', 'cache.json'),
    logs: path.join(root, 'logs'),
    searchIndex: path.join(root, 'search-index.db'),
    secrets: path.join(root, 'secrets'),
    ui: path.join(root, 'ui'),
    // per-agent
    agentDir: (id) => path.join(agents, id),
    agentProfile: (id) => path.join(agents, id, 'profile.json'),
    agentSettings: (id) => path.join(agents, id, 'settings.json'),
    agentStore: (id) => path.join(agents, id, 'store.db'),
    agentMemory: (id) => path.join(agents, id, 'memory'),
    agentMemoryProfile: (id) => path.join(agents, id, 'memory', 'profile.md'),
    agentMemoryLog: (id) => path.join(agents, id, 'memory', 'log'),
    agentAutomations: (id) => path.join(agents, id, 'automations'),
    agentAttachments: (id) => path.join(agents, id, 'attachments'),
    agentAssets: (id) => path.join(agents, id, 'assets'),
    // The real box runs every agent against a single /workspace: exec-daemon logs
    // `workspacePaths:["/workspace"]` and projectDir /home/box/.cursor/projects/workspace.
    // Agent directories hold state, not working trees. Per-agent "workspaces" are a
    // fiction, and a dangerous one: they imply isolation that does not exist.
    workspace: path.join(root, 'workspace'),
    workspaceUploads: path.join(root, 'workspace', 'uploads'),
  };
}

export function ensureDirs(p) {
  for (const dir of [p.root, p.agents, p.managedSkillsDir, p.logs, p.secrets, p.workspace, p.workspaceUploads]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function ensureAgentDirs(p, id) {
  for (const dir of [
    p.agentDir(id),
    p.agentMemory(id),
    p.agentMemoryLog(id),
    p.agentAutomations(id),
    p.agentAttachments(id),
    p.agentAssets(id),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeJsonAtomicLoose(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}
