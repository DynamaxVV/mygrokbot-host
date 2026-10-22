// mgb — the operator CLI.
//
//   mgb doctor                       check the data root, bindings, skills, gateway
//   mgb serve [--port N] [--token T] [--no-token]
//   mgb init [--bot "Main Bot"] [--model ...] [--base-url ...] [--key-env ...]
//   mgb agents [ls|new|rm|use|show]
//   mgb prompt <agent> <text>        send a prompt, stream the answer to stdout
//   mgb tail <agent> [--limit N]
//   mgb memory <agent> [--read|--append TEXT]
//   mgb skill [ls|install|rm]
//   mgb routine [ls|add|rm|run] <agent>
//   mgb bind <agent> --model ... [--base-url ...] [--key-env ...] [--max] [--effort X]
//   mgb routine tick                 fire due routines once (cron dry-run helper)

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHost, bootstrap } from '../src/host.mjs';
import { resolveDataRoot, paths, readJson } from '../src/paths.mjs';
import { loadSecretsIntoEnv } from '../src/secrets.mjs';

// Provider keys live in <dataRoot>/secrets/env.json (mode 600); see src/secrets.mjs.
loadSecretsIntoEnv(resolveDataRoot());
import { resolveBinding, setAgentBinding, loadBindings } from '../src/providers/bindings.mjs';

const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const RED = '\u001b[31m';
const CYAN = '\u001b[36m';
const OFF = '\u001b[0m';

function out(line = '') {
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  process.stderr.write(`${RED}error${OFF} ${message}\n`);
  process.exitCode = 1;
}

function table(rows, columns) {
  if (!rows.length) return out(`${DIM}(none)${OFF}`);
  const widths = columns.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  out(columns.map((c, i) => `${BOLD}${c.label.padEnd(widths[i])}${OFF}`).join('  '));
  for (const row of rows) {
    out(columns.map((c, i) => String(c.get(row) ?? '').padEnd(widths[i])).join('  '));
  }
}

function fmtTime(ms) {
  if (!ms) return '-';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

const HELP = `${BOLD}mgb${OFF} — personal Grok-Bot-style workspace

  ${CYAN}init${OFF}      create the data root, first bot, and a model binding
  ${CYAN}doctor${OFF}    verify layout, bindings, skills, and gateway discovery
  ${CYAN}serve${OFF}     run the gateway (HTTP RPC + SSE + web client)
  ${CYAN}agents${OFF}    ls | new <name> | rm <agent> | use <agent> | show <agent>
  ${CYAN}prompt${OFF}    <agent> <text>  send a prompt and stream the reply
  ${CYAN}tail${OFF}      <agent> [--limit N]  print the recent transcript
  ${CYAN}memory${OFF}    <agent> [--append TEXT] [--kind note|profile]
  ${CYAN}skill${OFF}     ls | install <slug> --name N --desc D --body-file F | rm <name>
  ${CYAN}routine${OFF}   ls <agent> | add <agent> --name N --prompt P --cron C | run <agent> <slug> | rm <agent> <slug>
  ${CYAN}bind${OFF}      <agent> --model M [--base-url U] [--key-env E] [--max] [--effort LEVEL]
  ${CYAN}policy${OFF}    show | set --allow "shell:ls*" --deny "shell:rm*" --auto
  ${CYAN}verify${OFF}    <agent> --base-url U --key-env E [--model M]  one real round-trip

Data root: ${DIM}${resolveDataRoot()}${OFF} (override with MGB_DATA_ROOT)
`;

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'help';
  const rest = argv.slice(1);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      out(HELP);
      return;
    case 'init':
      return cmdInit(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'serve':
      return cmdServe(rest);
    case 'agents':
      return cmdAgents(rest);
    case 'prompt':
      return cmdPrompt(rest);
    case 'tail':
      return cmdTail(rest);
    case 'memory':
      return cmdMemory(rest);
    case 'skill':
      return cmdSkill(rest);
    case 'routine':
      return cmdRoutine(rest);
    case 'bind':
      return cmdBind(rest);
    case 'policy':
      return cmdPolicy(rest);
    case 'verify':
      return cmdVerify(rest);
    default:
      fail(`unknown command: ${command}`);
      out(HELP);
  }
}

