// Codex Desktop native RPC over the running renderer's local debug endpoint.
// Nothing here starts an app-server, a CLI, a window, or a model turn by itself.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);

// The methods the managed Codex path needs. config/read is kept separate below
// because its result is reduced to model fields before it leaves the renderer.
// thread/unsubscribe is deliberately absent: it is only ever sent from the guarded
// expression, so a plain call path that would bypass the view check cannot compile.
const NATIVE_METHODS = new Set([
  'config/read', 'model/list',
  'thread/start', 'thread/name/set', 'thread/read', 'thread/turns/list', 'thread/items/list', 'thread/list',
  'thread/resume', 'thread/delete',
  'turn/start', 'turn/steer', 'turn/interrupt',
]);

// The writes a managed dispatch may still be refused for, right before the page commits
// them. Nothing reads through this set: a status call is never gated.
const GATED_WRITE_METHODS = new Set(['thread/start', 'turn/start', 'turn/steer', 'turn/interrupt']);

const THREAD_MISSING = /(?:thread|conversation)[^.]*(?:not found|does not exist|unknown|not loaded)|no (?:such )?thread|invalid thread/i;
// Native Codex reports "rollout is empty", "rollout empty", and the path-bearing
// form "rollout at C:\...\xxx.jsonl is empty"; all mean the thread exists but
// its first turn has not been written yet.
const EMPTY_ROLLOUT = /rollout (?:at .*? )?(?:is )?empty|no rollout/i;

export function codexThreadNotFound(threadId) {
  return fail('codex-thread-not-found',
    `The Codex thread ${threadId} is not visible in the current profile. If FAswitch switched accounts, switch back to the profile that created it; this managed session will not be retried automatically.`,
    { terminal: true });
}

export function isCodexThreadMissing(error) {
  return error?.code === 'codex-thread-not-found'
    || THREAD_MISSING.test(String(error?.rpcMessage ?? error?.message ?? ''));
}

/** A thread exists but its first rollout content has not been written yet. */
export function isCodexRolloutEmpty(error) {
  return error?.code === 'codex-empty-rollout'
    || EMPTY_ROLLOUT.test(String(error?.rpcMessage ?? error?.message ?? ''));
}

/** A request that never reached the desktop: safe to fall back to app-tools. */
export function isCodexRpcUnavailable(error) {
  return ['codex-native-rpc-unavailable', 'codex-native-rpc-timeout'].includes(error?.code);
}

/** A read-only native call that failed before any write was attempted. These
 * transport outcomes are safe to retry; application rejections are not. */
export function isCodexReadRetryable(error) {
  return isCodexRpcUnavailable(error)
    || ['codex-native-rpc-response-timeout', 'codex-native-rpc-closed'].includes(error?.code);
}

// The running Desktop already opens this local debug endpoint. Never restart it
// with extra flags or connect to a web/account/browser profile instead.
const DISCOVER_RENDERER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$all = @(Get-CimInstance Win32_Process)
$native = @($all | Where-Object {
  $_.ExecutablePath -and $_.Name -match '^(ChatGPT|Codex)\.exe$' -and
  $_.CommandLine -match '--remote-debugging-port=' -and $_.CommandLine -notmatch '--type=' -and
  # A Store build is recognised by its package folder: after a background update the
  # installer strips the old folder while that process keeps running, so a bundled file
  # next to the exe can no longer be the test. Other installs still need the file.
  (($_.ExecutablePath -match '\\WindowsApps\\OpenAI\.Codex_') -or
   (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $_.ExecutablePath) 'resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs')))
})
@(Get-NetTCPConnection -State Listen | Where-Object {
  $_.OwningProcess -in $native.ProcessId -and $_.LocalAddress -eq '127.0.0.1'
} | ForEach-Object { [pscustomobject]@{ port=$_.LocalPort; pid=$_.OwningProcess } }) | ConvertTo-Json -Compress
`;

export async function discoverCodexRenderer() {
  if (process.platform !== 'win32') throw fail('codex-native-rpc-unavailable', 'Desktop renderer discovery is currently implemented for Windows.');
  const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const endpoints = await new Promise((resolve, reject) => execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', DISCOVER_RENDERER],
    { windowsHide: true, timeout: 10000, maxBuffer: 65536, encoding: 'utf8' }, (error, stdout) => {
      if (error) return reject(fail('codex-native-rpc-unavailable', 'Could not locate the running Desktop native endpoint.'));
      try { const parsed = stdout.trim() ? JSON.parse(stdout) : []; resolve(Array.isArray(parsed) ? parsed : [parsed]); } catch { reject(fail('codex-native-rpc-unavailable', 'The Desktop native endpoint discovery returned an invalid response.')); }
    }));
  const matches = [];
  for (const endpoint of endpoints) {
    try {
      const origin = `http://127.0.0.1:${endpoint.port}`;
      const targets = await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(1500) }).then(r => r.json());
      const pages = targets.filter(t => t.type === 'page' && t.url === 'app://-/index.html');
      for (const target of pages) {
        const ws = new URL(target.webSocketDebuggerUrl);
        if (ws.hostname === '127.0.0.1' && ws.port === String(endpoint.port) && ws.pathname.startsWith('/devtools/page/')) {
          matches.push({ endpoint, target, webSocketUrl: ws.href });
        }
      }
    } catch { /* An unrelated local listener is never used as a fallback. */ }
  }
  if (new Set(matches.map(m => m.endpoint.pid)).size !== 1 || matches.length !== 1) {
    throw fail('codex-native-rpc-unavailable', 'Exactly one running Codex main renderer must be available.');
  }
  return { webSocketUrl: matches[0].webSocketUrl, pid: matches[0].endpoint.pid, targetId: matches[0].target.id };
}

/** The one place a renderer request is sent and matched, shared by every expression
 * below. `request` is a plain object: the desktop bridge takes an object, not JSON text. */
export async function pageMcpRequest(win, request, timeoutMs) {
  return await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { win.removeEventListener('message', listen); } catch { /* the page is going away */ }
      resolve(value);
    };
    function listen(event) {
      const data = event?.data;
      if (!data || data.type !== 'mcp-response' || data.hostId !== 'local') return;
      if (data.message?.id !== request.id) return;
      finish(data.message);
    }
    const timer = setTimeout(() => finish({ error: { code: 'timeout', message: 'Native Desktop response timed out' } }), timeoutMs);
    win.addEventListener('message', listen);
    Promise.resolve(win.electronBridge.sendMessageFromView({ type: 'mcp-request', hostId: 'local', request }))
      .catch(error => finish({ error: { code: 'bridge', message: String(error?.message ?? error) } }));
  });
}

export function nativeRpcExpression(method, params, timeoutMs) {
  if (!NATIVE_METHODS.has(method)) throw fail('codex-native-rpc-unsupported', 'Unsupported native Desktop method.');
  // Interpolated unquoted: this is an object literal inside the page expression, which
  // is the shape the bridge expects.
  const request = JSON.stringify({ id: `futureaide-native-${randomUUID()}`, method, params });
  // The response envelope uses a sentinel for a JSON-RPC error, so its numeric
  // code survives Runtime.evaluate and can be reported as a structured failure.
  // config/read still returns only model fields: auth, provider keys and
  // unrelated configuration never cross the CDP connection.
  const result = method === 'config/read'
    ? 'const c=m.result?.config??{};return {model:c.model,provider:c.model_provider??"openai",'
      + 'reasoningEffort:c.model_reasoning_effort,profile:c.profile??null};'
    : 'return m.result;';
  // A resume is the desktop putting a subscription back. It drops any release credential
  // prepared for the same thread in this same page, before the resume goes out: if the
  // resume lands first the old commit has nothing to send, and if the commit lands first
  // this resume then restores the subscription on the same connection.
  const prelude = method === 'thread/resume' && typeof params?.threadId === 'string'
    ? `(${pageDropReleaseHandoff.toString()})(window, ${JSON.stringify(params.threadId)});`
    : '';
  return `(async()=>{${prelude}const m=await (${pageMcpRequest.toString()})(window,${request},${timeoutMs});`
    + 'if(m?.error)return {__futureaideRpcError:{code:m.error.code,message:m.error.message,data:m.error.data}};'
    + `${result}})()`;
}

