import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPeers } from '../src/peers.mjs';
import { runPeerWatch } from '../src/peer-watch-worker.mjs';

const THREAD = '11111111-1111-4111-8111-111111111111';
const DSH_AGENT = 'agent-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CLI_PATH = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function threadPayload(root, overrides = {}) {
  return { schemaVersion: 1, thread: { id: THREAD, kind: 'codex', hostId: 'local', cwd: root, ...overrides }, page: {}, turns: [] };
}

const textResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function fakeCodex(root) {
  const calls = [];
  return {
    calls,
    async call(threadId, name, args) {
      calls.push({ threadId, name, args });
      if (name === 'read_thread') return textResult(threadPayload(root, { id: threadId }));
      if (name === 'send_message_to_thread') return textResult({ accepted: true });
      throw new Error(`Unexpected Codex operation: ${name}`);
    },
    notices() { return calls.filter(call => call.name === 'send_message_to_thread'); },
  };
}

function fakeDsh(items) {
  const calls = { list: [], followup: [], wait: [], archive: [] };
  const turns = new Map();
  let followup = null;
  let waitImpl = null;
  return {
    items,
    calls,
    turns,
    setFollowup(implementation) { followup = implementation; },
    setWait(implementation) { waitImpl = implementation; },
    complete(requestId, reply) {
      const turn = turns.get(requestId);
      assert.ok(turn, `Unknown native turn ${requestId}`);
      turn.state = 'completed';
      turn.reply = reply;
    },
    end(requestId, state) {
      const turn = turns.get(requestId);
      assert.ok(turn, `Unknown native turn ${requestId}`);
      turn.state = state;
    },
    async list(args) { calls.list.push(args); return { items }; },
    async followup(args) {
      calls.followup.push(args);
      if (followup) return followup(args);
      const requestId = args.requestId;
      turns.set(requestId, { state: 'running', reply: undefined, message: args.message });
      return { accepted: true, state: 'running', requestId };
    },
    async wait(args) {
      calls.wait.push(args);
      if (waitImpl) return waitImpl(args);
      const turn = turns.get(args.requestId);
      if (!turn) return { state: 'unknown', requestId: args.requestId };
      return { state: turn.state, reply: turn.reply, requestId: args.requestId };
    },
    async archive(args) {
      calls.archive.push(args);
      return { accepted: true, archive: { state: 'archived' } };
    },
  };
}

