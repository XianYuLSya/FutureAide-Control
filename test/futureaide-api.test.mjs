import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FutureAideClient, FutureAideError } from '../src/futureaide-api.mjs';

const savedEnvironment = Object.fromEntries(['FUTUREAIDE_LAUNCH_URL', 'FUTUREAIDE_INSTANCE_FILE']
  .map(key => [key, process.env[key]]));
delete process.env.FUTUREAIDE_LAUNCH_URL;
delete process.env.FUTUREAIDE_INSTANCE_FILE;
after(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const ordinary = {
  sessionId: 'session-parent', running: true, cwd: 'D:\\Work\\FutureAide',
  projections: { asOfSeq: 123, values: { title: 'Integration task' } },
};

async function fixture(t, options = {}) {
  const state = { calls: [], exchanges: 0, token: 'fixture-launch-token', cookie: 'dsh-auth-fixture=fixture-session-cookie', projectSessions: [] };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/') {
        state.exchanges++;
        if (options.exchange) return options.exchange(req, res, state);
        if (url.searchParams.get('token') !== state.token) { res.writeHead(401); res.end(); return; }
        res.writeHead(303, { location: '/', 'set-cookie': `${state.cookie}; Path=/; HttpOnly; SameSite=Strict` });
        res.end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      state.calls.push({ method: req.method, path: url.pathname, body, cookie: req.headers.cookie, contentType: req.headers['content-type'] });
      if (req.headers.cookie !== state.cookie) { res.writeHead(401); res.end(); return; }
      if (options.rpc) return options.rpc(body, res, state);
      let value;
      switch (body.method) {
        case 'session/list': value = { items: options.items ?? [ordinary] }; break;
        case 'session/page': value = { records: [{ type: 'event', event: { type: 'assistant/message', seq: 123, data: { content: [{ type: 'text', text: 'Actual reply' }] } } }], hasMore: true }; break;
        case 'session/prompt': case 'session/cancel': value = { accepted: true }; break;
        case 'session/modelCatalog': value = { default: { provider: 'fixture', model: 'fixture-model' }, groups: [] }; break;
        case 'workspace/create': value = { created: false, workspace: { workspaceId: 'workspace-fixture', path: ordinary.cwd, title: 'Fixture', sessionIds: state.projectSessions } }; break;
        case 'session/create': {
          const request = body.payload.args.request;
          if (request.workspaceId && !options.skipAttach) state.projectSessions.push(request.sessionId);
          value = { sessionId: request.sessionId, agentPreset: request.agentPreset }; break;
        }
        case 'session/selectModel': { const { sessionId, ...selected } = body.payload.args.request; value = { selected }; break; }
        default: throw new Error('Unexpected endpoint');
      }
      reply(res, body, { ok: true, value });
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    state, baseUrl, port: server.address().port, launchUrl: `${baseUrl}/?token=${state.token}`,
    client: new FutureAideClient({ launchUrl: `${baseUrl}/?token=${state.token}`, timeoutMs: 1000, hostBridgeFile: options.hostBridgeFile }),
  };
}

function reply(res, body, result) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }));
}

