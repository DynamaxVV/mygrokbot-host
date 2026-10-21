// Model bindings: per-agent model choice plus wire controls, persisted in one file.
//
// Shape (same idea as opengrok's model-bindings.json):
//
//   {
//     "version": 1,
//     "default": { "modelId": "...", "baseUrl": "...", "apiKeyEnv": "..." },
//     "agents": {
//       "<agentId>": {
//         "modelId": "grok-4.6",
//         "baseUrl": "https://api.x.ai/v1",
//         "apiKeyEnv": "XAI_API_KEY",
//         "maxMode": true,
//         "parameters": [{ "id": "effort", "value": "high" }]
//       }
//     }
//   }
//
// A binding never carries the key itself: it names an env var. That is the same
// rule the real hop binding file enforces (no user/pass, no query strings).

import path from 'node:path';
import { readJson, writeJsonAtomicLoose } from '../paths.mjs';

export const BINDINGS_FILENAME = 'model-bindings.json';

export function bindingsPath(root) {
  return path.join(root, BINDINGS_FILENAME);
}

export function loadBindings(root) {
  return readJson(bindingsPath(root), { version: 1, default: {}, agents: {} }) ?? {
    version: 1,
    default: {},
    agents: {},
  };
}

export function saveBindings(root, bindings) {
  writeJsonAtomicLoose(bindingsPath(root), bindings);
  return bindings;
}

export function resolveBinding(root, agentId, env = process.env) {
  const bindings = loadBindings(root);
  const entry = bindings.agents?.[agentId] ?? null;
  const base = bindings.default ?? {};
  const merged = { ...base, ...(entry ?? {}) };
  const apiKey = merged.apiKeyEnv ? env[merged.apiKeyEnv] ?? '' : env.MGB_API_KEY ?? '';
  return {
    agentId,
    modelId: merged.modelId ?? env.MGB_MODEL ?? 'grok-4.6',
    baseUrl: merged.baseUrl ?? env.MGB_BASE_URL ?? 'https://api.x.ai/v1',
    apiKey,
    apiKeyEnv: merged.apiKeyEnv ?? 'MGB_API_KEY',
    maxMode: merged.maxMode === true,
    parameters: Array.isArray(merged.parameters) ? merged.parameters : [],
    bound: entry != null,
  };
}

export function setAgentBinding(root, agentId, patch) {
  const bindings = loadBindings(root);
  bindings.agents = bindings.agents ?? {};
  const previous = bindings.agents[agentId] ?? {};
  const next = { ...previous, ...patch };

  // A stale *provider hint* is dropped when the model family changes; the endpoint is
  // NOT. Dropping baseUrl silently sent the next turn to the built-in default, which
  // then failed with a 400 — the endpoint is a deliberate setting, not a cache.
  if (patch.modelId && patch.baseUrl === undefined && previous.baseUrl) {
    const family = (m) => String(m ?? '').split('/')[0];
    if (previous.baseUrlForModelId && family(previous.baseUrlForModelId) !== family(patch.modelId)) {
      delete next.provider;
    }
  }

  next.baseUrlForModelId = next.modelId;
  bindings.agents[agentId] = next;
  return saveBindings(root, bindings);
}

export function removeAgentBinding(root, agentId) {
  const bindings = loadBindings(root);
  if (bindings.agents) delete bindings.agents[agentId];
  return saveBindings(root, bindings);
}
