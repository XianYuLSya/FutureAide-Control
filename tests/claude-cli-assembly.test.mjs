// claude-cli acceptance through the public management entry.
//
// Real code only: createScopedAgents and its one state machine, RosterStore, the
// production adapter (src/claude-cli-backend.mjs), the production runner
// (src/claude-cli-runner.mjs) with its detached worker, and the real
// ask_parent/report_parent stdio MCP server (server name `futureaide`) that the
// runner configures for every dispatch.
//
// Two seams are replaced, both of them the ones the runner itself declares for tests:
//   probeClaudeCli({ findCli, exec })  -> the stand-in executable
//   startClaudeTurn({ cli })           -> the same stand-in, as { command, prefixArgs }
// Everything else — session UUIDs, argv, stream-json parsing, heartbeats, the report
// channel, cancellation of the process tree — is production behavior.
//
// No real Claude account, model call or login is involved. The stand-in lives in
// fixtures/fake-claude-workflow.mjs and answers only fixture data.
//
// Run: node --test tests/claude-cli-assembly.test.mjs
// Artifacts (roster, turn directories, invocation logs) stay under
// clean/claude-cli-assembly/ and are kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { appendFile, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor, ownerIdForSource } from '../src/calling-context.mjs';
import { startHttpService } from '../src/claude-report-server.mjs';
import { scopedManagement } from '../src/mcp-server.mjs';
import { connectHttpMcp, callTool } from '../test/assembly/fixture.mjs';
import { CLAUDE_CLI_MODELS, createClaudeCliBackend } from '../src/claude-cli-backend.mjs';
import {
  cancelClaudeTurn, probeClaudeCli, readClaudeTurn, startClaudeTurn,
} from '../src/claude-cli-runner.mjs';
import {
  CLI_MODELS, latestTurnDirectory, pidAlive, readInvocations, writeAuthState,
} from '../fixtures/fake-claude-workflow.mjs';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_CLI = path.join(projectRoot, 'fixtures', 'fake-claude-workflow.mjs');
const artifactRoot = path.join(projectRoot, 'clean', 'claude-cli-assembly');
const THREAD = '11111111-1111-4111-8111-111111111111';
const extra = { _meta: { threadId: THREAD } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The stand-in executable, wired through the seams the runner documents. The CLI path
 * the adapter sees is a plain string; the process it actually starts is this file.
 */
const runner = {
  probeClaudeCli: options => probeClaudeCli({ ...options, findCli: async () => FAKE_CLI,
    exec: (cli, args, execOptions) => execFileAsync(process.execPath, [cli, ...args], execOptions) }),
  startClaudeTurn: (input, deps) => startClaudeTurn({ ...input,
    cli: { command: process.execPath, prefixArgs: [FAKE_CLI] } }, deps),
  readClaudeTurn,
  cancelClaudeTurn,
};

async function caseDir(label) {
  await mkdir(artifactRoot, { recursive: true });
  return mkdtemp(path.join(artifactRoot, `${label}-`));
}

/**
 * A real roster and the real management entry for one case. `steps` is the scripted
 * CLI behaviour; `loggedIn` writes the stand-in's auth state before anything runs.
 */
async function assembly(label, { steps = [], loggedIn = true, nativeRequestFactory } = {}) {
  const root = await caseDir(label);
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'cli-home');
  const stateDirectory = path.join(root, 'state');
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(stateDirectory, { recursive: true });
  writeAuthState(home, { loggedIn });
  const scenario = path.join(root, 'scenario.json');
  await writeFile(scenario, JSON.stringify({ steps }, null, 2), 'utf8');
  // The CLI and its detached worker inherit these, exactly as they would inherit a
  // real installation's environment.
  process.env.FAKE_CLAUDE_HOME = home;
  process.env.FAKE_CLAUDE_SCENARIO_FILE = scenario;

  const calls = [];
  // The caller side of the shared layer: a Codex chat that records what it was sent.
  const callCodex = async (threadId, tool, args) => {
    calls.push({ tool, args });
    if (tool !== 'read_thread') return { accepted: true };
    return { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } };
  };
  const store = new RosterStore(path.join(stateDirectory, 'roster.sqlite'));
  const nativeRequest = nativeRequestFactory?.({ workspace, root, stateDirectory });
  const service = createScopedAgents({
    stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh',
  }, {
    store,
    ...(nativeRequest ? { nativeRequest } : { callCodex }),
    startSharedMonitor: () => true,
    // Archive the private directory inside this case's clean/ workspace.
    removeTree: source => rename(source, path.join(root, 'cleaned-' + path.basename(source))),
    clientFactory: () => ({ hostStatus: async () => { throw new Error('fixture DSH offline'); } }),
    codexProbeRegistration: async () => ({ ready: false }),
    backendAdapterLoader: (target, adapters) => adapters[target],
    backendAdapters: { 'claude-cli': (record, deps) => createClaudeCliBackend(record, { ...deps, runner }) },
  });
  return {
    root, workspace, home, scenario, stateDirectory, store, service, calls,
    record: name => store.named(ownerIdFor(THREAD), name),
    invocations: () => readInvocations(home),
    turnState: async record => {
      const directory = latestTurnDirectory(path.join(stateDirectory, 'scoped', record.ownerId, record.agentId));
      if (!directory) return undefined;
      return { directory, state: await readJsonFile(path.join(directory, 'state.json')) };
    },
    close: async () => {
      // A turn this case left running is a detached worker plus the CLI it started:
      // stop both, so nothing outlives the run. Nothing on disk is deleted.
      try { await stopStragglers(store, stateDirectory); } catch { /* best effort */ }
      try { service.close(); } catch { /* already closed */ }
    },
  };
}

