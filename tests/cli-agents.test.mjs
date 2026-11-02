import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCliAgents, managedOwnerIdFor } from '../src/cli-agents.mjs';
import { createRuntimeAdapter } from '../src/cli-agent-adapters.mjs';
import { runWorker, workerActive } from '../src/cli-agent-worker.mjs';
import { RosterStore } from '../src/roster-store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'clean', 'cli-agent-tests');
const A = 'owner-A';
const B = 'owner-B';
const thread = { A: 'thread-A', B: 'thread-B' };
const extra = key => ({ key });
const childExtra = agentId => ({ child: agentId });

async function fixture({ notifyState = 'delivered', turnScript, environmentError = false, realAdapters = false } = {}) {
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'run-'));
  const store = new RosterStore(':memory:');
  const contexts = new Map([
    [A, { ownerId: A, threadId: thread.A, workspace: root, client: 'codex' }],
    [B, { ownerId: B, threadId: thread.B, workspace: root, client: 'claude' }],
  ]);
  const workers = [];
  const notifications = [];
  const runs = [];
  const kills = [];
  const cleanupCalls = [];
  let turn = 0;
  const service = createCliAgents({
    stateDirectory,
    configFile: path.join(stateDirectory, 'config.json'),
    binding: { profileId: 'fixture-profile' },
  }, {
    store,
    resolveContext: async value => {
      if (value.child) {
        const agent = store.get(value.child);
        const reportContext = { ...agent.owner, _resolved: true, ownerId: agent.ownerId,
          parentAgentId: value.child, parentTaskId: agent.task.taskId, taskId: agent.task.taskId };
        return { ...reportContext, ownerId: managedOwnerIdFor(agent.agentId), threadId: agent.cliSessionId,
          client: 'managed-cli', reportContext };
      }
      return contexts.get(value.key);
    },
    resolveEnvironment: async ({ binding, directory }) => {
      if (environmentError) throw new Error('fixture environment unavailable');
      return {
        executable: process.execPath,
        env: { CODEX_HOME: path.join(directory, 'codex-home') },
        binding: { ...binding, kind: 'fixture', name: 'fixture-runtime' },
        cleanup: async () => { cleanupCalls.push(directory); },
      };
    },
    notify: async input => {
      notifications.push(input);
      const state = typeof notifyState === 'function' ? await notifyState(input) : notifyState;
      return { state };
    },
    startWorker: (...args) => { workers.push(args); return 9000 + workers.length; },
    adapterFor: realAdapters ? createRuntimeAdapter : runtime => runtime === 'claude'
      ? { id: 'test-claude', build: input => ({ command: process.execPath, args: ['test-claude'], stdinText: input.prompt + '\n' }) }
      : createRuntimeAdapter(runtime),
    killTree: async pid => { kills.push(pid); return true; },
    runTurn: async input => {
      if (turnScript) return turnScript(input);
      runs.push(input);
      const index = turn++;
      input.onSpawn?.(1000 + index);
      input.onStdoutLine?.(JSON.stringify({ type: 'system', session_id: 'native-session-1' }));
      input.onStdoutLine?.(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `working-${index}` }] },
      }));
      input.onStdoutLine?.(JSON.stringify({
        type: 'tool_use',
        id: `write-${index}`,
        name: 'Write',
        input: { file_path: `fixture-${index}.txt`, content: 'not persisted' },
      }));
      input.onStdoutLine?.(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `write-${index}`, content: 'written' }] } }));
      return { exitCode: 0, signal: null, stderrTail: '' };
    },
  });
  const record = (name = 'reviewer', owner = A) => store.named(owner, name);
  return { service, store, stateDirectory, workers, notifications, runs, kills, cleanupCalls, record, extra, childExtra, contexts };
}

function reportChild(f, agentId, message = '完成', final = true) {
  return f.service.report({ message, final }, f.childExtra(agentId));
}

