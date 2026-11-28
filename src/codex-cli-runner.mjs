// Headless Codex CLI (`codex exec --json`) runner utilities for FutureAide Control.
//
// Runs one detached worker per turn inside the agent's private request directory,
// following the same durable snapshot, heartbeat, fail-closed proxy enforcement, and
// Windows CIM process-tree cancellation architecture as claude-cli-runner.mjs.
//
// Network & profile boundary:
//   Every probe and turn resolves its active route via `resolveCliRoute({ target: 'codex-cli' })`:
//     1. Explicit manual port/proxy override in config.json / env
//     2. Active FAswitch profile & managed proxy port (with profile_id consistency check)
//     3. Inherit environment when FAswitch is not installed
//   Whenever a proxy is selected, TCP reachability is verified fail-closed BEFORE spawning
//   codex.exe, and `buildCliProxyEnv()` injects clean proxy vars + loopback NO_PROXY.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildCliProxyEnv, resolveCliRoute } from './cli-proxy.mjs';
import { managedCliEnv } from './managed-cli-policy.mjs';
import { killProcessCage } from './process-cage.mjs';
import { replaceStateFile } from './replace-state-file.mjs';

const execFileAsync = promisify(execFile);

export const CODEX_CLI_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const DEFAULT_CODEX_CALLBACK_SERVER = 'futureaide_report';
export const DEFAULT_TURN_TIMEOUT_MS = 25 * 60 * 1000;
export const MAX_MESSAGE_TEXT = 8000;
export const MAX_LAST_STEP_CHARS = 50;
export const MAX_STORED_MESSAGES = 400;
export const WORKER_HEARTBEAT_MS = 2000;
export const LOST_HEARTBEAT_MS = 120000;
export const CANCEL_CONFIRM_MS = 10000;
export const PROBE_TIMEOUT_MS = 20000;
const IDENTITY_TIMEOUT_MS = 20000;

export const CODEX_TURN_FILES = Object.freeze({
  owner: 'owner.json',
  turn: 'turn.json',
  prompt: 'prompt.txt',
  stdout: 'stdout.stream.jsonl',
  stderr: 'stderr.log',
  workerStderr: 'worker.stderr.log',
  state: 'state.json',
  terminal: 'terminal.json',
  cancel: 'cancel.json',
});

export const CODEX_WORKER_ERROR_PREFIX = 'codex-cli-worker: ';
export const TERMINAL_STATES = Object.freeze(['ended', 'completed', 'failed', 'cancelled']);

const fail = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });

async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
}

async function isRegularFile(candidate) {
  try { return (await lstat(candidate)).isFile(); }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false; throw error; }
}

export function isCodexStateFileBusy(error) {
  return process.platform === 'win32' && error?.syscall === 'rename'
    && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);
}

export async function writeJsonFile(directory, name, value, { retryMs = 0, mode } = {}) {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  const temporary = target + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {
      encoding: 'utf8',
      ...(mode !== undefined ? { mode } : {}),
    });
    const deadline = performance.now() + retryMs;
    for (;;) {
      try { return await replaceStateFile(temporary, target); }
      catch (error) {
        const remaining = deadline - performance.now();
        if (!isCodexStateFileBusy(error) || remaining <= 0) throw error;
        await delay(Math.min(100, remaining));
      }
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function recordedWorkerPid(turn, state) {
  for (const value of [turn?.workerPid, state?.workerPid]) {
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}

export function normalizeCliSpec(cli) {
  if (typeof cli === 'string' && cli.trim()) {
    const trimmed = cli.trim();
    if (/\.(mjs|cjs|js)$/i.test(trimmed)) return { command: process.execPath, prefixArgs: [trimmed] };
    return { command: trimmed, prefixArgs: [] };
  }
  if (cli && typeof cli === 'object' && typeof cli.command === 'string' && cli.command.trim()) {
    const prefixArgs = Array.isArray(cli.prefixArgs) ? cli.prefixArgs.map(String) : [];
    return { command: cli.command.trim(), prefixArgs };
  }
  return undefined;
}

export function resolveTurnTimeoutMs({ timeoutMs, timeoutMinutes, config } = {}) {
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) return Math.max(1, Math.round(timeoutMs));
  if (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0) return Math.max(1, Math.round(timeoutMinutes * 60 * 1000));
  if (Number.isFinite(config?.turnTimeoutMs) && config.turnTimeoutMs > 0) {
    return Math.max(1, Math.round(config.turnTimeoutMs));
  }
  if (Number.isFinite(config?.turnTimeoutMinutes) && config.turnTimeoutMinutes > 0) {
    return Math.max(1, Math.round(config.turnTimeoutMinutes * 60 * 1000));
  }
  return DEFAULT_TURN_TIMEOUT_MS;
}

function toNonNegInt(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : fallback;
}

export function normalizeCodexUsage(raw, prev = null, { startedAt, durationMs: explicitDurationMs, durationSec: explicitDurationSec, nowMs = Date.now() } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const inputTokens = toNonNegInt(
    src.input_tokens ?? src.inputTokens ?? src.prompt_tokens,
    prev?.inputTokens ?? 0,
  );
  const outputTokens = toNonNegInt(
    src.output_tokens ?? src.outputTokens ?? src.completion_tokens,
    prev?.outputTokens ?? 0,
  );
  const cachedTokens = toNonNegInt(
    src.cached_input_tokens ?? src.cache_read_tokens ?? src.cache_read_input_tokens ?? src.cachedTokens,
    prev?.cachedTokens ?? 0,
  );
  const rawTotal = src.total_tokens ?? src.totalTokens;
  const cachedIsSubset = src.cached_input_tokens !== undefined
    && src.cache_read_tokens === undefined
    && src.cache_read_input_tokens === undefined;
  const totalTokens = Number.isFinite(Number(rawTotal)) && Number(rawTotal) >= 0
    ? Math.round(Number(rawTotal))
    : (cachedIsSubset ? Math.max(inputTokens, cachedTokens) + outputTokens : inputTokens + outputTokens + cachedTokens);

  let durationSec = prev?.durationSec ?? 0;
  const rawSec = explicitDurationSec ?? src.duration_seconds ?? src.durationSec;
  const rawMs = explicitDurationMs ?? src.duration_ms ?? src.durationMs;
  if (Number.isFinite(Number(rawSec)) && Number(rawSec) >= 0) {
    durationSec = Math.round(Number(rawSec) * 100) / 100;
  } else if (Number.isFinite(Number(rawMs)) && Number(rawMs) >= 0) {
    durationSec = Math.round((Number(rawMs) / 1000) * 100) / 100;
  } else if (typeof startedAt === 'string' && startedAt) {
    const parsedStart = Date.parse(startedAt);
    if (Number.isFinite(parsedStart)) {
      durationSec = Math.max(0, Math.round(((nowMs - parsedStart) / 1000) * 100) / 100);
    }
  }
  return { inputTokens, outputTokens, cachedTokens, totalTokens, durationSec };
}

// ---------------------------------------------------------------------------
// Discovery, auth & model catalog
// ---------------------------------------------------------------------------

/**
 * Locate codex.exe in strict precedence order:
 *   1. explicitPath / explicit
 *   2. env.CODEX_CLI
 *   3. PATH (codex.exe / codex)
 *   4. Newest `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` (shipped with Codex Desktop)
 */
export async function findCodexCli({
  explicitPath,
  explicit,
  env = process.env,
  isFile = isRegularFile,
  list = readdir,
  stat = lstat,
} = {}) {
  const direct = typeof explicitPath === 'string' && explicitPath.trim()
    ? explicitPath.trim()
    : (typeof explicit === 'string' && explicit.trim() ? explicit.trim() : '');
  if (direct) return direct;

  const envCli = typeof env?.CODEX_CLI === 'string' ? env.CODEX_CLI.trim() : '';
  if (envCli) return envCli;

  const rawPath = env?.PATH || env?.Path || '';
  const names = process.platform === 'win32' ? ['codex.exe', 'codex'] : ['codex'];
  for (const dir of String(rawPath).split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isFile(candidate)) return candidate;
    }
  }

  const localAppData = env?.LOCALAPPDATA || env?.LocalAppData
    || (env === process.env && process.platform === 'win32' ? path.join(homedir(), 'AppData', 'Local') : '');
  if (localAppData) {
    const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
    let subdirs = [];
    try { subdirs = await list(binRoot); } catch { subdirs = []; }
    const candidates = [];
    for (const sub of subdirs) {
      const candidate = path.join(binRoot, sub, process.platform === 'win32' ? 'codex.exe' : 'codex');
      try {
        const info = await stat(candidate);
        if (info.isFile()) candidates.push({ path: candidate, mtimeMs: info.mtimeMs ?? 0 });
      } catch { /* ignore */ }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (candidates[0]) return candidates[0].path;
  }
  return undefined;
}

