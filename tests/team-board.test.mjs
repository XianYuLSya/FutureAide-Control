// The team board: one request in, the designer's shape out. Everything here runs against
// a fixture roster and a loopback listener on an ephemeral port; no application, window,
// process or conversation is touched.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { BOARD_DATA_PATH, BOARD_PATH, boardData, boardName, boardPageFile, boardRoutes, claudeTitles, projectName } from '../src/team-board.mjs';
import { startHttpService } from '../src/claude-report-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.dirname(here);
const CLOCK = new Date('2026-11-12T15:00:00.000Z');
const recent = new Date(CLOCK.getTime() - 60 * 60 * 1000).toISOString();
const stale = new Date(CLOCK.getTime() - 40 * 60 * 60 * 1000).toISOString();

function record(overrides) {
  return { ownerId: 'owner-a', name: 'name', state: 'idle', lifetime: 'persistent', closed: false,
    updatedAt: recent, task: { taskId: 'task-1', message: 'do the work', dispatches: [], answers: [], reports: [] }, ...overrides };
}

/** A roster shaped like the live one: two owners, one nested helper, one Codex lead thread. */
function fixture() {
  const store = new RosterStore(':memory:');
  // Claude owner without a session title: the board must fall back to the folder name.
  store.saveOwner({ ownerId: 'owner-a', workspace: 'D:\\Work\\media', source: 'claude-desktop', createdAt: recent });
  // Codex owner whose thread owns a name in another chat (the lead-nesting rule).
  store.saveOwner({ ownerId: 'owner-b', workspace: 'D:\\Work\\xiayuls_workflow', source: 'codex-desktop',
    threadId: 'thread-lead', createdAt: recent });
  store.insert(record({ agentId: 'agent-lead', ownerId: 'owner-b', name: '团队长', state: 'running',
    observation: { tree: { nodes: [{}, {}] } } }));
  store.appendHistory('agent-lead', { message: '你是团队长，按角色卡做。' });
  store.insert(record({ agentId: 'agent-child', ownerId: 'owner-a', name: 'worker', parentAgentId: 'agent-lead',
    state: 'awaiting_input', task: { taskId: 'task-2', message: 'second', dispatches: [], answers: [],
      modelSelection: { model: 'gpt-6-astra', effort: 'high' }, result: { changes: [{ path: 'a' }, { path: 'b' }] },
      reports: [{ message: 'first report', final: false, failure: null, delivery: { state: 'delivered' } },
        { message: 'latest report', final: true, failure: null, delivery: { state: 'pending' } }] },
    observation: { activity: 'tool: pwsh', questions: [{ id: 'q', state: 'pending' }, { id: 'q2', state: 'answered' }],
      tree: { nodes: [] } }, releaseState: { state: 'complete' } }));
  store.appendHistory('agent-child', { message: '角色：后端工程师。按派单做。' });
  store.insert(record({ agentId: 'agent-old', ownerId: 'owner-a', name: 'gone', updatedAt: stale }));
  // A dispatched helper of the Codex lead: its own chat hangs under the lead.
  store.saveOwner({ ownerId: 'owner-c', workspace: 'D:\\Work\\media', source: 'claude-desktop',
    threadId: 'thread-lead', createdAt: recent });
  store.insert(record({ agentId: 'agent-helper', ownerId: 'owner-c', name: 'helper' }));
  store.saveBackendState('agent-lead', { binding: { sessionId: 'thread-lead' } });
  return store;
}