function cmdInit(args) {
  const { values } = parseArgs({
    args,
    options: {
      bot: { type: 'string', default: 'Main Bot' },
      model: { type: 'string', default: 'grok-4.6' },
      'base-url': { type: 'string', default: 'https://api.x.ai/v1' },
      'key-env': { type: 'string', default: 'XAI_API_KEY' },
    },
  });
  const host = bootstrap({
    botName: values.bot,
    model: values.model,
    baseUrl: values['base-url'],
    apiKeyEnv: values['key-env'],
  });
  const agents = host.roster.list();
  out(`${GREEN}ok${OFF} data root ${host.root}`);
  for (const a of agents) {
    const b = resolveBinding(host.root, a.id, process.env);
    out(`  ${BOLD}${a.name}${OFF} ${DIM}${a.id}${OFF}  model=${b.modelId} key=${b.apiKey ? 'set' : `${YELLOW}missing ${b.apiKeyEnv}${OFF}`}`);
  }
  out(`\nnext: ${CYAN}mgb serve${OFF}  then open the printed URL`);
  host.roster.closeStores();
}

function cmdDoctor(args) {
  const host = createHost({ recover: false });
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  add('data root exists', fs.existsSync(host.root), host.root);
  add('settings.json', fs.existsSync(host.p.settings));
  add('agents present', host.roster.list().length > 0, `${host.roster.list().length} bot(s)`);
  const skills = host.catalog.list();
  add('skill catalog', skills.length > 0, `${skills.length} skill(s)`);

  const bindings = loadBindings(host.root);
  for (const agent of host.roster.list()) {
    const b = resolveBinding(host.root, agent.id, process.env);
    add(
      `binding ${agent.name}`,
      Boolean(b.modelId),
      `${b.modelId} @ ${b.baseUrl} key=${b.apiKey ? 'set' : `missing ${b.apiKeyEnv}`}`,
    );
  }

  const discovery = readJson(host.p.gateway, null);
  add('gateway discovery', Boolean(discovery), discovery ? `${discovery.host}:${discovery.port} pid ${discovery.pid}` : 'not running');

  for (const c of checks) {
    out(`${c.ok ? `${GREEN}ok  ${OFF}` : `${YELLOW}warn${OFF}`} ${c.name}${c.detail ? ` ${DIM}${c.detail}${OFF}` : ''}`);
  }
  const warnings = checks.filter((c) => !c.ok).length;
  out(`\n${warnings === 0 ? `${GREEN}all checks passed${OFF}` : `${YELLOW}${warnings} warning(s)${OFF}`}`);
  host.roster.closeStores();
}

async function cmdServe(args) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string', default: '0' },
      host: { type: 'string', default: '127.0.0.1' },
      token: { type: 'string' },
      'no-token': { type: 'boolean', default: false },
    },
  });
  const host = createHost({ log: (kind, data) => {
    if (process.env.MGB_LOG_RPC === '1') out(`${DIM}[${kind}] ${JSON.stringify(data)}${OFF}`);
  } });
  const agents = host.roster.list();
  if (!agents.length) {
    fail('no bots yet — run `mgb init` first');
    return;
  }
  // Loopback + no token by default so the browser opens without ?token=. Pass --token
  // (or bind off loopback) and the bearer check comes back on.
  const loopback = values.host === '127.0.0.1' || values.host === 'localhost';
  const token = values['no-token'] || (loopback && !values.token)
    ? null
    : values.token ?? readJson(host.p.gateway, {})?.token ?? null;
  const discovery = await host.listen({ port: Number(values.port), host: values.host, token });
  const url = `http://${discovery.host === '0.0.0.0' ? '127.0.0.1' : discovery.host}:${discovery.port}`;
  out(`${GREEN}gateway${OFF} ${url}  ${DIM}pid ${process.pid}${OFF}`);
  out(`${DIM}bots: ${agents.map((a) => a.name).join(', ')}${OFF}`);
  if (token) out(`${DIM}auth: bearer token from ${host.p.gateway}${OFF}`);
  out(`${DIM}web: ${url}/   rpc: POST ${url}/api/<method>   events: GET ${url}/events${OFF}`);

  const shutdown = async (signal) => {
    out(`\n${DIM}${signal}: shutting down${OFF}`);
    await host.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  await new Promise(() => {});
}

