import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  createCodexHost, emptyProjection, projectCodexTurns, readDefaultModel, readCodexMcpRegistration, markerLine,
} from '../src/codex-host.mjs';
import { liveThread, livePage, liveTurn } from './live-thread-fixture.mjs';

const directory = () => fileURLToPath(new URL(`../clean/validation/codex/${randomUUID()}/`, import.meta.url));

test('status uses one real read RPC and keeps each default-model read live', async () => {
  const home = directory(); await mkdir(home, { recursive: true });
  let nativeReads = 0, selected = 'first';
  const host = createCodexHost({ home, nativeRequest: async method => {
    nativeReads++;
    if (method === 'thread/list') return { data: [] };
    if (method === 'config/read') return { model: selected, provider: 'openai', reasoningEffort: 'max' };
    throw new Error('unexpected ' + method);
  } });
  await Promise.all([host.probe(), host.probe()]);
  await host.probe();
  assert.equal(nativeReads, 1, 'the capability read is shared across concurrent probes');
  assert.equal((await host.readDefaultModel({ workspace: home })).model, 'first');
  selected = 'second';
  assert.equal((await host.readDefaultModel({ workspace: home })).model, 'second');
  assert.equal(nativeReads, 3);
  const uncached = createCodexHost({ home, probeCacheMs: 0, nativeRequest: async method => {
    nativeReads++;
    if (method === 'thread/list') return { data: [] };
    return { model: 'x', reasoningEffort: 'max' };
  } });
  await uncached.probe(); await uncached.probe();
  assert.equal(nativeReads, 5);
});

test('a missing debug port is reported with the FAswitch instruction', async () => {
  const host = createCodexHost({ nativeRequest: async () => {
    throw Object.assign(new Error('Exactly one running Codex main renderer must be available.'),
      { code: 'codex-native-rpc-unavailable' });
  } });
  await assert.rejects(host.probe(), error => error.code === 'codex-native-rpc-unavailable'
    && /Open Codex from FAswitch/.test(error.message));
});

test('schema-shaped turns project marker, messages and file changes incrementally', () => {
  const marker = markerLine('r', 'nonce');
  const turns = [{ id: 'turn-1', status: 'inProgress', startedAt: 1, items: [
    { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: `${marker}\nwork` }] },
  ] }];
  const first = projectCodexTurns(emptyProjection(), turns, { r: { marker } });
  assert.equal(first.deliveries.r.turnId, 'turn-1');
  assert.equal(first.running, true);
  turns[0].status = 'completed';
  turns[0].items.push({ id: 'a1', type: 'agentMessage', text: 'done' });
  turns[0].items.push({ id: 'f1', type: 'fileChange', status: 'completed',
    changes: [{ path: 'D:/work/a.txt', kind: { type: 'add' } }] });
  const next = projectCodexTurns(first, turns, { r: { marker } });
  assert.equal(next.running, false);
  assert.deepEqual(next.messages.map(message => [message.role, message.text]), [['user', `${marker}\nwork`], ['assistant', 'done']]);
  assert.equal(next.changes[0].kind, 'add');
  const again = projectCodexTurns(next, turns, { r: { marker } });
  assert.equal(again.messages.length, 2);
  assert.equal(again.changes.length, 1);
});

test('current profile files precede trusted project overrides; project cannot change provider/profile', async () => {
  const dir = directory(), home = path.join(dir, '\u6d4b\u8bd5-home'), workspace = path.join(dir, 'workspace');
  await mkdir(home, { recursive: true }); await mkdir(path.join(workspace, '.codex'), { recursive: true });
  await writeFile(path.join(home, 'config.toml'), `model = "base"\n[projects.${JSON.stringify(workspace.replaceAll('\\', '/'))}]\ntrust_level = "trusted"\n`);
  await writeFile(path.join(home, 'review.config.toml'), 'model = "profile-a"\nmodel_reasoning_effort = "high"\n');
  await writeFile(path.join(workspace, '.codex/config.toml'), 'model = "project-b"\nmodel_reasoning_effort = "max"\nmodel_provider = "ignored"\nprofile = "ignored"\n');
  const actual = await readDefaultModel({ home, workspace, profile: 'review' });
  assert.equal(actual.model, 'project-b'); assert.equal(actual.reasoningEffort, 'max');
  assert.equal(actual.provider, 'openai'); assert.equal(actual.profile, 'review');
  assert.equal(actual.sources.length, 3);
});

