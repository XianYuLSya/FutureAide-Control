import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { emptyClaudeProjection, observeClaudeTranscript } from '../src/claude-observer.mjs';
import { readClaudeEvents } from '../src/claude-inbox.mjs';
import { cancelClaudeTree, claudeNodeId, claudeTreeNodeMessages, claudeTreeStopEvidence,
  emptyClaudeTreeState, observeClaudeTree, TREE_PROTOCOL } from '../src/claude-tree.mjs';

const line = value => `${JSON.stringify(value)}\n`;
const assistant = (sessionId, content, { stopReason, sidechain = false } = {}) => line({
  type: 'assistant', sessionId, uuid: `uuid-${Math.random().toString(16).slice(2)}`, timestamp: 'time',
  isSidechain: sidechain, message: { role: 'assistant', model: 'claude-x', content,
    ...(stopReason ? { stop_reason: stopReason } : {}) } });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (sessionId, text, options) => assistant(sessionId, [{ type: 'text', text }], options);
const toolResult = (sessionId, toolUseId, { toolUseResult, sidechain = false } = {}) => line({
  type: 'user', sessionId, timestamp: 'time', isSidechain: sidechain,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: false, content: 'ok' }] },
  ...(toolUseResult ? { toolUseResult } : {}) });

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = '9f1c1b0e-1111-4a2b-9c3d-000000000001';
  const project = path.join(root, 'projects', '-D-Work-project');
  const sessionDirectory = path.join(project, sessionId);
  await mkdir(path.join(sessionDirectory, 'subagents'), { recursive: true });
  const transcriptFile = path.join(project, `${sessionId}.jsonl`);
  return { root, sessionId, project, sessionDirectory, transcriptFile,
    binding: { sessionId, transcriptFile },
    subagent: agentId => path.join(sessionDirectory, 'subagents', `agent-${agentId}.jsonl`) };
}

const treeOptions = (f, overrides = {}) => ({ logicalSessionId: 'logical-1', agentId: 'root-native',
  name: 'root-agent', workspace: f.root, taskId: 'task-1', ...overrides });

async function rootProjection(f) {
  const projection = emptyClaudeProjection('task-1');
  await observeClaudeTranscript(f.binding, projection, { workspace: f.root, agentId: 'root-native' });
  return projection;
}

test('a foreground Agent result pairs one child transcript and settles the tree', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('a1'), reply(f.sessionId, 'short reply', { stopReason: 'end_turn' })
    + assistant(f.sessionId, [toolUse('toolu_w', 'Write', { file_path: 'child.txt', content: 'x' })])
    + toolResult(f.sessionId, 'toolu_w', {}));
  await writeFile(f.transcriptFile,
    assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'child one', prompt: 'hi', run_in_background: false })])
    + toolResult(f.sessionId, 'toolu_a', { toolUseResult: { agentId: 'a1', status: 'completed' } })
    + reply(f.sessionId, 'done', { stopReason: 'end_turn' }));

  const projection = await rootProjection(f);
  const { tree, state, histories } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(TREE_PROTOCOL, 1);
  assert.equal(tree.nodes.length, 2);
  assert.deepEqual({ sessionId: tree.nodes[0].sessionId, parent: tree.nodes[0].parentSessionId,
    status: tree.nodes[0].status }, { sessionId: 'logical-1', parent: null, status: 'ended' });
  const child = tree.nodes[1];
  assert.equal(child.sessionId, claudeNodeId('a1'));
  assert.equal(child.parentSessionId, 'logical-1');
  assert.equal(child.name, 'child one');
  assert.equal(child.status, 'ended');
  assert.equal(child.evidence, 'parent-agent-tool-result');
  assert.deepEqual(child.changes.map(change => change.operation), ['create']);
  assert.equal(tree.settled, true);
  assert.equal(tree.running, false);
  assert.equal(state.nodes.a1.file, f.subagent('a1'));

  const history = claudeTreeNodeMessages(tree, { name: 'child one' });
  assert.equal(history.found, true);
  assert.ok(history.messages.some(message => message.text === 'short reply'));
  // The adapter serves non-root history only from these per-node entries.
  assert.deepEqual(Object.keys(histories), [claudeNodeId('a1')]);
  assert.ok(histories[claudeNodeId('a1')].messages.some(message => message.text === 'short reply'));
  assert.equal(claudeTreeStopEvidence(tree, { afterSeq: 0 }).stopped, true);
});

