// Final conversation regressions. No external provider, shared mock, or production patches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fixture, until, barrier, userText, encoded } from './conversation-fixture.mjs';

const options = { timeout: 15000 };
const textOf = (rows) => rows.map((row) => row.message?.content ?? '').join('\n');

test('two groups sharing a bot and concurrent DM keep provider histories and memory isolated', options, async (t) => {
  const gate = barrier();
  const f = await fixture(t, { script: (body) => userText(body).includes('ROOM_ONE_SECRET') ? { gate } : {} });
  const a = f.bot('Shared'), g1 = f.group('First', [a]), g2 = f.group('Second', [a]);
  f.host.roster.writeMemory(a.id, 'PRIVATE_MEMORY_CANARY');
  const historical = await f.send(a, 'PRIVATE_HISTORY_CANARY');
  await f.settled(historical.clientNonce);
  const first = await f.send(g1, 'ROOM_ONE_SECRET');
  await until(() => f.requests.some((row) => userText(row.body).includes('ROOM_ONE_SECRET')));
  const [second, direct] = await Promise.all([f.send(g2, 'ROOM_TWO_SECRET'), f.send(a, 'PRIVATE_CURRENT_CANARY')]);
  // All three admissions exist while the first request is held, even though a bot executes serially.
  assert.equal(f.host.rooms.admission(second.clientNonce).targets.length, 1);
  assert.ok((await f.rows(a)).some((row) => row.clientNonce === direct.clientNonce));
  gate.release();
  await Promise.all([f.groupSettled(first.clientNonce), f.groupSettled(second.clientNonce), f.settled(direct.clientNonce)]);
  const groupRequests = f.requests.filter((row) => /ROOM_(ONE|TWO)_SECRET/.test(userText(row.body)));
  assert.equal(groupRequests.length, 2);
  for (const { body } of groupRequests) {
    assert.doesNotMatch(encoded(body.messages), /PRIVATE_(MEMORY|HISTORY|CURRENT)_CANARY/);
    const mine = userText(body).includes('ROOM_ONE_SECRET') ? 'ROOM_TWO_SECRET' : 'ROOM_ONE_SECRET';
    assert.ok(!encoded(body.messages).includes(mine));
  }
  const dm = f.requests.find((row) => userText(row.body) === 'PRIVATE_CURRENT_CANARY').body;
  assert.match(encoded(dm.messages), /PRIVATE_MEMORY_CANARY/);
  assert.match(encoded(dm.messages), /PRIVATE_HISTORY_CANARY/);
  assert.doesNotMatch(encoded(dm.messages), /ROOM_(ONE|TWO)_SECRET/);
  assert.doesNotMatch(textOf(await f.rows(a)), /ROOM_(ONE|TWO)_SECRET/);
});

test('a bot post persists, wakes members to decide for themselves, and never duplicates into member DMs', options, async (t) => {
  const f = await fixture(t);
  const a = f.bot('Author'), b = f.bot('Reader');
  const g = await f.rpc('createGroup', { name: 'Normal Group', memberAgentIds: [a.id, b.id] });
  const receipt = await f.rpc('messageAgent', { fromAgentId: a.id, to: g.id, text: 'PEER_POST_UNIQUE', priority: true, messageId: 'bot-post-1' });
  assert.equal(receipt.woken, true, 'members are woken so they can decide to answer or pass');
  assert.equal(f.host.roster.store(g.id).getEntry(receipt.entryId).message.content, 'PEER_POST_UNIQUE');
  // Waking is asynchronous; the room keeps exactly one copy of the post either way.
  // The visible copy lives in the room; the wake prompts are hidden rows in the same
  // conversation, so only non-hidden rows count as "posted".
  assert.equal((await f.rows(g)).filter((row) => !row.hidden && row.message?.content === 'PEER_POST_UNIQUE').length, 1);
  for (const bot of [a, b]) assert.doesNotMatch(textOf(await f.rows(bot)), /PEER_POST_UNIQUE/);
  const duplicate = await f.rpc('messageAgent', { fromAgentId: a.id, to: g.id, text: 'PEER_POST_UNIQUE', priority: true, messageId: 'bot-post-1' });
  assert.equal(duplicate.duplicate, true);
  const post = await f.send(g, 'reader inspect', { mentionAgentIds: [b.id] });
  await f.groupSettled(post.clientNonce);
  // Wake requests now exist too, so pick the mention run by its own prompt and check
  // that it sees the bot post exactly once.
  const mentionRun = f.requests.find((r) => String(r.body.messages.at(-1)?.content ?? '').includes('reader inspect'));
  assert.ok(mentionRun, 'the mentioned member ran');
  const matches = mentionRun.body.messages.filter((row) => String(row.content).includes('PEER_POST_UNIQUE'));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].role, 'user');
  assert.match(matches[0].content, new RegExp(a.id));
  assert.equal((await f.rows(g)).filter((row) => row.message?.content === 'PEER_POST_UNIQUE').length, 1);
});

