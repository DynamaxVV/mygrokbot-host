// Host-wide durable execution state. Recovery methods never execute side effects.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EXECUTION_SCHEMA_VERSION = 1;
export const EXECUTION_FILENAME = 'execution.db';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Encode strings directly so even integer-looking keys retain lexical order.
export function canonicalJSON(value) {
  const normalized = clone(value);
  if (normalized === undefined) throw new TypeError('Expected a JSON value');
  function encode(item) {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item !== null && typeof item === 'object') {
      return `{${Object.keys(item).sort().map((k) => `${JSON.stringify(k)}:${encode(item[k])}`).join(',')}}`;
    }
    return JSON.stringify(item);
  }
  return encode(normalized);
}

export function inputDigest(input) {
  return createHash('sha256').update(canonicalJSON(input)).digest('hex');
}
function key(value, label) {
  if (typeof value !== 'string' || !value.length) throw new TypeError(`${label} must be a nonempty string`);
  return value;
}
function object(value, label = 'record') {
  const copy = clone(value);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new TypeError(`${label} must be a JSON object`);
  return copy;
}
const SCHEMA = `
CREATE TABLE admissions (
  scope TEXT NOT NULL, nonce TEXT NOT NULL, digest TEXT NOT NULL,
  record TEXT NOT NULL CHECK(json_valid(record)), PRIMARY KEY(scope, nonce)
) STRICT;
CREATE TABLE runs (
  id TEXT PRIMARY KEY, nonce TEXT, state TEXT,
  record TEXT NOT NULL CHECK(json_valid(record))
) STRICT;
CREATE INDEX runs_nonce ON runs(nonce);
CREATE TABLE interactions (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE tasks (id TEXT PRIMARY KEY, record TEXT NOT NULL CHECK(json_valid(record))) STRICT;
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  acked INTEGER NOT NULL DEFAULT 0 CHECK(acked IN (0, 1)),
  record TEXT NOT NULL CHECK(json_valid(record))
) STRICT;
CREATE INDEX outbox_pending ON outbox(seq) WHERE acked = 0;
`;

