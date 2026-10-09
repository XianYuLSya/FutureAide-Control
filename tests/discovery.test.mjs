import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FutureAideClient, FutureAideError } from '../src/futureaide-api.mjs';

const savedEnvironment = Object.fromEntries(
  ['FUTUREAIDE_LAUNCH_URL', 'FUTUREAIDE_INSTANCE_FILE', 'FUTUREAIDE_DATA_ROOT', 'DSH_HOME']
    .map(key => [key, process.env[key]]),
);
for (const key of Object.keys(savedEnvironment)) delete process.env[key];
after(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const sessionRow = { sessionId: 'discovery-session', running: true, projections: { asOfSeq: 1, values: {} } };

async function makeHost(t, options = {}) {
  const state = { calls: [], exchanges: 0, token: options.token ?? 'host-token', cookie: 'dsh-auth-host=host-cookie' };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      state.exchanges++;
      if (options.exchange) return options.exchange(req, res, state);
      if (url.searchParams.get('token') !== state.token) { res.writeHead(401); res.end(); return; }
      res.writeHead(303, { location: '/', 'set-cookie': `${state.cookie}; Path=/; HttpOnly; SameSite=Strict` });
      res.end();
      return;
    }
    if (!options.acceptApi && url.pathname !== '/api/session/list') { res.writeHead(404); res.end(); return; }
    const chunks = [];
    void (async () => {
      try {
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        state.calls.push({ method: body.method, payload: body.payload, cookie: req.headers.cookie });
        if (req.headers.cookie !== state.cookie) { res.writeHead(401); res.end(); return; }
        if (options.rpc) return options.rpc(body, res, state);
        if (url.pathname === '/api/session/list') return reply(res, body, { items: [sessionRow] });
        if (url.pathname === '/api/session/create') return reply(res, body, { sessionId: body.payload.args.request.sessionId });
        res.writeHead(404);
        res.end();
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const launchUrl = `${baseUrl}/?token=${state.token}`;
  return { state, baseUrl, launchUrl, pid: options.pid ?? process.pid, token: state.token };
}

function reply(res, body, value) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
}

async function tempHome(t) {
  const directory = await mkdtemp(join(tmpdir(), 'discovery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeDshInstance(t, root, host, options = {}) {
  const registry = join(root, '.runtime', 'dsh-control', 'instances');
  await mkdir(registry, { recursive: true });
  const file = join(registry, `${options.pid ?? host.pid}.json`);
  await writeFile(file, JSON.stringify({
    version: 1,
    application: 'dsh',
    pid: options.pid ?? host.pid,
    instanceId: options.instanceId ?? randomUUID(),
    dataRoot: root,
    launchUrl: host.launchUrl,
  }));
  return file;
}

async function writeFutureInstance(t, temporaryRoot, host, options = {}) {
  const shellRoot = join(temporaryRoot, 'futureaide-shell', options.directory ?? 'current');
  await mkdir(shellRoot, { recursive: true });
  const file = join(shellRoot, 'control-instance.json');
  await writeFile(file, JSON.stringify({
    pid: options.pid ?? host.pid,
    url: host.baseUrl,
    authToken: host.token,
  }));
  return file;
}

function futureClient(t, temporaryRoot, host, options = {}) {
  return new FutureAideClient({
    target: 'futureaide',
    temporaryRoot,
    hostBridgeFile: options.hostBridgeFile,
    ...options.extra,
  });
}

function failure(code) {
  return error => {
    assert.ok(error instanceof FutureAideError);
    assert.equal(error.code, code);
    return true;
  };
}

function hostCalls(host) {
  return host.state.calls;
}

test('discovers only the registered DSH host', async t => {
  const host = await makeHost(t);
  const home = await tempHome(t);
  await writeDshInstance(t, home, host);
  const client = new FutureAideClient({ target: 'auto', dataHome: await tempHome(t), dshDataHome: home, temporaryRoot: await tempHome(t) });
  const status = await client.status();
  assert.equal(status.connected, true);
  assert.equal(status.application, 'dsh');
  assert.equal(status.baseUrl, host.baseUrl);
  assert.equal(status.pid, host.pid);
  assert.equal(status.source, 'dsh-plugin-registry');
  assert.equal(status.sessionCount, 1);
  assert.ok(host.state.calls.every(call => call.method === 'session/list'));
  assert.equal(host.state.calls.length, 2);
  assert.ok(host.state.calls.every(call => call.payload.args._request !== undefined));
});

test('prefers FutureAide when both hosts are healthy', async t => {
  const future = await makeHost(t, { token: 'future-token' });
  const dsh = await makeHost(t, { token: 'dsh-token' });
  const temporaryRoot = await tempHome(t);
  await writeFutureInstance(t, temporaryRoot, future);
  const dshHome = await tempHome(t);
  await writeDshInstance(t, dshHome, dsh);
  const client = new FutureAideClient({
    target: 'auto', temporaryRoot, dataHome: join(dshHome, 'future-data'), dshDataHome: dshHome,
  });
  const status = await client.status();
  assert.equal(status.application, 'futureaide');
  assert.equal(status.baseUrl, future.baseUrl);
  assert.equal(status.source, 'futureaide-shell');
  assert.equal(dsh.state.exchanges, 0);
  assert.equal(future.state.exchanges, 1);
});

test('falls back to DSH when the FutureAide host is unreachable', async t => {
  const future = await makeHost(t, { token: 'future-token', acceptApi: true });
  const dsh = await makeHost(t, { token: 'dsh-token' });
  const temporaryRoot = await tempHome(t);
  await writeFutureInstance(t, temporaryRoot, future, { pid: 999_999_999 });
  const dshHome = await tempHome(t);
  await writeDshInstance(t, dshHome, dsh);
  const client = new FutureAideClient({
    target: 'auto', temporaryRoot, dataHome: join(dshHome, 'future-data'), dshDataHome: dshHome,
  });
  const status = await client.status();
  assert.equal(status.connected, true);
  assert.equal(status.application, 'dsh');
  assert.equal(status.baseUrl, dsh.baseUrl);
  assert.equal(future.state.exchanges, 0);
  assert.equal(dsh.state.exchanges, 1);
});

test('FutureAide authentication failure is visible and never falls back to DSH', async t => {
  const future = await makeHost(t, { token: 'future-token', exchange(_req, res) { res.writeHead(401); res.end(); } });
  const dsh = await makeHost(t, { token: 'dsh-token' });
  const temporaryRoot = await tempHome(t);
  await writeFutureInstance(t, temporaryRoot, future);
  const dshHome = await tempHome(t);
  await writeDshInstance(t, dshHome, dsh);
  const client = new FutureAideClient({
    target: 'auto', temporaryRoot, dataHome: join(dshHome, 'future-data'), dshDataHome: dshHome,
  });
  const status = await client.status();
  assert.equal(status.connected, false);
  assert.equal(status.error.code, 'authentication-failed');
  await assert.rejects(client.listSessions(), failure('authentication-failed'));
  assert.equal(dsh.state.exchanges, 0);
  assert.ok(future.state.exchanges >= 1);
  assert.ok(future.state.exchanges <= 2);
});

test('reports multiple healthy DSH hosts as ambiguous and skips dead PIDs', async t => {
  const first = await makeHost(t, { token: 'first-token' });
  const second = await makeHost(t, { token: 'second-token' });
  const home = await tempHome(t);
  const registry = join(home, '.runtime', 'dsh-control', 'instances');
  await mkdir(registry, { recursive: true });
  await writeFile(join(registry, '999999999.json'), JSON.stringify({
    version: 1, application: 'dsh', pid: 999_999_999, instanceId: randomUUID(), dataRoot: home, launchUrl: first.launchUrl,
  }));
  await writeFile(join(registry, `${first.pid}.json`), JSON.stringify({
    version: 1, application: 'dsh', pid: first.pid, instanceId: randomUUID(), dataRoot: home, launchUrl: first.launchUrl,
  }));
  await writeFile(join(registry, `${second.pid + 1}.json`), JSON.stringify({
    version: 1, application: 'dsh', pid: second.pid, instanceId: randomUUID(), dataRoot: home, launchUrl: second.launchUrl,
  }));
  const client = new FutureAideClient({ target: 'auto', dataHome: await tempHome(t), dshDataHome: home, temporaryRoot: await tempHome(t) });
  await assert.rejects(client.listSessions(), failure('ambiguous-instance'));
  assert.equal(first.state.exchanges, 1);
  assert.equal(second.state.exchanges, 1);
  assert.ok(hostCalls(first).every(entry => entry.method === 'session/list'));
  assert.ok(hostCalls(second).every(entry => entry.method === 'session/list'));
});

test('skips malformed automatic registrations and still finds a healthy DSH host', async t => {
  const host = await makeHost(t);
  const home = await tempHome(t);
  const registry = join(home, '.runtime', 'dsh-control', 'instances');
  await mkdir(registry, { recursive: true });
  await writeFile(join(registry, '999999998.json'), '{bad json');
  await writeDshInstance(t, home, host);
  const client = new FutureAideClient({ target: 'auto', dataHome: await tempHome(t), dshDataHome: home, temporaryRoot: await tempHome(t) });
  const status = await client.status();
  assert.equal(status.connected, true);
  assert.equal(status.baseUrl, host.baseUrl);
});

test('reports disconnected when no instance exists', async t => {
  const home = await tempHome(t);
  const client = new FutureAideClient({ target: 'auto', dataHome: await tempHome(t), dshDataHome: home, temporaryRoot: await tempHome(t) });
  const status = await client.status();
  assert.equal(status.connected, false);
  assert.equal(status.error.code, 'instance-not-found');
});

test('an explicitly broken instanceFile fails without fallback', async t => {
  const host = await makeHost(t);
  const home = await tempHome(t);
  const badFile = join(home, 'bad-instance.json');
  await writeFile(badFile, '{not-json');
  const dshHome = await tempHome(t);
  await writeDshInstance(t, dshHome, host);
  const client = new FutureAideClient({ target: 'auto', instanceFile: badFile, dshDataHome: dshHome, temporaryRoot: await tempHome(t) });
  await assert.rejects(client.listSessions(), failure('invalid-instance'));
  assert.equal(host.state.exchanges, 0);
});

test('does not send a write when the discovery record changes before the write', async t => {
  const host = await makeHost(t);
  const home = await tempHome(t);
  const registry = join(home, '.runtime', 'dsh-control', 'instances');
  await mkdir(registry, { recursive: true });
  const file = join(registry, `${host.pid}.json`);
  await writeFile(file, JSON.stringify({
    version: 1, application: 'dsh', pid: host.pid, instanceId: randomUUID(), dataRoot: home, launchUrl: host.launchUrl,
  }));
  const client = new FutureAideClient({ target: 'auto', dataHome: await tempHome(t), dshDataHome: home, temporaryRoot: await tempHome(t) });
  await client.listSessions();
  const before = host.state.calls.length;
  await writeFile(file, JSON.stringify({
    version: 1, application: 'dsh', pid: host.pid, instanceId: randomUUID(), dataRoot: home, launchUrl: host.launchUrl,
  }));
  await assert.rejects(client.createSession({ sessionId: 'new-session', cwd: home }), failure('instance-changed'));
  assert.ok(host.state.calls.slice(before).every(call => call.method !== 'session/create'));
});
