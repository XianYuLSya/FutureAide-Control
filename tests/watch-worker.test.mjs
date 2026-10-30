import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { notificationSummary, runWatchWorker, workerArguments, writeReportFile } from '../src/watch-worker.mjs';
import { notifyCodex } from '../src/codex-notify.mjs';

const THREAD = '11111111-1111-4111-8111-111111111111';
const OTHER_THREAD = '22222222-2222-4222-8222-222222222222';
const AGENT = 'agent-0123456789abcdef0123456789abcdef';
const SESSION = 'session-1';
const REQUEST = 'req-1';
const event = (seq, type, data = {}) => ({ type: 'event', event: { seq, type, data } });

/** A host fixture whose dispatch ends on the requested poll with the requested native reason. */
function host({ root, polls = 1, ending = true, running, reason = { kind: 'completed' } }) {
  const base = [event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { source: { rpcId: REQUEST }, content: [{ type: 'text', text: 'work' }] })];
  const finished = [...base,
    event(3, 'assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: 'reply done' }] } }),
    event(4, 'turn/end', { turn: 1, reason })];
  let reads = 0;
  return {
    reads: () => reads,
    client: {
      listSessions: async () => ({ items: [{ sessionId: SESSION, cwd: root, running: running ?? !ending, projections: { asOfSeq: 4 } }] }),
      readSession: async () => {
        reads += 1;
        return { records: reads < polls || !ending ? base : finished, hasMore: false };
      },
    },
  };
}

async function fixture(t, { configured = true, target = THREAD, polls = 1, ending = true, running, reason, maxMinutes = 0, notify, report, autoArchive = false, archive } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, 'state');
  const fake = host({ root, polls, ending, ...(running === undefined ? {} : { running }), ...(reason ? { reason } : {}) });
  const calls = [];
  const notifier = notify ?? (async (config, input) => { calls.push({ config, input }); return { delivered: true }; });
  const archives = [];
  fake.client.archiveSession = async sessionId => {
    archives.push(sessionId);
    return archive ? archive(sessionId) : { accepted: true, archivedSessionIds: [sessionId] };
  };
  const options = { workspace: root, stateDirectory, sessionId: SESSION, requestId: REQUEST, afterSeq: 0,
    agentId: AGENT, codexThreadId: configured ? target : undefined, pollMs: 1, maxMinutes, autoArchive };
  const result = await runWatchWorker(options, { client: fake.client, notify: notifier, ...(report ? { report } : {}) });
  const reportFile = path.join(stateDirectory, 'reports', `${SESSION}.${REQUEST}.json`);
  return { root, stateDirectory, reportFile, calls, archives, result, reads: fake.reads, options,
    report: JSON.parse(await readFile(reportFile, 'utf8')) };
}

const assistantTexts = report => report.messages.filter(message => message.role === 'assistant').map(message => message.text);

test('the completion report is stored before the callback and never depends on it', async t => {
  const order = [];
  let captured;
  const f = await fixture(t, {
    report: async (file, payload) => { order.push('report:' + payload.state); await writeReportFile(file, payload); },
    notify: async (config, input) => { order.push('notify'); captured = input; return { delivered: true }; },
  });
  assert.deepEqual(order, ['report:ended', 'notify', 'report:ended']);
  assert.equal(captured.event, 'completed');
  assert.match(captured.summary, /^state: completed$/m);
  assert.match(captured.summary, /^后台监视：派单回合已结束，完成报告已落盘。$/m);
  assert.doesNotMatch(captured.summary, /到达监视期限/);
  assert.match(captured.summary, new RegExp(`agentId: ${AGENT}`));
  assert.match(captured.summary, new RegExp(`sessionId: ${SESSION}`));
  assert.match(captured.summary, new RegExp(`requestId: ${REQUEST}`));
  assert.match(captured.summary, /reportFile: .+session-1\.req-1\.json/);
  assert.match(captured.summary, /reply done/);
  assert.doesNotMatch(captured.summary, /\d{4}-\d{2}-\d{2}T/);
  assert.equal(f.report.state, 'ended');
  assert.equal(f.report.terminalState, 'completed');
  assert.deepEqual(assistantTexts(f.report), ['reply done']);
  assert.equal(f.report.agentId, AGENT);
  assert.equal(f.report.notification.status, 'delivered');
  assert.equal(f.result.reportUpdateStored, true);
  assert.equal(f.result.state, 'ended');
});

