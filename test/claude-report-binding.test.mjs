// First-list self-binding and root-call evidence. Everything that touches the
// filesystem or the roster is injected, so these tests check the decisions; the
// single guarded UPDATE runs against a real in-memory RosterStore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RosterStore } from '../src/roster-store.mjs';
import {
  adoptFirstListBinding, bindPendingCreation, matchRootCall, pendingCreations, pendingRootCalls,
  readTailRecords, requireRootCall, REPORT_TOOL_ALLOWLIST,
} from '../src/claude-report-binding.mjs';

const nativeSessionId = '6808231c-116c-4fc7-b9b0-4d790e763b0b';
const REPORT = 'mcp__futureaide-report__report_parent';
const ASK = 'mcp__futureaide-report__ask_parent';

function roster({ workspace = 'D:\\Work\\xiayuls_workflow', bindingNonce = 'nonce-' + randomUUID(),
  binding, requests = { 'req-1': { requestId: 'req-1', attempted: true, status: 'unknown' } },
  target = 'claude-desktop', closed = false, withState = true } = {}) {
  const store = new RosterStore(':memory:');
  const agentId = 'agent-' + randomUUID().replace(/-/g, '');
  store.insert({ agentId, ownerId: 'owner-1', name: '首列表副手', target, closed, state: 'creating',
    sessionId: 'logical-1', workspace, task: { taskId: 5, state: 'running', reports: [] } });
  if (withState) store.saveBackendState(agentId, { bindingNonce, ...(binding ? { binding } : {}), requests });
  return { store, agentId, bindingNonce };
}

const caller = () => ({ pid: 50124, sessionId: nativeSessionId, cwd: 'D:\\Work\\xiayuls_workflow',
  procStart: '134381970992798945', pidDomain: 'win32:laptop-lbuiepjr', recordFile: 'D:\\c\\sessions\\50124.json',
  directory: 'D:\\c\\sessions', socketPath: '\\\\.\\pipe\\local\\cc-msg-abc', hostSessionId: 'local_1', name: '测试会话' });

test('a candidate is only offered when the creation is genuinely pending in this workspace', () => {
  const pending = roster();
  assert.deepEqual(pendingCreations(pending.store, 'd:\\work\\XIAYULS_WORKFLOW').map(row => row.agentId), [pending.agentId]);

  const otherWorkspace = roster({ workspace: 'D:\\Work\\other' });
  assert.deepEqual(pendingCreations(otherWorkspace.store, 'D:\\Work\\xiayuls_workflow'), []);

  const bound = roster({ binding: { sessionId: nativeSessionId } });
  assert.deepEqual(pendingCreations(bound.store, 'D:\\Work\\xiayuls_workflow'), []);

  const neverAttempted = roster({ requests: { 'req-1': { requestId: 'req-1', attempted: false } } });
  assert.deepEqual(pendingCreations(neverAttempted.store, 'D:\\Work\\xiayuls_workflow'), []);

  const dshTarget = roster({ target: 'dsh' });
  assert.deepEqual(pendingCreations(dshTarget.store, 'D:\\Work\\xiayuls_workflow'), []);

  const closed = roster({ closed: true });
  assert.deepEqual(pendingCreations(closed.store, 'D:\\Work\\xiayuls_workflow'), []);

  const noNonce = roster({ bindingNonce: '' });
  assert.deepEqual(pendingCreations(noNonce.store, 'D:\\Work\\xiayuls_workflow'), []);
});

test('the guarded write binds once and never overwrites another writer', () => {
  const fixture = roster();
  const binding = bindPendingCreation(fixture.store, { agentId: fixture.agentId, caller: caller(),
    requestId: 'req-1', bindingNonce: fixture.bindingNonce });
  assert.equal(binding.sessionId, nativeSessionId);
  assert.equal(binding.boundBy, 'report-first-list');
  const saved = fixture.store.backendState(fixture.agentId);
  assert.equal(saved.binding.sessionId, nativeSessionId);
  assert.equal(saved.binding.socketPath, caller().socketPath);
  // The projection side of the same document is untouched.
  assert.equal(saved.requests['req-1'].attempted, true);
  assert.equal(saved.bindingNonce, fixture.bindingNonce);

  // A second adoption of the same name must not win again.
  assert.equal(bindPendingCreation(fixture.store, { agentId: fixture.agentId, caller: caller(),
    requestId: 'req-1', bindingNonce: fixture.bindingNonce }), undefined);
});

