// The release guard in front of `thread/unsubscribe`.
//
// One renderer subscription per thread is all the desktop has, so a plugin release that is
// not gated on the desktop's own view state would drop the user's open thread. Three layers
// are pinned here: the page checks (route / mounted lease / stream role, known values only),
// the token-bound prepare → commit credential, and the transport gate, which watches the
// socket's own target lifecycle, re-reads the window list around the asynchronous role read,
// and honours a synchronous local permission right before the commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pageMcpRequest, pageThreadUnsubscribeGuard, pageDropReleaseHandoff,
  threadUnsubscribePrepareExpression, threadUnsubscribeSendExpression, threadViewProbeExpression,
  releaseCodexThreadNative, createCodexNativeRpc, nativeRpcExpression, appPageTargets,
  RELEASE_STATUSES, RELEASE_GUARD_INTERNALS, RELEASE_CLOCK_TOLERANCE_MS,
  pageAppClient, pageReadUserInput, pageReplyUserInput,
  readCodexUserInput, replyCodexUserInput, userInputReadExpression, userInputReplyExpression,
} from '../src/codex-ipc.mjs';

const THREAD = 'thread-abc';
const OTHER = 'thread-other';
const ORIGIN = 'app://-/';
const ENTRY = `${ORIGIN}assets/348410.792d1c9584.js`;
const TOKEN = 'app-scope-token';
const CREDENTIAL = 'release-a';
const REQUEST = { id: 'futureaide-release-test', method: 'thread/unsubscribe', params: { threadId: THREAD } };
const MAIN = { type: 'page', id: 'page-1', url: `${ORIGIN}index.html` };
const OVERLAY = { type: 'page', id: 'page-2', url: `${ORIGIN}index.html?initialRoute=%2Favatar-overlay` };
const DETACHED = { type: 'page', id: 'page-3', url: `${ORIGIN}detached-window.html?initialRoute=%2Fthread` };
// /json/list answers with `id`; CDP TargetInfo answers with `targetId`. Both real shapes.
const CDP_MAIN = { type: 'page', targetId: 'page-1', url: `${ORIGIN}index.html` };
const CDP_OVERLAY = { type: 'page', targetId: 'page-2', url: `${ORIGIN}index.html?initialRoute=%2Favatar-overlay` };
const CDP_DETACHED = { type: 'page', targetId: 'page-3', url: `${ORIGIN}detached-window.html?initialRoute=%2Fthread` };

function standIn({
  mounted = false, role = null, roleResult = undefined, route = { routeKind: 'home' },
  routeSequence = null, token = TOKEN, scopeToken = token, scripts = [{ src: ENTRY }],
  registry = 'ok', bridge = 'respond', hostStatus = 'ready', familyBindings = 'map',
  mountedRegistry = 'weakmap', routeModule = 'ok', handoff = null,
  location = `${ORIGIN}index.html`, rootChildren = 0, shellRegistry = 'ok', readyState = 'complete',
  response = { result: { status: 'unsubscribed' } }, onRoleRead,
} = {}) {
  const atom = { toString: () => 'view-lease' };
  const weak = mountedRegistry === 'weakmap' ? new WeakMap() : mountedRegistry;
  if (mounted === true && typeof weak.set === 'function') weak.set(atom, true);
  const hostClientsAtom = { key: 'host-clients' };
  const viewLeaseAtom = { key: 'view-lease-family' };
  const bindings = new Map([[JSON.stringify({ hostId: 'local', threadId: THREAD }), { value: { atom } }]]);
  const sent = [], listeners = new Set(), roleReads = [];
  let routeReads = 0;
  const scope = {
    node: {
      token: scopeToken,
      familyBindings: familyBindings === 'map' ? new Map([[viewLeaseAtom, bindings]]) : familyBindings,
      store: { name: 'jotai-store' },
    },
    get: (candidate, hostId) => (candidate === hostClientsAtom && hostId === 'local'
      ? { status: hostStatus, client: { rpc: {
        getStreamRole: async id => {
          roleReads.push(id);
          if (typeof onRoleRead === 'function') await onRoleRead({ weak, atom });
          return roleResult !== undefined ? roleResult({ role }) : role;
        },
      } } }
      : undefined),
  };
  const routeValue = () => {
    if (routeSequence) {
      const value = routeSequence[Math.min(routeReads, routeSequence.length - 1)];
      routeReads += 1;
      return value;
    }
    return route;
  };
  const modules = {
    [RELEASE_GUARD_INTERNALS.scopeModule]: { exports: { [RELEASE_GUARD_INTERNALS.scopeAccessor]: () => ({ scope, abortController: {} }) } },
    [RELEASE_GUARD_INTERNALS.tokenModule]: { exports: { [RELEASE_GUARD_INTERNALS.tokenAccessor]: token } },
    [RELEASE_GUARD_INTERNALS.hostClientsModule]: { exports: { [RELEASE_GUARD_INTERNALS.hostClientsAccessor]: hostClientsAtom } },
    [RELEASE_GUARD_INTERNALS.viewLeaseModule]: { exports: { [RELEASE_GUARD_INTERNALS.viewLeaseAccessor]: viewLeaseAtom } },
    [RELEASE_GUARD_INTERNALS.jotaiModule]: { exports: { [RELEASE_GUARD_INTERNALS.jotaiMountedAccessor]: store => [store, weak] } },
  };
  if (routeModule === 'ok') {
    modules[RELEASE_GUARD_INTERNALS.routeModule] = { exports: {
      [RELEASE_GUARD_INTERNALS.routeAccessor]: () => {
        const value = routeValue();
        return value === undefined ? undefined : { value };
      } } };
  }
  const registryObject = Object.assign(function registry() {}, { c: modules, d() {} });
  // The dedicated shell entry has its own registry: the detached initialiser, and none of
  // the main window's scope/route/host/view modules.
  const shellModules = shellRegistry === 'no-initialiser'
    ? { [RELEASE_GUARD_INTERNALS.detachedShellModule]: { exports: { somethingElse: 1 } } }
    : (shellRegistry === 'with-main-modules'
      ? { [RELEASE_GUARD_INTERNALS.detachedShellModule]: { exports: { [RELEASE_GUARD_INTERNALS.detachedShellModuleAccessor]: () => {} } },
        [RELEASE_GUARD_INTERNALS.scopeModule]: { exports: {} } }
      : { [RELEASE_GUARD_INTERNALS.detachedShellModule]: { exports: { [RELEASE_GUARD_INTERNALS.detachedShellModuleAccessor]: () => {} } },
        [RELEASE_GUARD_INTERNALS.tokenModule]: { exports: { [RELEASE_GUARD_INTERNALS.tokenAccessor]: token } } });
  const shellRegistryObject = Object.assign(function shellRegistry() {}, { c: shellModules, d() {} });
  const win = {
    location: { href: location },
    document: {
      readyState,
      querySelectorAll: () => scripts.map(node => ({ src: node.src })),
      querySelector: selector => (selector === '#root' ? { hasChildNodes: () => rootChildren > 0 } : null),
    },
    addEventListener: (type, listener) => { if (type === 'message') listeners.add(listener); },
    removeEventListener: (type, listener) => { if (type === 'message') listeners.delete(listener); },
    electronBridge: {
      sendMessageFromView: async message => {
        sent.push(message);
        if (bridge === 'throw') throw new Error('bridge unavailable');
        if (bridge !== 'respond') return;
        setTimeout(() => {
          for (const listener of [...listeners]) {
            listener({ data: { type: 'mcp-response', hostId: 'local', message: { id: message.request.id, ...response } } });
          }
        }, 0);
      },
    },
  };
  if (handoff) win.__futureaideReleaseHandoffs = new Map([[handoff.threadId, handoff]]);
  const load = async url => {
    if (registry === 'throw') throw new Error('import failed');
    if (String(url).endsWith(RELEASE_GUARD_INTERNALS.detachedShellEntryAssetPath)) {
      if (shellRegistry === 'throw') throw new Error('shell import failed');
      return { __webpack_require__: shellRegistryObject };
    }
    return { __webpack_require__: registry === 'ok' ? registryObject : registry };
  };
  return { win, load, sent, weak, atom, roleReads, bindings, viewLeaseAtom };
}

const runGuard = (fixture, request = REQUEST, options = {}, timeoutMs = 2000) => pageThreadUnsubscribeGuard(
  fixture.win, pageMcpRequest, fixture.load, RELEASE_GUARD_INTERNALS, THREAD, request, timeoutMs, options);
const prepare = (fixture, credential = CREDENTIAL) => runGuard(fixture, null, { handoffToken: credential });
/** A plain read-only probe: no credential, so it may never prepare anything. */
const pureProbe = (fixture, options = {}) => runGuard(fixture, null, options);
const commit = (fixture, credential = CREDENTIAL, checkedAt = Date.now()) =>
  runGuard(fixture, REQUEST, { skipRoleRead: true, handoffToken: credential, checkedAt });
/** The transport's own sequence: prepare, then commit. */
const releasePair = async (fixture, credential = CREDENTIAL) => {
  const prepared = await prepare(fixture, credential);
  if (prepared.status !== 'observed') return prepared;
  return await commit(fixture, credential);
};

test('a mounted view lease refuses the call without touching the bridge', async () => {
  const fixture = standIn({ mounted: true });
  const result = await releasePair(fixture);
  assert.deepEqual([result.status, result.reason], ['inUse', 'view-mounted']);
  assert.equal(fixture.sent.length, 0, 'a thread the user is looking at is never released');
});

