import { activeManagedRequestId } from './roster-store.mjs';
import { managedTokenFile, verifyManagedCaller, managedToolNames } from './managed-cli-policy.mjs';
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
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolveSocketCaller, resolveStdioCaller } from './claude-caller-identity.mjs';
import { replaceStateFile } from './replace-state-file.mjs';

export const SERVER_NAME = 'futureaide-report';
export const SERVER_VERSION = '0.1.0';
export const HTTP_PATH = '/mcp';
export const CLI_CALLBACK_PATH = '/futureaide/cli-callback';
export const DEFAULT_PORT = 17654;
export const ANTIGRAVITY_CALLER_TOKEN_FILENAME = 'antigravity-caller.json';
// The two read-only team-board routes this listener can mount. Kept as plain strings:
// the listener must not import the board module, so a board that is switched off costs
// this file nothing at all.
export const BOARD_PATH = '/board';
export const BOARD_DATA_PATH = '/board/data';
// How long an idle caller connection stays pooled: one identity lookup per session
// instead of one per call. Never below Node's 5 second default, or the socket would
// die between two ordinary tool calls.
export const DEFAULT_KEEP_ALIVE_MS = 600000;

export const INSTRUCTIONS = `FutureAide Control management tools.

The caller is identified from this connection itself: no session id, chat id, name or route is accepted as an argument, so never look for one. After dispatch, wait once with futureaide_wait_agents and taskKeys. Omit timeout_seconds. To wait after an event, pass nextCursor as after. Host limits apply; timeout leaves the task running.`;

/**
 * The trusted caller record the shared service reads from `calling-context`
 * TRUSTED_CALLER: built only from what the transport proved — the native session
 * id, its workspace and the registry record — never from a tool argument, and
 * carrying no token and no image name. The verified binding rides along so a
 * later call can resume straight from the roster.
 */
const antigravitySummaryCache = new Map();

function lookupAntigravitySummary(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId.trim() || conversationId === '__discovery__') {
    return undefined;
  }
  const id = conversationId.trim();
  const cached = antigravitySummaryCache.get(id);
  if (cached && Date.now() - cached.at < 30000) return cached.value;
  const appDataDir = (typeof process.env.ANTIGRAVITY_APP_DATA_DIR === 'string' && process.env.ANTIGRAVITY_APP_DATA_DIR.trim())
    ? process.env.ANTIGRAVITY_APP_DATA_DIR.trim()
    : path.join(homedir(), '.gemini', 'antigravity');
  const dbPath = path.join(appDataDir, 'conversation_summaries.db');
  if (!existsSync(dbPath)) return undefined;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(
      'SELECT title, workspace_uris FROM conversation_summaries WHERE conversation_id = ? LIMIT 1',
    ).get(id);
    if (!row) return undefined;
    let workspace;
    if (typeof row.workspace_uris === 'string' && row.workspace_uris.trim()) {
      const uris = JSON.parse(row.workspace_uris);
      if (Array.isArray(uris)) {
        for (const u of uris) {
          if (typeof u !== 'string' || !u.trim()) continue;
          if (/^file:\/\//i.test(u.trim())) {
            try { workspace = path.resolve(fileURLToPath(u.trim())); break; } catch { /* ignore */ }
          } else if (path.isAbsolute(u.trim())) {
            workspace = path.resolve(u.trim());
            break;
          }
        }
      }
    }
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : undefined;
    const value = workspace || title ? { ...(workspace ? { workspace } : {}), ...(title ? { title } : {}) } : undefined;
    if (value?.workspace) antigravitySummaryCache.set(id, { at: Date.now(), value });
    return value;
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

