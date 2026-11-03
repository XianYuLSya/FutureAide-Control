import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  INTERRUPT_MARKER, DEEP_LINK_PROMPT_LIMIT, markerLine, assertBindingNonce, assertRequestId,
  assertMessage, scanNativeSessions, listNativeSessions, resolveNativeSession, findTranscript,
  readTranscriptEvents, countMarker, interruptedSince, viewMatchesSession, deepLinks,
  createNullDriver, createFirstTurn, interrupt, destroy, resume, readDefaultModel, selectModel,
  probeClaudeHost, parseModelControl, modelInfo, resolveModelEvidence, confirmModelAfterTurn, sessionArtifacts,
  displayTitle, pageShowsSession,
} from '../src/claude-host.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION = '6808231c-116c-4fc7-b9b0-4d790e763b0b';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
// createFirstTurn refuses a workspace that is not a real directory, so the
// fixture keeps one on disk instead of faking the path.
const CWD = path.join(workspace, '.runtime', 'tests', 'claude-host-workspace');
await mkdir(CWD, { recursive: true });

async function scratch() {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'claude-host-'));
}

function record({ pid = 50124, sessionId = SESSION, cwd = CWD, name = 'Fixture session',
  hostSessionId = 'local_4a23e095-8206-44dc-af92-46c5f48c2d25', status = 'idle' } = {}) {
  return {
    pid, sessionId, cwd, name, status, hostSessionId,
    startedAt: 1793723500717, version: '2.1.309', kind: 'interactive',
    entrypoint: 'claude-desktop', procStart: '134381970992798945',
    pidDomain: 'win32:test-host', messagingSocketPath: '\\\\.\\pipe\\LOCAL\\cc-msg-fixture',
  };
}

/** A host fixture: config root with session records, transcripts, and a fake liveness set. */
async function host({ sessions = [], alive = new Set([50124]), transcriptLines = {} } = {}) {
  const root = allow => path.join(allow, 'claude');
  const dir = await scratch();
  const configRoot = root(dir);
  await mkdir(path.join(configRoot, 'sessions'), { recursive: true });
  await mkdir(path.join(configRoot, 'projects'), { recursive: true });
  const alivePids = new Set(alive);
  const write = async (value, lines = []) => {
    await writeFile(path.join(configRoot, 'sessions', `${value.pid}.json`), JSON.stringify(value, null, 0));
    const project = path.join(configRoot, 'projects', String(value.cwd).replace(/[^A-Za-z0-9]/g, '-'));
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, `${value.sessionId}.jsonl`),
      lines.map(line => JSON.stringify(line)).join('\n') + (lines.length ? '\n' : ''));
  };
  for (const value of sessions) await write(value, transcriptLines[value.sessionId] ?? []);
  return {
    dir,
    configRoot,
    env: { CLAUDE_CONFIG_DIR: configRoot },
    isAlive: pid => alivePids.has(pid),
    alivePids,
    write,
    async append(sessionId, lines) {
      const file = await findTranscript({ env: { CLAUDE_CONFIG_DIR: configRoot }, nativeSessionId: sessionId, workspace: CWD });
      const current = await readFile(file, 'utf8').catch(() => '');
      const text = current + lines.map(line => JSON.stringify(line)).join('\n') + '\n';
      await writeFile(file, text);
      return file;
    },
  };
}

let stamp = 0;
const userLine = text => ({ type: 'user', uuid: `u-${++stamp}`, timestamp: new Date(Date.now() + stamp * 1000).toISOString(),
  message: { role: 'user', content: text } });
const assistantLine = (model, effort) => ({ type: 'assistant', uuid: `a-${++stamp}`,
  timestamp: new Date(Date.now() + stamp * 1000).toISOString(), effort,
  message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] } });