for (const park of [false, true]) test(`DM peer inbound is immediately visible and reloadable while group ${park ? 'parked' : 'running'}`, options, async (t) => {
  const gate = barrier();
  const f = await fixture(t, { script: (body) => userText(body).includes('GROUP_HOLD') && body.messages.at(-1).role !== 'tool'
    ? park ? { tool: { name: 'ask_user', args: { prompt: 'group decision?', options: ['yes', 'no'] } } } : { gate } : {} });
  const a = f.bot('Busy'), peer = f.bot('Messenger'), g = f.group('Busy Room', [a]);
  const posted = await f.send(g, 'GROUP_HOLD');
  const target = f.host.rooms.admission(posted.clientNonce).targets[0];
  await until(() => park ? f.host.engine.getRun(target.runId)?.state === 'awaiting-answer' : f.requests.length === 1);
  const delivered = await f.rpc('messageAgent', { fromAgentId: peer.id, to: a.id, text: 'DM_INBOUND_VISIBLE', messageId: `inbound-${park}` });
  const rows = await f.rows(a);
  assert.equal(rows.filter((row) => row.id === delivered.entryId).length, 1);
  assert.equal(rows.find((row) => row.id === delivered.entryId).held, true);
  assert.equal((await f.rows(g)).some((row) => row.id === delivered.entryId), false);
  if (park) {
    const card = rows.find((row) => row.message?.type === 'question');
    assert.ok(card);
    assert.equal(card.conversationId, `group:${g.id}`);
    assert.equal(card.displayConversationId, `dm:${a.id}`);
    await f.rpc('respondToWidget', { agentId: a.id, entryId: card.id, value: 'yes' });
  } else gate.release();
  await f.groupSettled(posted.clientNonce);
  await f.restart();
  assert.equal((await f.rows(a)).filter((row) => row.id === delivered.entryId).length, 1);
  const dm = await f.send(a, 'READ_INBOUND');
  await f.settled(dm.clientNonce);
  const last = f.requests.at(-1).body;
  assert.match(encoded(last.messages), /DM_INBOUND_VISIBLE/);
  assert.doesNotMatch(encoded(last.messages), /GROUP_HOLD/);
});

test('DM input watermark excludes later queued prompt from its next real tool step', options, async (t) => {
  const gate = barrier();
  const f = await fixture(t, { script: (body) => userText(body) === 'CURRENT_TOOL_PROMPT' && body.messages.at(-1).role !== 'tool'
    ? { gate, tool: { name: 'read_file', args: { path: 'watermark.txt' } } } : {} });
  fs.writeFileSync(path.join(f.host.p.workspace, 'watermark.txt'), 'tool checkpoint');
  const a = f.bot('Watermark');
  const first = await f.send(a, 'CURRENT_TOOL_PROMPT');
  await until(() => f.requests.length === 1);
  const future = await f.send(a, 'FUTURE_QUEUED_PROMPT');
  assert.ok((await f.rows(a)).some((row) => row.clientNonce === future.clientNonce));
  gate.release();
  const currentResult = await f.settled(first.clientNonce);
  assert.equal(currentResult.state, 'done');
  await f.settled(future.clientNonce);
  const nextStep = f.requests.find((row) => row.body.messages.at(-1).role === 'tool');
  assert.ok(nextStep, 'real provider request after read_file');
  assert.doesNotMatch(encoded(nextStep.body.messages), /FUTURE_QUEUED_PROMPT/);
  assert.match(encoded(nextStep.body.messages), /tool checkpoint/);
});

