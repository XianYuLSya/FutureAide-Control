import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createClaudeCliBackend, CLAUDE_CLI_MODELS, CLAUDE_CLI_EFFORTS } from '../src/claude-cli-backend.mjs';
import { endedState, modelTurnError } from '../src/control.mjs';
import { modelCatalogSummary, resolveModelSelection } from '../src/model-selection.mjs';

const ROOT = 'D:\\Work\\fixture\\.runtime\\scoped\\agent-1';
const CLI = 'D:\\Work\\tools\\claude\\claude.exe';
const turnDirectory = requestId => path.join(ROOT, 'claude-cli', 'turns', requestId);

/** A runner that never spawns anything: the adapter is the only subject here. */
function fakeRunner({ probe, turns = {}, failFor = [] } = {}) {
  const calls = { probes: 0, starts: [], reads: [], cancels: [] };
  const live = new Map(Object.entries(turns));
  const failures = new Set(failFor);
  return {
    calls,
    live,
    setTurn(directory, turn) { live.set(directory, turn); },
    async probeClaudeCli() { calls.probes += 1; return probe ?? { cli: CLI }; },
    async startClaudeTurn(input) {
      const failing = [...failures].find(requestId => input.directory.includes(requestId));
      if (failing) {
        failures.delete(failing);
        throw Object.assign(new Error('The claude process could not be spawned.'), { code: 'claude-cli-spawn-failed', retryable: true });
      }
      calls.starts.push(input);
      live.set(input.directory, { state: 'running',
        messages: [{ role: 'assistant', text: 'working' }] });
      return { accepted: true };
    },
    async readClaudeTurn(directory) {
      calls.reads.push(directory);
      const turn = live.get(directory);
      if (!turn) throw Object.assign(new Error('No turn was started in this directory.'), { code: 'claude-turn-unknown' });
      return turn;
    },
    async cancelClaudeTurn(directory) {
      calls.cancels.push(directory);
      const turn = live.get(directory) ?? {};
      live.set(directory, { ...turn, state: 'cancelled' });
      return true;
    },
  };
}

async function harness({ runner, record = {}, submissions = { questions: [], reports: [] } } = {}) {
  const live = { agentId: 'agent-1', ownerId: 'owner-1', name: 'artist', sessionId: 'session-claude-1',
    workspace: 'D:\\Work\\fixture', target: 'claude-cli', state: 'running', created: true,
    task: { taskId: 'task-1' }, ...record };
  let saved;
  const writes = [];
  const deps = {
    load: () => live,
    requestDirectory: () => ROOT,
    readNativeState: () => saved,
    writeNativeState: value => {
      saved = structuredClone(value);
      writes.push(saved);
      return true;
    },
    // The shared layer serializes per name; this harness runs one operation at a time.
    withHostLock: action => action(),
    readParentSubmissions: () => submissions,
    claudeReportConfig: requestId => ({ mcpServers: { futureaide: {
      command: 'node', args: ['report.mjs'], env: { FUTUREAIDE_REQUEST_ID: requestId } } } }),
    runner,
  };
  return { record: live, deps, writes, state: () => saved,
    backend: await createClaudeCliBackend(live, deps) };
}

const setup = harness;

test('create reserves the name with zero model turns and confirms a logged-in CLI', async () => {
  const runner = fakeRunner();
  const { backend, writes, record } = await setup({ runner });
  const created = await backend.create();
  assert.deepEqual(created, { sessionId: record.sessionId, modelRequestsStarted: 0 });
  assert.equal(runner.calls.starts.length, 0, 'no turn was started');
  assert.equal(runner.calls.probes, 1, 'the login gate checked the CLI once');
  assert.ok(writes.length >= 1, 'the reservation was written beside the roster');
  assert.equal(record.requests, undefined, 'target state never lands in the shared record');
});

test('readiness refuses a logged-out CLI before reserving a name', async () => {
  const runner = fakeRunner({ probe: { cli: CLI, auth: { loggedIn: false, code: 'claude-cli-auth-required' } } });
  const { backend } = await setup({ runner });
  const fresh = await setup({ runner, record: { created: false } });
  await assert.rejects(() => fresh.backend.probe(), { code: 'claude-cli-auth-required' });
  assert.equal((await backend.probe()).treeProtocol, 1, 'an existing name stays observable after logout');
  await assert.rejects(() => backend.create(), error => error.code === 'claude-cli-auth-required');
});

