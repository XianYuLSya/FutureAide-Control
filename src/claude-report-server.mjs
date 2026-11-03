// Claude Desktop managed-session report surface.
//
// One narrow job: let a Claude Desktop session that FutureAide Control owns call
// `ask_parent` and `report_parent`, and make nothing else leave the session.
// Ordinary assistant text, tool use and the end of a turn never notify the
// parent; only an accepted tool call is a report. This server holds no task,
// roster or notification state of its own: it validates that the calling
// session is plugin-owned and that its current task can accept the submission,
// then returns `accepted` for the shared scoped state machine to deliver. The
// native transcript stays the persistent record of what was reported.
//
// Two transports, one implementation:
//   stdio — one process per Claude session (`node claude-report-server.mjs --stdio`);
//   HTTP  — one shared loopback Streamable HTTP service for every owned session,
//           so no Node process is started per session. The service is bound to
//           127.0.0.1 and identifies each caller from its TCP peer (see
//           claude-caller-identity.mjs); it is never reachable from another host.
//
// A session that is not plugin-owned keeps its normal chat: the service answers
// it with a surface that lists no tools at all (no approval noise, no failing
// server icon), and every submission is refused by code even if it races an
// ownership change. The same gate is what makes a workspace-level registration
// safe: the user's own chats in that project see nothing to approve.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { resolveSocketCaller, resolveStdioCaller } from './claude-caller-identity.mjs';
import { createReportOwnership } from './claude-report-ownership.mjs';

export const SERVER_NAME = 'futureaide-report';
export const SERVER_VERSION = '0.1.0';
export const HTTP_PATH = '/mcp';
export const DEFAULT_PORT = 17654;
export const REPORT_TOOL_NAMES = Object.freeze(['ask_parent', 'report_parent']);

export const INSTRUCTIONS = `FutureAide managed session bridge.

This server exists for one purpose: a Claude Desktop session owned by FutureAide Control reports to, and asks, the Codex parent chat that created it. It has two tools, ask_parent and report_parent. Your session is identified from the connection itself; no session id, chat id, name or route is accepted as an argument, so never look for one.

What reaches the parent:
- Your ordinary replies, tool use and the end of a turn are never forwarded. Nothing is automatic: a turn that ends without a tool call notifies nobody.
- This server identifies the session it is connected to, not the agent that writes the call. Only the session's own reports are observed by the main chat, so a sub-agent working inside the task must not use these tools: it reports to its own parent instead.
- ask_parent(message) asks the parent something you cannot decide yourself: a decision, a permission, or a missing fact. The tool returns accepted for delivery; end your turn and wait. The parent's answer arrives in this session as a new message. Ask once, do not poll, and do not repeat the question.
- report_parent(message, final=false) submits a progress report. Use it for a milestone or a change of plan the parent must know now, not for every step.
- report_parent(message, final=true) submits the final deliverable of the current task. Send it once the work is really finished and verified, and include what was done, how it was verified, and what remains.
- After a final report is accepted, do not submit another report for that task. The parent decides what happens next; a cancelled or closed task refuses further reports.

Reading the result:
- accepted:true means the parent side accepted this submission for delivery, and the result carries the taskId it belongs to. It is not proof of delivery, of reading, or of an answer. A late result whose taskId is not your current task belongs to an older task: ignore it.
- isError true means the submission was refused. Read error.code and act on it: not-owned-session and caller-unresolved mean this session must not report at all; task-closed, task-cancelled, task-finished and report-final-already-submitted mean stop writing reports for this task. Do not retry the same call with different wording or arguments.
- Never state in your reply that you reported something unless the tool returned accepted:true.`;

const refuse = (code, message) => Object.assign(new Error(message), { code });

const errorResult = error => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({
    error: { code: error?.code ?? 'operation-failed', message: String(error?.message ?? error).slice(0, 2000) },
  }) }],
});

const okResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/**
 * Build the MCP server for one already-identified caller.
 * @param {object} options
 * @param {() => Promise<object>} options.resolveCaller Verified caller; bound by
 *   the transport (parent process for stdio, TCP peer for HTTP).
 * @param {(caller: object, context: object) => Promise<object|null>} options.resolveOwned
 *   Returns the plugin-owned handle for this caller: `{ agentName, taskId,
 *   ask({message}), report({message, final}) }`, or null when the session is not
 *   bound to an owned agent. Submission methods resolve `{accepted:true,...}` or
 *   throw an Error with a `code`; they are supplied by the shared roster/state
 *   machine and are the only place task state is read.
 */