async function setup(t, { configFile } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-peer-worker-'));
  t.after(async () => {
    assert.ok(root.startsWith(tmpdir() + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await realpath(root);
  const codex = fakeCodex(workspace);
  const agents = fakeDsh([{ agentId: DSH_AGENT, workspace }]);
  const config = {
    workspace,
    stateDirectory: path.join(workspace, 'state'),
    registryDirectory: path.join(workspace, 'agents'),
    ...(configFile === undefined ? {} : { configFile }),
  };
  const workers = [];
  const peers = createPeers(config, {
    agentsFactory: () => agents,
    codexCall: (...args) => codex.call(...args),
    startWorker: async args => { workers.push(args); return process.pid; },
  });
  await peers.register({ peerId: 'codex-main', kind: 'codex-desktop', workspace, threadId: THREAD });
  await peers.register({ peerId: 'dsh-main', kind: 'dsh', workspace, agentId: DSH_AGENT });
  return { root: workspace, config, peers, codex, agents, workers };
}

const watch = (f, exchangeId, options = {}) => runPeerWatch({
  exchangeId,
  pollMs: 1,
  ...options,
}, { peers: f.peers });

test('the peer watcher stays alive while the native archive is pending and exits only when it settles', async () => {
  let pumps = 0;
  const peers = {
    pump: async () => {
      pumps += 1;
      return pumps === 1
        ? { exchangeId: 'exchange-test', state: 'completed', notification: { state: 'delivered' }, archive: { state: 'pending' } }
        : { exchangeId: 'exchange-test', state: 'completed', notification: { state: 'delivered' }, archive: { state: 'archived' } };
    },
    finishWatcher: async () => undefined,
  };
  const result = await runPeerWatch({ exchangeId: 'exchange-test', maxMinutes: 1, pollMs: 1 }, { peers, sleep: async () => undefined });
  assert.equal(pumps, 2);
  assert.equal(result.state, 'ended');
  assert.equal(result.exchange.archive.state, 'archived');
});

test('an unbound DSH completion posts one source notice and suppresses the old callback', async t => {
  const f = await setup(t);
  const parent = await f.peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'finish the report', requestId: 'auto-notice',
  });
  assert.equal(f.workers.length, 1);
  assert.ok(f.workers[0].includes('--exchange'));
  assert.equal(f.agents.calls.followup[0].suppressCallback, true);
  f.agents.complete(parent.native.requestId, 'REPORT_DONE');

  const first = await watch(f, parent.exchangeId);
  assert.equal(first.state, 'ended');
  assert.equal(f.codex.notices().length, 1);
  const notice = f.codex.notices()[0].args.prompt;
  assert.match(notice, new RegExp(parent.exchangeId));
  assert.match(notice, /State: completed/);
  assert.match(notice, /REPORT_DONE/);
  assert.match(notice, /one-way completion notice/);
  assert.match(notice, /read-exchange/);
  assert.match(notice, /--peer-id codex-main/);

  const second = await watch(f, parent.exchangeId);
  assert.equal(second.state, 'ended');
  assert.equal(f.codex.notices().length, 1, 'a delivered notice is never posted again');
});

test('a DSH source consuming a child answer does not add a continuation turn', async t => {
  const f = await setup(t);
  const parent = await f.peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'produce the report', requestId: 'parent-consume',
  });
  const child = await f.peers.send({
    fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'which format?', requestId: 'child-consume',
    parentExchangeId: parent.exchangeId,
  });
  assert.equal(child.sourceRequestId, parent.native.requestId);
  await f.peers.reply({ exchangeId: child.exchangeId, peerId: 'codex-main', message: 'Use JSON.' });
  const consumed = await f.peers.read({ exchangeId: child.exchangeId, peerId: 'dsh-main' });
  assert.equal(consumed.consumed, true);
  assert.equal(consumed.consumedVia, 'read');

  f.agents.complete(parent.native.requestId, 'ORIGINAL_DONE');
  const resumed = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(resumed.state, 'completed');
  assert.equal(resumed.reply.message, 'ORIGINAL_DONE');
  assert.equal(f.agents.calls.followup.length, 1, 'consumption must not add a followup turn');
  assert.equal(f.agents.calls.followup[0].requestId, parent.native.requestId);
});

test('a child answer resumes an awaiting parent once and the final notice carries the result', async t => {
  const f = await setup(t);
  const parent = await f.peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'produce the report with all sections', requestId: 'parent-resume',
  });
  const child = await f.peers.send({
    fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'Which format should I use?', requestId: 'child-resume',
    parentExchangeId: parent.exchangeId,
  });
  f.agents.complete(parent.native.requestId, 'PARTIAL_REPORT');
  const waiting = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(waiting.state, 'awaiting_input');
  assert.equal(waiting.reply, null);

  await f.peers.reply({ exchangeId: child.exchangeId, peerId: 'codex-main', message: 'Use JSON with sections.' });
  const continuing = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(continuing.state, 'pending');
  assert.equal(continuing.continuation.state, 'accepted');
  assert.equal(continuing.awaiting, undefined);
  assert.equal(continuing.awaitingHistory.length, 1);
  assert.match(continuing.continuation.requestId, /^peer-cont-/);
  assert.equal(continuing.native.requestId, continuing.continuation.requestId);
  assert.equal(f.agents.calls.followup.length, 2);
  const continuation = f.agents.calls.followup[1];
  assert.equal(continuation.suppressCallback, true);
  assert.match(continuation.message, /produce the report with all sections/);
  assert.match(continuation.message, /Use JSON with sections\./);
  assert.match(continuation.message, /do not merely acknowledge/i);
  assert.equal(f.agents.calls.followup.filter(call => call.requestId === continuation.requestId).length, 1);

  const childAfter = JSON.parse(await readFile(path.join(f.root, 'peers', 'exchanges', child.exchangeId, 'exchange.json'), 'utf8'));
  assert.equal(childAfter.consumed.via, 'continuation');
  assert.equal(childAfter.notification.state, 'skipped');

  f.agents.complete(continuing.native.requestId, 'CONTINUED_FINAL_REPORT');
  const done = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(done.state, 'completed');
  assert.equal(done.reply.message, 'CONTINUED_FINAL_REPORT');
  const notice = f.codex.notices().at(-1).args.prompt;
  assert.match(notice, new RegExp(parent.exchangeId));
  assert.match(notice, /State: completed/);
  assert.match(notice, /CONTINUED_FINAL_REPORT/);
  assert.equal(f.agents.calls.followup.filter(call => call.requestId.startsWith('peer-cont-')).length, 1);

  const again = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(again.state, 'completed');
  assert.equal(f.agents.calls.followup.filter(call => call.requestId.startsWith('peer-cont-')).length, 1);
});

