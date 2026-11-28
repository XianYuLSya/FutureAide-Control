// MCP callback bridge for the four headless CLI backends.
// The roster controls which tools are available for this dispatch. The bridge
// forwards authorized management calls to the matching loopback listener.
// Never imports `scoped-agents`, `peers`, `codex-ipc`, or `dsh`.
// Pushes `ask_parent` / `report_parent` straight to `POST /futureaide/cli-callback`
// on 127.0.0.1 (<10ms zero-polling wakeup), and falls back seamlessly to local
// `RosterStore.submitParentMessage(...)` when no HTTP listener is up.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CODEX_ASK_PARENT_INSTRUCTION, FINAL_REPORT_CONTRACT, QUESTION_CONTRACT } from './report-contract.mjs';
import { loadManagedRosterConfig } from './config.mjs';
import { RosterStore } from './roster-store.mjs';
import { readReportStatus } from './report-endpoint.mjs';
import { authorizeManagedTool, managedBoardRoutes, managedTokenFile, MANAGED_TOKEN_FILENAME,
  managedToolNames, verifyManagedCaller, managedBindingFromEnv } from './managed-cli-policy.mjs';
import { exitWhenInputCloses } from './stdio-exit.mjs';

export const CLI_CALLBACK_PATH = '/futureaide/cli-callback';
export const MCP_HTTP_PATH = '/mcp';
export const DEFAULT_REPORT_PORT = 17654;
const BOARD_TOOLS = [
  {
    name: 'futureaide_board_post',
    description: 'Post to the team meeting board; @后端1 or @团队长1/后端2 mentions wake or revive the target member to reply.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 4000, description: 'Board message text (use @name to wake teammates).' },
        urgent: { type: 'boolean', description: 'Prioritize mentioned descendants immediately.' },
        detail: { type: 'boolean' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'futureaide_board_read',
    description: 'Read recent messages from the team meeting board.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        after_seq: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  },
];

function postManagedMcpRpc({
  port,
  token,
  binding,
  rosterId,
  method,
  params,
  timeoutMs = 60000,
} = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || typeof token !== 'string' || !token) {
    return Promise.resolve(null);
  }
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
    'x-futureaide-caller': 'managed-cli',
    'x-futureaide-roster-id': rosterId,
    'x-futureaide-agent-id': binding.agentId,
    'x-futureaide-task-id': binding.taskId,
    'x-futureaide-request-id': binding.requestId,
    'x-futureaide-target': binding.target,
  };
  return new Promise(resolve => {
    let settled = false;
    const finish = val => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: MCP_HTTP_PATH,
      method: 'POST',
      agent: false,
      headers,
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
    }, res => {
      res.once('error', () => finish(null));
      res.once('aborted', () => finish(null));
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        const ct = String(res.headers['content-type'] ?? '').toLowerCase();
        let parsed = null;
        if (ct.includes('text/event-stream')) {
          const frames = raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean);
          for (let i = frames.length - 1; i >= 0; i -= 1) {
            try {
              const candidate = JSON.parse(frames[i]);
              if (candidate && (Object.hasOwn(candidate, 'result') || Object.hasOwn(candidate, 'error'))) {
                parsed = candidate;
                break;
              }
            } catch { /* ignore */ }
          }
        } else {
          try { parsed = JSON.parse(raw); } catch { parsed = null; }
        }
        finish({ statusCode: res.statusCode ?? 0, body: parsed });
      });
    });
    if (timeoutMs > 0) {
      req.once('timeout', () => { req.destroy(); finish(null); });
    }
    req.once('error', () => finish(null));
    req.end(payload);
  });
}

const PARENT_MESSAGE_DESCRIPTION = 'Message for the managed parent of this chat. Pass it directly; never a chat id, path, or internal number.';