test('a failed turn keeps its report and reason but is notified as blocked, not completed', async t => {
  const reason = { kind: 'error', message: 'tool crashed' };
  const f = await fixture(t, { reason });
  assert.equal(f.result.state, 'ended');
  assert.equal(f.report.state, 'ended');
  assert.equal(f.report.terminalState, 'failed');
  assert.deepEqual(f.report.completionReason, reason);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].input.event, 'blocked');
  assert.match(f.calls[0].input.summary, /终态为 failed/);
  assert.match(f.calls[0].input.summary, /^state: failed \(reason error\)$/m);
  assert.doesNotMatch(f.calls[0].input.summary, /到达监视期限|派单回合已结束，完成报告已落盘/);
  assert.deepEqual(assistantTexts(f.report), ['reply done']);
});

test('a cancelled turn keeps its report and reason but is notified as blocked, not completed', async t => {
  const reason = { kind: 'aborted', reason: { kind: 'user' } };
  const f = await fixture(t, { reason });
  assert.equal(f.result.state, 'ended');
  assert.equal(f.report.state, 'ended');
  assert.equal(f.report.terminalState, 'cancelled');
  assert.deepEqual(f.report.completionReason, reason);
  assert.equal(f.calls[0].input.event, 'blocked');
  assert.match(f.calls[0].input.summary, /终态为 cancelled/);
  assert.match(f.calls[0].input.summary, /^state: cancelled \(reason aborted\)$/m);
  assert.doesNotMatch(f.calls[0].input.summary, /到达监视期限/);
});

test('a late completion is still recorded as ended, never as a passed deadline', async t => {
  const f = await fixture(t, { polls: 3, maxMinutes: 1 });
  assert.equal(f.reads(), 3);
  assert.equal(f.result.state, 'ended');
  assert.equal(f.report.state, 'ended');
  assert.equal(f.report.endSeq, 4);
  assert.equal(f.calls[0].input.event, 'completed');
  assert.deepEqual(assistantTexts(f.report), ['reply done']);
});

test('a later watch run never replaces a stored completion with a timeout', async t => {
  const first = await fixture(t);
  assert.equal(first.report.state, 'ended');
  // Same dispatch, same report file, but the host no longer shows the ended turn: a restart, a
  // pruned page or a repeated send with the same request_id can produce exactly this second worker.
  const stale = host({ root: first.root, ending: false });
  const calls = [];
  const second = await runWatchWorker(first.options, { client: stale.client,
    notify: async (config, input) => { calls.push(input); return { delivered: true }; } });
  assert.equal(second.state, 'ended');
  assert.equal(second.timeoutSuppressed, true);
  assert.equal(second.sessionId, SESSION);
  assert.equal(calls.length, 0);
  const stored = JSON.parse(await readFile(first.reportFile, 'utf8'));
  assert.equal(stored.state, 'ended');
  assert.deepEqual(assistantTexts(stored), ['reply done']);
  assert.equal(stored.notification.status, 'delivered');
});

test('a stored completion without a delivery record still gets its one notice', async t => {
  // Simulates a first worker that stored the completion and then died before recording delivery:
  // the report on disk has state ended but no notification field.
  const first = await fixture(t, {
    notify: async () => { throw new Error('process died before delivery was recorded'); },
    report: async (file, payload) => { if (!payload.notification) await writeReportFile(file, payload); },
  });
  assert.equal(first.report.state, 'ended');
  assert.equal(first.report.notification, undefined);

  const stale = host({ root: first.root, ending: false });
  const calls = [];
  const second = await runWatchWorker(first.options, { client: stale.client,
    notify: async (config, input) => { calls.push(input); return { delivered: true }; } });
  assert.equal(second.state, 'ended');
  assert.equal(second.timeoutSuppressed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'completed');
  assert.match(calls[0].summary, /^state: completed$/m);
  const stored = JSON.parse(await readFile(first.reportFile, 'utf8'));
  assert.equal(stored.state, 'ended');
  assert.equal(stored.notification.status, 'delivered');
  assert.deepEqual(assistantTexts(stored), ['reply done']);
});