test('a late result from the pre-question turn cannot overwrite the continuation', async t => {
  const f = await setup(t);
  const parent = await f.peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'wait for the value', requestId: 'late-parent',
  });
  const original = parent.native.requestId;
  const child = await f.peers.send({
    fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'which value?', requestId: 'late-child',
    parentExchangeId: parent.exchangeId,
  });
  await f.peers.reply({ exchangeId: child.exchangeId, peerId: 'codex-main', message: 'VALUE-9' });

  let release;
  let started;
  let held = false;
  const gate = new Promise(resolve => { release = resolve; });
  const waitStarted = new Promise(resolve => { started = resolve; });
  f.agents.setWait(async args => {
    if (!held && args.requestId === original) {
      held = true;
      started();
      await gate;
      return { state: 'completed', reply: 'STALE_ORIGINAL', requestId: original };
    }
    const turn = f.agents.turns.get(args.requestId);
    return turn
      ? { state: turn.state, reply: turn.reply, requestId: args.requestId }
      : { state: 'unknown', requestId: args.requestId };
  });

  const reading = f.peers.read({ exchangeId: parent.exchangeId, timeoutSeconds: 0.4 });
  await waitStarted;
  f.agents.complete(original, 'ORIGINAL_ENDED');
  const continuing = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(continuing.state, 'pending');
  assert.match(continuing.continuation.requestId, /^peer-cont-/);
  release();

  const late = await reading;
  assert.notEqual(late.state, 'completed');
  assert.notEqual(late.reply?.message, 'STALE_ORIGINAL');
  assert.equal(f.agents.calls.followup.filter(call => call.requestId.startsWith('peer-cont-')).length, 1);
});

test('a second child answer starts a new continuation instead of being blocked by the first', async t => {
  const f = await setup(t);
  const parent = await f.peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'complete both sections', requestId: 'sequential-parent',
  });
  const first = await f.peers.send({
    fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'first value?', requestId: 'sequential-first',
    parentExchangeId: parent.exchangeId,
  });
  await f.peers.reply({ exchangeId: first.exchangeId, peerId: 'codex-main', message: 'FIRST_VALUE' });
  f.agents.complete(parent.native.requestId, 'FIRST_TURN_END');
  const continuationOne = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(continuationOne.state, 'pending');
  const firstRequest = continuationOne.continuation.requestId;

  const second = await f.peers.send({
    fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'second value?', requestId: 'sequential-second',
    parentExchangeId: parent.exchangeId,
  });
  await f.peers.reply({ exchangeId: second.exchangeId, peerId: 'codex-main', message: 'SECOND_VALUE' });
  f.agents.complete(firstRequest, 'FIRST_CONTINUATION_END');
  const continuationTwo = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(continuationTwo.state, 'pending');
  assert.match(continuationTwo.continuation.requestId, /^peer-cont-/);
  assert.notEqual(continuationTwo.continuation.requestId, firstRequest);
  assert.equal(continuationTwo.continuationHistory.length, 1);
  assert.equal(continuationTwo.continuationHistory[0].requestId, firstRequest);
  assert.equal(f.agents.calls.followup.length, 3);
  assert.match(f.agents.calls.followup[2].message, /second value\?/);
  assert.match(f.agents.calls.followup[2].message, /SECOND_VALUE/);
  assert.equal(f.agents.calls.followup.filter(call => call.requestId === firstRequest).length, 1);

  f.agents.complete(continuationTwo.native.requestId, 'SECOND_CONTINUATION_DONE');
  const final = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(final.state, 'completed');
  assert.equal(final.reply.message, 'SECOND_CONTINUATION_DONE');
  assert.equal(f.agents.calls.followup.filter(call => call.requestId.startsWith('peer-cont-')).length, 2);
});