test('the route is read as routeKind and refuses before the role is even asked', async () => {
  const fixture = standIn({ route: { routeKind: 'local-thread', conversationId: THREAD } });
  const result = await releasePair(fixture);
  assert.deepEqual([result.status, result.reason], ['inUse', 'view-route']);
  assert.deepEqual(fixture.roleReads, []);
  assert.equal(fixture.sent.length, 0);

  const elsewhere = standIn({ route: { routeKind: 'local-thread', conversationId: OTHER } });
  assert.equal((await releasePair(elsewhere)).status, 'unsubscribed', 'another thread on screen is not this thread');
  assert.equal(elsewhere.sent.length, 1);
});

test('only known route kinds are clear; anything else defers', async () => {
  for (const routeKind of ['home', 'new-thread-panel', 'chatgpt-thread']) {
    const fixture = standIn({ route: { routeKind } });
    assert.equal((await releasePair(fixture)).status, 'unsubscribed', routeKind);
    assert.equal(fixture.sent.length, 1, routeKind);
  }
  for (const route of [
    { routeKind: 'settings' },
    { routeKind: 'client-local-thread', clientThreadId: THREAD },
    { routeKind: 'local-thread' },
    { conversationId: THREAD },
    null,
  ]) {
    const fixture = standIn({ route });
    const result = await releasePair(fixture);
    assert.deepEqual([result.status, result.reason], ['unverified', 'route-unknown'], JSON.stringify(route));
    assert.equal(fixture.sent.length, 0, JSON.stringify(route));
  }
});

test('only a successfully read, known role is a verdict', async () => {
  for (const role of [{ role: 'owner' }, { role: 'follower' }]) {
    const fixture = standIn({ role });
    assert.deepEqual([(await releasePair(fixture)).status, (await releasePair(fixture)).reason],
      ['inUse', `stream-role:${role.role}`]);
    assert.equal(fixture.sent.length, 0);
  }
  for (const value of [undefined, true, 'owner', {}, { role: 'watcher' }]) {
    const fixture = standIn({ roleResult: () => value });
    const result = await releasePair(fixture);
    assert.deepEqual([result.status, result.reason], ['unverified', 'role-unknown'], String(value));
    assert.equal(fixture.sent.length, 0, String(value));
  }
  const throwing = standIn({ roleResult: () => { throw new Error('role read failed'); } });
  assert.deepEqual([(await releasePair(throwing)).status, (await releasePair(throwing)).reason],
    ['unverified', 'role-read-failed']);
  assert.equal(throwing.sent.length, 0);
});

test('a view or navigation that appears while the role is read refuses the call', async () => {
  const lateMount = standIn({ onRoleRead: ({ weak, atom }) => { weak.set(atom, true); } });
  assert.equal((await releasePair(lateMount)).reason, 'view-mounted-late');
  assert.equal(lateMount.sent.length, 0);

  const lateRoute = standIn({ routeSequence: [{ routeKind: 'home' },
    { routeKind: 'local-thread', conversationId: THREAD }] });
  assert.equal((await releasePair(lateRoute)).reason, 'view-route-late');
  assert.equal(lateRoute.sent.length, 0);
});

test('a clear thread is released once, as an object on the local host', async () => {
  const fixture = standIn({ response: { result: { status: 'notLoaded' } } });
  const prepared = await prepare(fixture);
  assert.deepEqual(prepared, { status: 'observed', mounted: false, role: null });
  assert.equal(fixture.sent.length, 0, 'the prepare half never sends');
  const result = await commit(fixture);
  assert.deepEqual([result.status, result.dispatched], ['notLoaded', true]);
  assert.equal(fixture.sent.length, 1);
  const [message] = fixture.sent;
  assert.equal(message.type, 'mcp-request');
  assert.equal(message.hostId, 'local');
  assert.equal(typeof message.request, 'object', 'the bridge takes an object, not JSON text');
  assert.deepEqual(message.request.params, { threadId: THREAD });
});

test('the credential is one-shot, token-bound and short-lived', async () => {
  // A different token is not the credential this page prepared.
  const wrongToken = standIn({});
  await prepare(wrongToken, 'release-a');
  assert.deepEqual([(await commit(wrongToken, 'release-b')).reason], ['handoff-stale']);
  assert.equal(wrongToken.sent.length, 0);

  // Used once: the second commit finds nothing to spend.
  const once = standIn({});
  await prepare(once);
  await commit(once);
  assert.equal(once.sent.length, 1);
  assert.deepEqual([(await commit(once)).reason], ['handoff-missing']);
  assert.equal(once.sent.length, 1);

  // A read-only probe leaves no credential behind.
  const probeOnly = standIn({});
  assert.equal((await probeOnly.win.electronBridge ? true : true), true);
  await pageThreadUnsubscribeGuard(probeOnly.win, pageMcpRequest, probeOnly.load,
    RELEASE_GUARD_INTERNALS, THREAD, null, 2000, {});
  assert.equal(probeOnly.win.__futureaideReleaseHandoffs, undefined, 'a plain probe prepares nothing');
  assert.deepEqual([(await commit(probeOnly)).reason], ['handoff-missing']);

  // An expired credential is not spent.
  const expired = standIn({ handoff: { token: CREDENTIAL, internals: RELEASE_GUARD_INTERNALS,
    threadId: THREAD, at: Date.now() - RELEASE_GUARD_INTERNALS.handoffMaxAgeMs - 1000 } });
  assert.deepEqual([(await commit(expired)).reason], ['handoff-expired']);
  assert.equal(expired.sent.length, 0);
});

test('a resume for the thread drops the prepared credential before it goes out', async () => {
  const fixture = standIn({});
  await prepare(fixture);
  assert.ok(fixture.win.__futureaideReleaseHandoffs?.has(THREAD), 'prepared');
  // The transport clears it from inside the resume expression, on the same page.
  pageDropReleaseHandoff(fixture.win, THREAD);
  assert.equal(fixture.win.__futureaideReleaseHandoffs, undefined);
  const late = await commit(fixture);
  assert.deepEqual([late.status, late.reason], ['unverified', 'handoff-missing']);
  assert.equal(fixture.sent.length, 0, 'the old commit never lands after a resume');

  // And the resume expression really carries that prelude.
  assert.match(nativeRpcExpression('thread/resume', { threadId: THREAD }, 1000), /pageDropReleaseHandoff/);
  assert.equal(nativeRpcExpression('thread/read', { threadId: THREAD }, 1000).includes('pageDropReleaseHandoff'), false);
});

test('a stale commit cannot erase a current credential for either thread', async () => {
  const fixture = standIn();
  const otherThread = 'another-managed-thread';
  const guardOther = (request, options) => pageThreadUnsubscribeGuard(fixture.win, pageMcpRequest,
    fixture.load, RELEASE_GUARD_INTERNALS, otherThread, request, 2000, options);
  await prepare(fixture, 'a-old');
  await prepare(fixture, 'a-current');
  assert.equal((await guardOther(null, { handoffToken: 'b-current' })).status, 'observed');

  assert.equal((await commit(fixture, 'a-old')).status, 'unverified');
  const request = { ...REQUEST, id: 'another-release', params: { threadId: otherThread } };
  assert.equal((await guardOther(request, { skipRoleRead: true, handoffToken: 'b-current', checkedAt: Date.now() })).status,
    'unsubscribed');
  assert.equal((await commit(fixture, 'a-current')).status, 'unsubscribed');
  assert.deepEqual(fixture.sent.map(message => message.request.params.threadId), [otherThread, THREAD]);
});

test('a queued commit will not spend an old window check', async () => {
  const fixture = standIn();
  await prepare(fixture);
  const queuedAt = Date.now() - 1000;
  assert.deepEqual(await commit(fixture, CREDENTIAL, queuedAt), { status: 'unverified', reason: 'window-check-stale' });
  assert.equal(fixture.sent.length, 0);
});

test('an unknown or errored answer is handed back, never promoted to success', async () => {
  assert.equal((await releasePair(standIn({ response: { result: { status: 'something-new' } } }))).status, 'something-new');
  assert.equal((await releasePair(standIn({ response: { result: {} } }))).status, 'unverified');
  const rejected = await releasePair(standIn({ response: { error: { code: -32000, message: 'nope' } } }));
  assert.deepEqual([rejected.status, rejected.reason], ['unverified', 'rpc-rejected']);
  const thrown = await releasePair(standIn({ bridge: 'throw' }));
  assert.deepEqual([thrown.status, thrown.reason], ['unverified', 'rpc-rejected']);
  const silent = standIn({ bridge: 'silent' });
  await prepare(silent);
  assert.deepEqual([(await commit(silent)).status], ['unverified']);
});

test('every unknown piece of this desktop answers unverified and sends nothing', async () => {
  const cases = [
    ['no-entry-asset', standIn({ scripts: [] })],
    ['no-entry-asset', standIn({ scripts: [{ src: `${ORIGIN}assets/348410.0000000000.js` }] })],
    ['module-import-failed', standIn({ registry: 'throw' })],
    ['no-module-registry', standIn({ registry: {} })],
    ['scope-token-mismatch', standIn({ scopeToken: 'another-build' })],
    ['no-route-state', standIn({ routeModule: 'missing' })],
    ['scope-shape-mismatch', standIn({ familyBindings: {} })],
    ['no-mounted-registry', standIn({ mountedRegistry: {} })],
    ['no-host-rpc', standIn({ hostStatus: 'request-only' })],
  ];
  for (const [reason, fixture] of cases) {
    const result = await releasePair(fixture);
    assert.deepEqual([result.status, result.reason], ['unverified', reason], reason);
    assert.equal(fixture.sent.length, 0, reason);
  }
});

