// Transcript entry model.
//
// The real host stores transcripts as JSON rows in transcript_entries.entry with a
// `kind` discriminator; tool-call rows are hidden from the window, branched rows are
// hidden too, and ordered `seq` is assigned on insert. This module owns the entry
// constructors so every writer produces the same shape.

import { randomUUID } from 'node:crypto';

export function entryId(kind) {
  return `${kind}-${randomUUID()}`;
}

export function userMessageEntry({ text, clientNonce, attachmentPaths = [], replyTo = null }) {
  const now = Date.now();
  return {
    kind: 'message',
    id: entryId('msg'),
    role: 'user',
    message: { type: 'text', content: text },
    ...(clientNonce ? { clientNonce } : {}),
    ...(attachmentPaths.length ? { attachments: attachmentPaths } : {}),
    ...(replyTo ? { replyTo } : {}),
    timestampMs: now,
  };
}

export function assistantTextEntry({ text, streaming = false, requestId = null, turnId = null }) {
  return {
    kind: 'send-message',
    id: entryId('send'),
    message: { type: 'text', content: text },
    ...(streaming ? { streaming: true } : {}),
    ...(requestId ? { requestId } : {}),
    ...(turnId ? { turnId } : {}),
    timestampMs: Date.now(),
  };
}

export function reasoningEntry({ text, turnId }) {
  return {
    kind: 'reasoning',
    id: entryId('reason'),
    text,
    ...(turnId ? { turnId } : {}),
    timestampMs: Date.now(),
  };
}

export function toolCallEntry({ name, args, callId, status = 'running', summary = '', turnId = null }) {
  return {
    kind: 'tool-call',
    id: callId ?? entryId('tool'),
    name,
    args,
    status,
    summary,
    ...(turnId ? { turnId } : {}),
    timestampMs: Date.now(),
  };
}

export function toolResultEntry({ name, callId, result, isError = false, turnId = null }) {
  return {
    kind: 'tool-result',
    id: entryId('toolres'),
    name,
    callId,
    result: typeof result === 'string' ? result : JSON.stringify(result),
    isError,
    ...(turnId ? { turnId } : {}),
    timestampMs: Date.now(),
  };
}

export function eventEntry(type, event = {}) {
  return {
    kind: 'event',
    id: entryId('event'),
    event: { type, ...event },
    timestampMs: Date.now(),
  };
}

export function noticeEntry(text, { level = 'info', turnId = null } = {}) {
  return {
    kind: 'notice',
    id: entryId('notice'),
    text,
    level,
    // A notice belongs to the turn that produced it; without this it floats between two
    // turns and reads as if it were the next turn's opening line.
    ...(turnId ? { turnId } : {}),
    timestampMs: Date.now(),
  };
}

export function approvalEntry({ requestId, command, surface = 'shell', resolution = null }) {
  return {
    kind: 'send-message',
    id: entryId('send'),
    message: {
      type: 'auto-review-approval',
      approval: { surface, command, requestId },
      resolution,
    },
    timestampMs: Date.now(),
  };
}

// Inbound from another bot. The real host prefixes the text with "[agent]" so the
// receiving model can tell a teammate's message from the user's words; a
// non-priority message is "held" and only read at the start of the next turn.
export function agentInboundEntry({ from, text, images = [], priority = false, messageId = null }) {
  return {
    kind: 'message',
    id: entryId('agent-inbound'),
    role: 'user',
    fromAgent: { kind: 'bot', id: from.id, name: from.name },
    message: { type: 'text', content: `[agent] ${text}` },
    ...(images.length ? { images } : {}),
    ...(priority ? { priority: true } : { held: true }),
    ...(messageId ? { peerMessageId: messageId } : {}),
    timestampMs: Date.now(),
  };
}

// A bot speaking to the operator on its own initiative (not the reply to a turn the
// operator started). It is rendered as an incoming message and, unlike a normal reply,
// can land while the operator is looking at a different bot.
export function agentToUserEntry({ from, text, images = [], reason = null }) {
  return {
    kind: 'message',
    id: entryId('agent-to-user'),
    role: 'assistant',
    fromAgent: { kind: 'bot', id: from.id, name: from.name },
    message: { type: 'text', content: text },
    ...(images.length ? { images } : {}),
    ...(reason ? { reason } : {}),
    proactive: true,
    timestampMs: Date.now(),
  };
}

// Outbound record: what this bot sent to a teammate, kept in its own transcript.
export function agentOutboundEntry({ to, text, images = [], taskId = null }) {
  return {
    kind: 'message',
    id: entryId('agent-outbound'),
    role: 'assistant',
    toAgent: { kind: 'bot', id: to.id, name: to.name },
    message: { type: 'text', content: text },
    ...(images.length ? { images } : {}),
    ...(taskId ? { taskId } : {}),
    timestampMs: Date.now(),
  };
}

// A question widget: the turn ends here and the answer resumes it.
export function widgetEntry({ widgetId, prompt, options = [], allowCustom = false }) {
  return {
    kind: 'send-message',
    id: entryId('send'),
    message: { type: 'question', widgetId, prompt, options, allowCustom, answered: false },
    timestampMs: Date.now(),
  };
}

// Rows excluded from the visible window (mirrors the host's partial index).
export function isWindowEntry(entry) {
  return entry.kind !== 'tool-call' && entry.branched !== 1;
}

export function summarizeEntry(entry) {
  switch (entry.kind) {
    case 'message':
    case 'send-message':
      return entry.message?.content ?? entry.message?.text ?? '';
    case 'notice':
      return entry.text;
    case 'reasoning':
      return entry.text;
    case 'event':
      return entry.event?.type ?? '';
    default:
      return '';
  }
}