test('the missing-notice retry still cannot post twice through the real notifier', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-worker-once-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, 'state');
  let sent = 0;
  const notify = (config, input) => notifyCodex(config, input, { callTool: async () => { sent += 1; } });
  const options = { workspace: root, stateDirectory, sessionId: SESSION, requestId: REQUEST, afterSeq: 0,
    agentId: AGENT, codexThreadId: THREAD, pollMs: 1, maxMinutes: 0 };
  // The first worker delivers, but its process dies before recording that in the report.
  await runWatchWorker(options, { client: host({ root }).client, notify,
    report: async (file, payload) => { if (!payload.notification) await writeReportFile(file, payload); } });
  assert.equal(sent, 1);
  const stored = JSON.parse(await readFile(path.join(stateDirectory, 'reports', `${SESSION}.${REQUEST}.json`), 'utf8'));
  assert.equal(stored.state, 'ended');
  assert.equal(stored.notification, undefined);

  // The later watch run finds the completion, has no delivery record and retries the notice once.
  const second = await runWatchWorker(options, { client: host({ root, ending: false }).client, notify });
  assert.equal(sent, 1);
  assert.equal(second.state, 'ended');
  assert.equal(second.timeoutSuppressed, true);
  assert.equal(second.notification.status, 'delivered');
  assert.equal(second.notification.duplicate, true);
});

test('the retry cannot be pushed into a second delivery by a changed identity or target', async t => {
  const setup = async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh-worker-identity-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const stateDirectory = path.join(root, 'state');
    const sent = [];
    const notify = (config, input) => notifyCodex(config, input, { callTool: async threadId => { sent.push(threadId); } });
    const options = { workspace: root, stateDirectory, sessionId: SESSION, requestId: REQUEST, afterSeq: 0,
      agentId: AGENT, codexThreadId: THREAD, pollMs: 1, maxMinutes: 0 };
    await runWatchWorker(options, { client: host({ root }).client, notify,
      report: async (file, payload) => { if (!payload.notification) await writeReportFile(file, payload); } });
    assert.equal(sent.length, 1);
    return { root, notify, options, sent };
  };

  // A later run that names no agent must still dedupe against the notice the first run posted.
  const withoutAgent = await setup();
  const second = await runWatchWorker({ ...withoutAgent.options, agentId: undefined },
    { client: host({ root: withoutAgent.root, ending: false }).client, notify: withoutAgent.notify });
  assert.equal(withoutAgent.sent.length, 1);
  assert.equal(second.state, 'ended');
  assert.equal(second.notification.status, 'delivered');
  assert.equal(second.notification.duplicate, true);

  // A later run bound to a different chat posts nothing for another chat's dispatch.
  const otherTarget = await setup();
  const third = await runWatchWorker({ ...otherTarget.options, codexThreadId: OTHER_THREAD },
    { client: host({ root: otherTarget.root, ending: false }).client, notify: otherTarget.notify });
  assert.equal(otherTarget.sent.length, 1);
  assert.equal(third.state, 'ended');
  assert.equal(third.timeoutSuppressed, true);
  assert.equal(third.notification, undefined);
  assert.deepEqual(assistantTexts(third), ['reply done']);
});

test('a completion that arrives after a stored timeout still upgrades the report', async t => {
  const timedOut = await fixture(t, { ending: false });
  assert.equal(timedOut.report.state, 'timeout');
  const later = host({ root: timedOut.root, polls: 2, ending: true });
  const calls = [];
  const result = await runWatchWorker({ ...timedOut.options, maxMinutes: 1 }, { client: later.client,
    notify: async (config, input) => { calls.push(input); return { delivered: true }; } });
  assert.equal(result.state, 'ended');
  assert.equal(result.terminalState, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, 'completed');
  const stored = JSON.parse(await readFile(timedOut.reportFile, 'utf8'));
  assert.equal(stored.state, 'ended');
  assert.deepEqual(assistantTexts(stored), ['reply done']);
});

