// Shared CLI network route & FAswitch profile resolver for headless CLI targets
// (codex-cli, antigravity, claude-cli).
//
// Resolution priority (highest to lowest):
//   1. Explicit manual binding (env override or config.cliRoutes.<target> / target-specific proxy/port)
//      - Port number (e.g. 17913) -> http://127.0.0.1:17913
//      - URL (e.g. http://127.0.0.1:17913, socks5://127.0.0.1:7897)
//      - "direct" -> explicitly disable proxy injection
//   2. FAswitch active profile & managed proxy route (read-only from FAswitch state/runtime):
//      - state/current-profile.json + state/current-accounts.json + runtime/proxy-activation.json
//      - Cross-checks profile_id consistency and fails closed on mismatch or inactive proxy
//   3. Fallback when FAswitch is absent: inherit current environment (or fail-closed if requireProxy=true)
//
// Whenever a proxy URL is resolved (manual or FAswitch), TCP reachability is verified
// fail-closed before any CLI process is spawned; it never falls back to direct egress.
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

function stripUrlUserInfo(candidate) {
  const url = new URL(candidate);
  if (!url.username && !url.password) return candidate;
  url.username = '';
  url.password = '';
  const authority = candidate.slice(candidate.indexOf('://') + 3);
  return /[/\\?#]/.test(authority) ? url.href : url.href.replace(/\/$/, '');
}

/** Remove proxy URL user information wherever a route is displayed. */
export function redactProxyCredentials(value) {
  let text = String(value);
  // WHATWG URLs can escape raw whitespace in userinfo. Parse a standalone URL
  // before extracting URL candidates from free-form diagnostics.
  if (/^(?:https?|socks(?:4a?|5h?)?):\/\//i.test(text)) {
    try { text = stripUrlUserInfo(text); } catch { /* Fall through for diagnostics and invalid URLs. */ }
  }
  return text.replace(/\b(?:https?|socks(?:4a?|5h?)?):\/\/(?:(?!(?:https?|socks(?:4a?|5h?)?):\/\/)(?:'[^'\r\n]*'|[^\s<>]))+/gi,
    candidate => {
      try { return stripUrlUserInfo(candidate); }
      catch {
        // Invalid input and surrounding log punctuation must not reveal credentials.
        return candidate.replace(/^(.*?:\/\/)[^/\\?#]*@/, '$1');
      }
    });
}

const PROXY_ENV_KEY = /^(?:http|https|all|no)_proxy$/i;
const DIRECT_VALUES = new Set(['direct', 'none', 'off', 'false']);

const TARGET_ENV_KEYS = Object.freeze({
  'codex-cli': ['FUTUREAIDE_CODEX_CLI_PROXY', 'FUTUREAIDE_CODEX_CLI_PROXY_PORT'],
  'claude-cli': ['FUTUREAIDE_CLAUDE_CLI_PROXY', 'FUTUREAIDE_CLAUDE_CLI_PROXY_PORT'],
  'agy-cli': ['FUTUREAIDE_AGY_CLI_PROXY', 'FUTUREAIDE_AGY_CLI_PROXY_PORT', 'FUTUREAIDE_ANTIGRAVITY_PROXY', 'FUTUREAIDE_ANTIGRAVITY_PROXY_PORT'],
  antigravity: ['FUTUREAIDE_ANTIGRAVITY_PROXY', 'FUTUREAIDE_ANTIGRAVITY_PROXY_PORT'],
});

const TARGET_CONFIG_KEYS = Object.freeze({
  'codex-cli': ['codexCliProxy', 'codexCliProxyPort'],
  'claude-cli': ['claudeCliProxy', 'claudeCliProxyPort'],
  'agy-cli': ['agyCliProxy', 'agyCliProxyPort', 'antigravityProxy', 'antigravityProxyPort'],
  antigravity: ['antigravityProxy', 'antigravityProxyPort'],
});

const TARGET_FASWITCH_CLIENT = Object.freeze({
  'codex-cli': 'codex',
  'claude-cli': 'claude',
  'agy-cli': 'antigravity',
  antigravity: 'antigravity',
});

async function readJsonOptional(filePath, read = readFile) {
  try { return JSON.parse(await read(filePath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined; return undefined; }
}

/**
 * Default FAswitch installation/data root on Windows (`%LOCALAPPDATA%\Programs\FAswitch`).
 */
export function defaultFaswitchRoot(env = process.env) {
  const fromEnv = typeof env?.FASWITCH_HOME === 'string' && env.FASWITCH_HOME.trim()
    ? env.FASWITCH_HOME.trim() : '';
  if (fromEnv) return path.resolve(fromEnv);
  const localAppData = env?.LOCALAPPDATA || env?.LocalAppData
    || (process.platform === 'win32' ? path.join(homedir(), 'AppData', 'Local') : '');
  if (!localAppData) return undefined;
  return path.join(localAppData, 'Programs', 'FAswitch');
}

/**
 * Parse a manual proxy specification: port number, numeric port string, full URL,
 * "direct", or `{ proxy?, proxyUrl?, port?, mode? }`.
 */
export function normalizeProxySpec(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw Object.assign(new Error(`Invalid proxy port: ${value}`), { code: 'invalid-proxy-config' });
    }
    return { mode: 'proxy', proxyUrl: `http://127.0.0.1:${value}`, port: value };
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (DIRECT_VALUES.has(trimmed.toLowerCase())) {
      return { mode: 'direct', proxyUrl: null, port: null };
    }
    if (/^\d{1,5}$/.test(trimmed)) {
      const port = Number.parseInt(trimmed, 10);
      if (port < 1 || port > 65535) {
        throw Object.assign(new Error(`Invalid proxy port: ${trimmed}`), { code: 'invalid-proxy-config' });
      }
      return { mode: 'proxy', proxyUrl: `http://127.0.0.1:${port}`, port };
    }
    let parsed;
    try { parsed = new URL(trimmed); }
    catch {
      throw Object.assign(new Error(`Invalid proxy URL: ${redactProxyCredentials(trimmed)}`), { code: 'invalid-proxy-config' });
    }
    if (!['http:', 'https:', 'socks5:', 'socks5h:', 'socks4:', 'socks:'].includes(parsed.protocol)) {
      throw Object.assign(new Error(`Unsupported proxy protocol: ${parsed.protocol}`), { code: 'invalid-proxy-config' });
    }
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : (parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : NaN);
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw Object.assign(new Error(`Proxy URL must specify a valid host and port: ${redactProxyCredentials(trimmed)}`), { code: 'invalid-proxy-config' });
    }
    return { mode: 'proxy', proxyUrl: trimmed, port };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.mode === 'string' && DIRECT_VALUES.has(value.mode.trim().toLowerCase())) {
      return { mode: 'direct', proxyUrl: null, port: null };
    }
    const inner = value.proxyUrl ?? value.proxy ?? value.port;
    if (inner !== undefined) return normalizeProxySpec(inner);
    return undefined;
  }
  throw Object.assign(new Error('Proxy configuration must be a port, URL, "direct", or route object.'), { code: 'invalid-proxy-config' });
}

/**
 * Fail-closed TCP reachability check for a proxy endpoint (e.g. http://127.0.0.1:17913).
 */
export async function checkProxyReachable(proxyUrl, { timeoutMs = 1500 } = {}) {
  if (typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
    return { ok: false, host: null, port: null, error: 'Proxy URL is empty or missing.' };
  }
  let parsed;
  try { parsed = new URL(proxyUrl.trim()); }
  catch (error) {
    return { ok: false, host: null, port: null, error: `Invalid proxy URL: ${error?.message ?? error}` };
  }
  const host = parsed.hostname;
  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : (parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : NaN);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, host: host || null, port: null, error: `Proxy URL must include a valid host and port: ${redactProxyCredentials(proxyUrl)}` };
  }
  const boundedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 1500;
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    const socket = net.createConnection({ host, port });
    socket.setTimeout(boundedTimeout);
    socket.once('connect', () => finish({ ok: true, host, port, error: null }));
    socket.once('timeout', () => finish({
      ok: false, host, port,
      error: `Proxy TCP probe timed out after ${boundedTimeout}ms (${host}:${port}).`,
    }));
    socket.once('error', error => finish({
      ok: false, host, port,
      error: String(error?.message || error?.code || error),
    }));
  });
}