test('first native creation sends only thread/start and turn/start with no model or permission fields', async () => {
  const calls = [];
  const host = createCodexHost({ nativeRequest: async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/start') return { thread: liveThread({ id: 'thread-1', cwd: 'D:/work/p' }) };
    if (method === 'turn/start') return { turn: liveTurn({ id: 'turn-1', status: 'inProgress', completedAt: null, durationMs: null }) };
    throw new Error('unexpected ' + method);
  } });
  const result = await host.createFirstTurn({ workspace: 'D:/work/p', message: 'work', title: 'helper' });
  assert.equal(result.nativeSessionId, 'thread-1');
  assert.deepEqual(calls.map(call => call[0]), ['thread/start', 'turn/start']);
  assert.deepEqual(calls[0][1], { cwd: path.resolve('D:/work/p'), threadSource: 'user' });
  const turn = calls[1][1];
  assert.equal(turn.threadId, 'thread-1');
  assert.deepEqual(turn.input, [{ type: 'text', text: 'work', text_elements: [] }]);
  for (const forbidden of ['model', 'effort', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'permissions', 'config']) {
    assert.equal(forbidden in turn, false, `${forbidden} must not be sent on the first turn`);
    assert.equal(forbidden in calls[0][1], false, `${forbidden} must not be sent on thread/start`);
  }
});

test('the host exposes a title write without requiring the create call to wait for a rollout', async () => {
  const calls = [];
  const host = createCodexHost({ nativeRequest: async (method, params) => { calls.push([method, params]); return {}; } });
  assert.deepEqual(await host.setTitle({ nativeSessionId: 'thread-1', name: 'helper' }), { renamed: true });
  assert.deepEqual(calls, [['thread/name/set', { threadId: 'thread-1', name: 'helper' }]]);
});

test('a failed first turn keeps the new thread binding instead of risking a second chat', async () => {
  const host = createCodexHost({ nativeRequest: async method => {
    if (method === 'thread/start') return { thread: liveThread({ id: 'thread-1' }) };
    if (method === 'turn/start') throw new Error('response lost');
    throw new Error('unexpected ' + method);
  } });
  await assert.rejects(host.createFirstTurn({ workspace: 'D:/work/p', message: 'work', title: 'helper' }),
    error => error.uncertain === true && error.nativeSessionId === 'thread-1');
});

test('native deletion checks the roster binding and cwd, deletes descendants first, and ignores thread_source', async () => {
  const rows = new Map([
    ['root', { id: 'root', cwd: path.toNamespacedPath('D:/work/p'), threadSource: 'user', status: { type: 'idle' } }],
    ['child', { id: 'child', cwd: 'D:/work/p', status: { type: 'idle' } }],
    ['user', { id: 'user', cwd: 'D:/work/p', status: { type: 'idle' } }],
  ]);
  const parents = new Map([['root', ['child']], ['child', []], ['user', []]]);
  const calls = [];
  const host = createCodexHost({ nativeRequest: async (method, params) => {
    calls.push([method, params.threadId]);
    if (method === 'thread/read') {
      const thread = rows.get(params.threadId);
      if (!thread) throw Object.assign(new Error('thread not found'), { rpcMessage: 'thread not found' });
      return { thread };
    }
    if (method === 'thread/list') return { data: (parents.get(params.parentThreadId) ?? []).map(id => rows.get(id)).filter(Boolean) };
    if (method === 'thread/delete') { rows.delete(params.threadId); return {}; }
    throw new Error('unexpected ' + method);
  } });
  await assert.rejects(host.destroy({ nativeSessionId: 'root', workspace: 'D:/work/p', ownedNodeIds: ['root'] }),
    { code: 'codex-delete-owner-mismatch' });
  assert.equal(calls.some(call => call[0] === 'thread/delete'), false,
    'an incomplete ownership snapshot is refused before any delete');
  await assert.rejects(host.destroy({ nativeSessionId: 'root', workspace: 'D:/work/other', ownedNodeIds: ['root', 'child'] }),
    { code: 'codex-delete-owner-mismatch' });
  const input = { nativeSessionId: 'root', workspace: 'D:/work/p', ownedNodeIds: ['root', 'child'] };
  assert.deepEqual(await host.destroy(input), { destroyed: true });
  assert.deepEqual(calls.filter(call => call[0] === 'thread/delete'), [['thread/delete', 'child'], ['thread/delete', 'root']]);
  assert.equal(rows.has('user'), true);
});

test('a thread already missing from the current profile counts as deleted', async () => {
  const host = createCodexHost({ nativeRequest: async () => {
    throw Object.assign(new Error('thread not found'), { rpcMessage: 'thread not found' });
  } });
  assert.deepEqual(await host.destroy({ nativeSessionId: 'gone', workspace: 'D:/work/p', ownedNodeIds: ['gone'] }),
    { destroyed: true });
});

