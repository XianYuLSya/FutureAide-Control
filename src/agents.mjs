import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isCodexThreadId } from './codex-target.mjs';
import { createControl, endedState, errorResult } from './control.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const request = value => {
  value ??= randomUUID();
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(value)) throw new Error('Invalid request_id.');
  return value;
};
const internal = (id, phase) => hash(id).slice(0, 40) + '-' + phase;
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const isProjectRoot = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
/**
 * A native session belongs to one Workspace path, so its cwd is that project root. When the caller
 * keeps work in a subdirectory, the task directory is recorded and stated in every dispatch and
 * followup instead of silently changing the native layout.
 */
const taskDirectoryNote = record => {
  if (typeof record.taskDirectory !== 'string' || record.taskDirectory === record.workspace) return '';
  return [
    '[执行目录契约]',
    `项目根（原生会话根）：${record.workspace}`,
    `任务目录（读写与命令目标）：${record.taskDirectory}`,
    '本任务的读写文件与执行命令均以任务目录为准；项目根只表示项目归属，不要改动项目根下的其他目录。',
    '[/执行目录契约]',
  ].join('\n');
};
const promptFor = (record, message) => {
  const note = taskDirectoryNote(record);
  return note ? `${note}\n\n${message}` : message;
};

export function resolveModel(catalog, input) {
  if ((input.provider === undefined) !== (input.model === undefined)) throw new Error('Provide both provider and model, or omit both.');
  if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim()
    || typeof input.provider !== 'string' || !input.provider.trim())) throw new Error('Provider and model must be nonempty strings.');
  const selection = input.model !== undefined ? { provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort }
    : { ...catalog.default, ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) };
  const group = catalog.groups?.find(group => (group.id ?? group.provider) === selection.provider);
  const model = group?.models?.find(model => (model.id ?? model.model) === selection.model);
  if (!selection.provider || !selection.model || !catalog.routableProviders?.includes(selection.provider) || !model) {
    throw new Error('No valid routable default model. Provide provider and model from the host catalog.');
  }
  const efforts = model.reasoning?.efforts?.map(effort => effort.id) ?? model.reasoningEfforts ?? [];
  if (selection.reasoningEffort !== undefined && !efforts.includes(selection.reasoningEffort)) {
    throw new Error('The selected model does not support this reasoning effort.');
  }
  return Object.fromEntries(Object.entries(selection).filter(([, value]) => value !== undefined));
}