test('an Agent tool without a result is running and never settles', async t => {
  const f = await fixture(t);
  await writeFile(f.transcriptFile,
    assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'pending child', prompt: 'hi' })]));
  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(tree.nodes.length, 1, 'no child exists until a successful result names its native agentId');
  assert.equal(tree.running, true);
  assert.equal(tree.settled, false);
  assert.deepEqual(tree.nodes[0].pendingAgentTools, ['toolu_a']);
  assert.deepEqual(claudeTreeStopEvidence(tree).pendingAgentTools, ['toolu_a']);
});

test('a background child stays unsettled until its own transcript stops growing', async t => {
  const f = await fixture(t);
  const child = f.subagent('b1');
  await writeFile(child, assistant(f.sessionId, [toolUse('toolu_b', 'Bash', { command: 'sleep' })])
    + toolResult(f.sessionId, 'toolu_b', {}));
  await writeFile(f.transcriptFile,
    assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'background child', prompt: 'hi', run_in_background: true })])
    + toolResult(f.sessionId, 'toolu_a', { toolUseResult: { agentId: 'b1', isAsync: true, status: 'async' } })
    + reply(f.sessionId, 'launched', { stopReason: 'end_turn' }));

  let saved = emptyClaudeTreeState();
  let projection = await rootProjection(f);
  let result = await observeClaudeTree(f.binding, projection, treeOptions(f, { state: saved }));
  assert.equal(result.tree.nodes[1].status, 'running');
  assert.equal(result.tree.nodes[1].evidence, 'no-completed-turn');
  assert.equal(result.tree.settled, false);

  await appendFile(child, reply(f.sessionId, 'background finished', { stopReason: 'end_turn' }));
  saved = result.state;
  projection = await rootProjection(f);
  result = await observeClaudeTree(f.binding, projection, treeOptions(f, { state: saved }));
  assert.equal(result.tree.nodes[1].status, 'running', 'a background turn end alone is not proof the child stopped');
  assert.equal(result.tree.nodes[1].evidence, 'turn-ended-unconfirmed');

  saved = result.state;
  projection = await rootProjection(f);
  result = await observeClaudeTree(f.binding, projection, treeOptions(f, { state: saved }));
  assert.equal(result.tree.nodes[1].status, 'ended');
  assert.equal(result.tree.settled, true);
});

test('a grandchild is found through its own Agent pair and keeps the parent chain', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('g1'), reply(f.sessionId, 'grandchild reply', { stopReason: 'end_turn' }));
  await writeFile(f.subagent('a1'),
    assistant(f.sessionId, [toolUse('toolu_g', 'Task', { description: 'grandchild', prompt: 'hi' })])
    + toolResult(f.sessionId, 'toolu_g', { toolUseResult: { agentId: 'g1', status: 'completed' } })
    + reply(f.sessionId, 'child done', { stopReason: 'end_turn' }));
  await writeFile(f.transcriptFile,
    assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'child one', prompt: 'hi' })])
    + toolResult(f.sessionId, 'toolu_a', { toolUseResult: { agentId: 'a1', status: 'completed' } })
    + reply(f.sessionId, 'done', { stopReason: 'end_turn' }));

  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.deepEqual(tree.nodes.map(node => [node.sessionId, node.parentSessionId, node.depth]),
    [['logical-1', null, 0], [claudeNodeId('a1'), 'logical-1', 1], [claudeNodeId('g1'), claudeNodeId('a1'), 2]]);
  assert.equal(tree.settled, true);
  assert.ok(claudeTreeNodeMessages(tree, { name: 'grandchild' }).messages.some(message => message.text === 'grandchild reply'));
});

