// Loopback stdio MCP forwarder for Antigravity sessions calling into FutureAide Control's
// shared loopback report service on 127.0.0.1:<port>/mcp.
//
// Key design properties:
//   1. Uses ONLY `node:http` directly to `127.0.0.1` so proxy environment variables
//      (`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`) can NEVER intercept loopback traffic.
//   2. Authenticates every request with the local Bearer token read from
//      `antigravity-caller.json` plus `x-futureaide-caller: antigravity`,
//      `x-antigravity-conversation-id`, and `x-antigravity-workspace`.
//   3. Resolves the active Antigravity workspace dynamically via `ANTIGRAVITY_WORKSPACE`,
//      MCP `roots/list` from the connected client, or `cwd` fallback.
//   4. On-demand monitor wake: because `scoped-worker.mjs` idles out cleanly after 30s,
//      wakes the shared monitor via `ensureSharedMonitor` (which strips proxy vars via
//      `cleanProxyEnv()`) when allowed (`coldStartMonitor !== false`). Users requiring
//      strict cross-tree air-gap isolation can disable cold-starting via `--no-cold-start`
//      or `antigravityColdStartMonitor: false` in config.json.
//   5. Supports streaming SSE + `notifications/progress` forwarding for `futureaide_wait_agents`
//      and bounded 2s timeout handling for `futureaide_feedback`.
import { existsSync } from 'node:fs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.mjs';
import { submitCliCallback } from './cli-callback-bridge.mjs';
import { CODEX_ASK_PARENT_INSTRUCTION, FINAL_REPORT_CONTRACT, QUESTION_CONTRACT } from './report-contract.mjs';
import { reportPort, rosterIdentity } from './report-endpoint.mjs';
import { RosterStore } from './roster-store.mjs';
import { ensureSharedMonitor } from './shared-monitor.mjs';
import { exitWhenInputCloses, stdioWaitSignal } from './stdio-exit.mjs';

export const BOOTSTRAP_NAME = 'futureaide-antigravity-bridge';
export const BOOTSTRAP_VERSION = '1.0.0';
export const DEFAULT_PORT = 17654;
export const HTTP_PATH = '/mcp';
export const TOKEN_FILENAME = 'antigravity-caller.json';
export const INSTRUCTIONS = `FutureAide Control Antigravity loopback bridge.

Forwards named subagent management tools (futureaide_*) to FutureAide Control's local loopback service on 127.0.0.1. Caller identity is proven by the local Bearer token and Antigravity conversation headers, never by tool arguments. After dispatch, wait once with futureaide_wait_agents and taskKeys, and read report bodies with futureaide_read_report.`;

const PARENT_MESSAGE_DESCRIPTION = 'Message for the managed parent of this chat. Pass it directly; never a chat id, path, or internal number.';

export const MANAGED_PARENT_TOOLS = Object.freeze([
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
]);

export function resolveManagedCliBinding(env = process.env) {
  if (env?.FUTUREAIDE_MANAGED_CLI !== '1') return null;
  const agentId = typeof env.FUTUREAIDE_PARENT_AGENT_ID === 'string' ? env.FUTUREAIDE_PARENT_AGENT_ID.trim() : '';
  const taskId = typeof (env.FUTUREAIDE_PARENT_TASK_ID ?? env.FUTUREAIDE_TASK_ID) === 'string'
    ? (env.FUTUREAIDE_PARENT_TASK_ID ?? env.FUTUREAIDE_TASK_ID).trim()
    : '';
  const requestId = typeof (env.FUTUREAIDE_PARENT_REQUEST_ID ?? env.FUTUREAIDE_RUN_ID) === 'string'
    ? (env.FUTUREAIDE_PARENT_REQUEST_ID ?? env.FUTUREAIDE_RUN_ID).trim()
    : '';
  if (!agentId || !taskId || !requestId) return null;
  const ownerId = typeof env.FUTUREAIDE_CALLER_OWNER_ID === 'string' && env.FUTUREAIDE_CALLER_OWNER_ID.trim()
    ? env.FUTUREAIDE_CALLER_OWNER_ID.trim()
    : undefined;
  const workspace = typeof env.FUTUREAIDE_CALLER_WORKSPACE === 'string' && env.FUTUREAIDE_CALLER_WORKSPACE.trim()
    ? env.FUTUREAIDE_CALLER_WORKSPACE.trim()
    : undefined;
  const roster = typeof env.FUTUREAIDE_ROSTER_PATH === 'string' && env.FUTUREAIDE_ROSTER_PATH.trim()
    ? env.FUTUREAIDE_ROSTER_PATH.trim()
    : undefined;
  const target = typeof env.FUTUREAIDE_MANAGED_TARGET === 'string' && env.FUTUREAIDE_MANAGED_TARGET.trim()
    ? env.FUTUREAIDE_MANAGED_TARGET.trim()
    : 'agy-cli';
  return { agentId, taskId, requestId, ownerId, workspace, roster, target };
}

