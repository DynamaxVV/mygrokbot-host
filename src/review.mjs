// Auto-review: the approval gate in front of side effects.
//
// Rebuilt from the deployed host's auto-review extension and the RPC schema.
// The contract has three parts that a naive "approve button" misses:
//
//   1. THREE resolutions, not two. `approved` / `denied` / `always`.
//      `always` means "approve this command and stop asking for it" — it must
//      persist as a standing rule, not just unblock one turn.
//   2. STALENESS. A card that was already settled, expired, or belongs to another
//      request is refused with `auto-review/stale`, never silently applied. This
//      is why an old approve click cannot resurrect a finished turn.
//   3. EXPIRY AT STARTUP. Pending cards are expired when the host starts, because
//      a card from a previous process no longer has a live resolver behind it.
//
// Permission ceilings (from LocalToolPermissionCeiling): NEVER / ASK / ALWAYS.
// A ceiling of NEVER blocks the tool outright; ALWAYS skips the card; ASK is the
// normal path that produces an approval entry.

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomicLoose } from './paths.mjs';

export const RESOLUTIONS = ['approved', 'denied', 'always'];
export const CEILINGS = ['NEVER', 'ASK', 'ALWAYS'];
// A card is only live for 10 minutes; after that the side effect must not run on a
// stale approval (the deployed host: SAND_AUTO_REVIEW_APPROVAL_TTL_MS = 600_000).
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

// Only one card may be pending at a time. The deployed host refuses a second side
// effect outright rather than queueing it: "Another action is waiting for Auto-review
// approval; no new side effect may start yet."
export const PENDING_APPROVAL_REASON =
  'Another action is waiting for Auto-review approval; no new side effect may start yet. ' +
  'Do not retry or start another action while that card is unanswered; end the turn and ' +
  'ask the user to approve or deny it.';

export const AUTO_REVIEW_STALE = 'auto-review/stale';
export const AUTO_REVIEW_STALE_MESSAGE = 'The Auto-review request is stale, expired, or not authorized.';
export const AWAITING_TAB_ID = 'auto-review';

const RULES_FILENAME = 'auto-review-rules.json';

export class StaleApprovalError extends Error {
  constructor() {
    super(`${AUTO_REVIEW_STALE}: ${AUTO_REVIEW_STALE_MESSAGE}`);
    this.name = 'StaleApprovalError';
    this.failureCode = AUTO_REVIEW_STALE;
    this.status = 409;
  }
}

export function rulesPath(root) {
  return path.join(root, RULES_FILENAME);
}

export function loadRules(root) {
  return (
    readJson(rulesPath(root), {
      version: 1,
      // Standing "always allow" commands, exact match on the command string.
      alwaysAllow: [],
      // Free-text steering for the reviewing model, mirroring settings.json.
      allowInstructions: [],
      blockInstructions: [],
      // Per-tool ceiling; anything unlisted defaults to ASK.
      ceilings: {},
      isEnabled: true,
    }) ?? {}
  );
}

export function saveRules(root, rules) {
  writeJsonAtomicLoose(rulesPath(root), rules);
  return rules;
}

// Decide what should happen *before* the model ever sees a result.
//   { decision: 'allow' | 'deny' | 'ask', reason }
export function evaluate({ root, tool, command, rules = null }) {
  const r = rules ?? loadRules(root);
  if (r.isEnabled === false) return { decision: 'allow', reason: 'auto-review disabled' };

  const ceiling = r.ceilings?.[tool] ?? 'ASK';
  if (ceiling === 'NEVER') return { decision: 'deny', reason: `ceiling NEVER for ${tool}` };
  if (ceiling === 'ALWAYS') return { decision: 'allow', reason: `ceiling ALWAYS for ${tool}` };

  const target = String(command ?? '');
  for (const rule of r.blockInstructions ?? []) {
    if (matches(rule, target, tool)) return { decision: 'deny', reason: `blocked by rule: ${rule}` };
  }
  for (const rule of r.allowInstructions ?? []) {
    if (matches(rule, target, tool)) return { decision: 'allow', reason: `allowed by rule: ${rule}` };
  }
  for (const entry of r.alwaysAllow ?? []) {
    if (entry.tool === tool && entry.command === target) {
      return { decision: 'allow', reason: 'standing always-allow' };
    }
  }
  return { decision: 'ask', reason: null };
}

// A rule is either "tool:pattern" (glob-ish) or a bare pattern against the command.
function matches(rule, command, tool) {
  const [maybeTool, ...rest] = String(rule).split(':');
  if (rest.length > 0) {
    if (maybeTool !== tool) return false;
    return glob(rest.join(':'), command);
  }
  return glob(rule, command) || glob(rule, `${tool}:${command}`);
}

function glob(pattern, value) {
  const re = new RegExp(
    `^${String(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  );
  return re.test(value);
}

// Is this card still live? Age is taken from the entry, so a restart does not reset it.
export function isCardLive(entry, now = Date.now()) {
  const createdAt = entry?.timestampMs ?? 0;
  if (!createdAt) return false;
  return now - createdAt <= APPROVAL_TTL_MS;
}

// Apply a resolution to a pending card. The caller owns the transcript entry; this
// owns the standing-rule bookkeeping and the staleness rule.
export function resolve({ root, resolution, tool, command, entry, requestId, expectedRequestId }) {
  if (!RESOLUTIONS.includes(resolution)) {
    throw Object.assign(new Error(`unknown resolution: ${resolution}`), { status: 400 });
  }
  // Staleness: a card that is already settled or belongs to another request cannot
  // be applied, even if the client still has the button on screen.
  if (!entry || entry.message?.type !== 'auto-review-approval') throw new StaleApprovalError();
  // An approval older than the TTL must not execute the side effect.
  if (!isCardLive(entry)) throw new StaleApprovalError();
  if (entry.message.resolution != null) throw new StaleApprovalError();
  if (expectedRequestId != null && entry.message.approval?.requestId !== expectedRequestId) {
    throw new StaleApprovalError();
  }

  const rules = loadRules(root);
  if (resolution === 'always') {
    const already = (rules.alwaysAllow ?? []).some((e) => e.tool === tool && e.command === command);
    if (!already) {
      rules.alwaysAllow = [...(rules.alwaysAllow ?? []), { tool, command, addedAtMs: Date.now() }];
      saveRules(root, rules);
    }
  }
  return {
    resolution,
    // `always` implies this turn is approved too.
    approved: resolution === 'approved' || resolution === 'always',
    standingRule: resolution === 'always',
  };
}

// Startup: expire cards left pending by a previous process. Returns the count.
export function expireAllPending({ roster, bus }) {
  let expired = 0;
  for (const agent of roster.list()) {
    const store = roster.store(agent.id);
    for (const entry of store.readAll()) {
      if (entry.message?.type !== 'auto-review-approval') continue;
      if (entry.message.resolution != null) continue;
      store.updateEntry(entry.id, (e) => ({
        ...e,
        message: { ...e.message, resolution: 'expired', resolvedAtMs: Date.now() },
      }));
      bus.publish({ type: 'approval-expired', agentId: agent.id, entryId: entry.id });
      expired += 1;
    }
  }
  return expired;
}
