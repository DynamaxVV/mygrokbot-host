// Provider keys on disk.
//
// A binding file only ever names an environment variable (see providers/bindings.mjs),
// which keeps keys out of git and out of `doctor` output. But a desktop app has no shell
// to export them from, so the app needs somewhere to put the value itself.
//
// That place is <dataRoot>/secrets/env.json, mode 0600:
//
//   { "MGB_REAL_KEY": "sk-…" }
//
// It is read into process.env at startup, so every existing code path that resolves a
// key by env name works unchanged.

import fs from 'node:fs';
import path from 'node:path';

export function secretsPath(root) {
  return path.join(root, 'secrets', 'env.json');
}

export function readSecrets(root) {
  try {
    const raw = fs.readFileSync(secretsPath(root), 'utf8');
    const bag = JSON.parse(raw);
    return bag && typeof bag === 'object' && !Array.isArray(bag) ? bag : {};
  } catch {
    return {};
  }
}

function writeSecrets(root, bag) {
  const file = secretsPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Create with 0600 before writing, so the key is never world-readable even briefly.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(bag, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // rename keeps the mode, but re-assert in case the temp file already existed.
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return bag;
}

export function setSecret(root, name, value) {
  const key = String(name ?? '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`invalid env var name: ${name}`);
  }
  const bag = readSecrets(root);
  const v = String(value ?? '').trim();
  if (v) {
    bag[key] = v;
    process.env[key] = v;
  } else {
    delete bag[key];
    delete process.env[key];
  }
  writeSecrets(root, bag);
  return { name: key, isSet: Boolean(v) };
}

export function deleteSecret(root, name) {
  const bag = readSecrets(root);
  delete bag[name];
  delete process.env[name];
  writeSecrets(root, bag);
  return { name, isSet: false };
}

// Which env vars have a value, without exposing the values.
export function secretStatus(root, names = []) {
  const bag = readSecrets(root);
  const out = {};
  for (const n of names) {
    const v = process.env[n] ?? bag[n] ?? '';
    out[n] = { isSet: Boolean(v), source: process.env[n] ? 'env' : bag[n] ? 'file' : null };
  }
  return out;
}

// Called once at startup: fill process.env from the file without clobbering anything the
// caller already exported (an explicit env var wins over the stored copy).
export function loadSecretsIntoEnv(root) {
  const bag = readSecrets(root);
  let n = 0;
  for (const [k, v] of Object.entries(bag)) {
    if (typeof v === 'string' && v && !process.env[k]) { process.env[k] = v; n += 1; }
  }
  return n;
}

export function maskKey(value) {
  const v = String(value ?? '');
  if (!v) return '';
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}
