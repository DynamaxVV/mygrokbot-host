// Conversation identities are independent of bot identities and UI visibility.
export const directConversation = (botId) => `dm:${botId}`;
export const groupConversation = (groupId) => `group:${groupId}`;
export const taskConversation = (taskId) => `task:${taskId}`;
export const TERMINAL_RUN_STATES = new Set(['done', 'error', 'interrupted', 'needs-reconciliation']);
export const WAITING_RUN_STATES = new Set(['awaiting-approval', 'awaiting-answer', 'waiting-children']);

export function entryConversation(entry, botId, hiddenTurns = new Set()) {
  if (entry.conversationId) return entry.conversationId;
  if (entry.hidden || (entry.turnId && hiddenTurns.has(entry.turnId))) return `legacy:unknown:${botId}`;
  return directConversation(botId);
}

export function contextFields(run, segmentId = run.turnId) {
  return {
    schemaVersion: 2,
    conversationId: run.conversationId,
    botId: run.agentId ?? run.botId,
    runId: run.runId,
    ...(segmentId ? { turnId: segmentId, segmentId } : {}),
    ...(run.taskId ? { taskId: run.taskId } : {}),
    ...(run.hidden ? { hidden: true } : {}),
  };
}

// Map actual speakers, not the storage kind, to the provider's two conversation roles.
export function projectText(entry, botId) {
  const speaker = entry.speaker ?? (entry.fromAgent ? { kind: 'bot', ...entry.fromAgent } : null);
  const fromPeer = speaker && speaker.kind !== 'human' && speaker.id !== botId;
  const outgoing = entry.kind === 'send-message' || entry.role === 'assistant';
  const role = fromPeer ? 'user' : outgoing ? 'assistant' : 'user';
  let content = String(entry.message?.content ?? '');
  if (speaker && (fromPeer || speaker.kind === 'human')) content = `[${speaker.kind ?? 'bot'}:${speaker.name ?? speaker.id} (${speaker.id})] ${content}`;
  if (entry.toAgent) content = `[to:${entry.toAgent.name ?? entry.toAgent.id}] ${content}`;
  if (entry.attachments?.length) content += `\n\n[附件]\n${entry.attachments.map((file) => `- ${file}`).join('\n')}`;
  return { role, content };
}

export function abortError(reason = 'run cancelled') {
  const error = new Error(String(reason));
  error.name = 'AbortError';
  return error;
}
