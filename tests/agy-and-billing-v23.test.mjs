import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { TARGETS, resolveBackend } from '../src/agent-backend.mjs';
import {
  AGY_CLI_FALLBACK_MODELS,
  DEFAULT_TURN_TIMEOUT_MS,
  applyAgyLine,
  buildAgyCliArgs,
  createAgyTurnState,
  findAgyCli,
  parseAgyModelsOutput,
  processAlive,
  readAgyCliModels,
  resolveTurnTimeoutMs,
} from '../src/agy-cli-runner.mjs';
import {
  resolveConversationId,
  resolveManagedCliBinding,
  startAntigravityCallerBridge,
} from '../src/antigravity-caller-bootstrap.mjs';
import { TRUSTED_CALLER } from '../src/calling-context.mjs';
import { startReportService } from '../src/claude-report-server.mjs';
import { loadConfig } from '../src/config.mjs';
import { scopedManagement } from '../src/mcp-server.mjs';
import { killProcessCage } from '../src/process-cage.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { resolveRoleDefaults } from '../src/team-config-defaults.mjs';

const execFileAsync = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pluginRoot, '..', '..');
const cliScript = path.join(pluginRoot, 'src', 'cli.mjs');
const tmpBase = path.join(repoRoot, '.work', 'tmp', 'agy-and-billing-v23');

async function makeTempDir(t, prefix = 'v23-') {
  await mkdir(tmpBase, { recursive: true });
  const dir = await mkdtemp(path.join(tmpBase, prefix));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  return dir;
}

function agyCallerExtra(conversationId, workspace) {
  return {
    [TRUSTED_CALLER]: {
      source: 'antigravity',
      conversationId,
      workspace,
    },
  };
}