test('the probe reports what the guard sees and never sends or takes a lease', async () => {
  const probe = fixture => pageThreadUnsubscribeGuard(fixture.win, pageMcpRequest, fixture.load,
    RELEASE_GUARD_INTERNALS, THREAD, null, 2000, {});
  assert.deepEqual(await probe(standIn({})), { status: 'observed', mounted: false, role: null });
  assert.deepEqual([(await probe(standIn({ mounted: true }))).reason], ['view-mounted']);
  assert.deepEqual([(await probe(standIn({ route: { routeKind: 'local-thread', threadId: THREAD } }))).reason], ['view-route']);

  const moving = standIn({});
  moving.weak.set(moving.atom, true);
  assert.equal((await probe(moving)).reason, 'view-mounted');
  moving.weak.delete(moving.atom);
  assert.equal((await probe(moving)).status, 'observed');
  assert.equal(moving.sent.length, 0);
  assert.equal(moving.win.__futureaideReleaseHandoffs, undefined);
});

test('the avatar overlay attachment is excluded, a real detached window is not', () => {
  const targets = [MAIN, OVERLAY, DETACHED, { type: 'other', id: 'worker-1', url: `${ORIGIN}index.html` }];
  assert.deepEqual(appPageTargets(targets), [
    { id: 'page-1', url: `${ORIGIN}index.html` },
    { id: 'page-3', url: `${ORIGIN}detached-window.html?initialRoute=%2Fthread` },
  ]);
  assert.deepEqual(appPageTargets([MAIN, OVERLAY]), [{ id: 'page-1', url: `${ORIGIN}index.html` }]);
  assert.equal(appPageTargets(null), null);

  for (const url of [
    `${ORIGIN}index.html?initialRoute=%2Favatar-overlay#x`,
    `${ORIGIN}index.html?initialRoute=%2Favatar-overlay&initialRoute=%2Favatar-overlay`,
    `${ORIGIN}index.html?initialRoute=%2Favatar-overlay&theme=dark`,
    `${ORIGIN}detached-window.html?initialRoute=%2Favatar-overlay`,
    `${ORIGIN}avatar-overlay.html`,
    `${ORIGIN}index.html?initialRoute=%2Favatar-overlayx`,
  ]) {
    assert.equal(appPageTargets([{ type: 'page', id: 'page-x', url }]).length, 1, `${url} is not the avatar attachment`);
  }
});

test('expressions carry one version table, a token per half, and no plain path', () => {
  const prepareExpression = threadUnsubscribePrepareExpression({ threadId: THREAD, token: CREDENTIAL });
  const commitExpression = threadUnsubscribeSendExpression({ threadId: THREAD, token: CREDENTIAL, checkedAt: Date.now() });
  const probeExpression = threadViewProbeExpression({ threadId: THREAD });
  for (const expression of [prepareExpression, commitExpression, probeExpression]) {
    assert.ok(expression.includes(JSON.stringify(RELEASE_GUARD_INTERNALS)));
    assert.match(expression, /routeKind/);
    assert.match(expression, /const hostId = 'local'/);
    assert.equal(expression.includes('__futureaideImport'), false, 'no window hook is read');
  }
  assert.match(prepareExpression, /handoffToken:"release-a"/);
  assert.match(commitExpression, /skipRoleRead:true/);
  assert.match(probeExpression, /handoffToken:null/, 'a plain probe cannot prepare a credential');
  assert.throws(() => threadUnsubscribePrepareExpression({ threadId: THREAD }), /token/);
  assert.throws(() => threadUnsubscribeSendExpression({ threadId: THREAD }), /token/);
  assert.throws(() => nativeRpcExpression('thread/unsubscribe', { threadId: THREAD }, 1000),
    /Unsupported native Desktop method/);
});

test('releaseCodexThreadNative normalises the answer and forwards the permission', async () => {
  const seen = [];
  const request = async (method, params, options) => {
    seen.push({ method, params, options });
    return { status: 'unsubscribed' };
  };
  const canRelease = () => true;
  const signal = { aborted: false };
  assert.deepEqual(await releaseCodexThreadNative(THREAD, { request, canRelease, signal }),
    { status: 'unsubscribed', reason: undefined });
  assert.deepEqual(seen[0], { method: 'thread/unsubscribe', params: { threadId: THREAD }, options: { canRelease, signal } });
  assert.equal((await releaseCodexThreadNative(THREAD, { request: async () => ({ status: 'inUse' }) })).status, 'inUse');
  assert.equal((await releaseCodexThreadNative(THREAD, { request: async () => ({}) })).status, 'unverified');
  await assert.rejects(() => releaseCodexThreadNative('', { request }), /thread id/);
  assert.deepEqual(RELEASE_STATUSES.refused, ['inUse', 'unverified', 'notSent']);
});

test('an owner that appears after the prepare stops the commit', async () => {
  let role = null;
  const fixture = standIn({ roleResult: () => role });
  assert.deepEqual(await prepare(fixture), { status: 'observed', mounted: false, role: null });
  role = { role: 'owner' };
  const result = await commit(fixture);
  assert.deepEqual([result.status, result.reason], ['inUse', 'stream-role:owner']);
  assert.equal(fixture.sent.length, 0, 'the owner that arrived after the prepare is honoured');
});

test('a slow role re-read invalidates the window snapshot', async () => {
  const clock = fakeClock();
  try {
    let reads = 0;
    const fixture = standIn({ roleResult: () => {
      reads += 1;
      if (reads > 1) clock.advance(150);
      return null;
    } });
    await prepare(fixture);
    const checkedAt = Date.now();
    const result = await commit(fixture, CREDENTIAL, checkedAt);
    assert.deepEqual([result.status, result.reason], ['unverified', 'window-check-stale']);
    assert.equal(fixture.sent.length, 0);
  } finally { clock.restore(); }
});

test('a role read that fails at the commit stops the send', async () => {
  let reads = 0;
  const fixture = standIn({ roleResult: () => {
    reads += 1;
    if (reads > 1) throw new Error('role read failed');
    return null;
  } });
  await prepare(fixture);
  const result = await commit(fixture);
  assert.deepEqual([result.status, result.reason], ['unverified', 'role-read-failed']);
  assert.equal(fixture.sent.length, 0);
});

test('the commit never imports again, and only spends its own credential', async () => {
  const reuse = standIn({});
  await prepare(reuse);
  reuse.win.document = { querySelectorAll: () => { throw new Error('no document at commit time'); } };
  assert.equal((await commit(reuse)).status, 'unsubscribed', 'the confirmed module is reused');
  assert.equal(reuse.sent.length, 1);

  const two = standIn({});
  await prepare(two, 'release-a');
  await prepare(two, 'release-b');
  assert.deepEqual([(await commit(two, 'release-a')).reason], ['handoff-stale'], 'the older token spends nothing');
  assert.equal(two.sent.length, 0);
  assert.equal((await commit(two, 'release-b')).status, 'unsubscribed', 'the newer credential still works');
  assert.equal(two.sent.length, 1);
});

test('a resume during the commit role read cancels the old release', async () => {
  // A same-name dispatch after the prepare issues thread/resume, whose prelude drops the
  // credential. The commit is already past its first checks and is waiting on the role
  // read, so it has to re-check the map afterwards instead of trusting the copy it holds.
  let reads = 0;
  const fixture = standIn({ roleResult: async () => {
    reads += 1;
    if (reads > 1) pageDropReleaseHandoff(fixture.win, THREAD);
    return null;
  } });
  assert.deepEqual(await prepare(fixture), { status: 'observed', mounted: false, role: null });
  const result = await commit(fixture);
  assert.deepEqual([result.status, result.reason], ['unverified', 'handoff-cancelled']);
  assert.equal(fixture.sent.length, 0, 'the late commit never unsubscribes a thread the new round resumed');
});

test('the credential is consumed only by the attempt that still matches it', async () => {
  // A newer prepare for the same thread replaces the older credential while the commit is
  // waiting on the role read; the older commit must neither send nor spend the newer one.
  let reads = 0, replaced = false;
  const fixture = standIn({ roleResult: async () => {
    reads += 1;
    if (reads > 1 && !replaced) { replaced = true; await prepare(fixture, 'release-b'); }
    return null;
  } });
  await prepare(fixture, 'release-a');
  assert.deepEqual([(await commit(fixture, 'release-a')).reason], ['handoff-stale']);
  assert.equal(fixture.sent.length, 0);
  assert.ok(fixture.win.__futureaideReleaseHandoffs?.get(THREAD), 'the newer credential is untouched');
  assert.equal((await commit(fixture, 'release-b')).status, 'unsubscribed');
  assert.equal(fixture.sent.length, 1);
});

// ---------------------------------------------------------------------------------------
// The hidden `detached-window.html` shell, checked on the page guard itself.
// ---------------------------------------------------------------------------------------

const SHELL_URL = `${ORIGIN}detached-window.html?initialRoute=%2Fdetached-window`;
const SHELL_ENTRY = `${ORIGIN}assets/357055.2b78f20048.js`;
/** Only the dedicated entry: the shell has no main entry of its own. */
const shellScripts = [{ src: SHELL_ENTRY }];

test('the empty detached shell is observed, not treated as a view', async () => {
  const fixture = standIn({ location: SHELL_URL, scripts: shellScripts, rootChildren: 0 });
  assert.deepEqual(await pureProbe(fixture), { status: 'observed', view: 'detached-shell', mounted: false, role: null });
  assert.equal(fixture.sent.length, 0, 'the shell probe never touches the bridge');
});

test('a detached shell URL with content is not taken as empty', async () => {
  const fixture = standIn({ location: SHELL_URL, scripts: shellScripts, rootChildren: 3 });
  assert.deepEqual([(await pureProbe(fixture)).status, (await pureProbe(fixture)).reason],
    ['unverified', 'shell-not-empty']);
  assert.equal(fixture.sent.length, 0);
});

