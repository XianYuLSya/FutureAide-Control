import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FutureAideClient } from './futureaide-api.mjs';
import { requireWorkspace } from './config.mjs';
import { discoverCodexBridge, notifyCodex } from './codex-notify.mjs';
import { HOST_PRESET, hostBridgeRevision, installHostBridge } from './host-install.mjs';
import { readDispatch } from './dispatch.mjs';

export function briefSession(row) {
  const values = row.projections?.values || {};
  return {
    sessionId: row.sessionId,
    running: row.running,
    cwd: row.cwd,
    updatedAt: row.updatedAt,
    parentSessionId: row.parentSessionId,
    title: typeof values.title === 'string' ? values.title : values.title?.title,
    model: values.modelSelection?.next || values.modelSelection?.lastUsed,
    asOfSeq: row.projections?.asOfSeq,
  };
}

export function historyMessages(page, row) {
  const messages = [];
  for (const record of page.records) {
    const event = record.type === 'event' ? record.event : undefined;
    if (!event || !['user/message', 'assistant/message'].includes(event.type)) continue;
    const message = event.data?.message ?? event.data;
    if (event.type === 'user/message' && ['plugin', 'agent-instructions', 'skill-catalog', 'runtime-context', 'time-context'].includes(message.source?.kind)) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const tools = content.filter(part => part.type === 'tool-call').slice(0, 24).map(part => ({ name: String(part.name ?? '').slice(0, 160), id: String(part.id ?? '').slice(0, 200) }));
    if (!text && !tools.length) continue;
    messages.push({ seq: event.seq, time: event.time, role: message.role ?? (event.type === 'user/message' ? 'user' : 'assistant'),
      text: text.slice(0, 8000), ...(text.length > 8000 ? { textTruncated: true } : {}), ...(tools.length ? { tools } : {}) });
  }
  const { records, ...paging } = page;
  let size = 0;
  const bounded = [];
  for (const message of messages.toReversed()) {
    const length = JSON.stringify(message).length;
    if (size + length > 28000) break;
    size += length;
    bounded.unshift(message);
  }
  const trimmed = bounded.length < messages.length;
  const firstSeq = trimmed ? bounded[0]?.seq : records.find(record => Number.isSafeInteger(record.event?.seq))?.event.seq;
  const hasMore = page.hasMore || trimmed;
  return { ...paging, hasMore, ...(hasMore && Number.isSafeInteger(firstSeq) ? { nextThroughSeq: firstSeq - 1 } : {}), view: 'messages', session: briefSession(row), messages: bounded,
    ...(bounded.length < messages.length ? { olderMessagesOmitted: messages.length - bounded.length } : {}),
    scannedRecords: records.length, lastEventType: records.at(-1)?.event?.type,
    ...(messages.length ? {} : { note: 'No completed text messages in this page. The session may still be producing output; use an earlier cursor or events view for diagnostics.' }) };
}

/**
 * A dispatched turn counts as finished only when the newest page ends with a
 * turn/end event newer than the baseline cursor taken before the dispatch.
 * @param {object} page History page returned by the client.
 * @param {number} afterSeq Baseline cursor.
 * @returns {boolean} True when the waited turn has ended.
 */
export function turnEnded(page, afterSeq) {
  const events = (page.records ?? []).filter(record => record.type === 'event' && record.event);
  const last = events.at(-1);
  return Boolean(last && last.event.type === 'turn/end'
    && Number.isSafeInteger(last.event.seq) && last.event.seq > afterSeq);
}