async function pollUntil(fn, { timeoutMs = 15000, intervalMs = 80, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastVal;
  while (Date.now() < deadline) {
    lastVal = await fn();
    if (lastVal) return lastVal;
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

async function initTempGitRepo(repoDir) {
  await mkdir(repoDir, { recursive: true });
  await execFileAsync('git', ['-C', repoDir, 'init'], { windowsHide: true });
  await execFileAsync('git', ['-C', repoDir, 'config', 'user.email', 'ci@example.invalid'], { windowsHide: true });
  await execFileAsync('git', ['-C', repoDir, 'config', 'user.name', 'FutureAide Test'], { windowsHide: true });
  await writeFile(path.join(repoDir, '.gitignore'), '.work/\n', 'utf8');
  await mkdir(path.join(repoDir, 'src'), { recursive: true });
  await writeFile(path.join(repoDir, 'src', 'app.js'), 'export const version = 1;\n', 'utf8');
  await writeFile(path.join(repoDir, 'src', 'legacy.js'), 'export const obsolete = true;\n', 'utf8');
  await execFileAsync('git', ['-C', repoDir, 'add', '-A'], { windowsHide: true });
  await execFileAsync('git', ['-C', repoDir, 'commit', '-m', 'initial'], { windowsHide: true });
}

// ---------------------------------------------------------------------------
// 1. agy-cli discovery, model catalog, CLI args, NDJSON stream & role defaults
// ---------------------------------------------------------------------------

test('agy-cli: discovery precedence, real `agy models` parsing, tier-aware argv, and open-source role defaults', async t => {
  const root = await makeTempDir(t, 'catalog-');

  assert.ok(TARGETS.includes('agy-cli'), 'TARGETS must include agy-cli');
  assert.equal(DEFAULT_TURN_TIMEOUT_MS, 25 * 60 * 1000);
  assert.equal(resolveTurnTimeoutMs({}), 25 * 60 * 1000);
  assert.equal(resolveTurnTimeoutMs({ config: { turnTimeoutMinutes: 10 } }), 10 * 60 * 1000);
  assert.equal(resolveTurnTimeoutMs({ timeoutMinutes: 2, config: { turnTimeoutMinutes: 10 } }), 2 * 60 * 1000);
  assert.equal(resolveTurnTimeoutMs({ timeoutMs: 450, timeoutMinutes: 2 }), 450);

  // Discovery precedence: explicitPath -> env.AGY_CLI -> PATH -> %LOCALAPPDATA%\agy\bin\agy.exe -> ~/.local/bin/agy
  const fakeLocalAppData = path.join(root, 'LocalAppData');
  const fakeWinBin = path.join(fakeLocalAppData, 'agy', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  const fakePathDir = path.join(root, 'path-bin');
  const fakePathBin = path.join(fakePathDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
  await mkdir(path.dirname(fakeWinBin), { recursive: true });
  await mkdir(fakePathDir, { recursive: true });
  await writeFile(fakeWinBin, 'stub', 'utf8');
  await writeFile(fakePathBin, 'stub', 'utf8');

  assert.equal(
    await findAgyCli({ explicitPath: '/opt/custom/agy', env: { AGY_CLI: '/env/agy', PATH: fakePathDir, LOCALAPPDATA: fakeLocalAppData } }),
    '/opt/custom/agy',
  );
  assert.equal(
    await findAgyCli({ env: { AGY_CLI: '/env/agy', PATH: fakePathDir, LOCALAPPDATA: fakeLocalAppData } }),
    '/env/agy',
  );
  assert.equal(
    await findAgyCli({ env: { PATH: fakePathDir, LOCALAPPDATA: fakeLocalAppData } }),
    fakePathBin,
  );
  assert.equal(
    await findAgyCli({ env: { PATH: '', LOCALAPPDATA: fakeLocalAppData } }),
    fakeWinBin,
  );
  // Ensure homedir() fallback works without hardcoded usernames
  assert.ok(typeof homedir() === 'string' && homedir().length > 0);

  // Parse real `agy models` <id>\t<Display Name> output and sort `-high` first per family
  const sampleModelsStdout = [
    'gemini-4-neon-low\tGemini 4 Neon (Low)',
    'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
    'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
    'gemini-4-carbon-high\tGemini 4 Carbon (High)',
    'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  ].join('\n');
  const parsed = parseAgyModelsOutput(sampleModelsStdout);
  assert.equal(parsed[0].id, 'gemini-4-neon-high', '`-high` must lead the neon family so substring "neon" resolves to gemini-4-neon-high');
  assert.equal(parsed[1].id, 'gemini-4-neon-xhigh');
  const carbonFirst = parsed.find(m => m.id.includes('carbon'));
  assert.equal(carbonFirst?.id, 'gemini-4-carbon-high');

  // Dynamic model pass-through + fallback catalog
  const catalog = await readAgyCliModels({
    liveDiscovery: false,
    settingsPath: path.join(root, 'missing-settings.json'),
    extraModels: ['experimental-future-model-v9'],
  });
  const catalogIds = catalog.groups[0].models.map(m => m.id);
  for (const fb of AGY_CLI_FALLBACK_MODELS) {
    assert.ok(catalogIds.includes(fb.id), `Fallback model ${fb.id} present`);
  }
  assert.ok(catalogIds.includes('experimental-future-model-v9'), 'Dynamic custom model passed through');

  // Tier-aware CLI argv construction: omit --effort when model ID already ends with tier suffix
  const suffixedArgs = buildAgyCliArgs({
    prompt: 'hello world',
    model: 'gemini-4-neon-high',
    effort: 'high',
    resume: false,
  });
  assert.deepEqual(suffixedArgs, [
    '-p', 'hello world',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--model', 'gemini-4-neon-high',
  ]);

  const unsuffixedResumeArgs = buildAgyCliArgs({
    prompt: 'continue work',
    conversationId: 'conv-agy-123',
    resume: true,
    model: 'pro',
    effort: 'xhigh',
  });
  assert.deepEqual(unsuffixedResumeArgs, [
    '-p', 'continue work',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--conversation', 'conv-agy-123',
    '--model', 'pro',
    '--effort', 'xhigh',
  ]);

  // Official NDJSON stream event folding
  const state = createAgyTurnState({ requestId: 'req-1', message: 'ping' });
  applyAgyLine(state, JSON.stringify({ event: 'init', conversation_id: 'conv-stream-42', init: { model: 'gemini-4-neon-high' } }));
  assert.equal(state.conversationId, 'conv-stream-42');
  assert.equal(state.model, 'gemini-4-neon-high');
  assert.equal(state.actualEffort, 'high');

  applyAgyLine(state, JSON.stringify({
    event: 'step_update',
    step_update: { step_type: 'thinking', usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 30 } },
  }));
  assert.equal(state.lastStep, '思考推理中');
  assert.equal(state.usage.inputTokens, 100);

  applyAgyLine(state, JSON.stringify({
    event: 'step_update',
    step_update: { step_type: 'text', text_delta: 'Partial ' },
  }));
  applyAgyLine(state, JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'conv-stream-42',
      status: 'SUCCESS',
      response: 'Final synthesized answer',
      duration_seconds: 3.456,
      usage: {
        input_tokens: 250,
        output_tokens: 90,
        cache_read_tokens: 60,
        total_tokens: 400,
      },
    },
  }));
  assert.equal(state.turnCompleted, true);
  assert.equal(state.resultText, 'Final synthesized answer');
  assert.deepEqual(state.usage, {
    inputTokens: 250,
    outputTokens: 90,
    cachedTokens: 60,
    totalTokens: 400,
    durationSec: 3.46,
  });

  // Brand hint: antigravity / agy -> agy-cli with null model/effort (follows CLI default) when roles.md does not exist!
  const missingTeamConfig = path.join(root, 'nonexistent-roles.md');
  for (const roleAlias of ['antigravity', 'agy']) {
    const resolved = resolveRoleDefaults(roleAlias, { teamConfigPath: missingTeamConfig });
    assert.equal(resolved.target, 'agy-cli');
    assert.equal(resolved.model, null);
    assert.equal(resolved.effort, null);
    assert.equal(resolved.lifetime, 'once');
  }
});

// ---------------------------------------------------------------------------
// 2. agy-cli full loop: stream, resume, callback bridge (HTTP + offline fallback),
//    nested child subagent spawning via antigravity-caller-bootstrap, & cage cleanup
// ---------------------------------------------------------------------------

test('agy-cli: end-to-end execution, --conversation resume, managed bootstrap ask/report + nested child spawn, and orphan cage cleanup', async t => {
  const root = await makeTempDir(t, 'agy-e2e-');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const binDir = path.join(root, 'bin');
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const bootstrapModuleUrl = new URL('../src/antigravity-caller-bootstrap.mjs', import.meta.url).href;
  const argvLogPath = path.join(root, 'agy-argv-log.jsonl');
  const sleeperPidFile = path.join(root, 'orphan-sleeper.pid');
  const mockAgyJs = path.join(binDir, 'mock-agy.mjs');

  await writeFile(mockAgyJs, `
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { startAntigravityCallerBridge } from ${JSON.stringify(bootstrapModuleUrl)};

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('1.5.18\\n');
  process.exit(0);
}
if (args[0] === 'models') {
  process.stderr.write('Fetching available models...\\n');
  process.stdout.write([
    'gemini-4-neon-high\\tGemini 4 Neon (High)',
    'gemini-4-neon-xhigh\\tGemini 4 Neon (XHigh)',
    'gemini-4-carbon-high\\tGemini 4 Carbon (High)',
    'gemini-3.8-flash-high\\tGemini 3.8 Flash (High)',
  ].join('\\n') + '\\n');
  process.exit(0);
}

appendFileSync(${JSON.stringify(argvLogPath)}, JSON.stringify({ args, envManaged: process.env.FUTUREAIDE_MANAGED_CLI }) + '\\n');

const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? args[pIdx + 1] : '';
const cIdx = args.indexOf('--conversation');
const convIn = cIdx >= 0 ? args[cIdx + 1] : null;
const mIdx = args.indexOf('--model');
const modelIn = mIdx >= 0 ? args[mIdx + 1] : 'gemini-4-neon-high';
const convId = convIn || 'agy-conv-session-777';

// Spawn a background sleeper grandchild on turn 1 to prove process-cage cleans up orphans
if (!convIn) {
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  writeFileSync(${JSON.stringify(sleeperPidFile)}, String(sleeper.pid));
  sleeper.unref();
}

process.stdout.write(JSON.stringify({
  event: 'init',
  conversation_id: convId,
  init: { model: modelIn },
}) + '\\n');

process.stdout.write(JSON.stringify({
  event: 'step_update',
  step_update: {
    step_type: 'tool_use',
    tool_name: convIn ? 'report_parent' : 'ask_parent',
    usage: { input_tokens: 80, output_tokens: 20, cache_read_tokens: 10 },
  },
}) + '\\n');

const bridge = await startAntigravityCallerBridge({
  coldStartMonitor: false,
  env: process.env,
  cwd: process.cwd(),
  log: () => {},
});

try {
  const tools = await bridge.fetchTools({}, {});
  const names = tools.map(item => item.name);
  if (!names.includes('ask_parent') || !names.includes('report_parent')) {
    throw new Error('Managed parent tools missing from antigravity-caller-bootstrap');
  }
  if (prompt.includes('MANUAL_OFFLINE_CALLBACK')) {
    // Let the outer test invoke offlineBridge.callTool('report_parent') directly
  } else if (!convIn) {
    // Turn 1: ask parent a question
    await bridge.callTool('ask_parent', { message: 'Which strategy should we use?' }, {}, {});
  } else {
    // Turn 2: spawn a child subagent as team lead (when server is online), then report final
    if (prompt.includes('SPAWN_CHILD_TOO')) {
      await bridge.callTool('futureaide_create_agent', {
        name: 'sub-worker',
        target: 'agy-cli',
        lifetime: 'persistent',
        model: 'neon',
      }, {}, {});
    }
    await bridge.callTool('report_parent', {
      message: 'Completed with strategy: ' + prompt.slice(0, 80),
      final: true,
    }, {}, {});
  }
} finally {
  await bridge.close();
}

process.stdout.write(JSON.stringify({
  event: 'result',
  result: {
    conversation_id: convId,
    status: 'SUCCESS',
    response: convIn ? 'Turn 2 done' : 'Asked parent',
    duration_seconds: convIn ? 1.75 : 1.25,
    usage: convIn
      ? { input_tokens: 300, output_tokens: 120, cache_read_tokens: 50, total_tokens: 470 }
      : { input_tokens: 200, output_tokens: 60, cache_read_tokens: 40, total_tokens: 300 },
  },
}) + '\\n');
`, 'utf8');

  const configPath = path.join(root, 'config.json');
  // Reserve an ephemeral port first so parallel tests never collide
  const freePort = await new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });

  await writeFile(configPath, JSON.stringify({
    workspace,
    stateDirectory: stateDir,
    reportPort: freePort,
    agyCliPath: mockAgyJs,
    cliRoutes: {
      'agy-cli': 'direct',
      'codex-cli': 'direct',
      'claude-cli': 'direct',
    },
    disabledTargets: ['dsh'],
    idleSessionCleanup: false,
  }, null, 2), 'utf8');

  const config = await loadConfig(configPath);
  const service = createScopedAgents(config, {
    startSharedMonitor: async () => true,
  });
  t.after(() => service.close());

  const reportServer = await startReportService({
    port: freePort,
    runtimeDir: stateDir,
    store: service.store,
    management: scopedManagement({ service }),
  });
  t.after(async () => {
    await reportServer.close().catch(() => {});
  });

  const bossExtra = agyCallerExtra('boss-conv-v23', workspace);

  // Substring 'neon' + effort 'xhigh' resolves cleanly to 'gemini-4-neon-xhigh' and omits conflicting --effort
  const runReceipt = await service.run({
    name: 'brain-lead',
    role: '团队长',
    target: 'agy-cli',
    lifetime: 'persistent',
    model: 'neon',
    effort: 'xhigh',
    message: 'Analyze architecture and ask if unsure',
  }, bossExtra);
  assert.equal(runReceipt.target, 'agy-cli');
  assert.equal(runReceipt.actualModel, 'gemini-4-neon-xhigh');

  // Drive polls until ask_parent question arrives
  const leadRecord = service.store.list().find(r => r.name === 'brain-lead');
  assert.ok(leadRecord);
  await pollUntil(async () => {
    await service.poll(leadRecord.agentId);
    const cur = service.store.get(leadRecord.agentId);
    return cur?.state === 'awaiting_input' ? cur : null;
  }, { label: 'agy-cli ask_parent awaiting_input' });

  // Verify orphan grandchild spawned during turn 1 was killed by worker's finally killProcessCage!
  const sleeperPid = Number((await readFile(sleeperPidFile, 'utf8')).trim());
  assert.ok(Number.isSafeInteger(sleeperPid) && sleeperPid > 0);
  await pollUntil(() => !processAlive(sleeperPid), { timeoutMs: 5000, label: 'orphan grandchild terminated by process cage' });

  // Answer the pending question -> triggers Turn 2 with `--conversation agy-conv-session-777`, spawns child subagent, and reports final!
  const ansReceipt = await service.answer({
    name: 'brain-lead',
    message: 'Use modular strategy SPAWN_CHILD_TOO',
  }, bossExtra);
  assert.equal(ansReceipt.answered, true);

  const completedLead = await pollUntil(async () => {
    await service.poll(leadRecord.agentId);
    // Also acknowledge pull delivery via wait(timeoutSeconds: 0)
    await service.wait({ names: ['brain-lead'], timeoutSeconds: 0 }, bossExtra);
    await service.poll(leadRecord.agentId);
    const cur = service.store.get(leadRecord.agentId);
    const hasFinal = (cur?.task?.reports ?? []).some(r => r.final === true);
    return hasFinal && !cur.observation?.running ? cur : null;
  }, { label: 'agy-cli turn 2 final report' });

  // Verify child subagent spawned by agy-cli via antigravity-caller-bootstrap inherited parentAgentId!
  const childRecord = service.store.list().find(r => r.name === 'sub-worker');
  assert.ok(childRecord, 'agy-cli team lead spawned child subagent through antigravity-caller-bootstrap');
  assert.equal(childRecord.parentAgentId, leadRecord.agentId, 'Child subagent carries parentAgentId of agy-cli lead');
  assert.equal(childRecord.target, 'agy-cli');

  // Verify argv log: Turn 1 had no --conversation and no --effort (tier-suffixed model); Turn 2 had --conversation agy-conv-session-777
  const argvEntries = (await readFile(argvLogPath, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(argvEntries.length, 2);
  assert.equal(argvEntries[0].envManaged, '1');
  assert.ok(!argvEntries[0].args.includes('--conversation'));
  assert.ok(!argvEntries[0].args.includes('--effort'), 'Suffixed model ID must omit --effort');
  const convFlagIdx = argvEntries[1].args.indexOf('--conversation');
  assert.ok(convFlagIdx >= 0);
  assert.equal(argvEntries[1].args[convFlagIdx + 1], 'agy-conv-session-777');

  // Verify cumulative usage across Turn 1 (300 total, 1.25s) + Turn 2 (470 total, 1.75s) = 770 total, 3.0s
  assert.deepEqual(completedLead.task.usage, {
    inputTokens: 500,
    outputTokens: 180,
    cachedTokens: 90,
    totalTokens: 770,
    durationSec: 3,
  });

  // Verify offline fallback in antigravity-caller-bootstrap when HTTP server is closed!
  await reportServer.close();
  assert.ok(resolveManagedCliBinding({
    FUTUREAIDE_MANAGED_CLI: '1',
    FUTUREAIDE_PARENT_AGENT_ID: childRecord.agentId,
    FUTUREAIDE_PARENT_TASK_ID: 'task-offline-1',
    FUTUREAIDE_PARENT_REQUEST_ID: 'req-offline-1',
  }));
  assert.equal(
    resolveConversationId({}, {}, {
      FUTUREAIDE_MANAGED_CLI: '1',
      FUTUREAIDE_PARENT_AGENT_ID: childRecord.agentId,
      FUTUREAIDE_PARENT_TASK_ID: 'task-offline-1',
      FUTUREAIDE_PARENT_REQUEST_ID: 'req-offline-1',
      FUTUREAIDE_CALLER_OWNER_ID: childRecord.ownerId,
    }),
    undefined,
  );

  // Put an active task on sub-worker and submit report_parent while HTTP loopback is OFFLINE
  const sendChild = await service.send({
    name: 'brain-lead/sub-worker',
    message: 'MANUAL_OFFLINE_CALLBACK check',
  }, bossExtra);
  await service.poll(childRecord.agentId);
  const freshChild = service.store.get(childRecord.agentId);
  const offlineBridge = await startAntigravityCallerBridge({
    coldStartMonitor: false,
    port: freePort,
    configPath,
    env: {
      FUTUREAIDE_MANAGED_CLI: '1',
      FUTUREAIDE_PARENT_AGENT_ID: freshChild.agentId,
      FUTUREAIDE_PARENT_TASK_ID: freshChild.task.taskId,
      FUTUREAIDE_PARENT_REQUEST_ID: sendChild.requestId,
      FUTUREAIDE_ROSTER_PATH: service.store.location,
      FUTUREAIDE_REPORT_PORT: String(freePort),
    },
    cwd: workspace,
    log: () => {},
  });
  try {
    const offlineTools = await offlineBridge.fetchTools({}, {});
    assert.ok(offlineTools.some(item => item.name === 'report_parent'), 'Managed tools remain available even when /mcp is offline');
    const cbRes = await offlineBridge.callTool('report_parent', {
      message: 'Delivered via SQLite fallback while HTTP offline',
      final: true,
    }, {}, {});
    assert.ok(!cbRes.isError);
    const parsedReceipt = JSON.parse(cbRes.content[0].text);
    assert.equal(parsedReceipt.accepted, true);
    assert.equal(parsedReceipt.kind, 'report');
    assert.equal(parsedReceipt.taskId, freshChild.task.taskId);
    assert.ok(typeof parsedReceipt.submissionId === 'string' && parsedReceipt.submissionId.startsWith('submission-'));
  } finally {
    await offlineBridge.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Unified 3-CLI usage billing + boardSnapshot + millisecond turn-timeout fuse
// ---------------------------------------------------------------------------

test('billing & turn-timeout: codex-cli, claude-cli, and agy-cli extract unified usage, accumulate across tasks, and trip turn-timeout fuse', async t => {
  const root = await makeTempDir(t, 'billing-timeout-');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const binDir = path.join(root, 'bin');
  await mkdir(workspace, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const bridgePath = path.join(pluginRoot, 'src', 'cli-callback-bridge.mjs');
  const codexHome = path.join(root, 'codex-home');
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, 'config.toml'), 'model = "gpt-5.4"\nmodel_reasoning_effort = "high"\n', 'utf8');
  await writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    models: [{
      slug: 'gpt-5.4',
      display_name: 'GPT-5.4',
      visibility: 'list',
      default_reasoning_level: 'high',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
    }],
  }, null, 2), 'utf8');

  // 1) Mock Codex CLI script (reads prompt from stdin, supports normal usage turn + HANG_FOREVER mode with grandchild)
  const bridgeModuleUrl = new URL('../src/cli-callback-bridge.mjs', import.meta.url).href;
  const mockCodexJs = path.join(binDir, 'mock-codex.mjs');
  await writeFile(mockCodexJs, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { submitCliCallback } from ${JSON.stringify(bridgeModuleUrl)};

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli 0.171.0\\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stdout.write('Logged in using ChatGPT\\n');
  process.exit(0);
}
let stdin = '';
for await (const chunk of process.stdin) stdin += chunk;
const prompt = stdin || args.at(-1) || '';
if (prompt.includes('HANG_FOREVER:')) {
  const pidOut = prompt.split('HANG_FOREVER:')[1].trim().split(/\\s+/)[0];
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(pidOut, String(grandchild.pid));
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th-hang-codex' }) + '\\n');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'th-bill-codex' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'codex ok' } }) + '\\n');
  await submitCliCallback({
    roster: process.env.FUTUREAIDE_ROSTER_PATH,
    agentId: process.env.FUTUREAIDE_PARENT_AGENT_ID,
    taskId: process.env.FUTUREAIDE_PARENT_TASK_ID,
    requestId: process.env.FUTUREAIDE_PARENT_REQUEST_ID,
    target: 'codex-cli',
    kind: 'report',
    message: 'Codex billing report',
    final: true,
    port: Number(process.env.FUTUREAIDE_REPORT_PORT || 0),
  });
  process.stdout.write(JSON.stringify({
    type: 'turn.completed',
    duration_ms: 1400,
    usage: { input_tokens: 120, output_tokens: 45, cached_input_tokens: 35, total_tokens: 165 },
  }) + '\\n');
}
`, 'utf8');

  // 2) Mock Claude CLI script (supports auth status, --help, control_request, stdin prompt, usage + HANG_FOREVER)
  const mockClaudeJs = path.join(binDir, 'mock-claude.mjs');
  await writeFile(mockClaudeJs, `
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { submitCliCallback } from ${JSON.stringify(bridgeModuleUrl)};

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.1.0 (Claude Code)\\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }, null, 2) + '\\n');
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write(
    '--permission-mode <mode>  Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "plan")\\n' +
    '--permission-prompts <target>  Who answers permission prompts: "host" or "none"\\n'
  );
  process.exit(0);
}
const sIdx = args.indexOf('--session-id');
const rIdx = args.indexOf('--resume');
const sid = (sIdx >= 0 ? args[sIdx + 1] : null) || (rIdx >= 0 ? args[rIdx + 1] : null) || '00000000-0000-4000-8000-000000000001';
const modIdx = args.indexOf('--model');
const effIdx = args.indexOf('--effort');
const appliedModel = (modIdx >= 0 ? args[modIdx + 1] : null) || 'claude-sonnet-4-6';
const appliedEffort = (effIdx >= 0 ? args[effIdx + 1] : null) || 'high';
const mIdx = args.indexOf('--mcp-config');
let cbEnv = { ...process.env };
let srvArgs = [];
if (mIdx >= 0 && args[mIdx + 1]) {
  try {
    const mcpCfg = JSON.parse(readFileSync(args[mIdx + 1], 'utf8'));
    const srv = mcpCfg?.mcpServers?.futureaide;
    if (srv?.env) cbEnv = { ...cbEnv, ...srv.env };
    if (Array.isArray(srv?.args)) srvArgs = srv.args;
  } catch {}
}

