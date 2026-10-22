// Public engine facade: prompt policy and provenance around the execution runtime.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TurnRuntime } from './runtime.mjs';

export class TurnEngine extends TurnRuntime {
  buildSystemPrompt(agentId, { conversationId = null } = {}) {
    const agent = this.roster.summary(agentId);
    const memory = this.roster.readMemoryAll(agentId, { conversationId }).trim();
    const skills = this.catalog.list();
    const settings = this.hostSettings() ?? {};
    const teammates = this.roster.list().filter((bot) => !bot.isGroup && bot.id !== agentId);
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
      '- Delegate work with delegate_task. The runtime waits for child results and resumes you automatically. Use message_agent for ordinary messages; it does not guarantee a reply.',
      '- Never claim you ran something you did not run, and never invent tool output.',
      '- Your visible reply is the message itself. Do not narrate tool calls, delivery status,',
      '  priority flags, or your internal plan in it — those belong in the transcript, not the text.',
      '- Never name tools or functions in your reply. Say "I messaged you" or "I sent it to the',
      '  ops group", never "message_user" / "message_agent" / "read_file" or any other API name.',
      '- If you already told the operator something yourself, do not repeat the same report to',
      '  the bot that asked you — one report is enough.',
      '',
      `## Time`,
      `Now: ${now.toISOString()} (${tz}). Treat all times as ${tz} unless asked otherwise.`,
      '',
      '## Language',
      lang === 'zh'
        ? `Address the operator as “${settings.userTitle || '你'}”. Write memory entries, notices, and your own notes in Chinese. Reply in the language the operator uses.`
        : `Address the operator as “${settings.userTitle || 'you'}”. Write memory entries, notices, and your own notes in English. Reply in the language the operator uses.`,
      '',
      '## Memory',
      memory ? memory : '(no memory yet)',
    ];

    if (teammates.length) {
      lines.push('', '## Teammates');
      for (const bot of teammates) lines.push(`- ${bot.name} (${bot.id}): ${bot.description ?? ''}`);
    }
    if (skills.length) {
    // Groups are addressable by name; without this list the model invents a need for a
    // group id and refuses to post.
    const groups = this.roster.list().filter((bot) => bot.isGroup);
    if (groups.length) {
      lines.push('', '## Groups');
      for (const g of groups) {
        const names = (g.memberIds ?? [])
          .map((id) => this.roster.summary(id)?.name)
          .filter(Boolean);
        lines.push(`- ${g.name}${names.length ? `: ${names.join(', ')}` : ''}`);
      }
      lines.push('- Address a group by its name in message_agent `to`. The name is enough —');
      lines.push('  never ask the operator for a group id. Group posts are plain text and do');
      lines.push('  not wake members; use priority only for a single bot.');
    }

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