function cmdAgents(args) {
  const sub = args[0] ?? 'ls';
  const host = createHost({ recover: false });
  if (sub === 'ls') {
    const active = host.roster.activeId();
    table(
      host.roster.list().map((a) => ({ ...a, active: a.id === active ? '*' : '' })),
      [
        { label: '', get: (r) => r.active },
        { label: 'name', get: (r) => r.name },
        { label: 'id', get: (r) => r.id },
        { label: 'model', get: (r) => resolveBinding(host.root, r.id).modelId },
        { label: 'last activity', get: (r) => fmtTime(r.lastActivityMs) },
      ],
    );
    host.roster.closeStores();
    return;
  }
  if (sub === 'new') {
    const name = args.slice(1).join(' ').trim();
    if (!name) return fail('agents new <name>');
    const agent = host.roster.create({ name, description: '' });
    out(`${GREEN}created${OFF} ${agent.name} ${DIM}${agent.id}${OFF}`);
    host.roster.closeStores();
    return;
  }
  if (sub === 'rm') {
    const id = host.roster.resolve(args[1]);
    host.roster.delete(id);
    out(`${GREEN}removed${OFF} ${id}`);
    host.roster.closeStores();
    return;
  }
  if (sub === 'use') {
    const id = host.roster.resolve(args[1]);
    host.roster.setActive(id);
    out(`${GREEN}active${OFF} ${host.roster.summary(id).name}`);
    host.roster.closeStores();
    return;
  }
  if (sub === 'show') {
    const id = host.roster.resolve(args[1]);
    out(JSON.stringify(host.roster.summary(id), null, 2));
    host.roster.closeStores();
    return;
  }
  fail(`unknown agents subcommand: ${sub}`);
}

async function cmdPrompt(args) {
  const agentRef = args[0];
  const text = args.slice(1).join(' ').trim();
  if (!agentRef || !text) return fail('prompt <agent> <text>');
  const host = createHost({ recover: false });
  const agentId = host.roster.resolve(agentRef);
  host.resume();
  const isGroup = host.roster.profile(agentId)?.isGroup === true;
  const binding = resolveBinding(host.root, agentId, process.env);
  out(`${DIM}${binding.modelId} @ ${binding.baseUrl}${OFF}`);
  const unsubscribe = host.bus.subscribe((event) => {
    if (event.agentId !== agentId) return;
    if (event.hidden) return;
    if (isGroup && event.type === 'transcript' && event.entry?.kind === 'send-message') out(`\n${event.entry.fromAgent?.name ?? 'bot'}: ${event.entry.message?.content ?? ''}`);
    else if (event.type === 'text-delta') process.stdout.write(event.text);
    else if (event.type === 'reasoning-delta') process.stderr.write(`${DIM}${event.text}${OFF}`);
    else if (event.type === 'tool-call') out(`\n${CYAN}tool${OFF} ${event.entry.name} ${DIM}${JSON.stringify(event.entry.args).slice(0, 160)}${OFF}`);
    else if (event.type === 'tool-result') out(`${DIM}tool result: ${String(typeof event.result === 'string' ? event.result : JSON.stringify(event.result)).slice(0, 300)}${OFF}`);
    else if (event.type === 'approval-request') out(`\n${YELLOW}approval required${OFF} ${event.entry.message.approval.command}`);
    else if (event.type === 'turn-error') out(`\n${RED}${event.error}${OFF}`);
  });
  const acceptance = isGroup ? await host.engine.postFromOperator({ groupId: agentId, text }) : host.engine.admit({ agentId, prompt: text });
  await waitForAcceptance(host, acceptance.clientNonce);
  unsubscribe();
  out('');
  await host.close();
}

async function waitForAcceptance(host, nonce, timeoutMs = 10 * 60_000) {
  const started = Date.now();
  for (;;) {
    const state = host.engine.acceptanceStatus(nonce);
    if (['done', 'error', 'interrupted', 'needs-reconciliation', 'awaiting-approval', 'awaiting-answer'].includes(state.state)) return state;
    if (Date.now() - started > timeoutMs) return state;
    await new Promise((r) => setTimeout(r, 120));
  }
}

