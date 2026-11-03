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

function currentRecord(binding) {
  const value = JSON.parse(readFileSync(binding.recordFile, 'utf8'));
  if (value.sessionId !== binding.sessionId || value.pid !== binding.pid || value.procStart !== binding.procStart
      || value.pidDomain !== binding.pidDomain || value.entrypoint !== 'claude-desktop'
      || !samePath(value.cwd, binding.workspace) || pipeName(value.messagingSocketPath) !== binding.socketPath) {
    throw new Error('claude-session-changed');
  }
  return value;
}

export async function sendClaude(binding, message, { requestId = randomUUID(), timeoutMs = 10000 } = {}) {
  if (typeof message !== 'string' || !message.trim()) throw new Error('claude-message-empty');
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(requestId)) throw new Error('claude-request-id-invalid');
  currentRecord(binding);
  const keyName = `${binding.pid}.${createHash('sha256').update(binding.socketPath).digest('hex')}.key`;
  const key = await json(path.join(binding.directory, keyName));
  if (!/^[a-f0-9]{32}$/i.test(key.peerToken ?? '') || (key.procStartFt ?? key.procStart) !== binding.procStart
      || key.pidDomain !== binding.pidDomain) throw new Error('claude-inbox-key-mismatch');
  const body = message.replace(/<\/cross-session-message\b/gi, '<\\/cross-session-message');
  const frame = { type: 'user', uuid: requestId, priority: 'next', from: 'FutureAide Control',
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

export async function readClaudeEvents(binding, { offset = 0, maxBytes = 1048576 } = {}) {
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
    const events = [], deliveries = [];
    for (const line of buffer.subarray(0, complete).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.sessionId !== binding.sessionId) continue;
      // Busy-session inbox messages are attachments, not user messages. Native
      // source_uuid correlates them without asking the model to echo our marker.
      const attachment = event.attachment;
      if (event.type === 'attachment' && attachment?.type === 'queued_command'
          && attachment.origin?.kind === 'peer' && typeof attachment.source_uuid === 'string') {
        deliveries.push({ requestId: attachment.source_uuid, deliveryId: attachment.delivery_id,
          stage: 'accepted', timestamp: event.timestamp });
      } else if (event.type === 'queue-operation' && event.operation === 'remove'
          && event.reason === 'absorbed_mid_turn' && typeof event.commandUuid === 'string') {
        deliveries.push({ requestId: event.commandUuid, deliveryId: event.deliveryId,
          stage: 'inserted', timestamp: event.timestamp });
      }
      if (!['user', 'assistant'].includes(event.type)) continue;
      const content = event.message?.content;
      events.push({ type: event.type, uuid: event.uuid, timestamp: event.timestamp, model: event.message?.model,
        effort: event.effort ?? event.perTurnEffort, stopReason: event.message?.stop_reason,
        text: typeof content === 'string' ? content : (content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n'),
        tools: Array.isArray(content) ? content.filter(c => c.type === 'tool_use').map(c => ({ id: c.id, name: c.name })) : [] });
    }
    return { events, deliveries, offset: offset + complete, size, hasMore: offset + complete < size };
  } finally { await handle.close(); }
}