export const READ_ONLY_TOOLS = Object.freeze([
  'futureaide_status',
  'futureaide_list_agents',
  'futureaide_agent_changes',
  'futureaide_inspect_agent',
  'futureaide_read_report',
  'futureaide_board_read',
]);

export function mayRetry(name) {
  return READ_ONLY_TOOLS.includes(name);
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const failure = (code, message, extra = {}) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...extra } }) }],
});

const parsePort = value => {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
  }
  return undefined;
};

/**
 * Parse CLI flags: `--config <path>`, `--token-file <path>`, `--port <number>`,
 * `--no-cold-start`, `--cold-start`.
 */
export function parseBootstrapArgs(argv = process.argv.slice(2)) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config' && argv[index + 1]) {
      result.configPath = argv[++index];
    } else if (arg === '--token-file' && argv[index + 1]) {
      result.tokenFile = argv[++index];
    } else if (arg === '--port' && argv[index + 1]) {
      const parsed = parsePort(argv[++index]);
      if (parsed === undefined) throw new Error(`Invalid --port value: ${argv[index]}`);
      result.port = parsed;
    } else if (arg === '--no-cold-start') {
      result.coldStartMonitor = false;
    } else if (arg === '--cold-start') {
      result.coldStartMonitor = true;
    }
  }
  return result;
}

/**
 * Extract Antigravity conversation ID from incoming MCP request `_meta` or environment.
 */
export function resolveConversationId(request, extra, env = process.env) {
  const managed = resolveManagedCliBinding(env);
  if (managed) {
    return `managed-cli:${managed.agentId}${managed.ownerId ? `:${managed.ownerId}` : ''}`;
  }
  const meta = request?.params?._meta ?? extra?._meta;
  const fromMeta = typeof meta?.['antigravity.google/conversation_id'] === 'string'
    ? meta['antigravity.google/conversation_id'].trim() : '';
  if (fromMeta) return fromMeta;
  const fromEnv = typeof env?.ANTIGRAVITY_CONVERSATION_ID === 'string'
    ? env.ANTIGRAVITY_CONVERSATION_ID.trim() : '';
  if (fromEnv) return fromEnv;
  return undefined;
}

/**
 * Convert an MCP `file://` root URI to a local filesystem path when valid.
 */
export function rootUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.trim()) return undefined;
  const trimmed = uri.trim();
  if (/^file:\/\//i.test(trimmed)) {
    try { return path.resolve(fileURLToPath(trimmed)); }
    catch { return undefined; }
  }
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : undefined;
}

const conversationSummaryCache = new Map();

/**
 * Look up the active workspace (and title) of an Antigravity conversation from
 * `~/.gemini/antigravity/conversation_summaries.db` when `ANTIGRAVITY_WORKSPACE`
 * is not explicitly provided (e.g. global plugin MCP spawn).
 */
export function resolveAntigravityConversationInfo(conversationId, { env = process.env, summaryDbPath } = {}) {
  if (typeof conversationId !== 'string') return undefined;
  const id = conversationId.trim();
  if (!id || id === '__discovery__' || id.startsWith('managed-cli:')) return undefined;
  const cached = conversationSummaryCache.get(id);
  if (cached && Date.now() - cached.at < 30000) return cached.value;

  const appDataDir = (typeof env?.ANTIGRAVITY_APP_DATA_DIR === 'string' && env.ANTIGRAVITY_APP_DATA_DIR.trim())
    ? env.ANTIGRAVITY_APP_DATA_DIR.trim()
    : path.join(homedir(), '.gemini', 'antigravity');
  const dbPath = summaryDbPath || path.join(appDataDir, 'conversation_summaries.db');
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
        workspace = uris.map(rootUriToPath).find(Boolean);
      }
    }
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : undefined;
    const value = workspace || title ? { ...(workspace ? { workspace } : {}), ...(title ? { title } : {}) } : undefined;
    if (value?.workspace) conversationSummaryCache.set(id, { at: Date.now(), value });
    return value;
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

/**
 * Build ordered candidate paths for `antigravity-caller.json`.
 */
export function resolveTokenFileCandidates({ tokenFile, config, env = process.env } = {}) {
  const candidates = [];
  const push = candidate => {
    if (typeof candidate === 'string' && candidate.trim()) {
      const resolved = path.resolve(candidate.trim());
      if (!candidates.includes(resolved)) candidates.push(resolved);
    }
  };
  push(tokenFile);
  push(env?.FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE);
  push(config?.antigravityCallerTokenFile);
  if (config?.stateDirectory) push(path.join(config.stateDirectory, TOKEN_FILENAME));
  if (config?.configFile) push(path.join(path.dirname(config.configFile), TOKEN_FILENAME));
  return candidates;
}