test('a stored completion with a missing, nonnumeric or different baseline cannot suppress this timeout', async t => {
  for (const afterSeq of [undefined, '0', 1]) {
    const first = await fixture(t);
    await writeReportFile(first.reportFile, { ...first.report, afterSeq });
    const calls = [];
    const result = await runWatchWorker(first.options, { client: host({ root: first.root, ending: false }).client,
      notify: async (config, input) => { calls.push(input); return { delivered: true }; } });
    assert.equal(result.state, 'timeout');
    assert.equal(result.timeoutSuppressed, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].event, 'blocked');
    assert.match(calls[0].summary, /^state: timeout$/m);
    // This run reports its own timeout, but the other baseline's completion is never destroyed.
    const kept = JSON.parse(await readFile(first.reportFile, 'utf8'));
    assert.equal(kept.state, 'ended');
    assert.deepEqual(assistantTexts(kept), ['reply done']);
  }
});

test('a repeated run reuses the existing receipt instead of posting a second notice', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-worker-once-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = path.join(root, 'state');
  let delivered = 0;
  const notify = (config, input) => notifyCodex(config, input, { callTool: async (threadId, name, args) => {
    delivered += 1;
    assert.equal(threadId, THREAD);
    assert.equal(name, 'send_message_to_thread');
    assert.match(args.prompt, /req-1/);
  } });
  const options = { workspace: root, stateDirectory, sessionId: SESSION, requestId: REQUEST, afterSeq: 0,
    agentId: AGENT, codexThreadId: THREAD, pollMs: 1, maxMinutes: 0 };
  const first = await runWatchWorker(options, { client: host({ root }).client, notify });
  const second = await runWatchWorker(options, { client: host({ root }).client, notify });
  assert.equal(delivered, 1);
  assert.equal(first.notification.status, 'delivered');
  assert.equal(second.notification.status, 'delivered');
  assert.equal(second.notification.duplicate, true);
  const stored = JSON.parse(await readFile(path.join(stateDirectory, 'reports', `${SESSION}.${REQUEST}.json`), 'utf8'));
  assert.equal(stored.state, 'ended');
  assert.equal(stored.notification.status, 'delivered');
});

test('a past deadline stores a timeout report and reports blocked, not a failed task', async t => {
  const f = await fixture(t, { ending: false });
  assert.equal(f.result.state, 'timeout');
  assert.equal(f.report.state, 'timeout');
  assert.match(f.report.note, /not a task failure/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].input.event, 'blocked');
  assert.match(f.calls[0].input.summary, /agentId: /);
  assert.match(f.calls[0].input.summary, /^后台监视：到达监视期限，任务是否结束仍未确认。$/m);
  assert.match(f.calls[0].input.summary, /^state: timeout$/m);
  assert.doesNotMatch(f.calls[0].input.summary, /终态为/);
  assert.equal(f.report.notification.status, 'delivered');
});

test('a failed notice keeps the completion report and cannot fall through to a timeout', async t => {
  const f = await fixture(t, { notify: async () => { throw new Error('Notification delivery is unconfirmed; it will not be retried automatically. Receipt: C:/private/notifications/key.json'); } });
  assert.equal(f.result.state, 'ended');
  assert.equal(f.reads(), 1);
  assert.equal(f.report.state, 'ended');
  assert.equal(f.report.notification.status, 'unknown');
  assert.match(f.report.notification.error, /unconfirmed/);
  assert.match(f.report.notification.receipt, /key\.json$/);
  assert.deepEqual(assistantTexts(f.report), ['reply done']);
});

