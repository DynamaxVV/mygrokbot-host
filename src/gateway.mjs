// Gateway: loopback JSON-RPC over HTTP + SSE event stream + a tiny web client.
//
// Mirrors the real sand-host gateway rather than inventing a new API:
//   GET  /health                 -> { ok, pid, isBusy, activeAgentId, startedAt }
//   GET  /events                 -> text/event-stream of bus events
//   POST /api/<method>           -> { ok: true, result } | { ok: false, error }
//   GET  /                       -> bundled web client
//
// Method names are the same vocabulary the cloud host exposes (listAgents,
// sendPrompt, getAgentTranscript, resolveAutoReviewApproval, ...), so a client
// written against a box snapshot reads the same way here.
//
// Auth: gateway.json carries a token; when set, every /api and /events call needs
// Authorization: Bearer <token>. Requests with a browser Origin header are refused,
// exactly like the host does, so a random web page cannot drive the gateway.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { writeJson, readJson } from './paths.mjs';
import { resolveBinding, setAgentBinding, removeAgentBinding, loadBindings } from './providers/bindings.mjs';
import { searchTranscripts } from './db.mjs';
import { secretStatus, setSecret, maskKey } from './secrets.mjs';
import { loadRules, saveRules } from './review.mjs';
import { directConversation, groupConversation, entryConversation, TERMINAL_RUN_STATES } from './conversation.mjs';

const MAX_BODY = 8 * 1024 * 1024;

