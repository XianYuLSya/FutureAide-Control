// Verification suite for Antigravity caller identity, proxy env cleaning,
// loopback Bearer/header auth on claude-report-server.mjs, antigravity-caller-bootstrap.mjs
// (including on-demand monitor wake, --no-cold-start air-gap mode, MCP roots/list workspace
// resolution, SSE progress streaming for futureaide_wait_agents, and pull-only report delivery).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  ownerIdFor,
  ownerIdForSource,
  resolveCallingContext,
  TRUSTED_CALLER,
  trustedCaller,
} from '../src/calling-context.mjs';
import { cleanProxyEnv, monitorSpawn } from '../src/shared-monitor.mjs';
import { startHttpService, startReportService, trustedContextOf } from '../src/claude-report-server.mjs';
import {
  parseBootstrapArgs,
  rootUriToPath,
  startAntigravityCallerBridge,
} from '../src/antigravity-caller-bootstrap.mjs';
import { scopedManagement } from '../src/mcp-server.mjs';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { loadConfig } from '../src/config.mjs';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function withTempDir(t, prefix = 'agy-caller-test-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });
  return dir;
}

async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(() => resolve()));
  return port;
}

function postRaw({ port, path: reqPath = '/mcp', headers = {}, body = {} }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        accept: 'application/json, text/event-stream',
        ...headers,
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once('error', reject);
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// 1. ownerIdForSource('antigravity', ...) & calling-context
// ---------------------------------------------------------------------------

test('ownerIdForSource namespaces antigravity separately from codex-desktop and claude-desktop', async t => {
  const dir = await withTempDir(t, 'agy-owner-');
  const id = '11111111-2222-4333-8444-555555555555';
  const agy = ownerIdForSource('antigravity', id);
  const agyUpper = ownerIdForSource('antigravity', id.toUpperCase());
  const codex = ownerIdForSource('codex-desktop', id);
  const claude = ownerIdForSource('claude-desktop', id);

  assert.match(agy, /^owner-[0-9a-f]{32}$/);
  assert.equal(agy, agyUpper, 'conversation id hashing is case-insensitive');
  assert.notEqual(agy, codex);
  assert.notEqual(agy, claude);
  assert.equal(codex, ownerIdFor(id));

  const extra = {
    [TRUSTED_CALLER]: { source: 'antigravity', conversationId: 'conv-xyz', workspace: projectRoot },
  };
  const caller = trustedCaller(extra);
  assert.equal(caller.source, 'antigravity');
  assert.equal(caller.conversationId, 'conv-xyz');

  const resolved = await resolveCallingContext(extra);
  assert.equal(resolved.ownerId, ownerIdForSource('antigravity', 'conv-xyz'));
  assert.equal(resolved.source, 'antigravity');
  assert.equal(resolved.conversationId, 'conv-xyz');
  assert.equal('nativeSessionId' in resolved, false, 'Antigravity owner must not impersonate Claude nativeSessionId');

  const store = new RosterStore(path.join(dir, 'roster.sqlite'));
  t.after(() => store.close());
  const saved = store.saveOwner(resolved);
  assert.equal(saved.conversationId, 'conv-xyz');
  assert.throws(() => store.saveOwner({ ...resolved, workspace: dir }), /already bound to another project/i);
});

// ---------------------------------------------------------------------------
// 2. cleanProxyEnv() & monitorSpawn env stripping
// ---------------------------------------------------------------------------

test('cleanProxyEnv strips mixed-case proxy vars and monitorSpawn preserves config + strips proxy', async () => {
  const dirty = {
    PATH: 'C:\\Windows',
    SAFE_VAR: 'keep',
    HTTP_PROXY: 'http://127.0.0.1:7897',
    http_proxy: 'http://127.0.0.1:17900',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
    https_proxy: 'http://127.0.0.1:17900',
    ALL_PROXY: 'socks5://127.0.0.1:7897',
    all_proxy: 'socks5://127.0.0.1:17900',
    NO_PROXY: 'evil.local',
    no_proxy: 'other.local',
  };
  const clean = cleanProxyEnv(dirty);
  assert.equal(clean.SAFE_VAR, 'keep');
  assert.equal(clean.NO_PROXY, '127.0.0.1,localhost,::1');
  for (const key of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'no_proxy']) {
    assert.equal(key in clean, false, `${key} must be deleted`);
  }
  assert.equal(dirty.HTTP_PROXY, 'http://127.0.0.1:7897');

  let capturedArgs;
  let capturedOpts;
  const fakeSpawn = (_cmd, args, opts) => {
    capturedArgs = args;
    capturedOpts = opts;
    const child = new EventEmitter();
    child.pid = 12345;
    child.unref = () => {};
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  const lease = 'monitor-00000000-0000-4000-8000-000000000000';
  const pid = await monitorSpawn('D:\\cfg.json', lease, fakeSpawn, {
    config: { profile: 'dev', stateDirectory: 'D:\\state', dshDataRoot: 'D:\\dsh' },
    env: dirty,
  });
  assert.equal(pid, 12345);
  assert.ok(capturedArgs.includes('--profile') && capturedArgs.includes('dev'));
  assert.ok(capturedArgs.includes('--state') && capturedArgs.includes('--root'));
  assert.equal('HTTP_PROXY' in capturedOpts.env, false);
  assert.equal('https_proxy' in capturedOpts.env, false);
  assert.equal('ALL_PROXY' in capturedOpts.env, false);
  assert.equal(capturedOpts.env.NO_PROXY, '127.0.0.1,localhost,::1');
});

// ---------------------------------------------------------------------------
// 3. claude-report-server.mjs Bearer token + header auth
// ---------------------------------------------------------------------------

test('claude-report-server writes antigravity-caller.json, accepts valid Bearer+headers, rejects 401 and 400', async t => {
  const dir = await withTempDir(t, 'agy-auth-');
  const tokenFile = path.join(dir, 'antigravity-caller.json');
  const seenCallers = [];

  const service = await startHttpService({
    port: 0,
    antigravityCallerTokenFile: tokenFile,
    resolveCaller: async () => { throw Object.assign(new Error('not claude'), { code: 'caller-unresolved' }); },
    management: ({ server, trusted }) => {
      server.registerTool('futureaide_status', { description: 'Status', inputSchema: {} }, async () => {
        const ctx = await trusted();
        seenCallers.push(ctx);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, caller: ctx }) }] };
      });
    },
  });
  t.after(() => service.close());

  const diskToken = JSON.parse(await readFile(tokenFile, 'utf8'));
  assert.equal(diskToken.port, service.port);
  assert.equal(diskToken.token, service.antigravityCallerToken);
  assert.equal(diskToken.token.length, 64);

  const callBody = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'futureaide_status', arguments: {} } };

  const noAuth = await postRaw({
    port: service.port,
    headers: { 'x-futureaide-caller': 'antigravity', 'x-antigravity-conversation-id': 'conv-1' },
    body: callBody,
  });
  assert.equal(noAuth.status, 401);

  const badAuth = await postRaw({
    port: service.port,
    headers: {
      authorization: `Bearer ${'0'.repeat(64)}`,
      'x-futureaide-caller': 'antigravity',
      'x-antigravity-conversation-id': 'conv-1',
    },
    body: callBody,
  });
  assert.equal(badAuth.status, 401);

  const missingConv = await postRaw({
    port: service.port,
    headers: {
      authorization: `Bearer ${service.antigravityCallerToken}`,
      'x-futureaide-caller': 'antigravity',
    },
    body: callBody,
  });
  assert.equal(missingConv.status, 400);

  const ok = await postRaw({
    port: service.port,
    headers: {
      authorization: `Bearer ${service.antigravityCallerToken}`,
      'x-futureaide-caller': 'antigravity',
      'x-antigravity-conversation-id': 'conv-42',
      'x-antigravity-workspace': projectRoot,
    },
    body: callBody,
  });
  assert.equal(ok.status, 200);
  assert.equal(seenCallers.length, 1);
  assert.equal(seenCallers[0].source, 'antigravity');
  assert.equal(seenCallers[0].conversationId, 'conv-42');
  assert.equal(seenCallers[0].workspace, projectRoot);
  assert.equal(trustedContextOf({ source: 'antigravity', conversationId: 'c1', workspace: projectRoot }).source, 'antigravity');
});