export function createClaudeReportServer({ resolveCaller, resolveOwned, instructions = INSTRUCTIONS,
  version = SERVER_VERSION } = {}) {
  if (typeof resolveCaller !== 'function') throw new TypeError('createClaudeReportServer requires resolveCaller');
  if (typeof resolveOwned !== 'function') throw new TypeError('createClaudeReportServer requires resolveOwned');
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions });

  const submit = async (kind, { message, final = false }) => {
    const caller = await resolveCaller();
    const owned = await resolveOwned(caller, { tool: kind });
    if (!owned) {
      throw refuse('not-owned-session',
        `Claude session ${caller?.sessionId ?? '(unknown)'} is not bound to a FutureAide-owned agent. `
        + 'Only plugin-owned sessions may report or ask; this session must answer in its own chat.');
    }
    if (owned.taskId === undefined || owned.taskId === null) {
      throw refuse('task-missing', 'This subagent has no current task; the submission was not recorded.');
    }
    const result = kind === 'ask'
      ? await owned.ask({ message, caller })
      : await owned.report({ message, final, caller });
    if (result?.accepted !== true) {
      throw refuse(result?.code ?? 'not-accepted',
        result?.message ?? 'The submission was not accepted by the FutureAide state machine.');
    }
    return {
      accepted: true,
      kind: kind === 'ask' ? 'question' : 'report',
      taskId: owned.taskId,
      ...(owned.agentId ? { agentId: owned.agentId } : {}),
      ...(owned.agentName ? { agent: owned.agentName } : {}),
      ...(result.receiptId ? { receiptId: result.receiptId } : {}),
      ...(kind === 'report' ? { final } : {}),
      note: kind === 'ask'
        ? 'Accepted for delivery. End your turn; the answer arrives as a new message in this session.'
        : final
          ? 'Final report accepted. Do not submit another report for this task.'
          : 'Progress report accepted. Continue the task unless the parent says otherwise.',
    };
  };

  const message = z.string().min(1).max(100000)
    .describe('Report or question text. Pass it directly; do not create a file to communicate.');

  server.registerTool('ask_parent', {
    description: 'Ask the Codex parent chat a question you cannot decide yourself. Returns accepted once the question is queued for the parent; end your turn and the answer arrives as a new message in this session. Ordinary replies and the end of a turn never reach the parent, so this tool is the only way to ask.',
    inputSchema: { message },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async args => {
    try { return okResult(await submit('ask', { message: args.message })); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool('report_parent', {
    description: 'Submit a progress report (final false, the default) or the final deliverable (final true) of the current task to the Codex parent chat. Returns accepted once the report is queued; accepted is not delivery or reading. Only explicit reports reach the parent: ordinary assistant text and turn ends notify nobody. Submit final once, after the work is finished and verified, and submit no reports for that task afterwards.',
    inputSchema: {
      message,
      final: z.boolean().optional().describe('true submits the final deliverable of this task. Omit or false for a progress report.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async args => {
    try { return okResult(await submit('report', { message: args.message, final: args.final === true })); }
    catch (error) { return errorResult(error); }
  });

  return server;
}

/** The surface for a session this plugin does not own: connected, zero tools. */
export function createUnavailableReportServer({ version = SERVER_VERSION } = {}) {
  const server = new McpServer({ name: SERVER_NAME, version });
  // Answer tools/list with an empty list instead of a protocol error: clients that
  // list unconditionally must see "no tools", not a broken server. No instructions
  // ride along: an unowned session is told nothing about reporting.
  server.server.registerCapabilities({ tools: {} });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return server;
}

/** Run the stdio transport: one process per Claude Desktop session. */
export async function runStdioService({ resolveOwned, resolveCaller, instructions, identity = {}, log = () => {} } = {}) {
  const resolve = resolveCaller ?? (() => resolveStdioCaller(identity));
  let server;
  try {
    const caller = await resolve();
    const owned = typeof resolveOwned === 'function' ? await resolveOwned(caller, { tool: 'list' }) : null;
    server = owned ? createClaudeReportServer({ resolveOwned, instructions, resolveCaller: async () => caller })
      : createUnavailableReportServer();
    if (!owned) log('this session is not plugin-owned; the report surface lists no tools');
  } catch (error) {
    server = createUnavailableReportServer();
    log(`no verified caller (${error?.code ?? 'caller-unresolved'}); the report surface lists no tools`);
  }
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
    if (size > limitBytes) throw refuse('request-too-large', 'The request body exceeds the accepted size.');
    chunks.push(chunk);
  }
  if (!size) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); }
  catch { throw refuse('invalid-json', 'The request body is not valid JSON.'); }
}

/**
 * Start the shared loopback Streamable HTTP service. Stateless per request: each
 * POST gets its own server and transport instance (the SDK forbids reusing a
 * stateless transport), and the caller is re-verified from the TCP peer on every
 * request, so one shared process cannot leak another session's identity.
 */
export async function startHttpService({ port = DEFAULT_PORT, host = '127.0.0.1', resolveOwned,
  resolveCaller, instructions, identity = {}, log = () => {} } = {}) {
  const startedAt = new Date().toISOString();
  const stats = { requests: 0, owned: 0, unowned: 0, served: 0 };
  // One identity per TCP connection, dropped when that socket closes.
  const identities = new WeakMap();
  let boundPort = port;

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== HTTP_PATH) {
      if (path === '/healthz' && req.method === 'GET') {
        sendJson(res, 200, { ok: true, server: SERVER_NAME, version: SERVER_VERSION, startedAt, stats });
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
    // netstat read. Ownership is still re-read on every request, because a task
    // can be cancelled or finished between two calls on the same connection.
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
    let owned = null;
    if (caller && typeof resolveOwned === 'function') {
      try { owned = await resolveOwned(caller, { tool: 'list' }); }
      catch (error) {
        if (!resolution.ownershipNoted) {
          resolution.ownershipNoted = true;
          log(`owned session ${caller.sessionId} cannot report now (${error?.code ?? 'not-accepted'}): `
            + `${String(error?.message ?? error).slice(0, 200)}`);
        }
      }
    }
    if (owned) stats.owned += 1; else stats.unowned += 1;
    let body;
    try { body = await readBody(req); }
    catch (error) { sendJson(res, 400, { error: { code: error.code ?? 'invalid-request', message: error.message } }); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const mcp = owned
      ? createClaudeReportServer({ resolveCaller: async () => caller, resolveOwned, instructions })
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
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  boundPort = server.address()?.port ?? port;
  const url = `http://${host}:${boundPort}${HTTP_PATH}`;
  return {
    server, stats, url, port: boundPort, host,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

/**
 * Development-only ownership stub for a UI or transport test before the shared
 * roster integration exists: accept exactly the pinned native session ids and
 * record what was submitted. It never widens identity — the caller is still
 * resolved from the connection — and it writes no state of its own.
 */
export function developmentOwnership(sessions, { log = () => {} } = {}) {
  const pinned = new Set(sessions.map(value => String(value).toLowerCase()));
  log(`DEVELOPMENT stub: only these native sessions are accepted (${[...pinned].join(', ')}); nothing is delivered.`);
  return async caller => (pinned.has(String(caller?.sessionId ?? '').toLowerCase()) ? {
    agentName: 'development-stub', taskId: 1,
    async ask({ message }) { log(`stub ask (${message.length} chars): ${message.slice(0, 120)}`); return { accepted: true }; },
    async report({ message, final }) { log(`stub report final=${final} (${message.length} chars): ${message.slice(0, 120)}`); return { accepted: true }; },
  } : null);
}

/**
 * The production wiring. Host it in the plugin's own long-lived process — the one
 * that is already up before any Claude session starts and stays up while managed
 * sessions idle — never in the shared monitor, which is created for a task and
 * exits when work stops. The roster is the same SQLite database the plugin
 * process already holds; the service adds no file, lock or process of its own.
 * Throws when the port is taken (another install is serving it); the caller
 * decides whether that is fatal.
 */
export async function startReportService({ store, port = DEFAULT_PORT, host = '127.0.0.1', log = () => {} } = {}) {
  if (!store) throw new TypeError('startReportService requires the shared RosterStore');
  return startHttpService({ port, host, resolveOwned: createReportOwnership({ store }), log });
}

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv = process.argv.slice(2)) {
  const ownershipPath = argument(argv, '--ownership');
  const accept = argument(argv, '--accept-session');
  const rosterPath = argument(argv, '--roster');
  const log = message => process.stderr.write(`[futureaide-report] ${message}\n`);
  // No ownership integration is bundled by default: without a resolver the
  // service refuses every call, so a mistakenly started service exposes nothing.
  // Precedence: the shared roster (production), an explicit adapter module, then
  // the pinned-session development stub.
  let resolveOwned;
  if (rosterPath) {
    const { RosterStore } = await import('./roster-store.mjs');
    resolveOwned = createReportOwnership({ store: new RosterStore(rosterPath) });
    log(`ownership from the shared roster at ${rosterPath}`);
  } else if (ownershipPath) resolveOwned = (await import(pathToFileURL(ownershipPath).href)).resolveOwned;
  else if (accept) resolveOwned = developmentOwnership(accept.split(',').map(value => value.trim()).filter(Boolean), { log });
  if (argv.includes('--http')) {
    const port = Number.parseInt(argument(argv, '--port') ?? process.env.FUTUREAIDE_REPORT_PORT ?? String(DEFAULT_PORT), 10);
    const service = await startHttpService({ port, resolveOwned, log });
    process.stderr.write(`[futureaide-report] listening on ${service.url}\n`);
    const stop = async () => { await service.close(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  await runStdioService({ resolveOwned, log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => {
    process.stderr.write(`[futureaide-report] ${error?.code ?? 'failed'}: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