test('a duplicate notice is recorded honestly without resending anything', async t => {
  const confirmed = await fixture(t, { notify: async () => ({ duplicate: true, delivered: true, status: 'accepted', receipt: 'C:/private/notifications/key.json' }) });
  assert.equal(confirmed.report.state, 'ended');
  assert.equal(confirmed.report.notification.status, 'delivered');
  assert.equal(confirmed.report.notification.duplicate, true);

  const unconfirmed = await fixture(t, { notify: async () => ({ duplicate: true, delivered: false, status: 'sending', receipt: 'C:/private/notifications/key.json' }) });
  assert.equal(unconfirmed.report.state, 'ended');
  assert.equal(unconfirmed.report.notification.status, 'unknown');
  assert.equal(unconfirmed.report.notification.duplicate, true);
  assert.match(unconfirmed.report.notification.receipt, /key\.json$/);
  assert.deepEqual(assistantTexts(unconfirmed.report), ['reply done']);
});

test('an unconfigured or invalid target is recorded without posting anything', async t => {
  const unbound = await fixture(t, { configured: false });
  assert.equal(unbound.report.state, 'ended');
  assert.equal(unbound.report.notification.status, 'not_configured');
  assert.equal(unbound.calls.length, 0);

  const invalid = await fixture(t, { target: 'not-a-task-id' });
  assert.equal(invalid.report.state, 'ended');
  assert.equal(invalid.report.notification.status, 'error');
  assert.match(invalid.report.notification.error, /not a valid UUID/);
  assert.equal(invalid.calls.length, 0);
});

test('worker arguments keep a task name that begins with dashes and parse the bare archive flag', () => {
  const args = workerArguments(['node', 'worker.mjs', '--workspace', 'C:/w', '--task-name', '--odd-name',
    '--auto-archive', '--session', 's', '--codex-thread-id', THREAD]);
  assert.equal(args.get('workspace'), 'C:/w');
  assert.equal(args.get('task-name'), '--odd-name');
  assert.equal(args.get('auto-archive'), true);
  assert.equal(args.get('session'), 's');
  assert.equal(args.get('codex-thread-id'), THREAD);
});

test('the notification summary names the terminal state without any timestamp', () => {
  const completed = notificationSummary({ agentId: AGENT, sessionId: SESSION, requestId: REQUEST, reportFile: 'C:/private/report.json', event: 'completed', state: 'completed', reason: 'completed', reply: 'final answer' });
  assert.equal(completed, notificationSummary({ agentId: AGENT, sessionId: SESSION, requestId: REQUEST, reportFile: 'C:/private/report.json', event: 'completed', state: 'completed', reason: 'completed', reply: 'final answer' }));
  assert.equal(completed.split('\n').length, 8);
  assert.match(completed, /^state: completed$/m);
  assert.match(completed, /最终结果/);
  assert.match(completed, /final answer/);
  assert.doesNotMatch(completed, /\d{4}-\d{2}-\d{2}T/);
  const failed = notificationSummary({ sessionId: SESSION, requestId: REQUEST, reportFile: 'f', event: 'blocked', state: 'failed', reason: 'error' });
  assert.match(failed, /^state: failed \(reason error\)$/m);
  assert.match(failed, /终态为 failed/);
  assert.doesNotMatch(failed, /到达监视期限|完成报告已落盘/);
  assert.match(failed, /没有可用的 assistant 文本/);
  const cancelled = notificationSummary({ sessionId: SESSION, requestId: REQUEST, reportFile: 'f', event: 'blocked', state: 'cancelled' });
  assert.match(cancelled, /^state: cancelled$/m);
  const timeout = notificationSummary({ sessionId: SESSION, requestId: REQUEST, reportFile: 'f', event: 'blocked', state: 'timeout' });
  assert.match(timeout, /^state: timeout$/m);
  assert.match(timeout, /到达监视期限/);
  assert.doesNotMatch(timeout, /终态为|完成报告已落盘/);
  const fallback = notificationSummary({ sessionId: SESSION, requestId: REQUEST, reportFile: 'f', event: 'blocked' });
  assert.match(fallback, /^agentId: .+$/m);
  assert.doesNotMatch(fallback, new RegExp(AGENT));
});

