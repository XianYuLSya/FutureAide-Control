// Headless Google Antigravity CLI (`agy -p ... --output-format stream-json`) runner utilities.
//
// Runs one detached worker per turn inside the agent's private request directory with:
//   - Atomic snapshot & heartbeat (`state.json` / `terminal.json`)
//   - Fail-closed proxy verification via `cli-proxy.mjs`
//   - Win32 Job Object process cage & orphan tree cleanup via `process-cage.mjs`
//   - Official `agy` NDJSON stream folding (`init`, `step_update`, `result`)
//   - Normalized token billing (`usage`) and single-turn timeout enforcement
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildCliProxyEnv, redactProxyCredentials, resolveCliRoute } from './cli-proxy.mjs';
import { managedCliEnv } from './managed-cli-policy.mjs';
import { killProcessCage } from './process-cage.mjs';
import { replaceStateFile } from './replace-state-file.mjs';

const execFileAsync = promisify(execFile);

export const AGY_CLI_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
export const AGY_MODEL_TIER_SUFFIX = /-(low|medium|high|xhigh|max)$/i;
export const DEFAULT_TURN_TIMEOUT_MS = 25 * 60 * 1000;
export const MAX_MESSAGE_TEXT = 8000;
export const MAX_LAST_STEP_CHARS = 50;
export const MAX_STORED_MESSAGES = 400;
export const WORKER_HEARTBEAT_MS = 2000;
export const LOST_HEARTBEAT_MS = 120000;
export const CANCEL_CONFIRM_MS = 10000;
export const PROBE_TIMEOUT_MS = 20000;
const IDENTITY_TIMEOUT_MS = 20000;

/**
 * Built-in fallback catalog ordered with `-high` first per model family so substring
 * queries such as `'neon'`, `'carbon'`, or `'flash'` resolve deterministically to
 * `gemini-4-neon-high`, `gemini-4-carbon-high`, and `gemini-3.8-flash-high`.
 */
