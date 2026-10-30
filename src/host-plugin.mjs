import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const name = 'futureaide-control-host';
// Tools belong to each Agent's composition; the bridge also mounts at host scope.
export const inject = ['connection', 'webServer', 'agents', 'sessions'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
export const MANAGED_METHODS = ['managedCreate', 'managedBeginTask', 'managedStatus', 'managedAnswer', 'managedCancel', 'managedDestroy'];

function managedId(value) {
  if (!ID.test(value ?? '')) reject('invalid-managed-identity');
  return value;
}

function canonicalEqual(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sessionCursor(session) {
  return Number.isSafeInteger(session?.seq) && session.seq >= 0
    ? session.seq - 1 : session?.events?.at(-1)?.seq ?? -1;
}

/** Private records are separate from the project and never become model-facing files. */
function managedFileStore(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) reject('managed-storage-required');
  const filename = key => path.join(directory, `${key}.json`);
  return {
    async read(key) {
      try { return JSON.parse(await readFile(filename(key), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async write(key, record) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // The host is the sole writer; direct writes avoid moving files on user volumes.
      await writeFile(filename(key), JSON.stringify(record), { mode: 0o600 });
    },
    async remove(key) { await rm(filename(key), { force: true }); },
  };
}

/**
 * Own ordinary DSH agents from creation through disposal. The small persistence
 * adapter below targets the JSONL, workspace and projection services verified in
 * DSH 0.2.1-rc.3; unsupported storage refuses cleanup instead of archiving it.
 */
export function createManagedHost(ctx, { stateDirectory, store, removeDirectory = rm } = {}) {
  const root = ctx.root ?? ctx;
  const runtimeKey = Symbol.for('futureaide-control.managed-runtimes');
  const runtimes = root[runtimeKey] ??= new Map();
  const directoryKey = typeof stateDirectory === 'string'
    ? (process.platform === 'win32' ? path.resolve(stateDirectory).toLowerCase() : path.resolve(stateDirectory)) : store;
  let runtime = runtimes.get(directoryKey);
  if (!runtime) {
    runtime = { records: new Map(), handles: new Map(), operations: new Map(), writes: new Map(), bindings: new Map(),
      storage: store ?? managedFileStore(stateDirectory) };
    runtimes.set(directoryKey, runtime);
  }
  const { records, handles, operations, writes, bindings, storage } = runtime;
  // The Agent factory ties ownership to the caller's fiber. The host root stays
  // alive across bridge reloads; replacing only the RPC fiber must not stop agents.
  const owner = typeof root.get === 'function' ? root : ctx;
  const keyOf = input => createHash('sha256').update(`${managedId(input.ownerId)}\n${managedId(input.agentId)}`).digest('hex');
  const service = name => owner.get(name);
  const persist = record => {
    const key = keyOf(record);
    record.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify(record);
    const next = (writes.get(key) ?? Promise.resolve()).then(() => storage.write(key, JSON.parse(snapshot)));
    // A failed write remains observable, but must not permanently poison later repair attempts.
    writes.set(key, next.catch(() => {}));
    return next;
  };
  const observeWrite = record => {
    void persist(record).catch(() => { record.observationError = 'managed-state-write-failed'; });
  };
  const serial = (input, operation) => {
    const key = keyOf(input);
    const next = (operations.get(key) ?? Promise.resolve()).then(operation);
    operations.set(key, next.catch(() => {}));
    return next;
  };
  async function load(input) {
    const key = keyOf(input);
    const record = records.get(key) ?? await storage.read(key);
    if (!record) reject('managed-agent-not-found');
    if (record.ownerId !== input.ownerId || record.agentId !== input.agentId) reject('managed-owner-mismatch');
    if (input.sessionId !== undefined && record.sessionId !== input.sessionId) reject('managed-session-mismatch');
    if (input.workspace !== undefined && !canonicalEqual(record.workspace, await realpath(input.workspace))) reject('workspace-mismatch');
    if (input.taskId !== undefined && record.taskId !== input.taskId) reject('managed-task-mismatch');
    records.set(key, record);
    return record;
  }
  function snapshot(record, agent = handles.get(keyOf(record))?.agent) {
    return {
      ownerId: record.ownerId, agentId: record.agentId, sessionId: record.sessionId,
      workspace: record.workspace, workspaceId: record.workspaceId, taskId: record.taskId ?? null,
      model: record.model, agentPreset: record.agentPreset,
      running: agent?.status === 'running', status: record.closing ? 'cleaning' : agent?.status ?? 'unloaded',
      activity: record.activity ?? 'idle', throughSeq: agent ? sessionCursor(agent.session) : record.throughSeq ?? -1,
      questions: structuredClone(record.questions ?? []), changes: structuredClone(record.changes ?? []),
      coverage: { source: 'agent-file-tool-results', complete: false,
        limitation: 'Only successful file mutations observed in this agent are attributed; shell and external writes are not inferred from the shared workspace.' },
      updatedAt: record.updatedAt, ...(record.observationError ? { observationError: record.observationError } : {}),
      ...(record.cancelled ? { cancelled: true } : {}),
    };
  }
  function installTools(agentCtx, agent, record) {
    const tools = agentCtx.get('tools');
    if (!tools?.register || !tools.guard) reject('managed-tools-unavailable');
    const key = keyOf(record);
    const previous = bindings.get(key);
    const fresh = previous?.agent !== agent;
    const binding = fresh ? { agent, record } : previous;
    bindings.set(key, binding);
    // Codex owns parallel delegation. A managed DSH session must not leave
    // untracked descendant sessions behind when its single-session owner closes.
    const delegates = definition => definition?.name === 'subagent'
      || definition?.description?.includes('This tool starts an independently managed subagent');
    const view = typeof tools.view === 'function' ? tools.view(agent) : undefined;
    const inherited = [...(view?.restrictableNames ?? [])].filter(name => delegates(tools.get(name, agent)));
    if (fresh && inherited.length) tools.restrict({ deny: inherited });
    binding.guard = exec => {
      if (exec.agent !== agent) return undefined;
      if (record.closing || record.cancelled) return 'The controlling agent has stopped this task.';
      if (record.questions.some(question => question.state === 'pending') && exec.name !== 'ask_parent') {
        return 'Wait for the controlling agent to answer before continuing this task.';
      }
      return delegates(tools.get(exec.name, agent))
        ? 'Ask the controlling Codex agent to arrange additional agents. This managed session cannot create nested agents.' : undefined;
    };
    if (fresh) tools.guard(exec => binding.guard(exec));
    binding.questionTool = {
      name: 'ask_parent',
      description: 'Ask the controlling Codex agent a question needed for your current task. Provide the question directly. This ends the current turn; the answer will resume this same task. Do not create a file or run a command to communicate.',
      parameters: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 100000 } }, required: ['message'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { waiting: { type: 'boolean' } }, required: ['waiting'], additionalProperties: false },
        render: () => [{ type: 'text', text: 'Your question has been sent to the controlling agent. Wait for its answer; the original task remains active.' }] },
      async execute(args, exec) {
        if (exec.agent !== agent || record.closing || record.cancelled) reject('managed-task-closed');
        if (!record.taskId) reject('managed-task-required');
        if (typeof args?.message !== 'string' || !args.message.trim() || args.message.length > 100000) reject('invalid-question');
        record.questions.push({ id: `question-${randomUUID()}`, taskId: record.taskId, message: args.message,
          state: 'pending', createdAt: new Date().toISOString() });
        record.activity = 'awaiting-answer';
        await persist(record);
        exec.concludeTurn();
        return { waiting: true };
      },
    };
    if (fresh) tools.register({ ...binding.questionTool, execute: (args, exec) => binding.questionTool.execute(args, exec) });
    binding.preExecute = async (exec, next) => {
      if (exec.agent === agent && record.taskId && !record.closing) {
        record.activity = `tool: ${exec.name}`;
        observeWrite(record);
      }
      return next();
    };
    if (fresh) agentCtx.on('tools/pre-execute', (...args) => binding.preExecute(...args));
    binding.result = (exec, result) => {
      if (exec.agent !== agent || !record.taskId || record.closing || result.isError) return;
      const value = result.value;
      const values = Array.isArray(value?.changes) ? value.changes : [value];
      for (const change of values) {
        if (typeof change?.path !== 'string' || !path.isAbsolute(change.path)
            || !['create', 'update', 'delete', 'rename'].includes(change.operation)) continue;
        const existing = record.changes.find(item => item.path === change.path);
        const item = { path: change.path, operation: change.operation,
          source: 'agent-file-tool-result', attribution: 'confirmed',
          ...(typeof change.before === 'string' || change.before === null ? { before: change.before } : {}),
          ...(typeof change.after === 'string' || change.after === null ? { after: change.after } : {}),
          ...(typeof change.oldPath === 'string' ? { oldPath: change.oldPath } : {}) };
        if (existing) {
          if ('before' in existing) item.before = existing.before;
          if (existing.operation === 'create' && item.operation === 'update') item.operation = 'create';
          Object.assign(existing, item);
        } else record.changes.push(item);
      }
      if (exec.name !== 'ask_parent') record.activity = `finished tool: ${exec.name}`;
      observeWrite(record);
    };
    if (fresh) agentCtx.on('tools/result', (...args) => binding.result(...args));
    binding.event = (session, event) => {
      if (session.id !== record.sessionId || record.closing) return;
      if (Number.isSafeInteger(event.seq)) record.throughSeq = event.seq;
      if (event.type === 'turn/start') record.activity = 'running';
      if (event.type === 'turn/end') record.activity = record.questions.some(question => question.state === 'pending')
        ? 'awaiting-answer' : record.cancelled ? 'cancelled' : 'turn-ended';
      if (['turn/start', 'turn/end', 'tool/call', 'assistant/message'].includes(event.type)) observeWrite(record);
    };
    if (fresh) agentCtx.on('session/event', (...args) => binding.event(...args));
  }
  async function activate(record, { fresh = false } = {}) {
    const key = keyOf(record);
    const owned = handles.get(key);
    if (owned && owner.agents.get(record.sessionId) === owned.agent) return owned.agent;
    if (record.closing) return undefined;
    if (owner.agents.get(record.sessionId)) reject('managed-handle-unavailable');
    const controller = service('sessionController');
    const composer = controller?.agents;
    if (typeof composer?.composeAgent !== 'function') reject('managed-composition-unavailable');
    const composition = await composer.composeAgent(record.agentPreset);
    record.agentPreset = composition.agentPreset;
    const setup = async (agentCtx, agent) => {
      const commit = await composition.setup(agentCtx, agent);
      installTools(agentCtx, agent, record);
      return commit;
    };
    let handle;
    if (fresh) {
      handle = await owner.agents.create({ sessionId: record.sessionId, agentOptions: record.model,
        meta: { cwd: record.workspace, ...(record.agentPreset ? { agentPreset: record.agentPreset } : {}) }, setup });
    } else {
      const inspected = await controller.inspect(record.sessionId);
      const header = inspected?.meta ?? inspected?.header;
      if (header?.id !== record.sessionId || !canonicalEqual(await realpath(header.cwd), record.workspace)) reject('managed-session-mismatch');
      handle = await owner.agents.resume({ resumeSessionId: record.sessionId, agentOptions: record.model, setup });
    }
    if (!handle?.agent || typeof handle.dispose !== 'function') reject('managed-handle-unavailable');
    handles.set(key, handle);
    record.throughSeq = sessionCursor(handle.agent.session);
    await persist(record);
    return handle.agent;
  }
  async function removeOwnedDirectory(directory, root, expectedName) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || typeof directory !== 'string' || !path.isAbsolute(directory)
        || path.basename(directory) !== expectedName) reject('managed-cleanup-path-unavailable');
    let entry;
    try { entry = await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!entry.isDirectory() || entry.isSymbolicLink()) reject('managed-cleanup-path-invalid');
    const [actualRoot, actualDirectory] = await Promise.all([realpath(root), realpath(directory)]);
    const relative = path.relative(actualRoot, actualDirectory);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) reject('managed-cleanup-path-invalid');
    await removeDirectory(actualDirectory, { recursive: true, force: true });
  }
  async function cleanupPlan(record, agent) {
    if (record.cleanup) return record.cleanup;
    const persistence = service('sessionPersistence');
    const registry = service('workspaceRegistry');
    const projectionCache = service('sessionProjectionCache');
    const query = service('sessionQuery');
    if (persistence?.name !== 'session-persistence-jsonl' || typeof persistence.resolveCurrentLog !== 'function'
        || typeof persistence.config?.root !== 'string') reject('managed-cleanup-backend-unsupported');
    const workspace = registry?.get(record.workspaceId);
    if (typeof workspace?.detachSession !== 'function') reject('managed-cleanup-workspace-unsupported');
    if (projectionCache && typeof projectionCache.requireTable?.()?.delete !== 'function') reject('managed-cleanup-cache-unsupported');
    if (query && (typeof query._serialized !== 'function' || typeof query._ensureReady !== 'function'
        || typeof query._reconcile !== 'function' || typeof query._requireDb !== 'function'
        || typeof query._observations?.cache?.delete !== 'function')) reject('managed-cleanup-query-unsupported');
    if (agent) await owner.sessions.flush(agent.session);
    const log = await persistence.resolveCurrentLog(record.sessionId);
    if (typeof log !== 'string' || path.basename(path.dirname(log)) !== record.sessionId) reject('managed-cleanup-path-unavailable');
    const spill = service('spillStore');
    const spillName = `session-${createHash('sha256').update(record.sessionId).digest('hex').slice(0, 12)}`;
    record.cleanup = { sessionRoot: path.resolve(persistence.config.root), sessionDirectory: path.dirname(log),
      ...(typeof spill?.root === 'string' ? { spillRoot: spill.root, spillDirectory: path.join(spill.root, spillName), spillName } : {}) };
    await persist(record);
    return record.cleanup;
  }
  const methods = {
    managedCreate(input) { return serial(input, async () => {
      const key = keyOf(input);
      managedId(input.sessionId);
      if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) reject('workspace-required');
      let record = records.get(key) ?? await storage.read(key);
      if (record) {
        record = await load(input);
        if (record.closing) reject('managed-agent-closing');
        const persisted = await service('sessionPersistence')?.stat(record.sessionId);
        const agent = await activate(record, { fresh: record.phase === 'creating' && !persisted });
        const project = service('workspaceRegistry').get(record.workspaceId);
        await owner.sessions.flush(agent.session);
        await project.attachSession(record.sessionId);
        if (!project.sessionIds.includes(record.sessionId)) reject('managed-project-attach-failed');
        record.phase = 'created';
        await persist(record);
        return { ...snapshot(record, agent), created: true, modelRequestsStarted: 0 };
      }
      const workspace = await realpath(input.workspace);
      const registry = service('workspaceRegistry');
      if (!registry?.resolveByPath || !registry?.create) reject('managed-workspace-unavailable');
      const project = await registry.resolveByPath(workspace) ?? await registry.create(workspace);
      const selection = service('agentDefaultModel')?.currentSelection();
      const model = modelValue(selection);
      if (owner.agents.get(input.sessionId) || await service('sessionPersistence')?.stat(input.sessionId)) reject('managed-session-already-exists');
      record = { version: 1, ownerId: input.ownerId, agentId: input.agentId, sessionId: input.sessionId,
        workspace, workspaceId: project.id, model, questions: [], changes: [], activity: 'idle', phase: 'creating' };
      records.set(key, record);
      await persist(record);
      const agent = await activate(record, { fresh: true });
      await owner.sessions.flush(agent.session);
      await project.attachSession(record.sessionId);
      if (!project.sessionIds.includes(record.sessionId)) reject('managed-project-attach-failed');
      record.phase = 'created';
      await persist(record);
      return { ...snapshot(record, agent), created: true, modelRequestsStarted: 0 };
    }); },
    managedBeginTask(input) { return serial(input, async () => {
      managedId(input.taskId);
      const record = await load({ ...input, taskId: undefined });
      if (record.closing) reject('managed-agent-closing');
      const agent = await activate(record);
      if (record.taskId === input.taskId) return snapshot(record, agent);
      if (agent.status === 'running' || record.questions.some(question => question.state === 'pending')) reject('managed-agent-busy');
      Object.assign(record, { taskId: input.taskId, questions: [], changes: [], cancelled: false,
        activity: 'ready', answers: [], throughSeq: sessionCursor(agent.session) });
      await persist(record);
      return snapshot(record, agent);
    }); },
    managedStatus(input) { return serial(input, async () => {
      const record = await load(input);
      const agent = record.closing ? handles.get(keyOf(record))?.agent : await activate(record);
      await (writes.get(keyOf(record)) ?? Promise.resolve());
      return snapshot(record, agent);
    }); },
    managedAnswer(input) { return serial(input, async () => {
      const record = await load(input);
      if (record.closing || record.cancelled) reject('managed-task-closed');
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 100000) reject('invalid-answer');
      if (input.answerId !== undefined) managedId(input.answerId);
      const prior = input.answerId === undefined ? undefined : record.answers?.find(answer => answer.answerId === input.answerId);
      if (prior) {
        if (prior.message !== input.message) reject('managed-answer-conflict');
        return { accepted: true, ...prior };
      }
      const pending = record.questions.filter(question => question.taskId === record.taskId && question.state === 'pending');
      if (!pending.length) reject('managed-no-pending-question');
      const answeredAt = new Date().toISOString();
      for (const question of pending) Object.assign(question, { state: 'answered', answer: input.message, answeredAt });
      const answer = { answerId: input.answerId ?? `answer-${randomUUID()}`, message: input.message,
        consumedQuestionIds: pending.map(question => question.id),
        continuation: `The controlling agent answered your question(s):\n${pending.map(question => `- ${question.message}`).join('\n')}\n\nAnswer:\n${input.message}\n\nContinue the original task. If complete, provide the final result normally.` };
      record.answers ??= [];
      record.answers.push(answer);
      record.activity = 'answer-ready';
      await persist(record);
      return { accepted: true, ...answer };
    }); },
    managedCancel(input) { return serial(input, async () => {
      const record = await load(input);
      if (record.closing) reject('managed-agent-closing');
      const agent = await activate(record);
      record.cancelled = true;
      for (const question of record.questions) if (question.state === 'pending') question.state = 'cancelled';
      record.activity = 'cancelling';
      await persist(record);
      agent.cancel({ kind: 'user' });
      record.activity = agent.status === 'running' ? 'cancelling' : 'cancelled';
      await persist(record);
      return { ...snapshot(record, agent), cancelled: true, cancelRequested: true, pendingInputCleared: true };
    }); },
    managedDestroy(input) { return serial(input, async () => {
      let record;
      try { record = await load(input); }
      catch (error) {
        if (error.controlCode !== 'managed-agent-not-found') throw error;
        managedId(input.sessionId);
        const persistence = service('sessionPersistence');
        const registry = service('workspaceRegistry');
        if (!persistence?.stat || !registry?.list) reject('managed-cleanup-verification-unavailable');
        if (owner.agents.get(input.sessionId) || owner.sessions.get(input.sessionId) || await persistence.stat(input.sessionId)
            || registry.list().some(project => project.sessionIds.includes(input.sessionId))
            || registry.pinnedSessionIds?.includes(input.sessionId) || registry.archivedSessionIds?.includes(input.sessionId)
            || service('sessionProjectionCache')?.requireTable().get(input.sessionId)) reject('managed-agent-not-found');
        const query = service('sessionQuery');
        if (query && (typeof query._serialized !== 'function' || typeof query._ensureReady !== 'function'
            || typeof query._requireDb !== 'function')) reject('managed-cleanup-verification-unavailable');
        if (query?._observations?.cache?.has(input.sessionId)) reject('managed-cleanup-incomplete');
        if (typeof query?._serialized === 'function') await query._serialized(undefined, async () => {
          await query._ensureReady(undefined);
          const db = query._requireDb();
          if (db.prepare('SELECT id FROM persisted_sessions WHERE id = ?').get(input.sessionId)
              || db.prepare('SELECT id FROM temp.live_sessions WHERE id = ?').get(input.sessionId)) reject('managed-cleanup-incomplete');
        });
        return { sessionId: input.sessionId, released: true, dataDeleted: true, destroyed: true, alreadyDestroyed: true };
      }
      const key = keyOf(record);
      const agent = record.closing ? handles.get(key)?.agent : await activate(record);
      const cleanup = await cleanupPlan(record, agent);
      record.closing = true;
      record.activity = 'cleaning';
      await persist(record);
      const handle = handles.get(key);
      if (handle) {
        handle.agent.cancel({ kind: 'user' });
        await handle.dispose();
        handles.delete(key);
        bindings.delete(key);
      }
      if (owner.agents.get(record.sessionId) || owner.sessions.get(record.sessionId)) reject('managed-release-incomplete');
      await removeOwnedDirectory(cleanup.sessionDirectory, cleanup.sessionRoot, record.sessionId);
      if (cleanup.spillDirectory) await removeOwnedDirectory(cleanup.spillDirectory, cleanup.spillRoot, cleanup.spillName);
      const persistence = service('sessionPersistence');
      persistence.coldLogMemo?.delete(record.sessionId);
      const projectionCache = service('sessionProjectionCache');
      // Disposal emits a final asynchronous cache write; enqueue our final delete after it.
      if (projectionCache) {
        if (agent) await projectionCache.flushSoft(agent.session, 'managed-delete');
        await projectionCache.requireTable().delete(record.sessionId);
      }
      const registry = service('workspaceRegistry');
      await registry.get(record.workspaceId).detachSession(record.sessionId);
      await registry.unpinSession(record.sessionId);
      await registry.unarchiveSession(record.sessionId);
      for (const field of ['headers', 'sessionPaths', 'invalidSessionPaths', 'missingSessionPaths']) registry[field]?.delete(record.sessionId);
      const query = service('sessionQuery');
      if (typeof query?._serialized === 'function' && typeof query?._reconcile === 'function') {
        await query._serialized(undefined, async () => {
          query._observations.cache.delete(record.sessionId);
          await query._ensureReady(undefined);
          await query._reconcile(undefined);
        });
      }
      if (await persistence.stat(record.sessionId)) reject('managed-cleanup-incomplete');
      await (writes.get(key) ?? Promise.resolve());
      await storage.remove(key);
      records.delete(key);
      writes.delete(key);
      return { sessionId: record.sessionId, released: true, dataDeleted: true, destroyed: true };
    }); },
  };
  // Existing registrations belong to their Agent scopes. Swap only their
  // callbacks so hot code uses the shared record and current implementation.
  for (const binding of bindings.values()) {
    if (owner.agents.get(binding.record.sessionId) === binding.agent) installTools(binding.agent.ctx, binding.agent, binding.record);
  }
  return methods;
}