/**
 * Read the first readable valid `antigravity-caller.json` from candidate paths.
 */
export async function readCallerTokenFile(candidates = [], { read = readFile } = {}) {
  for (const filePath of candidates) {
    let raw;
    try { raw = await read(filePath, 'utf8'); }
    catch { continue; }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && typeof parsed.token === 'string' && parsed.token.trim()) {
        return {
          filePath,
          token: parsed.token.trim(),
          port: parsePort(parsed.port),
          pid: parsed.pid,
          updatedAt: parsed.updatedAt,
        };
      }
    } catch { /* ignore corrupt candidate and continue */ }
  }
  return undefined;
}

/**
 * Resolve loopback target port and caller auth token from CLI options, env, config, and token file.
 */
export async function resolveEndpoint({
  configPath,
  tokenFile,
  port,
  env = process.env,
  load = loadConfig,
  read = readFile,
} = {}) {
  let config;
  const effectiveConfigPath = configPath
    || env?.FUTUREAIDE_CONFIG
    || env?.DSH_CONTROL_CONFIG
    || env?.FUTUREAIDE_CONTROL_CONFIG;
  try {
    config = await load(effectiveConfigPath);
  } catch {
    config = undefined;
  }
  const explicitPort = parsePort(port);
  const candidates = resolveTokenFileCandidates({ tokenFile, config, env });
  const auth = await readCallerTokenFile(candidates, { read });
  const resolvedPort = explicitPort
    ?? auth?.port
    ?? parsePort(config?.reportPort)
    ?? parsePort(env?.FUTUREAIDE_REPORT_PORT)
    ?? (config ? reportPort(config, env) : undefined)
    ?? DEFAULT_PORT;
  return {
    config,
    port: resolvedPort,
    token: auth?.token,
    tokenFile: auth?.filePath ?? candidates[0],
    candidates,
  };
}

/**
 * Probe `GET http://127.0.0.1:<port>/healthz` strictly via `node:http` (bypassing proxies).
 */
export function probeLoopbackHealth({ port, expectedRoster, timeoutMs = 1000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/healthz',
      method: 'GET',
      headers: { accept: 'application/json' },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          finish({ ready: false, reason: { code: 'report-service-http-error', status: res.statusCode } });
          return;
        }
        try {
          const info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (info?.ok !== true) {
            finish({ ready: false, reason: { code: 'report-service-invalid-health' } });
            return;
          }
          if (expectedRoster !== undefined && info.roster !== expectedRoster) {
            finish({ ready: false, reason: { code: 'report-service-foreign-roster' }, health: info });
            return;
          }
          finish({ ready: true, health: info });
        } catch {
          finish({ ready: false, reason: { code: 'report-service-invalid-health' } });
        }
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish({ ready: false, reason: { code: 'report-service-health-timeout' } });
    });
    req.once('error', () => {
      finish({ ready: false, reason: { code: 'report-service-connect-failed' } });
    });
    req.end();
  });
}

function parseRpcHttpBody(text, contentType = '') {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  if (contentType.toLowerCase().includes('text/event-stream')) {
    const dataLines = trimmed
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(Boolean);
    for (let index = dataLines.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(dataLines[index]); } catch { /* try prior frame */ }
    }
    return undefined;
  }
  try { return JSON.parse(trimmed); }
  catch { return undefined; }
}

/**
 * Send one JSON-RPC POST to `http://127.0.0.1:<port>/mcp` strictly via `node:http`.
 * When `onProgress` is supplied and the server answers with `text/event-stream`,
 * parses SSE frames incrementally and forwards `notifications/progress` events live.
 */