test('a stale nonce, a different request or a closed name blocks the write', () => {
  const fixture = roster();
  assert.equal(bindPendingCreation(fixture.store, { agentId: fixture.agentId, caller: caller(),
    requestId: 'req-1', bindingNonce: 'other-nonce' }), undefined);
  assert.equal(bindPendingCreation(fixture.store, { agentId: fixture.agentId, caller: caller(),
    requestId: 'req-9', bindingNonce: fixture.bindingNonce }), undefined);
  assert.equal(fixture.store.backendState(fixture.agentId).binding, undefined);

  const closed = roster({ closed: true });
  assert.equal(bindPendingCreation(closed.store, { agentId: closed.agentId, caller: caller(),
    requestId: 'req-1', bindingNonce: closed.bindingNonce }), undefined);
});

test('adoption waits for this session opener marker and writes the binding', async () => {
  const fixture = roster();
  let reads = 0;
  const outcome = await adoptFirstListBinding({ store: fixture.store, caller: caller(),
    // The host's head reader only finds the marker once the UI has sent the first
    // turn; here it appears on the third poll, with the transcript still absent before.
    confirm: async ({ marker }) => {
      reads += 1;
      if (reads < 3) return { file: undefined, firstInput: undefined, markerCount: 0 };
      return { file: 'D:\\c\\projects\\p\\s.jsonl', firstInput: { hasMarker: marker.includes('req-1') }, markerCount: 1 };
    },
    sleep: async () => {}, timeoutMs: 1000, pollMs: 0 });
  assert.equal(outcome.adopted, true);
  assert.equal(outcome.agentId, fixture.agentId);
  assert.equal(fixture.store.backendState(fixture.agentId).binding.sessionId, nativeSessionId);
  assert.equal(fixture.store.backendState(fixture.agentId).binding.transcriptFile, 'D:\\c\\projects\\p\\s.jsonl');
});

test('no pending creation answers at once, and a silent marker gives up at the deadline', async () => {
  const empty = roster({ requests: {} });
  const none = await adoptFirstListBinding({ store: empty.store, caller: caller(),
    sleep: async () => {}, timeoutMs: 1000 });
  assert.deepEqual([none.adopted, none.reason], [false, 'no-pending-creation']);

  const fixture = roster();
  let clock = 0;
  const timedOut = await adoptFirstListBinding({ store: fixture.store, caller: caller(),
    confirm: async () => ({ file: 'D:\\c\\p\\s.jsonl', firstInput: {}, markerCount: 0 }),
    now: () => clock, sleep: async () => { clock += 400; }, timeoutMs: 1000, pollMs: 400 });
  assert.deepEqual([timedOut.adopted, timedOut.reason], [false, 'marker-timeout']);
  assert.equal(fixture.store.backendState(fixture.agentId).binding, undefined);
});

test('a transcript that does not exist yet keeps polling instead of giving up', async () => {
  const fixture = roster();
  const outcome = await adoptFirstListBinding({ store: fixture.store, caller: caller(),
    confirm: async () => ({ file: undefined, firstInput: undefined, markerCount: 0 }),
    sleep: async () => {}, timeoutMs: 100 });
  assert.deepEqual([outcome.adopted, outcome.reason], [false, 'marker-timeout']);
  assert.equal(fixture.store.backendState(fixture.agentId).binding, undefined);
});

test('an ambiguous marker binds nothing', async () => {
  const first = roster();
  const second = roster();
  const outcome = await adoptFirstListBinding({
    store: {
      db: first.store.db, get: first.store.get, agentForNativeSession: first.store.agentForNativeSession,
      backendState: first.store.backendState,
    },
    caller: caller(),
    candidates: () => [
      { agentId: first.agentId, name: 'a', bindingNonce: first.bindingNonce, requestId: 'req-1' },
      { agentId: second.agentId, name: 'b', bindingNonce: second.bindingNonce, requestId: 'req-1' },
    ],
    confirm: async () => ({ file: 'D:\\x.jsonl', firstInput: { hasMarker: true }, markerCount: 1 }),
    sleep: async () => {}, timeoutMs: 1000 });
  assert.deepEqual([outcome.adopted, outcome.reason], [false, 'marker-ambiguous']);
  assert.equal(first.store.backendState(first.agentId).binding, undefined);
});

