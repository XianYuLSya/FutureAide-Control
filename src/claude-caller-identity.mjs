// Caller identity for the Claude Desktop managed-session report service.
//
// The service is reachable by any process that can open a loopback socket, so it
// never trusts an argument, header or query parameter for identity. Both
// supported transports end at the same verified native session record:
//
//   stdio: the MCP client's parent process, which is the Claude Code session
//          process that spawned this server.
//   HTTP : the TCP peer that opened the connection. One `netstat -ano` read
//          (about 40 ms here; the PowerShell NetTCPIP cmdlets cost about 2.6 s
//          per call and are not used on this path) maps the client's source port
//          to its owning PID, then the PID and its ancestors are looked up in
//          `~/.claude/sessions/<pid>.json`.
//
// A record is accepted only when it is Claude Desktop's own registry record:
// pid and sessionId match the file, `entrypoint` is `claude-desktop`, the pid
// domain is this host, cwd is absolute, and the recorded `procStart` equals the
// live process start time (so a recycled PID cannot inherit a stale record).
// `.key` files, peer tokens and any other credential material are never read.
import { readFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PROMPT_TIMEOUT_MS = 15000;

export const SESSION_ID_PATTERN = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

const fail = (code, message) => Object.assign(new Error(message), { code });

/** The native Claude configuration root; CLAUDE_CONFIG_DIR wins when set. */
export function configRoot(env = process.env) {
  return path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'));
}

export function sessionRecordPath(pid, { env = process.env } = {}) {
  return path.join(configRoot(env), 'sessions', `${pid}.json`);
}

async function runPowerShell(script) {
  const { stdout } = await exec('powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: PROMPT_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

/** Live process start time in the same units the session record uses, or null. */
export async function processStartTime(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const value = await runPowerShell(`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`);
    return /^\d+$/.test(value) ? value : null;
  } catch { return null; }
}

/** Parent PID of a live process, or null when it cannot be read. */
export async function parentProcessId(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const value = await runPowerShell(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop).ParentProcessId.ToString()`);
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch { return null; }
}

/** `netstat -ano -p TCP` rows, parsed into the fields identity needs. */
export function parseTcpConnections(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || !/^TCP$/i.test(fields[0])) continue;
    const local = fields[1] ?? '';
    const remote = fields[2] ?? '';
    const state = fields[3] ?? '';
    const pid = Number.parseInt(fields[4], 10);
    const [localAddress, localPort] = splitEndpoint(local);
    const [remoteAddress, remotePort] = splitEndpoint(remote);
    if (!localPort || !remotePort || !Number.isSafeInteger(pid)) continue;
    rows.push({ localAddress, localPort, remoteAddress, remotePort, state: state.toUpperCase(), pid });
  }
  return rows;
}

function splitEndpoint(value) {
  const index = value.lastIndexOf(':');
  if (index <= 0) return ['', 0];
  const port = Number.parseInt(value.slice(index + 1), 10);
  return [value.slice(0, index), Number.isSafeInteger(port) && port > 0 ? port : 0];
}

/**
 * Owning PID of the process that opened the connection from `clientPort` to
 * `serverPort`. Windows keeps the ESTABLISHED row for the client side, which is
 * the row that names the client process.
 */
export async function tcpOwnerPid({ clientPort, serverPort },
  { listConnections = async () => parseTcpConnections((await exec('netstat.exe', ['-ano', '-p', 'TCP'],
    { encoding: 'utf8', windowsHide: true, timeout: PROMPT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout) } = {}) {
  if (!Number.isSafeInteger(clientPort) || clientPort <= 0 || !Number.isSafeInteger(serverPort) || serverPort <= 0) return null;
  const rows = await listConnections();
  const match = rows.find(row => row.localPort === clientPort && row.remotePort === serverPort
    && row.state === 'ESTABLISHED' && row.pid > 0);
  return match?.pid ?? null;
}

/**
 * Verify one registry record against the live process. Each check fails closed:
 * a mismatch returns a reason instead of a usable identity.
 */
export async function verifySessionRecord(record, pid, { startTime = processStartTime, cache, now = () => Date.now(),
  isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } } } = {}) {
  if (!record || typeof record !== 'object') return { ok: false, code: 'session-record-missing' };
  if (record.pid !== pid) return { ok: false, code: 'session-record-pid-mismatch' };
  if (record.entrypoint !== 'claude-desktop') return { ok: false, code: 'session-entrypoint-mismatch' };
  if (!SESSION_ID_PATTERN.test(record.sessionId ?? '')) return { ok: false, code: 'session-id-invalid' };
  if (record.pidDomain !== `win32:${hostname().toLowerCase()}`) return { ok: false, code: 'session-pid-domain-mismatch' };
  if (!/^\d+$/.test(String(record.procStart ?? ''))) return { ok: false, code: 'session-proc-start-missing' };
  if (typeof record.cwd !== 'string' || !path.isAbsolute(record.cwd)) return { ok: false, code: 'session-cwd-invalid' };
  if (!isAlive(pid)) return { ok: false, code: 'session-process-gone' };
  const matches = cache
    ? await cache.verify(pid, String(record.procStart), startTime, now)
    : await matchesStartTime(pid, String(record.procStart), startTime);
  if (matches === null) return { ok: false, code: 'session-proc-start-unreadable' };
  if (matches === false) return { ok: false, code: 'session-process-replaced' };
  return { ok: true };
}

async function matchesStartTime(pid, procStart, startTime) {
  try {
    const live = await startTime(pid);
    return typeof live === 'string' ? live === procStart : null;
  } catch { return null; }
}

/** Bounded verification cache: procStart lookups are slow and rarely change. */
export function createStartTimeCache({ ttlMs = 300000 } = {}) {
  const entries = new Map();
  return {
    async verify(pid, procStart, startTime = processStartTime, now = Date.now) {
      const key = `${pid}:${procStart}`;
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.matches;
      let matches = null;
      try { const live = await startTime(pid); matches = typeof live === 'string' ? live === procStart : null; }
      catch { matches = null; }
      if (matches !== null) entries.set(key, { matches, at: now() });
      return matches;
    },
  };
}

/**
 * Walk from `startPid` up to `maxDepth` ancestors and return the first session
 * record that verifies. Returns null (never a guess) when nothing matches.
 */
export async function resolveSessionOwner(startPid, {
  env = process.env, maxDepth = 3, readRecord = readSessionRecord, startTime = processStartTime,
  parentOf = parentProcessId, cache, now = () => Date.now(),
  isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } },
} = {}) {
  if (!Number.isSafeInteger(startPid) || startPid <= 0) return null;
  const chain = [];
  let pid = startPid;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    chain.push(pid);
    const record = await readRecord(pid, { env });
    if (record) {
      const verdict = await verifySessionRecord(record, pid, { startTime, cache, now, isAlive });
      if (verdict.ok) return { record, pid, depth, chain };
      // A record that exists but does not verify is a hard stop: walking to the
      // parent would swap one session's identity for another.
      return { refusal: { ...verdict, pid, chain } };
    }
    if (depth === maxDepth) break;
    let next = null;
    try { next = await parentOf(pid); } catch { next = null; }
    if (!Number.isSafeInteger(next) || next <= 0 || chain.includes(next)) break;
    pid = next;
  }
  return null;
}

export async function readSessionRecord(pid, { env = process.env } = {}) {
  try {
    const text = await readFile(sessionRecordPath(pid, { env }), 'utf8');
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

const callerOf = ({ record, pid, depth }) => ({
  pid, sessionId: record.sessionId, cwd: record.cwd,
  name: typeof record.name === 'string' ? record.name : undefined,
  procStart: String(record.procStart), via: depth === 0 ? 'pid' : 'parent-pid',
});

const refuse = (code, message) => fail(code, message);
const notSession = (detail) => refuse('caller-unresolved',
  `This connection does not belong to a Claude Desktop managed session${detail ? ` (${detail})` : ''}. `
  + 'Report and question tools are only available to plugin-owned sessions; no argument can supply an identity.');

/** Identity for the stdio transport: the process that spawned this server. */
export async function resolveStdioCaller({ parentPid = process.ppid, ...options } = {}) {
  const owner = await resolveSessionOwner(parentPid, options);
  if (!owner) throw notSession('no verified session record for the parent process');
  if (owner.refusal) throw notSession(owner.refusal.code);
  return callerOf(owner);
}

/** Identity for the loopback HTTP transport: the TCP peer's owning process. */
export async function resolveSocketCaller(socket, { serverPort, tcpOwner = tcpOwnerPid, ...options } = {}) {
  const clientPort = socket?.remotePort;
  const localPort = Number.isSafeInteger(serverPort) ? serverPort : socket?.localPort;
  const pid = await tcpOwner({ clientPort, serverPort: localPort });
  if (!pid) throw notSession('the TCP peer could not be mapped to a process');
  const owner = await resolveSessionOwner(pid, options);
  if (!owner) throw notSession('the TCP peer is not a Claude Desktop session');
  if (owner.refusal) throw notSession(owner.refusal.code);
  return callerOf(owner);
}
