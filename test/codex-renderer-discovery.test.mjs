import test from 'node:test';
import assert from 'node:assert/strict';
import { createRendererDiscovery, rendererQuery } from '../src/codex-renderer-discovery.mjs';
import { createCodexNativeRpc } from '../src/codex-ipc.mjs';
import { createCodexHost } from '../src/codex-host.mjs';
import { BACKEND_METHODS, diagnoseTarget } from '../src/agent-backend.mjs';

const endpoint = { pid: 42, port: 45678, started: '900000000' };
function page(id, port = endpoint.port) {
  return { id, type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}` };
}

const failed = discoveryReason => ({ code: 'codex-native-rpc-unavailable', discoveryReason, notSent: true });

test('cold lookup filters names and session; warm lookup checks the cached PID and competing process IDs', () => {
  assert.match(rendererQuery(null), /-Filter "\(Name='ChatGPT\.exe' OR Name='Codex\.exe'\) AND SessionId=/);
  assert.match(rendererQuery(endpoint), /-Filter "ProcessId=42 AND SessionId=/);
  assert.match(rendererQuery(endpoint), /-Property ProcessId -Filter .*ProcessId<>42 .*--remote-debugging-port/);
  assert.match(rendererQuery(endpoint), /-OwningProcess \$candidate\.ProcessId/);
  assert.match(rendererQuery(null), /-OwningProcess \$candidate\.ProcessId/);
  assert.match(rendererQuery(null), /CmdletizationQuery_NotFound,Get-NetTCPConnection/);
  assert.match(rendererQuery(null), /\$listenerFilter\.LocalPort = \$portNumber/);
});

test('warm discovery revalidates the original listener and target; stale or reused PID causes cold discovery', async () => {
  const queries = [];
  let current = endpoint, currentPage = 'one';
  const find = createRendererDiscovery({
    query: async hint => { queries.push(hint ? hint.pid : 'cold'); return [current]; },
    pages: async port => [page(currentPage, port)],
  });
  assert.equal((await find()).targetId, 'one');
  assert.equal((await find()).targetId, 'one');
  currentPage = 'two';
  assert.equal((await find()).targetId, 'two');
  current = { ...endpoint, started: 'later-start', port: 45679 };
  assert.equal((await find()).port, 45679);
  assert.deepEqual(queries, ['cold', 42, 42, 'cold', 42, 'cold']);
});

test('invalid websocket identity, ambiguity and stale discovery fail closed', async () => {
  let pages = [page('one')];
  const find = createRendererDiscovery({ query: async () => [endpoint], pages: async () => pages });
  await find();
  pages.push(page('two'));
  await assert.rejects(find(), failed('multiple-main-targets'));
  pages = [{ ...page('one'), webSocketDebuggerUrl: 'ws://127.0.0.1:45678/devtools/page/two' }];
  await assert.rejects(find(), failed('no-match'));
});

test('concurrent discoveries share one process and listener check', async () => {
  let lookups = 0;
  const find = createRendererDiscovery({
    query: async () => { lookups++; return [endpoint]; },
    pages: async () => [page('shared')],
  });
  assert.deepEqual((await Promise.all(Array.from({ length: 9 }, find))).map(hit => hit.targetId), Array(9).fill('shared'));
  assert.equal(lookups, 1);
});

test('warm discovery finds a second main page on an unchanged sibling listener of the cached process', async () => {
  const reads = [];
  const queries = [];
  const sibling = { ...endpoint, port: 3344, listenerStarted: 'first' };
  let siblingPages = [];
  const find = createRendererDiscovery({
    query: async hint => { queries.push(hint?.pid ?? 'cold'); return [endpoint, sibling]; },
    pages: async port => { reads.push(port); return port === endpoint.port ? [page('main', port)] : siblingPages; },
  });
  await find();
  assert.deepEqual(reads.splice(0), [endpoint.port, 3344]);
  await find();
  assert.deepEqual(reads.splice(0), [endpoint.port, 3344]);
  siblingPages = [page('sibling', sibling.port)];
  await assert.rejects(find(), failed('multiple-main-targets'));
  assert.deepEqual(reads, [endpoint.port, 3344]);
  assert.deepEqual(queries, ['cold', endpoint.pid, endpoint.pid]);
});

test('a competing main process or second renderer port invalidates a previously good cache', async () => {
  for (const competitor of [{ ...endpoint, pid: 43, port: 45679 }, { ...endpoint, port: 45679 }]) {
    let rows = [endpoint];
    const find = createRendererDiscovery({ query: async () => rows, pages: async port => [page('main-' + port, port)] });
    assert.equal((await find()).pid, endpoint.pid);
    rows = [endpoint, competitor];
    await assert.rejects(find(), failed('multiple-main-targets'));
  }
});

test('warm competition signal triggers a targeted cold lookup, without treating its rows as multiple targets', async () => {
  const competitor = { ...endpoint, pid: 43, port: 45679 };
  let competitorPages = [];
  const queries = [];
  const find = createRendererDiscovery({
    query: async hint => { queries.push(hint?.pid ?? 'cold'); return hint ? [] : [endpoint, competitor]; },
    pages: async port => port === endpoint.port ? [page('main')] : competitorPages,
  });
  assert.equal((await find()).targetId, 'main');
  assert.equal((await find()).targetId, 'main');
  competitorPages = [page('competitor', competitor.port)];
  await assert.rejects(find(), failed('multiple-main-targets'));
  assert.deepEqual(queries, ['cold', endpoint.pid, 'cold', endpoint.pid, 'cold']);
});

test('query and page-list failures differ from a complete zero-match result and can recover', async () => {
  let rows = null, targets;
  const find = createRendererDiscovery({
    query: async (_hint, timeout) => {
      assert.ok(timeout > 0 && timeout <= 10_000);
      if (rows instanceof Error) throw rows;
      return rows;
    },
    pages: async (_port, timeout) => {
      assert.ok(timeout > 0 && timeout <= 1500);
      if (targets instanceof Error) throw targets;
      return targets;
    },
  });
  await assert.rejects(find(), failed('list-failed'));
  rows = new DOMException('provider timed out', 'TimeoutError');
  await assert.rejects(find(), failed('timeout'));
  rows = [];
  await assert.rejects(find(), failed('no-match'));
  rows = [endpoint];
  targets = new Error('HTTP 503');
  await assert.rejects(find(), failed('list-failed'));
  targets = { data: [] };
  await assert.rejects(find(), failed('list-failed'));
  targets = new DOMException('page list timed out', 'TimeoutError');
  await assert.rejects(find(), failed('timeout'));
  targets = [];
  await assert.rejects(find(), failed('no-match'));
  targets = [null, { ...page('invalid'), webSocketDebuggerUrl: 'bad URL' }, page('recovered'), page('recovered')];
  assert.equal((await find()).targetId, 'recovered');
});

test('failed sibling listing blocks selection until one target or real ambiguity can be verified', async () => {
  const sibling = { ...endpoint, port: 45679 };
  let targets = [page('main')];
  let failSibling = false;
  const find = createRendererDiscovery({
    query: async () => [sibling, endpoint],
    pages: async port => {
      if (port !== sibling.port) return targets;
      if (failSibling) throw new Error('unreadable list');
      return [];
    },
  });
  assert.equal((await find()).targetId, 'main');
  failSibling = true;
  await assert.rejects(find(), failed('list-failed'));
  targets = [page('main'), page('second')];
  await assert.rejects(find(), failed('multiple-main-targets'));
});

test('the default list reader handles a non-CDP dynamic sibling but keeps a fixed-port failure visible', async t => {
  const sibling = { ...endpoint, port: 45679 };
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(new URL(url).pathname, '/json/list');
    if (new URL(url).port === String(endpoint.port)) return Response.json([page('main')]);
    return new Response(null, { status: 404 });
  });
  const dynamic = createRendererDiscovery({ query: async () => [endpoint, sibling] });
  assert.equal((await dynamic()).targetId, 'main');
  const fixed = createRendererDiscovery({ query: async () => [{ ...sibling, debugPort: sibling.port }] });
  await assert.rejects(fixed(), failed('list-failed'));
});

test('failed discovery is reported at transport admission, then the probe admits a single write', async t => {
  let targets = [page('one'), page('two')];
  const discover = createRendererDiscovery({ query: async () => [endpoint], pages: async () => targets });
  const sent = [], measured = [];
  let sockets = 0;
  class Socket extends EventTarget {
    constructor() {
      super();
      sockets++;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(raw) {
      const command = JSON.parse(raw);
      sent.push(command.params.expression);
      const value = sent.length === 1 ? { data: [] } : { turn: { id: 'once' } };
      const data = JSON.stringify({ id: command.id, result: { result: { value } } });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const rpc = createCodexNativeRpc({ discover, WebSocketImpl: Socket, measure: event => measured.push(event) });
  t.after(() => rpc.close());
  rpc.ensureProbe();
  const holdEventLoop = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(holdEventLoop));
  await assert.rejects(rpc.request('turn/start', {}), {
    ...failed('multiple-main-targets'), transportAdmissionFailed: true,
  });
  assert.equal(sockets, 0);
  assert.equal(measured.find(event => event.event === 'discovery_error')?.discoveryReason, 'multiple-main-targets');
  targets = [page('one')];
  assert.deepEqual(await rpc.request('turn/start', {}), { turn: { id: 'once' } });
  assert.equal(sockets, 1);
  assert.equal(sent.length, 2);
  assert.match(sent[0], /thread\/list/);
  assert.match(sent[1], /turn\/start/);
});

test('host status preserves a classified discovery failure', async t => {
  const discover = createRendererDiscovery({ query: async () => [] });
  const rpc = createCodexNativeRpc({ discover, measure: null });
  t.after(() => rpc.close());
  const host = createCodexHost({ nativeRequest: rpc.request });
  const backend = Object.fromEntries(BACKEND_METHODS.map(method => [method, () => assert.fail(method)]));
  backend.probe = host.probe;
  const status = await diagnoseTarget('codex-desktop', { adapterLoader: async () => async () => backend });
  assert.equal(status.ready, false);
  assert.equal(status.reason.code, 'codex-native-rpc-unavailable');
  assert.equal(status.reason.discoveryReason, 'no-match');
});

test('discovery lost after thread creation reports a retryable first turn on that same thread', async t => {
  let rows = [endpoint];
  const discover = createRendererDiscovery({ query: async () => rows, pages: async () => [page('main')] });
  const calls = [];
  const thread = { id: 'existing-native-thread', status: { type: 'idle' } };
  const responses = { 'thread/start': { thread }, 'thread/list': { data: [] }, 'thread/read': { thread },
    'turn/start': { turn: { id: 'first-turn' } } };
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) {
      const { id, params } = JSON.parse(raw);
      const method = /"method":"([\w/]+)","params":/.exec(params.expression)?.[1];
      calls.push(method);
      const data = JSON.stringify({ id, result: { result: { value: responses[method] } } });
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const rpc = createCodexNativeRpc({ discover, WebSocketImpl: Socket, measure: null });
  t.after(() => rpc.close());
  const host = createCodexHost({ nativeRequest: rpc.request });
  const input = { workspace: process.cwd(), message: 'first message' };
  await assert.rejects(host.createFirstTurn({ ...input, onIntent: () => { rows = []; rpc.close(); } }), {
    ...failed('no-match'), transportAdmissionFailed: true, nativeSessionId: thread.id,
  });
  assert.deepEqual(calls, ['thread/start']);
  const holdEventLoop = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(holdEventLoop));
  rows = [endpoint];
  await host.createFirstTurn({ ...input, nativeSessionId: thread.id });
  assert.deepEqual(calls, ['thread/start', 'thread/list', 'thread/read', 'turn/start']);
});