export class ExecutionStore {
  constructor(root) {
    key(root, 'root');
    this.root = path.resolve(root);
    this.file = path.join(this.root, EXECUTION_FILENAME);
    this.filePath = this.file;
    this._depth = 0;
    this._rollback = null;
    this._afterCommit = [];
    this._closed = false;
    fs.mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(this.file);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
      this.transaction(() => {
        this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;');
        const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        const version = row ? Number(row.value) : 0;
        if (!Number.isInteger(version) || version < 0 || version > EXECUTION_SCHEMA_VERSION) {
          throw new Error(`Unsupported execution schema version: ${row?.value}`);
        }
        if (version === 0) {
          this.db.exec(SCHEMA);
          this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(String(EXECUTION_SCHEMA_VERSION));
          this.db.exec(`PRAGMA user_version = ${EXECUTION_SCHEMA_VERSION};`);
        }
      });
    } catch (error) {
      this.db.close();
      this._closed = true;
      throw error;
    }
  }

  // A caught nested error still rolls back the whole enclosing transaction.
  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('transaction requires a synchronous function');
    if (fn.constructor?.name === 'AsyncFunction') throw new TypeError('Async transactions are unsupported');
    const outer = this._depth === 0;
    if (outer) {
      this.db.exec('BEGIN IMMEDIATE');
      this._rollback = null;
      this._afterCommit = [];
    }
    let returned;
    let callbacks = [];
    this._depth++;
    try {
      const result = fn(this);
      if (result && typeof result.then === 'function') throw new TypeError('Async transactions are unsupported');
      returned = clone(result);
      if (outer) {
        if (this._rollback) throw this._rollback;
        this.db.exec('COMMIT');
        callbacks = this._afterCommit;
      }
    } catch (error) {
      this._rollback ??= error instanceof Error ? error : new Error(String(error));
      if (outer) {
        try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
      }
      throw error;
    } finally {
      this._depth--;
      if (outer) {
        this._rollback = null;
        this._afterCommit = [];
      }
    }
    // Run outside the rollback handler and only after depth returns to zero.
    // Each callback may safely start a fresh transaction or register immediate
    // work. Run all callbacks, then report errors as already-committed failures.
    if (outer) {
      const errors = [];
      for (const callback of callbacks) {
        try { callback(); } catch (error) { errors.push(error); }
      }
      if (errors.length) {
        throw Object.assign(new AggregateError(errors, 'Execution transaction committed; afterCommit callback failed'), {
          code: 'execution/postcommit-failed', phase: 'postcommit', committed: true,
        });
      }
    }
    return returned;
  }

  afterCommit(fn) {
    if (typeof fn !== 'function') throw new TypeError('afterCommit requires a function');
    if (this._depth > 0) {
      this._afterCommit.push(fn);
      return undefined;
    }
    return fn();
  }

  admit({ scope, nonce, input, record }) {
    key(scope, 'scope'); key(nonce, 'nonce');
    const digest = inputDigest(input);
    const copy = object(record);
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT digest, record FROM admissions WHERE scope = ? AND nonce = ?').get(scope, nonce);
      if (prior) {
        const conflict = prior.digest !== digest;
        const code = conflict ? 'send/nonce-digest-mismatch' : null;
        return { replayed: true, conflict, code, rejectionCode: code, record: JSON.parse(prior.record) };
      }
      this.db.prepare('INSERT INTO admissions(scope, nonce, digest, record) VALUES (?, ?, ?, ?)').run(scope, nonce, digest, JSON.stringify(copy));
      return { replayed: false, conflict: false, code: null, rejectionCode: null, record: copy };
    });
  }
  getAdmission(scope, nonce) {
    key(scope, 'scope'); key(nonce, 'nonce');
    const row = this.db.prepare('SELECT record FROM admissions WHERE scope = ? AND nonce = ?').get(scope, nonce);
    return row ? JSON.parse(row.record) : null;
  }
  // Recovery enumeration returns independent envelope + original record snapshots.
  // rowid preserves admission order; updates do not move an existing admission.
  listAdmissions(scope = null) {
    if (scope !== null) key(scope, 'scope');
    const rows = scope === null
      ? this.db.prepare('SELECT scope, nonce, digest, record FROM admissions ORDER BY rowid').all()
      : this.db.prepare('SELECT scope, nonce, digest, record FROM admissions WHERE scope = ? ORDER BY rowid').all(scope);
    return rows.map((row) => ({ scope: row.scope, nonce: row.nonce, digest: row.digest, record: JSON.parse(row.record) }));
  }
  updateAdmission(scope, nonce, patch) {
    const copy = object(patch, 'patch');
    return this.transaction(() => {
      const existing = this.getAdmission(scope, nonce);
      if (!existing) return null;
      const next = { ...existing, ...copy };
      this.db.prepare('UPDATE admissions SET record = ? WHERE scope = ? AND nonce = ?').run(JSON.stringify(next), scope, nonce);
      return next;
    });
  }
  saveRun(record) {
    const copy = object(record);
    const id = key(copy.runId, 'runId');
    const nonce = copy.clientNonce == null ? null : key(copy.clientNonce, 'clientNonce');
    const state = copy.state == null ? null : key(copy.state, 'state');
    this.db.prepare(`INSERT INTO runs(id, nonce, state, record) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET nonce = excluded.nonce, state = excluded.state, record = excluded.record`).run(id, nonce, state, JSON.stringify(copy));
    return copy;
  }
  getRun(runId) { return this._get('runs', key(runId, 'runId')); }
  listRuns() { return this._list('runs'); }
  getRunByNonce(clientNonce) {
    const row = this.db.prepare('SELECT record FROM runs WHERE nonce = ? ORDER BY rowid LIMIT 1').get(key(clientNonce, 'clientNonce'));
    return row ? JSON.parse(row.record) : null;
  }
  saveInteraction(record) { return this._save('interactions', record); }
  getInteraction(id) { return this._get('interactions', key(id, 'id')); }
  listInteractions() { return this._list('interactions'); }
  saveTask(record) { return this._save('tasks', record); }
  getTask(id) { return this._get('tasks', key(id, 'id')); }
  listTasks() { return this._list('tasks'); }

  // Optional atomic shallow patch; a state mismatch returns null unchanged.
  updateRun(runId, patch, expectedState = undefined) {
    return this._update('runs', runId, patch, expectedState);
  }
  updateTask(id, patch, expectedState = undefined) {
    return this._update('tasks', id, patch, expectedState);
  }
  _update(table, id, patch, expectedState) {
    key(id, 'id');
    const copy = object(patch, 'patch');
    return this.transaction(() => {
      const current = this._get(table, id);
      if (!current || (expectedState !== undefined && current.state !== expectedState)) return null;
      const next = { ...current, ...copy };
      return table === 'runs' ? this.saveRun({ ...next, runId: id }) : this.saveTask({ ...next, id });
    });
  }
  // Only fixed internal table names enter SQL; caller values are bound.
  _save(table, record) {
    const copy = object(record);
    key(copy.id, 'id');
    this.db.prepare(`INSERT INTO ${table}(id, record) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET record = excluded.record`).run(copy.id, JSON.stringify(copy));
    return copy;
  }
  _get(table, id) {
    const row = this.db.prepare(`SELECT record FROM ${table} WHERE id = ?`).get(id);
    return row ? JSON.parse(row.record) : null;
  }
  _list(table) {
    return this.db.prepare(`SELECT record FROM ${table} ORDER BY rowid`).all().map((row) => JSON.parse(row.record));
  }
  queueDelivery({ id, agentId, entry, event }) {
    key(id, 'id'); key(agentId, 'agentId');
    if (entry === undefined || event === undefined) throw new TypeError('delivery requires entry and event');
    const record = object({ id, agentId, entry, event });
    const serialized = canonicalJSON(record);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT record FROM outbox WHERE id = ?').get(id);
      if (row) {
        const prior = JSON.parse(row.record);
        const conflict = canonicalJSON(prior) !== serialized;
        return { replayed: true, conflict, code: conflict ? 'delivery/id-input-mismatch' : null, record: prior };
      }
      this.db.prepare('INSERT INTO outbox(id, record) VALUES (?, ?)').run(id, serialized);
      return { replayed: false, conflict: false, code: null, record };
    });
  }
  pendingDeliveries() {
    return this.db.prepare('SELECT record FROM outbox WHERE acked = 0 ORDER BY seq').all().map((row) => JSON.parse(row.record));
  }
  ackDelivery(id) {
    // Retain tombstones so duplicate enqueue never resurrects an acked ID.
    const result = this.db.prepare('UPDATE outbox SET acked = 1 WHERE id = ?').run(key(id, 'id'));
    return Number(result.changes) > 0;
  }
  getLegacyAdmission(nonce) { return this.getAdmission('legacy', nonce); }
  importLegacy(records) {
    if (!Array.isArray(records)) throw new TypeError('legacy records must be an array');
    return this.transaction(() => {
      const result = { imported: 0, skipped: 0, conflicts: 0, diagnostics: [] };
      for (let index = 0; index < records.length; index++) {
        const source = records[index];
        if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.clientNonce !== 'string' || !source.clientNonce.length) {
          result.diagnostics.push({ code: 'legacy/invalid-record', index });
          result.skipped++;
          continue;
        }
        const original = object(source);
        const nonce = original.clientNonce;
        // Preserve the old text-only inputDigest separately from the complete
        // canonical fingerprint of this legacy record used for import replay.
        const digest = inputDigest(original);
        const prior = this.db.prepare("SELECT digest FROM admissions WHERE scope = 'legacy' AND nonce = ?").get(nonce);
        if (prior) {
          result.skipped++;
          if (prior.digest !== digest) {
            result.conflicts++;
            result.diagnostics.push({ code: 'legacy/nonce-conflict', nonce, index });
          }
          continue;
        }
        const run = (typeof original.runId === 'string' && original.runId.length ? this.getRun(original.runId) : null) || this.getRunByNonce(nonce);
        const uncertain = ['accepted', 'pending'].includes(original.status) && !run;
        const record = {
          ...original, legacy: true, legacyInputDigest: original.inputDigest ?? null,
          ...(uncertain ? { needs_reconciliation: true, reconciliationReason: 'legacy-acceptance-without-run' } : {}),
        };
        this.db.prepare("INSERT INTO admissions(scope, nonce, digest, record) VALUES ('legacy', ?, ?, ?)").run(nonce, digest, JSON.stringify(record));
        result.imported++;
      }
      return result;
    });
  }
  migrateLegacy(root = this.root) {
    const file = path.join(root, 'send-acceptance.json');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { imported: 0, skipped: 0, conflicts: 0, diagnostics: [] };
      const diagnostic = { code: error instanceof SyntaxError ? 'legacy/corrupt-json' : 'legacy/read-failed', file, message: error.message };
      this._diagnose(diagnostic);
      return { imported: 0, skipped: 0, conflicts: 0, diagnostics: [diagnostic] };
    }
    if (!parsed || !Array.isArray(parsed.records)) {
      const diagnostic = { code: 'legacy/invalid-format', file, message: 'Expected an object containing a records array' };
      this._diagnose(diagnostic);
      return { imported: 0, skipped: 0, conflicts: 0, diagnostics: [diagnostic] };
    }
    return this.transaction(() => {
      const result = this.importLegacy(parsed.records);
      for (const diagnostic of result.diagnostics) this._diagnose({ ...diagnostic, file });
      if (parsed.historyGaps != null) {
        this.db.prepare("INSERT INTO meta(key, value) VALUES ('legacy_history_gaps', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(parsed.historyGaps));
      }
      return result;
    });
  }
  _diagnose(diagnostic) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES ('legacy_diagnostic', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(diagnostic));
  }
  getLegacyDiagnostics() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'legacy_diagnostic'").get();
    return row ? JSON.parse(row.value) : null;
  }
  close() {
    if (this._depth) throw new Error('Cannot close ExecutionStore during a transaction');
    if (!this._closed) {
      this.db.close();
      this._closed = true;
    }
  }
}