export function createControl(config, { client, notify = notifyCodex, installHost = installHostBridge } = {}) {
  const api = client || new FutureAideClient({
    dataHome: config.dataRoot,
    dshDataHome: config.dshDataRoot,
    target: config.target,
    baseUrl: config.baseUrl,
    instanceFile: config.instanceFile,
    preferredInstanceFile: config.preferredInstanceFile,
    timeoutMs: config.timeoutMs,
    hostBridgeFile: config.hostBridgeFile,
  });
  const permitted = row => requireWorkspace(row.cwd, config.workspace);
  const selected = id => {
    const value = id || config.futureaideSessionId;
    if (!value) throw new Error('Select a FutureAide session first.');
    return value;
  };
  async function checkSession(id) {
    const sessionId = selected(id);
    const row = (await api.listSessions()).items.find(item => item.sessionId === sessionId);
    if (!row || !permitted(row)) throw new Error('Session does not belong to the configured project.');
    return row;
  }

  async function writeOnce(kind, id, requestId, value, operation) {
    const session = typeof id === 'object' ? id : await checkSession(id);
    if (!requestId || !/^[a-zA-Z0-9_.-]{1,120}$/.test(requestId)) throw new Error('Provide a stable request_id containing letters, digits, dots, underscores, or hyphens.');
    const fingerprint = createHash('sha256').update(JSON.stringify([kind, session.sessionId, value])).digest('hex');
    const key = createHash('sha256').update(JSON.stringify([kind, session.sessionId, requestId])).digest('hex');
    const filename = path.join(config.stateDirectory, 'requests', key + '.json');
    await mkdir(path.dirname(filename), { recursive: true });
    const instance = await api.connectionIdentity?.();
    const record = { requestId, kind, sessionId: session.sessionId, fingerprint, ...(instance ? { instance } : {}), status: 'sending', time: new Date().toISOString() };
    try {
      await writeFile(filename, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await readFile(filename, 'utf8')); }
      catch { return { duplicate: true, accepted: false, status: 'unknown', requestId, receipt: filename }; }
      if (previous.fingerprint !== fingerprint) throw new Error('request_id was already used for different content.');
      if (instance && !previous.instance) {
        return { sessionId: session.sessionId, duplicate: true, accepted: false, status: 'unknown', requestId, receipt: filename,
          note: 'This historical receipt has no host identity. Inspect the original session before any new delivery.' };
      }
      const identity = value => { const { instanceFile, ...host } = value; return JSON.stringify(host); };
      if (previous.instance && instance && identity(previous.instance) !== identity(instance)) {
        throw new Error('This request_id belongs to another host instance. Inspect its original receipt; the write was not repeated.');
      }
      return { ...previous.result, ...(Number.isSafeInteger(previous.afterSeq) ? { afterSeq: previous.afterSeq } : {}), sessionId: session.sessionId, duplicate: true, accepted: previous.status === 'accepted', status: previous.status, requestId, receipt: filename };
    }
    try {
      const result = await operation(session.sessionId, async metadata => {
        Object.assign(record, metadata);
        await writeFile(filename, JSON.stringify(record), { mode: 0o600 });
      });
      await writeFile(filename, JSON.stringify({ ...record, status: 'accepted', result }), { mode: 0o600 });
      return { ...result, sessionId: session.sessionId, receipt: filename };
    } catch (error) {
      const status = error.uncertain ? 'unknown' : 'rejected';
      await writeFile(filename, JSON.stringify({ ...record, status }), { mode: 0o600 });
      Object.assign(error, { receipt: filename, sessionId: session.sessionId, requestId,
        ...(Number.isSafeInteger(record.afterSeq) ? { afterSeq: record.afterSeq } : {}) });
      throw error;
    }
  }

  async function sessionCursor(sessionId) {
    const row = (await api.listSessions()).items.find(item => item.sessionId === sessionId);
    const value = row?.projections?.asOfSeq;
    return Number.isSafeInteger(value) ? value : -1;
  }

  /** Read the baseline cursor recorded by an earlier send so wait() can scope that turn. */
  async function receiptCursor(sessionId, requestId) {
    if (typeof requestId !== 'string' || !requestId) return undefined;
    const key = createHash('sha256').update(JSON.stringify(['send', sessionId, requestId])).digest('hex');
    try {
      const record = JSON.parse(await readFile(path.join(config.stateDirectory, 'requests', key + '.json'), 'utf8'));
      const cursor = record?.result?.afterSeq ?? record?.afterSeq;
      return Number.isSafeInteger(cursor) ? cursor : undefined;
    } catch {
      return undefined;
    }
  }

  /** Cursor of the most recent dispatch to this session, for wait() calls made without a request_id. */
  async function latestSendCursor(sessionId) {
    const directory = path.join(config.stateDirectory, 'requests');
    let entries;
    try { entries = await readdir(directory); } catch { return undefined; }
    const candidates = [];
    for (const name of entries) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
        if (record?.kind === 'send' && record.sessionId === sessionId && Number.isSafeInteger(record?.result?.afterSeq)) {
          candidates.push({ afterSeq: record.result.afterSeq, time: Date.parse(record.time ?? '') || 0 });
        }
      } catch { /* unreadable receipts are ignored */ }
    }
    if (!candidates.length) return undefined;
    candidates.sort((left, right) => right.time - left.time);
    return candidates[0].afterSeq;
  }

  /**
   * Shared blocking wait behind wait() and watch(). `withReport` additionally stores the
   * finished reply under state/reports so a client that missed the completion
   * notification can still pick it up instead of losing the result.
   */
  async function awaitTurn({ sessionId, requestId, afterSeq, timeoutSeconds = 45, pollIntervalMs = 1500, maxMessages = 8, capSeconds, withReport }) {
    if (requestId !== undefined && !/^[a-zA-Z0-9_.-]{1,120}$/.test(requestId)) throw new Error('Invalid request_id.');
    const row = await checkSession(sessionId);
    const id = row.sessionId;
    if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > capSeconds) {
      throw new Error(`timeout_seconds must be a number between 0 and ${capSeconds}.`);
    }
    if (typeof pollIntervalMs !== 'number' || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 250 || pollIntervalMs > 60000) {
      throw new Error('poll_interval_ms must be a number between 250 and 60000.');
    }
    let baseline = Number.isSafeInteger(afterSeq) ? afterSeq : undefined;
    if (baseline === undefined) baseline = await receiptCursor(id, requestId);
    if (baseline === undefined && requestId === undefined) baseline = await latestSendCursor(id);
    if (baseline === undefined && requestId !== undefined) throw new Error('No dispatch receipt for this request_id. Supply its original after_seq.');
    if (baseline === undefined) baseline = Number.isSafeInteger(row.projections?.asOfSeq) ? row.projections.asOfSeq : -1;
    const deadline = Date.now() + timeoutSeconds * 1000;
    const pageSize = Math.max(Math.min(Math.max(maxMessages, 1), 100), 20);
    let dispatch = await readDispatch(api, id, { maxMessages: pageSize, workspace: config.workspace, requestId, afterSeq: baseline });
    let ended = dispatch.ended;
    while (!ended && Date.now() < deadline) {
      // Never oversleep past the deadline: a 1s wait must not cost a full poll interval.
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(pollIntervalMs, deadline - Date.now()))));
      dispatch = await readDispatch(api, id, { maxMessages: pageSize, workspace: config.workspace, requestId, afterSeq: baseline });
      ended = dispatch.ended;
    }
    const latest = (await api.listSessions()).items.find(item => item.sessionId === id) ?? row;
    const payload = historyMessages(dispatch.page, latest);
    const messages = (payload.messages ?? []).filter(message => Number.isSafeInteger(message.seq) && message.seq > baseline);
    const result = { state: ended ? 'ended' : 'running', sessionId: id,
      ...(requestId === undefined ? {} : { requestId }), afterSeq: baseline,
      correlation: dispatch.boundary.correlation, endSeq: dispatch.boundary.endSeq, completionReason: dispatch.boundary.completionReason,
      session: briefSession(latest), running: Boolean(latest.running), lastEventType: payload.lastEventType, messages,
      ...(payload.hasMore ? { hasMore: true, nextThroughSeq: payload.nextThroughSeq } : {}) };
    if (!ended) {
      return { ...result, waitedSeconds: timeoutSeconds,
        nextAction: withReport
          ? 'Still running. The watch call reached its deadline; inspect the report later or use wait with the same request_id.'
          : 'Still running. Continue independent work and use futureaide_wait with the same request_id when its result is needed.' };
    }
    if (!withReport) return result;
    const reportFile = path.join(config.stateDirectory, 'reports', `${id}.${requestId ?? baseline}.json`);
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(reportFile, JSON.stringify({ ...result, storedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    return { ...result, reportFile, reportStored: true, deliveredAutomatically: false };
  }

  return {
    async connectionIdentity() { return api.connectionIdentity(); },
    async connect({ requestId } = {}) {
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.-]{1,120}$/.test(requestId)) throw new Error('Provide a stable request_id.');
      const instance = await api.status();
      if (!instance.connected) return { ...instance, ready: false, modelRequestsStarted: 0 };
      let host;
      try { host = await api.hostStatus(); }
      catch (error) {
        if (!['host-bridge-required', 'bridge-auth-required'].includes(error.code)
            && !(error.code === 'http-error' && [404, 405].includes(error.httpStatus))) throw error;
      }
      let bootstrap;
      const needsHistoryCursor = host && !host.methods?.includes('historyCursor');
      if (!host || needsHistoryCursor) {
        const revision = await hostBridgeRevision();
        const identity = createHash('sha256').update(JSON.stringify([config.workspace, instance.baseUrl, instance.pid, requestId, revision])).digest('hex').slice(0, 32);
        const sessionId = 'session-codex-bridge-' + identity;
        bootstrap = await writeOnce('connect', { sessionId }, requestId, { pid: instance.pid, baseUrl: instance.baseUrl }, async id => {
          const identity = await api.connectionIdentity?.();
          await installHost({ ...config, ...(identity?.dataRoot ? { dataRoot: identity.dataRoot } : {}) });
          const current = await api.status();
          if (!current.connected || current.baseUrl !== instance.baseUrl || current.pid !== instance.pid) throw new Error('FutureAide changed during connection setup. Inspect the current instance before retrying.');
          return api.createSession({ sessionId: id, cwd: config.workspace, agentPreset: HOST_PRESET });
        });
        if (bootstrap.accepted === false) return { ...instance, ...bootstrap, ready: false, modelRequestsStarted: 0 };
        host = await api.hostStatus();
      }
      if (host.version !== 1 || !host.methods?.includes('capabilities') || !host.methods?.includes('historyCursor')
          || (instance.pid !== undefined && host.pid !== instance.pid)) throw new Error('The expected FutureAide capability bridge was not confirmed.');
      return { ...instance, ready: true, capabilityBridgeReady: true,
        ...(bootstrap ? { bootstrapSessionId: bootstrap.sessionId, receipt: bootstrap.receipt } : {}),
        modelRequestsStarted: 0, applicationRestarted: false };
    },
    async status() {
      const status = await api.status();
      if (!status.connected) return status;
      const rows = (await api.listSessions()).items.filter(permitted);
      return { ...status, workspace: config.workspace, projectSessionCount: rows.length,
        watchedSession: rows.find(row => row.sessionId === config.futureaideSessionId) ? briefSession(rows.find(row => row.sessionId === config.futureaideSessionId)) : null,
        completionRequiresIndependentAcceptance: true };
    },
    async sessions({ query = '', limit = 20 } = {}) {
      const rows = (await api.listSessions()).items.filter(permitted).map(briefSession)
        .filter(row => !query || JSON.stringify(row).toLowerCase().includes(query.toLowerCase()));
      return { items: rows.slice(0, Math.min(Math.max(limit, 1), 100)), total: rows.length };
    },
    async read({ sessionId, maxMessages = 8, throughSeq, view = 'messages' } = {}) {
      if (!['messages', 'events'].includes(view)) throw new Error('History view must be messages or events.');
      const row = await checkSession(sessionId);
      const page = await api.readSession(row.sessionId, { maxMessages, workspace: config.workspace,
        ...(throughSeq === undefined ? {} : { throughSeq }) });
      return view === 'events' ? page : historyMessages(page, row);
    },
    async send({ sessionId, message, requestId, mode = 'queue', background = false }) {
      const result = await writeOnce('send', sessionId, requestId, { message, mode }, async (id, checkpoint) => {
        // Attach the pre-dispatch cursor so the watcher knows which turn belongs to this send.
        const afterSeq = await sessionCursor(id);
        await checkpoint({ afterSeq });
        return { ...await api.sendMessage(id, message, { requestId, mode }), afterSeq };
      });
      if (!background || result.accepted !== true) {
        return { ...result, next: `Use futureaide_wait with session_id ${result.sessionId} and request_id ${requestId} to collect this reply.` };
      }
      // Dispatch and forget: a detached worker polls in the background and drops the reply
      // into the report file, so the calling agent is free immediately.
      const reportFile = path.join(config.stateDirectory, 'reports', `${result.sessionId}.${requestId}.json`);
      const worker = fileURLToPath(new URL('./watch-worker.mjs', import.meta.url));
      const child = spawn(process.execPath, [worker,
        '--workspace', config.workspace, '--state', config.stateDirectory,
        '--session', result.sessionId, '--request', requestId, '--after-seq', String(result.afterSeq ?? -1),
        ...(config.dataRoot ? ['--data-root', config.dataRoot] : []),
        ...(config.dshDataRoot ? ['--dsh-data-root', config.dshDataRoot] : []),
        ...(config.target ? ['--target', config.target] : []),
        ...(config.instanceFile ? ['--instance-file', config.instanceFile] : []),
        ...(config.preferredInstanceFile ? ['--preferred-instance-file', config.preferredInstanceFile] : []),
        ...(config.hostBridgeFile ? ['--host-bridge-file', config.hostBridgeFile] : []),
        ...(config.timeoutMs ? ['--timeout-ms', String(config.timeoutMs)] : []),
        ...(config.baseUrl ? ['--base-url', config.baseUrl] : []),
      ], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return { ...result, watching: true, watcherPid: child.pid, reportFile,
        next: `A detached watcher is polling in the background. Keep working - do NOT block. The reply appears in ${reportFile} when the turn ends; read that file (or Monitor it) when you are notified or when you next need it.` };
    },
    async wait(input = {}) {
      return awaitTurn({ ...input, capSeconds: 600, withReport: false });
    },
    /** Bounded blocking watch with a durable report; client notification support varies. */
    async watch({ sessionId, requestId, afterSeq, timeoutSeconds = 900, pollIntervalMs = 5000, maxMessages = 12 } = {}) {
      return awaitTurn({ sessionId, requestId, afterSeq, timeoutSeconds, pollIntervalMs, maxMessages, capSeconds: 3600, withReport: true });
    },
    async cancel({ sessionId, requestId }) {
      return writeOnce('cancel', sessionId, requestId, {}, id => api.cancelSession(id));
    },
    async models() { return api.modelCatalog(); },
    async createSession({ requestId, agentPreset } = {}) {
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_.-]{1,120}$/.test(requestId)) throw new Error('Provide a stable request_id.');
      const sessionId = 'session-codex-' + createHash('sha256').update(JSON.stringify([config.stateDirectory, config.workspace, requestId])).digest('hex').slice(0, 32);
      return writeOnce('create', { sessionId }, requestId, { cwd: config.workspace, agentPreset }, id =>
        (api.createProjectSession ?? api.createSession).call(api, { sessionId: id, cwd: config.workspace, agentPreset }));
    },
    async attachSession({ sessionId, requestId }) {
      return writeOnce('attach-session', sessionId, requestId, { workspace: config.workspace },
        id => api.attachSessionToWorkspace(id, config.workspace));
    },
    async selectModel({ sessionId, provider, model, reasoningEffort, requestId }) {
      if (typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim()) throw new Error('Provide both provider and model.');
      const selection = { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
      return writeOnce('select-model', sessionId, requestId, selection, id => api.selectModel(id, selection));
    },
    async capabilities({ sessionId, toolName, activate = true } = {}) {
      const row = await checkSession(sessionId);
      const snapshot = await api.capabilities(row.sessionId, config.workspace, { activate });
      const content = JSON.stringify(snapshot, null, 2) + '\n';
      const digest = createHash('sha256').update(content).digest('hex');
      const snapshotFile = path.join(config.stateDirectory, 'capabilities', digest + '.json');
      await mkdir(path.dirname(snapshotFile), { recursive: true });
      await writeFile(snapshotFile, content, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const { tools, ...summary } = snapshot;
      const toolNames = [];
      let nameSize = 0;
      for (const tool of tools) {
        nameSize += JSON.stringify(tool.name).length;
        if (nameSize > 10000) break;
        toolNames.push(tool.name);
      }
      const selectedTool = toolName === undefined ? undefined : tools.find(tool => tool.name === toolName);
      if (toolName !== undefined && !selectedTool) throw new Error('The requested tool is not visible in this session.');
      const detail = selectedTool && JSON.stringify(selectedTool).length <= 14000 ? selectedTool : undefined;
      return { snapshotFile, sha256: digest, ...summary, toolNames,
        ...(toolNames.length < tools.length ? { toolNamesOmitted: tools.length - toolNames.length } : {}),
        ...(detail ? { tool: detail } : {}), ...(selectedTool && !detail ? { toolDetailInSnapshot: toolName } : {}) };
    },
    async hostStatus() { return api.hostStatus(); },
    async notify(input) { return notify(config, input); },
    async codexStatus() {
      try {
        await discoverCodexBridge();
        return { available: true, targetThreadId: config.codexThreadId, transport: 'Codex App Tools MCP' };
      } catch {
        return { available: false, targetThreadId: config.codexThreadId };
      }
    },
  };
}

export function errorResult(error) {
  const result = typeof error.toJSON === 'function' ? error.toJSON()
    : { code: 'control-error', message: String(error.message || 'Control operation failed.').slice(0, 1500) };
  return { ...result, ...Object.fromEntries(['receipt', 'sessionId', 'requestId', 'afterSeq']
    .filter(key => error[key] !== undefined).map(key => [key, error[key]])) };
}

export function boundedOutput(value, maximum = 40000) {
  const json = JSON.stringify(value, null, 2);
  return json.length <= maximum ? json : JSON.stringify({ truncated: true, totalCharacters: json.length, preview: json.slice(0, maximum), hint: 'Request fewer messages or a narrower session query.' }, null, 2);
}