let prompt = '';
if (args.includes('--input-format')) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin });
  let gotUserPrompt = false;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.type === 'control_request') {
      const sub = req.request?.subtype;
      const payload = sub === 'list_models'
        ? { models: [{ resolvedModel: appliedModel, displayName: 'Claude Sonnet 4.6', supportedEffortLevels: ['low', 'medium', 'high', 'max'] }] }
        : sub === 'get_settings'
          ? { applied: { model: appliedModel, effort: appliedEffort } }
          : {};
      process.stdout.write(JSON.stringify({
        type: 'control_response',
        response: { request_id: req.request_id, subtype: 'success', response: payload },
      }) + '\\n');
      continue;
    }
    if (req.type === 'user') {
      gotUserPrompt = true;
      prompt = typeof req.message?.content === 'string' ? req.message.content : JSON.stringify(req.message ?? '');
      if (args.includes('--replay-user-messages')) {
        process.stdout.write(JSON.stringify(req) + '\\n');
      }
      break;
    }
  }
  if (!gotUserPrompt) process.exit(0);
} else {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += chunk;
  prompt = stdin;
}

if (prompt.includes('HANG_FOREVER:')) {
  const pidOut = prompt.split('HANG_FOREVER:')[1].trim().split(/\\s+/)[0];
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(pidOut, String(grandchild.pid));
  process.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sid,
    model: 'claude-sonnet-4-6',
    permissionMode: 'auto',
    mcp_servers: [{ name: 'futureaide', status: 'connected' }],
  }) + '\\n');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else {
  process.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sid,
    model: 'claude-sonnet-4-6',
    permissionMode: 'auto',
    mcp_servers: [{ name: 'futureaide', status: 'connected' }],
  }) + '\\n');
  await submitCliCallback({
    roster: cbEnv.FUTUREAIDE_ROSTER_PATH || srvArgs[2],
    agentId: cbEnv.FUTUREAIDE_PARENT_AGENT_ID || srvArgs[3],
    taskId: cbEnv.FUTUREAIDE_PARENT_TASK_ID || srvArgs[4],
    requestId: cbEnv.FUTUREAIDE_PARENT_REQUEST_ID || srvArgs[5],
    target: 'claude-cli',
    kind: 'report',
    message: 'Claude billing report',
    final: true,
    port: Number(cbEnv.FUTUREAIDE_REPORT_PORT || 0),
    env: cbEnv,
  });
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sid,
    result: 'claude ok',
    duration_ms: 2150,
    usage: { input_tokens: 150, output_tokens: 60, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
  }) + '\\n');
}
`, 'utf8');

  // 3) Mock Agy CLI script
  const mockAgyJs = path.join(binDir, 'mock-agy-bill.mjs');
  await writeFile(mockAgyJs, `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { submitCliCallback } from ${JSON.stringify(bridgeModuleUrl)};

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('1.5.18\\n');
  process.exit(0);
}
if (args[0] === 'models') {
  process.stdout.write('gemini-4-neon-high\\tGemini 4 Neon (High)\\ncustom-pass-through\\tCustom\\n');
  process.exit(0);
}
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? (args[pIdx + 1] || '') : '';
if (prompt.includes('HANG_FOREVER:')) {
  const pidOut = prompt.split('HANG_FOREVER:')[1].trim().split(/\\s+/)[0];
  const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  writeFileSync(pidOut, String(grandchild.pid));
  process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'agy-hang-1', init: { model: 'gemini-4-neon-high' } }) + '\\n');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else {
  process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'agy-bill-1', init: { model: 'gemini-4-neon-high' } }) + '\\n');
  await submitCliCallback({
    roster: process.env.FUTUREAIDE_ROSTER_PATH,
    agentId: process.env.FUTUREAIDE_PARENT_AGENT_ID,
    taskId: process.env.FUTUREAIDE_PARENT_TASK_ID,
    requestId: process.env.FUTUREAIDE_PARENT_REQUEST_ID,
    target: 'agy-cli',
    kind: 'report',
    message: 'Agy billing report',
    final: true,
    port: Number(process.env.FUTUREAIDE_REPORT_PORT || 0),
  });
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: {
      conversation_id: 'agy-bill-1',
      status: 'SUCCESS',
      response: 'agy ok',
      duration_seconds: 1.8,
      usage: { input_tokens: 180, output_tokens: 70, cache_read_tokens: 50, total_tokens: 300 },
    },
  }) + '\\n');
}
`, 'utf8');

  assert.ok(await lstat(bridgePath));

  const prevCodexCli = process.env.CODEX_CLI;
  const prevCodexHome = process.env.CODEX_HOME;
  const prevClaudeCli = process.env.CLAUDE_CLI;
  process.env.CODEX_CLI = mockCodexJs;
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CLI = mockClaudeJs;
  t.after(() => {
    if (prevCodexCli === undefined) delete process.env.CODEX_CLI; else process.env.CODEX_CLI = prevCodexCli;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevCodexHome;
    if (prevClaudeCli === undefined) delete process.env.CLAUDE_CLI; else process.env.CLAUDE_CLI = prevClaudeCli;
  });

  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    workspace,
    stateDirectory: stateDir,
    agyCliPath: mockAgyJs,
    cliRoutes: {
      'codex-cli': 'direct',
      'claude-cli': 'direct',
      'agy-cli': 'direct',
    },
    disabledTargets: ['dsh'],
    idleSessionCleanup: false,
  }, null, 2), 'utf8');

  const config = await loadConfig(configPath);
  const service = createScopedAgents(config, {
    startSharedMonitor: async () => true,
  });
  t.after(() => service.close());

  const extra = agyCallerExtra('billing-conv-1', workspace);

  // Dispatch all 3 CLIs (including a dynamic custom model name on agy-cli!)
  const rCodex = await service.run({ name: 'c-codex', target: 'codex-cli', lifetime: 'persistent', message: 'Bill task 1' }, extra);
  const rClaude = await service.run({ name: 'c-claude', target: 'claude-cli', lifetime: 'persistent', message: 'Bill task 1' }, extra);
  const rAgy = await service.run({ name: 'c-agy', target: 'agy-cli', lifetime: 'persistent', model: 'my-dynamic-agy-model-x1', message: 'Bill task 1' }, extra);

  for (const [name, key] of [['c-codex', rCodex.taskKey], ['c-claude', rClaude.taskKey], ['c-agy', rAgy.taskKey]]) {
    await pollUntil(async () => {
      const rec = service.store.list().find(r => r.name === name);
      await service.poll(rec.agentId);
      await service.wait({ taskKeys: [key], timeoutSeconds: 0 }, extra);
      await service.flushSettlements?.();
      await service.poll(rec.agentId);
      const after = service.store.get(rec.agentId);
      return after?.state === 'idle' && after?.usage ? after : null;
    }, { label: `${name} billing task 1 settled` });
  }

  // Poll again to prove zero double-counting across repeated polls
  for (const rec of service.store.list()) {
    await service.poll(rec.agentId);
  }

  const codexRec = service.store.list().find(r => r.name === 'c-codex');
  const claudeRec = service.store.list().find(r => r.name === 'c-claude');
  const agyRec = service.store.list().find(r => r.name === 'c-agy');

  assert.deepEqual(codexRec.usage, { inputTokens: 120, outputTokens: 45, cachedTokens: 35, totalTokens: 165, durationSec: 1.4 });
  assert.deepEqual(claudeRec.usage, { inputTokens: 150, outputTokens: 60, cachedTokens: 40, totalTokens: 260, durationSec: 2.15 });
  assert.deepEqual(agyRec.usage, { inputTokens: 180, outputTokens: 70, cachedTokens: 50, totalTokens: 300, durationSec: 1.8 });

  // Run a 2nd task on persistent `c-agy` and verify `record.usage` accumulates Task 1 + Task 2!
  const rAgy2 = await service.send({ name: 'c-agy', message: 'Bill task 2' }, extra);
  const agyAfterTask2 = await pollUntil(async () => {
    await service.poll(agyRec.agentId);
    await service.wait({ taskKeys: [rAgy2.taskKey], timeoutSeconds: 0 }, extra);
    await service.flushSettlements?.();
    await service.poll(agyRec.agentId);
    const cur = service.store.get(agyRec.agentId);
    return cur?.state === 'idle' && cur?.usage?.totalTokens === 600 ? cur : null;
  }, { label: 'c-agy task 2 cumulative usage' });

  assert.deepEqual(agyAfterTask2.usage, {
    inputTokens: 360,
    outputTokens: 140,
    cachedTokens: 100,
    totalTokens: 600,
    durationSec: 3.6,
  });

  // Verify publicResult (`list`) and `boardSnapshot()` expose normalized usage
  const listed = await service.list(extra, { scope: 'all', state: 'idle' });
  const listedAgy = listed.items.find(item => item.name === 'c-agy');
  assert.deepEqual(listedAgy?.usage, agyAfterTask2.usage);

  const boardMembers = service.store.boardSnapshot();
  assert.deepEqual(boardMembers.find(m => m.name === 'c-codex')?.usage, codexRec.usage);
  assert.deepEqual(boardMembers.find(m => m.name === 'c-claude')?.usage, claudeRec.usage);
  assert.deepEqual(boardMembers.find(m => m.name === 'c-agy')?.usage, agyAfterTask2.usage);

  // Millisecond turn-timeout fuse across all 3 CLIs: kills process tree + grandchild and marks state='failed', error.code='turn-timeout'
  for (const target of ['codex-cli', 'claude-cli', 'agy-cli']) {
    const pidFile = path.join(root, `hang-${target}.pid`);
    const agentName = `timeout-${target}`;
    await service.run({
      name: agentName,
      target,
      lifetime: 'persistent',
      timeoutMs: 350,
      message: `HANG_FOREVER:${pidFile}`,
    }, extra);

    const rec = service.store.list().find(r => r.name === agentName);
    assert.ok(rec);

    const failedRec = await pollUntil(async () => {
      await service.poll(rec.agentId);
      const cur = service.store.get(rec.agentId);
      return cur?.state === 'failed' ? cur : null;
    }, { timeoutMs: 12000, label: `${target} turn-timeout state=failed` });

    const lastDispatch = failedRec.task?.dispatches?.at(-1);
    const errCode = failedRec.error?.code ?? lastDispatch?.failure?.code ?? lastDispatch?.error?.code;
    assert.equal(errCode, 'turn-timeout', `${target} must fail with code 'turn-timeout'`);

    const grandPidRaw = await readFile(pidFile, 'utf8').catch(() => '');
    if (grandPidRaw.trim()) {
      const grandPid = Number(grandPidRaw.trim());
      await pollUntil(() => !processAlive(grandPid), {
        timeoutMs: 5000,
        label: `${target} grandchild killed by killProcessCage on turn-timeout`,
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 4. worktree one-click harvest & merge (`manageTeam({ action: 'merge' })` & `cli.mjs team merge`)
// ---------------------------------------------------------------------------

test('worktree merge: conflict guard on dirty main workspace, clean apply of committed + uncommitted + added + deleted files, and tree teardown', async t => {
  const root = await makeTempDir(t, 'wt-merge-');
  const repoDir = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const binDir = path.join(root, 'bin');
  await initTempGitRepo(repoDir);
  await mkdir(stateDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  // Mock agy CLI that edits files in its cwd (the isolated worktree!) and reports final
  const mockAgyJs = path.join(binDir, 'mock-agy-wt.mjs');
  await writeFile(mockAgyJs, `
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('1.5.18\\n');
  process.exit(0);
}
if (args[0] === 'models') {
  process.stdout.write('gemini-4-neon-high\\tGemini 4 Neon (High)\\n');
  process.exit(0);
}
const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? (args[pIdx + 1] || '') : '';
const cwd = process.cwd();

