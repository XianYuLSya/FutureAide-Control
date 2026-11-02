import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_KINDS = Object.freeze(['task', 'supplement', 'question', 'answer']);
export const TARGET_RUNTIMES = Object.freeze(['claude', 'codex']);
export const TARGET_CLIENTS = Object.freeze(['claude-code', 'codex-desktop']);
export const REQUEST_STATES = Object.freeze({
  QUEUED: 'queued',
  RECEIVED: 'received',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  UNKNOWN: 'unknown',
});

const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const ID_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const STATE_VALUES = new Set(Object.values(REQUEST_STATES));
const ENVELOPE_FIELDS = new Set([
  'version', 'requestId', 'deliveryReceipt', 'bindingTicket', 'taskId', 'ownerId', 'agentName',
  'profileId', 'workspace', 'kind', 'message', 'nativeHandle',
]);

export class DesktopProtocolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DesktopProtocolError';
    this.code = code;
    if (details) this.details = details;
  }
}

function fail(code, message, details) {
  throw new DesktopProtocolError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength || value.includes('\0')) {
    fail('desktop-envelope-invalid', `Envelope ${field} must be non-empty text of at most ${maxLength} characters.`, { field });
  }
  return value;
}

function requireId(value, prefix, field) {
  if (typeof value !== 'string' || !value.startsWith(prefix) || !ID_SUFFIX.test(value.slice(prefix.length))) {
    fail('desktop-envelope-invalid', `Envelope ${field} must be a plugin-generated ${prefix} ID.`, { field });
  }
  return value;
}

function requireNativeHandle(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) return null;
  return value;
}

/** Generate one ID set. Keep generation injectable so callers and tests can be deterministic. */
export function createRequestIds({ generateId = randomUUID } = {}) {
  if (typeof generateId !== 'function') fail('desktop-id-generator-invalid', 'generateId must be a function.');
  const next = prefix => {
    const suffix = generateId();
    if (typeof suffix !== 'string' || !ID_SUFFIX.test(suffix)) {
      fail('desktop-id-generator-invalid', 'The ID generator returned an invalid suffix.');
    }
    return prefix + suffix;
  };
  return {
    requestId: next('req_'),
    deliveryReceipt: next('rcpt_'),
    bindingTicket: next('ticket_'),
  };
}

/** Build the fixed version-1 envelope. Task identity is always the existing CLI task id. */
export function createEnvelope(input, options = {}) {
  if (!isObject(input) || !isObject(options)) fail('desktop-envelope-invalid', 'Envelope input must be an object.');
  for (const field of ['version', 'requestId', 'deliveryReceipt', 'bindingTicket', 'taskId']) {
    if (Object.hasOwn(input, field)) {
      fail('desktop-envelope-invalid', `${field} is assigned internally and cannot be supplied by the caller.`, { field });
    }
  }
  const generated = createRequestIds({ generateId: options.generateId });
  if (!options.taskId) fail('desktop-task-id-required', 'The existing CLI taskId is required.');
  const envelope = {
    version: ENVELOPE_VERSION,
    requestId: options.requestId ?? generated.requestId,
    deliveryReceipt: options.deliveryReceipt ?? generated.deliveryReceipt,
    bindingTicket: options.bindingTicket ?? generated.bindingTicket,
    taskId: options.taskId,
    ownerId: input.ownerId,
    agentName: input.agentName,
    profileId: input.profileId,
    workspace: input.workspace,
    kind: input.kind,
    message: input.message,
  };
  if (input.nativeHandle !== undefined) envelope.nativeHandle = input.nativeHandle;
  return validateEnvelope(envelope);
}

