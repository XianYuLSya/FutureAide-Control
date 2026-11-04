// Claude Desktop local inbox transport. No model, UI, installer, or background worker.
// Framing follows Anthropic's cross-session messaging documentation and the MIT
// KeeVeeG desktop bridge. See THIRD_PARTY_NOTICES.md.
import { readFile, readdir, open } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:net';

const exec = promisify(execFile);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const configRoot = env => path.resolve(env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'));
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));

function pipeName(value) {
  if (typeof value !== 'string' || !/^\\\\[.?]\\pipe\\(?:LOCAL\\)?[^\\/\r\n\0]+$/i.test(value)) {
    throw new Error('claude-inbox-invalid-pipe');
  }
  return value.replace(/^\\\\\?\\/, '\\\\.\\').toLowerCase();
}

export async function discoverClaude({ env = process.env } = {}) {
  const directory = path.join(configRoot(env), 'sessions');
  let files;
  try { files = await readdir(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return { available: false, reason: 'session-directory-missing', sessions: [] };
    throw error;
  }
  const sessions = [];
  for (const file of files.filter(name => /^[1-9][0-9]*\.json$/.test(name))) {
    try {
      const value = await json(path.join(directory, file));
      if (value.entrypoint !== 'claude-desktop' || String(value.pid) + '.json' !== file) continue;
      process.kill(value.pid, 0);
      pipeName(value.messagingSocketPath);
      sessions.push({ pid: value.pid, sessionId: value.sessionId, name: value.name,
        cwd: value.cwd, status: value.status, version: value.version });
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code) && error.message !== 'claude-inbox-invalid-pipe') throw error;
    }
  }
  return { available: true, sessions };
}