export function postLoopbackJsonRpc({
  port,
  token,
  conversationId,
  workspace,
  body,
  timeoutMs = 60000,
  signal,
  onProgress,
  agent,
} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError', code: 'ABORT_ERR', connected: false }));
      return;
    }
    const payload = JSON.stringify(body);
    const asciiWorkspace = typeof workspace === 'string' && /^[\x20-\x7e]+$/.test(workspace) ? workspace : undefined;
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'x-futureaide-caller': 'antigravity',
      'x-antigravity-conversation-id': conversationId,
      ...(workspace ? { 'x-antigravity-workspace-b64': Buffer.from(workspace, 'utf8').toString('base64') } : {}),
      ...(asciiWorkspace ? { 'x-antigravity-workspace': asciiWorkspace } : {}),
    };
    let connected = false;
    let settled = false;
    const cleanup = () => { signal?.removeEventListener('abort', onAbort); };
    const done = fn => value => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const finish = done(resolve);
    const fail = done(reject);

    const req = http.request({
      host: '127.0.0.1',
      port,
      path: HTTP_PATH,
      method: 'POST',
      headers,
      ...(agent ? { agent } : {}),
    }, res => {
      connected = true;
      const contentType = String(res.headers['content-type'] ?? '');
      const isSse = contentType.toLowerCase().includes('text/event-stream');

      if (isSse && typeof onProgress === 'function') {
        let buffer = '';
        let finalMessage;
        const rawChunks = [];
        const flushFrames = (final = false) => {
          const lines = buffer.split(/\r?\n/);
          buffer = final ? '' : (lines.pop() ?? '');
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const rawData = line.slice(5).trim();
            if (!rawData) continue;
            let frame;
            try { frame = JSON.parse(rawData); } catch { continue; }
            if (frame?.method === 'notifications/progress' && frame.params) {
              try { onProgress(frame.params); } catch { /* ignore notification hook failure */ }
            } else if (frame && (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error'))) {
              finalMessage = frame;
            }
          }
        };
        res.setEncoding('utf8');
        res.on('data', chunk => {
          rawChunks.push(chunk);
          buffer += chunk;
          flushFrames(false);
        });
        res.on('end', () => {
          flushFrames(true);
          const raw = rawChunks.join('');
          const parsed = finalMessage ?? parseRpcHttpBody(raw, contentType);
          finish({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, raw });
        });
        res.on('error', error => {
          error.connected = connected;
          fail(error);
        });
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const parsed = parseRpcHttpBody(text, contentType);
        finish({ status: res.statusCode ?? 0, headers: res.headers, body: parsed, raw: text });
      });
      res.on('error', error => {
        error.connected = connected;
        fail(error);
      });
    });

    const onAbort = () => {
      const error = signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
      error.connected = connected;
      req.destroy(error);
      fail(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        const error = Object.assign(
          new Error(`Timed out waiting for FutureAide report service on 127.0.0.1:${port}.`),
          { code: 'ETIMEDOUT', connected },
        );
        req.destroy(error);
      });
    }
    req.once('error', error => {
      error.connected = connected;
      fail(error);
    });
    req.end(payload);
  });
}

/**
 * Create a thin forwarding MCP server that delegates list and call to the provided handlers.
 */
export function createForwardServer({ fetchTools, callTool, onRootsChanged, instructions = INSTRUCTIONS }) {
  const server = new Server(
    { name: BOOTSTRAP_NAME, version: BOOTSTRAP_VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => ({
    tools: await fetchTools(request, extra),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await callTool(request.params.name, request.params.arguments ?? {}, request, extra);
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      ...(result?.isError ? { isError: true } : {}),
      ...(result?.structuredContent ? { structuredContent: result.structuredContent } : {}),
    };
  });
  if (typeof onRootsChanged === 'function') {
    server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
      onRootsChanged();
    });
  }
  return server;
}

/**
 * Start the Antigravity-to-FutureAide stdio forwarder bridge.
 * Wakes the shared monitor on demand (with `cleanProxyEnv()`) when `coldStartMonitor` is
 * enabled; when `coldStartMonitor` is explicitly `false`, never spawns any process.
 */
