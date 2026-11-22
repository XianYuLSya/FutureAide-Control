import {RELEASE_GUARD_INTERNALS} from '../src/codex-ipc.mjs';
export function makeView(threadId) {
const THREAD=threadId, ORIGIN='app://-/', ENTRY=ORIGIN+'assets/348410.792d1c9584.js', TOKEN='app-scope-token';
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


return standIn({});
}