/**
 * Read active profile & managed proxy route from FAswitch 3.2 runtime state (read-only).
 * Never reads or copies any account credentials.
 */
export async function readFaswitchRoute({
  client = 'codex',
  faswitchHome,
  env = process.env,
  read = readFile,
} = {}) {
  const root = (typeof faswitchHome === 'string' && faswitchHome.trim())
    ? path.resolve(faswitchHome.trim())
    : defaultFaswitchRoot(env);
  if (!root) return { present: false };

  const [currentProfile, currentAccounts, proxyActivation] = await Promise.all([
    readJsonOptional(path.join(root, 'state', 'current-profile.json'), read),
    readJsonOptional(path.join(root, 'state', 'current-accounts.json'), read),
    readJsonOptional(path.join(root, 'runtime', 'proxy-activation.json'), read),
  ]);

  if (!currentProfile && !currentAccounts && !proxyActivation) {
    return { present: false };
  }

  const active = currentProfile?.active && typeof currentProfile.active === 'object' ? currentProfile.active : null;
  const activeProfileId = typeof active?.profile_id === 'string' && active.profile_id.trim() ? active.profile_id.trim() : null;
  const activeProfileName = typeof active?.name === 'string' && active.name.trim() ? active.name.trim() : null;
  const activeProfileKey = typeof active?.profile_key === 'string' && active.profile_key.trim() ? active.profile_key.trim() : null;
  const codexHome = typeof currentProfile?.roots?.home === 'string' && path.isAbsolute(currentProfile.roots.home)
    ? currentProfile.roots.home : null;

  const clientAccount = client && currentAccounts && typeof currentAccounts[client] === 'object'
    ? currentAccounts[client] : null;
  if (client === 'antigravity' && !clientAccount) {
    // FAswitch profile proxies isolate OpenAI/Anthropic accounts unless an explicit
    // antigravity client entry is present; do not hijack agy-cli onto codex/claude routes.
    return { present: false };
  }
  const clientProfileId = typeof clientAccount?.profile_id === 'string' && clientAccount.profile_id.trim()
    ? clientAccount.profile_id.trim() : null;

  const expectedProfileId = clientProfileId ?? activeProfileId;
  const activationProfileId = typeof proxyActivation?.profile_id === 'string' && proxyActivation.profile_id.trim()
    ? proxyActivation.profile_id.trim() : null;
  const activationPort = Number(proxyActivation?.port);
  const activationState = typeof proxyActivation?.state === 'string' ? proxyActivation.state.trim().toLowerCase() : null;
  const node = typeof proxyActivation?.node === 'string' && proxyActivation.node.trim() ? proxyActivation.node.trim() : null;
  const proxyPid = Number.isSafeInteger(proxyActivation?.pid) ? proxyActivation.pid : null;

  if (!proxyActivation || activationState !== 'active' || !Number.isInteger(activationPort) || activationPort < 1 || activationPort > 65535) {
    return {
      present: true,
      ok: false,
      code: 'faswitch-proxy-inactive',
      source: 'faswitch',
      profileId: expectedProfileId,
      profileName: activeProfileName,
      profileKey: activeProfileKey,
      port: Number.isInteger(activationPort) ? activationPort : null,
      proxyUrl: null,
      node,
      codexHome,
      error: `FAswitch active proxy is not running for profile ${activeProfileName ?? expectedProfileId ?? '(unknown)'} (state=${activationState ?? 'missing'}). Open FAswitch and activate the profile proxy, or bind a manual port in config.json.`,
    };
  }

  if (expectedProfileId && activationProfileId && expectedProfileId !== activationProfileId) {
    return {
      present: true,
      ok: false,
      code: 'faswitch-profile-mismatch',
      source: 'faswitch',
      profileId: expectedProfileId,
      activeProxyProfileId: activationProfileId,
      profileName: activeProfileName,
      profileKey: activeProfileKey,
      port: activationPort,
      proxyUrl: null,
      node,
      codexHome,
      error: `FAswitch profile mismatch: active ${client} profile (${activeProfileName ?? expectedProfileId}) does not match active proxy profile (${activationProfileId}). Wait for profile switch to finish or re-activate in FAswitch.`,
    };
  }

  const proxyUrl = `http://127.0.0.1:${activationPort}`;
  return {
    present: true,
    ok: true,
    source: 'faswitch',
    mode: 'proxy',
    proxyUrl,
    port: activationPort,
    profileId: activationProfileId ?? expectedProfileId,
    profileName: activeProfileName,
    profileKey: activeProfileKey,
    node,
    proxyPid,
    codexHome,
  };
}