test('a detached shell URL without the dedicated entry or with the wrong shape defers', async () => {
  const cases = [
    // Two initialRoute values, or a fragment, are not the exact shell route.
    [{ location: `${SHELL_URL}&x=1`, scripts: shellScripts }, 'no-entry-asset'],
    [{ location: `${SHELL_URL}#frag`, scripts: shellScripts }, 'no-entry-asset'],
    // A different asset path for the shell entry is not the known one.
    [{ location: SHELL_URL, scripts: [{ src: `${ORIGIN}assets/357055.0000000000.js` }] }, 'no-entry-asset'],
    // The route must be this app's; anything else is checked as an ordinary page.
    [{ location: 'about:blank', scripts: shellScripts }, 'no-entry-asset'],
    // The dedicated entry loaded but its registry lacks the initialiser.
    [{ location: SHELL_URL, scripts: shellScripts, shellRegistry: 'no-initialiser' }, 'shell-module-missing'],
    // Its registry also carries a main-window module: this is not the shell shape.
    [{ location: SHELL_URL, scripts: shellScripts, shellRegistry: 'with-main-modules' }, 'shell-shape-mismatch'],
    [{ location: SHELL_URL, scripts: shellScripts, shellRegistry: 'throw' }, 'shell-entry-import-failed'],
  ];
  for (const [options, reason] of cases) {
    const fixture = standIn(options);
    assert.deepEqual([(await pureProbe(fixture)).status, (await pureProbe(fixture)).reason],
      ['unverified', reason], JSON.stringify(options.location));
    assert.equal(fixture.sent.length, 0, JSON.stringify(options.location));
  }
});

test('a detached shell URL that carries the main entry is checked like any window', async () => {
  // Same URL, but the page is a real renderer: the shell shortcut must not fire.
  const fixture = standIn({ location: SHELL_URL, scripts: [{ src: ENTRY }, { src: SHELL_ENTRY }],
    route: { routeKind: 'local-thread', conversationId: THREAD } });
  assert.deepEqual([(await pureProbe(fixture)).status, (await pureProbe(fixture)).reason], ['inUse', 'view-route']);
  assert.equal(fixture.sent.length, 0);
});

test('a probe pinned to another page refuses before it imports anything', async () => {
  const fixture = standIn({ location: `${ORIGIN}index.html`, scripts: [{ src: ENTRY }] });
  const result = await pureProbe(fixture, { expectedPageUrl: SHELL_URL });
  assert.deepEqual([result.status, result.reason], ['unverified', 'page-mismatch']);
  assert.equal(fixture.sent.length, 0);
  // A blank target is never a page to read.
  assert.deepEqual([(await pureProbe(fixture, { expectedPageUrl: 'about:blank' })).reason], ['page-mismatch']);
  // Still-loading documents wait: the module must have run in the page that is really there.
  const loading = standIn({ location: `${ORIGIN}index.html`, scripts: [{ src: ENTRY }], readyState: 'loading' });
  assert.deepEqual([(await pureProbe(loading, { expectedPageUrl: `${ORIGIN}index.html` })).reason], ['page-not-ready']);
  assert.equal(loading.sent.length, 0);
  // The same page, named correctly, goes on to the normal checks.
  assert.match(threadViewProbeExpression({ threadId: THREAD, expectedPageUrl: `${ORIGIN}index.html` }),
    /expectedPageUrl:"app:\/\/-\/index\.html"/);
});

test('a prepare never reports the shell, and a committed shell is never released', async () => {
  const fixture = standIn({ location: SHELL_URL, scripts: shellScripts });
  // The prepare half carries a credential, so the read-only shell branch is not eligible.
  const prepared = await prepare(fixture, CREDENTIAL);
  assert.equal(prepared.status, 'unverified');
  assert.equal(prepared.reason, 'no-entry-asset');
  assert.equal(fixture.sent.length, 0);
  assert.deepEqual([(await commit(fixture)).reason], ['handoff-missing']);
  assert.equal(fixture.sent.length, 0);
});

test('the commit is timed from the earliest observation, not the last refresh', async () => {
  const clock = fakeClock();
  try {
    const observed = Date.now();
    const fixture = standIn({});
    const t = pageTransport({ guard: fixture, hooks: { beforeTargetsReply: () => clock.advance(200) } });
    assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
      { status: 'unverified', reason: 'window-check-stale' }, 'the renderer refuses the stale start');
    assert.equal(fixture.sent.length, 0, 'nothing was sent');
    // The extra page was read at `observed` (minus the 5 ms conservative shift), the snapshot
    // 200 ms later: the commit must carry the earlier of the two.
    const commit = t.main().sent.find(message => String(message.params?.expression ?? '').includes('skipRoleRead:true'));
    assert.match(String(commit.params.expression), new RegExp(`checkedAt:${observed - RELEASE_CLOCK_TOLERANCE_MS}\\b`),
      'the earliest observation is what the renderer measures');
    assert.notEqual(clock.now(), observed, 'the snapshot really did happen later');
    t.rpc.close();
  } finally { clock.restore(); }
});

test('a one-millisecond cross-process stamp is accepted, a ten-millisecond lie is not, and the window is not extended', async () => {
  const clock = fakeClock();
  try {
    const sent = Date.now();
    const fine = pageTransport({ extra: 'future-1', guard: standIn({}) });
    assert.equal((await fine.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true })).status,
      'unsubscribed', 'a millisecond of rounding is not a lie');
    const sentMessage = fine.main().sent.find(message => String(message.params?.expression ?? '').includes('skipRoleRead:true'));
    assert.match(String(sentMessage.params.expression), new RegExp(`checkedAt:${sent - RELEASE_CLOCK_TOLERANCE_MS}\\b`),
      'the stamp moves 5 ms earlier for the commit, never later');
    fine.rpc.close();

    const coarse = pageTransport({ extra: 'future-10' });
    assert.deepEqual(await coarse.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
      { status: 'unverified', reason: 'extra-page-observation' });
    coarse.rpc.close();

    // The deadline itself is unchanged: 96 ms of real age already counts as 101 ms.
    const fixture = standIn({});
    await prepare(fixture);
    clock.advance(96);
    const stale = await commit(fixture, CREDENTIAL, Date.now() - 96 - RELEASE_CLOCK_TOLERANCE_MS);
    assert.deepEqual([stale.status, stale.reason], ['unverified', 'window-check-stale']);
    assert.equal(fixture.sent.length, 0);
  } finally { clock.restore(); }
});

test('a snapshot older than the window is refused by the renderer, not by a sleep', async () => {
  const clock = fakeClock();
  try {
    const fixture = standIn({});
    await prepare(fixture);
    clock.advance(120);
    const result = await commit(fixture, CREDENTIAL, Date.now() - 120);
    assert.deepEqual([result.status, result.reason], ['unverified', 'window-check-stale']);
    assert.equal(fixture.sent.length, 0);
  } finally { clock.restore(); }
});

test('a slow connect is fine while the observation itself is fresh', async () => {
  const clock = fakeClock();
  try {
    const t = pageTransport({ guard: standIn({}), hooks: { beforeExtraReply: () => clock.advance(300) } });
    assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
      { status: 'unsubscribed', dispatched: true },
      'connect and import time does not count against the view');
    t.rpc.close();
  } finally { clock.restore(); }
});

test('an observation without its own time is unknown, and pages are read before the snapshot', async () => {
  const clock = fakeClock();
  try {
    const missing = pageTransport({ extra: 'no-observation' });
    assert.deepEqual(await missing.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
      { status: 'unverified', reason: 'extra-page-observation' });
    missing.rpc.close();

    const order = [];
    const t = pageTransport({ hooks: {
      beforeExtraReply: () => order.push('extra'),
      beforeTargetsReply: () => order.push('targets'),
    } });
    assert.equal((await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true })).status, 'unsubscribed');
    assert.deepEqual(order, ['extra', 'targets'], 'every extra page is read before the final snapshot');
    t.rpc.close();
  } finally { clock.restore(); }
});

// ---------------------------------------------------------------------------------------
// Transport: watch, window snapshots around the asynchronous role read, and the permission.
// ---------------------------------------------------------------------------------------