export function resolveCodexHome({ route, env = process.env } = {}) {
  if (typeof route?.codexHome === 'string' && route.codexHome.trim()) return route.codexHome.trim();
  if (typeof env?.CODEX_HOME === 'string' && env.CODEX_HOME.trim()) return env.CODEX_HOME.trim();
  return path.join(homedir(), '.codex');
}

function parseTopLevelTomlString(content, key) {
  let inSection = false;
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { inSection = true; continue; }
    if (inSection) continue;
    const match = line.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`));
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Read available Codex models and default selection from `$CODEX_HOME/models_cache.json`
 * and `$CODEX_HOME/config.toml` with zero model turns and zero subprocess overhead.
 */
export async function readCodexCliModels({ codexHome, read = readFile } = {}) {
  const home = codexHome || path.join(homedir(), '.codex');
  let defaultModel = null;
  let defaultEffort = null;
  try {
    const toml = await read(path.join(home, 'config.toml'), 'utf8');
    defaultModel = parseTopLevelTomlString(toml, 'model');
    defaultEffort = parseTopLevelTomlString(toml, 'model_reasoning_effort');
  } catch { /* config.toml optional */ }

  let cache;
  try { cache = JSON.parse(await read(path.join(home, 'models_cache.json'), 'utf8')); }
  catch { cache = null; }

  const rawModels = Array.isArray(cache?.models) ? cache.models : [];
  const visible = rawModels.filter(item => item && typeof item.slug === 'string'
    && (item.visibility === undefined || item.visibility === 'list' || item.slug === defaultModel));

  const models = visible.map(item => {
    const efforts = Array.isArray(item.supported_reasoning_levels) && item.supported_reasoning_levels.length
      ? item.supported_reasoning_levels
        .map(level => (typeof level === 'string' ? level : level?.effort))
        .filter(Boolean)
        .map(id => ({ id }))
      : CODEX_CLI_EFFORTS.map(id => ({ id }));
    return {
      id: item.slug,
      name: item.display_name || item.slug,
      reasoning: {
        efforts,
        ...(typeof item.default_reasoning_level === 'string' ? { defaultEffort: item.default_reasoning_level } : {}),
      },
    };
  });

  if (defaultModel && !models.some(model => model.id === defaultModel)) {
    models.unshift({
      id: defaultModel,
      name: defaultModel,
      reasoning: { efforts: CODEX_CLI_EFFORTS.map(id => ({ id })) },
    });
  }

  return {
    groups: [{ id: 'openai', models }],
    ...(defaultModel ? {
      default: {
        provider: 'openai',
        model: defaultModel,
        ...(defaultEffort ? { reasoningEffort: defaultEffort } : {}),
      },
    } : {}),
    note: 'Models loaded from local Codex CLI catalog ($CODEX_HOME/models_cache.json).',
  };
}

async function runCliCommand(cliSpec, args, { env, exec = execFileAsync, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const { stdout, stderr } = await exec(cliSpec.command, [...cliSpec.prefixArgs, ...args], {
      encoding: 'utf8',
      env,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
    });
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
 * Probe Codex CLI readiness:
 *   1. Resolve and verify network route (manual bind or FAswitch active profile) FAIL-CLOSED.
 *   2. Discover codex.exe binary.
 *   3. Check `codex --version` and `codex login status` with clean proxy env.
 */
export async function probeCodexCli({
  cliPath,
  cli,
  config = {},
  env = process.env,
  findCli = findCodexCli,
  resolveRoute = resolveCliRoute,
  exec = execFileAsync,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const route = await resolveRoute({ target: 'codex-cli', client: 'codex', config, env });
  if (!route.ok) {
    return {
      ok: false,
      code: route.code || 'proxy-unavailable',
      error: route.error || 'Codex CLI proxy route is unavailable.',
      route,
      cli: null,
      version: null,
    };
  }

  let spec = normalizeCliSpec(cli ?? cliPath);
  if (!spec) {
    const found = await findCli({ explicitPath: typeof cliPath === 'string' ? cliPath : undefined, env });
    spec = normalizeCliSpec(found);
  }
  if (!spec) {
    return {
      ok: false,
      code: 'codex-cli-not-found',
      error: 'The Codex CLI (codex.exe) was not found.',
      route,
      cli: null,
      version: null,
    };
  }

  const childEnv = buildCliProxyEnv(env, route);
  const ver = await runCliCommand(spec, ['--version'], { env: childEnv, exec, timeoutMs });
  if (ver.code !== 0 || !ver.stdout.trim()) {
    return {
      ok: false,
      code: 'codex-cli-probe-failed',
      error: `codex --version failed (code ${ver.code}): ${(ver.stderr || ver.stdout || 'no output').trim().slice(0, 400)}`,
      route,
      cli: spec.command,
      version: null,
    };
  }
  const version = ver.stdout.trim().split(/\r?\n/).find(line => line.trim())?.trim() ?? null;

  const auth = await runCliCommand(spec, ['login', 'status'], { env: childEnv, exec, timeoutMs });
  const authText = `${auth.stdout}\n${auth.stderr}`.trim();
  if (auth.code !== 0 || /not\s+logged\s+in/i.test(authText)) {
    return {
      ok: false,
      code: 'codex-cli-auth-required',
      error: `Codex CLI is not signed in (${authText.slice(0, 300) || 'run codex login'}).`,
      route,
      cli: spec.command,
      version,
    };
  }

  return {
    ok: true,
    code: 'ok',
    cli: spec.command,
    spec,
    version,
    auth: { loggedIn: true, detail: authText.split(/\r?\n/)[0]?.trim() ?? 'Logged in' },
    route,
  };
}

// ---------------------------------------------------------------------------
// Prompt, callback MCP config & argv construction
// ---------------------------------------------------------------------------

/** Encode a TOML string literal safely (handles Windows backslashes and quotes). */
export function tomlString(value) {
  return JSON.stringify(String(value ?? ''));
}

/** Build concise callback instructions prepended to the first managed turn. */
export function codexCallbackPrompt({ serverName = DEFAULT_CODEX_CALLBACK_SERVER, name, message, isResume = false } = {}) {
  if (isResume) return String(message ?? '');
  const server = String(serverName || DEFAULT_CODEX_CALLBACK_SERVER);
  const header = [
    `[FutureAide Managed Codex CLI Helper${name ? ` — ${name}` : ''}]`,
    'Another agent assigned this task and is waiting for your explicit MCP callback.',
    `- If you need a decision from your parent, call ask_parent (MCP server ${server}) and stop.`,
    `- When you finish, deliver your final result by calling report_parent(message, final=true) (MCP server ${server}).`,
    `- Record plugin problems or friction with feedback (MCP server ${server}); this does not notify your parent.`,
    '- Ordinary text replies do not reach your parent; only ask_parent and report_parent do.',
  ].join('\n');
  return `${header}\n\n${String(message ?? '')}`;
}

/**
 * Build argv for `codex exec` (fresh turn) or `codex exec resume` (subsequent turns).
 * Prompt is passed on stdin (`-`), avoiding Windows 8191-char command line limits.
 * Turn-scoped callback MCP server is injected via `-c mcp_servers.<server>...` with
 * zero edits to `~/.codex/config.toml` or workspace files.
 */
export function buildCodexCliArgs({
  workspace,
  threadId,
  resume = false,
  model,
  effort,
  reportConfig,
  readOnly = false,
  turnDir,
} = {}) {
  const args = ['exec'];
  if (resume && threadId) {
    args.push('resume');
  }
  args.push('--json', '--skip-git-repo-check');
  if (readOnly) {
    args.push(...(resume && threadId ? ['-c', 'sandbox_mode="read-only"'] : ['--sandbox', 'read-only']));
  }
  if (!resume && workspace) {
    args.push('--cd', String(workspace));
  }
  if (typeof model === 'string' && model.trim()) {
    args.push('--model', model.trim());
  }
  if (typeof effort === 'string' && effort.trim()) {
    const normalized = effort.trim().toLowerCase();
    args.push('-c', `model_reasoning_effort=${tomlString(normalized)}`);
  }
  if (reportConfig && typeof reportConfig.command === 'string' && reportConfig.command.trim()) {
    const serverName = (typeof reportConfig.serverName === 'string' && reportConfig.serverName.trim())
      || DEFAULT_CODEX_CALLBACK_SERVER;
    if (serverName !== 'futureaide' && reportConfig.disableGlobalFutureaide !== false) {
      args.push('-c', 'mcp_servers.futureaide.enabled=false');
    }
    const prefix = `mcp_servers.${serverName}`;
    args.push('-c', `${prefix}.command=${tomlString(reportConfig.command.trim())}`);
    const serverArgs = Array.isArray(reportConfig.args) ? reportConfig.args.map(String) : [];
    args.push('-c', `${prefix}.args=[${serverArgs.map(tomlString).join(',')}]`);
    args.push('-c', `${prefix}.enabled=true`);
    const mergedServerEnv = {};
    for (const sourceEnv of [reportConfig.callerEnv, reportConfig.env]) {
      if (sourceEnv && typeof sourceEnv === 'object' && !Array.isArray(sourceEnv)) {
        for (const [key, val] of Object.entries(sourceEnv)) {
          if (val !== undefined && val !== null) mergedServerEnv[key] = String(val);
        }
      }
    }
    for (const [key, val] of Object.entries(mergedServerEnv)) {
      const envKey = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : tomlString(key);
      args.push('-c', `${prefix}.env.${envKey}=${tomlString(val)}`);
    }
    if (turnDir) {
      // Carry turnDir in a harmless env key on the callback server so Windows CIM
      // identity checks can always match this codex.exe process to its exact turnDir.
      args.push('-c', `${prefix}.env.FUTUREAIDE_TURN_DIR=${tomlString(turnDir)}`);
    }
  }
  if (resume && threadId) {
    args.push(String(threadId));
  }
  args.push('-');
  return args;
}

// ---------------------------------------------------------------------------
// JSONL event folding
// ---------------------------------------------------------------------------

function bounded(text) {
  const value = String(text ?? '');
  return { text: value.slice(0, MAX_MESSAGE_TEXT), truncated: value.length > MAX_MESSAGE_TEXT };
}

function clipLastStep(value) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length > MAX_LAST_STEP_CHARS
    ? normalized.slice(0, MAX_LAST_STEP_CHARS - 3) + '...'
    : normalized;
}

function pushMessage(state, message) {
  state.messages ??= [];
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

export function createCodexTurnState({
  requestId,
  agentId,
  taskId,
  sessionId,
  threadId,
  workspace,
  message,
  requestedModel,
  requestedEffort,
  route,
} = {}) {
  const time = new Date().toISOString();
  const state = {
    version: 1,
    requestId: requestId ?? null,
    agentId: agentId ?? null,
    taskId: taskId ?? null,
    sessionId: sessionId ?? null,
    threadId: threadId ?? null,
    workspace: workspace ?? null,
    state: 'running',
    phase: 'starting',
    startedAt: time,
    updatedAt: time,
    heartbeatAt: time,
    lastEventAt: time,
    lastStep: null,
    endedAt: null,
    model: null,
    requestedModel: requestedModel ?? null,
    requestedEffort: requestedEffort ?? null,
    actualEffort: null,
    route: route ?? null,
    sessionStarted: false,
    messages: [],
    messagesDropped: 0,
    toolCalls: [],
    warnings: [],
    rawTail: [],
    usage: null,
    turnCompleted: false,
    turnFailed: false,
    failureMessage: null,
    workerPid: null,
    pid: null,
    exitCode: null,
    error: null,
  };
  if (typeof message === 'string' && message) {
    const text = bounded(message);
    pushMessage(state, {
      role: 'user',
      kind: 'dispatch',
      text: text.text,
      ...(text.truncated ? { textTruncated: true } : {}),
    });
  }
  return state;
}

/**
 * Fold one JSONL event from `codex exec --json` into normalized turn state.
 * Unknown or non-JSON lines never throw and are kept in `rawTail`.
 */
export function applyCodexLine(state, line) {
  let value;
  try { value = JSON.parse(line); }
  catch { recordRawLine(state, line); return { kind: 'raw' }; }
  if (!value || typeof value !== 'object' || typeof value.type !== 'string') {
    recordRawLine(state, line);
    return { kind: 'raw' };
  }
  state.updatedAt = new Date().toISOString();
  state.lastEventAt = state.updatedAt;
  const type = value.type;

  if (type === 'thread.started' || type === 'session_configured') {
    state.sessionStarted = true;
    if (state.phase === 'starting') state.phase = 'streaming';
    state.lastStep ??= '会话已启动';
    const tid = value.thread_id ?? value.threadId ?? value.session_id;
    if (typeof tid === 'string' && tid.trim()) state.threadId = tid.trim();
    const model = value.model ?? value.config?.model;
    if (typeof model === 'string' && model.trim()) state.model = model.trim();
    const effort = value.reasoning_effort ?? value.effort ?? value.config?.model_reasoning_effort;
    if (typeof effort === 'string' && effort.trim()) state.actualEffort = effort.trim().toLowerCase();
    return { kind: 'init' };
  }

  if (type === 'turn.started') {
    state.sessionStarted = true;
    if (state.phase === 'starting') state.phase = 'streaming';
    state.lastStep ??= '会话已启动';
    if (typeof value.model === 'string' && value.model.trim()) state.model = value.model.trim();
    if (typeof value.reasoning_effort === 'string' && value.reasoning_effort.trim()) {
      state.actualEffort = value.reasoning_effort.trim().toLowerCase();
    }
    return { kind: 'turn_started' };
  }

  if (type === 'item.completed' || type === 'item.updated' || type === 'item.started') {
    const item = value.item && typeof value.item === 'object' ? value.item : value;
    const itemType = item.type ?? '';
    if (itemType === 'agent_message' || itemType === 'assistant_message') {
      state.lastStep = '输出回复中';
      if (type === 'item.completed') {
        const text = typeof item.text === 'string' ? item.text
          : Array.isArray(item.content) ? item.content.map(c => c?.text ?? '').join('') : '';
        if (text.trim()) {
          const clipped = bounded(text);
          pushMessage(state, {
            role: 'assistant',
            text: clipped.text,
            ...(clipped.truncated ? { textTruncated: true } : {}),
          });
        }
        return { kind: 'assistant' };
      }
      return { kind: 'item' };
    }
    if (itemType === 'reasoning') {
      state.lastStep = '思考推理中';
      return { kind: 'item' };
    }
    if (itemType === 'mcp_tool_call' || itemType === 'command_execution' || itemType === 'file_change') {
      if (itemType === 'command_execution') {
        const cmd = String(item.command ?? '').replace(/\s+/g, ' ').trim();
        state.lastStep = clipLastStep(cmd ? `shell: ${cmd}` : 'shell');
      } else if (itemType === 'mcp_tool_call') {
        state.lastStep = clipLastStep(`mcp: ${item.tool ?? item.name ?? 'mcp'}`);
      } else {
        const firstChange = Array.isArray(item.changes) ? item.changes[0] : undefined;
        const changedPath = firstChange?.path ?? item.path;
        state.lastStep = clipLastStep(changedPath ? `改文件 ${path.basename(String(changedPath))}` : '改文件');
      }
      const toolName = itemType === 'mcp_tool_call'
        ? `${item.server ? `mcp_${item.server}_` : ''}${item.tool ?? 'mcp'}`
        : itemType === 'command_execution'
          ? `shell:${String(item.command ?? '').slice(0, 80)}`
          : 'file_change';
      state.toolCalls ??= [];
      const existing = item.id ? state.toolCalls.find(call => call.id === item.id) : undefined;
      const callStatus = item.status ?? (type === 'item.completed' ? 'completed' : 'in_progress');
      if (!existing) {
        state.toolCalls.push({ ...(item.id ? { id: item.id } : {}), name: toolName, state: String(callStatus) });
        if (state.toolCalls.length > 200) state.toolCalls.splice(0, state.toolCalls.length - 200);
      } else {
        existing.state = String(callStatus);
      }
      if (type === 'item.completed') {
        const summary = itemType === 'command_execution'
          ? (item.aggregated_output || `$ ${item.command ?? ''}`)
          : itemType === 'mcp_tool_call'
            ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? item.error ?? `[${toolName}]`))
            : JSON.stringify(item.changes ?? `[${toolName}]`);
        const clipped = bounded(summary);
        pushMessage(state, {
          role: 'tool',
          tool: toolName,
          text: clipped.text,
          ...(clipped.truncated ? { textTruncated: true } : {}),
          ...(item.error || item.status === 'failed' ? { isError: true } : {}),
        });
      }
      return { kind: 'tool' };
    }
    return { kind: 'item' };
  }

  if (type === 'token_count') {
    const rawUsage = value.info?.total_token_usage ?? value.usage;
    if (rawUsage && typeof rawUsage === 'object') {
      state.usage = normalizeCodexUsage(rawUsage, state.usage, { startedAt: state.startedAt });
    }
    return { kind: 'usage' };
  }

  if (type === 'turn.completed' || type === 'task_complete') {
    state.turnCompleted = true;
    state.lastStep = '回合已完成';
    const rawUsage = value.usage ?? value.token_usage ?? value.info?.total_token_usage;
    if ((rawUsage && typeof rawUsage === 'object') || value.duration_seconds !== undefined || value.duration_ms !== undefined || state.usage) {
      state.usage = normalizeCodexUsage(rawUsage, state.usage, {
        startedAt: state.startedAt,
        durationMs: value.duration_ms ?? value.durationMs,
        durationSec: value.duration_seconds ?? value.durationSec,
      });
    }
    if (typeof value.model === 'string' && value.model.trim()) state.model = value.model.trim();
    return { kind: 'result' };
  }

  if (type === 'turn.failed' || type === 'error') {
    const message = typeof value.error === 'string'
      ? value.error
      : (typeof value.error?.message === 'string' ? value.error.message : (typeof value.message === 'string' ? value.message : 'Codex turn failed.'));
    if (type === 'turn.failed') state.turnFailed = true;
    state.failureMessage = message.slice(0, 1200);
    state.lastStep = clipLastStep(`错误: ${state.failureMessage}`);
    return { kind: 'error' };
  }

  return { kind: 'other' };
}

function tailText(state, stderrTail) {
  return [
    ...(state.rawTail ?? []).slice(-2),
    String(stderrTail ?? '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' '),
  ].filter(Boolean).join(' | ').slice(0, 700);
}

export function codexTurnOutcome({ state, exitCode = null, cancelled = false, stderrTail = '' } = {}) {
  if (cancelled) return { state: 'cancelled' };
  const tail = tailText(state, stderrTail);
  if (state.turnFailed) {
    return {
      state: 'failed',
      error: {
        code: 'codex-cli-turn-failed',
        message: (state.failureMessage || 'Codex CLI reported turn failure.') + (tail ? ` Output: ${tail}` : ''),
      },
    };
  }
  if (exitCode !== 0) {
    return {
      state: 'failed',
      error: {
        code: 'codex-cli-exit-nonzero',
        message: `Codex CLI exited with code ${exitCode ?? 'unknown'}.`
          + (state.failureMessage ? ` It reported: ${state.failureMessage}` : '')
          + (tail ? ` Output: ${tail}` : ''),
      },
    };
  }
  if (!state.sessionStarted && !state.turnCompleted) {
    return {
      state: 'failed',
      error: {
        code: 'codex-cli-no-events',
        message: 'Codex CLI exited without emitting session events.' + (tail ? ` Output: ${tail}` : ''),
      },
    };
  }
  return { state: 'ended' };
}

// ---------------------------------------------------------------------------
// Start, read, and CIM-verified cancel
// ---------------------------------------------------------------------------

function defaultSpawnWorker(turnDir, { env = process.env } = {}) {
  const workerScript = fileURLToPath(new URL('./codex-cli-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [workerScript, '--turn', turnDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  return { pid: child.pid };
}

export async function startCodexTurn({
  cli,
  directory,
  workspace,
  name,
  threadId,
  resume = false,
  message,
  model,
  effort,
  reportConfig,
  callerEnv,
  readOnly = false,
  requestId,
  agentId,
  taskId,
  sessionId,
  route,
  config,
  timeoutMs,
  timeoutMinutes,
  writeBlockReason,
} = {}, { spawnWorker = defaultSpawnWorker, env = process.env } = {}) {
  const spec = normalizeCliSpec(cli);
  if (!spec) throw fail('invalid-cli', 'A Codex CLI path is required.');
  if (!directory || !path.isAbsolute(directory)) throw fail('invalid-turn-dir', 'Turn directory must be an absolute path.');
  if (!workspace || !path.isAbsolute(workspace)) throw fail('invalid-workspace', 'Workspace must be an absolute path.');

  const blocked = typeof writeBlockReason === 'function' ? writeBlockReason() : undefined;
  if (blocked) {
    throw fail(blocked, `Nothing was dispatched: ${blocked}.`, { terminal: true, notSent: true });
  }

  const fullPrompt = codexCallbackPrompt({
    serverName: reportConfig?.serverName ?? DEFAULT_CODEX_CALLBACK_SERVER,
    name,
    message,
    isResume: resume,
  });
  const fingerprint = createHash('sha256').update(JSON.stringify({
    workspace, fullPrompt, model: model ?? null, effort: effort ?? null,
    threadId: threadId ?? null, resume, readOnly, command: spec,
  })).digest('hex');

  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const ownerPath = path.join(directory, CODEX_TURN_FILES.owner);
  let claimed = true;
  try {
    await writeFile(ownerPath, JSON.stringify({
      version: 1, requestId, agentId, taskId, fingerprint, workspace, createdAt: startedAt,
    }, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    claimed = false;
  }

  if (!claimed) {
    const owner = await readJson(ownerPath);
    if (owner?.fingerprint !== fingerprint) {
      throw fail('request-id-conflict', 'Turn directory already belongs to a different request.', { terminal: true });
    }
    const existing = await readCodexTurn(directory).catch(() => null);
    return { accepted: existing ? existing.state === 'running' : true, duplicate: true, workerPid: existing?.workerPid ?? null };
  }

  const state = createCodexTurnState({
    requestId, agentId, taskId, sessionId, threadId, workspace,
    message, requestedModel: model ?? null, requestedEffort: effort ?? null, route,
  });
  const resolvedCallerEnv = callerEnv ?? reportConfig?.callerEnv ?? null;
  const turn = {
    version: 1,
    requestId: requestId ?? null,
    agentId: agentId ?? null,
    taskId: taskId ?? null,
    sessionId: sessionId ?? null,
    workspace,
    prompt: fullPrompt,
    rawMessage: message,
    threadId: threadId ?? null,
    resume: Boolean(resume && threadId),
    model: model ?? null,
    effort: effort ?? null,
    timeoutMs: resolveTurnTimeoutMs({ timeoutMs, timeoutMinutes, config }),
    reportConfig: reportConfig ?? null,
    callerEnv: resolvedCallerEnv,
    readOnly,
    route: route ?? null,
    command: spec.command,
    prefixArgs: spec.prefixArgs,
    startedAt,
    workerPid: null,
  };

  await writeFile(path.join(directory, CODEX_TURN_FILES.prompt), fullPrompt, 'utf8');
  await writeJsonFile(directory, CODEX_TURN_FILES.turn, turn);
  await writeJsonFile(directory, CODEX_TURN_FILES.state, state);

  const workerEnv = buildCliProxyEnv(managedCliEnv(env), route);
  const worker = await spawnWorker(directory, { env: workerEnv, route });
  const claimedTurn = await readJson(path.join(directory, CODEX_TURN_FILES.turn));
  const workerPid = (Number.isSafeInteger(claimedTurn?.workerPid) && claimedTurn.workerPid > 0)
    ? claimedTurn.workerPid
    : (Number.isSafeInteger(worker?.pid) ? worker.pid : null);
  turn.workerPid = workerPid;
  await writeJsonFile(directory, CODEX_TURN_FILES.turn, { ...(claimedTurn ?? {}), ...turn, workerPid }).catch(() => undefined);

  return { accepted: true, duplicate: false, workerPid };
}

async function readTerminalSnapshot(directory, turn) {
  const terminal = await readJson(path.join(directory, CODEX_TURN_FILES.terminal));
  if (!terminal || terminal.phase !== 'exited' || !TERMINAL_STATES.includes(terminal.state)) return undefined;
  if (!turn || !Object.hasOwn(turn, 'requestId') || terminal.requestId !== turn.requestId) return undefined;
  return terminal;
}

async function readTurnState(directory, turn, { checkTerminal = false } = {}) {
  let state;
  try { state = await readJson(path.join(directory, CODEX_TURN_FILES.state)); }
  catch (error) {
    const terminal = await readTerminalSnapshot(directory, turn);
    if (terminal) return terminal;
    throw error;
  }
  if (state && (!turn || !Object.hasOwn(turn, 'requestId') || state.requestId !== turn.requestId)) {
    return readTerminalSnapshot(directory, turn);
  }
  if (checkTerminal && !TERMINAL_STATES.includes(state?.state)) {
    return await readTerminalSnapshot(directory, turn) ?? state;
  }
  return state;
}

async function workerLostError(directory, message) {
  const stderr = await readFile(path.join(directory, CODEX_TURN_FILES.workerStderr), 'utf8').catch(() => '');
  const diagnostic = stderr.split(/\r?\n/).find(line => line.startsWith(CODEX_WORKER_ERROR_PREFIX))
    ?.slice(CODEX_WORKER_ERROR_PREFIX.length, CODEX_WORKER_ERROR_PREFIX.length + 400);
  return { code: 'codex-turn-worker-lost', message: diagnostic ? `${message} Worker error: ${diagnostic}` : message };
}

export async function readCodexTurn(directory, { isAlive = processAlive } = {}) {
  const turn = await readJson(path.join(directory, CODEX_TURN_FILES.turn));
  let state = await readTurnState(directory, turn);
  const alive = !state && Number.isSafeInteger(turn?.workerPid) && isAlive(turn.workerPid);
  if (!state && turn && !alive) state = await readTurnState(directory, turn, { checkTerminal: true });
  if (!state) {
    if (!turn) throw fail('codex-turn-not-found', `No Codex CLI turn is recorded in ${directory}.`);
    return {
      directory,
      state: alive ? 'running' : 'failed',
      requestId: turn.requestId ?? null,
      sessionId: turn.sessionId ?? null,
      threadId: turn.threadId ?? null,
      model: null,
      actualEffort: null,
      usage: null,
      messages: [],
      messagesDropped: 0,
      sessionStarted: false,
      ...(alive ? {} : {
        error: await workerLostError(directory, 'The detached Codex CLI worker exited before writing state.json.'),
      }),
      workerPid: turn.workerPid ?? null,
      codexPid: null,
      lastStep: null,
      lastEventAt: turn.startedAt ?? null,
      startedAt: turn.startedAt ?? null,
      endedAt: null,
    };
  }

  const marker = await readJson(path.join(directory, CODEX_TURN_FILES.cancel));
  const workerPid = recordedWorkerPid(turn, state);
  const codexPid = Number.isSafeInteger(state.pid) && state.pid > 0 ? state.pid : null;
  const owned = [...new Set([workerPid, codexPid].filter(pid => pid !== null))];
  const live = new Map(owned.map(pid => [pid, isAlive(pid)]));
  const alivePids = owned.filter(pid => live.get(pid));
  const workerAlive = workerPid !== null && live.get(workerPid) === true;
  const heartbeat = Date.parse(state.heartbeatAt ?? state.updatedAt ?? state.startedAt ?? '');
  const fresh = Number.isFinite(heartbeat) && Date.now() - heartbeat <= LOST_HEARTBEAT_MS;

  if ((!workerAlive || !fresh) && !TERMINAL_STATES.includes(state.state)) {
    const latest = await readTurnState(directory, turn, { checkTerminal: true });
    if (TERMINAL_STATES.includes(latest?.state)) state = latest;
  }

  let reported = state.state === undefined ? 'running' : state.state;
  let error = state.error ?? undefined;
  if (!TERMINAL_STATES.includes(reported)) {
    if (marker?.requestId === turn?.requestId && marker?.stopped === true && !alivePids.length) {
      reported = 'cancelled';
      error = undefined;
    } else if (alivePids.length) {
      // At least one owned process is still running.
    } else if (owned.length) {
      reported = 'failed';
      error = await workerLostError(directory,
        'The detached Codex CLI worker exited without recording a final state, and no owned process remains.');
    } else if (!fresh) {
      reported = 'failed';
      error = await workerLostError(directory,
        'The detached Codex CLI worker missed its heartbeat window and is treated as gone.');
    }
  }

  return {
    directory,
    state: reported === 'completed' ? 'ended' : reported,
    requestId: state.requestId ?? turn?.requestId ?? null,
    sessionId: state.sessionId ?? turn?.sessionId ?? null,
    threadId: state.threadId ?? turn?.threadId ?? null,
    model: state.model ?? null,
    requestedModel: state.requestedModel ?? turn?.model ?? null,
    actualEffort: state.actualEffort ?? state.requestedEffort ?? turn?.effort ?? null,
    usage: state.usage ?? null,
    messages: state.messages ?? [],
    messagesDropped: state.messagesDropped ?? 0,
    ...(error ? { error } : {}),
    sessionStarted: state.sessionStarted === true,
    notSent: state.notSent === true || state.error?.notSent === true,
    workerPid,
    codexPid,
    lastStep: state.lastStep ?? null,
    lastEventAt: state.lastEventAt ?? state.updatedAt ?? state.startedAt ?? turn?.startedAt ?? null,
    startedAt: state.startedAt ?? turn?.startedAt ?? null,
    endedAt: state.endedAt ?? null,
  };
}

export async function killProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: true };
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGKILL'); return { ok: true }; }
    catch (error) { return { ok: error?.code === 'ESRCH', code: error?.code }; }
  }
  const child = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  const code = await new Promise(resolve => {
    child.once('exit', value => resolve(value ?? null));
    child.once('error', () => resolve(-1));
  });
  return { ok: code === 0, code };
}

export async function readProcessIdentities(pids) {
  const lines = new Map();
  const ids = [...new Set(pids.filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  if (!ids.length) return lines;
  if (process.platform !== 'win32') {
    for (const pid of ids) {
      try {
        const text = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').join(' ').trim();
        lines.set(pid, { text, creationDate: null, ok: true });
      } catch (error) {
        lines.set(pid, { text: null, creationDate: null, ok: error?.code === 'ENOENT' });
      }
    }
    return lines;
  }
  const filter = ids.map(pid => `ProcessId=${pid}`).join(' OR ');
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    '$ErrorActionPreference = "SilentlyContinue"',
    `foreach ($p in @(Get-CimInstance Win32_Process -Filter "${filter}")) { if ($p) { $dt = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString("o") } else { "" }; "$($p.ProcessId)" + [char]9 + $dt + [char]9 + $p.CommandLine } }`,
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: IDENTITY_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
    for (const pid of ids) lines.set(pid, { text: null, creationDate: null, ok: true });
    for (const line of String(stdout ?? '').split(/\r?\n/)) {
      const firstTab = line.indexOf('\t');
      if (firstTab <= 0) continue;
      const pid = Number.parseInt(line.slice(0, firstTab), 10);
      if (!Number.isSafeInteger(pid) || !lines.has(pid)) continue;
      const rest = line.slice(firstTab + 1);
      const secondTab = rest.indexOf('\t');
      const creationDate = secondTab >= 0 ? (rest.slice(0, secondTab).trim() || null) : null;
      const text = secondTab >= 0 ? rest.slice(secondTab + 1).trim() : rest.trim();
      lines.set(pid, { text, creationDate, ok: true });
    }
  } catch {
    for (const pid of ids) lines.set(pid, { text: null, creationDate: null, ok: false });
  }
  return lines;
}

function ownsTurnProcess(identity, { directory, threadId, requestId, startedAt }) {
  const text = String(identity?.text ?? '').toLowerCase();
  if (!text) return false;
  if (identity?.creationDate && startedAt) {
    const createdMs = Date.parse(identity.creationDate);
    const turnMs = Date.parse(startedAt);
    if (Number.isFinite(createdMs) && Number.isFinite(turnMs) && createdMs < turnMs - 120000) return false;
  }
  const normalizedDir = directory ? path.resolve(directory).toLowerCase() : '';
  const markers = [normalizedDir, directory, threadId, requestId]
    .filter(marker => typeof marker === 'string' && marker.length > 8);
  return markers.some(marker => text.includes(marker.toLowerCase()));
}

async function markCancelled(directory, state) {
  const time = new Date().toISOString();
  await writeJsonFile(directory, CODEX_TURN_FILES.state, {
    ...state,
    state: 'cancelled',
    phase: 'exited',
    updatedAt: time,
    heartbeatAt: time,
    endedAt: state.endedAt ?? time,
    error: null,
  });
}

export async function cancelCodexTurn(directory, { expectedRequestId,
  isAlive = processAlive,
  killTree = killProcessTree,
  killCage = killTree === killProcessTree ? killProcessCage : async () => ({ ok: true, killed: [] }),
  commandLines = readProcessIdentities,
  confirmMs = CANCEL_CONFIRM_MS,
} = {}) {
  const turn = await readJson(path.join(directory, CODEX_TURN_FILES.turn));
  if (expectedRequestId !== undefined && turn?.requestId !== expectedRequestId) {
    return { ok: false, stopped: false, note: 'The original turn request does not match.' };
  }
  // A native session survives multiple turns. Only use this turn's directory
  // and request ID when preempting, including for orphan discovery.
  const stopCage = async options => {
    const result = await killCage(expectedRequestId === undefined ? options : { ...options, sessionId: undefined });
    if (expectedRequestId !== undefined && result?.ok === false) {
      throw fail('preempt-cage-still-running', 'The original process cage could not be reaped.');
    }
    return result;
  };
  const state = await readTurnState(directory, turn, { checkTerminal: true });
  const pids = {
    worker: recordedWorkerPid(turn, state),
    codex: Number.isSafeInteger(state?.pid) && state.pid > 0 ? state.pid : null,
  };
  if (!state && !turn) {
    return { ok: true, cancelled: false, stopped: true, state: null, pids, remaining: [] };
  }
  const recorded = [...new Set([pids.worker, pids.codex].filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  const alive = () => recorded.filter(pid => isAlive(pid));
  const requestedAt = new Date().toISOString();
  const requestId = state?.requestId ?? turn?.requestId ?? null;
  const sessionId = state?.sessionId ?? turn?.sessionId ?? null;
  const markers = {
    directory,
    threadId: expectedRequestId === undefined ? state?.threadId ?? turn?.threadId ?? null : undefined,
    requestId,
    startedAt: state?.startedAt ?? turn?.startedAt ?? null,
  };

  if (TERMINAL_STATES.includes(state?.state)) {
    const surviving = alive();
    if (surviving.length) {
      const identities = await commandLines(surviving);
      const ours = [];
      const reused = [];
      for (const pid of surviving) {
        const identity = identities?.get?.(pid) ?? { text: null, creationDate: null, ok: false };
        if (!identity.ok || !identity.text) continue;
        if (ownsTurnProcess(identity, markers)) ours.push(pid);
        else reused.push(pid);
      }
      if (ours.length) {
        for (const pid of ours) await killTree(pid);
        await stopCage({ pids: ours, turnDir: directory, runId: requestId, sessionId });
        const deadline = Date.now() + confirmMs;
        let stillOurs = ours.filter(pid => isAlive(pid));
        while (stillOurs.length && Date.now() < deadline) {
          await delay(100);
          stillOurs = ours.filter(pid => isAlive(pid));
        }
        if (stillOurs.length) {
          return { ok: false, cancelled: false, stopped: false, state: state.state, pids, remaining: stillOurs,
            note: `Processes still alive after terminal cleanup: ${stillOurs.join(', ')}.` };
        }
        return { ok: true, cancelled: state.state === 'cancelled', stopped: true, state: state.state, pids, remaining: [] };
      }
      await stopCage({ pids: [], turnDir: directory, runId: requestId, sessionId });
      const nonReused = surviving.filter(pid => isAlive(pid) && !reused.includes(pid));
      if (nonReused.length) {
        return { ok: false, cancelled: false, stopped: false, state: state.state, pids, remaining: nonReused,
          note: 'Turn already ended; recorded processes are still alive and will not be killed by recycled pid.' };
      }
      return { ok: true, cancelled: state.state === 'cancelled', stopped: true, state: state.state, pids, remaining: [] };
    }
    await stopCage({ pids: [], turnDir: directory, runId: requestId, sessionId });
    return { ok: true, cancelled: state.state === 'cancelled', stopped: true, state: state.state, pids, remaining: [] };
  }

  if (!recorded.length) {
    await stopCage({ pids: [], turnDir: directory, runId: requestId, sessionId });
    return { ok: false, cancelled: false, stopped: false, state: 'running', pids, remaining: [],
      note: 'Worker has not recorded any pid yet; retry cancel shortly.' };
  }

  await writeJsonFile(directory, CODEX_TURN_FILES.cancel, { requestId, requestedAt, stopped: null, pids });
  const targets = alive();
  if (!targets.length) {
    await stopCage({ pids: [], turnDir: directory, runId: requestId, sessionId });
    const latest = await readTurnState(directory, turn, { checkTerminal: true });
    const current = TERMINAL_STATES.includes(latest?.state) ? latest.state : 'cancelled';
    if (!TERMINAL_STATES.includes(latest?.state) && (latest ?? state)) {
      await markCancelled(directory, latest ?? state);
    }
    await writeJsonFile(directory, CODEX_TURN_FILES.cancel, { requestId, requestedAt, stopped: true, remaining: [], pids });
    return { ok: true, cancelled: current === 'cancelled', stopped: true, state: current, pids, remaining: [] };
  }

  const identities = await commandLines(targets);
  const ours = [];
  const reused = [];
  for (const pid of targets) {
    const identity = identities?.get?.(pid) ?? { text: null, creationDate: null, ok: false };
    if (!identity.ok || !identity.text) continue;
    if (ownsTurnProcess(identity, markers)) ours.push(pid);
    else reused.push(pid);
  }
  if (!ours.length && !reused.length) {
    await writeJsonFile(directory, CODEX_TURN_FILES.cancel, { requestId, requestedAt, stopped: false, remaining: targets, pids });
    return { ok: false, cancelled: false, stopped: false, state: 'running', pids, remaining: targets,
      note: `Process identity for (${targets.join(', ')}) could not be verified, so nothing was killed.` };
  }

  for (const pid of ours) await killTree(pid);
  await stopCage({ pids: ours, turnDir: directory, runId: requestId, sessionId });
  const blocking = () => recorded.filter(pid => isAlive(pid) && !reused.includes(pid));
  const deadline = Date.now() + confirmMs;
  let remaining = blocking();
  while (remaining.length && Date.now() < deadline) {
    await delay(100);
    remaining = blocking();
  }
  if (remaining.length) {
    await writeJsonFile(directory, CODEX_TURN_FILES.cancel, { requestId, requestedAt, stopped: false, remaining, pids });
    return { ok: false, cancelled: false, stopped: false, state: 'running', pids, remaining,
      note: `Processes still alive after kill attempt: ${remaining.join(', ')}.` };
  }

  const latest = await readTurnState(directory, turn, { checkTerminal: true });
  await writeJsonFile(directory, CODEX_TURN_FILES.cancel, { requestId, requestedAt, stopped: true, remaining: [], pids });
  if (!TERMINAL_STATES.includes(latest?.state) && (latest ?? state)) {
    await markCancelled(directory, latest ?? state);
  }
  return { ok: true, cancelled: true, stopped: true, state: TERMINAL_STATES.includes(latest?.state) ? latest.state : 'cancelled', pids, remaining: [] };
}
