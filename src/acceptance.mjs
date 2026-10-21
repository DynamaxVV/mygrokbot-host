// Acceptance ledger — the durable record that a prompt was taken in.
//
// Rebuilt from the deployed host's prompt-acceptance-ledger.ts. The contract that
// matters: acceptance is written to disk *before* the turn runs, so a crash between
// "the user pressed send" and "the model answered" is still answerable afterwards.
// A client that re-sends the same clientNonce must get the original record back,
// not a second turn.
//
// File: <root>/send-acceptance.json
//   { records: [...], historyGaps: { evictionHorizonMs, degradedWindows[], corruptResetAtMs } }
//
// Record shape (coerceRecord in the real host is equally strict):
//   { accountSlot, clientNonce, inputDigest, status, acceptedAtMs, agentId,
//     echoEntryId, rejectionCode }
//
// status ∈ accepted | rejected | pending. `unknown-durability` is a distinct
// outcome from `not-found`: it means "history was evicted or degraded, so I cannot
// honestly say this nonce was never seen".

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const ACCEPTANCE_FILENAME = 'send-acceptance.json';
export const ACCEPTANCE_STATUSES = ['accepted', 'rejected', 'pending'];
export const MAX_DEGRADED_WINDOWS = 8;
const MAX_RECORDS = 5000; // keeps the file bounded; the host caps too

export function acceptancePath(root) {
  return path.join(root, ACCEPTANCE_FILENAME);
}

export function inputDigest(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex');
}

function emptyGaps() {
  return { evictionHorizonMs: null, degradedWindows: [], corruptResetAtMs: null };
}

function keyOf(accountSlot, clientNonce) {
  return `${accountSlot}\u0000${clientNonce}`;
}

export class AcceptanceLedger {
  constructor(root, { now = () => Date.now() } = {}) {
    this.filePath = root == null ? null : acceptancePath(root);
    this.now = now;
    this._cache = null;
    this.degradedSinceMs = null;
  }

  markerPath() {
    return this.filePath == null ? null : `${this.filePath}.degraded`;
  }

  load() {
    if (this._cache) return this._cache;
    let raw = null;
    if (this.filePath) {
      try {
        raw = fs.readFileSync(this.filePath, 'utf8');
      } catch {
        raw = null;
      }
    }
    const parsed = parseFile(raw);
    let gaps = parsed.gaps;
    let repair = false;

    if (parsed.damaged && raw != null && this.filePath) {
      try {
        fs.writeFileSync(`${this.filePath}.corrupt-${this.now()}`, raw, { mode: 0o600 });
      } catch {
        /* quarantine is best effort */
      }
      gaps = withCorruptReset(gaps, this.now());
      repair = true;
    }

    const markerSince = this.readDegradedMarker();
    if (markerSince != null) {
      gaps = withDegradedWindow(gaps, { fromMs: markerSince, toMs: this.now() });
      repair = true;
    }

    this._cache = {
      records: new Map(parsed.records.map((r) => [keyOf(r.accountSlot, r.clientNonce), r])),
      gaps,
    };
    if (repair) this.persist();
    return this._cache;
  }

  readDegradedMarker() {
    const p = this.markerPath();
    if (!p) return null;
    try {
      const value = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Number.isFinite(value?.sinceMs) ? value.sinceMs : 0;
    } catch {
      return null;
    }
  }

  markDegraded() {
    const p = this.markerPath();
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const since = this.degradedSinceMs ?? this.now();
    this.degradedSinceMs = since;
    try {
      fs.writeFileSync(p, JSON.stringify({ sinceMs: since }));
    } catch {
      /* the marker is advisory */
    }
  }

  // Looking up a nonce never creates one.
  lookup({ accountSlot = 'host', clientNonce }) {
    const loaded = this.load();
    const record = loaded.records.get(keyOf(accountSlot, clientNonce));
    if (record) return { outcome: 'found', record };
    if (loaded.gaps != null || this.degradedSinceMs != null) return { outcome: 'unknown-durability' };
    return { outcome: 'not-found' };
  }

  // Admit one prompt. Returns the record, plus whether it was a replay.
  record({ accountSlot = 'host', clientNonce, prompt, agentId, echoEntryId = null, status = 'accepted' }) {
    const loaded = this.load();
    const digest = inputDigest(prompt);
    const existing = loaded.records.get(keyOf(accountSlot, clientNonce));
    if (existing) {
      const sameInput = existing.inputDigest === digest;
      return {
        replayed: true,
        conflict: !sameInput,
        record: existing,
        // A different prompt under the same nonce is a client bug, not a new turn.
        rejectionCode: sameInput ? null : 'send/nonce-digest-mismatch',
      };
    }
    const record = {
      accountSlot,
      clientNonce,
      inputDigest: digest,
      status,
      acceptedAtMs: this.now(),
      agentId,
      echoEntryId,
      rejectionCode: null,
    };
    loaded.records.set(keyOf(accountSlot, clientNonce), record);
    this.persist();
    return { replayed: false, conflict: false, record, rejectionCode: null };
  }