test('@ selection, explicit empty mentionAgentIds, and default fanout use actual admissions', options, async (t) => {
  const f = await fixture(t);
  const a = f.bot('Nas Bot'), b = f.bot('Nas Bot X'), g = f.group('Mention Room', [a, b]);
  const selected = await f.send(g, '@Nas Bot X status?');
  assert.deepEqual(selected.members, [b.id]);
  await f.groupSettled(selected.clientNonce);
  const explicit = await f.send(g, '@Nas Bot X status?', { mentionAgentIds: [a.id] });
  assert.deepEqual(explicit.members, [a.id]);
  await f.groupSettled(explicit.clientNonce);
  const before = f.requests.length;
  const empty = await f.send(g, 'NO_WAKE_EMPTY', { mentionAgentIds: [] });
  assert.deepEqual(empty.members, []);
  assert.equal(empty.state, 'done');
  assert.equal(f.requests.length, before);
  assert.match(textOf(await f.rows(g)), /NO_WAKE_EMPTY/);
  const emptyAlias = await f.send(g, 'NO_WAKE_EMPTY_ALIAS', { mentions: [] });
  assert.deepEqual(emptyAlias.members, []);
  assert.equal(f.requests.length, before);
  assert.equal(f.host.rooms.selectedMembers(g.id, '@Nas Bot Xylophone', null).mentioned, false);
  const fanout = await f.send(g, 'DEFAULT_FANOUT');
  assert.deepEqual(fanout.members, [a.id, b.id]);
  await f.groupSettled(fanout.clientNonce);
});

test('round B starts after A durable delivery and reads A exactly once as role=user', options, async (t) => {
  const gate = barrier();
  const f = await fixture(t, { script: (body) => body.model === 'script-RoundA' ? { gate, text: 'ROUND_A_DELIVERED_VALUE' } : { text: 'ROUND_B_RESULT' } });
  const a = f.bot('RoundA'), b = f.bot('RoundB'), g = f.group('Serial Room', [a, b]);
  const round = f.host.rooms.runRound({ roomId: g.id, newMessages: [{ speakerKind: 'human', speakerName: 'operator', text: 'ROUND_TRIGGER' }] });
  await until(() => f.requests.length === 1);
  assert.equal(f.requests[0].body.model, 'script-RoundA');
  assert.equal(f.host.engine.execution.listRuns().filter((run) => run.agentId === b.id).length, 0, 'B is not admitted while A is held');
  gate.release();
  const result = await round;
  assert.deepEqual(result.results.map((row) => row.outcome), ['delivered', 'delivered']);
  const requestB = f.requests.find((row) => row.body.model === 'script-RoundB');
  assert.ok(requestB.startedAt >= f.requests[0].finishedAt);
  const seen = requestB.body.messages.filter((row) => String(row.content).includes('ROUND_A_DELIVERED_VALUE'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].role, 'user');
  assert.equal((await f.rows(g)).filter((row) => row.message?.content === 'ROUND_A_DELIVERED_VALUE').length, 1);
});

test('same group nonce concurrent retries and restart replay one input, member run, and answer', options, async (t) => {
  const f = await fixture(t);
  const a = f.bot('Deduper'), g = f.group('Dedupe Room', [a]);
  const send = () => f.send(g, 'DEDUPE_INPUT', { clientNonce: 'group-dedupe-fixed' });
  const receipts = await Promise.all([send(), send(), send()]);
  assert.ok(receipts.slice(1).every((receipt) => receipt.replayed));
  await f.groupSettled('group-dedupe-fixed');
  const firstRows = await f.rows(g), count = f.requests.length;
  assert.equal(firstRows.filter((row) => row.message?.content === 'DEDUPE_INPUT').length, 1);
  assert.equal(firstRows.filter((row) => row.kind === 'send-message').length, 1);
  const runId = f.host.rooms.admission('group-dedupe-fixed').targets[0].runId;
  await f.restart();
  const replay = await send();
  assert.equal(replay.replayed, true);
  await f.groupSettled('group-dedupe-fixed');
  assert.equal(f.requests.length, count);
  assert.equal(f.host.rooms.admission('group-dedupe-fixed').targets[0].runId, runId);
  assert.deepEqual((await f.rows(g)).map((row) => row.id), firstRows.map((row) => row.id));
  await f.rpc('sendPrompt', { agentId: g.id, prompt: 'DIFFERENT_INPUT', clientNonce: 'group-dedupe-fixed' }, { status: 409 });
});