// ---------------------------------------------------------------------------
// 4. antigravity-caller-bootstrap.mjs: air-gap --no-cold-start vs on-demand wake
// ---------------------------------------------------------------------------

test('antigravity-caller-bootstrap respects --no-cold-start and never spawns monitor when disabled', async t => {
  const dir = await withTempDir(t, 'agy-nocold-');
  const deadPort = await closedPort();
  let ensureCalled = 0;

  assert.deepEqual(parseBootstrapArgs(['--config', 'D:\\a.json', '--port', '17654', '--no-cold-start']), {
    configPath: 'D:\\a.json',
    port: 17654,
    coldStartMonitor: false,
  });

  const bridge = await startAntigravityCallerBridge({
    port: deadPort,
    tokenFile: path.join(dir, 'missing-token.json'),
    coldStartMonitor: false,
    ensure: async () => { ensureCalled += 1; return true; },
    log: () => {},
  });
  t.after(() => bridge.close());

  assert.equal(bridge.ready, false);
  assert.equal(ensureCalled, 0);

  const result = await bridge.callTool('futureaide_status', {}, {
    params: { _meta: { 'antigravity.google/conversation_id': 'conv-offline' } },
  }, {});
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.error.code, 'report-service-unavailable');
  assert.equal(ensureCalled, 0);
});

