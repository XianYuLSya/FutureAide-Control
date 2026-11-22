import test from 'node:test';
import assert from 'node:assert/strict';
import { createRendererDiscovery, rendererQuery } from '../src/codex-renderer-discovery.mjs';

const endpoint = { pid: 42, port: 45678, started: '900000000' };
function page(id, port = endpoint.port) {
  return { id, type: 'page', url: 'app://-/index.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${id}` };
}

test('cold lookup filters names and session at the provider; warm lookup checks only the cached PID/port', () => {
  assert.match(rendererQuery(null), /-Filter "\(Name='ChatGPT\.exe' OR Name='Codex\.exe'\) AND SessionId=/);
  assert.match(rendererQuery(endpoint), /-Filter "ProcessId=42 AND SessionId=/);
  assert.match(rendererQuery(endpoint), /-Property ProcessId -Filter .*ProcessId<>42 .*--remote-debugging-port/);
  assert.match(rendererQuery(endpoint), /-OwningProcess \$candidate\.ProcessId/);
  assert.match(rendererQuery(null), /-OwningProcess \$candidate\.ProcessId/);
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
  await assert.rejects(find(), { code: 'codex-native-rpc-unavailable' });
  pages = [{ ...page('one'), webSocketDebuggerUrl: 'ws://127.0.0.1:45678/devtools/page/two' }];
  await assert.rejects(find(), { code: 'codex-native-rpc-unavailable' });
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

test('a competing main process or second renderer port invalidates a previously good cache', async () => {
  for (const competitor of [{ ...endpoint, pid: 43, port: 45679 }, { ...endpoint, port: 45679 }]) {
    let rows = [endpoint];
    const find = createRendererDiscovery({ query: async () => rows, pages: async port => [page('main-' + port, port)] });
    assert.equal((await find()).pid, endpoint.pid);
    rows = [endpoint, competitor];
    await assert.rejects(find(), { code: 'codex-native-rpc-unavailable' });
  }
});
