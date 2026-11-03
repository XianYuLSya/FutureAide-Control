import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { emptyClaudeProjection, observeClaudeTranscript } from '../src/claude-observer.mjs';
import { readClaudeEvents } from '../src/claude-inbox.mjs';
import { cancelClaudeTree, claudeNodeId, claudeTreeNodeMessages, claudeTreeStopEvidence,
  claudeTreeStopTargets, emptyClaudeTreeState, observeClaudeTree, TREE_PROTOCOL } from '../src/claude-tree.mjs';

const line = value => `${JSON.stringify(value)}\n`;
const assistant = (sessionId, content, { stopReason, sidechain = false, agentId } = {}) => line({
  type: 'assistant', sessionId, uuid: `uuid-${Math.random().toString(16).slice(2)}`, timestamp: 'time',
  isSidechain: sidechain, ...(agentId ? { agentId } : {}),
  message: { role: 'assistant', model: 'claude-x', content,
    ...(stopReason ? { stop_reason: stopReason } : {}) } });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (sessionId, text, options) => assistant(sessionId, [{ type: 'text', text }], options);
const toolResult = (sessionId, toolUseId, { toolUseResult, sidechain = false, agentId, isError = false } = {}) => line({
  type: 'user', sessionId, timestamp: 'time', isSidechain: sidechain, ...(agentId ? { agentId } : {}),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: isError ? 'failed' : 'ok' }] },
  ...(toolUseResult ? { toolUseResult } : {}) });
const launched = (id, description, { background = true, agentId } = {}) => [
  assistant('', [toolUse(id, 'Agent', { description, prompt: 'hi', ...(background ? {} : { run_in_background: false }) })]),
  toolResult('', id, { toolUseResult: { agentId, ...(background ? { isAsync: true, status: 'async_launched' } : { status: 'completed' }) } })];

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'claude-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = '9f1c1b0e-1111-4a2b-9c3d-000000000001';
  const project = path.join(root, 'projects', '-D-Work-project');
  const sessionDirectory = path.join(project, sessionId);
  await mkdir(path.join(sessionDirectory, 'subagents'), { recursive: true });
  const transcriptFile = path.join(project, `${sessionId}.jsonl`);
  const f = { root, sessionId, project, sessionDirectory, transcriptFile,
    binding: { sessionId, transcriptFile },
    subagent: agentId => path.join(sessionDirectory, 'subagents', `agent-${agentId}.jsonl`),
    meta: agentId => path.join(sessionDirectory, 'subagents', `agent-${agentId}.meta.json`),
    // Root transcript helper: children live in the root session, so the fixture
    // writes the same sessionId but never a child agentId.
    rootLines: parts => parts.join('').replaceAll('"sessionId":""', `"sessionId":"${sessionId}"`),
    writeRoot: async parts => {
      const body = parts.join('').replaceAll('"sessionId":""', `"sessionId":"${sessionId}"`);
      await writeFile(transcriptFile, body);
    } };
  return f;
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
  await writeFile(f.subagent('a1'), reply(f.sessionId, 'short reply', { stopReason: 'end_turn', sidechain: true, agentId: 'a1' })
    + assistant(f.sessionId, [toolUse('toolu_w', 'Write', { file_path: 'child.txt', content: 'x' })], { sidechain: true, agentId: 'a1' })
    + toolResult(f.sessionId, 'toolu_w', { sidechain: true, agentId: 'a1' }));
  await f.writeRoot([...launched('toolu_a', 'child one', { background: false, agentId: 'a1' }),
    reply(f.sessionId, 'done', { stopReason: 'end_turn' })]);

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
  assert.deepEqual(Object.keys(histories), [claudeNodeId('a1')]);
  assert.ok(histories[claudeNodeId('a1')].messages.some(message => message.text === 'short reply'));
  assert.equal(claudeTreeStopEvidence(tree, { afterSeq: 0 }).stopped, true);
});

test('an Agent tool without a result is running and never settles', async t => {
  const f = await fixture(t);
  await f.writeRoot([assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'pending child', prompt: 'hi' })])]);
  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(tree.nodes.length, 1, 'no child exists until native evidence names its agentId');
  assert.equal(tree.running, true);
  assert.equal(tree.settled, false);
  assert.deepEqual(tree.nodes[0].pendingAgentTools, ['toolu_a']);
  assert.deepEqual(claudeTreeStopEvidence(tree).pendingAgentTools, ['toolu_a']);
});

