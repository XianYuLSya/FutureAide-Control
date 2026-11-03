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
  probeClaudeHost, parseModelControl, modelInfo,
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

/** A stand-in for the UI bridge. It records what it was asked to do. */
function uiDriver(behaviour = {}) {
  const calls = [];
  const driver = {
    kind: 'fake-uia',
    available: true,
    calls,
    async probe() { calls.push('probe'); return { available: true, documentName: behaviour.documentName ?? 'Fixture session - Claude Code' }; },
    async currentView() { calls.push('view'); return { available: true, documentName: behaviour.documentName ?? 'Fixture session - Claude Code', composerFound: true }; },
    async openNewSession(input) { calls.push(['openNewSession', input]); return behaviour.openNewSession?.() ?? { strategy: 'deep-link-code-new', prefilled: true }; },
    async submit(input) { calls.push(['submit', input]); return behaviour.submit?.() ?? { method: 'enter-on-prefilled-composer' }; },
    async interrupt() { calls.push('interrupt'); return behaviour.interrupt?.() ?? { method: 'escape' }; },
    async revealSession(input) { calls.push(['revealSession', input]); behaviour.revealSession?.(input); return { revealed: true, method: 'deep-link-continue' }; },
    async readModel() { calls.push('readModel'); return behaviour.readModel?.() ?? { label: 'Opus 5.5', raw: '模型：Opus 5.5 最高 3.5× 或更多用量' }; },
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

// ----------------------------------------------------------------- destroy

test('destroy ends the session process and never claims a deletion', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: { [SESSION]: [userLine('work')] } });
  const killed = [];
  try {
    const transcript = await findTranscript({ env: host1.env, nativeSessionId: SESSION, workspace: CWD });
    const result = await destroy({ nativeSessionId: SESSION }, {
      env: host1.env, isAlive: host1.isAlive, kill: pid => { killed.push(pid); host1.alivePids.delete(pid); }, timeoutMs: 500, pollMs: 20,
    });
    assert.deepEqual(killed, [50124]);
    assert.equal(result.destroyed, true);
    assert.equal(result.status, 'ended');
    assert.equal(result.deleted, false);
    assert.equal(result.transcriptKept, true);
    assert.deepEqual(result.verifiedBy, ['process-exit']);
    assert.equal((await readFile(transcript, 'utf8')).includes('work'), true, 'the transcript is untouched');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('destroy refuses an unknown session and a protected pid', async () => {
  const host1 = await host({ sessions: [record()] });
  try {
    await assert.rejects(destroy({ nativeSessionId: OTHER }, { env: host1.env, isAlive: host1.isAlive }),
      { code: 'unknown-native-session' });
    await assert.rejects(destroy({ nativeSessionId: SESSION }, { env: host1.env, isAlive: host1.isAlive, protectedPids: [50124] }),
      { code: 'protected-pid' });
    assert.equal(host1.alivePids.has(50124), true, 'a refused destroy changes nothing');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('destroy on an already stopped session reports the truth instead of success', async () => {
  const host1 = await host({ sessions: [record()], alive: new Set() });
  try {
    const result = await destroy({ nativeSessionId: SESSION }, { env: host1.env, isAlive: host1.isAlive });
    assert.equal(result.destroyed, false);
    assert.equal(result.status, 'already-stopped');
    assert.equal(result.deleted, false);
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

// ------------------------------------------------------------------ models

test('the default model is read from the host control or reported unavailable', async () => {
  const read = await readDefaultModel({ driver: uiDriver() });
  assert.equal(read.label, 'Opus 5.5');
  assert.equal(read.effort, '最高');
  assert.equal(read.verified, true);
  assert.equal(read.source, 'ui-model-control');
  const none = await readDefaultModel({ driver: createNullDriver() });
  assert.equal(none.model, null);
  assert.equal(none.verified, false);
  const blank = await readDefaultModel({ driver: uiDriver({ readModel: () => ({ label: '' }) }) });
  assert.equal(blank.verified, false);
  assert.equal(blank.reason, 'model-control-not-found');
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

test('model selection is only accepted when the host shows the new model', async () => {
  const accepted = await selectModel({ model: 'Sonnet 5.5' }, { driver: uiDriver() });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.after, 'Sonnet 5.5');

  const mismatch = await selectModel({ model: 'Sonnet 5.5' },
    { driver: uiDriver({ readModel: () => ({ label: 'Opus 5.5' }), selectModel: () => ({ clicked: 'Sonnet 5.5', observed: 'Opus 5.5' }) }),
      timeoutMs: 120, pollMs: 20 });
  assert.equal(mismatch.accepted, false);
  assert.equal(mismatch.status, 'unconfirmed');
  assert.equal(mismatch.observedAfter, 'Opus 5.5');

  await assert.rejects(selectModel({ model: '  ' }, { driver: uiDriver() }), { code: 'invalid-model' });
  await assert.rejects(selectModel({ model: 'Sonnet 5.5' }, { driver: createNullDriver() }), { code: 'ui-driver-unavailable' });
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
    assert.equal(withUi.capabilities.selectModel, 'unverified');
    assert.equal(withUi.deepLinks.newSession, 'prefill-only');

    const withoutUi = await probeClaudeHost({ env: host1.env, driver: createNullDriver(), isAlive: host1.isAlive });
    assert.equal(withoutUi.ui.available, false);
    assert.equal(withoutUi.capabilities.createFirstTurn, 'unavailable');
    assert.equal(withoutUi.capabilities.interrupt, 'unavailable');
    assert.equal(withoutUi.capabilities.destroy, 'verified-surface');
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