async function tempHome(t) {
  const path = await mkdtemp(join(tmpdir(), 'futureaide-api-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function failure(code, uncertain = false) {
  return error => {
    assert.ok(error instanceof FutureAideError);
    assert.equal(error.code, code);
    assert.equal(error.uncertain, uncertain);
    return true;
  };
}

test('uses the native authenticated RPC envelope and retains session rows', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.listSessions(), { items: [ordinary] });
  assert.equal(f.state.exchanges, 1);
  const call = f.state.calls[0];
  assert.equal(call.path, '/api/session/list');
  assert.equal(call.method, 'POST');
  assert.equal(call.contentType, 'application/json');
  assert.equal(call.cookie, f.state.cookie);
  assert.equal(call.body.type, 'client-request');
  assert.equal(call.body.method, 'session/list');
  assert.match(call.body.rpcId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(call.body.payload, { args: { _request: {} } });
  const status = await f.client.status();
  assert.equal(status.connected, true);
  assert.equal(status.baseUrl, f.baseUrl);
  assert.equal(status.sessionCount, 1);
  const visible = JSON.stringify({ client: f.client, status });
  assert.ok(!visible.includes(f.state.token));
  assert.ok(!visible.includes(f.state.cookie));
});

test('ordinary project creation uses workspaceId and verifies sidebar membership', async t => {
  const f = await fixture(t);
  const result = await f.client.createProjectSession({ sessionId: 'project-session', cwd: ordinary.cwd, agentPreset: 'standard' });
  assert.equal(result.projectVisible, true);
  assert.equal(result.workspaceId, 'workspace-fixture');
  const creation = f.state.calls.find(call => call.body.method === 'session/create').body.payload.args.request;
  assert.equal(creation.workspaceId, 'workspace-fixture');
  assert.equal(creation.cwd, undefined);
  assert.equal(f.state.calls.filter(call => call.body.method === 'workspace/create').length, 2);
  assert.ok(!f.state.calls.some(call => call.body.method === 'session/prompt'));
});

test('existing ordinary sessions are attached with their original identity and never prompted', async t => {
  const f = await fixture(t);
  const result = await f.client.attachSessionToWorkspace(ordinary.sessionId, ordinary.cwd);
  assert.equal(result.projectVisible, true);
  assert.equal(result.sessionId, ordinary.sessionId);
  await f.client.attachSessionToWorkspace(ordinary.sessionId, ordinary.cwd);
  assert.equal(f.state.calls.filter(call => call.body.method === 'session/create').length, 1);
  assert.ok(!f.state.calls.some(call => call.body.method === 'session/prompt'));
});

test('a session created without confirmed project membership is not reported as success', async t => {
  const f = await fixture(t, { skipAttach: true });
  await assert.rejects(f.client.createProjectSession({ sessionId: 'unattached', cwd: ordinary.cwd }), failure('workspace-attach-failed', true));
});

test('creates an explicitly identified session without prompting and refuses preexisting identities', async t => {
  const f = await fixture(t);
  const result = await f.client.createSession({ sessionId: 'new-session', cwd: ordinary.cwd, agentPreset: 'boss' });
  assert.equal(result.sessionId, 'new-session');
  assert.equal(result.modelRequestsStarted, 0);
  assert.deepEqual(f.state.calls.map(call => call.body.method), ['session/list', 'session/create']);
  assert.deepEqual(f.state.calls[1].body.payload.args.request, { sessionId: 'new-session', cwd: ordinary.cwd, agentPreset: 'boss' });
  await assert.rejects(f.client.createSession({ sessionId: 'session-parent', cwd: ordinary.cwd }), failure('session-exists'));
});

test('refuses a session create request that combines workspaceId and cwd', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.createSession({ sessionId: 'invalid-combination', cwd: ordinary.cwd, workspaceId: 'workspace-fixture' }), failure('invalid-input'));
  assert.equal(f.state.calls.length, 0);
});

test('detects the modern native API using a read before creating a session', async t => {
  const f = await fixture(t, { rpc(body, res) {
    if (body.method === 'session/list') { res.writeHead(404); res.end(); return; }
    if (body.method === 'session.list') return reply(res, body, { ok: true, value: { items: [ordinary] } });
    if (body.method === 'session.create') return reply(res, body, { ok: true, value: { sessionId: body.payload.sessionId } });
    throw new Error('Unexpected request');
  } });
  const result = await f.client.createSession({ sessionId: 'new-modern', cwd: ordinary.cwd });
  assert.equal(result.sessionId, 'new-modern');
  assert.deepEqual(f.state.calls.map(call => call.body.method), ['session/list', 'session.list', 'session.create']);
  assert.deepEqual(f.state.calls[2].body.payload, { sessionId: 'new-modern', cwd: ordinary.cwd });
});

