// Read-only view of the Claude Desktop session registry.
//
// The only thing this plugin still reads from that application is the identity of
// the calling chat: a caller that presents a native Claude session id is checked
// against the app's own session records before it becomes an owner. Nothing here
// starts, drives, closes or deletes a session — there is no process spawn, no UI
// driver, no deep link and no interrupt — and the desktop application is never
// asked to open, focus or change anything.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const SESSION_FILE = /^([1-9][0-9]*)\.json$/;

const fail = (code, message) => Object.assign(new Error(message), { code });
const configRoot = env => path.resolve(env?.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string'
  && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function defaultIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function normalizeRecord(record, directory) {
  return Object.freeze({
    nativeSessionId: record.sessionId,
    hostSessionId: typeof record.hostSessionId === 'string' ? record.hostSessionId : undefined,
    pid: record.pid,
    name: typeof record.name === 'string' ? record.name : undefined,
    status: record.status,
    workspace: record.cwd,
    procStart: record.procStart,
    pidDomain: record.pidDomain,
    socketPath: record.messagingSocketPath,
    startedAt: record.startedAt,
    version: record.version,
    kind: record.kind,
    entrypoint: record.entrypoint,
    recordFile: path.join(directory, `${record.pid}.json`),
  });
}

/**
 * Every native session record the app has registered, stale files included.
 * `*.key` files (peer tokens) are never opened: the name filter accepts digits
 * only.
 */
export async function scanNativeSessions({ env = process.env, isAlive = defaultIsAlive } = {}) {
  const directory = path.join(configRoot(env), 'sessions');
  let names;
  try { names = await readdir(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return { directory, sessions: [] };
    throw error;
  }
  const sessions = [];
  for (const name of names) {
    const match = SESSION_FILE.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    let record;
    try { record = JSON.parse((await readFile(path.join(directory, name), 'utf8')).replace(/^\uFEFF/, '')); }
    catch { continue; } // a half-written or vanished record is not a session
    if (record?.entrypoint !== 'claude-desktop' || record.pid !== pid || typeof record.sessionId !== 'string') continue;
    sessions.push({ ...normalizeRecord(record, directory), alive: isAlive(record.pid) });
  }
  return { directory, sessions };
}

/**
 * Resolve one native session by the identifier the plugin stored for it.
 * A record for a dead process still resolves and carries `alive: false`.
 */
export async function resolveNativeSession(nativeSessionId, {
  env = process.env, isAlive = defaultIsAlive, workspace,
} = {}) {
  if (typeof nativeSessionId !== 'string' || !nativeSessionId.trim()) {
    throw fail('invalid-native-session', 'nativeSessionId must be the Claude session id string.');
  }
  const { sessions } = await scanNativeSessions({ env, isAlive });
  const matches = sessions.filter(session => session.nativeSessionId === nativeSessionId);
  if (!matches.length) throw fail('unknown-native-session', `Claude Desktop has no registered session ${nativeSessionId}.`);
  if (matches.length > 1) {
    throw fail('ambiguous-native-session', `Claude Desktop registered ${matches.length} processes for session ${nativeSessionId}.`);
  }
  const [record] = matches;
  if (workspace && !samePath(record.workspace, workspace)) {
    throw fail('session-workspace-mismatch',
      `Session ${nativeSessionId} belongs to ${record.workspace}, not ${path.resolve(workspace)}.`);
  }
  return record;
}