async function readJsonFile(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Stop any CLI worker tree this case started and did not already stop. */
async function stopStragglers(store, stateDirectory) {
  for (const record of store.list()) {
    const directory = latestTurnDirectory(path.join(stateDirectory, 'scoped', record.ownerId, record.agentId));
    if (directory) await cancelClaudeTurn(directory);
  }
}

/** The caller-side text of every notice and report this chat received. */
const callerText = calls => calls.map(call => JSON.stringify(call.args ?? {})).join('\n');

const page = (data = []) => ({ data, nextCursor: null, backwardsCursor: null });

/**
 * A native Codex owner that never serves a large full turn page, matching the
 * live timeout. Owner reads are metadata-only; turn pages are summary/notLoaded.
 */
function codexOwner(workspace, { summary = () => page(), items = () => page(), onTurn = () => undefined } = {}) {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: THREAD, cwd: workspace } };
    if (method === 'thread/turns/list') {
      if (params?.itemsView === 'full' && (params.limit ?? 0) > 2) {
        throw Object.assign(new Error('Native Desktop response timed out'), { code: 'codex-native-rpc-response-timeout' });
      }
      return summary(params);
    }
    if (method === 'thread/items/list') return items(params);
    if (method === 'thread/list') return page();
    if (method === 'turn/start' || method === 'turn/steer') {
      const value = onTurn(params);
      if (value instanceof Error) throw value;
      return value ?? { turn: { id: 'notice-turn' } };
    }
    throw new Error('unexpected ' + method);
  };
  return { request, calls };
}

/** Drive the one state machine until the caller's own condition holds. */
async function pollUntil(f, agentId, predicate, { timeoutMs = 45000, message = 'state' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { await f.service.poll(agentId); } catch { /* a poll that raced a removal is fine */ }
    last = f.store.get(agentId);
    if (await predicate(last)) return last;
    await sleep(80);
  }
  throw new Error(`Timed out waiting for ${message}. Last: ${JSON.stringify(last && {
    state: last.state,
    taskState: last.task?.state,
    dispatches: last.task?.dispatches?.map(item => [item.state, item.error?.code, item.failure?.code]),
    reports: last.task?.reports?.map(item => [item.final, item.delivery?.state]),
    questions: last.observation?.questions ?? last.task?.questions,
    error: last.error })}`);
}

const turn = (invocations, index) => invocations.filter(entry => entry.command === 'print')[index];