test('a running child is bound from its own meta while its Agent result is still open', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('b1'), assistant(f.sessionId, [toolUse('toolu_b', 'Bash', { command: 'sleep' })],
    { sidechain: true, agentId: 'b1' }));
  await writeFile(f.meta('b1'), JSON.stringify({ agentType: 'general-purpose', description: 'background child',
    toolUseId: 'toolu_pending', spawnDepth: 1, requestShape: 'background', finished: false }));
  await f.writeRoot([assistant(f.sessionId, [toolUse('toolu_pending', 'Agent', { description: 'background child', prompt: 'hi' })])]);
  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f, { nativeStatus: 'busy' }));
  assert.equal(tree.nodes.length, 2, 'an open Agent tool still binds its child through meta.toolUseId');
  assert.equal(tree.nodes[1].name, 'background child');
  assert.equal(tree.nodes[1].status, 'running');
  assert.equal(tree.nodes[1].evidence, 'pending-tool');
  assert.equal(tree.settled, false);
});

test('a background child without meta needs a successful handback, never quiet time', async t => {
  const f = await fixture(t);
  const child = f.subagent('b1');
  await writeFile(child, assistant(f.sessionId, [toolUse('toolu_b', 'Bash', { command: 'sleep' })], { sidechain: true, agentId: 'b1' })
    + toolResult(f.sessionId, 'toolu_b', { sidechain: true, agentId: 'b1' }));
  await f.writeRoot([...launched('toolu_a', 'background child', { agentId: 'b1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);

  let projection = await rootProjection(f);
  let result = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(result.tree.nodes[1].status, 'running');
  assert.equal(result.tree.nodes[1].evidence, 'no-completed-turn');

  // Native transcripts are append-only, so the fixture appends too: rewriting a
  // file under a live byte cursor is not something the runtime can ever see.
  await appendFile(child, assistant(f.sessionId, [toolUse('toolu_h', 'SubagentHandback', { message: 'done' })],
    { sidechain: true, agentId: 'b1' }));
  projection = await rootProjection(f);
  result = await observeClaudeTree(f.binding, projection, treeOptions(f, { state: result.state }));
  assert.equal(result.tree.nodes[1].status, 'running', 'an unanswered handback is not a finished subagent');

  await appendFile(child, toolResult(f.sessionId, 'toolu_h', { sidechain: true, agentId: 'b1' }));
  projection = await rootProjection(f);
  result = await observeClaudeTree(f.binding, projection, treeOptions(f, { state: result.state }));
  assert.equal(result.tree.nodes[1].status, 'ended');
  assert.equal(result.tree.nodes[1].evidence, 'subagent-handback');
  assert.equal(result.tree.settled, true);
});

test('a failed handback never ends a node', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('b1'), assistant(f.sessionId, [], { sidechain: true, agentId: 'b1' })
    + assistant(f.sessionId, [toolUse('toolu_h', 'SubagentHandback', { message: 'x' })], { sidechain: true, agentId: 'b1' })
    + toolResult(f.sessionId, 'toolu_h', { sidechain: true, agentId: 'b1', isError: true }));
  await writeFile(f.meta('b1'), JSON.stringify({ toolUseId: 'toolu_a', finished: false, requestShape: 'background' }));
  await f.writeRoot([...launched('toolu_a', 'failing child', { agentId: 'b1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);
  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(tree.nodes[1].status, 'running');
  assert.equal(tree.settled, false);
});

test('a grandchild is found through its own Agent pair and keeps the parent chain', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('g1'), reply(f.sessionId, 'grandchild reply', { stopReason: 'end_turn', sidechain: true, agentId: 'g1' }));
  await writeFile(f.subagent('a1'), assistant(f.sessionId, [toolUse('toolu_g', 'Task', { description: 'grandchild', prompt: 'hi' })], { sidechain: true, agentId: 'a1' })
    + toolResult(f.sessionId, 'toolu_g', { toolUseResult: { agentId: 'g1', status: 'completed' }, sidechain: true, agentId: 'a1' })
    + reply(f.sessionId, 'child done', { stopReason: 'end_turn', sidechain: true, agentId: 'a1' }));
  await writeFile(f.meta('a1'), JSON.stringify({ agentType: 'general-purpose', description: 'child one',
    toolUseId: 'toolu_a', spawnDepth: 1, requestShape: 'background', finished: true }));
  await f.writeRoot([...launched('toolu_a', 'child one', { agentId: 'a1' }),
    reply(f.sessionId, 'done', { stopReason: 'end_turn' })]);

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
  await writeFile(path.join(foreign, 'agent-x1.jsonl'),
    reply('aaaaaaaa-2222-4a2b-9c3d-000000000002', 'foreign', { stopReason: 'end_turn', sidechain: true, agentId: 'x1' }));
  await writeFile(path.join(foreign, 'agent-x1.meta.json'), JSON.stringify({ toolUseId: 'toolu_a', finished: true }));
  await f.writeRoot([...launched('toolu_a', 'elsewhere', { agentId: 'x1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);

  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(tree.nodes[1].status, 'unverified');
  assert.equal(tree.nodes[1].evidence, 'missing-transcript');
  assert.deepEqual(tree.unverified, [claudeNodeId('x1')]);
  assert.equal(tree.settled, false);
  assert.equal(typeof tree.limitation, 'string');
  assert.equal(claudeTreeStopEvidence(tree).stopped, false);
});

test('a transcript that names another session or agent is refused', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('a1'), reply('cccccccc-3333-4a2b-9c3d-000000000003', 'other session',
    { stopReason: 'end_turn', sidechain: true, agentId: 'a1' }));
  await f.writeRoot([...launched('toolu_a', 'foreign session child', { agentId: 'a1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);
  let projection = await rootProjection(f);
  let tree = (await observeClaudeTree(f.binding, projection, treeOptions(f))).tree;
  assert.equal(tree.nodes[1].status, 'unverified');
  assert.equal(tree.nodes[1].evidence, 'agent-identity-mismatch');
  assert.equal(tree.settled, false);

  await writeFile(f.subagent('a1'), reply(f.sessionId, 'wrong agent', { stopReason: 'end_turn', sidechain: true, agentId: 'someone-else' }));
  projection = await rootProjection(f);
  tree = (await observeClaudeTree(f.binding, projection, treeOptions(f))).tree;
  assert.equal(tree.nodes[1].evidence, 'agent-identity-mismatch');
  assert.equal(tree.settled, false);
});

test('cursors are incremental and a saved state never duplicates a node effect', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('a1'), reply(f.sessionId, 'child reply', { stopReason: 'end_turn', sidechain: true, agentId: 'a1' }));
  await writeFile(f.meta('a1'), JSON.stringify({ toolUseId: 'toolu_a', spawnDepth: 1, finished: true }));
  await f.writeRoot([...launched('toolu_a', 'child one', { agentId: 'a1' }),
    reply(f.sessionId, 'done', { stopReason: 'end_turn' })]);
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
    assistant(f.sessionId, [toolUse('toolu_b', 'Bash', { command: 'ls' })], { sidechain: true, agentId: 'a1' }));
  await f.writeRoot([...launched('toolu_a', 'sidechain child', { agentId: 'a1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);
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
    assistant(f.sessionId, [{ type: 'text', text: 'working' }], { sidechain: true, agentId: 'a1' })
    + assistant(f.sessionId, [toolUse('toolu_h', 'SubagentHandback', { result: 'short reply' })], { sidechain: true, agentId: 'a1' })
    + toolResult(f.sessionId, 'toolu_h', { sidechain: true, agentId: 'a1' }));
  await writeFile(f.meta('a1'), JSON.stringify({ agentType: 'general-purpose', description: 'native child',
    toolUseId: 'toolu_a', spawnDepth: 1, requestShape: 'background', finished: true }));
  await f.writeRoot([...launched('toolu_a', 'native child', { agentId: 'a1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);
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
  await writeFile(f.subagent('a1'), reply(f.sessionId, 'short reply', { stopReason: 'end_turn', sidechain: true, agentId: 'a1' }));
  await writeFile(f.meta('a1'), JSON.stringify({ agentType: 'general-purpose',
    toolUseId: 'toolu_other', spawnDepth: 1, finished: true }));
  await f.writeRoot([...launched('toolu_a', 'native child', { agentId: 'a1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);
  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(tree.nodes[1].status, 'unverified');
  assert.equal(tree.nodes[1].evidence, 'agent-pairing-mismatch');
  assert.equal(tree.settled, false);
});

test('no default node or depth cap drops a child, and paging keeps it visible', async t => {
  const f = await fixture(t);
  const parts = [];
  for (let index = 0; index < 40; index++) {
    const agentId = `bulk${index}`;
    await writeFile(f.subagent(agentId), reply(f.sessionId, `reply ${index}`, { stopReason: 'end_turn', sidechain: true, agentId }));
    await writeFile(f.meta(agentId), JSON.stringify({ description: `child ${index}`,
      toolUseId: `toolu_bulk${index}`, spawnDepth: 1, requestShape: 'foreground', finished: true }));
    parts.push(...launched(`toolu_bulk${index}`, `child ${index}`, { agentId, background: false }));
  }
  await f.writeRoot([...parts, reply(f.sessionId, 'done', { stopReason: 'end_turn' })]);
  const projection = await rootProjection(f);
  const all = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(all.tree.nodes.length, 41, 'every discovered child is observed by default');
  assert.equal(all.tree.settled, true);
  assert.equal(all.tree.truncated, undefined);

  // An explicit page is allowed, but a paged-out child is unverified, not ended.
  const paged = await observeClaudeTree(f.binding, projection, treeOptions(f, { maxNodes: 2 }));
  assert.equal(paged.tree.nodes.length, 41);
  assert.ok(paged.tree.nodes.slice(3).every(node => node.status === 'unverified'));
  assert.equal(paged.tree.settled, false);
  assert.ok(paged.tree.truncated >= 38);
});

test('node changes are reported whole, not sliced', async t => {
  const f = await fixture(t);
  let child = '';
  for (let index = 0; index < 30; index++) {
    child += assistant(f.sessionId, [toolUse(`toolu_w${index}`, 'Write', { file_path: `file-${index}.txt`, content: 'x' })],
      { sidechain: true, agentId: 'a1' });
    child += toolResult(f.sessionId, `toolu_w${index}`, { sidechain: true, agentId: 'a1' });
  }
  await writeFile(f.subagent('a1'), child);
  await writeFile(f.meta('a1'), JSON.stringify({ toolUseId: 'toolu_a', finished: true, spawnDepth: 1 }));
  await f.writeRoot([...launched('toolu_a', 'many writes', { agentId: 'a1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);
  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(tree.nodes[1].changes.length, 30);
});

test('a root interrupt with a stale pending tool still stops the tree', async t => {
  const f = await fixture(t);
  await f.writeRoot([
    assistant(f.sessionId, [toolUse('toolu_a', 'Agent', { description: 'never answered', prompt: 'hi' })]),
    line({ type: 'user', sessionId: f.sessionId, timestamp: 'time', uuid: 'uuid-int',
      message: { role: 'user', content: '[Request interrupted by user]' } })]);
  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f, { nativeStatus: 'idle' }));
  assert.equal(tree.nodes[0].status, 'ended', 'registry idle is authoritative for the root turn');
  assert.equal(tree.running, false);
  assert.equal(tree.settled, true);
  // The stale call predates the interrupt, so it is no longer open work — while
  // the observer still remembers it as an Agent call of this task.
  assert.deepEqual(tree.nodes[0].pendingAgentTools, []);
  assert.deepEqual(Object.keys(projection.agentTools), ['toolu_a']);
  assert.equal(claudeTreeStopEvidence(tree, { afterSeq: 0 }).stopped, true);
});

test('state defaults to a fresh tree and cancelClaudeTree only reports proven stops', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('a1'), reply(f.sessionId, 'short reply', { stopReason: 'end_turn', sidechain: true, agentId: 'a1' }));
  await writeFile(f.meta('a1'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_a', spawnDepth: 1, finished: true }));
  await f.writeRoot([...launched('toolu_a', 'native child', { agentId: 'a1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);
  const projection = await rootProjection(f);
  const first = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(first.tree.settled, true);
  assert.deepEqual(Object.keys(first.state.nodes), ['a1']);

  const cancelled = await cancelClaudeTree(f.binding, projection, treeOptions(f, { state: first.state, afterSeq: 0 }));
  assert.equal(cancelled.stopped, true);
  assert.deepEqual(cancelled.remaining, []);
  assert.equal(cancelled.method, 'observe-only');
  const late = await cancelClaudeTree(f.binding, projection, treeOptions(f, { state: cancelled.state, afterSeq: 10 ** 9 }));
  assert.equal(late.stopped, false);
  assert.ok(late.evidence.limitation);
});

test('agentTools keeps every child even after the message window is trimmed', async t => {
  const f = await fixture(t);
  const parts = [];
  for (let index = 0; index < 40; index++) {
    const agentId = `trim${index}`;
    await writeFile(f.subagent(agentId), reply(f.sessionId, `reply ${index}`, { stopReason: 'end_turn', sidechain: true, agentId }));
    await writeFile(f.meta(agentId), JSON.stringify({ toolUseId: `toolu_trim${index}`, spawnDepth: 1, finished: true }));
    parts.push(...launched(`toolu_trim${index}`, `child ${index}`, { agentId, background: false }));
  }
  await f.writeRoot([...parts, reply(f.sessionId, 'done', { stopReason: 'end_turn' })]);
  const projection = await rootProjection(f);
  assert.equal(Object.keys(projection.agentTools).length, 40);
  // The bounded message window is what the observer trims; the agent ids stay.
  projection.messages = [];
  projection.messagesOmitted = 400;
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.equal(tree.nodes.length, 41);
  assert.equal(tree.settled, true);
});

test('an interrupted child stops counting as running and still pairs its late result', async t => {
  const f = await fixture(t);
  const child = f.subagent('b1');
  await writeFile(child,
    assistant(f.sessionId, [toolUse('toolu_w', 'Write', { file_path: 'late.txt', content: 'x' })], { sidechain: true, agentId: 'b1' })
    + line({ type: 'user', sessionId: f.sessionId, isSidechain: true, agentId: 'b1', timestamp: 'time',
      message: { role: 'user', content: '[Request interrupted by user]' } }));
  await f.writeRoot([...launched('toolu_a', 'interrupted child', { agentId: 'b1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);
  let projection = await rootProjection(f);
  let result = await observeClaudeTree(f.binding, projection, treeOptions(f, { nativeStatus: 'idle' }));
  assert.equal(result.tree.nodes[1].status, 'ended');
  assert.equal(result.tree.nodes[1].evidence, 'agent-interrupted');
  assert.equal(result.tree.settled, true);
  assert.equal(result.tree.running, false);

  // A result that arrives after the interrupt must still be attributed.
  await appendFile(child, toolResult(f.sessionId, 'toolu_w', { sidechain: true, agentId: 'b1' }));
  projection = await rootProjection(f);
  result = await observeClaudeTree(f.binding, projection, treeOptions(f, { nativeStatus: 'idle', state: result.state }));
  assert.equal(result.tree.nodes[1].status, 'ended');
  assert.ok(result.tree.nodes[1].changes.some(change => change.path.endsWith('late.txt')));
  assert.equal(result.tree.settled, true);
});

test('the tool-use interrupt variant from 2.1.309 also stops counting open calls', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('b1'),
    assistant(f.sessionId, [toolUse('toolu_b', 'Bash', { command: 'sleep 90' })], { sidechain: true, agentId: 'b1' })
    + line({ type: 'user', sessionId: f.sessionId, isSidechain: true, agentId: 'b1', timestamp: 'time',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }));
  await f.writeRoot([...launched('toolu_a', 'interrupted child', { agentId: 'b1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);
  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f, { nativeStatus: 'idle' }));
  assert.equal(tree.nodes[1].status, 'ended');
  assert.equal(tree.nodes[1].evidence, 'agent-interrupted');
  assert.equal(tree.settled, true);
});

test('a finished child from an earlier task never enters a new task tree', async t => {
  const f = await fixture(t);
  // Left over from a previous task in the same session: its own transcript and
  // meta are on disk, but this task's transcript never emitted its tool id.
  await writeFile(f.subagent('old1'), reply(f.sessionId, 'old reply', { stopReason: 'end_turn', sidechain: true, agentId: 'old1' }));
  await writeFile(f.meta('old1'), JSON.stringify({ description: 'old child', toolUseId: 'toolu_old',
    spawnDepth: 1, requestShape: 'foreground', finished: true }));
  await writeFile(f.subagent('a1'), reply(f.sessionId, 'reply', { stopReason: 'end_turn', sidechain: true, agentId: 'a1' }));
  await f.writeRoot([...launched('toolu_a', 'current child', { agentId: 'a1', background: false }),
    reply(f.sessionId, 'done', { stopReason: 'end_turn' })]);

  const projection = await rootProjection(f);
  const { tree, state, histories } = await observeClaudeTree(f.binding, projection, treeOptions(f));
  assert.deepEqual(tree.nodes.map(node => node.sessionId), ['logical-1', claudeNodeId('a1')]);
  assert.equal(state.nodes.old1, undefined);
  assert.deepEqual(Object.keys(histories), [claudeNodeId('a1')]);
  assert.deepEqual(tree.unpaired, ['old1'], 'the unpaired meta is reported, never attached');
  assert.equal(tree.settled, true);
});

test('stop targets name the native task id of every unfinished node', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('b1'), assistant(f.sessionId, [toolUse('toolu_b', 'Bash', { command: 'sleep' })],
    { sidechain: true, agentId: 'b1' }));
  await f.writeRoot([...launched('toolu_a', 'still running', { agentId: 'b1' }),
    reply(f.sessionId, 'launched', { stopReason: 'end_turn' })]);
  const projection = await rootProjection(f);
  const { tree } = await observeClaudeTree(f.binding, projection, treeOptions(f, { nativeStatus: 'busy' }));
  assert.deepEqual(claudeTreeStopTargets(tree), [
    { sessionId: 'logical-1', name: 'root-agent', depth: 0, status: 'running', evidence: null, root: true },
    { sessionId: claudeNodeId('b1'), name: 'still running', depth: 1, status: 'running',
      evidence: 'pending-tool', taskId: 'b1' }]);
  const settledTree = { nodes: tree.nodes.map(node => ({ ...node, status: 'ended' })) };
  assert.deepEqual(claudeTreeStopTargets(settledTree), []);
});

test('a finished unpaired meta does not block a stop verdict, an unfinished one does', async t => {
  const f = await fixture(t);
  await writeFile(f.subagent('a1'), reply(f.sessionId, 'reply', { stopReason: 'end_turn', sidechain: true, agentId: 'a1' }));
  await writeFile(f.meta('a1'), JSON.stringify({ toolUseId: 'toolu_a', spawnDepth: 1, finished: true }));
  // Older task leftovers in the same session directory.
  await writeFile(f.subagent('old1'), reply(f.sessionId, 'old', { stopReason: 'end_turn', sidechain: true, agentId: 'old1' }));
  await writeFile(f.meta('old1'), JSON.stringify({ toolUseId: 'toolu_old', spawnDepth: 1, finished: true }));
  await f.writeRoot([...launched('toolu_a', 'current', { agentId: 'a1', background: false }),
    reply(f.sessionId, 'done', { stopReason: 'end_turn' })]);
  let projection = await rootProjection(f);
  let tree = (await observeClaudeTree(f.binding, projection, treeOptions(f))).tree;
  assert.deepEqual(tree.unpaired, ['old1']);
  assert.equal(tree.unpairedRunning, undefined);
  assert.equal(claudeTreeStopEvidence(tree, { afterSeq: 0 }).stopped, true);

  await writeFile(f.meta('old1'), JSON.stringify({ toolUseId: 'toolu_old', spawnDepth: 1, finished: false }));
  projection = await rootProjection(f);
  tree = (await observeClaudeTree(f.binding, projection, treeOptions(f))).tree;
  assert.deepEqual(tree.unpairedRunning, ['old1']);
  assert.equal(tree.settled, false);
  assert.equal(claudeTreeStopEvidence(tree, { afterSeq: 0 }).stopped, false);
});

test('an unbound root is refused instead of producing an empty tree', async () => {
  await assert.rejects(observeClaudeTree({}, emptyClaudeProjection('task-1'), { logicalSessionId: 'logical-1' }),
    /transcript file/i);
  await assert.rejects(observeClaudeTree({ sessionId: 's', transcriptFile: 'f' }, emptyClaudeProjection('task-1'), {}),
    /logical session id/i);
});
