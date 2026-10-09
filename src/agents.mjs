import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createControl, errorResult } from './control.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const request = value => {
  value ??= randomUUID();
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(value)) throw new Error('Invalid request_id.');
  return value;
};
const internal = (id, phase) => hash(id).slice(0, 40) + '-' + phase;
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

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
    sessionId: record.sessionId, model: record.model, state: record.current?.state ?? record.phase,
    requestId: record.current?.requestId ?? record.requestId, updatedAt: record.updatedAt });
  const controlFor = record => controlFactory({ ...config, ...record.transport, workspace: record.workspace,
    futureaideSessionId: undefined, codexThreadId: undefined, stateDirectory: path.join(directory(record.agentId), 'state') });

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
    if (!dispatch?.accepted) return { ...summary(record), requestId, state: dispatch?.state ?? 'unknown', accepted: false };
    const result = await controlFor(record).wait({ sessionId: record.sessionId, requestId,
      afterSeq: dispatch.afterSeq, timeoutSeconds, maxMessages });
    const reason = result.completionReason?.kind;
    dispatch.state = result.state !== 'ended' ? 'running' : reason === 'cancelled'
      || (reason === 'aborted' && result.completionReason.reason?.kind === 'user') ? 'cancelled'
      : !reason || reason === 'completed' ? 'completed' : 'failed';
    if (record.current?.requestId === requestId) record.current = dispatch;
    await save(record);
    return { ...summary(record), ...result, requestId, state: dispatch.state,
      reply: result.messages?.filter(message => message.role === 'assistant' && message.text).map(message => message.text).join('\n\n') ?? '' };
  }

  async function advance(record, dispatch) {
    let control = controlFor(record);
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
        control = controlFor(record);
      }
      // A restarted instance must be explicitly reattached rather than silently receiving a recovery write.
      if (hash(await control.connectionIdentity()) !== hash(record.host)) throw new Error('This agent belongs to another host instance; its work was not resent.');
      if (!record.model) { record.model = resolveModel(await control.models(), record.input); await save(record); }
      if (!record.sessionId) {
        record.phase = 'creating'; await save(record);
        const created = await control.createSession({ requestId: internal(record.requestId, 'create'), agentPreset: record.input.agentPreset });
        if (created.accepted === false) return { ...summary(record), accepted: false, ...created, phase: record.phase };
        record.sessionId = created.sessionId; record.phase = 'created'; await save(record);
      }
      if (!dispatch.modelSelected) {
        record.phase = 'selecting-model'; await save(record);
        const selected = await control.selectModel({ sessionId: record.sessionId, ...record.model, requestId: internal(dispatch.requestId, 'model') });
        if (selected.accepted === false) return { ...summary(record), ...selected, phase: record.phase };
        dispatch.modelSelected = true; await save(record);
      }
      record.phase = 'sending'; await save(record);
      const sent = await control.send({ sessionId: record.sessionId, message: dispatch.message, requestId: dispatch.requestId, background: true });
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

  return {
    async spawn(input) {
      const requestId = request(input.requestId);
      const agentId = 'agent-' + hash(['spawn', requestId]).slice(0, 32);
      if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) throw new Error('Provide an absolute workspace.');
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 100000) throw new Error('Provide a task message (1-100000 characters).');
      const workspace = await realpath(input.workspace);
      const canonical = { workspace, message: input.message, taskName: input.taskName, provider: input.provider,
        model: input.model, reasoningEffort: input.reasoningEffort, agentPreset: input.agentPreset };
      return locked(agentId, async () => {
        let record;
        try { record = await load(agentId); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (record && record.fingerprint !== hash(canonical)) throw new Error('request_id already belongs to a different spawn task.');
        if (!record) {
          const dispatch = { requestId, message: input.message, state: 'pending', accepted: false };
          record = { version: 1, agentId, requestId, fingerprint: hash(canonical), workspace,
            taskName: input.taskName ?? 'DSH agent', input: canonical, phase: 'registered', current: dispatch, dispatches: { [requestId]: dispatch } };
          await save(record);
        }
        const dispatch = record.dispatches[requestId];
        if (dispatch.accepted) return { ...summary(record), requestId, state: dispatch.state, duplicate: true, accepted: true, receipt: dispatch.receipt, reportFile: dispatch.reportFile };
        return advance(record, dispatch);
      });
    },
    async followup({ agentId, message, requestId }) {
      requestId = request(requestId);
      if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw new Error('Provide a task message (1-100000 characters).');
      return locked(agentId, async () => {
        const record = await load(agentId);
        const existing = record.dispatches[requestId];
        if (existing) {
          if (existing.message !== message) throw new Error('request_id already belongs to different content.');
          if (existing.accepted) return { ...summary(record), requestId, duplicate: true, accepted: true, receipt: existing.receipt, reportFile: existing.reportFile };
          return advance(record, existing);
        }
        if (!record.current?.accepted) return { ...summary(record), accepted: false, state: 'busy', note: 'The earlier dispatch has an unresolved stage. Resume its original request_id.' };
        const previous = await collect(record);
        if (!['completed', 'cancelled', 'failed'].includes(previous.state)) return { ...summary(record), accepted: false, state: 'busy' };
        const dispatch = { requestId, message, state: 'pending', accepted: false };
        record.dispatches[requestId] = dispatch; record.current = dispatch; await save(record);
        return advance(record, dispatch);
      });
    },
    async wait({ agentId, ...input }) { return locked(agentId, async () => collect(await load(agentId), input)); },
    async cancel({ agentId, requestId }) {
      return locked(agentId, async () => {
        const record = await load(agentId);
        if (hash(await controlFor(record).connectionIdentity()) !== hash(record.host)) throw new Error('The saved host instance changed. Cancellation was not sent.');
        const previous = await collect(record);
        if (['completed', 'cancelled', 'failed'].includes(previous.state)) return { ...previous, accepted: false, note: 'The dispatch has already ended.' };
        if (!record.current.accepted) return { ...previous, accepted: false, note: 'Resolve the pending delivery before cancelling.' };
        const cancellationRequestId = request(requestId ?? internal(record.current.requestId, 'cancel'));
        const result = await controlFor(record).cancel({ sessionId: record.sessionId, requestId: cancellationRequestId });
        record.current.state = result.accepted === false ? record.current.state : 'cancel_requested'; await save(record);
        return { ...summary(record), ...result, requestId: record.current.requestId, cancellationRequestId };
      });
    },
    async list({ workspace } = {}) {
      let entries;
      try { entries = await readdir(root); } catch (error) { if (error.code === 'ENOENT') return { items: [] }; throw error; }
      const items = [];
      for (const id of entries.filter(value => /^agent-[a-f0-9]{32}$/.test(value))) {
        const record = await load(id).catch(() => undefined);
        if (record && (workspace === undefined || path.resolve(workspace) === record.workspace)) items.push(summary(record));
      }
      return { items, note: 'Persisted status; wait_agent refreshes a dispatch from native history.' };
    },
  };
}