/**
 * `thread/unsubscribe` is the one native method that speaks for the whole desktop
 * connection: the renderer's app-server client owns a single subscription per thread,
 * so releasing a thread the user is looking at would drop their view, not ours. The
 * desktop already marks that state itself — the window's own route, one mounted
 * `retainActiveConversation` effect per open thread, and the manager's stream role — so
 * the request is forwarded only when those checks pass. The last route and lease checks
 * run synchronously with the send. The window snapshot and role read are earlier checks.
 *
 * Everything comes from the desktop's own loaded code. The registry is an ESM export of
 * the entry asset (`/assets/348410.<hash>.js`), not a window global, so the guard imports
 * that asset by its script src. One build is one set of ids: the scope token has to match
 * the token of the guard's own build, which is what makes a moved id an `unverified`
 * answer instead of a wrong object. `hostId` is fixed to `local` here; it is not a
 * parameter, because a remote host has no renderer view to protect.
 *
 * The expression builder passes this table to the page with the stringified guard.
 * Provenance in `OpenAI.Codex 26.1103.4239.0` `app.asar`:
 * `webview/assets/async/182735.*.js` — the app-window accessor returning
 * `{scope, getManagerForHost, abortController}` (@7094941, its own `getStreamRole` use at
 * @7096729), the manager `streamRoles`/`familyBindings` surface (@882328, @1507228), and
 * `threadStore.isConversationActive`/`retainActiveConversation` (@1006211).
 */
export const RELEASE_GUARD_INTERNALS = Object.freeze({
  // The exact entry asset of this build: a different hash is a different bundle, and the
  // guard answers unverified rather than guessing at ids that may have moved.
  entryAssetPath: '/assets/348410.792d1c9584.js',
  scopeModule: 'bB0J', scopeAccessor: 'lv',
  tokenModule: 'OWtl', tokenAccessor: 'u',
  hostClientsModule: 'l00C', hostClientsAccessor: 'M4',
  viewLeaseModule: 'vdpW', viewLeaseAccessor: 'Ct',
  routeModule: 'hvSK', routeAccessor: 'lK',
  jotaiModule: 'HkKI', jotaiMountedAccessor: 'h7',
  // The renderer's own route vocabulary (`webview/assets/async/182735.*.js` @2160269): the
  // thread kind names the conversation it shows, and these three show no local thread at
  // all. Any other kind is a page this guard has no evidence about and is never "clear".
  threadRouteKind: 'local-thread',
  clearRouteKinds: ['home', 'new-thread-panel', 'chatgpt-thread'],
  // The only answers `getStreamRole` is known to give. Anything else — including a missing
  // value or a failed call — is not a verdict, so it cannot let a release through.
  heldRoles: ['owner', 'follower'],
  // A prepared release commits only within this window; a handoff left behind by a round
  // that walked away is never used by a later one.
  handoffMaxAgeMs: 60000,
  commitWindowMs: 100,
  // The desktop keeps one hidden shell next to the main window. It is not a view, but it is
  // also not something to whitelist by URL: `webview/detached-window.html` loads its own
  // entry `/assets/357055.2b78f20048.js`, which reaches `async/998287.*.js` module `b9YD`
  // (`initializeDetachedWindow`) and renders nothing until it is asked for content.
  detachedShellEntryAssetPath: '/assets/357055.2b78f20048.js',
  detachedShellModule: 'b9YD',
  detachedShellModuleAccessor: 'initializeDetachedWindow',
  detachedShellUrlPath: '/detached-window.html',
  detachedShellRoute: '/detached-window',
  // MCP app-tool approvals are delivered through `item/tool/requestUserInput` itself
  // (`core\src\mcp_tool_approval_templates.rs`), so the method proves nothing. These are the
  // built-in template literals of that approval card ("Approve app tool call?" and its four
  // fixed choices); a card matching them is an approval and is never handed off, whatever
  // its source item looks like.
  approvalQuestionHeader: 'Approve app tool call?',
  approvalOptionLabels: ['Allow', 'Allow for this session', "Allow and don't ask me again", 'Cancel this tool call'],
  // Item types that mean "an app/MCP tool is being called", i.e. a provable approval source.
  approvalItemTypes: ['mcpToolCall', 'dynamicToolCall'],
});

/** The page side of the credential: a prepared release is dropped from the confirmed
 * module state, so the commit half has nothing to import and nothing to await. */
export function pageDropReleaseHandoff(win, threadId) {
  const handoffs = win.__futureaideReleaseHandoffs;
  const handoff = handoffs?.get(threadId);
  if (handoff) {
    clearTimeout(handoff.timer);
    handoffs.delete(threadId);
    if (!handoffs.size) delete win.__futureaideReleaseHandoffs;
  }
  return true;
}

