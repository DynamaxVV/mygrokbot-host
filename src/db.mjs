// SQLite access via node:sqlite (Node >= 22.5). One handle per agent store.
//
// Schema is byte-compatible with the real sand-host agent store, so an exported
// store.db from a cloud box opens here unchanged:
//
//   kv(key,value)
//   blobs(id,data)
//   transcript_entries(seq,id,entry)
//   automation_completion_inbox(seq,id,text,attribution,acknowledged)
//
// The two partial indexes are recreated verbatim because the transcript window
// query depends on them; FTS is not required for the store to be valid.

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encryptBlob(bytes, passphrase) {
  const key = crypto.createHash('sha256').update(String(passphrase)).digest();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(bytes)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptBlob(buf, passphrase) {
  const key = crypto.createHash('sha256').update(String(passphrase)).digest();
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ct = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}
import fs from 'node:fs';
import path from 'node:path';

const AGENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  data BLOB NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS transcript_entries (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  entry TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS automation_completion_inbox (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  attribution TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1))
) STRICT;
CREATE INDEX IF NOT EXISTS idx_transcript_window
  ON transcript_entries(seq, entry)
  WHERE json_extract(entry, '$.kind') != 'tool-call'
        AND COALESCE(json_extract(entry, '$.branched'), 0) != 1;
CREATE INDEX IF NOT EXISTS idx_transcript_branched
  ON transcript_entries(seq, entry)
  WHERE COALESCE(json_extract(entry, '$.branched'), 0) = 1;
CREATE INDEX IF NOT EXISTS idx_automation_completion_inbox_pending
  ON automation_completion_inbox(seq)
  WHERE acknowledged = 0;
`;

const SEARCH_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  timestamp_ms INTEGER NOT NULL,
  body TEXT NOT NULL,
  seq INTEGER,
  UNIQUE(agent_id, entry_id)
) STRICT;
CREATE INDEX IF NOT EXISTS messages_agent_recency
  ON messages(agent_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS messages_agent_seq ON messages(agent_id, seq);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  ext TEXT NOT NULL,
  mime TEXT,
  kind TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  seq INTEGER,
  UNIQUE(agent_id, entry_id)
) STRICT;
CREATE TABLE IF NOT EXISTS server_cursors (
  agent_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  topped_through_seq INTEGER NOT NULL,
  backfilled_from_seq INTEGER NOT NULL
) STRICT;
`;

export function openAgentStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(AGENT_SCHEMA);
  return new AgentStore(db, file);
}

export function openSearchIndex(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SEARCH_SCHEMA);
  return db;
}

export class AgentStore {
  constructor(db, file) {
    this.db = db;
    this.file = file;
    this._stmts = new Map();
  }

