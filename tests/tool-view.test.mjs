import test from 'node:test';
import assert from 'node:assert/strict';
import { compactAgent, compactChanges, compactCreate, compactInspect, compactList, compactStatus, compactWait } from '../src/tool-view.mjs';

const truncated = (value, length) => value.slice(0, length) + '…';

// A report long enough to be clipped, and made of distinct paragraphs so a marker
// from its head can only be found in the one copy that survives.
const REPORT = Array.from({ length: 6 }, (unused, index) =>
  `Paragraph ${index} streams its artifact through the shared workspace before it reports once.`).join(' ');

// One entry shaped like the service's publicResult plus list's own fields: a full
// result, a three-level tree, twelve files and a long report.
function heavyItem() {
  const files = Array.from({ length: 12 }, (unused, index) => ({ path: `src/module-${index}.mjs`,
    operation: index ? 'update' : 'create', agentPath: ['助手-1a2b'], ...(index > 8 ? { attribution: 'unconfirmed' } : {}) }));
  const node = (name, depth, path) => ({ name, parentName: depth ? path.at(-2) : null,
    agentPath: ['助手-1a2b', ...path], depth, status: 'running', activity: 'writing',
    changes: files.slice(0, 3), coverage: { complete: false, limitation: 'x' } });
  return {
    name: '助手-1a2b', lifetime: 'once', target: 'codex-desktop', state: 'running', activity: 'writing',
    task: { text: 'Rebuild the report pipeline so every tool answer stays inside the context budget of the calling model. '.repeat(3),
      state: 'running', startedAt: '2026-11-04T01:00:00.000Z',
      result: { state: 'completed', summary: REPORT, files, coverage: { workspace: {} } } },
    changes: { count: 12, unconfirmed: 9, files,
      coverage: { scope: 'Codex Desktop task tree', nodes: [], workspace: { complete: false, limitation: 'x' } },
      observedAt: '2026-11-04T02:00:00.000Z', stale: false },
    questions: [{ message: 'Which report should land first?' }],
    tree: { settled: false, running: true, nodes: [node('助手-1a2b', 0, []), node('helper', 1, ['helper']),
      node('sub-helper', 2, ['helper', 'sub-helper'])] },
    reports: { total: 2, pending: 0, latest: { summary: REPORT, final: true, delivery: 'delivered' } },
    delivery: 'delivered', updatedAt: '2026-11-04T02:00:00.000Z', monitor: 'running',
    supplements: { queued: 1, unknown: 0, blocked: 0, accepted: 2 },
  };
}

test('a compact entry keeps the decision facts and nothing else', () => {
  const item = heavyItem();
  assert.deepEqual(compactAgent(item), {
    name: '助手-1a2b', target: 'codex-desktop', state: 'running', lifetime: 'once', activity: 'writing',
    task: truncated(item.task.text, 80),
    questions: ['Which report should land first?'],
    report: { summary: truncated(REPORT, 200), final: true, delivery: 'delivered' },
    files: { count: 12, unconfirmed: 9 },
    team: [{ path: 'helper', state: 'running', activity: 'writing', files: 3 },
      { path: 'helper/sub-helper', state: 'running', activity: 'writing', files: 3 }],
    supplements: { queued: 1 },
  });
  const text = JSON.stringify(compactAgent(item));
  assert.doesNotMatch(text, /updatedAt|observedAt|"coverage"|"monitor"|"limitation"/,
    'timestamps, coverage and the monitor state stay out of the text');
  assert.equal(typeof compactAgent(item).task, 'string', 'the task is its text, not the full task result');
});

test('a compact entry is small and its report text appears once', () => {
  const item = heavyItem();
  const text = JSON.stringify(compactAgent(item));
  assert.ok(Buffer.byteLength(JSON.stringify(item), 'utf8') > 2000, 'the fixture is a genuinely large entry');
  assert.ok(Buffer.byteLength(text, 'utf8') < 800, `compact entry is ${Buffer.byteLength(text, 'utf8')} bytes`);
  const marker = REPORT.slice(0, 60);
  assert.equal(text.split(marker).length - 1, 1, 'the report text appears exactly once');
  assert.equal(text.includes(REPORT), false, 'the long body is clipped, not repeated');
});