/** Durable facade: each id owns one session, a fixed host and one outstanding dispatch. */
export function createAgents(config, { controlFactory = createControl } = {}) {
  const root = config.registryDirectory ?? path.join(path.dirname(config.stateDirectory), 'agents');
  const directory = id => {
    if (!/^agent-[a-f0-9]{32}$/.test(id ?? '')) throw new Error('Invalid agent_id.');
    return path.join(root, id);
  };
  const load = async id => JSON.parse(await readFile(path.join(directory(id), 'agent.json'), 'utf8'));
  const save = async record => {
    record.updatedAt = new Date().toISOString();
    const filename = path.join(directory(record.agentId), 'agent.json');
    const temp = filename + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, filename);
  };
  const summary = record => ({ agentId: record.agentId, taskName: record.taskName, workspace: record.workspace,
    ...(record.taskDirectory === undefined ? {} : { taskDirectory: record.taskDirectory }),
    ...(record.project === undefined ? {} : { project: record.project }),
    sessionId: record.sessionId, model: record.model, state: record.current?.state ?? record.phase,
    requestId: record.current?.requestId ?? record.requestId, updatedAt: record.updatedAt,
    callbackConfigured: isCodexThreadId(record.codexThreadId),
    ...(record.codexThreadId === undefined ? {} : { callbackTarget: record.codexThreadId }),
    ...(record.archive === undefined ? {} : { archive: record.archive }),
    ...(record.current?.suppressCallback === true ? { suppressCallback: true } : {}) });
  // The agent's own bound target and identity travel into every control call; an unbound agent
  // passes codexThreadId: undefined, so a profile-wide target is never inherited. A peer dispatch
  // suppresses only its own callback: the old agent/profile target is removed from this dispatch's
  // control config, while later ordinary followups still carry the agent's original binding.
  const controlFor = (record, dispatch) => controlFactory({ ...config, ...record.transport, workspace: record.workspace,
    futureaideSessionId: undefined,
    codexThreadId: dispatch?.suppressCallback === true ? undefined : record.codexThreadId,
    agentId: record.agentId,
    stateDirectory: path.join(directory(record.agentId), 'state') });

  async function locked(id, action) {
    const dir = directory(id);
    await mkdir(dir, { recursive: true });
    const filename = path.join(dir, 'lock.json');
    const nonce = randomUUID();
    const acquire = () => writeFile(filename, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 });
    try { await acquire(); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(filename, 'utf8')); } catch { return { agentId: id, accepted: false, state: 'busy', note: 'An incomplete lock requires inspection before recovery.' }; }
      if (isAlive(owner.pid)) return { agentId: id, accepted: false, state: 'busy' };
      // Serialize recovery so a contender cannot remove a newly acquired lock.
      const recovery = path.join(dir, 'recover.lock');
      try { await mkdir(recovery); } catch (error) { if (error.code === 'EEXIST') return { agentId: id, accepted: false, state: 'busy' }; throw error; }
      try {
        const current = JSON.parse(await readFile(filename, 'utf8'));
        if (current.nonce !== owner.nonce || isAlive(current.pid)) return { agentId: id, accepted: false, state: 'busy' };
        await rm(filename);
        await acquire();
      } finally { await rmdir(recovery); }
    }
    try { return await action(); }
    finally {
      const current = JSON.parse(await readFile(filename, 'utf8'));
      if (current.nonce === nonce) await rm(filename);
    }
  }

  async function collect(record, { requestId = record.current?.requestId, timeoutSeconds = 0, maxMessages = 8 } = {}) {
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 45) throw new Error('timeout_seconds must be between 0 and 45.');
    const dispatch = record.dispatches?.[requestId];
    if (!dispatch?.accepted) {
      // An unconfirmed send may still have reached the native session. Only an exact request-id
      // marker with an ended turn is accepted as proof; a baseline-only correlation is not enough.
      if (dispatch?.state === 'unknown' && typeof requestId === 'string' && record.sessionId) {
        let check;
        try {
          check = await controlFor(record, dispatch).wait({
            sessionId: record.sessionId,
            requestId,
            ...(Number.isSafeInteger(dispatch.afterSeq) ? { afterSeq: dispatch.afterSeq } : {}),
            timeoutSeconds: 0,
            maxMessages,
          });
        } catch {
          check = undefined;
        }
        if (check?.state === 'ended' && check.correlation === 'request-id') {
          const state = endedState(check.completionReason);
          Object.assign(dispatch, {
            accepted: true,
            state,
            recoveredFrom: 'native-read-only',
            ...(Number.isSafeInteger(check.afterSeq) ? { afterSeq: check.afterSeq } : {}),
          });
          if (record.current?.requestId === requestId) record.current = dispatch;
          await save(record);
          return {
            ...summary(record),
            ...check,
            requestId,
            state,
            accepted: true,
            recoveredFrom: 'native-read-only',
            reply: check.messages?.filter(message => message.role === 'assistant' && message.text)
              .map(message => message.text).join('\n\n') ?? '',
          };
        }
      }
      return { ...summary(record), requestId, state: dispatch?.state ?? 'unknown', accepted: false };
    }
    const result = await controlFor(record, dispatch).wait({ sessionId: record.sessionId, requestId,
      afterSeq: dispatch.afterSeq, timeoutSeconds, maxMessages });
    dispatch.state = result.state !== 'ended' ? 'running' : endedState(result.completionReason);
    if (record.current?.requestId === requestId) record.current = dispatch;
    await save(record);
    return { ...summary(record), ...result, requestId, state: dispatch.state,
      reply: result.messages?.filter(message => message.role === 'assistant' && message.text).map(message => message.text).join('\n\n') ?? '' };
  }

  async function advance(record, dispatch) {
    let control = controlFor(record, dispatch);
    try {
      if (!record.transport) {
        const connected = await control.connect({ requestId: internal(record.requestId, 'connect') });
        if (!connected.ready) throw Object.assign(new Error('Host connection is not ready.'), { details: connected });
        const identity = await control.connectionIdentity();
        record.host = identity;
        record.transport = { target: undefined, baseUrl: identity.baseUrl, dataRoot: identity.dataRoot,
          ...(identity.instanceFile ? { instanceFile: identity.instanceFile } : {}),
          hostBridgeFile: config.hostBridgeFile, timeoutMs: config.timeoutMs };
        record.phase = 'connected';
        await save(record);
        control = controlFor(record, dispatch);
      }
      // A restarted instance must be explicitly reattached rather than silently receiving a recovery write.
      if (hash(await control.connectionIdentity()) !== hash(record.host)) throw new Error('This agent belongs to another host instance; its work was not resent.');
      if (!record.model) { record.model = resolveModel(await control.models(), record.input); await save(record); }
      if (!record.sessionId) {
        record.phase = 'creating'; await save(record);
        const created = await control.createSession({ requestId: internal(record.requestId, 'create'), agentPreset: record.input.agentPreset,
          ...(record.input.projectName === undefined ? {} : { projectName: record.input.projectName }) });
        if (created.accepted === false) return { ...summary(record), accepted: false, ...created, phase: record.phase };
        record.sessionId = created.sessionId; record.phase = 'created';
        if (typeof created.workspaceId === 'string') {
          record.project = { workspaceId: created.workspaceId, path: record.workspace,
            ...(typeof created.workspaceTitle === 'string' ? { title: created.workspaceTitle } : {}),
            created: created.projectCreated === true, renamed: created.projectRenamed === true };
        }
        await save(record);
      }
      if (!dispatch.modelSelected) {
        record.phase = 'selecting-model'; await save(record);
        const selected = await control.selectModel({ sessionId: record.sessionId, ...record.model, requestId: internal(dispatch.requestId, 'model') });
        if (selected.accepted === false) return { ...summary(record), ...selected, phase: record.phase };
        dispatch.modelSelected = true; await save(record);
      }
      record.phase = 'sending'; await save(record);
      const sent = await control.send({ sessionId: record.sessionId, message: promptFor(record, dispatch.message),
        requestId: dispatch.requestId, background: true, archive: true, taskName: record.taskName,
        suppressCallback: dispatch.suppressCallback === true });
      Object.assign(dispatch, { accepted: sent.accepted === true, state: sent.accepted ? 'running' : sent.status ?? 'unknown',
        afterSeq: sent.afterSeq, receipt: sent.receipt, reportFile: sent.reportFile });
      record.phase = sent.accepted ? 'dispatched' : dispatch.state;
      record.current = dispatch; await save(record);
      return { ...summary(record), ...sent, requestId: dispatch.requestId, model: record.model };
    } catch (error) {
      record.stageReceipt = error.receipt;
      if (record.phase === 'sending') Object.assign(dispatch, { state: error.uncertain ? 'unknown' : 'rejected', receipt: error.receipt, afterSeq: error.afterSeq });
      record.lastError = errorResult(error); await save(record);
      return { ...summary(record), requestId: dispatch.requestId, accepted: false, phase: record.phase,
        sessionId: error.sessionId ?? record.sessionId, receipt: error.receipt, afterSeq: error.afterSeq,
        error: record.lastError, ...(error.details ? { details: error.details } : {}),
        note: 'Reuse this request_id to inspect the same durable stages. Unknown writes are never resent.' };
    }
  }

  /**
   * The detached watcher persists the outcome in this agent's private state. Reading it back keeps
   * a cached "running" registry from hiding a turn that already finished in another process, and a
   * watch timeout stays distinct from a failed turn because a deadline is not task completion.
   */
  async function recoveredReport(record) {
    const dispatch = record.current;
    if (typeof record.sessionId !== 'string' || typeof dispatch?.requestId !== 'string') return undefined;
    const file = path.join(directory(record.agentId), 'state', 'reports', `${record.sessionId}.${dispatch.requestId}.json`);
    let report;
    try { report = JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
    if (report?.sessionId !== record.sessionId || report?.requestId !== dispatch.requestId) return undefined;
    // An integer cursor is authoritative: a missing, non-numeric or different baseline cannot prove
    // the report belongs to this dispatch, so it is not adopted.
    if (Number.isSafeInteger(dispatch.afterSeq) && (!Number.isSafeInteger(report.afterSeq) || report.afterSeq !== dispatch.afterSeq)) return undefined;
    const notification = report.notification?.status;
    // A restore recorded for this exact dispatch means this report's archive step was already
    // reversed. A newer dispatch's report is independent and must still surface its own archive.
    const restoredForThisDispatch = ['restored', 'restore-unavailable'].includes(record.archive?.state)
      && record.archive?.requestId === dispatch.requestId;
    if (report.state === 'ended') return { state: endedState(report.completionReason), reportState: 'ended', reportFile: file,
      ...(report.storedAt === undefined ? {} : { reportStoredAt: report.storedAt }), ...(notification === undefined ? {} : { notificationStatus: notification }),
      ...(report.archive === undefined || restoredForThisDispatch ? {} : { archive: report.archive }) };
    if (report.state === 'timeout') return { reportState: 'timeout', reportFile: file, ...(notification === undefined ? {} : { notificationStatus: notification }),
      note: 'The watch deadline passed; the dispatch may still be running. A watch timeout is not a task failure.' };
    return undefined;
  }

  /**
   * A finished session can be archived. Native restore is idempotent and keeps the same session,
   * so a followup always continues the original conversation instead of creating a replacement.
   * The call is made only for a session the saved evidence marks archived.
   */
  async function restoreIfArchived(record, requestId) {
    const dispatchRequestId = record.current?.requestId;
    const ignoreReportArchive = ['restored', 'restore-unavailable'].includes(record.archive?.state)
      && record.archive?.requestId === dispatchRequestId;
    const recovered = ignoreReportArchive ? undefined : await recoveredReport(record);
    const archived = record.archive?.state === 'archived' || recovered?.archive?.state === 'archived';
    if (!archived) return { ok: true };
    try {
      const result = await controlFor(record).unarchiveSession({ sessionId: record.sessionId,
        requestId: internal(requestId, 'restore') });
      if (result?.accepted !== true) {
        // A duplicate receipt whose original outcome is unknown proves neither restore nor failure.
        record.archive = { state: result?.status === 'unknown' ? 'unknown' : 'failed', requestId: dispatchRequestId,
          at: new Date().toISOString(), status: result?.status,
          ...(result?.receipt === undefined ? {} : { receipt: result.receipt }) };
        record.lastError = { code: 'restore-unconfirmed', message: 'The native restore was not confirmed; inspect its receipt before retrying.' };
        await save(record);
        return { ok: false, result: { ...summary(record), requestId, accepted: false, state: 'archived', restored: false,
          error: record.lastError, note: 'The session may still be archived and nothing was sent. Inspect the restore receipt before retrying.' } };
      }
      record.archive = { state: 'restored', requestId: dispatchRequestId, at: new Date().toISOString(),
        ...(result?.receipt === undefined ? {} : { restoreReceipt: result.receipt }) };
      delete record.lastError;
      await save(record);
      return { ok: true, fields: { restored: true, archived: false, restoreReceipt: result?.receipt } };
    } catch (error) {
      const unsupported = ['unknown-endpoint', 'remote-not-found'].includes(error?.code)
        || (error?.code === 'http-error' && [404, 405].includes(error.httpStatus));
      if (unsupported) {
        // An older host may have archive without the restore endpoint. Its archived session may
        // still run; continue on the same session and report that restore was unavailable rather
        // than blocking followups forever.
        record.archive = { state: 'restore-unavailable', requestId: dispatchRequestId, at: new Date().toISOString(),
          error: errorResult(error) };
        await save(record);
        return { ok: true, fields: { restored: false, restoreUnavailable: true,
          note: 'This host does not expose session restore. The original session was kept and the followup was attempted; report this fact instead of claiming a restore.' } };
      }
      record.archive = { state: 'restore-failed', requestId: dispatchRequestId, at: new Date().toISOString(),
        error: errorResult(error) };
      record.lastError = errorResult(error);
      await save(record);
      return { ok: false, result: { ...summary(record), requestId, accepted: false, state: 'archived', restored: false,
        error: record.lastError, note: 'The session could not be restored; nothing was sent. Inspect the archive state before retrying.' } };
    }
  }

  return {
    async spawn(input) {
      const requestId = request(input.requestId);
      const agentId = 'agent-' + hash(['spawn', requestId]).slice(0, 32);
      if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) throw new Error('Provide an absolute workspace.');
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 100000) throw new Error('Provide a task message (1-100000 characters).');
      if (input.projectWorkspace !== undefined && (typeof input.projectWorkspace !== 'string' || !path.isAbsolute(input.projectWorkspace))) {
        throw new Error('project_workspace must be an absolute project root directory.');
      }
      if (input.projectName !== undefined && (typeof input.projectName !== 'string' || !input.projectName.trim() || input.projectName.length > 200)) {
        throw new Error('project_name must be a nonempty string of at most 200 characters.');
      }
      // A chat callback exists only when this exact call names an authorized target. It is never
      // read from metadata, the environment or the current conversation.
      if (input.codexThreadId !== undefined && !isCodexThreadId(input.codexThreadId)) {
        throw new Error('codex_thread_id must be a Codex task UUID. Omit it to keep the default of no chat callback.');
      }
      const taskDirectory = await realpath(input.workspace);
      // The project is an explicit native Workspace root, never a basename guess. Without it the
      // task workspace is also the project, which preserves the previous one-argument behavior.
      let workspace = taskDirectory;
      if (input.projectWorkspace !== undefined) {
        workspace = await realpath(input.projectWorkspace);
        if (!isProjectRoot(workspace, taskDirectory)) {
          throw new Error('project_workspace must be the task workspace or one of its ancestors.');
        }
      }
      const taskDirectoryField = workspace === taskDirectory ? undefined : taskDirectory;
      const projectName = input.projectName === undefined ? undefined : input.projectName.trim();
      const canonical = { workspace, ...(taskDirectoryField === undefined ? {} : { taskDirectory: taskDirectoryField }),
        message: input.message, taskName: input.taskName, provider: input.provider,
        model: input.model, reasoningEffort: input.reasoningEffort, agentPreset: input.agentPreset, codexThreadId: input.codexThreadId,
        ...(projectName === undefined ? {} : { projectName }) };
      return locked(agentId, async () => {
        let record;
        try { record = await load(agentId); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (record && record.fingerprint !== hash(canonical)) throw new Error('request_id already belongs to a different spawn task.');
        if (!record) {
          const dispatch = { requestId, message: input.message, state: 'pending', accepted: false };
          record = { version: 1, agentId, requestId, fingerprint: hash(canonical), workspace,
            ...(taskDirectoryField === undefined ? {} : { taskDirectory: taskDirectoryField }),
            taskName: input.taskName ?? 'DSH agent', input: canonical, phase: 'registered', current: dispatch, dispatches: { [requestId]: dispatch },
            ...(input.codexThreadId === undefined ? {} : { codexThreadId: input.codexThreadId }) };
          await save(record);
        }
        const dispatch = record.dispatches[requestId];
        if (dispatch.accepted) return { ...summary(record), requestId, state: dispatch.state, duplicate: true, accepted: true, receipt: dispatch.receipt, reportFile: dispatch.reportFile };
        return advance(record, dispatch);
      });
    },
    async followup({ agentId, message, requestId, suppressCallback }) {
      requestId = request(requestId);
      if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw new Error('Provide a task message (1-100000 characters).');
      if (suppressCallback !== undefined && typeof suppressCallback !== 'boolean') throw new Error('suppressCallback must be a boolean.');
      const suppressed = suppressCallback === true;
      return locked(agentId, async () => {
        const record = await load(agentId);
        const existing = record.dispatches[requestId];
        if (existing) {
          if (existing.message !== message) throw new Error('request_id already belongs to different content.');
          if ((existing.suppressCallback === true) !== suppressed) throw new Error('request_id already belongs to a different callback policy.');
          if (existing.accepted) return { ...summary(record), requestId, duplicate: true, accepted: true, receipt: existing.receipt, reportFile: existing.reportFile };
          const restored = await restoreIfArchived(record, requestId);
          if (!restored.ok) return restored.result;
          return { ...await advance(record, existing), ...restored.fields };
        }
        if (!record.current?.accepted) return { ...summary(record), accepted: false, state: 'busy', note: 'The earlier dispatch has an unresolved stage. Resume its original request_id.' };
        const previous = await collect(record);
        if (!['completed', 'cancelled', 'failed'].includes(previous.state)) return { ...summary(record), accepted: false, state: 'busy' };
        const restored = await restoreIfArchived(record, requestId);
        if (!restored.ok) return restored.result;
        const dispatch = { requestId, message, state: 'pending', accepted: false, ...(suppressed ? { suppressCallback: true } : {}) };
        record.dispatches[requestId] = dispatch; record.current = dispatch; await save(record);
        return { ...await advance(record, dispatch), ...restored.fields };
      });
    },
    async wait({ agentId, ...input }) { return locked(agentId, async () => collect(await load(agentId), input)); },
    async cancel({ agentId, requestId }) {
      return locked(agentId, async () => {
        const record = await load(agentId);
        if (hash(await controlFor(record, record.current).connectionIdentity()) !== hash(record.host)) throw new Error('The saved host instance changed. Cancellation was not sent.');
        const previous = await collect(record);
        if (['completed', 'cancelled', 'failed'].includes(previous.state)) return { ...previous, accepted: false, note: 'The dispatch has already ended.' };
        if (!record.current.accepted) return { ...previous, accepted: false, note: 'Resolve the pending delivery before cancelling.' };
        const cancellationRequestId = request(requestId ?? internal(record.current.requestId, 'cancel'));
        const result = await controlFor(record, record.current).cancel({ sessionId: record.sessionId, requestId: cancellationRequestId });
        record.current.state = result.accepted === false ? record.current.state : 'cancel_requested'; await save(record);
        return { ...summary(record), ...result, requestId: record.current.requestId, cancellationRequestId };
      });
    },
    /**
     * Archive exactly this agent's finished session. The native archive is a Session id set, not a
     * Workspace operation, so a shared project and every other conversation stay untouched.
     */
    async archive({ agentId, requestId } = {}) {
      return locked(agentId, async () => {
        const record = await load(agentId);
        if (typeof record.sessionId !== 'string') return { ...summary(record), accepted: false, note: 'This agent has no native session to archive.' };
        if (record.archive?.state === 'archived') {
          return { ...summary(record), accepted: true, duplicate: true, archive: record.archive };
        }
        const state = record.current?.state;
        if (!['completed', 'cancelled', 'failed'].includes(state)) {
          return { ...summary(record), accepted: false, state: state ?? 'unknown',
            note: 'Only a finished dispatch (completed, cancelled or failed) may be archived; running and timeout are not completion.' };
        }
        try {
          const result = await controlFor(record, record.current).archiveSession({ sessionId: record.sessionId,
            requestId: requestId ?? internal(record.current.requestId, 'archive') });
          if (result?.accepted !== true) {
            // A duplicate receipt with an unknown original outcome is not proof that the archive
            // landed. Preserve the completion result and the receipt instead of claiming archived.
            record.archive = { state: result?.status === 'unknown' ? 'unknown' : 'failed',
              requestId: record.current.requestId, at: new Date().toISOString(), status: result?.status,
              ...(result?.receipt === undefined ? {} : { receipt: result.receipt }) };
            record.lastError = { code: 'archive-unconfirmed',
              message: 'The native archive was not confirmed; inspect its receipt before retrying.' };
            await save(record);
            return { ...summary(record), accepted: false, archive: record.archive, error: record.lastError,
              note: 'The completion result is preserved; the archive outcome remains inspectable and was not assumed.' };
          }
          record.archive = { state: 'archived', requestId: record.current.requestId, at: new Date().toISOString(),
            ...(result.receipt === undefined ? {} : { receipt: result.receipt }) };
          delete record.lastError;
          await save(record);
          return { ...summary(record), ...result, accepted: true };
        } catch (error) {
          record.lastError = errorResult(error);
          record.archive = { state: 'failed', requestId: record.current.requestId, at: new Date().toISOString(), error: record.lastError };
          await save(record);
          return { ...summary(record), accepted: false, archive: record.archive, error: record.lastError,
            note: 'The completion result is preserved; only the archive step failed and remains inspectable.' };
        }
      });
    },
    async list({ workspace } = {}) {
      let entries;
      try { entries = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return { items: [] }; throw error; }
      const items = [];
      for (const id of entries.filter(value => /^agent-[a-f0-9]{32}$/.test(value))) {
        const record = await load(id).catch(() => undefined);
        if (!record) continue;
        if (workspace !== undefined) {
          const target = path.resolve(workspace);
          if (target !== record.workspace && target !== record.taskDirectory) continue;
        }
        const recovered = await recoveredReport(record);
        items.push(recovered ? { ...summary(record), ...recovered } : summary(record));
      }
      return { items, note: 'Persisted status, refreshed from each agent\'s own private completion report. state completed/cancelled/failed comes from a finished turn; reportState timeout only means the background watch deadline passed and is not a task failure. wait_agent re-reads native history and returns the reply. archive shows whether this agent\'s own session was archived; it never describes the whole project.' };
    },
  };
}
