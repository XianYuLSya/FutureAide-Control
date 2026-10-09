import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { discoveryCandidates, isProcessAlive } from './discovery.mjs';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DISCOVERY_BYTES = 32 * 1024;
const MAX_LOG_BYTES = 512 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

export class FutureAideError extends Error {
  constructor(code, message, { uncertain = false, httpStatus } = {}) {
    super(message);
    this.name = 'FutureAideError';
    this.code = code;
    this.uncertain = uncertain;
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
    fail('unsafe-url', 'The FutureAide address must be a loopback HTTP URL.');
  }
  let url;
  try { url = new URL(raw); } catch {
    fail('unsafe-url', 'The FutureAide address must be a loopback HTTP URL.');
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

async function readBoundedFile(path, maxBytes, { tail = false, optional = false } = {}) {
  let handle;
  try {
    handle = await open(path, 'r');
    const stats = await handle.stat();
    if (!stats.isFile() || (!tail && stats.size > maxBytes)) {
      fail('invalid-instance', 'A FutureAide discovery file is invalid or too large.');
    }
    const start = tail ? Math.max(0, stats.size - maxBytes) : 0;
    const buffer = Buffer.alloc(Math.min(stats.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return undefined;
    if (error instanceof FutureAideError) throw error;
    fail('discovery-failed', 'A FutureAide discovery file could not be read.');
  } finally {
    await handle?.close();
  }
}

function numberFile(raw, name, maximum) {
  if (typeof raw !== 'string' || !/^\s*\d+\s*$/.test(raw)) {
    fail('invalid-instance', `The FutureAide ${name} file is invalid.`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail('invalid-instance', `The FutureAide ${name} file is invalid.`);
  }
  return value;
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
  #target;
  #dshDataHome;
  #temporaryRoot;
  #selectedCandidate;
  #preferredInstanceFile;

  constructor({ dataHome, dshDataHome, target, temporaryRoot, launchUrl, baseUrl, instanceFile, preferredInstanceFile, hostBridgeFile, fetchImpl, timeoutMs = 15_000 } = {}) {
    this.#dataHome = resolve(dataHome ?? join(homedir(), '.futureaide'));
    const launch = launchUrl ?? process.env.FUTUREAIDE_LAUNCH_URL;
    this.#configuredLaunch = launch === undefined ? undefined : parseLocalUrl(launch, true).href;
    this.#configuredBase = baseUrl === undefined ? undefined : parseLocalUrl(baseUrl).origin;
    if (this.#configuredLaunch && this.#configuredBase
        && new URL(this.#configuredLaunch).origin !== this.#configuredBase) {
      fail('instance-mismatch', 'The launch URL and base URL identify different FutureAide instances.');
    }
    const discoveryFile = instanceFile ?? process.env.FUTUREAIDE_INSTANCE_FILE;
    this.#instanceFile = discoveryFile === undefined ? undefined : resolve(discoveryFile);
    if (target !== undefined && !['auto', 'futureaide', 'dsh'].includes(target)) fail('invalid-input', 'target must be auto, futureaide, or dsh.');
    this.#preferredInstanceFile = preferredInstanceFile === undefined ? undefined : resolve(preferredInstanceFile);
    // Explicit targets always remain pinned; automatic discovery uses its
    // separate preferredInstanceFile hint, which may disappear after shutdown.
    this.#target = this.#configuredLaunch || this.#configuredBase || this.#instanceFile ? undefined
      : target ?? (this.#instanceFile || dataHome !== undefined ? undefined : 'auto');
    this.#dshDataHome = dshDataHome;
    this.#temporaryRoot = temporaryRoot;
    this.#hostBridgeFile = hostBridgeFile;
    this.#fetch = fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      fail('invalid-input', 'A fetch function and a timeout between 1 and 120000 milliseconds are required.');
    }
    this.#timeoutMs = timeoutMs;
  }

  async #discover() {
    if (this.#target) return this.#discoverAutomatic();
    let instance;
    if (this.#configuredLaunch) {
      instance = { baseUrl: new URL(this.#configuredLaunch).origin, launchUrl: this.#configuredLaunch, source: 'launch-url' };
    } else if (this.#instanceFile) {
      let record;
      try { record = JSON.parse(await readBoundedFile(this.#instanceFile, MAX_DISCOVERY_BYTES)); } catch (error) {
        if (error instanceof FutureAideError) throw error;
        fail('invalid-instance', 'The FutureAide instance file must contain valid JSON.');
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        fail('invalid-instance', 'The FutureAide instance file must contain an object.');
      }
      let launch = record.launchUrl;
      let base = record.baseUrl ?? record.url;
      if (launch === undefined && record.authToken !== undefined) {
        const url = parseLocalUrl(base);
        if (typeof record.authToken !== 'string') fail('invalid-instance', 'The instance launch token is invalid.');
        url.searchParams.set('token', record.authToken);
        launch = url.href;
      }
      if (launch !== undefined) {
        launch = parseLocalUrl(launch, true).href;
        base ??= new URL(launch).origin;
      }
      base = parseLocalUrl(base).origin;
      if (launch && new URL(launch).origin !== base) {
        fail('instance-mismatch', 'The instance file contains inconsistent FutureAide addresses.');
      }
      if (record.pid !== undefined && (!Number.isInteger(record.pid) || record.pid < 1 || record.pid > 2 ** 31 - 1)) {
        fail('invalid-instance', 'The instance PID is invalid.');
      }
      instance = { baseUrl: base, launchUrl: launch, source: 'instance-file', ...(record.pid === undefined ? {} : { pid: record.pid }) };
      if (record.application === 'dsh') {
        if (typeof record.dataRoot !== 'string' || !isAbsolute(record.dataRoot)
          || typeof record.instanceId !== 'string' || !/^[a-f0-9-]{36}$/i.test(record.instanceId)) fail('invalid-instance', 'Invalid native DSH instance metadata.');
        Object.assign(instance, { application: 'dsh', dataRoot: resolve(record.dataRoot), instanceId: record.instanceId });
      }
    } else {
      const runtime = join(this.#dataHome, '.runtime', 'futureaide');
      const rawPort = await readBoundedFile(join(runtime, 'futureaide-web.port'), 128, { optional: true });
      const base = this.#configuredBase ?? (rawPort === undefined ? undefined
        : `http://127.0.0.1:${numberFile(rawPort, 'port', 65535)}`);
      if (!base) fail('instance-not-found', 'No running FutureAide instance was discovered.');
      const rawPid = await readBoundedFile(join(runtime, 'futureaide-web.pid'), 128, { optional: true });
      const pid = this.#configuredBase || rawPid === undefined ? undefined : numberFile(rawPid, 'PID', 2 ** 31 - 1);
      const log = await readBoundedFile(join(runtime, 'logs', 'futureaide-desktop-service.log'), MAX_LOG_BYTES, { tail: true, optional: true });
      let launch;
      // Use the last matching native startup URL. Stale tokens fail the normal exchange.
      for (const match of log?.matchAll(/\bdsh web:\s*(\S+)/gu) ?? []) {
        try {
          const candidate = parseLocalUrl(match[1], true);
          if (candidate.origin === base) launch = candidate.href;
        } catch { /* Unrelated or truncated startup lines cannot authorize this instance. */ }
      }
      instance = { baseUrl: base, launchUrl: launch, source: this.#configuredBase ? 'base-url' : 'desktop-runtime', ...(pid === undefined ? {} : { pid }) };
    }
    if (this.#configuredBase && instance.baseUrl !== this.#configuredBase) {
      fail('instance-mismatch', 'The configured address does not match the discovered FutureAide instance.');
    }
    if (this.#instance?.baseUrl !== instance.baseUrl || this.#instance?.pid !== instance.pid) {
      this.#cookie = undefined;
      if (this.#instance) this.#dialect = undefined;
    }
    this.#instance = instance;
    return instance;
  }

  async #candidateInstance(candidate) {
    if (candidate.legacy) {
      const runtime = join(candidate.dataRoot, '.runtime', 'futureaide');
      const rawPort = await readBoundedFile(join(runtime, 'futureaide-web.port'), 128, { optional: true });
      if (rawPort === undefined) return undefined;
      const baseUrl = `http://127.0.0.1:${numberFile(rawPort, 'port', 65535)}`;
      const rawPid = await readBoundedFile(join(runtime, 'futureaide-web.pid'), 128, { optional: true });
      const pid = rawPid === undefined ? undefined : numberFile(rawPid, 'PID', 2 ** 31 - 1);
      const log = await readBoundedFile(join(runtime, 'logs', 'futureaide-desktop-service.log'), MAX_LOG_BYTES, { optional: true, tail: true });
      let launchUrl;
      for (const match of log?.matchAll(/\bdsh web:\s*(\S+)/gu) ?? []) {
        try { const parsed = parseLocalUrl(match[1], true); if (parsed.origin === baseUrl) launchUrl = parsed.href; } catch { /* Ignore truncated log lines. */ }
      }
      if (!launchUrl) return undefined;
      return { baseUrl, launchUrl, pid, dataRoot: candidate.dataRoot, application: 'futureaide', source: 'desktop-runtime' };
    }
    const raw = await readBoundedFile(candidate.instanceFile, MAX_DISCOVERY_BYTES, { optional: true });
    if (raw === undefined) return undefined;
    let record;
    try { record = JSON.parse(raw); } catch { fail('invalid-instance', 'Invalid local instance discovery record.'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) fail('invalid-instance', 'Invalid local instance discovery record.');
    if (!Number.isInteger(record.pid) || record.pid < 1 || record.pid > 2 ** 31 - 1) fail('invalid-instance', 'Discovery requires a valid host PID.');
    if (!isProcessAlive(record.pid)) return undefined;
    if (candidate.registered && (record.version !== 1 || record.application !== 'dsh'
      || typeof record.instanceId !== 'string' || !/^[a-f0-9-]{36}$/i.test(record.instanceId)
      || typeof record.dataRoot !== 'string' || !isAbsolute(record.dataRoot)
      || !samePath(record.dataRoot, candidate.dataRoot))) {
      fail('invalid-instance', 'The DSH discovery record does not match its data directory.');
    }
    let launchUrl = record.launchUrl;
    let baseUrl = record.baseUrl ?? record.url;
    if (launchUrl === undefined && typeof record.authToken === 'string') {
      const url = parseLocalUrl(baseUrl); url.searchParams.set('token', record.authToken); launchUrl = url.href;
    }
    launchUrl = parseLocalUrl(launchUrl, true).href;
    baseUrl = parseLocalUrl(baseUrl ?? new URL(launchUrl).origin).origin;
    if (new URL(launchUrl).origin !== baseUrl) fail('instance-mismatch', 'Discovery contains inconsistent local addresses.');
    return { baseUrl, launchUrl, pid: record.pid, ...(record.instanceId ? { instanceId: record.instanceId } : {}),
      application: candidate.application, dataRoot: candidate.dataRoot, source: candidate.registered ? 'dsh-plugin-registry' : 'futureaide-shell' };
  }

  async #discoverAutomatic() {
    if (this.#selectedCandidate) {
      const current = await this.#candidateInstance(this.#selectedCandidate);
      if (!current || !sameInstance(current, this.#instance)) fail('instance-changed', 'The selected host changed; no request was sent to another instance.');
      this.#instance = current;
      return current;
    }
    const candidates = await discoveryCandidates({ target: this.#target, dataHome: this.#dataHome,
      dshDataHome: this.#dshDataHome, temporaryRoot: this.#temporaryRoot, preferredInstanceFile: this.#preferredInstanceFile });
    for (const application of ['futureaide', 'dsh']) {
      const ready = [];
      const origins = new Set();
      let authFailure;
      for (const candidate of candidates.filter(item => item.application === application)) {
        let instance;
        try { instance = await this.#candidateInstance(candidate); }
        catch (error) {
          if (['discovery-failed', 'invalid-instance', 'unsafe-url', 'invalid-launch-url', 'instance-mismatch'].includes(error.code)) continue;
          throw error;
        }
        if (!instance || (instance.pid !== undefined && !isProcessAlive(instance.pid)) || origins.has(instance.baseUrl)) continue;
        this.#cookie = undefined;
        this.#dialect = undefined;
        try {
          await this.#listSessionsFor(instance);
          // Only a host that actually answered claims its origin; a rejected stale
          // record must not shadow the live host that shares the same address.
          origins.add(instance.baseUrl);
          ready.push({ instance, candidate, cookie: this.#cookie, dialect: this.#dialect });
        } catch (error) {
          if (['transport-error', 'timeout'].includes(error.code)) continue;
          // A crashed host leaves its discovery record behind, and the recorded PID
          // can be reused by an unrelated process that is alive. That record's token
          // is stale, so a rejected candidate is simply not the host: keep probing and
          // surface the authentication failure only when no candidate answers.
          if (['authentication-failed', 'authentication-required', 'bridge-auth-required'].includes(error.code)) {
            authFailure ??= error;
            continue;
          }
          // Protocol failures are visible; they must never silently reroute a
          // user's task to a different application.
          throw error;
        }
      }
      if (ready.length > 1) fail('ambiguous-instance', 'Multiple running hosts match. Configure an explicit instanceFile or baseUrl.');
      if (ready.length === 1) {
        const chosen = ready[0];
        this.#instance = chosen.instance; this.#selectedCandidate = chosen.candidate;
        this.#cookie = chosen.cookie; this.#dialect = chosen.dialect;
        return chosen.instance;
      }
      if (authFailure) throw authFailure;
    }
    fail('instance-not-found', 'No running FutureAide or registered DSH Web host was found. Enable the dsh-control-discovery plugin in the native DSH Web profile.');
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
          : 'The FutureAide request could not complete.', { uncertain });
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
          const code = typeof rawCode === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(rawCode)
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
    if (this.#dialect === undefined) await this.listSessions();
    const { value } = await this.#rpc('session/modelCatalog', {});
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
    return workspace;
  }

  async createProjectSession({ sessionId, cwd, agentPreset }) {
    await this.listSessions();
    const expectedInstance = this.#instance;
    const workspace = await this.#workspaceForPath(cwd, expectedInstance);
    const result = await this.createSession({ sessionId, agentPreset, workspaceId: workspace.workspaceId });
    const confirmed = await this.#workspaceForPath(cwd, expectedInstance);
    if (!confirmed.sessionIds.includes(sessionId)) fail('workspace-attach-failed', 'The session exists but was not confirmed in the project list.', { uncertain: true });
    return { ...result, workspaceId: workspace.workspaceId, workspaceTitle: workspace.title, projectVisible: true };
  }

  async attachSessionToWorkspace(sessionId, cwd) {
    const rows = (await this.listSessions()).items;
    const row = rows.find(item => item.sessionId === sessionId);
    if (!row || row.parentSessionId || row.origin === 'subagent' || !samePath(row.cwd, cwd)) {
      fail('workspace-mismatch', 'Only an ordinary session in this exact project can be attached.');
    }
    const expectedInstance = this.#instance;
    const workspace = await this.#workspaceForPath(cwd, expectedInstance);
    if (!workspace.sessionIds.includes(sessionId)) {
      // Native create explicitly adopts an existing identity and accounts it
      // to workspaceId. It submits no model prompt and preserves the session.
      const { value } = await this.#rpc('session/create', { request: { sessionId, workspaceId: workspace.workspaceId } }, { write: true, expectedInstance });
      if (value?.sessionId !== sessionId) fail('invalid-response', 'The host did not confirm the attached session.', { uncertain: true });
    }
    const confirmed = await this.#workspaceForPath(cwd, expectedInstance);
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
    const { value } = await this.#rpc('session/selectModel', { request: { sessionId, ...selection } }, { write: true, expectedInstance });
    if (!value?.selected || typeof value.selected.provider !== 'string' || typeof value.selected.model !== 'string') {
      fail('invalid-response', 'FutureAide did not confirm model selection.', { uncertain: true });
    }
    return { accepted: true, ...value, sessionId, source: 'native-session-selectModel',
      defaultModelBehavior: 'The native host also attempts to save this selection as its default. Explicitly select a model for each task.', modelRequestsStarted: 0 };
  }
}