test('an idle entry drops the fields that would be empty', () => {
  const item = { name: 'artist', lifetime: 'persistent', target: 'dsh', state: 'idle', activity: 'Waiting for a task',
    task: null, changes: { count: 0, files: [], coverage: {}, stale: false }, questions: [],
    tree: { settled: true, running: false, nodes: [{ name: 'artist', depth: 0 }] },
    reports: { total: 0, pending: 0 }, delivery: null, updatedAt: '2026-11-04T02:00:00.000Z', monitor: 'sleeping',
    supplements: { queued: 0, unknown: 0, blocked: 0, accepted: 3 } };
  assert.deepEqual(compactAgent(item), { name: 'artist', state: 'idle', lifetime: 'persistent' });
});

test('pending input states and errors survive compaction unchanged', () => {
  const error = { code: 'send-rejected', message: 'transport rejected' };
  const callbackError = { code: 'native-callback-unavailable', message: 'The desktop does not permit background reports.' };
  const compact = compactAgent({ name: 'artist', lifetime: 'once', target: 'dsh', state: 'reconnecting',
    changes: { count: 2, files: [{ path: 'a', operation: 'update' }] },
    supplements: { queued: 2, unknown: 1, blocked: 3, accepted: 4 }, error, callbackError });
  assert.deepEqual(compact.supplements, { queued: 2, unknown: 1, blocked: 3 });
  assert.deepEqual(compact.error, error);
  assert.deepEqual(compact.callbackError, callbackError);
  assert.deepEqual(compact.files, { count: 2 });
});

test('expired dispatch reasons remain visible in the default list', () => {
  const expired = { reason: 'dispatch-expired', kind: 'supplement', count: 1, createdAt: '2026-11-10T12:39:30.864Z' };
  const result = compactList({ items: [{ name: 'helper', lifetime: 'persistent', state: 'failed', expired,
    supplements: { blocked: 1, latest: { status: 'accepted' } } }] });
  assert.deepEqual(result.items[0].expired, expired);
});

test('an undelivered earlier report and a stopped monitor stay visible', () => {
  const stuck = compactAgent({ name: 'artist', lifetime: 'persistent', target: 'dsh', state: 'idle',
    reports: { total: 2, pending: 1, latest: { summary: 'latest', final: false, delivery: 'delivered' } }, monitor: 'stopped' });
  assert.deepEqual(stuck.report, { summary: 'latest', final: false, delivery: 'delivered', pending: 1 },
    'a delivered latest report must not hide an undelivered earlier one');
  assert.equal(stuck.monitor, 'stopped');
  const healthy = compactAgent({ name: 'artist', lifetime: 'persistent', target: 'dsh', state: 'idle',
    reports: { total: 1, pending: 0, latest: { summary: 'only', final: true, delivery: 'delivered' } }, monitor: 'sleeping' });
  assert.equal('pending' in healthy.report, false);
  assert.equal('monitor' in healthy, false, 'every other monitor state is unremarkable');
});

test('the unconfirmed count comes from the service total, not the twelve listed files', () => {
  const files = Array.from({ length: 12 }, (unused, index) => ({ path: `f${index}.mjs`, operation: 'update',
    ...(index < 3 ? { attribution: 'unconfirmed' } : {}) }));
  const compact = compactAgent({ name: 'artist', lifetime: 'once', target: 'dsh', state: 'idle',
    changes: { count: 20, unconfirmed: 9, files } });
  assert.deepEqual(compact.files, { count: 20, unconfirmed: 9 },
    'the listed files show only 3 unconfirmed paths of 20 changes');
});

test('a creation receipt keeps the outcome and the error, not the coverage text', () => {
  assert.deepEqual(compactCreate({ name: 'artist', lifetime: 'once', target: 'dsh', state: 'idle', created: true,
    modelRequestsStarted: 0, changes: { count: 12, coverage: { limitation: 'x' } }, tree: { nodes: [] }, updatedAt: 'now' }),
  { name: 'artist', lifetime: 'once', state: 'idle', created: true, modelRequestsStarted: 0 });
  const error = { code: 'managed-host-required', message: 'Install the current managed DSH bridge.' };
  assert.deepEqual(compactCreate({ name: 'partner', lifetime: 'once', target: 'codex-desktop', state: 'reconnecting',
    created: false, error }),
  { name: 'partner', target: 'codex-desktop', lifetime: 'once', state: 'reconnecting', created: false, error });
});

