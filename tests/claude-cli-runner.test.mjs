// Claude CLI runner: discovery, argv, normalization, detached turns and cancellation.
// Everything runs against fixtures/claude-cli.mjs, a stand-in CLI, so no test ever calls a
// real model. The stand-in's scenario and receipt directory are passed through the
// inherited environment (the runner has no env option), so the tests set process.env
// around each dispatch; node:test runs the cases in this file in order.
// Scratch directories are created under clean/claude-cli-runner-tests/ and are left in
// place on purpose: this project moves work aside instead of deleting it.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CLAUDE_TURN_FILES, allowedCallbackTools, applyClaudeLine, cancelClaudeTurn, claudeSystemPrompt,
  claudeTurnArguments, claudeTurnOutcome, createClaudeTurnState, mcpServerFromConfig,
  permissionSupportFromHelp, probeClaudeCli, readClaudeTurn, startClaudeTurn,
} from '../src/claude-cli-runner.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(projectRoot, 'fixtures', 'claude-cli.mjs');
const scratchRoot = path.join(projectRoot, 'clean', 'claude-cli-runner-tests',
  new Date().toISOString().replace(/[:.]/g, '-'));
const SESSION = '11111111-2222-4333-8444-555555555555';
const MCP_CONFIG = { mcpServers: { futureaide: { command: process.execPath, args: ['src/mcp-server.mjs'] } } };
const fixtureCli = { command: process.execPath, prefixArgs: [fixture] };

let scratchCount = 0;
async function scratch(name) {
  const directory = path.join(scratchRoot, name + '-' + (++scratchCount));
  await mkdir(directory, { recursive: true });
  return directory;
}

