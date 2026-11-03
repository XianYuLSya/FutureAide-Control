// First-list self-binding and root-call evidence for the report surface.
//
// A managed Claude session connects to the shared tool endpoint before the plugin
// has bound it, and a stateless transport cannot push a tools/list_changed after
// the fact. So the surface adopts the session itself, under rules that cannot bind
// the wrong one:
//
//   adoptFirstListBinding: the caller is already authenticated (pid, session id,
//     procStart, cwd). If it is unbound, look for an existing name that is
//     claude-desktop, open, in the same workspace, still unbound, carrying a
//     binding nonce and a first request that was actually attempted. Then confirm
//     it from this session's own transcript opener: the request+binding marker
//     line must appear exactly once as the first input. Only a unique match is
//     written, with one guarded UPDATE that never overwrites an existing binding
//     or the projection beside it.
//
//   matchRootCall: a question or report is accepted only while the root transcript
//     shows the matching tool_use and no result for it yet. A sub-agent shares the
//     process and the connection, so its calls exist only in sidechain records and
//     can never satisfy this check.
//
// Everything here is read-only apart from that single guarded UPDATE. No second
// database, no file writes, no keys or credentials, and no scanning of sessions
// other than the caller's own transcript.
// Everything here reuses the host adapter's own readers: `markerLine`,
// `findTranscript` and `firstTurnBinding` (which reads the transcript head with
// `readTranscriptHead` and compares the marker against the first real enqueue/user
// input via `firstInputOf`). One raw tail read remains, for the root-call gate
// only: `readTranscriptEvents` normalises events down to text, so tool_use and
// tool_result blocks never reach a caller. When that reader carries them, this
// module's tail helper goes away.
import { open } from 'node:fs/promises';
import { firstTurnBinding, findTranscript, markerLine } from './claude-host.mjs';

/**
 * Exact registered tool names as Claude reports them in a transcript. The prefix
 * is `mcp__<config key>__<tool>`, and the plugin's config key is
 * `futureaide-report`; the underscore spelling is kept because the observer
 * accepts both. A bare `report_parent` is never treated as a registered tool.
 */
export const REPORT_TOOL_ALLOWLIST = Object.freeze([
  'mcp__futureaide-report__ask_parent',
  'mcp__futureaide-report__report_parent',
  'mcp__futureaide_report__ask_parent',
  'mcp__futureaide_report__report_parent',
]);

const TAIL_BYTES = 512 * 1024;

export function reportToolKind(name) {
  if (typeof name !== 'string') return undefined;
  if (name.endsWith('__ask_parent')) return 'question';
  if (name.endsWith('__report_parent')) return 'report';
  return undefined;
}

/**
 * Why a submission was refused when it is not backed by a root tool call. The
 * code is what the model reads, so it names the situation instead of guessing.
 */
const refusal = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);

const transcriptCache = new Map();

/** The caller's own transcript file, resolved once per session. */
export async function transcriptPathFor({ sessionId, workspace, env = process.env } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  const key = `${sessionId}|${workspace ?? ''}|${env.CLAUDE_CONFIG_DIR ?? ''}`;
  const cached = transcriptCache.get(key);
  if (cached) return cached;
  const file = await findTranscript({ env, nativeSessionId: sessionId, workspace }).catch(() => undefined);
  if (file) transcriptCache.set(key, file);
  return file;
}

/** Whole records from the end of a transcript; a cut first line is dropped. */
export async function readTailRecords(file, { maxBytes = TAIL_BYTES } = {}) {
  if (!file) return [];
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    if (!buffer.length) return [];
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const cut = text.indexOf('\n');
      text = cut === -1 ? '' : text.slice(cut + 1);
    }
    const records = [];
    for (const line of text.split('\n')) {
      const value = line.trim();
      if (!value) continue;
      try { records.push(JSON.parse(value)); } catch { /* partial or foreign line */ }
    }
    return records;
  } finally { await handle.close(); }
}

/**
 * Report tool calls in these records that have no result yet. Sidechain records are
 * excluded: they belong to a sub-agent, not to the session that reports.
 */