/** Validate and copy exactly one common envelope. */
export function validateEnvelope(value) {
  if (!isObject(value)) fail('desktop-envelope-invalid', 'Envelope must be an object.');
  const unknown = Object.keys(value).filter(field => !ENVELOPE_FIELDS.has(field));
  if (unknown.length) {
    fail('desktop-envelope-invalid', `Envelope has unsupported field: ${unknown.join(', ')}.`, { fields: unknown });
  }
  if (value.version !== ENVELOPE_VERSION) {
    fail('desktop-envelope-invalid', `Envelope version must be ${ENVELOPE_VERSION}.`, { field: 'version' });
  }
  requireId(value.requestId, 'req_', 'requestId');
  requireId(value.deliveryReceipt, 'rcpt_', 'deliveryReceipt');
  requireId(value.bindingTicket, 'ticket_', 'bindingTicket');
  requireId(value.taskId, 'task-', 'taskId');
  requireText(value.ownerId, 'ownerId', 200);
  requireText(value.agentName, 'agentName', 200);
  if (typeof value.profileId !== 'string' || !UUID.test(value.profileId)) {
    fail('desktop-envelope-invalid', 'Envelope profileId must be a FaSwitch profile UUID.', { field: 'profileId' });
  }
  if (typeof value.workspace !== 'string' || !path.isAbsolute(value.workspace) || value.workspace.includes('\0')) {
    fail('desktop-envelope-invalid', 'Envelope workspace must be an absolute path.', { field: 'workspace' });
  }
  if (!ENVELOPE_KINDS.includes(value.kind)) {
    fail('desktop-envelope-invalid', `Envelope kind must be one of: ${ENVELOPE_KINDS.join(', ')}.`, { field: 'kind' });
  }
  requireText(value.message, 'message', 100000);
  if (value.nativeHandle !== undefined && !requireNativeHandle(value.nativeHandle)) {
    fail('desktop-envelope-invalid', 'Envelope nativeHandle must be non-empty text of at most 512 characters.', { field: 'nativeHandle' });
  }
  const envelope = {
    version: ENVELOPE_VERSION,
    requestId: value.requestId,
    deliveryReceipt: value.deliveryReceipt,
    bindingTicket: value.bindingTicket,
    taskId: value.taskId,
    ownerId: value.ownerId,
    agentName: value.agentName,
    profileId: value.profileId,
    workspace: value.workspace,
    kind: value.kind,
    message: value.message,
  };
  if (value.nativeHandle !== undefined) envelope.nativeHandle = value.nativeHandle;
  return envelope;
}

function normalizeBinding(input) {
  if (!isObject(input)) fail('desktop-binding-invalid', 'Dispatcher binding must be an object.');
  if (!TARGET_RUNTIMES.includes(input.targetRuntime)) {
    fail('desktop-binding-invalid', 'Dispatcher binding targetRuntime is invalid.', { field: 'targetRuntime' });
  }
  if (!TARGET_CLIENTS.includes(input.targetClient)) {
    fail('desktop-binding-invalid', 'Dispatcher binding targetClient is invalid.', { field: 'targetClient' });
  }
  if (typeof input.profileId !== 'string' || !UUID.test(input.profileId)) {
    fail('desktop-binding-invalid', 'Dispatcher binding profileId must be a UUID.', { field: 'profileId' });
  }
  if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace) || input.workspace.includes('\0')) {
    fail('desktop-binding-invalid', 'Dispatcher binding workspace must be an absolute path.', { field: 'workspace' });
  }
  if (input.targetRuntime === 'codex') {
    if (typeof input.hostId !== 'string' || !input.hostId.trim() || input.hostId.length > 120) {
      fail('desktop-binding-invalid', 'Codex dispatcher binding hostId must be verified thread host identity.', { field: 'hostId' });
    }
    if (typeof input.threadId !== 'string' || !input.threadId.trim() || input.threadId.length > 200) {
      fail('desktop-binding-invalid', 'Codex dispatcher binding threadId must be the verified native thread.', { field: 'threadId' });
    }
    return {
      targetRuntime: input.targetRuntime,
      targetClient: input.targetClient,
      profileId: input.profileId.toLowerCase(),
      workspace: path.resolve(input.workspace),
      bindingMode: 'thread',
      hostId: input.hostId.trim(),
      threadId: input.threadId.trim(),
    };
  }
  if (!Number.isSafeInteger(input.hostPid) || input.hostPid <= 0) {
    fail('desktop-binding-invalid', 'Dispatcher binding hostPid must be a positive integer.', { field: 'hostPid' });
  }
  const validStarted = (typeof input.hostStarted === 'string' && input.hostStarted.trim() && input.hostStarted.length <= 100)
    || (Number.isSafeInteger(input.hostStarted) && input.hostStarted >= 0);
  if (!validStarted) {
    fail('desktop-binding-invalid', 'Dispatcher binding hostStarted must be a process start value.', { field: 'hostStarted' });
  }
  return {
    targetRuntime: input.targetRuntime,
    targetClient: input.targetClient,
    profileId: input.profileId.toLowerCase(),
    workspace: path.resolve(input.workspace),
    bindingMode: 'process',
    hostPid: input.hostPid,
    hostStarted: String(input.hostStarted).trim(),
  };
}