async function waitForTurn(directory, done = value => value.state !== 'running', { timeout = 40000, interval = 40 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const current = await readClaudeTurn(directory);
    if (done(current)) return current;
    if (Date.now() > deadline) {
      throw new Error('turn did not settle: ' + JSON.stringify({ state: current.state, error: current.error,
        messages: current.messages.length, warnings: current.warnings }));
    }
    await delay(interval);
  }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

const hanging = [];
function run(directory, { scenario = 'ok', message = 'Do the task.', ...rest } = {}) {
  // A hanging turn is cancelled at the end of the suite even if an assertion fails first:
  // a leaked stand-in CLI would keep running, because a real turn is meant to outlive its caller.
  if (scenario === 'hang') hanging.push(directory);
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  process.env.FAKE_CLAUDE_RECEIPT_DIR = path.join(directory, 'receipts');
  return startClaudeTurn({ directory, cli: fixtureCli, workspace: directory, sessionId: SESSION,
    message, mcpConfig: MCP_CONFIG, ...rest }).then(async started => {
    // The detached worker reads FAKE_CLAUDE_SCENARIO when it spawns. Do not let the
    // next case replace that environment before this worker has really started.
    const spawnLog = path.join(directory, 'receipts', 'fake-claude-spawns.log');
    for (let attempt = 0; attempt < 250; attempt++) {
      try { await stat(spawnLog); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await delay(20);
    }
    return started;
  });
}

after(async () => {
  for (const directory of hanging) await cancelClaudeTurn(directory).catch(() => undefined);
  delete process.env.FAKE_CLAUDE_SCENARIO;
  delete process.env.FAKE_CLAUDE_RECEIPT_DIR;
});

const HELP_OK = '--permission-mode <mode>  Permission mode (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")\n'
  + '--permission-prompts <target>  Who answers permission prompts with --print: "host" or "none"';

/** A CLI stub that answers auth status and --help and records every call. */
function stubCli({ status = { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' },
  statusText, help = HELP_OK, helpCode = 0, calls = [] } = {}) {
  const exec = async (cli, args) => {
    const line = args.join(' ');
    calls.push(line);
    if (line === 'auth status') return { stdout: statusText ?? JSON.stringify(status, null, 2) };
    if (args[0] === '--help') {
      if (helpCode !== 0) {
        const error = new Error('help failed');
        error.code = helpCode; error.stdout = ''; error.stderr = 'help is broken';
        throw error;
      }
      return { stdout: help };
    }
    throw new Error('unexpected ' + line);
  };
  return { exec, calls };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('probeClaudeCli returns the CLI and its auth status without reading credentials', async () => {
  const { exec, calls } = stubCli();
  const probe = await probeClaudeCli({ findCli: async () => 'D:\\tools\\claude.exe', exec });
  assert.equal(probe.cli, 'D:\\tools\\claude.exe');
  assert.equal(probe.auth.subscriptionType, 'max');
  assert.equal(probe.auth.authMethod, 'claude.ai');
  assert.equal(probe.permissions.mode, 'auto');
  assert.equal(probe.permissions.prompts, 'none');
  // Only the CLI's own reporting is used, and it never prints environment or credential values.
  assert.deepEqual(calls, ['auth status', '--help']);
  assert.deepEqual(Object.keys(probe.auth).sort(), ['authMethod', 'loggedIn', 'subscriptionType']);
});

test('probeClaudeCli reads the pretty-printed status the real CLI prints', async () => {
  // The installed CLI indents its JSON over many lines; a line-only reader misses it.
  const { exec } = stubCli({ status: { loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max',
    configDirectory: 'C:\\Users\\x\\.claude' } });
  const probe = await probeClaudeCli({ findCli: async () => 'claude.exe', exec });
  assert.equal(probe.auth.loggedIn, true);
  assert.equal(probe.auth.subscriptionType, 'max');
});

test('a nonzero auth probe or a host-only prompt target is not ready', async () => {
  const findCli = async () => 'fixture.exe';
  const exec = async () => { throw Object.assign(new Error('status failed'), {
    code: 2, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }),
  }); };
  await assert.rejects(probeClaudeCli({ findCli, exec }), { code: 'claude-cli-probe-failed' });
  await assert.rejects(probeClaudeCli({ findCli, exec: stubCli({ help: HELP_OK.replace(' or "none"', '') }).exec }),
    { code: 'claude-cli-permission-prompts-unavailable' });
});

test('probeClaudeCli refuses an API-key or cloud sign-in instead of billing another route', async () => {
  for (const authMethod of ['apiKey', 'api_key', 'bedrock', 'vertex', 'gateway', 'cloud', 'weird-unknown']) {
    await assert.rejects(probeClaudeCli({
      findCli: async () => 'claude.exe', exec: stubCli({ status: { loggedIn: true, authMethod } }).exec,
    }), error => error.code === 'claude-cli-auth-unsupported', authMethod);
  }
  for (const authMethod of ['claude.ai', 'oauth', 'claude.ai (subscription)']) {
    const probe = await probeClaudeCli({
      findCli: async () => 'claude.exe', exec: stubCli({ status: { loggedIn: true, authMethod } }).exec,
    });
    assert.equal(probe.auth.authMethod, authMethod);
  }
});

test('probeClaudeCli refuses a missing CLI with a concrete code', async () => {
  await assert.rejects(probeClaudeCli({ findCli: async () => undefined, exec: async () => { throw new Error('unused'); } }),
    error => error.code === 'claude-cli-not-found');
});

test('probeClaudeCli reports a signed-out CLI and an unreadable one separately', async () => {
  await assert.rejects(probeClaudeCli({
    findCli: async () => 'claude.exe', exec: stubCli({ status: { loggedIn: false } }).exec,
  }), error => error.code === 'claude-cli-auth-required');
  await assert.rejects(probeClaudeCli({
    findCli: async () => 'claude.exe', exec: stubCli({ statusText: 'not json at all' }).exec,
  }), error => error.code === 'claude-cli-probe-failed');
  await assert.rejects(probeClaudeCli({
    findCli: async () => 'claude.exe', exec: stubCli({ helpCode: 1 }).exec,
  }), error => error.code === 'claude-cli-probe-failed');
});

test('probeClaudeCli refuses a CLI that cannot do auto without prompts', async () => {
  await assert.rejects(probeClaudeCli({
    findCli: async () => 'claude.exe',
    exec: stubCli({ help: '--permission-mode <mode>  Permission mode (choices: "manual", "plan")\n--permission-prompts <target>  Who answers' }).exec,
  }), error => error.code === 'claude-cli-permission-mode-unavailable');
  await assert.rejects(probeClaudeCli({
    findCli: async () => 'claude.exe',
    exec: stubCli({ help: '--permission-mode <mode>  Permission mode (choices: "manual", "auto")' }).exec,
  }), error => error.code === 'claude-cli-permission-prompts-unavailable');
  await assert.rejects(probeClaudeCli({
    findCli: async () => 'claude.exe',
    exec: stubCli({ help: '--permission-prompts <target>  Who answers permission prompts' }).exec,
  }), error => error.code === 'claude-cli-permission-mode-unavailable');
});

test('permissionSupportFromHelp reads the choices it actually prints', () => {
  const support = permissionSupportFromHelp('--permission-mode <mode>  Permission mode (choices: "acceptEdits", "auto", "plan")');
  assert.equal(support.modeFlag, true);
  assert.equal(support.auto, true);
  assert.deepEqual(support.modes, ['acceptEdits', 'auto', 'plan']);
  // No choice list means auto cannot be proven, which is not the same as "available".
  assert.equal(permissionSupportFromHelp('--permission-mode <mode>  no choices here').auto, false);
});

// ---------------------------------------------------------------------------
// argv and prompts
// ---------------------------------------------------------------------------

test('claudeTurnArguments builds the print-mode argv and widens nothing', () => {
  const args = claudeTurnArguments({ sessionId: SESSION, systemPrompt: 'sys',
    mcpFile: 'C:\\state\\mcp.json', allowedTools: allowedCallbackTools('futureaide') });
  assert.deepEqual(args.slice(0, 9), ['-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'auto', '--permission-prompts', 'none', '--session-id']);
  assert.equal(args[9], SESSION);
  // Model and effort are only present when the caller chose them explicitly.
  assert.equal(args.includes('--model'), false);
  assert.equal(args.includes('--effort'), false);
  // Exactly the two callback tools are pre-allowed, and no bypass flag is anywhere.
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__futureaide__ask_parent,mcp__futureaide__report_parent');
  for (const forbidden of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--bare']) {
    assert.equal(args.includes(forbidden), false, forbidden + ' must never be passed');
  }
});

test('claudeTurnArguments resumes the same id and passes an explicit model and effort', () => {
  const args = claudeTurnArguments({ sessionId: SESSION, resume: true, model: 'claude-opus-4-6', effort: 'high' });
  assert.deepEqual(args.slice(args.indexOf('--resume')),
    ['--resume', SESSION, '--model', 'claude-opus-4-6', '--effort', 'high']);
  assert.equal(args.includes('--session-id'), false);
  assert.throws(() => claudeTurnArguments({ sessionId: 'not-a-uuid' }), error => error.code === 'invalid-session-id');
});

test('an MCP config must declare exactly one server, and only its callbacks are allowed', () => {
  assert.equal(mcpServerFromConfig(MCP_CONFIG), 'futureaide');
  assert.throws(() => mcpServerFromConfig({ mcpServers: {} }), error => error.code === 'invalid-mcp-config');
  assert.throws(() => mcpServerFromConfig({ mcpServers: { a: {}, b: {} } }), error => error.code === 'invalid-mcp-config');
  assert.throws(() => mcpServerFromConfig({}), error => error.code === 'invalid-mcp-config');
  assert.deepEqual(allowedCallbackTools('futureaide'),
    ['mcp__futureaide__ask_parent', 'mcp__futureaide__report_parent']);
});

test('the system prompt names both parent callbacks and the final report flag', () => {
  const prompt = claudeSystemPrompt({ serverName: 'futureaide', name: 'Terra' });
  assert.match(prompt, /mcp__futureaide__ask_parent/);
  assert.match(prompt, /mcp__futureaide__report_parent\(message, final=true\)/);
  assert.match(prompt, /Terra/);
  // The only extra policy is about the two callbacks; no subagent or directory rules.
  assert.doesNotMatch(prompt, /subagent|working directory/i);
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function stateOf() {
  return createClaudeTurnState({ requestId: 'r1', sessionId: SESSION, workspace: 'D:\\w',
    message: 'task', mcpRequired: 'futureaide' });
}

test('normalization keeps the real model, the MCP status and the tool trail', () => {
  const state = stateOf();
  applyClaudeLine(state, JSON.stringify({ type: 'system', subtype: 'init', session_id: SESSION,
    model: 'claude-real-1', permissionMode: 'auto', tools: ['Read'],
    mcp_servers: [{ name: 'futureaide', status: 'connected' }] }));
  applyClaudeLine(state, JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-ignored',
    content: [{ type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'toolu_1', name: 'mcp__futureaide__report_parent' }] } }));
  applyClaudeLine(state, JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
    result: 'done', num_turns: 1, duration_ms: 12, total_cost_usd: 0.1 }));
  // A model on the assistant message never overrides what init reported.
  assert.equal(state.model, 'claude-real-1');
  assert.equal(state.sessionStarted, true);
  assert.equal(state.permissionMode, 'auto');
  assert.equal(state.mcp.servers[0].status, 'connected');
  assert.deepEqual(state.warnings, []);
  assert.deepEqual(state.messages.map(message => message.role), ['user', 'assistant']);
  assert.equal(state.messages[1].tools[0].name, 'mcp__futureaide__report_parent');
  assert.equal(state.resultSeen, true);
  assert.equal(state.costUsd, 0.1);
});

test('a permission denial lands in history once, and a rejected MCP entry is a warning', () => {
  const state = stateOf();
  applyClaudeLine(state, JSON.stringify({ type: 'system', subtype: 'init',
    mcp_server_errors: [{ name: 'futureaide', type: 'invalid_config', message: 'missing command' }] }));
  applyClaudeLine(state, JSON.stringify({ type: 'assistant', message: { role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash' }] } }));
  applyClaudeLine(state, JSON.stringify({ type: 'user', message: { role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', is_error: true,
      content: [{ type: 'text', text: 'Permission to use Bash has been denied.' }] }] } }));
  applyClaudeLine(state, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'x',
    permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_bash' }] }));
  const denied = state.messages.filter(message => message.permissionDenied);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].toolUseId, 'toolu_bash');
  assert.equal(state.denials.length, 1);
  assert.equal(state.denials[0].tool, 'Bash');
  assert.deepEqual(state.warnings.map(warning => warning.code),
    ['claude-mcp-config-rejected', 'claude-mcp-server-missing']);
});

test('non-JSON progress lines are kept as raw tail, never thrown', () => {
  const state = stateOf();
  assert.equal(applyClaudeLine(state, 'compiling something').kind, 'raw');
  assert.equal(applyClaudeLine(state, '{"type":"unknown-future-event"}').kind, 'other');
  assert.deepEqual(state.rawTail, ['compiling something']);
  assert.equal(state.messages.length, 1, 'only the dispatched task is in history');
});

test('terminal outcomes separate a clean turn from every failure the caller must know about', () => {
  const clean = { ...stateOf(), sessionStarted: true, permissionMode: 'auto', resultSeen: true, resultIsError: false,
    resultText: 'I verified --permission-mode auto works.',
    mcp: { required: 'futureaide', servers: [{ name: 'futureaide', status: 'connected' }], errors: [] } };
  assert.equal(claudeTurnOutcome({ state: clean, exitCode: 0 }).state, 'ended');
  assert.equal(claudeTurnOutcome({ state: stateOf(), exitCode: 0 }).error.code, 'claude-result-missing');
  assert.equal(claudeTurnOutcome({ state: { ...stateOf(), resultSeen: true, resultIsError: true,
    resultSubtype: 'error_max_turns' }, exitCode: 0 }).error.code, 'claude-max-turns');
  // A result carried on a non-zero exit still hands back the CLI's own text.
  const failed = claudeTurnOutcome({ state: { ...stateOf(), resultSeen: true, resultIsError: true,
    resultSubtype: 'error_during_execution', resultText: 'could not write',
    resultErrors: ['EACCES: permission denied'] }, exitCode: 4, stderrTail: 'boom' });
  assert.equal(failed.error.code, 'claude-turn-failed');
  assert.match(failed.error.message, /could not write/);
  assert.match(failed.error.message, /EACCES/);
  // A capability refusal is recognised even when it only appears on stdout.
  assert.equal(claudeTurnOutcome({ state: { ...stateOf(), resultSeen: true, resultIsError: true,
    resultSubtype: 'error_during_execution',
    resultText: "error: option '--permission-mode <mode>' argument 'auto' is not supported" }, exitCode: 0 }).error.code,
  'claude-cli-permission-mode-unavailable');
  assert.equal(claudeTurnOutcome({ state: stateOf(), exitCode: 3, stderrTail: 'boom' }).error.code, 'claude-exit-nonzero');
  assert.equal(claudeTurnOutcome({ state: stateOf(), exitCode: 2,
    stderrTail: "error: option '--permission-mode <mode>' argument 'auto' is invalid" }).error.code,
  'claude-cli-permission-mode-unavailable');
  assert.equal(claudeTurnOutcome({ state: stateOf(), exitCode: 1, cancelled: true }).state, 'cancelled');
});

test('a turn that could not reach its parent, or ran in another mode, is a failure not a warning', () => {
  const started = () => ({ ...stateOf(), sessionStarted: true, permissionMode: 'auto', resultSeen: true, resultIsError: false });
  const missing = started();
  missing.mcp.servers = [];
  missing.warnings = [{ code: 'claude-mcp-server-missing', message: 'not in this CLI session' }];
  const missingOutcome = claudeTurnOutcome({ state: missing, exitCode: 0 });
  assert.equal(missingOutcome.state, 'failed');
  assert.equal(missingOutcome.error.code, 'claude-mcp-server-missing');
  assert.match(missingOutcome.error.message, /not in this CLI session/);

  const disconnected = started();
  disconnected.mcp.servers = [{ name: 'futureaide', status: 'failed' }];
  const disconnectedOutcome = claudeTurnOutcome({ state: disconnected, exitCode: 0 });
  assert.equal(disconnectedOutcome.state, 'failed');
  assert.equal(disconnectedOutcome.error.code, 'claude-mcp-server-not-connected');
  assert.match(disconnectedOutcome.error.message, /failed/);

  const rejected = started();
  rejected.mcp.servers = [{ name: 'futureaide', status: 'connected' }];
  rejected.mcp.errors = [{ name: 'futureaide', type: 'invalid_config', message: 'bad' }];
  assert.equal(claudeTurnOutcome({ state: rejected, exitCode: 0 }).error.code, 'claude-mcp-config-rejected');

  const downgraded = started();
  downgraded.mcp.servers = [{ name: 'futureaide', status: 'connected' }];
  downgraded.permissionMode = 'acceptEdits';
  const downgradedOutcome = claudeTurnOutcome({ state: downgraded, exitCode: 0 });
  assert.equal(downgradedOutcome.state, 'failed');
  assert.equal(downgradedOutcome.error.code, 'claude-permission-mode-downgraded');
  assert.match(downgradedOutcome.error.message, /acceptEdits/);

  // A turn with the callback server connected and auto honoured is still a plain success.
  const healthy = started();
  healthy.mcp.servers = [{ name: 'futureaide', status: 'connected' }];
  healthy.permissionMode = 'auto';
  healthy.mcp.errors = [{ name: 'optional-other-server', type: 'invalid_config' }];
  assert.equal(claudeTurnOutcome({ state: healthy, exitCode: 0 }).state, 'ended');
  assert.equal(claudeTurnOutcome({ state: { ...healthy, permissionMode: null }, exitCode: 0 }).error.code,
    'claude-permission-mode-unconfirmed');
});

// ---------------------------------------------------------------------------
// Turns through the real detached worker
// ---------------------------------------------------------------------------

test('a full turn streams to ended with the real model and a connected MCP server', { timeout: 60000 }, async () => {
  const directory = await scratch('ok');
  const started = await run(directory);
  assert.equal(started.accepted, true);
  assert.ok(Number.isSafeInteger(started.workerPid));
  const turn = await waitForTurn(directory);
  assert.equal(turn.state, 'ended');
  assert.equal(turn.model, 'claude-fixture-default');
  assert.equal(turn.sessionStarted, true);
  assert.equal(turn.cliSessionId, SESSION);
  assert.equal(turn.permissionMode, 'auto');
  assert.equal(turn.mcp.servers[0].name, 'futureaide');
  assert.deepEqual(turn.warnings, []);
  assert.deepEqual(turn.messages.map(message => message.role), ['user', 'assistant', 'assistant', 'tool', 'assistant']);
  assert.equal(turn.messages[0].text, 'Do the task.');
  assert.match(turn.messages[2].tools[0].name, /ask_parent/);
  assert.equal(turn.messages[3].text, 'Use main.');
  assert.equal(turn.resultText, 'Finished the task.');
  // The raw transcript stays on disk next to the normalized state.
  assert.match(await readFile(path.join(directory, CLAUDE_TURN_FILES.stdout), 'utf8'), /"type":"result"/);
});

test('the CLI receives exactly the documented argv, prompt and MCP config', { timeout: 60000 }, async () => {
  const directory = await scratch('echo');
  await run(directory, { scenario: 'echo' });
  const turn = await waitForTurn(directory);
  assert.equal(turn.state, 'ended');
  const receipt = JSON.parse(turn.messages.find(message => message.role === 'assistant').text);
  assert.equal(receipt.sessionId, SESSION);
  assert.equal(receipt.permissionMode, 'auto');
  assert.equal(receipt.permissionPrompts, 'none');
  assert.equal(receipt.allowedTools, 'mcp__futureaide__ask_parent,mcp__futureaide__report_parent');
  assert.deepEqual(receipt.mcpServerNames, ['futureaide']);
  assert.equal(receipt.prompt, 'Do the task.');
  assert.equal(receipt.model, 'claude-fixture-default', 'no --model was passed, so the CLI default is reported');
  assert.equal(receipt.effort, null);
  assert.ok(receipt.mcpFile.endsWith(CLAUDE_TURN_FILES.mcp));
  assert.match(receipt.systemPrompt, /ask_parent/);
  assert.match(receipt.systemPrompt, /report_parent/);
  for (const forbidden of ['--bare', '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions']) {
    assert.equal(receipt.argv.includes(forbidden), false, forbidden);
  }
});

test('explicit model and effort reach the CLI, and a resumed turn keeps the session id', { timeout: 60000 }, async () => {
  const directory = await scratch('model');
  await run(directory, { scenario: 'echo', model: 'claude-opus-4-6', effort: 'high', resume: true });
  const turn = await waitForTurn(directory);
  const receipt = JSON.parse(turn.messages.find(message => message.role === 'assistant').text);
  assert.equal(receipt.model, 'claude-opus-4-6');
  assert.equal(receipt.effort, 'high');
  assert.equal(receipt.resume, true);
  assert.equal(receipt.argv.includes('--session-id'), false);
});

test('readClaudeTurn reports a model only when the CLI printed one in init', { timeout: 60000 }, async () => {
  const directory = await scratch('no-init');
  await run(directory, { scenario: 'no-init', model: 'claude-requested-but-not-started' });
  const turn = await waitForTurn(directory);
  assert.equal(turn.state, 'failed');
  assert.equal(turn.error.code, 'claude-init-missing');
  assert.equal(turn.sessionStarted, false);
  assert.equal(turn.model, null, 'a requested model id must never be echoed as the model that ran');
});

test('a rejected MCP config or missing callback server fails the turn instead of stranding the parent', { timeout: 60000 }, async () => {
  const directory = await scratch('mcp-failed');
  await run(directory, { scenario: 'mcp-failed' });
  const turn = await waitForTurn(directory);
  assert.equal(turn.state, 'failed');
  assert.equal(turn.error.code, 'claude-mcp-server-missing');
  assert.match(turn.error.message, /futureaide/);
  const codes = turn.warnings.map(warning => warning.code);
  assert.ok(codes.includes('claude-mcp-config-rejected'));
  assert.ok(codes.includes('claude-mcp-server-missing'));
  assert.deepEqual(turn.mcp.servers, []);
});

test('a permission mode other than auto, or an auto refusal on stdout, fails the turn', { timeout: 60000 }, async () => {
  const downgraded = await scratch('permission-downgraded');
  await run(downgraded, { scenario: 'permission-downgraded' });
  const down = await waitForTurn(downgraded);
  assert.equal(down.state, 'failed');
  assert.equal(down.error.code, 'claude-permission-mode-downgraded');
  assert.equal(down.permissionMode, 'acceptEdits');

  // The refusal arrives as ordinary JSON on stdout with a zero exit code.
  const json = await scratch('auto-unavailable-json');
  await run(json, { scenario: 'auto-unavailable-json' });
  const refused = await waitForTurn(json);
  assert.equal(refused.state, 'failed');
  assert.equal(refused.error.code, 'claude-cli-permission-mode-unavailable');
  assert.match(refused.error.message, /--permission-mode/);
});

test('an error result keeps the CLI result text and errors[] in the failure', { timeout: 60000 }, async () => {
  const directory = await scratch('result-error');
  await run(directory, { scenario: 'result-error' });
  const turn = await waitForTurn(directory);
  assert.equal(turn.state, 'failed');
  assert.equal(turn.error.code, 'claude-turn-failed');
  assert.match(turn.error.message, /the workspace could not be written/);
  assert.match(turn.error.message, /EACCES/);
  assert.equal(turn.exitCode, 4);
});

test('a permission denial is visible in history and does not fail the turn', { timeout: 60000 }, async () => {
  const directory = await scratch('denied');
  await run(directory, { scenario: 'denied' });
  const turn = await waitForTurn(directory);
  assert.equal(turn.state, 'ended');
  // The shared inspect reads messages, so the refusal must be a message, not only metadata.
  const denied = turn.messages.filter(message => message.permissionDenied);
  assert.equal(denied.length, 1);
  assert.match(denied[0].text, /Permission to use Bash has been denied/);
  assert.equal(turn.messages.find(message => message.permissionDenied).role, 'tool');
  assert.deepEqual(turn.denials.map(denial => denial.tool), ['Bash']);
});

test('a CLI that never prints a result, and one that dies early, both end failed', { timeout: 60000 }, async () => {
  const missing = await scratch('no-result');
  await run(missing, { scenario: 'no-result' });
  const noResult = await waitForTurn(missing);
  assert.equal(noResult.state, 'failed');
  assert.equal(noResult.error.code, 'claude-result-missing');

  const crashed = await scratch('crash');
  await run(crashed, { scenario: 'crash' });
  const crash = await waitForTurn(crashed);
  assert.equal(crash.state, 'failed');
  assert.equal(crash.error.code, 'claude-exit-nonzero');
  assert.match(crash.error.message, /boom/);
  assert.equal(crash.sessionStarted, false, 'no init event, so no session was created');
});

test('a CLI that refuses --permission-mode auto is reported as an unavailable capability', { timeout: 60000 }, async () => {
  const directory = await scratch('permission');
  await run(directory, { scenario: 'permission-rejected' });
  const turn = await waitForTurn(directory);
  assert.equal(turn.state, 'failed');
  assert.equal(turn.error.code, 'claude-cli-permission-mode-unavailable');
  assert.match(turn.error.message, /--permission-mode/);
});

test('the last line is kept even when it has no newline and is larger than one read', { timeout: 60000 }, async () => {
  const noNewline = await scratch('no-newline');
  await run(noNewline, { scenario: 'no-newline' });
  const unterminated = await waitForTurn(noNewline);
  assert.equal(unterminated.state, 'ended', 'a result line without a trailing newline still counts');
  assert.equal(unterminated.resultText, 'unterminated result line');

  const large = await scratch('large');
  await run(large, { scenario: 'large' });
  const big = await waitForTurn(large);
  assert.equal(big.state, 'ended');
  assert.equal(big.resultText, 'large done');
  const raw = await stat(path.join(large, CLAUDE_TURN_FILES.stdout));
  assert.ok(raw.size > 4 * 1024 * 1024, 'the transcript really was bigger than one 4 MB read');
});

test('re-reading a turn never dispatches again, and one directory is one request', { timeout: 60000 }, async () => {
  const directory = await scratch('duplicate');
  const [first, second] = await Promise.all([run(directory, { scenario: 'hang' }), run(directory, { scenario: 'hang' })]);
  assert.ok([first, second].some(result => result.accepted === true), 'one concurrent call is accepted');
  assert.equal([first, second].filter(result => result.duplicate === false).length, 1, 'exactly one call dispatches');
  await waitForTurn(directory, value => Number.isSafeInteger(value.claudePid));
  // Reading is free: no new CLI process appears.
  await readClaudeTurn(directory);
  await readClaudeTurn(directory);
  let spawns = [];
  for (let attempt = 0; attempt < 50 && !spawns.length; attempt++) {
    try {
      spawns = (await readFile(path.join(directory, 'receipts', 'fake-claude-spawns.log'), 'utf8'))
        .trim().split('\n').filter(Boolean);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!spawns.length) await delay(100);
  }
  assert.equal(spawns.length, 1, 'the stand-in CLI must have been started exactly once');
  await assert.rejects(run(directory, { scenario: 'hang', message: 'A different task.' }),
    error => error.code === 'claude-request-conflict');
  assert.equal((await cancelClaudeTurn(directory)).stopped, true);
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test('cancelClaudeTurn kills the whole tree and only then records cancelled', { timeout: 60000 }, async () => {
  const directory = await scratch('cancel');
  const started = await run(directory, { scenario: 'hang' });
  const running = await waitForTurn(directory, value => Number.isSafeInteger(value.claudePid) && value.phase === 'running');
  assert.ok(alive(running.claudePid), 'the stand-in CLI should be running');
  assert.ok(alive(started.workerPid));
  const cancelled = await cancelClaudeTurn(directory);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.stopped, true);
  assert.deepEqual(cancelled.remaining, []);
  assert.equal(alive(running.claudePid), false, 'the CLI process must be gone');
  assert.equal(alive(started.workerPid), false, 'the worker must be gone');
  const after = await readClaudeTurn(directory);
  assert.equal(after.state, 'cancelled');
  // Cancelling again is honest about there being nothing left to stop.
  const again = await cancelClaudeTurn(directory);
  assert.equal(again.stopped, true);
  assert.equal(again.cancelled, true);
});

test('a cancel that leaves processes alive keeps the turn running and can be retried', { timeout: 60000 }, async () => {
  const directory = await scratch('cancel-partial');
  const started = await run(directory, { scenario: 'hang' });
  const running = await waitForTurn(directory, value => Number.isSafeInteger(value.claudePid) && value.phase === 'running');
  const survivors = new Set([running.claudePid, started.workerPid]);
  const partial = await cancelClaudeTurn(directory, {
    isAlive: pid => survivors.has(pid),
    killTree: async () => ({ ok: false }),
  });
  assert.equal(partial.stopped, false);
  assert.equal(partial.cancelled, false);
  assert.equal(partial.state, 'running', 'a half-stopped tree must not be recorded as cancelled');
  assert.equal(partial.remaining.length, 2);
  assert.match(partial.note, /retried/);
  assert.equal((await readClaudeTurn(directory)).state, 'running', 'the record still says running');
  const marker = JSON.parse(await readFile(path.join(directory, CLAUDE_TURN_FILES.cancel), 'utf8'));
  assert.equal(marker.stopped, false);
  // The retry really stops it.
  const retried = await cancelClaudeTurn(directory);
  assert.equal(retried.stopped, true);
  assert.equal(retried.state, 'cancelled');
});

test('a turn that already ended is never killed by its old pid', async () => {
  const directory = await scratch('cancel-ended');
  await run(directory, { scenario: 'ok' });
  const ended = await waitForTurn(directory);
  assert.equal(ended.state, 'ended');
  let killed = 0;
  const stale = await cancelClaudeTurn(directory, {
    isAlive: () => true,
    killTree: async () => { killed += 1; return { ok: true }; },
  });
  assert.equal(killed, 0, 'a terminal record must never be killed again');
  assert.equal(stale.cancelled, false);
  assert.equal(stale.stopped, false);
  assert.match(stale.note, /never killed/);
  const clean = await cancelClaudeTurn(directory, {
    isAlive: () => false,
    killTree: async () => { killed += 1; return { ok: true }; },
  });
  assert.equal(killed, 0);
  assert.equal(clean.stopped, true);
  assert.equal(clean.state, 'ended');
  assert.equal((await readClaudeTurn(directory)).state, 'ended', 'the finished turn keeps its own state');
});

test('cancelClaudeTurn on an empty directory reports nothing to stop', async () => {
  const directory = await scratch('cancel-empty');
  const result = await cancelClaudeTurn(directory);
  assert.equal(result.stopped, true);
  assert.equal(result.cancelled, false);
  assert.match(result.note, /nothing to stop/);
});

test('a worker that finishes between the state read and the liveness check is not reported lost', async () => {
  const directory = await scratch('finish-race');
  await run(directory, { scenario: 'ok' });
  assert.equal((await waitForTurn(directory)).state, 'ended');
  const stateFile = path.join(directory, CLAUDE_TURN_FILES.state);
  const finished = await readFile(stateFile, 'utf8');
  await writeFile(stateFile, JSON.stringify({ ...JSON.parse(finished), state: 'running', error: null, phase: 'running' }, null, 2));
  // The reader holds the old running state; the worker writes its final state and exits
  // before the liveness check, so every recorded pid is gone by the time it is asked.
  const seen = await readClaudeTurn(directory, { isAlive: () => { writeFileSync(stateFile, finished); return false; } });
  assert.equal(seen.state, 'ended');
  assert.equal(seen.error, undefined);
});

test('a worker that vanished without finalizing is reported failed, not running', async () => {
  const directory = await scratch('lost');
  await run(directory, { scenario: 'ok' });
  assert.equal((await waitForTurn(directory)).state, 'ended');
  // Reproduce a killed worker: the record still says running, the pids are gone.
  const stateFile = path.join(directory, CLAUDE_TURN_FILES.state);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  await writeFile(stateFile, JSON.stringify({ ...state, state: 'running', error: null, phase: 'running' }, null, 2));
  const turnFile = path.join(directory, CLAUDE_TURN_FILES.turn);
  await writeFile(turnFile, JSON.stringify({ ...JSON.parse(await readFile(turnFile, 'utf8')), workerPid: 2147483000 }, null, 2));
  const lost = await readClaudeTurn(directory, { isAlive: () => false });
  assert.equal(lost.state, 'failed');
  assert.equal(lost.error.code, 'claude-turn-worker-lost');
  assert.ok(lost.messages.length > 0, 'what the CLI printed is still readable');
  // Only a confirmed cancel can make a dead worker's turn read as cancelled.
  await writeFile(path.join(directory, CLAUDE_TURN_FILES.cancel), JSON.stringify({ requestedAt: new Date().toISOString(), stopped: true }));
  const cancelled = await readClaudeTurn(directory, { isAlive: () => false });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.error, undefined);
});

// ---------------------------------------------------------------------------
// Input validation and files
// ---------------------------------------------------------------------------

test('startClaudeTurn refuses incomplete input instead of starting something', async () => {
  const directory = await scratch('validate');
  let spawned = 0;
  const spawnWorker = async () => { spawned += 1; return { pid: process.pid }; };
  const base = { directory, cli: fixtureCli, workspace: directory, sessionId: SESSION, message: 'x' };
  const cases = [
    [{ ...base, directory: 'relative/dir' }, 'invalid-directory'],
    [{ ...base, workspace: undefined }, 'invalid-workspace'],
    [{ ...base, sessionId: 'nope' }, 'invalid-session-id'],
    [{ ...base, message: '   ' }, 'invalid-message'],
    [{ ...base, effort: 'extreme' }, 'invalid-effort'],
    [{ ...base, mcpConfig: { mcpServers: {} } }, 'invalid-mcp-config'],
    [{ ...base, cli: {} }, 'invalid-cli'],
  ];
  for (const [input, code] of cases) {
    await assert.rejects(startClaudeTurn(input, { spawnWorker }), error => error.code === code);
  }
  assert.equal(spawned, 0, 'a refused request must never spawn a worker');
  assert.deepEqual(await readdir(directory), []);
});

test('one accepted request spawns exactly one worker and writes the private files', async () => {
  const directory = await scratch('files');
  let spawned = 0;
  const spawnWorker = async () => { spawned += 1; return { pid: process.pid }; };
  const started = await startClaudeTurn({ directory, cli: fixtureCli, workspace: directory, sessionId: SESSION,
    message: 'hello', mcpConfig: MCP_CONFIG }, { spawnWorker });
  assert.equal(spawned, 1);
  assert.equal(started.duplicate, false);
  assert.deepEqual((await readdir(directory)).sort(),
    [CLAUDE_TURN_FILES.mcp, CLAUDE_TURN_FILES.owner, CLAUDE_TURN_FILES.prompt, CLAUDE_TURN_FILES.state, CLAUDE_TURN_FILES.turn].sort());
  const turn = JSON.parse(await readFile(path.join(directory, CLAUDE_TURN_FILES.turn), 'utf8'));
  assert.equal(turn.args.includes('--permission-mode'), true);
  assert.equal(await readFile(path.join(directory, CLAUDE_TURN_FILES.prompt), 'utf8'), 'hello');
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, CLAUDE_TURN_FILES.mcp), 'utf8')), MCP_CONFIG);
});

test('a worker that cannot be started is recorded failed, not left running', async () => {
  const directory = await scratch('spawn-fail');
  await assert.rejects(startClaudeTurn({ directory, cli: fixtureCli, workspace: directory, sessionId: SESSION,
    message: 'hello' }, { spawnWorker: async () => { throw new Error('spawn refused'); } }),
  error => error.code === 'claude-cli-spawn-failed');
  const turn = await readClaudeTurn(directory);
  assert.equal(turn.state, 'failed');
  assert.equal(turn.error.code, 'claude-cli-spawn-failed');
});