test('final is refused while a descendant created by this agent is still active', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'parent', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    const parent = f.record('parent');
    await f.service.send({ name: 'parent', message: 'parent work' }, f.extra(A));
    await f.service.poll(parent.agentId);
    await f.service.create({ name: 'child', lifetime: 'persistent', runtime: 'claude' }, { child: parent.agentId });
    const child = f.record('child', managedOwnerIdFor(parent.agentId));
    await f.service.send({ name: 'child', message: 'child work' }, { child: parent.agentId });
    await f.service.poll(child.agentId);
    await assert.rejects(
      () => f.service.report({ message: 'parent final', final: true }, { child: parent.agentId }),
      /descendant/i,
    );
    assert.equal(f.record('parent').task.finalSubmitted, false);
  } finally { f.service.close(); }
});

test('a managed CLI parent receives child reports through its own task queue', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'parent', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    const parent = f.record('parent');
    await f.service.send({ name: 'parent', message: 'parent task' }, f.extra(A));
    await f.service.poll(parent.agentId);
    await f.service.create({ name: 'child', lifetime: 'persistent', runtime: 'claude' }, { child: parent.agentId });
    const child = f.record('child', managedOwnerIdFor(parent.agentId));
    await f.service.send({ name: 'child', message: 'child task' }, { child: parent.agentId });
    await f.service.poll(child.agentId);
    const delivered = await reportChild(f, child.agentId, 'child result', true);
    assert.equal(delivered.delivery, 'delivered');
    const queued = f.store.supplements(parent.agentId).filter(item => item.status === 'queued');
    assert.equal(queued.length, 1);
    assert.match(queued[0].message, /child result/);
    assert.equal(f.store.get(parent.agentId).state, 'awaiting_report');
  } finally { f.service.close(); }
});

test('retiring a parent retires its separately scoped children and preserves unrelated agents', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'parent', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    await f.service.create({ name: 'unrelated', lifetime: 'persistent', runtime: 'codex' }, f.extra(B));
    const parent = f.record('parent');
    await f.service.send({ name: 'parent', message: 'work' }, f.extra(A));
    await f.service.poll(parent.agentId);
    await f.service.create({ name: 'child', lifetime: 'persistent', runtime: 'codex' }, f.childExtra(parent.agentId));
    const result = await f.service.delete({ name: 'parent' }, f.extra(A));
    assert.equal(result.deleted, true);
    assert.equal(f.store.count(A), 0);
    assert.equal(f.store.count(managedOwnerIdFor(parent.agentId)), 0);
    assert.equal(f.store.count(B), 1);
  } finally { f.service.close(); }
});

test('managed context token is task-scoped and report/ask can use it directly', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    const record = f.record();
    await f.service.send({ name: 'reviewer', message: 'managed task' }, f.extra(A));
    await f.service.poll(record.agentId);
    const token = f.runs[0].env.FUTUREAIDE_MANAGED_TOKEN;
    assert.equal(typeof token, 'string');
    assert.equal(typeof f.record().task.managedTokenHash, 'string');
    assert.notEqual(f.record().task.managedTokenHash, token);
    const context = await f.service.resolveManagedContext(record.agentId, token);
    assert.notEqual(context.ownerId, record.ownerId);
    assert.equal(context.reportContext.ownerId, record.ownerId);
    f.contexts.set('managed-owner', context);
    await f.service.create({ name: 'nested-idle', lifetime: 'persistent', runtime: 'codex' }, f.extra('managed-owner'));
    const nested = f.record('nested-idle', context.ownerId);
    assert.equal(nested.owner.ownerId, context.ownerId);
    assert.equal(nested.owner.threadId, context.threadId);
    assert.equal((await f.service.list(f.extra('managed-owner'))).items.length, 1);
    assert.equal((await f.service.list(f.extra(A))).items.length, 1);
    await f.service.delete({ name: 'nested-idle' }, f.extra('managed-owner'));
    assert.equal(context.taskId, f.record().task.taskId);
    assert.equal(context.reportContext.taskId, context.taskId);
    const legacyContext = await f.service.resolveManagedContext(record.agentId, f.record().task.taskId, token);
    assert.equal(legacyContext.taskId, f.record().task.taskId);
    await f.service.report({ message: 'progress', final: false }, { agentId: record.agentId, token });
    await f.service.report({ message: 'from managed context', final: true }, context.reportContext);
    const final = await f.service.poll(record.agentId);
    assert.equal(final.state, 'idle');
    await assert.rejects(() => f.service.resolveManagedContext(record.agentId, 'old-or-wrong'), /token/i);
    await f.service.send({ name: 'reviewer', message: 'new task' }, f.extra(A));
    await f.service.poll(record.agentId);
    const nextToken = f.runs.at(-1).env.FUTUREAIDE_MANAGED_TOKEN;
    assert.notEqual(nextToken, token);
    await assert.rejects(() => f.service.resolveManagedContext(record.agentId, token), /token|task/i);
  } finally { f.service.close(); }
});