function transport({ pages = [MAIN, OVERLAY], initial = [CDP_MAIN, CDP_OVERLAY], finalTargets = [CDP_MAIN, CDP_OVERLAY],
  found = { webSocketUrl: 'ws://127.0.0.1:1/devtools/page/x', targetId: 'page-1' },
  during = null, tracking = true, acknowledge = true, sentTargets = [],
  probe = { status: 'observed', mounted: false, role: null } } = {}) {
  const sockets = [], order = [];
  class FakeSocket {
    constructor(url) {
      this.url = url; this.sent = []; this.listeners = {}; sockets.push(this);
      queueMicrotask(() => this.fire('open', {}));
    }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    removeEventListener() { }
    fire(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
    reply(value) { this.fire('message', { data: JSON.stringify(value) }); }
    send(payload) {
      const message = JSON.parse(payload);
      this.sent.push(message);
      if (message.method === 'Target.setDiscoverTargets') {
        order.push('watch');
        queueMicrotask(() => {
          if (acknowledge) this.reply({ id: message.id, result: {} });
          if (!tracking) return;
          for (const target of initial) this.reply({ method: 'Target.targetCreated', params: { targetInfo: target } });
        });
        return;
      }
      if (message.method === 'Target.getTargets') {
        order.push('targets');
        queueMicrotask(() => {
          this.reply({ id: message.id, result: { targetInfos: finalTargets } });
        });
        return;
      }
      if (message.method !== 'Runtime.evaluate') return;
      const expression = String(message.params?.expression ?? '');
      if (expression.includes('skipRoleRead:true')) order.push('commit'); else order.push('prepare');
      const answer = expression.includes('skipRoleRead:true') ? { status: 'unsubscribed', dispatched: true } : probe;
      queueMicrotask(() => {
        if (!expression.includes('skipRoleRead:true')) during?.({ socket: this, rpc });
        this.reply({ id: message.id, result: { result: { value: answer } } });
      });
    }
    emit(method, params) { this.reply({ method, params }); }
    close() { }
  }
  const reads = [];
  const rpc = createCodexNativeRpc({
    discover: async () => found,
    appPages: async argument => {
      reads.push(argument);
      order.push('pages');
      return appPageTargets(pages);
    },
    WebSocketImpl: FakeSocket,
    targetHandshakeMs: 5000,
  });
  return { rpc, sockets, reads, found, order, sentTargets };
}

const evaluations = socket => socket.sent.filter(message => String(message.params?.expression ?? '')
  .includes('pageThreadUnsubscribeGuard')).length;

test('a clear desktop releases: watch, prepare, then commit on the same socket', async () => {
  const t = transport();
  assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
    { status: 'unsubscribed', dispatched: true });
  assert.equal(t.sockets.length, 1);
  assert.deepEqual(t.reads, [t.found], 'the first window list is read on the socket endpoint');
  assert.deepEqual(t.order, ['watch', 'pages', 'prepare', 'targets', 'commit'],
    'the watch starts before the first snapshot, and the commit is last');
  assert.equal(evaluations(t.sockets[0]), 2, 'one prepare, one commit');
  t.rpc.close();
});

test('a release needs a synchronous true; anything else sends nothing', async () => {
  for (const [label, canRelease] of [
    ['missing', undefined],
    ['undefined answer', () => undefined],
    ['promise answer', async () => true],
    ['false answer', () => false],
    ['throwing', () => { throw new Error('nope'); }],
  ]) {
    const t = transport();
    assert.equal((await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease })).status,
      'notSent', label);
    assert.equal(t.sockets.length, 0, `${label}: nothing was even connected`);
    assert.equal(evaluations(t.sockets[0] ?? { sent: [] }), 0);
    t.rpc.close();
  }
});

test('a window opened while the role is read stops the release', async () => {
  const t = transport({ during: ({ socket }) => {
    socket.emit('Target.targetCreated', { targetInfo: CDP_DETACHED });
  } });
  assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
    { status: 'inUse', reason: 'window-check-changed' });
  assert.equal(evaluations(t.sockets[0]), 1, 'the commit never ran');
  t.rpc.close();
});

test('the final snapshot on the renderer socket catches a detached window missed by HTTP', async () => {
  const t = transport({ finalTargets: [CDP_MAIN, CDP_OVERLAY, CDP_DETACHED] });
  assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
    { status: 'inUse', reason: 'window-check-changed' },
    'a page that only the final snapshot knows about changed the window set');
  assert.equal(evaluations(t.sockets[0]), 1, 'the commit was never queued');
  t.rpc.close();
});

test('a blank or unreadable final target snapshot defers', async () => {
  for (const [targets, expected] of [
    [[CDP_MAIN, { ...CDP_DETACHED, url: 'about:blank' }], { status: 'inUse', reason: 'window-check-changed' }],
    [null, { status: 'unverified', reason: 'window-check-unavailable' }],
  ]) {
    const t = transport({ finalTargets: targets });
    assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }), expected);
    assert.equal(evaluations(t.sockets[0]), 1);
    t.rpc.close();
  }
});

test('a window opened and closed during the role read still stops the release', async () => {
  const t = transport({
    during: async ({ socket }) => {
      socket.emit('Target.targetCreated', { targetInfo: CDP_DETACHED });
      socket.emit('Target.targetDestroyed', { targetId: CDP_DETACHED.targetId });
    },
  });
  assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
    { status: 'inUse', reason: 'window-check-changed' });
  assert.equal(evaluations(t.sockets[0]), 1);
  t.rpc.close();
});

test('a watch that was not acknowledged or never saw the main window is not trusted', async () => {
  for (const [label, options] of [
    ['unacknowledged', { acknowledge: false }],
    ['no main window', { initial: [CDP_DETACHED] }],
  ]) {
    const t = transport(options);
    assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
      { status: 'unverified', reason: 'window-tracking-unavailable' }, label);
    assert.equal(evaluations(t.sockets[0]), 0, label);
    t.rpc.close();
  }
});

test('the permission is asked before connecting and again before the commit', async () => {
  const calls = [];
  const t = transport();
  assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD },
    { canRelease: () => { calls.push(evaluations(t.sockets[0] ?? { sent: [] })); return calls.length < 2; } }),
  { status: 'notSent', reason: 'cancelled' });
  assert.deepEqual(calls, [0, 1], 'asked before the prepare and again before the commit');
  assert.equal(evaluations(t.sockets[0]), 1, 'only the prepare ran');
  t.rpc.close();

  const revoked = transport();
  const controller = new AbortController();
  let asked = 0;
  assert.deepEqual(await revoked.rpc.request('thread/unsubscribe', { threadId: THREAD },
    { signal: controller.signal, canRelease: () => { asked += 1; if (asked === 2) controller.abort(); return true; } }),
  { status: 'notSent', reason: 'aborted' });
  assert.equal(asked, 2);
  assert.equal(evaluations(revoked.sockets[0]), 1, 'the abort landed before the commit');
  revoked.rpc.close();
});

test('a refused prepare answer is passed through without a commit', async () => {
  const t = transport({ probe: { status: 'inUse', reason: 'view-mounted' } });
  assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
    { status: 'inUse', reason: 'view-mounted' });
  assert.equal(evaluations(t.sockets[0]), 1);
  assert.deepEqual(t.reads, [t.found], 'the post-role window read never runs');
  t.rpc.close();
});

test('an unreadable page list or a foreign renderer never releases', async () => {
  for (const [answer, expected] of [
    [null, { status: 'unverified', reason: 'window-check-unavailable' }],
    [[{ id: 'page-9', url: `${ORIGIN}index.html` }], { status: 'unverified', reason: 'window-check-mismatch' }],
  ]) {
    const sent = [];
    class Socket {
      constructor(url) {
        this.url = url; this.sent = sent; this.listeners = {}; queueMicrotask(() => this.fire('open', {}));
      }
      addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
      removeEventListener() {}
      fire(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
      reply(value) { this.fire('message', { data: JSON.stringify(value) }); }
      send(payload) {
        const message = JSON.parse(payload);
        sent.push(message);
        if (message.method === 'Target.setDiscoverTargets') {
          setTimeout(() => {
            this.reply({ id: message.id, result: {} });
            this.reply({ method: 'Target.targetCreated', params: { targetInfo: CDP_MAIN } });
          }, 0);
        }
      }
      close() {}
    }
    const rpc = createCodexNativeRpc({
      discover: async () => ({ webSocketUrl: 'ws://127.0.0.1:1/devtools/page/x', targetId: 'page-1' }),
      appPages: async () => answer,
      WebSocketImpl: Socket,
      targetHandshakeMs: 5000,
    });
    assert.deepEqual(await rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }), expected);
    assert.equal(sent.some(message => message.method === 'Runtime.evaluate'), false, 'nothing was evaluated');
    rpc.close();
  }
});

test('a timed out release read leaves a concurrent turn start on the socket', async () => {
  const readSent = Promise.withResolvers(), turnSent = Promise.withResolvers();
  let socket;
  class Socket extends EventTarget {
    constructor() {
      super();
      socket = this;
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send(payload) {
      const message = JSON.parse(payload);
      const request = message.params.expression;
      (request.includes('"method":"turn/start"') ? turnSent : readSent).resolve(message.id);
    }
    reply(id, value) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result: { result: { value } } }) }));
    }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const rpc = createCodexNativeRpc({
    discover: async () => ({ webSocketUrl: 'ws://127.0.0.1:1/devtools/page/x' }),
    WebSocketImpl: Socket,
    timeoutMs: 50,
  });
  try {
    const read = rpc.request('thread/read', { threadId: THREAD }, { background: true });
    await readSent.promise;
    const turn = rpc.request('turn/start', { threadId: THREAD, input: [] });
    const outcome = turn.then(value => value, error => error.code);
    const turnId = await turnSent.promise;
    await assert.rejects(read, { code: 'codex-native-rpc-response-timeout' });
    socket.reply(turnId, { turn: { id: 'new-turn' } });
    assert.deepEqual(await outcome, { turn: { id: 'new-turn' } });
  } finally {
    rpc.close();
  }
});

