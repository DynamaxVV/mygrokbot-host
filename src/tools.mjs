// Tools the agent loop can call. Local-first, approval-aware.
//
// The reference host gates side effects through an auto-review surface: the bot
// proposes a command, the host asks, and only an approved command runs. The same
// split exists here — a tool call yields a `needs-approval` result and the turn
// engine parks it as an approval entry instead of executing.
//
// Config: tools.json in the data root
//   { "allow": ["shell:ls*", "shell:cat*"], "deny": ["shell:rm -rf*"], "autoApprove": false }

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readJson, writeJsonAtomicLoose } from './paths.mjs';
import { evaluate } from './review.mjs';

const MAX_OUTPUT = 64 * 1024;

function truncate(text) {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n...[truncated ${text.length - MAX_OUTPUT} bytes]`;
}

function globToRe(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

export function toolDefinitions() {
  return [
    {
      type: 'function',
      function: {
        name: 'shell',
        description:
          'Run a shell command inside this agent workspace. Returns combined stdout/stderr. Long turns are allowed.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Command line to run with /bin/sh -lc' },
            workdir: { type: 'string', description: 'Optional directory relative to the agent workspace' },
          },
          required: ['command'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a UTF-8 text file. Paths are relative to the agent workspace unless absolute.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or fully replace a UTF-8 text file inside the agent workspace.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_dir',
        description: 'List a directory inside the agent workspace.',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recall_memory',
        description: 'Read this bot’s persistent memory (profile + dated log shards).',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_memory',
        description:
          'Persist a durable fact, convention, or preference to this bot’s memory. Write it in the operator’s language (the host setting), not in English by default.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            kind: { type: 'string', enum: ['note', 'profile', 'episode'] },
          },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_skill',
        description: 'Load a skill’s full instructions by name from the managed skill catalog.',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
    },
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description:
          'Ask the user one question with a small set of options. The turn ends and every later step waits for the answer. Use it when the next step is genuinely the user’s call, not to confirm things you can verify yourself.',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'One sentence naming the decision and its consequence.' },
            options: { type: 'array', items: { type: 'string' }, description: '2–5 concrete options.' },
            allowCustom: { type: 'boolean', description: 'Let the user type their own answer.' },
          },
          required: ['prompt'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'message_user',
        description:
          'Send the operator a message in their own chat — use it when you have something to report that they are waiting on, or when another bot asked you to reply to them. This is how a bot reaches the operator directly instead of only answering the turn that summoned it. Do not use it to acknowledge; only when there is real content.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The message body, written to the operator.' },
            reason: {
              type: 'string',
              description: 'Optional short note on why this arrived unprompted (shown as context).',
            },
          },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'message_agent',
        description:
          'Message another bot. REQUIRED: decide whether this is actionable. priority=true means they should act or someone waits on their reply: it is delivered now and wakes them, jumping their queue ahead of routine/background work (but behind a turn already talking to the user). priority=false means informational: it is held and read at the start of their next turn, without waking them. Replies are asynchronous — do not wait. Groups are text-only and always post immediately.',
        parameters: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Bot name or id, or a group id' },
            text: { type: 'string', description: 'Write it as if texting a teammate: lead with the point, keep it short.' },
            priority: {
              type: 'boolean',
              description:
                'true: actionable, delivered now and wakes them. false: FYI only, held until their next turn. Ignored for groups.',
            },
            images: {
              type: 'array',
              items: { type: 'object', properties: { url: { type: 'string' }, alt: { type: 'string' } }, required: ['url'] },
              description: 'Optional images. A 1:1 recipient sees them; groups are text-only.',
            },
          },
          required: ['to', 'text', 'priority'],
        },
      },
    },
  ];
}

export class ToolRuntime {
  constructor({ p, roster, root, env = process.env }) {
    this.p = p;
    this.roster = roster;
    this.root = root;
    this.env = env;
    this.policyFile = path.join(root, 'tools.json');
  }

  policy() {
    return readJson(this.policyFile, { allow: [], deny: [], autoApprove: false }) ?? {};
  }

  setPolicy(patch) {
    const next = { ...this.policy(), ...patch };
    writeJsonAtomicLoose(this.policyFile, next);
    return next;
  }

  // One workspace for the whole host, exactly like the box's /workspace. The
  // agentId parameter stays so call sites keep naming whose turn this is, but it
  // does not partition the filesystem.
  workspace(_agentId) {
    const dir = this.p.workspace;
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  resolveInside(agentId, maybeRelative) {
    const ws = this.workspace(agentId);
    if (!maybeRelative || maybeRelative === '.') return ws;
    // A path that already names the workspace root (e.g. "workspace/uploads/x") must
    // not be joined again — that produced <ws>/workspace/uploads/x and an ENOENT.
    let cleaned = String(maybeRelative);
    const wsName = path.basename(ws);
    if (!path.isAbsolute(cleaned) && cleaned.split(/[\\/]/)[0] === wsName) {
      cleaned = cleaned.split(/[\\/]/).slice(1).join('/') || '.';
    }
    const abs = path.isAbsolute(cleaned) ? cleaned : path.resolve(ws, cleaned);
    const rel = path.relative(ws, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`path escapes the workspace: ${maybeRelative}`);
    }
    return abs;
  }

  // Approval decision for a proposed side effect, delegated to the auto-review
  // module so the three-state ceiling (NEVER/ASK/ALWAYS) and the standing
  // "always allow" rules are decided in one place.
  assess(command, tool = 'shell') {
    // autoApprove is the legacy master switch in tools.json; it still short-circuits
    // everything, so an old config keeps working after the review module took over.
    const policy = this.policy();
    if (policy.autoApprove === true) return { decision: 'allowed', rule: 'autoApprove' };
    if ((policy.deny ?? []).some((g) => globToRe(g).test(command) || globToRe(g).test(`${tool}:${command}`))) {
      return { decision: 'denied', rule: 'tools.json deny' };
    }
    const verdict = evaluate({ root: this.root, tool, command });
    if (verdict.decision === 'deny') return { decision: 'denied', rule: verdict.reason };
    if (verdict.decision === 'allow') return { decision: 'allowed', rule: verdict.reason };
    return { decision: 'needs-approval', rule: null };
  }

  async execute({ agentId, call, approvedCommands = new Set() }) {
    const name = call.name;
    const args = call.args ?? {};
    switch (name) {
      case 'shell': {
        const verdict = this.assess(args.command);
        if (verdict.decision === 'denied') {
          return { isError: true, result: `denied by policy rule ${verdict.rule}` };
        }
        if (verdict.decision === 'needs-approval' && !approvedCommands.has(args.command)) {
          return {
            isError: false,
            needsApproval: true,
            result: {
              status: 'approval_required',
              command: args.command,
              note: 'Ask the user to approve this exact command, then call shell again with it unchanged.',
            },
          };
        }
        const cwd = args.workdir ? this.resolveInside(agentId, args.workdir) : this.workspace(agentId);
        const out = await new Promise((resolve) => {
          execFile('/bin/sh', ['-lc', args.command], { cwd, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
            const code = err?.code ?? 0;
            resolve({
              exitCode: typeof code === 'number' ? code : 1,
              stdout: truncate(String(stdout ?? '')),
              stderr: truncate(String(stderr ?? err?.message ?? '')),
            });
          });
        });
        return { isError: out.exitCode !== 0, result: out };
      }
      case 'read_file': {
        const abs = this.resolveInside(agentId, args.path);
        const text = fs.readFileSync(abs, 'utf8');
        const offset = Number(args.offset ?? 1);
        const limit = Number(args.limit ?? 2000);
        const lines = text.split('\n').slice(offset - 1, offset - 1 + limit);
        return { isError: false, result: lines.map((l, i) => `${offset + i}\t${l}`).join('\n') };
      }
      case 'write_file': {
        const abs = this.resolveInside(agentId, args.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(args.content ?? ''), 'utf8');
        return { isError: false, result: { wrote: path.relative(this.workspace(agentId), abs), bytes: String(args.content ?? '').length } };
      }
      case 'list_dir': {
        const abs = this.resolveInside(agentId, args.path ?? '.');
        if (!fs.existsSync(abs)) return { isError: true, result: `no such directory: ${args.path}` };
        const rows = fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
          name: d.name,
          type: d.isDirectory() ? 'dir' : 'file',
          size: d.isDirectory() ? null : fs.statSync(path.join(abs, d.name)).size,
        }));
        return { isError: false, result: rows };
      }
      case 'recall_memory':
        return { isError: false, result: this.roster.readMemoryAll(agentId) || '(empty memory)' };
      case 'update_memory': {
        const file = this.roster.appendMemory(agentId, args.text, { kind: args.kind ?? 'note' });
        return { isError: false, result: { saved: true, file } };
      }
      case 'read_skill': {
        const dir = path.join(this.p.managedSkillsDir, String(args.name));
        const file = path.join(dir, 'SKILL.md');
        if (!fs.existsSync(file)) {
          const cache = readJson(this.p.managedSkillsCache, { skills: [] });
          const hit = (cache.skills ?? []).find((s) => s.name === args.name || s.id === args.name);
          if (!hit) return { isError: true, result: `unknown skill: ${args.name}` };
          return { isError: false, result: hit.body ?? hit.description ?? '' };
        }
        return { isError: false, result: fs.readFileSync(file, 'utf8') };
      }
      case 'ask_user':
        return {
          isError: false,
          needsWidget: {
            prompt: String(args.prompt ?? ''),
            options: Array.isArray(args.options) ? args.options.map(String) : [],
            allowCustom: args.allowCustom === true,
          },
        };
      case 'message_user': {
        // The engine owns the bus and the operator chat, so it supplies this hook.
        if (typeof this.onMessageUser !== 'function') {
          return { isError: true, result: { error: 'message_user is unavailable in this runtime' } };
        }
        const sent = await this.onMessageUser({ agentId, text: args.text, reason: args.reason ?? null });
        return { isError: false, result: { delivered: sent.delivered, to: 'user' } };
      }
      case 'message_agent':
        return {
          isError: false,
          deferToRuntime: {
            kind: 'message_agent',
            to: args.to,
            text: args.text,
            priority: args.priority === true,
            images: Array.isArray(args.images) ? args.images : [],
          },
        };
      default:
        return { isError: true, result: `unknown tool: ${name}` };
    }
  }
}
