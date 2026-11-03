import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  INTERRUPT_MARKER, DEEP_LINK_PROMPT_LIMIT, markerLine, assertBindingNonce, assertRequestId,
  assertMessage, scanNativeSessions, listNativeSessions, resolveNativeSession, findTranscript,
  readTranscriptEvents, countMarker, interruptedSince, viewMatchesSession, deepLinks,
  createNullDriver, createFirstTurn, interrupt, destroy, resume, readDefaultModel, selectModel,
  probeClaudeHost, parseModelControl, modelInfo, resolveModelEvidence, confirmModelAfterTurn, sessionArtifacts,
  displayTitle, pageShowsSession, findCreatedSession, readCurrentModel, labelForModel, interruptEvidence, bindingOf,
  MODEL_MENU, EFFORT_LABELS, EFFORT_LABEL_FOR, offeredModelLabels, isOfferedModelLabel, isOfferedEffort,
  loadModelCatalog, BUILT_IN_MODEL_CATALOG, extractModelSelectorConfigs, sliceBalancedArray,
  extractEmbeddedCatalog, readQuotedLiteral, firstTurnBinding, readTranscriptHead, firstInputOf,
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
const enqueueLine = text => ({ type: 'queue-operation', operation: 'enqueue',
  timestamp: new Date(Date.now() + (++stamp) * 1000).toISOString(), content: text });
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
    async currentView() { calls.push('view'); return { available: true, documentName: behaviour.documentName ?? 'Fixture session - Claude Code',
      composerFound: true, hasComposer: true, messages: behaviour.messages ?? 0,
      composerLength: behaviour.composerLength ?? 0, trustPrompt: behaviour.trustPrompt ?? false,
      texts: behaviour.texts ?? [] }; },
    async openNewSession(input) { calls.push(['openNewSession', input]); return behaviour.openNewSession?.(input) ?? { strategy: 'deep-link-code-new-protocol', prefilled: true }; },
    async submit(input) { calls.push(['submit', input]); return behaviour.submit?.() ?? { method: 'enter-on-prefilled-composer' }; },
    async interrupt() { calls.push('interrupt'); return behaviour.interrupt?.() ?? { method: 'escape' }; },
    async revealSession(input) { calls.push(['revealSession', input]); behaviour.revealSession?.(input); return { revealed: true, method: 'deep-link-continue-protocol' }; },
    async readSessionArgs(input) { calls.push(['readSessionArgs', input]); return behaviour.readSessionArgs?.(input); },
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
      await host1.write(record(), [enqueueLine(`do the thing\n\n${markerLine('request-abc', 'fa-life-20261103-1630')}`)]);
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
    assert.deepEqual(result.verifiedBy, ['native-record-created', 'first-input-marker-once']);
    assert.equal(result.submittedBy, 'enqueue', 'the opener is the native enqueue record');
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
    [SESSION]: [enqueueLine(`do the thing\n\n${markerLine('request-abc', 'fa-life-20261103-1630')}`)],
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
function nativeDelete(host1, { remove = ['record', 'transcript', 'sessionDir', 'sessionEnv', 'process'] } = {}) {
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
    if (remove.includes('sessionDir')) {
      await rm(path.join(host1.configRoot, 'projects', String(CWD).replace(/[^A-Za-z0-9]/g, '-'), SESSION), { recursive: true, force: true });
      removed.push('sessionDir');
    }
    if (remove.includes('sessionEnv')) {
      await rm(path.join(host1.configRoot, 'session-env', SESSION), { recursive: true, force: true });
      removed.push('sessionEnv');
    }
    if (remove.includes('process')) host1.alivePids.delete(50124);
    return { clicked: '删除', confirmed: '删除', removed };
  };
}