test('a failed child is consumed by the continuation instead of blocking the parent', async t => {
  const f = await setup(t);
  const parent = await f.peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'continue despite a failed child', requestId: 'failed-child-parent',
  });
  const child = await f.peers.send({
    fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'optional detail?', requestId: 'failed-child',
    parentExchangeId: parent.exchangeId,
  });
  f.agents.complete(parent.native.requestId, 'ORIGINAL_WAITING');
  await f.peers.pump({ exchangeId: parent.exchangeId });
  const file = path.join(f.root, 'peers', 'exchanges', child.exchangeId, 'exchange.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.state = 'failed';
  record.reply = null;
  record.delivery = { ...record.delivery, state: 'failed', accepted: true };
  await writeFile(file, JSON.stringify(record, null, 2) + '\n');

  const continuing = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(continuing.state, 'pending');
  assert.equal(continuing.continuation.state, 'accepted');
  assert.match(f.agents.calls.followup.at(-1).message, /terminal state failed/);
  const childAfter = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(childAfter.consumed.via, 'continuation');

  f.agents.complete(continuing.native.requestId, 'DONE_AFTER_FAILED_CHILD');
  const final = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(final.state, 'completed');
  assert.equal(final.reply.message, 'DONE_AFTER_FAILED_CHILD');
});

test('an explicitly rejected continuation reports a failed notice to the source', async t => {
  const f = await setup(t);
  const parent = await f.peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'continue the task', requestId: 'reject-cont-parent',
  });
  const child = await f.peers.send({
    fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'value?', requestId: 'reject-cont-child',
    parentExchangeId: parent.exchangeId,
  });
  await f.peers.reply({ exchangeId: child.exchangeId, peerId: 'codex-main', message: 'VALUE' });
  f.agents.complete(parent.native.requestId, 'WAITING');
  f.agents.setFollowup(async args => {
    assert.match(args.requestId, /^peer-cont-/);
    return { accepted: false, state: 'rejected' };
  });
  const failed = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.continuation.state, 'failed');
  assert.equal(failed.notification.state, 'delivered');
  const notice = f.codex.notices().at(-1).args.prompt;
  assert.match(notice, /State: failed/);
  assert.ok(notice.includes(`Continuation requestId: ${failed.continuation.requestId}`));
  assert.match(notice, /did not resume/);
  const count = f.agents.calls.followup.length;
  await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(f.agents.calls.followup.length, count);
  assert.equal(f.codex.notices().filter(item => item.args.prompt.includes('State: failed')).length, 1);
});

test('an unconfirmed continuation is reported as unknown without resending and can be read-only confirmed', async t => {
  const f = await setup(t);
  const parent = await f.peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'continue despite uncertainty', requestId: 'unknown-cont-parent',
  });
  const child = await f.peers.send({
    fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'value?', requestId: 'unknown-cont-child',
    parentExchangeId: parent.exchangeId,
  });
  await f.peers.reply({ exchangeId: child.exchangeId, peerId: 'codex-main', message: 'VALUE-U' });
  f.agents.complete(parent.native.requestId, 'WAITING-U');
  f.agents.setFollowup(async () => { throw new Error('continuation response lost'); });
  const unknown = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.continuation.state, 'unknown');
  assert.equal(unknown.notification.state, 'delivered');
  assert.equal(unknown.native.requestId, unknown.continuation.requestId);
  const notice = f.codex.notices().at(-1).args.prompt;
  assert.match(notice, /State: unknown/);
  assert.ok(notice.includes(`Continuation requestId: ${unknown.native.requestId}`));
  assert.match(notice, /Do not resend/);
  const followups = f.agents.calls.followup.length;
  const notices = f.codex.notices().length;
  await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(f.agents.calls.followup.length, followups, 'unknown is never resent');
  assert.equal(f.codex.notices().length, notices, 'a delivered unknown notice is never resent');

  // A native read-only confirmation is allowed; this represents agents.collect proving the exact
  // request-id turn after the facade reports the turn exists.
  const continuationRequest = unknown.native.requestId;
  f.agents.setWait(async args => {
    if (args.requestId === continuationRequest) {
      return { state: 'completed', reply: 'RECOVERED_UNKNOWN_CONTINUATION', requestId: continuationRequest };
    }
    const turn = f.agents.turns.get(args.requestId);
    return turn
      ? { state: turn.state, reply: turn.reply, requestId: args.requestId }
      : { state: 'unknown', requestId: args.requestId };
  });
  const recovered = await f.peers.pump({ exchangeId: parent.exchangeId });
  assert.equal(recovered.state, 'completed');
  assert.equal(recovered.reply.message, 'RECOVERED_UNKNOWN_CONTINUATION');
  assert.equal(recovered.notification.state, 'delivered');
  assert.equal(f.agents.calls.followup.length, followups, 'read-only confirmation adds no turn');
  const childAfter = JSON.parse(await readFile(path.join(f.root, 'peers', 'exchanges', child.exchangeId, 'exchange.json'), 'utf8'));
  assert.equal(childAfter.consumed.via, 'continuation');
});