for (const mode of ['cancel', 'timeout']) test(`Room ${mode} targets exact queued childrun and leaves same-bot unrelated DM alive`, options, async (t) => {
  const gate = barrier();
  const f = await fixture(t, { script: (body) => userText(body) === 'UNRELATED_DM_RUNNING' ? { gate } : {} });
  const a = f.bot(`Cancel-${mode}`), g = f.group(`Cancel room ${mode}`, [a]);
  const dm = await f.send(a, 'UNRELATED_DM_RUNNING');
  await until(() => f.requests.length === 1);
  const round = f.host.rooms.runRound({ roomId: g.id, deadlineMs: mode === 'timeout' ? 180 : 5000 });
  const groupRun = await until(() => f.host.engine.execution.listRuns().find((run) => run.conversationId === `group:${g.id}`));
  assert.notEqual(groupRun.runId, dm.runId);
  if (mode === 'cancel') f.host.rooms.cancel(g.id);
  const result = await round;
  assert.equal(result.results[0].outcome, mode === 'timeout' ? 'timeout' : 'cancelled');
  await until(() => f.host.engine.getRun(groupRun.runId).state === 'interrupted');
  assert.equal(f.host.engine.getRun(dm.runId).state, 'running');
  assert.equal(f.host.engine.getRun(dm.runId).abortRequested, undefined);
  assert.equal(f.requests.length, 1, 'cancelled queued group never reaches provider');
  gate.release();
  assert.equal((await f.settled(dm.clientNonce)).state, 'done');
});

for (const harness of ['local', 'temporal']) for (const mode of ['cancel', 'timeout']) test(`active ${harness} Room ${mode} cancels exact child and preserves queued same-bot DM`, options, async (t) => {
  const gate = barrier();
  const f = await fixture(t, { script: (body) => userText(body).includes('ACTIVE_ROOM_HOLD') ? { gate, text: 'LATE_ROOM_RESULT' } : { text: 'SURVIVING_DM_RESULT' } });
  const a = f.bot(`Active-${harness}-${mode}`, { harness }), g = f.group(`Active room ${harness} ${mode}`, [a]);
  const actions = [], original = f.host.proxy.transport;
  f.host.proxy.transport = { async performAction(action) { actions.push(structuredClone(action)); return original.performAction(action); } };
  const round = f.host.rooms.runRound({ roomId: g.id, deadlineMs: mode === 'timeout' ? 350 : 5000, newMessages: [{ speakerKind: 'human', speakerName: 'operator', text: 'ACTIVE_ROOM_HOLD' }] });
  await until(() => f.requests.length === 1);
  const child = f.host.engine.execution.listRuns().find((run) => run.conversationId === `group:${g.id}`);
  assert.equal(child.state, 'running');
  const dm = await f.send(a, 'SURVIVE_ROOM_CANCELLATION');
  assert.equal(f.host.engine.getRun(dm.runId).state, 'accepted');
  if (mode === 'cancel') f.host.rooms.cancel(g.id);
  const result = await round;
  assert.equal(result.results[0].outcome, mode === 'cancel' ? 'cancelled' : 'timeout');
  assert.equal((await f.settled(dm.clientNonce)).state, 'done');
  await until(() => f.host.engine.getRun(child.runId).state === 'interrupted');
  assert.equal(f.host.engine.getRun(dm.runId).abortRequested, undefined);
  if (harness === 'temporal') {
    const cancel = actions.find((action) => action.method === 'interruptAgentRun');
    assert.ok(cancel);
    assert.equal(cancel.args.agentId, a.id);
    assert.equal(cancel.args.runId, child.runId);
    assert.notEqual(cancel.args.runId, dm.runId);
  }
  gate.release();
  assert.doesNotMatch(textOf(await f.rows(g)), /LATE_ROOM_RESULT/);
  assert.match(textOf(await f.rows(a)), /SURVIVING_DM_RESULT/);
});

