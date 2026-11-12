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

let hosted;

async function health(port, { fetchImpl = globalThis.fetch, timeoutMs = 500 } = {}) {
  if (typeof fetchImpl !== 'function') return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response?.ok) return undefined;
    const value = await response.json();
    return value?.ok === true ? value : undefined;
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

/**
 * Read-only readiness. Never starts anything, so a status probe or an adapter's
 * probe() can call it safely. With `expectedRoster`, a service that answers for a
 * different roster (or names none) is not ready.
 */
export async function readReportStatus({ port = reportPort(), expectedRoster, fetchImpl } = {}) {
  const info = await health(port, { fetchImpl });
  if (!info) return { port, url: reportUrl(port), ready: false, hosting: 'none' };
  const hosting = hosted?.port === port ? 'this-process' : 'another-process';
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
export async function ensureReportService({ store, port = reportPort(), timeoutMs = 1500, fetchImpl, management, board, log = () => {} } = {}) {
  const expectedRoster = rosterIdentity(store);
  const current = await readReportStatus({ port, expectedRoster, fetchImpl });
  if (current.ready) return { ...current, started: false };
  if (current.reason?.code === 'report-service-foreign-roster') {
    log(`port ${port} is served by another roster; not reused`);
    return { ...current, started: false };
  }
  if (hosted?.port !== port) {
    try {
      // management mounts the shared management tools on the same MCP server; the
      // report surface owns that hook and adds no service or database of its own.
      const service = await startReportService({ store, port, log, ...(management ? { management } : {}), ...(board ? { board } : {}) });
      hosted = { port: service.port ?? port, service };
      // The listener loop owns this process's lifetime; the server must not keep
      // the process alive after that loop ends.
      try { service.server?.unref?.(); } catch { /* A host that cannot unref still works. */ }
      process.once('exit', () => { void hosted?.service?.close?.(); });
    } catch (error) {
      log(`report service start failed: ${error?.code ?? ''} ${error?.message ?? error}`);
    }
  }
  const waitingPort = hosted?.port ?? port;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await readReportStatus({ port: waitingPort, expectedRoster, fetchImpl });
    if (status.ready) return { ...status, started: Boolean(hosted?.port === waitingPort) };
    if (status.reason?.code === 'report-service-foreign-roster') {
      log(`port ${waitingPort} is served by another roster; not reused`);
      return { ...status, started: false };
    }
    if (Date.now() >= deadline) break;
    await pause(50);
  }
  return { port, url: reportUrl(port), ready: false, started: false,
    reason: { code: 'report-service-unavailable', message: 'The loopback tool service did not answer its health check in time.' } };
}

/** Stop the service this process started, if any. */
export async function closeReportService() {
  const service = hosted?.service;
  hosted = undefined;
  await service?.close?.();
}
