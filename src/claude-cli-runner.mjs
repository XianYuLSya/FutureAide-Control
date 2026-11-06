// Headless Claude Code turns for the FutureAide shared state machine.
//
// Claude Desktop exposes no external session API, so a FutureAide target that runs
// Claude has to drive the real Claude Code CLI in print mode. This module owns exactly
// that: one request per private directory, one detached worker per request, and a
// normalized read model the shared layer can poll without knowing the CLI's event
// format. It never speaks to a model itself and never keeps a connection open, so a
// caller that disappears does not affect a running turn, and the turn does not depend
// on the FutureAide MCP connection staying up (the CLI runs its own MCP client).
//
// Files in one request directory (all written here, never in a shared location):
//   owner.json           claimed once with O_EXCL; a second dispatcher cannot take it
//   turn.json            the resolved command, argv, workspace and worker pid
//   prompt.txt           the exact message, passed on stdin (no argv length limit)
//   mcp.json             only when mcpConfig was given; that object, verbatim
//   stdout.stream.jsonl  raw CLI stdout, appended by the CLI itself
//   stderr.log           raw CLI stderr
//   state.json           normalized snapshot, replaced atomically by the worker
//   cancel.json          the cancel attempt and whether the whole tree really stopped
//
// Environment: every child inherits this process's environment unchanged. Proxy
// variables (HTTP_PROXY, HTTPS_PROXY, NO_PROXY, ...) are never set, cleared or
// "helpfully" corrected here; the user's proxy decision is the user's. Credentials and
// Claude Desktop caches are never read: authentication is reported only by
// `claude auth status`.
//
// Process ownership: the worker records its own pid the moment it starts (turn.json and
// state.json), so a caller that dies between spawning the worker and writing its own record
// cannot leave a turn nobody names; the CLI pid is recorded by the worker when it spawns it.
// A turn is settled only when its own record is terminal or every recorded pid is gone: a live
// CLI tree whose worker died stays open, because calling it failed would hand the caller a
// finished turn while its processes keep running. A recorded pid is killed only while the
// process behind it still names this request, so a number the system has since reused is never
// touched. The worker also stops the tree as soon as the first system/init proves the turn
// cannot honour its permission mode or its callback server (claudeInitError).
//
// Injection seams for tests (all optional, all defaulting to production behavior):
//   probeClaudeCli({ findCli, exec })        fake CLI discovery and command execution
//   startClaudeTurn(input, { spawnWorker })  fake detached spawn
//   readClaudeTurn(directory, { isAlive })   fake process liveness
//   cancelClaudeTurn(directory, { isAlive, killTree, commandLines })  fake kill tree and identity
//   `cli` may be a path string, or { command, prefixArgs } so a stand-in CLI can be run
//   by an interpreter. The real caller always passes the path string probeClaudeCli
//   returned.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { replaceStateFile } from './replace-state-file.mjs';

const execFileAsync = promisify(execFile);

// The installer already owns the one CLI-discovery rule (explicit, CLAUDE_CLI, PATH, then
// the newest installed Claude build), so it is reused instead of copied. It is loaded on
// demand because the detached worker imports this module too and must stay cheap.
async function defaultFindClaudeCli(options) {
  const { findClaudeCli } = await import('../scripts/install-plugin.mjs');
  return findClaudeCli(options);
}

/** Effort levels `--effort` accepts; anything else is refused before a process starts. */
export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
/** The MCP server whose two callback tools are the only ones pre-allowed. */
export const DEFAULT_MCP_SERVER_NAME = 'futureaide';
/** Callback tools pre-allowed non-interactively; nothing else is widened. */
export const REQUIRED_MCP_TOOLS = Object.freeze(['ask_parent', 'report_parent']);
/** Stored message text is bounded the same way the shared history view bounds it. */
export const MAX_MESSAGE_TEXT = 8000;
/** Oldest normalized messages are dropped beyond this, so a long turn cannot bloat state.json. */
export const MAX_STORED_MESSAGES = 400;
/** A live worker rewrites its heartbeat this often; a reader uses it to spot a killed worker. */
export const WORKER_HEARTBEAT_MS = 2000;
/** A running turn with no heartbeat for this long is reported failed, not "still running". */
export const LOST_HEARTBEAT_MS = 120000;
/** How long cancel keeps confirming that the whole tree is gone before admitting it is not. */
export const CANCEL_CONFIRM_MS = 10000;
/** A probe must never hang a status call: every CLI read is bounded by this. */
const PROBE_TIMEOUT_MS = 30000;

export const CLAUDE_TURN_FILES = Object.freeze({
  owner: 'owner.json', turn: 'turn.json', prompt: 'prompt.txt', mcp: 'mcp.json',
  stdout: 'stdout.stream.jsonl', stderr: 'stderr.log', state: 'state.json', cancel: 'cancel.json',
});

const TERMINAL_STATES = Object.freeze(['ended', 'failed', 'cancelled']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code, message) => Object.assign(new Error(message), { code });
const isUuid = value => typeof value === 'string' && UUID.test(value);