test('a changes answer keeps one line per path and one coverage sentence', () => {
  const changes = [{ path: 'D:\\project\\a.mjs', operation: 'update', agentPath: ['artist'],
    source: 'workspace-diff', attribution: 'unconfirmed', before: 'x'.repeat(900), after: 'y'.repeat(900) },
  { path: 'D:\\project\\b.mjs', operation: 'create', agentPath: ['artist', 'helper'] }];
  const compact = compactChanges({ name: 'artist', task: 0, changes, stale: true,
    tree: { settled: true, running: false, nodes: [{ name: 'artist' }, { name: 'helper' }] },
    coverage: { scope: 'DSH task tree', nodes: [{ agentPath: ['artist'], coverage: 'root' }],
      workspace: { source: 'git-status-diff', complete: false, limitation: 'long text' } } });
  assert.deepEqual(compact.changes, [
    { path: 'D:\\project\\a.mjs', operation: 'update', attribution: 'unconfirmed' },
    { path: 'D:\\project\\b.mjs', operation: 'create', agentPath: ['artist', 'helper'] }],
  'a file body never rides along, and a team path only appears below the root');
  assert.equal(compact.name, 'artist');
  assert.equal(compact.task, 0);
  assert.equal(compact.stale, true);
  assert.equal('tree' in compact, false);
  assert.match(compact.note, /unconfirmed/, 'an unconfirmed path is called out');
  assert.equal(typeof compact.note, 'string', 'coverage becomes one sentence');
  assert.ok(Buffer.byteLength(JSON.stringify(compact), 'utf8') < 600,
    'a changes answer with whole file bodies stays a summary');

  const unavailable = compactChanges({ name: 'artist', task: 0, changes: [],
    coverage: { workspace: { source: 'git-status-diff', complete: false, reason: 'not-a-repository' } } });
  assert.match(unavailable.note, /not-a-repository/, 'an unavailable comparison names its reason');

  const compared = compactChanges({ name: 'artist', task: 0,
    changes: [{ path: 'a.mjs', operation: 'update', agentPath: ['artist'] }], coverage: { workspace: { complete: false } } });
  assert.match(compared.note, /comparing the workspace/, 'otherwise the shell-write caveat is stated once');
});

test('a changes answer keeps the historical task text and says when paths were clipped', () => {
  const message = 'Migrate the report generator, then regenerate the fixtures for the whole project. '.repeat(6);
  const clipped = compactChanges({ name: 'artist', task: 2, message,
    changes: [{ path: 'a.mjs', operation: 'update', agentPath: ['artist'] }],
    coverage: { workspace: { source: 'git-status-diff', complete: false, truncated: true } } });
  assert.equal(clipped.message, truncated(message, 240), 'the answer still says which task it is');
  assert.equal(clipped.task, 2);
  assert.match(clipped.note, /Only the first 200 changed paths are listed/, 'a clipped comparison is stated, not silent');
  const whole = compactChanges({ name: 'artist', task: 0,
    changes: [{ path: 'a.mjs', operation: 'update', agentPath: ['artist'] }],
    coverage: { workspace: { source: 'git-status-diff', complete: false } } });
  assert.doesNotMatch(whole.note, /first 200/);
  assert.equal('message' in whole, false, 'the current task needs no separate text');
});