test('model selection uses the native validated path and declares its native default behavior', async t => {
  const f = await fixture(t);
  const selection = { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' };
  const result = await f.client.selectModel('session-parent', selection);
  assert.deepEqual(result.selected, selection);
  assert.equal(result.source, 'native-session-selectModel');
  assert.match(result.defaultModelBehavior, /default/);
  assert.deepEqual(f.state.calls.map(call => call.body.method), ['session/list', 'session/selectModel']);
  assert.deepEqual(f.state.calls[1].body.payload.args.request, { sessionId: 'session-parent', ...selection });
});

test('uses the list cursor for a cold-safe page and preserves the real reply', async t => {
  const f = await fixture(t);
  const page = await f.client.readSession('session-parent', { maxMessages: 7 });
  assert.deepEqual(f.state.calls.map(call => call.body.method), ['session/list', 'session/page']);
  assert.deepEqual(f.state.calls[1].body.payload.args, { request: {
    address: { kind: 'session', sessionId: 'session-parent' }, throughSeq: 123, maxMessages: 7,
  } });
  assert.equal(page.records[0].event.data.content[0].text, 'Actual reply');
  assert.equal(page.hasMore, true);
  await f.client.readSession('session-parent', { throughSeq: 40 });
  assert.equal(f.state.calls.length, 3);
  assert.equal(f.state.calls[2].body.payload.args.request.throughSeq, 40);
});

test('refuses missing history cursors without opening a follow stream', async t => {
  const f = await fixture(t, { items: [{ sessionId: 'session-parent', running: false }] });
  await assert.rejects(f.client.readSession('session-parent'), failure('cursor-unavailable'));
  assert.deepEqual(f.state.calls.map(call => call.body.method), ['session/list']);
});

test('uses the authenticated bridge cursor when a cold list projection is stale', async t => {
  const home = await tempHome(t);
  const bridge = join(home, 'bridge.json');
  await writeFile(bridge, JSON.stringify({ version: 1, token: 'a'.repeat(64) }));
  const cold = { ...ordinary, projections: { asOfSeq: -1, values: { title: 'Cold history' } } };
  const f = await fixture(t, { hostBridgeFile: bridge, items: [cold], rpc(body, res) {
    if (body.method === 'session/list') return reply(res, body, { ok: true, value: { items: [cold] } });
    if (body.method === 'historyCursor') {
      assert.equal(body.payload.args.workspace, ordinary.cwd);
      assert.equal(body.payload.args.sessionId, ordinary.sessionId);
      return reply(res, body, { ok: true, value: { sessionId: ordinary.sessionId, throughSeq: 71 } });
    }
    if (body.method === 'session/page') {
      assert.equal(body.payload.args.request.throughSeq, 71);
      return reply(res, body, { ok: true, value: { records: [{ type: 'event', event: { type: 'assistant/message', seq: 71, data: { content: [{ type: 'text', text: 'Cold reply' }] } } }], hasMore: false } });
    }
    throw new Error('Unexpected endpoint');
  } });
  const page = await f.client.readSession('session-parent', { workspace: ordinary.cwd });
  assert.equal(page.records[0].event.data.content[0].text, 'Cold reply');
  assert.deepEqual(f.state.calls.map(call => [call.path, call.body.method]), [
    ['/api/session/list', 'session/list'], ['/futureaide-control/historyCursor', 'historyCursor'], ['/api/session/page', 'session/page'],
  ]);
});

test('preserves an explicit empty cursor without consulting the bridge', async t => {
  const f = await fixture(t, { rpc(body, res) {
    assert.equal(body.method, 'session/page');
    assert.equal(body.payload.args.request.throughSeq, -1);
    reply(res, body, { ok: true, value: { records: [], hasMore: false } });
  } });
  assert.deepEqual(await f.client.readSession('session-parent', { throughSeq: -1 }), { records: [], hasMore: false });
  assert.equal(f.state.calls.length, 1);
});

test('reauthenticates and retries one read after 401', async t => {
  const f = await fixture(t, { rpc(body, res, state) {
    if (state.calls.length === 1) { res.writeHead(401); res.end(); return; }
    reply(res, body, { ok: true, value: { items: [ordinary] } });
  } });
  assert.equal((await f.client.listSessions()).items.length, 1);
  assert.equal(f.state.exchanges, 2);
  assert.equal(f.state.calls.length, 2);
});

test('bounds persistent 401 retries', async t => {
  const f = await fixture(t, { rpc(_body, res) { res.writeHead(401); res.end(); } });
  await assert.rejects(f.client.listSessions(), failure('authentication-required'));
  assert.equal(f.state.exchanges, 2);
  assert.equal(f.state.calls.length, 2);
});

test('reports business failures even with HTTP 200 and never echoes remote secrets', async t => {
  const f = await fixture(t, { rpc(body, res, state) {
    reply(res, body, { ok: false, error: { code: 'agent-busy', message: `${state.token} ${state.cookie}`, details: { launchUrl: `${state.token}` } } });
  } });
  await assert.rejects(f.client.listSessions(), error => {
    assert.equal(error.code, 'agent-busy');
    assert.ok(!JSON.stringify(error).includes(f.state.token));
    assert.ok(!String(error).includes(f.state.cookie));
    return true;
  });
});

test('redacts authentication values even when a remote error uses one as its code', async t => {
  const f = await fixture(t, { rpc(body, res, state) {
    reply(res, body, { ok: false, error: { code: state.token, message: state.cookie } });
  } });
  await assert.rejects(f.client.listSessions(), error => {
    assert.equal(error.code, 'rpc-error');
    assert.ok(!JSON.stringify(error).includes(f.state.token));
    return true;
  });
});

test('rejects unsafe URLs and credential-bearing URLs without disclosing input', () => {
  for (const launchUrl of [
    'https://example.com/?token=secret-value',
    'http://user:secret-value@127.0.0.1:3080/?token=secret-value',
    'file:///tmp/service?token=secret-value',
    'http://127.0.0.1:3080/api?token=secret-value',
    'http://127.0.0.1:3080/?token=secret-value&token=again',
  ]) {
    assert.throws(() => new FutureAideClient({ launchUrl }), error => {
      assert.ok(error instanceof FutureAideError);
      assert.ok(!String(error).includes('secret-value'));
      return true;
    });
  }
  assert.throws(() => new FutureAideClient({ baseUrl: 'http://127.0.0.1:3080/?token=secret-value' }), failure('unsafe-url'));
});

test('rejects authentication redirects to another origin and never follows them', async t => {
  const f = await fixture(t, { exchange(_req, res, state) {
    res.writeHead(303, { location: 'https://example.com/?token=fixture-launch-token', 'set-cookie': state.cookie });
    res.end();
  } });
  await assert.rejects(f.client.listSessions(), failure('unsafe-redirect'));
  assert.equal(f.state.exchanges, 1);
  assert.equal(f.state.calls.length, 0);
});

test('rejects redirected and mismatched RPC responses', async t => {
  const f = await fixture(t, { rpc(body, res, state) {
    if (state.calls.length === 1) { res.writeHead(302, { location: 'https://example.com/' }); res.end(); return; }
    reply(res, { ...body, rpcId: 'different-rpc-id' }, { ok: true, value: { items: [] } });
  } });
  await assert.rejects(f.client.listSessions(), failure('unsafe-redirect'));
  await assert.rejects(f.client.listSessions(), failure('invalid-response'));
});

test('rejects declared oversized RPC responses before buffering', async t => {
  const f = await fixture(t, { rpc(_body, res) {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 16 * 1024 * 1024 + 1 });
    res.end();
  } });
  await assert.rejects(f.client.listSessions(), failure('response-too-large'));
});