test('the board groups by owner, nests helpers under their lead and drops the old window', () => {
  const store = fixture();
  try {
    const data = boardData(store, { titles: new Map(), now: CLOCK.getTime() });
    assert.equal(data.machine, undefined, 'the export machine block never reaches the board');
    assert.match(data.exportedAt, /^\d\d\/\d\d \d\d:\d\d$/);
    assert.deepEqual(Object.keys(data.states).sort(), ['awaiting_input', 'running', 'idle'].sort());
    assert.equal(data.states.awaiting_input, 1, 'awaiting_input is counted like any other state');
    const lead = data.chats.find(chat => chat.names.some(name => name.name === '团队长'));
    assert.ok(lead, 'the Codex lead still has its own chat');
    assert.equal(lead.chat, 'Codex 对话');
    assert.equal(lead.ownerThread, 'thread-lead');
    assert.equal(lead.source, 'codex-desktop');
    const top = lead.names.find(name => name.name === '团队长');
    assert.equal(top.role, '团队长', 'the role comes from the first task');
    assert.deepEqual(top.children.map(child => [child.name, child.via]), [['helper', 'lead-dispatch']]);
    assert.equal(data.chats.some(chat => chat.names.some(name => name.name === 'helper')), false,
      'a dispatched helper chat does not appear twice');
    assert.equal(top.nativeChildren, 1, 'native children are the observed tree minus itself');
    const claude = data.chats.find(chat => chat.project === 'D:\\Work\\media' && chat.ownerThread === null);
    assert.equal(claude.chat, 'media', 'a chat without a title falls back to the project folder');
    const worker = claude.names.find(name => name.name === 'worker');
    assert.equal(worker.state, 'awaiting_input');
    assert.equal(worker.role, '后端工程师');
    assert.equal(worker.model, 'gpt-6-astra');
    assert.equal(worker.effort, 'high');
    assert.equal(worker.files, 2);
    assert.equal(worker.pendingQuestions, 1);
    assert.equal(worker.release, 'complete');
    assert.equal(worker.activity, 'tool: pwsh');
    assert.deepEqual(worker.report, { final: true, summary: 'latest report', delivery: 'pending' },
      'the latest report that is not a failure wins');
    assert.equal(claude.names.some(name => name.name === 'gone'), false, 'a name outside the window is not shown');
  } finally { store.close(); }
});

test('the board reads the roster once per request and reuses one snapshot', () => {
  const store = fixture();
  try {
    const reads = [];
    const original = store.boardSnapshot;
    store.boardSnapshot = () => { reads.push(Date.now()); return original.call(store); };
    const data = boardData(store, { titles: new Map(), now: CLOCK.getTime() });
    assert.equal(reads.length, 1, 'one snapshot serves the whole board');
    assert.ok(data.chats.length >= 2);
    // The projection is cached: a second request without a roster commit reuses it, and
    // the 36-hour window is applied in JS so an old row never invalidates the cache.
    boardData(store, { titles: new Map(), now: CLOCK.getTime() });
    assert.equal(store.projections.get('board')?.rows.length, 4, 'the cached rows keep the old row too');
  } finally { store.close(); }
});

test('a title from the local session registry wins over the project folder', () => {
  const store = fixture();
  try {
    store.saveOwner({ ownerId: 'owner-d', workspace: 'D:\\Work\\demo', source: 'claude-desktop',
      nativeSessionId: 'session-1', createdAt: recent });
    store.insert(record({ agentId: 'agent-titled', ownerId: 'owner-d', name: 'titled' }));
    const data = boardData(store, { titles: new Map([['session-1', 'FutureAIdeControl']]), now: CLOCK.getTime() });
    const chat = data.chats.find(item => item.project === 'D:\\Work\\demo');
    assert.equal(chat.chat, 'FutureAIdeControl');
  } finally { store.close(); }
});