test('concurrent workers post one notice; busy stays pending; unknown is never retried', async t => {
  const f = await setup(t);
  const first = await f.peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'race', requestId: 'worker-race',
  });
  f.agents.complete(first.native.requestId, 'RACE_DONE');
  const [left, right] = await Promise.all([watch(f, first.exchangeId), watch(f, first.exchangeId)]);
  assert.equal(left.state, 'ended');
  assert.equal(right.state, 'ended');
  assert.equal(f.codex.notices().length, 1);

  const busy = await f.peers.send({
    fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'busy notice', requestId: 'busy-notice',
  });
  await f.peers.reply({ exchangeId: busy.exchangeId, peerId: 'codex-main', message: 'busy answer' });
  let noticeCalls = f.agents.calls.followup.length;
  f.agents.setFollowup(async args => {
    assert.match(args.requestId, /^peer-notice-/);
    return { accepted: false, state: 'busy' };
  });
  const pending = await f.peers.pump({ exchangeId: busy.exchangeId });
  assert.equal(pending.state, 'completed');
  assert.equal(pending.notification.state, 'pending');
  assert.equal(f.agents.calls.followup.length, noticeCalls + 1);

  f.agents.setFollowup(async args => ({ accepted: true, state: 'running', requestId: args.requestId }));
  const delivered = await f.peers.pump({ exchangeId: busy.exchangeId });
  assert.equal(delivered.notification.state, 'delivered');
  assert.equal(f.agents.calls.followup.length, noticeCalls + 2);

  const unknown = await f.peers.send({
    fromPeerId: 'dsh-main', toPeerId: 'codex-main', message: 'unknown notice', requestId: 'unknown-notice',
  });
  await f.peers.reply({ exchangeId: unknown.exchangeId, peerId: 'codex-main', message: 'unknown answer' });
  noticeCalls = f.agents.calls.followup.length;
  f.agents.setFollowup(async () => { throw new Error('notice transport lost'); });
  const lost = await f.peers.pump({ exchangeId: unknown.exchangeId });
  assert.equal(lost.notification.state, 'unknown');
  const again = await f.peers.pump({ exchangeId: unknown.exchangeId });
  assert.equal(again.notification.state, 'unknown');
  assert.equal(f.agents.calls.followup.length, noticeCalls + 1);
});

test('failed and cancelled turns remain terminal in the source notice', async t => {
  const f = await setup(t);
  const failed = await f.peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'fail', requestId: 'terminal-fail',
  });
  f.agents.end(failed.native.requestId, 'failed');
  const failedResult = await f.peers.pump({ exchangeId: failed.exchangeId });
  assert.equal(failedResult.state, 'failed');
  assert.equal(failedResult.notification.state, 'delivered');
  assert.match(f.codex.notices().at(-1).args.prompt, /State: failed/);

  const cancelled = await f.peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'cancel', requestId: 'terminal-cancel',
  });
  f.agents.end(cancelled.native.requestId, 'cancelled');
  const cancelledResult = await f.peers.pump({ exchangeId: cancelled.exchangeId });
  assert.equal(cancelledResult.state, 'cancelled');
  assert.match(f.codex.notices().at(-1).args.prompt, /State: cancelled/);
  assert.equal(f.codex.notices().length, 2);
});

