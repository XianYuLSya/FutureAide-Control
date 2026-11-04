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

const unavailable = message => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error: { code: 'report-service-unavailable', message } }) }],
});

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
  const empty = () => ({ server: createForwardServer({ fetchTools: async () => [],
    callTool: async () => unavailable('The loopback tool service is not reachable.') }), ready: false,
  tools: 0, close: async () => {} });

  let config;
  let store;
  try {
    config = await load(configPath);
    store = storeFor(config);
  } catch (error) {
    log(`no usable configuration (${error?.code ?? error?.message ?? error}); this session gets no tools`);
    return empty();
  }
  const port = reportPort(config, env);
  let expectedRoster;
  try { expectedRoster = rosterIdentity(store); } catch { expectedRoster = undefined; }
  const ready = async () => {
    try { return (await status({ port, expectedRoster }))?.ready === true; }
    catch { return false; }
  };

  if (!(await ready())) {
    try {
      const started = await ensure(config, store);
      if (started === false) log('this build cannot start the shared monitor here');
      else log('asked the shared monitor to start');
    } catch (error) {
      log(`the shared monitor did not start (${error?.code ?? error?.message ?? error})`);
    }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !(await ready())) await pause(pollMs);
  }
  if (!(await ready())) {
    log(`the loopback tool service did not answer on ${port}; this session gets no tools`);
    return empty();
  }

  const url = reportUrl(port);
  let client = await connect(url);
  let cached;
  const fetchTools = async () => {
    if (cached) return cached;
    const { tools } = await client.listTools();
    cached = Array.isArray(tools) ? tools : [];
    return cached;
  };
  const reopen = async () => {
    cached = undefined;
    try { await client.close(); } catch { /* already gone */ }
    try { await ensure(config, store); } catch { /* the health check below decides */ }
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && !(await ready())) await pause(pollMs);
    client = await connect(url);
  };
  const callTool = async (name, args) => {
    try { return await client.callTool({ name, arguments: args }); }
    catch {
      // The monitor may have gone quiet between calls; bring the one monitor back
      // and retry this single call rather than failing the model's turn.
      try { await reopen(); return await client.callTool({ name, arguments: args }); }
      catch (error) { return unavailable(`The loopback tool service stopped answering (${error?.message ?? error}).`); }
    }
  };

  const tools = await fetchTools().catch(() => []);
  const server = createForwardServer({ fetchTools, callTool });
  log(`bridging ${tools.length} tool(s) to ${url}`);
  return {
    server, ready: true, tools: tools.length, port, url,
    close: async () => { try { await client.close(); } catch { /* ignore */ } },
  };
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