async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Replace one JSON file in place; a reader never sees a half-written state. */
export async function writeJsonFile(directory, name, value) {
  const target = path.join(directory, name);
  const temporary = target + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' });
  await replaceStateFile(temporary, target);
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/**
 * The worker pid this turn recorded: the worker's own claim in turn.json first, then the copy
 * it keeps in state.json for the case where the caller died before writing anything.
 */
function recordedWorkerPid(turn, state) {
  for (const value of [turn?.workerPid, state?.workerPid]) {
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

function cliCommand(cli) {
  if (typeof cli === 'string' && cli.trim()) return { command: cli.trim(), prefixArgs: [] };
  if (cli && typeof cli === 'object' && typeof cli.command === 'string' && cli.command.trim()) {
    const prefixArgs = Array.isArray(cli.prefixArgs) ? cli.prefixArgs.map(String) : [];
    return { command: cli.command.trim(), prefixArgs };
  }
  throw fail('invalid-cli', 'A Claude CLI path (or a {command, prefixArgs} stand-in) is required. Use probeClaudeCli() to resolve it.');
}

/** `mcp__<server>__<tool>`: the name the CLI exposes for one MCP tool. */
export const mcpToolName = (server, tool) => 'mcp__' + server + '__' + tool;

/**
 * The only tools pre-allowed without a prompt. Everything else stays under the session's
 * permission mode, and with --permission-prompts none anything that would ask is denied
 * instead of silently widening what the subagent may call.
 * @param {string} server MCP server name from mcpConfig.
 * @returns {string[]} Exact allowedTools values.
 */
export function allowedCallbackTools(server = DEFAULT_MCP_SERVER_NAME) {
  const name = String(server || DEFAULT_MCP_SERVER_NAME);
  return REQUIRED_MCP_TOOLS.map(tool => mcpToolName(name, tool));
}

/** The one MCP server name a config may declare, so no other server gets a say. */
export function mcpServerFromConfig(mcpConfig) {
  const servers = mcpConfig?.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw fail('invalid-mcp-config', 'mcpConfig must be an object shaped {"mcpServers":{"<name>":{...}}}; it is passed to --mcp-config as given.');
  }
  const names = Object.keys(servers);
  if (names.length !== 1) {
    throw fail('invalid-mcp-config', `mcpConfig must declare exactly one MCP server so only its callback tools are pre-allowed; received ${names.length}.`);
  }
  return names[0];
}

/** System prompt that tells the model which two calls reach its parent. */
export function claudeSystemPrompt({ serverName = DEFAULT_MCP_SERVER_NAME, name } = {}) {
  const server = String(serverName || DEFAULT_MCP_SERVER_NAME);
  return [
    'You are a FutureAide managed Claude helper' + (name ? ' named ' + JSON.stringify(name) : '') + '.',
    'Another agent assigned this task and is waiting for you.',
    `If you need a decision from your parent, call the MCP tool ${mcpToolName(server, 'ask_parent')}.`,
    `Deliver your final result with ${mcpToolName(server, 'report_parent')}(message, final=true).`,
    'Ordinary replies do not reach your parent; only those two calls do.',
  ].join('\n');
}

/**
 * Print-mode argv for one turn. The prompt is deliberately absent: `-p` with no
 * positional prompt reads it from stdin, which keeps long tasks off the command line
 * and avoids Windows quoting entirely.
 * @param {object} input Turn options; sessionId is always required.
 * @param {boolean} [input.resume] Continue an existing session instead of creating it.
 * @returns {string[]} argv without the executable.
 */
export function claudeTurnArguments({ sessionId, resume = false, model, effort, systemPrompt, mcpFile, allowedTools, name } = {}) {
  if (!isUuid(sessionId)) throw fail('invalid-session-id', 'sessionId must be a UUID: the Claude CLI requires one for --session-id and --resume.');
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'auto', '--permission-prompts', 'none',
    ...(resume === true ? ['--resume', sessionId] : ['--session-id', sessionId])];
  if (model) args.push('--model', String(model));
  if (effort) args.push('--effort', String(effort));
  if (systemPrompt) args.push('--append-system-prompt', String(systemPrompt));
  if (mcpFile) {
    args.push('--mcp-config', String(mcpFile));
    if (Array.isArray(allowedTools) && allowedTools.length) args.push('--allowedTools', allowedTools.join(','));
  }
  if (name) args.push('--name', String(name));
  return args;
}

// ---------------------------------------------------------------------------
// Discovery and readiness
// ---------------------------------------------------------------------------

/** Parse the `--permission-mode` / `--permission-prompts` capability out of `claude --help`. */
export function permissionSupportFromHelp(help) {
  const text = String(help ?? '');
  const modeFlag = /--permission-mode\s+<mode>/.test(text);
  const promptsHelp = text.match(/--permission-prompts\s+<target>([^\n]*(?:\r?\n[ \t]{4,}(?!-)[^\n]*)*)/)?.[1] ?? '';
  const promptsFlag = /\bnone\b/i.test(promptsHelp);
  const choices = text.match(/--permission-mode\s+<mode>[\s\S]{0,400}?\(choices:\s*([^)]*)\)/)?.[1] ?? '';
  const modes = choices.split(',').map(value => value.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  return { modeFlag, promptsFlag, modes, auto: modeFlag && modes.includes('auto') };
}

async function runCli(cli, args, { exec = execFileAsync } = {}) {
  try {
    const { stdout, stderr } = await exec(cli, args, { encoding: 'utf8', windowsHide: true,
      maxBuffer: 8 * 1024 * 1024, timeout: PROBE_TIMEOUT_MS });
    return { code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (error) {
    return {
      code: Number.isFinite(error?.code) ? Number(error.code) : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? error?.message ?? ''),
    };
  }
}

/**
 * Parse the CLI's JSON answer. The real `claude auth status` prints an indented object over
 * several lines, so a line-only reader would miss it.
 */
function readJsonAnswer(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return undefined;
  try { return JSON.parse(raw); }
  catch { /* fall through to the embedded object */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); }
    catch { /* fall through to a line scan */ }
  }
  for (const line of raw.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try { return JSON.parse(trimmed); }
    catch { /* keep looking */ }
  }
  return undefined;
}

// A managed Claude turn must run on the account the CLI itself signed in to. The FutureAide
// target calls the user's own Claude subscription, so an API-key, cloud or gateway auth path
// is refused instead of silently billing another route. Only the reported method is read;
// no credential file, key or desktop cache is ever opened.
const AUTH_METHOD_REJECTED = /api[-_ ]?key|bedrock|vertex|foundry|gateway|azur|iam|service[-_ ]?account|cloud/i;
const AUTH_METHOD_OAUTH = /oauth|claude\.ai|subscription/i;

/** Classify the CLI's reported auth method: 'oauth', 'unsupported' or 'unknown'. */
export function authMethodKind(method) {
  const value = String(method ?? '').trim();
  if (!value) return 'unknown';
  if (AUTH_METHOD_REJECTED.test(value)) return 'unsupported';
  if (AUTH_METHOD_OAUTH.test(value)) return 'oauth';
  return 'unsupported';
}

/**
 * Resolve the Claude CLI and prove it can run a non-interactive turn.
 * Reads nothing but the CLI's own output: no .credentials, no Desktop cache, no proxy
 * configuration. Every failure carries a concrete code so the caller can show the reason.
 * `--permission-mode auto` and `--permission-prompts none` are requirements, not
 * preferences: a CLI that cannot do both is refused instead of being run permissively.
 * @param {object} [options] Test seams and an explicit CLI path.
 * @returns {Promise<{cli: string, auth: object, permissions: object}>}
 */