function findManualOverride(target, config, env) {
  const envKeys = TARGET_ENV_KEYS[target] ?? [];
  for (const key of [...envKeys, 'FUTUREAIDE_CLI_PROXY']) {
    const raw = env?.[key];
    if (typeof raw === 'string' && raw.trim()) {
      return { raw: raw.trim(), from: `env:${key}` };
    }
  }
  const routeEntry = config?.cliRoutes?.[target]
    ?? (target === 'agy-cli' ? config?.cliRoutes?.antigravity : undefined);
  if (routeEntry !== undefined) {
    return {
      raw: routeEntry,
      from: config?.cliRoutes?.[target] !== undefined ? `config:cliRoutes.${target}` : 'config:cliRoutes.antigravity',
    };
  }
  const cfgKeys = TARGET_CONFIG_KEYS[target] ?? [];
  for (const key of cfgKeys) {
    if (config?.[key] !== undefined) {
      return { raw: config[key], from: `config:${key}` };
    }
  }
}

/**
 * Resolve the effective network route & FAswitch profile for a headless CLI target.
 * Enforces fail-closed TCP reachability whenever a proxy URL is selected.
 */
export async function resolveCliRoute({
  target = 'codex-cli',
  client = TARGET_FASWITCH_CLIENT[target] ?? 'codex',
  config = {},
  env = process.env,
  checkProxy = checkProxyReachable,
  read = readFile,
  requireProxy = false,
} = {}) {
  const manual = findManualOverride(target, config, env);
  if (manual) {
    let spec;
    try { spec = normalizeProxySpec(manual.raw); }
    catch (error) {
      return {
        ok: false,
        code: error.code ?? 'invalid-proxy-config',
        source: 'manual',
        configuredVia: manual.from,
        error: error.message,
      };
    }
    if (!spec || spec.mode === 'direct') {
      return {
        ok: true,
        source: 'manual',
        configuredVia: manual.from,
        mode: 'direct',
        proxyUrl: null,
        port: null,
        proxyReachable: null,
        profileName: null,
        profileId: null,
      };
    }
    const probe = await checkProxy(spec.proxyUrl);
    if (!probe.ok) {
      return {
        ok: false,
        code: 'proxy-unavailable',
        source: 'manual',
        configuredVia: manual.from,
        mode: 'proxy',
        proxyUrl: spec.proxyUrl,
        port: spec.port,
        proxyReachable: false,
        profileName: null,
        profileId: null,
        error: `Bound proxy ${redactProxyCredentials(spec.proxyUrl)} (${manual.from}) is unreachable: ${redactProxyCredentials(probe.error)}`,
      };
    }
    return {
      ok: true,
      source: 'manual',
      configuredVia: manual.from,
      mode: 'proxy',
      proxyUrl: spec.proxyUrl,
      port: spec.port,
      proxyReachable: true,
      profileName: null,
      profileId: null,
    };
  }

  const faswitch = await readFaswitchRoute({
    client,
    faswitchHome: config?.faswitchHome,
    env,
    read,
  });
  if (faswitch.present) {
    if (!faswitch.ok) return faswitch;
    const probe = await checkProxy(faswitch.proxyUrl);
    if (!probe.ok) {
      return {
        ...faswitch,
        ok: false,
        code: 'proxy-unavailable',
        proxyReachable: false,
        error: `FAswitch profile ${faswitch.profileName ?? faswitch.profileId ?? ''} proxy ${redactProxyCredentials(faswitch.proxyUrl)} is unreachable: ${redactProxyCredentials(probe.error)}`,
      };
    }
    return { ...faswitch, ok: true, proxyReachable: true };
  }

  if ((target === 'agy-cli' || target === 'antigravity') && env === process.env && checkProxy === checkProxyReachable) {
    const hasExistingEnvProxy = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']
      .some(key => typeof env?.[key] === 'string' && env[key].trim());
    if (!hasExistingEnvProxy) {
      const localClashUrl = 'http://127.0.0.1:7897';
      const localProbe = await checkProxy(localClashUrl, { timeoutMs: 300 });
      if (localProbe.ok) {
        return {
          ok: true,
          source: 'local-proxy',
          mode: 'proxy',
          proxyUrl: localClashUrl,
          port: 7897,
          proxyReachable: true,
          profileName: null,
          profileId: null,
        };
      }
    }
  }

  if (requireProxy) {
    return {
      ok: false,
      code: 'proxy-required',
      source: 'none',
      mode: 'none',
      proxyUrl: null,
      port: null,
      proxyReachable: false,
      error: `No manual proxy or FAswitch active route was found for ${target}. Bind a port in config.json (cliRoutes.${target}) or activate a profile in FAswitch.`,
    };
  }

  return {
    ok: true,
    source: 'inherit',
    mode: 'inherit',
    proxyUrl: null,
    port: null,
    proxyReachable: null,
    profileName: null,
    profileId: null,
  };
}