export async function pageThreadUnsubscribeGuard(win, call, load, internals, threadId, request, timeoutMs, options) {
  const hostId = 'local';
  const skipRoleRead = options?.skipRoleRead === true;
  const handoffToken = typeof options?.handoffToken === 'string' && options.handoffToken ? options.handoffToken : null;
  const answer = (status, extra) => ({ status, ...extra });
  // The instant the read-only verdict is actually reached, readable by the transport when it
  // asks for it: this is the page's own clock inside the synchronous section, never the
  // moment Node receives the reply.
  const observedVerdict = verdict => (options?.includeObservedAt === true
    ? { ...verdict, observedAt: Date.now() } : verdict);
  try {
    if (skipRoleRead) {
      // The commit half: it resolves nothing and imports nothing. The credential is the
      // token this very release prepared, for this thread, against this version table, and
      // only while it is fresh.
      const handoffs = win.__futureaideReleaseHandoffs;
      const handoff = handoffs?.get(threadId);
      const usable = handoff && handoffToken && handoff.token === handoffToken
        && handoff.threadId === threadId
        && JSON.stringify(handoff.internals) === JSON.stringify(internals);
      if (!usable) return answer('unverified', { reason: handoff ? 'handoff-stale' : 'handoff-missing' });
      const dropOwn = () => {
        // Re-read the property: a prepare that emptied the map deletes it outright.
        if (win.__futureaideReleaseHandoffs?.get(threadId) === handoff) pageDropReleaseHandoff(win, threadId);
      };
      if (!(Date.now() - handoff.at <= internals.handoffMaxAgeMs)) {
        dropOwn();
        return answer('unverified', { reason: 'handoff-expired' });
      }
      // P2: the prepare proved no role, but another window can take the stream between the
      // prepare and this commit with the route and the lease unchanged, so the role is read
      // again on the same confirmed client. The credential stays in the map for the whole
      // read: a resume (or a newer prepare) for this thread while this await is in flight
      // removes or replaces it, and this commit must then not send — that fence is exactly
      // what a same-name dispatch relies on.
      let role;
      try { role = await handoff.getStreamRole(threadId); }
      catch { return answer('unverified', { reason: 'role-read-failed' }); }
      if (role === null) { /* read, and this connection holds no role */ }
      else if (role && typeof role === 'object' && internals.heldRoles.includes(role.role)) {
        return answer('inUse', { reason: `stream-role:${role.role}` });
      } else {
        return answer('unverified', { reason: 'role-unknown' });
      }
      // Re-read the property after the await, not the map captured before it: a prepare that
      // emptied the map deleted it, and the newer one lives on a fresh map.
      const current = win.__futureaideReleaseHandoffs?.get(threadId);
      if (current !== handoff || current.token !== handoffToken) {
        return answer('unverified', { reason: current ? 'handoff-stale' : 'handoff-cancelled' });
      }
      // One synchronous block now: the credential is consumed here, and route, lease and the
      // age of the transport's window snapshot are all read after the await and before the
      // send, in this same tick.
      pageDropReleaseHandoff(win, threadId);
      const route = handoff.routeVerdict();
      if (route === 'unknown') return answer('unverified', { reason: 'route-unknown' });
      if (route === 'target') return answer('inUse', { reason: 'view-route' });
      if (handoff.leaseMounted()) return answer('inUse', { reason: 'view-mounted' });
      const age = Date.now() - options.checkedAt;
      if (!Number.isSafeInteger(options.checkedAt) || age < 0 || age > internals.commitWindowMs) {
        return answer('unverified', { reason: 'window-check-stale' });
      }
      const message = await call(win, request, timeoutMs);
      if (message?.error) return answer('unverified', { reason: 'rpc-rejected' });
      const status = message?.result?.status;
      return answer(typeof status === 'string' && status ? status : 'unverified', { dispatched: true });
    }
    const importModule = typeof load === 'function' ? load : url => import(url);
    // A probe may be aimed at one specific page (another window of this desktop). The page
    // confirms it is that page — app scheme, `-` host, fully loaded — before importing
    // anything, so a navigation or a still-loading document can never make this read a
    // different page's scripts or run an initialiser early.
    const expectedPageUrl = typeof options?.expectedPageUrl === 'string' ? options.expectedPageUrl : null;
    if (expectedPageUrl !== null) {
      let expected = null;
      try { expected = new URL(expectedPageUrl); } catch { expected = null; }
      if (!expected || expected.protocol !== 'app:' || expected.host !== '-') {
        return answer('unverified', { reason: 'page-mismatch' });
      }
      let href = null;
      try { href = String(win.location?.href ?? ''); } catch { href = null; }
      if (href !== expectedPageUrl) return answer('unverified', { reason: 'page-mismatch' });
      if (win.document?.readyState !== 'complete') return answer('unverified', { reason: 'page-not-ready' });
    }
    // The registry is the exact entry asset's ESM export, so it is imported by src;
    // nothing is read off window globals and no other asset is accepted.
    const appAsset = path => `app://-${path}`;
    const sources = [...(win.document?.querySelectorAll('script[src]') ?? [])]
      .map(node => String(node.src ?? ''));
    const hasAsset = path => sources.includes(appAsset(path));
    // The proven empty shell, checked in read-only mode only. Every condition below has to
    // hold: the exact route, the dedicated entry and its own registry with the detached
    // initialiser, none of the main window's scope/route/host/view modules, no main entry,
    // and an empty `#root` read in the same synchronous step that answers.
    if (request === null && !handoffToken) {
      const shellEntry = hasAsset(internals.detachedShellEntryAssetPath);
      const mainPresent = hasAsset(internals.entryAssetPath);
      let shellUrl = null;
      try { shellUrl = new URL(String(win.location?.href ?? '')); } catch { shellUrl = null; }
      const exactRoute = shellUrl !== null && shellUrl.protocol === 'app:' && shellUrl.host === '-'
        && shellUrl.pathname === internals.detachedShellUrlPath && !shellUrl.hash
        && shellUrl.searchParams.size === 1
        && shellUrl.searchParams.get('initialRoute') === internals.detachedShellRoute;
      if (shellEntry && !mainPresent && exactRoute) {
        let shellRegistry;
        try { shellRegistry = (await importModule(appAsset(internals.detachedShellEntryAssetPath))).__webpack_require__; }
        catch { return answer('unverified', { reason: 'shell-entry-import-failed' }); }
        if (typeof shellRegistry !== 'function' || !shellRegistry.c) {
          return answer('unverified', { reason: 'shell-no-module-registry' });
        }
        // Only the known initialiser: an arbitrary function on that module is not evidence.
        const initialiser = shellRegistry.c[internals.detachedShellModule]?.exports;
        if (typeof initialiser?.[internals.detachedShellModuleAccessor] !== 'function') {
          return answer('unverified', { reason: 'shell-module-missing' });
        }
        const root = win.document?.querySelector?.('#root');
        // Its own registry carries only the shell's modules: a main-window scope, route,
        // host client or view lease means this is not the shell this guard knows.
        const mainModules = [internals.scopeModule, internals.routeModule,
          internals.hostClientsModule, internals.viewLeaseModule];
        if (mainModules.some(id => shellRegistry.c[id])) {
          return answer('unverified', { reason: 'shell-shape-mismatch' });
        }
        if (!root || typeof root.hasChildNodes !== 'function' || root.hasChildNodes()) {
          return answer('unverified', { reason: 'shell-not-empty' });
        }
        return observedVerdict({ status: 'observed', view: 'detached-shell', mounted: false, role: null });
      }
    }
    const entry = hasAsset(internals.entryAssetPath) ? appAsset(internals.entryAssetPath) : null;
    if (!entry) return answer('unverified', { reason: 'no-entry-asset' });
    let registry;
    try { registry = (await importModule(entry)).__webpack_require__; }
    catch { return answer('unverified', { reason: 'module-import-failed' }); }
    if (typeof registry !== 'function' || !registry.c) return answer('unverified', { reason: 'no-module-registry' });
    const exportsOf = id => { const cached = registry.c[id]; return cached ? cached.exports : undefined; };

    const scopeOwner = exportsOf(internals.scopeModule);
    if (typeof scopeOwner?.[internals.scopeAccessor] !== 'function') return answer('unverified', { reason: 'no-scope-accessor' });
    const scope = scopeOwner[internals.scopeAccessor]()?.scope;
    if (!scope || typeof scope.get !== 'function' || !scope.node) return answer('unverified', { reason: 'no-app-scope' });
    // A different build moves the ids; its token is what proves the objects below belong
    // to the same app this guard was written against.
    const token = exportsOf(internals.tokenModule)?.[internals.tokenAccessor];
    if (token === undefined || scope.node.token !== token) return answer('unverified', { reason: 'scope-token-mismatch' });
    // The shape is checked even when this thread has no family binding at all: a missing
    // Map or WeakMap means this build is not the one the checks were written for.
    const familyBindings = scope.node.familyBindings;
    const routeOf = exportsOf(internals.routeModule)?.[internals.routeAccessor];
    const hostClientsAtom = exportsOf(internals.hostClientsModule)?.[internals.hostClientsAccessor];
    const viewLeaseAtom = exportsOf(internals.viewLeaseModule)?.[internals.viewLeaseAccessor];
    const mountedOf = exportsOf(internals.jotaiModule)?.[internals.jotaiMountedAccessor];
    if (typeof routeOf !== 'function') return answer('unverified', { reason: 'no-route-state' });
    if (!hostClientsAtom || !viewLeaseAtom || typeof mountedOf !== 'function') {
      return answer('unverified', { reason: 'no-guard-atoms' });
    }
    if (!(familyBindings instanceof Map)) return answer('unverified', { reason: 'scope-shape-mismatch' });
    const mountedRegistry = mountedOf(scope.node.store)?.[1];
    if (!(mountedRegistry instanceof WeakMap)) return answer('unverified', { reason: 'no-mounted-registry' });

    const hostClient = scope.get(hostClientsAtom, hostId);
    const rpc = hostClient?.status === 'ready'
      ? (hostClient.client?.rpc ?? hostClient.requestClient?.rpc) : undefined;
    if (!skipRoleRead && typeof rpc?.getStreamRole !== 'function') {
      return answer('unverified', { reason: 'no-host-rpc' });
    }

    // `target` = this window shows the thread, `clear` = a known kind that shows no local
    // thread (or another thread's id), `unknown` = not evidence of either, never a release.
    const routeVerdict = () => {
      const value = routeOf(scope)?.value;
      if (!value || typeof value !== 'object' || typeof value.routeKind !== 'string') return 'unknown';
      if (value.routeKind === internals.threadRouteKind) {
        const id = typeof value.conversationId === 'string' ? value.conversationId
          : (typeof value.threadId === 'string' ? value.threadId : undefined);
        if (!id) return 'unknown';
        return id === threadId ? 'target' : 'clear';
      }
      return internals.clearRouteKinds.includes(value.routeKind) ? 'clear' : 'unknown';
    };
    // A mounted effect atom is the renderer's own "a view holds this thread" lease.
    // Reading the mounted WeakMap does not create or retain the subscription.
    const leaseMounted = () => {
      const binding = familyBindings.get(viewLeaseAtom);
      if (!binding) return false;
      const atom = binding.get?.(JSON.stringify({ hostId, threadId }))?.value?.atom;
      if (!atom) return false;
      return mountedRegistry.has(atom);
    };
    const pageVerdict = suffix => {
      const route = routeVerdict();
      if (route === 'unknown') return answer('unverified', { reason: 'route-unknown' });
      if (route === 'target') return answer('inUse', { reason: `view-route${suffix}` });
      if (leaseMounted()) return answer('inUse', { reason: `view-mounted${suffix}` });
      return null;
    };

    // Route first: it also covers a navigation whose view effect has not mounted yet.
    const first = pageVerdict('');
    if (first) return first;
    if (!skipRoleRead) {
      let role;
      try { role = await rpc.getStreamRole(threadId); }
      catch { return answer('unverified', { reason: 'role-read-failed' }); }
      // The desktop's own accessor is `getStreamRole(e){ return this.streamRoles.get(e) ?? null }`
      // (`webview/assets/async/182735.*.js` @884861), so a successful read answers an explicit
      // `null` when this connection holds no role. `null` is therefore proof, and a missing
      // value is not: an `undefined` means the read did not answer in the known shape and the
      // release is deferred rather than taken as "no role".
      if (role === null) { /* read, and this connection holds no role */ }
      else if (role && typeof role === 'object' && internals.heldRoles.includes(role.role)) {
        return answer('inUse', { reason: `stream-role:${role.role}` });
      } else {
        return answer('unverified', { reason: 'role-unknown' });
      }
    }
    // Re-checked in this same tick: the role read is async, so the window could have
    // navigated to or opened the thread while it was in flight.
    const late = pageVerdict('-late');
    if (late) return late;
    if (request === null) {
      // Only a release prepares a credential, and only under its own random token; a plain
      // read-only probe leaves the page untouched.
      if (handoffToken) {
        pageDropReleaseHandoff(win, threadId);
        const handoffs = win.__futureaideReleaseHandoffs ??= new Map();
        const handoff = { token: handoffToken, internals, threadId, at: Date.now(),
          routeVerdict, leaseMounted,
          // The same confirmed host client, kept for the commit's own role re-read; no
          // lookup, no scan, and no second import is involved.
          getStreamRole: id => rpc.getStreamRole(id) };
        handoffs.set(threadId, handoff);
        handoff.timer = setTimeout(() => {
          if (handoffs.get(threadId) === handoff) pageDropReleaseHandoff(win, threadId);
        }, internals.handoffMaxAgeMs);
        handoff.timer?.unref?.();
      }
      return observedVerdict({ status: 'observed', mounted: false, role: null });
    }
    // Only the commit half sends, and only with a credential this page prepared under the
    // release's own token. A full re-check that ends in a request is never forwarded.
    return answer('unverified', { reason: 'commit-requires-credential' });
  } catch (error) {
    return answer('unverified', { reason: String(error?.message ?? error) });
  }
}