export async function probeClaudeCli({ explicit, env = process.env, findCli = defaultFindClaudeCli, exec } = {}) {
  const cli = await findCli({ explicit, env });
  if (!cli) {
    throw fail('claude-cli-not-found', 'The Claude Code CLI was not found: put claude on PATH, install Claude Code, or pass an explicit path. Nothing was started.');
  }
  const auth = await runCli(cli, ['auth', 'status'], { exec });
  const status = readJsonAnswer(auth.stdout);
  if (!status) {
    throw fail('claude-cli-probe-failed', '`claude auth status` did not return JSON, so this CLI cannot be used. Nothing was started.');
  }
  if (status.loggedIn !== true) {
    throw fail('claude-cli-auth-required', 'The Claude Code CLI is installed but not signed in (`claude auth status` reports loggedIn=false). Sign in with the CLI, then dispatch again. Nothing was started.');
  }
  if (auth.code !== 0) throw fail('claude-cli-probe-failed',
    `claude auth status exited with code ${auth.code}; login could not be verified.`);
  const kind = authMethodKind(status.authMethod);
  if (kind !== 'oauth') {
    throw fail('claude-cli-auth-unsupported', 'This managed Claude turn has to use the subscription the CLI signed in to itself, '
      + 'but `claude auth status` reports authMethod ' + JSON.stringify(status.authMethod ?? null)
      + ', which is not that sign-in. Sign the CLI in with its own OAuth login and dispatch again. Nothing was started.');
  }
  const help = await runCli(cli, ['--help'], { exec });
  if (help.code !== 0 || !help.stdout.trim()) {
    throw fail('claude-cli-probe-failed', 'This Claude CLI did not print its help, so its permission flags cannot be verified. Nothing was started.'
      + (help.stderr.trim() ? ' It said: ' + help.stderr.trim().slice(0, 300) : ''));
  }
  const support = permissionSupportFromHelp(help.stdout);
  if (!support.modeFlag) {
    throw fail('claude-cli-permission-mode-unavailable', 'This Claude CLI has no --permission-mode flag, so a non-interactive turn cannot be bounded. Nothing was started.');
  }
  if (!support.auto) {
    throw fail('claude-cli-permission-mode-unavailable', 'This Claude CLI does not offer --permission-mode auto'
      + (support.modes.length ? ` (it lists: ${support.modes.join(', ')})` : '') + '. Nothing was started; a turn that would prompt has no one to answer it.');
  }
  if (!support.promptsFlag) {
    throw fail('claude-cli-permission-prompts-unavailable', 'This Claude CLI has no --permission-prompts flag, so permission prompts in print mode cannot be refused deterministically. Nothing was started.');
  }
  return {
    cli,
    auth: {
      loggedIn: true,
      authMethod: status.authMethod ?? null,
      subscriptionType: status.subscriptionType ?? null,
    },
    permissions: { mode: 'auto', prompts: 'none', modes: support.modes },
  };
}

// ---------------------------------------------------------------------------
// Normalization (pure, shared with the worker)
// ---------------------------------------------------------------------------

/** Fresh normalized state for one request. `model` stays null until the CLI reports it. */
export function createClaudeTurnState({ requestId, sessionId, workspace, message, mcpRequired } = {}) {
  const time = new Date().toISOString();
  const state = {
    version: 1, requestId: requestId ?? null, sessionId: sessionId ?? null, cliSessionId: null,
    workspace: workspace ?? null, state: 'running', phase: 'starting',
    startedAt: time, updatedAt: time, heartbeatAt: time, endedAt: null,
    model: null, permissionMode: null, sessionStarted: false,
    messages: [], messagesDropped: 0,
    warnings: [], mcp: { required: mcpRequired ?? null, servers: [], errors: [] },
    denials: [], rawTail: [],
    resultSeen: false, resultSubtype: null, resultIsError: false, resultText: null,
    resultErrors: [], turns: null, durationMs: null, costUsd: null, stopReason: null,
    pid: null, exitCode: null, error: null,
  };
  if (typeof message === 'string' && message) {
    pushClaudeMessage(state, { role: 'user', kind: 'dispatch', text: message });
  }
  return state;
}

function bounded(text) {
  const value = String(text ?? '');
  return { text: value.slice(0, MAX_MESSAGE_TEXT), truncated: value.length > MAX_MESSAGE_TEXT };
}

function pushClaudeMessage(state, message) {
  state.messages.push({ time: new Date().toISOString(), ...message });
  const overflow = state.messages.length - MAX_STORED_MESSAGES;
  if (overflow > 0) {
    state.messages.splice(0, overflow);
    state.messagesDropped = (state.messagesDropped ?? 0) + overflow;
  }
}

function recordRawLine(state, line) {
  const value = String(line ?? '').trim();
  if (!value) return;
  state.rawTail = [...(state.rawTail ?? []), value.slice(0, 500)].slice(-20);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.content === 'string') return part.content;
    if (part?.type) return '[' + part.type + ']';
    return '';
  }).filter(Boolean).join('\n');
}

const PERMISSION_DENIED_TEXT = /permission|not allowed|not permitted|denied|prohibited|blocked|requires (?:your )?approval|needs approval/i;

function applySystemEvent(state, value) {
  // Only the init event may set the model: it is the one place the CLI states which model
  // the turn actually runs, so a caller-supplied model id can never be reported back as fact.
  if (value.subtype !== 'init') return;
  state.sessionStarted = true;
  if (state.phase === 'starting') state.phase = 'streaming';
  if (typeof value.session_id === 'string' && value.session_id) state.cliSessionId = value.session_id;
  if (typeof value.model === 'string' && value.model) state.model = value.model;
  if (typeof value.permissionMode === 'string' && value.permissionMode) state.permissionMode = value.permissionMode;
  const servers = Array.isArray(value.mcp_servers)
    ? value.mcp_servers.map(entry => ({ name: String(entry?.name ?? ''), status: String(entry?.status ?? 'unknown') }))
    : [];
  const errors = Array.isArray(value.mcp_server_errors)
    ? value.mcp_server_errors.map(entry => ({
      name: String(entry?.name ?? ''), type: String(entry?.type ?? 'unknown'),
      message: String(entry?.message ?? '').slice(0, 400) }))
    : [];
  state.mcp = { required: state.mcp?.required ?? null, servers, errors };
  applyMcpWarnings(state, servers, errors);
}

function applyMcpWarnings(state, servers, errors) {
  const warn = (code, message) => {
    const text = String(message).slice(0, 700);
    if (state.warnings.some(entry => entry.code === code && entry.message === text)) return;
    state.warnings.push({ code, message: text, time: new Date().toISOString() });
  };
  for (const entry of errors) {
    warn('claude-mcp-config-rejected', `The CLI skipped ${JSON.stringify(entry.name)} from --mcp-config (${entry.type})`
      + (entry.message ? ': ' + entry.message : '') + '. That server is absent from the session.');
  }
  const required = state.mcp?.required;
  if (!required) return;
  const entry = servers.find(server => server.name === required);
  if (!entry) {
    warn('claude-mcp-server-missing', `The required MCP server ${JSON.stringify(required)} is not in this CLI session, so ask_parent and report_parent cannot be called this turn.`);
  } else if (entry.status !== 'connected') {
    warn('claude-mcp-server-not-connected', `The required MCP server ${JSON.stringify(required)} reported status ${JSON.stringify(entry.status)}, so ask_parent and report_parent may be unavailable this turn.`);
  }
}