test('a warm connection rediscovers nothing, watches once, and reuses its own endpoint', async () => {
  let discoveries = 0;
  const found = { webSocketUrl: 'ws://127.0.0.1:1/devtools/page/x', targetId: 'page-1' };
  const reads = [], sockets = [];
  class Socket {
    constructor(url) {
      this.url = url; this.sent = []; this.listeners = {}; sockets.push(this);
      queueMicrotask(() => this.fire('open', {}));
    }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    removeEventListener() {}
    fire(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
    reply(value) { this.fire('message', { data: JSON.stringify(value) }); }
    send(payload) {
      const message = JSON.parse(payload);
      this.sent.push(message);
      if (message.method === 'Target.setDiscoverTargets') {
        setTimeout(() => {
          this.reply({ id: message.id, result: {} });
          this.reply({ method: 'Target.targetCreated', params: { targetInfo: CDP_MAIN } });
        }, 0);
        return;
      }
      if (message.method === 'Target.getTargets') {
        setTimeout(() => this.reply({ id: message.id, result: { targetInfos: [CDP_MAIN] } }), 0);
        return;
      }
      if (message.method !== 'Runtime.evaluate') return;
      const answer = String(message.params?.expression ?? '').includes('skipRoleRead:true')
        ? { status: 'unsubscribed', dispatched: true } : { status: 'observed', mounted: false, role: null };
      setTimeout(() => this.reply({ id: message.id, result: { result: { value: answer } } }), 0);
    }
    close() {}
  }
  const rpc = createCodexNativeRpc({
    discover: async () => { discoveries += 1; return found; },
    appPages: async argument => { reads.push(argument); return appPageTargets([MAIN]); },
    WebSocketImpl: Socket,
    targetHandshakeMs: 5000,
  });
  await rpc.request('thread/read', { threadId: THREAD, includeTurns: false });
  assert.equal(discoveries, 1);
  assert.equal(sockets[0].sent.some(message => message.method === 'Target.setDiscoverTargets'), false,
    'a normal request starts no target watch');
  await rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true });
  await rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true });
  assert.equal(discoveries, 1, 'a release does not rediscover the desktop');
  assert.equal(sockets.length, 1, 'every call used the existing socket');
  assert.equal(sockets[0].sent.filter(message => message.method === 'Target.setDiscoverTargets').length, 1,
    'one watch per connection');
  assert.deepEqual(reads, [found, found], 'each release reads its own socket endpoint');
  assert.equal(sockets[0].sent.filter(message => message.method === 'Target.getTargets').length, 2,
    'each release gets the final snapshot over that socket');
  rpc.close();
});

// ---------------------------------------------------------------------------------------
// The real desktop also holds a hidden `detached-window.html` shell page. It is a page, so
// it has to be probed rather than refusing every desktop that has one.
// ---------------------------------------------------------------------------------------

const SHELL = { type: 'page', id: 'page-7', url: `${ORIGIN}detached-window.html?initialRoute=%2Fdetached-window` };

function pageTransport({ pages = [MAIN, SHELL], extra = 'observed',
  found = { webSocketUrl: 'ws://127.0.0.1:1/devtools/page/x', targetId: 'page-1' },
  hooks = {}, guard = null, commit = { status: 'unsubscribed', dispatched: true } } = {}) {
  const sockets = [];
  const MAIN_URL = found.webSocketUrl;
  // With `guard`, the main socket's two evaluations run the real page guard (same fixture,
  // same credential, the checkedAt the transport really sent), so a canned "unsubscribed"
  // can never hide a stale window.
  const runRealGuard = (expression, isCommit) => {
    const token = /handoffToken:"([^"]+)"/.exec(expression)?.[1] ?? CREDENTIAL;
    const checkedAt = Number(/checkedAt:(\d+)/.exec(expression)?.[1]);
    return pageThreadUnsubscribeGuard(guard.win, pageMcpRequest, guard.load, RELEASE_GUARD_INTERNALS,
      THREAD, isCommit ? REQUEST : null, 2000,
      isCommit ? { skipRoleRead: true, handoffToken: token, checkedAt } : { handoffToken: token });
  };
  class Socket {
    constructor(url) {
      this.url = url; this.sent = []; this.listeners = {}; this.extra = url !== MAIN_URL;
      sockets.push(this);
      queueMicrotask(() => this.fire('open', {}));
    }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    removeEventListener() {}
    fire(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
    reply(value) { this.fire('message', { data: JSON.stringify(value) }); }
    send(payload) {
      const message = JSON.parse(payload);
      this.sent.push(message);
      if (message.method === 'Target.setDiscoverTargets') {
        if (this.extra) return;
        queueMicrotask(() => {
          this.reply({ id: message.id, result: {} });
          this.reply({ method: 'Target.targetCreated', params: { targetInfo: { type: 'page', targetId: 'page-1', url: MAIN.url } } });
        });
        return;
      }
      if (message.method === 'Target.getTargets') {
        queueMicrotask(() => {
          hooks.beforeTargetsReply?.();
          this.reply({ id: message.id,
            result: { targetInfos: pages.map(page => ({ type: 'page', targetId: page.id, url: page.url })) } });
        });
        return;
      }
      if (message.method !== 'Runtime.evaluate') return;
      if (this.extra) {
        // A silent shell is a shell that goes away: close it precisely instead of waiting
        // out a real deadline.
        if (extra === 'silent') { queueMicrotask(() => this.fire('close', {})); return; }
        queueMicrotask(() => {
          hooks.beforeExtraReply?.();
          const value = extra === 'inUse'
            ? { status: 'inUse', reason: 'view-route' }
            : (extra === 'no-entry'
              // The real shell page has no main entry asset, so the shared probe cannot resolve
              // anything on it. That answer is not clearance: the release defers.
              ? { status: 'unverified', reason: 'no-entry-asset' }
              : (extra === 'no-observation'
                ? { status: 'observed', mounted: false, role: null }
                : { status: 'observed', mounted: false, role: null,
                  observedAt: Date.now() + (extra === 'future-1' ? 1 : extra === 'future-10' ? 10 : 0) }));
          this.reply({ id: message.id, result: { result: { value } } });
        });
        return;
      }
      const expression = String(message.params?.expression ?? '');
      const isCommit = expression.includes('skipRoleRead:true');
      if (guard) {
        queueMicrotask(() => {
          Promise.resolve(runRealGuard(expression, isCommit))
            .then(value => this.reply({ id: message.id, result: { result: { value } } }))
            .catch(error => this.reply({ id: message.id, result: { result: { value:
              { status: 'unverified', reason: String(error?.message ?? error) } } } }));
        });
        return;
      }
      const value = isCommit ? commit : { status: 'observed', mounted: false, role: null };
      queueMicrotask(() => this.reply({ id: message.id, result: { result: { value } } }));
    }
    close() {}
  }
  const rpc = createCodexNativeRpc({
    discover: async () => found,
    appPages: async () => appPageTargets(pages),
    WebSocketImpl: Socket,
    targetHandshakeMs: 5000,
    extraProbeTimeoutMs: 5000,
  });
  return { rpc, sockets, main: () => sockets.find(socket => !socket.extra), extras: () => sockets.filter(socket => socket.extra) };
}

/** A virtual clock: the guard and the transport both read `Date.now`, so tests drive time
 * instead of sleeping. */
function fakeClock(start = 1_800_000_000_000) {
  const real = Date.now;
  let now = start;
  Date.now = () => now;
  return { now: () => now, advance: ms => { now += ms; }, restore: () => { Date.now = real; } };
}

test('the probe can report the instant it reached its verdict', async () => {
  const clock = fakeClock();
  try {
    const fixture = standIn({});
    const plain = await pureProbe(fixture);
    assert.equal('observedAt' in plain, false, 'the old shape is unchanged');
    clock.advance(7);
    const timed = await pureProbe(fixture, { includeObservedAt: true });
    assert.equal(timed.status, 'observed');
    assert.equal(timed.observedAt, Date.now(), 'the page clock, in the same synchronous section');
    assert.match(threadViewProbeExpression({ threadId: THREAD, includeObservedAt: true }), /includeObservedAt:true/);
    assert.equal(threadViewProbeExpression({ threadId: THREAD }).includes('includeObservedAt:true'), false);
  } finally { clock.restore(); }
});

test('a hidden empty shell page is probed and does not block the release', async () => {
  const t = pageTransport();
  assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
    { status: 'unsubscribed', dispatched: true });
  const [extra] = t.extras();
  assert.ok(extra, 'the shell page got its own socket');
  assert.equal(extra.sent.length, 1, 'exactly one read-only evaluation on it');
  assert.equal(extra.sent[0].method, 'Runtime.evaluate');
  const expression = String(extra.sent[0].params.expression);
  assert.match(expression, /handoffToken:null/, 'a probe cannot prepare a credential');
  assert.ok(expression.includes(`expectedPageUrl:${JSON.stringify(SHELL.url)}`), 'the probe is pinned to that page');
  assert.match(expression, /mcp-request/, 'the shared expression body is reused');
  assert.equal(extra.sent.some(message => message.method.startsWith('Target.')), false, 'no target commands on it');
  const commit = t.main().sent.filter(message => String(message.params?.expression ?? '').includes('skipRoleRead:true'));
  assert.equal(commit.length, 1, 'the commit still runs on the main renderer socket');
  t.rpc.close();
});

test('a shell page that is showing the thread blocks the release', async () => {
  const t = pageTransport({ extra: 'inUse' });
  const result = await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true });
  assert.equal(result.status, 'inUse');
  assert.match(result.reason, /^extra-page:/);
  assert.equal(t.main().sent.filter(message => String(message.params?.expression ?? '').includes('skipRoleRead:true')).length, 0,
    'the commit never ran');
  t.rpc.close();
});

test('a shell page that cannot be probed defers the release', async () => {
  const t = pageTransport({ extra: 'silent' });
  assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
    { status: 'unverified', reason: 'extra-page-unavailable' });
  assert.equal(t.main().sent.filter(message => String(message.params?.expression ?? '').includes('skipRoleRead:true')).length, 0);
  t.rpc.close();
});

test('a shell page with no main entry asset is not treated as empty', async () => {  // The live desktop answered exactly this on 2026-11-12: the detached shell has its URL but
  // not `348410.792d1c9584.js`, so the shared probe reports no-entry-asset there. That is a
  // page this build cannot read, so the release stays deferred rather than guessing.
  const t = pageTransport({ extra: 'no-entry' });
  assert.deepEqual(await t.rpc.request('thread/unsubscribe', { threadId: THREAD }, { canRelease: () => true }),
    { status: 'unverified', reason: 'extra-page-unverified' });
  assert.equal(t.main().sent.filter(message => String(message.params?.expression ?? '').includes('skipRoleRead:true')).length, 0,
    'the commit never ran');
  const [extra] = t.extras();
  assert.equal(extra.sent.length, 1, 'one read-only evaluation, no other command');
  t.rpc.close();
});