test('polling reserved names does not spawn login checks', async () => {
  const runner = fakeRunner();
  const { backend } = await setup({ runner });
  await backend.probe();
  await backend.probe();
  await backend.probe();
  assert.equal(runner.calls.probes, 0);
});

test('one turn per request, and every later turn resumes the same session uuid', async () => {
  const runner = fakeRunner();
  const { backend, record } = await setup({ runner });
  assert.deepEqual(await backend.beginTask({}), { treeProtocol: 1, reportProtocol: 1, throughSeq: 0 });
  const first = await backend.deliver({ requestId: 'request-1', message: 'Do the work', kind: 'task' });
  assert.equal(first.accepted, true);
  assert.equal(runner.calls.starts.length, 1);
  const [started] = runner.calls.starts;
  assert.equal(started.directory, turnDirectory('request-1'));
  assert.equal(started.resume, false);
  assert.equal(started.name, 'artist');
  assert.equal(started.workspace, record.workspace);
  assert.equal(started.mcpConfig.mcpServers.futureaide.env.FUTUREAIDE_REQUEST_ID, 'request-1');

  const running = await backend.turn({ requestId: 'request-1' });
  assert.equal(running.state, 'running');
  runner.setTurn(started.directory, { state: 'ended', model: 'claude-opus-5-5', sessionStarted: true,
    messages: [{ role: 'assistant', text: 'done' }] });
  const ended = await backend.turn({ requestId: 'request-1' });
  assert.equal(ended.state, 'ended');
  assert.equal(ended.correlation, 'request-id');
  assert.deepEqual(ended.completionReason, { kind: 'completed' });
  assert.equal(endedState(ended.completionReason), 'completed');

  await backend.deliver({ requestId: 'request-2', message: 'Continue', kind: 'supplement' });
  const second = runner.calls.starts[1];
  assert.equal(second.resume, true, 'the second turn continues the same conversation');
  assert.equal(second.sessionId, started.sessionId);
  assert.notEqual(second.directory, started.directory, 'each request owns a private directory');
});

test('a live turn makes the next input retryable instead of starting a second process', async () => {
  const runner = fakeRunner();
  const { backend } = await setup({ runner });
  await backend.deliver({ requestId: 'request-1', message: 'First', kind: 'task' });
  const second = await backend.deliver({ requestId: 'request-2', message: 'Second', kind: 'supplement' });
  assert.deepEqual(second, { accepted: false, status: 'retryable' });
  assert.equal(runner.calls.starts.length, 1, 'exactly one process is ever active');
  // Once the first turn is over the retry starts a new, resumed turn.
  runner.setTurn(turnDirectory('request-1'), { state: 'ended', sessionStarted: true, messages: [] });
  await backend.turn({ requestId: 'request-1' });
  const retried = await backend.deliver({ requestId: 'request-2', message: 'Second', kind: 'supplement' });
  assert.equal(retried.accepted, true);
  assert.equal(runner.calls.starts.length, 2);
});

test('delivery is idempotent per request id and refuses a reuse with another message', async () => {
  const runner = fakeRunner();
  const { backend, state } = await setup({ runner });
  const first = await backend.deliver({ requestId: 'request-1', message: 'Do the work' });
  const again = await backend.deliver({ requestId: 'request-1', message: 'Do the work' });
  assert.equal(again.accepted, true);
  assert.equal(again.afterSeq, first.afterSeq);
  assert.equal(runner.calls.starts.length, 1, 'the same request never starts twice');
  assert.deepEqual(await backend.receipt({ requestId: 'request-1' }),
    { status: 'accepted', afterSeq: first.afterSeq, result: { accepted: true, requestId: 'request-1' } });
  await assert.rejects(() => backend.deliver({ requestId: 'request-1', message: 'Something else' }),
    error => error.code === 'request-id-conflict');
  assert.equal(await backend.receipt({ requestId: 'request-unknown' }), undefined,
    'no write was ever attempted');
  assert.equal(state().requests['request-1'].messageHash.length, 64);
});

