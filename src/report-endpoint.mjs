// Readiness link to the loopback tool service that managed Claude sessions call
// back through. The service itself lives in src/claude-report-server.mjs (owned by
// the report surface); this module only answers "is it up, and what is its URL"
// and, in the long-lived plugin process, starts it once.
//
// Hosting rule (from that module's own contract): host it in the plugin process
// that is already up before any managed session starts — never in the shared
// monitor, which is created for a task and exits when work stops. A session must
// never be handed a tool endpoint that dies with its task, so the monitor passes
// hostReportService: false and only reads readiness.
import { DEFAULT_PORT, HTTP_PATH, startReportService } from './claude-report-server.mjs';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Loopback report port, configured inside the plugin (never a tool argument). */
export function reportPort(env = process.env) {
  const raw = env.FUTUREAIDE_REPORT_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : DEFAULT_PORT;
}

export function reportUrl(port) { return `http://127.0.0.1:${port}${HTTP_PATH}`; }

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
 * probe() can call it safely.
 */
export async function readReportStatus({ port = reportPort(), fetchImpl } = {}) {
  const info = await health(port, { fetchImpl });
  return { port, url: reportUrl(port), ready: Boolean(info),
    hosting: hosted?.port === port ? 'this-process' : info ? 'another-process' : 'none',
    ...(info ? { health: info } : {}) };
}

/**
 * Ensure the loopback tool service is ready: reuse whatever answers the health
 * check, otherwise start it in this process, then wait for the health check with
 * a short deadline.
 * @returns {{port:number,url:string,ready:boolean,started?:boolean,reason?:object}}
 */
export async function ensureReportService({ store, port = reportPort(), timeoutMs = 1500, fetchImpl, log = () => {} } = {}) {
  if (await health(port, { fetchImpl })) return { port, url: reportUrl(port), ready: true, started: false };
  if (hosted?.port !== port) {
    try {
      const service = await startReportService({ store, port, log });
      hosted = { port: service.port ?? port, service };
      process.once('exit', () => { void hosted?.service?.close?.(); });
    } catch (error) {
      // Another process may already own the port; the health check decides.
      log(`report service start failed: ${error?.code ?? ''} ${error?.message ?? error}`);
    }
  }
  const waitingPort = hosted?.port ?? port;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await health(waitingPort, { fetchImpl });
    if (info) return { port: waitingPort, url: reportUrl(waitingPort), ready: true, started: Boolean(hosted?.port === waitingPort) };
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