// ---------------------------------------------------------------------------------------
// Native user input (`item/tool/requestUserInput`) through the desktop's own app client.
// ---------------------------------------------------------------------------------------

function userInputPage({ token = TOKEN, scripts = [{ src: ENTRY }], conversation = null, registry = 'ok' } = {}) {
  const reads = [];
  const writes = [];
  const state = { conversation, replyThrows: false, silent: false, recorded: null };
  const rpc = {
    getConversation: async threadId => {
      reads.push(threadId);
      if (state.conversation === 'throw') throw new Error('conversation read failed');
      return state.conversation;
    },
    replyWithUserInputResponse: async (threadId, requestId, response) => {
      if (state.replyThrows) throw new Error('reply rejected');
      writes.push({ threadId, requestId, response });
      // The desktop removes the request and records the accepted answer on its own item
      // (`applyUserInputResponse`); `recorded` and `silent` let a test break either half.
      state.conversation.requests = state.conversation.requests.filter(entry => entry.id !== requestId);
      const item = state.conversation.turns?.[0]?.items?.find(entry => entry.requestId === String(requestId));
      if (item && state.silent !== true) {
        item.completed = true;
        item.answers = state.recorded ?? Object.fromEntries(
          Object.entries(response?.answers ?? {}).map(([key, value]) => [key, [...(value?.answers ?? [])].map(String)]));
      }
    },
  };
  const scope = { node: { token }, get: () => ({ status: 'ready', client: { rpc } }) };
  const modules = {
    [RELEASE_GUARD_INTERNALS.scopeModule]: { exports: { [RELEASE_GUARD_INTERNALS.scopeAccessor]: () => ({ scope, abortController: {} }) } },
    [RELEASE_GUARD_INTERNALS.tokenModule]: { exports: { [RELEASE_GUARD_INTERNALS.tokenAccessor]: token } },
    [RELEASE_GUARD_INTERNALS.hostClientsModule]: { exports: { [RELEASE_GUARD_INTERNALS.hostClientsAccessor]: Symbol('host-clients') } },
  };
  const registryObject = Object.assign(function registry() {}, { c: modules, d() {} });
  const win = { document: { querySelectorAll: () => scripts.map(node => ({ src: node.src })) } };
  return { win, load: async () => ({ __webpack_require__: registry === 'ok' ? registryObject : registry }),
    rpc, reads, writes, state };
}

const QUESTION = (overrides = {}) => ({
  id: 'q1', header: '方向', question: '首单的启动动作放在哪里？', isOther: true, isSecret: false,
  options: [{ label: '先跑通', description: '最小闭环' }], ...overrides,
});
const UI_REQUEST = (id = 'req-1', overrides = {}) => ({
  id, method: 'item/tool/requestUserInput',
  params: { threadId: THREAD, turnId: 'turn-1', itemId: 'item-1', isBlocking: true, autoResolutionMs: null,
    questions: [QUESTION()], ...overrides },
});
// The desktop pushes one `userInputResponse` item per pending card, `completed:false`
// (early-bootstrap-199 @1028145/@1644018); it is the only positive evidence a card is real.
const cardItem = requestId => ({ id: `user-input-response-${requestId}`, type: 'userInputResponse',
  requestId: String(requestId), turnId: 'turn-1', answers: {}, completed: false });
const conversationWith = (...requests) => ({ id: THREAD, requests,
  turns: [{ turnId: 'turn-1', items: [{ id: 'item-1', type: 'toolCall' },
    ...requests.filter(entry => entry?.method === 'item/tool/requestUserInput')
      .map(entry => cardItem(entry.id))] }] });
const withoutCardItem = (conversation, requestId) => {
  conversation.turns[0].items = conversation.turns[0].items.filter(item => item.requestId !== String(requestId));
  return conversation;
};

test('a pending native question is read with its options, and only for this thread', async () => {
  const page = userInputPage({ conversation: conversationWith(
    UI_REQUEST('req-1'),
    UI_REQUEST('req-2', { threadId: OTHER }),
    { id: 'req-3', method: 'item/commandExecution/requestApproval', params: { threadId: THREAD, turnId: 'turn-1', reason: 'x' } },
  ) });
  const result = await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD);
  assert.equal(result.status, 'observed');
  assert.equal(result.requests.length, 1, 'another thread and an approval are not this thread question');
  const [card] = result.requests;
  assert.deepEqual([card.requestId, card.threadId, card.turnId, card.itemId, card.isBlocking, card.kind],
    ['req-1', THREAD, 'turn-1', 'item-1', true, 'question']);
  assert.deepEqual(card.questions[0], { id: 'q1', header: '方向', question: '首单的启动动作放在哪里？',
    isOther: true, isSecret: false, options: [{ label: '先跑通', description: '最小闭环' }] });
  assert.equal(page.writes.length, 0, 'reading writes nothing');
});

test('a read that cannot be made is unverified, never an empty list', async () => {
  for (const [conversation, reason] of [
    ['throw', 'conversation-read-failed'],
    [null, 'no-conversation'],
    [{ id: THREAD, turns: [] }, 'no-requests'],
  ]) {
    const page = userInputPage({ conversation });
    const result = await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD);
    assert.deepEqual([result.status, result.reason], ['unverified', reason]);
    assert.equal(result.requests, undefined, 'no empty list is ever reported');
  }
  const bare = userInputPage({ scripts: [] });
  assert.deepEqual([(await pageReadUserInput(bare.win, bare.load, RELEASE_GUARD_INTERNALS, THREAD)).reason], ['no-app-client']);
});

test('a numeric request ID is sent unchanged to the same desktop card', async () => {
  const page = userInputPage({ conversation: conversationWith(UI_REQUEST(7)) });
  const { requests: [card] } = await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD);
  assert.equal(card.requestId, 7);
  assert.deepEqual(await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card,
    { q1: { answers: ['先跑通'] } }), { status: 'answered' });
  assert.equal(page.writes[0].requestId, 7);
});

test('a reply losing its round while the renderer connects never evaluates the page', async () => {
  let opened, sent = 0, allowed = true;
  const connecting = new Promise(resolve => { opened = resolve; });
  class DelayedSocket {
    addEventListener(type, listener) { if (type === 'open') opened(listener); }
    send() { sent += 1; }
    close() {}
  }
  const rpc = createCodexNativeRpc({ discover: async () => ({ webSocketUrl: 'ws://127.0.0.1:1/app' }),
    WebSocketImpl: DelayedSocket });
  try {
    const pending = rpc.request('futureaide/userInput/reply', { card: { threadId: THREAD }, answers: {} },
      { canAnswer: () => allowed });
    const open = await connecting;
    allowed = false;
    open();
    assert.deepEqual(await pending, { status: 'unknown', reason: 'round-finished' });
    assert.equal(sent, 0);
  } finally { rpc.close(); }
});

test('approvals, secret questions and cards with no desktop item are never handed off', async () => {
  const page = userInputPage({ conversation: conversationWith(
    UI_REQUEST('req-secret', { questions: [QUESTION({ isSecret: true })] }),
    UI_REQUEST('req-mcp', { itemId: 'item-mcp' }),
    UI_REQUEST('req-unknown'),
    UI_REQUEST('req-plain'),
  ) });
  page.state.conversation.turns[0].items.push({ id: 'item-mcp', type: 'mcpToolCall' });
  // No `userInputResponse` item for this one: the card cannot be told apart, so it stays unknown.
  withoutCardItem(page.state.conversation, 'req-unknown');
  const result = await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD);
  const kinds = Object.fromEntries(result.requests.map(card => [card.requestId, card.kind]));
  assert.deepEqual(kinds, { 'req-secret': 'secret', 'req-mcp': 'mcp-approval', 'req-unknown': 'unknown', 'req-plain': 'question' });
  for (const card of result.requests.filter(entry => entry.kind !== 'question')) {
    assert.deepEqual([(await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card,
      { q1: { answers: ['先跑通'] } })).status], ['unsupported'], card.requestId);
  }
  assert.equal(page.writes.length, 0, 'nothing was written for a card that is not a plain question');
});

test('an answer is written as the typed shape, and only while the card is still pending', async () => {
  const page = userInputPage({ conversation: conversationWith(UI_REQUEST('req-1')) });
  const [card] = (await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD)).requests;
  assert.deepEqual(await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card,
    { q1: { answers: ['先跑通'] } }), { status: 'answered' });
  assert.deepEqual(page.writes, [{ threadId: THREAD, requestId: 'req-1',
    response: { answers: { q1: { answers: ['先跑通'] } } } }],
  'the app-client method the UI itself uses, with the typed answer map');
  assert.deepEqual(await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card,
    { q1: { answers: ['先跑通'] } }), { status: 'not-pending', reason: 'refreshed-card-missing' });
  assert.equal(page.writes.length, 1, 'a duplicate answer writes nothing');
});