test('a transcript outside this session directory is never used', async t => {
  const f = await fixture(t);
  const foreign = path.join(f.root, 'projects', '-D-Work-other', 'aaaaaaaa-2222-4a2b-9c3d-000000000002', 'subagents');
  await mkdir(foreign, { recursive: true });
  await writeFile(path.join(foreign, 'agent-x1.jsonl'), reply('aaaaaaaa-2222-4a2b-9c3d-000000000002', 'foreign', { stopReason: 'end_turn' }));
  await writeFile(f.transcriptFile,
    assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'elsewhere', prompt: 'hi', run_in_background: true })])
    + toolResult(f.sessionId, 'toolu_a', { toolUseResult: { agentId: 'x1', isAsync: true, status: 'async' } })
    + reply(f.sessionId, 'launched', { stopReason: 'end_turn' }));

  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(tree.nodes[1].status, 'unverified');
  assert.equal(tree.nodes[1].evidence, 'missing-transcript');
  assert.deepEqual(tree.unverified, [claudeNodeId('x1')]);
  assert.equal(tree.settled, false);
  assert.equal(typeof tree.limitation, 'string');
  assert.equal(claudeTreeStopEvidence(tree).stopped, false);
});

test('cursors are incremental and a saved state never duplicates a node effect', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('a1'), reply(f.sessionId, 'child reply', { stopReason: 'end_turn' }));
  await writeFile(f.transcriptFile,
    assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'child one', prompt: 'hi' })])
    + toolResult(f.sessionId, 'toolu_a', { toolUseResult: { agentId: 'a1', status: 'completed' } })
    + reply(f.sessionId, 'done', { stopReason: 'end_turn' }));
  const calls = [];
  const readEvents = async (binding, page) => {
    calls.push([path.basename(binding.transcriptFile), page.offset]);
    return readClaudeEvents(binding, page);
  };
  let projection = await rootProjection(f);
  const first = await observeClaudeTree(f.binding, projection, treeOptions(f, { readEvents }));
  calls.length = 0;
  projection = await rootProjection(f);
  const second = await observeClaudeTree(f.binding, projection, treeOptions(f, { state: first.state, readEvents }));
  assert.deepEqual(calls, [['agent-a1.jsonl', first.state.nodes.a1.projection.throughSeq]]);
  assert.ok(first.state.nodes.a1.projection.throughSeq > 0);
  assert.equal(second.tree.settled, true);
  assert.deepEqual(second.state.order, first.state.order);
});

test('a sidechain-marked child transcript is read with the marker its own lines carry', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('a1'),
    assistant(f.sessionId, [toolUse('toolu_b', 'Bash', { command: 'ls' })], { sidechain: true }));
  await writeFile(f.transcriptFile,
    assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'sidechain child', prompt: 'hi', run_in_background: true })])
    + toolResult(f.sessionId, 'toolu_a', { toolUseResult: { agentId: 'a1', isAsync: true, status: 'async' } })
    + reply(f.sessionId, 'launched', { stopReason: 'end_turn' }));
  const projection = await rootProjection(f);
  const { tree, state } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(state.nodes.a1.sidechain, true);
  assert.equal(tree.nodes[1].status, 'running');
  assert.equal(tree.nodes[1].evidence, 'pending-tool');
});