function applyAssistantEvent(state, value) {
  const content = Array.isArray(value.message?.content) ? value.message.content : [];
  const raw = content.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n');
  const tools = content.filter(part => part?.type === 'tool_use').slice(0, 24)
    .map(part => ({ name: String(part.name ?? '').slice(0, 160), id: String(part.id ?? '').slice(0, 200) }));
  if (!raw && !tools.length) return;
  const text = bounded(raw);
  pushClaudeMessage(state, {
    role: 'assistant', text: text.text, ...(text.truncated ? { textTruncated: true } : {}),
    ...(tools.length ? { tools } : {}),
  });
}

function applyUserEvent(state, value) {
  const content = value.message?.content;
  const parts = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
  for (const part of parts) {
    if (part?.type === 'tool_result') {
      const raw = contentText(part.content);
      const text = bounded(raw);
      const isError = part.is_error === true;
      const denied = isError && PERMISSION_DENIED_TEXT.test(raw);
      const toolUseId = typeof part.tool_use_id === 'string' ? part.tool_use_id : undefined;
      if (denied) {
        // The tool name lives on the assistant message that requested it; a denial is
        // recorded by name so the caller can see which call was refused.
        const name = toolUseId
          ? state.messages.flatMap(message => message.tools ?? []).find(tool => tool.id === toolUseId)?.name ?? null
          : null;
        state.denials.push({ tool: name, ...(toolUseId ? { toolUseId } : {}), source: 'tool_result' });
      }
      pushClaudeMessage(state, {
        role: 'tool', text: text.text, ...(text.truncated ? { textTruncated: true } : {}),
        ...(toolUseId ? { toolUseId } : {}), ...(isError ? { isError: true } : {}),
        ...(denied ? { permissionDenied: true } : {}),
      });
    } else if (part?.type === 'text' && typeof part.text === 'string') {
      const text = bounded(part.text);
      pushClaudeMessage(state, { role: 'user', text: text.text, ...(text.truncated ? { textTruncated: true } : {}) });
    }
  }
}

function resultErrorCode(subtype) {
  if (subtype === 'error_max_turns') return 'claude-max-turns';
  if (subtype === 'error_max_budget_usd') return 'claude-budget-exceeded';
  return 'claude-turn-failed';
}

function applyResultEvent(state, value) {
  state.resultSeen = true;
  state.resultSubtype = typeof value.subtype === 'string' ? value.subtype : null;
  state.resultIsError = value.is_error === true
    || (typeof value.subtype === 'string' && value.subtype !== 'success');
  if (typeof value.result === 'string') state.resultText = value.result.slice(0, MAX_MESSAGE_TEXT);
  if (Number.isSafeInteger(value.num_turns)) state.turns = value.num_turns;
  if (Number.isFinite(value.duration_ms)) state.durationMs = value.duration_ms;
  if (Number.isFinite(value.total_cost_usd)) state.costUsd = value.total_cost_usd;
  if (typeof value.stop_reason === 'string') state.stopReason = value.stop_reason;
  if (Array.isArray(value.errors) && value.errors.length) {
    state.resultErrors = value.errors.slice(0, 4).map(entry => String(entry).slice(0, 400));
  }
  for (const denial of Array.isArray(value.permission_denials) ? value.permission_denials : []) {
    const tool = String(denial?.tool_name ?? denial?.toolName ?? 'unknown');
    const toolUseId = denial?.tool_use_id ?? denial?.toolUseId;
    // A refusal already visible as a tool_result must not appear twice in history.
    if (toolUseId && state.messages.some(message => message.permissionDenied && message.toolUseId === toolUseId)) continue;
    state.denials.push({ tool, ...(toolUseId ? { toolUseId: String(toolUseId) } : {}), source: 'result' });
    pushClaudeMessage(state, {
      role: 'tool', text: `Permission denied for ${tool}; the CLI did not run it.`,
      permissionDenied: true, tool, ...(toolUseId ? { toolUseId: String(toolUseId) } : {}),
    });
  }
}

/**
 * Fold one CLI stdout line into the normalized state.
 * Unknown shapes are kept as raw tail, never thrown: a new CLI event type must not lose a turn.
 * @param {object} state Mutable state from createClaudeTurnState.
 * @param {string} line One raw line.
 * @returns {{kind: 'raw'|'system'|'assistant'|'user'|'result'|'other'}}
 */
export function applyClaudeLine(state, line) {
  let value;
  try { value = JSON.parse(line); }
  catch { recordRawLine(state, line); return { kind: 'raw' }; }
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') {
    recordRawLine(state, line);
    return { kind: 'raw' };
  }
  state.updatedAt = new Date().toISOString();
  if (value.type === 'system') { applySystemEvent(state, value); return { kind: 'system' }; }
  if (value.type === 'assistant') { applyAssistantEvent(state, value); return { kind: 'assistant' }; }
  if (value.type === 'user') { applyUserEvent(state, value); return { kind: 'user' }; }
  if (value.type === 'result') { applyResultEvent(state, value); return { kind: 'result' }; }
  return { kind: 'other' };
}