// This binding is internal to the host adapter. It is never a user-facing tool argument.
export async function bindClaude({ pid, sessionId, workspace }, { env = process.env } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[a-f0-9-]{36}$/i.test(sessionId ?? '')) {
    throw new Error('claude-binding-invalid');
  }
  const directory = path.join(configRoot(env), 'sessions');
  const recordFile = path.join(directory, `${pid}.json`);
  const record = await json(recordFile);
  if (record.pid !== pid || record.sessionId !== sessionId || record.entrypoint !== 'claude-desktop'
      || !samePath(record.cwd, workspace) || record.pidDomain !== `win32:${hostname().toLowerCase()}`
      || !/^[0-9]+$/.test(record.procStart ?? '')) throw new Error('claude-binding-mismatch');
  const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc().ToString()`],
  { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (stdout.trim() !== record.procStart) throw new Error('claude-process-replaced');
  const socketPath = pipeName(record.messagingSocketPath);
  return { pid, sessionId, workspace: path.resolve(workspace), directory, recordFile,
    socketPath, procStart: record.procStart, pidDomain: record.pidDomain,
    transcriptFile: await findTranscript(configRoot(env), sessionId) };
}

async function findTranscript(root, sessionId) {
  const directory = path.join(root, 'projects');
  const matches = [];
  for (const project of await readdir(directory, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const file = path.join(directory, project.name, `${sessionId}.jsonl`);
    try { const handle = await open(file, 'r'); await handle.close(); matches.push(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (matches.length !== 1) throw new Error('claude-transcript-unresolved');
  return matches[0];
}

export function currentRecord(binding) {
  let text;
  // A record belongs to one process: a restarted session writes a new file under its
  // new pid and the old one goes away, so a missing file is a changed session.
  try { text = readFileSync(binding.recordFile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('claude-session-changed'); throw error; }
  const value = JSON.parse(text);
  if (value.sessionId !== binding.sessionId || value.pid !== binding.pid || value.procStart !== binding.procStart
      || value.pidDomain !== binding.pidDomain || value.entrypoint !== 'claude-desktop'
      || !samePath(value.cwd, binding.workspace) || pipeName(value.messagingSocketPath) !== binding.socketPath) {
    throw new Error('claude-session-changed');
  }
  // A crashed process leaves its record behind, so a matching file alone proves nothing.
  try { process.kill(value.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') throw new Error('claude-session-changed'); throw error; }
  return value;
}

export async function sendClaude(binding, message, { requestId = randomUUID(), timeoutMs = 10000, priority = 'next' } = {}) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('claude-message-empty');
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(requestId)) throw new Error('claude-request-id-invalid');
  if (!['next', 'now'].includes(priority)) throw new Error('claude-priority-invalid');
  currentRecord(binding);
  const keyName = `${binding.pid}.${createHash('sha256').update(binding.socketPath).digest('hex')}.key`;
  const key = await json(path.join(binding.directory, keyName)).catch(error => {
    throw error.code === 'ENOENT' ? new Error('claude-inbox-key-mismatch') : error;
  });
  if (!/^[a-f0-9]{32}$/i.test(key.peerToken ?? '') || (key.procStartFt ?? key.procStart) !== binding.procStart
      || key.pidDomain !== binding.pidDomain) throw new Error('claude-inbox-key-mismatch');
  const body = message.replace(/<\/cross-session-message\b/gi, '<\\/cross-session-message');
  const frame = { type: 'user', uuid: requestId, priority, from: 'FutureAide Control',
    session_id: binding.sessionId, message: { role: 'user',
      content: `<cross-session-message from-name="FutureAide Control">\n[FutureAide request ${requestId}]\n${body}\n</cross-session-message>` } };
  const payload = `${JSON.stringify({ type: 'auth', token: key.peerToken })}\n${JSON.stringify(frame)}\n`;
  if (payload.length > 1048576) throw new Error('claude-message-too-large');
  const started = performance.now();
  return new Promise(resolve => {
    let settled = false, attempted = false, written = false, ended = false;
    const socket = connect({ path: binding.socketPath, allowHalfOpen: true });
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ requestId, status: error ? (attempted ? 'uncertain' : 'failed') : 'written',
        acknowledged: false, elapsedMs: Math.round(performance.now() - started), ...(error ? { error } : {}) });
    }
    socket.once('connect', () => {
      try { currentRecord(binding); } catch { finish('claude-session-changed'); return; }
      attempted = true;
      socket.end(payload);
    });
    socket.once('finish', () => { written = true; if (ended) finish(); });
    socket.once('end', () => { ended = true; if (written) finish(); });
    socket.on('data', () => {}); // The native protocol has no model-acceptance response frame.
    socket.once('error', error => finish(error.code || 'socket-error'));
    socket.once('close', hadError => { if (!settled) finish(!hadError && written && ended ? null : 'closed'); });
  });
}

// The observer retains only the small fields needed to pair reports/file writes.
// It never retains thinking blocks, complete tool output, or code/file contents.
const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n') : '';
export function reportReceipt(content, depth = 0) {
  if (depth > 4) return undefined;
  if (typeof content === 'string') {
    try { return reportReceipt(JSON.parse(content), depth + 1); } catch { return undefined; }
  }
  if (!content || typeof content !== 'object' || content.isError === true) return undefined;
  if (content.accepted === true) return { accepted: true, taskId: content.taskId,
    agentId: content.agentId, kind: content.kind, final: content.final,
    questionId: content.questionId, receiptId: content.receiptId };
  const parts = Array.isArray(content) ? content : content.content;
  for (const part of Array.isArray(parts) ? parts : []) {
    const found = reportReceipt(part?.type === 'text' ? part.text : part, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function toolInput(input) {
  const picked = {};
  for (const key of ['message', 'final', 'file_path', 'path', 'notebook_path', 'description',
    'name', 'subagent_type', 'run_in_background', 'resume', 'task_id', 'agent_id']) {
    if (typeof input?.[key] === 'string' || typeof input?.[key] === 'boolean') picked[key] = input[key];
  }
  return picked;
}

function toolMetadata(value) {
  if (!value || typeof value !== 'object') return undefined;
  const picked = {};
  for (const key of ['agentId', 'taskId', 'status', 'isAsync', 'outputFile', 'filePath', 'type']) {
    if (['string', 'boolean'].includes(typeof value[key])) picked[key] = value[key];
  }
  return Object.keys(picked).length ? picked : undefined;
}

export async function readClaudeEvents(binding, { offset = 0, maxBytes = 1048576, sidechain = false } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid-transcript-offset');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('invalid-transcript-page-size');
  const handle = await open(binding.transcriptFile, 'r');
  try {
    const { size } = await handle.stat();
    if (offset > size) throw new Error('claude-transcript-replaced');
    const buffer = Buffer.alloc(Math.min(maxBytes, size - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const complete = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
    // A full page with no complete line cannot advance. Fail explicitly so an
    // observer does not reread the same bytes forever; it may choose a larger page.
    if (!complete && bytesRead === maxBytes) throw new Error('claude-transcript-line-exceeds-page');
    const events = [], deliveries = [], taskNotifications = [];
    let badLines = 0, lineStart = 0;
    while (lineStart < complete) {
      const lineEnd = buffer.indexOf(10, lineStart);
      const line = buffer.subarray(lineStart, lineEnd).toString('utf8');
      const seq = offset + lineEnd + 1;
      lineStart = lineEnd + 1;
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { badLines++; continue; }
      if (event.sessionId !== binding.sessionId) continue;
      if ((event.isSidechain === true) !== sidechain) continue;
      // Busy-session inbox messages are attachments, not user messages. Native
      // source_uuid correlates them without asking the model to echo our marker.
      const attachment = event.attachment;
      const notification = event.type === 'queue-operation' && typeof event.content === 'string'
        ? event.content : event.type === 'attachment' && attachment?.origin?.kind === 'task-notification'
          ? attachment.prompt : undefined;
      if (typeof notification === 'string' && notification.trimStart().startsWith('<task-notification>')) {
        const taskId = /<task-id>([A-Za-z0-9_-]+)<\/task-id>/.exec(notification)?.[1];
        const status = /<status>(completed|failed|killed|stopped)<\/status>/.exec(notification)?.[1];
        if (taskId && status) taskNotifications.push({ taskId, status: status === 'killed' ? 'stopped' : status,
          toolUseId: /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notification)?.[1], seq, timestamp: event.timestamp,
          evidence: 'native-task-notification' });
      }
      const enqueued = event.type === 'queue-operation' && event.operation === 'enqueue'
        && typeof event.content === 'string'
        ? /^<cross-session-message from-name="FutureAide Control">\r?\n\[FutureAide request ([A-Za-z0-9-]{1,100})\]\r?\n/.exec(event.content) : null;
      if (enqueued) {
        // This is our fixed transport envelope at the start of a native queue
        // record, not an id quoted by the model. The observer still intersects
        // it with persisted request ids; insertion remains a separate receipt.
        deliveries.push({ requestId: enqueued[1], stage: 'accepted', timestamp: event.timestamp, seq });
      } else if (event.type === 'attachment' && attachment?.type === 'queued_command'
          && attachment.origin?.kind === 'peer' && typeof attachment.source_uuid === 'string') {
        deliveries.push({ requestId: attachment.source_uuid, deliveryId: attachment.delivery_id,
          stage: 'accepted', timestamp: event.timestamp, seq });
      } else if (event.type === 'queue-operation' && event.operation === 'remove'
          && event.reason === 'absorbed_mid_turn' && typeof event.commandUuid === 'string') {
        deliveries.push({ requestId: event.commandUuid, deliveryId: event.deliveryId,
          stage: 'inserted', timestamp: event.timestamp, seq });
      } else if (event.type === 'user' && typeof event.uuid === 'string'
          && typeof event.message?.content === 'string') {
        // An idle-session inbox frame retains its UUID as a user message. The
        // caller matches this against its persisted request IDs, never by text.
        deliveries.push({ requestId: event.uuid, stage: 'inserted', timestamp: event.timestamp, seq });
      }
      if (!['user', 'assistant'].includes(event.type)) continue;
      const content = event.message?.content;
      events.push({ type: event.type, uuid: event.uuid, parentUuid: event.parentUuid,
        seq, timestamp: event.timestamp, model: event.message?.model, agentId: event.agentId,
        effort: event.effort ?? event.perTurnEffort, stopReason: event.message?.stop_reason,
        apiError: event.isApiErrorMessage === true,
        text: textOf(content).slice(0, 8000),
        textTruncated: textOf(content).length > 8000,
        tools: Array.isArray(content) ? content.filter(c => c.type === 'tool_use').map(c => ({ id: c.id, name: c.name,
          input: toolInput(c.input) })) : [],
        results: Array.isArray(content) ? content.filter(c => c.type === 'tool_result').map(c => ({ id: c.tool_use_id,
          isError: c.is_error === true, receipt: c.is_error === true ? undefined : reportReceipt(c.content),
          metadata: toolMetadata(event.toolUseResult), summary: textOf(c.content).slice(0, 2000) })) : [] });
    }
    return { events, deliveries, taskNotifications, badLines, offset: offset + complete, size, hasMore: offset + complete < size };
  } finally { await handle.close(); }
}