test('a caller cannot switch the same chat to another workspace', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    const other = await mkdtemp(path.join(base, 'other-'));
    f.contexts.set('A-other', { ownerId: A, threadId: thread.A, workspace: other, client: 'codex' });
    await assert.rejects(() => f.service.list(f.extra('A-other')), /another project|bound/i);
  } finally { f.service.close(); }
});

test('Claude host wait acknowledges a pending final report and finishes the task', async () => {
  const f = await fixture({ notifyState: 'pending' });
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'codex' }, f.extra(A));
    const record = f.record();
    await f.service.send({ name: 'reviewer', message: 'wait for report' }, f.extra(A));
    await f.service.poll(record.agentId);
    await reportChild(f, record.agentId, 'wait result', true);
    await f.service.poll(record.agentId);
    assert.equal(f.record().state, 'delivery_pending');
    f.contexts.get(A).client = 'claude-code';
    const result = await f.service.wait({ names: ['reviewer'], timeoutSeconds: 0 }, f.extra(A));
    assert.equal(result.reports?.length, 1);
    assert.equal(result.reports[0].message, 'wait result');
    assert.equal(f.record().state, 'idle');
  } finally { f.service.close(); }
});

test('wait returns complete unseen reports and does not retire a once agent before its process exits', async () => {
  let f;
  const longReport = 'full report '.repeat(100);
  f = await fixture({ notifyState: 'pending', turnScript: async input => {
    const record = f.record('once-report');
    await reportChild(f, record.agentId, 'first checkpoint', false);
    await reportChild(f, record.agentId, longReport, true);
    const received = await f.service.wait({ names: ['once-report'] }, f.extra(A));
    assert.deepEqual(received.reports.map(r => r.message), ['first checkpoint', longReport]);
    assert.ok(f.record('once-report'), 'the process is still executing its final tool response');
    const again = await f.service.wait({ names: ['once-report'] }, f.extra(A));
    assert.equal(again.reports, undefined);
    return { exitCode: 0 };
  } });
  try {
    await f.service.create({ name: 'once-report', lifetime: 'once', runtime: 'codex' }, f.extra(A));
    const id = f.record('once-report').agentId;
    await f.service.send({ name: 'once-report', message: 'work' }, f.extra(A));
    await f.service.poll(id);
    assert.equal(f.record('once-report'), undefined);
  } finally { f.service.close(); }
});

test('delivery_pending is retried by a later poll and can still complete', async () => {
  let attempts = 0;
  const f = await fixture({ notifyState: () => ++attempts <= 2 ? 'pending' : 'delivered' });
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    const record = f.record();
    await f.service.send({ name: 'reviewer', message: 'deliver later' }, f.extra(A));
    await f.service.poll(record.agentId);
    await reportChild(f, record.agentId, 'delivered later', true);
    const pending = await f.service.poll(record.agentId);
    assert.equal(pending.state, 'delivery_pending');
    const complete = await f.service.poll(record.agentId);
    assert.equal(complete.state, 'idle');
    assert.equal(f.record().task.result.reply, 'delivered later');
  } finally { f.service.close(); }
});