test('Claude Desktop calls a named CLI helper over MCP and receives its report in its own inbox', async t => {
  const f = await assembly('claude-caller', { steps: [{ mode: 'final', message: 'Returned to Claude.', tryBlank: true }] });
  t.after(f.close);
  const sessionId = randomUUID();
  const ownerId = ownerIdForSource('claude-desktop', sessionId);
  const socketPath = '\\\\.\\pipe\\futureaide-test-' + sessionId;
  const binding = { sessionId, pid: process.pid, directory: f.root, workspace: f.workspace,
    procStart: 'fixture', pidDomain: 'fixture', socketPath, transcriptFile: path.join(f.root, 'caller.jsonl'),
    recordFile: path.join(f.root, 'caller.json') };
  const key = process.pid + '.' + createHash('sha256').update(socketPath).digest('hex') + '.key';
  await writeFile(path.join(f.root, key), JSON.stringify({ peerToken: '0'.repeat(32), procStart: 'fixture', pidDomain: 'fixture' }));
  await writeFile(binding.recordFile, JSON.stringify({ ...binding, entrypoint: 'claude-desktop', cwd: f.workspace,
    messagingSocketPath: socketPath }));
  await writeFile(binding.transcriptFile, '');
  f.store.saveOwner({ ownerId, source: 'claude-desktop', nativeSessionId: sessionId, workspace: f.workspace, binding });
  const frames = [];
  const inbox = createServer({ allowHalfOpen: true }, socket => {
    let incoming = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { incoming += chunk; });
    socket.on('end', async () => {
      const [, frame] = incoming.trim().split('\n').map(line => JSON.parse(line));
      frames.push(frame);
      await appendFile(binding.transcriptFile, JSON.stringify({ ...frame, sessionId: frame.session_id }) + '\n');
      socket.end();
    });
  });
  await new Promise((resolve, reject) => { inbox.once('error', reject); inbox.listen(socketPath, resolve); });
  t.after(() => new Promise(resolve => inbox.close(resolve)));
  const host = await startHttpService({ port: 0, resolveCaller: () => ({ sessionId, cwd: f.workspace, pid: process.pid }),
    management: scopedManagement({ service: f.service }) });
  const mcp = await connectHttpMcp(host.port);
  t.after(async () => { await mcp.close(); await host.close(); });
  const run = await callTool(mcp.client, 'futureaide_run_agent', { name: '审稿', target: 'claude-cli',
    lifetime: 'persistent', model: 'sonnet', effort: 'high', message: 'Report back to this Claude caller.' });
  assert.equal(run.isError, false, JSON.stringify(run.value));
  const agent = f.store.named(ownerId, '审稿');
  const complete = await pollUntil(f, agent.agentId, r => r?.state === 'idle', { message: 'Claude inbox receipt' });
  assert.equal(complete.task.result.reply, 'Returned to Claude.');
  const print = turn(f.invocations(), 0);
  assert.deepEqual(print.calls.map(call => call.ok), [false, true], 'a blank final leaves the valid report deliverable');
  assert.equal(print.model, 'claude-sonnet-5-5'); assert.equal(print.effort, 'high');
  assert.equal(frames.length, 1); assert.equal(frames[0].session_id, sessionId);
  assert.match(frames[0].message.content, /Returned to Claude\./);
  assert.equal(f.calls.length, 0, 'the Claude parent needs no Codex owner route');
  const waited = await callTool(mcp.client, 'futureaide_wait_agents', { names: ['审稿'], timeout_seconds: 0 });
  assert.equal(waited.value.items[0].actualModel, 'claude-sonnet-5-5');
});

// --------------------------------------------------------------- acceptance

test('a logged-out CLI refuses the name with its own reason while the four models stay listed', async t => {
  const f = await assembly('auth', { loggedIn: false, steps: [] });
  t.after(() => f.close());

  // status reads the same adapter without a login: the catalog is still there and
  // the reason a turn cannot start is the CLI's, not a generic one.
  const diagnosed = (await f.service.status(extra)).backends['claude-cli'];
  assert.equal(diagnosed.ready, false);
  assert.equal(diagnosed.reason.code, 'claude-cli-auth-required', JSON.stringify(diagnosed.reason));
  assert.match(diagnosed.reason.message, /claude auth login|sign in/i);
  assert.deepEqual(diagnosed.models, [...CLAUDE_CLI_MODELS], 'the four declared models are still listed while logged out');
  assert.equal(diagnosed.models.length, 4);
  assert.equal(diagnosed.defaultModel, null, 'no default model is invented before a real turn reports one');
  assert.deepEqual([...CLAUDE_CLI_MODELS], [...CLI_MODELS], 'the stand-in and the adapter declare the same catalog');

  // Creating a name is refused before the name exists, with that same reason.
  await assert.rejects(() => f.service.create({ name: '待登录', lifetime: 'persistent', target: 'claude-cli' }, extra),
    error => {
      assert.equal(error.code, 'claude-cli-auth-required', JSON.stringify(error.code));
      assert.match(error.message, /claude auth login|sign in/i);
      return true;
    });
  assert.equal(f.store.named(ownerIdFor(THREAD), '待登录'), undefined, 'a refused name is never written to the roster');

  // Signing in through the CLI is what unblocks it, and creation still starts no turn.
  const login = await execFileAsync(process.execPath, [FAKE_CLI, 'auth', 'login'],
    { env: { ...process.env, FAKE_CLAUDE_HOME: f.home }, windowsHide: true });
  assert.equal(login.stdout.trim().length > 0, true);
  const created = await f.service.create({ name: '待登录', lifetime: 'persistent', target: 'claude-cli' }, extra);
  assert.equal(created.created, true, JSON.stringify(created));
  assert.equal(created.target, 'claude-cli');
  assert.equal(created.modelRequestsStarted, 0, 'creating a name starts no model turn');
  assert.deepEqual(f.invocations().filter(entry => entry.command === 'print'), [],
    'creation never ran a turn');
});