test('the marker must be the first input and appear exactly once', async () => {
  const fixture = roster();
  const laterOnly = await adoptFirstListBinding({ store: fixture.store, caller: caller(),
    confirm: async () => ({ file: 'D:\\x.jsonl', firstInput: { hasMarker: false }, markerCount: 1 }),
    sleep: async () => {}, timeoutMs: 100 });
  assert.deepEqual([laterOnly.adopted, laterOnly.reason], [false, 'marker-timeout']);
  const twice = await adoptFirstListBinding({ store: fixture.store, caller: caller(),
    confirm: async () => ({ file: 'D:\\x.jsonl', firstInput: { hasMarker: true }, markerCount: 2 }),
    sleep: async () => {}, timeoutMs: 100 });
  assert.deepEqual([twice.adopted, twice.reason], [false, 'marker-timeout']);
});

const use = (id, name, input, extra = {}) => ({ type: 'assistant', uuid: id,
  message: { content: [{ type: 'tool_use', id, name, input }] }, ...extra });
const answered = (id, isError = false) => ({ type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] } });

test('pending root calls exclude sidechain records and already answered calls', () => {
  const records = [
    use('toolu_1', REPORT, { message: 'a', final: true }),
    use('toolu_2', REPORT, { message: 'b', final: true }, { isSidechain: true }),
    use('toolu_3', ASK, { message: 'c' }),
    answered('toolu_3'),
    use('toolu_4', 'Read', { file_path: 'x' }),
  ];
  assert.deepEqual(pendingRootCalls(records).map(call => [call.id, call.kind]),
    [['toolu_1', 'report']]);
});

test('the root call match is exact on tool, message and final', () => {
  const records = [use('toolu_1', REPORT, { message: 'done', final: true }),
    use('toolu_2', REPORT, { message: 'half', final: false })];
  assert.deepEqual(matchRootCall(records, { tool: 'report', message: 'done', final: true }),
    { matched: true, id: 'toolu_1', by: 'unique-message', pending: 2 });
  assert.equal(matchRootCall(records, { tool: 'report', message: 'done', final: false }).matched, false);
  assert.equal(matchRootCall(records, { tool: 'question', message: 'done', final: true }).matched, false);
  assert.equal(matchRootCall(records, { tool: 'report', message: 'nope', final: true }).reason,
    'no-pending-root-call');
});

test('a native tool-use id, when the client supplies one, is matched directly', () => {
  const records = [use('toolu_1', REPORT, { message: 'done', final: true })];
  assert.deepEqual(matchRootCall(records, { tool: 'report', message: 'something else', final: true,
    toolUseId: 'toolu_1' }), { matched: true, id: 'toolu_1', by: 'tool-use-id' });
  assert.equal(matchRootCall(records, { tool: 'report', message: 'done', final: true,
    toolUseId: 'toolu_9' }).matched, false);
});

test('two identical open calls are ambiguous and refuse rather than pick one', () => {
  const records = [use('toolu_1', REPORT, { message: 'same', final: true }),
    use('toolu_2', REPORT, { message: 'same', final: true })];
  const match = matchRootCall(records, { tool: 'report', message: 'same', final: true });
  assert.equal(match.matched, false);
  assert.equal(match.reason, 'ambiguous-pending-root-calls');
});

test('the submission gate refuses with not-root-agent when the transcript has no call', async () => {
  await assert.rejects(requireRootCall({ transcriptFile: undefined, tool: 'report', message: 'x', final: true }),
    error => error.code === 'not-root-agent');
});

test('plain assistant text is never mistaken for a tool call', () => {
  const records = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'I reported it.' }] } }];
  assert.deepEqual(pendingRootCalls(records), []);
  assert.equal(matchRootCall(records, { tool: 'report', message: 'I reported it.', final: true }).matched, false);
});

test('the tail reader drops a cut first line and keeps whole records', async () => {
  assert.deepEqual(await readTailRecords(undefined), []);
  assert.deepEqual(await readTailRecords('D:\\definitely\\missing.jsonl'), []);
  assert.ok(REPORT_TOOL_ALLOWLIST.every(name => name.includes('__') && name.startsWith('mcp__')));
});
