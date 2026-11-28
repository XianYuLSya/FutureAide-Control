import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCliProxyEnv,
  checkProxyReachable,
  normalizeProxySpec,
  publicRouteSummary,
  readFaswitchRoute,
  resolveCliRoute,
} from '../src/cli-proxy.mjs';
import { loadConfig } from '../src/config.mjs';
import { createScopedAgents } from '../src/scoped-agents.mjs';

async function startTcpServer() {
  const server = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    port,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function getClosedPort() {
  const temp = await startTcpServer();
  const { port } = temp;
  await temp.close();
  return port;
}

async function makeFaswitchFixture(root, {
  profileId = '1b37fed7-2a5d-4b5a-976b-8571bbcde341',
  profileName = 'xiayuip-win',
  codexHome = path.join(root, 'codex-home'),
  accountProfileId = profileId,
  activationState = 'active',
  activationProfileId = profileId,
  port,
  node = 'fa:clash-verge-rev:b5ded46ce7:XiaYuip-Windows',
} = {}) {
  await mkdir(path.join(root, 'state'), { recursive: true });
  await mkdir(path.join(root, 'runtime'), { recursive: true });
  await writeFile(path.join(root, 'state', 'current-profile.json'), JSON.stringify({
    schema_version: 2,
    active: { profile_id: profileId, name: profileName },
    roots: { home: codexHome },
  }));
  await writeFile(path.join(root, 'state', 'current-accounts.json'), JSON.stringify({
    schema_version: 1,
    codex: { profile_id: accountProfileId },
  }));
  await writeFile(path.join(root, 'runtime', 'proxy-activation.json'), JSON.stringify({
    schema_version: 2,
    state: activationState,
    profile_id: activationProfileId,
    port,
    node,
    pid: process.pid,
  }));
}

test('normalizeProxySpec accepts ports, URLs, direct, and route objects and rejects invalid inputs', () => {
  assert.deepEqual(normalizeProxySpec(17913), { mode: 'proxy', proxyUrl: 'http://127.0.0.1:17913', port: 17913 });
  assert.deepEqual(normalizeProxySpec('17913'), { mode: 'proxy', proxyUrl: 'http://127.0.0.1:17913', port: 17913 });
  assert.deepEqual(normalizeProxySpec('socks5://127.0.0.1:7897'), { mode: 'proxy', proxyUrl: 'socks5://127.0.0.1:7897', port: 7897 });
  assert.deepEqual(normalizeProxySpec('direct'), { mode: 'direct', proxyUrl: null, port: null });
  assert.deepEqual(normalizeProxySpec({ port: 17913 }), { mode: 'proxy', proxyUrl: 'http://127.0.0.1:17913', port: 17913 });
  assert.deepEqual(normalizeProxySpec({ mode: 'direct' }), { mode: 'direct', proxyUrl: null, port: null });
  assert.equal(normalizeProxySpec(''), undefined);

  assert.throws(() => normalizeProxySpec(0), /Invalid proxy port/);
  assert.throws(() => normalizeProxySpec(70000), /Invalid proxy port/);
  assert.throws(() => normalizeProxySpec('ftp://127.0.0.1:8080'), /Unsupported proxy protocol/);
  assert.throws(() => normalizeProxySpec('not-a-url'), /Invalid proxy URL/);
});

test('resolveCliRoute follows FAswitch 3.2 active profile & port and fails closed on mismatch or inactive proxy', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fa-cli-proxy-'));
  const proxy = await startTcpServer();
  try {
    await makeFaswitchFixture(dir, { port: proxy.port });
    const route = await resolveCliRoute({
      target: 'codex-cli',
      config: { faswitchHome: dir },
      env: {},
    });
    assert.equal(route.ok, true);
    assert.equal(route.source, 'faswitch');
    assert.equal(route.mode, 'proxy');
    assert.equal(route.profileName, 'xiayuip-win');
    assert.equal(route.port, proxy.port);
    assert.equal(route.proxyUrl, `http://127.0.0.1:${proxy.port}`);
    assert.equal(route.node, 'fa:clash-verge-rev:b5ded46ce7:XiaYuip-Windows');
    assert.equal(publicRouteSummary(route).profile, 'xiayuip-win');

    // Profile mismatch between current-profile.json and proxy-activation.json -> fail closed
    await makeFaswitchFixture(dir, { port: proxy.port, activationProfileId: 'other-profile-id' });
    const mismatch = await resolveCliRoute({
      target: 'codex-cli',
      config: { faswitchHome: dir },
      env: {},
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'faswitch-profile-mismatch');

    // Proxy inactive -> fail closed
    await makeFaswitchFixture(dir, { port: proxy.port, activationState: 'inactive' });
    const inactive = await resolveCliRoute({
      target: 'codex-cli',
      config: { faswitchHome: dir },
      env: {},
    });
    assert.equal(inactive.ok, false);
    assert.equal(inactive.code, 'faswitch-proxy-inactive');

    // Closed port -> fail closed
    const closedPort = await getClosedPort();
    await makeFaswitchFixture(dir, { port: closedPort });
    const unreachable = await resolveCliRoute({
      target: 'codex-cli',
      config: { faswitchHome: dir },
      env: {},
    });
    assert.equal(unreachable.ok, false);
    assert.equal(unreachable.code, 'proxy-unavailable');
    assert.equal(unreachable.port, closedPort);
  } finally {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveCliRoute honors manual port/URL/direct overrides ahead of FAswitch and verifies TCP reachability', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fa-cli-manual-'));
  const manualProxy = await startTcpServer();
  const closedPort = await getClosedPort();
  try {
    // Even if FAswitch is broken/inactive, explicit manual binding overrides it.
    await makeFaswitchFixture(dir, { port: closedPort, activationState: 'inactive' });

    const viaConfig = await resolveCliRoute({
      target: 'codex-cli',
      config: { faswitchHome: dir, cliRoutes: { 'codex-cli': manualProxy.port } },
      env: {},
    });
    assert.equal(viaConfig.ok, true);
    assert.equal(viaConfig.source, 'manual');
    assert.equal(viaConfig.port, manualProxy.port);
    assert.equal(viaConfig.proxyUrl, `http://127.0.0.1:${manualProxy.port}`);

    // Env overrides config.cliRoutes
    const viaEnv = await resolveCliRoute({
      target: 'codex-cli',
      config: { faswitchHome: dir, cliRoutes: { 'codex-cli': closedPort } },
      env: { FUTUREAIDE_CODEX_CLI_PROXY: String(manualProxy.port) },
    });
    assert.equal(viaEnv.ok, true);
    assert.equal(viaEnv.source, 'manual');
    assert.equal(viaEnv.port, manualProxy.port);

    // Explicit direct skips TCP probe and disables proxy injection
    const viaDirect = await resolveCliRoute({
      target: 'codex-cli',
      config: { faswitchHome: dir, codexCliProxy: 'direct' },
      env: {},
    });
    assert.equal(viaDirect.ok, true);
    assert.equal(viaDirect.source, 'manual');
    assert.equal(viaDirect.mode, 'direct');
    assert.equal(viaDirect.proxyUrl, null);

    // Manual override pointing at closed port still fails closed
    const badManual = await resolveCliRoute({
      target: 'codex-cli',
      config: { faswitchHome: dir, codexCliProxyPort: closedPort },
      env: {},
    });
    assert.equal(badManual.ok, false);
    assert.equal(badManual.code, 'proxy-unavailable');
    assert.equal(badManual.source, 'manual');
  } finally {
    await manualProxy.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildCliProxyEnv replaces stale parent proxy vars and preserves loopback NO_PROXY', () => {
  const base = {
    PATH: 'C:\\Windows\\System32',
    HTTP_PROXY: 'http://127.0.0.1:7901',
    https_proxy: 'http://127.0.0.1:7901',
    ALL_PROXY: 'socks5://127.0.0.1:7901',
    NO_PROXY: 'corp.local',
  };

  const proxied = buildCliProxyEnv(
    base,
    { mode: 'proxy', proxyUrl: 'http://127.0.0.1:17913', codexHome: path.resolve('fixture-codex-home') },
  );
  assert.equal(proxied.HTTP_PROXY, 'http://127.0.0.1:17913');
  assert.equal(proxied.HTTPS_PROXY, 'http://127.0.0.1:17913');
  assert.equal(proxied.ALL_PROXY, 'http://127.0.0.1:17913');
  assert.equal(proxied.http_proxy, 'http://127.0.0.1:17913');
  assert.equal(proxied.https_proxy, 'http://127.0.0.1:17913');
  assert.equal(proxied.all_proxy, 'http://127.0.0.1:17913');
  assert.match(proxied.NO_PROXY, /127\.0\.0\.1/);
  assert.match(proxied.NO_PROXY, /localhost/);
  assert.match(proxied.NO_PROXY, /corp\.local/);
  assert.equal(proxied.CODEX_HOME, path.resolve('fixture-codex-home'));

  const direct = buildCliProxyEnv(base, { mode: 'direct', proxyUrl: null });
  assert.equal(direct.HTTP_PROXY, undefined);
  assert.equal(direct.https_proxy, undefined);
  assert.equal(direct.ALL_PROXY, undefined);
});

test('loadConfig validates and inherits cliRoutes, faswitchHome, and codexCliProxyPort', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fa-cli-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  try {
    await writeFile(cfgPath, JSON.stringify({
      faswitchHome: dir,
      codexCliProxyPort: 17913,
      cliRoutes: { 'codex-cli': 'http://127.0.0.1:17913', antigravity: 'direct' },
    }));
    const loaded = await loadConfig(cfgPath);
    assert.equal(loaded.faswitchHome, dir);
    assert.equal(loaded.codexCliProxyPort, 17913);
    assert.deepEqual(loaded.cliRoutes, { 'codex-cli': 'http://127.0.0.1:17913', antigravity: 'direct' });

    await writeFile(cfgPath, JSON.stringify({ cliRoutes: { 'codex-cli': 'ftp://bad:21' } }));
    await assert.rejects(() => loadConfig(cfgPath), /Unsupported proxy protocol/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkProxyReachable detects listening vs closed loopback ports', async () => {
  const server = await startTcpServer();
  const closedPort = await getClosedPort();
  try {
    const ok = await checkProxyReachable(`http://127.0.0.1:${server.port}`);
    assert.equal(ok.ok, true);
    assert.equal(ok.port, server.port);
    const bad = await checkProxyReachable(`http://127.0.0.1:${closedPort}`, { timeoutMs: 300 });
    assert.equal(bad.ok, false);
  } finally {
    await server.close();
  }
});

test('readFaswitchRoute returns present:false when FAswitch directory does not exist', async () => {
  const missing = path.join(tmpdir(), `no-faswitch-${Date.now()}`);
  const result = await readFaswitchRoute({ faswitchHome: missing, env: {} });
  assert.equal(result.present, false);
});

test('Antigravity CLI binds port 7901 and checks it in status for all backends', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fa-agy-proxy-'));
  const configFile = path.join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify({ cliRoutes: { 'codex-cli': 'direct', 'claude-cli': 'direct' } }));
  const seen = [];
  const service = createScopedAgents({ workspace: dir, stateDirectory: dir, configFile, faswitchHome: dir,
    cliRoutes: { 'codex-cli': 'direct', 'claude-cli': 'direct' },
  }, {
    checkCliProxy: async url => { seen.push(url); return { ok: true }; },
  });
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  const bound = await service.manageCliProxy({ action: 'bind', target: 'agy-cli', proxy: 7901 });
  assert.equal(bound.ok, true);
  const all = await service.manageCliProxy({ target: 'all' });
  assert.equal(all.ok, true);
  assert.deepEqual(all.routes.map(item => [item.target, item.port]), [
    ['codex-cli', null], ['claude-cli', null], ['agy-cli', 7901],
  ]);
  assert.deepEqual(seen, ['http://127.0.0.1:7901', 'http://127.0.0.1:7901']);
});