test('the first dispatch names the session, ask_parent reaches the caller, answer resumes that id, report_parent final delivers', async t => {
  const f = await assembly('ask-answer', { steps: [
    { mode: 'ask', message: 'Which directory should I write to?' },
    { mode: 'final', message: 'Delivered after the answer.' },
  ] });
  t.after(() => f.close());

  const created = await f.service.create({ name: '助手', lifetime: 'persistent', target: 'claude-cli' }, extra);
  assert.equal(created.created, true, JSON.stringify(created));
  const record = f.record('助手');
  const sent = await f.service.send({ name: '助手', message: 'do the work' }, extra);
  assert.equal(sent.name, '助手');

  const asked = await pollUntil(f, record.agentId, item => item?.state === 'awaiting_input' || item?.state === 'failed',
    { message: 'the subagent to ask its parent' });
  assert.equal(asked.state, 'awaiting_input', JSON.stringify(asked.error));

  // Wait for the turn itself: a probe invocation can be logged before it.
  let invocations = [];
  for (let attempt = 0; attempt < 100 && !turn(invocations, 0); attempt++) {
    invocations = f.invocations();
    if (!turn(invocations, 0)) await sleep(50);
  }
  const first = turn(invocations, 0);
  assert.ok(first, 'one CLI turn ran');
  assert.ok(first.argv.includes('--session-id'), `the first turn names the conversation: ${JSON.stringify(first.argv)}`);
  assert.equal(first.resumed, false);
  assert.equal(first.modelFlag, false, 'no --model is passed when the caller selected none');
  assert.equal(first.prompt, 'do the work');
  const sessionId = first.sessionId;
  assert.match(sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'the turn carries a real session UUID');

  // The question reached the caller, and it arrived through the real MCP server the
  // runner configured (the stand-in connected to `futureaide` and called the tool).
  assert.match(callerText(f.calls), /Which directory should I write to\?/);
  assert.deepEqual(first.calls?.map(call => [call.tool, call.ok]), [['ask_parent', true]],
    `the child really called ask_parent over MCP: ${JSON.stringify(first.calls)}`);
  const notices = Object.values(asked.task.questionNotices ?? {});
  assert.equal(notices.length, 1);
  assert.equal(notices[0].state, 'delivered', JSON.stringify(notices[0]));

  const answered = await f.service.answer({ name: '助手', message: 'Write under the project workspace.' }, extra);
  assert.notEqual(answered, undefined);
  const done = await pollUntil(f, record.agentId, item => item?.state === 'idle' || item?.state === 'failed',
    { message: 'the answered task to finish' });
  assert.equal(done.state, 'idle', JSON.stringify(done.error));

  const resumed = turn(f.invocations(), 1);
  assert.ok(resumed, 'the answer started a second turn');
  assert.equal(resumed.resumed, true);
  assert.ok(resumed.argv.includes('--resume'), JSON.stringify(resumed.argv));
  assert.equal(resumed.sessionId, sessionId, 'the answer resumes the original session UUID');
  assert.match(resumed.prompt, /Write under the project workspace/);

  // report_parent(final) is what finished the task, and it is what the caller saw.
  assert.deepEqual(resumed.calls?.map(call => [call.tool, call.ok]), [['report_parent', true]],
    `the child really reported over MCP: ${JSON.stringify(resumed.calls)}`);
  const report = done.task.reports.at(-1);
  assert.equal(report.final, true);
  assert.equal(report.delivery.state, 'delivered');
  assert.match(callerText(f.calls), /Delivered after the answer\./);
});