test('also bounds chunked responses without a content-length header', async () => {
  let cancelled = false;
  const client = new FutureAideClient({ launchUrl: 'http://127.0.0.1:3080/?token=fixture-token', fetchImpl: async (_url, init) => {
    if (init.method === 'GET') return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': 'dsh-auth-fixture=fixture-cookie' } });
    const chunk = new Uint8Array(1024 * 1024);
    return new Response(new ReadableStream({
      start(controller) { for (let i = 0; i < 18; i++) controller.enqueue(chunk); },
      cancel() { cancelled = true; },
    }), { status: 200 });
  } });
  await assert.rejects(client.listSessions(), failure('response-too-large'));
  assert.equal(cancelled, true);
});

test('sends exactly one native prompt after ordinary-session preflight', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.client.sendMessage('session-parent', 'Continue the task', { requestId: 'prompt-123' }), { accepted: true, requestId: 'prompt-123' });
  const prompt = f.state.calls.filter(call => call.body.method === 'session/prompt');
  assert.equal(prompt.length, 1);
  assert.deepEqual(prompt[0].body.payload.args, { request: {
    sessionId: 'session-parent', requestId: 'prompt-123', mode: 'queue',
    content: [{ type: 'text', text: 'Continue the task' }], clientTimeZone: 'Asia/Shanghai',
  } });
  const cancelled = await f.client.cancelSession('session-parent');
  assert.equal(cancelled.accepted, true);
  assert.match(cancelled.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(f.state.calls.at(-1).body.payload.args, { request: { sessionId: 'session-parent' } });
});

test('refuses child and absent sessions before either write endpoint', async t => {
  const f = await fixture(t, { items: [{ ...ordinary, origin: 'subagent', parentSessionId: 'other-parent' }] });
  await assert.rejects(f.client.sendMessage('session-parent', 'Continue'), failure('subagent-owned'));
  await assert.rejects(f.client.cancelSession('session-parent'), failure('subagent-owned'));
  await assert.rejects(f.client.sendMessage('missing-parent', 'Continue'), failure('session-not-found'));
  assert.ok(f.state.calls.every(call => call.body.method === 'session/list'));
});

