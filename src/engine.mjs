// Turn engine: assemble prompt -> stream model -> run tools -> persist entries.
//
// Design points taken from the real host:
//   1. Admission is separate from execution. sendPrompt returns an acceptance
//      record immediately; the turn runs in the background and reports through
//      the event bus. That is why the desktop UI never blocks on a model.
//   2. Everything durable is a transcript entry. Streaming text mutates the same
//      entry it was created as, so a crash mid-turn leaves a recoverable row.
//   3. Approvals are entries too. A tool that needs approval parks and the turn
//      ends; a later resolveAutoReviewApproval resumes with the new state.
//   4. Model choice is per agent, resolved from bindings, never from the prompt.

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {
  assistantTextEntry,
  approvalEntry,
  agentInboundEntry,
  agentToUserEntry,
  agentOutboundEntry,
  noticeEntry,
  reasoningEntry,
  toolCallEntry,
  toolResultEntry,
  userMessageEntry,
  widgetEntry,
} from './entries.mjs';
import { resolveBinding } from './providers/bindings.mjs';
import { streamChat } from './providers/transport.mjs';
import { toolDefinitions } from './tools.mjs';
import { AcceptanceLedger, inputDigest } from './acceptance.mjs';
import { RunScheduler } from './scheduler.mjs';
import { ChangedMids } from './timeline.mjs';
import { resolve as resolveReview, expireAllPending, PENDING_APPROVAL_REASON } from './review.mjs';

const MAX_TOOL_STEPS = 12;
const PEER_MESSAGE_ID_LEDGER_CAP = 512;

export class TurnEngine {
  constructor({ p, roster, catalog, tools, bus, log = () => {} }) {
    this.p = p;
    this.roster = roster;
    this.catalog = catalog;
    this.tools = tools;
    this.bus = bus;
    this.log = log;
    this.acceptances = new Map();
    this.running = new Map();
    // Real scheduling semantics (three lanes, per-agent serialization, watchdog).
    this.scheduler = new RunScheduler({
      telemetry: {
        onAccepted: (e) => this.bus.publish({ type: 'queue-accepted', ...e }),
        onDequeued: (e) => this.bus.publish({ type: 'queue-dequeued', ...e }),
        onWatchdog: (e) => this.bus.publish({ type: 'queue-watchdog', ...e }),
      },
    });
    this.approvedCommands = new Set(); // command -> approved for the current process lifetime
    this.aborts = new Map(); // agentId -> AbortController for the in-flight model stream
    this.hostSettings = () => ({});
    this.ledger = new AcceptanceLedger(p.root);
    this.receivedPeerMessageIds = new Set();
    // agentId -> the turn parked on an approval or a question. A parked agent keeps
    // its queue slot: later prompts stay queued until the park is resolved.
    // agentId -> the turn parked on an approval or a question. Informational: a park
    // does NOT block the queue (Telegram leaves the chat usable behind an action card).
    // It exists so the client can show the agent as waiting on the operator.
    this.parked = new Map();
    // clientNonce -> entryId. The client may render by nonce before the row exists;
    // this lets it re-key the node in place instead of rebuilding (tweb changedMids).
    this.changedMids = new ChangedMids();
  }

  // ---- prompt -----------------------------------------------------------
  buildSystemPrompt(agentId) {
    const agent = this.roster.summary(agentId);
    const memory = this.roster.readMemoryAll(agentId).trim();
    const skills = this.catalog.list();
    const settings = this.hostSettings() ?? {};
    const now = new Date();
    const tz = settings.userTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const lang = settings.language === 'en' ? 'en' : 'zh';

    const lines = [
      `You are ${agent?.name ?? 'a bot'}, a bot on a personal Grok-Bot-style workspace.`,
      agent?.description ? `Your role: ${agent.description}` : '',
      agent?.title ? `Your title: ${agent.title}` : '',
      '',
      '## How this workspace behaves',
      '- You are not a chat window. You have a workspace directory with real files, a shell, and your own memory.',
      '- Durable state is written to the transcript and to memory. Anything you need next turn must be in one of those.',
      '- Side-effectful shell commands can require the user’s approval; when a tool result says approval_required, stop and say what you need approved.',
      '- To hand work to another bot, use message_agent. Its answer arrives as a message from that bot; you do not block waiting.',
      '- Never claim you ran something you did not run, and never invent tool output.',
      '',
      `## Time`,
      `Now: ${now.toISOString()} (${tz}). Treat all times as ${tz} unless asked otherwise.`,
      '',
      '## Language',
      lang === 'zh'
        ? 'The operator works in Chinese. Write memory entries, notices, and your own notes in Chinese. Reply in the language the operator uses.'
        : 'The operator works in English. Write memory entries, notices, and your own notes in English. Reply in the language the operator uses.',
      '',
      '## Memory',
      memory ? memory : '(no memory yet)',
    ];

    if (skills.length) {
      lines.push('', '## Skills');
      lines.push('Read a skill with read_skill before doing the kind of work it names.');
      for (const s of skills) {
        lines.push(`- ${s.name}: ${String(s.description ?? '').replace(/\s+/g, ' ').trim()}`);
      }
    }

    lines.push(
      '',
      '## Workspace',
      `Your workspace is ${this.p.workspace}. Relative tool paths resolve there.`,
      'Other bots on this host share that same directory. Do not assume a file is yours alone, and do not treat a separate folder as a security boundary.',
    );

    return lines.filter((l) => l !== '').join('\n');
  }