test('a final report reaches a large Codex owner without a full turn page', async t => {
  let owner;
  const f = await assembly('codex-large-owner', { steps: [{ mode: 'final', message: 'Large-thread delivery complete.' }],
    nativeRequestFactory: ({ workspace }) => {
      owner = codexOwner(workspace, { summary: params => params.itemsView === 'summary' ? page() : page() });
      return owner.request;
    } });
  t.after(() => f.close());
  const created = await f.service.create({ name: 'large-owner', lifetime: 'persistent', target: 'claude-cli' }, extra);
  assert.equal(created.created, true, JSON.stringify(created));
  const record = f.record('large-owner');
  await f.service.send({ name: 'large-owner', message: 'finish the work' }, extra);
  const done = await pollUntil(f, record.agentId, item => item?.state === 'idle' || item?.state === 'failed',
    { message: 'the final report to reach the large owner' });
  assert.equal(done.state, 'idle', JSON.stringify(done.error));
  assert.equal(done.task.reports[0].delivery.state, 'delivered');
  assert.equal(owner.calls.some(call => call.method === 'thread/turns/list'
    && call.params.itemsView === 'full' && (call.params.limit ?? 0) > 2), false);
  assert.ok(owner.calls.some(call => call.method === 'turn/start'
    && JSON.stringify(call.params).includes('Large-thread delivery complete.')));
});

test('a timed-out report is recovered from a summary marker instead of resending', async t => {
  let sentPrompt;
  let failed = false;
  let owner;
  const f = await assembly('codex-owner-readback', { steps: [{ mode: 'final', message: 'Recovered from the owner transcript.' }],
    nativeRequestFactory: ({ workspace }) => {
      owner = codexOwner(workspace, {
        onTurn: params => {
          if (!failed) { failed = true; sentPrompt = params.input?.[0]?.text ?? ''; return Object.assign(new Error('timed out'), { code: 'codex-native-rpc-response-timeout' }); }
          return { turn: { id: 'notice-turn-2' } };
        },
        summary: params => params.itemsView === 'summary' && sentPrompt
          ? page([{ id: 'notice-turn', status: 'completed', startedAt: Math.floor(Date.now() / 1000),
            completedAt: Math.floor(Date.now() / 1000), items: [{ id: 'u1', type: 'userMessage',
              content: [{ type: 'text', text: sentPrompt }] }] }])
          : page(),
      });
      return owner.request;
    } });
  t.after(() => f.close());
  const created = await f.service.create({ name: 'readback', lifetime: 'persistent', target: 'claude-cli' }, extra);
  assert.equal(created.created, true, JSON.stringify(created));
  const record = f.record('readback');
  await f.service.send({ name: 'readback', message: 'finish and report' }, extra);
  const done = await pollUntil(f, record.agentId, item => item?.state === 'idle' || item?.state === 'failed',
    { message: 'the report read-back to settle' });
  assert.equal(done.state, 'idle', JSON.stringify(done.error));
  assert.equal(done.task.reports[0].delivery.state, 'delivered');
  assert.ok(done.task.reports[0].delivery.recovered);
  assert.equal(owner.calls.filter(call => call.method === 'turn/start').length, 1, 'read-back never resends');
});

test('a confirmed missing marker resends the report exactly once', async t => {
  let sends = 0;
  let owner;
  const f = await assembly('codex-owner-resend', { steps: [{ mode: 'final', message: 'Resend after confirmed absence.' }],
    nativeRequestFactory: ({ workspace }) => {
      owner = codexOwner(workspace, {
        onTurn: () => ++sends === 1
          ? Object.assign(new Error('timed out'), { code: 'codex-native-rpc-response-timeout' })
          : { turn: { id: 'notice-turn-2' } },
        summary: () => page(),
      });
      return owner.request;
    } });
  t.after(() => f.close());
  const created = await f.service.create({ name: 'resend', lifetime: 'persistent', target: 'claude-cli' }, extra);
  assert.equal(created.created, true, JSON.stringify(created));
  const record = f.record('resend');
  await f.service.send({ name: 'resend', message: 'finish and report' }, extra);
  let current;
  for (let attempt = 0; attempt < 200; attempt++) {
    await f.service.poll(record.agentId);
    current = f.store.get(record.agentId);
    if (current?.task?.reports?.[0]?.delivery?.state === 'unknown') break;
    await sleep(40);
  }
  assert.equal(current.task.reports[0].delivery.state, 'unknown');
  current.task.reports[0].delivery.attemptedAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  current.task.reports[0].delivery.nextAttemptAt = 0;
  f.store.save(current);
  const done = await pollUntil(f, record.agentId, item => item?.state === 'idle' || item?.state === 'failed',
    { message: 'the one resend to settle' });
  assert.equal(done.state, 'idle', JSON.stringify(done.error));
  assert.equal(done.task.reports[0].delivery.state, 'delivered');
  assert.equal(sends, 2, 'exactly one resend');
});

