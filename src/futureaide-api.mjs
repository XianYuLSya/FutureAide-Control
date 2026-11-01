import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { discoveryCandidates, isProcessAlive } from './discovery.mjs';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DISCOVERY_BYTES = 32 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

export class FutureAideError extends Error {
  constructor(code, message, { uncertain = false, httpStatus, retryableRead = false } = {}) {
    super(message);
    this.name = 'FutureAideError';
    this.code = code;
    this.uncertain = uncertain;
    if (retryableRead) this.retryableRead = true;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      uncertain: this.uncertain,
      ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }),
    };
  }
}

function fail(code, message, options) {
  throw new FutureAideError(code, message, options);
}

function validId(value, field = 'sessionId') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail('invalid-input', `${field} must contain 1 to 200 letters, digits, dots, underscores, or hyphens.`);
  }
  return value;
}

function parseLocalUrl(raw, launch = false) {
  if (typeof raw !== 'string' || raw.length > 8192 || raw !== raw.trim()) {
    fail('unsafe-url', 'The DSH address must be a loopback HTTP URL.');
  }
  let url;
  try { url = new URL(raw); } catch {
    fail('unsafe-url', 'The DSH address must be a loopback HTTP URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.hash || url.pathname !== '/') {
    fail('unsafe-url', 'Only loopback HTTP origins without URL credentials are supported.');
  }
  if (launch) {
    const values = url.searchParams.getAll('token');
    if ([...url.searchParams.keys()].some(key => key !== 'token')
        || values.length !== 1 || !/^[A-Za-z0-9_-]{1,4096}$/.test(values[0])) {
      fail('invalid-launch-url', 'The launch URL must contain exactly one valid launch token.');
    }
  } else if (url.search) {
    fail('unsafe-url', 'The base URL must not contain query parameters.');
  }
  return url;
}

function errorValue(error) {
  return error instanceof FutureAideError ? error.toJSON() : {
    code: 'client-error', message: 'The FutureAide client could not complete the operation.', uncertain: false,
  };
}

function checkedSessionList(value) {
  if (!value || !Array.isArray(value.items)) fail('invalid-response', 'FutureAide returned an invalid session list.');
  return value;
}

function sameInstance(a, b) {
  return a && b && a.baseUrl === b.baseUrl && a.pid === b.pid && a.instanceId === b.instanceId;
}

function samePath(a, b) {
  const left = resolve(a); const right = resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function readBoundedFile(path, maxBytes, { optional = false } = {}) {
  let handle;
  try {
    handle = await open(path, 'r');
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > maxBytes) {
      fail('invalid-instance', 'A FutureAide discovery file is invalid or too large.');
    }
    const buffer = Buffer.alloc(Math.min(stats.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return undefined;
    if (error instanceof FutureAideError) throw error;
    fail('discovery-failed', 'A FutureAide discovery file could not be read.');
  } finally {
    await handle?.close();
  }
}

function sessionCookie(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie() : [headers.get('set-cookie')].filter(Boolean);
  const candidates = values.map(value => value.split(';', 1)[0].trim())
    .filter(value => /^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.~-]+$/.test(value) && value.length <= 8192);
  if (candidates.length !== 1) {
    fail('authentication-failed', 'FutureAide did not issue a valid session cookie.');
  }
  return candidates[0];
}

async function discard(response) {
  try { await response.body?.cancel(); } catch { /* The response may already be closed. */ }
}

async function readJson(response, uncertain) {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    await discard(response);
    fail('response-too-large', 'The FutureAide response exceeded the byte limit.', { uncertain });
  }
  if (!response.body) fail('invalid-response', 'FutureAide returned an empty response.', { uncertain });
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        fail('response-too-large', 'The FutureAide response exceeded the byte limit.', { uncertain });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    fail('invalid-response', 'FutureAide returned invalid JSON.', { uncertain });
  }
}

export class FutureAideClient {
  #dataHome;
  #configuredLaunch;
  #configuredBase;
  #instanceFile;
  #fetch;
  #timeoutMs;
  #instance;
  #cookie;
  #dialect;
  #hostBridgeFile;
  #selectedCandidate;
  #preferredInstanceFile;