test('cancel after a submitted final is refused and cannot overwrite the deliverable', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    const record = f.record();
    await f.service.send({ name: 'reviewer', message: 'final first' }, f.extra(A));
    await f.service.poll(record.agentId);
    await reportChild(f, record.agentId, 'final answer', true);
    const cancelled = await f.service.cancel({ name: 'reviewer' }, f.extra(A));
    assert.equal(cancelled.accepted, false);
    assert.equal(cancelled.reason, 'final-submitted');
    assert.equal(f.record().task.finalSubmitted, true);
  } finally { f.service.close(); }
});

test('a failed create leaves a tracked record that can be retired', async () => {
  const f = await fixture({ environmentError: true });
  try {
    const created = await f.service.create({ name: 'bad', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    assert.equal(created.created, false);
    assert.equal(created.state, 'create_failed');
    const record = f.record('bad');
    assert.equal(record.state, 'create_failed');
    const removed = await f.service.delete({ name: 'bad' }, f.extra(A));
    assert.equal(removed.deleted, true);
    assert.equal(f.store.get(record.agentId), undefined);
  } finally { f.service.close(); }
});

test('final is refused while queued input remains, preventing silent loss', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    const record = f.record();
    await f.service.send({ name: 'reviewer', message: 'first' }, f.extra(A));
    await f.service.send({ name: 'reviewer', message: 'queued supplement' }, f.extra(A));
    await f.service.poll(record.agentId);
    await assert.rejects(
      () => reportChild(f, record.agentId, 'premature final', true),
      /queued input|pending input/i,
    );
    assert.equal(f.record().task.finalSubmitted, false);
    assert.equal(f.store.supplements(record.agentId).filter(item => item.status === 'queued').length, 1);
  } finally { f.service.close(); }
});

test('accepted-only delivery is not treated as delivered', async () => {
  const f = await fixture({ notifyState: 'accepted' });
  try {
    await f.service.create({ name: 'once-agent', lifetime: 'once', runtime: 'claude' }, f.extra(A));
    const record = f.record('once-agent');
    await f.service.send({ name: 'once-agent', message: 'work' }, f.extra(A));
    await f.service.poll(record.agentId);
    const reported = await reportChild(f, record.agentId, 'result', true);
    assert.equal(reported.delivery, 'unknown');
    const result = await f.service.poll(record.agentId);
    assert.equal(result.state, 'delivery_pending');
    assert.notEqual(f.store.get(record.agentId), undefined);
  } finally { f.service.close(); }
});

test('a failed CLI terminal event is not reported as completed on a zero exit', async () => {
  const f = await fixture({ turnScript: async input => {
    input.onStdoutLine?.(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'failed' }));
    return { exitCode: 0, signal: null, stderrTail: '' };
  } });
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    const record = f.record();
    await f.service.send({ name: 'reviewer', message: 'fail this turn' }, f.extra(A));
    const result = await f.service.poll(record.agentId);
    assert.equal(result.state, 'failed');
    assert.equal(f.record().task.dispatches.at(-1).state, 'failed');
  } finally { f.service.close(); }
});

test('the independent cli-roster.sqlite survives a service reopen', async () => {
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'persist-'));
  const config = { stateDirectory, configFile: path.join(stateDirectory, 'config.json') };
  const contexts = new Map([[A, { ownerId: A, threadId: thread.A, workspace: root, client: 'codex' }]]);
  const options = {
    resolveContext: async value => contexts.get(value.key),
    resolveEnvironment: async ({ binding }) => ({ executable: process.execPath, env: {}, binding }),
    startWorker: () => 9001,
  };
  const first = createCliAgents(config, options);
  await first.create({ name: 'persisted', lifetime: 'persistent', runtime: 'claude' }, extra(A));
  first.close();
  assert.notEqual(await stat(path.join(stateDirectory, 'cli-roster.sqlite')), undefined);
  const second = createCliAgents(config, options);
  try {
    const listed = await second.list(extra(A));
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].name, 'persisted');
    assert.equal(listed.items[0].state, 'idle');
  } finally { second.close(); }
});