const TOOLS = [
  {
    name: 'ask_parent',
    description: 'Ask the parent of this managed subagent a question. The caller is identified by the managed connection, so no chat or agent id is accepted. The question joins the subagent’s current task and is delivered to its parent; the task keeps waiting for the answer. You may go on with whatever does not depend on it: the answer arrives in this conversation as a message beginning "Parent answer:", and a final report is not accepted before then. '
      + QUESTION_CONTRACT + ' ' + CODEX_ASK_PARENT_INSTRUCTION,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 100000, description: PARENT_MESSAGE_DESCRIPTION },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_parent',
    description: 'Submit an explicit report from this managed subagent to its parent. The caller is identified by the managed connection. Ordinary final text from a native turn never completes a task; only this tool does, and only with final:true. '
      + FINAL_REPORT_CONTRACT,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 100000, description: PARENT_MESSAGE_DESCRIPTION },
        final: {
          type: 'boolean',
          description: 'Submit as the final report. Omitting it submits a progress report and keeps the task open.',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'feedback',
    description: 'Record a plugin problem or friction in the local feedback inbox.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['problem', 'friction'] },
        message: { type: 'string', minLength: 1, maxLength: 1200 },
        severity: { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['kind', 'message'],
      additionalProperties: false,
    },
  },
];

export function rosterIdentityFromPath(filename) {
  if (!filename || filename === ':memory:') return ':memory:';
  const resolved = path.resolve(filename);
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return createHash('sha256').update(normalized).digest('hex');
}

async function readCallerTokenInfo(roster, explicitTokenFile, env = process.env) {
  const rosterDir = roster && roster !== ':memory:' ? path.dirname(path.resolve(roster)) : null;
  const candidates = [
    env.FUTUREAIDE_MANAGED_CLI_TOKEN_FILE,
    managedTokenFile(explicitTokenFile || env.FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE),
    rosterDir && path.join(rosterDir, MANAGED_TOKEN_FILENAME),
    rosterDir && path.basename(rosterDir).toLowerCase() === 'scoped'
      && path.join(path.dirname(rosterDir), MANAGED_TOKEN_FILENAME),
  ];
  const expectedRoster = rosterIdentityFromPath(roster);
  for (const candidate of new Set(candidates.filter(Boolean))) {
    try {
      const value = JSON.parse(await readFile(candidate, 'utf8'));
      if (value?.roster === expectedRoster && typeof value.token === 'string' && value.token) return value;
    } catch { /* A new listener can publish the file on its next attempt. */ }
  }
  return null;
}

function resolveCallbackPort(explicitPort, tokenInfo, env = process.env) {
  return [explicitPort, tokenInfo?.port, Number(env.FUTUREAIDE_REPORT_PORT), DEFAULT_REPORT_PORT]
    .find(port => Number.isInteger(port) && port > 0 && port <= 65535);
}

const AUTHORITATIVE_REJECTION_CODES = new Set([
  'invalid-message',
  'submission-not-owned',
  'task-cancelled',
  'final-already-submitted',
  'question-unanswered',
  'answer-undelivered',
  'supplement-undelivered',
]);

/**
 * Push a parent callback straight to the loopback HTTP report listener.
 * Uses `node:http` directly over `127.0.0.1` so `HTTP_PROXY` / `HTTPS_PROXY`
 * never intercept loopback traffic.
 * Returns `{ receipt, via: 'http' }`, or `null` when the listener is down or belongs to another roster.
 */
export function postCliCallback({
  port,
  token,
  rosterId,
  payload,
  timeoutMs = 1500,
} = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(null);
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-futureaide-cli-callback': '1',
    ...(rosterId ? { 'x-futureaide-roster-id': rosterId } : {}),
    ...(typeof token === 'string' && token ? { authorization: `Bearer ${token}` } : {}),
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(val);
    };

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: CLI_CALLBACK_PATH,
      method: 'POST',
      agent: false,
      headers,
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('aborted', () => finish(null, null));
      res.once('error', () => finish(null, null));
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
        if (res.statusCode === 200 && parsed?.ok === true && parsed.receipt) {
          finish(null, { via: 'http', receipt: parsed.receipt });
          return;
        }
        const errCode = parsed?.error?.code;
        if (errCode && AUTHORITATIVE_REJECTION_CODES.has(errCode)) {
          finish(Object.assign(new Error(parsed.error.message || 'Callback rejected.'), {
            code: errCode,
            authoritative: true,
          }));
          return;
        }
        finish(null, null);
      });
    });

    req.once('timeout', () => {
      req.destroy();
      finish(null, null);
    });
    req.once('error', () => finish(null, null));
    req.end(body);
  });
}

