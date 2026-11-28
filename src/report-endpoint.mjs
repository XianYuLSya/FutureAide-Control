// Readiness link to the loopback tool service a calling Claude Desktop session
// reaches. The service itself is src/claude-report-server.mjs (the shared
// name-addressed management tools); this module only answers "is OUR roster's
// service up, and what is its URL".
//
// Hosting rule: the one shared monitor hosts it (same RosterStore, same process
// lifetime), never a service per MCP connection. Identity is the roster itself —
// sha256 of the canonical database path from RosterStore.identity() — so a service
// that answers but belongs to another roster is reported as foreign and never
// reused.
import { DEFAULT_PORT, HTTP_PATH, startReportService } from './claude-report-server.mjs';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Loopback report port: config.reportPort, then FUTUREAIDE_REPORT_PORT, then the default. */
export function reportPort(config = {}, env = process.env) {
  if (Number.isInteger(config?.reportPort) && config.reportPort >= 0 && config.reportPort <= 65535) return config.reportPort;
  const raw = env.FUTUREAIDE_REPORT_PORT;
  if (raw !== undefined && raw !== '') {
    const value = Number.parseInt(raw, 10);
    if (Number.isInteger(value) && value >= 0 && value <= 65535) return value;
  }
  return DEFAULT_PORT;
}

export function reportUrl(port) { return `http://127.0.0.1:${port}${HTTP_PATH}`; }

/** Identity of the roster this store serves. */
export function rosterIdentity(store) { return typeof store?.identity === 'function' ? store.identity() : undefined; }

let hosted, exitHookRegistered = false;

/** A report listener bound by this process, including an ephemeral configured port. */
export function isReportServiceListening(port) {
  return hosted?.service.server.listening === true && (hosted.port === port || hosted.requestedPort === port);
}

/** Effective port to advertise to child CLI processes: live bound port first, then configured port. */
export function activeReportPort(config = {}, env = process.env) {
  const configured = reportPort(config, env);
  if (hosted?.service?.server?.listening === true && (hosted.port === configured || hosted.requestedPort === configured)) {
    return hosted.port;
  }
  return configured;
}

// A failed probe keeps one finite code: callers can tell a timeout from a
// connection failure, an HTTP refusal, or an unusable health document without
// forwarding any raw exception, response body, or filesystem path.
const healthFailure = (code, message, extra = {}) => ({ ok: false, reason: { code, message, ...extra } });

export const REPORT_HEALTH_TIMEOUT_MS = 500;

async function health(port, { fetchImpl = globalThis.fetch, timeoutMs = REPORT_HEALTH_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') {
    return healthFailure('report-service-connect-failed', 'This runtime has no HTTP client for the health check.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (controller.signal.aborted) {
      return healthFailure('report-service-health-timeout', `The health check did not answer within ${timeoutMs} ms.`);
    }
    if (!response?.ok) {
      const status = Number.isInteger(response?.status) ? response.status : undefined;
      return healthFailure('report-service-http-error',
        status === undefined ? 'The health check did not return a successful HTTP response.' : `The health check answered HTTP ${status}.`,
        status === undefined ? {} : { status });
    }
    let value;
    try { value = await response.json(); }
    catch {
      return controller.signal.aborted
        ? healthFailure('report-service-health-timeout', `The health check did not answer within ${timeoutMs} ms.`)
        : healthFailure('report-service-invalid-health', 'The health check did not return a JSON document.');
    }
    if (controller.signal.aborted) {
      return healthFailure('report-service-health-timeout', `The health check did not answer within ${timeoutMs} ms.`);
    }
    return value?.ok === true
      ? { ok: true, info: value }
      : healthFailure('report-service-invalid-health', 'The health check did not report ok: true.');
  } catch {
    return controller.signal.aborted
      ? healthFailure('report-service-health-timeout', `The health check did not answer within ${timeoutMs} ms.`)
      : healthFailure('report-service-connect-failed', 'The health check could not reach the loopback tool service.');
  } finally { clearTimeout(timer); }
}

/**
 * Read-only readiness. Never starts anything, so a status probe or an adapter's
 * probe() can call it safely. With `expectedRoster`, a service that answers for a
 * different roster (or names none) is not ready.
 */
