import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgyCliBackend } from '../src/agy-cli-backend.mjs';
import { cancelAgyTurn, readAgyTurn } from '../src/agy-cli-runner.mjs';
import { TRUSTED_CALLER } from '../src/calling-context.mjs';
import { createClaudeCliBackend } from '../src/claude-cli-backend.mjs';
import { allowedCallbackTools, cancelClaudeTurn, readClaudeTurn } from '../src/claude-cli-runner.mjs';
import { startReportService } from '../src/claude-report-server.mjs';
import { createCliCallbackServer } from '../src/cli-callback-bridge.mjs';
import { createCodexCliBackend } from '../src/codex-cli-backend.mjs';
import { buildCodexCliArgs, cancelCodexTurn, readCodexTurn } from '../src/codex-cli-runner.mjs';
import { managedToolNames } from '../src/managed-cli-policy.mjs';
import { makeScopedServer, scopedManagement } from '../src/mcp-server.mjs';
import { RosterStore } from '../src/roster-store.mjs';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const targets = ['codex-cli', 'claude-cli', 'agy-cli'];
const builders = [createCodexCliBackend, createClaudeCliBackend, createAgyCliBackend];
const readers = [readCodexTurn, readClaudeTurn, readAgyTurn];
const cancellers = [cancelCodexTurn, cancelClaudeTurn, cancelAgyTurn];
const baseTools = ['ask_parent', 'feedback', 'futureaide_board_post', 'futureaide_board_read', 'report_parent'];
const currentRequest = record => record.task.dispatches.at(-1).requestId;
const binding = record => ({ agentId: record.agentId, taskId: record.task.taskId,
  requestId: currentRequest(record), target: record.target });
const envFor = (record, roster, tokenFile) => ({
  FUTUREAIDE_MANAGED_CLI: '1',
  FUTUREAIDE_ROSTER_PATH: roster,
  FUTUREAIDE_PARENT_AGENT_ID: record.agentId,
  FUTUREAIDE_PARENT_TASK_ID: record.task.taskId,
  FUTUREAIDE_PARENT_REQUEST_ID: currentRequest(record),
  FUTUREAIDE_AGENT_ID: record.agentId,
  FUTUREAIDE_TASK_ID: record.task.taskId,
  FUTUREAIDE_RUN_ID: currentRequest(record),
  FUTUREAIDE_MANAGED_TARGET: record.target,
  ...(tokenFile ? { FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE: tokenFile } : {}),
});
const body = result => JSON.parse(result.content[0].text);
const names = response => response.tools.map(tool => tool.name).sort();

async function tempRoot(t, close = async () => {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'f12-bridge-'));
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return root;
}

async function seedRoster(t) {
  const closers = [];
  const root = await tempRoot(t, async () => {
    for (const close of closers.reverse()) await close();
  });
  const cleanup = close => closers.push(close);
  const store = new RosterStore(path.join(root, 'roster.sqlite'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  cleanup(() => store.close());
  const insert = (name, { role = 'builder', parent, target = 'codex-cli', readOnlyScout, ownerId } = {}) => {
    const agentId = 'agent-' + name;
    const record = { name, agentId, state: 'running', role, target, workspace,
      ownerId: ownerId ?? parent?.ownerId ?? 'owner-root', parentAgentId: parent?.agentId, readOnlyScout,
      task: { taskId: 'task-' + name, state: 'running', dispatches: [{ requestId: 'req-' + name }] } };
    store.insert(record);
    return record;
  };
  return { root, store, workspace, insert, cleanup };
}

async function connectMemory(server) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'f12-in-memory', version: '1.0.0' });
  await server.connect(b);
  await client.connect(a);
  return client;
}

function runCli(args, options = {}) {
  return execFileSync(process.execPath, ['src/cli.mjs', ...args], { cwd: packageRoot, encoding: 'utf8', ...options });
}