/**
 * Submit `ask` or `report` via HTTP fast-path first, falling back seamlessly to
 * local `RosterStore.submitParentMessage` when the HTTP service is not listening.
 */
export async function submitCliCallback({
  roster,
  agentId,
  taskId,
  requestId,
  target,
  kind,
  message,
  final = false,
  port,
  token,
  tokenFile,
  env = process.env,
  getStore,
} = {}) {
  if (typeof message !== 'string' || !message.trim() || message.length > 100000) {
    throw Object.assign(new Error('A message of 1–100000 characters is required.'), { code: 'invalid-message' });
  }
  if (!['ask', 'report'].includes(kind)) {
    throw Object.assign(new Error('kind must be ask or report.'), { code: 'invalid-kind' });
  }

  if (roster && roster !== ':memory:') {
    const tokenInfo = token ? { token } : await readCallerTokenInfo(roster, tokenFile, env);
    const targetPort = resolveCallbackPort(port, tokenInfo, env);
    const rosterId = rosterIdentityFromPath(roster);
    const pushed = await postCliCallback({
      port: targetPort,
      token: token ?? tokenInfo?.token,
      rosterId,
      payload: {
        agentId,
        taskId,
        requestId,
        target,
        kind,
        message,
        final: final === true,
      },
    });
    if (pushed?.receipt) return pushed.receipt;
  }

  let ownStore = false;
  const store = typeof getStore === 'function' ? getStore() : (() => { ownStore = true; return new RosterStore(roster); })();
  try {
    return store.submitParentMessage(
      agentId,
      { kind, message, final: final === true },
      { taskId, requestId, ...(target ? { target } : {}) },
    );
  } finally {
    if (ownStore) store.close();
  }
}

