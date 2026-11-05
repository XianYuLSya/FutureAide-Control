// Loopback management tool surface for Claude Desktop sessions.
//
// One narrow job: serve the shared name-addressed management tools (`futureaide_*`)
// to a Claude Desktop session that calls back through this plugin, and make nothing
// else leave the session. This surface holds no task, roster or notification state
// of its own: the tools are registered by the shared registrar (mcp-server.mjs), so
// their schemas live in exactly one place for every caller.
//
// The calling session is identified from the connection itself — the parent process
// for stdio, the TCP peer's process chain for HTTP (see claude-caller-identity.mjs) —
// and never from a tool argument, so no session id, chat id, name or route can be
// supplied by a model.
//
// Two transports, one implementation:
//   stdio — one process per Claude session (`node claude-report-server.mjs --stdio`);
//   HTTP  — one shared loopback Streamable HTTP service for every session, so no
//           Node process is started per session. The service is bound to
//           127.0.0.1 and is never reachable from another host.
//
// A peer that cannot be identified gets a surface that lists no tools at all (no
// approval noise, no failing server icon), so registering this service at the
// workspace level shows the user's own chats nothing to approve.
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveSocketCaller, resolveStdioCaller } from './claude-caller-identity.mjs';

export const SERVER_NAME = 'futureaide-report';
export const SERVER_VERSION = '0.1.0';
export const HTTP_PATH = '/mcp';
export const DEFAULT_PORT = 17654;
// How long an idle caller connection stays pooled: one identity lookup per session
// instead of one per call. Never below Node's 5 second default, or the socket would
// die between two ordinary tool calls.
export const DEFAULT_KEEP_ALIVE_MS = 600000;

export const INSTRUCTIONS = `FutureAide Control management tools.

These tools manage named subagents for the current project. The calling chat is identified from this connection itself: no session id, chat id, name or route is accepted as an argument, so never look for one. Each tool reports its own result; an ordinary reply and the end of a turn notify nobody.`;

/**
 * The trusted caller record the shared service reads from `calling-context`
 * TRUSTED_CALLER: built only from what the transport proved — the native session
 * id, its workspace and the registry record — never from a tool argument, and
 * carrying no token and no image name. The verified binding rides along so a
 * later call can resume straight from the roster.
 */
export function trustedContextOf(caller) {
  if (!caller || typeof caller.sessionId !== 'string' || typeof caller.cwd !== 'string') return undefined;
  return {
    source: 'claude-desktop',
    nativeSessionId: caller.sessionId,
    workspace: caller.cwd,
    pid: caller.pid,
    ...(caller.procStart ? { procStart: caller.procStart } : {}),
    ...(caller.pidDomain ? { pidDomain: caller.pidDomain } : {}),
    ...(caller.socketPath ? { socketPath: caller.socketPath } : {}),
    ...(caller.recordFile ? { recordFile: caller.recordFile } : {}),
    ...(caller.directory ? { directory: caller.directory } : {}),
    ...(caller.hostSessionId ? { hostSessionId: caller.hostSessionId } : {}),
    ...(caller.name ? { label: caller.name } : {}),
    ...(caller.via ? { via: caller.via } : {}),
  };
}

/**
 * Build the MCP server for one already-identified caller.
 * @param {object} options
 * @param {() => Promise<object>} options.resolveCaller Verified caller; bound by
 *   the transport (parent process for stdio, TCP peer for HTTP).
 * @param {(input: object) => void} [options.management] Registers the shared
 *   name-addressed management tools on this same server, called with
 *   `{ server, caller, trusted }`. The caller is the verified one above.
 */
export function createClaudeReportServer({ resolveCaller, management,
  instructions = INSTRUCTIONS, version = SERVER_VERSION } = {}) {
  if (typeof resolveCaller !== 'function') throw new TypeError('createClaudeReportServer requires resolveCaller');
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions });
  if (typeof management === 'function') {
    management({ server, caller: async () => resolveCaller(),
      trusted: async () => trustedContextOf(await resolveCaller()) });
  }
  return server;
}

/** The surface for a peer this plugin cannot identify: connected, zero tools. */
export function createUnavailableReportServer({ version = SERVER_VERSION } = {}) {
  const server = new McpServer({ name: SERVER_NAME, version });
  // Answer tools/list with an empty list instead of a protocol error: clients that
  // list unconditionally must see "no tools", not a broken server. No instructions
  // ride along: an unidentified peer is told nothing about this plugin.
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return server;
}

/**
 * Run the stdio transport: one process per Claude Desktop session, identified by
 * its parent process.
 */
export async function runStdioService({ resolveCaller, instructions, identity = {}, management, log = () => {} } = {}) {
  const resolve = resolveCaller ?? (() => resolveStdioCaller(identity));
  let caller;
  try { caller = await resolve(); }
  catch (error) { log(`no verified caller (${error?.code ?? 'caller-unresolved'}); the tool surface lists no tools`); }
  const server = caller
    ? createClaudeReportServer({ resolveCaller: async () => caller, instructions, management })
    : createUnavailableReportServer();
  await server.connect(new StdioServerTransport());
  return server;
}

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

async function readBody(req, limitBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw Object.assign(new Error('The request body exceeds the accepted size.'), { code: 'request-too-large' });
    chunks.push(chunk);
  }
  if (!size) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('The request body is not valid JSON.'), { code: 'invalid-json' }); }
}