test('create is name-addressed per caller and starts no model turn', async () => {
  const f = await fixture();
  try {
    const created = await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    assert.equal(created.created, true);
    assert.equal(created.state, 'idle');
    assert.equal(created.runtime, 'claude');
    assert.equal(created.lifetime, 'persistent');
    assert.equal(f.runs.length, 0);
    assert.equal(f.workers.length, 0);
    assert.ok(f.cleanupCalls.length >= 1, 'create cleans the prepared runtime environment');

    await assert.rejects(
      () => f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'codex' }, f.extra(A)),
      /already exists|name/i,
    );
    const other = await f.service.create({ name: 'reviewer', lifetime: 'once', runtime: 'codex' }, f.extra(B));
    assert.equal(other.created, true);
    assert.equal(f.store.list(A).length, 1);
    assert.equal(f.store.list(B).length, 1);
  } finally { f.service.close(); }
});

test('send returns a compact receipt and a running supplement is persisted instead of rejected', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    const first = await f.service.send({ name: 'reviewer', message: 'first task' }, f.extra(A));
    assert.deepEqual(Object.keys(first).sort(), ['accepted', 'name', 'state']);
    assert.equal(first.accepted, true);
    const second = await f.service.send({ name: 'reviewer', message: 'please also check tests' }, f.extra(A));
    assert.deepEqual(Object.keys(second).sort(), ['accepted', 'name', 'queued', 'state']);
    assert.equal(second.accepted, false);
    assert.equal(second.queued, true);
    const record = f.record();
    assert.equal(f.store.supplements(record.agentId).filter(item => item.status === 'queued').length, 1);
    assert.equal(f.runs.length, 0, 'send only queues; the worker owns execution');
  } finally { f.service.close(); }
});

test('Claude adapter uses the Desktop Code invocation without a login step', () => {
  const adapter = createRuntimeAdapter('claude');
  const invocation = adapter.build({
    executable: 'claude-desktop.exe',
    prompt: 'hello',
    sessionId: '11111111-1111-4111-8111-111111111111',
    mcpConfigPath: 'D:\\fixture\\mcp.json',
    model: 'opus',
    effort: 'medium',
  });
  assert.equal(adapter.id, 'claude-desktop-code');
  assert.equal(invocation.command, 'claude-desktop.exe');
  assert.ok(invocation.args.includes('--verbose'));
  assert.ok(invocation.args.includes('--strict-mcp-config'));
  assert.ok(invocation.args.includes('--mcp-config'));
  assert.ok(!invocation.args.includes('--bare'));
});

test('poll executes stdin task, collects stdout events, and explicit final returns persistent agent to idle', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'codex' }, f.extra(A));
    await f.service.send({ name: 'reviewer', message: 'first task' }, f.extra(A));
    const record = f.record();
    const first = await f.service.poll(record.agentId);
    assert.equal(first.state, 'awaiting_report');
    assert.equal(f.runs.length, 1);
    assert.match(f.runs[0].stdinText, /first task/);
    assert.match(f.runs[0].stdinText, /report_parent/);
    assert.match(f.runs[0].stdinText, /final:true/);
    assert.equal(f.runs[0].args.includes('--skip-git-repo-check'), true);
    assert.equal(f.runs[0].args.includes('-C'), true);
    assert.equal(f.runs[0].args.includes('-c'), true);

    await reportChild(f, record.agentId, 'first result', true);
    const final = await f.service.poll(record.agentId);
    assert.equal(final.state, 'idle');
    assert.equal(f.record().task.result.reply, 'first result');
    assert.equal(f.notifications.at(-1).kind, 'report');
    assert.equal(f.notifications.at(-1).final, true);
  } finally { f.service.close(); }
});