/** A stand-in for the UI bridge. It records what it was asked to do. */
function uiDriver(behaviour = {}) {
  const calls = [];
  const driver = {
    kind: 'fake-uia',
    available: true,
    calls,
    async probe() { calls.push('probe'); return { available: true, documentName: behaviour.documentName ?? 'Fixture session - Claude Code' }; },
    async currentView() { calls.push('view'); return { available: true, documentName: behaviour.documentName ?? 'Fixture session - Claude Code', composerFound: true, texts: behaviour.texts ?? [] }; },
    async openNewSession(input) { calls.push(['openNewSession', input]); return behaviour.openNewSession?.() ?? { strategy: 'deep-link-code-new-protocol', prefilled: true }; },
    async submit(input) { calls.push(['submit', input]); return behaviour.submit?.() ?? { method: 'enter-on-prefilled-composer' }; },
    async interrupt() { calls.push('interrupt'); return behaviour.interrupt?.() ?? { method: 'escape' }; },
    async revealSession(input) { calls.push(['revealSession', input]); behaviour.revealSession?.(input); return { revealed: true, method: 'deep-link-continue-protocol' }; },
    async sessionMenu(input) { calls.push(['sessionMenu', input]); return behaviour.sessionMenu?.(input) ?? { opened: true, items: [{ type: 'MenuItem', name: '删除会话' }] }; },
    async deleteSession(input) { calls.push(['deleteSession', input]); return behaviour.deleteSession?.(input) ?? { clicked: '删除会话', confirmed: '删除' }; },
    async readModel() { calls.push('readModel'); return behaviour.readModel?.() ?? { raw: '模型：Opus 5.5 最高 3.5× 或更多用量' }; },
    async selectModel(input) { calls.push(['selectModel', input]); return behaviour.selectModel?.(input) ?? { clicked: input.label, observed: input.label }; },
  };
  return driver;
}

// --------------------------------------------------------------- arguments

test('the request marker is stable and both identifiers are validated', () => {
  assert.equal(markerLine('request-abc', 'fa-life-20261103-1630'),
    '[FutureAide Control request request-abc · binding fa-life-20261103-1630]');
  assert.equal(assertRequestId('request-abc'), 'request-abc');
  assert.equal(assertBindingNonce('fa-life-20261103-1630'), 'fa-life-20261103-1630');
  assert.throws(() => assertRequestId('bad id'), { code: 'invalid-request-id' });
  assert.throws(() => assertBindingNonce('short'), { code: 'invalid-binding-nonce' });
  assert.throws(() => assertBindingNonce('has space in it'), { code: 'invalid-binding-nonce' });
  assert.throws(() => assertMessage('   '), { code: 'message-empty' });
});

test('deep links match the routes the shipped bundle accepts', () => {
  const url = deepLinks.newSessionDeepLink({ workspace: CWD, prompt: 'hello' });
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'claude:');
  assert.equal(parsed.hostname, 'code');
  assert.equal(parsed.pathname, '/new');
  assert.equal(parsed.searchParams.get('q'), 'hello');
  assert.equal(parsed.searchParams.get('folder'), CWD);
  assert.equal(parsed.searchParams.get('src'), 'external');
  assert.throws(() => deepLinks.newSessionDeepLink({ workspace: CWD, prompt: 'x'.repeat(DEEP_LINK_PROMPT_LIMIT + 1) }),
    { code: 'prompt-exceeds-deep-link' });
  assert.equal(deepLinks.continueSessionDeepLink({ hostSessionId: 'local_4a23e095-8206-44dc-af92-46c5f48c2d25' }),
    'claude://code/continue?session=local_4a23e095-8206-44dc-af92-46c5f48c2d25');
  assert.throws(() => deepLinks.continueSessionDeepLink({ hostSessionId: 'not-a-host-session' }),
    { code: 'invalid-host-session-id' });
  assert.throws(() => deepLinks.continueSessionDeepLink({ hostSessionId: 'local_' + 'x'.repeat(70) }),
    { code: 'invalid-host-session-id' });
});

// ----------------------------------------------------------- native records