  update(accountSlot, clientNonce, patch) {
    const loaded = this.load();
    const key = keyOf(accountSlot, clientNonce);
    const existing = loaded.records.get(key);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    loaded.records.set(key, next);
    this.persist();
    return next;
  }

  persist() {
    if (!this.filePath || !this._cache) return;
    const records = [...this._cache.records.values()];
    let gaps = this._cache.gaps;
    let kept = records;
    if (records.length > MAX_RECORDS) {
      kept = records.slice(records.length - MAX_RECORDS);
      const horizon = kept[0]?.acceptedAtMs ?? this.now();
      // Evicting history is a durability gap and must be declared as one.
      gaps = { ...(gaps ?? emptyGaps()), evictionHorizonMs: horizon };
      this._cache.records = new Map(kept.map((r) => [keyOf(r.accountSlot, r.clientNonce), r]));
    }
    this._cache.gaps = gaps;
    const payload = { records: kept, ...(gaps ? { historyGaps: gaps } : {}) };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  // Diagnostics: what the host would report about its own ledger.
  status() {
    const loaded = this.load();
    return {
      file: this.filePath,
      records: loaded.records.size,
      gaps: loaded.gaps,
      degraded: this.degradedSinceMs != null,
    };
  }
}

function parseFile(raw) {
  if (raw == null) return { records: [], gaps: null, damaged: false };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { records: [], gaps: null, damaged: true };
  }
  if (typeof value !== 'object' || value === null) return { records: [], gaps: null, damaged: true };
  if (!Array.isArray(value.records)) return { records: [], gaps: null, damaged: true };

  let damaged = false;
  const records = [];
  for (const entry of value.records) {
    const record = coerceRecord(entry);
    if (record == null) damaged = true;
    else records.push(record);
  }
  const gaps = coerceGaps(value.historyGaps);
  if (gaps === 'malformed') return { records, gaps: null, damaged: true };
  return { records, gaps, damaged };
}

function coerceGaps(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') return 'malformed';
  const horizon = value.evictionHorizonMs ?? null;
  if (horizon !== null && !Number.isFinite(horizon)) return 'malformed';
  const reset = value.corruptResetAtMs ?? null;
  if (reset !== null && !Number.isFinite(reset)) return 'malformed';
  if (!Array.isArray(value.degradedWindows)) return 'malformed';
  const windows = [];
  for (const entry of value.degradedWindows) {
    if (typeof entry !== 'object' || entry === null) return 'malformed';
    if (!Number.isFinite(entry.fromMs) || !Number.isFinite(entry.toMs)) return 'malformed';
    windows.push({ fromMs: entry.fromMs, toMs: entry.toMs });
  }
  return { evictionHorizonMs: horizon, degradedWindows: windows, corruptResetAtMs: reset };
}

function coerceRecord(entry) {
  if (typeof entry !== 'object' || entry === null) return null;
  if (typeof entry.accountSlot !== 'string' || !entry.accountSlot.length) return null;
  if (typeof entry.clientNonce !== 'string' || !entry.clientNonce.length) return null;
  if (typeof entry.inputDigest !== 'string' || !entry.inputDigest.length) return null;
  if (typeof entry.agentId !== 'string' || !entry.agentId.length) return null;
  if (!ACCEPTANCE_STATUSES.includes(entry.status)) return null;
  if (!Number.isFinite(entry.acceptedAtMs)) return null;
  return {
    accountSlot: entry.accountSlot,
    clientNonce: entry.clientNonce,
    inputDigest: entry.inputDigest,
    status: entry.status,
    acceptedAtMs: entry.acceptedAtMs,
    agentId: entry.agentId,
    echoEntryId: typeof entry.echoEntryId === 'string' ? entry.echoEntryId : null,
    rejectionCode: typeof entry.rejectionCode === 'string' ? entry.rejectionCode : null,
  };
}

function withDegradedWindow(gaps, window) {
  const base = gaps ?? emptyGaps();
  if (base.degradedWindows.length >= MAX_DEGRADED_WINDOWS) {
    const kept = base.degradedWindows.slice(0, -1);
    const last = base.degradedWindows[base.degradedWindows.length - 1];
    return {
      ...base,
      degradedWindows: [
        ...kept,
        { fromMs: Math.min(last.fromMs, window.fromMs), toMs: Math.max(last.toMs, window.toMs) },
      ],
    };
  }
  return { ...base, degradedWindows: [...base.degradedWindows, window] };
}

function withCorruptReset(gaps, atMs) {
  const base = gaps ?? emptyGaps();
  return { ...base, corruptResetAtMs: Math.max(base.corruptResetAtMs ?? atMs, atMs) };
}