function guardExpressionSource(threadId, requestLiteral, timeoutMs, options = {}) {
  // The version table, the request helper and the loader position are all passed in: the
  // page has no module scope, and nothing here may fall back to a window global.
  return `(async()=>{const call=${pageMcpRequest.toString()};`
    + `const pageDropReleaseHandoff=${pageDropReleaseHandoff.toString()};const guard=${pageThreadUnsubscribeGuard.toString()};`
    + `return await guard(window, call, null, ${JSON.stringify(RELEASE_GUARD_INTERNALS)}, `
    + `${JSON.stringify(threadId)}, ${requestLiteral}, ${Number(timeoutMs) || 15000}, `
    + `{skipRoleRead:${options.skipRoleRead === true}, handoffToken:${JSON.stringify(options.handoffToken ?? null)}, `
    + `checkedAt:${JSON.stringify(options.checkedAt ?? null)}, `
    + `expectedPageUrl:${JSON.stringify(options.expectedPageUrl ?? null)}, `
    + `includeObservedAt:${options.includeObservedAt === true}});})()`;
}

/** The prepare half of a release: every check, no send, and a credential under this
 * release's own random token. Only the transport calls this. */
export function threadUnsubscribePrepareExpression({ threadId, token, timeoutMs = 15000 } = {}) {
  if (typeof threadId !== 'string' || !threadId) {
    throw fail('codex-native-rpc-unsupported', 'thread/unsubscribe needs one threadId.');
  }
  if (typeof token !== 'string' || !token) {
    throw fail('codex-native-rpc-unsupported', 'A release prepare needs its own token.');
  }
  return guardExpressionSource(threadId, 'null', timeoutMs, { handoffToken: token });
}

/** The commit half: no import, one role re-read on the module the prepare confirmed, then
 * everything else — route, lease and the snapshot's age — in the single synchronous step
 * that sends. Only the transport calls this. */
export function threadUnsubscribeSendExpression({ threadId, token, checkedAt, timeoutMs = 15000 } = {}) {
  if (typeof threadId !== 'string' || !threadId) {
    throw fail('codex-native-rpc-unsupported', 'A release needs one threadId.');
  }
  if (typeof token !== 'string' || !token) {
    throw fail('codex-native-rpc-unsupported', 'A release commit needs its own token.');
  }
  if (!Number.isSafeInteger(checkedAt)) {
    throw fail('codex-native-rpc-unsupported', 'A release commit needs a window check time.');
  }
  const request = JSON.stringify({ id: `futureaide-release-${randomUUID()}`, method: 'thread/unsubscribe', params: { threadId } });
  return guardExpressionSource(threadId, request, timeoutMs, { skipRoleRead: true, handoffToken: token, checkedAt });
}

/** Observation only: the same resolution and the same checks, without a bridge call,
 * without taking any lease, and without preparing anything the page could commit later.
 * `expectedPageUrl` pins it to one page: the page must still be that URL before anything is
 * imported, which is what makes it safe to aim at another window. `includeObservedAt` adds
 * the time the verdict was actually reached: the page's own synchronous section, not the
 * instant Node happens to hear back. */
export function threadViewProbeExpression({ threadId, expectedPageUrl, includeObservedAt = false, timeoutMs = 15000 } = {}) {
  if (typeof threadId !== 'string' || !threadId) {
    throw fail('codex-native-rpc-unsupported', 'A view probe needs one threadId.');
  }
  return guardExpressionSource(threadId, 'null', timeoutMs, {
    ...(typeof expectedPageUrl === 'string' && expectedPageUrl ? { expectedPageUrl } : {}),
    ...(includeObservedAt === true ? { includeObservedAt: true } : {}),
  });
}

/** The avatar overlay is an attachment page, not a conversation window: the installed
 * desktop mounts it as its own non-focused target (`early-bootstrap-199` @683168). It is
 * the one `app://-/` page that is excluded from the window count, and only in its exact
 * form: `/index.html` with exactly one `initialRoute=/avatar-overlay` and no fragment. */
function isAvatarOverlayPage(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'app:' || parsed.pathname !== '/index.html' || parsed.hash) return false;
    // Exactly one query parameter, and it is the overlay route: anything richer is a page
    // this guard has no evidence about, so it counts as a window.
    if (parsed.searchParams.size !== 1) return false;
    return parsed.searchParams.get('initialRoute') === '/avatar-overlay';
  } catch { return false; }
}

/** Filter one `/json/list` answer down to the app pages a release has to account for.
 * `detached-window.html` and any other `app://-/` page count, because a second window's
 * view cannot be read from the first one. `null` means the shape was not readable. */
function possibleAppPage(url) {
  // A new target can start blank before its app route is published.
  return typeof url !== 'string' || url === '' || url === 'about:blank' || url.startsWith('app://-/');
}

export function appPageTargets(targets) {
  if (!Array.isArray(targets)) return null;
  return targets
    .filter(target => target?.type === 'page' && possibleAppPage(target.url) && !isAvatarOverlayPage(target.url))
    .map(target => ({ id: target.id, url: target.url }));
}

/** The app pages on the endpoint that already serves this renderer, read cheaply over the
 * debug port's `/json/list` instead of enumerating processes. */
export async function appPagesOnEndpoint(found) {
  if (typeof found?.webSocketUrl !== 'string') return null;
  let origin;
  try {
    const url = new URL(found.webSocketUrl);
    origin = `http://${url.hostname}:${url.port}`;
  } catch { return null; }
  try {
    return appPageTargets(await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(1500) })
      .then(response => response.json()));
  } catch { return null; }
}

/** One existing renderer socket per monitor process. No model runner or per-name
 * process is created. A failed mutation is never retried by this transport. */