export async function readReportStatus({ port = reportPort(), expectedRoster, fetchImpl, timeoutMs } = {}) {
  const probe = await health(port, { fetchImpl, timeoutMs });
  if (!probe.ok) return { port, url: reportUrl(port), ready: false, hosting: 'none', reason: probe.reason };
  const info = probe.info;
  const hosting = hosted?.port === port && isReportServiceListening(port) ? 'this-process' : 'another-process';
  if (expectedRoster !== undefined && info.roster !== expectedRoster) {
    return { port, url: reportUrl(port), ready: false, hosting, health: info,
      reason: { code: 'report-service-foreign-roster', message: `Port ${port} answers for a different roster; it was not reused.` } };
  }
  return { port, url: reportUrl(port), ready: true, hosting, health: info };
}

/**
 * Ensure OUR roster's tool service is ready: reuse it when the health document
 * names the same roster, otherwise start it in this process. A foreign service is
 * reported and left alone.
 * @returns {{port:number,url:string,ready:boolean,started?:boolean,reason?:object}}
 */
export async function ensureReportService({ store, port = reportPort(), timeoutMs = 1500, fetchImpl, management, board,
  onCliSubmission, runtimeDir, antigravityCallerTokenFile, canStart = () => true, log = () => {} } = {}) {
  const expectedRoster = rosterIdentity(store);
  const checkedPort = isReportServiceListening(port) ? hosted.port : port;
  if (isReportServiceListening(port) && typeof onCliSubmission === 'function') {
    hosted.onCliSubmission = onCliSubmission;
  }
  const current = await readReportStatus({ port: checkedPort, expectedRoster, fetchImpl });
  if (current.ready) return { ...current, started: false };
  if (current.reason?.code === 'report-service-foreign-roster') {
    log(`port ${port} is served by another roster; not reused`);
    return { ...current, started: false };
  }
  if (!isReportServiceListening(port)) {
    if (!canStart()) return { ...current, started: false };
    try {
      // management mounts the shared management tools on the same MCP server; the
      // report surface owns that hook and adds no service or database of its own.
      const holder = { onCliSubmission };
      const service = await startReportService({ store, port, log,
        onCliSubmission: payload => holder.onCliSubmission?.(payload),
        ...(runtimeDir ? { runtimeDir } : {}),
        ...(antigravityCallerTokenFile ? { antigravityCallerTokenFile } : {}),
        ...(management ? { management } : {}), ...(board ? { board } : {}) });
      hosted = { requestedPort: port, port: service.port ?? port, service,
        get onCliSubmission() { return holder.onCliSubmission; },
        set onCliSubmission(fn) { holder.onCliSubmission = fn; } };
      // The listener loop owns this process's lifetime; the server must not keep
      // the process alive after that loop ends.
      try { service.server?.unref?.(); } catch { /* A host that cannot unref still works. */ }
      if (!exitHookRegistered) {
        process.once('exit', () => { void hosted?.service?.close?.(); });
        exitHookRegistered = true;
      }
    } catch (error) {
      log(`report service start failed: ${error?.code ?? ''} ${error?.message ?? error}`);
    }
  }
  const waitingPort = isReportServiceListening(port) ? hosted.port : port;
  const deadline = Date.now() + timeoutMs;
  let lastReason = current.reason;
  for (;;) {
    const status = await readReportStatus({ port: waitingPort, expectedRoster, fetchImpl });
    if (status.ready) return { ...status, started: status.hosting === 'this-process' };
    if (status.reason?.code === 'report-service-foreign-roster') {
      log(`port ${waitingPort} is served by another roster; not reused`);
      return { ...status, started: false };
    }
    lastReason = status.reason;
    if (Date.now() >= deadline) break;
    await pause(50);
  }
  const cause = lastReason?.code ?? 'report-service-unavailable';
  return { port, url: reportUrl(port), ready: false, started: false,
    reason: { code: 'report-service-unavailable', message: 'The loopback tool service did not answer its health check in time.', cause } };
}

/** Stop the service this process started, if any. */
export async function closeReportService() {
  const service = hosted?.service;
  hosted = undefined;
  await service?.close?.();
}