test('H02 headless backends consume exact question IDs and MCP and CLI expose the selector', async t => {
  const record = { workspace: packageRoot, task: { taskId: 'task-1' } };
  const questions = ['q1', 'q2', 'q3'].map(id => ({ id, taskId: 'task-1', state: 'pending', message: 'same message' }));
  for (const createBackend of builders) {
    let state = { taskId: 'task-1' };
    const backend = createBackend(record, {
      readNativeState: () => structuredClone(state),
      writeNativeState: value => { state = structuredClone(value); },
      readParentSubmissions: () => ({ questions }),
    });
    const selected = { answerId: 'reply-1', message: '  exact\r\nbody  ', questionIds: ['q2'] };
    const first = await backend.answer(selected);
    assert.deepEqual(first.consumedQuestionIds, ['q2']);
    assert.equal(first.continuation, 'Parent answer:\n  exact\r\nbody  \nContinue the same task.');
    assert.deepEqual(await backend.answer(selected), first);
    await assert.rejects(backend.answer({ ...selected, message: 'different' }), { code: 'question-changed' });
    await assert.rejects(backend.answer({ ...selected, answerId: 'different', questionIds: ['q1', 'q2'] }), { code: 'question-not-pending' });
    await assert.rejects(backend.answer({ ...selected, answerId: 'different', questionIds: ['q3', 'q3'] }), { code: 'invalid-question-selector' });
    assert.deepEqual(state.answered, ['q2']);
    assert.deepEqual((await backend.answer({ answerId: 'reply-2', message: 'default' })).consumedQuestionIds, ['q1']);
    assert.deepEqual((await backend.answer({ answerId: 'reply-3', message: 'later', questionIds: ['q3'] })).consumedQuestionIds, ['q3']);
  }

  const calls = [];
  const service = {
    answer: args => { calls.push(['answer', args]); return { answered: true, consumedQuestionIds: args.questionIds }; },
    run: args => { calls.push(['run', args]); return { accepted: true }; },
    delete: args => { calls.push(['delete', args]); return { deleted: true }; },
    postBoard: args => { calls.push(['board', args]); return { posted: true }; },
  };
  const server = makeScopedServer({ configReady: Promise.resolve({}), scopedFactory: () => service, env: {} });
  const client = await connectMemory(server);
  t.after(async () => { await client.close(); await server.close(); });
  const answer = args => client.callTool({ name: 'futureaide_answer_agent',
    arguments: { name: 'member', message: 'reply', ...args }, });
  assert.equal((await answer({ question_id: 'q2' })).isError, undefined);
  assert.deepEqual(calls[0][1].questionIds, ['q2']);
  for (const args of [{ question_id: 'q2', questionIds: ['q1'] }, { questionIds: [] }, { questionIds: ['q2', 'q2'] }]) {
    assert.equal((await answer(args)).isError, true);
  }
  assert.equal(calls.length, 1);
  const sha = 'a'.repeat(40);
  await client.callTool({ name: 'futureaide_run_agent', arguments: {
    role: 'builder', worktree: true, baseSha: sha, tasks: [{ message: 'first' }, { message: 'second', baseSha: 'b'.repeat(40) }],
  } });
  assert.equal(calls[1][1].baseSha, sha);
  assert.equal(calls[1][1].tasks[1].baseSha, 'b'.repeat(40));
  await client.callTool({ name: 'futureaide_delete_agent', arguments: { name: 'member', discard_worktree: true } });
  assert.equal(calls[2][1].discardWorktree, true);
  await client.callTool({ name: 'futureaide_board_post', arguments: { message: '@member urgent', urgent: true } });
  assert.equal(calls[3][1].urgent, true);
  const temp = await tempRoot(t);
  const configFile = path.join(temp, 'config.json');
  await writeFile(configFile, JSON.stringify({ stateDirectory: temp, workspace: temp, idleSessionCleanup: false }));
  assert.throws(() => runCli(['team', 'answer', 'member', '--message', 'reply', '--question-id', 'q2',
    '--question-id', 'q2', '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] }),
  error => { assert.match(error.stderr, /invalid-question-selector/); return true; });
});

test('H05 matches a real roster listener and persists scoped offline posts through rediscovery', async t => {
  const box = await seedRoster(t);
  const { root, store, insert, cleanup } = box;
  const lead = insert('lead', { role: '团队长' });
  const caller = insert('section', { role: '团队长', parent: lead, ownerId: 'owner-section' });
  const worker = insert('worker', { parent: caller, ownerId: 'owner-leaf' });
  const sibling = insert('sibling', { parent: lead });
  const foreign = insert('foreign', { ownerId: 'owner-foreign' });
  const desktopFile = path.join(root, 'custom folder', 'private desktop token.json');
  const diagnostics = [];
  const bridge = createCliCallbackServer({ ...binding(caller), roster: store.location,
    env: { ...envFor(caller, store.location, desktopFile), FUTUREAIDE_REPORT_PORT: '1' },
    log: code => diagnostics.push(code), });
  cleanup(() => bridge.close());
  assert.deepEqual((await bridge.listTools()).map(tool => tool.name).sort(), baseTools);
  assert.equal(diagnostics.at(-1), 'managed-cli-token-unavailable');
  const urgent = body(await bridge.callTool('futureaide_board_post', { message: '@lead/section/worker now', urgent: true }));
  assert.deepEqual(urgent.mentions, ['lead/section/worker']);
  assert.equal(urgent.deferred[0].targetAgentId, worker.agentId);
  assert.equal(urgent.deferred[0].targetTaskId, worker.task.taskId);
  assert.equal(urgent.deferred[0].urgent, true);
  const denied = await bridge.callTool('futureaide_board_post', { message: '@worker @sibling invalid', urgent: true });
  assert.equal(body(denied).error.code, 'permission-denied');
  const offline = body(await bridge.callTool('futureaide_board_read'));
  assert.equal(offline.latestSeq, urgent.seq);
  assert.equal(offline.messages[0].authorAgentId, caller.agentId);
  assert.deepEqual(offline.messages[0].mentions, ['lead/section/worker']);
  assert.equal(offline.messages.length, 1);
  const config = path.join(root, 'config.json');
  await writeFile(config, JSON.stringify({ stateDirectory: root, workspace: box.workspace, idleSessionCleanup: false }));
  assert.throws(() => runCli(['board', 'post', '@worker @sibling invalid', '--urgent', '--owner', sibling.ownerId, '--config', config],
    { env: { ...process.env, ...envFor(caller, store.location, desktopFile) }, stdio: ['ignore', 'pipe', 'pipe'] }),
  error => { assert.match(error.stderr, /permission-denied/); return true; });
  assert.equal(store.listBoardMessages(lead.ownerId).latestSeq, urgent.seq);
  const otherBridge = createCliCallbackServer({ ...binding(foreign), roster: store.location,
    env: envFor(foreign, store.location, desktopFile) });
  cleanup(() => otherBridge.close());
  assert.deepEqual(body(await otherBridge.callTool('futureaide_board_read')).messages, []);

  const service = { store, readBoard: (_args, extra) => ({ online: true, caller: extra[TRUSTED_CALLER].callerAgentId }) };
  let report = await startReportService({ port: 0, store, antigravityCallerTokenFile: desktopFile });
  try {
    assert.deepEqual((await bridge.listTools()).map(tool => tool.name).sort(), baseTools);
    assert.equal(diagnostics.at(-1), 'report-service-callback-only');
  } finally { await report.close(); }

  report = await startReportService({ port: 0, store, antigravityCallerTokenFile: desktopFile,
    management: scopedManagement({ service }) });
  try {
    assert.ok((await bridge.listTools()).some(tool => tool.name === 'futureaide_run_agent'));
    assert.deepEqual(body(await bridge.callTool('futureaide_board_read')), { online: true, caller: caller.agentId });
    const tokenInfo = JSON.parse(await readFile(report.managedCliTokenFile, 'utf8'));
    await writeFile(report.managedCliTokenFile, JSON.stringify({ ...tokenInfo, token: 'expired-test-token' }));
    assert.deepEqual((await bridge.listTools()).map(tool => tool.name).sort(), baseTools);
    assert.equal(diagnostics.at(-1), 'managed-cli-token-rejected (HTTP 401)');
    await writeFile(report.managedCliTokenFile, JSON.stringify(tokenInfo));
    assert.ok((await bridge.listTools()).some(tool => tool.name === 'futureaide_run_agent'));
    assert.ok(!diagnostics.some(code => code.includes(root) || code.includes(tokenInfo.token)));
  } finally { await report.close(); }

  // A connection can disappear after the remote handler writes. Retrying the
  // same board post against SQLite would create a duplicate.
  const uncertain = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, roster: store.identity(), management: true }));
      return;
    }
    req.resume();
    req.once('end', () => {
      store.postBoardMessage({ rootOwnerId: lead.ownerId, text: 'online write' });
      res.destroy();
    });
  });
  uncertain.listen(0, '127.0.0.1');
  await once(uncertain, 'listening');
  try {
    await writeFile(report.managedCliTokenFile, JSON.stringify({ port: uncertain.address().port,
      token: 'test-token', roster: store.identity() }));
    const posted = await bridge.callTool('futureaide_board_post', { message: 'online write' });
    assert.equal(body(posted).error.code, 'write-outcome-unknown');
    assert.equal(store.listBoardMessages(sibling.ownerId).messages.filter(row => row.text === 'online write').length, 1);
  } finally { await new Promise(resolve => uncertain.close(resolve)); }
});