test('read-back follows item cursors so a late steer message is found', async t => {
  let sentPrompt;
  let itemPage = 0;
  let owner;
  const f = await assembly('codex-owner-item-cursor', { steps: [{ mode: 'final', message: 'Found on the second item page.' }],
    nativeRequestFactory: ({ workspace }) => {
      owner = codexOwner(workspace, {
        onTurn: params => {
          sentPrompt = params.input?.[0]?.text ?? '';
          return Object.assign(new Error('timed out'), { code: 'codex-native-rpc-response-timeout' });
        },
        summary: () => page([{ id: 'notice-turn', status: 'completed', startedAt: Math.floor(Date.now() / 1000),
          completedAt: Math.floor(Date.now() / 1000), items: [] }]),
        items: () => {
          itemPage++;
          return itemPage === 1 ? { data: [], nextCursor: 'page-2' }
            : { data: [{ turnId: 'notice-turn', item: { id: 'u2', type: 'userMessage',
              content: [{ type: 'text', text: sentPrompt }] } }], nextCursor: null };
        },
      });
      return owner.request;
    } });
  t.after(() => f.close());
  const created = await f.service.create({ name: 'cursor', lifetime: 'persistent', target: 'claude-cli' }, extra);
  assert.equal(created.created, true, JSON.stringify(created));
  const record = f.record('cursor');
  await f.service.send({ name: 'cursor', message: 'finish and report' }, extra);
  const done = await pollUntil(f, record.agentId, item => item?.state === 'idle' || item?.state === 'failed',
    { message: 'the cursor page read-back to settle' });
  assert.equal(done.state, 'idle', JSON.stringify(done.error));
  assert.equal(done.task.reports[0].delivery.state, 'delivered');
  assert.equal(itemPage, 2);
  assert.equal(owner.calls.filter(call => call.method === 'turn/start').length, 1, 'no resend was needed');
});

test('an unconfirmed final lets a new task start and returns previousReport', async t => {
  let owner;
  const f = await assembly('codex-owner-next-task', { steps: [
    { mode: 'final', message: 'First task body.' },
    { mode: 'final', message: 'Second task body.' },
  ], nativeRequestFactory: ({ workspace }) => {
    owner = codexOwner(workspace, {
      onTurn: () => Object.assign(new Error('timed out'), { code: 'codex-native-rpc-response-timeout' }),
      summary: () => page(),
    });
    return owner.request;
  } });
  t.after(() => f.close());
  const created = await f.service.create({ name: 'next-task', lifetime: 'persistent', target: 'claude-cli' }, extra);
  assert.equal(created.created, true, JSON.stringify(created));
  const record = f.record('next-task');
  await f.service.send({ name: 'next-task', message: 'first task' }, extra);
  const pending = await pollUntil(f, record.agentId, item => item?.state === 'delivery_pending',
    { message: 'the first final to remain unconfirmed' });
  assert.equal(pending.task.reports[0].delivery.state, 'unknown');
  const sent = await f.service.send({ name: 'next-task', message: 'second task' }, extra);
  assert.equal(sent.previousReport.delivered, false);
  assert.match(sent.previousReport.summary, /First task body/);
  const current = f.store.get(record.agentId);
  assert.equal(current.task.message, 'second task');
  const old = f.store.historyFor(record.agentId).find(task => task.taskId === pending.task.taskId);
  assert.equal(old.reports[0].delivery.state, 'blocked');
  assert.equal(old.reports[0].delivery.error.reason, 'unconfirmed');
});