export const AGY_CLI_FALLBACK_MODELS = Object.freeze([
  Object.freeze({ id: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' }),
  Object.freeze({ id: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' }),
  Object.freeze({ id: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' }),
  Object.freeze({ id: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' }),
  Object.freeze({ id: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' }),
  Object.freeze({ id: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' }),
  Object.freeze({ id: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' }),
  Object.freeze({ id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' }),
  Object.freeze({ id: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' }),
  Object.freeze({ id: 'gemini-4-hydrogen-xhigh', name: 'Gemini 4 Hydrogen (XHigh)' }),
  Object.freeze({ id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' }),
  Object.freeze({ id: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' }),
  Object.freeze({ id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' }),
  Object.freeze({ id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' }),
  Object.freeze({ id: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 (High)' }),
  Object.freeze({ id: 'pro', name: 'Antigravity Pro' }),
  Object.freeze({ id: 'flash', name: 'Antigravity Flash' }),
  Object.freeze({ id: 'flash_lite', name: 'Antigravity Flash Lite' }),
]);

export const AGY_TURN_FILES = Object.freeze({
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

export const AGY_WORKER_ERROR_PREFIX = 'agy-cli-worker: ';
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

export function isAgyStateFileBusy(error) {
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
        if (!isAgyStateFileBusy(error) || remaining <= 0) throw error;
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

export function normalizeAgyUsage(raw, prev = null, { startedAt, durationSec: explicitDurationSec, nowMs = Date.now() } = {}) {
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
    src.cache_read_tokens ?? src.cache_read_input_tokens ?? src.cached_input_tokens ?? src.cachedTokens,
    prev?.cachedTokens ?? 0,
  );
  const cacheWrite = toNonNegInt(src.cache_creation_input_tokens ?? src.cache_write_tokens, 0);
  const rawTotal = src.total_tokens ?? src.totalTokens;
  const totalTokens = Number.isFinite(Number(rawTotal)) && Number(rawTotal) >= 0
    ? Math.round(Number(rawTotal))
    : inputTokens + outputTokens + cachedTokens + cacheWrite;

  let durationSec = prev?.durationSec ?? 0;
  const rawSec = explicitDurationSec ?? src.duration_seconds ?? src.durationSec;
  const rawMs = src.duration_ms ?? src.durationMs;
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
// Discovery & model catalog
// ---------------------------------------------------------------------------

/**
 * Locate `agy` in strict precedence order:
 *   1. explicitPath / explicit (`config.agyCliPath`)
 *   2. `env.AGY_CLI`
 *   3. `PATH` (`agy.exe` / `agy` / `agy.cmd` on Windows, `agy` on POSIX)
 *   4. `%LOCALAPPDATA%\agy\bin\agy.exe`
 *   5. `~/.local/bin/agy` (and `agy.exe` on Windows)
 */
export async function findAgyCli({
  explicitPath,
  explicit,
  env = process.env,
  isFile = isRegularFile,
} = {}) {
  const direct = typeof explicitPath === 'string' && explicitPath.trim()
    ? explicitPath.trim()
    : (typeof explicit === 'string' && explicit.trim() ? explicit.trim() : '');
  if (direct) return direct;

  const envCli = typeof env?.AGY_CLI === 'string' ? env.AGY_CLI.trim() : '';
  if (envCli) return envCli;

  const rawPath = env?.PATH || env?.Path || '';
  const names = process.platform === 'win32' ? ['agy.exe', 'agy'] : ['agy'];
  for (const dir of String(rawPath).split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await isFile(candidate)) return candidate;
    }
  }

  const localAppData = env?.LOCALAPPDATA || env?.LocalAppData
    || (env === process.env && process.platform === 'win32' ? path.join(homedir(), 'AppData', 'Local') : '');
  if (localAppData) {
    const winCandidate = path.join(localAppData, 'agy', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
    if (await isFile(winCandidate)) return winCandidate;
  }

  const home = homedir();
  const localBinCandidates = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin', 'agy.exe'), path.join(home, '.local', 'bin', 'agy')]
    : [path.join(home, '.local', 'bin', 'agy')];
  for (const candidate of localBinCandidates) {
    if (await isFile(candidate)) return candidate;
  }

  return undefined;
}

const TIER_RANK = Object.freeze({ high: 0, xhigh: 1, max: 2, medium: 3, low: 4 });

function tierRankOf(id) {
  const match = AGY_MODEL_TIER_SUFFIX.exec(id);
  if (!match) return 5;
  return TIER_RANK[match[1].toLowerCase()] ?? 5;
}

function familyPrefixOf(id) {
  return String(id ?? '').toLowerCase().replace(AGY_MODEL_TIER_SUFFIX, '');
}

/**
 * Parse `agy models` stdout (`<model_id>\t<Display Name>` per line).
 * Keeps family order while placing `-high` first within each family so substring
 * queries like `'neon'` always select `gemini-4-neon-high` first.
 */
export function parseAgyModelsOutput(stdout) {
  const rawEntries = [];
  const seen = new Set();
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^fetching\b/i.test(line) || line.startsWith('#')) continue;
    let id = '';
    let name = '';
    const tabIdx = line.indexOf('\t');
    if (tabIdx > 0) {
      id = line.slice(0, tabIdx).trim();
      name = line.slice(tabIdx + 1).trim();
    } else {
      const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\s{2,}(.+))?$/.exec(line);
      if (match) {
        id = match[1].trim();
        name = (match[2] ?? '').trim();
      }
    }
    if (!id || /\s/.test(id)) continue;
    const lower = id.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    rawEntries.push({ id, name: name || id });
  }

  const familyOrder = new Map();
  for (const item of rawEntries) {
    const fam = familyPrefixOf(item.id);
    if (!familyOrder.has(fam)) familyOrder.set(fam, familyOrder.size);
  }
  rawEntries.sort((a, b) => {
    const famDiff = (familyOrder.get(familyPrefixOf(a.id)) ?? 0) - (familyOrder.get(familyPrefixOf(b.id)) ?? 0);
    if (famDiff !== 0) return famDiff;
    return tierRankOf(a.id) - tierRankOf(b.id);
  });
  return rawEntries;
}

function buildCatalogModelEntry({ id, name }) {
  return {
    id,
    name: name || id,
    reasoning: {
      efforts: AGY_CLI_EFFORTS.map(eff => ({ id: eff })),
      defaultEffort: 'high',
    },
  };
}

export async function readAgyCliModels({
  cli,
  route,
  env = process.env,
  exec = execFileAsync,
  read = readFile,
  settingsPath = path.join(homedir(), '.gemini', 'antigravity-cli', 'settings.json'),
  extraModels = [],
  liveDiscovery = false,
  timeoutMs = 8000,
} = {}) {
  let defaultModel = 'gemini-4-neon-high';
  let defaultEffort = 'high';
  try {
    const rawSettings = JSON.parse(await read(settingsPath, 'utf8'));
    if (typeof rawSettings?.model === 'string' && rawSettings.model.trim()) {
      defaultModel = rawSettings.model.trim();
    }
    if (typeof rawSettings?.effort === 'string' && rawSettings.effort.trim()) {
      defaultEffort = rawSettings.effort.trim().toLowerCase();
    }
  } catch { /* optional settings.json */ }

  let discovered = [];
  if (liveDiscovery && cli) {
    const spec = normalizeCliSpec(cli);
    if (spec) {
      const childEnv = route ? buildCliProxyEnv(env, route) : env;
      const res = await runCliCommand(spec, ['models'], { env: childEnv, exec, timeoutMs });
      if (res.code === 0 && res.stdout.trim()) {
        discovered = parseAgyModelsOutput(res.stdout);
      }
    }
  }

  const merged = [];
  const seen = new Set();
  const pushItem = item => {
    if (!item || typeof item.id !== 'string' || !item.id.trim()) return;
    const key = item.id.trim().toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(buildCatalogModelEntry({ id: item.id.trim(), name: item.name || item.id.trim() }));
  };

  for (const item of discovered) pushItem(item);
  for (const item of AGY_CLI_FALLBACK_MODELS) pushItem(item);
  if (defaultModel) pushItem({ id: defaultModel, name: defaultModel });
  for (const dynamicId of extraModels) {
    if (typeof dynamicId === 'string' && dynamicId.trim()) {
      const cleaned = dynamicId.trim();
      // Keep family substrings like 'neon' / 'carbon' / 'flash' resolving to their `-high` full IDs
      const lower = cleaned.toLowerCase();
      const matchesExistingSubstring = merged.some(entry => entry.id.toLowerCase().includes(lower));
      if (!matchesExistingSubstring) {
        pushItem({ id: cleaned, name: cleaned });
      }
    }
  }

  const effectiveDefault = merged.some(m => m.id.toLowerCase() === defaultModel.toLowerCase())
    ? merged.find(m => m.id.toLowerCase() === defaultModel.toLowerCase()).id
    : (merged[0]?.id ?? 'gemini-4-neon-high');

  return {
    groups: [{ id: 'antigravity', models: merged }],
    routableProviders: ['antigravity'],
    default: {
      provider: 'antigravity',
      model: effectiveDefault,
      reasoningEffort: defaultEffort,
    },
    note: discovered.length
      ? 'Models loaded from `agy models`.'
      : 'Models loaded from built-in Antigravity CLI catalog.',
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

export async function probeAgyCli({
  cliPath,
  cli,
  config = {},
  env = process.env,
  findCli = findAgyCli,
  resolveRoute = resolveCliRoute,
  exec = execFileAsync,
  timeoutMs = PROBE_TIMEOUT_MS,
} = {}) {
  const route = await resolveRoute({ target: 'agy-cli', client: 'antigravity', config, env });
  if (!route.ok) {
    return {
      ok: false,
      code: route.code || 'proxy-unavailable',
      error: route.error || 'Antigravity CLI proxy route is unavailable.',
      route,
      cli: null,
      version: null,
    };
  }

  let spec = normalizeCliSpec(cli ?? cliPath ?? config?.agyCliPath);
  if (!spec) {
    const found = await findCli({
      explicitPath: typeof (cliPath ?? config?.agyCliPath) === 'string' ? (cliPath ?? config?.agyCliPath) : undefined,
      env,
    });
    spec = normalizeCliSpec(found);
  }
  if (!spec) {
    return {
      ok: false,
      code: 'agy-cli-not-found',
      error: 'The Antigravity CLI (agy) was not found.',
      route,
      cli: null,
      version: null,
    };
  }

  const childEnv = buildCliProxyEnv(env, route);
  const ver = await runCliCommand(spec, ['--version'], { env: childEnv, exec, timeoutMs });
  if (ver.code !== 0 || !(ver.stdout.trim() || ver.stderr.trim())) {
    return {
      ok: false,
      code: 'agy-cli-probe-failed',
      error: `agy --version failed (code ${ver.code}): ${(ver.stderr || ver.stdout || 'no output').trim().slice(0, 400)}`,
      route,
      cli: spec.command,
      version: null,
    };
  }
  const version = (ver.stdout || ver.stderr).trim().split(/\r?\n/).find(line => line.trim())?.trim() ?? null;

  return {
    ok: true,
    code: 'ok',
    cli: spec.command,
    spec,
    version,
    auth: { loggedIn: true, detail: 'Antigravity CLI ready' },
    route,
  };
}

// ---------------------------------------------------------------------------
// Prompt & argv construction
// ---------------------------------------------------------------------------

export function agyCallbackPrompt({ name, message, isResume = false } = {}) {
  if (isResume) return String(message ?? '');
  const header = [
    `[FutureAide Managed Antigravity CLI Helper${name ? ` — ${name}` : ''}]`,
    'Another agent assigned this task and is waiting for your explicit MCP callback.',
    '- If you need a decision from your parent, call ask_parent and stop.',
    '- When you finish, deliver your final result by calling report_parent(message, final=true).',
    '- Ordinary text replies do not complete the parent task; only ask_parent and report_parent do.',
  ].join('\n');
  return `${header}\n\n${String(message ?? '')}`;
}

export function hasAgyModelTierSuffix(model) {
  return typeof model === 'string' && AGY_MODEL_TIER_SUFFIX.test(model.trim());
}

/**
 * Build argv for `agy -p <prompt> --output-format stream-json --dangerously-skip-permissions`.
 * When `model` already carries an Antigravity tier suffix (e.g. `gemini-4-neon-high`),
 * `--effort` is omitted so the CLI never rejects duplicate/conflicting effort flags.
 */
export function buildAgyCliArgs({
  prompt,
  conversationId,
  resume = false,
  model,
  effort,
} = {}) {
  const args = [
    '-p',
    String(prompt ?? ''),
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
  ];
  if (resume && typeof conversationId === 'string' && conversationId.trim()) {
    args.push('--conversation', conversationId.trim());
  }
  const trimmedModel = typeof model === 'string' ? model.trim() : '';
  if (trimmedModel) {
    args.push('--model', trimmedModel);
  }
  const trimmedEffort = typeof effort === 'string' ? effort.trim().toLowerCase() : '';
  if (trimmedEffort && !hasAgyModelTierSuffix(trimmedModel)) {
    const cliEffort = trimmedEffort === 'ultra' ? 'max' : trimmedEffort;
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(cliEffort)) {
      args.push('--effort', cliEffort);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Official NDJSON stream folding
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

export function createAgyTurnState({
  requestId,
  agentId,
  taskId,
  sessionId,
  conversationId,
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
    conversationId: conversationId ?? null,
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
    resultSeen: false,
    resultStatus: null,
    resultText: null,
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
 * Fold one NDJSON line from `agy --output-format stream-json`:
 *   - `{"event":"init","conversation_id":"...","init":{"model":"..."}}`
 *   - `{"event":"step_update","step_update":{"step_type":"...","text_delta":"...","usage":{...}}}`
 *   - `{"event":"result","result":{"conversation_id":"...","status":"SUCCESS","response":"...","duration_seconds":...,"usage":{...}}}`
 */
export function applyAgyLine(state, line) {
  let value;
  try { value = JSON.parse(line); }
  catch { recordRawLine(state, line); return { kind: 'raw' }; }
  if (!value || typeof value !== 'object') {
    recordRawLine(state, line);
    return { kind: 'raw' };
  }
  const eventType = typeof value.event === 'string'
    ? value.event
    : (typeof value.type === 'string' ? value.type : '');
  if (!eventType) {
    recordRawLine(state, line);
    return { kind: 'raw' };
  }

  state.updatedAt = new Date().toISOString();
  state.lastEventAt = state.updatedAt;

  if (eventType === 'init') {
    state.sessionStarted = true;
    if (state.phase === 'starting') state.phase = 'streaming';
    state.lastStep ??= '会话已启动';
    const initObj = value.init && typeof value.init === 'object' ? value.init : value;
    const cid = value.conversation_id ?? initObj.conversation_id ?? value.conversationId ?? initObj.conversationId;
    if (typeof cid === 'string' && cid.trim()) state.conversationId = cid.trim();
    const model = initObj.model ?? value.model;
    if (typeof model === 'string' && model.trim()) {
      state.model = model.trim();
      const suffixMatch = AGY_MODEL_TIER_SUFFIX.exec(state.model);
      if (suffixMatch && !state.actualEffort) state.actualEffort = suffixMatch[1].toLowerCase();
    }
    const effort = initObj.effort ?? value.effort;
    if (typeof effort === 'string' && effort.trim()) state.actualEffort = effort.trim().toLowerCase();
    return { kind: 'init' };
  }

  if (eventType === 'step_update') {
    state.sessionStarted = true;
    if (state.phase === 'starting') state.phase = 'streaming';
    const cid = value.conversation_id ?? value.step_update?.conversation_id;
    if (typeof cid === 'string' && cid.trim()) state.conversationId = cid.trim();
    const step = value.step_update && typeof value.step_update === 'object' ? value.step_update : value;
    const stepType = String(step.step_type ?? step.type ?? '').trim();
    const toolName = step.tool_name ?? step.tool ?? null;

    if (toolName || /tool|command|exec/i.test(stepType)) {
      const label = String(toolName || stepType || 'tool');
      state.lastStep = clipLastStep(`tool: ${label}`);
      state.toolCalls ??= [];
      state.toolCalls.push({ name: label.slice(0, 120), state: String(step.status ?? 'running') });
      if (state.toolCalls.length > 200) state.toolCalls.splice(0, state.toolCalls.length - 200);
    } else if (/think|reason|thought/i.test(stepType)) {
      state.lastStep = '思考推理中';
    } else if (typeof step.text_delta === 'string' && step.text_delta.length > 0) {
      state.lastStep = '输出回复中';
      state._streamingText = `${state._streamingText ?? ''}${step.text_delta}`.slice(-MAX_MESSAGE_TEXT * 2);
    } else if (stepType) {
      state.lastStep = clipLastStep(stepType);
    }

    if (step.usage && typeof step.usage === 'object') {
      state.usage = normalizeAgyUsage(step.usage, state.usage, { startedAt: state.startedAt });
    }
    return { kind: 'step_update' };
  }

  if (eventType === 'result') {
    state.sessionStarted = true;
    state.resultSeen = true;
    const res = value.result && typeof value.result === 'object' ? value.result : value;
    const cid = res.conversation_id ?? value.conversation_id ?? res.conversationId;
    if (typeof cid === 'string' && cid.trim()) state.conversationId = cid.trim();
    if (typeof res.model === 'string' && res.model.trim()) state.model = res.model.trim();

    const responseText = typeof res.response === 'string' && res.response.trim()
      ? res.response
      : (typeof state._streamingText === 'string' && state._streamingText.trim() ? state._streamingText : '');
    delete state._streamingText;
    if (responseText) {
      const clipped = bounded(responseText);
      state.resultText = clipped.text;
      pushMessage(state, {
        role: 'assistant',
        text: clipped.text,
        ...(clipped.truncated ? { textTruncated: true } : {}),
      });
    }

    const statusStr = typeof res.status === 'string' ? res.status.trim().toUpperCase() : 'SUCCESS';
    state.resultStatus = statusStr;
    const isError = res.is_error === true
      || (statusStr !== '' && !['SUCCESS', 'OK', 'COMPLETED', 'DONE'].includes(statusStr));

    if (isError) {
      state.turnFailed = true;
      const errMsg = typeof res.error === 'string'
        ? res.error
        : (typeof res.error?.message === 'string'
          ? res.error.message
          : (responseText || `Antigravity CLI finished with status ${statusStr}.`));
      state.failureMessage = errMsg.slice(0, 1200);
      state.lastStep = clipLastStep(`错误: ${state.failureMessage}`);
    } else {
      state.turnCompleted = true;
      state.lastStep = '回合已完成';
    }

    if (res.usage || res.duration_seconds !== undefined || state.usage) {
      state.usage = normalizeAgyUsage(res.usage, state.usage, {
        startedAt: state.startedAt,
        durationSec: res.duration_seconds,
      });
    }
    return { kind: 'result' };
  }

  if (eventType === 'error') {
    const errMsg = typeof value.error === 'string'
      ? value.error
      : (typeof value.error?.message === 'string'
        ? value.error.message
        : (typeof value.message === 'string' ? value.message : 'Antigravity CLI error.'));
    state.turnFailed = true;
    state.failureMessage = errMsg.slice(0, 1200);
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

export function agyTurnOutcome({ state, exitCode = null, cancelled = false, stderrTail = '' } = {}) {
  if (cancelled) return { state: 'cancelled' };
  const tail = tailText(state, stderrTail);
  if (state.turnFailed) {
    return {
      state: 'failed',
      error: {
        code: 'agy-cli-turn-failed',
        message: (state.failureMessage || 'Antigravity CLI reported turn failure.') + (tail ? ` Output: ${tail}` : ''),
      },
    };
  }
  if (exitCode !== 0) {
    return {
      state: 'failed',
      error: {
        code: 'agy-cli-exit-nonzero',
        message: `Antigravity CLI exited with code ${exitCode ?? 'unknown'}.`
          + (state.failureMessage ? ` It reported: ${state.failureMessage}` : '')
          + (tail ? ` Output: ${tail}` : ''),
      },
    };
  }
  if (!state.sessionStarted && !state.turnCompleted && !state.resultSeen) {
    return {
      state: 'failed',
      error: {
        code: 'agy-cli-no-events',
        message: 'Antigravity CLI exited without emitting stream-json events.' + (tail ? ` Output: ${tail}` : ''),
      },
    };
  }
  return { state: 'ended' };
}

// ---------------------------------------------------------------------------
// Start, read, and CIM-verified cancel
// ---------------------------------------------------------------------------

function defaultSpawnWorker(turnDir, { env = process.env } = {}) {
  const workerScript = fileURLToPath(new URL('./agy-cli-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [workerScript, '--turn', turnDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  return { pid: child.pid };
}

export async function startAgyTurn({
  cli,
  directory,
  workspace,
  name,
  conversationId,
  resume = false,
  message,
  model,
  effort,
  reportConfig,
  callerEnv,
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
  if (!spec) throw fail('invalid-cli', 'An Antigravity CLI (agy) path is required.');
  if (!directory || !path.isAbsolute(directory)) throw fail('invalid-turn-dir', 'Turn directory must be an absolute path.');
  if (!workspace || !path.isAbsolute(workspace)) throw fail('invalid-workspace', 'Workspace must be an absolute path.');

  const blocked = typeof writeBlockReason === 'function' ? writeBlockReason() : undefined;
  if (blocked) {
    throw fail(blocked, `Nothing was dispatched: ${blocked}.`, { terminal: true, notSent: true });
  }

  const fullPrompt = agyCallbackPrompt({
    name,
    message,
    isResume: Boolean(resume && conversationId),
  });
  const fingerprint = createHash('sha256').update(JSON.stringify({
    workspace, fullPrompt, model: model ?? null, effort: effort ?? null,
    conversationId: conversationId ?? null, resume: Boolean(resume && conversationId), command: spec,
  })).digest('hex');

  await mkdir(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const ownerPath = path.join(directory, AGY_TURN_FILES.owner);
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
    const existing = await readAgyTurn(directory).catch(() => null);
    return { accepted: existing ? existing.state === 'running' : true, duplicate: true, workerPid: existing?.workerPid ?? null };
  }

  const state = createAgyTurnState({
    requestId, agentId, taskId, sessionId, conversationId, workspace,
    message, requestedModel: model ?? null, requestedEffort: effort ?? null, route,
  });
  const resolvedCallerEnv = callerEnv ?? reportConfig?.callerEnv ?? null;
  const effectiveTimeoutMs = resolveTurnTimeoutMs({ timeoutMs, timeoutMinutes, config });
  const turn = {
    version: 1,
    requestId: requestId ?? null,
    agentId: agentId ?? null,
    taskId: taskId ?? null,
    sessionId: sessionId ?? null,
    workspace,
    prompt: fullPrompt,
    rawMessage: message,
    conversationId: conversationId ?? null,
    resume: Boolean(resume && conversationId),
    model: model ?? null,
    effort: effort ?? null,
    timeoutMs: effectiveTimeoutMs,
    reportConfig: reportConfig ?? null,
    callerEnv: resolvedCallerEnv,
    route: route ?? null,
    command: spec.command,
    prefixArgs: spec.prefixArgs,
    startedAt,
    workerPid: null,
  };

  await writeFile(path.join(directory, AGY_TURN_FILES.prompt), fullPrompt, 'utf8');
  await writeJsonFile(directory, AGY_TURN_FILES.turn, turn);
  await writeJsonFile(directory, AGY_TURN_FILES.state, state);

  const workerEnv = buildCliProxyEnv(managedCliEnv(env), route);
  const worker = await spawnWorker(directory, { env: workerEnv, route });
  const claimedTurn = await readJson(path.join(directory, AGY_TURN_FILES.turn));
  const workerPid = (Number.isSafeInteger(claimedTurn?.workerPid) && claimedTurn.workerPid > 0)
    ? claimedTurn.workerPid
    : (Number.isSafeInteger(worker?.pid) ? worker.pid : null);
  turn.workerPid = workerPid;
  await writeJsonFile(directory, AGY_TURN_FILES.turn, { ...(claimedTurn ?? {}), ...turn, workerPid }).catch(() => undefined);

  return { accepted: true, duplicate: false, workerPid };
}

async function readTerminalSnapshot(directory, turn) {
  const terminal = await readJson(path.join(directory, AGY_TURN_FILES.terminal));
  if (!terminal || terminal.phase !== 'exited' || !TERMINAL_STATES.includes(terminal.state)) return undefined;
  if (!turn || !Object.hasOwn(turn, 'requestId') || terminal.requestId !== turn.requestId) return undefined;
  return terminal;
}

async function readTurnState(directory, turn, { checkTerminal = false } = {}) {
  let state;
  try { state = await readJson(path.join(directory, AGY_TURN_FILES.state)); }
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

async function workerLostError(directory, message, target) {
  const stderr = await readFile(path.join(directory, AGY_TURN_FILES.workerStderr), 'utf8').catch(() => '');
  const prefix = target + '-worker: ';
  const diagnostic = stderr.split(/\r?\n/).find(line => line.startsWith(prefix))?.slice(prefix.length, prefix.length + 400);
  return { code: target.replace(/-cli$/, '') + '-turn-worker-lost',
    message: diagnostic ? message + ' Worker error: ' + redactProxyCredentials(diagnostic) : message };
}

export async function confirmTurnCage(killCage, options) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const proof = await Promise.resolve().then(() => killCage(options)).catch(() => undefined);
    if (proof?.ok === true) return true;
    if (attempt < 2) await delay(100);
  }
  return false;
}

export async function persistTurnCleanupPending(directory, state, hostCode, host) {
  const error = fail(hostCode + '-cage-unverified', host + ' process cleanup could not be confirmed.');
  const heartbeatAt = new Date().toISOString();
  Object.assign(state, { state: 'running', phase: 'cleanup-pending', cleanupPending: true, heartbeatAt,
    error: { code: error.code, message: error.message } });
  await writeJsonFile(directory, AGY_TURN_FILES.state, state, { mode: 0o600, retryMs: 5000 });
  return error;
}

export async function readAgyTurn(directory, { isAlive = processAlive } = {}) {
  const target = 'agy-cli';
  const host = 'Antigravity CLI';
  const turn = await readJson(path.join(directory, AGY_TURN_FILES.turn));
  const marker = await readJson(path.join(directory, AGY_TURN_FILES.cancel));
  const sameMarker = Boolean(marker && turn && Object.hasOwn(turn, 'requestId') && marker.requestId === turn.requestId);
  let state = await readTurnState(directory, turn);
  const alive = !state && Number.isSafeInteger(turn?.workerPid) && isAlive(turn.workerPid);
  if (!state && turn && !alive) state = await readTurnState(directory, turn, { checkTerminal: true });
  if (!state) {
    if (!turn) throw fail(target.replace(/-cli$/, '') + '-turn-not-found', `No ${host} turn is recorded in ${directory}.`);
    const pending = sameMarker && marker.cleanupPending === true;
    const stopped = sameMarker && marker.stopped === true && !alive;
    return {
      directory,
      state: pending || alive ? 'running' : stopped ? 'cancelled' : 'failed',
      requestId: turn.requestId ?? null,
      sessionId: turn.sessionId ?? null,
      conversationId: turn.conversationId ?? null,
      model: null,
      actualEffort: null,
      usage: null,
      messages: [],
      messagesDropped: 0,
      sessionStarted: false,
      ...(pending ? { cleanupPending: true, error: marker.error } : alive || stopped ? {} : {
        error: await workerLostError(directory, `The detached ${host} worker exited before writing state.json.`, target),
      }),
      workerPid: turn.workerPid ?? null,
      agyPid: null,
      lastStep: null,
      lastEventAt: turn.startedAt ?? null,
      startedAt: turn.startedAt ?? null,
      endedAt: null,
    };
  }

  const workerPid = recordedWorkerPid(turn, state);
  const agyPid = Number.isSafeInteger(state.pid) && state.pid > 0 ? state.pid : null;
  const owned = [...new Set([workerPid, agyPid].filter(pid => pid !== null))];
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
  const stopped = sameMarker && marker.stopped === true;
  const cleanupPending = !stopped && (state.cleanupPending === true
    || (sameMarker && marker.cleanupPending === true));
  if (cleanupPending) {
    reported = 'running';
    error = state.cleanupPending ? state.error : marker.error;
  } else if (!TERMINAL_STATES.includes(reported)) {
    if (stopped && !alivePids.length) {
      reported = 'cancelled';
      error = undefined;
    } else if (alivePids.length) {
      // At least one owned process is still running.
    } else if (owned.length) {
      reported = 'failed';
      error = await workerLostError(directory,
        `The detached ${host} worker exited without recording a final state, and no owned process remains.`, target);
    } else if (!fresh) {
      reported = 'failed';
      error = await workerLostError(directory,
        `The detached ${host} worker missed its heartbeat window and is treated as gone.`, target);
    }
  }

  return {
    directory,
    state: reported === 'completed' ? 'ended' : reported,
    ...(cleanupPending ? { cleanupPending: true } : {}),
    requestId: state.requestId ?? turn?.requestId ?? null,
    sessionId: state.sessionId ?? turn?.sessionId ?? null,
    conversationId: state.conversationId ?? turn?.conversationId ?? null,
    model: state.model ?? null,
    requestedModel: state.requestedModel ?? turn?.model ?? null,
    actualEffort: state.actualEffort ?? state.requestedEffort ?? turn?.effort ?? null,
    usage: state.usage ?? null,
    ...(state.usageDetails ? { usageDetails: state.usageDetails } : {}),
    ...(state.sessionCwd ? { sessionCwd: state.sessionCwd } : {}),
    messages: state.messages ?? [],
    messagesDropped: state.messagesDropped ?? 0,
    ...(error ? { error } : {}),
    sessionStarted: state.sessionStarted === true,
    notSent: state.notSent === true || state.error?.notSent === true,
    workerPid,
    agyPid,
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

function ownsTurnProcess(identity, { directory, conversationId, requestId, startedAt }) {
  const text = String(identity?.text ?? '').toLowerCase();
  if (!text) return false;
  if (identity?.creationDate && startedAt) {
    const createdMs = Date.parse(identity.creationDate);
    const turnMs = Date.parse(startedAt);
    if (Number.isFinite(createdMs) && Number.isFinite(turnMs) && createdMs < turnMs - 120000) return false;
  }
  const normalizedDir = directory ? path.resolve(directory).toLowerCase() : '';
  const markers = [normalizedDir, directory, conversationId, requestId]
    .filter(marker => typeof marker === 'string' && marker.length > 8);
  return markers.some(marker => text.includes(marker.toLowerCase()));
}

async function markCancelled(directory, state) {
  const time = new Date().toISOString();
  await writeJsonFile(directory, AGY_TURN_FILES.state, {
    ...state,
    state: 'cancelled',
    phase: 'exited',
    cleanupPending: false,
    updatedAt: time,
    heartbeatAt: time,
    endedAt: state.endedAt ?? time,
    error: null,
  });
}

export async function cancelAgyTurn(directory, options = {}) {
  try { return await stopAgyTurn(directory, options); }
  catch (error) {
    if (error?.code !== 'preempt-cage-still-running' && error?.code !== 'turn-cage-unverified') throw error;
    if (options.expectedRequestId !== undefined) throw error;
    return { ok: false, cancelled: false, stopped: false, cleanupPending: true, state: 'running',
      pids: error.pids, remaining: error.remaining, note: error.message };
  }
}

async function stopAgyTurn(directory, { expectedRequestId,
  isAlive = processAlive,
  killTree = killProcessTree,
  killCage = killTree === killProcessTree ? killProcessCage : async () => ({ ok: true, killed: [] }),
  commandLines = readProcessIdentities,
  confirmMs = CANCEL_CONFIRM_MS,
} = {}) {
  const turn = await readJson(path.join(directory, AGY_TURN_FILES.turn));
  if (expectedRequestId !== undefined && turn?.requestId !== expectedRequestId) {
    return { ok: false, stopped: false, note: 'The original turn request does not match.' };
  }
  // A native session survives multiple turns. Scope preemption to this request.
  const state = await readTurnState(directory, turn, { checkTerminal: true });
  const pids = {
    worker: recordedWorkerPid(turn, state),
    agy: Number.isSafeInteger(state?.pid) && state.pid > 0 ? state.pid : null,
  };
  if (!state && !turn) {
    return { ok: true, cancelled: false, stopped: true, state: null, pids, remaining: [] };
  }
  const recorded = [...new Set([pids.worker, pids.agy].filter(pid => Number.isSafeInteger(pid) && pid > 0))];
  const alive = () => recorded.filter(pid => isAlive(pid));
  const requestedAt = new Date().toISOString();
  const requestId = state?.requestId ?? turn?.requestId ?? null;
  const sessionId = state?.sessionId ?? turn?.sessionId ?? null;
  const marker = await readJson(path.join(directory, AGY_TURN_FILES.cancel));
  const pendingStop = marker?.requestId === requestId && marker?.cleanupPending === true;
  const cleanupCode = expectedRequestId === undefined ? 'turn-cage-unverified' : 'preempt-cage-still-running';
  const writeStop = (stopped, remaining = [], fields = {}) => writeJsonFile(directory, AGY_TURN_FILES.cancel,
    { requestId, requestedAt, stopped, remaining, pids, ...fields });
  const unverifiedStop = async (remaining, message) => {
    await writeStop(false, remaining, { cleanupPending: true, error: { code: cleanupCode, message } });
    return { ok: false, cancelled: false, stopped: false, cleanupPending: true, state: 'running', pids, remaining, note: message };
  };
  const stopCage = async options => {
    const proved = await confirmTurnCage(killCage,
      expectedRequestId === undefined ? options : { ...options, sessionId: undefined });
    if (proved) return;
    const pending = await unverifiedStop(alive(), 'The original process cage could not be reaped.');
    throw fail(cleanupCode, pending.note, { pids, remaining: pending.remaining });
  };
  const markers = {
    directory,
    conversationId: expectedRequestId === undefined ? state?.conversationId ?? turn?.conversationId ?? null : undefined,
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
          return unverifiedStop(stillOurs, `Processes still alive after terminal cleanup: ${stillOurs.join(', ')}.`);
        }
        if (pendingStop) await writeStop(true);
        return { ok: true, cancelled: state.state === 'cancelled', stopped: true, state: state.state, pids, remaining: [] };
      }
      await stopCage({ pids: [], turnDir: directory, runId: requestId, sessionId });
      const nonReused = surviving.filter(pid => isAlive(pid) && !reused.includes(pid));
      if (nonReused.length) {
        return unverifiedStop(nonReused, 'Recorded processes are still alive and their ownership could not be verified.');
      }
      if (pendingStop) await writeStop(true);
      return { ok: true, cancelled: state.state === 'cancelled', stopped: true, state: state.state, pids, remaining: [] };
    }
    await stopCage({ pids: [], turnDir: directory, runId: requestId, sessionId });
    if (pendingStop) await writeStop(true);
    return { ok: true, cancelled: state.state === 'cancelled', stopped: true, state: state.state, pids, remaining: [] };
  }

  if (!recorded.length && !state?.cleanupPending && !pendingStop) {
    await stopCage({ pids: [], turnDir: directory, runId: requestId, sessionId });
    return { ok: false, cancelled: false, stopped: false, state: 'running', pids, remaining: [],
      note: 'Worker has not recorded any pid yet; retry cancel shortly.' };
  }

  if (!pendingStop) await writeStop(null);
  const targets = alive();
  if (!targets.length) {
    await stopCage({ pids: [], turnDir: directory, runId: requestId, sessionId });
    const latest = await readTurnState(directory, turn, { checkTerminal: true });
    const current = TERMINAL_STATES.includes(latest?.state) ? latest.state : 'cancelled';
    if (!TERMINAL_STATES.includes(latest?.state) && (latest ?? state)) {
      await markCancelled(directory, latest ?? state);
    }
    await writeStop(true);
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
    return unverifiedStop(targets, `Process identity for (${targets.join(', ')}) could not be verified, so nothing was killed.`);
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
    return unverifiedStop(remaining, `Processes still alive after kill attempt: ${remaining.join(', ')}.`);
  }

  const latest = await readTurnState(directory, turn, { checkTerminal: true });
  await writeStop(true);
  if (!TERMINAL_STATES.includes(latest?.state) && (latest ?? state)) {
    await markCancelled(directory, latest ?? state);
  }
  return { ok: true, cancelled: true, stopped: true, state: TERMINAL_STATES.includes(latest?.state) ? latest.state : 'cancelled', pids, remaining: [] };
}