/** Validate and normalize the fixed dispatcher binding. */
export function validateDispatcherBinding(input) {
  return normalizeBinding(input);
}

/** Stable inbox key: runtime/client plus profile/workspace; binding identity remains separate. */
export function desktopHostKey(input) {
  if (!isObject(input)) fail('desktop-binding-invalid', 'Dispatcher inbox binding must be an object.');
  if (!TARGET_RUNTIMES.includes(input.targetRuntime)) {
    fail('desktop-binding-invalid', 'Dispatcher inbox targetRuntime is invalid.', { field: 'targetRuntime' });
  }
  if (!TARGET_CLIENTS.includes(input.targetClient)) {
    fail('desktop-binding-invalid', 'Dispatcher inbox targetClient is invalid.', { field: 'targetClient' });
  }
  if (typeof input.profileId !== 'string' || !UUID.test(input.profileId)) {
    fail('desktop-binding-invalid', 'Dispatcher inbox profileId must be a UUID.', { field: 'profileId' });
  }
  if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace) || input.workspace.includes('\0')) {
    fail('desktop-binding-invalid', 'Dispatcher inbox workspace must be an absolute path.', { field: 'workspace' });
  }
  const workspace = process.platform === 'win32' ? path.resolve(input.workspace).toLowerCase() : path.resolve(input.workspace);
  return JSON.stringify([input.targetRuntime, input.targetClient, input.profileId.toLowerCase(), workspace]);
}

/** Fixed key for the runtime-specific dispatcher identity. */
export function dispatcherBindingKey(input) {
  const binding = validateDispatcherBinding(input);
  const workspace = process.platform === 'win32' ? binding.workspace.toLowerCase() : binding.workspace;
  return JSON.stringify(binding.bindingMode === 'thread'
    ? [binding.targetRuntime, binding.targetClient, binding.profileId, workspace, binding.hostId, binding.threadId]
    : [binding.targetRuntime, binding.targetClient, binding.profileId, workspace, binding.hostPid, binding.hostStarted]);
}

/** Refuse a dispatch whenever any part of the registered Desktop binding changed. */
export function assertDispatcherBinding(expected, actual) {
  const normalizedExpected = normalizeBinding(expected);
  if (dispatcherBindingKey(normalizedExpected) === dispatcherBindingKey(actual)) return normalizeBinding(actual);
  const normalizedActual = normalizeBinding(actual);
  const fields = (normalizedExpected.bindingMode === 'thread'
    ? ['targetRuntime', 'targetClient', 'profileId', 'workspace', 'hostId', 'threadId']
    : ['targetRuntime', 'targetClient', 'profileId', 'workspace', 'hostPid', 'hostStarted']).filter(field => {
    if (field === 'workspace') {
      const left = process.platform === 'win32' ? normalizedExpected.workspace.toLowerCase() : normalizedExpected.workspace;
      const right = process.platform === 'win32' ? normalizedActual.workspace.toLowerCase() : normalizedActual.workspace;
      return left !== right;
    }
    return normalizedExpected[field] !== normalizedActual[field];
  });
  fail('desktop-host-binding-mismatch', 'Desktop dispatcher binding changed; refusing to dispatch.', { fields });
}

/** Explicit environment/capability error; cancel is the first fixed capability. */
export function unsupportedError(capability, details = {}) {
  if (typeof capability !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(capability)) {
    fail('desktop-unsupported-capability-invalid', 'Unsupported capability must be a lowercase hyphenated name.');
  }
  return new DesktopProtocolError(
    `desktop-${capability}-unsupported`,
    `Desktop capability "${capability}" is not supported.`,
    { ...details, capability },
  );
}

export function cancelUnsupportedError(details = {}) {
  return unsupportedError('cancel', details);
}

/** Create the local queued record. Queueing is never acceptance. */
export function createDispatchState(envelope) {
  const valid = validateEnvelope(envelope);
  return {
    requestId: valid.requestId,
    deliveryReceipt: valid.deliveryReceipt,
    bindingTicket: valid.bindingTicket,
    taskId: valid.taskId,
    state: REQUEST_STATES.QUEUED,
    accepted: false,
    nativeHandle: null,
  };
}

