// The one boundary between the shared name-addressed state machine and whichever
// target application executes the work. DSH delegates to the existing managed
// bridge unchanged; Claude Desktop is supplied by its own adapter. A missing
// adapter is reported as backend-not-ready and is never replaced by the DSH path.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const TARGETS = Object.freeze(['dsh', 'claude-desktop']);
export const DEFAULT_TARGET = 'dsh';
// Older roster records carry no target and keep the DSH behavior they were
// created with. Native identifiers stay internal: the contract only ever moves
// the plugin's own sessionId across this boundary.
export const DSH_HOST_METHODS = Object.freeze(['managedCreate', 'managedBeginTask', 'managedStatus',
  'managedHistory', 'managedAnswer', 'managedCancel', 'managedDestroy']);
// Deliveries and terminal cleanup stay in the shared state machine; a backend
// only observes, delivers one idempotent request, and reports its own receipt.
export const BACKEND_METHODS = Object.freeze(['probe', 'create', 'beginTask', 'observe', 'history', 'answer',
  'deliver', 'receipt', 'turn', 'models', 'model', 'selectModel', 'cancel', 'destroy', 'cursor']);

const fail = (code, message) => Object.assign(new Error(message), { code });
export const backendNotReady = (target, missing = []) => fail('backend-not-ready',
  `The ${target} backend is not available in this build${missing.length ? `: it does not provide ${missing.join(', ')}` : ''}. No subagent was created and no task was sent to another backend.`);
export const invalidTarget = value => fail('invalid-target',
  `target must be one of ${TARGETS.join(' / ')}; received ${JSON.stringify(value)}.`);

export function normalizeTarget(value) {
  if (value === undefined || value === null) return DEFAULT_TARGET;
  if (!TARGETS.includes(value)) throw invalidTarget(value);
  return value;
}
export function targetOf(record) { return normalizeTarget(record?.target); }

/** Refuse a backend that cannot honor the whole contract instead of degrading quietly. */
export function assertBackend(backend, target) {
  const missing = BACKEND_METHODS.filter(method => typeof backend?.[method] !== 'function');
  if (missing.length) throw backendNotReady(target, missing);
  return backend;
}

async function adapterFactory(target, adapters = {}) {
  if (typeof adapters?.[target] === 'function') return adapters[target];
  if (target !== 'claude-desktop') return undefined;
  let module;
  try { module = await import('./claude-backend.mjs'); }
  catch (error) {
    // Only the absent adapter file falls back to not-ready; a broken adapter must
    // surface its own error instead of looking like a missing backend.
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && String(error.message).includes('claude-backend')) return undefined;
    throw error;
  }
  return module.createClaudeBackend;
}

/**
 * Build the single backend for one recorded subagent.
 * @param {object} record Live roster record; `load()` re-reads it per call so a
 * new task id or state never hides behind a cached binding.
 * @param {object} options Target, injected adapters, and the DSH client/control
 * factories already resolved by the caller.
 */
export async function resolveBackend(record, { target, adapters = {}, dsh, load = () => record } = {}) {
  const wanted = normalizeTarget(target ?? record?.target);
  if (wanted === DEFAULT_TARGET) {
    if (!dsh) throw backendNotReady(DEFAULT_TARGET);
    return assertBackend(createDshBackend({ ...dsh, load }), DEFAULT_TARGET);
  }
  const factory = await adapterFactory(wanted, adapters);
  if (typeof factory !== 'function') throw backendNotReady(wanted);
  return assertBackend(await factory(load(), { load, requestDirectory: dsh?.requestDirectory }), wanted);
}

/**
 * DSH backend: the 0.5.7 managed bridge, expressed only in the calls the shared
 * state machine already made. Nothing here adds a second dispatch path.
 */
export function createDshBackend({ client, control, hostArgs = () => ({}), requestDirectory = () => process.cwd(), load = () => undefined }) {
  const args = () => hostArgs(load());
  const receiptFile = requestId => path.join(requestDirectory(load()), 'requests',
    createHash('sha256').update(JSON.stringify(['send', args().sessionId, requestId])).digest('hex') + '.json');
  return {
    target: DEFAULT_TARGET,
    labels: { host: 'DSH', bridge: 'The DSH bridge' },
    requiredMethods: DSH_HOST_METHODS,
    async probe() {
      const identity = await client.connectionIdentity();
      const status = await client.hostStatus();
      return { identity, methods: status?.methods ?? [],
        treeProtocol: status?.treeProtocol ?? null, reportProtocol: status?.reportProtocol ?? null };
    },
    async create() { return client.managedCreate(args()); },
    async beginTask(input = {}) { return client.managedBeginTask({ ...args(), ...input }); },
    async observe() { return client.managedStatus(args()); },
    async history({ targetSessionId } = {}) { return client.managedHistory({ ...args(), targetSessionId }); },
    async answer({ answerId, message } = {}) { return client.managedAnswer({ ...args(), answerId, message }); },
    async deliver({ requestId, message } = {}) {
      return control().send({ sessionId: args().sessionId, message, requestId,
        background: false, suppressCallback: true, mode: 'queue' });
    },
    async receipt({ requestId } = {}) {
      if (typeof requestId !== 'string' || !requestId) return undefined;
      try {
        const value = JSON.parse(await readFile(receiptFile(requestId), 'utf8'));
        return { status: value.status ?? 'unknown', afterSeq: value.result?.afterSeq ?? value.afterSeq,
          ...(value.result ? { result: value.result } : {}) };
      } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async turn({ requestId, afterSeq, timeoutSeconds = 0, maxMessages = 100 } = {}) {
      return control().wait({ sessionId: args().sessionId, requestId,
        ...(Number.isSafeInteger(afterSeq) ? { afterSeq } : {}), timeoutSeconds, maxMessages });
    },
    async models() { return control().models(); },
    async model() {
      const session = await client.managedSession(args());
      return session?.projections?.values?.modelSelection?.next ?? null;
    },
    async selectModel({ requestId, provider, model, reasoningEffort } = {}) {
      return control().selectModel({ sessionId: args().sessionId, provider, model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }), requestId });
    },
    async cancel() { return client.managedCancel(args()); },
    async destroy() { return client.managedDestroy(args()); },
    async cursor() { return client.historyCursor(args().sessionId, args().workspace); },
  };
}