test('does not retry a prompt after an authentication rejection', async t => {
  const f = await fixture(t, { rpc(body, res) {
    if (body.method === 'session/list') reply(res, body, { ok: true, value: { items: [ordinary] } });
    else { res.writeHead(401); res.end(); }
  } });
  await assert.rejects(f.client.sendMessage('session-parent', 'Continue'), failure('authentication-required'));
  assert.equal(f.state.calls.filter(call => call.body.method === 'session/prompt').length, 1);
  assert.equal(f.state.exchanges, 1);
});

test('marks timed-out writes uncertain and never redelivers the prompt', async t => {
  const f = await fixture(t, { rpc(body, res) {
    if (body.method === 'session/list') reply(res, body, { ok: true, value: { items: [ordinary] } });
  } });
  const client = new FutureAideClient({ launchUrl: f.launchUrl, timeoutMs: 150 });
  await assert.rejects(client.sendMessage('session-parent', 'Continue'), failure('timeout', true));
  assert.equal(f.state.calls.filter(call => call.body.method === 'session/prompt').length, 1);
});

test('discovers the legacy runtime and extracts only a bounded matching startup URL', async t => {
  const f = await fixture(t);
  const home = await tempHome(t);
  const runtime = join(home, '.runtime', 'futureaide');
  await mkdir(join(runtime, 'logs'), { recursive: true });
  await writeFile(join(runtime, 'futureaide-web.port'), String(f.port));
  await writeFile(join(runtime, 'futureaide-web.pid'), String(process.pid));
  await writeFile(join(runtime, 'logs', 'futureaide-desktop-service.log'), `${'x'.repeat(600 * 1024)}\n[I] dsh web: ${f.launchUrl}\n[I] dsh web: https://example.com/?token=untrusted\n`);
  const status = await new FutureAideClient({ dataHome: home }).status();
  assert.equal(status.connected, true);
  assert.equal(status.baseUrl, f.baseUrl);
  assert.equal(status.pid, process.pid);
  assert.equal(status.source, 'desktop-runtime');
  assert.ok(!JSON.stringify(status).includes(f.state.token));
});

test('supports instance files shaped like the native desktop snapshot', async t => {
  const f = await fixture(t);
  const home = await tempHome(t);
  const instanceFile = join(home, 'instance.json');
  await writeFile(instanceFile, JSON.stringify({ url: f.baseUrl, authToken: f.state.token, pid: process.pid }));
  const client = new FutureAideClient({ instanceFile });
  assert.equal((await client.status()).connected, true);
  assert.deepEqual(await client.modelCatalog(), { default: { provider: 'fixture', model: 'fixture-model' }, groups: [] });
  assert.deepEqual(f.state.calls.at(-1).body.payload, { args: {} });
});

test('does not send a write if the instance changes after target preflight', async t => {
  const next = await fixture(t);
  const home = await tempHome(t);
  const instanceFile = join(home, 'instance.json');
  const previous = await fixture(t, { rpc: async (body, res) => {
    await writeFile(instanceFile, JSON.stringify({ launchUrl: next.launchUrl, pid: process.pid }));
    reply(res, body, { ok: true, value: { items: [ordinary] } });
  } });
  await writeFile(instanceFile, JSON.stringify({ launchUrl: previous.launchUrl, pid: process.pid }));
  const client = new FutureAideClient({ instanceFile });
  await assert.rejects(client.sendMessage('session-parent', 'Continue'), failure('instance-changed'));
  assert.equal(previous.state.calls.length, 1);
  assert.equal(next.state.calls.length, 0);
  assert.equal(next.state.exchanges, 0);
});

test('supports an explicitly supplied launch URL through the process environment', async t => {
  const f = await fixture(t);
  process.env.FUTUREAIDE_LAUNCH_URL = f.launchUrl;
  try {
    assert.equal((await new FutureAideClient().status()).connected, true);
  } finally {
    delete process.env.FUTUREAIDE_LAUNCH_URL;
  }
});

test('reports missing discovery as disconnected and validates inputs before network access', async t => {
  const home = await tempHome(t);
  const client = new FutureAideClient({ dataHome: home });
  const status = await client.status();
  assert.equal(status.connected, false);
  assert.equal(status.error.code, 'instance-not-found');
  await assert.rejects(client.readSession('../session'), failure('invalid-input'));
  await assert.rejects(client.readSession('session-parent', { maxMessages: 101 }), failure('invalid-input'));
  await assert.rejects(client.readSession('session-parent', { throughSeq: NaN }), failure('invalid-input'));
  await assert.rejects(client.sendMessage('session-parent', ' '), failure('invalid-input'));
  await assert.rejects(client.sendMessage('session-parent', 'x'.repeat(128 * 1024 + 1)), failure('invalid-input'));
});