test('an inspection shows each message list once and clips only long text', () => {
  const rootMessage = 'root reply';
  const long = 'w'.repeat(5000);
  const result = {
    name: 'artist', lifetime: 'once', target: 'dsh', state: 'running', activity: 'writing',
    task: { text: 'draw', state: 'running', startedAt: '2026-11-04T01:00:00.000Z',
      result: { state: 'running', summary: 'duplicate body', files: [], coverage: { workspace: {} } } },
    changes: { count: 1, files: [{ path: 'a.mjs', operation: 'update', agentPath: ['artist'], attribution: 'unconfirmed' }],
      coverage: { workspace: { complete: false, reason: 'not-a-repository' } }, observedAt: null, stale: false },
    questions: [{ message: 'which file?' }], messages: [{ seq: 1, role: 'assistant', text: rootMessage }], hasMore: false,
    reports: { total: 1, pending: 0, latest: { summary: 'duplicate body', final: true, delivery: 'delivered' },
      items: [{ message: 'duplicate body', final: true, delivery: 'delivered' }] },
    tree: { settled: false, running: true, nodes: [
      { name: 'artist', parentName: null, agentPath: ['artist'], depth: 0, status: 'running', activity: 'writing', changes: [],
        coverage: 'root writes', messages: [{ seq: 1, role: 'assistant', text: rootMessage }], hasMore: false },
      { name: 'helper', parentName: 'artist', agentPath: ['artist', 'helper'], depth: 1, status: 'running', activity: 'writing',
        changes: [], coverage: 'child writes', messages: [{ seq: 2, role: 'assistant', text: long }], hasMore: true },
    ] },
    inspectionIncomplete: false, historyCount: 1,
    history: [{ task: 1, message: 'draw', state: 'running', startedAt: '2026-11-04T01:00:00.000Z' }],
    updatedAt: '2026-11-04T02:00:00.000Z',
  };
  const compact = compactInspect(result);
  const text = JSON.stringify(compact);
  assert.equal('messages' in compact, false, 'the top-level copy of the root page is gone');
  assert.equal(text.split(rootMessage).length - 1, 1, 'the root page stays exactly once');
  assert.equal(text.split('duplicate body').length - 1, 1, 'the report body stays exactly once');
  assert.equal(compact.tree.nodes.length, 2);
  assert.equal('coverage' in compact.tree.nodes[0], false, 'per-node coverage is dropped');
  assert.equal('changes' in compact.tree.nodes[1], false, 'a node does not repeat the top-level file list');
  assert.deepEqual(compact.changes.files, [{ path: 'a.mjs', operation: 'update', attribution: 'unconfirmed' }],
    'the top-level file list is summarised the same way as a changes answer');
  assert.deepEqual(compact.tree.nodes[1].messages, [{ seq: 2, role: 'assistant', text: truncated(long, 4000), truncated: true }]);
  assert.equal(compact.tree.nodes[1].hasMore, true);
  assert.deepEqual(compact.reports, { total: 1, pending: 0, items: [{ message: 'duplicate body', final: true, delivery: 'delivered' }] });
  assert.deepEqual(compact.task, { text: 'draw', state: 'running', startedAt: '2026-11-04T01:00:00.000Z', result: { state: 'running' } });
  assert.equal(compact.changes.count, 1);
  assert.match(compact.changes.note, /unconfirmed/);
  assert.deepEqual(compact.questions, ['which file?']);
  assert.equal(compact.historyCount, 1);
  assert.equal(compact.history.length, 1);
  assert.equal('updatedAt' in compact, false);
});

test('status keeps every readiness field and drops only the method lists', () => {
  const status = { ready: true, contextVerified: true, workspace: 'D:\\project',
    backends: { dsh: { ready: true, connected: true },
      'codex-desktop': { ready: true, present: true, methods: ['probe', 'create'], treeProtocol: 1, reportProtocol: 1 } } };
  assert.deepEqual(compactStatus(status), { ...status,
    backends: { dsh: { ready: true, connected: true },
      'codex-desktop': { ready: true, present: true, treeProtocol: 1, reportProtocol: 1 } } });
  assert.deepEqual(compactStatus({ ready: false, contextError: { code: 'calling-context' } }),
    { ready: false, contextError: { code: 'calling-context' } }, 'a status without backends is unchanged');
  assert.deepEqual(status.backends['codex-desktop'].methods, ['probe', 'create'], 'the input is not mutated');
});

test('list and wait wrap the same compact entry and keep their own receipt fields', () => {
  const item = { name: 'artist', lifetime: 'once', target: 'dsh', state: 'idle', task: null, activity: 'Waiting for a task',
    changes: { count: 0, files: [], coverage: {}, stale: false }, questions: [],
    tree: { settled: true, running: false, nodes: [{ name: 'artist' }] }, reports: { total: 0, pending: 0 } };
  assert.deepEqual(compactList({ items: [item], total: 1 }), { items: [compactAgent(item)], total: 1 });
  assert.deepEqual(compactWait({ items: [item], notListed: ['gone'], note: 'Absence alone does not prove completion.', timedOut: true }),
    { items: [compactAgent(item)], notListed: ['gone'], note: 'Absence alone does not prove completion.', timedOut: true });
  assert.deepEqual(compactWait({ items: [], notListed: [] }), { items: [], notListed: [], timedOut: false });
});

const member = (name, depth, path, overrides = {}) => ({ name, parentName: depth ? path.at(-2) : null,
  agentPath: ['boss', ...path], depth, status: 'idle', activity: 'waiting', changes: [], ...overrides });