test('remote member proxy forwards full identity and mirrors same remote result locally once across replay/restart', options, async (t) => {
  const f = await fixture(t);
  const a = f.bot('Remote', { harness: 'temporal' }), g = f.group('Remote Room', [a]);
  const actions = [];
  const transport = f.host.proxy.transport;
  f.host.proxy.transport = { async performAction(action) { actions.push(structuredClone(action)); return transport.performAction(action); } };
  const posted = await f.send(g, 'REMOTE_GROUP_INPUT', { clientNonce: 'remote-group-nonce' });
  const admission = await f.groupSettled(posted.clientNonce);
  const target = admission.targets[0];
  const forwarded = actions.find((action) => action.method === 'sendPrompt').args;
  for (const key of ['agentId', 'clientNonce', 'conversationId', 'sourceMessageId', 'hidden', 'lane', 'source', 'trigger', 'contextPrompt']) assert.equal(forwarded[key], target.args[key], key);
  assert.equal(forwarded.inputThroughSeq, admission.inputThroughSeq);
  assert.equal(forwarded.conversationId, `group:${g.id}`);
  const localRun = f.host.engine.getRun(target.runId);
  const result = await f.host.proxy.act({ method: 'promptAcceptanceStatus', args: { agentId: a.id, clientNonce: target.clientNonce, runId: target.runId } });
  assert.equal(result.runId, localRun.runId);
  assert.equal(result.conversationId, `group:${g.id}`);
  assert.ok(result.resultEntryId);
  assert.ok(result.resultText);
  const acceptance = { ...target, agentId: a.id, parentNonce: posted.clientNonce };
  f.host.rooms.mirrorRemoteResult(acceptance, result);
  f.host.rooms.mirrorRemoteResult(acceptance, result);
  const before = await f.rows(g);
  assert.equal(before.filter((row) => row.kind === 'send-message').length, 1);
  assert.doesNotMatch(textOf(await f.rows(a)), /REMOTE_GROUP_INPUT|RESULT:/);
  await f.restart();
  await f.send(g, 'REMOTE_GROUP_INPUT', { clientNonce: 'remote-group-nonce' });
  assert.deepEqual((await f.rows(g)).map((row) => row.id), before.map((row) => row.id));
  assert.equal(f.requests.length, 1);
});

test('HTTP transcript/tail/outline/export/branch isolate private group traces and remap branch callId pairs', options, async (t) => {
  const f = await fixture(t, { script: (body) => body.messages.at(-1).role === 'tool' ? { text: 'TOOL_DONE' } : { tool: { name: 'read_file', args: { path: 'api.txt' } } } });
  fs.writeFileSync(path.join(f.host.p.workspace, 'api.txt'), 'REAL_TOOL_RESULT');
  const a = f.bot('API'), g = f.group('API Room', [a]);
  const direct = await f.send(a, 'DM_API_ONLY');
  await f.settled(direct.clientNonce);
  const group = await f.send(g, 'GROUP_API_ONLY');
  await f.groupSettled(group.clientNonce);
  for (const method of ['getAgentTranscript', 'getAgentTranscriptAll', 'getAgentTranscriptTail']) {
    const rows = await f.rpc(method, { agentId: a.id });
    assert.match(textOf(rows), /DM_API_ONLY/);
    assert.doesNotMatch(encoded(rows), /GROUP_API_ONLY|group:/);
    await f.rpc(method, { agentId: a.id, conversationId: `group:${g.id}` }, { status: 409 });
  }
  const outline = await f.rpc('getAgentOutline', { agentId: a.id });
  assert.equal(outline.length, 1);
  assert.equal(outline[0].hasResult, true);
  assert.match(outline[0].result, /REAL_TOOL_RESULT/);
  assert.equal((await f.rpc('getAgentOutline', { agentId: g.id })).length, 0);
  const dmExport = await f.rpc('exportTranscript', { agentId: a.id });
  assert.match(dmExport.content, /DM_API_ONLY/);
  assert.doesNotMatch(dmExport.content, /GROUP_API_ONLY/);
  const groupExport = await f.rpc('exportTranscript', { agentId: g.id });
  assert.match(groupExport.content, /GROUP_API_ONLY/);
  assert.doesNotMatch(groupExport.content, /DM_API_ONLY|read_file/);
  const rows = await f.rows(a);
  const branched = await f.rpc('branchConversation', { agentId: a.id, entryId: rows.at(-1).id });
  const copies = await f.rpc('getAgentTranscriptAll', { agentId: branched.agentId });
  assert.doesNotMatch(encoded(copies), /GROUP_API_ONLY/);
  const call = copies.find((row) => row.kind === 'tool-call'), result = copies.find((row) => row.kind === 'tool-result');
  assert.equal(result.callId, call.id);
  assert.notEqual(call.id, rows.find((row) => row.kind === 'tool-call').id);
  assert.equal((await f.rpc('getAgentOutline', { agentId: branched.agentId }))[0].hasResult, true);
  assert.ok(copies.every((row) => row.conversationId === `dm:${branched.agentId}` && !row.runId));
  const groupRows = await f.rows(g);
  const groupBranch = await f.rpc('branchConversation', { agentId: g.id, entryId: groupRows.at(-1).id });
  const groupCopies = await f.rpc('getAgentTranscriptAll', { agentId: groupBranch.agentId });
  assert.match(textOf(groupCopies), /GROUP_API_ONLY/);
  assert.doesNotMatch(encoded(groupCopies), /DM_API_ONLY|REAL_TOOL_RESULT/);
  assert.equal(groupCopies.some((row) => row.kind === 'tool-call' || row.kind === 'tool-result'), false);
  assert.ok(groupCopies.every((row) => row.conversationId === `dm:${groupBranch.agentId}` && !row.runId));
});

