import { timingSafeEqual } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const name = 'futureaide-control-host';
// Tools belong to each Agent's composition; the bridge also mounts at host scope.
export const inject = ['connection', 'webServer', 'agents', 'sessions'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

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
export function createHostHandler(ctx, token) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Invalid host bridge credential.');
  return async (endpoint, payload) => {
    try {
      const input = payload?.args;
      const supplied = input?.token;
      if (typeof supplied !== 'string' || supplied.length !== token.length
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) reject('bridge-auth-required');
      if (!['capabilities', 'historyCursor', 'ping'].includes(endpoint)) reject('unknown-method');
      if (endpoint === 'ping') return { ok: true, value: { version: 1, methods: ['capabilities', 'historyCursor'], pid: process.pid } };
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
  const handler = createHostHandler(ctx, record.token);
  const key = Symbol.for('futureaide-control.host-handler');
  const current = ctx.root[key];
  if (current) { current.handler = handler; return; }
  const binding = { handler };
  // New Connection services expose register(owner, ...); pass our injected context
  // explicitly, because the rpc getter retains the Connection provider's context.
  if (typeof ctx.connection.register === 'function') ctx.connection.register(ctx, '/futureaide-control', (...args) => binding.handler(...args));
  else ctx.connection.rpc.handle('/futureaide-control', (...args) => binding.handler(...args), { authority: 'loopback' });
  ctx.root[key] = binding;
  ctx.effect(() => () => { if (ctx.root[key] === binding) delete ctx.root[key]; });
}