test('a team roster caps its rows and keeps every line short', () => {
  const long = 'x'.repeat(300);
  const nodes = [member('boss', 0, []),
    member(long, 1, [long], { status: 'running', activity: 'writing', changes: [{ path: 'a' }, { path: 'b' }] }),
    ...Array.from({ length: 35 }, (unused, index) => member(`member-${index}`, 1, [`member-${index}`]))];
  const compact = compactAgent({ name: 'boss', lifetime: 'persistent', target: 'dsh', state: 'idle',
    tree: { settled: false, running: true, nodes } });
  assert.equal('tree' in compact, false, 'the roster replaces the node count');
  assert.equal(compact.team.length, 31, '30 rows plus the summary line');
  assert.deepEqual(compact.team[1], { path: 'member-0', state: 'idle' });
  assert.deepEqual(compact.team.at(-1), { more: 6 }, 'the rows that did not fit are counted, not dropped silently');
  for (const row of compact.team) assert.ok(Buffer.byteLength(JSON.stringify(row), 'utf8') <= 120, JSON.stringify(row));
  assert.equal(compact.team[0].path.endsWith('…'), true, 'a long team path is shortened, never wrapped');
  assert.equal(compact.team[0].files, 2);
});

test('a roster line says nothing it cannot know', () => {
  const nodes = [member('boss', 0, []), member('frontend', 1, ['frontend']),
    member('backend', 2, ['frontend', 'backend'], { status: 'running', activity: 'writing', changes: [{ path: 'x' }] })];
  const compact = compactAgent({ name: 'boss', lifetime: 'persistent', target: 'dsh', state: 'idle',
    tree: { settled: false, running: true, nodes } });
  assert.deepEqual(compact.team, [{ path: 'frontend', state: 'idle' },
    { path: 'frontend/backend', state: 'running', activity: 'writing', files: 1 }],
  'activity only while running, files only when there are some');
});

test('inspect reads one node by name or team path and says what it could not find', () => {
  const result = {
    name: 'boss', lifetime: 'persistent', target: 'dsh', state: 'running', activity: 'writing',
    changes: { count: 0, files: [], coverage: {} }, questions: [],
    tree: { settled: false, running: true, nodes: [
      member('boss', 0, [], { status: 'running', activity: 'writing', messages: [{ seq: 1, role: 'assistant', text: 'root said' }] }),
      member('frontend', 1, ['frontend'], { messages: [{ seq: 2, role: 'assistant', text: 'frontend said' }], hasMore: true }),
      member('backend', 2, ['frontend', 'backend'], { messages: [{ seq: 3, role: 'assistant', text: 'backend said' }] }),
    ] },
    history: [], historyCount: 0,
  };
  const byName = compactInspect(result, { node: 'backend' });
  assert.equal(byName.node, 'frontend/backend');
  assert.deepEqual(byName.tree.nodes.map(entry => entry.name), ['boss', 'frontend', 'backend'],
    'the tree keeps its shape; only the chosen node carries a conversation');
  assert.deepEqual(byName.tree.nodes[0], { name: 'boss', status: 'running' }, 'every other node shrinks to name and status');
  assert.deepEqual(byName.tree.nodes[2].messages, [{ seq: 3, role: 'assistant', text: 'backend said' }]);
  assert.equal('messages' in byName.tree.nodes[1], false);
  const byPath = compactInspect(result, { node: 'frontend' });
  assert.deepEqual(byPath.tree.nodes.at(-1), { name: 'backend', status: 'idle' });
  assert.equal(byPath.tree.nodes[1].hasMore, true);
  assert.throws(() => compactInspect(result, { node: 'nobody' }),
    error => error.code === 'node-not-found' && /frontend\/backend/.test(error.message),
    'a wrong name comes back with the nodes that exist');
  const detail = compactInspect.detail(result, { node: 'backend' });
  assert.deepEqual(detail.messages, [{ seq: 3, role: 'assistant', text: 'backend said' }], 'detail filters by node too');
  assert.deepEqual(detail.tree.nodes[0], { name: 'boss', status: 'running' });
  assert.equal(compactInspect.detail(result), result, 'without node, detail changes nothing');
});

test('an unobservable tree is reported, never shown as an empty team', () => {
  const compact = compactAgent({ name: 'boss', lifetime: 'persistent', target: 'dsh', state: 'running',
    activity: 'writing', changes: { count: 0, files: [] }, questions: [], reports: { total: 0, pending: 0 },
    tree: { settled: false, running: true, nodes: [], observationError: { code: 'managed-tree-unavailable', message: 'The DSH bridge cannot list descendants.' } } });
  assert.deepEqual(compact.treeError, { code: 'managed-tree-unavailable', message: 'The DSH bridge cannot list descendants.' });
  assert.equal('team' in compact, false);
  assert.equal(compact.state, 'running', 'the state alone still reads as running');
  const healthy = compactAgent({ name: 'boss', lifetime: 'persistent', target: 'dsh', state: 'running',
    tree: { settled: false, running: true, nodes: [{ name: 'boss', depth: 0 }] } });
  assert.equal('treeError' in healthy, false);
});