test('observation reads thread metadata, turn pages and parent-filtered children without the database', async () => {
  const root = liveThread({ id: 'root', cwd: 'D:/work/p', model: 'gpt', modelProvider: 'openai', reasoningEffort: 'max' });
  const child = liveThread({ id: 'child', cwd: 'D:/work/p', name: 'helper' });
  const calls = [];
  const host = createCodexHost({ nativeRequest: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: params.threadId === 'root' ? root : child };
    if (method === 'thread/turns/list') {
      return params.threadId === 'root' ? livePage([liveTurn({ id: 'turn-1', items: [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] },
        { id: 'a1', type: 'agentMessage', text: 'done' },
      ] })]) : livePage();
    }
    if (method === 'thread/list') {
      return livePage(params.parentThreadId === 'root' ? [child] : []);
    }
    throw new Error('unexpected ' + method);
  } });
  const observed = await host.observe({ nativeSessionId: 'root', workspace: 'D:/work/p' });
  assert.deepEqual(observed.tree.nodes.map(node => [node.sessionId, node.parentSessionId, node.status]),
    [['root', null, 'idle'], ['child', 'root', 'idle']]);
  assert.equal(observed.histories.root.messages.length, 2);
  const childCall = calls.find(call => call.method === 'thread/list' && call.params.parentThreadId === 'root');
  assert.ok(childCall.params.sourceKinds.includes('subAgent'), 'subAgent source kinds are requested explicitly');
  assert.equal(calls.some(call => /state_5|rollout/i.test(JSON.stringify(call))), false);
  await assert.rejects(host.observe({ nativeSessionId: 'root', workspace: 'D:/work/other' }), { code: 'codex-native-binding-invalid' });
});

test('a post-delete thread/read rejection saying not loaded counts as deleted', async () => {
  let deleted = false;
  const host = createCodexHost({ nativeRequest: async method => {
    if (method === 'thread/read') {
      if (deleted) throw Object.assign(new Error('Native Desktop rejected thread/read: thread not loaded: root'),
        { code: 'codex-native-rpc-rejected', rpcMessage: 'thread/read: thread not loaded: root' });
      return { thread: liveThread({ id: 'root', cwd: 'D:/work/p' }) };
    }
    if (method === 'thread/list') return livePage();
    if (method === 'thread/delete') { deleted = true; return {}; }
    throw new Error('unexpected ' + method);
  } });
  assert.deepEqual(await host.destroy({ nativeSessionId: 'root', workspace: 'D:/work/p', ownedNodeIds: ['root'] }),
    { destroyed: true }, 'the deletion is confirmed even though the verification read rejects as not loaded');
});

test('an empty rollout while observing is running, never a transient error', async () => {
  const host = createCodexHost({ nativeRequest: async method => {
    if (method === 'thread/read') throw Object.assign(new Error(
      'failed to read session metadata for thread: rollout is empty'), { code: 'codex-native-rpc-rejected' });
    throw new Error('unexpected ' + method);
  } });
  const observed = await host.observe({ nativeSessionId: 'thread-1', workspace: 'D:/work/p' });
  assert.equal(observed.tree.running, true);
  assert.equal(observed.tree.settled, false);
  assert.equal(observed.tree.nodes[0].status, 'running');
});

test('interrupt reaches a running native child even when the root turn already ended', async () => {
  const calls = [];
  const host = createCodexHost({ nativeRequest: async (method, params) => {
    calls.push([method, params]);
    if (method === 'thread/read') return { thread: liveThread({ id: params.threadId, cwd: 'D:/work/p' }) };
    if (method === 'thread/turns/list') return livePage(params.threadId === 'child'
      ? [liveTurn({ id: 'turn-child', status: 'inProgress', completedAt: null, durationMs: null })] : []);
    if (method === 'thread/list') return livePage(params.parentThreadId === 'root'
      ? [liveThread({ id: 'child', cwd: 'D:/work/p' })] : []);
    if (method === 'turn/interrupt') return {};
    throw new Error('unexpected ' + method);
  } });
  const result = await host.interrupt({ nativeSessionId: 'root', ownedNodeIds: ['root', 'child'] });
  assert.deepEqual(result.interruptedTurns, [{ threadId: 'child', turnId: 'turn-child' }]);
  assert.deepEqual(calls.filter(call => call[0] === 'turn/interrupt').map(call => call[1]),
    [{ threadId: 'child', turnId: 'turn-child' }]);
});