function json(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (chunks.reduce((n, c) => n + c.length, 0) > MAX_BODY) {
      throw Object.assign(new Error('body too large'), { status: 413 });
    }
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Same-origin test: the Origin must name the host we are actually serving on. Any
// other page (including one on another localhost port) is refused, so a random tab
// cannot drive this gateway.
function isSameOrigin(origin, req) {
  try {
    const parsed = new URL(origin);
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!host) return false;
    return parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

function authorized(req, token) {
  if (!token) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createGateway({ p, roster, catalog, engine, tools, bus, routines, rooms, proxy, log = () => {} }) {
  const startedAt = Date.now();
  const config = { host: '127.0.0.1', port: 0, token: null };
  const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
  const surface = (agentId, conversationId = null) => {
    const id = roster.resolve(agentId);
    const conv = roster.profile(id)?.isGroup === true ? groupConversation(id) : directConversation(id);
    // JSON ctx/hidden/taskId flags are data, never a capability to enter an
    // internal group-member/task conversation through the public gateway.
    if (conversationId != null && conversationId !== conv) throw fail('conversation/owner-mismatch');
    return { id, conversationId: conv };
  };
  const allVisible = (agentId, conversationId = null, { includeToolCalls = true } = {}) => {
    const { id, conversationId: conv } = surface(agentId, conversationId);
    // The full/export/branch API must not silently truncate at a window's 10k
    // cap. Apply the same display-conversation projection over the complete store.
    const rows = roster.store(id).readAll({ includeToolCalls });
    const hiddenTurns = new Set(rows.filter((row) => row.hidden && row.turnId).map((row) => row.turnId));
    return rows.filter((row) => !row.hidden && !row.branched &&
      (row.displayConversationId ?? entryConversation(row, id, hiddenTurns)) === conv);
  };
  const visibleWindow = (agentId, conversationId, options = {}) => {
    const { id, conversationId: conv } = surface(agentId, conversationId);
    return engine.visibleEntries(id, { ...options, conversationId: conv });
  };
  const requireTask = (taskId) => {
    if (typeof taskId !== 'string' || !taskId) throw fail('task/invalid-id', 400);
    const task = engine.tasks?.get(taskId) ?? engine.execution.getTask(taskId);
    if (!task) throw fail('task/not-found', 404);
    return task;
  };
  const requireRun = (runId) => {
    if (typeof runId !== 'string' || !runId) throw fail('run/invalid-id', 400);
    const run = engine.getRun(runId);
    if (!run) throw fail('run/not-found', 404);
    return run;
  };
  const executionSummary = () => {
    const execution = engine.execution;
    const runs = execution.listRuns(), tasks = execution.listTasks(), interactions = execution.listInteractions();
    const counts = (rows) => rows.reduce((out, row) => { out[row.state ?? 'unknown'] = (out[row.state ?? 'unknown'] ?? 0) + 1; return out; }, {});
    return { runs: runs.length, runStates: counts(runs), tasks: tasks.length, taskStates: counts(tasks),
      interactions: interactions.length, interactionStates: counts(interactions), pendingDeliveries: execution.pendingDeliveries().length };
  };
  const retireConversation = async ({ agentId, conversationId = null, entryId = null, fresh = false }) => {
    const { id, conversationId: conv } = surface(agentId, conversationId);
    if (proxy?.isProxiedAgent(id)) return proxy.act({ method: fresh ? 'startFreshConversation' : 'rollBackConversation', args: { agentId: id, conversationId: conv, entryId } });
    const rows = allVisible(id, conv);
    const cut = fresh ? null : rows.find((row) => row.id === entryId);
    if (!fresh && !cut) throw fail('conversation/message-not-found', 404);
    if (roster.profile(id)?.isGroup === true) await rooms.cancel(id);
    // Cancel this conversation only; physical stores also contain private task
    // and group-member work whose execution/history must remain independent.
    for (const run of engine.execution.listRuns()) if (run.conversationId === conv && !TERMINAL_RUN_STATES.has(run.state)) await engine.cancelRun(run.runId, fresh ? 'conversation reset' : 'conversation rolled back');
    const removed = rows.filter((row) => fresh || row.seq > cut.seq);
    for (const row of removed) roster.store(id).updateEntry(row.id, (entry) => ({ ...entry, branched: true }));
    bus.publish({ type: 'conversation-reset', agentId: id, conversationId: conv, ...(cut ? { throughEntryId: cut.id } : {}), fresh });
    return { agentId: id, conversationId: conv, removed: removed.length, ...(cut ? { entryId: cut.id } : {}) };
  };

  const methods = {
    // ---- health / host --------------------------------------------------
    getHostStatus: () => ({
      ok: true,
      pid: process.pid,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      dataRoot: p.root,
      activeAgentId: roster.activeId(),
      agentCount: roster.list().length,
      streamingClients: bus.size,
      runningTurns: engine.running.size,
      runningAgents: [...engine.running.keys()],
    }),
    // The box publishes a fixed port map; documenting it here keeps clients from
    // guessing. Values mirror what the real logs show.
    // Port table copied verbatim from the box's generated contract
    // (box-scripts/box-contract.generated.mjs -> SAND_BOX_PORTS / SAND_BOX_FORK_PORT_BASES).
    // The host gateway slot is replaced with this process's real port.
    getProxyStatus: () => ({
      configured: proxy != null,
      transport: proxy?.transport == null ? 'none' : proxy.transport.constructor?.name ?? 'custom',
      proxiedAgents: roster.list().filter((a) => proxy?.isProxiedAgent(a.id)).map((a) => ({ id: a.id, name: a.name })),
    }),
    getServiceMap: () => ({
      host: { gateway: config.port, bind: config.host, authRequired: Boolean(config.token) },
      ports: {
        primaryExecDaemon: 1337,
        primaryPty: 1338,
        primaryNovncWebsockify: 6080,
        windowRouter: 1339,
        forkNovncWebsockify: 6081,
        hostGateway: config.port,
        egressTunnelWebSocket: 8790,
        egressConnectProxy: 8791,
      },
      forkPortBases: { execDaemon: 14000, pty: 13600, vnc: 5900 },
      cdpPortBase: 9222,
      headers: { display: 'x-sand-display', windowOwner: 'x-sand-window-owner' },
      desktops: [
        { display: ':1', role: 'primary' },
        { display: ':2', role: 'agent' },
        { display: ':3', role: 'agent' },
      ],
    }),
    // Why a prompt to this bot would or would not run here — the same question the
    // deployed host answers from profile.json's harness field.
    getAgentRoute: ({ agentId }) => {
      const id = roster.resolve(agentId);
      const route = engine.route(id);
      return { ...route, proxied: proxy?.isProxiedAgent(id) === true };
    },
    getHostSettings: () => readJson(p.settings, {}),
    // Language drives both the UI strings and the language the bot writes memory in.
    setLanguage: ({ language }) => {
      if (!['zh', 'en'].includes(language)) throw new Error(`unsupported language: ${language}`);
      const next = { ...(readJson(p.settings, {}) ?? {}), language };
      writeJson(p.settings, next);
      return { language };
    },
    setHostSettings: ({ patch }) => {
      // Deep merge for nested sections (notifications, autoReviewInstructions):
      // a shallow spread replaced whole objects and silently dropped sibling keys.
      const cur = readJson(p.settings, {}) ?? {};
      const merge = (a, b) => {
        const out = { ...a };
        for (const [k, v] of Object.entries(b ?? {})) {
          out[k] = v && typeof v === 'object' && !Array.isArray(v)
            ? merge(a?.[k] ?? {}, v)
            : v;
        }
        return out;
      };
      const next = merge(cur, patch);
      writeJson(p.settings, next);
      return next;
    },

    // ---- roster ---------------------------------------------------------
    listAgents: () => roster.list(),
    countAgents: () => ({ count: roster.list().length }),
    getAgent: ({ agentId }) => roster.summary(roster.resolve(agentId)),
    createAgent: ({ profile, activate = true }) => roster.create(profile ?? {}, { activate }),
    updateAgent: ({ agentId, patch }) => roster.update(roster.resolve(agentId), patch ?? {}),
    deleteAgents: ({ agentIds }) => ({ deleted: agentIds.map((id) => roster.delete(roster.resolve(id))) }),
    createGroup: ({ name, description = '', memberAgentIds = [] }) =>
      roster.createGroup({ name, description, memberAgentIds }),
    getGroupMembers: ({ agentId }) => {
      const id = roster.resolve(agentId);
      return { agentId: id, memberIds: roster.groupMembers(id) };
    },
    setGroupMembers: ({ agentId, memberAgentIds }) =>
      roster.setGroupMembers(roster.resolve(agentId), memberAgentIds),

    // Room turns: round-robin over members, six-state outcome per member.
    runRoomTurn: ({ roomId, newMessages = [], isWindingDown = false, deadlineMs = null }) =>
      rooms.runRound({ roomId, newMessages, isWindingDown, deadlineMs }),
    cancelRoomTurn: ({ roomId }) => rooms.cancel(roomId),
    deliverRoomMemberTurnResult: (args) => rooms.submitResult(args),
    getRoomDiagnostics: () => rooms.diagnostics(),
    setActiveAgent: ({ agentId }) => ({ activeAgentId: roster.setActive(roster.resolve(agentId)) }),
    getActiveAgent: () => ({ activeAgentId: roster.activeId() }),
    setAgentSettings: ({ agentId, patch }) => roster.updateSettings(roster.resolve(agentId), patch ?? {}),
    searchAgents: ({ query }) => {
      const q = String(query ?? '').toLowerCase();
      return roster.list().filter((a) => `${a.name} ${a.description}`.toLowerCase().includes(q));
    },

    // ---- transcript -----------------------------------------------------
    getAgentTranscript: ({ agentId, conversationId = null, limit = 200, beforeSeq = null }) =>
      visibleWindow(agentId, conversationId, { limit, beforeSeq }),
    getAgentTranscriptTail: ({ agentId, conversationId = null, limit = 50, beforeSeq = null }) =>
      visibleWindow(agentId, conversationId, { limit, beforeSeq }).reverse(),
    // Calls/results join only within the same visible conversation; a group's
    // private tool trace in a member's physical store never enters its DM outline.
    getAgentOutline: ({ agentId, conversationId = null, limit = 200 }) => {
      const all = allVisible(agentId, conversationId);
      const count = Math.max(1, Math.min(Number(limit) || 200, 10000));
      const calls = all
        .filter((e) => e.kind === 'tool-call')
        .slice(-count)
        .map((e) => ({
          id: e.id,
          name: e.name ?? 'tool',
          status: e.status ?? 'ok',
          summary: e.summary ?? '',
          args: e.args ?? {},
          turnId: e.turnId ?? null,
          conversationId: e.displayConversationId ?? e.conversationId,
          timestampMs: e.timestampMs,
        }));
      const results = new Map(all.filter((e) => e.kind === 'tool-result').map((e) => [e.callId, e]));
      return calls.map((call) => {
        const hit = results.get(call.id);
        return { ...call, hasResult: hit != null, result: hit?.result ?? null, isError: hit?.isError === true };
      });
    },
    getAgentTranscriptAll: ({ agentId, conversationId = null }) => allVisible(agentId, conversationId),
    startFreshConversation: (args) => retireConversation({ ...args, fresh: true }),
    rollBackConversation: (args) => retireConversation({ ...args, fresh: false }),

    // Branch a conversation at a message: the new bot inherits the transcript up to
    // and including that entry, then diverges. The original is untouched.
    branchConversation: ({ agentId, entryId, conversationId = null }) => {
      const { id, conversationId: sourceConv } = surface(agentId, conversationId);
      const source = roster.summary(id);
      const rows = allVisible(id, sourceConv);
      const cut = rows.findIndex((row) => row.id === entryId);
      if (cut < 0) throw new Error('message not found');
      const parent = roster.profile(id) ?? {};
      // Branch names must be unique or the roster becomes a wall of identical rows.
      const base = `${source?.name ?? 'Bot'} 分支`;
      const taken = new Set(roster.list().map((a) => a.name));
      let branchName = base;
      for (let i = 2; taken.has(branchName); i += 1) branchName = `${base} ${i}`;
      const branch = roster.create({
        name: branchName,
        description: parent.description ?? '',
        harness: parent.harness ?? 'local',
      });
      // A branch is a continuation of its source, so it must inherit the model binding —
      // without it the branch falls back to the built-in default provider and cannot run.
      const sourceBinding = loadBindings(p.root).agents?.[id];
      if (sourceBinding) setAgentBinding(p.root, branch.id, sourceBinding);

      const store = roster.store(branch.id);
      const copied = rows.slice(0, cut + 1);
      const ids = new Map(copied.map((row) => [row.id, `branch-${randomUUID()}`]));
      const turns = new Map();
      const turnId = (value) => {
        if (!turns.has(value)) turns.set(value, `branch-segment-${randomUUID()}`);
        return turns.get(value);
      };
      for (const row of copied) {
        const { seq, displayConversationId, interactionId, runId, taskId, clientNonce, sourceMessageId, ...rest } = row;
        const next = { ...rest, id: ids.get(row.id), schemaVersion: 2,
          botId: branch.id, conversationId: directConversation(branch.id), hidden: false,
          sourceConversationId: row.conversationId ?? sourceConv, sourceEntryId: row.id,
          ...(runId ? { sourceRunId: runId } : {}), ...(taskId ? { sourceTaskId: taskId } : {}),
          streaming: false, held: false };
        if (row.turnId) next.turnId = turnId(row.turnId);
        if (row.segmentId) next.segmentId = turnId(row.segmentId);
        if (row.callId) {
          if (ids.has(row.callId)) next.callId = ids.get(row.callId);
          else if (row.kind === 'tool-result') { next.callId = `historical-${randomUUID()}`; next.sourceCallId = row.callId; }
          else delete next.callId;
        }
        if (typeof row.replyTo === 'string') {
          if (ids.has(row.replyTo)) next.replyTo = ids.get(row.replyTo);
          else { next.sourceReplyTo = row.replyTo; delete next.replyTo; }
        }
        if (row.kind === 'tool-call' && !['ok', 'error', 'denied', 'blocked'].includes(row.status)) next.status = 'interrupted';
        if (row.message?.type === 'auto-review-approval') {
          next.message = { ...row.message, resolution: row.message.resolution ?? 'expired', inert: true };
        } else if (row.message?.type === 'question') {
          next.message = { ...row.message, answered: true, cancelled: true, inert: true, widgetId: `historical-${randomUUID()}` };
        }
        store.appendEntry(next);
      }
      return { agentId: branch.id, conversationId: directConversation(branch.id), name: branch.name, copied: copied.length };
    },

    // Export one conversation as a self-contained markdown transcript.
    exportTranscript: ({ agentId, conversationId = null, format = 'markdown' }) => {
      const { id, conversationId: conv } = surface(agentId, conversationId);
      const agent = roster.summary(id);
      const rows = allVisible(id, conv);
      const lines = [`# ${agent?.name ?? 'Bot'}`, ''];
      const fmt = (ms) => {
        if (!ms) return '';
        const d = new Date(ms);
        const p2 = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      };
      for (const row of rows) {
        if (row.kind === 'message' && row.message?.type === 'text') {
          const who = row.role === 'user'
            ? (row.fromAgent?.name ?? '我')
            : (row.fromAgent?.name ?? agent?.name ?? 'bot');
          lines.push(`**${who}** · ${fmt(row.timestampMs)}`, '', row.message.content, '');
        } else if (row.kind === 'send-message' && row.message?.content) {
          lines.push(`**${agent?.name ?? 'bot'}** · ${fmt(row.timestampMs)}`, '', row.message.content, '');
        } else if (row.kind === 'tool-call') {
          lines.push(`> 工具 \`${row.name}\` ${JSON.stringify(row.args ?? {})}`, '');
        } else if (row.kind === 'reasoning' && row.text) {
          lines.push('<details><summary>思考</summary>', '', row.text, '', '</details>', '');
        }
      }
      const body = lines.join('\n');
      return { format, filename: `${agent?.name ?? 'bot'}-${Date.now()}.md`, content: body };
    },

    // Cross-bot history search: "where did I discuss X" spans every agent.
    searchTranscripts: ({ query, limit = 60 }) => {
      const stores = roster.list()
        .filter((a) => !a.isGroup)
        .map((a) => ({ agentId: a.id, agentName: a.name, store: { readAll: () => allVisible(a.id) } }));
      return searchTranscripts({ stores, query, limit });
    },
    // Rows accepted but not yet settled. The client merges this with the transcript
    // so overlapping sends keep their order instead of jumping.
    getPendingEntryIds: ({ agentId, conversationId = null }) => {
      const { id, conversationId: conv } = surface(agentId, conversationId);
      return engine.pendingEntryIds(id, conv);
    },
    listTasks: ({ agentId = null, parentRunId = null, conversationId = null, state = null } = {}) => {
      const id = agentId == null ? null : roster.resolve(agentId);
      if (parentRunId != null) requireRun(parentRunId);
      return engine.execution.listTasks().filter((task) =>
        (!id || task.fromBotId === id || task.toBotId === id) && (!parentRunId || task.parentRunId === parentRunId) &&
        (!conversationId || task.returnConversationId === conversationId) && (!state || task.state === state));
    },
    getTask: ({ taskId }) => requireTask(taskId),
    cancelTask: async ({ taskId, reason = 'task cancelled by operator' }) => {
      const task = requireTask(taskId);
      if (!task.runId) throw fail('task/missing-run');
      const run = requireRun(task.runId);
      if (run.taskId !== task.id || run.agentId !== task.toBotId) throw fail('task/run-mismatch');
      const requested = await engine.cancelRun(run.runId, String(reason));
      return { taskId, runId: run.runId, requested, task: requireTask(taskId) };
    },
    getRunStatus: ({ runId }) => requireRun(runId),
    // nonce -> entryId pairs, so a client that optimistically rendered by nonce can
    // re-key the node once the row lands (tweb changedMids).
    getChangedMids: () => engine.changedMids.entries(),
    // The raw acceptance table: ids and states only, never prompt text. Useful when
    // reconciling what the client shows against what the host actually accepted.
    getAcceptanceTable: () =>
      [...engine.acceptances.values()].map((a) => ({
        agentId: a.agentId,
        entryId: a.entryId,
        state: a.state,
        trigger: a.trigger,
      })),

    // ---- prompts --------------------------------------------------------
    // Every method below checks isProxiedAgent first, the same guard the deployed host
    // applies on all of them: a temporal agent's work belongs to the server.
    sendPrompt: async ({ agentId, prompt, clientNonce = null, nonce = null, conversationId = null, attachmentPaths = [], replyTo = null, mentionAgentIds = null, mentions = null, strategy = null }) => {
      const { id, conversationId: conv } = surface(agentId, conversationId);
      if (!String(prompt ?? '').trim() && !(attachmentPaths?.length)) throw new Error('prompt is empty');
      if (clientNonce != null && nonce != null && clientNonce !== nonce) throw fail('send/nonce-mismatch');
      const acceptedNonce = clientNonce ?? nonce ?? randomUUID();
      const text = String(prompt ?? '');
      // Group routing precedes proxy routing: a group is a room surface, never
      // an agent model, even if a legacy profile happens to name a harness.
      if (roster.profile(id)?.isGroup === true) {
        const memberIds = roster.groupMembers(id);
        const selectedRefs = mentionAgentIds ?? mentions;
        if (selectedRefs != null && (!Array.isArray(selectedRefs) || selectedRefs.some((member) => typeof member !== 'string'))) throw fail('group/invalid-mentions');
        const selected = selectedRefs == null ? null : selectedRefs.map((member) => roster.resolve(member));
        if (selected?.some((member) => !memberIds.includes(member))) throw fail('group/mention-not-member');
        return engine.postFromOperator({ groupId: id, text, clientNonce: acceptedNonce, conversationId: conv,
          attachmentPaths, replyTo, onlyMemberIds: selected, mentionAgentIds: selected, mentions,
          ...(strategy != null ? { strategy } : {}) });
      }
      if (proxy?.isProxiedAgent(id)) {
        const forwarded = await proxy.act({ method: 'sendPrompt', args: {
          agentId: id, prompt: text, clientNonce: acceptedNonce, conversationId: conv,
          attachmentPaths, replyTo, mentionAgentIds, mentions, ...(strategy != null ? { strategy } : {}),
        } });
        return { ...forwarded, agentId: id, proxied: true };
      }
      return engine.admit({ agentId: id, prompt: text, clientNonce: acceptedNonce, conversationId: conv, attachmentPaths, replyTo });
    },
    promptAcceptanceStatus: async ({ clientNonce, agentId = null }) => {
      if (agentId && proxy?.isProxiedAgent(roster.resolve(agentId))) {
        const forwarded = await proxy.act({
          method: 'promptAcceptanceStatus',
          args: { agentId: roster.resolve(agentId), clientNonce },
        });
        return { ...forwarded, proxied: true };
      }
      return engine.acceptanceStatus(clientNonce);
    },
    // Durable ledger health: how many records, and whether history was evicted or
    // degraded (which turns a lookup into unknown-durability).
    getAcceptanceLedgerStatus: () => ({ ...engine.ledger.status(), execution: executionSummary() }),
    getQueueDiagnostics: () => engine.scheduler.getDiagnostics(),
    respondToWidget: async ({ agentId, entryId, value }) => {
      const id = roster.resolve(agentId);
      if (proxy?.isProxiedAgent(id)) {
        const forwarded = await proxy.act({ method: 'respondToWidget', args: { agentId: id, entryId, value } });
        return { ...forwarded, proxied: true };
      }
      return engine.answerWidget({ agentId: id, entryId, value });
    },
    resolveAutoReviewApproval: ({ agentId, entryId, resolution }) =>
      engine.resolveApproval({ agentId, entryId, resolution }),
    messageAgent: ({ fromAgentId, to, text, priority = false, images = [], messageId = null }) =>
      engine.sendToAgent({
        fromAgentId: roster.resolve(fromAgentId),
        to,
        text,
        priority,
        images,
        messageId,
      }),
    interruptAgentRun: async ({ agentId, runId = null }) => {
      const id = roster.resolve(agentId);
      if (runId != null && (typeof runId !== 'string' || !runId)) throw fail('run/invalid-id', 400);
      if (proxy?.isProxiedAgent(id)) {
        const forwarded = await proxy.act({ method: 'interruptAgentRun', args: { id, agentId: id, runId } });
        return { ...forwarded, agentId: id, proxied: true };
      }
      if (runId != null && requireRun(runId).agentId !== id) throw fail('run/owner-mismatch');
      return engine.interrupt(id, { runId });
    },

    // ---- attachments -----------------------------------------------------
    // Uploads land in <root>/workspace/uploads, which is the same directory the agent
    // tools see, so a path handed to the model is immediately readable by read_file.
    saveAttachment: async ({ name, stream }) => {
      const safe = path.basename(String(name ?? 'file'))
        .replace(/[^\p{L}\p{N}._-]/gu, '-')
        .replace(/-{2,}/g, '-')
        .slice(0, 120);
      if (!safe || safe === '.' || safe === '..') throw new Error('bad filename');
      fs.mkdirSync(p.workspaceUploads, { recursive: true });
      const stamp = Date.now().toString(36);
      const target = path.join(p.workspaceUploads, `${stamp}-${safe}`);
      const chunks = [];
      let total = 0;
      const MAX = 25 * 1024 * 1024;
      for await (const chunk of stream) {
        total += chunk.length;
        if (total > MAX) return { ok: false, error: 'file too large (max 25MB)' };
        chunks.push(chunk);
      }
      fs.writeFileSync(target, Buffer.concat(chunks));
      return {
        ok: true,
        name: safe,
        path: target,
        // Tools resolve against the workspace root, so the path handed over must be
        // relative to <root>/workspace — otherwise "workspace/uploads/x" doubles up.
        relativePath: path.relative(p.workspace, target).split(path.sep).join('/'),
        bytes: total,
      };
    },
    deleteAttachment: ({ attachmentPath }) => {
      const resolved = path.resolve(String(attachmentPath));
      if (!resolved.startsWith(path.resolve(p.workspaceUploads))) throw new Error('outside uploads');
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
      return { deleted: true };
    },

    // ---- memory ---------------------------------------------------------
    readMemory: ({ agentId }) => ({ memory: roster.readMemoryAll(roster.resolve(agentId)) }),
    // The profile file only: the pane edits what it can write back.
    readMemoryProfile: ({ agentId }) => {
      const id = roster.resolve(agentId);
      return { memory: roster.readMemory(id), path: 'memory/profile.md' };
    },
    writeMemoryProfile: ({ agentId, text }) => {
      const id = roster.resolve(agentId);
      const file = roster.writeMemory(id, text);
      return { saved: true, bytes: Buffer.byteLength(String(text ?? '')), file };
    },
    updateMemory: ({ agentId, text, kind = 'note' }) => ({
      file: roster.appendMemory(roster.resolve(agentId), String(text), { kind }),
    }),

    // ---- skills ---------------------------------------------------------
    skillsCatalog: () => catalog.list(),
    refreshSkills: () => catalog.refresh(),
    installSkill: (args) => catalog.install(args),
    removeSkill: ({ name }) => catalog.remove(name),

    // ---- routines -------------------------------------------------------
    getAgentAutomations: ({ agentId }) => routines.list(roster.resolve(agentId)),
    createAgentAutomation: (args) => routines.create({ ...args, agentId: roster.resolve(args.agentId) }),
    updateAgentAutomation: (args) => routines.update({ ...args, agentId: roster.resolve(args.agentId) }),
    deleteAgentAutomation: (args) => routines.remove({ ...args, agentId: roster.resolve(args.agentId) }),
    runAgentAutomationNow: (args) => routines.runNow({ ...args, agentId: roster.resolve(args.agentId) }),
    // External event ingress: today only webhook-shaped triggers fire this way.
    // The response says what fired and what was ignored, never a bare ok.
    fireRoutineWebhook: ({ source, payload = null }) => {
      const fired = routines.fireExternal({ source, payload });
      return { fired, count: fired.length, source };
    },
    getTriggerTypes: () => ({
      supported: ["cron", "webhook", "email", "slack", "github", "origin", "microsoftTeams", "linear", "sentry", "pagerduty"],
      executableLocally: ["cron", "webhook"],
    }),

    // ---- models ---------------------------------------------------------
    // The provider catalog for the picker. Fetched server-side so the API key never
    // reaches the browser; failures are reported, not silently replaced with a guess.
    listModels: async ({ agentId = null }) => {
      const id = agentId ? roster.resolve(agentId) : roster.activeId();
      const binding = resolveBinding(p.root, id);
      if (!binding.apiKey) {
        return { models: [], error: `no API key: set ${binding.apiKeyEnv}`, baseUrl: binding.baseUrl };
      }
      const base = String(binding.baseUrl).replace(/\/+$/, '');
      try {
        const res = await fetch(`${base}/models`, {
          headers: { authorization: `Bearer ${binding.apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { models: [], error: `provider ${res.status}`, baseUrl: binding.baseUrl };
        const body = await res.json();
        const models = (body?.data ?? [])
          .map((m) => ({
            id: m.id,
            owner: m.owned_by ?? null,
            context: m.context_length ?? null,
            reasoning: m.reasoning === true,
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
        return { models, baseUrl: binding.baseUrl, current: binding.modelId };
      } catch (err) {
        return { models: [], error: String(err?.message ?? err), baseUrl: binding.baseUrl };
      }
    },
    // ---- provider configuration -------------------------------------------
    // What the settings UI needs: the endpoint, the model, and whether a key exists —
    // never the key itself. The value is written to secrets/env.json by setProviderConfig.
    getProviderConfig: ({ agentId }) => {
      const id = roster.resolve(agentId);
      const b = resolveBinding(p.root, id, process.env);
      const st = secretStatus(p.root, [b.apiKeyEnv]);
      return {
        agentId: id,
        modelId: b.modelId,
        baseUrl: b.baseUrl,
        apiKeyEnv: b.apiKeyEnv,
        keyIsSet: st[b.apiKeyEnv]?.isSet === true,
        keySource: st[b.apiKeyEnv]?.source ?? null,
        keyPreview: maskKey(b.apiKey),
        bound: b.bound,
      };
    },

    setProviderConfig: ({ agentId, modelId, baseUrl, apiKeyEnv, apiKey }) => {
      const id = roster.resolve(agentId);
      const patch = {};
      if (typeof modelId === 'string' && modelId.trim()) patch.modelId = modelId.trim();
      if (typeof baseUrl === 'string' && baseUrl.trim()) {
        let u;
        try { u = new URL(baseUrl.trim()); } catch { throw new Error('base URL 不是合法地址'); }
        if (!/^https?:$/.test(u.protocol)) throw new Error('base URL 只支持 http/https');
        patch.baseUrl = baseUrl.trim().replace(/\/+$/, '');
      }
      if (typeof apiKeyEnv === 'string' && apiKeyEnv.trim()) patch.apiKeyEnv = apiKeyEnv.trim();
      if (Object.keys(patch).length) setAgentBinding(p.root, id, patch);
      // An empty string clears the stored key; undefined leaves it untouched.
      if (typeof apiKey === 'string') {
        const target = patch.apiKeyEnv ?? resolveBinding(p.root, id, process.env).apiKeyEnv;
        setSecret(p.root, target, apiKey);
      }
      const b = resolveBinding(p.root, id, process.env);
      return { agentId: id, modelId: b.modelId, baseUrl: b.baseUrl, apiKeyEnv: b.apiKeyEnv, keyIsSet: Boolean(b.apiKey) };
    },

    // One cheap round trip against the configured endpoint: does it answer, and with
    // which models? This is what the "测试连接" button calls.
    testProvider: async ({ agentId, baseUrl, apiKey }) => {
      const id = agentId ? roster.resolve(agentId) : roster.activeId();
      const b = resolveBinding(p.root, id, process.env);
      const url = String(baseUrl ?? b.baseUrl ?? '').replace(/\/+$/, '');
      const key = String(apiKey ?? b.apiKey ?? '');
      if (!url) return { ok: false, error: '没有配置 base URL' };
      if (!key) return { ok: false, error: '没有配置 API Key' };
      const started = Date.now();
      try {
        const res = await fetch(`${url}/models`, {
          headers: { authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(12_000),
        });
        const ms = Date.now() - started;
        if (!res.ok) return { ok: false, status: res.status, ms, error: `HTTP ${res.status}` };
        const body = await res.json().catch(() => ({}));
        const count = Array.isArray(body?.data) ? body.data.length : 0;
        return { ok: true, status: res.status, ms, models: count };
      } catch (err) {
        return { ok: false, ms: Date.now() - started, error: String(err?.message ?? err) };
      }
    },

    getAgentBinding: ({ agentId }) => {
      const id = roster.resolve(agentId);
      const binding = resolveBinding(p.root, id);
      return { ...binding, apiKey: binding.apiKey ? '***set***' : '' };
    },
    setAgentBinding: ({ agentId, patch }) => {
      const id = roster.resolve(agentId);
      const bindings = setAgentBinding(p.root, id, patch ?? {});
      return { agentId: id, binding: bindings.agents[id] };
    },
    removeAgentBinding: ({ agentId }) => removeAgentBinding(p.root, roster.resolve(agentId)),
    listBindings: () => {
      const bindings = loadBindings(p.root);
      return { default: bindings.default ?? {}, agents: bindings.agents ?? {} };
    },

    // ---- tools policy ---------------------------------------------------
    // Auto-review surface: rules, ceilings, and the standing always-allow list.
    getAutoReviewRules: () => loadRules(p.root),
    setAutoReviewRules: ({ patch }) => saveRules(p.root, { ...loadRules(p.root), ...patch }),
    getToolPolicy: () => tools.policy(),
    setToolPolicy: ({ patch }) => tools.setPolicy(patch ?? {}),
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    try {
      // The deployed host refuses *any* Origin header, because its client is a native
      // process that never sends one. A web UI cannot work that way: browsers attach
      // Origin to same-origin POSTs and EventSource requests. The rule that keeps the
      // security property is same-origin-only, not origin-less.
      const origin = req.headers.origin;
      if (origin !== undefined && !isSameOrigin(origin, req)) {
        return json(res, 403, { ok: false, error: `cross-origin gateway requests are not allowed: ${origin}` });
      }
      // The real host binds 0.0.0.0 and relies on its token alone; when no token is
      // configured we fall back to the stricter rule and demand a loopback Host.
      if (!config.token) {
        const hostname = new URL(`http://${req.headers.host ?? ''}`).hostname;
        if (!isLoopbackHostname(hostname)) {
          return json(res, 403, { ok: false, error: 'untrusted gateway host' });
        }
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          ok: true,
          pid: process.pid,
          isBusy: engine.scheduler.getDiagnostics().length > 0,
          activeAgentId: roster.activeId(),
          startedAt,
        });
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        // EventSource cannot set headers; a loopback-only query token is allowed.
        const queryToken = url.searchParams.get('token');
        if (!authorized(req, config.token) && !(queryToken && queryToken === config.token)) {
          return json(res, 401, { ok: false, error: 'unauthorized' });
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
        });
        res.write('retry: 1000\n\n');
        const unsubscribe = bus.subscribe((event) => {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => res.write(':ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return undefined;
      }

      // The UI map is the same contract the real app ships (settings anchors, deep
      // links, commands, info-pane layouts). Exposed read-only so the web client can
      // render real anchors instead of inventing its own.
      // Inline favicon: without it the browser logs a 404 on every load.
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2f6fed"/><circle cx="16" cy="16" r="6" fill="#fff"/></svg>`;
        const body = Buffer.from(svg);
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': body.length, 'cache-control': 'max-age=86400' });
        return res.end(body);
      }

      // Static assets that ship with the UI (the Telegram paper pattern, icons).
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const rel = url.pathname.slice('/assets/'.length);
        if (!/^[a-zA-Z0-9._-]+$/.test(rel)) return json(res, 400, { ok: false, error: 'bad asset path' });
        const file = path.join(import.meta.dirname, 'ui', 'assets', rel);
        if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'not found' });
        const body = fs.readFileSync(file);
        const type = rel.endsWith('.svg') ? 'image/svg+xml'
          : rel.endsWith('.png') ? 'image/png'
          : rel.endsWith('.webp') ? 'image/webp' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': type, 'content-length': body.length,
          'cache-control': 'public, max-age=86400' });
        return res.end(body);
      }

      // Workspace files, for inline images and downloads. Confined to the workspace.
      if (req.method === 'GET' && url.pathname.startsWith('/files/')) {
        const rel = decodeURIComponent(url.pathname.slice('/files/'.length));
        const root = path.resolve(p.workspace);
        // Same base as the tools: <root>/workspace. Legacy rows stored
        // "workspace/uploads/..." so a redundant leading segment is stripped first.
        const cleaned = rel.replace(/^workspace\//, '');
        const target = path.resolve(p.workspace, cleaned);
        if (!target.startsWith(root)) return json(res, 403, { ok: false, error: 'outside workspace' });
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
          return json(res, 404, { ok: false, error: 'not found' });
        }
        const ext = path.extname(target).toLowerCase();
        const types = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
          '.md': 'text/plain; charset=utf-8', '.json': 'application/json',
        };
        const body = fs.readFileSync(target);
        res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream',
          'content-length': body.length, 'cache-control': 'private, max-age=3600' });
        return res.end(body);
      }

      if (req.method === 'GET' && url.pathname === '/uimap.json') {
        const file = path.join(import.meta.dirname, 'ui', 'uimap.json');
        const body = fs.readFileSync(file);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
        return res.end(body);
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const file = path.join(import.meta.dirname, 'ui', 'index.html');
        const body = fs.readFileSync(file);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
        return res.end(body);
      }

      // Binary upload for attachments. The body is the file; the name travels in a
      // header so the JSON envelope stays untouched.
      if (req.method === 'POST' && url.pathname === '/api/attachments') {
        if (!authorized(req, config.token)) return json(res, 401, { ok: false, error: 'unauthorized' });
        const rawName = req.headers['x-filename'] ?? 'file';
        let name;
        try { name = decodeURIComponent(String(rawName)); } catch { name = String(rawName); }
        const result = await methods.saveAttachment({ name, stream: req });
        return json(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!authorized(req, config.token)) return json(res, 401, { ok: false, error: 'unauthorized' });
        const method = url.pathname.slice('/api/'.length);
        const handler = methods[method];
        if (!handler) return json(res, 404, { ok: false, error: `unknown gateway method: ${method}` });
        let args;
        try {
          args = await readBody(req);
        } catch (err) {
          return json(res, err.status ?? 400, { ok: false, error: String(err.message) });
        }
        const requestId = req.headers['x-request-id'] ?? randomUUID();
        try {
          const result = await handler(args);
          res.setHeader('x-request-id', requestId);
          log('rpc', { method, requestId });
          return json(res, 200, { ok: true, method, requestId, result });
        } catch (err) {
          log('rpc.error', { method, requestId, error: String(err.message) });
          return json(res, err.status ?? 500, { ok: false, method, requestId, ...(err.code ? { code: err.code } : {}), error: String(err.message) });
        }
      }

      return json(res, 404, { ok: false, error: `not found: ${req.method} ${url.pathname}` });
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  });

  return {
    methods,
    server,
    config,
    async listen({ port = 0, host = '127.0.0.1', token = null } = {}) {
      config.host = host;
      config.port = port;
      config.token = token;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      config.port = server.address().port;
      const discovery = {
        port: config.port,
        pid: process.pid,
        startedAt,
        scheme: 'http',
        host: config.host,
        ...(token ? { token } : {}),
      };
      writeJson(p.gateway, discovery);
      fs.writeFileSync(p.hostLock, String(process.pid));
      return discovery;
    },
    async close() {
      fs.rmSync(p.gateway, { force: true });
      fs.rmSync(p.hostLock, { force: true });
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