test('branch and reset make old question cards inactive and stale actions produce no provider work', options, async (t) => {
  const f = await fixture(t, { script: () => ({ tool: { name: 'ask_user', args: { prompt: 'OLD_QUESTION', options: ['yes', 'no'] } } }) });
  const a = f.bot('OldCard');
  const sent = await f.send(a, 'park question');
  await until(() => f.host.engine.getRun(sent.runId)?.state === 'awaiting-answer');
  const rows = await f.rows(a), card = rows.find((row) => row.message?.type === 'question');
  assert.ok(card);
  const branch = await f.rpc('branchConversation', { agentId: a.id, entryId: card.id });
  const historical = (await f.rpc('getAgentTranscriptAll', { agentId: branch.agentId })).find((row) => row.message?.type === 'question');
  assert.equal(historical.message.inert, true);
  assert.equal(historical.message.answered, true);
  assert.equal(historical.message.cancelled, true);
  const before = f.requests.length;
  await f.rpc('respondToWidget', { agentId: branch.agentId, entryId: historical.id, value: 'yes' }, { status: 409 });
  await f.rpc('startFreshConversation', { agentId: a.id });
  await f.rpc('respondToWidget', { agentId: a.id, entryId: card.id, value: 'yes' }, { status: 409 });
  assert.equal(f.requests.length, before);
  assert.equal(f.host.engine.getRun(sent.runId).state, 'interrupted');
  assert.equal((await f.rows(a)).length, 0);
});

test('independent remote executor result is mirrored once without a local member run', options, async (t) => {
  const f = await fixture(t);
  const a = f.bot('IndependentRemote', { harness: 'temporal' }), g = f.group('Independent Remote Room', [a]);
  const actions = [];
  let remote;
  f.host.proxy.transport = { async performAction(action) {
    actions.push(structuredClone(action));
    if (action.method === 'sendPrompt') {
      remote = { ...action.args, accepted: true, runId: 'remote-only-run-identity', entryId: 'remote-input', state: 'done', resultText: 'INDEPENDENT_REMOTE_RESULT', resultEntryId: 'remote-output', finishedAtMs: Date.now() };
      return { status: 'ok', result: remote };
    }
    if (action.method === 'promptAcceptanceStatus') return { status: 'ok', result: { ...remote, record: remote, outcome: 'found' } };
    return { status: 'error', error: 'unexpected method' };
  } };
  const posted = await f.send(g, 'REMOTE_ONLY_INPUT', { clientNonce: 'independent-remote-nonce' });
  const admission = await f.groupSettled(posted.clientNonce), target = admission.targets[0];
  assert.equal(target.runId, remote.runId);
  assert.equal(f.host.engine.execution.listRuns().length, 0);
  assert.equal(f.requests.length, 0);
  const args = actions.find((action) => action.method === 'sendPrompt').args;
  assert.equal(args.sourceMessageId, admission.entryId);
  assert.equal(args.inputThroughSeq, admission.inputThroughSeq);
  assert.equal(args.conversationId, `group:${g.id}`);
  assert.equal(args.clientNonce, `group:${posted.clientNonce}:${a.id}`);
  const acceptance = { ...target, agentId: a.id, parentNonce: posted.clientNonce };
  await f.host.rooms.memberStatus(acceptance);
  await f.host.rooms.memberStatus(acceptance);
  const rows = await f.rows(g);
  assert.equal(rows.filter((row) => row.message?.content === 'INDEPENDENT_REMOTE_RESULT').length, 1);
  assert.doesNotMatch(textOf(await f.rows(a)), /REMOTE_ONLY_INPUT|INDEPENDENT_REMOTE_RESULT/);
  await f.restart();
  await f.send(g, 'REMOTE_ONLY_INPUT', { clientNonce: 'independent-remote-nonce' });
  assert.deepEqual((await f.rows(g)).map((row) => row.id), rows.map((row) => row.id));
});