  stmt(sql) {
    let prepared = this._stmts.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this._stmts.set(sql, prepared);
    }
    return prepared;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---- kv ---------------------------------------------------------------
  getKV(key, fallback = null) {
    const row = this.stmt('SELECT value FROM kv WHERE key = ?').get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  setKV(key, value) {
    this.stmt(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, JSON.stringify(value));
  }

  deleteKV(key) {
    this.stmt('DELETE FROM kv WHERE key = ?').run(key);
  }

  // ---- blobs ------------------------------------------------------------
  // Attachments and other binary payloads are AES-256-GCM encrypted at rest, matching
  // the real host: 12-byte IV || 16-byte tag || ciphertext, key = SHA-256(passphrase).
  putBlob(id, bytes, passphrase = null) {
    const payload = passphrase ? encryptBlob(bytes, passphrase) : Buffer.from(bytes);
    this.stmt('INSERT INTO blobs (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(
      id,
      new Uint8Array(payload),
    );
  }

  getBlob(id, passphrase = null) {
    const row = this.stmt('SELECT data FROM blobs WHERE id = ?').get(id);
    if (!row) return null;
    const buf = Buffer.from(row.data);
    return passphrase ? decryptBlob(buf, passphrase) : buf;
  }

  // ---- transcript -------------------------------------------------------
  appendEntry(entry) {
    const seq = Number(this.stmt('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM transcript_entries').get().next);
    this.stmt('INSERT INTO transcript_entries (seq, id, entry) VALUES (?, ?, ?)').run(
      seq,
      entry.id,
      JSON.stringify(entry),
    );
    return seq;
  }

  // Window read: everything except tool-call rows and branched rows, matching
  // the real host's idx_transcript_window partial index predicate.
  readWindow({ beforeSeq = null, limit = 200 } = {}) {
    const rows =
      beforeSeq == null
        ? this.stmt(`SELECT seq, entry FROM transcript_entries
                     WHERE json_extract(entry, '$.kind') != 'tool-call'
                       AND COALESCE(json_extract(entry, '$.branched'), 0) != 1
                     ORDER BY seq DESC LIMIT ?`).all(limit)
        : this.stmt(`SELECT seq, entry FROM transcript_entries
                     WHERE seq < ?
                       AND json_extract(entry, '$.kind') != 'tool-call'
                       AND COALESCE(json_extract(entry, '$.branched'), 0) != 1
                     ORDER BY seq DESC LIMIT ?`).all(beforeSeq, limit);
    return rows.map((row) => ({ seq: row.seq, ...JSON.parse(row.entry) }));
  }

  readTail({ limit = 50 } = {}) {
    return this.readWindow({ limit }).reverse();
  }

  readAll({ includeToolCalls = true } = {}) {
    const sql = includeToolCalls
      ? 'SELECT seq, entry FROM transcript_entries ORDER BY seq ASC'
      : `SELECT seq, entry FROM transcript_entries
         WHERE json_extract(entry, '$.kind') != 'tool-call' ORDER BY seq ASC`;
    return this.stmt(sql).all().map((row) => ({ seq: row.seq, ...JSON.parse(row.entry) }));
  }

  getEntry(id) {
    const row = this.stmt('SELECT seq, entry FROM transcript_entries WHERE id = ?').get(id);
    return row ? { seq: row.seq, ...JSON.parse(row.entry) } : null;
  }

  updateEntry(id, mutate) {
    const row = this.stmt('SELECT seq, entry FROM transcript_entries WHERE id = ?').get(id);
    if (!row) return null;
    const entry = JSON.parse(row.entry);
    const next = mutate(entry) ?? entry;
    this.stmt('UPDATE transcript_entries SET entry = ? WHERE id = ?').run(JSON.stringify(next), id);
    return { seq: row.seq, ...next };
  }

  maxSeq() {
    return Number(this.stmt('SELECT COALESCE(MAX(seq), 0) AS m FROM transcript_entries').get().m);
  }

  // ---- routine completion inbox ----------------------------------------
  pushRoutineCompletion({ id, text, attribution }) {
    this.stmt('INSERT INTO automation_completion_inbox (id, text, attribution) VALUES (?, ?, ?)').run(
      id,
      text,
      attribution,
    );
  }

  pendingRoutineCompletions() {
    return this.stmt(
      'SELECT seq, id, text, attribution FROM automation_completion_inbox WHERE acknowledged = 0 ORDER BY seq ASC',
    ).all();
  }

  acknowledgeRoutineCompletion(seq) {
    this.stmt('UPDATE automation_completion_inbox SET acknowledged = 1 WHERE seq = ?').run(seq);
  }
}

// ---------------------------------------------------------------------------
// Cross-agent search.
//
// A per-store FTS5 table would need to be kept in sync on every append, and the
// transcript JSON is not a column. Instead search reads every store's transcript and
// matches in JS: correct by construction, and fast enough for a personal host (tens of
// thousands of rows). A LIKE prefilter on the raw JSON keeps it off the hot path.
// ---------------------------------------------------------------------------

export function searchTranscripts({ stores, query, limit = 60 }) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const needle = q.toLowerCase();
  const hits = [];
  for (const { agentId, agentName, store } of stores) {
    let rows;
    try {
      rows = store.readAll();
    } catch {
      continue;
    }
    for (const row of rows) {
      const text = row.message?.content ?? row.text ?? row.result ?? '';
      if (typeof text !== 'string' || !text) continue;
      const hay = text.toLowerCase();
      const at = hay.indexOf(needle);
      if (at < 0) continue;
      hits.push({
        agentId,
        agentName,
        entryId: row.id,
        kind: row.kind,
        role: row.role ?? null,
        timestampMs: row.timestampMs ?? null,
        // A short window around the hit so the result list is readable.
        snippet: text.slice(Math.max(0, at - 40), Math.min(text.length, at + q.length + 80)),
        offset: at,
      });
      if (hits.length >= limit * 4) break;
    }
  }
  hits.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0));
  return hits.slice(0, limit);
}