export function pendingRootCalls(records, { allowlist = REPORT_TOOL_ALLOWLIST } = {}) {
  const allowed = new Set(allowlist);
  const answered = new Set();
  const uses = [];
  for (const record of Array.isArray(records) ? records : []) {
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') answered.add(part.tool_use_id);
      if (part?.type === 'tool_use' && allowed.has(part.name) && typeof part.id === 'string') {
        uses.push({ id: part.id, name: part.name, kind: reportToolKind(part.name),
          input: part.input && typeof part.input === 'object' ? part.input : {},
          sidechain: record?.isSidechain === true });
      }
    }
  }
  return uses.filter(use => !use.sidechain && !answered.has(use.id));
}

/**
 * Decide whether this submission is the root session's own call.
 * @returns {{matched: boolean, id?: string, by?: string, reason?: string}}
 */
export function matchRootCall(records, { tool, message, final = false, toolUseId,
  allowlist = REPORT_TOOL_ALLOWLIST } = {}) {
  const pending = pendingRootCalls(records, { allowlist });
  if (typeof toolUseId === 'string' && toolUseId) {
    return pending.some(call => call.id === toolUseId)
      ? { matched: true, id: toolUseId, by: 'tool-use-id' }
      : { matched: false, reason: 'no-pending-root-call', by: 'tool-use-id', pending: pending.length };
  }
  const wanted = pending.filter(call => call.kind === tool
    && typeof call.input.message === 'string' && call.input.message === message
    && (tool !== 'report' || (call.input.final === true) === (final === true)));
  if (wanted.length === 1) return { matched: true, id: wanted[0].id, by: 'unique-message', pending: pending.length };
  if (!wanted.length) return { matched: false, reason: 'no-pending-root-call', by: 'unique-message', pending: pending.length };
  return { matched: false, reason: 'ambiguous-pending-root-calls', by: 'unique-message',
    ids: wanted.map(call => call.id), pending: pending.length };
}

/**
 * Names that could belong to this caller: same workspace, claude-desktop, open,
 * still unbound, with a nonce and an attempted first request.
 */
export function pendingCreations(store, workspace) {
  if (typeof workspace !== 'string' || !workspace) return [];
  return store.db.prepare(`SELECT a.id AS agentId, a.name AS name,
      json_extract(b.body,'$.bindingNonce') AS bindingNonce,
      (SELECT key FROM json_each(json_extract(b.body,'$.requests'))
        WHERE json_extract(value,'$.attempted') = 1 ORDER BY key LIMIT 1) AS requestId
    FROM backend_state AS b JOIN agents AS a ON a.id = b.agent
    WHERE json_extract(a.body,'$.target') = 'claude-desktop'
      AND coalesce(json_extract(a.body,'$.closed'),0) = 0
      AND lower(json_extract(a.body,'$.workspace')) = lower(?)
      AND json_extract(b.body,'$.binding') IS NULL
      AND coalesce(json_extract(b.body,'$.bindingNonce'),'') <> ''
      AND EXISTS (SELECT 1 FROM json_each(json_extract(b.body,'$.requests'))
        WHERE json_extract(value,'$.attempted') = 1)`).all(workspace)
    .filter(row => typeof row.agentId === 'string' && typeof row.requestId === 'string' && typeof row.bindingNonce === 'string');
}

/**
 * Write the native binding for exactly this candidate, one time. The guards keep
 * another writer's projection or an existing binding intact, and `onBound` may
 * still write the same native id again afterwards.
 */
