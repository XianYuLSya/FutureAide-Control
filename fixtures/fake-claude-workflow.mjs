#!/usr/bin/env node
// A stand-in for the `claude` headless CLI, used only by tests.
//
// It exists so the real adapter (src/claude-cli-backend.mjs), the real runner
// (src/claude-cli-runner.mjs), its detached worker and the real ask_parent /
// report_parent MCP server can be exercised end to end without a real Claude
// account, a real model call or a real CLI installation.
//
// It is not a claim about the real CLI. Everything it answers is fixture data:
// the model list, the auth state and the scripted steps.
//
// Surface, as the runner drives it:
//   claude --version
//   claude --help                       (--permission-mode / --permission-prompts)
//   claude auth status                  JSON on stdout; exit 1 when logged out
//   claude auth login                   flips the fixture's own auth state
//   claude -p --output-format stream-json --verbose
//          --permission-mode auto --permission-prompts none
//          (--session-id <uuid> | --resume <uuid>) [--model] [--effort]
//          [--append-system-prompt <text>] [--mcp-config <file>]
//          [--allowedTools <tools>] [--name <name>]
//     The prompt arrives on stdin. stream-json events go to stdout.
//
// The --mcp-config file is the production `{mcpServers:{futureaide:{...}}}` object,
// so the ask and report steps really connect to that stdio server as a client and
// really call ask_parent / report_parent; the outcome is recorded with the turn.
//
// Environment
//   FAKE_CLAUDE_HOME           auth state, per-session turn records, invocation log
//   FAKE_CLAUDE_SCENARIO_FILE  JSON {"steps":[{mode:'text'|'ask'|'final'|'deny'|'fail'|'hang', ...}]}
//                              Step N drives turn N of each conversation.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const selfPath = fileURLToPath(import.meta.url);

/** Fixture catalog: four declared models, stable across logins. */
export const CLI_MODELS = Object.freeze(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
export const AUTH_REASON = 'Not logged in: the stored OAuth token expired. Run `claude auth login`.';
export const VERSION = '2.9.0 (FutureAide CLI stand-in)';

const HELP = `Usage: claude [options] [command]

Options:
  -p, --print                        Print response and exit
  --output-format <format>           Output format (choices: "text", "json", "stream-json")
  --verbose                          Verbose output
  --permission-mode <mode>           Permission mode (choices: "default", "acceptEdits", "plan", "auto")
  --permission-prompts <target>      Permission prompts in print mode (choices: "ask", "none")
  --mcp-config <file>                Load MCP servers from a JSON file
  --allowedTools <tools...>          Pre-allowed tool names
  --session-id <uuid>                Use a specific session id
  --resume <uuid>                    Resume a specific session
  --model <model>                    Model for this turn
  --effort <level>                   Reasoning effort for this turn
  --append-system-prompt <text>      Extra system prompt
  --name <name>                      Name for this conversation
  -h, --help                         Show help
  -v, --version                      Show version

Commands:
  auth status                        Show the current login
  auth login                         Sign in
`;

const home = () => process.env.FAKE_CLAUDE_HOME ?? path.join(path.dirname(selfPath), '.fake-claude-home');
const authFile = () => path.join(home(), 'auth.json');
const sessionsDir = () => path.join(home(), 'sessions');
const sessionFile = id => path.join(sessionsDir(), `${id}.json`);
const logFile = () => path.join(home(), 'invocations.jsonl');

const out = line => process.stdout.write(line);
const err = line => process.stderr.write(line);

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
function authState() {
  return readJson(authFile(), { loggedIn: false, reason: AUTH_REASON, account: null });
}
function steps() {
  const file = process.env.FAKE_CLAUDE_SCENARIO_FILE;
  return (file ? readJson(file, { steps: [] }) : { steps: [] }).steps ?? [];
}
function logInvocation(entry) {
  mkdirSync(home(), { recursive: true });
  appendFileSync(logFile(), JSON.stringify(entry) + '\n', 'utf8');
}

function parseArgs(argv) {
  const options = { argv: [...argv], flags: {}, positional: [] };
  const valueFlags = new Set(['--output-format', '--permission-mode', '--permission-prompts',
    '--session-id', '--resume', '--model', '--effort', '--append-system-prompt', '--mcp-config',
    '--allowedTools', '--name']);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (valueFlags.has(token)) { options.flags[token.slice(2)] = argv[++index]; continue; }
    if (token === '-p' || token === '--print') { options.flags.print = true; continue; }
    if (token === '--verbose') { options.flags.verbose = true; continue; }
    if (token === '--version' || token === '-v') { options.flags.version = true; continue; }
    if (token === '--help' || token === '-h') { options.flags.help = true; continue; }
    if (token.startsWith('-')) { options.flags[token.replace(/^-+/, '')] = true; continue; }
    options.positional.push(token);
  }
  options.command = options.positional[0] === 'auth' ? 'auth' : 'print';
  options.sub = options.positional[1];
  return options;
}