export function createCodexNativeRpc({ discover = discoverCodexRenderer, WebSocketImpl = WebSocket,
  appPages = appPagesOnEndpoint, targetHandshakeMs = 500, extraProbeTimeoutMs = 1500,
  idleMs = 30000, timeoutMs = 15000 } = {}) {
  let connection, timer, sequence = 0, active = 0, failedUntil = 0, failure;
  function close(target = connection) {
    clearTimeout(timer);
    if (connection === target) connection = undefined;
    target?.socket?.close();
  }
  async function endpoint() {
    // A missing debug port is a property of the running application, not of each
    // call; do not spawn a process inspection for every status or fallback attempt.
    if (failedUntil > Date.now()) throw failure;
    try { return await discover(); }
    catch (error) { failedUntil = Date.now() + 5000; failure = error; throw error; }
  }
  async function connect(target) {
    // The one renderer discovery per connection; the release window check reads this same
    // `found`, so the page list and the socket can never come from different endpoints.
    const found = await endpoint();
    target.found = found;
    const socket = target.socket = new WebSocketImpl(found.webSocketUrl);
    target.pending = new Map();
    socket.addEventListener('message', event => {
      let value;
      try { value = JSON.parse(event.data); } catch { return; }
      // CDP target lifecycle of this very socket: a window that opens and closes while the
      // release is in flight has to be visible even though both page lists look the same.
      if (typeof value?.method === 'string' && value.method.startsWith('Target.target')) {
        recordTargetChange(target, value);
        return;
      }
      const waiter = target.pending.get(value.id);
      if (!waiter) return;
      target.pending.delete(value.id); clearTimeout(waiter.timer);
      if (value.error || value.result?.exceptionDetails) waiter.reject(fail('codex-native-rpc-rejected',
        value.error?.message ?? value.result.exceptionDetails.exception?.description ?? 'Native Desktop request failed.'));
      else waiter.resolve(value.result);
    });
    socket.addEventListener('close', () => {
      if (connection === target) connection = undefined;
      for (const waiter of target.pending.values()) { clearTimeout(waiter.timer); waiter.reject(fail('codex-native-rpc-closed', 'Native Desktop connection closed.')); }
      target.pending.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(fail('codex-native-rpc-timeout', 'Native Desktop connection timed out.')); }, timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(fail('codex-native-rpc-unavailable', 'Native Desktop connection failed.')); }, { once: true });
    });
    target.watch = null;
    return target;
  }
  function command(target, method, params, waitMs = timeoutMs + 1000) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        target.pending.delete(id);
        reject(fail('codex-native-rpc-response-timeout', 'Native Desktop request timed out.'));
      }, waitMs);
      target.pending.set(id, { resolve, reject, timer });
      try { target.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer);
        target.pending.delete(id);
        reject(error);
      }
    });
  }
  /**
   * Start watching this socket's target lifecycle, which is only done when a release begins.
   * It proves itself before it is trusted: the `Target.setDiscoverTargets` command has to be
   * answered on this endpoint and the main window's own target has to be reported by it.
   * Anything else is `unavailable`, and an unavailable watch never releases.
   */
  async function startReleaseWatch(target) {
    if (target.watch) return target.watch;
    target.watch = (async () => {
      target.pages = new Map();
      target.pageGeneration = 0;
      target.sawMainTarget = false;
      let announce;
      const watching = new Promise(resolve => { announce = resolve; });
      target.targetWatch = announce;
      const answered = command(target, 'Target.setDiscoverTargets', { discover: true }, targetHandshakeMs)
        .then(result => result !== undefined, () => false);
      const settled = await Promise.race([watching.then(() => 'event'),
        new Promise(resolve => { const timer = setTimeout(() => resolve('timeout'), targetHandshakeMs); timer.unref?.(); })]);
      const acknowledged = await answered;
      target.targetWatch = null;
      return acknowledged && settled === 'event' && target.sawMainTarget ? 'ready' : 'unavailable';
    })();
    return target.watch;
  }
  function recordTargetChange(target, value) {
    if (value.method === 'Target.targetDestroyed' || value.method === 'Target.targetCrashed') {
      const id = value.params?.targetId;
      if (typeof id !== 'string') return;
      if (target.pages?.delete(id)) target.pageGeneration += 1;
      return;
    }
    const info = value.params?.targetInfo;
    if (!info || typeof info.targetId !== 'string' || typeof info.type !== 'string') return;
    if (info.targetId === target.found?.targetId && info.type === 'page' && info.url === 'app://-/index.html') {
      target.sawMainTarget = true;
      target.targetWatch?.();
    }
    if (info.type !== 'page') return;
    const isApp = possibleAppPage(info.url);
    const known = target.pages?.get(info.targetId);
    if (!isApp) {
      if (known !== undefined) { target.pages.delete(info.targetId); target.pageGeneration += 1; }
      return;
    }
    const url = info.url ?? '';
    if (known === undefined || known !== url) target.pageGeneration += 1;
    target.pages.set(info.targetId, url);
  }
  // The pages of one snapshot, split by the page this socket actually is: the main renderer
  // (which the prepare/commit path already speaks for) and every other app page, which has
  // to be probed on its own. The real desktop keeps a hidden `detached-window.html` shell
  // next to the main window, so "more than one page" alone is not a view.
  function splitPages(pages, found) {
    if (!Array.isArray(pages)) return { verdict: { status: 'unverified', reason: 'window-check-unavailable' } };
    if (typeof found?.targetId !== 'string') return { verdict: { status: 'unverified', reason: 'window-check-mismatch' } };
    const main = pages.find(page => page?.id === found.targetId);
    if (!main || main.url !== 'app://-/index.html') {
      return { verdict: { status: 'unverified', reason: 'window-check-mismatch' } };
    }
    const others = pages.filter(page => page?.id !== found.targetId);
    // Every other page needs an id and a URL: an entry this build cannot name is a page it
    // cannot probe, and a page it cannot probe is never released past.
    if (others.some(page => typeof page?.id !== 'string' || !page.id || typeof page?.url !== 'string')) {
      return { verdict: { status: 'unverified', reason: 'window-check-unavailable' } };
    }
    return { main, others };
  }
  const pageKey = page => `${page.id}\u0000${page.url}`;
  const samePages = (left, right) => {
    const a = left.map(pageKey).sort(), b = right.map(pageKey).sort();
    return a.length === b.length && a.every((key, index) => key === b[index]);
  };
  /**
   * One other app page, read-only: a temporary connection to the same confirmed loopback
   * endpoint, exactly one `Runtime.evaluate` of the shared probe, and then that socket is
   * closed. It never prepares a credential, never calls the bridge, and never sends a target
   * command or anything else.
   */
  async function probeExtraPage(found, page, threadId, timeoutMs) {
    let socket;
    let timer;
    const unknown = reason => ({ verdict: { status: 'unverified', reason }, observedAt: null });
    try {
      const endpoint = new URL(found.webSocketUrl);
      // Same endpoint and nothing else: the loopback debug socket this connection was
      // discovered on, and a target id that came out of that endpoint's own page list.
      const safeId = typeof page.id === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(page.id);
      if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port || !safeId) {
        return unknown('extra-page-endpoint');
      }
      socket = new WebSocketImpl(`ws://${endpoint.hostname}:${endpoint.port}/devtools/page/${encodeURIComponent(page.id)}`);
      let sentAt = null;
      let receivedAt = null;
      const reply = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else { receivedAt = Date.now(); resolve(value); }
        };
        timer = setTimeout(() => finish(fail('codex-native-rpc-response-timeout', 'Extra page probe timed out.')), timeoutMs);
        timer.unref?.();
        socket.addEventListener('message', event => {
          let value;
          try { value = JSON.parse(event.data); } catch { return; }
          if (value?.id !== 1) return;
          finish(null, value);
        });
        socket.addEventListener('close', () => finish(fail('codex-native-rpc-closed', 'Extra page socket closed.')));
        socket.addEventListener('error', () => finish(fail('codex-native-rpc-unavailable', 'Extra page socket failed.')));
        socket.addEventListener('open', () => {
          try {
            const expression = threadViewProbeExpression({ threadId, expectedPageUrl: page.url,
              includeObservedAt: true, timeoutMs });
            sentAt = Date.now();
            socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
              params: { expression, awaitPromise: true, returnByValue: true } }));
          } catch (error) {
            finish(fail('codex-native-rpc-unavailable', `Extra page send failed: ${error?.message ?? error}`));
          }
        }, { once: true });
      });
      const value = reply?.result?.result?.value;
      if (value?.status === 'inUse') {
        return { verdict: { status: 'inUse', reason: `extra-page:${value.reason ?? 'in-use'}` }, observedAt: null };
      }
      if (value?.status !== 'observed' || value.mounted !== false || value.role !== null) {
        return unknown('extra-page-unverified');
      }
      // The page reports when it reached the verdict; it has to sit inside this one
      // evaluation (sent, then received). Real Windows rounds the two processes' clocks
      // apart by up to a millisecond, so the window is widened by 5 ms — and the stamp used
      // for the commit is moved 5 ms earlier, so the 100 ms limit is never extended.
      const observedAt = value.observedAt;
      if (!Number.isSafeInteger(observedAt) || sentAt === null || receivedAt === null
        || observedAt < sentAt - RELEASE_CLOCK_TOLERANCE_MS
        || observedAt > receivedAt + RELEASE_CLOCK_TOLERANCE_MS) {
        return unknown('extra-page-observation');
      }
      return { verdict: null, observedAt: Math.min(observedAt, receivedAt) - RELEASE_CLOCK_TOLERANCE_MS };
    } catch {
      return unknown('extra-page-unavailable');
    } finally {
      clearTimeout(timer);
      // Only this probe's own socket; the shared connection is never touched here.
      try { socket?.close?.(); } catch { /* already gone */ }
    }
  }
  return { close, async request(method, params, options = {}) {
    const { canRelease, signal } = options ?? {};
    const release = method === 'thread/unsubscribe';
    const background = options?.background === true && (method === 'thread/read' || method === 'thread/list');
    const userInputRead = method === 'futureaide/userInput/read';
    const userInputReply = method === 'futureaide/userInput/reply';
    const expression = release ? null : userInputRead ? userInputReadExpression(params)
      : userInputReply ? userInputReplyExpression(params) : nativeRpcExpression(method, params, timeoutMs);
    clearTimeout(timer); active++;
    let target;
    try {
      // A release is the one call that can drop the user's own subscription, so it is the
      // one call with a local permission contract. `canRelease` has to answer a synchronous
      // `true` — anything else (undefined, a promise, a throw) is a refusal — and it is
      // asked before this side connects, and again immediately before the commit. An aborted
      // `signal` stops it at either point. A rejected or failing release returns a release
      // answer and leaves the shared socket and every other in-flight request alone.
      const permitted = () => {
        try {
          if (typeof canRelease !== 'function') return { go: false, reason: 'unauthorized' };
          if (canRelease() !== true) return { go: false, reason: 'cancelled' };
        } catch { return { go: false, reason: 'cancelled' }; }
        return signal?.aborted === true ? { go: false, reason: 'aborted' } : { go: true };
      };
      if (release) {
        const before = permitted();
        if (!before.go) return { status: 'notSent', reason: before.reason };
      }
      if (!connection) { connection = {}; connection.ready = connect(connection); }
      target = connection; await target.ready;
      if (GATED_WRITE_METHODS.has(method) && typeof options?.blockReason === 'function') {
        const refused = options.blockReason();
        if (refused) throw fail(refused, 'The round ended before this request was written; nothing was sent.',
          { terminal: true, notSent: true });
      }
      if (userInputReply && (signal?.aborted || (typeof options.canAnswer === 'function' && options.canAnswer() !== true))) {
        return { status: 'unknown', reason: 'round-finished' };
      }
      const evaluate = async value => {
        const reply = await command(target, 'Runtime.evaluate', { expression: value, awaitPromise: true, returnByValue: true });
        const result = reply?.result?.value;
        if (result?.__futureaideRpcError) throw fail('codex-native-rpc-rejected',
          `Native Desktop rejected ${method}: ${result.__futureaideRpcError.message}`,
          { rpcCode: result.__futureaideRpcError.code, rpcMessage: result.__futureaideRpcError.message, rpcData: result.__futureaideRpcError.data });
        return result;
      };
      if (!release) return await evaluate(expression);

      const releaseOnce = async () => {
        // The watch is started before the first window snapshot, so a change that happens
        // while that snapshot is being read is still counted by the generation.
        const watch = await startReleaseWatch(target);
        if (watch !== 'ready') return { status: 'unverified', reason: 'window-tracking-unavailable' };
        const generation = target.pageGeneration;
        const began = splitPages(await appPages(target.found), target.found);
        if (began.verdict) return began.verdict;
        if (target.pageGeneration !== generation) return { status: 'inUse', reason: 'window-check-changed' };

        const token = `release-${randomUUID()}`;
        const probe = await evaluate(threadUnsubscribePrepareExpression({ threadId: params?.threadId, token, timeoutMs }));
        if (probe?.status !== 'observed') return probe;

        // Every other app page is probed in parallel, on its own short-lived socket, and each
        // one reports the instant it actually reached its verdict. Only after all of them are
        // in is the final snapshot requested, so no stale first evidence can hide behind a
        // later refresh.
        const extraResults = await Promise.all(began.others.map(page =>
          probeExtraPage(target.found, page, params?.threadId, extraProbeTimeoutMs)));
        for (const result of extraResults) {
          if (result.verdict) return result.verdict;
        }
        // The final snapshot travels on the socket that delivers target events and executes
        // the commit. The renderer checks its age before sending.
        const snapshotAt = Date.now();
        const reply = await command(target, 'Target.getTargets', {}, targetHandshakeMs).catch(() => undefined);
        const infos = reply?.targetInfos;
        const latest = Array.isArray(infos) && infos.every(info => typeof info?.type === 'string'
          && typeof info?.targetId === 'string' && typeof info?.url === 'string')
          ? appPageTargets(infos.map(info => ({ type: info.type, id: info.targetId, url: info.url }))) : null;
        const after = splitPages(latest, target.found);
        if (after.verdict) return after.verdict;
        // The same set of other pages has to be on both sides: a page that appeared or went
        // away during the release is exactly what this release must not step over.
        if (!samePages(began.others, after.others)) return { status: 'inUse', reason: 'window-check-changed' };
        if (target.pageGeneration !== generation) return { status: 'inUse', reason: 'window-check-changed' };

        // The freshness clock starts at the earliest real observation: an extra page's own
        // verdict time, or the moment the final snapshot was asked for. Both are moved the
        // same 5 ms earlier for cross-process clock rounding, so the deadline is never
        // stretched and a page read first cannot be made to look fresh by a later refresh.
        const checkedAt = extraResults.reduce((earliest, result) =>
          Math.min(earliest, result.observedAt), snapshotAt - RELEASE_CLOCK_TOLERANCE_MS);

        const permittedNow = permitted();
        if (!permittedNow.go) return { status: 'notSent', reason: permittedNow.reason };
        // One more generation read, after the last permission answer and before the commit.
        if (target.pageGeneration !== generation) return { status: 'inUse', reason: 'window-check-changed' };
        // The commit spends the credential, rechecks this window's route and view
        // lease, and sends on the same renderer tick. A different window can still
        // open after this final snapshot but before the queued evaluation starts.
        return await evaluate(threadUnsubscribeSendExpression({
          threadId: params?.threadId, token, checkedAt, timeoutMs,
        }));
      };
      try {
        return await releaseOnce();
      } catch (error) {
        // A release failure is this call's own; it never invalidates the shared socket and
        // never rejects a turn/start running beside it.
        return { status: 'unverified', reason: `release-failed:${error?.code ?? 'unknown'}` };
      }
    } catch (error) {
      // This socket is shared by every managed name in the monitor process. A
      // JSON-RPC/application rejection (bad params, missing thread, unsupported
      // method) must not tear down another name's in-flight write. Only a real
      // transport failure invalidates the socket.
      if ((background || userInputRead || userInputReply) && error?.code === 'codex-native-rpc-response-timeout') throw error;
      if (!error?.code || ['codex-native-rpc-unavailable', 'codex-native-rpc-timeout',
        'codex-native-rpc-response-timeout', 'codex-native-rpc-closed',
        'codex-native-rpc-invalid-response'].includes(error.code)) close(target);
      throw error;
    }
    finally { if (!--active) { timer = setTimeout(() => close(), idleMs); timer.unref?.(); } }
  } };
}