test('a persistent name keeps one conversation, and an ordinary reply only leaves the task awaiting a report', async t => {
  const f = await assembly('persistent', { steps: [
    { mode: 'final', message: 'First task delivered.' },
    { mode: 'text', text: 'ordinary progress text, no report at all' },
  ] });
  t.after(() => f.close());

  await f.service.create({ name: '长期助手', lifetime: 'persistent', target: 'claude-cli' }, extra);
  const record = f.record('长期助手');
  await f.service.send({ name: '长期助手', message: 'first task' }, extra);
  const idle = await pollUntil(f, record.agentId, item => item?.state === 'idle' || item?.state === 'failed',
    { message: 'the first task to be delivered' });
  assert.equal(idle.state, 'idle', JSON.stringify(idle.error));
  assert.match(callerText(f.calls), /First task delivered\./);
  const firstSession = turn(f.invocations(), 0).sessionId;

  await f.service.send({ name: '长期助手', message: 'second task' }, extra);
  const awaiting = await pollUntil(f, record.agentId, item => item?.state === 'awaiting_report' || item?.state === 'failed',
    { message: 'ordinary text to leave the task awaiting a report' });
  assert.equal(awaiting.state, 'awaiting_report', 'ordinary text never completes a task');
  assert.equal(awaiting.task.reports?.length ?? 0, 0, 'no report was submitted');

  const second = turn(f.invocations(), 1);
  assert.equal(second.resumed, true,
    `the second task continues the same conversation: ${JSON.stringify(f.invocations().filter(e => e.command === 'print').map(e => ({ resumed: e.resumed, sessionId: e.sessionId, mode: e.mode, prompt: e.prompt })))}`);
  assert.equal(second.sessionId, firstSession, 'a persistent name keeps its one session UUID');
  const beforeReminder = f.calls.length;
  assert.equal(callerText(f.calls).includes('ordinary progress text'), false,
    'an ordinary reply is never reported to the caller');
  assert.equal(f.calls.length, beforeReminder);
});

test('a permission denial is visible in inspect instead of being reported as done', async t => {
  const f = await assembly('denied', { steps: [
    { mode: 'deny', tool: 'Bash', reason: 'Bash(git push) is not allowed by the current permission policy.' },
  ] });
  t.after(() => f.close());

  await f.service.create({ name: '拒绝助手', lifetime: 'persistent', target: 'claude-cli' }, extra);
  const record = f.record('拒绝助手');
  await f.service.send({ name: '拒绝助手', message: 'push the branch' }, extra);
  const awaiting = await pollUntil(f, record.agentId,
    item => item?.state === 'awaiting_report' || item?.state === 'failed',
    { message: 'the denied turn to end' });
  assert.equal(awaiting.state, 'awaiting_report', JSON.stringify(awaiting.error));
  assert.equal(awaiting.task.reports?.length ?? 0, 0, 'a denial is not a completed task');

  const inspected = await f.service.inspect({ name: '拒绝助手' }, extra);
  const text = JSON.stringify(inspected);
  assert.match(text, /Permission denied/, 'the denial is readable by the caller');
  assert.match(text, /Bash\(git push\) is not allowed/, 'the denied call and its reason are kept');
  assert.equal(inspected.inspectionIncomplete, false);
});