if (prompt.includes('WORKTREE_TASK_A')) {
  // 1) Committed file inside worktree
  mkdirSync(path.join(cwd, 'src', 'features'), { recursive: true });
  writeFileSync(path.join(cwd, 'src', 'features', 'committed.js'), 'export const committedFeature = 42;\\n', 'utf8');
  execFileSync('git', ['-C', cwd, 'add', 'src/features/committed.js'], { windowsHide: true });
  execFileSync('git', ['-C', cwd, 'commit', '-m', 'feat: add committed.js'], { windowsHide: true });

  // 2) Modified tracked file (uncommitted)
  writeFileSync(path.join(cwd, 'src', 'app.js'), 'export const version = 2;\\nexport const merged = true;\\n', 'utf8');

  // 3) Newly created untracked file
  writeFileSync(path.join(cwd, 'src', 'untracked-helper.js'), 'export const helper = "ok";\\n', 'utf8');

  // 4) Deleted tracked file
  rmSync(path.join(cwd, 'src', 'legacy.js'), { force: true });
} else if (prompt.includes('WORKTREE_TASK_CLI')) {
  writeFileSync(path.join(cwd, 'src', 'cli-merged.js'), 'export const fromCli = true;\\n', 'utf8');
}

execFileSync(process.execPath, ['-e', \`
  import { submitCliCallback } from ${JSON.stringify(new URL('../src/cli-callback-bridge.mjs', import.meta.url).href)};
  import { RosterStore } from ${JSON.stringify(new URL('../src/roster-store.mjs', import.meta.url).href)};
  const store = new RosterStore(process.env.FUTUREAIDE_ROSTER_PATH);
  await submitCliCallback({
    roster: process.env.FUTUREAIDE_ROSTER_PATH,
    agentId: process.env.FUTUREAIDE_PARENT_AGENT_ID,
    taskId: process.env.FUTUREAIDE_PARENT_TASK_ID,
    requestId: process.env.FUTUREAIDE_PARENT_REQUEST_ID,
    target: 'agy-cli',
    kind: 'report',
    message: 'Worktree edits ready',
    final: true,
    port: Number(process.env.FUTUREAIDE_REPORT_PORT || 0),
    getStore: () => store,
  });
  store.close();
\`], { env: process.env, windowsHide: true });

process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'wt-conv-1', init: { model: 'gemini-4-neon-high' } }) + '\\n');
process.stdout.write(JSON.stringify({
  event: 'result',
  result: {
    conversation_id: 'wt-conv-1',
    status: 'SUCCESS',
    response: 'done',
    duration_seconds: 0.9,
    usage: { input_tokens: 90, output_tokens: 30, cache_read_tokens: 10, total_tokens: 130 },
  },
}) + '\\n');
`, 'utf8');

  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    workspace: repoDir,
    stateDirectory: stateDir,
    agyCliPath: mockAgyJs,
    cliRoutes: { 'agy-cli': 'direct' },
    disabledTargets: ['dsh'],
    idleSessionCleanup: false,
  }, null, 2), 'utf8');

  const config = await loadConfig(configPath);
  const service = createScopedAgents(config, {
    startSharedMonitor: async () => true,
  });
  t.after(() => service.close());

  const extra = agyCallerExtra('wt-boss-conv', repoDir);

  // Create persistent worktree agent and run task
  const wtRunA = await service.run({
    name: 'wt-coder',
    target: 'agy-cli',
    lifetime: 'persistent',
    worktree: true,
    message: 'WORKTREE_TASK_A',
  }, extra);

  const coderRec = await pollUntil(async () => {
    const rec = service.store.list().find(r => r.name === 'wt-coder');
    await service.poll(rec.agentId);
    await service.wait({ taskKeys: [wtRunA.taskKey], timeoutSeconds: 0 }, extra);
    await service.flushSettlements?.();
    await service.poll(rec.agentId);
    const after = service.store.get(rec.agentId);
    return after?.state === 'idle' ? after : null;
  }, { label: 'wt-coder settled idle' });

  const wtPath = coderRec.worktreePath;
  assert.ok(wtPath && (await lstat(wtPath)).isDirectory(), 'Isolated worktree directory created');
  // Main workspace still has original app.js before merge
  assert.equal(await readFile(path.join(repoDir, 'src', 'app.js'), 'utf8'), 'export const version = 1;\n');

  // Step A: Dirty conflict in main workspace on `src/app.js` MUST refuse merge and preserve worktree!
  await writeFile(path.join(repoDir, 'src', 'app.js'), 'export const dirtyMainEdit = true;\n', 'utf8');
  await assert.rejects(
    () => service.manageTeam({ action: 'merge', target: 'wt-coder' }, extra),
    err => err?.code === 'worktree-merge-conflict' && Array.isArray(err.conflictingFiles) && err.conflictingFiles.includes('src/app.js'),
  );
  assert.ok((await lstat(wtPath)).isDirectory(), 'Worktree preserved after conflict refusal');
  assert.ok(service.store.get(coderRec.agentId).worktreePath, 'record.worktreePath still set after conflict');

  // Step B: Restore clean `src/app.js` in main workspace, then one-click merge!
  await execFileAsync('git', ['-C', repoDir, 'checkout', '--', 'src/app.js'], { windowsHide: true });
  const mergeRes = await service.manageTeam({ action: 'merge', target: 'wt-coder' }, extra);

  assert.equal(mergeRes.action, 'merge');
  assert.equal(mergeRes.ok, true);
  assert.equal(mergeRes.name, 'wt-coder');
  assert.equal(mergeRes.worktreeRemoved, true);
  assert.deepEqual(mergeRes.mergedFiles, [
    'src/app.js',
    'src/features/committed.js',
    'src/legacy.js',
    'src/untracked-helper.js',
  ]);
  assert.ok(typeof mergeRes.summary === 'string' && mergeRes.summary.length > 0);

  // Verify all 4 file operations landed in main workspace
  assert.equal(
    (await readFile(path.join(repoDir, 'src', 'app.js'), 'utf8')).replace(/\r\n/g, '\n'),
    'export const version = 2;\nexport const merged = true;\n',
  );
  assert.equal(
    (await readFile(path.join(repoDir, 'src', 'features', 'committed.js'), 'utf8')).replace(/\r\n/g, '\n'),
    'export const committedFeature = 42;\n',
  );
  assert.equal(
    (await readFile(path.join(repoDir, 'src', 'untracked-helper.js'), 'utf8')).replace(/\r\n/g, '\n'),
    'export const helper = "ok";\n',
  );
  await assert.rejects(() => lstat(path.join(repoDir, 'src', 'legacy.js')), { code: 'ENOENT' });

  // Verify worktree directory was removed and record.worktreePath cleared
  await assert.rejects(() => lstat(wtPath), { code: 'ENOENT' });
  const afterMergeRec = service.store.get(coderRec.agentId);
  assert.equal(afterMergeRec.worktreePath, undefined);
  assert.equal(afterMergeRec.workspaceMode, 'inherit');

  // Step C: Also verify `cli.mjs team merge <target>` CLI entrypoint works end-to-end!
  const wtRunCli = await service.run({
    name: 'wt-cli-coder',
    target: 'agy-cli',
    lifetime: 'persistent',
    worktree: true,
    message: 'WORKTREE_TASK_CLI',
  }, extra);

  const cliCoderRec = await pollUntil(async () => {
    const rec = service.store.list().find(r => r.name === 'wt-cli-coder');
    await service.poll(rec.agentId);
    await service.wait({ taskKeys: [wtRunCli.taskKey], timeoutSeconds: 0 }, extra);
    await service.flushSettlements?.();
    await service.poll(rec.agentId);
    const after = service.store.get(rec.agentId);
    return after?.state === 'idle' ? after : null;
  }, { label: 'wt-cli-coder settled idle' });

  const cliWtPath = cliCoderRec.worktreePath;
  assert.ok(cliWtPath);

  const { stdout: cliMergeOut } = await execFileAsync(
    process.execPath,
    [cliScript, 'team', 'merge', 'wt-cli-coder', '--config', configPath, '--workspace', repoDir, '--conv', 'wt-boss-conv'],
    { encoding: 'utf8', windowsHide: true },
  );
  const parsedCliMerge = JSON.parse(cliMergeOut);
  assert.equal(parsedCliMerge.action, 'merge');
  assert.equal(parsedCliMerge.ok, true);
  assert.equal(parsedCliMerge.worktreeRemoved, true);
  assert.deepEqual(parsedCliMerge.mergedFiles, ['src/cli-merged.js']);
  assert.equal(
    (await readFile(path.join(repoDir, 'src', 'cli-merged.js'), 'utf8')).replace(/\r\n/g, '\n'),
    'export const fromCli = true;\n',
  );
  await assert.rejects(() => lstat(cliWtPath), { code: 'ENOENT' });

  // Also verify resolveBackend('agy-cli') directly
  const resolvedBackend = await resolveBackend({ target: 'agy-cli', sessionId: 's1' }, {
    target: 'agy-cli',
    deps: {
      readNativeState: () => ({}),
      writeNativeState: () => true,
      requestDirectory: () => path.join(stateDir, 'dummy'),
      readParentSubmissions: async () => ({ questions: [], reports: [] }),
      callerEnv: { FUTUREAIDE_MANAGED_CLI: '1' },
    },
  });
  assert.equal(resolvedBackend.target, 'agy-cli');
  await killProcessCage({ pids: [] });
});