test('an unchanged idle thread reuses its observation without pulling turns or children', async () => {
  let updatedAt = 1, turnsReads = 0, childReads = 0;
  const host = createCodexHost({ nativeRequest: async (method, params) => {
    if (method === 'thread/read') return { thread: liveThread({ id: 'root', cwd: 'D:/work/p', updatedAt,
      model: 'gpt', modelProvider: 'openai' }) };
    if (method === 'thread/turns/list') { turnsReads++; return { data: [{ id: `turn-${turnsReads}`, status: 'completed', startedAt: 1,
      items: [{ id: `u-${turnsReads}`, type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }] }] }; }
    if (method === 'thread/list') { childReads++; return { data: [] }; }
    throw new Error('unexpected ' + method);
  } });
  const first = await host.observe({ nativeSessionId: 'root', workspace: 'D:/work/p' });
  const second = await host.observe({ nativeSessionId: 'root', workspace: 'D:/work/p' });
  assert.deepEqual(second, first);
  assert.deepEqual([turnsReads, childReads], [1, 1], 'a stable idle thread is served from the cached projection');
  await host.observe({ nativeSessionId: 'root', workspace: 'D:/work/p', requests: { r: { status: 'unknown' } } });
  assert.deepEqual([turnsReads, childReads], [2, 2], 'an unconfirmed write forces a fresh observation');
  updatedAt = 2;
  await host.observe({ nativeSessionId: 'root', workspace: 'D:/work/p' });
  assert.deepEqual([turnsReads, childReads], [3, 3], 'a changed thread refreshes the page');
});

test('findCreatedSession is read-only, skips an unreadable candidate and confirms the marker', async () => {
  const startedAt = new Date().toISOString();
  const marker = markerLine('r', 'nonce');
  const createdAt = Math.floor(Date.parse(startedAt) / 1000);
  const calls = [];
  const host = createCodexHost({ nativeRequest: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/list') return livePage([
      liveThread({ id: 'someone-else', cwd: 'D:/work/p', createdAt }),
      liveThread({ id: 'thread-1', cwd: 'D:/work/p', createdAt }),
    ]);
    if (method === 'thread/read' && params.threadId === 'someone-else') throw new Error('not readable in this store');
    if (method === 'thread/read') return { thread: liveThread({ id: 'thread-1', cwd: 'D:/work/p', turns: [
      liveTurn({ id: 'turn-1', items: [
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: `${marker}\nwork` }] },
      ] }),
    ] }) };
    if (method === 'thread/turns/list') throw new Error('turns should come from the read-only thread/read page');
    throw new Error('unexpected ' + method);
  } });
  assert.deepEqual(await host.findCreatedSession({ workspace: 'D:/work/p', marker, startedAt }),
    { nativeSessionId: 'thread-1' }, 'one unreadable candidate does not abort the scan');
  assert.equal(calls.find(call => call.method === 'thread/list').params.limit, 100);
  assert.ok(calls.filter(call => call.method === 'thread/read').every(call => call.params.includeTurns === true));
  assert.equal(calls.some(call => call.method === 'thread/resume'), false, 'recovery never resumes a user thread');
});

test('registration matches exact build and roster with either config environment name and optional explicit server', async () => {
  const dir = directory(), home = path.join(dir, 'home'), workspace = path.join(dir, 'workspace');
  await mkdir(home, { recursive: true }); await mkdir(path.join(workspace, '.codex'), { recursive: true });
  const q = value => JSON.stringify(value.replaceAll('\\', '/'));
  const formal = path.join(dir, 'formal/mcp-server.mjs'), dev = path.join(dir, 'dev/mcp-server.mjs');
  const formalConfig = path.join(dir, 'formal/config.json'), devConfig = path.join(dir, 'dev/config.json');
  await writeFile(path.join(home, 'config.toml'), `[projects.${q(workspace)}]\ntrust_level = "trusted"\n[mcp_servers.renamed-production]\ncommand = ${q(process.execPath)}\nargs = [${q(formal)}]\n[mcp_servers.renamed-production.env]\nDSH_CONTROL_CONFIG = ${q(formalConfig)}\nFUTUREAIDE_CONTROL_CONFIG = ${q(devConfig)}\n`);
  await writeFile(path.join(workspace, '.codex/config.toml'), `[mcp_servers.custom-dev]\ncommand = ${q(process.execPath)}\nargs = [${q(dev)}]\n[mcp_servers.custom-dev.env]\nFUTUREAIDE_CONTROL_CONFIG = ${q(devConfig)}\n`);
  assert.equal((await readCodexMcpRegistration({ home, workspace, configPath: formalConfig, serverPath: formal })).serverName, 'renamed-production');
  assert.equal((await readCodexMcpRegistration({ home, workspace, configPath: devConfig, serverPath: dev })).serverName, 'custom-dev');
  await assert.rejects(readCodexMcpRegistration({ home, workspace, configPath: formalConfig, serverPath: dev }), { code: 'codex-registration-mismatch' });
  await assert.rejects(readCodexMcpRegistration({ home, workspace, configPath: devConfig, serverPath: dev, serverName: 'renamed-production' }), { code: 'codex-registration-mismatch' });
});