const nativeRpc = createCodexNativeRpc();
export const requestCodexNative = (method, params, options) => nativeRpc.request(method, params, options);
export const closeCodexNative = () => nativeRpc.close();

/** Read one thread's metadata; a profile switch is surfaced as a terminal error. */
export async function readCodexThreadNative(threadId, { request = requestCodexNative, includeTurns = false } = {}) {
  try {
    const result = await request('thread/read', { threadId, includeTurns });
    const thread = result?.thread;
    if (!thread || typeof thread.id !== 'string') throw fail('codex-native-rpc-invalid-response', 'Codex returned no thread metadata.');
    return thread;
  } catch (error) {
    if (isCodexThreadMissing(error)) throw codexThreadNotFound(threadId);
    if (isCodexRolloutEmpty(error)) throw fail('codex-empty-rollout',
      'The Codex thread exists but its rollout content is not written yet.', { threadId });
    throw error;
  }
}

/** Cold threads are resumed before a read of turns or a new turn is attempted. */
export async function ensureCodexThreadNative(threadId, { request = requestCodexNative } = {}) {
  let thread = await readCodexThreadNative(threadId, { request });
  if (thread?.status?.type !== 'notLoaded') return thread;
  try {
    const resumed = await request('thread/resume', { threadId, excludeTurns: true });
    if (resumed?.thread) return resumed.thread;
  } catch (error) {
    if (isCodexThreadMissing(error)) throw codexThreadNotFound(threadId);
    throw error;
  }
  return readCodexThreadNative(threadId, { request });
}

/** What `thread/unsubscribe` may answer, and which answers mean the desktop really let
 * go. `unsubscribed`/`notSubscribed` are the acknowledgement, `notLoaded` is the proof,
 * and `inUse`/`unverified` are the guarded guard refusing to speak for this connection. */
export const RELEASE_STATUSES = Object.freeze({
  acknowledged: ['unsubscribed', 'notSubscribed'],
  unloaded: ['notLoaded'],
  // `notSent` is the local permission saying no (or the signal being aborted) before the
  // request left; it never travelled, so it counts with the refusals, not with the answers.
  refused: ['inUse', 'unverified', 'notSent'],
});

/** Two processes on one machine still round `Date.now` apart by about a millisecond, so a
 * page stamp may sit this far outside the Node-side send/receive window. It is used only to
 * accept the stamp, never to extend the commit window: the stamp itself is moved this much
 * earlier. */
export const RELEASE_CLOCK_TOLERANCE_MS = 5;

/** Ask the desktop to release one thread. The view/role guard runs in the renderer, the
 * window gate runs on the same socket, and `canRelease`/`signal` are the caller's own
 * synchronous brake; an answer this build does not know is reported as `unverified`, never
 * as success, and no other thread is touched. */
// ---------------------------------------------------------------------------------------
// Native user input (`item/tool/requestUserInput`) over the desktop's own app client.
//
// A pending server request is not persisted and has no app-server read method, so the only
// readable copy is the desktop's own conversation state: `requests[]` on the conversation
// object, filled when the request arrived (`early-bootstrap-199` @1643540). Reading and
// answering therefore go through the same confirmed app scope the release guard uses:
// `getConversation(threadId)` and `replyWithUserInputResponse(threadId, requestId, {answers})`
// (@1546463, @1655659). The raw `mcp-response` bridge is never used here.
// ---------------------------------------------------------------------------------------

/** Resolve the confirmed app scope and this host's client rpc, or null. */
export function pageAppClient(win, load, internals) {
  return (async () => {
    const importModule = typeof load === 'function' ? load : url => import(url);
    const sources = [...(win.document?.querySelectorAll('script[src]') ?? [])]
      .map(node => String(node.src ?? ''));
    const entry = sources.includes(`app://-${internals.entryAssetPath}`)
      ? `app://-${internals.entryAssetPath}` : null;
    if (!entry) return null;
    let registry;
    try { registry = (await importModule(entry)).__webpack_require__; } catch { return null; }
    if (typeof registry !== 'function' || !registry.c) return null;
    const scopeOwner = registry.c[internals.scopeModule]?.exports;
    if (typeof scopeOwner?.[internals.scopeAccessor] !== 'function') return null;
    const scope = scopeOwner[internals.scopeAccessor]()?.scope;
    if (!scope || typeof scope.get !== 'function' || !scope.node) return null;
    const token = registry.c[internals.tokenModule]?.exports?.[internals.tokenAccessor];
    if (token === undefined || scope.node.token !== token) return null;
    const hostClient = scope.get(registry.c[internals.hostClientsModule]?.exports?.[internals.hostClientsAccessor],
      'local');
    const rpc = hostClient?.status === 'ready'
      ? (hostClient.client?.rpc ?? hostClient.requestClient?.rpc) : undefined;
    if (typeof rpc?.getConversation !== 'function') return null;
    return { scope, rpc };
  })();
}