test('a failed turn keeps both the shared completion reason and the runner error', async () => {
  const runner = fakeRunner();
  const { backend } = await setup({ runner });
  await backend.deliver({ requestId: 'request-1', message: 'Do the work' });
  const [started] = runner.calls.starts;
  const native = { code: 'claude-cli-auth-required', source: 'stdout', httpStatus: 401,
    message: '401: ' + JSON.stringify({ code: 'invalid_api_key' }) };
  runner.setTurn(started.directory, { state: 'failed', error: native, sessionStarted: false, messages: [] });
  const ended = await backend.turn({ requestId: 'request-1' });
  assert.equal(ended.state, 'ended');
  assert.equal(ended.completionReason.kind, 'error');
  assert.equal(ended.completionReason.error.code, native.code);
  assert.equal(ended.failure.source, 'stdout', 'the runner category is passed through unchanged');
  assert.equal(ended.failure.httpStatus, 401);
  assert.equal(ended.failure.message, native.message);
  assert.equal(endedState(ended.completionReason), 'failed');
  assert.equal(modelTurnError(ended.completionReason).code, 'invalid_api_key');
  // The turn repeated reads the same verdict instead of inventing a new one.
  assert.deepEqual(await backend.turn({ requestId: 'request-1' }), ended);
  const history = await backend.history({ maxMessages: 20 });
  assert.equal(history.failure.code, native.code, 'history carries the same failure');
  // A session that never started is not resumed later.
  await backend.deliver({ requestId: 'request-2', message: 'Try again' });
  assert.equal(runner.calls.starts[1].resume, false);
  assert.notEqual(runner.calls.starts[1].sessionId, started.sessionId);
});

test('cancel confirms the stop and ends the turn as cancelled', async () => {
  const runner = fakeRunner();
  const { backend } = await setup({ runner });
  await backend.deliver({ requestId: 'request-1', message: 'Long job' });
  assert.deepEqual(await backend.cancel(), { cancelRequested: true });
  assert.deepEqual(runner.calls.cancels, [turnDirectory('request-1')]);
  const ended = await backend.turn({ requestId: 'request-1' });
  assert.equal(ended.completionReason.kind, 'cancelled');
  assert.equal(endedState(ended.completionReason), 'cancelled');
  assert.deepEqual(await backend.cancel(), { cancelRequested: true }, 'nothing left to stop');
});

test('observe reports one root node and only this task’s questions and reports', async () => {
  const submissions = { questions: [
    { id: 'submission:1', taskId: 'task-1', state: 'pending', message: 'Which file?', createdAt: '2026-11-07T00:00:00.000Z' },
    { id: 'submission:2', taskId: 'task-old', state: 'pending', message: 'Stale', createdAt: '2026-11-07T00:00:00.000Z' },
  ], reports: [
    { id: 'submission:3', taskId: 'task-1', message: 'Summary', final: true, createdAt: '2026-11-07T00:00:00.000Z' },
  ] };
  const runner = fakeRunner();
  const { backend, record } = await setup({ runner, submissions });
  const view = await backend.observe();
  assert.equal(view.sessionId, record.sessionId);
  assert.equal(view.taskId, 'task-1');
  assert.equal(view.running, false);
  assert.equal(view.modelSelectionObserved, false);
  assert.equal(view.tree.settled, true);
  assert.equal(view.tree.nodes.length, 1);
  assert.equal(view.tree.nodes[0].sessionId, record.sessionId, 'the root node is this name’s own session');
  assert.equal(view.tree.nodes[0].parentSessionId, null);
  assert.deepEqual(view.questions.map(question => question.id), ['submission:1']);
  assert.deepEqual(view.reports.map(report => report.id), ['submission:3']);
  assert.match(view.coverage.note, /workspace comparison/);

  await backend.deliver({ requestId: 'request-1', message: 'Do the work' });
  const busy = await backend.observe();
  assert.equal(busy.running, true);
  assert.equal(busy.tree.settled, false, 'a live turn never reports a settled tree');
});

test('answer consumes the pending question once and continues the same task', async () => {
  const submissions = { questions: [{ id: 'submission:1', taskId: 'task-1', state: 'pending',
    message: 'Which file?', createdAt: '2026-11-07T00:00:00.000Z' }], reports: [] };
  const { backend } = await setup({ runner: fakeRunner(), submissions });
  const first = await backend.answer({ answerId: 'answer-1', message: 'src/a.mjs' });
  assert.deepEqual(first.consumedQuestionIds, ['submission:1']);
  assert.match(first.continuation, /src\/a\.mjs/);
  assert.deepEqual(await backend.answer({ answerId: 'answer-1', message: 'src/a.mjs' }), first,
    'the same answer id never consumes twice');
  const view = await backend.observe();
  assert.equal(view.questions[0].state, 'answered');
  await assert.rejects(() => backend.answer({ answerId: 'answer-2', message: 'later' }),
    error => error.code === 'question-not-pending');
});