test('antigravity-caller-bootstrap wakes shared monitor on demand when coldStartMonitor is enabled', async t => {
  const dir = await withTempDir(t, 'agy-wake-');
  const configFile = path.join(dir, 'config.json');
  const stateDir = path.join(dir, 'state');
  const tokenFile = path.join(stateDir, 'antigravity-caller.json');
  await writeFile(configFile, JSON.stringify({ target: 'dsh', dataRoot: path.join(dir, 'dsh') }), 'utf8');

  const store = new RosterStore(path.join(stateDir, 'roster.sqlite'));
  t.after(() => store.close());

  let service;
  t.after(async () => { await service?.close(); });
  let wakeCalls = 0;
  let boundPort = await closedPort();

  const bridge = await startAntigravityCallerBridge({
    configPath: configFile,
    tokenFile,
    port: boundPort,
    coldStartMonitor: true,
    waitMs: 5000,
    pollMs: 50,
    storeFor: () => store,
    ensure: async () => {
      wakeCalls += 1;
      service = await startReportService({
        store,
        port: boundPort,
        runtimeDir: stateDir,
        antigravityCallerTokenFile: tokenFile,
        management: ({ server }) => {
          server.registerTool('futureaide_status', { description: 'Status', inputSchema: {} }, async () => ({
            content: [{ type: 'text', text: JSON.stringify({ ok: true, woken: true }) }],
          }));
        },
      });
      return true;
    },
    log: () => {},
  });
  t.after(() => bridge.close());

  assert.equal(wakeCalls, 1);
  assert.equal(bridge.ready, true);
  assert.equal(bridge.tools, 1);

  const res = await bridge.callTool('futureaide_status', {}, {
    params: { _meta: { 'antigravity.google/conversation_id': 'conv-woken' } },
  }, {});
  assert.equal(res.isError, undefined);
  assert.equal(JSON.parse(res.content[0].text).woken, true);
});

// ---------------------------------------------------------------------------
// 5. MCP roots/list workspace discovery & SSE progress forwarding for wait
// ---------------------------------------------------------------------------

test('antigravity-caller-bootstrap resolves workspace via MCP roots/list and streams SSE wait progress', async t => {
  const dir = await withTempDir(t, 'agy-roots-sse-');
  const workspaceDir = path.join(dir, 'my-project');
  const tokenFile = path.join(dir, 'antigravity-caller.json');
  assert.equal(rootUriToPath(pathToFileURL(workspaceDir).href), path.resolve(workspaceDir));

  let seenWorkspace;
  const service = await startHttpService({
    port: 0,
    antigravityCallerTokenFile: tokenFile,
    resolveCaller: async () => { throw Object.assign(new Error('not claude'), { code: 'caller-unresolved' }); },
    management: ({ server, trusted }) => {
      server.registerTool('futureaide_wait_agents', { description: 'Wait', inputSchema: {} }, async (_args, extra) => {
        const ctx = await trusted();
        seenWorkspace = ctx.workspace;
        const progressToken = extra?._meta?.progressToken;
        if (progressToken !== undefined && extra?.sendNotification) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: 1, message: 'Still waiting' },
          });
        }
        return { content: [{ type: 'text', text: JSON.stringify({ events: [{ type: 'final' }], workspace: ctx.workspace }) }] };
      });
    },
  });
  t.after(() => service.close());

  const bridge = await startAntigravityCallerBridge({
    port: service.port,
    tokenFile,
    coldStartMonitor: false,
    env: { ANTIGRAVITY_CONVERSATION_ID: 'conv-roots-1' },
    cwd: dir,
    log: () => {},
  });
  t.after(() => bridge.close());

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'antigravity-test-client', version: '1.0.0' },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(workspaceDir).href, name: 'my-project' }],
  }));
  await bridge.server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(() => client.close());

  const progressUpdates = [];
  const callRes = await client.callTool(
    { name: 'futureaide_wait_agents', arguments: {} },
    undefined,
    { onprogress: p => progressUpdates.push(p) },
  );
  assert.equal(callRes.isError, undefined);
  assert.equal(seenWorkspace, path.resolve(workspaceDir));
  assert.equal(progressUpdates.length, 1);
  assert.equal(progressUpdates[0].message, 'Still waiting');
  const payload = JSON.parse(callRes.content[0].text);
  assert.equal(payload.events[0].type, 'final');
});

// ---------------------------------------------------------------------------
// 6. Full scopedManagement + createScopedAgents integration (pull-only notice)
// ---------------------------------------------------------------------------