function cmdTail(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { limit: { type: 'string', default: '30' } },
  });
  const host = createHost({ recover: false });
  const id = host.roster.resolve(positionals[0]);
  const entries = host.engine.visibleEntries(id, { limit: Number(values.limit) }).reverse();
  for (const entry of entries) {
    const who =
      entry.kind === 'message'
        ? entry.role === 'user'
          ? entry.fromAgent?.name ?? 'you'
          : 'bot'
        : entry.kind;
    if (entry.kind === 'message' || entry.kind === 'send-message') {
      const text = entry.message?.content ?? entry.message?.text ?? JSON.stringify(entry.message);
      out(`${DIM}${fmtTime(entry.timestampMs)}${OFF} ${BOLD}${who}${OFF} ${String(text).slice(0, 400)}`);
    } else if (entry.kind === 'notice' || entry.kind === 'error') {
      out(`${DIM}${fmtTime(entry.timestampMs)}${OFF} ${YELLOW}${entry.kind}${OFF} ${entry.text ?? entry.message}`);
    } else if (entry.kind === 'event') {
      out(`${DIM}${fmtTime(entry.timestampMs)} event ${entry.event?.type}${OFF}`);
    }
  }
  host.roster.closeStores();
}

function cmdMemory(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { append: { type: 'string' }, kind: { type: 'string', default: 'note' } },
  });
  const host = createHost({ recover: false });
  const id = host.roster.resolve(positionals[0]);
  if (values.append) {
    const file = host.roster.appendMemory(id, values.append, { kind: values.kind });
    out(`${GREEN}saved${OFF} ${file}`);
  } else {
    out(host.roster.readMemoryAll(id) || `${DIM}(empty)${OFF}`);
  }
  host.roster.closeStores();
}

function cmdSkill(args) {
  const sub = args[0] ?? 'ls';
  const host = createHost({ recover: false });
  if (sub === 'ls') {
    table(host.catalog.list(), [
      { label: 'name', get: (s) => s.name },
      { label: 'description', get: (s) => String(s.description).slice(0, 80) },
    ]);
    return;
  }
  if (sub === 'install') {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        name: { type: 'string' },
        desc: { type: 'string', default: '' },
        'body-file': { type: 'string' },
        overwrite: { type: 'boolean', default: false },
      },
    });
    const slug = positionals[0];
    if (!slug) return fail('skill install <slug> --name N --desc D --body-file F');
    const body = values['body-file'] ? fs.readFileSync(values['body-file'], 'utf8') : '';
    const skill = host.catalog.install({
      slug,
      name: values.name ?? slug,
      description: values.desc ?? '',
      body,
      overwrite: values.overwrite,
    });
    out(`${GREEN}installed${OFF} ${skill.name}`);
    return;
  }
  if (sub === 'rm') {
    out(JSON.stringify(host.catalog.remove(args[1])));
    return;
  }
  fail(`unknown skill subcommand: ${sub}`);
}

function cmdRoutine(args) {
  const sub = args[0] ?? 'ls';
  const host = createHost({ recover: false });
  if (sub === 'tick') {
    const tz = host.hostSettings().userTimeZone ?? 'UTC';
    out(JSON.stringify(host.routines.tick(new Date(), tz), null, 2));
    return;
  }
  if (sub === 'ls') {
    const id = host.roster.resolve(args[1]);
    table(host.routines.list(id), [
      { label: 'slug', get: (r) => r.slug },
      { label: 'name', get: (r) => r.name },
      { label: 'cron', get: (r) => r.schedule },
      { label: 'on', get: (r) => (r.enabled === false ? 'no' : 'yes') },
      { label: 'last run', get: (r) => fmtTime(r.lastRunAt) },
    ]);
    return;
  }
  if (sub === 'add') {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: { name: { type: 'string' }, prompt: { type: 'string' }, cron: { type: 'string' } },
    });
    const agentId = host.roster.resolve(positionals[0]);
    const routine = host.routines.create({
      agentId,
      name: values.name,
      prompt: values.prompt,
      schedule: values.cron,
    });
    out(`${GREEN}created${OFF} ${routine.slug} (${routine.schedule})`);
    return;
  }
  if (sub === 'run') {
    const agentId = host.roster.resolve(args[1]);
    out(JSON.stringify(host.routines.runNow({ agentId, slug: args[2] })));
    return;
  }
  if (sub === 'rm') {
    const agentId = host.roster.resolve(args[1]);
    out(JSON.stringify(host.routines.remove({ agentId, slug: args[2] })));
    return;
  }
  fail(`unknown routine subcommand: ${sub}`);
}