test('members that share a name stay addressable, and a guessed name is refused', () => {
  const twins = { name: 'boss', lifetime: 'persistent', target: 'dsh', state: 'idle',
    changes: { count: 0, files: [], coverage: {} }, questions: [], history: [], historyCount: 0,
    tree: { settled: false, running: true, nodes: [member('boss', 0, []),
      member('subagent', 1, ['subagent'], { messages: [{ seq: 2, role: 'assistant', text: 'first' }] }),
      member('subagent', 1, ['subagent'], { messages: [{ seq: 3, role: 'assistant', text: 'second' }] })] } };
  assert.deepEqual(compactAgent(twins).team.map(row => row.path), ['subagent', 'subagent#2'],
    'a repeated label is numbered by tree order so each row can be inspected');
  assert.deepEqual(compactInspect(twins, { node: 'subagent#2' }).tree.nodes[2].messages, [{ seq: 3, role: 'assistant', text: 'second' }]);
  assert.equal(compactInspect(twins, { node: 'subagent#…' }).node, 'subagent#2', 'a shortened roster path is matched by its prefix');

  // Two members with the same name under different leads can only be told apart by path.
  const nested = { ...twins, tree: { settled: false, running: true, nodes: [member('boss', 0, []),
    member('lead-a', 1, ['lead-a']), member('subagent', 2, ['lead-a', 'subagent']),
    member('lead-b', 1, ['lead-b']), member('subagent', 2, ['lead-b', 'subagent'])] } };
  assert.throws(() => compactInspect(nested, { node: 'subagent' }),
    error => error.code === 'node-ambiguous' && /lead-a\/subagent/.test(error.message) && /lead-b\/subagent/.test(error.message),
    'a name that fits two members is refused with the paths that work');
  assert.equal(compactInspect(nested, { node: 'lead-b/subagent' }).node, 'lead-b/subagent');
});

test('detail and node take their pagination and note from the node that was read', () => {
  const nodes = [member('boss', 0, [], { messages: [{ seq: 1, role: 'assistant', text: 'root page' }], hasMore: true, note: 'root page note' }),
    member('helper', 1, ['helper'], { messages: [{ seq: 2, role: 'assistant', text: 'child page' }], hasMore: false, note: 'child page note' })];
  const result = { name: 'boss', lifetime: 'persistent', target: 'dsh', state: 'idle',
    changes: { count: 0, files: [], coverage: {} }, questions: [], hasMore: true, note: 'top-level root note',
    tree: { settled: false, running: true, nodes }, history: [], historyCount: 0 };
  const compact = compactInspect(result, { node: 'helper' });
  assert.equal('hasMore' in compact, false, "the child's own hasMore is false, so the root's true is not inherited");
  assert.equal(compact.note, 'child page note');
  const detail = compactInspect.detail(result, { node: 'helper' });
  assert.equal(detail.hasMore, false, 'detail replaces the root page pagination with the node’s');
  assert.equal(detail.note, 'child page note');
  assert.deepEqual(detail.messages, [{ seq: 2, role: 'assistant', text: 'child page' }]);
  const root = compactInspect.detail(result, { node: 'boss' });
  assert.equal(root.hasMore, true);
  assert.equal(root.note, 'root page note');
});

test('an inspect answer says how many paths it left to the changes tool', () => {
  const files = Array.from({ length: 12 }, (unused, index) => ({ path: `f${index}.mjs`, operation: 'update' }));
  const result = { name: 'boss', lifetime: 'persistent', target: 'dsh', state: 'idle',
    changes: { count: 40, unconfirmed: 0, files, coverage: { workspace: { truncated: true } } },
    questions: [], tree: { settled: true, running: false, nodes: [member('boss', 0, [])] }, history: [], historyCount: 0 };
  assert.match(compactInspect(result).changes.note, /Showing 12 of 40 paths; changes lists them\./);
  assert.doesNotMatch(compactInspect(result).changes.note, /first 200 changed paths/,
    'the workspace cap sentence belongs to the changes tool, which lists them');
});
