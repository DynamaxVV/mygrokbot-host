// Server agent proxy: an agent whose harness is "temporal" runs elsewhere, and every
// gateway method for it is forwarded instead of executed locally.
//
// Read from the deployed host:
//   server-agent-proxy/performs  isProxiedAgent(id) -> requiredAgents.has(id)
//                                performAction({ method, args }) -> { status, ... }
//   gateway routing              `if (!proxy.isProxiedAgent(id)) return api.<method>(args);`
//                                then `act({ method, args }, validate, fallback)`
//
// Two behaviours are worth keeping verbatim:
//
//   1. The proxy is decided per agent from profile.harness, and the *same* check
//      guards every method. There is no "some methods are local" special case.
//   2. `act()` falls back to the local API when the remote refuses, but a refusal is
//      classified first: a timeout or an unsupported method becomes a typed refusal,
//      not a silent local execution. Falling back to local would mean the box runs a
//      turn the server was supposed to run.
//
// This module does not invent a wire protocol. It defines the transport seam and a
// local stand-in that speaks the same request/response shape, so a real remote can be
// dropped in without touching the gateway.

import { randomUUID } from 'node:crypto';

export const PROXY_TIMEOUT_MS = 120_000;

// The shape `act()` validates against, per method: what a caller may rely on.
export const METHOD_CONTRACTS = {
  // Keep the nonce and timestamp: the caller needs them to poll for acceptance, and
  // the deployed host's validator returns `{accepted}` while passing the rest through
  // in the same reply object.
  sendPrompt: (value) => ({
    accepted: value?.accepted === true,
    ...(value?.clientNonce ? { clientNonce: value.clientNonce } : {}),
    ...(value?.acceptedAtMs ? { acceptedAtMs: value.acceptedAtMs } : {}),
  }),
  promptAcceptanceStatus: (value) => (value && typeof value === 'object' ? value : { outcome: 'not-found' }),
  interruptAgentRun: (value) => ({ hadActiveRun: value?.hadActiveRun === true }),
  respondToWidget: (value) => ({ accepted: value?.accepted !== false }),
  startFreshConversation: () => null,
  rollBackConversation: () => null,
  submitSecret: () => null,
  dismissWidget: () => null,
};

export class ProxyRefusedError extends Error {
  constructor(message, kind = 'refused') {
    super(message);
    this.name = 'ProxyRefusedError';
    this.kind = kind;
    this.status = 502;
  }
}

export class ServerAgentProxy {
  /**
   * @param transport { performAction({method, args}) => Promise<{status, result?, error?}> }
   *                   an object with the same shape the deployed host's proxy uses.
   */
  constructor({ roster, transport, log = () => {} }) {
    this.roster = roster;
    this.transport = transport;
    this.log = log;
  }

  // Decided from profile.harness, exactly like readSandProfileHarness in the host.
  isProxiedAgent(agentId) {
    if (!agentId) return false;
    const profile = this.roster.profile(agentId);
    return profile?.harness === 'temporal';
  }

  // Forward one method. Returns the validated reply, or throws a typed refusal.
  async act({ method, args, fallback = null, timeoutMs = PROXY_TIMEOUT_MS }) {
    if (!this.transport) {
      throw new ProxyRefusedError(`no proxy transport configured for ${method}`, 'no_transport');
    }
    const started = Date.now();
    let reply;
    try {
      reply = await withTimeout(this.transport.performAction({ method, args }), timeoutMs);
    } catch (error) {
      const kind = error?.kind === 'timeout' ? 'timeout' : 'transport_error';
      this.log('proxy.error', { method, kind, ms: Date.now() - started });
      throw new ProxyRefusedError(`server agent proxy failed for ${method}: ${error.message}`, kind);
    }

    if (reply?.status === 'ok') {
      const validate = METHOD_CONTRACTS[method];
      const value = validate ? validate(reply.result) : reply.result;
      this.log('proxy.ok', { method, ms: Date.now() - started });
      return value;
    }

    // A refusal is NOT a reason to run the turn locally: the server owns this agent.
    const reason = reply?.error ?? 'refused';
    this.log('proxy.refused', { method, reason, ms: Date.now() - started });
    if (fallback) {
      // The host allows a fallback only where the server explicitly cannot serve the
      // method at all (e.g. a room that the server has not implemented). It is opt-in
      // per call site, never a default.
      this.log('proxy.fallback', { method, reason });
      return fallback();
    }
    throw new ProxyRefusedError(`server refused ${method}: ${reason}`, 'remote_refusal');
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const t = setTimeout(() => {
        const err = new Error(`timed out after ${ms}ms`);
        err.kind = 'timeout';
        reject(err);
      }, ms);
      t.unref?.();
    }),
  ]);
}

/**
 * A local transport that answers with the same envelope the remote does, so the
 * gateway path can be exercised without a server. It runs the turn in-process and
 * reports `accepted` the way the server does — the point is the *routing*, not a
 * fake cloud.
 */
export function createLocalTemporalTransport({ engine, roster, log = () => {} }) {
  const pending = new Map();
  return {
    async performAction({ method, args }) {
      switch (method) {
        case 'sendPrompt': {
          const clientNonce = args.clientNonce ?? randomUUID();
          try {
            const acc = engine.admit({
              agentId: args.agentId,
              prompt: args.prompt,
              clientNonce,
              trigger: 'proxy',
              attachmentPaths: args.attachmentPaths ?? [],
              // This transport *is* the executor for a temporal agent.
              viaProxy: true,
            });
            pending.set(clientNonce, acc);
            return { status: 'ok', result: { accepted: true, clientNonce, acceptedAtMs: acc.acceptedAtMs } };
          } catch (error) {
            return { status: 'error', error: String(error.message) };
          }
        }
        case 'promptAcceptanceStatus': {
          const st = engine.acceptanceStatus(args.clientNonce);
          if (st.state === 'unknown') return { status: 'ok', result: { outcome: 'not-found' } };
          return { status: 'ok', result: { outcome: 'found', state: st.state, record: st } };
        }
        case 'interruptAgentRun': {
          const out = engine.interrupt(args.id);
          return { status: 'ok', result: { hadActiveRun: out.streaming === true || out.interrupted === true } };
        }
        case 'respondToWidget': {
          const out = await engine.answerWidget({ agentId: args.agentId, entryId: args.entryId, value: args.value });
          return { status: 'ok', result: { accepted: out.answered !== false } };
        }
        case 'startFreshConversation':
        case 'rollBackConversation':
        case 'submitSecret':
        case 'dismissWidget':
          return { status: 'ok', result: null };
        default:
          return { status: 'error', error: `unsupported by this transport: ${method}` };
      }
    },
  };
}