/**
 * Start the shared loopback Streamable HTTP service. Stateless per request: each
 * POST gets its own server and transport instance (the SDK forbids reusing a
 * stateless transport), and the caller is re-verified from the TCP peer on every
 * request, so one shared process cannot leak another session's identity.
 */
export async function startHttpService({ port = DEFAULT_PORT, host = '127.0.0.1',
  resolveCaller, instructions, identity = {}, management, rosterId = undefined,
  keepAliveTimeoutMs = DEFAULT_KEEP_ALIVE_MS, log = () => {} } = {}) {
  const startedAt = new Date().toISOString();
  const stats = { requests: 0, identified: 0, unidentified: 0, served: 0 };
  // One identity per TCP connection, dropped when that socket closes.
  const identities = new WeakMap();
  let boundPort = port;

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== HTTP_PATH) {
      if (path === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, server: SERVER_NAME, version: SERVER_VERSION, startedAt, stats,
          ...(rosterId === undefined ? {} : { roster: rosterId }) });
        return;
      }
      sendJson(res, 404, { error: { code: 'not-found', message: `Use POST ${HTTP_PATH}.` } });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { code: 'method-not-allowed', message: `Only POST ${HTTP_PATH} is supported.` } }, { allow: 'POST' });
      return;
    }
    stats.requests += 1;
    // Identity is resolved once per TCP connection and cached until that socket
    // closes: the peer cannot change mid-connection, and the lookup costs a
    // netstat read.
    let resolution = identities.get(req.socket);
    if (!resolution) {
      resolution = (async () => {
        try {
          // The default resolver reads the request socket; an injected resolver
          // gets the same context so it can be verified or replaced without a
          // second path.
          const value = await (resolveCaller ?? (() => resolveSocketCaller(req.socket,
            { serverPort: boundPort, ...identity })))({ req, socket: req.socket, serverPort: boundPort });
          log(`connection from ${value?.image ?? 'unknown-image'} pid=${value?.pid ?? '?'} `
            + `session=${value?.sessionId ?? '?'} via ${value?.via ?? '?'}`);
          return { caller: value ?? null };
        } catch (error) {
          log(`unidentified connection (${error?.code ?? 'caller-unresolved'}): ${String(error?.message ?? error).slice(0, 200)}`);
          return { caller: null, failure: error?.code ?? 'caller-unresolved' };
        }
      })();
      identities.set(req.socket, resolution);
      req.socket.once('close', () => identities.delete(req.socket));
    }
    const { caller } = await resolution;
    if (caller) stats.identified += 1; else stats.unidentified += 1;
    let body;
    try { body = await readBody(req); }
    catch (error) { sendJson(res, 400, { error: { code: error.code ?? 'invalid-request', message: error.message } }); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // Only a verified caller gets a surface; an unidentified peer gets nothing.
    const mcp = caller
      ? createClaudeReportServer({ resolveCaller: async () => caller, instructions, management })
      : createUnavailableReportServer();
    const close = () => { void transport.close().catch(() => {}); void mcp.close().catch(() => {}); };
    res.once('close', close);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      stats.served += 1;
    } catch (error) {
      log(`request failed: ${String(error?.message ?? error).slice(0, 200)}`);
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'transport-failed', message: 'The MCP request could not be handled.' } });
      else res.end();
      close();
    }
  });

  await new Promise((resolve, reject) => {
    const onError = error => reject(error?.code === 'EADDRINUSE'
      ? Object.assign(new Error(`Another process already serves ${host}:${port}. Only one report service may own `
        + 'this port, so the running one keeps serving; do not start a second.'), { code: 'report-port-in-use' })
      : error);
    server.once('error', onError);
    server.listen(port, host, () => { server.off('error', onError); resolve(); });
  });
  // A tool call costs two process lookups when it has to re-establish identity, and
  // the caller's own HTTP client keeps its pooled socket only as long as this
  // timeout allows. Ten minutes keeps a working session on one connection instead of
  // paying that cost every few calls. Node requires headersTimeout to exceed it.
  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.headersTimeout = Math.max(server.headersTimeout ?? 0, keepAliveTimeoutMs + 1000);
  boundPort = server.address()?.port ?? port;
  const url = `http://${host}:${boundPort}${HTTP_PATH}`;
  return {
    server, stats, url, port: boundPort, host,
    // Idle keep-alive sockets would otherwise hold the listener open for the whole
    // timeout; an in-flight request still finishes.
    close: () => new Promise(resolve => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    }),
  };
}

/**
 * The production wiring. Host it in the one long-lived plugin process that is
 * already up while a calling session works; the roster is the SQLite database that
 * process already holds, so the service adds no file, lock or process of its own.
 * Throws when the port is taken (another install is serving it); the caller decides
 * whether that is fatal.
 */
export async function startReportService({ store, port = DEFAULT_PORT, host = '127.0.0.1',
  management, log = () => {} } = {}) {
  if (!store) throw new TypeError('startReportService requires the shared RosterStore');
  return startHttpService({ port, host, log, management,
    // The health document names the roster it serves, so a caller can prove the
    // service it reached belongs to its own database.
    rosterId: typeof store.identity === 'function' ? store.identity() : undefined });
}