function mergeNoProxy(existing) {
  const parts = ['127.0.0.1', 'localhost', '::1'];
  if (typeof existing === 'string' && existing.trim()) {
    for (const item of existing.split(',').map(s => s.trim()).filter(Boolean)) {
      if (!parts.some(p => p.toLowerCase() === item.toLowerCase())) parts.push(item);
    }
  }
  return parts.join(',');
}

/**
 * Construct a clean child environment for a CLI process based on its resolved route.
 * Strips all proxy variable case variants when route is `proxy` or `direct`, sets both
 * uppercase and lowercase proxy vars for Rust/Go/Node CLIs, and pins loopback NO_PROXY.
 */
export function buildCliProxyEnv(baseEnv = process.env, route = {}) {
  const result = {};
  const stripExisting = route?.mode === 'proxy' || route?.mode === 'direct';
  let existingNoProxy = '';
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (/^no_proxy$/i.test(key) && typeof value === 'string' && value.trim()) {
      existingNoProxy = existingNoProxy ? `${existingNoProxy},${value.trim()}` : value.trim();
    }
    if (/^futureaide_antigravity_caller_token_file$/i.test(key)) continue;
    if (stripExisting && PROXY_ENV_KEY.test(key)) continue;
    if (value !== undefined) result[key] = value;
  }
  const noProxy = mergeNoProxy(existingNoProxy);
  if (route?.mode === 'proxy' && typeof route.proxyUrl === 'string' && route.proxyUrl.trim()) {
    const proxy = route.proxyUrl.trim();
    result.HTTP_PROXY = proxy;
    result.HTTPS_PROXY = proxy;
    result.ALL_PROXY = proxy;
    result.http_proxy = proxy;
    result.https_proxy = proxy;
    result.all_proxy = proxy;
    result.NO_PROXY = noProxy;
    result.no_proxy = noProxy;
  } else if (route?.mode === 'direct') {
    result.NO_PROXY = noProxy;
    result.no_proxy = noProxy;
  }
  if (typeof route?.codexHome === 'string' && route.codexHome.trim() && !result.CODEX_HOME) {
    result.CODEX_HOME = route.codexHome.trim();
  }
  return result;
}

/** Compact non-secret route summary suitable for `futureaide_status` diagnostics. */
export function publicRouteSummary(route) {
  if (!route || typeof route !== 'object') return undefined;
  const profile = route.profileName ?? route.profile;
  return {
    source: route.source ?? 'inherit',
    mode: route.mode ?? null,
    ...(profile ? { profile } : {}),
    ...(route.profileId ? { profileId: route.profileId } : {}),
    ...(route.port ? { port: route.port } : {}),
    ...(route.proxyUrl ? { proxy: redactProxyCredentials(route.proxyUrl) } : {}),
    ...(route.node ? { node: route.node } : {}),
    ...(route.configuredVia ? { configuredVia: route.configuredVia } : {}),
    ...(route.proxyReachable !== undefined && route.proxyReachable !== null ? { proxyReachable: route.proxyReachable } : {}),
  };
}