async function connectStdio(record, roster, tokenFile) {
  const target = record.target;
  const script = target === 'agy-cli' ? 'antigravity-caller-bootstrap.mjs' : 'cli-callback-bridge.mjs';
  const args = target === 'agy-cli' ? [] : ['--' + target + '-reports'];
  if (target === 'codex-cli' || target === 'claude-cli') {
    args.push(roster, record.agentId, record.task.taskId, currentRequest(record));
  }
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(packageRoot, 'src', script), ...args], cwd: packageRoot, env: envFor(record, roster, tokenFile), stderr: 'pipe' });
  const client = new Client({ name: 'f12-stdio', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function checkPreemption(t) {
  const root = await tempRoot(t);
  const requestId = 'R0';
  const claudeId = '72b025a4-d4c9-4d8b-bfe9-0afdd750a068';
  const oldRecord = { workspace: root, task: { taskId: 'task-1' } };
  for (const [index, create] of builders.entries()) {
    let state = { active: requestId, requests: { R0: { taskId: 'task-1', status: 'accepted' } },
      ...(index === 1 ? { sessionId: claudeId } : {}) };
    let stops = 0;
    let stopped = false;
    let initialized = false;
    const cancel = async (directory, options) => {
      assert.equal(options.expectedRequestId, requestId);
      assert.equal(path.basename(directory), requestId);
      stops += 1;
      return { ok: stopped, stopped };
    };
    const read = async () => ({
      requestId, state: 'cancelled',
      ...(initialized ? { threadId: claudeId, cliSessionId: claudeId, conversationId: claudeId, sessionStarted: true } : {}),
    });
    const backend = create(oldRecord, {
      requestDirectory: () => root, readNativeState: () => structuredClone(state),
      writeNativeState: value => { state = structuredClone(value); },
      runner: { cancel, read, cancelCodexTurn: cancel, readCodexTurn: read, cancelClaudeTurn: cancel, readClaudeTurn: read,
        cancelAgyTurn: cancel, readAgyTurn: read },
    });
    assert.equal((await backend.preemptTurn(oldRecord, { expectedRequestId: 'R1' })).stopped, false);
    assert.equal(stops, 0);
    assert.equal((await backend.preemptTurn(oldRecord, { expectedRequestId: requestId })).stopped, false);
    assert.equal(state.active, requestId);
    stopped = true;
    initialized = index !== 1;
    const receipt = await backend.preemptTurn(oldRecord, { expectedRequestId: requestId });
    assert.equal(receipt.sessionResumable, index !== 1);
    assert.equal(receipt.stopped, true);
    assert.equal(state.active, undefined);
    assert.equal(state.requests.R0.terminal, undefined);
    assert.equal(state.sessionId, index === 3 ? claudeId : undefined);
    assert.deepEqual(await backend.preemptTurn(oldRecord, { expectedRequestId: requestId }), receipt);
    assert.equal(stops, 2);
  }
  for (const [index, read] of readers.entries()) {
    const directory = path.join(root, 'stale-' + index);
    await mkdir(directory);
    const now = new Date().toISOString();
    await writeFile(path.join(directory, 'turn.json'), JSON.stringify({ requestId: 'R1', sessionId: claudeId,
      workspace: root, workerPid: process.pid, startedAt: now }));
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ requestId: 'R0', sessionId: claudeId,
      state: 'failed', error: { code: 'old-error' }, phase: 'exited' }));
    await writeFile(path.join(directory, 'terminal.json'), JSON.stringify({ sessionId: claudeId, state: 'failed', phase: 'exited' }));
    const observed = await read(directory);
    assert.equal(observed.requestId, 'R1');
    assert.equal(observed.state, 'running');
    assert.equal(observed.error, undefined);
    const workerPid = process.pid;
    let live = true;
    let killCount = 0;
    const testSeams = {
      isAlive: () => live,
      commandLines: async () => new Map([[workerPid, { ok: true, text: 'worker --turn ' + directory }]]),
      killTree: async () => { killCount += 1; live = false; },
      killCage: async ({ sessionId, runId }) => {
        assert.equal(sessionId, undefined, 'a shared native session must not be an orphan search key');
        assert.equal(runId, 'R1');
        return { ok: true, killed: [] };
      },
    };
    const wrong = await cancellers[index](directory, { ...testSeams, expectedRequestId: 'R0' });
    assert.equal(wrong.stopped, false);
    assert.equal(killCount, 0);
    const stopped = await cancellers[index](directory, { ...testSeams, expectedRequestId: 'R1' });
    assert.equal(stopped.stopped, true);
    assert.equal(killCount, 1);
  }
}