test('a stale card never writes, and a failing reply is not reported as answered', async () => {
  const page = userInputPage({ conversation: conversationWith(UI_REQUEST('req-1')) });
  const [card] = (await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD)).requests;
  assert.equal((await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS,
    { ...card, turnId: 'turn-9' }, {})).status, 'not-pending');
  assert.equal((await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS,
    { ...card, itemId: 'item-9' }, {})).status, 'not-pending');
  assert.equal((await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS,
    { ...card, requestId: 'req-9' }, {})).status, 'not-pending');
  assert.equal(page.writes.length, 0, 'a mismatched card is not pending');
  page.state.replyThrows = true;
  assert.deepEqual(await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card, {}),
    { status: 'unknown', reason: 'reply rejected' });
  assert.equal((await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, null, {})).status, 'unknown');
});

test('the public seam maps both halves and never falls back to a raw bridge response', async () => {
  const calls = [];
  const stub = async (method, params, options) => {
    calls.push({ method, params, options });
    return method === 'futureaide/userInput/read'
      ? { status: 'observed', requests: [{ requestId: 'req-1', threadId: THREAD, turnId: 'turn-1',
        itemId: 'item-1', questions: [QUESTION()], isBlocking: true, kind: 'question' }] }
      : { status: 'answered' };
  };
  const read = await readCodexUserInput(THREAD, { request: stub });
  assert.equal(read.status, 'observed');
  assert.deepEqual(Object.keys(read.requests[0]).sort(),
    ['isBlocking', 'itemId', 'kind', 'questions', 'requestId', 'threadId', 'turnId']);
  assert.equal((await replyCodexUserInput(read.requests[0],
    { answers: { q1: { answers: ['先跑通'] } } }, { request: stub })).status, 'answered');
  assert.deepEqual(calls.map(call => call.method), ['futureaide/userInput/read', 'futureaide/userInput/reply']);
  assert.deepEqual(calls[0].params, { threadId: THREAD });
  assert.deepEqual(calls[1].params.answers, { q1: { answers: ['先跑通'] } });
  assert.deepEqual(await readCodexUserInput(THREAD,
    { request: async () => ({ status: 'unverified', reason: 'no-app-client' }) }),
  { status: 'unverified', reason: 'no-app-client' });
  assert.deepEqual(await replyCodexUserInput({}, {}, { request: async () => ({ status: 'weird' }) }),
    { status: 'unknown', reason: 'unexpected-answer' });
  for (const expression of [userInputReadExpression({ threadId: THREAD }),
    userInputReplyExpression({ card: read.requests[0], answers: {} })]) {
    assert.ok(expression.includes('replyWithUserInputResponse') || expression.includes('getConversation'));
    assert.equal(expression.includes('mcp-response'), false, 'the raw bridge response is never used');
    assert.equal(expression.includes('sendMessageFromView'), false);
  }
  assert.ok(userInputReadExpression({ threadId: THREAD }).includes(JSON.stringify(THREAD)));
});



test('a card whose desktop item is already completed is not a pending question', async () => {
  const conversation = conversationWith(UI_REQUEST('req-done'));
  conversation.turns[0].items.find(item => item.requestId === 'req-done').completed = true;
  const page = userInputPage({ conversation });
  const [card] = (await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD)).requests;
  assert.equal(card.kind, 'unknown', 'a completed item is not positive evidence of a pending card');
  assert.equal((await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card, {})).status, 'unsupported');
  assert.equal(page.writes.length, 0);
});

test('a reply the facade silently ignored is reported unknown, not answered', async () => {
  const page = userInputPage({ conversation: conversationWith(UI_REQUEST('req-ghost')) });
  // The manager returns without error when the request is gone, so make the write a no-op.
  page.rpc.replyWithUserInputResponse = async () => {};
  const [card] = (await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD)).requests;
  assert.deepEqual(await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card, { q1: { answers: ['先跑通'] } }),
    { status: 'unknown', reason: 'still-pending' });
});


test('an MCP approval card is recognised by its own template, even without a source item', async () => {
  // The built-in approval template: fixed header and the four fixed choices, delivered
  // through the same method (`core\src\mcp_tool_approval_templates.rs`).
  const approvalQuestion = { id: 'mcp-approval', header: 'Approve app tool call?',
    question: 'Allow 团队长 to read the repository?', isOther: false, isSecret: false,
    options: [
      { label: 'Allow', description: 'Run the tool and continue.' },
      { label: 'Allow for this session', description: 'Run the tool and remember this choice for this session.' },
      { label: "Allow and don't ask me again", description: 'Run the tool and remember this choice for future tool calls.' },
      { label: 'Cancel this tool call.', description: null },
    ] };
  const page = userInputPage({ conversation: conversationWith(
    UI_REQUEST('req-approval', { questions: [approvalQuestion], itemId: null })),
  });
  const [card] = (await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD)).requests;
  assert.equal(card.kind, 'mcp-approval', 'the template alone proves it is an approval');
  assert.equal((await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card,
    { 'mcp-approval': { answers: ['Allow'] } })).status, 'unsupported');
  assert.equal(page.writes.length, 0, 'an approval is never answered through this seam');
});

test('a card whose source item cannot be proven is deferred, marker or not', async () => {
  for (const overrides of [{ itemId: null }, { itemId: 'item-absent' }]) {
    const page = userInputPage({ conversation: conversationWith(UI_REQUEST('req-1', overrides)) });
    const [card] = (await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD)).requests;
    assert.equal(card.kind, 'unknown', JSON.stringify(overrides));
    assert.equal((await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card, {})).status, 'unsupported');
    assert.equal(page.writes.length, 0, JSON.stringify(overrides));
  }
});

test('an answer is only reported when the desktop recorded this very answer', async () => {
  const answered = userInputPage({ conversation: conversationWith(UI_REQUEST('req-1')) });
  const [card] = (await pageReadUserInput(answered.win, answered.load, RELEASE_GUARD_INTERNALS, THREAD)).requests;
  assert.equal((await pageReplyUserInput(answered.win, answered.load, RELEASE_GUARD_INTERNALS, card,
    { q1: { answers: ['先跑通'] } })).status, 'answered', 'the recorded answer matches what was sent');

  const swapped = userInputPage({ conversation: conversationWith(UI_REQUEST('req-1')) });
  swapped.state.recorded = { q1: ['先铺量'] };
  const [other] = (await pageReadUserInput(swapped.win, swapped.load, RELEASE_GUARD_INTERNALS, THREAD)).requests;
  assert.deepEqual(await pageReplyUserInput(swapped.win, swapped.load, RELEASE_GUARD_INTERNALS, other,
    { q1: { answers: ['先跑通'] } }), { status: 'unknown', reason: 'answers-mismatch' });

  const unrecorded = userInputPage({ conversation: conversationWith(UI_REQUEST('req-1')) });
  unrecorded.state.silent = true;
  const [silentCard] = (await pageReadUserInput(unrecorded.win, unrecorded.load, RELEASE_GUARD_INTERNALS, THREAD)).requests;
  assert.deepEqual(await pageReplyUserInput(unrecorded.win, unrecorded.load, RELEASE_GUARD_INTERNALS, silentCard,
    { q1: { answers: ['先跑通'] } }), { status: 'unknown', reason: 'no-completed-item' });
});

test('a card that turned secret or an approval after it was read is not answered', async () => {
  const run = async (mutate, expected) => {
    const page = userInputPage({ conversation: conversationWith(UI_REQUEST('req-1')) });
    const [card] = (await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD)).requests;
    assert.equal(card.kind, 'question', 'read once as a plain question');
    mutate(page);
    const answer = await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card,
      { q1: { answers: ['先跑通'] } });
    assert.deepEqual(answer, expected);
    assert.equal(page.writes.length, 0, 'nothing is written for a card that is no longer a plain question');
  };
  await run(page => { page.state.conversation.requests[0].params.questions[0].isSecret = true; },
    { status: 'unsupported', reason: 'kind:secret' });
  await run(page => { page.state.conversation.requests[0].params.questions[0].header = 'Approve app tool call?'; },
    { status: 'unsupported', reason: 'kind:mcp-approval' });
  await run(page => { page.state.conversation.turns[0].items.find(item => item.id === 'item-1').type = 'mcpToolCall'; },
    { status: 'unsupported', reason: 'kind:mcp-approval' });
});

test('a synthetic marker from another turn is not evidence for this card', async () => {
  for (const placement of ['other-turn', 'moved-at-reply']) {
    const conversation = conversationWith(UI_REQUEST('req-1'));
    if (placement === 'other-turn') {
      conversation.turns.push({ turnId: 'turn-2', items: conversation.turns[0].items.splice(1, 1) });
    }
    const page = userInputPage({ conversation });
    const read = await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD);
    if (placement === 'other-turn') {
      assert.equal(read.requests[0].kind, 'unknown', 'an item in another turn proves nothing');
      assert.equal((await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, read.requests[0], {})).status,
        'unsupported');
      assert.equal(page.writes.length, 0);
      continue;
    }
    // Read with the marker in place, then move it into another turn before the answer.
    conversation.turns.push({ turnId: 'turn-2', items: [] });
    const [card] = read.requests;
    assert.equal(card.kind, 'question');
    conversation.turns[1].items.push(...conversation.turns[0].items.splice(1, 1));
    assert.deepEqual((await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card, {})).status,
      'unsupported');
    assert.equal(page.writes.length, 0, 'a marker that left this turn is not evidence');
  }
});

test('a card whose questions or options were replaced is not answered', async () => {
  const page = userInputPage({ conversation: conversationWith(UI_REQUEST('req-1')) });
  const [card] = (await pageReadUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, THREAD)).requests;
  page.state.conversation.requests[0].params.questions[0].options.push({ label: '第三条', description: null });
  assert.deepEqual(await pageReplyUserInput(page.win, page.load, RELEASE_GUARD_INTERNALS, card,
    { q1: { answers: ['先跑通'] } }), { status: 'unknown', reason: 'questions-changed' });
  assert.equal(page.writes.length, 0);
});