export function trustedContextOf(caller) {
  if (!caller || typeof caller !== 'object') return undefined;
  if (caller.source === 'managed-cli') {
    return caller.callerAgentId && caller.callerTaskId && caller.callerRequestId ? { ...caller } : undefined;
  }
  if (caller.source === 'antigravity') {
    if (typeof caller.conversationId !== 'string' || !caller.conversationId.trim()) return undefined;
    const conversationId = caller.conversationId.trim();
    let workspace = typeof caller.workspace === 'string' && caller.workspace.trim()
      ? caller.workspace.trim()
      : (typeof caller.cwd === 'string' && caller.cwd.trim() ? caller.cwd.trim() : undefined);
    let label = caller.label;
    if (!workspace || /[\\/]\.gemini[\\/]config[\\/]plugins([\\/]|$)/i.test(workspace)) {
      const summary = lookupAntigravitySummary(conversationId);
      if (summary?.workspace) workspace = summary.workspace;
      if (!label && summary?.title) label = summary.title;
    }
    return {
      source: 'antigravity',
      conversationId,
      nativeSessionId: conversationId,
      ...(workspace ? { workspace } : {}),
      ...(label ? { label } : {}),
    };
  }
  if (typeof caller.sessionId !== 'string' || typeof caller.cwd !== 'string') return undefined;
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
  instructions = INSTRUCTIONS, version = SERVER_VERSION, waitSignal, managedCaller, roleOptions } = {}) {
  if (typeof resolveCaller !== 'function') throw new TypeError('createClaudeReportServer requires resolveCaller');
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions });
  if (typeof management === 'function') {
    management({ server, waitSignal, managedCaller, roleOptions, caller: async () => resolveCaller(),
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
 * Timing-safe verification of an `Authorization: Bearer <token>` header against
 * the server instance's 32-byte hex Antigravity caller token.
 */
export function verifyAntigravityBearerToken(authHeader, expectedToken) {
  if (typeof authHeader !== 'string' || typeof expectedToken !== 'string' || !expectedToken) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
  if (!match) return false;
  const supplied = Buffer.from(match[1], 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

/**
 * Atomically persist `{ token, port, pid, updatedAt }` with mode 0o600.
 */
export async function writeAntigravityCallerTokenFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    await replaceStateFile(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function headerString(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function isLoopbackRemote(remoteAddress) {
  if (!remoteAddress) return true;
  return remoteAddress === '127.0.0.1' || remoteAddress === '::ffff:127.0.0.1' || remoteAddress === '::1';
}

/**
 * Start the shared loopback Streamable HTTP service. Stateless per request: each
 * POST gets its own server and transport instance (the SDK forbids reusing a
 * stateless transport), and the caller is re-verified from the TCP peer on every
 * request, so one shared process cannot leak another session's identity.
 */
export async function startHttpService({ port = DEFAULT_PORT, host = '127.0.0.1',
  resolveCaller, instructions, identity = {}, management, rosterId = undefined, board = undefined,
  store = undefined, onCliSubmission = undefined,
  runtimeDir = undefined, antigravityCallerTokenFile = undefined, antigravityCallerToken = undefined,
  managedCliTokenFile = undefined, teamConfigPath = undefined,
  keepAliveTimeoutMs = DEFAULT_KEEP_ALIVE_MS, log = () => {} } = {}) {
  const roleOptions = { teamConfigPath };
  // The board is a private roster view: refusing every other address here means the
  // option cannot be widened by accident, and nothing is bound or imported when it is off.
  if (board && host !== '127.0.0.1') {
    throw Object.assign(new Error('The team board serves a private roster: it may only listen on 127.0.0.1.'),
      { code: 'board-loopback-only' });
  }
  const startedAt = new Date().toISOString();
  const stats = { requests: 0, identified: 0, unidentified: 0, served: 0 };
  const callerToken = typeof antigravityCallerToken === 'string' && antigravityCallerToken.length > 0
    ? antigravityCallerToken
    : randomBytes(32).toString('hex');
  const tokenFile = antigravityCallerTokenFile
    || (runtimeDir ? path.join(runtimeDir, ANTIGRAVITY_CALLER_TOKEN_FILENAME) : undefined);
  const managedToken = randomBytes(32).toString('hex');
  const managedFile = managedCliTokenFile || managedTokenFile(tokenFile);
  if (tokenFile && managedFile && path.resolve(tokenFile).toLowerCase() === path.resolve(managedFile).toLowerCase()) {
    throw Object.assign(new Error('Managed and desktop token files must use separate destinations.'), { code: 'report-token-file-conflict' });
  }
  // One identity per TCP connection, dropped when that socket closes.
  const identities = new WeakMap();
  let boundPort = port;
  // The team board is mounted only when the installation switched it on: with `board`
  // absent these two paths are not routed at all, and nothing of the board is imported
  // or read. Both are plain GET reads on this listener's own loopback address; they are
  // not part of the MCP surface and answer no cross-site request (no CORS headers, and
  // the page only ever calls them from the same origin it was served from).
  const boardPage = async (res, type) => {
    const page = await board.page();
    if (!page) { sendJson(res, 404, { error: { code: 'board-page-missing', message: 'The team board page is not installed.' } }); return; }
    res.writeHead(200, { 'content-type': page.type ?? type, 'content-length': Buffer.byteLength(page.body),
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(page.body);
  };  // The board carries a private roster, so it only ever answers for the loopback name it
  // was reached by. A rebinding page arrives under its own host name and is refused; the
  // MCP surface and the health document answer exactly as before, with no such check.
  const boardHostAllowed = host => {
    const name = String(host ?? '').toLowerCase();
    return name === `127.0.0.1:${boundPort}` || name === `localhost:${boundPort}`;
  };

  const server = http.createServer(async (req, res) => {
    const reqPath = (req.url ?? '').split('?')[0];
    if (board && (reqPath === BOARD_PATH || reqPath === BOARD_DATA_PATH)) {
      // The roster behind this route changes constantly, so no answer — success, refusal
      // or failure — may be cached by anything between the listener and the page.
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: { code: 'method-not-allowed', message: 'The team board is read-only.' } }, { allow: 'GET' });
        return;
      }
      if (!boardHostAllowed(req.headers.host)) {
        sendJson(res, 403, { error: { code: 'board-host-rejected', message: `The team board answers only on 127.0.0.1:${boundPort}.` } });
        return;
      }
      try {
        if (reqPath === BOARD_PATH) await boardPage(res, 'text/html; charset=utf-8');
        else sendJson(res, 200, board.data());
      } catch (error) {
        log(`board request failed: ${String(error?.message ?? error).slice(0, 200)}`);
        if (!res.headersSent) sendJson(res, 503, { error: { code: 'board-unavailable', message: 'The team board data could not be read.' } });
        else res.end();
      }
      return;
    }
    if (reqPath === CLI_CALLBACK_PATH) {
      res.setHeader('cache-control', 'no-store');
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: `Only POST ${CLI_CALLBACK_PATH} is supported.` } }, { allow: 'POST' });
        return;
      }
      if (!isLoopbackRemote(req.socket?.remoteAddress)) {
        sendJson(res, 403, { ok: false, error: { code: 'loopback-only', message: 'CLI callbacks are permitted only on loopback.' } });
        return;
      }
      if (!store || typeof store.submitParentMessage !== 'function') {
        sendJson(res, 503, { ok: false, error: { code: 'cli-callback-store-unavailable', message: 'This listener has no attached RosterStore.' } });
        return;
      }
      const suppliedRosterId = headerString(req.headers, 'x-futureaide-roster-id')?.trim();
      if (suppliedRosterId && rosterId && suppliedRosterId !== rosterId) {
        sendJson(res, 409, { ok: false, error: { code: 'report-service-foreign-roster', message: 'Callback targets a different roster.' } });
        return;
      }
      let payload;
      try { payload = await readBody(req, 256 * 1024); }
      catch (error) {
        sendJson(res, 400, { ok: false, error: { code: error.code ?? 'invalid-request', message: error.message } });
        return;
      }
      const { agentId, taskId, requestId, target, kind, message, final } = payload ?? {};
      const tokenVerified = verifyAntigravityBearerToken(headerString(req.headers, 'authorization'), managedToken);
      const hasDispatchBinding = typeof agentId === 'string' && agentId.length > 0
        && typeof taskId === 'string' && taskId.length > 0
        && typeof requestId === 'string' && requestId.length > 0;
      if (!hasDispatchBinding) {
        sendJson(res, 400, { ok: false, error: { code: 'invalid-cli-callback', message: 'agentId, taskId, and requestId are required.' } });
        return;
      }
      if (!tokenVerified) {
        const bound = store.get(agentId);
        const matchesRoster = Boolean(bound && !bound.closed
          && bound.task?.taskId === taskId
          && activeManagedRequestId(bound.task) === requestId
          && (!target || bound.target === target));
        if (!matchesRoster) {
          sendJson(res, 401, { ok: false, error: { code: 'cli-callback-unauthorized', message: 'Unauthorized CLI callback: token or active dispatch binding is required.' } });
          return;
        }
      }
      if (!['ask', 'report'].includes(kind)) {
        sendJson(res, 400, { ok: false, error: { code: 'invalid-kind', message: 'kind must be ask or report.' } });
        return;
      }
      try {
        const receipt = store.submitParentMessage(
          agentId,
          { kind, message, final: final === true },
          { taskId, requestId, ...(typeof target === 'string' && target ? { target } : {}) },
        );
        if (typeof onCliSubmission === 'function') {
          try {
            await onCliSubmission({ agentId, taskId, requestId, kind, message, final: final === true, receipt });
          } catch (hookError) {
            log(`cli-callback hook warning: ${String(hookError?.message ?? hookError).slice(0, 200)}`);
          }
        }
        sendJson(res, 200, { ok: true, receipt });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: { code: error?.code ?? 'submission-rejected', message: String(error?.message ?? error) } });
      }
      return;
    }
    if (reqPath !== HTTP_PATH) {
      if (reqPath === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, server: SERVER_NAME, version: SERVER_VERSION, startedAt, stats,
          management: typeof management === 'function',
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

    const agyConvHeader = headerString(req.headers, 'x-antigravity-conversation-id');
    const callerHeader = headerString(req.headers, 'x-futureaide-caller')?.trim().toLowerCase();
    const isAntigravityRequest = agyConvHeader !== undefined || callerHeader === 'antigravity';
    const isManagedCliRequest = !isAntigravityRequest && callerHeader === 'managed-cli';

    let caller = null;
    if (isManagedCliRequest) {
      if (!isLoopbackRemote(req.socket?.remoteAddress)) {
        stats.unidentified += 1;
        sendJson(res, 403, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: 'Managed CLI authentication is permitted only on loopback.', data: { code: 'loopback-only' } },
        });
        return;
      }
      if (!verifyAntigravityBearerToken(headerString(req.headers, 'authorization'), managedToken)) {
        stats.unidentified += 1;
        sendJson(res, 401, {
          jsonrpc: '2.0', id: null,
          error: { code: -32001, message: 'A managed CLI bearer token is required.', data: { code: 'managed-cli-auth-required' } },
        });
        return;
      }
      try {
        if (!rosterId || headerString(req.headers, 'x-futureaide-roster-id') !== rosterId) {
          throw Object.assign(new Error('The managed roster does not match.'), { code: 'report-service-foreign-roster' });
        }
        caller = verifyManagedCaller(store, {
          agentId: headerString(req.headers, 'x-futureaide-agent-id'),
          taskId: headerString(req.headers, 'x-futureaide-task-id'),
          requestId: headerString(req.headers, 'x-futureaide-request-id'),
          target: headerString(req.headers, 'x-futureaide-target'),
          ownerId: headerString(req.headers, 'x-futureaide-owner-id'),
          workspace: headerString(req.headers, 'x-futureaide-workspace-b64')
            ? Buffer.from(headerString(req.headers, 'x-futureaide-workspace-b64'), 'base64').toString('utf8')
            : headerString(req.headers, 'x-futureaide-workspace'),
          role: headerString(req.headers, 'x-futureaide-role'),
        });
      } catch (error) {
        stats.unidentified += 1;
        sendJson(res, 403, {
          jsonrpc: '2.0', id: null,
          error: { code: -32001, message: 'The managed dispatch could not be verified.', data: { code: error.code ?? 'permission-denied' } },
        });
        return;
      }
      stats.identified += 1;
    } else if (isAntigravityRequest) {
      if (!isLoopbackRemote(req.socket?.remoteAddress)) {
        stats.unidentified += 1;
        sendJson(res, 403, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: 'Antigravity caller authentication is permitted only on loopback.', data: { code: 'loopback-only' } },
        });
        return;
      }
      if (!verifyAntigravityBearerToken(headerString(req.headers, 'authorization'), callerToken)) {
        stats.unidentified += 1;
        sendJson(res, 401, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: 'Unauthorized Antigravity caller: valid Bearer token is required.', data: { code: 'antigravity-auth-required' } },
        });
        return;
      }
      const conversationId = typeof agyConvHeader === 'string' ? agyConvHeader.trim() : '';
      if (!conversationId || conversationId.startsWith('managed-cli:')) {
        stats.unidentified += 1;
        sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32602, message: 'Missing or empty x-antigravity-conversation-id header.', data: { code: 'invalid-antigravity-conversation-id' } },
        });
        return;
      }
      const rawWorkspaceB64 = headerString(req.headers, 'x-antigravity-workspace-b64')?.trim();
      let rawWorkspace;
      if (rawWorkspaceB64) {
        try { rawWorkspace = Buffer.from(rawWorkspaceB64, 'base64').toString('utf8').trim(); }
        catch { rawWorkspace = undefined; }
      }
      if (!rawWorkspace) {
        rawWorkspace = headerString(req.headers, 'x-antigravity-workspace')?.trim();
      }
      caller = {
        source: 'antigravity',
        conversationId,
        workspace: rawWorkspace || undefined,
      };
      stats.identified += 1;
    } else {
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
      ({ caller } = await resolution);
      if (caller) stats.identified += 1; else stats.unidentified += 1;
    }
    let body;
    try { body = await readBody(req); }
    catch (error) { sendJson(res, 400, { error: { code: error.code ?? 'invalid-request', message: error.message } }); return; }
    if (isManagedCliRequest && body?.method === 'tools/call'
        && !managedToolNames(caller.callerRole, roleOptions).includes(body.params?.name)) {
      sendJson(res, 200, { jsonrpc: '2.0', id: body.id,
        result: { isError: true, content: [{ type: 'text', text: JSON.stringify({
          error: { code: 'permission-denied', message: 'This tool is outside the caller’s managed role.' },
        }) }] } });
      return;
    }
    const isWait = body?.method === 'tools/call' && body?.params?.name === 'futureaide_wait_agents';
    const waitController = new AbortController();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !isWait });
    // Only a verified caller gets a surface; an unidentified peer gets nothing.
    const mcp = caller
      ? createClaudeReportServer({ resolveCaller: async () => caller, instructions, management, waitSignal: waitController.signal,
        ...(isManagedCliRequest ? { managedCaller: caller, roleOptions } : {}) })
      : createUnavailableReportServer();
    const close = () => { if (!res.writableFinished) waitController.abort(); void transport.close().catch(() => {}); void mcp.close().catch(() => {}); };
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
  const close = () => new Promise(resolve => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
  });
  try {
    const endpoint = { port: boundPort, pid: process.pid, updatedAt: new Date().toISOString() };
    if (tokenFile) await writeAntigravityCallerTokenFile(tokenFile, { ...endpoint, token: callerToken });
    if (managedFile) await writeAntigravityCallerTokenFile(managedFile, { ...endpoint, token: managedToken, roster: rosterId });
  } catch (error) {
    await close();
    throw error;
  }
  const url = `http://${host}:${boundPort}${HTTP_PATH}`;
  return {
    server, stats, url, port: boundPort, host,
    antigravityCallerToken: callerToken,
    antigravityCallerTokenFile: tokenFile,
    managedCliTokenFile: managedFile,
    // Idle keep-alive sockets would otherwise hold the listener open for the whole
    // timeout; an in-flight request still finishes.
    close,
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
  management, board = undefined, onCliSubmission = undefined, runtimeDir = undefined,
  antigravityCallerTokenFile = undefined, antigravityCallerToken = undefined, managedCliTokenFile = undefined, teamConfigPath = undefined,
  log = () => {} } = {}) {
  if (!store) throw new TypeError('startReportService requires the shared RosterStore');
  const storeDir = typeof store.location === 'string' && store.location !== ':memory:'
    ? path.dirname(store.location)
    : undefined;
  const effectiveRuntimeDir = runtimeDir ?? storeDir;
  const tokenFile = antigravityCallerTokenFile
    || (process.env.FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE || undefined)
    || (effectiveRuntimeDir ? path.join(effectiveRuntimeDir, ANTIGRAVITY_CALLER_TOKEN_FILENAME) : undefined);
  return startHttpService({ port, host, log, store, management, teamConfigPath,
    managedCliTokenFile: managedCliTokenFile || process.env.FUTUREAIDE_MANAGED_CLI_TOKEN_FILE, ...(board ? { board } : {}),
    ...(onCliSubmission ? { onCliSubmission } : {}),
    ...(effectiveRuntimeDir ? { runtimeDir: effectiveRuntimeDir } : {}),
    ...(tokenFile ? { antigravityCallerTokenFile: tokenFile } : {}),
    ...(antigravityCallerToken ? { antigravityCallerToken } : {}),
    // The health document names the roster it serves, so a caller can prove the
    // service it reached belongs to its own database.
    rosterId: typeof store.identity === 'function' ? store.identity() : undefined });
}