test('the callback summary carries this turn\'s exact final answer and truncates long text before the 4000 limit', () => {
  const long = 'A'.repeat(5000);
  const summary = notificationSummary({ agentId: AGENT, taskName: 'Task one', workspace: 'C:/project', taskDirectory: 'C:/project/sub',
    sessionId: SESSION, requestId: REQUEST, reportFile: 'C:/private/report.json', event: 'completed', state: 'completed', reply: long });
  assert.ok(summary.length <= 4000);
  assert.match(summary, /taskName: Task one/);
  assert.match(summary, /project: C:\/project/);
  assert.match(summary, /taskDirectory: C:\/project\/sub/);
  assert.match(summary, /reportFile: C:\/private\/report\.json/);
  assert.match(summary, /已截断/);
  assert.ok(summary.includes('A'.repeat(100)));
  assert.doesNotMatch(summary, /\d{4}-\d{2}-\d{2}T/);
  const exact = notificationSummary({ sessionId: SESSION, requestId: REQUEST, reportFile: 'r', event: 'completed', state: 'completed', reply: 'exact final words' });
  assert.match(exact, /exact final words/);
  assert.doesNotMatch(exact, /已截断/);
});

test('an ended turn in a still-running session is not archived when a followup already started', async t => {
  const f = await fixture(t, { autoArchive: true, running: true });
  assert.equal(f.result.state, 'ended');
  assert.equal(f.report.terminalState, 'completed');
  assert.equal(f.report.running, true);
  assert.equal(f.report.archive.state, 'skipped');
  assert.match(f.report.archive.reason, /still running/);
  assert.deepEqual(f.archives, []);
  assert.equal(f.report.notification.status, 'delivered');
});

test('a completed agent session is archived only after the full report is stored, then the notice is posted', async t => {
  const order = [];
  const f = await fixture(t, { autoArchive: true,
    archive: async () => { order.push('archive'); return { accepted: true, archivedSessionIds: [SESSION] }; },
    report: async (file, payload) => { order.push('report:' + (payload.archive ? 'archived' : 'ended')); await writeReportFile(file, payload); },
    notify: async (config, input) => { order.push('notify'); assert.match(input.summary, /reply done/); return { delivered: true }; },
  });
  assert.deepEqual(order, ['report:ended', 'archive', 'report:archived', 'notify', 'report:archived']);
  assert.equal(f.report.state, 'ended');
  assert.equal(f.report.archive.state, 'archived');
  assert.deepEqual(f.archives, [SESSION]);
  assert.deepEqual(assistantTexts(f.report), ['reply done']);
  assert.equal(f.report.notification.status, 'delivered');
});

test('a failed archive keeps the completion result and records an inspectable archive failure', async t => {
  const f = await fixture(t, { autoArchive: true, archive: async () => { throw new Error('workspace/session-active'); } });
  assert.equal(f.report.state, 'ended');
  assert.equal(f.report.terminalState, 'completed');
  assert.equal(f.report.archive.state, 'failed');
  assert.match(f.report.archive.error, /session-active/);
  assert.deepEqual(assistantTexts(f.report), ['reply done']);
  assert.equal(f.report.notification.status, 'delivered');
  assert.match(f.calls[0].input.summary, /reply done/);
});

test('timeout and running never archive a session, and a repeated completion does not archive twice', async t => {
  const timedOut = await fixture(t, { ending: false, autoArchive: true });
  assert.equal(timedOut.report.state, 'timeout');
  assert.equal(timedOut.report.archive, undefined);
  assert.deepEqual(timedOut.archives, []);

  const first = await fixture(t, { autoArchive: true });
  assert.equal(first.report.archive.state, 'archived');
  assert.equal(first.archives.length, 1);
  const calls = [];
  const second = await runWatchWorker(first.options, { client: host({ root: first.root, ending: false }).client,
    notify: async (config, input) => { calls.push(input); return { delivered: true }; } });
  assert.equal(second.state, 'ended');
  assert.equal(second.timeoutSuppressed, true);
  assert.equal(second.archive.state, 'archived');
  assert.equal(calls.length, 0);
  // The repeated run adopts the stored archive instead of calling the host again.
  const archived = await readFile(first.reportFile, 'utf8').then(JSON.parse);
  assert.equal(archived.archive.state, 'archived');
});
