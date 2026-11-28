import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { diagnoseTarget, resolveBackend, TARGETS } from '../src/agent-backend.mjs';
import { createDesktopCleanup } from '../src/cleanup-desktop.mjs';
import { createCodexCliBackend } from '../src/codex-cli-backend.mjs';
import {
  buildCodexCliArgs,
  probeCodexCli,
  readCodexCliModels,
} from '../src/codex-cli-runner.mjs';

async function startTcpServer() {
  const server = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function createFakeCodexScript(dir) {
  const scriptPath = path.join(dir, 'fake-codex.mjs');
  const script = `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('codex-cli 0.171.0-fake');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  if (process.env.FAKE_CODEX_LOGGED_OUT === '1') {
    console.log('Not logged in');
    process.exit(1);
  }
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (args[0] === 'exec') {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  const recordFile = process.env.FAKE_CODEX_RECORD_FILE;
  if (recordFile) {
    writeFileSync(recordFile, JSON.stringify({
      args,
      cwd: process.cwd(),
      stdin,
      httpProxy: process.env.HTTP_PROXY ?? null,
      httpsProxy: process.env.HTTPS_PROXY ?? null,
      codexHome: process.env.CODEX_HOME ?? null,
    }, null, 2));
  }
  const isResume = args[1] === 'resume';
  const threadId = isResume ? args[args.length - 2] : 'thread-fake-001';
  console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  if (stdin.includes('HANG_FOREVER')) {
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  const reply = isResume ? 'Resumed reply: ' + stdin.trim().slice(-40) : 'Fresh reply: ok';
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: reply },
  }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }));
  process.exit(0);
}
console.error('Unknown args: ' + args.join(' '));
process.exit(2);
`;
  await writeFile(scriptPath, script, 'utf8');
  return scriptPath;
}

async function waitFor(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Timed out waiting for condition.');
}

test('TARGETS includes codex-cli and buildCodexCliArgs injects stdin prompt and callback MCP without --cd on resume', () => {
  assert.ok(TARGETS.includes('codex-cli'));

  const fresh = buildCodexCliArgs({
    workspace: 'D:\\repo',
    model: 'gpt-6.2-sol',
    effort: 'high',
    turnDir: 'D:\\state\\turn1',
    reportConfig: { serverName: 'futureaide_report', command: process.execPath, args: ['mcp.mjs', '--codex-cli-reports'] },
  });
  assert.equal(fresh[0], 'exec');
  assert.ok(fresh.includes('--json'));
  assert.ok(fresh.includes('--skip-git-repo-check'));
  assert.ok(fresh.includes('--cd'));
  assert.ok(fresh.includes('gpt-6.2-sol'));
  assert.ok(fresh.some(arg => arg.includes('model_reasoning_effort="high"')));
  assert.ok(fresh.some(arg => arg.includes('mcp_servers.futureaide_report.command=')));
  assert.equal(fresh.at(-1), '-');

  const resumed = buildCodexCliArgs({
    workspace: 'D:\\repo',
    threadId: 'thread-abc',
    resume: true,
    model: 'gpt-6.2-sol',
  });
  assert.deepEqual(resumed.slice(0, 2), ['exec', 'resume']);
  assert.ok(!resumed.includes('--cd'), 'codex exec resume must not pass --cd');
  assert.equal(resumed.at(-2), 'thread-abc');
  assert.equal(resumed.at(-1), '-');
});

test('readCodexCliModels parses models_cache.json and config.toml default model', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'fa-codex-home-'));
  try {
    await writeFile(path.join(home, 'config.toml'), 'model = "gpt-6.2-sol"\nmodel_reasoning_effort = "xhigh"\n');
    await writeFile(path.join(home, 'models_cache.json'), JSON.stringify({
      models: [
        {
          slug: 'gpt-6.2-sol',
          display_name: 'gpt-6.2-sol',
          visibility: 'list',
          default_reasoning_level: 'high',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'xhigh' }],
        },
        {
          slug: 'hidden-internal',
          visibility: 'hide',
        },
      ],
    }));
    const catalog = await readCodexCliModels({ codexHome: home });
    assert.equal(catalog.default.provider, 'openai');
    assert.equal(catalog.default.model, 'gpt-6.2-sol');
    assert.equal(catalog.default.reasoningEffort, 'xhigh');
    assert.deepEqual(catalog.groups[0].models.map(m => m.id), ['gpt-6.2-sol']);
    assert.deepEqual(catalog.groups[0].models[0].reasoning.efforts.map(e => e.id), ['low', 'high', 'xhigh']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('codex-cli backend runs fresh turn, resumes threadId, injects proxy env, answers questions, cancels, and cleans up', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fa-codex-e2e-'));
  const proxy = await startTcpServer();
  const fakeScript = await createFakeCodexScript(dir);
  const recordFile = path.join(dir, 'last-invocation.json');
  const codexHome = path.join(dir, 'codex-home');
  const stateDir = path.join(dir, 'state');
  const prevRecordFile = process.env.FAKE_CODEX_RECORD_FILE;
  process.env.FAKE_CODEX_RECORD_FILE = recordFile;
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-6.2-sol"\n');
    await writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({
      models: [{ slug: 'gpt-6.2-sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }] }],
    }));

    let nativeState;
    const submissions = { questions: [], reports: [] };
    const record = {
      agentId: 'agent-1',
      ownerId: 'owner-1',
      sessionId: 'session-1',
      name: 'codex-worker',
      target: 'codex-cli',
      workspace: dir,
      created: false,
      task: { taskId: 'task-1' },
    };
    const requestDir = path.join(stateDir, 'scoped', record.ownerId, record.agentId);
    const cliSpec = { command: process.execPath, prefixArgs: [fakeScript] };
    const route = {
      ok: true,
      source: 'faswitch',
      mode: 'proxy',
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
      port: proxy.port,
      profileName: 'xiayuip-win',
      profileId: 'prof-1',
      node: 'fa:clash:Xiayu',
      codexHome,
    };

    const runnerModule = await import('../src/codex-cli-runner.mjs');
    const wrappedRunner = {
      ...runnerModule,
      probeCodexCli: opts => probeCodexCli({
        ...opts,
        cli: cliSpec,
        resolveRoute: async () => route,
      }),
    };

    const backend = createCodexCliBackend(record, {
      load: () => record,
      requestDirectory: () => requestDir,
      readNativeState: () => nativeState,
      writeNativeState: value => { nativeState = structuredClone(value); return true; },
      readParentSubmissions: async () => submissions,
      codexCliReportConfig: reqId => ({
        serverName: 'futureaide_report',
        command: process.execPath,
        args: ['fake-mcp.mjs', '--codex-cli-reports', reqId],
      }),
      runner: wrappedRunner,
    });

    // 1. Probe surfaces route summary & protocol=1
    const probed = await backend.probe();
    assert.equal(probed.treeProtocol, 1);
    assert.equal(probed.reportProtocol, 1);
    assert.equal(probed.route.profile, 'xiayuip-win');
    assert.equal(probed.route.port, proxy.port);

    // 2. Create reserves session with 0 model requests
    const created = await backend.create();
    assert.equal(created.sessionId, 'session-1');
    assert.equal(created.modelRequestsStarted, 0);
    record.created = true;

    // 3. Begin task & deliver fresh turn
    await backend.beginTask();
    const sent1 = await backend.deliver({
      requestId: 'req-1',
      message: 'Check status',
      model: { provider: 'openai', model: 'gpt-6.2-sol', reasoningEffort: 'medium' },
    });
    assert.equal(sent1.accepted, true);
    assert.equal(sent1.actualModel, 'gpt-6.2-sol');
    assert.equal(sent1.actualEffort, 'medium');

    await waitFor(async () => (await backend.turn({ requestId: 'req-1' })).state === 'ended');
    const obs1 = await backend.observe();
    assert.equal(obs1.running, false);
    assert.equal(nativeState.threadId, 'thread-fake-001');

    const inv1 = JSON.parse(await readFile(recordFile, 'utf8'));
    assert.equal(inv1.httpProxy, `http://127.0.0.1:${proxy.port}`);
    assert.equal(inv1.httpsProxy, `http://127.0.0.1:${proxy.port}`);
    assert.equal(inv1.codexHome, codexHome);
    assert.ok(inv1.args.some(a => a.includes('mcp_servers.futureaide_report.command=')));

    const hist1 = await backend.history({ maxMessages: 10 });
    assert.ok(hist1.messages.some(m => m.role === 'assistant' && m.text.includes('Fresh reply: ok')));

    // 4. Question & answer flow
    submissions.questions.push({ id: 'q-1', taskId: 'task-1', state: 'pending', message: 'Proceed?' });
    const answered = await backend.answer({ answerId: 'ans-1', message: 'Yes proceed' });
    assert.deepEqual(answered.consumedQuestionIds, ['q-1']);
    assert.match(answered.continuation, /Yes proceed/);

    // 5. Second deliver uses `codex exec resume thread-fake-001 -`
    const sent2 = await backend.deliver({
      requestId: 'req-2',
      message: answered.continuation,
      model: { provider: 'openai', model: 'gpt-6.2-sol' },
    });
    assert.equal(sent2.accepted, true);
    await waitFor(async () => (await backend.turn({ requestId: 'req-2' })).state === 'ended');
    const inv2 = JSON.parse(await readFile(recordFile, 'utf8'));
    assert.deepEqual(inv2.args.slice(0, 2), ['exec', 'resume']);
    assert.ok(!inv2.args.includes('--cd'));
    assert.equal(inv2.args.at(-2), 'thread-fake-001');

    // 6. Cancel a hanging turn cleanly
    const sent3 = await backend.deliver({
      requestId: 'req-3',
      message: 'HANG_FOREVER',
      model: { provider: 'openai', model: 'gpt-6.2-sol' },
    });
    assert.equal(sent3.accepted, true);
    await waitFor(async () => (await backend.observe()).running === true);
    const cancelled = await backend.cancel();
    assert.equal(cancelled.cancelRequested, true);
    const turn3 = await backend.turn({ requestId: 'req-3' });
    assert.equal(turn3.state, 'ended');
    assert.equal(turn3.completionReason.kind, 'cancelled');

    // 7. Cleanup desktop adapter recognizes codex-cli and retains native history
    const cleanup = createDesktopCleanup({ stateDirectory: stateDir });
    const inspected = await cleanup.inspect(record, nativeState);
    assert.equal(inspected.running, false);
    assert.equal(inspected.historyPresent, true);
    const removed = await cleanup.remove(record, nativeState, inspected);
    assert.equal(removed.removed, true);
    assert.equal(removed.nativeSessionRetained, true);
  } finally {
    if (prevRecordFile === undefined) delete process.env.FAKE_CODEX_RECORD_FILE;
    else process.env.FAKE_CODEX_RECORD_FILE = prevRecordFile;
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('disabledTargets blocks codex-cli in both diagnoseTarget and resolveBackend', async () => {
  const diagnosed = await diagnoseTarget('codex-cli', { config: { disabledTargets: ['codex-cli'] } });
  assert.equal(diagnosed.ready, false);
  assert.equal(diagnosed.disabled, true);
  assert.equal(diagnosed.reason.code, 'target-disabled');

  await assert.rejects(
    () => resolveBackend({ target: 'codex-cli' }, { config: { disabledTargets: ['codex-cli'] } }),
    error => error.code === 'target-disabled',
  );
});