function cmdBind(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'key-env': { type: 'string' },
      max: { type: 'boolean', default: false },
      effort: { type: 'string' },
      fast: { type: 'boolean', default: false },
    },
  });
  const host = createHost({ recover: false });
  const id = host.roster.resolve(positionals[0]);
  const patch = {};
  if (values.model) patch.modelId = values.model;
  if (values['base-url']) patch.baseUrl = values['base-url'];
  if (values['key-env']) patch.apiKeyEnv = values['key-env'];
  if (values.max) patch.maxMode = true;
  const params = [];
  if (values.effort) params.push({ id: 'effort', value: values.effort });
  if (values.fast) params.push({ id: 'fast', value: true });
  if (params.length) patch.parameters = params;
  const saved = setAgentBinding(host.root, id, patch);
  const b = resolveBinding(host.root, id, process.env);
  out(`${GREEN}bound${OFF} ${host.roster.summary(id).name} -> ${b.modelId} ${DIM}@ ${b.baseUrl}${OFF}`);
  out(`${DIM}${JSON.stringify(saved.agents[id])}${OFF}`);
  host.roster.closeStores();
}

// One real round-trip against whatever the agent is bound to, so a fresh install can
// prove the provider answers before anything else is trusted.
async function cmdVerify(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'key-env': { type: 'string' },
      timeout: { type: 'string', default: '120000' },
    },
  });
  const host = createHost({ recover: false });
  const id = host.roster.resolve(positionals[0]);
  const patch = {};
  if (values.model) patch.modelId = values.model;
  if (values['base-url']) patch.baseUrl = values['base-url'];
  if (values['key-env']) patch.apiKeyEnv = values['key-env'];
  if (Object.keys(patch).length) setAgentBinding(host.root, id, patch);

  const b = resolveBinding(host.root, id, process.env);
  if (!b.apiKey) return fail(`no API key: set ${b.apiKeyEnv} in the environment`);
  out(`${DIM}${b.modelId} @ ${b.baseUrl}${OFF}`);

  const acc = host.engine.admit({ agentId: id, prompt: 'Reply with exactly: MGB-OK' });
  const deadline = Date.now() + Number(values.timeout);
  let state = acc;
  while (Date.now() < deadline) {
    state = host.engine.acceptanceStatus(acc.clientNonce);
    if (['done', 'error', 'interrupted', 'needs-reconciliation', 'awaiting-approval', 'awaiting-answer'].includes(state.state)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const rows = host.roster.store(id).readAll();
  const reply = rows.filter((e) => e.kind === 'send-message').at(-1);
  const reasoning = rows.filter((e) => e.kind === 'reasoning').at(-1);

  out(`${state.state === 'done' ? `${GREEN}ok${OFF}` : `${RED}${state.state}${OFF}`} ${DIM}${state.usage ? `${state.usage.total_tokens} tok` : 'no usage'}${OFF}`);
  if (reasoning) out(`${DIM}reasoning: ${String(reasoning.text).slice(0, 90).replace(/\n/g, ' ')}${OFF}`);
  if (reply) out(`reply: ${String(reply.message.content).slice(0, 200)}`);
  await host.close();
}

function cmdPolicy(args) {
  const sub = args[0] ?? 'show';
  const host = createHost({ recover: false });
  if (sub === 'show') {
    out(JSON.stringify(host.tools.policy(), null, 2));
    return;
  }
  if (sub === 'set') {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        allow: { type: 'string', multiple: true, default: [] },
        deny: { type: 'string', multiple: true, default: [] },
        auto: { type: 'boolean', default: false },
        'no-auto': { type: 'boolean', default: false },
      },
    });
    const patch = {};
    if (values.allow.length) patch.allow = values.allow;
    if (values.deny.length) patch.deny = values.deny;
    if (values.auto) patch.autoApprove = true;
    if (values['no-auto']) patch.autoApprove = false;
    out(JSON.stringify(host.tools.setPolicy(patch), null, 2));
    return;
  }
  fail(`unknown policy subcommand: ${sub}`);
}

main().catch((err) => {
  fail(String(err?.stack ?? err));
});
