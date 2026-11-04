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
import { TRUSTED_CALLER } from './calling-context.mjs';
import { z } from 'zod';
import { resolveSocketCaller, resolveStdioCaller } from './claude-caller-identity.mjs';
import { adoptFirstListBinding } from './claude-report-binding.mjs';
import { createReportOwnership } from './claude-report-ownership.mjs';
import { FINAL_REPORT_CONTRACT, QUESTION_CONTRACT } from './report-contract.mjs';

export const SERVER_NAME = 'futureaide-report';
export const SERVER_VERSION = '0.1.0';
export const HTTP_PATH = '/mcp';
export const DEFAULT_PORT = 17654;
// How long an idle caller connection stays pooled: one identity lookup per session
// instead of one per call. Never below Node's 5 second default, or the socket would
// die between two ordinary tool calls.
export const DEFAULT_KEEP_ALIVE_MS = 600000;
export const REPORT_TOOL_NAMES = Object.freeze(['ask_parent', 'report_parent']);

export const INSTRUCTIONS = `FutureAide managed session bridge.

This server exists for one purpose: a Claude Desktop session owned by FutureAide Control reports to, and asks, the parent chat that created it. It also carries the shared management tools, so any verified Claude session can create and supervise named subagents. Your session is identified from the connection itself; no session id, chat id, name or route is accepted as an argument, so never look for one.

Only a session this plugin manages may ask or report. Any other session that calls these two tools is refused with not-owned-session and nothing is sent, and its own parent never hears about the attempt.

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
 * A native tool-use id, when the MCP client happens to expose one. MCP itself does
 * not carry it, so this is only a shortcut: without it the ownership layer matches
 * the open tool call by exact tool and arguments instead. The first live report
 * shows which one applies.
 */
const nativeToolUseId = extra => {
  const meta = extra?._meta ?? {};
  return [extra?.toolUseId, meta.toolUseId, meta['claude/toolUseId'], meta['anthropic/toolUseId']]
    .find(value => typeof value === 'string' && value.length > 0);
};

/**
 * The trusted caller record the shared service reads from `calling-context`
 * TRUSTED_CALLER: built only from what the transport proved — the native session
 * id, its workspace and the registry record — never from a tool argument, and
 * carrying no token and no image name. The verified binding rides along so a
 * parent session can answer cold without re-discovering the native session.
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

/** The `extra` the shared tool actions receive: the transport's own plus the verified caller. */
export function trustedExtra(extra, caller) {
  const trusted = trustedContextOf(caller);
  return trusted ? { ...extra, [TRUSTED_CALLER]: trusted } : extra;
}

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
 * @param {(input: object) => void} [options.management] Registers the shared
 *   name-addressed management tools on this same server, called with
 *   `{ server, caller, trusted }`. The caller is the verified one above.
 */
export function createClaudeReportServer({ resolveCaller, resolveOwned, management, adopt,
  instructions = INSTRUCTIONS, version = SERVER_VERSION } = {}) {
  if (typeof resolveCaller !== 'function') throw new TypeError('createClaudeReportServer requires resolveCaller');
  if (typeof resolveOwned !== 'function') throw new TypeError('createClaudeReportServer requires resolveOwned');
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions });

  const submit = async (kind, { message, final = false, extra }) => {
    const caller = await resolveCaller();
    let owned = await resolveOwned(caller, { tool: kind, input: { message, final },
      toolUseId: nativeToolUseId(extra) });
    // A listing never waits for a binding, so the only place this matters is a real
    // submission that arrives before the plugin has bound the session. Prove the
    // pending creation from the transcript opener here, once, then retry the lookup.
    if (!owned && typeof adopt === 'function') {
      const outcome = await adopt(caller).catch(error => ({ adopted: false, reason: error?.code ?? 'adopt-failed' }));
      if (outcome?.adopted) {
        owned = await resolveOwned(caller, { tool: kind, input: { message, final },
          toolUseId: nativeToolUseId(extra) }).catch(() => null);
      }
    }
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
    description: 'Ask the parent chat a question you cannot decide yourself. Returns accepted once the question is queued for the parent; end your turn and the answer arrives as a new message in this session. Ordinary replies and the end of a turn never reach the parent, so this tool is the only way to ask. Only a session this plugin manages may use it; any other session is refused with not-owned-session and nothing is sent. '
      + QUESTION_CONTRACT,
    inputSchema: { message },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    try { return okResult(await submit('ask', { message: args.message, extra })); }
    catch (error) { return errorResult(error); }
  });

  server.registerTool('report_parent', {
    description: 'Submit a progress report (final false, the default) or the final deliverable (final true) of the current task to the parent chat. Returns accepted once the report is queued; accepted is not delivery or reading. Only explicit reports reach the parent: ordinary assistant text and turn ends notify nobody. Submit final once, after the work is finished and verified, and submit no reports for that task afterwards. Only a session this plugin manages may use it; any other session is refused with not-owned-session and nothing is sent. '
      + FINAL_REPORT_CONTRACT,
    inputSchema: {
      message,
      final: z.boolean().optional().describe('true submits the final deliverable of this task. Omit or false for a progress report.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, extra) => {
    try { return okResult(await submit('report', { message: args.message, final: args.final === true, extra })); }
    catch (error) { return errorResult(error); }
  });

  // The same server also carries the shared name-addressed management tools when
  // the host supplies their registrar, so one Claude session drives DSH, Claude
  // Desktop and Codex Desktop exactly as any calling chat does. Reports and questions
  // stay the owned child's own path and are unaffected by that registration.
  if (typeof management === 'function') {
    management({ server, caller: async () => resolveCaller(),
      trusted: async () => trustedContextOf(await resolveCaller()) });
  }
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
export async function runStdioService({ resolveOwned, resolveCaller, instructions, identity = {},
  adopt, management, log = () => {} } = {}) {
  const resolve = resolveCaller ?? (() => resolveStdioCaller(identity));
  let server;
  try {
    const caller = await resolve();
    // No adoption here: the static table does not depend on a binding, and a real
    // submission still goes through the same call-time gate and adoption.
    const owned = typeof resolveOwned === 'function' ? await resolveOwned(caller, { tool: 'list' }) : null;
    server = createClaudeReportServer({ resolveOwned, instructions, management, adopt,
      resolveCaller: async () => caller });
    if (!owned) log('this session is not bound yet; the static tool table is served anyway');
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
  resolveCaller, instructions, identity = {}, adopt, management, rosterId = undefined,
  keepAliveTimeoutMs = DEFAULT_KEEP_ALIVE_MS, log = () => {} } = {}) {
  const startedAt = new Date().toISOString();
  const stats = { requests: 0, owned: 0, unowned: 0, served: 0 };
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
      // One cheap roster read for the health counters. Listing never waits for a
      // binding and never adopts: the table is static, and a real submission does
      // the adoption itself.
      try { owned = await resolveOwned(caller, { tool: 'list' }); }
      catch (error) {
        if (!resolution.ownershipNoted) {
          resolution.ownershipNoted = true;
          log(`session ${caller.sessionId} cannot report now (${error?.code ?? 'not-accepted'}): `
            + `${String(error?.message ?? error).slice(0, 200)}`);
        }
      }
      if (!owned && !resolution.unboundNoted) {
        resolution.unboundNoted = true;
        log(`session ${caller.sessionId} is not bound yet; serving the static tool table`);
      }
    }
    if (owned) stats.owned += 1; else stats.unowned += 1;
    let body;
    try { body = await readBody(req); }
    catch (error) { sendJson(res, 400, { error: { code: error.code ?? 'invalid-request', message: error.message } }); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    // Only a verified caller is a parent here; an unidentified peer gets nothing.
    // Every verified session gets the same static table; role is enforced per call,
    // so an unowned parent lists ask/report and is refused with not-owned-session
    // when it uses them, and an unverified peer still gets nothing.
    const mcp = caller
      ? createClaudeReportServer({ resolveCaller: async () => caller, resolveOwned, instructions, management, adopt })
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
 * The production wiring. Host it in the one long-lived plugin process that is
 * already up before any managed Claude session starts and stays up while they
 * idle; the roster is the SQLite database that process already holds, so the
 * service adds no file, lock or process of its own. Throws when the port is taken
 * (another install is serving it); the caller decides whether that is fatal.
 */
export async function startReportService({ store, port = DEFAULT_PORT, host = '127.0.0.1',
  env = process.env, management, log = () => {} } = {}) {
  if (!store) throw new TypeError('startReportService requires the shared RosterStore');
  return startHttpService({ port, host, log, management,
    // The health document names the roster it serves, so a caller can prove the
    // service it reached belongs to its own database.
    rosterId: typeof store.identity === 'function' ? store.identity() : undefined,
    resolveOwned: createReportOwnership({ store, env }),
    adopt: caller => adoptFirstListBinding({ store, caller, env }) });
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
  let adopt;
  if (rosterPath) {
    const { RosterStore } = await import('./roster-store.mjs');
    const store = new RosterStore(rosterPath);
    resolveOwned = createReportOwnership({ store });
    adopt = caller => adoptFirstListBinding({ store, caller });
    log(`ownership from the shared roster at ${rosterPath}`);
  } else if (ownershipPath) resolveOwned = (await import(pathToFileURL(ownershipPath).href)).resolveOwned;
  else if (accept) resolveOwned = developmentOwnership(accept.split(',').map(value => value.trim()).filter(Boolean), { log });
  if (argv.includes('--http')) {
    const port = Number.parseInt(argument(argv, '--port') ?? process.env.FUTUREAIDE_REPORT_PORT ?? String(DEFAULT_PORT), 10);
    const service = await startHttpService({ port, resolveOwned, adopt, log });
    process.stderr.write(`[futureaide-report] listening on ${service.url}\n`);
    const stop = async () => { await service.close(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }
  await runStdioService({ resolveOwned, adopt, log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => {
    process.stderr.write(`[futureaide-report] ${error?.code ?? 'failed'}: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