  // Convert the durable transcript into chat messages for the provider.
  buildMessages(agentId) {
    const store = this.roster.store(agentId);
    const entries = store.readAll({ includeToolCalls: true });
    const messages = [{ role: 'system', content: this.buildSystemPrompt(agentId) }];
    const pendingToolCalls = [];

    // A turn interrupted by an approval leaves a tool-call with no result. Providers
    // reject an assistant tool_calls message whose calls are unanswered, so those
    // calls are dropped from the replay and only complete pairs are sent.
    const answered = new Set(entries.filter((e) => e.kind === 'tool-result').map((e) => e.callId));
    const orphanCalls = new Set(
      entries.filter((e) => e.kind === 'tool-call' && !answered.has(e.id)).map((e) => e.id),
    );

    const flushToolCalls = () => {
      if (!pendingToolCalls.length) return;
      messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls.splice(0) });
    };

    for (const entry of entries) {
      switch (entry.kind) {
        case 'message':
          if (entry.role === 'user' && entry.message?.type === 'text') {
            flushToolCalls();
            // Attachments are workspace paths; tell the model they exist so it can open
            // them with read_file instead of guessing.
            const files = (Array.isArray(entry.attachments) ? entry.attachments : [])
              .map((f) => String(f).replace(/^workspace\//, ''));
            const imgExt = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);
            const note = files.length
              ? '\n\n[附件]\n' + files.map((f) => {
                  const ext = f.split('.').pop().toLowerCase();
                  return imgExt.has(ext)
                    ? `- ${f}（图片，不要用 read_file 读二进制，需要时用 shell 的 file/identify）`
                    : `- ${f}（文本，可用 read_file）`;
                }).join('\n')
              : '';
            messages.push({ role: 'user', content: `${entry.message.content}${note}` });
          }
          break;
        case 'send-message':
          if (entry.message?.type === 'text' && entry.message.content) {
            flushToolCalls();
            messages.push({ role: 'assistant', content: entry.message.content });
          }
          break;
        case 'tool-call':
          if (orphanCalls.has(entry.id)) break;
          pendingToolCalls.push({
            id: entry.id,
            type: 'function',
            function: { name: entry.name, arguments: JSON.stringify(entry.args ?? {}) },
          });
          break;
        case 'tool-result':
          if (orphanCalls.has(entry.callId)) break;
          flushToolCalls();
          messages.push({ role: 'tool', tool_call_id: entry.callId, content: String(entry.result ?? '') });
          break;
        default:
          break;
      }
    }
    flushToolCalls();
    return messages;
  }

  // ---- admission --------------------------------------------------------
  // Admission: write the durable acceptance record FIRST, then queue the turn.
  // The order matters — a crash after this returns still leaves an answerable
  // record, and a replayed nonce returns the original instead of running twice.
  // Where does this agent's turn actually run?
  //
  // The deployed host reads profile.json's `harness` and routes on it:
  //   "temporal" → every turn goes to the server agent proxy; the box may not run it
  //   "box"      → local execution... except sendPrompt now unconditionally refuses
  //                (SandBoxHarnessRetiredError), so a box-harness agent is a dead end
  //   absent     → treated as unknown; the host falls back to its local path
  //
  // Our equivalent keeps the same three states so the distinction is visible rather
  // than silently collapsing to "everything is local".
  route(agentId) {
    const profile = this.roster.profile(agentId) ?? {};
    const harness = profile.harness ?? null;
    if (harness === 'temporal') {
      return {
        harness,
        lane: 'server',
        runnable: false,
        reason:
          'this agent is server-hosted (harness=temporal); its turns run through the server agent proxy, not in this process',
      };
    }
    if (harness === 'box') {
      return {
        harness,
        lane: 'retired',
        runnable: false,
        reason: 'local box turns are retired; the deployed host refuses them with SandBoxHarnessRetiredError',
      };
    }
    return { harness: harness ?? 'local', lane: 'local', runnable: true, reason: null };
  }

  admit({ agentId, prompt, clientNonce = null, trigger = 'user', attachmentPaths = [], replyTo = null, lane = 'user', source = 'user', viaProxy = false }) {
    const id = this.roster.resolve(agentId);
    const route = this.route(id);
    // `viaProxy` is set only by the proxy transport: it is the executor for this
    // agent, so the local harness check does not apply to it.
    if (!route.runnable && !viaProxy) {
      // Refuse *before* writing an acceptance record: a refused prompt was never
      // accepted, and recording it as accepted would be a lie.
      throw Object.assign(new Error(route.reason), {
        code: 'send/agent-unavailable',
        status: 'rejected',
        route,
      });
    }
    const nonce = clientNonce ?? randomUUID();

    const admitted = this.ledger.record({ accountSlot: 'host', clientNonce: nonce, prompt, agentId: id });
    if (admitted.replayed) {
      const known = this.acceptances.get(nonce);
      const record = admitted.record;
      if (admitted.conflict) {
        throw Object.assign(new Error(admitted.rejectionCode), {
          code: admitted.rejectionCode,
          status: 'rejected',
        });
      }
      return {
        ...(known ?? {}),
        clientNonce: nonce,
        agentId: record.agentId,
        entryId: record.echoEntryId,
        // Prefer the live value: the durable record is written a hair earlier,
        // and a client comparing retries must see one stable timestamp.
        acceptedAtMs: known?.acceptedAtMs ?? record.acceptedAtMs,
        state: known?.state ?? record.status,
        replayed: true,
        trigger,
      };
    }

    const store = this.roster.store(id);
    const entry = userMessageEntry({ text: prompt, clientNonce: nonce, attachmentPaths, replyTo });
    store.appendEntry(entry);
    this.ledger.update('host', nonce, { echoEntryId: entry.id });
    this.changedMids.set(nonce, entry.id);
    this.bus.publish({ type: 'transcript', agentId: id, entry });

    const acceptance = {
      clientNonce: nonce,
      agentId: id,
      entryId: entry.id,
      acceptedAtMs: Date.now(),
      state: 'accepted',
      trigger,
      lane,
      source,
      inputDigest: inputDigest(prompt),
    };
    this.acceptances.set(nonce, acceptance);
    this.enqueue(id, () => this.runTurn({ agentId: id, acceptance }), {
      lane,
      source,
      acceptedAtMs: acceptance.acceptedAtMs,
      ackToken: nonce,
    });
    return { ...acceptance };
  }

  // Three outcomes, exactly like the real ledger: found / not-found / unknown-durability.
  // "not-found" is an honest "never seen this nonce"; "unknown-durability" means
  // history was evicted or degraded and no honest answer is available.
  // Which rows are still on their way? A user message is pending from the moment it
  // is accepted until its turn settles. The UI needs this to keep send order stable
  // when two prompts overlap (see src/timeline.mjs).
  //
  // A row stops being pending when its turn reaches a terminal state: done,
  // error, or interrupted. `awaiting-approval` and `awaiting-answer` are NOT
  // terminal — the turn is parked, still owns its queue slot, and the next prompt
  // waits behind it. Those rows count as pending too, because from the operator's
  // point of view the work is still in flight.
  // True while any card for this agent is still unanswered.
  hasPendingApproval(agentId) {
    const id = this.roster.resolve(agentId);
    const rows = this.roster.store(id).readAll();
    return rows.some(
      (e) => e.message?.type === 'auto-review-approval' && e.message.resolution == null,
    );
  }

  isParked(agentId) {
    return this.parked.has(this.roster.resolve(agentId));
  }

  pendingEntryIds(agentId) {
    const id = this.roster.resolve(agentId);
    const TERMINAL = new Set(['done', 'error', 'interrupted']);
    const pending = new Set();
    for (const a of this.acceptances.values()) {
      if (a.agentId !== id || !a.entryId) continue;
      if (!TERMINAL.has(a.state)) pending.add(a.entryId);
    }
    return [...pending];
  }

  acceptanceStatus(nonce) {
    const live = this.acceptances.get(nonce);
    const durable = this.ledger.lookup({ accountSlot: 'host', clientNonce: nonce });
    if (durable.outcome === 'found') {
      return {
        state: live?.state ?? durable.record.status,
        ...(live ?? {}),
        record: durable.record,
        durable: true,
      };
    }
    if (durable.outcome === 'unknown-durability') {
      return { state: 'unknown-durability', ...(live ?? {}), durable: false };
    }
    return live ? { ...live, durable: false } : { state: 'unknown', durable: false };
  }

  enqueue(agentId, job, { lane = 'user', source = 'user', acceptedAtMs = undefined, ackToken = undefined } = {}) {
    return this.scheduler
      .enqueue(agentId, job, { lane, source, acceptedAtMs, ackToken })
      .catch((err) => {
        this.log('turn.error', { agentId, error: String(err?.message ?? err) });
      });
  }

  // ---- execution --------------------------------------------------------
  async runTurn({ agentId, acceptance }) {
    const binding = resolveBinding(this.p.root, agentId);
    const store = this.roster.store(agentId);
    const turnId = randomUUID();
    acceptance.state = 'running';
    acceptance.turnId = turnId;
    this.running.set(agentId, { turnId, startedAt: Date.now() });
    this.bus.publish({ type: 'turn-start', agentId, turnId, entryId: acceptance.entryId, clientNonce: acceptance.clientNonce });

    const startedAt = Date.now();
    let textEntry = null;
    let accumulated = '';
    let usage = null;

    try {
      for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
        // Honour a stop that arrived between steps or during a tool await.
        if (acceptance.abortRequested) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        const messages = this.buildMessages(agentId);
        let reasoningEntryRef = null;
        let toolCalls = null;
        let route = null;
        let upstreamId = null;
        let responseModel = null;
        let httpStatus = null;

        const abort = new AbortController();
        this.aborts.set(agentId, abort);
        const stream = streamChat({
          baseUrl: binding.baseUrl,
          apiKey: binding.apiKey,
          modelId: binding.modelId,
          messages,
          tools: toolDefinitions(),
          maxMode: binding.maxMode,
          parameters: binding.parameters,
          signal: abort.signal,
        });

        for await (const event of stream) {
          if (event.type === 'route') {
            route = event.route;
            upstreamId = event.upstreamId ?? null;
            responseModel = event.responseModel ?? null;
            httpStatus = event.httpStatus ?? null;
            this.bus.publish({ type: 'turn-route', agentId, turnId, route, model: event.model, url: event.url });
            continue;
          }
          if (event.type === 'reasoning') {
            if (!reasoningEntryRef) {
              reasoningEntryRef = reasoningEntry({ text: '', turnId });
              store.appendEntry(reasoningEntryRef);
            }
            reasoningEntryRef.text += event.text;
            store.updateEntry(reasoningEntryRef.id, (e) => ({ ...e, text: reasoningEntryRef.text }));
            this.bus.publish({ type: 'reasoning-delta', agentId, turnId, entryId: reasoningEntryRef.id, text: event.text });
            continue;
          }
          if (event.type === 'text') {
            accumulated += event.text;
            if (!textEntry) {
              textEntry = assistantTextEntry({ text: '', streaming: true, turnId });
              store.appendEntry(textEntry);
            }
            store.updateEntry(textEntry.id, (e) => ({ ...e, message: { type: 'text', content: accumulated } }));
            this.bus.publish({ type: 'text-delta', agentId, turnId, entryId: textEntry.id, text: event.text });
            continue;
          }
          if (event.type === 'tool_calls') {
            toolCalls = event.calls;
            continue;
          }
          if (event.type === 'upstream') {
            upstreamId = event.upstreamId ?? upstreamId;
            responseModel = event.responseModel ?? responseModel;
            continue;
          }
          if (event.type === 'done') {
            usage = event.usage ?? usage;
            continue;
          }
        }

        this.writeProvenance({
          agentId,
          turnId,
          route,
          binding,
          usage,
          accumulated,
          upstreamId,
          responseModel,
          httpStatus,
          outcome: toolCalls ? 'tool-calls' : 'ok',
          elapsedMs: Date.now() - startedAt,
        });

        if (!toolCalls?.length) break;

        // Materialize tool calls, run them, feed results back.
        for (const call of toolCalls) {
          let parsedArgs = {};
          try {
            parsedArgs = call.args ? JSON.parse(call.args) : {};
          } catch {
            parsedArgs = { _raw: call.args };
          }
          // Providers may reuse a tool-call id across turns; entry ids must stay unique.
          let callId = call.id;
          if (store.getEntry(callId)) callId = `${callId}-${randomUUID().slice(0, 8)}`;
          const record = toolCallEntry({ name: call.name, args: parsedArgs, callId, status: 'running', turnId });
          store.appendEntry(record);
          this.bus.publish({ type: 'tool-call', agentId, turnId, entry: record });

          const outcome = await this.tools.execute({
            agentId,
            call: { name: call.name, args: parsedArgs },
            approvedCommands: this.approvedCommands,
          });
          if (acceptance.abortRequested) {
            const err = new Error('aborted');
            err.name = 'AbortError';
            throw err;
          }

          if (outcome.needsWidget) {
            const widget = widgetEntry({
              widgetId: `w-${randomUUID()}`,
              prompt: outcome.needsWidget.prompt,
              options: outcome.needsWidget.options,
              allowCustom: outcome.needsWidget.allowCustom,
            });
            store.appendEntry(widget);
            store.updateEntry(record.id, (e) => ({ ...e, status: 'awaiting-answer' }));
            this.bus.publish({ type: 'widget-request', agentId, turnId, entry: widget, callId, clientNonce: acceptance.clientNonce });
            acceptance.state = 'awaiting-answer';
            acceptance.widgetEntryId = widget.id;
            this.running.delete(agentId);
            this.parked.set(agentId, { acceptance, widgetEntryId: widget.id, turnId });
            return;
          }

          if (outcome.needsApproval) {
            // Only one card at a time: the deployed host refuses a second side effect
            // rather than queueing it, so the operator is never eyeballing two cards.
            if (this.hasPendingApproval(agentId)) {
              const refused = toolResultEntry({
                name: call.name,
                callId,
                result: { status: 'blocked_by_pending_approval', reason: PENDING_APPROVAL_REASON },
                isError: true,
                turnId,
              });
              store.appendEntry(refused);
              store.updateEntry(record.id, (e) => ({ ...e, status: 'blocked' }));
              this.bus.publish({ type: 'tool-result', agentId, turnId, callId, result: refused.result });
              continue;
            }
            const approval = approvalEntry({
              requestId: `req-${callId}`,
              command: parsedArgs.command,
              surface: 'shell',
            });
            store.appendEntry(approval);
            this.bus.publish({
              type: 'approval-request',
              agentId,
              turnId,
              entry: approval,
              clientNonce: acceptance.clientNonce,
            });
            store.updateEntry(record.id, (e) => ({ ...e, status: 'awaiting-approval' }));
            acceptance.state = 'awaiting-approval';
            acceptance.approvalEntryId = approval.id;
            acceptance.command = parsedArgs.command;
            this.running.delete(agentId);
            this.parked.set(agentId, { acceptance, approvalEntryId: approval.id, turnId });
            return;
          }

          store.updateEntry(record.id, (e) => ({
            ...e,
            status: outcome.isError ? 'error' : 'ok',
            summary: summarizeResult(outcome.result),
          }));

          if (outcome.deferToRuntime?.kind === 'message_agent') {
            const sent = await this.sendToAgent({
              fromAgentId: agentId,
              to: outcome.deferToRuntime.to,
              text: outcome.deferToRuntime.text,
              images: outcome.deferToRuntime.images,
              priority: outcome.deferToRuntime.priority,
              turnId,
            });
            store.appendEntry(
              toolResultEntry({
                name: call.name,
                callId,
                result: {
                  delivered: sent.delivered,
                  to: sent.agentId ?? sent.groupId,
                  woken: sent.woken === true,
                  held: sent.held === true,
                  ...(sent.reason ? { reason: sent.reason } : {}),
                  ...(sent.notes ? { notes: sent.notes } : {}),
                },
              }),
            );
            this.bus.publish({ type: 'tool-result', agentId, turnId, callId, result: sent });
            continue;
          }

          const resultEntry = toolResultEntry({
            name: call.name,
            callId,
            result: outcome.result,
            isError: outcome.isError === true,
            turnId,
          });
          store.appendEntry(resultEntry);
          this.bus.publish({ type: 'tool-result', agentId, turnId, callId, result: outcome.result });
        }
      }

      if (textEntry) store.updateEntry(textEntry.id, (e) => ({ ...e, streaming: false }));
      acceptance.state = 'done';
      acceptance.finishedAtMs = Date.now();
      acceptance.usage = usage;
      this.bus.publish({
        type: 'turn-end',
        agentId,
        turnId,
        usage,
        elapsedMs: Date.now() - startedAt,
        clientNonce: acceptance.clientNonce,
        state: 'done',
      });
      this.running.delete(agentId);
      this.aborts.delete(agentId);
      this.appendWorkLog({ agentId, prompt: acceptance.entryId, status: 'done', elapsedMs: Date.now() - startedAt });
    } catch (error) {
      const aborted = error?.name === 'AbortError'
        || acceptance.abortRequested === true
        || this.aborts.get(agentId)?.signal.aborted === true;
      acceptance.state = aborted ? 'interrupted' : 'error';
      this.aborts.delete(agentId);
      if (aborted) {
        if (textEntry) store.updateEntry(textEntry.id, (e) => ({ ...e, streaming: false }));
        store.appendEntry(noticeEntry(
          (this.hostSettings()?.language === 'en') ? 'turn interrupted by the operator' : '已停止本轮生成',
          { level: 'warn', turnId },
        ));
        this.bus.publish({ type: 'turn-interrupted', agentId, turnId, clientNonce: acceptance.clientNonce });
        this.running.delete(agentId);
        return;
      }
      acceptance.error = String(error?.message ?? error);
      if (textEntry) store.updateEntry(textEntry.id, (e) => ({ ...e, streaming: false }));
      store.appendEntry({
        kind: 'error',
        id: `err-${randomUUID()}`,
        message: acceptance.error,
        turnId,
        timestampMs: Date.now(),
      });
      this.bus.publish({ type: 'turn-error', agentId, turnId, error: acceptance.error, clientNonce: acceptance.clientNonce });
      this.running.delete(agentId);
      this.appendWorkLog({ agentId, prompt: acceptance.entryId, status: 'failed', error: acceptance.error });
      this.writeProvenance({
        agentId,
        turnId,
        route: null,
        binding,
        usage: null,
        accumulated,
        outcome: 'error',
        elapsedMs: Date.now() - startedAt,
        error: acceptance.error,
      });
      throw error;
    }
  }

  // Resume an approval: execute the parked command, write its tool result, then
  // continue the same conversation. The continuation is a normal turn — the model
  // reads the tool result from the transcript like any other step.
  async resolveApproval({ agentId, entryId, resolution }) {
    const id = this.roster.resolve(agentId);
    const store = this.roster.store(id);
    const entry = store.getEntry(entryId);
    if (!entry || entry.message?.type !== 'auto-review-approval') throw new Error(`no approval entry: ${entryId}`);
    const command = entry.message.approval.command;
    const requestId = entry.message.approval.requestId ?? '';
    const tool = entry.message.approval.surface === 'shell' ? 'shell' : entry.message.approval.surface;

    // Staleness + standing-rule bookkeeping live in review.mjs. A card that is
    // already settled or has no live resolver is refused, never silently applied.
    const outcome = resolveReview({
      root: this.p.root,
      resolution,
      tool,
      command,
      entry,
      expectedRequestId: entry.message.approval.requestId,
    });

    store.updateEntry(entryId, (e) => ({ ...e, message: { ...e.message, resolution } }));
    this.bus.publish({ type: 'approval-resolved', agentId: id, entryId, resolution, standingRule: outcome.standingRule });

    // Find the parked tool call this approval belongs to.
    const callId = requestId.replace(/^req-/, '');
    const callEntry = store.getEntry(callId);

    if (!outcome.approved) {
      if (callEntry) {
        store.updateEntry(callId, (e) => ({ ...e, status: 'denied' }));
        store.appendEntry(
          toolResultEntry({ name: callEntry.name, callId, result: 'denied by the user; the command was not run', isError: true }),
        );
      }
      const parkedAcceptance = this.parked.get(id)?.acceptance;
      if (parkedAcceptance) parkedAcceptance.state = 'done';
      this.parked.delete(id);
      store.appendEntry(noticeEntry(`approval denied: ${command}`, { level: 'warn', turnId }));
      this.bus.publish({ type: 'approval-denied', agentId: id, entryId, command });
      return { resumed: false, command };
    }

    this.approvedCommands.add(command);
    if (callEntry) {
      const outcome = await this.tools.execute({ agentId: id, call: { name: callEntry.name, args: callEntry.args ?? {} }, approvedCommands: this.approvedCommands });
      store.updateEntry(callId, (e) => ({
        ...e,
        status: outcome.isError ? 'error' : 'ok',
        summary: summarizeResult(outcome.result),
      }));
      const resultEntry = toolResultEntry({
        name: callEntry.name,
        callId,
        result: outcome.result,
        isError: outcome.isError === true,
      });
      store.appendEntry(resultEntry);
      this.bus.publish({ type: 'tool-result', agentId: id, callId, result: outcome.result });
    }

    const nonce = randomUUID();
    const acceptance = {
      clientNonce: nonce,
      agentId: id,
      entryId,
      acceptedAtMs: Date.now(),
      state: 'accepted',
      trigger: 'approval-resume',
    };
    // Close the parked acceptance: its row is no longer in flight, the resumed turn
    // is a new acceptance with its own nonce.
    const parkedAcceptance = this.parked.get(id)?.acceptance;
    if (parkedAcceptance) parkedAcceptance.state = 'done';
    this.acceptances.set(nonce, acceptance);
    this.parked.delete(id);
    this.enqueue(id, () => this.runTurn({ agentId: id, acceptance }));
    return { resumed: true, command, clientNonce: nonce };
  }

  // Answer a question widget: record it as the tool result and continue the turn.
  async answerWidget({ agentId, entryId, value }) {
    const id = this.roster.resolve(agentId);
    const store = this.roster.store(id);
    const entry = store.getEntry(entryId);
    if (!entry || entry.message?.type !== 'question') throw new Error(`no question widget: ${entryId}`);
    if (entry.message.answered) return { answered: false, reason: 'already answered', value: entry.message.answer };

    store.updateEntry(entryId, (e) => ({ ...e, message: { ...e.message, answered: true, answer: value } }));
    const callEntry = store
      .readAll()
      .reverse()
      .find((e) => e.kind === 'tool-call' && e.name === 'ask_user' && e.status === 'awaiting-answer');
    if (callEntry) {
      store.updateEntry(callEntry.id, (e) => ({ ...e, status: 'ok', summary: String(value).slice(0, 120) }));
      store.appendEntry(toolResultEntry({ name: 'ask_user', callId: callEntry.id, result: { answer: value } }));
    }
    this.bus.publish({ type: 'widget-answered', agentId: id, entryId, value });

    const nonce = randomUUID();
    const acceptance = {
      clientNonce: nonce,
      agentId: id,
      entryId,
      acceptedAtMs: Date.now(),
      state: 'accepted',
      trigger: 'widget-answer',
    };
    const parkedAcceptance = this.parked.get(id)?.acceptance;
    if (parkedAcceptance) parkedAcceptance.state = 'done';
    this.acceptances.set(nonce, acceptance);
    this.parked.delete(id);
    this.enqueue(id, () => this.runTurn({ agentId: id, acceptance }));
    return { answered: true, value, clientNonce: nonce };
  }

  interrupt(agentId) {
    const id = this.roster.resolve(agentId);
    // The queue lives in the scheduler now; aborting the stream is what actually stops
    // a running turn. A queued (not yet started) turn is dropped by the abort flag on
    // its acceptance, which runTurn checks before doing any work.
    const abort = this.aborts.get(id);
    const streaming = Boolean(abort);
    for (const a of this.acceptances.values()) {
      if (a.agentId === id && (a.state === 'accepted' || a.state === 'running')) {
        a.abortRequested = true;
        a.interruptedBy = 'operator';
        // A queued turn never starts: mark it settled now.
        if (a.state === 'accepted') a.state = 'interrupted';
      }
    }
    if (abort) abort.abort();
    this.bus.publish({ type: 'turn-interrupted', agentId: id, requested: true });
    return { interrupted: true, agentId: id, streaming };
  }

  // Bot-to-bot delivery.
  //
  // The real host splits this on `priority`:
  //   priority: true  → actionable; delivered now and wakes the recipient. It jumps
  //                     their queue and interrupts routine/background work, but waits
  //                     behind a turn already talking to the user or another agent.
  //   priority: false → informational; HELD and read at the start of the recipient's
  //                     next turn, whenever that is, without waking them.
  //
  // Delivery is idempotent on (toAgentId, messageId). Replies are asynchronous: the
  // sender is told not to wait. Groups are text-only and always post immediately.
  async sendToAgent({ fromAgentId, to, text, images = [], priority = false, messageId = null, turnId = null }) {
    const targetId = this.roster.resolve(to);
    const target = this.roster.summary(targetId);
    const from = this.roster.summary(fromAgentId);
    const fromRef = { id: fromAgentId, name: from?.name ?? fromAgentId };

    // Group target: text-only broadcast, never a wake.
    if (this.roster.profile(targetId)?.isGroup === true) {
      return this.postToGroup({ fromAgentId, groupId: targetId, text, images, priority });
    }

    const ledgerKey = `${targetId}\u0000${messageId ?? ''}`;
    if (messageId && this.receivedPeerMessageIds.has(ledgerKey)) {
      return { delivered: true, duplicate: true, agentId: targetId, priority };
    }

    const store = this.roster.store(targetId);
    const route = this.route(targetId);
    const entry = agentInboundEntry({ from: fromRef, text, images, priority, messageId });
    store.appendEntry(entry);
    if (messageId) this.rememberPeerMessageId(ledgerKey);
    this.bus.publish({ type: 'transcript', agentId: targetId, entry });

    // Record the outbound side in the sender's own transcript.
    const senderStore = this.roster.store(fromAgentId);
    const outbound = agentOutboundEntry({ to: { id: targetId, name: target?.name ?? targetId }, text, images });
    senderStore.appendEntry(outbound);
    this.bus.publish({ type: 'transcript', agentId: fromAgentId, entry: outbound });

    if (!route.runnable) {
      // Cannot run here; the message is still durably recorded as held.
      return { delivered: true, agentId: targetId, priority, held: true, reason: route.reason };
    }

    if (priority) {
      // Actionable: wake them now, on the agent lane so they yield to a live user turn.
      const nonce = randomUUID();
      const acceptance = {
        clientNonce: nonce,
        agentId: targetId,
        entryId: entry.id,
        acceptedAtMs: Date.now(),
        state: 'accepted',
        trigger: `message_agent:${fromAgentId}`,
        lane: 'agent',
        source: 'agent',
      };
      this.acceptances.set(nonce, acceptance);
      this.enqueue(targetId, () => this.runTurn({ agentId: targetId, acceptance }), {
        lane: 'agent',
        source: 'agent',
        acceptedAtMs: acceptance.acceptedAtMs,
        ackToken: nonce,
      });
      return { delivered: true, agentId: targetId, priority: true, woken: true, nonce };
    }

    // Informational: no wake. It is read when that bot next runs for any reason.
    return { delivered: true, agentId: targetId, priority: false, woken: false, held: true };
  }

  // A bot reaching the operator directly. The row lands in this bot's own transcript
  // (that is its chat) and is broadcast so an open client renders it immediately, even
  // when the operator is looking at a different bot.
  async messageUser({ agentId, text, reason = null }) {
    const body = String(text ?? '').trim();
    if (!body) return { delivered: false, reason: 'empty text' };
    const from = this.roster.summary(agentId);
    const entry = agentToUserEntry({
      from: { id: agentId, name: from?.name ?? agentId },
      text: body,
      reason,
    });
    this.roster.store(agentId).appendEntry(entry);
    this.bus.publish({ type: 'transcript', agentId, entry });
    this.bus.publish({ type: 'agent-to-user', agentId, entry });
    return { delivered: true, entryId: entry.id };
  }

  rememberPeerMessageId(key) {
    this.receivedPeerMessageIds.add(key);
    if (this.receivedPeerMessageIds.size > PEER_MESSAGE_ID_LEDGER_CAP) {
      const oldest = this.receivedPeerMessageIds.values().next().value;
      this.receivedPeerMessageIds.delete(oldest);
    }
  }

  // Group post: text-only, immediate, no interrupt. Members read it on their turn.
  async postToGroup({ fromAgentId, groupId, text, images = [], priority = false }) {
    const group = this.roster.profile(groupId) ?? {};
    const members = Array.isArray(group.memberIds) ? group.memberIds : [];
    const from = this.roster.summary(fromAgentId);
    const note = [];
    if (images.length) note.push('the attached image(s) were NOT delivered — group messages are text-only');
    if (priority) note.push('priority is 1:1 only — this post did not interrupt members');
    const delivered = [];
    for (const memberId of members) {
      if (memberId === fromAgentId) continue;
      const store = this.roster.store(memberId);
      const entry = agentInboundEntry({ from: { id: fromAgentId, name: from?.name ?? fromAgentId }, text, images: [], priority: false });
      entry.message.content = `[group:${group.name ?? groupId}] ${text}`;
      store.appendEntry(entry);
      this.bus.publish({ type: 'transcript', agentId: memberId, entry });
      delivered.push(memberId);
    }
    return {
      delivered: true,
      groupId,
      members: delivered,
      priority: false,
      ...(note.length ? { notes: note } : {}),
    };
  }

  // Fold held peer messages into the prompt of the next turn. This is what "read at
  // the start of their next turn" means concretely: the text is already in the
  // transcript, so buildMessages picks it up; this only reports what was waiting.
  pendingHeldMessages(agentId) {
    const entries = this.roster.store(agentId).readWindow({ limit: 200 });
    return entries.filter((e) => e.kind === 'message' && e.held === true && e.fromAgent);
  }

  // ---- side records -----------------------------------------------------
  // Provenance row — field-for-field the same shape a real box writes, so a
  // snapshot's log and this one can be compared line by line:
  //   schema / event / timestamp / traceId / agentId / modelId /
  //   hopBaseUrlHostOrRouteLabel / requestKind / upstreamId / responseModel /
  //   httpStatus / promptTokens / completionTokens / finishReason / elapsedMs /
  //   visibleOutputSha256 / visibleOutputBytes / visibleOutputCharacters /
  //   outputComplete / outcome / nullReasons
  //
  // Missing values are explicit nulls with a stated reason, never omitted: that is
  // what makes "we did not get usage" distinguishable from "usage was zero".
  writeProvenance(row) {
    const output = row.accumulated ?? '';
    const bytes = Buffer.byteLength(output);
    const nullReasons = {};
    const orNull = (value, reason) => {
      if (value != null) return value;
      nullReasons[reason.key] = reason.why;
      return null;
    };

    const line = {
      schema: 'GROKBOT_LOCAL_PROVENANCE_V1',
      event: 'local-bound-terminal',
      timestamp: new Date().toISOString(),
      traceId: row.turnId,
      agentId: row.agentId,
      modelId: row.binding.modelId,
      hopBaseUrlHostOrRouteLabel: row.binding.baseUrl,
      requestKind: 'main',
      upstreamId: orNull(row.upstreamId, { key: 'upstreamId', why: 'not_received_or_unsafe' }),
      responseModel: orNull(row.responseModel, { key: 'responseModel', why: 'not_received_or_unsafe' }),
      httpStatus: orNull(row.httpStatus, { key: 'httpStatus', why: 'no_http_response' }),
      promptTokens: orNull(row.usage?.prompt_tokens, { key: 'promptTokens', why: 'stream_usage_not_received' }),
      completionTokens: orNull(row.usage?.completion_tokens, {
        key: 'completionTokens',
        why: 'stream_usage_not_received',
      }),
      finishReason: row.outcome,
      elapsedMs: row.elapsedMs,
      visibleOutputSha256: createHash('sha256').update(output).digest('hex'),
      visibleOutputBytes: bytes,
      visibleOutputCharacters: output.length,
      outputComplete: row.outcome === 'ok',
      outcome: row.outcome === 'ok' ? 'success' : row.outcome === 'tool-calls' ? 'success' : 'error',
      nullReasons,
    };

    const file = path.join(this.p.logs, 'local-bound-provenance.jsonl');
    fs.mkdirSync(this.p.logs, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  }

  appendWorkLog({ agentId, status, elapsedMs, error }) {
    const agent = this.roster.summary(agentId);
    const file = path.join(this.p.logs, 'bot-work-log.jsonl');
    fs.mkdirSync(this.p.logs, { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        end: new Date().toISOString(),
        agent: agent?.name ?? agentId,
        task: 'turn',
        status,
        elapsed_ms: elapsedMs,
        ...(error ? { error } : {}),
      })}\n`,
    );
  }
}

function summarizeResult(result) {
  if (typeof result === 'string') return result.slice(0, 200);
  if (result && typeof result === 'object') {
    if ('exitCode' in result) return `exit ${result.exitCode}`;
    if (Array.isArray(result)) return `${result.length} entries`;
    return Object.keys(result).slice(0, 4).join(', ');
  }
  return String(result).slice(0, 200);
}

function safeHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return String(baseUrl ?? '').slice(0, 80);
  }
}