/** One classifier for both halves. Everything it looks at — the source item, the desktop's
 * pending marker and the receipt — is taken from the card's own turn, so an item of another
 * turn is never evidence for this card. */
export function pageClassifyUserInput(entry, turns, internals) {
  const params = entry?.params ?? {};
  const requestId = entry?.id;
  const turnId = typeof params.turnId === 'string' ? params.turnId : null;
  const list = Array.isArray(turns) ? turns : [];
  const turn = turnId === null ? undefined : list.find(candidate => candidate?.turnId === turnId);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const questions = (Array.isArray(params.questions) ? params.questions : []).map(question => ({
    id: typeof question?.id === 'string' ? question.id : null,
    header: typeof question?.header === 'string' ? question.header : null,
    question: typeof question?.question === 'string' ? question.question : null,
    isOther: question?.isOther === true,
    isSecret: question?.isSecret === true,
    options: (Array.isArray(question?.options) ? question.options : [])
      .map(option => ({ label: option?.label ?? null, description: option?.description ?? null })),
  }));
  const itemId = typeof params.itemId === 'string' ? params.itemId : null;
  const source = itemId === null ? undefined : items.find(item => item?.id === itemId);
  const sourceType = source === undefined ? undefined : (source.type ?? null);
  // The desktop pushes `{ id: 'user-input-response-<requestId>', type: 'userInputResponse',
  // requestId, completed: false }` into this turn when the request arrives (@1028145), and it
  // finds a pending input by scanning a turn for exactly that (@1068384).
  const marker = items.find(item => item?.type === 'userInputResponse'
    && (item.requestId === requestId || item.id === `user-input-response-${requestId}`)
    && item.completed === false);
  // MCP app-tool approvals arrive through this same method, with a fixed template
  // (`mcp_tool_approval_templates.rs`): this is the negative identification.
  const approvalShaped = questions.some(question => question.header === internals.approvalQuestionHeader
    || (question.options.length > 0
      && question.options.every(option => internals.approvalOptionLabels.includes(option.label))));
  const kind = questions.some(question => question.isSecret) ? 'secret'
    : (approvalShaped || internals.approvalItemTypes.includes(sourceType) ? 'mcp-approval'
      // A plain question needs a provable non-approval source and the desktop's own pending
      // marker in this same turn. No source, an unknown source, or a completed marker is not
      // evidence, and the answer is never guessed from what the card looked like before.
      : (sourceType !== null && sourceType !== undefined && marker ? 'question' : 'unknown'));
  return {
    requestId, threadId: params.threadId ?? null, turnId, itemId,
    isBlocking: params.isBlocking === true, kind, questions, items, marker,
  };
}

/** Two card shapes are the same question: same ids, same text, same options. */
export function pageSameQuestions(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((question, index) => {
    const other = right[index];
    if (!other || question?.id !== other.id || question?.header !== other.header
      || question?.question !== other.question || question?.isOther !== other.isOther
      || question?.isSecret !== other.isSecret) return false;
    const a = Array.isArray(question?.options) ? question.options : [];
    const b = Array.isArray(other?.options) ? other.options : [];
    if (a.length !== b.length) return false;
    return a.every((option, position) => option?.label === b[position]?.label
      && option?.description === b[position]?.description);
  });
}

/** Read the pending user-input cards of one thread. Nothing is written, and a read that
 * cannot be made is `unverified` — never an empty list. */
export async function pageReadUserInput(win, load, internals, threadId, resolveClient = pageAppClient) {
  const unknown = reason => ({ status: 'unverified', reason });
  try {
    const client = await resolveClient(win, load, internals);
    if (!client) return unknown('no-app-client');
    const { rpc } = client;
    if (typeof rpc.getConversation !== 'function') return unknown('no-conversation-read');
    let conversation;
    try { conversation = await rpc.getConversation(threadId); }
    catch { return unknown('conversation-read-failed'); }
    if (!conversation || typeof conversation !== 'object') return unknown('no-conversation');
    if (!Array.isArray(conversation.requests)) return unknown('no-requests');
    const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
    const requests = [];
    for (const entry of conversation.requests) {
      if (entry?.method !== 'item/tool/requestUserInput') continue;
      if (!(typeof entry.id === 'string' && entry.id) && !Number.isSafeInteger(entry.id)) continue;
      // Exact thread match only: another thread's pending question is not this thread's.
      if (entry.params?.threadId !== threadId) continue;
      const card = pageClassifyUserInput(entry, turns, internals);
      requests.push({
        requestId: card.requestId, threadId, turnId: card.turnId, itemId: card.itemId,
        isBlocking: card.isBlocking, kind: card.kind, questions: card.questions,
      });
    }
    return { status: 'observed', requests };
  } catch (error) {
    return unknown(String(error?.message ?? error));
  }
}

/** Answer one card, but only after re-reading it and classifying it again. A card that is
 * gone, changed, or no longer a plain question is never written. */
export async function pageReplyUserInput(win, load, internals, card, answers, resolveClient = pageAppClient) {
  const outcome = (status, reason) => (reason ? { status, reason } : { status });
  try {
    if (!card || (!(typeof card.requestId === 'string' && card.requestId) && !Number.isSafeInteger(card.requestId))) {
      return outcome('unknown', 'no-card');
    }
    if (typeof card.threadId !== 'string' || !card.threadId) return outcome('unknown', 'no-thread');
    if (card.kind !== 'question') return outcome('unsupported', `kind:${card.kind ?? 'unknown'}`);
    if (typeof card.turnId !== 'string' || !card.turnId || typeof card.itemId !== 'string' || !card.itemId) {
      return outcome('unsupported', 'no-source');
    }
    const client = await resolveClient(win, load, internals);
    if (!client) return outcome('unknown', 'no-app-client');
    const { rpc } = client;
    if (typeof rpc.replyWithUserInputResponse !== 'function') return outcome('unsupported', 'no-reply-method');
    let conversation;
    try { conversation = await rpc.getConversation(card.threadId); }
    catch { return outcome('unknown', 'conversation-read-failed'); }
    const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
    const pending = Array.isArray(conversation?.requests)
      ? conversation.requests.find(entry => entry?.method === 'item/tool/requestUserInput'
        && entry.id === card.requestId
        && entry.params?.threadId === card.threadId
        && entry.params?.turnId === card.turnId
        && entry.params?.itemId === card.itemId)
      : null;
    if (!pending) return outcome('not-pending', 'refreshed-card-missing');
    // The same classifier runs on the refreshed card: a request that turned secret, became an
    // approval, or lost its own turn's marker is refused here, not answered from the copy
    // that was read earlier.
    const fresh = pageClassifyUserInput(pending, turns, internals);
    if (fresh.kind !== 'question') return outcome('unsupported', `kind:${fresh.kind}`);
    if (!pageSameQuestions(fresh.questions, card.questions)) return outcome('unknown', 'questions-changed');
    try {
      await rpc.replyWithUserInputResponse(card.threadId, card.requestId, { answers });
    } catch (error) {
      return outcome('unknown', String(error?.message ?? error));
    }
    // The facade answers a card it no longer holds by simply returning: the manager looks it
    // up with `getConversationRequest` and returns when it is gone (@1655659). A resolved call
    // proves nothing, so read again and require the desktop's own receipt.
    let after;
    try { after = await rpc.getConversation(card.threadId); }
    catch { return outcome('unknown', 'conversation-read-failed'); }
    if (!Array.isArray(after?.requests)) return outcome('unknown', 'conversation-read-failed');
    const stillPending = after.requests.some(entry =>
      entry?.method === 'item/tool/requestUserInput' && entry.id === card.requestId);
    if (stillPending) return outcome('unknown', 'still-pending');
    // The accepted answer is recorded on this turn's own item (`applyUserInputResponse` fills
    // `answers` and flips `completed`, @1028145/@1655659); match it against what was sent.
    const items = (Array.isArray(after?.turns) ? after.turns : [])
      .find(turn => turn?.turnId === card.turnId)?.items ?? [];
    const completed = (Array.isArray(items) ? items : []).find(item => item?.type === 'userInputResponse'
      && (item.requestId === card.requestId || item.id === `user-input-response-${card.requestId}`));
    if (!completed || completed.completed !== true) return outcome('unknown', 'no-completed-item');
    const recorded = completed.answers;
    if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) return outcome('unknown', 'answers-missing');
    if (Object.keys(recorded).length !== Object.keys(answers ?? {}).length) return outcome('unknown', 'answers-mismatch');
    for (const [questionId, value] of Object.entries(answers ?? {})) {
      const sent = Array.isArray(value?.answers) ? value.answers.map(String) : null;
      if (sent === null) return outcome('unknown', 'answers-shape');
      const saved = Array.isArray(recorded[questionId]) ? recorded[questionId].map(String) : null;
      if (saved === null || saved.length !== sent.length || saved.some((text, index) => text !== sent[index])) {
        return outcome('unknown', 'answers-mismatch');
      }
    }
    return outcome('answered');
  } catch (error) {
    return outcome('unknown', String(error?.message ?? error));
  }
}

