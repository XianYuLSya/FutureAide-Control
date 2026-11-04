// Cold-start entry for a Claude Desktop session that uses the management and
// report tools. Claude can only launch a stdio server, so this thin bridge does
// two things and nothing else:
//
//   1. make sure the one shared monitor is running (it is the process that hosts
//      the loopback tool service), by calling the existing ensureSharedMonitor;
//   2. forward this session's tool traffic to that existing service unchanged.
//
// It is a forwarder, not a second surface: no tool schemas live here, no task or
// notification state, no second database. The roster is opened only to read and
// claim the monitor lease, the same way the plugin does. Identity is the chain the
// service already applies: the TCP peer is this Node process, whose parent is the
// Claude session, so the verified native record checks still decide who the caller
// is. A tool argument can never name a session.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.mjs';
import { readReportStatus, reportPort, reportUrl, rosterIdentity } from './report-endpoint.mjs';
import { ensureSharedMonitor } from './shared-monitor.mjs';
import { RosterStore } from './roster-store.mjs';

export const BOOTSTRAP_NAME = 'futureaide-report';
export const BOOTSTRAP_VERSION = '1.0.0';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const failure = (code, message, extra = {}) => ({ isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { code, message, ...extra } }) }] });

/**
 * Tools whose failure cannot have changed anything, so a retry is safe. Nothing
 * else is retried: no current tool has a durable server-side idempotency contract,
 * and a field that merely looks like one would be neither guaranteed to reach the
 * service nor honoured by it.
 */
export const READ_ONLY_TOOLS = Object.freeze(['futureaide_status', 'futureaide_list_agents',
  'futureaide_wait_agents', 'futureaide_agent_changes', 'futureaide_inspect_agent']);

export function mayRetry(name) {
  return READ_ONLY_TOOLS.includes(name);
}

/**
 * A tools-only MCP server that forwards list and call to the loopback service, so
 * the 12 tools are defined in exactly one place.
 * @param {{fetchTools: Function, callTool: Function}} options
 */
export function createForwardServer({ fetchTools, callTool }) {
  const server = new Server({ name: BOOTSTRAP_NAME, version: BOOTSTRAP_VERSION },
    { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await fetchTools() }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const result = await callTool(request.params.name, request.params.arguments ?? {});
    return {
      content: Array.isArray(result?.content) ? result.content : [],
      ...(result?.isError ? { isError: true } : {}),
      ...(result?.structuredContent ? { structuredContent: result.structuredContent } : {}),
    };
  });
  return server;
}

/**
 * Start the bridge. Returns `{ server, ready, close }`; `ready:false` means the
 * loopback service could not be reached and the session is served no tools instead
 * of tools that always fail.
 */
export async function startColdStartBridge({ configPath = process.env.DSH_CONTROL_CONFIG, env = process.env,
  waitMs = 10000, pollMs = 250, log = message => process.stderr.write(`[futureaide-report] ${message}\n`),
  load = loadConfig, status = readReportStatus, ensure = ensureSharedMonitor,
  storeFor = config => new RosterStore(path.join(config.stateDirectory, 'roster.sqlite')),
  connect = async url => {
    const client = new Client({ name: 'futureaide-report-bootstrap', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return client;
  } } = {}) {
  const state = { config: undefined, store: undefined, client: undefined, port: undefined, url: undefined };

  try {
    state.config = await load(configPath);
    state.store = storeFor(state.config);
    state.port = reportPort(state.config, env);
    state.url = reportUrl(state.port);
  } catch (error) {
    log(`no usable configuration (${error?.code ?? error?.message ?? error})`);
  }
  let expectedRoster;
  try { expectedRoster = rosterIdentity(state.store); } catch { expectedRoster = undefined; }

  const coded = (code, message) => Object.assign(new Error(message), { code });
  const serviceReady = async () => {
    if (!state.config) return false;
    try { return (await status({ port: state.port, expectedRoster }))?.ready === true; }
    catch { return false; }
  };
  const connectClient = async () => {
    if (state.client) { try { await state.client.close(); } catch { /* already gone */ } state.client = undefined; }
    state.client = await connect(state.url);
  };
  // Health, then the one existing monitor, then a live client. Called before every
  // forward, so a monitor that went quiet is brought back instead of failing.
  const prepare = async () => {
    if (!state.config) {
      throw coded('configuration-unavailable',
        'This session has no FutureAide configuration, so the tool service cannot be located.');
    }
    if (await serviceReady()) {
      if (!state.client) await connectClient();
      return;
    }
    try {
      const started = await ensure(state.config, state.store);
      if (started === false) log('this build cannot start the shared monitor here');
    } catch (error) {
      log(`the shared monitor did not start (${error?.code ?? error?.message ?? error})`);
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !(await serviceReady())) await pause(pollMs);
    if (!(await serviceReady())) {
      throw coded('report-service-unavailable',
        `The loopback tool service is not reachable on port ${state.port}.`);
    }
    await connectClient();
  };

  // The twelve tools stay the service's own: nothing is defined here.
  const fetchTools = async () => {
    await prepare();
    const { tools } = await state.client.listTools();
    return Array.isArray(tools) ? tools : [];
  };
  const callTool = async (name, args) => {
    try { await prepare(); }
    catch (error) { return failure(error?.code ?? 'report-service-unavailable', error?.message ?? String(error)); }
    try {
      return await state.client.callTool({ name, arguments: args });
    } catch (error) {
      // A write may already have been applied before the answer was lost. Never
      // replay it: say so plainly and let the caller inspect the operation.
      if (!mayRetry(name)) {
        return failure('write-outcome-unknown',
          'This call may already have been applied and its answer was lost. Do not resend it; '
          + 'check the operation with status, list or inspect first.', { operation: name });
      }
      try {
        await prepare();
        return await state.client.callTool({ name, arguments: args });
      } catch (retryError) {
        return failure('report-service-unavailable',
          `The loopback tool service stopped answering (${retryError?.message ?? retryError}).`, { operation: name });
      }
    }
  };

  // One bounded attempt so the first list is usually ready; a failure is not
  // cached: every later list or call prepares again and can recover.
  let ready = false;
  try { await prepare(); ready = true; } catch (error) { log(`${error?.code ?? 'unavailable'}: ${error.message}`); }
  const tools = ready ? await fetchTools().then(list => list.length).catch(() => 0) : 0;
  const server = createForwardServer({ fetchTools, callTool });
  if (ready) log(`bridging ${tools} tool(s) to ${state.url}`);
  const close = async () => {
    const client = state.client; state.client = undefined;
    try { await client?.close(); } catch { /* ignore */ }
    const store = state.store; state.store = undefined;
    try { store?.close?.(); } catch { /* ignore */ }
  };
  return { server, ready, tools, port: state.port, url: state.url, close };
}

async function main() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--config');
  const configPath = index === -1 ? process.env.DSH_CONTROL_CONFIG : argv[index + 1];
  const bridge = await startColdStartBridge({ configPath });
  await bridge.server.connect(new StdioServerTransport());
  const stop = async () => { await bridge.close(); process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => {
    process.stderr.write(`[futureaide-report] bootstrap failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