export function bindPendingCreation(store, { agentId, caller, requestId, bindingNonce }) {
  const binding = {
    sessionId: caller.sessionId,
    pid: caller.pid,
    workspace: caller.cwd,
    directory: caller.directory,
    recordFile: caller.recordFile,
    socketPath: caller.socketPath,
    procStart: caller.procStart,
    pidDomain: caller.pidDomain,
    transcriptFile: caller.transcriptFile,
    ...(caller.hostSessionId ? { hostSessionId: caller.hostSessionId } : {}),
    ...(caller.name ? { name: caller.name } : {}),
    boundBy: 'report-first-list',
    boundAt: new Date().toISOString(),
  };
  const result = store.db.prepare(`UPDATE backend_state SET body = json_set(body, '$.binding', json(?1))
    WHERE agent = ?2
      AND json_extract(body,'$.binding') IS NULL
      AND coalesce(json_extract(body,'$.bindingNonce'),'') = ?3
      AND EXISTS (SELECT 1 FROM json_each(json_extract(body,'$.requests'))
        WHERE key = ?4 AND json_extract(value,'$.attempted') = 1)
      AND EXISTS (SELECT 1 FROM agents AS a WHERE a.id = backend_state.agent
        AND json_extract(a.body,'$.target') = 'claude-desktop'
        AND coalesce(json_extract(a.body,'$.closed'),0) = 0
        AND lower(json_extract(a.body,'$.workspace')) = lower(?5))`)
    .run(JSON.stringify(binding), agentId, bindingNonce, requestId, caller.cwd);
  return result.changes === 1 ? binding : undefined;
}

/**
 * Adopt the pending creation this caller proves it owns, or nothing.
 *
 * The head read is the host's own: `firstTurnBinding` resolves the transcript,
 * reads its opening with `readTranscriptHead` and compares the marker against the
 * first real enqueue/user input via `firstInputOf`. Nothing here re-implements
 * that. No pending creation answers immediately; a pending one may wait up to
 * `timeoutMs` for the opening marker to be written — the transcript may not even
 * exist yet, which is exactly what the wait is for. The client is never assumed to
 * re-list, so the caller re-reads ownership itself.
 */
export async function adoptFirstListBinding({ store, caller, env = process.env, timeoutMs = 3000,
  pollMs = 100, now = () => Date.now(), sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  candidates = pendingCreations, confirm = firstTurnBinding, bind = bindPendingCreation } = {}) {
  const started = now();
  if (!store?.db || typeof caller?.sessionId !== 'string' || !caller.sessionId || typeof caller.cwd !== 'string') {
    return { adopted: false, reason: 'caller-incomplete' };
  }
  const record = { nativeSessionId: caller.sessionId, workspace: caller.cwd };
  for (;;) {
    const list = candidates(store, caller.cwd);
    if (!list.length) return { adopted: false, reason: 'no-pending-creation', waitedMs: now() - started };
    const matches = [];
    for (const candidate of list) {
      const marker = markerLine(candidate.requestId, candidate.bindingNonce);
      const found = await confirm({ env, record, marker }).catch(() => undefined);
      if (found?.file && found.firstInput?.hasMarker === true && found.markerCount === 1) {
        matches.push({ candidate, marker, file: found.file });
      }
    }
    if (matches.length > 1) return { adopted: false, reason: 'marker-ambiguous', waitedMs: now() - started };
    if (matches.length === 1) {
      const [{ candidate, file }] = matches;
      const binding = bind(store, { agentId: candidate.agentId, caller: { ...caller, transcriptFile: file },
        requestId: candidate.requestId, bindingNonce: candidate.bindingNonce });
      return binding
        ? { adopted: true, agentId: candidate.agentId, name: candidate.name,
          taskId: candidate.taskId, waitedMs: now() - started }
        : { adopted: false, reason: 'binding-raced', agentId: candidate.agentId, waitedMs: now() - started };
    }
    if (now() - started >= timeoutMs) return { adopted: false, reason: 'marker-timeout', waitedMs: now() - started };
    await sleep(pollMs);
  }
}

/**
 * The submission gate: a report or question is accepted only while the root
 * transcript carries its own call with the same tool and arguments.
 */
export async function requireRootCall({ transcriptFile, tool, message, final, toolUseId, allowlist } = {}) {
  const records = await readTailRecords(transcriptFile);
  const match = matchRootCall(records, { tool, message, final, toolUseId, allowlist });
  if (match.matched) return match;
  if (match.reason === 'ambiguous-pending-root-calls') {
    throw refusal('ambiguous-root-call',
      'More than one open tool call in this session matches this submission; it was not recorded. '
      + 'Report once and wait for the answer instead of repeating the same call.', match);
  }
  throw refusal('not-root-agent',
    'This submission has no open matching tool call in the session transcript. A sub-agent shares this '
    + 'session but its calls are not the session\'s own; only the session itself can report to the main chat.', match);
}
