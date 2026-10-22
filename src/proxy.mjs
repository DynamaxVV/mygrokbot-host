// Server-owned agents always route through this explicit transport seam.
import { randomUUID } from 'node:crypto';
import { directConversation, groupConversation, taskConversation } from './conversation.mjs';

export const PROXY_TIMEOUT_MS = 120_000;

const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
export const METHOD_CONTRACTS = {
  // Preserve the admission identity and execution/result context for callers that
  // poll a particular room member/run rather than the agent's latest DM reply.
  sendPrompt: (value) => ({ ...record(value), accepted: value?.accepted === true }),
  promptAcceptanceStatus: (value) => value && typeof value === 'object' ? value : { outcome: 'not-found' },
  interruptAgentRun: (value) => ({ ...record(value), hadActiveRun: value?.hadActiveRun === true }),
  respondToWidget: (value) => ({ ...record(value), accepted: value?.accepted !== false }),
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
  constructor({ roster, transport, log = () => {} }) {
    Object.assign(this, { roster, transport, log });
  }

  isProxiedAgent(agentId) {
    return Boolean(agentId && this.roster.profile(agentId)?.harness === 'temporal');
  }

  async act({ method, args, fallback = null, timeoutMs = PROXY_TIMEOUT_MS }) {
    if (!this.transport) throw new ProxyRefusedError(`no proxy transport configured for ${method}`, 'no_transport');
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
    const reason = typeof reply?.error === 'string' ? reply.error : reply?.error?.message ?? 'refused';
    this.log('proxy.refused', { method, reason, ms: Date.now() - started });
    const code = String(reply?.code ?? reply?.error?.code ?? reply?.kind ?? '').toLowerCase().replace(/-/g, '_');
    const unsupported = ['unsupported_method', 'method_unsupported', 'method_not_supported', 'not_implemented', 'unimplemented', 'method_not_found', '-32601'].includes(code) ||
      /^(?:unimplemented|not[_ -]implemented|method[_ -](?:unsupported|not[_ -]implemented))$/i.test(reason) ||
      /^(?:unsupported method|method not supported|unsupported by this transport)(?::|$)/i.test(reason);
    if (typeof fallback === 'function' && unsupported) {
      this.log('proxy.fallback', { method, reason, kind: 'unsupported_method' });
      return fallback();
    }
    throw new ProxyRefusedError(`server refused ${method}: ${reason}`, 'remote_refusal');
  }
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`timed out after ${ms}ms`);
          error.kind = 'timeout';
          reject(error);
        }, ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The stand-in is an explicitly configured executor, never an automatic fallback
// after an actual remote failure. Public gateway sendPrompt restricts to the
// surface conversation before reaching this seam; direct internal callers still
// need real group membership or a durable task/run association.
export function createLocalTemporalTransport({ engine, roster, log = () => {} }) {
  const refusal = (message) => { throw new ProxyRefusedError(message, 'context_mismatch'); };
  const contextFor = (args, agentId, clientNonce) => {
    const direct = directConversation(agentId);
    const conversationId = args.conversationId ?? direct;
    if (typeof conversationId !== 'string') refusal('conversationId must be a string');
    let taskId = null;
    if (conversationId === direct) {
      if (args.taskId != null) refusal('task context does not match a direct conversation');
    } else if (conversationId.startsWith('group:')) {
      const groupId = conversationId.slice(6);
      if (args.taskId != null || roster.profile(groupId)?.isGroup !== true || !roster.groupMembers(groupId).includes(agentId)) {
        refusal('agent is not a member of this conversation');
      }
    } else if (conversationId.startsWith('task:')) {
      const task = typeof args.taskId === 'string' ? engine.execution?.getTask(args.taskId) : null;
      const run = task?.runId ? engine.getRun(task.runId) : null;
      if (!task || task.toBotId !== agentId || conversationId !== taskConversation(task.id) ||
          !run || run.agentId !== agentId || run.taskId !== task.id || run.conversationId !== conversationId || run.clientNonce !== clientNonce) {
        refusal('task context has no matching durable run');
      }
      taskId = task.id;
    } else refusal('conversation does not belong to this agent');
    if (args.sourceMessageId != null) {
      const owner = conversationId.startsWith('group:') ? conversationId.slice(6) : agentId;
      const source = roster.store(owner).getEntry(args.sourceMessageId);
      if (!source || (source.conversationId ?? directConversation(owner)) !== conversationId) refusal('source message does not belong to this conversation');
    }
    if (args.inputThroughSeq != null && (!Number.isSafeInteger(args.inputThroughSeq) || args.inputThroughSeq < 0)) {
      refusal('inputThroughSeq must be a nonnegative integer');
    }
    if (args.lane != null && !['user', 'agent', 'background'].includes(args.lane)) refusal('unknown execution lane');
    return { conversationId, taskId, hidden: args.hidden === true || conversationId !== direct };
  };

  return {
    async performAction({ method, args = {} }) {
      try {
        switch (method) {
          case 'sendPrompt': {
            const agentId = roster.resolve(args.agentId);
            if (roster.profile(agentId)?.isGroup === true) refusal('group prompts must use the room admission API');
            const clientNonce = args.clientNonce ?? randomUUID();
            const context = contextFor(args, agentId, clientNonce);
            const admission = engine.admit({
              agentId, prompt: args.prompt, clientNonce, trigger: args.trigger ?? 'proxy',
              attachmentPaths: args.attachmentPaths ?? [], replyTo: args.replyTo ?? null,
              ...context, sourceMessageId: args.sourceMessageId ?? null,
              inputThroughSeq: args.inputThroughSeq ?? null,
              ...(args.lane != null ? { lane: args.lane } : {}),
              ...(args.source != null ? { source: args.source } : {}),
              contextPrompt: args.contextPrompt === true,
              viaProxy: true,
            });
            return { status: 'ok', result: { ...admission, accepted: true } };
          }
          case 'promptAcceptanceStatus': {
            const status = engine.acceptanceStatus(args.clientNonce);
            if (status.state === 'unknown') return { status: 'ok', result: { ...status, outcome: 'not-found' } };
            if (args.agentId && status.agentId && roster.resolve(args.agentId) !== status.agentId) refusal('acceptance belongs to another agent');
            return { status: 'ok', result: { ...status, outcome: 'found', record: status } };
          }
          case 'interruptAgentRun': {
            const agentId = roster.resolve(args.agentId ?? args.id);
            if (args.runId != null) {
              const run = engine.getRun(args.runId);
              if (!run || run.agentId !== agentId) refusal('run does not belong to this agent');
            }
            const out = engine.interrupt(agentId, { runId: args.runId ?? null });
            return { status: 'ok', result: { ...out, ...(args.runId ? { runId: args.runId } : {}), hadActiveRun: out.streaming === true || out.interrupted === true } };
          }
          case 'respondToWidget': {
            const out = await engine.answerWidget({ agentId: args.agentId, entryId: args.entryId, value: args.value });
            return { status: 'ok', result: { ...out, accepted: out.answered !== false } };
          }
          // This transport has no remote transcript mutation implementation.
          // Returning a successful no-op would make the caller believe it ran.
          default:
            return { status: 'error', error: `unsupported by this transport: ${method}` };
        }
      } catch (error) {
        log('proxy.local.error', { method, error: String(error.message) });
        return { status: 'error', error: String(error.message) };
      }
    },
  };
}