export function createCliCallbackServer({
  roster,
  agentId,
  taskId,
  requestId,
  target = 'codex-cli',
  configFile,
  port,
  token,
  tokenFile,
  env = process.env,
  log = () => {},
} = {}) {
  if (!roster || !agentId || !taskId || !requestId) {
    throw new Error(`Missing managed ${target} dispatch.`);
  }
  let lazyStore = null;
  let recentErr = null;
  const getStore = () => {
    lazyStore ??= new RosterStore(roster);
    return lazyStore;
  };

  const server = new Server(
    { name: 'futureaide', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: 'Use ask_parent for questions and report_parent with final: true for the completed task.' },
  );

  const managedEnabled = env?.FUTUREAIDE_MANAGED_CLI === '1';
  const configuredRoles = managedEnabled && configFile && !env.FUTUREAIDE_ROLES_CONFIG?.trim()
    ? loadManagedRosterConfig(configFile, roster).then(config => config.teamConfigPath, () => undefined) : undefined;
  const roleOptionsForCall = async () => ({ env, teamConfigPath: await configuredRoles });
  const binding = { agentId, taskId, requestId, target };
  const localBinding = { ...managedBindingFromEnv(env, target), ...binding };
  const rosterId = rosterIdentityFromPath(roster);
  const baseTools = [...TOOLS, ...BOARD_TOOLS];
  let lastDiagnostic;

  const resolveLoopbackAuth = async () => {
    let tokenInfo = await readCallerTokenInfo(roster, tokenFile, env);
    if (!tokenInfo && !tokenFile && configFile) {
      const config = await loadManagedRosterConfig(configFile, roster).catch(() => undefined);
      if (config?.antigravityCallerTokenFile) {
        tokenInfo = await readCallerTokenInfo(roster, config.antigravityCallerTokenFile, env);
      }
    }
    if (!token && !tokenInfo?.token) return { code: 'managed-cli-token-unavailable' };
    const portNumber = resolveCallbackPort(port, tokenInfo, env);
    const status = await readReportStatus({ port: portNumber, expectedRoster: rosterId, requireManagement: true });
    if (!status.ready) return { code: status.reason.code, statusCode: status.reason.status };
    return { port: portNumber, token: token ?? tokenInfo.token };
  };
  const diagnose = (code, status) => {
    const diagnostic = code + (status ? ' (HTTP ' + status + ')' : '');
    if (diagnostic !== lastDiagnostic) log(diagnostic);
    lastDiagnostic = diagnostic;
  };
  const throughLoopback = async (method, params) => {
    const options = { binding, rosterId, method, params,
      timeoutMs: params.name === 'futureaide_wait_agents' ? 0 : method === 'tools/list' ? 3000 : 60000 };
    let auth = await resolveLoopbackAuth();
    if (!auth.token) return auth;
    let rpc = await postManagedMcpRpc({ ...options, ...auth });
    if (rpc?.statusCode === 401) {
      const current = await resolveLoopbackAuth();
      if (current.token && (current.token !== auth.token || current.port !== auth.port)) {
        auth = current;
        rpc = await postManagedMcpRpc({ ...options, ...current });
      }
    }
    if (rpc?.statusCode === 401) return { code: 'managed-cli-token-rejected', statusCode: 401 };
    if (!rpc?.body) return { code: 'report-service-invalid-rpc', statusCode: rpc?.statusCode, uncertain: true };
    return { rpc };
  };

  const listTools = async () => {
    if (!managedEnabled) return TOOLS;
    let allowed;
    const roleOptions = await roleOptionsForCall();
    try { allowed = managedToolNames(verifyManagedCaller(getStore(), localBinding).callerRole, roleOptions); }
    catch { return []; }
    if (allowed.length === baseTools.length) return baseTools;
    const result = await throughLoopback('tools/list', {});
    const remote = result.rpc?.body?.result?.tools;
    if (Array.isArray(remote)) {
      lastDiagnostic = undefined;
      const localNames = new Set(baseTools.map(tool => tool.name));
      return [...baseTools, ...remote.filter(tool => allowed.includes(tool.name) && !localNames.has(tool.name))];
    }
    diagnose(result.code ?? 'report-service-invalid-rpc', result.statusCode ?? result.rpc?.statusCode);
    return baseTools;
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));

  const callTool = async (toolName, args = {}) => {
    try {
      const roleOptions = await roleOptionsForCall();
      const store = getStore();
      const caller = managedEnabled
        ? verifyManagedCaller(store, localBinding, { allowFinal: toolName === 'report_parent' && args.final === true })
        : undefined;
      if (caller && !managedToolNames(caller.callerRole, roleOptions).includes(toolName)) {
        throw Object.assign(new Error('This tool is outside the caller’s managed role.'), { code: 'permission-denied' });
      }
      if (toolName === 'ask_parent') {
        const receipt = await submitCliCallback({
          roster, agentId, taskId, requestId, target,
          kind: 'ask', message: args.message, final: false,
          port, token, tokenFile, env, getStore,
        });
        return { content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      }
      if (toolName === 'report_parent') {
        const receipt = await submitCliCallback({
          roster, agentId, taskId, requestId, target,
          kind: 'report', message: args.message, final: args.final === true,
          port, token, tokenFile, env, getStore,
        });
        return { content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      }
      if (caller && toolName !== 'feedback') {
        const verified = authorizeManagedTool(store, caller, toolName, args, roleOptions);
        const boardPost = toolName === 'futureaide_board_post';
        if (boardPost && (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 4000
            || (args.urgent !== undefined && typeof args.urgent !== 'boolean'))) {
          throw Object.assign(new Error('Provide a board message of 1–4000 characters and a boolean urgent flag.'), { code: 'invalid-arguments' });
        }
        const result = await throughLoopback('tools/call', { name: toolName, arguments: args });
        if (result.rpc?.body?.result) return result.rpc.body.result;
        if (result.rpc?.body?.error) {
          throw Object.assign(new Error('The loopback service rejected this call.'), {
            code: result.rpc.body.error.data?.code ?? 'mcp-error',
          });
        }
        if (boardPost && result.uncertain) {
          throw Object.assign(new Error('The board post may already have been saved.'), { code: 'write-outcome-unknown' });
        }
        if (toolName === 'futureaide_board_read') {
          const board = store.listBoardMessages(verified.rootOwnerId, { limit: args.limit, afterSeq: args.after_seq });
          return { content: [{ type: 'text', text: JSON.stringify({ rootOwnerId: verified.rootOwnerId, ...board }) }] };
        }
        if (boardPost) {
          // Recheck after the asynchronous probe before writing a local post.
          const current = authorizeManagedTool(store, verified, toolName, args, roleOptions);
          const { mentions, routed } = managedBoardRoutes(store, current, args, roleOptions);
          const saved = store.postBoardMessage({
            rootOwnerId: current.rootOwnerId, author: current.callerName,
            authorRole: current.callerRole, authorAgentId: current.callerAgentId,
            authorTaskId: current.callerTaskId, authorRequestId: current.callerRequestId,
            text: args.message, mentions, routed, urgent: args.urgent === true,
          });
          return { content: [{ type: 'text', text: JSON.stringify({
            posted: true, seq: saved.seq, mentions, woken: [], deferred: routed.filter(route => route.action === 'deferred'), routed,
          }) }] };
        }
        diagnose(result.code, result.statusCode);
        throw Object.assign(new Error('FutureAide loopback management service is not reachable.'), {
          code: result.uncertain && !['futureaide_wait_agents', 'futureaide_read_report', 'futureaide_list_agents',
            'futureaide_inspect_agent', 'futureaide_agent_changes'].includes(toolName)
            ? 'write-outcome-unknown' : 'report-service-unavailable',
        });
      }
      if (toolName === 'feedback') {
        const deadline = Date.now() + 2000;
        verifyManagedCaller(store, localBinding);
        const record = store.get(agentId);
        const { feedbackRecordError, submitFeedback } = await import('./feedback-client.mjs');
        const activeErr = recentErr && Date.now() - Date.parse(recentErr.at) <= 900000 ? recentErr : null;
        const saved = await submitFeedback(
          { kind: args.kind, message: args.message, ...(args.severity ? { severity: args.severity } : {}) },
          {
            source: target,
            caller: store.owner(record.ownerId)?.source ?? null,
            target,
            name: record.name ?? null,
            error: feedbackRecordError(record, activeErr),
          },
          { configFile, deadline },
        );
        return { content: [{ type: 'text', text: JSON.stringify(saved) }] };
      }
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ error: { code: 'unknown-tool', message: `Unknown tool: ${toolName}` } }) }],
      };
    } catch (error) {
      if (toolName !== 'feedback' && typeof error?.code === 'string') {
        recentErr = { tool: toolName, code: error.code, at: new Date().toISOString() };
      }
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: {
              code: error?.code ?? 'operation-failed',
              message: toolName === 'feedback' ? 'Feedback could not be submitted.' : String(error?.message ?? error),
            },
          }),
        }],
      };
    }
  };
  server.setRequestHandler(CallToolRequestSchema, request => callTool(request.params?.name, request.params?.arguments));

  const closeStore = () => {
    if (lazyStore) {
      try { lazyStore.close(); } catch {}
      lazyStore = null;
    }
  };

  server.onclose = closeStore;
  const close = async () => {
    try { await server.close(); } finally { closeStore(); }
  };
  return { server, close, listTools, callTool };
}