test('Antigravity caller works end-to-end against createScopedAgents status & list', async t => {
  const dir = await withTempDir(t, 'agy-e2e-caller-');
  const configFile = path.join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify({ target: 'dsh', dataRoot: path.join(dir, 'dsh') }), 'utf8');
  const config = await loadConfig(configFile);

  const service = createScopedAgents(config, {
    clientFactory: () => ({
      hostStatus: async () => ({ methods: [], treeProtocol: null, reportProtocol: null }),
    }),
    backendAdapters: {
      'codex-desktop': () => ({
        target: 'codex-desktop',
        probe: async () => ({ identity: { application: 'codex-desktop' }, methods: [], treeProtocol: 1, reportProtocol: 1 }),
        create: async () => ({}), beginTask: async () => ({}), observe: async () => ({}),
        history: async () => ({ messages: [], hasMore: false }), answer: async () => ({}),
        deliver: async () => ({}), receipt: async () => undefined, turn: async () => ({ state: 'ended' }),
        models: async () => ({ groups: [{ id: 'openai', models: [{ id: 'gpt-6.2-astra', name: 'GPT 6.2 Astra' }] }] }),
        model: async () => null, selectModel: async () => ({ accepted: true }),
        cancel: async () => ({ cancelRequested: true }), destroy: async () => ({ destroyed: true }),
        cursor: async () => ({ throughSeq: 0 }),
      }),
      'claude-cli': () => ({
        target: 'claude-cli',
        probe: async () => { throw Object.assign(new Error('not installed'), { code: 'claude-cli-not-found' }); },
        create: async () => ({}), beginTask: async () => ({}), observe: async () => ({}),
        history: async () => ({ messages: [], hasMore: false }), answer: async () => ({}),
        deliver: async () => ({}), receipt: async () => undefined, turn: async () => ({ state: 'ended' }),
        models: async () => ({ groups: [] }), model: async () => null, selectModel: async () => ({ accepted: true }),
        cancel: async () => ({ cancelRequested: true }), destroy: async () => ({ destroyed: true }),
        cursor: async () => ({ throughSeq: 0 }),
      }),
    },
  });
  t.after(() => service.close());

  const tokenFile = path.join(config.stateDirectory, 'antigravity-caller.json');
  const httpSvc = await startReportService({
    store: service.store,
    port: 0,
    runtimeDir: config.stateDirectory,
    antigravityCallerTokenFile: tokenFile,
    management: scopedManagement({ service }),
  });
  t.after(() => httpSvc.close());

  const bridge = await startAntigravityCallerBridge({
    configPath: configFile,
    tokenFile,
    port: httpSvc.port,
    coldStartMonitor: false,
    env: { ANTIGRAVITY_WORKSPACE: dir },
    log: () => {},
  });
  t.after(() => bridge.close());

  assert.equal(bridge.ready, true);
  assert.ok(bridge.tools >= 10, `expected full management tool list, got ${bridge.tools}`);

  const metaReq = { params: { _meta: { 'antigravity.google/conversation_id': 'conv-live-001' } } };
  const statusRes = await bridge.callTool('futureaide_status', { detail: true }, metaReq, {});
  const statusBody = JSON.parse(statusRes.content[0].text);
  assert.equal(statusBody.contextVerified, true);
  assert.equal(statusBody.returnChannel, 'chat-verified');
  assert.equal(statusBody.workspace, path.resolve(dir));
  assert.equal(statusBody.agents, 0);

  const listRes = await bridge.callTool('futureaide_list_agents', {}, metaReq, {});
  assert.equal(listRes.isError, undefined);
  const listBody = JSON.parse(listRes.content[0].text);
  assert.deepEqual(listBody.items, []);
});

test('installAntigravityPlugin stages plugin.json, mcp_config.json, and skills without touching config.json', async t => {
  const { installAntigravityPlugin } = await import('../scripts/install-plugin.mjs');
  const dir = await withTempDir(t, 'agy-install-');
  const pluginDir = path.join(dir, 'plugins', 'futureaide-control');
  const cfgPath = path.join(dir, 'config.json');
  const result = await installAntigravityPlugin({
    sourceRoot: projectRoot,
    configFile: cfgPath,
    antigravityPluginDir: pluginDir,
  });
  assert.equal(result.registered, true);
  assert.equal(result.pluginRoot, path.resolve(pluginDir));

  const manifest = JSON.parse(await readFile(path.join(pluginDir, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'futureaide-control');
  const mcp = JSON.parse(await readFile(path.join(pluginDir, 'mcp_config.json'), 'utf8'));
  assert.equal(mcp.mcpServers.futureaide.args[0], path.join(projectRoot, 'src', 'antigravity-caller-bootstrap.mjs'));
  assert.equal(mcp.mcpServers.futureaide.env.FUTUREAIDE_CONFIG, cfgPath);
  const skill = await readFile(path.join(pluginDir, 'skills', 'futureaide-control', 'SKILL.md'), 'utf8');
  assert.match(skill, /FutureAide Control/);
});

