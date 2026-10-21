// Host assembly: everything wired once, so CLI and tests build the same object.
//
// This is the equivalent of the real SandHost: it owns the data root, the roster,
// the skill catalog, the tool runtime, the turn engine, routines, and the gateway.
// Nothing here talks to a cloud service — the only outbound call is the provider
// you bind per agent.

import fs from 'node:fs';
import path from 'node:path';
import { EventBus } from './bus.mjs';
import { Roster } from './roster.mjs';
import { SkillCatalog, SEED_SKILLS } from './skills.mjs';
import { ToolRuntime } from './tools.mjs';
import { TurnEngine } from './engine.mjs';
import { Routines } from './routines.mjs';
import { RoomTurns } from './room.mjs';
import { ServerAgentProxy, createLocalTemporalTransport } from './proxy.mjs';
import { createGateway } from './gateway.mjs';
import { setAgentBinding } from './providers/bindings.mjs';
import { expireAllPending } from './review.mjs';
import { ensureDirs, paths, readJson, resolveDataRoot, writeJson } from './paths.mjs';

const DEFAULT_SETTINGS = {
  version: 1,
  // The operator's language, used for the UI and for what the bot writes into memory.
  // Existing settings files keep working: resolveLanguage() falls back to 'zh'.
  language: 'zh',
  userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  notifications: { isEnabled: true },
  messagesEnabled: true,
  autoReviewInstructions: { isEnabled: true, allowInstructions: [], blockInstructions: [] },
  botColorInChatEnabled: true,
  egressTunnelEnabled: false,
};

export function createHost({ root = resolveDataRoot(), env = process.env, log = () => {}, seed = true } = {}) {
  const p = paths(root);
  ensureDirs(p);

  if (!fs.existsSync(p.settings)) writeJson(p.settings, DEFAULT_SETTINGS);
  if (!fs.existsSync(p.hostSecrets)) writeJson(p.hostSecrets, { machineId: crypto.randomUUID() });

  const roster = new Roster(p);
  const catalog = new SkillCatalog(p);
  if (seed && !fs.existsSync(p.managedSkillsCache)) {
    for (const skill of SEED_SKILLS) {
      const dir = path.join(p.managedSkillsDir, skill.slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${skill.name}\ndescription: >-\n  ${skill.description}\n---\n${skill.body}\n`,
        'utf8',
      );
    }
    catalog.refresh();
  }

  const bus = new EventBus();
  const tools = new ToolRuntime({ p, roster, root, env });
  const engine = new TurnEngine({ p, roster, catalog, tools, bus, log });
  engine.hostSettings = () => readJson(p.settings, DEFAULT_SETTINGS) ?? DEFAULT_SETTINGS;
  // A bot calling message_user speaks to the operator through the engine, which owns
  // both the transcript store and the event bus.
  tools.onMessageUser = (args) => engine.messageUser(args);

  // A temporal agent's turns belong to the server; this transport answers with the
  // same envelope so the routing can be exercised. Swap it for a real client and the
  // gateway path does not change.
  const proxy = new ServerAgentProxy({
    roster,
    transport: createLocalTemporalTransport({ engine, roster, log }),
    log,
  });
  const routines = new Routines({ p, roster, engine, log });
  routines.observe(bus);
  const rooms = new RoomTurns({ roster, engine, bus, proxy, log });
  const gateway = createGateway({ p, roster, catalog, engine, tools, bus, routines, rooms, proxy, log });

  return {
    p,
    root,
    env,
    roster,
    catalog,
    tools,
    bus,
    engine,
    routines,
    rooms,
    proxy,
    gateway,
    log,
    hostSettings: () => readJson(p.settings, DEFAULT_SETTINGS) ?? DEFAULT_SETTINGS,
    // Startup: cards left pending by a previous process have no live resolver, so
    // they are expired rather than left clickable.
    expirePendingApprovals() {
      return expireAllPending({ roster, bus });
    },
    async listen(opts = {}) {
      const token = opts.token ?? readJson(p.gateway, {})?.token ?? null;
      const expired = expireAllPending({ roster, bus });
      if (expired > 0) log('approvals.expired', { count: expired });
      const discovery = await gateway.listen({ ...opts, token });
      const tz = (readJson(p.settings, DEFAULT_SETTINGS) ?? DEFAULT_SETTINGS).userTimeZone ?? 'UTC';
      routines.start({ timeZone: tz });
      return discovery;
    },
    async close() {
      routines.stop();
      await gateway.close();
      roster.closeStores();
    },
  };
}

// First-run bootstrap: one bot that is useful immediately, plus a written config.
export function bootstrap({ root = resolveDataRoot(), botName = 'Main Bot', model = null, baseUrl = null, apiKeyEnv = null } = {}) {
  const host = createHost({ root });
  let agents = host.roster.list();
  if (!agents.length) {
    agents = [
      host.roster.create({
        name: botName,
        description: 'Coordinates the other bots and takes the work you hand it directly.',
        title: 'Chief of staff',
        avatarColor: 'green',
      }),
    ];
  }
  if (model) {
    const patch = { modelId: model };
    if (baseUrl) patch.baseUrl = baseUrl;
    if (apiKeyEnv) patch.apiKeyEnv = apiKeyEnv;
    for (const agent of agents) setAgentBinding(host.root, agent.id, patch);
  }
  return host;
}