function tailText(state, stderrTail) {
  return [...(state.rawTail ?? []).slice(-2),
    String(stderrTail ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')]
    .filter(Boolean).join(' | ').slice(0, 700);
}

/**
 * A turn whose permission mode is not the auto mode we asked for, or whose CLI said the flag
 * is not usable, is not a safe or a complete turn: report it as a capability failure even when
 * the CLI exited 0 and printed a normal result, because the CLI can report the refusal inside
 * its own JSON output instead of on stderr.
 */
function permissionFailure(state, stderrTail, exitCode) {
  // A successful result contains the assistant's prose. It may even be an
  // explanation of these very flags and is never a CLI rejection diagnostic.
  if (exitCode === 0 && !state.resultIsError) return undefined;
  const evidence = [String(stderrTail ?? ''), ...(state.rawTail ?? []), state.resultText ?? '',
    ...(state.resultErrors ?? [])].filter(Boolean).join(' ');
  if (/--permission-mode|--permission-prompts/i.test(evidence)
    && /invalid|unknown option|not supported|unsupported|unrecognized|unavailable|denied/i.test(evidence)) {
    return { code: 'claude-cli-permission-mode-unavailable',
      message: 'This Claude CLI rejected --permission-mode auto / --permission-prompts none, so the turn could not run non-interactively. Nothing was delivered. Claude said: '
        + evidence.slice(0, 600) };
  }
  return undefined;
}

/**
 * A turn that could not call its parent is a failed turn, not a quiet success: the parent is
 * waiting for a report that can never arrive. The required server's status and any rejected
 * --mcp-config entry are therefore terminal errors, with the details in the error itself.
 */
function mcpFailure(state) {
  if (!state.sessionStarted || !state.mcp?.required) return undefined;
  const required = state.mcp.required;
  const detail = (state.warnings ?? []).filter(entry => entry.code.startsWith('claude-mcp'))
    .map(entry => entry.message).join(' ');
  const entry = (state.mcp.servers ?? []).find(server => server.name === required);
  if (!entry) {
    return { code: 'claude-mcp-server-missing',
      message: `The required MCP server ${JSON.stringify(required)} was not in this Claude session, so ask_parent and report_parent could not be called and the parent would wait for a report that never comes. `
        + detail };
  }
  if (entry.status !== 'connected') {
    return { code: 'claude-mcp-server-not-connected',
      message: `The required MCP server ${JSON.stringify(required)} reported status ${JSON.stringify(entry.status)}, so ask_parent and report_parent could not be called and the parent would wait for a report that never comes. `
        + detail };
  }
  const rejected = (state.mcp.errors ?? []).find(error => error.name === required);
  if (rejected) {
    return { code: 'claude-mcp-config-rejected',
      message: `Claude rejected the required MCP server ${required}: ${rejected.message || rejected.type}.` };
  }
  return undefined;
}

/** Validate the first system/init before the worker lets the turn continue. */
export function claudeInitError(state) {
  if (!state.permissionMode) return { code: 'claude-permission-mode-unconfirmed',
    message: 'Claude did not report its effective permission mode in system/init.' };
  if (state.permissionMode !== 'auto') return { code: 'claude-permission-mode-downgraded',
    message: 'Claude selected permission mode ' + JSON.stringify(state.permissionMode) + '. The managed turn requires auto.' };
  return mcpFailure(state);
}

/**
 * Terminal state for one finished CLI process.
 * Every reason the caller must know about is returned as an error with its detail, never only
 * as a warning: a turn that cannot reach its parent, or that ran with the wrong permission
 * mode, or that printed an error result, did not succeed even when the exit code was 0.
 * @param {object} input Normalized state, exit code, cancel confirmation, stderr tail.
 * @returns {{state: 'ended'|'failed'|'cancelled', error?: {code: string, message: string}}}
 */
export function claudeTurnOutcome({ state, exitCode = null, cancelled = false, stderrTail = '' } = {}) {
  if (cancelled) return { state: 'cancelled' };
  const tail = tailText(state, stderrTail);
  const permission = permissionFailure(state, stderrTail, exitCode);
  if (permission) return { state: 'failed', error: permission };
  const reported = state.resultIsError
    ? [state.resultText, ...(state.resultErrors ?? [])].filter(Boolean).join(' ')
    : '';
  if (state.resultSeen && state.resultIsError) {
    return { state: 'failed', error: { code: resultErrorCode(state.resultSubtype),
      message: `Claude reported ${state.resultSubtype ?? 'an error'}`
        + (reported ? ': ' + reported.slice(0, 1200) : '') + (tail ? ' Output: ' + tail : '') } };
  }
  if (exitCode === 0 && !state.resultSeen) {
    return { state: 'failed', error: { code: 'claude-result-missing',
      message: 'Claude exited without a result event, so the turn has no usable outcome.' + (tail ? ' Output: ' + tail : '') } };
  }
  if (exitCode !== 0) {
    // A non-zero exit can still carry a result on stdout; its text is what explains the failure.
    const detail = (state.resultText || (state.resultErrors ?? []).join(' '))
      || (state.resultSeen ? '' : 'no result event');
    return { state: 'failed', error: { code: 'claude-exit-nonzero',
      message: `Claude exited with code ${exitCode ?? 'unknown'}.` + (detail ? ' It reported: ' + detail.slice(0, 1200) : '')
        + (tail ? ' Output: ' + tail : '') } };
  }
  if (!state.sessionStarted) return { state: 'failed', error: { code: 'claude-init-missing',
    message: 'Claude exited without system/init. Its session and callback server could not be verified.' } };
  const initError = claudeInitError(state);
  if (initError) return { state: 'failed', error: initError };
  return { state: 'ended' };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Spawn the detached, windowless worker that outlives this call. */
function startDetachedWorker(directory) {
  const worker = fileURLToPath(new URL('./claude-cli-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [worker, '--turn', directory], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { pid: child.pid };
}

/**
 * Start one headless turn in its own private directory.
 * The call returns as soon as the detached worker owns the request; it never waits for the
 * model. A second call for the same directory and the same request is idempotent and never
 * starts a second CLI process, which is what stops a re-read from double-dispatching. A
 * directory whose claim exists but whose worker could not start is recorded failed here, so
 * it never looks busy forever.
 * @param {object} input directory, cli, workspace, sessionId, resume, message, model, effort, mcpConfig, name.
 * @param {object} [deps] Test seam: spawnWorker.
 * @returns {Promise<object>} {accepted, duplicate, state, directory, requestId, sessionId, workerPid?, startedAt}
 */
export async function startClaudeTurn(input = {}, deps = {}) {
  const { directory, cli, workspace, sessionId, resume = false, message, model, effort, mcpConfig, name } = input;
  if (typeof directory !== 'string' || !directory.trim() || !path.isAbsolute(directory)) {
    throw fail('invalid-directory', 'directory must be an absolute per-request path; the caller owns one private directory per request.');
  }
  if (typeof workspace !== 'string' || !workspace.trim() || !path.isAbsolute(workspace)) {
    throw fail('invalid-workspace', 'workspace must be an absolute path: it is the working directory of the turn.');
  }
  if (!isUuid(sessionId)) throw fail('invalid-session-id', 'sessionId must be the UUID the shared layer assigned to this managed Claude session.');
  if (typeof message !== 'string' || !message.trim()) throw fail('invalid-message', 'A non-empty message is required for a Claude turn.');
  const effortValue = effort === undefined || effort === null || effort === '' ? undefined : String(effort);
  if (effortValue !== undefined && !CLAUDE_EFFORTS.includes(effortValue)) {
    throw fail('invalid-effort', `effort must be one of ${CLAUDE_EFFORTS.join(' / ')}; received ${JSON.stringify(effort)}.`);
  }
  const modelValue = model === undefined || model === null || model === '' ? undefined : String(model);
  const nameValue = name === undefined || name === null || name === '' ? undefined : String(name);
  const command = cliCommand(cli);
  const serverName = mcpConfig === undefined || mcpConfig === null ? undefined : mcpServerFromConfig(mcpConfig);

  const requestId = createHash('sha256').update(JSON.stringify([directory, workspace, sessionId, message])).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify({
    workspace, sessionId, resume: resume === true, message, model: modelValue ?? null,
    effort: effortValue ?? null, name: nameValue ?? null, command,
    mcp: mcpConfig === undefined || mcpConfig === null ? null : createHash('sha256').update(JSON.stringify(mcpConfig)).digest('hex'),
  })).digest('hex');

  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const ownerFile = path.join(directory, CLAUDE_TURN_FILES.owner);
  let claimed = true;
  try {
    await writeFile(ownerFile, JSON.stringify({ version: 1, requestId, fingerprint, workspace, sessionId, createdAt: startedAt }, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    claimed = false;
  }
  if (!claimed) {
    const owner = await readJson(ownerFile);
    if (owner?.fingerprint !== fingerprint) {
      throw fail('claude-request-conflict', 'This directory already belongs to a different request; give each request its own private directory.');
    }
    // Another dispatcher claimed this directory a moment ago. Wait for its record instead of
    // starting a second CLI process: that wait is what makes a re-read idempotent.
    let current = await readClaudeTurn(directory, deps).catch(() => undefined);
    for (let attempt = 0; !current && attempt < 100; attempt++) {
      await delay(20);
      current = await readClaudeTurn(directory, deps).catch(() => undefined);
    }
    if (!current) {
      throw fail('claude-turn-not-ready', 'This directory was claimed by another dispatcher that has not recorded its turn yet; read it again shortly.');
    }
    return { accepted: current.state === 'running', duplicate: true, state: current.state, directory, requestId, sessionId,
      workerPid: current.workerPid ?? null, startedAt: current.startedAt ?? startedAt,
      ...(current.state === 'running' ? {} : { note: 'This request already ran in this directory; nothing was dispatched again.' }) };
  }

  const mcpFile = serverName === undefined ? undefined : path.join(directory, CLAUDE_TURN_FILES.mcp);
  const state = createClaudeTurnState({ requestId, sessionId, workspace, message, mcpRequired: serverName });
  let turn;
  try {
    if (mcpFile) await writeFile(mcpFile, JSON.stringify(mcpConfig, null, 2) + '\n', { encoding: 'utf8' });
    await writeFile(path.join(directory, CLAUDE_TURN_FILES.prompt), message, { encoding: 'utf8' });
    turn = {
      version: 1, requestId, sessionId, resume: resume === true, workspace, name: nameValue ?? null,
      command: command.command, prefixArgs: command.prefixArgs,
      args: claudeTurnArguments({
        sessionId, resume: resume === true, model: modelValue, effort: effortValue,
        systemPrompt: claudeSystemPrompt({ serverName, name: nameValue }),
        mcpFile, allowedTools: mcpFile ? allowedCallbackTools(serverName) : undefined,
        name: nameValue,
      }),
      mcpServer: serverName ?? null, startedAt, workerPid: null,
      files: { prompt: CLAUDE_TURN_FILES.prompt, mcp: mcpFile ? CLAUDE_TURN_FILES.mcp : null,
        stdout: CLAUDE_TURN_FILES.stdout, stderr: CLAUDE_TURN_FILES.stderr },
    };
    await writeJsonFile(directory, CLAUDE_TURN_FILES.turn, turn);
    await writeJsonFile(directory, CLAUDE_TURN_FILES.state, state);
  } catch (error) {
    // The claim exists but the request was never written: record that instead of leaving a
    // directory that looks busy for a turn that does not exist.
    Object.assign(state, { state: 'failed', phase: 'exited', endedAt: new Date().toISOString(),
      error: { code: 'claude-turn-not-prepared',
        message: 'The request files could not be written, so this turn never began: ' + String(error?.message ?? error).slice(0, 400) } });
    await writeJsonFile(directory, CLAUDE_TURN_FILES.state, state).catch(() => undefined);
    throw fail('claude-turn-not-prepared', state.error.message);
  }

  let worker;
  try {
    worker = await (deps.spawnWorker ?? startDetachedWorker)(directory);
  } catch (error) {
    // The request is claimed but nothing runs it. Record that instead of leaving a turn that
    // looks busy until its heartbeat goes stale.
    Object.assign(state, { state: 'failed', phase: 'exited', endedAt: new Date().toISOString(),
      error: { code: 'claude-cli-spawn-failed',
        message: 'The detached Claude worker could not be started, so this turn never began: '
          + String(error?.message ?? error).slice(0, 400) } });
    await writeJsonFile(directory, CLAUDE_TURN_FILES.state, state);
    throw fail('claude-cli-spawn-failed', state.error.message);
  }
  // The worker writes its own pid the moment it starts, so any pid already in the record is the
  // live process that owns this turn and outranks the one this call spawned. Writing the record
  // back this way keeps a claim the caller never got to write, and merges instead of replacing.
  const claimedTurn = await readJson(path.join(directory, CLAUDE_TURN_FILES.turn));
  const workerPid = recordedWorkerPid(claimedTurn, undefined)
    ?? (Number.isSafeInteger(worker?.pid) ? worker.pid : null);
  turn.workerPid = workerPid;
  await writeJsonFile(directory, CLAUDE_TURN_FILES.turn, { ...(claimedTurn ?? {}), ...turn, workerPid });
  return { accepted: true, duplicate: false, state: 'running', directory, requestId, sessionId,
    workerPid, startedAt, mcpServer: serverName ?? null };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read one turn. Read-only: it never dispatches and never writes.
 * A worker that died without finalizing is reported failed (or cancelled) instead of
 * looking alive forever, so a caller polling this can always reach a terminal state.
 * `model` is only ever what the CLI's init event reported; it is never an echo of what
 * the caller asked for.
 * @param {string} directory The request's private directory.
 * @param {object} [deps] Test seam: isAlive.
 * @returns {Promise<object>} {state, model, messages, error?, sessionStarted, ...}
 */
export async function readClaudeTurn(directory, { isAlive = processAlive } = {}) {
  const state = await readJson(path.join(directory, CLAUDE_TURN_FILES.state));
  const turn = await readJson(path.join(directory, CLAUDE_TURN_FILES.turn));
  if (!state) {
    if (!turn) throw fail('claude-turn-not-found', `No Claude turn is recorded in ${directory}.`);
    const alive = Number.isSafeInteger(turn.workerPid) && isAlive(turn.workerPid);
    return {
      directory, state: alive ? 'running' : 'failed', requestId: turn.requestId ?? null,
      sessionId: turn.sessionId ?? null, cliSessionId: null, model: null, messages: [], sessionStarted: false,
      ...(alive ? {} : { error: { code: 'claude-turn-worker-lost',
        message: 'The detached Claude worker is gone and never wrote a state file. Nothing can be recovered from this turn.' } }),
      workerPid: turn.workerPid ?? null, startedAt: turn.startedAt ?? null, endedAt: null,
    };
  }
  const marker = await readJson(path.join(directory, CLAUDE_TURN_FILES.cancel));
  const workerPid = recordedWorkerPid(turn, state);
  const claudePid = Number.isSafeInteger(state.pid) && state.pid > 0 ? state.pid : null;
  const owned = [...new Set([workerPid, claudePid].filter(pid => pid !== null))];
  const live = new Map(owned.map(pid => [pid, isAlive(pid)]));
  const alivePids = owned.filter(pid => live.get(pid));
  let reported = state.state === undefined ? 'running' : state.state;
  let error = state.error ?? undefined;
  let orphaned;
  if (!TERMINAL_STATES.includes(reported)) {
    const heartbeat = Date.parse(state.heartbeatAt ?? state.updatedAt ?? state.startedAt ?? '');
    const fresh = Number.isFinite(heartbeat) && Date.now() - heartbeat <= LOST_HEARTBEAT_MS;
    const workerAlive = workerPid !== null && live.get(workerPid) === true;
    if (marker?.stopped === true && !alivePids.length) {
      // Only a cancel that was confirmed against the whole tree makes a dead worker's turn
      // read as cancelled.
      reported = 'cancelled'; error = undefined;
    } else if (alivePids.length) {
      // Something this record owns is still running, so the turn is not settled, whatever
      // happened to the worker. Reporting a terminal state here is what loses ownership of a
      // live CLI tree and lets cancel and delete claim a stop that never happened.
      if (!workerAlive) {
        orphaned = { code: 'claude-turn-worker-lost',
          message: 'The detached Claude worker is gone, but the CLI process tree it started is still running, so this turn is not settled. Cancel it to stop that whole tree.' };
      }
    } else if (owned.length) {
      // Every process this turn recorded is gone: the worker died mid-turn.
      reported = 'failed';
      error = { code: 'claude-turn-worker-lost',
        message: 'The detached Claude worker exited without recording a final state, and no process it started is still running. The turn did not finish and nothing was resent.' };
    } else if (!fresh) {
      // No process was ever recorded and nothing is beating: the worker never got that far.
      reported = 'failed';
      error = { code: 'claude-turn-worker-lost',
        message: 'The detached Claude worker stopped updating this turn for longer than the heartbeat window, so it is treated as gone.' };
    }
  }
  return {
    directory,
    state: reported,
    requestId: state.requestId ?? null,
    sessionId: state.sessionId ?? null,
    cliSessionId: state.cliSessionId ?? null,
    model: state.model ?? null,
    messages: state.messages ?? [],
    ...(error ? { error } : {}),
    sessionStarted: state.sessionStarted === true,
    warnings: [...(state.warnings ?? []), ...(orphaned ? [orphaned] : [])],
    mcp: state.mcp ?? { required: null, servers: [], errors: [] },
    denials: state.denials ?? [],
    permissionMode: state.permissionMode ?? null,
    turns: state.turns ?? null,
    costUsd: state.costUsd ?? null,
    durationMs: state.durationMs ?? null,
    resultText: state.resultText ?? null,
    phase: state.phase ?? null,
    startedAt: state.startedAt ?? null,
    endedAt: state.endedAt ?? null,
    exitCode: state.exitCode ?? null,
    messagesDropped: state.messagesDropped ?? 0,
    workerPid, claudePid: state.pid ?? null,
  };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/** Kill this pid and every process started under it. Shared with the worker, which stops its
 *  own CLI tree when system/init proves the turn cannot run as asked. */
export async function stopClaudeTree(pid) {
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); return { ok: true }; }
    catch (error) { return { ok: error.code === 'ESRCH', code: error.code }; }
  }
  const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const code = await new Promise(resolve => {
    child.once('exit', value => resolve(value ?? null));
    child.once('error', () => resolve(-1));
  });
  return { ok: code === 0, code };
}

/** Identity reads are only on the cancel path and never on a poll, so they may take a moment. */
const IDENTITY_TIMEOUT_MS = 20000;

/**
 * Identity of each pid that is still there, read one by one: `{ text, ok }`, where `ok` says the
 * identity request itself could be answered and `text` is the command line (null when the
 * process is already gone). Node has no pid→command-line read on Windows, and CIM is where this
 * project already reads process identity; every pid is answered by one call because the whole
 * decision needs them together.
 */
async function readCommandLines(pids) {
  const lines = new Map();
  const ids = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  if (!ids.length) return lines;
  if (process.platform !== 'win32') {
    for (const pid of ids) {
      try { lines.set(pid, { text: (await readFile('/proc/' + pid + '/cmdline', 'utf8')).split('\0').join(' '), ok: true }); }
      catch (error) { lines.set(pid, { text: null, ok: error.code === 'ENOENT' }); }
    }
    return lines;
  }
  const script = [
    // A command line can hold a path outside the console code page (any non-ASCII request
    // directory), so this one child is told to write UTF-8, which is what Node decodes here.
    // If that cannot be set up the whole read has to fail instead of quietly returning text in
    // another encoding: a badly decoded command line would look like a stranger's process.
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$ErrorActionPreference = "SilentlyContinue"',
    ...ids.map(pid =>
      `$process = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($process) { "${pid}" + [char]9 + $process.CommandLine }`),
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: IDENTITY_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    for (const pid of ids) lines.set(pid, { text: null, ok: true });
    for (const line of String(stdout ?? '').split(/\r?\n/)) {
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      const pid = Number.parseInt(line.slice(0, tab), 10);
      if (Number.isSafeInteger(pid) && lines.has(pid)) lines.set(pid, { text: line.slice(tab + 1).trim(), ok: true });
    }
  } catch {
    // An answer that never came proves nothing, so every pid stays unknown rather than trusted.
    for (const pid of ids) lines.set(pid, { text: null, ok: false });
  }
  return lines;
}

/**
 * Does this process still name the request that recorded its pid? The worker is started with
 * `--turn <directory>` and the CLI with this session's id, so a process that answers to neither
 * is some other program that inherited the number.
 */
function ownsRequest(commandLine, { directory, sessionId }) {
  const text = String(commandLine ?? '').toLowerCase();
  if (!text) return false;
  return [directory, sessionId]
    .filter(marker => typeof marker === 'string' && marker.length > 8)
    .some(marker => text.includes(marker.toLowerCase()));
}

async function markCancelled(directory, state) {
  const time = new Date().toISOString();
  await writeJsonFile(directory, CLAUDE_TURN_FILES.state, {
    ...state, state: 'cancelled', phase: 'exited', updatedAt: time, heartbeatAt: time,
    endedAt: state.endedAt ?? time, error: null,
  });
}

/**
 * Stop one turn's whole process tree and confirm it is gone.
 * The CLI is started by the worker, so killing either root (taskkill /T) takes both.
 * A turn is only ever recorded cancelled when every process it owns is confirmed gone; while
 * anything survives, the turn keeps running and the call can simply be repeated. A turn that
 * already reached a terminal state is never killed again, and a pid is only ever killed after
 * its own process is shown to still name this request: the same number may belong to another
 * program by now, and that one is neither killed nor mistaken for a running turn.
 * @param {string} directory The request's private directory.
 * @param {object} [deps] Test seams: isAlive, killTree, commandLines (pid → {text, ok}).
 * @returns {Promise<{cancelled: boolean, stopped: boolean, state: string, pids: object, remaining: number[], note?: string}>}
 */
export async function cancelClaudeTurn(directory, { isAlive = processAlive, killTree = stopClaudeTree,
  commandLines = readCommandLines } = {}) {
  const state = await readJson(path.join(directory, CLAUDE_TURN_FILES.state));
  const turn = await readJson(path.join(directory, CLAUDE_TURN_FILES.turn));
  const pids = { worker: recordedWorkerPid(turn, state),
    claude: Number.isSafeInteger(state?.pid) && state.pid > 0 ? state.pid : null };
  if (!state && !turn) {
    return { cancelled: false, stopped: true, state: null, pids, remaining: [],
      note: 'No Claude turn is recorded in this directory, so there is nothing to stop.' };
  }
  const recorded = [...new Set([pids.worker, pids.claude].filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  const alive = () => recorded.filter(pid => isAlive(pid));
  const requestedAt = new Date().toISOString();
  const requestId = state?.requestId ?? turn?.requestId ?? null;

  if (TERMINAL_STATES.includes(state?.state)) {
    const surviving = alive();
    if (surviving.length) {
      return { cancelled: false, stopped: false, state: state.state, pids, remaining: surviving,
        note: 'This turn already reached a terminal state; its recorded processes are alive but are never killed by pid again. Retry with a fresh request.' };
    }
    return { cancelled: state.state === 'cancelled', stopped: true, state: state.state, pids, remaining: [],
      ...(state.state === 'cancelled' ? {} : { note: 'This turn already ended; nothing was killed.' }) };
  }

  if (!recorded.length) {
    // The claim exists but the worker never recorded a pid: it may be starting right now.
    return { cancelled: false, stopped: false, state: 'running', pids, remaining: [],
      note: 'The worker has not recorded any process yet, so nothing can be confirmed stopped. Retry cancel shortly.' };
  }

  await writeJsonFile(directory, CLAUDE_TURN_FILES.cancel, { requestId, requestedAt, stopped: null, pids });
  const targets = alive();
  if (!targets.length) {
    // Every recorded process is already gone: the tree is stopped, whether or not the
    // worker got to write its own final state.
    const latest = await readJson(path.join(directory, CLAUDE_TURN_FILES.state));
    const current = TERMINAL_STATES.includes(latest?.state) ? latest.state : 'cancelled';
    if (!TERMINAL_STATES.includes(latest?.state)) await markCancelled(directory, latest ?? state);
    await writeJsonFile(directory, CLAUDE_TURN_FILES.cancel, { requestId, requestedAt, stopped: true, remaining: [], pids });
    return { cancelled: current === 'cancelled', stopped: true, state: current, pids, remaining: [] };
  }

  // Every recorded pid is judged on its own, and only a pid that still names this request is
  // killed. A pid whose process answers to something else has been reused, so it is left alone
  // and counts as "the original process has left"; a pid whose identity cannot be read yet
  // proves nothing and is neither killed nor counted as stopped.
  const lines = await commandLines(targets);
  const markers = { directory, sessionId: state?.sessionId ?? turn?.sessionId ?? null };
  const ours = [];
  const reused = [];
  const unknown = [];
  for (const pid of targets) {
    const identity = lines?.get?.(pid) ?? { text: null, ok: false };
    if (!identity.ok) { unknown.push(pid); continue; }
    if (!identity.text) continue;                                    // gone while it was read
    if (ownsRequest(identity.text, markers)) ours.push(pid);
    else reused.push(pid);                                           // another program holds this pid now
  }
  if (!ours.length && !reused.length) {
    // Nothing could be proven either way, so nothing is killed and nothing is recorded as
    // stopped: the turn stays open instead of reporting a stop that never happened.
    await writeJsonFile(directory, CLAUDE_TURN_FILES.cancel,
      { requestId, requestedAt, stopped: false, remaining: targets, pids, unknown });
    return { cancelled: false, stopped: false, state: 'running', pids, remaining: targets,
      note: 'The identity of the recorded processes (' + targets.join(', ') + ') could not be read, so nothing was killed and nothing is confirmed stopped. The turn stays running.' };
  }

  for (const pid of ours) await killTree(pid);
  // A reused pid is another program and never blocks a stop; anything else still running does.
  const blocking = () => recorded.filter(pid => isAlive(pid) && !reused.includes(pid));
  const deadline = Date.now() + CANCEL_CONFIRM_MS;
  let remaining = blocking();
  while (remaining.length && Date.now() < deadline) {
    await delay(100);
    remaining = blocking();
  }
  if (remaining.length) {
    // Nothing is recorded as cancelled while a process still runs; the marker says the
    // attempt failed so a retry is the obvious next step.
    await writeJsonFile(directory, CLAUDE_TURN_FILES.cancel, { requestId, requestedAt, stopped: false,
      remaining, pids, ...(reused.length ? { reused } : {}), ...(unknown.length ? { unknown } : {}) });
    return { cancelled: false, stopped: false, state: 'running', pids, remaining,
      note: 'Still running and not confirmed stopped: ' + remaining.join(', ')
        + (unknown.some(pid => remaining.includes(pid)) ? ' (its identity could not be read yet, so it was not killed)' : '')
        + '. The turn stays running and cancel can be retried.' };
  }
  const latest = await readJson(path.join(directory, CLAUDE_TURN_FILES.state));
  const reusedNote = reused.length
    ? { note: 'Left alone because these pids now belong to other processes, so the original processes had already left: '
      + reused.join(', ') + '.' }
    : {};
  if (TERMINAL_STATES.includes(latest?.state)) {
    await writeJsonFile(directory, CLAUDE_TURN_FILES.cancel, { requestId, requestedAt, stopped: true, remaining: [], pids });
    return { cancelled: latest.state === 'cancelled', stopped: true, state: latest.state, pids, remaining: [], ...reusedNote };
  }
  await writeJsonFile(directory, CLAUDE_TURN_FILES.cancel, { requestId, requestedAt, stopped: true, remaining: [], pids });
  await markCancelled(directory, latest ?? state);
  return { cancelled: true, stopped: true, state: 'cancelled', pids, remaining: [], ...reusedNote };
}