export async function runCliCallbackBridge(argv = process.argv.slice(2), env = process.env) {
  let cliTarget = 'codex-cli';
  let rest = argv;
  if (['--claude-cli-reports', '--codex-cli-reports', '--agy-cli-reports'].includes(argv[0])) {
    cliTarget = argv[0].slice(2, -'-reports'.length);
    rest = argv.slice(1);
  }
  const [roster, agentId, taskId, requestId, fifth, sixth] = rest;
  const configFile = fifth === '--no-idle-session-cleanup' ? undefined : (fifth || undefined);
  const cleanupFlag = fifth === '--no-idle-session-cleanup' ? fifth : sixth;
  const { server, close } = createCliCallbackServer({
    roster: roster || env.FUTUREAIDE_ROSTER_PATH,
    agentId: agentId || env.FUTUREAIDE_AGENT_ID,
    taskId: taskId || env.FUTUREAIDE_TASK_ID,
    requestId: requestId || env.FUTUREAIDE_RUN_ID,
    target: cliTarget,
    configFile: configFile || env.FUTUREAIDE_CONFIG,
    env,
    log: message => process.stderr.write('[futureaide] ' + message + '\n'),
  });
  const transport = new StdioServerTransport();
  if (cleanupFlag !== '--no-idle-session-cleanup') {
    exitWhenInputCloses({ transport, close });
  }
  await server.connect(transport);
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCliCallbackBridge();
}
