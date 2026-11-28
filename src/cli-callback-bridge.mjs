// Ultra-thin zero-heavy-dependency MCP callback bridge for headless CLI subagents
// (`codex-cli` and `claude-cli`).
//
// Exposes only `ask_parent`, `report_parent`, and `feedback` over stdio JSON-RPC.
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
import { RosterStore, isCancelledRound } from './roster-store.mjs';
import { exitWhenInputCloses } from './stdio-exit.mjs';

export const CLI_CALLBACK_PATH = '/futureaide/cli-callback';
export const MCP_HTTP_PATH = '/mcp';
export const DEFAULT_REPORT_PORT = 17654;
const TOKEN_FILENAME = 'antigravity-caller.json';

const LEAF_ONLY_ROLES = new Set([
  '执行', '执行师', 'builder',
  '前端', '前端工程师', '前端执行师', 'frontend', 'frontend-engineer', '设计', '设计师', 'designer',
  '后端', '后端工程师', '后端执行师', 'backend', 'backend-engineer',
  '调查', '调研', '调查员', '探子', '红队', 'researcher', 'scout',
]);

const BOARD_TOOLS = [
  {
    name: 'futureaide_board_post',
    description: 'Post to the team meeting board; @后端1 or @团队长1/后端2 mentions wake or revive the target member to reply.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 8000, description: 'Board message text (use @name to wake teammates).' },
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

const LEAD_FORWARDED_TOOL_NAMES = new Set([
  'futureaide_board_post',
  'futureaide_board_read',
  'futureaide_run_agent',
  'futureaide_create_agent',
  'futureaide_wait_agents',
  'futureaide_list_agents',
  'futureaide_answer_agent',
  'futureaide_send_agent',
  'futureaide_team',
  'futureaide_inspect_agent',
  'futureaide_agent_changes',
  'futureaide_read_report',
  'futureaide_cancel_agent',
  'futureaide_delete_agent',
]);

function isLeafOnlyRole(rawRole) {
  if (typeof rawRole !== 'string' || !rawRole.trim()) return false;
  const cleaned = rawRole.replace(/（[^（）]*）|\([^()]*\)/g, '').replace(/-?\d+$/u, '').trim().toLowerCase();
  return LEAF_ONLY_ROLES.has(cleaned);
}

function postManagedMcpRpc({
  port,
  token,
  parentAgentId,
  ownerId,
  workspace,
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
    ...(parentAgentId ? { 'x-futureaide-parent-agent-id': parentAgentId } : {}),
    ...(ownerId ? { 'x-futureaide-owner-id': ownerId } : {}),
    ...(workspace ? { 'x-futureaide-workspace-b64': Buffer.from(workspace, 'utf8').toString('base64') } : {}),
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
      headers,
      ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
    }, res => {
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
  const candidate = explicitTokenFile
    || (typeof env.FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE === 'string' && env.FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE.trim()
      ? env.FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE.trim()
      : undefined)
    || (roster && roster !== ':memory:' ? path.join(path.dirname(path.resolve(roster)), TOKEN_FILENAME) : undefined);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(await readFile(candidate, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function resolveCallbackPort(explicitPort, tokenInfo, env = process.env) {
  if (Number.isInteger(explicitPort) && explicitPort > 0 && explicitPort <= 65535) return explicitPort;
  const rawEnv = env.FUTUREAIDE_REPORT_PORT;
  if (rawEnv !== undefined && rawEnv !== '') {
    const parsed = Number.parseInt(rawEnv, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  }
  if (Number.isInteger(tokenInfo?.port) && tokenInfo.port > 0 && tokenInfo.port <= 65535) {
    return tokenInfo.port;
  }
  return DEFAULT_REPORT_PORT;
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
      headers,
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
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
    { capabilities: { tools: {} } },
  );

  const managedEnabled = env?.FUTUREAIDE_MANAGED_CLI === '1';
  const callerRole = env?.FUTUREAIDE_CALLER_ROLE ?? '';
  const allowLeadTools = managedEnabled && !isLeafOnlyRole(callerRole);
  const parentAgentId = (typeof env?.FUTUREAIDE_PARENT_AGENT_ID === 'string' && env.FUTUREAIDE_PARENT_AGENT_ID.trim())
    ? env.FUTUREAIDE_PARENT_AGENT_ID.trim()
    : agentId;
  const ownerId = typeof env?.FUTUREAIDE_CALLER_OWNER_ID === 'string' ? env.FUTUREAIDE_CALLER_OWNER_ID.trim() : '';
  const callerWorkspace = typeof env?.FUTUREAIDE_CALLER_WORKSPACE === 'string' ? env.FUTUREAIDE_CALLER_WORKSPACE.trim() : '';
  let cachedLeadTools = null;

  const resolveLoopbackAuth = async () => {
    const tokenInfo = token ? { token } : await readCallerTokenInfo(roster, tokenFile, env);
    return {
      port: resolveCallbackPort(port, tokenInfo, env),
      token: token ?? tokenInfo?.token,
    };
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!managedEnabled) return { tools: TOOLS };
    if (!allowLeadTools) return { tools: [...TOOLS, ...BOARD_TOOLS] };
    const auth = await resolveLoopbackAuth();
    if (auth.token) {
      const rpc = await postManagedMcpRpc({
        port: auth.port,
        token: auth.token,
        parentAgentId,
        ownerId,
        workspace: callerWorkspace,
        method: 'tools/list',
        params: {},
        timeoutMs: 3000,
      });
      const remoteTools = rpc?.body?.result?.tools;
      if (Array.isArray(remoteTools) && remoteTools.length > 0) {
        cachedLeadTools = remoteTools.filter(t => LEAD_FORWARDED_TOOL_NAMES.has(t?.name));
      }
    }
    return { tools: [...TOOLS, ...(cachedLeadTools ?? BOARD_TOOLS)] };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const toolName = request.params?.name;
    const args = request.params?.arguments ?? {};
    try {
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
      if (managedEnabled && (toolName === 'futureaide_board_post' || toolName === 'futureaide_board_read' || (allowLeadTools && LEAD_FORWARDED_TOOL_NAMES.has(toolName)))) {
        const auth = await resolveLoopbackAuth();
        if (auth.token) {
          const isWait = toolName === 'futureaide_wait_agents';
          const rpc = await postManagedMcpRpc({
            port: auth.port,
            token: auth.token,
            parentAgentId,
            ownerId,
            workspace: callerWorkspace,
            method: 'tools/call',
            params: { name: toolName, arguments: args },
            timeoutMs: isWait ? 0 : 60000,
          });
          if (rpc?.body?.result) return rpc.body.result;
          if (rpc?.body?.error) {
            throw Object.assign(new Error(rpc.body.error.message ?? 'Remote MCP error.'), {
              code: rpc.body.error.data?.code ?? 'mcp-error',
            });
          }
        }
        // Offline fallback for board read/post when HTTP service is not running
        if (toolName === 'futureaide_board_read') {
          const store = getStore();
          const rec = store.get(agentId);
          const rootId = rec?.ownerId ?? ownerId;
          const messages = store.listTeamBoardMessages(rootId, {
            limit: args.limit ?? 30,
            ...(args.after_seq !== undefined ? { afterSeq: args.after_seq } : {}),
          });
          return { content: [{ type: 'text', text: JSON.stringify({ messages }) }] };
        }
        if (toolName === 'futureaide_board_post') {
          const store = getStore();
          const rec = store.get(agentId);
          const rootId = rec?.ownerId ?? ownerId;
          const author = rec?.name ?? 'member';
          const saved = store.appendTeamBoardMessage({
            rootOwnerId: rootId,
            author,
            text: String(args.message ?? ''),
            mentions: [],
          });
          return { content: [{ type: 'text', text: JSON.stringify({ posted: true, seq: saved.seq, mentions: [], woken: [] }) }] };
        }
        throw Object.assign(new Error('FutureAide loopback management service is not reachable.'), {
          code: 'report-service-unavailable',
        });
      }
      if (toolName === 'feedback') {
        const deadline = Date.now() + 2000;
        const store = getStore();
        const record = store.get(agentId);
        if (!record || record.closed || record.target !== target || record.task?.taskId !== taskId
            || record.task?.dispatches?.at(-1)?.requestId !== requestId || ['idle', 'failed'].includes(record.state)
            || isCancelledRound(record) || record.task.reports?.some(report => report.final)
            || store.submissions(agentId, taskId).some(report => report.final)) {
          throw Object.assign(new Error('This caller has no active managed task for this dispatch.'),
            { code: 'submission-not-owned' });
        }
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
  });

  const close = async () => {
    try { await server.close(); } catch {}
    if (lazyStore) {
      try { lazyStore.close(); } catch {}
      lazyStore = null;
    }
  };

  return { server, close };
}

export async function runCliCallbackBridge(argv = process.argv.slice(2), env = process.env) {
  let cliTarget = 'codex-cli';
  let rest = argv;
  if (argv[0] === '--claude-cli-reports' || argv[0] === '--codex-cli-reports') {
    cliTarget = argv[0] === '--codex-cli-reports' ? 'codex-cli' : 'claude-cli';
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
    configFile,
    env,
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