test('session titles are read from the registry and a broken one is skipped', async () => {
  const base = path.join(here, '..', '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'board-titles-'));
  await mkdir(path.join(root, 'sessions'), { recursive: true });
  await writeFile(path.join(root, 'sessions', '1.json'), JSON.stringify({ sessionId: 's1', name: '  named chat  ' }), 'utf8');
  await writeFile(path.join(root, 'sessions', '2.json'), '{ not json', 'utf8');
  await writeFile(path.join(root, 'sessions', '3.json'), JSON.stringify({ sessionId: 's3', name: '   ' }), 'utf8');
  const titles = claudeTitles({ root });
  assert.deepEqual([...titles], [['s1', 'named chat']], 'only a real title counts');
});

test('boardName trims what the page shows and defaults what it cannot know', () => {
  const name = boardName({ id: 'a', name: 'x', updatedAt: recent, state: 'idle', task: `  ${'long '.repeat(40)}  `,
    firstTaskMessage: '角色：设计师', activity: '  ', pendingQuestions: 0, treeNodes: 1, fileCount: null });
  assert.equal(name.role, '设计师');
  assert.equal(name.target, 'dsh');
  assert.equal(name.activity, null);
  assert.equal(name.files, null);
  assert.equal(name.report, null);
  assert.equal(name.nativeChildren, 0);
  assert.ok(name.task.length <= 90 && !name.task.startsWith(' '));
  assert.equal(projectName('D:\\Work\\media\\'), 'media');
  assert.equal(projectName(undefined), null);
});

test('the page comes from the build first, then from the approved design in docs', async () => {
  const base = path.join(here, '..', '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'board-page-'));
  const built = path.join(root, 'assets', 'team-board', 'index.html');
  const designed = path.join(root, 'docs', 'grill', 'Boss协议', '团队看板', '小看板.html');
  await mkdir(path.dirname(designed), { recursive: true });
  await writeFile(designed, '<html>design</html>', 'utf8');
  assert.equal(boardPageFile({ here: path.join(root, 'src') }), designed,
    'the approved design is the fallback while the build has no copy yet');
  await mkdir(path.dirname(built), { recursive: true });
  await writeFile(built, '<html>built</html>', 'utf8');
  assert.equal(boardPageFile({ here: path.join(root, 'src') }), built, 'the page in this build always wins');
  const store = new RosterStore(':memory:');
  try {
    const routes = boardRoutes(store, { pageFile: () => designed });
    assert.equal(routes.page().body.toString('utf8'), '<html>design</html>', 'the page is returned byte for byte');
  } finally { store.close(); }
});

test('a development tree reads the approved design while no asset is packaged', async () => {
  const base = path.join(here, '..', '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'board-devpage-'));
  const designed = path.join(root, 'docs', 'grill', 'Boss协议', '团队看板', '小看板.html');
  const built = path.join(root, 'assets', 'team-board', 'index.html');
  await mkdir(path.dirname(designed), { recursive: true });
  await writeFile(designed, '<html>design</html>', 'utf8');
  assert.equal(boardPageFile({ here: path.join(root, 'src') }), designed, 'the design is used until an asset exists');
  await mkdir(path.dirname(built), { recursive: true });
  await writeFile(built, '<html>built</html>', 'utf8');
  assert.equal(boardPageFile({ here: path.join(root, 'src') }), built, 'the packaged asset always wins');
  // An installed plugin is not a development checkout: it never reads its parent's docs.
  assert.equal(boardPageFile({ here: path.join(os.tmpdir(), 'board-installed-check', 'plugin', 'src') }), undefined);
});

async function listener(board) {
  return startHttpService({ port: 0, host: '127.0.0.1', board, log: () => {} });
}

test('the two board routes are read-only GETs on the loopback listener', async () => {
  const store = fixture();
  const data = boardData(store, { titles: new Map(), now: CLOCK.getTime() });
  const service = await listener({ page: () => ({ body: Buffer.from('<html>board</html>'), type: 'text/html; charset=utf-8' }),
    data: () => data });
  const base = service.url.replace(/\/mcp$/, '');
  try {
    const page = await fetch(`${base}${BOARD_PATH}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal(await page.text(), '<html>board</html>');
    const json = await fetch(`${base}${BOARD_DATA_PATH}`);
    assert.equal(json.status, 200);
    assert.equal(json.headers.get('access-control-allow-origin'), null, 'the board answers no cross-site request');
    assert.deepEqual(await json.json(), data);
    const post = await fetch(`${base}${BOARD_PATH}`, { method: 'POST' });
    assert.equal(post.status, 405);
    // The existing surface is untouched: health still answers, MCP still refuses GET.
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
  } finally { await service.close(); store.close(); }
});

test('with the switch off there is no board route at all', async () => {
  const service = await listener(undefined);
  const base = service.url.replace(/\/mcp$/, '');
  try {
    for (const route of [BOARD_PATH, BOARD_DATA_PATH]) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 404, `${route} must not exist`);
    }
    assert.equal((await fetch(`${base}/healthz`)).status, 200, 'the listener itself is unchanged');
  } finally { await service.close(); }
});

test('a board route that cannot read its data answers 503 instead of a guess', async () => {
  const service = await listener({ page: () => undefined, data: () => { throw new Error('projection failed'); } });
  const base = service.url.replace(/\/mcp$/, '');
  try {
    const data = await fetch(`${base}${BOARD_DATA_PATH}`);
    assert.equal(data.status, 503);
    assert.equal((await data.json()).error.code, 'board-unavailable');
    const page = await fetch(`${base}${BOARD_PATH}`);
    assert.equal(page.status, 404, 'a missing page is reported, not faked');
    assert.equal((await page.json()).error.code, 'board-page-missing');
  } finally { await service.close(); }
});

// The board carries a private roster: it must not answer a name that could be rebound by
// local DNS, and it may not be widened off loopback at all. The MCP surface and the
// health document keep answering exactly as before.
test('the board answers only loopback addresses and only under the loopback Host', async () => {
  await assert.rejects(startHttpService({ port: 0, host: '0.0.0.0', board: { page: () => undefined, data: () => ({}) } }),
    error => error.code === 'board-loopback-only', 'a wider bind is refused before anything is bound');
  const service = await startHttpService({ port: 0, host: '127.0.0.1', log: () => {},
    board: { page: () => ({ body: Buffer.from('<html>ok</html>'), type: 'text/html; charset=utf-8' }), data: () => ({ ok: true }) } });
  const { port } = service;
  const get = (route, hostHeader) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'GET',
      headers: hostHeader === undefined ? {} : { host: hostHeader } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.equal((await get(BOARD_DATA_PATH)).status, 200, 'the loopback name it was reached by is accepted');
    assert.equal((await get(BOARD_DATA_PATH, `localhost:${port}`)).status, 200, 'localhost is the same loopback name');
    const rebound = await get(BOARD_DATA_PATH, 'evil.example:80');
    assert.equal(rebound.status, 403, 'a rebound name gets no roster');
    assert.equal(JSON.parse(rebound.body).error.code, 'board-host-rejected');
    assert.equal((await get(BOARD_PATH, 'evil.example:80')).status, 403, 'the page is guarded the same way');
    assert.equal((await get('/healthz', 'evil.example:80')).status, 200, 'health carries no roster and keeps its answer');
  } finally { await service.close(); }
});

// The packaged asset is what a deployment serves: the page route must return exactly
// those bytes, and both routes must stay uncacheable and same-origin only.
test('the packaged page is served byte for byte, uncached and same-origin', async () => {
  const asset = path.join(here, '..', 'assets', 'team-board', 'index.html');
  const bytes = readFileSync(asset);
  const digest = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  assert.equal(bytes.length, 51783, 'the designer page the front end delivered');
  assert.equal(`${digest.slice(0, 6)}…${digest.slice(-4)}`, '9D3650…ADA4');
  const store = fixture();
  const service = await startHttpService({ port: 0, host: '127.0.0.1', log: () => {}, board: boardRoutes(store) });
  const base = service.url.replace(/\/mcp$/, '');
  try {
    const page = await fetch(`${base}${BOARD_PATH}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html; charset=utf-8/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Buffer.from(await page.arrayBuffer()).equals(bytes), true, 'the page is returned untouched');
    // Same origin as the page that fetched it; no cross-site permission is handed out.
    const data = await fetch(`${base}${BOARD_DATA_PATH}`);
    assert.equal(data.status, 200);
    assert.equal(data.headers.get('cache-control'), 'no-store');
    assert.equal(data.headers.get('access-control-allow-origin'), null);
    const body = await data.json();
    assert.equal(body.machine, undefined);
    assert.ok(Array.isArray(body.chats) && typeof body.exportedAt === 'string');
  } finally { await service.close(); store.close(); }
});

// Every board answer is uncacheable, including the ones that carry no data at all.
test('a board refusal is uncacheable too, and the switch off leaves no route', async () => {
  const guarded = await startHttpService({ port: 0, host: '127.0.0.1', log: () => {},
    board: { page: () => undefined, data: () => { throw new Error('projection failed'); } } });
  const guardedBase = guarded.url.replace(/\/mcp$/, '');
  try {
    const missing = await fetch(`${guardedBase}${BOARD_PATH}`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    const failed = await fetch(`${guardedBase}${BOARD_DATA_PATH}`);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get('cache-control'), 'no-store');
    const post = await fetch(`${guardedBase}${BOARD_DATA_PATH}`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('cache-control'), 'no-store');
  } finally { await guarded.close(); }
  const off = await startHttpService({ port: 0, host: '127.0.0.1', log: () => {} });
  const offBase = off.url.replace(/\/mcp$/, '');
  try {
    for (const route of [BOARD_PATH, BOARD_DATA_PATH]) {
      const response = await fetch(`${offBase}${route}`);
      assert.equal(response.status, 404, `${route} does not exist while the board is off`);
    }
  } finally { await off.close(); }
});

test('teamBoard is a configuration switch that is off unless it is asked for', async () => {
  const base = path.join(here, '..', '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'board-config-'));
  const write = async (name, value) => {
    const file = path.join(root, `${name}.json`);
    await writeFile(file, JSON.stringify(value), 'utf8');
    return file;
  };
  assert.equal((await loadConfig(await write('off', { workspace: root }))).teamBoard, false, 'default off');
  assert.equal((await loadConfig(await write('on', { workspace: root, teamBoard: true }))).teamBoard, true);
  await assert.rejects(loadConfig(await write('bad', { workspace: root, teamBoard: 'yes' })), /teamBoard must be true or false/);
});