test('historical approval cards in branches are inert; reset expires original resolver', options, async (t) => {
  const f = await fixture(t, { script: () => ({ tool: { name: 'shell', args: { command: 'printf approval-check' } } }) });
  f.host.tools.setPolicy({ autoApprove: false, deny: [] });
  const a = f.bot('OldApproval');
  const sent = await f.send(a, 'park approval');
  await until(() => f.host.engine.getRun(sent.runId)?.state === 'awaiting-approval');
  const card = (await f.rows(a)).find((row) => row.message?.type === 'auto-review-approval');
  assert.ok(card);
  const branch = await f.rpc('branchConversation', { agentId: a.id, entryId: card.id });
  const historical = (await f.rpc('getAgentTranscriptAll', { agentId: branch.agentId })).find((row) => row.message?.type === 'auto-review-approval');
  assert.equal(historical.message.inert, true);
  assert.equal(historical.message.resolution, 'expired');
  const count = f.requests.length;
  await f.rpc('resolveAutoReviewApproval', { agentId: branch.agentId, entryId: historical.id, resolution: 'approved' }, { status: 409 });
  await f.rpc('startFreshConversation', { agentId: a.id });
  await f.rpc('resolveAutoReviewApproval', { agentId: a.id, entryId: card.id, resolution: 'approved' }, { status: 409 });
  assert.equal(f.requests.length, count);
  assert.equal(f.host.engine.getRun(sent.runId).state, 'interrupted');
});

test('UI real pure helpers isolate event conversations and dedupe longest-name mentions (VM, no browser interaction)', () => {
  const html = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  const block = (start, end) => {
    const from = html.indexOf(start), to = html.indexOf(end, from);
    assert.ok(from >= 0 && to > from);
    return html.slice(from, to);
  };
  const context = vm.createContext({ activeId: 'a', agents: [{ id: 'a' }, { id: 'g', isGroup: true }], mentionCandidates: () => [{ id: 'short', name: 'Nas Bot' }, { id: 'long', name: 'Nas Bot X' }] });
  vm.runInContext(block('function conversationFor(', 'function invalidateSendAttempt(') + '\n' + block('function mentionedAgentIds(', 'async function send('), context);
  assert.equal(vm.runInContext("conversationFor('g')", context), 'group:g');
  assert.equal(vm.runInContext("matchesConversation({agentId:'a', conversationId:'group:g'})", context), false);
  assert.equal(vm.runInContext("matchesConversation({agentId:'a', conversationId:'group:g', displayConversationId:'dm:a'})", context), true);
  assert.equal(vm.runInContext("matchesConversation({agentId:'other', conversationId:'dm:other'})", context), false);
  assert.equal(vm.runInContext("JSON.stringify(mentionedAgentIds('@Nas Bot X @Nas Bot X @Nas Bot'))", context), '["long","short"]');
  assert.equal(vm.runInContext("JSON.stringify(mentionedAgentIds('@Nas Bot Xylophone'))", context), '[]', 'name prefixes must not select an unrelated member');
});