function userInputExpression(handler, args) {
  return `(() => {
    const pageAppClient = ${pageAppClient.toString()};
    const pageClassifyUserInput = ${pageClassifyUserInput.toString()};
    const pageSameQuestions = ${pageSameQuestions.toString()};
    return (${handler.toString()})(window, null, ${JSON.stringify(RELEASE_GUARD_INTERNALS)}, ${args.map(value => JSON.stringify(value)).join(', ')});
  })()`;
}

export function userInputReadExpression({ threadId } = {}) {
  return userInputExpression(pageReadUserInput, [threadId ?? null]);
}

export function userInputReplyExpression({ card, answers } = {}) {
  return userInputExpression(pageReplyUserInput, [card ?? null, answers ?? {}]);
}

/** Read the pending native user-input cards of one managed thread. Read-only, and a read
 * that cannot be made is `unverified` — never an empty list. Each card carries `kind` so the
 * caller can refuse anything that is not a plain question: `secret`, `mcp-approval` (the
 * app-server delivers MCP app-tool approvals through this same method, see
 * `mcp_tool_approval_templates.rs`) and `unknown`. */
export async function readCodexUserInput(threadId, { request = requestCodexNative } = {}) {
  if (typeof threadId !== 'string' || !threadId) {
    throw fail('codex-native-rpc-unsupported', 'A user-input read needs exactly one Codex thread id.');
  }
  const answer = await request('futureaide/userInput/read', { threadId });
  if (answer?.status !== 'observed' || !Array.isArray(answer.requests)) {
    return { status: 'unverified', reason: answer?.reason ?? 'unknown' };
  }
  return { status: 'observed', requests: answer.requests.map(card => ({
    requestId: card.requestId,
    threadId: card.threadId,
    turnId: card.turnId ?? null,
    itemId: card.itemId ?? null,
    questions: card.questions ?? [],
    isBlocking: card.isBlocking === true,
    kind: card.kind ?? 'unknown',
  })) };
}

/** Answer one card. The page re-reads the conversation and writes only when that exact
 * request is still pending; every other outcome is reported and nothing is sent. */
export async function replyCodexUserInput(card, { answers } = {}, { request = requestCodexNative, signal, canAnswer } = {}) {
  const options = { ...(signal === undefined ? {} : { signal }), ...(canAnswer === undefined ? {} : { canAnswer }) };
  const answer = await request('futureaide/userInput/reply', { card, answers: answers ?? {} }, options);
  const status = answer?.status;
  if (status === 'answered' || status === 'not-pending' || status === 'unsupported' || status === 'unknown') {
    return answer.reason ? { status, reason: answer.reason } : { status };
  }
  return { status: 'unknown', reason: answer?.reason ?? 'unexpected-answer' };
}
export async function releaseCodexThreadNative(threadId, { request = requestCodexNative, timeoutMs, canRelease, signal } = {}) {
  if (typeof threadId !== 'string' || !threadId) {
    throw fail('codex-native-rpc-unsupported', 'A release needs exactly one Codex thread id.');
  }
  const options = {};
  if (typeof canRelease === 'function') options.canRelease = canRelease;
  if (signal !== undefined) options.signal = signal;
  const result = await request('thread/unsubscribe',
    { threadId, ...(timeoutMs === undefined ? {} : { timeoutMs }) }, options);
  const status = typeof result?.status === 'string' && result.status ? result.status : 'unverified';
  return { status, reason: typeof result?.reason === 'string' ? result.reason : undefined };
}

export async function listCodexTurnsNative(threadId, { limit = 40, itemsView = 'summary', cursor, sortDirection = 'desc', request = requestCodexNative } = {}) {
  try {
    const result = await request('thread/turns/list', { threadId, limit, itemsView,
      sortDirection, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw fail('codex-native-rpc-invalid-response', 'Codex returned no turn page.');
    return result;
  } catch (error) {
    // A thread created by thread/start has no rollout until its first turn is
    // written; that is an empty page, not a missing thread.
    if (isCodexRolloutEmpty(error)) return { data: [], nextCursor: null };
    if (isCodexThreadMissing(error)) throw codexThreadNotFound(threadId);
    throw error;
  }
}

/** Read the persisted items of exactly one turn; inspect and marker recovery use this. */
export async function listCodexItemsNative(threadId, turnId, { limit = 100, cursor, sortDirection = 'asc', request = requestCodexNative } = {}) {
  try {
    const result = await request('thread/items/list', { threadId, turnId, limit, sortDirection,
      ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data)) throw fail('codex-native-rpc-invalid-response', 'Codex returned no item page.');
    return result;
  } catch (error) {
    if (isCodexThreadMissing(error)) throw codexThreadNotFound(threadId);
    throw error;
  }
}

/**
 * Read the native model catalog in the order the app-server returns it. Every
 * page is part of one logical list; a repeated cursor is a protocol failure, not
 * a signal to stop early, so the caller never receives a truncated catalog.
 */
export async function listCodexModelsNative({ request = requestCodexNative, includeHidden, limit = 100 } = {}) {
  const data = [], cursors = new Set();
  let cursor;
  do {
    const result = await request('model/list', {
      limit,
      ...(includeHidden === undefined ? {} : { includeHidden: includeHidden === true }),
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result?.data)) throw fail('codex-native-rpc-invalid-response', 'Codex returned no model page.');
    data.push(...result.data);
    cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
    if (cursor && cursors.has(cursor)) throw fail('codex-native-rpc-invalid-response', 'Codex repeated a model-list pagination cursor.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { data, nextCursor: null };
}

/** Send text to an idle thread with turn/start, or add input to the active turn.
 * `model` and `effort` are the already-resolved native values: they are only
 * legal on a new turn. A steer has no such fields, so a running turn can only
 * receive the same selection it already runs with; anything else is refused
 * before a write instead of being silently dropped. */
export async function sendCodexTextNative(threadId, text, { request = requestCodexNative, model, effort, blockReason } = {}) {
  let thread;
  try {
    thread = await ensureCodexThreadNative(threadId, { request });
  } catch (error) {
    // A bound thread with an unwritten first rollout has no metadata to read,
    // but its turn page is still the authoritative "empty" page. Continue to
    // turn/start instead of turning a pre-write read gap into an unknown write.
    if (error.code !== 'codex-empty-rollout') throw error;
  }
  const page = await listCodexTurnsNative(threadId, { limit: 10, itemsView: 'notLoaded', request });
  const active = (page.data ?? []).find(turn => turn?.status === 'inProgress' && typeof turn.id === 'string');
  const input = [{ type: 'text', text, text_elements: [] }];
  // The read and the resume above took time, and a round can end in that gap. The
  // shared fence is asked once more here, immediately before the turn would be written;
  // a refusal is reported as "never sent" so it can never look like an unknown write.
  const refuse = () => {
    const reason = typeof blockReason === 'function' ? blockReason() : undefined;
    if (!reason) return;
    throw fail(reason, 'The round ended before this input was written; nothing was sent.',
      { terminal: true, notSent: true, threadId, ...(active ? { turnId: active.id } : {}) });
  };
  // The same fence travels with the request itself, so it is asked a last time after the
  // connection is live and immediately before the page commits the write.
  const fence = typeof blockReason === 'function' ? { blockReason } : undefined;
  if (active) {
    // Without thread metadata the active turn's selection cannot be proven
    // unchanged, so only an option-free steer is safe.
    const sameModel = model === undefined || thread?.model === model;
    const sameEffort = effort === undefined || (thread?.reasoningEffort ?? undefined) === effort;
    if (!sameModel || !sameEffort) {
      throw fail('codex-model-change-while-running',
        'Codex Desktop cannot change model or effort while a turn is running. This input was not sent; wait for the current turn to end, then send the new selection.',
        { terminal: true, threadId, turnId: active.id });
    }
    refuse();
    const result = await request('turn/steer', { threadId, expectedTurnId: active.id, clientUserMessageId: randomUUID(), input }, fence);
    return { ...(result ?? {}), turnId: result?.turnId ?? active.id };
  }
  refuse();
  return request('turn/start', { threadId, clientUserMessageId: randomUUID(), input,
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }) }, fence);
}