test('a failing CLI turn is reported with its stdout, and cancelling stops the whole process tree', async t => {
  const failing = await assembly('failure', { steps: [
    { mode: 'fail', stdout: 'partial output before the failure', stderr: 'API Error: 500 internal error' },
  ] });
  t.after(() => failing.close());
  await failing.service.create({ name: '失败助手', lifetime: 'persistent', target: 'claude-cli' }, extra);
  const failedRecord = failing.record('失败助手');
  await failing.service.send({ name: '失败助手', message: 'run the failing task' }, extra);
  const failed = await pollUntil(failing, failedRecord.agentId, item => item?.state === 'failed',
    { message: 'the failing turn' });
  assert.equal(failed.state, 'failed');
  const dispatch = failed.task.dispatches.at(-1);
  assert.equal(dispatch.state, 'failed');
  const reason = JSON.stringify(dispatch.failure ?? dispatch.error ?? {});
  assert.match(reason, /500 internal error/, 'the CLI stderr is kept as the reason');
  assert.match(callerText(failing.calls), /失败助手/, 'the failure reached the caller');
  const inspected = await failing.service.inspect({ name: '失败助手' }, extra);
  assert.match(JSON.stringify(inspected), /partial output before the failure/, 'stdout stays readable after the failure');

  const hanging = await assembly('cancel', { steps: [{ mode: 'hang', ms: 120000 }] });
  t.after(() => hanging.close());
  await hanging.service.create({ name: '长跑助手', lifetime: 'persistent', target: 'claude-cli' }, extra);
  const runningRecord = hanging.record('长跑助手');
  await hanging.service.send({ name: '长跑助手', message: 'long running work' }, extra);
  await pollUntil(hanging, runningRecord.agentId, item => item?.state === 'running',
    { message: 'the long turn to start' });
  let turnState;
  const pidDeadline = Date.now() + 20000;
  while (Date.now() < pidDeadline) {
    turnState = await hanging.turnState(runningRecord);
    if (turnState?.state?.pid) break;
    await sleep(100);
  }
  const pid = turnState?.state?.pid;
  assert.equal(Number.isSafeInteger(pid), true, `the CLI process id was recorded: ${JSON.stringify(turnState?.state ?? {})}`);
  assert.equal(pidAlive(pid), true, 'the stand-in CLI process is really running');

  const cancelled = await hanging.service.cancel({ name: '长跑助手' }, extra);
  assert.equal(cancelled.accepted !== false || cancelled.queued === true, true, JSON.stringify(cancelled));
  await pollUntil(hanging, runningRecord.agentId,
    item => item?.task?.cancelRequested === true && ['cancelled', 'running', 'failed'].includes(item.state),
    { message: 'the cancel intent' });
  const deadline = Date.now() + 20000;
  while (pidAlive(pid) && Date.now() < deadline) await sleep(200);
  assert.equal(pidAlive(pid), false, 'the cancelled CLI process tree is gone, not merely marked cancelled');
  const after = hanging.record('长跑助手');
  assert.equal(after.task.cancelRequested, true);
  const finalTurn = await hanging.turnState(after);
  assert.equal(finalTurn.state.state, 'cancelled', JSON.stringify(finalTurn.state.state));
});

test('a once name is cleaned up after its final report, while a persistent name is only removed by delete', async t => {
  const f = await assembly('cleanup', { steps: [
    { mode: 'final', message: 'One-shot result delivered.' },
    { mode: 'final', message: 'Persistent result delivered.' },
  ] });
  t.after(() => f.close());

  await f.service.create({ name: '一次性助手', lifetime: 'once', target: 'claude-cli' }, extra);
  const once = f.record('一次性助手');
  await f.service.send({ name: '一次性助手', message: 'one-shot task' }, extra);
  await pollUntil(f, once.agentId, item => item === undefined || item.state === 'idle',
    { message: 'the one-shot name to close' });
  assert.equal(f.store.get(once.agentId), undefined, 'a once name leaves the roster after its final report is delivered');
  assert.equal((await f.service.list(extra)).items.some(item => item.name === '一次性助手'), false);
  assert.match(callerText(f.calls), /One-shot result delivered\./);

  await f.service.create({ name: '长期助手', lifetime: 'persistent', target: 'claude-cli' }, extra);
  const persistent = f.record('长期助手');
  await f.service.send({ name: '长期助手', message: 'persistent task' }, extra);
  const idle = await pollUntil(f, persistent.agentId, item => item?.state === 'idle' || item?.state === 'failed',
    { message: 'the persistent task to finish' });
  assert.equal(idle.state, 'idle', JSON.stringify(idle.error));
  assert.ok(f.store.get(persistent.agentId), 'a persistent name stays after its final report');
  const { sessionId } = f.invocations().findLast(item => item.command === 'print');
  const transcript = path.join(f.home, 'sessions', sessionId + '.json');
  const original = await readFile(transcript, 'utf8');
  const removed = await f.service.delete({ name: '长期助手' }, extra);
  assert.equal(removed.queued, true);
  assert.equal(removed.nativeHistoryPolicy, 'retain');
  const receipt = await f.service.poll(persistent.agentId);
  assert.equal(receipt.deleted, true, JSON.stringify(receipt));
  assert.equal(receipt.nativeSessionRetained, true);
  assert.equal(receipt.sessionDataRemoved, false);
  assert.equal(await readFile(transcript, 'utf8'), original);
  assert.equal(f.store.get(persistent.agentId), undefined);
  assert.equal((await f.service.list(extra)).items.some(item => item.name === '长期助手'), false);
});