function reject(code) {
  const error = new Error(code);
  error.controlCode = code;
  throw error;
}

function latest(events, type) {
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === type) return events[i].data;
}

function modelValue(value) {
  if (!value || typeof value.provider !== 'string' || !value.provider.trim() || value.provider.length > 200
      || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200
      || (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string'
        || !value.reasoningEffort.trim() || value.reasoningEffort.length > 100))) reject('invalid-model');
  return { provider: value.provider, model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) };
}

async function inWorkspace(candidate, workspace) {
  if (typeof candidate !== 'string' || typeof workspace !== 'string' || !path.isAbsolute(workspace)) return false;
  const [root, target] = await Promise.all([realpath(workspace), realpath(candidate)]);
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveAgent(ctx, sessionId, workspace, activate) {
  if (!ID.test(sessionId ?? '')) reject('invalid-session');
  let agent = ctx.agents.get(sessionId);
  let activated = false;
  if (!agent && activate) {
    const controller = ctx.get('sessionController');
    if (controller) {
      const inspected = await controller.inspect(sessionId);
      const header = inspected?.header ?? inspected?.meta;
      if (!await inWorkspace(header?.cwd, workspace)) reject('workspace-mismatch');
      const result = await controller.resolveAgent(sessionId);
      if (result.error) reject('agent-unavailable');
      agent = result.agent;
    } else {
      const proxy = ctx.get('apiProxy');
      if (!proxy) reject('host-api-unavailable');
      const listed = await proxy.sessions.list({ rpcId: 'codex-capabilities-list', payload: {} });
      const row = listed.result?.value?.items?.find(item => item.sessionId === sessionId);
      if (!await inWorkspace(row?.cwd, workspace)) reject('workspace-mismatch');
      if (row.origin === 'subagent') reject('subagent-owned');
      const loaded = await proxy.sessions.models({ rpcId: 'codex-capabilities-load', payload: { sessionId } });
      if (!loaded.result?.ok) reject('agent-unavailable');
      agent = ctx.agents.get(sessionId);
    }
    activated = true;
  }
  if (!agent) reject('agent-not-loaded');
  if (!await inWorkspace(agent.session.header.cwd, workspace)) reject('workspace-mismatch');
  return { agent, activated };
}

/** Return a durable ordinary session's final event sequence without loading its Agent. */
async function historyCursor(ctx, sessionId, workspace) {
  if (!ID.test(sessionId ?? '')) reject('invalid-session');
  const controller = ctx.get('sessionController');
  if (!controller || typeof controller.inspect !== 'function') reject('history-cursor-unavailable');
  const inspected = await controller.inspect(sessionId);
  const header = inspected?.meta ?? inspected?.header;
  if (!await inWorkspace(header?.cwd, workspace)) reject('workspace-mismatch');
  if (header?.origin === 'subagent') reject('subagent-owned');
  const events = inspected?.events;
  if (!Array.isArray(events)) reject('history-cursor-unavailable');
  const event = events.findLast(value => Number.isSafeInteger(value?.seq) && value.seq >= 0);
  return { sessionId, throughSeq: event?.seq ?? -1 };
}

/** Read registered schemas and effective policy without executing any tool or model. */
export function capabilitySnapshot(agent, { activated = false } = {}) {
  const ctx = agent.ctx;
  const get = key => ctx.get(key);
  const session = agent.session;
  const tools = get('tools');
  if (!tools || typeof tools.schemas !== 'function') reject('tool-registry-unavailable');
  const projections = get('sessionProjections')?.snapshot(session)?.values ?? {};
  const sandbox = get('sandboxPolicy');
  const approval = get('approval');
  const permission = get('permissionPresets');
  const plan = get('planMode');
  const schemas = tools.schemas(agent).map(schema => {
    const definition = tools.get(schema.name, agent);
    return { ...schema,
      ...(definition?.output?.schema === undefined ? {} : { outputSchema: definition.output.schema }),
      ...(definition?.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
      availability: 'visible-in-session', permissionEvaluation: 'at-call-time',
    };
  });
  return {
    version: 1, capturedAt: new Date().toISOString(), sessionId: agent.id,
    cwd: session.header.cwd, status: agent.status, activated,
    agentPreset: projections.agentPreset ?? session.header.agentPreset ?? null,
    model: (() => {
      const value = projections.modelSelection?.next ?? projections.modelSelection?.lastUsed
        ?? latest(session.events, 'model/selection') ?? session.requestHeader?.()?.config ?? agent.options;
      return value?.provider && value?.model ? modelValue(value) : null;
    })(),
    tools: schemas, totalTools: schemas.length,
    permissions: {
      sandbox: sandbox ? sandbox.resolve({ session }) : { available: false },
      processSandbox: { available: Boolean(get('sandbox')), implementation: get('sandbox')?.constructor?.name ?? null },
      approval: approval ? { policy: approval.overrideOf(session) ?? approval.config.policy ?? 'ask',
        source: approval.overrideOf(session) === undefined ? 'composition-default' : 'session-override' } : { available: false },
      preset: permission ? { current: projections.permissions?.currentValue
        ?? permission.current(Array.isArray(session.events) ? session.events : session), options: [...permission.names] } : { available: false },
      plan: projections.plan ? { ...projections.plan, source: 'session-projection' }
        : plan || schemas.some(tool => tool.name === 'exit_plan_mode')
          ? { active: latest(session.events, 'plan/mode')?.active ?? false, pending: null, source: 'session-events', pendingStateKnown: false }
          : { available: false },
      limitations: ['Tool schemas are the complete currently visible registry, not a guarantee that every argument is permitted.',
        'Argument-specific approval, filesystem observation, tool guards, external credentials and provider availability are evaluated when called.'],
    },
    complete: true, source: 'live-agent-services', modelRequestsStarted: 0,
  };
}

/** Build the fixed authenticated host methods; no arbitrary tool execution is exposed. */
export function createHostHandler(ctx, token, options = {}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Invalid host bridge credential.');
  const managed = options.stateDirectory || options.store ? createManagedHost(ctx, options) : undefined;
  return async (endpoint, payload) => {
    try {
      const input = payload?.args;
      const supplied = input?.token;
      if (typeof supplied !== 'string' || supplied.length !== token.length
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) reject('bridge-auth-required');
      if (managed && MANAGED_METHODS.includes(endpoint)) return { ok: true, value: await managed[endpoint](input) };
      if (!['capabilities', 'historyCursor', 'ping'].includes(endpoint)) reject('unknown-method');
      if (endpoint === 'ping') return { ok: true, value: { version: 1, revision: options.revision ?? null,
        methods: ['capabilities', 'historyCursor', ...(managed ? MANAGED_METHODS : [])], pid: process.pid } };
      if (endpoint === 'historyCursor') return { ok: true, value: await historyCursor(ctx, input.sessionId, input.workspace) };
      const { agent, activated } = await resolveAgent(ctx, input.sessionId, input.workspace, input.activate === true);
      return { ok: true, value: capabilitySnapshot(agent, { activated }) };
    } catch (error) {
      return { ok: false, error: { code: error.controlCode ?? 'host-operation-failed',
        message: error.controlCode ?? 'The host operation failed; no private runtime configuration is returned.' } };
    }
  };
}

/** Mount an authenticated side channel through the host's normal Connection plugin. */
export async function apply(ctx, config) {
  if (typeof config?.credentialFile !== 'string' || !path.isAbsolute(config.credentialFile)) throw new Error('credentialFile must be absolute.');
  const record = JSON.parse(await readFile(config.credentialFile, 'utf8'));
  const handler = createHostHandler(ctx, record.token, {
    stateDirectory: config.managedStateDirectory ?? path.join(path.dirname(config.credentialFile), 'managed-host'),
    revision: new URL(import.meta.url).searchParams.get('v'),
  });
  const key = Symbol.for('futureaide-control.host-handler');
  const current = ctx.root[key];
  if (current && typeof current.dispose !== 'function') { current.handler = handler; return; }
  if (current) await current.dispose();
  const binding = { handler };
  // New Connection services expose register(owner, ...); pass our injected context
  // explicitly, because the rpc getter retains the Connection provider's context.
  const dispose = await (typeof ctx.connection.register === 'function'
    ? ctx.connection.register(ctx, '/futureaide-control', (...args) => binding.handler(...args))
    : ctx.connection.rpc.handle('/futureaide-control', (...args) => binding.handler(...args), { authority: 'loopback' }));
  // A replacement fiber owns its route; disposing the previous fiber must not
  // remove the replacement's route or leave an active bridge without one.
  let disposed = false;
  binding.dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (typeof dispose === 'function') await dispose();
    if (ctx.root[key] === binding) delete ctx.root[key];
  };
  ctx.root[key] = binding;
  ctx.effect(() => binding.dispose);
  if (config.discoveryFile !== undefined) {
    if (typeof config.discoveryFile !== 'string' || !path.isAbsolute(config.discoveryFile)
        || typeof config.dataRoot !== 'string' || !path.isAbsolute(config.dataRoot)) throw new Error('Discovery paths must be absolute.');
    const instanceKey = Symbol.for('futureaide-control.host-instance');
    const instanceId = ctx.root[instanceKey] ??= randomUUID();
    const launchUrl = await ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`);
    await mkdir(path.dirname(config.discoveryFile), { recursive: true, mode: 0o700 });
    await writeFile(config.discoveryFile, JSON.stringify({ version: 1, application: 'dsh', pid: process.pid,
      instanceId, dataRoot: config.dataRoot, launchUrl, startedAt: new Date().toISOString() }), { mode: 0o600 });
  }
}