// ---------------------------------------------------------------------------
// 5. Managed CLI role-tiered bridge (lead dispatch + leaf board) & once+worktree retention
// ---------------------------------------------------------------------------

test('P0 regression: managed CLI bridge exposes board tools to leaf roles & team tools to lead roles, and once+worktree retains dirty worktrees until merge', async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createCliCallbackServer } = await import('../src/cli-callback-bridge.mjs');

  const root = await makeTempDir(t, 'p0-seams-');
  const repoDir = path.join(root, 'repo');
  const stateDir = path.join(root, 'state');
  const binDir = path.join(root, 'bin');
  await initTempGitRepo(repoDir);
  await mkdir(stateDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const mockAgyJs = path.join(binDir, 'mock-agy-once-wt.mjs');
  await writeFile(mockAgyJs, `
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('1.5.18\\n'); process.exit(0); }
if (args[0] === 'models') { process.stdout.write('gemini-4-neon-high\\tGemini 4 Neon (High)\\n'); process.exit(0); }

const pIdx = args.indexOf('-p');
const prompt = pIdx >= 0 ? (args[pIdx + 1] || '') : '';
if (prompt.includes('ONCE_DIRTY_WORKTREE')) {
  writeFileSync(path.join(process.cwd(), 'src', 'once-feature.js'), 'export const preservedFromOnce = true;\\n', 'utf8');
}

execFileSync(process.execPath, ['-e', \`
  import { submitCliCallback } from ${JSON.stringify(new URL('../src/cli-callback-bridge.mjs', import.meta.url).href)};
  import { RosterStore } from ${JSON.stringify(new URL('../src/roster-store.mjs', import.meta.url).href)};
  const store = new RosterStore(process.env.FUTUREAIDE_ROSTER_PATH);
  await submitCliCallback({
    roster: process.env.FUTUREAIDE_ROSTER_PATH,
    agentId: process.env.FUTUREAIDE_PARENT_AGENT_ID,
    taskId: process.env.FUTUREAIDE_PARENT_TASK_ID,
    requestId: process.env.FUTUREAIDE_PARENT_REQUEST_ID,
    target: 'agy-cli',
    kind: 'report',
    message: 'Once worktree task finished',
    final: true,
    port: Number(process.env.FUTUREAIDE_REPORT_PORT || 0),
    getStore: () => store,
  });
  store.close();
\`], { env: process.env, windowsHide: true });

process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'once-wt-1', init: { model: 'gemini-4-neon-high' } }) + '\\n');
process.stdout.write(JSON.stringify({
  event: 'result',
  result: { conversation_id: 'once-wt-1', status: 'SUCCESS', response: 'ok', duration_seconds: 0.5, usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 } },
}) + '\\n');
`, 'utf8');

  const freePort = await new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on('error', reject);
  });

  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    workspace: repoDir,
    stateDirectory: stateDir,
    reportPort: freePort,
    agyCliPath: mockAgyJs,
    cliRoutes: { 'agy-cli': 'direct' },
    disabledTargets: ['dsh'],
    idleSessionCleanup: false,
  }, null, 2), 'utf8');

  const config = await loadConfig(configPath);
  const service = createScopedAgents(config, { startSharedMonitor: async () => true });
  t.after(() => service.close());

  const reportServer = await startReportService({
    port: freePort,
    runtimeDir: stateDir,
    store: service.store,
    management: scopedManagement({ service }),
  });
  t.after(async () => { await reportServer.close().catch(() => {}); });

  const extra = agyCallerExtra('boss-p0-conv', repoDir);

  // Part A: Create a persistent lead agent and verify createCliCallbackServer role-tiered tools over /mcp!
  await service.create({
    name: '团队长1',
    role: '团队长',
    target: 'agy-cli',
    lifetime: 'persistent',
  }, extra);
  await service.create({ name: 'builder1', role: 'builder', target: 'agy-cli', lifetime: 'persistent' }, extra);
  const bindFixtureTurn = name => {
    const record = service.store.list().find(r => r.name === name);
    const requestId = 'req-bridge-' + record.agentId;
    const taskId = 'task-bridge-' + record.agentId;
    const bound = { ...record, state: 'running', task: { taskId, dispatches: [{ requestId }] } };
    service.store.save(bound);
    return bound;
  };
  const leadRec = bindFixtureTurn('团队长1');
  const leafRec = bindFixtureTurn('builder1');

  const connectBridgeClient = async (record) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const bridge = createCliCallbackServer({
      roster: service.store.location,
      agentId: record.agentId,
      taskId: record.task.taskId,
      requestId: record.task.dispatches.at(-1).requestId,
      target: record.target,
      port: freePort,
      env: {
        FUTUREAIDE_MANAGED_CLI: '1',
        FUTUREAIDE_CALLER_ROLE: record.role,
        FUTUREAIDE_PARENT_AGENT_ID: record.agentId,
        FUTUREAIDE_CALLER_OWNER_ID: record.ownerId,
        FUTUREAIDE_CALLER_WORKSPACE: repoDir,
        FUTUREAIDE_REPORT_PORT: String(freePort),
      },
    });
    await bridge.server.connect(serverTransport);
    const client = new Client({ name: 'test-cli-worker', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    return {
      client,
      close: async () => {
        await client.close().catch(() => {});
        await bridge.close().catch(() => {});
      },
    };
  };

  // 1) Leaf builder ('builder') sees 3 callback tools + 2 board tools (5 total, zero bloat) and can post/read board
  const leafSession = await connectBridgeClient(leafRec);
  try {
    const leafTools = (await leafSession.client.listTools()).tools.map(item => item.name);
    assert.deepEqual(leafTools.sort(), [
      'ask_parent',
      'feedback',
      'futureaide_board_post',
      'futureaide_board_read',
      'report_parent',
    ]);
    const postRes = await leafSession.client.callTool({
      name: 'futureaide_board_post',
      arguments: { message: 'Interface schema locked at v2' },
    });
    assert.ok(!postRes.isError, `Expected leaf board_post ok, got ${JSON.stringify(postRes)}`);
    const readRes = await leafSession.client.callTool({
      name: 'futureaide_board_read',
      arguments: { limit: 10 },
    });
    assert.ok(JSON.stringify(readRes).includes('Interface schema locked at v2'));
  } finally {
    await leafSession.close();
  }

  // 2) Lead ('团队长') sees full forwarded team tools and can actually create a child subagent under itself!
  const leadSession = await connectBridgeClient(leadRec);
  try {
    const leadTools = (await leadSession.client.listTools()).tools.map(item => item.name);
    assert.ok(leadTools.includes('futureaide_run_agent'), 'Lead CLI worker must see futureaide_run_agent');
    assert.ok(leadTools.includes('futureaide_team'), 'Lead CLI worker must see futureaide_team');
    assert.ok(leadTools.includes('futureaide_wait_agents'), 'Lead CLI worker must see futureaide_wait_agents');
    assert.ok(leadTools.includes('futureaide_board_post'), 'Lead CLI worker must see futureaide_board_post');

    const childSpawnRes = await leadSession.client.callTool({
      name: 'futureaide_create_agent',
      arguments: {
        name: 'worker-child',
        role: 'builder',
        target: 'agy-cli',
        lifetime: 'persistent',
      },
    });
    assert.ok(!childSpawnRes.isError, `Expected lead child spawn ok, got ${JSON.stringify(childSpawnRes)}`);
    const spawnedChild = service.store.list().find(r => r.name === 'worker-child');
    assert.ok(spawnedChild, 'Managed CLI lead spawned child subagent');
    assert.equal(spawnedChild.parentAgentId, leadRec.agentId, 'Child subagent parentAgentId points to 团队长1');
  } finally {
    await leadSession.close();
  }

  // Part B: `lifetime: 'once'` + `worktree: true` with modified files MUST retain worktree until `merge`!
  const onceRun = await service.run({
    name: 'once-wt-builder',
    role: 'builder',
    target: 'agy-cli',
    lifetime: 'once',
    worktree: true,
    message: 'ONCE_DIRTY_WORKTREE',
  }, extra);

  const retainedRec = await pollUntil(async () => {
    const rec = service.store.list().find(r => r.name === 'once-wt-builder');
    if (!rec) return null;
    await service.poll(rec.agentId);
    await service.wait({ taskKeys: [onceRun.taskKey], timeoutSeconds: 0 }, extra);
    await service.flushSettlements?.();
    await service.poll(rec.agentId);
    const after = service.store.get(rec.agentId);
    return after?.state === 'idle' && after?.unmergedWorktree === true ? after : null;
  }, { label: 'once+worktree retained in idle with unmergedWorktree=true' });

  const onceWtPath = retainedRec.worktreePath;
  assert.ok(onceWtPath && (await lstat(onceWtPath)).isDirectory(), 'Dirty once worktree directory must survive final report');
  assert.ok(!retainedRec.closed, 'Agent must stay open until worktree is merged');

  // Even stale GC must NOT delete an unmerged worktree!
  const gcSweep = service.store.gcStaleAgents({ nowMs: Date.now() + 24 * 3600 * 1000 });
  assert.ok(!gcSweep.some(r => r.agentId === retainedRec.agentId), 'gcStaleAgents must skip unmergedWorktree records');

  // Now merge `once-wt-builder` -> harvests `src/once-feature.js` AND completes deferred `once` cleanup!
  const onceMergeRes = await service.manageTeam({ action: 'merge', target: 'once-wt-builder' }, extra);
  assert.equal(onceMergeRes.ok, true);
  assert.deepEqual(onceMergeRes.mergedFiles, ['src/once-feature.js']);
  assert.equal(
    (await readFile(path.join(repoDir, 'src', 'once-feature.js'), 'utf8')).replace(/\r\n/g, '\n'),
    'export const preservedFromOnce = true;\n',
  );
  await assert.rejects(() => lstat(onceWtPath), { code: 'ENOENT' });
  const postMergeRec = service.store.get(retainedRec.agentId);
  assert.ok(!postMergeRec || postMergeRec.closed === true, 'Deferred once cleanup closes/removes agent after merge');
});