test('persistent second task resumes the stored native session', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'codex' }, f.extra(A));
    let record = f.record();
    await f.service.send({ name: 'reviewer', message: 'first' }, f.extra(A));
    await f.service.poll(record.agentId);
    record = f.record();
    assert.equal(f.runs[0].env.CODEX_HOME, path.join(record.directory, 'codex-home'));
    assert.equal(f.runs[0].args.includes('--skip-git-repo-check'), true);
    assert.equal(f.runs[0].args[f.runs[0].args.indexOf('-C') + 1], record.workspace);
    assert.ok(f.runs[0].args.some(argument => argument.startsWith('mcp_servers.futureaide.command=')));
    assert.ok(f.runs[0].args.some(argument => argument.startsWith('mcp_servers.futureaide.args=')));
    assert.ok(f.runs[0].args.some(argument => argument === '-c'));
    await reportChild(f, record.agentId, 'first done', true);
    await f.service.poll(record.agentId);
    assert.equal(f.runs.length, 1);

    await f.service.send({ name: 'reviewer', message: 'second' }, f.extra(A));
    await f.service.poll(record.agentId);
    assert.equal(f.runs.length, 2);
    assert.equal(f.runs[1].args.includes('resume'), true);
    assert.equal(f.runs[1].args.includes('native-session-1'), true);
    assert.equal(f.record().state, 'awaiting_report');
  } finally { f.service.close(); }
});

test('running supplements are drained in order after the current turn', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'codex' }, f.extra(A));
    const record = f.record();
    await f.service.send({ name: 'reviewer', message: 'first' }, f.extra(A));
    await f.service.send({ name: 'reviewer', message: 'second queued' }, f.extra(A));
    await f.service.poll(record.agentId);
    assert.equal(f.runs.length, 1);
    await f.service.poll(record.agentId);
    assert.equal(f.runs.length, 2);
    assert.match(f.runs[1].stdinText, /second queued/);
    assert.equal(f.record().state, 'awaiting_report');
  } finally { f.service.close(); }
});

test('ask_parent waits without re-running the original task', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    const record = f.record();
    await f.service.send({ name: 'reviewer', message: 'ask first' }, f.extra(A));
    await f.service.poll(record.agentId);
    await f.service.ask({ message: 'Need a decision' }, f.childExtra(record.agentId));
    const waiting = await f.service.poll(record.agentId);
    assert.equal(waiting.state, 'awaiting_input');
    assert.equal(f.runs.length, 1);
    await assert.rejects(
      () => f.service.report({ message: 'too early', final: true }, f.childExtra(record.agentId)),
      /pending question|final report/i,
    );
  } finally { f.service.close(); }
});

test('ask_parent waits for one answer and the answer resumes the same task once', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    await f.service.send({ name: 'reviewer', message: 'needs a decision' }, f.extra(A));
    const record = f.record();
    await f.service.poll(record.agentId);
    const asked = await f.service.ask({ message: 'Which branch?' }, f.childExtra(record.agentId));
    assert.deepEqual(asked, { waiting: true });
    assert.equal(f.record().state, 'awaiting_input');
    assert.equal(f.notifications.at(-1).kind, 'question');

    const answered = await f.service.answer({ name: 'reviewer', message: 'main' }, f.extra(A));
    assert.equal(answered.answered, true);
    assert.equal(f.record().state, 'running');
    await f.service.poll(record.agentId);
    assert.equal(f.runs.length, 2);
    assert.match(f.runs[1].stdinText, /主控回答/);
    assert.match(f.runs[1].stdinText, /main/);
  } finally { f.service.close(); }
});

test('one-shot retires by moving its owned directory to clean, never deleting it', async () => {
  const f = await fixture();
  try {
    const created = await f.service.create({ name: 'once-agent', lifetime: 'once', runtime: 'claude' }, f.extra(A));
    assert.equal(created.created, true);
    const record = f.record('once-agent');
    await f.service.send({ name: 'once-agent', message: 'finish once' }, f.extra(A));
    await f.service.poll(record.agentId);
    await reportChild(f, record.agentId, 'once result', true);
    const result = await f.service.poll(record.agentId);
    assert.equal(result.deleted, true);
    assert.equal(f.store.get(record.agentId), undefined);
    assert.equal(f.store.list(A).length, 0);
    const entries = await readdir(path.join(f.stateDirectory, 'clean'));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].startsWith(record.agentId), true);
  } finally { f.service.close(); }
});