test('the catalog lists the four CLI models, no invented default, and pass-through efforts', async () => {
  const { backend } = await setup({ runner: fakeRunner() });
  const catalog = await backend.models();
  const summary = modelCatalogSummary(catalog);
  assert.deepEqual(summary.models, [...CLAUDE_CLI_MODELS]);
  assert.equal(summary.defaultModel, null, 'an unknown default stays empty');
  assert.deepEqual(catalog.groups[0].models[0].reasoning.efforts.map(effort => effort.id),
    [...CLAUDE_CLI_EFFORTS]);
  assert.equal(catalog.groups[0].models[0].reasoning.defaultEffort, undefined);
  assert.match(catalog.note, /verbatim/);
  assert.deepEqual(resolveModelSelection(catalog, { model: 'sonnet' }),
    { provider: 'claude-cli', model: 'claude-sonnet-5-5' });
  assert.equal(resolveModelSelection(catalog, { model: 'opus', effort: 'xhigh' }).reasoningEffort, 'xhigh');
  assert.throws(() => resolveModelSelection(catalog, { model: 'opus', effort: 'turbo' }),
    error => error.code === 'effort-not-supported');
});

test('model() only claims what the CLI really reported', async () => {
  const runner = fakeRunner();
  const { backend } = await setup({ runner });
  assert.equal(await backend.model(), undefined, 'an unstarted name has no observed model');
  await assert.rejects(() => backend.selectModel({ model: 'claude-sonnet-5-5' }), { code: 'model-selection-unsupported' });

  await backend.deliver({ requestId: 'request-1', message: 'Do the work', explicitModel: true,
    model: { provider: 'claude-cli', model: 'claude-sonnet-5-5', reasoningEffort: 'high' } });
  const [started] = runner.calls.starts;
  assert.equal(started.model, 'claude-sonnet-5-5');
  assert.equal(started.effort, 'high');
  runner.setTurn(started.directory, { state: 'ended', sessionStarted: true, model: 'claude-sonnet-5-5',
    messages: [{ role: 'assistant', text: 'done' }] });
  await backend.turn({ requestId: 'request-1' });
  const observed = await backend.model();
  assert.equal(observed.model, 'claude-sonnet-5-5');
  assert.equal(observed.provider, 'claude-cli');
  const begin = await backend.beginTask({});
  assert.equal(begin.currentModel.model, 'claude-sonnet-5-5');
});

test('an explicit selection is frozen with its request, and an unflagged one is refused', async () => {
  const runner = fakeRunner({ failFor: ['request-2'] });
  const { backend } = await setup({ runner });
  await assert.rejects(() => backend.deliver({ requestId: 'request-1', message: 'x',
    model: { model: 'claude-opus-5-5' } }), error => error.code === 'invalid-dispatch');
  const selection = { provider: 'claude-cli', model: 'claude-opus-5-5', reasoningEffort: 'max' };
  await backend.deliver({ requestId: 'request-1', message: 'x', explicitModel: true, model: selection });
  assert.equal(runner.calls.starts[0].effort, 'max');
  assert.equal(runner.calls.starts[0].model, 'claude-opus-5-5');
  // Replaying the same request id with the same selection is a no-op.
  const replay = await backend.deliver({ requestId: 'request-1', message: 'x', explicitModel: true, model: selection });
  assert.equal(replay.accepted, true);
  assert.equal(runner.calls.starts.length, 1);
  // A retryable start failure keeps the frozen selection: another model on the same
  // request id is a conflict, and the same one may try again.
  runner.setTurn(turnDirectory('request-1'), { state: 'ended', sessionStarted: true, messages: [] });
  await backend.turn({ requestId: 'request-1' });
  await assert.rejects(() => backend.deliver({ requestId: 'request-2', message: 'y', explicitModel: true,
    model: { provider: 'claude-cli', model: 'claude-haiku-5-5' } }), error => error.code === 'claude-cli-spawn-failed');
  await assert.rejects(() => backend.deliver({ requestId: 'request-2', message: 'y', explicitModel: true,
    model: { provider: 'claude-cli', model: 'claude-fable-5-1' } }), error => error.code === 'request-id-conflict');
  const retried = await backend.deliver({ requestId: 'request-2', message: 'y', explicitModel: true,
    model: { provider: 'claude-cli', model: 'claude-haiku-5-5' } });
  assert.equal(retried.accepted, true);
  assert.equal(runner.calls.starts[1].model, 'claude-haiku-5-5');
});