test('only live desktop session records are sessions; token files are never read', async () => {
  const host1 = await host({ sessions: [record(), record({ pid: 90001, sessionId: OTHER })], alive: new Set([50124]) });
  try {
    await writeFile(path.join(host1.configRoot, 'sessions', '50124.abc.key'), '{"peerToken":"nope"}');
    const all = await scanNativeSessions({ env: host1.env, isAlive: host1.isAlive });
    assert.equal(all.sessions.length, 2, 'a stale record is still scanned for destroy/resume');
    assert.deepEqual(all.sessions.map(s => [s.nativeSessionId, s.alive]).sort(),
      [[SESSION, true], [OTHER, false]].sort());
    const live = await listNativeSessions({ env: host1.env, isAlive: host1.isAlive });
    assert.deepEqual(live.map(s => s.nativeSessionId), [SESSION]);
    assert.equal(live[0].hostSessionId.startsWith('local_'), true);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('transcript lookups resolve by session id and report markers', async () => {
  const host1 = await host({ sessions: [record()] });
  try {
    const file = await findTranscript({ env: host1.env, nativeSessionId: SESSION, workspace: CWD });
    assert.ok(file.endsWith(`${SESSION}.jsonl`));
    await host1.append(SESSION, [userLine('hello'), userLine(INTERRUPT_MARKER)]);
    const { events } = await readTranscriptEvents(file);
    assert.equal(countMarker(events, markerLine('r1', 'fa-1')), 0);
    assert.equal(interruptedSince(events, new Date(Date.now() - 60000).toISOString()), true);
    assert.equal(interruptedSince(events, new Date(Date.now() + 60000).toISOString()), false);
    assert.equal(await findTranscript({ env: host1.env, nativeSessionId: OTHER }), undefined);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- creating

test('a session counts as created only when a new record registers and the marker lands once', async () => {
  const host1 = await host({ sessions: [] });
  const driver = uiDriver({
    openNewSession: async () => {
      await host1.write(record(), [userLine('do the thing'), userLine(markerLine('request-abc', 'fa-life-20261103-1630'))]);
      return { strategy: 'deep-link-code-new', prefilled: true };
    },
  });
  try {
    const result = await createFirstTurn({ workspace: CWD, requestId: 'request-abc', message: 'do the thing',
      bindingNonce: 'fa-life-20261103-1630' }, { env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 2000, pollMs: 20 });
    assert.equal(result.created, true);
    assert.equal(result.nativeSessionId, SESSION);
    assert.equal(result.pid, 50124);
    assert.equal(result.workspace, CWD);
    assert.deepEqual(result.verifiedBy, ['native-record-created', 'transcript-marker-once']);
    assert.equal(result.marker, '[FutureAide Control request request-abc · binding fa-life-20261103-1630]');
    assert.equal(result.model, undefined);
    assert.equal(driver.calls.filter(call => Array.isArray(call) && call[0] === 'submit').length, 1,
      'the first turn is sent, not merely prefilled');
    assert.match(driver.calls.find(call => Array.isArray(call) && call[0] === 'openNewSession')[1].prompt,
      /\[FutureAide Control request request-abc · binding fa-life-20261103-1630\]$/);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a new record with the wrong or duplicated marker is never reported as created', async () => {
  for (const [label, lines, reason] of [
    ['missing marker', [userLine('something else')], 'transcript-marker-count-0'],
    ['duplicated marker', [userLine(markerLine('request-abc', 'fa-life-20261103-1630')),
      userLine(markerLine('request-abc', 'fa-life-20261103-1630'))], 'transcript-marker-count-2'],
  ]) {
    const host1 = await host({ sessions: [] });
    const driver = uiDriver({ openNewSession: async () => { await host1.write(record(), lines); return { strategy: 'deep-link-code-new', prefilled: true }; } });
    try {
      const result = await createFirstTurn({ workspace: CWD, requestId: 'request-abc', message: 'do the thing',
        bindingNonce: 'fa-life-20261103-1630' }, { env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 400, pollMs: 20 });
      assert.equal(result.created, false, label);
      assert.equal(result.status, 'unconfirmed', label);
      assert.equal(result.reason, reason, label);
      assert.equal(result.nativeSessionId, undefined, label);
    } finally { await rm(host1.dir, { recursive: true, force: true }); }
  }
});

test('a session created in another workspace or another time is not the new session', async () => {
  const host1 = await host({ sessions: [record({ cwd: 'D:\\Work\\elsewhere' })] });
  const driver = uiDriver();
  try {
    const result = await createFirstTurn({ workspace: CWD, requestId: 'request-abc', message: 'x',
      bindingNonce: 'fa-life-20261103-1630' }, { env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 300, pollMs: 20 });
    assert.equal(result.created, false);
    assert.equal(result.reason, 'no-native-session-registered');
    assert.equal(result.bindingNonce, 'fa-life-20261103-1630');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a repeated request reuses the delivered session instead of creating a second one', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: {
    [SESSION]: [userLine('do the thing'), userLine(markerLine('request-abc', 'fa-life-20261103-1630'))],
  } });
  try {
    const result = await createFirstTurn({ workspace: CWD, requestId: 'request-abc', message: 'do the thing',
      bindingNonce: 'fa-life-20261103-1630' }, { env: host1.env, driver: createNullDriver(), isAlive: host1.isAlive });
    assert.equal(result.created, false);
    assert.equal(result.reused, true);
    assert.equal(result.status, 'already-delivered');
    assert.equal(result.nativeSessionId, SESSION);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('creating without a UI bridge fails explicitly and creates nothing', async () => {
  const host1 = await host({ sessions: [] });
  try {
    await assert.rejects(createFirstTurn({ workspace: CWD, requestId: 'request-abc', message: 'x',
      bindingNonce: 'fa-life-20261103-1630' }, { env: host1.env, driver: createNullDriver(), isAlive: host1.isAlive }),
    { code: 'ui-driver-unavailable' });
    assert.equal((await listNativeSessions({ env: host1.env, isAlive: host1.isAlive })).length, 0);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a message that already carries a FutureAide marker is refused', async () => {
  const host1 = await host({ sessions: [] });
  try {
    await assert.rejects(createFirstTurn({ workspace: CWD, requestId: 'request-abc',
      message: `hi\n\n${markerLine('other', 'fa-life-20261103-1630')}`, bindingNonce: 'fa-life-20261103-1630' },
    { env: host1.env, driver: uiDriver(), isAlive: host1.isAlive }), { code: 'message-already-marked' });
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

// --------------------------------------------------------------- interrupt

test('interrupt is confirmed by the transcript marker, not by the click', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: { [SESSION]: [userLine('long task')] } });
  const driver = uiDriver({ interrupt: async () => { await host1.append(SESSION, [userLine(INTERRUPT_MARKER)]); return { method: 'escape' }; } });
  try {
    const result = await interrupt({ nativeSessionId: SESSION }, { env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 1000, pollMs: 20 });
    assert.equal(result.interrupted, true);
    assert.deepEqual(result.verifiedBy, ['transcript-interrupt-marker']);
    assert.equal(result.method, 'escape');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('an interrupt whose marker never appears is reported unconfirmed', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: { [SESSION]: [userLine('long task')] } });
  try {
    const result = await interrupt({ nativeSessionId: SESSION }, { env: host1.env, driver: uiDriver(),
      isAlive: host1.isAlive, timeoutMs: 200, pollMs: 20 });
    assert.equal(result.interrupted, false);
    assert.equal(result.status, 'unconfirmed');
    assert.equal(result.reason, 'interrupt-marker-not-written');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('interrupt refuses to fire when the window shows another session', async () => {
  const host1 = await host({ sessions: [record({ name: 'Partner review' })] });
  const driver = uiDriver({ documentName: 'Someone else - Claude Code' });
  try {
    await assert.rejects(interrupt({ nativeSessionId: SESSION }, { env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 200, pollMs: 20 }),
      { code: 'session-not-visible' });
    assert.equal(driver.calls.includes('interrupt'), false, 'no key press reached an unidentified session');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('view matching never guesses from a shared prefix alone', () => {
  const record1 = { name: 'FutureAide 插件生命周期测试' };
  assert.equal(viewMatchesSession({ available: true, documentName: 'FutureAide 插件生命周期测试 - Claude Code' }, record1), true);
  assert.equal(viewMatchesSession({ available: true, documentName: 'FutureAide 插件生命周期测试' }, record1), true);
  assert.equal(viewMatchesSession({ available: true, documentName: 'FutureAide Control Opus 评审 - Claude Code' }, record1), false);
  assert.equal(viewMatchesSession({ available: false, documentName: 'FutureAide 插件生命周期测试 - Claude Code' }, record1), false);
  assert.equal(viewMatchesSession({ available: true, documentName: 'x - Claude Code' }, {}), false);
});

﻿// ----------------------------------------------------------------- destroy

/** The host's native delete: its own menu removes this session's state. */
function nativeDelete(host1, { remove = ['record', 'transcript', 'sessionEnv', 'process'] } = {}) {
  return async () => {
    const removed = [];
    if (remove.includes('record')) {
      await rm(path.join(host1.configRoot, 'sessions', '50124.json'), { force: true });
      removed.push('record');
    }
    if (remove.includes('transcript')) {
      const file = await findTranscript({ env: host1.env, nativeSessionId: SESSION, workspace: CWD }).catch(() => undefined);
      if (file) { await rm(file, { force: true }); removed.push('transcript'); }
    }
    if (remove.includes('sessionEnv')) {
      await rm(path.join(host1.configRoot, 'session-env', SESSION), { recursive: true, force: true });
      removed.push('sessionEnv');
    }
    if (remove.includes('process')) host1.alivePids.delete(50124);
    return { clicked: '删除会话', confirmed: '删除', removed };
  };
}

test('destroy deletes through the host menu and verifies every artifact', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: { [SESSION]: [userLine('work')] } });
  await mkdir(path.join(host1.configRoot, 'session-env', SESSION), { recursive: true });
  try {
    const driver = uiDriver({ deleteSession: nativeDelete(host1) });
    const result = await destroy({ nativeSessionId: SESSION }, { env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 500, pollMs: 20 });
    assert.equal(result.destroyed, true);
    assert.equal(result.deleted, true);
    assert.equal(result.status, 'deleted');
    assert.deepEqual(result.verifiedBy,
      ['registry-record-gone', 'transcript-gone', 'host-process-exited', 'session-directories-gone']);
    assert.deepEqual(result.removed, { recordFile: true, transcriptFile: true, sessionEnvDirectory: true, fileHistoryDirectory: true, process: true });
    assert.equal(result.kept.projectFiles, true);
    assert.equal(result.hostAction.clicked, '删除会话');
    assert.equal(result.hostAction.confirmed, '删除');
    assert.equal(driver.calls.filter(call => Array.isArray(call) && call[0] === 'deleteSession').length, 1);
    assert.equal((await listNativeSessions({ env: host1.env, isAlive: host1.isAlive })).length, 0);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a host that only drops the registry entry is reported as partially deleted', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: { [SESSION]: [userLine('work')] } });
  try {
    const driver = uiDriver({ deleteSession: nativeDelete(host1, { remove: ['record'] }) });
    const result = await destroy({ nativeSessionId: SESSION }, { env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 200, pollMs: 20 });
    assert.equal(result.destroyed, false);
    assert.equal(result.deleted, false);
    assert.equal(result.status, 'partially-deleted');
    assert.equal(result.removed.recordFile, true);
    assert.equal(result.removed.transcriptFile, false);
    assert.equal(result.after.transcriptFile, 'file');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('destroy never falls back to killing a process', async () => {
  const host1 = await host({ sessions: [record()] });
  try {
    await assert.rejects(destroy({ nativeSessionId: SESSION }, { env: host1.env, driver: createNullDriver(), isAlive: host1.isAlive }),
      { code: 'ui-driver-unavailable' });
    await assert.rejects(destroy({ nativeSessionId: SESSION }, { env: host1.env, driver: uiDriver(), isAlive: host1.isAlive, protectedPids: [50124] }),
      { code: 'protected-pid' });
    await assert.rejects(destroy({ nativeSessionId: OTHER }, { env: host1.env, driver: uiDriver(), isAlive: host1.isAlive }),
      { code: 'unknown-native-session' });
    assert.equal(host1.alivePids.has(50124), true, 'a refused destroy changes nothing');

    const anonymous = await host({ sessions: [{ ...record(), name: undefined }] });
    try {
      await assert.rejects(destroy({ nativeSessionId: SESSION }, { env: anonymous.env, driver: uiDriver(), isAlive: anonymous.isAlive }),
        { code: 'session-title-missing' });
    } finally { await rm(anonymous.dir, { recursive: true, force: true }); }
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('destroy on a session whose record is already gone says so', async () => {
  const host1 = await host({ sessions: [] });
  try {
    await assert.rejects(destroy({ nativeSessionId: SESSION }, { env: host1.env, driver: uiDriver(), isAlive: host1.isAlive }),
      { code: 'unknown-native-session' });
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ resume

test('resume reports a live session without touching the window', async () => {
  const host1 = await host({ sessions: [record()] });
  const driver = uiDriver();
  try {
    const result = await resume({ nativeSessionId: SESSION }, { env: host1.env, driver, isAlive: host1.isAlive });
    assert.equal(result.resumed, true);
    assert.equal(result.mode, 'live');
    assert.deepEqual(result.verifiedBy, ['record-and-process-live']);
    assert.deepEqual(driver.calls, [], 'a live session needs no UI work');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('resume of a closed session only succeeds when the record comes back', async () => {
  const closed = await host({ sessions: [record()], alive: new Set() });
  try {
    const driver = uiDriver({ revealSession: async input => {
      closed.alivePids.add(50555);
      await closed.write(record({ pid: 50555 }), [userLine('earlier turn')]);
    } });
    const result = await resume({ nativeSessionId: SESSION }, { env: closed.env, driver, isAlive: closed.isAlive, timeoutMs: 1000, pollMs: 20 });
    assert.equal(result.resumed, true);
    assert.equal(result.mode, 'reopened');
    assert.equal(result.pid, 50555);
    assert.equal(driver.calls.find(call => Array.isArray(call) && call[0] === 'revealSession')[1].hostSessionId,
      'local_4a23e095-8206-44dc-af92-46c5f48c2d25');
  } finally { await rm(closed.dir, { recursive: true, force: true }); }

  const gone = await host({ sessions: [], alive: new Set() });
  try {
    const stale = uiDriver();
    const result = await resume({ nativeSessionId: OTHER }, { env: gone.env, driver: stale, isAlive: gone.isAlive, timeoutMs: 200, pollMs: 20 });
    assert.equal(result.resumed, false);
    assert.equal(result.reason, 'unknown-native-session');

    const unconfirmed = await resume({ nativeSessionId: OTHER, hostSessionId: 'local_4a23e095-8206-44dc-af92-46c5f48c2d25' },
      { env: gone.env, driver: uiDriver(), isAlive: gone.isAlive, timeoutMs: 200, pollMs: 20 });
    assert.equal(unconfirmed.resumed, false);
    assert.equal(unconfirmed.reason, 'no-session-record-after-reopen');
  } finally { await rm(gone.dir, { recursive: true, force: true }); }
});

﻿// ------------------------------------------------------------------ models

test('the model is reported as provider/model/effort with the real label', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: {
    [SESSION]: [userLine('hi'), assistantLine('claude-opus-5-5', 'max')],
  } });
  try {
    const read = await readDefaultModel({ driver: uiDriver(), env: host1.env, isAlive: host1.isAlive });
    assert.equal(read.provider, 'anthropic');
    assert.equal(read.model, 'claude-opus-5-5');
    assert.equal(read.reasoningEffort, 'max');
    assert.equal(read.label, 'Opus 5.5');
    assert.equal(read.effortLabel, '最高');
    assert.equal(read.resolved, true);
    assert.equal(read.verified, true);
    assert.equal(read.effortResolution.source, 'paired-observation');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a label that no local evidence can map stays unresolved', async () => {
  const host1 = await host({ sessions: [] });
  try {
    const read = await readDefaultModel({ driver: uiDriver({ readModel: () => ({ raw: '模型：Frobnicator 最高 3× 或更多用量' }) }),
      env: host1.env, isAlive: host1.isAlive });
    assert.equal(read.label, 'Frobnicator');
    assert.equal(read.model, null);
    assert.equal(read.resolved, false);
    assert.equal(read.reason, 'no-host-session-to-observe');

    const conflict = resolveModelEvidence({
      label: 'Opus 5.5', effortLabel: '最高',
      evidence: { sessions: [
        { nativeSessionId: 'a', current: { model: 'claude-opus-5-5' }, efforts: ['max'] },
        { nativeSessionId: 'b', current: { model: 'claude-sonnet-5-5' }, efforts: ['max'] },
      ], configModels: [] },
    });
    assert.equal(conflict.resolved, false);
    assert.equal(conflict.reason, 'conflicting-model-evidence');
    assert.deepEqual(conflict.candidates, ['claude-opus-5-5', 'claude-sonnet-5-5']);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('the model control name is parsed, not echoed as the model', () => {
  // The name measured on Claude 4.4212.0.0.
  assert.deepEqual(parseModelControl('模型：Opus 5.5 最高 3.5× 或更多用量'),
    { label: 'Opus 5.5', effort: '最高', raw: '模型：Opus 5.5 最高 3.5× 或更多用量' });
  assert.equal(parseModelControl('Model: Sonnet 5.5 High').label, 'Sonnet 5.5');
  assert.equal(parseModelControl('Opus 5.5').label, 'Opus 5.5');
  assert.equal(parseModelControl('').label, null);
  assert.equal(parseModelControl(undefined).label, null);
  assert.equal(modelInfo({ label: 'Haiku 4.5' }).label, 'Haiku 4.5');
  assert.equal(modelInfo(undefined).label, null);
});

test('a selection is accepted only when the control shows it, and the id comes from evidence', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: {
    [SESSION]: [userLine('hi'), assistantLine('claude-opus-5-5', 'max')],
  } });
  let raw = '模型：Opus 5.5 最高 3.5× 或更多用量';
  const driver = uiDriver({
    readModel: () => ({ raw }),
    selectModel: input => {
      raw = `模型：${input.label} 最高 3.5× 或更多用量`;
      return { clicked: input.label, observed: raw };
    },
  });
  try {
    const result = await selectModel({ model: 'Opus 5.5', nativeSessionId: SESSION },
      { env: host1.env, driver, isAlive: host1.isAlive });
    assert.equal(result.accepted, true);
    assert.equal(result.after.label, 'Opus 5.5');
    assert.equal(result.after.model, 'claude-opus-5-5');
    assert.equal(result.after.reasoningEffort, 'max');
    assert.equal(result.after.resolved, true);
    assert.deepEqual(result.after.provider, 'anthropic');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a selection the host does not show is never reported as accepted', async () => {
  const host1 = await host({ sessions: [] });
  try {
    const stuck = await selectModel({ model: 'Sonnet 5.5' }, { env: host1.env,
      driver: uiDriver({ readModel: () => ({ raw: '模型：Opus 5.5 最高 3.5× 或更多用量' }),
        selectModel: () => ({ clicked: 'Sonnet 5.5', observed: '模型：Opus 5.5 最高 3.5× 或更多用量' }) }),
      isAlive: host1.isAlive, timeoutMs: 120, pollMs: 20 });
    assert.equal(stuck.accepted, false);
    assert.equal(stuck.status, 'unconfirmed');
    assert.equal(stuck.observedAfter, 'Opus 5.5');
    await assert.rejects(selectModel({ model: '  ' }, { driver: uiDriver() }), { code: 'invalid-model' });
    await assert.rejects(selectModel({ model: 'Sonnet 5.5' }, { driver: createNullDriver() }), { code: 'ui-driver-unavailable' });
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('the model of the newest assistant turn can be confirmed after a turn', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: {
    [SESSION]: [userLine('hi'), assistantLine('claude-opus-5-5', 'max')],
  } });
  try {
    const confirmed = await confirmModelAfterTurn({ nativeSessionId: SESSION }, { env: host1.env, isAlive: host1.isAlive });
    assert.equal(confirmed.model, 'claude-opus-5-5');
    assert.equal(confirmed.reasoningEffort, 'max');
    assert.deepEqual(confirmed.verifiedBy, ['session-transcript-assistant-turn']);
    const stale = await confirmModelAfterTurn({ nativeSessionId: SESSION, after: new Date(Date.now() + 600000).toISOString() },
      { env: host1.env, isAlive: host1.isAlive });
    assert.equal(stale, null);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------- probe

test('the probe states what is really available', async () => {
  const host1 = await host({ sessions: [record()] });
  try {
    const withUi = await probeClaudeHost({ env: host1.env, driver: uiDriver(), isAlive: host1.isAlive });
    assert.equal(withUi.application, 'claude-desktop');
    assert.equal(withUi.sessions.live, 1);
    assert.equal(withUi.capabilities.createFirstTurn, 'verified-surface');
    assert.equal(withUi.capabilities.readDefaultModel, 'verified-surface');
    assert.equal(withUi.capabilities.selectModel, 'verified-surface');
    assert.equal(withUi.capabilities.destroy, 'verified-surface');
    assert.equal(withUi.deepLinks.newSession, 'prefill-only');

    const withoutUi = await probeClaudeHost({ env: host1.env, driver: createNullDriver(), isAlive: host1.isAlive });
    assert.equal(withoutUi.ui.available, false);
    assert.equal(withoutUi.capabilities.createFirstTurn, 'unavailable');
    assert.equal(withoutUi.capabilities.interrupt, 'unavailable');
    assert.equal(withoutUi.capabilities.destroy, 'unavailable');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('resolveNativeSession refuses a session from another workspace', async () => {
  const host1 = await host({ sessions: [record()] });
  try {
    await assert.rejects(resolveNativeSession(SESSION, { env: host1.env, isAlive: host1.isAlive, workspace: 'D:\\Work\\other' }),
      { code: 'session-workspace-mismatch' });
    const ok = await resolveNativeSession(SESSION, { env: host1.env, isAlive: host1.isAlive, workspace: CWD });
    assert.equal(ok.nativeSessionId, SESSION);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

// ------------------------------------------- identity, interrupt shapes, delete

test('the page title is normalized and page content can identify a session', () => {
  assert.equal(displayTitle('FutureAide host verify - Claude Code'), 'FutureAide host verify');
  assert.equal(displayTitle('Bare title'), 'Bare title');
  assert.equal(displayTitle(''), undefined);
  assert.equal(displayTitle(undefined), undefined);
  assert.equal(pageShowsSession({ texts: ['a', 'FutureAide host verify: reply OK only.'] }, 'FutureAide host verify: reply'), true);
  assert.equal(pageShowsSession({ texts: ['something else'] }, 'FutureAide host verify: reply'), false);
  assert.equal(pageShowsSession({ texts: [] }, undefined), false);
});

test('an interrupt recorded inside a request blob still counts', () => {
  const blob = { type: 'api-request-blob', timestamp: new Date(Date.now() + 5000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: `${INTERRUPT_MARKER}\n` }, { type: 'text', text: 'next message' }] } };
  const old = { type: 'user', timestamp: new Date(Date.now() - 600000).toISOString(), message: { role: 'user', content: INTERRUPT_MARKER } };
  assert.equal(interruptedSince(parseEvents([blob]), new Date(Date.now() - 60000).toISOString()), true,
    'a blob-shaped marker is still the app reporting an interrupt');
  assert.equal(interruptedSince(parseEvents([old]), new Date(Date.now() - 60000).toISOString()), false,
    'an older interrupt does not count for a newer request');
});

/** Parse transcript lines the same way the reader does, without touching a file. */
function parseEvents(events) {
  const file = path.join(os.tmpdir(), `fa-events-${process.pid}-${Date.now()}.jsonl`);
  return events.map(event => {
    const content = event.message?.content;
    const parts = Array.isArray(content) ? content : [];
    return {
      type: event.type,
      timestamp: event.timestamp,
      text: typeof content === 'string' ? content
        : parts.filter(part => part?.type === 'text').map(part => part.text).join('\n'),
    };
  }).map(event => { void file; return event; });
}

test('a host that shows the derived title is deleted through that title', async () => {
  const host1 = await host({ sessions: [record({ name: 'xiayuls-workflow-c4' })],
    transcriptLines: { [SESSION]: [userLine('FutureAide host verify: reply OK only.')] } });
  const seen = [];
  const driver = uiDriver({
    documentName: 'FutureAide host verify - Claude Code',
    texts: ['Claude Code', 'FutureAide host verify: reply OK only.', 'Claude 已完成回复'],
    deleteSession: input => { seen.push(input); return nativeDelete(host1)(); },
  });
  try {
    const result = await destroy({ nativeSessionId: SESSION }, { env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 500, pollMs: 20 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].title, 'FutureAide host verify', 'the sidebar entry is addressed by the title the host shows');
    assert.equal(seen[0].deleteLabel, '删除');
    assert.deepEqual(seen[0].confirmLabels, ['删除', 'Delete', '删除会话', 'Delete session']);
    assert.equal(result.title, 'FutureAide host verify');
    assert.equal(result.recordName, 'xiayuls-workflow-c4');
    // The record name is a placeholder, so the session's own text on the page is
    // what identifies it; the title is still the one used for the sidebar entry.
    assert.equal(result.targetConfirmedBy, 'page-content');
    assert.equal(result.destroyed, true);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('model evidence from one session pairs its label with its own effort', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: {
    [SESSION]: [userLine('hi'), assistantLine('claude-opus-5-5', 'medium')],
  } });
  try {
    const read = await readDefaultModel({ driver: uiDriver({ readModel: () => ({ raw: '模型：Opus 5.5 中等' }) }),
      env: host1.env, isAlive: host1.isAlive, nativeSessionId: SESSION });
    assert.equal(read.model, 'claude-opus-5-5');
    assert.equal(read.reasoningEffort, 'medium');
    assert.equal(read.effortLabel, '中等');
    assert.equal(read.effortResolution.source, 'paired-observation');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});