export async function startAntigravityCallerBridge({
  configPath,
  tokenFile,
  port,
  coldStartMonitor = undefined,
  inputSignal = undefined,
  waitMs = 10000,
  pollMs = 200,
  env = process.env,
  cwd = process.cwd(),
  load = loadConfig,
  read = readFile,
  request = postLoopbackJsonRpc,
  health = probeLoopbackHealth,
  ensure = ensureSharedMonitor,
  storeFor = config => new RosterStore(path.join(config.stateDirectory, 'roster.sqlite')),
  timeoutMs = 60000,
  log = message => process.stderr.write(`[${BOOTSTRAP_NAME}] ${message}\n`),
} = {}) {
  let nextRpcId = 1;
  const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const activeWaits = new Set();
  const managedBinding = resolveManagedCliBinding(env);
  const explicitWorkspace = (typeof env?.ANTIGRAVITY_WORKSPACE === 'string' && env.ANTIGRAVITY_WORKSPACE.trim())
    ? env.ANTIGRAVITY_WORKSPACE.trim()
    : managedBinding?.workspace;
  let cachedRootWorkspace;
  let rootWorkspaceChecked = false;
  let store;
  let fallbackRosterStore;

  const currentEndpoint = () => resolveEndpoint({ configPath, tokenFile, port, env, load, read });

  const allowColdStart = config => {
    if (typeof coldStartMonitor === 'boolean') return coldStartMonitor;
    if (env?.FUTUREAIDE_ANTIGRAVITY_COLD_START_MONITOR === '0'
      || env?.FUTUREAIDE_ANTIGRAVITY_COLD_START_MONITOR === 'false') return false;
    if (config && typeof config.antigravityColdStartMonitor === 'boolean') {
      return config.antigravityColdStartMonitor;
    }
    return true;
  };

  const unavailableMessage = (targetPort, detail, coldStartAllowed) =>
    `The FutureAide loopback report service is not reachable on 127.0.0.1:${targetPort} (${detail}). `
    + (coldStartAllowed
      ? 'Check your FutureAide configuration and ensure Node.js can launch the shared monitor.'
      : 'Ensure the FutureAide monitor (Codex Desktop or Claude Desktop) is running; monitor cold-start is disabled.');

  const getStore = config => {
    if (!config?.stateDirectory) return undefined;
    if (!store) store = storeFor(config);
    return store;
  };

  /**
   * Ensure the loopback report service is reachable and has published a valid token.
   * Only spawns the shared monitor when `allowColdStart(config)` is true.
   */
  const prepareEndpoint = async ({ forceRefresh = false } = {}) => {
    let endpoint = await currentEndpoint();
    const canWake = allowColdStart(endpoint.config);
    if (!forceRefresh && endpoint.token) {
      if (!canWake) return { ok: true, endpoint };
      let expectedRoster;
      try { expectedRoster = rosterIdentity(getStore(endpoint.config)); } catch { expectedRoster = undefined; }
      const probe = await health({ port: endpoint.port, expectedRoster });
      if (probe?.ready === true) return { ok: true, endpoint };
      if (probe?.reason?.code === 'report-service-foreign-roster') {
        return {
          ok: false,
          code: 'report-service-unavailable',
          message: unavailableMessage(endpoint.port, 'port serves a different FutureAide roster', canWake),
          endpoint,
        };
      }
    }
    if (!canWake) {
      if (!endpoint.token) {
        return {
          ok: false,
          code: 'report-service-unavailable',
          message: unavailableMessage(endpoint.port, 'antigravity-caller.json not found', false),
          endpoint,
        };
      }
      return { ok: true, endpoint };
    }
    if (!endpoint.config) {
      return {
        ok: false,
        code: 'report-service-unavailable',
        message: unavailableMessage(endpoint.port, 'FutureAide configuration not found', true),
        endpoint,
      };
    }

    let expectedRoster;
    let activeStore;
    try {
      activeStore = getStore(endpoint.config);
      expectedRoster = rosterIdentity(activeStore);
    } catch (error) {
      return {
        ok: false,
        code: 'report-service-unavailable',
        message: unavailableMessage(endpoint.port, error?.message ?? 'failed to open roster', true),
        endpoint,
      };
    }

    const initialProbe = await health({ port: endpoint.port, expectedRoster });
    if (initialProbe?.ready === true) {
      endpoint = await currentEndpoint();
      if (endpoint.token) return { ok: true, endpoint };
    } else if (initialProbe?.reason?.code === 'report-service-foreign-roster') {
      return {
        ok: false,
        code: 'report-service-unavailable',
        message: unavailableMessage(endpoint.port, 'port serves a different FutureAide roster', true),
        endpoint,
      };
    } else {
      try {
        const started = await ensure(endpoint.config, activeStore);
        if (started === false) log('this build cannot start the shared monitor here');
      } catch (error) {
        log(`shared monitor did not start (${error?.code ?? error?.message ?? error})`);
      }
    }

    const deadline = Date.now() + waitMs;
    let lastDetail = initialProbe?.reason?.code ?? (endpoint.token ? 'service-starting' : 'antigravity-caller.json not found');
    while (Date.now() < deadline) {
      endpoint = await currentEndpoint();
      const probe = await health({ port: endpoint.port, expectedRoster });
      if (probe?.ready === true && endpoint.token) {
        return { ok: true, endpoint };
      }
      if (probe?.reason?.code === 'report-service-foreign-roster') {
        lastDetail = 'port serves a different FutureAide roster';
        break;
      }
      lastDetail = probe?.ready === true ? 'antigravity-caller.json not written yet' : (probe?.reason?.code ?? 'report-service-unavailable');
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await pause(Math.min(pollMs, remaining));
    }
    return {
      ok: false,
      code: 'report-service-unavailable',
      message: unavailableMessage(endpoint.port, lastDetail, true),
      endpoint,
    };
  };

  let server;
  const resolveWorkspace = async conversationId => {
    if (explicitWorkspace) return explicitWorkspace;
    const fromSummary = resolveAntigravityConversationInfo(conversationId, { env })?.workspace;
    if (fromSummary) return fromSummary;
    if (rootWorkspaceChecked) return cachedRootWorkspace ?? cwd;
    if (server && typeof server.listRoots === 'function' && server.getClientCapabilities?.()?.roots) {
      try {
        const result = await Promise.race([
          server.listRoots(),
          pause(2000).then(() => undefined),
        ]);
        const firstRoot = Array.isArray(result?.roots)
          ? result.roots.map(item => rootUriToPath(item?.uri)).find(Boolean)
          : undefined;
        if (firstRoot) {
          cachedRootWorkspace = firstRoot;
          rootWorkspaceChecked = true;
          return cachedRootWorkspace;
        }
      } catch { /* fall back to cwd */ }
      rootWorkspaceChecked = true;
    }
    return cwd;
  };

  const sendRpc = async (endpoint, conversationId, workspace, rpcMethod, params, {
    requestTimeoutMs = timeoutMs,
    signal,
    onProgress,
    useAgent = true,
  } = {}) => {
    const id = nextRpcId++;
    return request({
      port: endpoint.port,
      token: endpoint.token,
      conversationId,
      workspace,
      body: { jsonrpc: '2.0', id, method: rpcMethod, params },
      timeoutMs: requestTimeoutMs,
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
      ...(useAgent ? { agent: httpAgent } : {}),
    });
  };

  const listRemoteTools = async (req, extra) => {
    const prepared = await prepareEndpoint();
    if (!prepared.ok) return prepared;
    let endpoint = prepared.endpoint;
    const canWake = allowColdStart(endpoint.config);
    const conversationId = resolveConversationId(req, extra, env) ?? '__discovery__';
    const workspace = await resolveWorkspace(conversationId);
    const attempt = async targetEndpoint => sendRpc(targetEndpoint, conversationId, workspace, 'tools/list', {});
    try {
      let response = await attempt(endpoint);
      if (response.status === 401) {
        const refreshed = await currentEndpoint();
        if (refreshed.token && refreshed.token !== endpoint.token) {
          endpoint = refreshed;
          response = await attempt(endpoint);
        }
      }
      if (response.status === 401) {
        return {
          ok: false,
          code: 'report-service-unavailable',
          message: unavailableMessage(endpoint.port, 'caller token rejected with HTTP 401', canWake),
          endpoint,
        };
      }
      if (response.status < 200 || response.status >= 300 || response.body?.error) {
        const detail = response.body?.error?.message ?? `HTTP ${response.status}`;
        return {
          ok: false,
          code: 'report-service-unavailable',
          message: unavailableMessage(endpoint.port, detail, canWake),
          endpoint,
        };
      }
      const tools = response.body?.result?.tools;
      return { ok: true, tools: Array.isArray(tools) ? tools : [], endpoint };
    } catch (error) {
      return {
        ok: false,
        code: 'report-service-unavailable',
        message: unavailableMessage(endpoint.port, error?.code ?? error?.message ?? String(error), canWake),
        endpoint,
      };
    }
  };

  let cachedTools = [];

  const withManagedParentTools = toolsList => {
    if (!managedBinding) return toolsList;
    const filtered = (Array.isArray(toolsList) ? toolsList : [])
      .filter(tool => tool?.name !== 'ask_parent' && tool?.name !== 'report_parent');
    return [...filtered, ...MANAGED_PARENT_TOOLS];
  };

  const fetchTools = async (req, extra) => {
    const listed = await listRemoteTools(req, extra);
    if (!listed.ok) {
      log(`${listed.code}: ${listed.message}`);
      return withManagedParentTools(cachedTools);
    }
    cachedTools = listed.tools;
    return withManagedParentTools(listed.tools);
  };

  const callTool = async (name, args, req, extra) => {
    if (managedBinding && (name === 'ask_parent' || name === 'report_parent')) {
      try {
        const endpoint = await currentEndpoint();
        const rosterPath = managedBinding.roster
          || (endpoint.config?.stateDirectory ? path.join(endpoint.config.stateDirectory, 'roster.sqlite') : undefined);
        if (!rosterPath) {
          return failure('calling-context-unavailable', 'Managed CLI roster path is unavailable.', { operation: name });
        }
        const getFallbackStore = () => {
          if (endpoint.config?.stateDirectory) {
            const existing = getStore(endpoint.config);
            if (existing) return existing;
          }
          fallbackRosterStore ??= new RosterStore(rosterPath);
          return fallbackRosterStore;
        };
        const receipt = await submitCliCallback({
          roster: rosterPath,
          agentId: managedBinding.agentId,
          taskId: managedBinding.taskId,
          requestId: managedBinding.requestId,
          target: managedBinding.target,
          kind: name === 'ask_parent' ? 'ask' : 'report',
          message: args?.message,
          final: name === 'report_parent' ? args?.final === true : false,
          port: endpoint.port,
          token: endpoint.token,
          tokenFile: endpoint.tokenFile,
          env,
          getStore: getFallbackStore,
        });
        return { content: [{ type: 'text', text: JSON.stringify(receipt) }] };
      } catch (error) {
        return failure(
          error?.code ?? 'operation-failed',
          String(error?.message ?? error),
          { operation: name },
        );
      }
    }

    const conversationId = resolveConversationId(req, extra, env);
    if (!conversationId) {
      return failure(
        'calling-context-unavailable',
        'Antigravity conversation ID is missing (expected _meta["antigravity.google/conversation_id"] or ANTIGRAVITY_CONVERSATION_ID).',
        { operation: name },
      );
    }

    if (name === 'futureaide_feedback') {
      let sent = false;
      let expired = false;
      let timer;
      const unknown = () => failure(
        'write-outcome-unknown',
        'This feedback may already have been saved. Ask the secretary to check the local feedback inbox; do not resend.',
        { operation: name },
      );
      const unavailable = () => ({
        content: [{ type: 'text', text: JSON.stringify({ saved: false, code: 'feedback-unavailable' }) }],
      });
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
          expired = true;
          resolve(sent ? unknown() : unavailable());
        }, 2000);
      });
      const work = (async () => {
        try {
          const prepared = await prepareEndpoint();
          if (!prepared.ok || expired) return unavailable();
          const workspace = await resolveWorkspace(conversationId);
          sent = true;
          const response = await sendRpc(prepared.endpoint, conversationId, workspace, 'tools/call',
            { name, arguments: args ?? {} }, { requestTimeoutMs: 2000 });
          return response.body?.result ?? unavailable();
        } catch {
          return sent ? unknown() : unavailable();
        }
      })();
      const result = await Promise.race([work, timeout]);
      clearTimeout(timer);
      return result;
    }

    const prepared = await prepareEndpoint();
    if (!prepared.ok) {
      return failure(prepared.code, prepared.message, { operation: name });
    }
    let endpoint = prepared.endpoint;
    const canWake = allowColdStart(endpoint.config);
    const workspace = await resolveWorkspace(conversationId);

    if (name === 'futureaide_wait_agents') {
      const controller = new AbortController();
      activeWaits.add(controller);
      const callerSignal = AbortSignal.any([extra?.signal, inputSignal].filter(Boolean));
      const abort = () => controller.abort(callerSignal.reason);
      if (callerSignal.aborted) abort();
      else callerSignal.addEventListener('abort', abort, { once: true });
      const token = req?.params?._meta?.progressToken ?? extra?._meta?.progressToken;
      const rpcParams = {
        name,
        arguments: args ?? {},
        ...(token !== undefined ? { _meta: { progressToken: token } } : {}),
      };
      const onProgress = token !== undefined
        ? progress => {
          if (!controller.signal.aborted) {
            void extra?.sendNotification?.({
              method: 'notifications/progress',
              params: { ...progress, progressToken: token },
            }).catch(() => {});
          }
        }
        : undefined;
      try {
        let response = await sendRpc(endpoint, conversationId, workspace, 'tools/call', rpcParams, {
          requestTimeoutMs: 0,
          signal: controller.signal,
          onProgress,
          useAgent: false,
        });
        if (response.status === 401) {
          const refreshed = await currentEndpoint();
          if (refreshed.token && refreshed.token !== endpoint.token) {
            endpoint = refreshed;
            response = await sendRpc(endpoint, conversationId, workspace, 'tools/call', rpcParams, {
              requestTimeoutMs: 0,
              signal: controller.signal,
              onProgress,
              useAgent: false,
            });
          }
        }
        if (response.status === 401) {
          return failure('report-service-unavailable',
            unavailableMessage(endpoint.port, 'caller token rejected with HTTP 401', canWake),
            { operation: name, httpStatus: 401 });
        }
        if (response.status === 400) {
          return failure(response.body?.error?.data?.code ?? 'invalid-request',
            response.body?.error?.message ?? 'Report service rejected request with HTTP 400.',
            { operation: name, httpStatus: 400 });
        }
        if (response.status < 200 || response.status >= 300) {
          return failure('report-service-unavailable',
            unavailableMessage(endpoint.port, response.body?.error?.message ?? `HTTP ${response.status}`, canWake),
            { operation: name, httpStatus: response.status });
        }
        if (response.body?.error) {
          return failure(response.body.error.data?.code ?? 'mcp-error',
            response.body.error.message ?? 'Remote MCP error.', { operation: name });
        }
        if (!response.body?.result || typeof response.body.result !== 'object') {
          return failure('transport-lost',
            'The wait transport ended without a result. Do not resend the task; check the original task reference.',
            { operation: name, taskKeys: args?.taskKeys, names: args?.names });
        }
        return response.body.result;
      } catch (error) {
        if (callerSignal.aborted) throw error;
        return failure('transport-lost',
          'The wait transport was lost. Do not resend the task; check the original task reference.',
          { operation: name, taskKeys: args?.taskKeys, names: args?.names, cause: error?.message ?? String(error) });
      } finally {
        callerSignal.removeEventListener('abort', abort);
        controller.abort();
        activeWaits.delete(controller);
      }
    }

    const invokeOnce = targetEndpoint => sendRpc(targetEndpoint, conversationId, workspace, 'tools/call', {
      name,
      arguments: args ?? {},
    });

    try {
      let response = await invokeOnce(endpoint);
      if (response.status === 401) {
        // HTTP 401 occurs before any tool handler executes, so refreshing a rotated
        // token file from disk and re-attempting once is always safe.
        const refreshed = await currentEndpoint();
        if (refreshed.token && refreshed.token !== endpoint.token) {
          endpoint = refreshed;
          response = await invokeOnce(endpoint);
        }
      }
      if (response.status === 401) {
        return failure(
          'report-service-unavailable',
          unavailableMessage(endpoint.port, 'caller token rejected with HTTP 401', canWake),
          { operation: name, httpStatus: 401 },
        );
      }
      if (response.status === 400) {
        return failure(
          response.body?.error?.data?.code ?? 'invalid-request',
          response.body?.error?.message ?? 'Report service rejected request with HTTP 400.',
          { operation: name, httpStatus: 400 },
        );
      }
      if (response.status < 200 || response.status >= 300) {
        return failure(
          'report-service-unavailable',
          unavailableMessage(endpoint.port, response.body?.error?.message ?? `HTTP ${response.status}`, canWake),
          { operation: name, httpStatus: response.status },
        );
      }
      if (response.body?.error) {
        return failure(
          response.body.error.data?.code ?? 'mcp-error',
          response.body.error.message ?? 'Remote MCP error.',
          { operation: name },
        );
      }
      const result = response.body?.result;
      if (!result || typeof result !== 'object') {
        return failure(
          'report-service-unavailable',
          unavailableMessage(endpoint.port, 'empty or invalid JSON-RPC response', canWake),
          { operation: name },
        );
      }
      return result;
    } catch (error) {
      if (error?.connected && !mayRetry(name)) {
        return failure(
          'write-outcome-unknown',
          'This call may already have been applied by the FutureAide service before the loopback connection closed. Do not resend it; inspect with futureaide_status or futureaide_list_agents first.',
          { operation: name },
        );
      }
      if (mayRetry(name) && canWake) {
        const retried = await prepareEndpoint({ forceRefresh: true });
        if (retried.ok) {
          try {
            const response = await invokeOnce(retried.endpoint);
            if (response.status >= 200 && response.status < 300 && response.body?.result) {
              return response.body.result;
            }
          } catch { /* fall through to unavailable error */ }
        }
      }
      return failure(
        'report-service-unavailable',
        unavailableMessage(endpoint.port, error?.code ?? error?.message ?? String(error), canWake),
        { operation: name },
      );
    }
  };

  server = createForwardServer({
    fetchTools,
    callTool,
    instructions: managedBinding
      ? `${INSTRUCTIONS}\n\nManaged CLI child mode active: call ask_parent to ask your parent a question, and call report_parent(message, final=true) to deliver your final report.`
      : INSTRUCTIONS,
    onRootsChanged: () => {
      cachedRootWorkspace = undefined;
      rootWorkspaceChecked = false;
    },
  });

  const initial = await listRemoteTools();
  const ready = initial.ok;
  if (ready) cachedTools = initial.tools;
  const tools = ready ? initial.tools.length : 0;
  if (ready) {
    log(`bridging ${tools} tool(s) to http://127.0.0.1:${initial.endpoint.port}${HTTP_PATH}`);
  } else {
    log(`${initial.code}: ${initial.message}`);
  }

  const close = async () => {
    for (const controller of activeWaits) controller.abort();
    httpAgent.destroy();
    const activeStore = store;
    const activeFallback = fallbackRosterStore;
    store = undefined;
    fallbackRosterStore = undefined;
    try { activeStore?.close?.(); } catch { /* ignore */ }
    try { activeFallback?.close?.(); } catch { /* ignore */ }
  };

  return {
    server,
    ready,
    tools,
    port: initial.endpoint.port,
    tokenFile: initial.endpoint.tokenFile,
    ...(ready ? {} : { reason: { code: initial.code, message: initial.message } }),
    idleSessionCleanup: initial.endpoint.config?.idleSessionCleanup !== false,
    fetchTools,
    listRemoteTools,
    callTool,
    resolveWorkspace,
    close,
  };
}

async function main() {
  const parsed = parseBootstrapArgs(process.argv.slice(2));
  const bridge = await startAntigravityCallerBridge({ ...parsed, inputSignal: stdioWaitSignal() });
  const transport = new StdioServerTransport();
  if (bridge.idleSessionCleanup) {
    exitWhenInputCloses({ transport, close: () => bridge.close() });
  }
  const stop = async () => { await bridge.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await bridge.server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main().catch(error => {
    process.stderr.write(`[${BOOTSTRAP_NAME}] bootstrap failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