  constructor({ dataHome, dshDataHome, target = 'dsh', launchUrl, baseUrl, instanceFile, preferredInstanceFile, hostBridgeFile, fetchImpl, timeoutMs = 15_000 } = {}) {
    if (target !== 'dsh') fail('invalid-input', 'Only target=dsh is supported. Select a DSH data directory or an explicit DSH instance.');
    this.#dataHome = resolve(dshDataHome ?? dataHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
    // Explicit URLs remain useful for DSH maintenance. Old FutureAide environment
    // overrides and its shell/log/port discovery are intentionally not consulted.
    this.#configuredLaunch = launchUrl === undefined ? undefined : parseLocalUrl(launchUrl, true).href;
    this.#configuredBase = baseUrl === undefined ? undefined : parseLocalUrl(baseUrl).origin;
    if (this.#configuredLaunch && this.#configuredBase
        && new URL(this.#configuredLaunch).origin !== this.#configuredBase) {
      fail('instance-mismatch', 'The launch URL and base URL identify different DSH instances.');
    }
    this.#instanceFile = instanceFile === undefined ? undefined : resolve(instanceFile);
    this.#preferredInstanceFile = preferredInstanceFile === undefined ? undefined : resolve(preferredInstanceFile);
    this.#hostBridgeFile = hostBridgeFile;
    this.#fetch = fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      fail('invalid-input', 'A fetch function and a timeout between 1 and 120000 milliseconds are required.');
    }
    this.#timeoutMs = timeoutMs;
  }