test('final delivery not confirmed stays delivery_pending and keeps a one-shot agent', async () => {
  const f = await fixture({ notifyState: 'pending' });
  try {
    await f.service.create({ name: 'once-agent', lifetime: 'once', runtime: 'codex' }, f.extra(A));
    const record = f.record('once-agent');
    await f.service.send({ name: 'once-agent', message: 'work' }, f.extra(A));
    await f.service.poll(record.agentId);
    const reported = await reportChild(f, record.agentId, 'result', true);
    assert.equal(reported.delivery, 'pending');
    const result = await f.service.poll(record.agentId);
    assert.equal(result.state, 'delivery_pending');
    assert.notEqual(f.store.get(record.agentId), undefined);
    assert.equal(f.store.get(record.agentId).state, 'delivery_pending');
  } finally { f.service.close(); }
});

test('changes and inspect expose bounded event attribution without native identifiers', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    const record = f.record();
    await f.service.send({ name: 'reviewer', message: 'edit a file' }, f.extra(A));
    await f.service.poll(record.agentId);
    const changes = await f.service.changes({ name: 'reviewer' }, f.extra(A));
    assert.equal(changes.changes[0].path, path.join(root, 'fixture-0.txt'));
    const inspection = await f.service.inspect({ name: 'reviewer', maxMessages: 10 }, f.extra(A));
    assert.equal(inspection.messages.some(message => message.text === 'working-0'), true);
    assert.equal(JSON.stringify(inspection).includes('native-session-1'), false);
  } finally { f.service.close(); }
});

test('cancel only targets the recorded child pid and leaves other processes alone', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'reviewer', lifetime: 'persistent', runtime: 'claude' }, f.extra(A));
    await f.service.send({ name: 'reviewer', message: 'long task' }, f.extra(A));
    const record = f.record();
    record.childPid = 43210;
    f.store.save(record);
    const result = await f.service.cancel({ name: 'reviewer' }, f.extra(A));
    assert.equal(result.accepted, true);
    assert.deepEqual(f.kills, [43210]);
  } finally { f.service.close(); }
});

test('CLI agent state root on drive C is refused before a roster is opened', { skip: process.platform !== 'win32' }, () => {
  assert.throws(
    () => createCliAgents({ stateDirectory: 'C:\\futureaide-test-state' }, { store: new RosterStore(':memory:') }),
    /drive C|c-drive/i,
  );
});

test('workerActive stops on idle and keeps running while queued work exists', () => {
  const store = {
    supplements: () => [],
  };
  const idle = { agentId: 'agent-a', state: 'idle', closed: false };
  assert.equal(workerActive(idle, store), false);
  const waiting = { agentId: 'agent-a', state: 'awaiting_input', closed: false, task: { taskId: 'task-a', questions: [] } };
  assert.equal(workerActive(waiting, store), false);
  const running = { agentId: 'agent-a', state: 'running', closed: false, task: { taskId: 'task-a' } };
  assert.equal(workerActive(running, store), true);
});

test('runWorker polls until the agent stops and releases its lease', async () => {
  const calls = [];
  const releases = [];
  let record = { agentId: 'agent-a', state: 'running', closed: false, task: { taskId: 'task-a' } };
  const store = {
    renewLease: () => true,
    supplements: () => [],
    get: () => record,
    releaseLease: (...args) => releases.push(args),
    setWorker: () => {},
  };
  const service = {
    store,
    async poll() {
      calls.push('poll');
      record = { ...record, state: 'idle' };
    },
    async resume() {},
    close() {},
  };
  await runWorker({ service, agentId: 'agent-a', lease: 'worker-0123456789abcdef0123456789abcdef', pollMs: 50 });
  assert.equal(calls.length, 1);
  assert.deepEqual(releases, [['worker:agent-a', 'worker-0123456789abcdef0123456789abcdef']]);
});