async function checkPublicPackage(t) {
  const root = await tempRoot(t);
  const npm = process.env.npm_execpath || (process.platform === 'win32'
    ? path.join(path.dirname(execFileSync('where.exe', ['npm.cmd'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]),
      'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined);
  const args = ['pack', '--json', '--pack-destination', root];
  const [pkg] = JSON.parse(execFileSync(npm ? process.execPath : 'npm', npm ? [npm, ...args] : args,
    { cwd: packageRoot, encoding: 'utf8', windowsHide: true }));
  assert.ok(pkg.files.some(item => item.path === 'src/mcp-server.mjs'));
  execFileSync('tar', ['-xf', path.join(root, pkg.filename), '-C', root], { windowsHide: true });
  const banned = [
    'project' + '-map', 'FutureAide' + 'MAP', String.fromCodePoint(33258, 30001, 30011, 24067),
    String(47329 + 1), 'xiayuls' + '_workflow', 'xiayus' + '-workflow', String.fromCodePoint(27741, 30343),
    'work' + '-workflow', String.fromCodePoint(22242, 38431, 37197, 32622),
    'Boss' + String.fromCodePoint(21327, 35758), '规' + '划师', '秘' + '书',
    '主' + '策', '审查' + '官', '严谨' + '龙', '执行' + '师', '外置' + '大脑',
  ];
  const roots = [process.env.USERPROFILE, process.env.FA_F12_PRIVATE_ROOT].filter(Boolean);
  const needles = [...banned, ...roots.flatMap(value => [value, value.replaceAll('\\', '/'), value.replaceAll('\\', '\\\\')])]
    .map(value => value.toLowerCase());
  const encodings = ['utf-8', 'utf-16le', 'utf-16be'];
  const matches = (bytes, encoding) => needles.some(needle => new TextDecoder(encoding).decode(bytes).toLowerCase().includes(needle));
  for (const word of banned) {
    const control = Buffer.from(word, 'utf16le');
    assert.ok(matches(Buffer.from(word), encodings[0]));
    assert.ok(matches(control, encodings[1]));
    assert.ok(matches(control.swap16(), encodings[2]));
  }
  const privatePath = /(^|\/)(?:\.git|\.map|\.runtime|\.work|\.gemini|node_modules)(\/|$)|^docs\/project\/|(^|\/)(?:\.env(?:\.local)?|[^/]+\.(?:pem|pfx|sqlite))$/i;
  const unpacked = path.join(root, 'package');
  const filesIn = async directory => (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile()).map(entry => path.join(entry.parentPath, entry.name));
  const files = await filesIn(unpacked);
  assert.deepEqual(files.map(file => path.relative(unpacked, file).replaceAll(path.sep, '/')).sort(),
    pkg.files.map(file => file.path).sort());
  for (const directory of ['tests', 'test']) files.push(...await filesIn(path.join(packageRoot, directory)));
  for (const file of files) {
    const relative = path.relative(file.startsWith(unpacked + path.sep) ? unpacked : packageRoot, file).replaceAll(path.sep, '/');
    assert.ok(!privatePath.test(relative) && !needles.some(needle => relative.toLowerCase().includes(needle)), relative);
    const bytes = await readFile(file);
    for (const encoding of encodings) assert.ok(!matches(bytes, encoding), relative + ' ' + encoding);
  }
}

test('H06 headless CLI transports enforce roster roles, scoped dispatch and separate credentials', async t => {
  const { root, store, insert, cleanup } = await seedRoster(t);
  const desktopFile = path.join(root, 'desktop-token.json');
  const writes = [];
  const service = {
    store, run: (args, extra) => { writes.push({ args, caller: extra[TRUSTED_CALLER] }); return { accepted: true }; },
    cancel: args => { writes.push({ args }); return { cancelRequested: true }; },
  };
  const server = await startReportService({ store, port: 0, antigravityCallerTokenFile: desktopFile,
    management: scopedManagement({ service }) });
  cleanup(() => server.close());
  const managed = JSON.parse(await readFile(server.managedCliTokenFile, 'utf8'));
  const desktop = JSON.parse(await readFile(desktopFile, 'utf8'));
  assert.notEqual(managed.token, desktop.token);

  for (const [index, target] of targets.entries()) {
    const leaf = insert('leaf-' + index, { target });
    const reviewer = insert('reviewer-' + index, { target, role: '审查员' });
    const scout = insert('scout-' + index, { parent: reviewer, target: 'codex-cli', role: '调查员', readOnlyScout: true });
    const lead = insert('lead-' + index, { target, role: '团队长' });
    for (const record of [leaf, reviewer, lead]) {
      const client = await connectStdio(record, store.location, desktopFile);
      const call = (name, args) => client.callTool({ name, arguments: args });
      try {
        assert.deepEqual(names(await client.listTools()), managedToolNames(record.role).sort(), target + '/' + record.role);
        assert.equal(body(await call('futureaide_list_agents', { scope: 'all' })).error.code, 'permission-denied');
        assert.equal(body(await call('futureaide_cancel_agent', { name: 'leaf-' + index })).error.code, 'permission-denied');
        if (record !== reviewer) continue;

        const run = args => call('futureaide_run_agent', { role: '调查员', message: 'Read files', ...args });
        const before = writes.length;
        for (const args of [{ target: 'agy-cli' }, { lifetime: 'persistent' }, { name: scout.name }, { worktree: true },
          { tasks: [{ message: 'read' }, { message: 'edit', role: 'builder' }] }]) {
          assert.equal(body(await run(args)).error.code, 'permission-denied');
        }
        assert.equal(writes.length, before);
        assert.equal((await run({ target: 'codex-cli' })).isError, undefined);
        assert.equal(writes.at(-1).caller.readOnlyScout, true);
        assert.equal((await call('futureaide_cancel_agent', { name: scout.name })).isError, undefined);
      } finally { await client.close(); }
    }

    const headers = { 'x-futureaide-caller': 'managed-cli', 'x-futureaide-roster-id': store.identity(),
      'x-futureaide-agent-id': leaf.agentId, 'x-futureaide-task-id': leaf.task.taskId,
      'x-futureaide-request-id': currentRequest(leaf), 'x-futureaide-target': leaf.target };
    const rpc = (overrides = {}, token = managed.token) => fetch(server.url, { method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + token, ...headers, ...overrides },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    for (const bad of [{ 'x-futureaide-agent-id': lead.agentId }, { 'x-futureaide-request-id': 'old' },
      { 'x-futureaide-task-id': 'wrong' }, { 'x-futureaide-target': 'other' }, { 'x-futureaide-role': 'planner-lead' },
      { 'x-futureaide-owner-id': 'fake-owner' }, { 'x-futureaide-workspace-b64': Buffer.from(path.join(root, 'wrong')).toString('base64') }]) {
      const response = await rpc(bad);
      assert.equal(response.status, 403);
      await response.json();
    }
    const disguised = await rpc({ 'x-antigravity-conversation-id': 'fake-boss' });
    assert.equal(disguised.status, 401);
    await disguised.json();
    const wrongToken = await rpc({}, desktop.token);
    assert.equal(wrongToken.status, 401);
    await wrongToken.json();
  }
  assert.deepEqual(allowedCallbackTools('relay', '审查员'),
    managedToolNames('审查员').map(name => 'mcp__relay__' + name));
  const fresh = buildCodexCliArgs({ readOnly: true });
  assert.equal(fresh[fresh.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(buildCodexCliArgs({ readOnly: true, resume: true, threadId: 'uuid' }).includes('sandbox_mode="read-only"'));
  await checkPreemption(t);
  await checkPublicPackage(t);
});