  async #discover() {
    let instance;
    if (this.#instanceFile) {
      instance = await this.#candidateInstance({ instanceFile: this.#instanceFile }, false);
      if (!instance) fail('instance-not-found', 'The explicit DSH instance is not running.');
    } else if (this.#configuredLaunch) {
      instance = { baseUrl: new URL(this.#configuredLaunch).origin, launchUrl: this.#configuredLaunch,
        application: 'dsh', dataRoot: this.#dataHome, source: 'launch-url' };
    } else {
      return this.#discoverAutomatic();
    }
    if (this.#configuredBase && instance.baseUrl !== this.#configuredBase) {
      fail('instance-mismatch', 'The configured address does not match the DSH instance.');
    }
    if (this.#instance && !sameInstance(this.#instance, instance)) {
      this.#cookie = undefined;
      this.#dialect = undefined;
    }
    this.#instance = instance;
    return instance;
  }

  async #candidateInstance(candidate, optional = true) {
    const raw = await readBoundedFile(candidate.instanceFile, MAX_DISCOVERY_BYTES, { optional });
    if (raw === undefined) return undefined;
    let record;
    try { record = JSON.parse(raw); } catch { fail('invalid-instance', 'Invalid DSH instance discovery record.'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.version !== 1 || record.application !== 'dsh'
      || !Number.isInteger(record.pid) || record.pid < 1 || record.pid > 2 ** 31 - 1
      || typeof record.instanceId !== 'string' || !/^[a-f0-9-]{36}$/i.test(record.instanceId)
      || typeof record.dataRoot !== 'string' || !isAbsolute(record.dataRoot)
      || (candidate.dataRoot && !samePath(record.dataRoot, candidate.dataRoot))) {
      fail('invalid-instance', 'The discovery record must identify a native DSH instance and its data directory.');
    }
    if (!isProcessAlive(record.pid)) return undefined;
    const launchUrl = parseLocalUrl(record.launchUrl, true).href;
    const baseUrl = parseLocalUrl(record.baseUrl ?? new URL(launchUrl).origin).origin;
    if (new URL(launchUrl).origin !== baseUrl) fail('instance-mismatch', 'DSH discovery contains inconsistent local addresses.');
    return { baseUrl, launchUrl, pid: record.pid, instanceId: record.instanceId,
      application: 'dsh', dataRoot: resolve(record.dataRoot), source: candidate.registered ? 'dsh-plugin-registry' : 'instance-file' };
  }

  async #discoverAutomatic() {
    if (this.#selectedCandidate) {
      const current = await this.#candidateInstance(this.#selectedCandidate);
      if (!current || !sameInstance(current, this.#instance)) fail('instance-changed', 'The selected DSH host changed; no request was sent to another instance.');
      this.#instance = current;
      return current;
    }
    const candidates = await discoveryCandidates({ dshDataHome: this.#dataHome, preferredInstanceFile: this.#preferredInstanceFile });
    const ready = [], origins = new Set();
    let authFailure;
    for (const candidate of candidates) {
      let instance;
      try { instance = await this.#candidateInstance(candidate); }
      catch (error) {
        if (['discovery-failed', 'invalid-instance', 'unsafe-url', 'invalid-launch-url', 'instance-mismatch'].includes(error.code)) continue;
        throw error;
      }
      if (!instance || (this.#configuredBase && instance.baseUrl !== this.#configuredBase) || origins.has(instance.baseUrl)) continue;
      this.#cookie = undefined;
      this.#dialect = undefined;
      try {
        await this.#modelCatalogFor(instance);
        // Rejected stale records must not shadow a live DSH host at the same origin.
        origins.add(instance.baseUrl);
        ready.push({ instance, candidate, cookie: this.#cookie, dialect: this.#dialect });
      } catch (error) {
        if (['transport-error', 'timeout'].includes(error.code)) continue;
        if (['authentication-failed', 'authentication-required', 'bridge-auth-required'].includes(error.code)) {
          authFailure ??= error;
          continue;
        }
        throw error;
      }
    }
    if (ready.length > 1) fail('ambiguous-instance', 'Multiple running DSH hosts match. Configure an explicit instanceFile or baseUrl.');
    if (ready.length === 1) {
      const chosen = ready[0];
      this.#instance = chosen.instance; this.#selectedCandidate = chosen.candidate;
      this.#cookie = chosen.cookie; this.#dialect = chosen.dialect;
      return chosen.instance;
    }
    if (authFailure) throw authFailure;
    fail('instance-not-found', 'No registered DSH Web host was found. Enable the dsh-control-discovery plugin in the native DSH Web profile.');
  }

  async connectionIdentity() {
    const instance = await this.#discover();
    return { baseUrl: instance.baseUrl, ...(instance.pid === undefined ? {} : { pid: instance.pid }),
      ...(instance.instanceId ? { instanceId: instance.instanceId } : {}),
      ...(instance.application ? { application: instance.application } : {}), dataRoot: instance.dataRoot ?? this.#dataHome,
      ...(this.#selectedCandidate?.instanceFile || this.#instanceFile ? { instanceFile: this.#selectedCandidate?.instanceFile ?? this.#instanceFile } : {}) };
  }

  async #transport(url, init, consume, uncertain = false) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, { ...init, redirect: 'manual', signal: abort.signal });
      if (response.redirected) {
        await discard(response);
        fail('unsafe-redirect', 'FutureAide unexpectedly redirected a request.', { uncertain });
      }
      return await consume(response);
    } catch (error) {
      if (error instanceof FutureAideError) throw error;
      fail(abort.signal.aborted ? 'timeout' : 'transport-error',
        uncertain ? 'The FutureAide write outcome is unknown. Inspect the session before retrying.'
          : 'The FutureAide request could not complete.', { uncertain, retryableRead: !uncertain });
    } finally {
      clearTimeout(timer);
    }
  }

  async #authenticate(instance) {
    if (!instance.launchUrl) {
      fail('authentication-required', 'No native launch URL is available for this FutureAide instance.');
    }
    const cookie = await this.#transport(instance.launchUrl, { method: 'GET' }, async response => {
      try {
        if (response.status !== 303) {
          fail('authentication-failed', 'FutureAide refused the native launch-token exchange.', { httpStatus: response.status });
        }
        const location = response.headers.get('location');
        let redirect;
        try { redirect = location === null ? undefined : new URL(location, instance.baseUrl); } catch { /* Rejected below. */ }
        if (!redirect || redirect.origin !== instance.baseUrl || redirect.pathname !== '/'
            || redirect.search || redirect.hash || redirect.username || redirect.password) {
          fail('unsafe-redirect', 'The FutureAide authentication redirect was not a clean same-origin root.');
        }
        return sessionCookie(response.headers);
      } finally {
        await discard(response);
      }
    });
    this.#cookie = { baseUrl: instance.baseUrl, pid: instance.pid, value: cookie };
    return cookie;
  }

  async #rpc(endpoint, args, { write = false, expectedInstance, channel = 'api', instanceOverride } = {}) {
    let instance = instanceOverride ?? await this.#discover();
    if (expectedInstance && !sameInstance(instance, expectedInstance)) {
      fail('instance-changed', 'The FutureAide instance changed after preflight; the write was not sent.');
    }
    let cookie = this.#cookie?.baseUrl === instance.baseUrl && this.#cookie.pid === instance.pid
      ? this.#cookie.value : await this.#authenticate(instance);
    const rpcId = randomUUID();
    // Both API shapes are used by DSH releases. 'legacy' describes the slash
    // wire format, not a fallback to the removed FutureAide application.
    const modern = channel === 'api' && this.#dialect === 'modern';
    const wireEndpoint = modern ? ({ 'session/page': 'session.history', 'session/modelCatalog': 'llm.models' }[endpoint] ?? endpoint.replace('/', '.')) : endpoint;
    let payload = modern ? (args.request ?? args._request ?? args) : { args };
    if (modern && endpoint === 'session/page') payload = {
      sessionId: args.request.address.sessionId, beforeSeq: args.request.throughSeq + 1, maxMessages: args.request.maxMessages,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.#transport(new URL(`/${channel}/${wireEndpoint}`, instance.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method: wireEndpoint, payload }),
      }, async response => {
        if (response.status === 401) { await discard(response); return { unauthorized: true }; }
        if (response.status >= 300 && response.status < 400) {
          await discard(response);
          fail('unsafe-redirect', 'FutureAide unexpectedly redirected an RPC request.', { uncertain: write });
        }
        if (!response.ok) {
          await discard(response);
          fail('http-error', `FutureAide returned HTTP ${response.status}.`, { httpStatus: response.status, uncertain: write && response.status >= 500 });
        }
        const envelope = await readJson(response, write);
        if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId
            || typeof envelope.result?.ok !== 'boolean') {
          fail('invalid-response', 'FutureAide returned an invalid RPC envelope.', { uncertain: write });
        }
        if (!envelope.result.ok) {
          const rawCode = envelope.result.error?.code;
          const token = instance.launchUrl ? new URL(instance.launchUrl).searchParams.get('token') : undefined;
          const privateValues = [token, cookie, cookie?.slice(cookie.indexOf('=') + 1), channel === 'futureaide-control' ? args.token : undefined].filter(Boolean);
          const code = typeof rawCode === 'string' && rawCode.length <= 80
            && /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(rawCode)
            && !privateValues.some(secret => rawCode.includes(secret)) ? rawCode : 'rpc-error';
          // Remote errors may echo request data. Return the stable code, never that text.
          fail(code, `FutureAide rejected ${endpoint} (${code}).`);
        }
        return { value: envelope.result.value, rpcId };
      }, write);
      if (!result.unauthorized) return { ...result, instance };
      this.#cookie = undefined;
      if (write || attempt === 1 || instanceOverride) {
        fail('authentication-required', 'FutureAide rejected the session authentication.', { httpStatus: 401 });
      }
      instance = await this.#discover();
      cookie = await this.#authenticate(instance);
    }
  }

  async status() {
    try {
      const sessions = await this.listSessions();
      const instance = this.#instance;
      return { connected: true, baseUrl: instance.baseUrl, source: instance.source,
        ...(instance.application ? { application: instance.application, dataRoot: instance.dataRoot } : {}),
        ...(instance.pid === undefined ? {} : { pid: instance.pid }), sessionCount: sessions.items.length, apiDialect: this.#dialect ?? 'legacy' };
    } catch (error) {
      return { connected: false,
        ...(this.#instance ? { baseUrl: this.#instance.baseUrl, source: this.#instance.source,
          ...(this.#instance.pid === undefined ? {} : { pid: this.#instance.pid }) } : {}), error: errorValue(error) };
    }
  }

  async listSessions() {
    return this.#listSessionsFor();
  }

  async #listSessionsFor(instanceOverride) {
    try {
      const { value } = await this.#rpc('session/list', { _request: {} }, { instanceOverride });
      this.#dialect ??= 'legacy';
      return checkedSessionList(value);
    } catch (error) {
      if (this.#dialect !== undefined || !(error.httpStatus === 404 || ['unknown-endpoint', 'remote-not-found'].includes(error.code))) throw error;
      this.#dialect = 'modern';
      try { return checkedSessionList((await this.#rpc('session/list', { _request: {} }, { instanceOverride })).value); }
      catch (modernError) { this.#dialect = undefined; throw modernError; }
    }
  }

  async readSession(sessionId, { maxMessages = 10, throughSeq, workspace } = {}) {
    validId(sessionId);
    if (!Number.isInteger(maxMessages) || maxMessages < 1 || maxMessages > 100
        || (throughSeq !== undefined && (!Number.isSafeInteger(throughSeq) || throughSeq < -1))) {
      fail('invalid-input', 'History requires 1 to 100 messages and a valid event sequence.');
    }
    if (throughSeq === undefined) {
      const row = (await this.listSessions()).items.find(item => item.sessionId === sessionId);
      if (!row) fail('session-not-found', 'The requested FutureAide session was not found.');
      const listCursor = row.projections?.asOfSeq;
      if (!Number.isSafeInteger(listCursor) || listCursor < -1) {
        fail('cursor-unavailable', 'No cached history cursor is available for this session.');
      }
      throughSeq = listCursor === -1
        ? (await this.historyCursor(sessionId, workspace)).throughSeq
        : listCursor;
    }
    const { value } = await this.#rpc('session/page', { request: {
      address: { kind: 'session', sessionId }, throughSeq, maxMessages,
    } });
    if (this.#dialect === 'modern' && Array.isArray(value?.events)) {
      return { records: value.events.map(entry => ({ type: 'event', event: entry.event })), hasMore: value.hasMore,
        ...(value.projections ? { projections: value.projections } : {}) };
    }
    if (!value || !Array.isArray(value.records) || typeof value.hasMore !== 'boolean') {
      fail('invalid-response', 'FutureAide returned an invalid history page.');
    }
    return value;
  }

  async #ordinarySession(sessionId) {
    validId(sessionId);
    const row = (await this.listSessions()).items.find(item => item.sessionId === sessionId);
    if (!row) fail('session-not-found', 'The requested FutureAide session was not found.');
    const subagent = row.projections?.values?.subagent;
    if (row.origin === 'subagent' || subagent?.mode || subagent?.identity?.mode) {
      fail('subagent-owned', 'Send follow-up work to the owning ordinary session.');
    }
    return this.#instance;
  }

  async sendMessage(sessionId, text, { mode = 'queue', requestId = randomUUID() } = {}) {
    validId(sessionId);
    validId(requestId, 'requestId');
    if (typeof text !== 'string' || text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES
        || !['queue', 'steer'].includes(mode)) {
      fail('invalid-input', 'A nonempty message up to 128 KiB and queue or steer mode are required.');
    }
    const expectedInstance = await this.#ordinarySession(sessionId);
    return this.#sendPrompt(sessionId, text, { mode, requestId }, expectedInstance);
  }

  async #sendPrompt(sessionId, text, { mode, requestId }, expectedInstance) {
    const { value } = await this.#rpc('session/prompt', { request: {
      sessionId, requestId, mode, content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai',
    } }, { write: true, expectedInstance });
    if (value?.accepted !== true) fail('invalid-response', 'FutureAide did not return a prompt receipt.', { uncertain: true });
    return { accepted: true, requestId };
  }

  async cancelSession(sessionId) {
    const expectedInstance = await this.#ordinarySession(sessionId);
    const { value, rpcId } = await this.#rpc('session/cancel', { request: { sessionId } }, { write: true, expectedInstance });
    if (value?.accepted !== true) fail('invalid-response', 'FutureAide did not return a cancellation receipt.', { uncertain: true });
    return { accepted: true, requestId: rpcId };
  }

  async modelCatalog() {
    return this.#modelCatalogFor();
  }

  async #modelCatalogFor(instanceOverride) {
    let value;
    try {
      ({ value } = await this.#rpc('session/modelCatalog', {}, { instanceOverride }));
      this.#dialect ??= 'legacy';
    } catch (error) {
      if (this.#dialect !== undefined || !(error.httpStatus === 404 || ['unknown-endpoint', 'remote-not-found'].includes(error.code))) throw error;
      this.#dialect = 'modern';
      try { ({ value } = await this.#rpc('session/modelCatalog', {}, { instanceOverride })); }
      catch (modernError) { this.#dialect = undefined; throw modernError; }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('invalid-response', 'FutureAide returned an invalid model catalog.');
    }
    return value;
  }

  /** Create one explicitly identified ordinary session without submitting a prompt. */
  async createSession({ sessionId, cwd, agentPreset, workspaceId }) {
    validId(sessionId);
    const hasWorkspaceId = workspaceId !== undefined;
    if ((hasWorkspaceId && (cwd !== undefined || !ID_PATTERN.test(workspaceId)))
      || (!hasWorkspaceId && (typeof cwd !== 'string' || !isAbsolute(cwd)))
      || (agentPreset !== undefined && (typeof agentPreset !== 'string' || !agentPreset.trim() || agentPreset.length > 200))) {
      fail('invalid-input', 'Provide either a workspace ID or an absolute workspace path, plus an optional preset name.');
    }
    const rows = (await this.listSessions()).items;
    if (rows.some(row => row.sessionId === sessionId)) fail('session-exists', 'The requested session already exists; inspect it instead of adopting it.');
    const expectedInstance = this.#instance;
    const { value } = await this.#rpc('session/create', { request: { sessionId, ...(hasWorkspaceId ? { workspaceId } : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }) } }, { write: true, expectedInstance });
    if (value?.sessionId !== sessionId) fail('invalid-response', 'FutureAide returned a different session identity.', { uncertain: true });
    return { accepted: true, sessionId, agentPreset: value.agentPreset, modelRequestsStarted: 0 };
  }

  async #workspaceForPath(cwd, expectedInstance) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('invalid-input', 'An absolute project directory is required.');
    const { value } = await this.#rpc('workspace/create', { request: { path: cwd } }, { write: true, expectedInstance });
    const workspace = value?.workspace;
    if (!workspace || typeof workspace.workspaceId !== 'string' || typeof workspace.path !== 'string' || !samePath(workspace.path, cwd)
      || !Array.isArray(workspace.sessionIds)) fail('invalid-response', 'The host did not confirm the requested project.', { uncertain: true });
    return { workspace, created: value?.created === true };
  }

  /**
   * Resolve one native Workspace for an existing directory and, only when the caller explicitly
   * names it, rename that project. The native create already reuses a Workspace registered for the
   * same canonical path, so a shared project keeps its identity and title unless a name is supplied.
   * @param {string} cwd Absolute project root.
   * @param {{projectName?: string}} [options] Explicit user-visible project title.
   * @returns {Promise<{workspaceId: string, path: string, title: string, created: boolean, renamed: boolean}>}
   */
  async ensureProject(cwd, { projectName } = {}) {
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) fail('invalid-input', 'An absolute project directory is required.');
    if (projectName !== undefined && (typeof projectName !== 'string' || !projectName.trim() || projectName.length > 200)) {
      fail('invalid-input', 'projectName must be a nonempty string of at most 200 characters.');
    }
    if (this.#dialect === undefined) await this.listSessions();
    const expectedInstance = this.#instance;
    const resolved = await this.#workspaceForPath(cwd, expectedInstance);
    let workspace = resolved.workspace;
    const created = resolved.created;
    let renamed = false;
    if (projectName !== undefined && workspace.title !== projectName.trim()) {
      const renamedValue = await this.#rpc('workspace/rename', {
        request: { workspaceId: workspace.workspaceId, title: projectName.trim() },
      }, { write: true, expectedInstance });
      const renamedWorkspace = renamedValue.value?.workspace;
      if (!renamedWorkspace || renamedWorkspace.workspaceId !== workspace.workspaceId
        || typeof renamedWorkspace.title !== 'string' || renamedWorkspace.title !== projectName.trim()) {
        fail('invalid-response', 'The host did not confirm the project rename.', { uncertain: true });
      }
      workspace = renamedWorkspace;
      renamed = true;
    }
    return { workspaceId: workspace.workspaceId, path: workspace.path, title: workspace.title, created, renamed };
  }

  async createProjectSession({ sessionId, cwd, agentPreset, projectName }) {
    await this.listSessions();
    const expectedInstance = this.#instance;
    const project = await this.ensureProject(cwd, { projectName });
    const result = await this.createSession({ sessionId, agentPreset, workspaceId: project.workspaceId });
    const confirmed = (await this.#workspaceForPath(cwd, expectedInstance)).workspace;
    if (!confirmed.sessionIds.includes(sessionId)) fail('workspace-attach-failed', 'The session exists but was not confirmed in the project list.', { uncertain: true });
    return { ...result, workspaceId: project.workspaceId, workspaceTitle: project.title,
      projectVisible: true, projectCreated: project.created, projectRenamed: project.renamed };
  }

  /** Archive exactly one session in native Workspace navigation; never a Workspace or project. */
  async archiveSession(sessionId) {
    validId(sessionId);
    if (this.#dialect === undefined) await this.listSessions();
    const expectedInstance = this.#instance;
    const { value } = await this.#rpc('workspace/archiveSession', { request: { sessionId } }, { write: true, expectedInstance });
    if (!Array.isArray(value?.archivedSessionIds) || !value.archivedSessionIds.includes(sessionId)) {
      fail('invalid-response', 'The host did not confirm the session archive.', { uncertain: true });
    }
    return { accepted: true, sessionId, archived: true, archivedSessionIds: value.archivedSessionIds };
  }

  /** Restore exactly one archived session so a later followup can run the original conversation. */
  async unarchiveSession(sessionId) {
    validId(sessionId);
    if (this.#dialect === undefined) await this.listSessions();
    const expectedInstance = this.#instance;
    const { value } = await this.#rpc('workspace/unarchiveSession', { request: { sessionId } }, { write: true, expectedInstance });
    if (!Array.isArray(value?.archivedSessionIds) || value.archivedSessionIds.includes(sessionId)) {
      fail('invalid-response', 'The host did not confirm the session restore.', { uncertain: true });
    }
    return { accepted: true, sessionId, archived: false, archivedSessionIds: value.archivedSessionIds };
  }

  async attachSessionToWorkspace(sessionId, cwd) {
    const rows = (await this.listSessions()).items;
    const row = rows.find(item => item.sessionId === sessionId);
    if (!row || row.parentSessionId || row.origin === 'subagent' || !samePath(row.cwd, cwd)) {
      fail('workspace-mismatch', 'Only an ordinary session in this exact project can be attached.');
    }
    const expectedInstance = this.#instance;
    const workspace = (await this.#workspaceForPath(cwd, expectedInstance)).workspace;
    if (!workspace.sessionIds.includes(sessionId)) {
      // Native create explicitly adopts an existing identity and accounts it
      // to workspaceId. It submits no model prompt and preserves the session.
      const { value } = await this.#rpc('session/create', { request: { sessionId, workspaceId: workspace.workspaceId } }, { write: true, expectedInstance });
      if (value?.sessionId !== sessionId) fail('invalid-response', 'The host did not confirm the attached session.', { uncertain: true });
    }
    const confirmed = (await this.#workspaceForPath(cwd, expectedInstance)).workspace;
    if (!confirmed.sessionIds.includes(sessionId)) fail('workspace-attach-failed', 'The session was not confirmed in the project list.', { uncertain: true });
    return { accepted: true, sessionId, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, projectVisible: true, modelRequestsStarted: 0 };
  }

  async #hostCall(endpoint, args, { write = false, expectedInstance } = {}) {
    if (!this.#hostBridgeFile) fail('host-bridge-required', 'Install and bootstrap the FutureAide host bridge first.');
    let credential;
    try { credential = JSON.parse(await readBoundedFile(this.#hostBridgeFile, 2048)); }
    catch { fail('host-bridge-required', 'The local host bridge credential is unavailable.'); }
    if (credential.version !== 1 || !/^[a-f0-9]{64}$/.test(credential.token ?? '')) fail('host-bridge-required', 'The local host bridge credential is invalid.');
    return (await this.#rpc(endpoint, { ...args, token: credential.token }, { write, expectedInstance, channel: 'futureaide-control' })).value;
  }

  async hostStatus() { return this.#hostCall('ping', {}); }

  async #managedCall(method, input, write) {
    validId(input?.ownerId, 'ownerId');
    validId(input?.agentId, 'agentId');
    if (input.sessionId !== undefined) validId(input.sessionId);
    if (input.taskId !== undefined) validId(input.taskId, 'taskId');
    const expectedInstance = await this.#discover();
    return this.#hostCall(method, input, { write, expectedInstance });
  }

  /** Managed identities are internal to one caller's roster, never model-entered addresses. */
  async managedCreate(input) { return this.#managedCall('managedCreate', input, true); }
  async managedBeginTask(input) { return this.#managedCall('managedBeginTask', input, true); }
  async managedStatus(input) { return this.#managedCall('managedStatus', input, false); }
  /** Validate one roster binding and return only its ordinary-session read cursor. */
  async managedSession(input) {
    validId(input?.sessionId);
    if (typeof input?.workspace !== 'string' || !isAbsolute(input.workspace)) fail('invalid-input', 'A managed workspace is required.');
    const view = await this.managedStatus(input);
    if (view.ownerId !== input.ownerId || view.agentId !== input.agentId || view.sessionId !== input.sessionId
        || (input.taskId !== undefined && view.taskId !== input.taskId)
        || typeof view.workspace !== 'string' || !Number.isSafeInteger(view.throughSeq) || view.throughSeq < -1) {
      fail('managed-session-mismatch', 'DSH did not confirm the requested managed session.');
    }
    if (this.#dialect === undefined) await this.#modelCatalogFor(this.#instance);
    return { sessionId: view.sessionId, cwd: view.workspace, running: view.running,
      projections: { asOfSeq: view.throughSeq, values: { modelSelection: { next: view.currentModel } } } };
  }
  async managedSendMessage(input, text, { mode = 'queue', requestId = randomUUID() } = {}) {
    validId(requestId, 'requestId');
    if (typeof text !== 'string' || text.trim().length === 0 || Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES
        || !['queue', 'steer'].includes(mode)) fail('invalid-input', 'A nonempty message up to 128 KiB and queue or steer mode are required.');
    const row = await this.managedSession(input);
    const expectedInstance = this.#instance;
    if (this.#dialect === undefined) await this.modelCatalog();
    return this.#sendPrompt(row.sessionId, text, { mode, requestId }, expectedInstance);
  }
  async managedSelectModel(input, selection) {
    const row = await this.managedSession(input);
    const expectedInstance = this.#instance;
    if (this.#dialect === undefined) await this.modelCatalog();
    return this.#selectModel(row.sessionId, selection, expectedInstance);
  }
  async managedHistory(input) {
    validId(input?.targetSessionId, 'targetSessionId');
    const value = await this.#managedCall('managedHistory', input, false);
    if (!Array.isArray(value?.events)) fail('invalid-response', 'DSH returned invalid managed session history.');
    return value;
  }
  async managedAnswer(input) { return this.#managedCall('managedAnswer', input, true); }
  async managedCancel(input) { return this.#managedCall('managedCancel', input, true); }
  async managedDestroy(input) { return this.#managedCall('managedDestroy', input, true); }

  async historyCursor(sessionId, workspace) {
    validId(sessionId);
    if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
      fail('cursor-unavailable', 'No configured workspace is available to inspect this session history.');
    }
    const value = await this.#hostCall('historyCursor', { sessionId, workspace });
    if (value?.sessionId !== sessionId || !Number.isSafeInteger(value.throughSeq) || value.throughSeq < -1) {
      fail('invalid-response', 'FutureAide returned an invalid history cursor.');
    }
    return value;
  }

  async capabilities(sessionId, workspace, { activate = true } = {}) {
    validId(sessionId);
    const value = await this.#hostCall('capabilities', { sessionId, workspace, activate });
    if (value?.sessionId !== sessionId || value.complete !== true || !Array.isArray(value.tools)
        || value.totalTools !== value.tools.length || !value.permissions) fail('invalid-response', 'FutureAide returned an incomplete capability snapshot.');
    return value;
  }

  async selectModel(sessionId, selection) {
    const expectedInstance = await this.#ordinarySession(sessionId);
    return this.#selectModel(sessionId, selection, expectedInstance);
  }

  async #selectModel(sessionId, selection, expectedInstance) {
    const { value } = await this.#rpc('session/selectModel', { request: { sessionId, ...selection } }, { write: true, expectedInstance });
    if (!value?.selected || typeof value.selected.provider !== 'string' || typeof value.selected.model !== 'string') {
      fail('invalid-response', 'FutureAide did not confirm model selection.', { uncertain: true });
    }
    return { accepted: true, ...value, sessionId, source: 'native-session-selectModel',
      defaultModelBehavior: 'The native host also attempts to save this selection as its default. Explicitly select a model for each task.', modelRequestsStarted: 0 };
  }
}