test('history keeps the task’s messages in order and reports the page size', async () => {
  const runner = fakeRunner();
  const { backend } = await setup({ runner });
  await backend.deliver({ requestId: 'request-1', message: 'First' });
  const [first] = runner.calls.starts;
  runner.setTurn(first.directory, { state: 'ended', sessionStarted: true,
    messages: [{ role: 'user', text: 'First' }, { role: 'assistant', text: 'one' }] });
  await backend.turn({ requestId: 'request-1' });
  await backend.deliver({ requestId: 'request-2', message: 'Second' });
  const [, second] = runner.calls.starts;
  runner.setTurn(second.directory, { state: 'ended', sessionStarted: true,
    messages: [{ role: 'assistant', text: 'two' }] });
  await backend.turn({ requestId: 'request-2' });
  const page = await backend.history({ maxMessages: 20 });
  assert.deepEqual(page.messages.map(message => message.text), ['First', 'one', 'two']);
  assert.equal(page.hasMore, false);
  const short = await backend.history({ maxMessages: 1 });
  assert.deepEqual(short.messages.map(message => message.text), ['two']);
  assert.equal(short.hasMore, true);
  await assert.rejects(() => backend.history({ targetSessionId: 'someone-else' }),
    error => error.code === 'unknown-owned-node');
});

test('delete stops the process and never deletes the native session', async () => {
  const runner = fakeRunner();
  const { backend } = await setup({ runner });
  await backend.deliver({ requestId: 'request-1', message: 'Do the work' });
  const result = await backend.destroy();
  assert.equal(result.destroyed, true);
  assert.equal(result.nativeSessionRetained, false, 'the CLI had not initialized a native session');
  assert.deepEqual(runner.calls.cancels, [turnDirectory('request-1')]);
  assert.deepEqual(await backend.cursor(), { throughSeq: 1 });
});

test('the adapter refuses to work without the shared state store or the report server', async () => {
  const runner = fakeRunner();
  const record = { agentId: 'agent-1', ownerId: 'owner-1', name: 'artist', sessionId: 'session-claude-1',
    workspace: 'D:\\Work\\fixture', target: 'claude-cli', task: { taskId: 'task-1' } };
  const bare = await createClaudeCliBackend(record, { load: () => record, requestDirectory: () => ROOT, runner });
  assert.equal((await bare.probe()).reportProtocol, null, 'no report server means no report protocol');
  await assert.rejects(() => bare.create(), error => error.code === 'claude-report-not-ready');
  const noState = await createClaudeCliBackend(record, { load: () => record, requestDirectory: () => ROOT,
    runner, readParentSubmissions: () => ({ questions: [], reports: [] }),
    claudeReportConfig: () => ({ mcpServers: {} }) });
  await assert.rejects(() => noState.create(), error => error.code === 'claude-state-unavailable');
});

test('a missing CLI is a concrete refusal, not a silent no-op', async () => {
  const runner = fakeRunner({ probe: { cli: '' } });
  const { backend } = await setup({ runner, record: { created: false } });
  await assert.rejects(() => backend.probe(), error => error.code === 'claude-cli-not-found');
});

test('final delivery can observe a settled first turn before the shared turn reader', async () => {
  const runner = fakeRunner();
  const { backend, record } = await setup({ runner });
  await backend.deliver({ requestId: 'first', message: 'First' });
  runner.setTurn(turnDirectory('first'), { state: 'ended', sessionStarted: true, model: 'observed-id' });
  assert.equal((await backend.observe()).currentModel.model, 'observed-id');
  record.task = { taskId: 'next' };
  await backend.beginTask();
  await backend.deliver({ requestId: 'second', message: 'Continue' });
  assert.equal(runner.calls.starts[1].resume, true);
  assert.equal(runner.calls.starts[1].sessionId, runner.calls.starts[0].sessionId);
});