test('watcher PID dedup survives duplicate sends and recovers a dead watcher', async t => {
  const f = await setup(t);
  const input = { fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: 'pending', requestId: 'watch-pid' };
  const sent = await f.peers.send(input);
  assert.equal(f.workers.length, 1);
  const duplicate = await f.peers.send(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.workers.length, 1, 'a live watcher is reused');

  const watchFile = path.join(f.root, 'peers', 'watchers', `${sent.exchangeId}.json`);
  const watcher = JSON.parse(await readFile(watchFile, 'utf8'));
  watcher.pid = 2147483647;
  await writeFile(watchFile, JSON.stringify(watcher));
  await f.peers.send(input);
  assert.equal(f.workers.length, 2, 'a dead watcher is restarted by a duplicate send');

  const nonce = JSON.parse(await readFile(watchFile, 'utf8')).nonce;
  f.agents.complete(sent.native.requestId, 'WATCH_DONE');
  const finished = await watch(f, sent.exchangeId, { nonce });
  assert.equal(finished.state, 'ended');
  assert.equal((await f.peers.watcherStatus(sent.exchangeId)).state, 'ended');
});

test('a mailbox source notice is written once by the watcher and never pushed as a turn', async t => {
  const f = await setup(t);
  await f.peers.register({ peerId: 'claude-main', kind: 'mailbox', workspace: f.root });
  const sent = await f.peers.send({
    fromPeerId: 'claude-main', toPeerId: 'codex-main', message: 'review the plan', requestId: 'mailbox-watch',
  });
  await f.peers.reply({ exchangeId: sent.exchangeId, peerId: 'codex-main', message: 'PLAN_APPROVED' });
  assert.equal(f.agents.calls.followup.length, 0);

  const first = await watch(f, sent.exchangeId);
  assert.equal(first.state, 'ended');
  assert.equal(first.notification.state, 'delivered');
  assert.equal(f.agents.calls.followup.length, 0, 'the mailbox path must not resume any agent');
  assert.equal(f.codex.notices().length, 1, 'only the original question was posted to the chat');

  const file = path.join(f.root, 'peers', 'mailbox', 'claude-main', `${sent.exchangeId}.json`);
  const notice = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(notice.exchangeId, sent.exchangeId);
  assert.equal(notice.state, 'completed');
  assert.match(notice.text, /PLAN_APPROVED/);

  const second = await watch(f, sent.exchangeId);
  assert.equal(second.state, 'ended');
  const again = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(again.createdAt, notice.createdAt, 'a delivered mailbox notice is never rewritten');
  assert.equal(f.agents.calls.followup.length, 0);
});

test('custom config and a Unicode path are preserved in prompts and worker args', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-peer-config-'));
  t.after(async () => {
    assert.ok(root.startsWith(tmpdir() + path.sep));
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await realpath(root);
  const configDirectory = path.join(workspace, '配置 根');
  await mkdir(configDirectory);
  const configFile = path.join(configDirectory, 'config.json');
  await writeFile(configFile, JSON.stringify({ workspace }));
  const codex = fakeCodex(workspace);
  const agents = fakeDsh([{ agentId: DSH_AGENT, workspace }]);
  const config = {
    workspace,
    stateDirectory: path.join(workspace, 'state'),
    registryDirectory: path.join(workspace, 'agents'),
    configFile,
  };
  const workers = [];
  const peers = createPeers(config, {
    agentsFactory: () => agents,
    codexCall: (...args) => codex.call(...args),
    startWorker: async args => { workers.push(args); return process.pid; },
  });
  await peers.register({ peerId: 'codex-main', kind: 'codex-desktop', workspace, threadId: THREAD });
  await peers.register({ peerId: 'dsh-main', kind: 'dsh', workspace, agentId: DSH_AGENT });
  const sent = await peers.send({
    fromPeerId: 'codex-main', toPeerId: 'dsh-main', message: '配置任务', requestId: 'unicode-config',
  });
  assert.ok(workers[0].includes('--config'));
  assert.equal(workers[0][workers[0].indexOf('--config') + 1], configFile);
  const delivery = agents.calls.followup[0].message;
  assert.ok(delivery.includes(`--config "${configFile}"`));
  assert.ok(delivery.includes('--parent-exchange-id'));
  assert.ok(delivery.includes('--peer-id dsh-main'));
  assert.ok(delivery.includes('--message-file'));

  agents.complete(sent.native.requestId, '配置完成');
  await watch({ peers }, sent.exchangeId);
  const notice = codex.notices().at(-1).args.prompt;
  assert.ok(notice.includes(`--config "${configFile}"`));
  assert.ok(notice.includes('--peer-id codex-main'));
  assert.ok(notice.includes('配置完成'));
  assert.ok(CLI_PATH.includes('cli.mjs'));
});
