// Skill catalog: managed skills (shipped catalog) + per-agent user skills.
//
// Layout mirrors sand-data:
//   <root>/managed-skills/skills/<slug>/SKILL.md   + cache.json {fetchedAt, skills:[{id,name,description,body}]}
//   <root>/managed-skills/cache.json
// A SKILL.md is YAML-ish frontmatter (name/description) plus a markdown body. The
// model sees only name + description in the system prompt and pulls the body with
// read_skill, which keeps the prompt small as the catalog grows.

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomicLoose } from './paths.mjs';

export function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { attributes: {}, body: text };
  const attributes = {};
  let currentKey = null;
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1];
      const value = kv[2].trim();
      // Block scalars (>-, >, |, |-) start empty; the indented lines carry the text.
      attributes[currentKey] = /^[>|][+-]?$/.test(value) ? '' : value.replace(/^["']|["']$/g, '');
      continue;
    }
    const cont = /^\s+(.*)$/.exec(line);
    if (cont && currentKey) {
      attributes[currentKey] = `${attributes[currentKey]} ${cont[1].trim()}`.trim();
    }
  }
  return { attributes, body: text.slice(match[0].length) };
}

export class SkillCatalog {
  constructor(p) {
    this.p = p;
  }

  refresh({ writeCache = true } = {}) {
    const dir = this.p.managedSkillsDir;
    const skills = [];
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const file = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(file)) continue;
        const raw = fs.readFileSync(file, 'utf8');
        const { attributes, body } = parseFrontmatter(raw);
        skills.push({
          id: entry.name,
          name: attributes.name ?? entry.name,
          description: attributes.description ?? '',
          body: body.trim(),
          filePath: file,
        });
      }
    }
    const cache = { fetchedAt: Date.now(), skills };
    if (writeCache) writeJsonAtomicLoose(this.p.managedSkillsCache, cache);
    return cache;
  }

  list() {
    const cache = readJson(this.p.managedSkillsCache, null);
    if (cache?.skills?.length) return cache.skills;
    return this.refresh({ writeCache: false }).skills;
  }

  get(name) {
    const skill = this.list().find((s) => s.name === name || s.id === name);
    if (!skill) return null;
    if (skill.body) return skill;
    // Fall back to the file when the cache predates a body field.
    const file = path.join(this.p.managedSkillsDir, skill.id, 'SKILL.md');
    if (!fs.existsSync(file)) return skill;
    const { attributes, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    return { ...skill, name: attributes.name ?? skill.name, description: attributes.description ?? skill.description, body: body.trim() };
  }

  install({ slug, name, description, body, overwrite = false }) {
    const id = slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const dir = path.join(this.p.managedSkillsDir, id);
    const file = path.join(dir, 'SKILL.md');
    if (fs.existsSync(file) && !overwrite) throw new Error(`skill already exists: ${id}`);
    fs.mkdirSync(dir, { recursive: true });
    const front = `---\nname: ${name}\ndescription: >-\n  ${(description ?? '').replace(/\n/g, ' ')}\n---\n`;
    fs.writeFileSync(file, `${front}${body ?? ''}\n`, 'utf8');
    this.refresh();
    return this.get(id);
  }

  remove(name) {
    const skill = this.get(name);
    if (!skill) throw new Error(`unknown skill: ${name}`);
    fs.rmSync(path.join(this.p.managedSkillsDir, skill.id), { recursive: true, force: true });
    this.refresh();
    return { removed: skill.id };
  }
}

// Seed catalog. Small on purpose: a starter set that demonstrates the contract.
export const SEED_SKILLS = [
  {
    slug: 'routines',
    name: 'routines',
    description: 'Use when the user asks for something recurring: a daily digest, a standing watch, a scheduled report, or "tell me when X changes".',
    body: `# Routines

A routine is a saved prompt plus a schedule. It runs as a normal turn for its bot,
and its result lands in the conversation as a message from that bot.

## Writing one

1. Decide the cadence and the time zone. Default to the user's time zone from Host
   settings, never the machine's.
2. Write the instruction as a job, not as a topic: what to read, what to produce,
   what "nothing to report" looks like.
3. Say explicitly what must never happen (no outbound mail, no writes) unless the
   user asked for it.
4. Save it with \`mgb routine add\`. State the cadence and what it will do in one line.

## Failure behavior

A failing routine is reported once, in the conversation, with its error. It is not
retried silently in a loop, and it does not page the user every cycle.`,
  },
  {
    slug: 'code-changes',
    name: 'code-changes',
    description: 'Use when the user asks for coding work in a repository: a feature, a bug fix, a refactor, or an investigation of how code behaves.',
    body: `# Code changes

Work in the agent workspace. Do not clone into shared directories.

1. Read the repository entry points before editing: README, package manifest, test
   command. Confirm the working tree is clean or explain the existing changes.
2. Reproduce the problem first when the ask is a bug. A fix without a repro is a guess.
3. Make the smallest coherent change. Do not reformat unrelated files.
4. Run the project's own test command. If it cannot run, say exactly why.
5. Report: what changed, why, what you ran, and what remains unverified.`,
  },
  {
    slug: 'sign-in',
    name: 'sign-in',
    description: 'Use when a task needs the user to sign in, pass a one-time code, or clear a human-verification wall on a site you are driving.',
    body: `# Sign in

The user's credentials are theirs. You never type them, store them, or ask for them
in chat.

1. Stop at the wall. State the site and the exact step you reached.
2. Hand the screen to the user with one instruction, e.g. "Sign in to <service>".
3. When the screen comes back, continue from the page you were on. Do not start over.
4. Never retry a verification wall in a loop; repeated attempts get accounts locked.`,
  },
  {
    slug: 'export-bot-template',
    name: 'export-bot-template',
    description: 'Use when the user wants to share or export this bot as a reusable template: which memories, skills, and routines travel with it.',
    body: `# Export a bot template

A template is a shareable copy. Choose what travels; leave out what is only this user's.

1. Read memory, skills, and routines in that order and report counts as you go.
2. Keep workflow conventions. Drop secrets, credentials, people's names, private
   links, customer names, and trade secrets. If a sensitive part is one piece of a
   useful item, cut that piece and keep the rest.
3. Never copy automation.json verbatim; copy the job text and generalize ids.
4. Write a getting-started skill for the new owner: one line on what the bot does,
   then the setup questions whose answers made this bot work, asked one at a time.`,
  },
  {
    slug: 'mac-local-llm-gateway',
    name: 'mac-local-llm-gateway',
    description: 'Use when offloading long reasoning, summaries, or log triage to a local OpenAI-compatible gateway to save the bot’s own tokens.',
    body: `# Local LLM gateway

Offload content production, keep tool work local.

- Do offload: digests, long summaries, log triage, drafting copy.
- Do not offload: short answers, HTTP/CLI/Git work, file edits, deployments.
- Decide the model once at task start; never switch mid-task (prefix cache re-bills).
- If the gateway is down, self-write and mark the fallback in the ledger.`,
  },
];