/**
 * The real stdio MCP server from `--mcp-config`. The production runner writes the
 * `futureaide` entry there, so this is the same client call a managed subagent makes.
 */
async function callParentTool(mcpConfig, { name, args }) {
  const server = mcpConfig?.mcpServers?.futureaide;
  if (!server?.command) return { ok: false, error: 'no futureaide server in --mcp-config' };
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({ command: server.command, args: server.args ?? [],
      cwd: process.cwd(), env: { ...process.env, ...(server.env ?? {}) }, stderr: 'ignore' });
    const client = new Client({ name: 'fake-claude-cli', version: '1.0.0' });
    await client.connect(transport);
    const result = await client.callTool({ name, arguments: args });
    await client.close();
    const text = result.content?.find(part => part.type === 'text')?.text;
    let value;
    try { value = text === undefined ? undefined : JSON.parse(text); } catch { value = text; }
    return result.isError === true ? { ok: false, error: value ?? 'tool error' } : { ok: true, result: value };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function readStdin() {
  try { return readFileSync(0, 'utf8'); }
  catch { return ''; }
}

async function runPrint(options) {
  const auth = authState();
  if (auth.loggedIn !== true) {
    err(AUTH_REASON + '\n');
    logInvocation({ command: 'print', argv: options.argv, exitCode: 1, refused: 'auth-required' });
    return 1;
  }
  const prompt = (options.positional[0] ?? readStdin()).trim();
  const requestedSession = options.flags.resume ?? options.flags['session-id'];
  if (requestedSession && !/^[0-9a-f-]{36}$/i.test(requestedSession)) {
    err(`Invalid session id: ${requestedSession}\n`);
    return 4;
  }
  let sessionId = requestedSession;
  if (options.flags.resume) {
    if (!readJson(sessionFile(options.flags.resume), undefined)) {
      // The same refusal the real CLI gives: a resume of an unknown conversation
      // must never silently become a second conversation.
      err(`No conversation found with session ID: ${options.flags.resume}\n`);
      logInvocation({ command: 'print', argv: options.argv, exitCode: 3, refused: 'unknown-session',
        resume: options.flags.resume });
      return 3;
    }
  } else if (!sessionId) {
    sessionId = randomUUID();
  }
  const conversation = readJson(sessionFile(sessionId), undefined)
    ?? { sessionId, createdAt: new Date().toISOString(), turns: [] };
  const step = steps()[conversation.turns.length] ?? { mode: 'text', text: 'Nothing was scripted for this turn.' };
  const mcpConfig = options.flags['mcp-config']
    ? readJson(path.resolve(options.flags['mcp-config']), undefined) : undefined;
  const emit = event => out(JSON.stringify(event) + '\n');
  const toolText = (id, name, input) => ({ type: 'assistant', session_id: sessionId,
    message: { content: [{ type: 'tool_use', id, name, input }] } });
  const toolResult = (id, text, isError) => ({ type: 'user', session_id: sessionId,
    message: { content: [{ type: 'tool_result', tool_use_id: id,
      content: [{ type: 'text', text }], ...(isError ? { is_error: true } : {}) }] } });
  const text = value => ({ type: 'assistant', session_id: sessionId,
    message: { model: options.flags.model ?? null, content: [{ type: 'text', text: value }] } });
  const result = extra => ({ type: 'result', session_id: sessionId, num_turns: 1, duration_ms: 12,
    total_cost_usd: 0, is_error: false, subtype: 'success', result: 'ok', ...extra });

  const calls = [];
  let exitCode = 0;
  emit({ type: 'system', subtype: 'init', session_id: sessionId, model: options.flags.model ?? 'claude-fixture-default',
    permissionMode: options.flags['permission-mode'] ?? null, cwd: process.cwd(),
    tools: ['Bash', 'Read', 'Write'], mcp_servers: [{ name: 'futureaide', status: 'connected' }] });

  if (step.mode === 'hang') {
    emit(text(step.text ?? 'long running work'));
    // Stays alive until the runner cancels the whole tree.
    await new Promise(resolve => setTimeout(resolve, Number(step.ms ?? 60000)));
    emit(result());
  } else if (step.mode === 'fail') {
    emit(text(step.stdout ?? 'partial output before the failure'));
    err((step.stderr ?? 'API Error: 500 internal error') + '\n');
    emit({ type: 'result', session_id: sessionId, subtype: 'error_during_execution', is_error: true,
      errors: [step.stderr ?? 'API Error: 500 internal error'], result: '' });
  } else {
    emit(text(step.text ?? 'working on it'));
    if (step.mode === 'ask') {
      const message = step.message ?? 'Which directory should I write to?';
      emit(toolText('toolu_ask', 'mcp__futureaide__ask_parent', { message }));
      const answer = await callParentTool(mcpConfig, { name: 'ask_parent', args: { message } });
      calls.push({ tool: 'ask_parent', ...answer });
      emit(toolResult('toolu_ask', answer.ok === true ? JSON.stringify(answer.result) : String(answer.error), answer.ok !== true));
    } else if (step.mode === 'final') {
      const message = step.message ?? 'Fixture report: the work is done.';
      const final = step.final !== false;
      if (step.tryBlank) {
        calls.push(await callParentTool(mcpConfig, { name: 'report_parent', args: { message: '  ', final: true } }));
      }
      emit(toolText('toolu_report', 'mcp__futureaide__report_parent', { message, final }));
      const answer = await callParentTool(mcpConfig, { name: 'report_parent', args: { message, final } });
      calls.push({ tool: 'report_parent', ...answer });
      emit(toolResult('toolu_report', answer.ok === true ? JSON.stringify(answer.result) : String(answer.error), answer.ok !== true));
    } else if (step.mode === 'deny') {
      const reason = step.reason ?? 'Bash(git push) is not allowed by the current permission policy.';
      emit(toolText('toolu_deny', step.tool ?? 'Bash', { command: 'git push' }));
      emit(toolResult('toolu_deny', `Permission denied: ${reason}`, true));
      emit(text(`I could not finish the task: ${reason}`));
    }
    emit(result());
  }

  conversation.turns.push({ index: conversation.turns.length, prompt, mode: step.mode,
    at: new Date().toISOString(), exitCode, resumed: Boolean(options.flags.resume),
    ...(calls.length ? { calls } : {}) });
  writeJson(sessionFile(sessionId), conversation);
  logInvocation({ command: 'print', argv: options.argv, exitCode, sessionId, resumed: Boolean(options.flags.resume),
    modelFlag: Object.hasOwn(options.flags, 'model'), model: options.flags.model ?? null,
    effort: options.flags.effort ?? null, prompt, mode: step.mode, textChannel: Boolean(mcpConfig),
    ...(calls.length ? { calls } : {}) });
  return exitCode;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.flags.version) { out(VERSION + '\n'); return 0; }
  if (options.flags.help) { out(HELP); return 0; }
  if (options.command === 'auth') {
    const auth = authState();
    if (options.sub === 'login') {
      const next = { loggedIn: true, account: 'fixture@example.invalid', loggedAt: new Date().toISOString() };
      writeJson(authFile(), next);
      logInvocation({ command: 'auth login', argv: options.argv, exitCode: 0 });
      out(JSON.stringify({ loggedIn: true, models: CLI_MODELS }) + '\n');
      return 0;
    }
    if (options.sub && options.sub !== 'status') { err(`Unknown auth command: ${options.sub}\n`); return 4; }
    const payload = { loggedIn: auth.loggedIn === true, authMethod: auth.loggedIn ? 'claude.ai' : 'none', account: auth.account ?? null,
      ...(auth.loggedIn === true ? {} : { reason: auth.reason ?? AUTH_REASON }), models: CLI_MODELS };
    out(JSON.stringify(payload) + '\n');
    logInvocation({ command: 'auth status', argv: options.argv, exitCode: payload.loggedIn ? 0 : 1 });
    return payload.loggedIn ? 0 : 1;
  }
  return runPrint(options);
}

/** The auth state the fixture starts from, written before a case runs. */
export function writeAuthState(directory, { loggedIn }) {
  writeJson(path.join(directory, 'auth.json'), loggedIn === true
    ? { loggedIn: true, account: 'fixture@example.invalid', loggedAt: new Date().toISOString() }
    : { loggedIn: false, reason: AUTH_REASON, account: null });
}

/** Every recorded invocation, oldest first. */
export function readInvocations(directory) {
  try {
    return readFileSync(path.join(directory, 'invocations.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/** The newest turn directory under one managed name's private state. */
export function latestTurnDirectory(agentDirectory) {
  const root = path.join(agentDirectory, 'claude-cli', 'turns');
  try {
    return readdirSync(root).map(name => path.join(root, name))
      .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs).at(-1);
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** True while a pid is still running. */
export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}


if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