test('native agent meta finishes a child that never writes an end_turn', async t => {
  const f = await fixture(t);
  // Measured on Claude Desktop 2.1.309: a subagent may end with SubagentHandback
  // and a tool_result, and only its meta.json says the work is finished.
  await writeFile(f.subagent('a1'),
    assistant(f.sessionId, [{ type: 'text', text: 'working' }], { sidechain: true })
    + assistant(f.sessionId, [toolUse('toolu_h', 'SubagentHandback', { result: 'short reply' })], { sidechain: true })
    + toolResult(f.sessionId, 'toolu_h', { sidechain: true }));
  await writeFile(f.subagent('a1').replace(/\.jsonl$/, '.meta.json'), JSON.stringify({
    agentType: 'general-purpose', description: 'native child', toolUseId: 'toolu_a', spawnDepth: 1,
    requestShape: 'background', finished: true }));
  await writeFile(f.transcriptFile,
    assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'native child', prompt: 'hi' })])
    + toolResult(f.sessionId, 'toolu_a', { toolUseResult: { agentId: 'a1', isAsync: true, status: 'async_launched' } })
    + reply(f.sessionId, 'launched', { stopReason: 'end_turn' }));
  const projection = await rootProjection(f);
  const { tree, state } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(tree.nodes[1].status, 'ended');
  assert.equal(tree.nodes[1].evidence, 'agent-meta-finished');
  assert.equal(tree.nodes[1].nativeDepth, 1);
  assert.equal(tree.nodes[1].agentType, 'general-purpose');
  assert.equal(tree.settled, true);
  assert.equal(state.nodes.a1.meta.finished, true);
  assert.equal(claudeTreeStopEvidence(tree, { afterSeq: 0 }).stopped, true);
});

test('a native meta that names another Agent tool is never settled', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('a1'), reply(f.sessionId, 'short reply', { stopReason: 'end_turn', sidechain: true }));
  await writeFile(f.subagent('a1').replace(/\.jsonl$/, '.meta.json'), JSON.stringify({
    agentType: 'general-purpose', toolUseId: 'toolu_other', spawnDepth: 1, finished: true }));
  await writeFile(f.transcriptFile,
    assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'native child', prompt: 'hi' })])
    + toolResult(f.sessionId, 'toolu_a', { toolUseResult: { agentId: 'a1', isAsync: true, status: 'async_launched' } })
    + reply(f.sessionId, 'launched', { stopReason: 'end_turn' }));
  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(tree.nodes[1].status, 'unverified');
  assert.equal(tree.nodes[1].evidence, 'agent-pairing-mismatch');
  assert.equal(tree.settled, false);
});

test('an unbound root is refused instead of producing an empty tree', async () => {
  await assert.rejects(observeClaudeTree({}, emptyClaudeProjection('task-1'), { logicalSessionId: 'logical-1' }),
    /transcript file/i);
  await assert.rejects(observeClaudeTree({ sessionId: 's', transcriptFile: 'f' }, emptyClaudeProjection('task-1'), {}),
    /logical session id/i);
});

test('state defaults to a fresh tree and cancelClaudeTree only reports proven stops', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('a1'), reply(f.sessionId, 'short reply', { stopReason: 'end_turn', sidechain: true }));
  await writeFile(f.subagent('a1').replace(/\.jsonl$/, '.meta.json'), JSON.stringify({
    agentType: 'general-purpose', toolUseId: 'toolu_a', spawnDepth: 1, finished: true }));
  await writeFile(f.transcriptFile,
    assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'native child', prompt: 'hi' })])
    + toolResult(f.sessionId, 'toolu_a', { toolUseResult: { agentId: 'a1', isAsync: true, status: 'async_launched' } })
    + reply(f.sessionId, 'launched', { stopReason: 'end_turn' }));
  let projection = await rootProjection(f);
  // No `state` argument at all: the caller's first observation after a new task.
  const first = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(first.tree.settled, true);
  assert.deepEqual(Object.keys(first.state.nodes), ['a1']);

  const cancelled = await cancelClaudeTree(f.binding, projection, treeOptions(f, { state: first.state, afterSeq: 0 }));
  assert.equal(cancelled.stopped, true);
  assert.deepEqual(cancelled.remaining, []);
  assert.equal(cancelled.method, 'observe-only');
  // A cancellation point after every node's last event cannot be proven stopped.
  const late = await cancelClaudeTree(f.binding, projection, treeOptions(f, { state: cancelled.state, afterSeq: 10 ** 9 }));
  assert.equal(late.stopped, false);
  assert.ok(late.evidence.limitation);
});