function assertDispatchState(value) {
  if (!isObject(value) || !STATE_VALUES.has(value.state) || typeof value.accepted !== 'boolean') {
    fail('desktop-dispatch-state-invalid', 'Dispatch state is not a Claude Desktop protocol state.');
  }
  requireId(value.requestId, 'req_', 'requestId');
  requireId(value.deliveryReceipt, 'rcpt_', 'deliveryReceipt');
  requireId(value.bindingTicket, 'ticket_', 'bindingTicket');
  requireId(value.taskId, 'task-', 'taskId');
  if (value.accepted !== (value.state === REQUEST_STATES.ACCEPTED)) {
    fail('desktop-dispatch-state-invalid', 'Dispatch accepted flag does not match its state.');
  }
  if (value.nativeHandle !== null && !requireNativeHandle(value.nativeHandle)) {
    fail('desktop-dispatch-state-invalid', 'Dispatch nativeHandle is invalid.');
  }
  return value;
}

/**
 * First receipt is the only delivery that may spawn. Every receipt replay is
 * reconcile-only and returns spawnAllowed:false.
 */
export function receiveRequest(value) {
  const current = assertDispatchState(value);
  if (current.state === REQUEST_STATES.QUEUED) {
    return {
      dispatch: { ...current, state: REQUEST_STATES.RECEIVED },
      delivery: 'received',
      replay: false,
      spawnAllowed: true,
      accepted: false,
    };
  }
  return {
    dispatch: current,
    delivery: 'received',
    replay: true,
    spawnAllowed: false,
    accepted: current.accepted,
    reconcile: current.state === REQUEST_STATES.UNKNOWN,
  };
}

/** Mark native spawn success followed by a lost ack. Reconciliation now requires a native handle. */
export function markRequestUnknown(value, { nativeHandle } = {}) {
  const current = assertDispatchState(value);
  if (current.state !== REQUEST_STATES.RECEIVED) {
    fail('desktop-ack-before-receive', 'Only a received request can become unknown.');
  }
  const handle = requireNativeHandle(nativeHandle);
  if (!handle) fail('desktop-native-handle-required', 'Unknown acknowledgement requires a native handle.');
  return { ...current, state: REQUEST_STATES.UNKNOWN, accepted: false, nativeHandle: handle };
}

/**
 * Acknowledge a delivered request. An accepted ack from unknown is the explicit
 * native-handle reconciliation path. Missing handles reject instead of accepting.
 */
export function ackRequest(value, ack = {}) {
  const current = assertDispatchState(value);
  if (!isObject(ack)) fail('desktop-ack-invalid', 'Acknowledgement must be an object.');
  if (ack.requestId !== current.requestId) {
    fail('desktop-ack-request-mismatch', 'Acknowledgement requestId does not match the delivered request.');
  }
  if (ack.deliveryReceipt !== current.deliveryReceipt) {
    fail('desktop-ack-receipt-mismatch', 'Acknowledgement deliveryReceipt does not match the delivered request.');
  }
  if (ack.status !== 'accepted' && ack.status !== 'rejected') {
    fail('desktop-ack-invalid', 'Acknowledgement status must be accepted or rejected.');
  }
  if (current.state === REQUEST_STATES.QUEUED) {
    fail('desktop-ack-before-receive', 'A queued request has not been received and cannot be acknowledged.');
  }
  if (current.accepted) {
    if (ack.status === 'accepted' && ack.nativeHandle === current.nativeHandle) {
      return { dispatch: current, ackState: 'accepted', accepted: true, reconciled: false, duplicate: true };
    }
    fail('desktop-ack-conflict', 'An accepted request cannot be acknowledged differently.');
  }
  if (current.state === REQUEST_STATES.REJECTED) {
    if (ack.status === 'rejected') {
      return { dispatch: current, ackState: 'ack-rejected', accepted: false, reconciled: false, duplicate: true };
    }
    fail('desktop-ack-conflict', 'A rejected request cannot later be accepted.');
  }
  const reconciled = current.state === REQUEST_STATES.UNKNOWN;
  const handle = ack.status === 'accepted' ? requireNativeHandle(ack.nativeHandle) : null;
  if (ack.status === 'accepted' && !handle) {
    return {
      dispatch: current,
      ackState: 'ack-rejected',
      accepted: false,
      reconciled,
      reason: 'native-handle-required',
    };
  }
  if (ack.status === 'rejected') {
    return {
      dispatch: { ...current, state: REQUEST_STATES.REJECTED, accepted: false, nativeHandle: null },
      ackState: 'ack-rejected',
      accepted: false,
      reconciled,
    };
  }
  return {
    dispatch: { ...current, state: REQUEST_STATES.ACCEPTED, accepted: true, nativeHandle: handle },
    ackState: 'accepted',
    accepted: true,
    reconciled,
  };
}