test('destroy deletes through the host menu and verifies every artifact', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: { [SESSION]: [userLine('work')] } });
  await mkdir(path.join(host1.configRoot, 'projects', String(CWD).replace(/[^A-Za-z0-9]/g, '-'), SESSION, 'subagents'), { recursive: true });
  await writeFile(path.join(host1.configRoot, 'projects', String(CWD).replace(/[^A-Za-z0-9]/g, '-'), SESSION, 'subagents', 'agent-1.jsonl'), '{}\n');
  await mkdir(path.join(host1.configRoot, 'session-env', SESSION), { recursive: true });
  try {
    const driver = uiDriver({ deleteSession: nativeDelete(host1) });
    const result = await destroy({ nativeSessionId: SESSION }, { env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 500, pollMs: 20 });
    assert.equal(result.destroyed, true);
    assert.equal(result.deleted, true);
    assert.equal(result.status, 'deleted');
    for (const name of ['registry-record-gone', 'transcript-gone', 'session-directory-gone', 'host-process-exited', 'session-directories-gone']) {
      assert.ok(result.verifiedBy.includes(name), name);
    }
    assert.deepEqual(result.before.subagents, 1, 'the subagent transcript was there before the deletion');
    assert.equal(result.after.subagents, 0);
    assert.equal(result.removed.sessionDirectory, true);
    assert.equal(result.removed.subagentDirectory, true);
    assert.equal(result.kept.projectFiles, true);
    assert.equal(result.hostAction.clicked, '删除');
    assert.equal(result.hostAction.confirmed, '删除');
    assert.equal((await listNativeSessions({ env: host1.env, isAlive: host1.isAlive })).length, 0);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a host that leaves the session directory behind is not reported as deleted', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: { [SESSION]: [userLine('work')] } });
  await mkdir(path.join(host1.configRoot, 'projects', String(CWD).replace(/[^A-Za-z0-9]/g, '-'), SESSION, 'subagents'), { recursive: true });
  await writeFile(path.join(host1.configRoot, 'projects', String(CWD).replace(/[^A-Za-z0-9]/g, '-'), SESSION, 'subagents', 'agent-1.jsonl'), '{}\n');
  try {
    const driver = uiDriver({ deleteSession: nativeDelete(host1, { remove: ['record', 'transcript'] }) });
    const result = await destroy({ nativeSessionId: SESSION }, { env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 200, pollMs: 20 });
    assert.equal(result.destroyed, false, 'a leftover subagent directory is not success');
    assert.equal(result.deleted, true, 'record and transcript are gone');
    assert.equal(result.removed.subagentDirectory, false);
    assert.deepEqual(result.leftovers, ['sessionDirectory', 'subagentDirectory']);
    assert.equal(result.after.subagents, 1);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a repeated destroy confirms an already-deleted session only from the known paths', async () => {
  const host1 = await host({ sessions: [], alive: new Set() });
  try {
    const binding = { nativeSessionId: SESSION, workspace: CWD, pid: 50124, name: 'Fixture session' };
    const done = await destroy({ nativeSessionId: SESSION, binding }, { env: host1.env, driver: createNullDriver(), isAlive: host1.isAlive });
    assert.equal(done.destroyed, true);
    assert.equal(done.alreadyDeleted, true);
    assert.equal(done.status, 'already-deleted');
    assert.ok(done.verifiedBy.includes('known-paths-clear'));

    await mkdir(path.join(host1.configRoot, 'session-env', SESSION), { recursive: true });
    const left = await destroy({ nativeSessionId: SESSION, binding }, { env: host1.env, driver: createNullDriver(), isAlive: host1.isAlive });
    assert.equal(left.destroyed, false);
    assert.equal(left.status, 'leftovers');
    assert.ok(left.leftovers.includes('sessionEnvDirectory'));

    const blind = await destroy({ nativeSessionId: OTHER }, { env: host1.env, driver: createNullDriver(), isAlive: host1.isAlive });
    assert.equal(blind.destroyed, false);
    assert.equal(blind.status, 'unknown');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('destroy refuses without a UI driver, for a protected pid, or without a title', async () => {
  const host1 = await host({ sessions: [record()] });
  try {
    await assert.rejects(destroy({ nativeSessionId: SESSION }, { env: host1.env, driver: createNullDriver(), isAlive: host1.isAlive }),
      { code: 'ui-driver-unavailable' });
    await assert.rejects(destroy({ nativeSessionId: SESSION }, { env: host1.env, driver: uiDriver(), isAlive: host1.isAlive, protectedPids: [50124] }),
      { code: 'protected-pid' });
    assert.equal(host1.alivePids.has(50124), true, 'a refused destroy changes nothing');
    const anonymous = await host({ sessions: [{ ...record(), name: undefined }] });
    try {
      await assert.rejects(destroy({ nativeSessionId: SESSION }, { env: anonymous.env, driver: uiDriver(), isAlive: anonymous.isAlive }),
        { code: 'session-title-missing' });
    } finally { await rm(anonymous.dir, { recursive: true, force: true }); }
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

test('the catalogue driven menu is the one this host shows', () => {
  assert.deepEqual(MODEL_MENU.primary, ['Opus 5.5', 'Sonnet 5.5', 'Fable 5.1', 'Haiku 5.5']);
  assert.equal(offeredModelLabels().length, 13);
  assert.equal(isOfferedModelLabel('Opus 4.6'), true);
  assert.equal(isOfferedModelLabel('Opus 5.6'), false);
  assert.deepEqual(BUILT_IN_MODEL_CATALOG.efforts.map(option => option.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(BUILT_IN_MODEL_CATALOG.efforts.find(option => option.recommended)?.id, 'medium');
  assert.equal(EFFORT_LABELS['超高'], 'xhigh');
  assert.equal(EFFORT_LABEL_FOR.max, '最高');
  assert.equal(isOfferedEffort('xhigh'), true);
  assert.equal(isOfferedEffort('turbo'), false);
  assert.equal(BUILT_IN_MODEL_CATALOG.selectionSource, 'global_default');
  // The menu decorates the recommended entry and the max entry with hints.
  assert.equal(parseModelControl('模型：Opus 5.5 中等（推荐）').effort, '中等');
  assert.equal(parseModelControl('模型：Opus 5.5 中等（推荐）').label, 'Opus 5.5');
  assert.equal(parseModelControl('模型：Opus 5.5 最高 3.5× 或更多').effort, '最高');
});

test('every id in the shipped catalogue maps to its own name', () => {
  const mapped = labelForModel({ provider: 'anthropic', model: 'claude-sonnet-5-5' });
  assert.equal(mapped.resolved, true);
  assert.equal(mapped.label, 'Sonnet 5.5');
  assert.equal(mapped.section, 'main');
  assert.match(mapped.evidence, /model_selector_config/);
  assert.equal(labelForModel({ model: 'claude-haiku-4-5-20251001' }).label, 'Haiku 4.5');
  assert.equal(labelForModel({ model: 'claude-opus-4-1-20250805' }).label, 'Opus 4.1');
  const unknown = labelForModel({ model: 'claude-frobnicator-9' });
  assert.equal(unknown.reason, 'unmapped-model-id');
  assert.ok(unknown.known.includes('claude-opus-5-5'), 'the refusal lists the ids the catalogue knows');
  assert.equal(labelForModel({ provider: 'openai', model: 'claude-opus-5-5' }).reason, 'provider-mismatch');
});

test('the model control name is parsed, not echoed as the model', () => {
  assert.deepEqual(parseModelControl('模型：Opus 5.5 最高 3.5× 或更多用量'),
    { label: 'Opus 5.5', effort: '最高', raw: '模型：Opus 5.5 最高 3.5× 或更多用量' });
  assert.deepEqual(parseModelControl('模型：Opus 5.5 中等'),
    { label: 'Opus 5.5', effort: '中等', raw: '模型：Opus 5.5 中等' });
  assert.equal(parseModelControl('').label, null);
  assert.equal(modelInfo(undefined).label, null);
});

test('the default model is read from a draft control resolved through the catalogue', async () => {
  const driver = uiDriver({ messages: 0, readModel: () => ({ raw: '模型：Sonnet 5.5 高' }) });
  const read = await readDefaultModel({ driver, catalog: await loadModelCatalog({ asar: 'missing.asar' }) });
  assert.equal(read.provider, 'anthropic');
  assert.equal(read.model, 'claude-sonnet-5-5');
  assert.equal(read.reasoningEffort, 'high');
  assert.equal(read.label, 'Sonnet 5.5');
  assert.equal(read.effortLabel, '高');
  assert.equal(read.resolved, true);
  assert.equal(read.verified, true);
  assert.equal(read.status, 'read');
  assert.equal(read.source, 'draft-control+app-catalog');
  assert.equal(read.selectionSource, 'global_default');
  assert.equal(read.navigation.navigated, false, 'a draft already on screen is read in place');
  assert.equal(read.navigation.draftPreserved, true);
  assert.equal(read.evidence.control.raw, '模型：Sonnet 5.5 高');
  assert.equal(read.evidence.launchArgs, undefined, 'a running session never stands in for the default');

  await assert.rejects(readDefaultModel({ driver: createNullDriver() }), { code: 'ui-driver-unavailable' });
});

test('the next-turn model comes from the session control, never from history', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: {
    [SESSION]: [userLine('hi'), assistantLine('claude-opus-5-5', 'max')],
  } });
  const page = { documentName: 'Fixture session - Claude Code', texts: ['Claude Code', 'Fixture session'] };
  try {
    // Without a driver there is nothing to read: no history stand-in.
    await assert.rejects(readCurrentModel({ nativeSessionId: SESSION }, { env: host1.env, isAlive: host1.isAlive }),
      { code: 'ui-driver-unavailable' });

    // The control is unreadable: fail explicitly even though the transcript has a model.
    const blind = await readCurrentModel({ nativeSessionId: SESSION }, {
      driver: uiDriver({ ...page, readModel: () => ({ label: '' }) }), env: host1.env, isAlive: host1.isAlive });
    assert.equal(blind.resolved, false);
    assert.equal(blind.status, 'unreadable');
    assert.equal(blind.model, null);
    assert.equal(blind.evidence.history.transcript.model, 'claude-opus-5-5', 'history is context only');

    // A control that differs from the transcript is a normal selection change.
    const changed = await readCurrentModel({ nativeSessionId: SESSION }, {
      driver: uiDriver({ ...page, readModel: () => ({ raw: '模型：Sonnet 5.5 高' }) }),
      env: host1.env, isAlive: host1.isAlive });
    assert.equal(changed.resolved, true);
    assert.equal(changed.model, 'claude-sonnet-5-5');
    assert.equal(changed.reasoningEffort, 'high');
    assert.equal(changed.source, 'composer-control');
    assert.equal(changed.historyDiffers, true);
    assert.match(changed.note, /selection change/);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a model selection is requested by id and confirmed by the control', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: {
    [SESSION]: [userLine('hi'), assistantLine('claude-opus-5-5', 'max')],
  } });
  let raw = '模型：Opus 5.5 最高 3.5× 或更多用量';
  const driver = uiDriver({
    documentName: 'Fixture session - Claude Code',
    texts: ['Claude Code', 'Fixture session'],
    readModel: () => ({ raw }),
    selectModel: input => { raw = `模型：${input.label} ${input.effortLabel ?? ''} 3.5× 或更多用量`; return { clicked: input.label, effortClicked: input.effortLabel, observed: raw }; },
    readSessionArgs: ({ pid }) => ({ pid, found: true, model: 'claude-opus-5-5', effort: 'max' }),
  });
  try {
    const result = await selectModel({ nativeSessionId: SESSION, provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'max' },
      { driver, env: host1.env, isAlive: host1.isAlive });
    assert.equal(result.accepted, true);
    assert.equal(result.after.label, 'Opus 5.5');
    assert.equal(result.after.reasoningEffort, 'max');
    assert.equal(result.catalogSource, 'built-in-snapshot');
    await assert.rejects(selectModel({ nativeSessionId: SESSION, model: 'claude-frobnicator-9' },
      { driver, env: host1.env, isAlive: host1.isAlive }), { code: 'unmapped-model-id' });
    await assert.rejects(selectModel({ nativeSessionId: SESSION, model: 'claude-opus-5-5', reasoningEffort: 'turbo' },
      { driver, env: host1.env, isAlive: host1.isAlive }), { code: 'unmapped-effort' });
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a selection the host does not show is never reported as accepted', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: { [SESSION]: [assistantLine('claude-opus-5-5', 'max')] } });
  try {
    const stuck = await selectModel({ nativeSessionId: SESSION, model: 'claude-opus-5-5', reasoningEffort: 'max' },
      { driver: uiDriver({
        documentName: 'Fixture session - Claude Code',
        texts: ['Claude Code', 'Fixture session'],
        readModel: () => ({ raw: '模型：Opus 5.5 中等' }),
        selectModel: () => ({ clicked: 'Opus 5.5', observed: '模型：Opus 5.5 中等' }),
      }), env: host1.env, isAlive: host1.isAlive, timeoutMs: 120, pollMs: 20 });
    assert.equal(stuck.accepted, false);
    assert.equal(stuck.status, 'unconfirmed');
    await assert.rejects(selectModel({ nativeSessionId: SESSION, model: 'claude-opus-5-5' }, { driver: createNullDriver() }),
      { code: 'ui-driver-unavailable' });
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
    assert.ok(['verified-surface', 'unavailable'].includes(withUi.capabilities.readDefaultModel));
    assert.equal(withUi.capabilities.selectModel, 'unverified', 'a control that was never exercised on a live app is not claimed');
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
  void file;
  return events.map(event => {
    const content = event.message?.content;
    const parts = Array.isArray(content) ? content : [];
    return {
      type: event.type,
      timestamp: event.timestamp,
      role: event.message?.role,
      textParts: typeof content === 'string' ? [content.trim()]
        : parts.filter(part => part?.type === 'text').map(part => String(part.text).trim()),
    };
  });
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

// --------------------------------------- binding, long first turn, strict stop

test('findCreatedSession locates the session by the unique marker only', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: {
    [SESSION]: [enqueueLine(`do the thing\n\n${markerLine('request-abc', 'fa-life-20261103-1630')}`)],
  } });
  try {
    const found = await findCreatedSession({ workspace: CWD, requestId: 'request-abc', bindingNonce: 'fa-life-20261103-1630' },
      { env: host1.env, isAlive: host1.isAlive });
    assert.equal(found.nativeSessionId, SESSION);
    assert.equal(found.hostSessionId, 'local_4a23e095-8206-44dc-af92-46c5f48c2d25');
    assert.equal(found.workspace, CWD);
    assert.deepEqual(found.verifiedBy, ['first-input-marker-once']);
    assert.equal(found.submittedBy, 'enqueue');
    assert.equal(found.firstInput.hasMarker, true);

    const wrongNonce = await findCreatedSession({ workspace: CWD, requestId: 'request-abc', bindingNonce: 'fa-life-other-nonce' },
      { env: host1.env, isAlive: host1.isAlive });
    assert.equal(wrongNonce, undefined, 'a different nonce is a different request');

    await host1.append(SESSION, [userLine(markerLine('request-abc', 'fa-life-20261103-1630'))]);
    await assert.rejects(findCreatedSession({ workspace: CWD, requestId: 'request-abc', bindingNonce: 'fa-life-20261103-1630' },
      { env: host1.env, isAlive: host1.isAlive }), { code: 'marker-not-unique' });
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('the binding is persisted through onBound the moment the session is identified', async () => {
  const host1 = await host({ sessions: [] });
  const bound = [];
  let resolvedBeforeReturn = false;
  const driver = uiDriver({ openNewSession: async () => {
    await host1.write(record(), [enqueueLine(`work\n\n${markerLine('request-bound', 'fa-bound-20261104')}`)]);
    return { strategy: 'deep-link-code-new-protocol', prefilled: true };
  } });
  try {
    const result = await createFirstTurn({ workspace: CWD, requestId: 'request-bound', message: 'work',
      bindingNonce: 'fa-bound-20261104' }, {
      env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 2000, pollMs: 20,
      onBound: async record1 => { bound.push(record1); await new Promise(r => setTimeout(r, 30)); resolvedBeforeReturn = true; },
    });
    assert.equal(result.created, true);
    assert.equal(result.onBoundCalled, true);
    assert.equal(bound.length, 1, 'the callback runs once');
    assert.equal(bound[0].nativeSessionId, SESSION);
    assert.equal(bound[0].hostSessionId, 'local_4a23e095-8206-44dc-af92-46c5f48c2d25');
    assert.equal(resolvedBeforeReturn, true, 'onBound is awaited before createFirstTurn returns');
    assert.equal(result.bindingError, undefined);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a failing onBound is surfaced instead of being swallowed', async () => {
  const host1 = await host({ sessions: [] });
  const driver = uiDriver({ openNewSession: async () => {
    await host1.write(record(), [enqueueLine(`work\n\n${markerLine('request-bound2', 'fa-bound-20261104b')}`)]);
    return { strategy: 'deep-link-code-new-protocol', prefilled: true };
  } });
  try {
    const result = await createFirstTurn({ workspace: CWD, requestId: 'request-bound2', message: 'work',
      bindingNonce: 'fa-bound-20261104b' }, {
      env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 2000, pollMs: 20,
      onBound: async () => { throw Object.assign(new Error('roster write failed'), { code: 'roster-write-failed' }); },
    });
    assert.equal(result.created, true);
    assert.deepEqual(result.bindingError, { code: 'roster-write-failed', message: 'roster write failed' });
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a first message longer than the deep-link limit is filled through the composer', async () => {
  const long = `Interrupt-free long task. ${'x'.repeat(20000)}`;
  const host1 = await host({ sessions: [] });
  const driver = uiDriver({ openNewSession: async input => {
    host1.lastLaunch = input;
    await host1.write(record(), [enqueueLine(`${long}\n\n${markerLine('request-long', 'fa-long-20261104')}`)]);
    return { strategy: 'deep-link-code-new-protocol', prefilled: false, navigated: true };
  } });
  try {
    const result = await createFirstTurn({ workspace: CWD, requestId: 'request-long', message: long,
      bindingNonce: 'fa-long-20261104' }, { env: host1.env, driver, isAlive: host1.isAlive, timeoutMs: 2000, pollMs: 20 });
    assert.equal(host1.lastLaunch.prefill, false, 'the deep link is not asked to carry a 20k message');
    const submit = driver.calls.find(call => Array.isArray(call) && call[0] === 'submit');
    assert.ok(submit[1].prompt.length > 20000, 'the whole message goes through the composer');
    assert.ok(submit[1].prompt.endsWith('[FutureAide Control request request-long \u00b7 binding fa-long-20261104]'));
    assert.equal(result.created, true);
    assert.equal(deepLinks.newSessionDeepLink.length > 0, true);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('only an exact interrupt message written after the request counts', () => {
  const now = Date.now();
  const quoted = { type: 'user', role: 'user', timestamp: new Date(now + 1000).toISOString(),
    textParts: ['Here is what the log said: [Request interrupted by user] earlier today'] };
  // A tool result that happens to contain the sentence is not a text part, so the
  // reader never reports it as an interrupt.
  const toolish = { type: 'user', role: 'user', timestamp: new Date(now + 2000).toISOString(), textParts: [] };
  const assistantMention = { type: 'assistant', role: 'assistant', timestamp: new Date(now + 3000).toISOString(),
    textParts: [INTERRUPT_MARKER] };
  const real = { type: 'api-request-blob', role: 'user', timestamp: new Date(now + 4000).toISOString(),
    textParts: [INTERRUPT_MARKER, 'next message'] };
  const since = new Date(now).toISOString();
  assert.equal(interruptEvidence([quoted], since), undefined, 'a quote is not an interrupt');
  assert.equal(interruptEvidence([toolish], since), undefined, 'a tool result is not an interrupt');
  assert.equal(interruptEvidence([assistantMention], since), undefined, 'only the user side carries it');
  const evidence = interruptEvidence([real], since);
  assert.equal(evidence.matched, 'exact-text-part');
  assert.equal(evidence.type, 'api-request-blob');
});

// ---------------------------------------------------- shipped model catalogue

test('the catalogue parser reads the shipped JSON shape without executing it', () => {
  const bundle = 'var a=1;x={"selection_source":"global_default"}],"model_selector_config":[{"id":"ccd","models":[{"id":"claude-x-1","name":"X 1","section":"main","thinking":{"effort_options":[{"id":"low","name":"Low"},{"id":"medium","name":"Medium","badge":{"message":"Recommended"}}]}}]}],"next":2;';
  const configs = extractModelSelectorConfigs(bundle);
  assert.equal(configs.length, 1);
  assert.equal(configs[0].id, 'ccd');
  assert.equal(configs[0].models[0].id, 'claude-x-1');
  assert.equal(configs[0].models[0].thinking.effort_options[1].badge.message, 'Recommended');
  // Brackets inside strings and escapes must not end the array.
  const tricky = 'k="model_selector_config":[{"id":"ccd","note":"a ] bracket and \\" quote","models":[]}]';
  const parsed = JSON.parse(sliceBalancedArray(tricky, tricky.indexOf('"model_selector_config"')));
  assert.equal(parsed[0].note, 'a ] bracket and " quote');
  assert.equal(sliceBalancedArray('no array here', 0), undefined);
});

test('an unreadable archive falls back to the snapshot this build knows', async () => {
  const catalog = await loadModelCatalog({ asar: path.join(os.tmpdir(), 'definitely-not-an-archive.asar') });
  assert.equal(catalog.catalogSource, 'built-in-snapshot');
  assert.equal(catalog.surface, 'ccd');
  assert.equal(catalog.selectionSource, 'global_default');
  assert.equal(catalog.models.length, 13);
  assert.equal(catalog.models.find(model => model.id === 'claude-sonnet-5-5').name, 'Sonnet 5.5');
  assert.equal(catalog.efforts.find(option => option.id === 'xhigh').name, 'Extra');
});

test('the installed app archive carries the authoritative catalogue', async t => {
  const asar = 'C:/Program Files/WindowsApps/Claude_4.4212.0.0_x64__pzs8sxrjxfjjc/app/resources/app.asar';
  if (!existsSync(asar)) return t.skip('the app archive is not installed on this machine');
  const catalog = await loadModelCatalog({ asar });
  assert.equal(catalog.catalogSource, 'app-asar');
  assert.equal(catalog.surface, 'ccd');
  assert.equal(catalog.selectionSource, 'global_default');
  assert.equal(catalog.models.length, 13);
  assert.deepEqual(catalog.models.filter(model => model.section === 'main').map(model => model.name),
    ['Opus 5.5', 'Sonnet 5.5', 'Fable 5.1', 'Haiku 5.5']);
  assert.equal(labelForModel({ model: 'claude-opus-5-5' }, catalog).label, 'Opus 5.5');
  assert.equal(labelForModel({ model: 'claude-sonnet-5-5' }, catalog).label, 'Sonnet 5.5');
  assert.deepEqual(catalog.efforts.map(option => option.id), ['low', 'medium', 'high', 'xhigh', 'max']);
});

// ------------------------------------------- default model without a model turn

/** A page whose state the UI bridge changes as the test drives it. */
function pageDriver(initial, transitions) {
  let state = { ...initial };
  const calls = [];
  const driver = {
    kind: 'fake-uia', available: true, calls,
    async probe() { return { available: true, documentName: state.documentName }; },
    async currentView() { calls.push('view'); return { available: true, hasComposer: true, texts: [], ...state }; },
    async readModel() { calls.push('readModel'); return { raw: state.raw }; },
    async openNewSession(input) {
      calls.push(['openNewSession', input]);
      state = { ...state, ...(transitions.open ?? {}) };
      return transitions.openResult ?? { strategy: 'deep-link-code-new-protocol', navigated: true };
    },
    async revealSession(input) {
      calls.push(['revealSession', input]);
      state = { ...state, ...(transitions.reveal ?? {}) };
      return { revealed: true, method: 'deep-link-continue-protocol' };
    },
  };
  return driver;
}

test('a session page is swapped for a draft control read, then restored', async () => {
  const host1 = await host({ sessions: [record()], transcriptLines: { [SESSION]: [assistantLine('claude-opus-5-5', 'max')] } });
  try {
    const driver = pageDriver(
      { documentName: 'Fixture session - Claude Code', messages: 3, composerLength: 0, raw: '模型：Opus 5.5 中等' },
      { open: { documentName: 'New session - Claude Code', messages: 0, raw: '模型：Opus 5.5 中等' },
        reveal: { documentName: 'Fixture session - Claude Code', messages: 3 } },
    );
    const catalog = await loadModelCatalog({ asar: 'missing.asar' });
    const read = await readDefaultModel({ driver, env: host1.env, isAlive: host1.isAlive, catalog });
    assert.equal(read.resolved, true);
    assert.equal(read.model, 'claude-opus-5-5');
    assert.equal(read.navigation.navigated, true);
    assert.equal(read.navigation.draft, 'fresh');
    assert.equal(read.navigation.restored, 'session', 'the previous view is put back');
    const open = driver.calls.find(call => Array.isArray(call) && call[0] === 'openNewSession');
    assert.equal(open[1].prefill, false, 'no prompt goes through the deep link');
    assert.equal(open[1].prompt, undefined, 'nothing is sent, so no model turn is spent');
    assert.ok(driver.calls.some(call => Array.isArray(call) && call[0] === 'revealSession'));
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('unsent text in the composer is never overwritten to read a default', async () => {
  const host1 = await host({ sessions: [record()] });
  try {
    const driver = pageDriver({ documentName: 'Fixture session - Claude Code', messages: 3, composerLength: 42, raw: '模型：Opus 5.5 中等' }, {});
    await assert.rejects(readDefaultModel({ driver, env: host1.env, isAlive: host1.isAlive, catalog: await loadModelCatalog({ asar: 'missing.asar' }) }),
      { code: 'unsent-text-present' });
    assert.equal(driver.calls.some(call => Array.isArray(call) && call[0] === 'openNewSession'), false);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a workspace trust question during the draft read fails without approving it', async () => {
  const host1 = await host({ sessions: [record()] });
  try {
    const driver = pageDriver(
      { documentName: 'Fixture session - Claude Code', messages: 3, composerLength: 0, raw: '模型：Opus 5.5 中等' },
      { open: { trustPrompt: true, messages: 0 }, openResult: { blocked: 'workspace-trust-prompt', navigated: false },
        reveal: { trustPrompt: false, messages: 3, documentName: 'Fixture session - Claude Code' } },
    );
    await assert.rejects(readDefaultModel({ driver, env: host1.env, isAlive: host1.isAlive, catalog: await loadModelCatalog({ asar: 'missing.asar' }) }),
      { code: 'workspace-trust-prompt' });
    assert.ok(driver.calls.some(call => Array.isArray(call) && call[0] === 'revealSession'),
      'the previous view is restored even when the read fails');
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('the embedded catalog is read from the surfaces literal, as data', async () => {
  const payload = JSON.stringify({ ccd: { model_selector_config: [{ id: 'ccd', models: [
    { id: 'claude-x-1', name: 'X 1', section: 'main', thinking: { effort_options: [{ id: 'medium', name: 'Medium' }] } },
  ] }] } }).replace(/'/g, "\\'");
  const bundle = `var cdn={$schema:"s",schema_version:1,version:42,issued_at:"2026-10-29T05:58:15Z",expires_at:"2026-11-05T05:58:15Z",key_id:"k",surfaces:JSON.parse('${payload}')};`;
  const embedded = extractEmbeddedCatalog(bundle);
  assert.equal(embedded.surfaces.ccd.model_selector_config[0].models[0].id, 'claude-x-1');
  assert.equal(embedded.meta.version, 42);
  assert.equal(embedded.meta.issuedAt, '2026-10-29T05:58:15Z');
  assert.equal(readQuotedLiteral("x='a\\'b'", 2), "a'b");
  assert.equal(readQuotedLiteral("nope", 0), undefined);
});


test('a read-only default read never navigates the window', async () => {
  const host1 = await host({ sessions: [record()] });
  try {
    const driver = pageDriver({ documentName: 'Fixture session - Claude Code', messages: 3, composerLength: 0, raw: '模型：Opus 5.5 中等' }, {});
    const read = await readDefaultModel({ driver, env: host1.env, isAlive: host1.isAlive,
      catalog: await loadModelCatalog({ asar: 'missing.asar' }), readOnly: true });
    assert.equal(read.resolved, false);
    assert.equal(read.reason, 'draft-not-shown');
    assert.equal(read.navigation.navigated, false);
    assert.equal(driver.calls.some(call => Array.isArray(call) && call[0] === 'openNewSession'), false);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

// ------------------------------------------------ the head is where the first turn is

test('a first turn is still found after the transcript grows past the old tail window', async () => {
  const host1 = await host({ sessions: [] });
  try {
    const marker = markerLine('request-huge', 'fa-huge-20261104');
    await host1.write(record(), [enqueueLine(`long task\n\n${marker}`)]);
    const file = await findTranscript({ env: host1.env, nativeSessionId: SESSION, workspace: CWD });
    const filler = 'x'.repeat(2000);
    const lines = [];
    for (let index = 0; index < 4800; index += 1) {
      lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
        message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `${index}-${filler}` }] } }));
    }
    await writeFile(file, (await readFile(file, 'utf8')) + lines.join('\n') + '\n');
    assert.ok((await readFile(file)).length > 8 * 1024 * 1024, 'the transcript is larger than the old tail window');
    const found = await findCreatedSession({ workspace: CWD, requestId: 'request-huge', bindingNonce: 'fa-huge-20261104' },
      { env: host1.env, isAlive: host1.isAlive });
    assert.equal(found.nativeSessionId, SESSION);
    assert.equal(found.submittedBy, 'enqueue');
    assert.equal(found.firstInput.hasMarker, true);
    const binding = await firstTurnBinding({ env: host1.env, record: await resolveNativeSession(SESSION, { env: host1.env, isAlive: host1.isAlive }), marker });
    assert.equal(binding.complete, true);
    assert.equal(binding.markerCount, 1);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});

test('a first record larger than the initial window is read whole, not truncated', async () => {
  const host1 = await host({ sessions: [] });
  try {
    const marker = markerLine('request-big', 'fa-big-20261104');
    const big = 'y'.repeat(1_500_000);
    await host1.write(record(), [enqueueLine(`${big}\n\n${marker}`)]);
    const found = await findCreatedSession({ workspace: CWD, requestId: 'request-big', bindingNonce: 'fa-big-20261104' },
      { env: host1.env, isAlive: host1.isAlive });
    assert.equal(found.nativeSessionId, SESSION);
    assert.ok(found.firstInput.length > 1_500_000, 'the whole opener was read, not a prefix');
    assert.equal(found.firstInput.hasMarker, true);
  } finally { await rm(host1.dir, { recursive: true, force: true }); }
});