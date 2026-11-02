import { createDecipheriv, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, copyFile, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const fail = (code, message) => Object.assign(new Error(message), { code });
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
export const isDriveC = value => /^c:/i.test(path.resolve(value).replace(/^\\\\\?\\/, ''));
const ordinaryEnvironment = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|COMSPEC|OS|PROCESSOR_[A-Z_]+|NUMBER_OF_PROCESSORS|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMMONPROGRAMFILES(?:\(X86\))?|PUBLIC|ALLUSERSPROFILE|LANG|LC_ALL|TZ)$/i;

/** Resolve the selected FaSwitch profile, then pin its identity for subsequent turns. */
export async function resolveFaSwitchBinding(config = {}, binding = {}) {
  const root = path.resolve(binding.faSwitchRoot ?? config.faSwitchRoot ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'FAswitch'));
  const codexHome = path.resolve(config.codexProfileHome ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex'));
  const hash = createHash('sha256').update(codexHome.toLowerCase()).digest('hex').slice(0, 24);
  const ownerFile = config.faSwitchOwnerFile ?? path.join(path.dirname(codexHome), `.faswitch-runtime-${hash}`, 'owner.json');
  let owner;
  try { owner = await json(ownerFile); } catch { /* A Claude host may bind its own profile without a Codex host. */ }
  const active = owner?.active;
  const profileId = binding.profileId ?? process.env.FUTUREAIDE_PROFILE_ID ?? active?.profile_id;
  if (!UUID.test(profileId ?? '')) throw fail('profile-unavailable', 'FaSwitch did not supply a bound account profile.');
  let name = binding.name ?? (active?.profile_id === profileId ? active.name : undefined);
  const kind = binding.kind ?? (active?.profile_id === profileId ? active.kind : 'account');
  if (kind !== 'account') throw fail('profile-unsupported', 'Desktop account agents require a FaSwitch account profile.');
  if (!name) {
    for (const item of await readdir(path.join(root, 'profiles'), { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      let meta;
      try { meta = await json(path.join(root, 'profiles', item.name, '.runtime-v2.json')); } catch { continue; }
      if (meta.profile_id === profileId && meta.kind === kind) { name = item.name; break; }
    }
  }
  if (!name || path.basename(name) !== name) throw fail('profile-unavailable', 'The bound FaSwitch profile could not be located.');
  const metadata = await json(path.join(root, 'profiles', name, '.runtime-v2.json'));
  if (metadata.profile_id !== profileId || metadata.kind !== kind) throw fail('profile-changed', 'The selected FaSwitch account no longer matches this agent.');
  const browserEnv = await json(path.join(root, 'browser-envs', 'accounts', name, 'env.json'));
  let proxy;
  try { proxy = new URL(browserEnv.proxy); } catch { throw fail('profile-proxy-unavailable', 'This FaSwitch profile has no usable proxy.'); }
  if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password) throw fail('profile-proxy-unsupported', 'Use the FaSwitch local HTTP proxy for account agents.');
  if (binding.proxy && binding.proxy !== proxy.href.replace(/\/$/, '')) throw fail('profile-proxy-changed', 'The bound profile proxy changed. Recreate this agent to use the new binding.');
  const desktopData = path.join(root, 'client-state', 'claude', kind, profileId, 'home', 'AppData', 'Roaming', 'Claude');
  const codeAuthHome = active?.profile_id === profileId ? (owner.roots?.home ?? codexHome) : path.join(root, 'profiles', name);
  return { ...binding, profileId, kind, name, faSwitchRoot: root, desktopData,
    proxy: proxy.href.replace(/\/$/, ''), codexAuthHome: codeAuthHome };
}

// The DPAPI result stays on this private pipe. Never put it in an exception or log.
async function unprotectCurrentUser(bytes) {
  if (process.platform !== 'win32') throw fail('desktop-auth-platform', 'Reusing this Claude Desktop login currently requires Windows.');
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; try { $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p)); [Array]::Clear($p,0,$p.Length) } catch { exit 2 }";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(fail('desktop-auth-locked', 'The current Windows user could not open this profile login.')); }, 10000);
    child.stdout.on('data', value => { output += value.toString('ascii'); });
    child.once('error', () => { clearTimeout(timer); reject(fail('desktop-auth-locked', 'The Windows credential reader could not start.')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !output) return reject(fail('desktop-auth-locked', 'The current Windows user could not open this profile login.'));
      resolve(Buffer.from(output.trim(), 'base64'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes.toString('base64'));
  });
}

/** Read only this profile's current Code authorization. No refresh or new login is attempted. */
export async function readClaudeDesktopAuthorization(binding, { unprotect = unprotectCurrentUser } = {}) {
  const settings = await json(path.join(binding.desktopData, 'config.json'));
  const account = settings.lastKnownAccountUuid;
  if (!UUID.test(account ?? '')) throw fail('desktop-account-unavailable', 'Claude Desktop has no current account in this FaSwitch profile.');
  if (binding.claudeAccountId && binding.claudeAccountId !== account) throw fail('profile-account-changed', 'The Claude account in this FaSwitch profile changed.');
  const encoded = settings['oauth:tokenCacheV2'] ?? settings['oauth:tokenCache'];
  if (!encoded) throw fail('desktop-code-auth-unavailable', 'Open Code in this already signed-in Claude Desktop profile to initialize its Code authorization.');
  const blob = Buffer.from(encoded, 'base64');
  const prefix = blob.subarray(0, 3).toString('ascii');
  let plaintext;
  if (['v10', 'v11'].includes(prefix)) {
    const state = await json(path.join(binding.desktopData, 'Local State'));
    const wrapped = Buffer.from(state.os_crypt?.encrypted_key ?? '', 'base64');
    if (wrapped.subarray(0, 5).toString() !== 'DPAPI') throw fail('desktop-auth-format', 'This Desktop credential format is unsupported.');
    const key = await unprotect(wrapped.subarray(5));
    try {
      if (key.length !== 32 || blob.length <= 31) throw new Error('format');
      const cipher = createDecipheriv('aes-256-gcm', key, blob.subarray(3, 15));
      cipher.setAuthTag(blob.subarray(-16));
      plaintext = Buffer.concat([cipher.update(blob.subarray(15, -16)), cipher.final()]);
    } catch { throw fail('desktop-auth-locked', 'This profile credential could not be opened.'); }
    finally { key.fill(0); }
  } else {
    if (prefix.startsWith('v')) throw fail('desktop-auth-format', 'This Desktop credential format is unsupported.');
    plaintext = await unprotect(blob);
  }
  let cache;
  try { cache = JSON.parse(plaintext.toString('utf8')); }
  catch { throw fail('desktop-auth-format', 'This Desktop login cache has an unsupported shape.'); }
  finally { plaintext.fill(0); }
  const candidates = Object.entries(cache).flatMap(([key, value]) => {
    const match = /^acct:([^|]+)\|([^:]+):([^:]+):(https?:\/\/[^:]+(?::\d+)?):(.*)$/.exec(key);
    if (!match || match[1] !== account || !match[5].split(' ').includes('user:sessions:claude_code') || !value.token) return [];
    const expiresAt = typeof value.expiresAt === 'number' ? value.expiresAt : Date.parse(value.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60000) return [];
    return [{ token: value.token, orgId: match[3], apiHost: match[4], scopes: match[5], expiresAt,
      subscriptionType: value.subscriptionType, rateLimitTier: value.rateLimitTier }];
  });
  const selected = candidates.filter(value => !binding.claudeOrgId || value.orgId === binding.claudeOrgId);
  if (selected.length !== 1) throw fail('desktop-code-auth-unavailable', 'The current Claude Desktop Code authorization is expired or ambiguous. Open Code in the bound profile to refresh it.');
  return { ...selected[0], accountId: account };
}

async function findClaudeExecutable(binding, override) {
  if (override) { await access(override); return path.resolve(override); }
  const directory = path.join(binding.desktopData, 'claude-code');
  const versions = (await readdir(directory, { withFileTypes: true })).filter(v => v.isDirectory() && /^\d+\.\d+\.\d+$/.test(v.name))
    .map(v => v.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const version of versions) for (const build of await readdir(path.join(directory, version), { withFileTypes: true })) {
    if (!build.isDirectory()) continue;
    const executable = path.join(directory, version, build.name, 'claude.exe');
    try { await access(executable); return executable; } catch { /* Other package entries are not executables. */ }
  }
  throw fail('claude-runtime-unavailable', 'Claude Desktop has not installed its Code runtime yet.');
}

async function findCodexExecutable(config, binding) {
  if (config.codexExecutable) { await access(config.codexExecutable); return path.resolve(config.codexExecutable); }
  const localAppData = binding?.faSwitchRoot ? path.dirname(path.dirname(binding.faSwitchRoot)) : process.env.LOCALAPPDATA ?? '';
  const directory = config.codexRuntimeRoot ?? path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.reverse()) if (entry.isDirectory()) {
    const executable = path.join(directory, entry.name, 'codex.exe');
    try { await access(executable); return executable; } catch { /* Not a runtime directory. */ }
  }
  throw fail('codex-runtime-unavailable', 'The installed Codex runtime was not found.');
}

/** Build a fresh environment; inherited API credentials and proxy overrides are excluded. */
export function isolatedRuntimeEnvironment(binding, directory, base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([key, value]) => ordinaryEnvironment.test(key) && typeof value === 'string'));
  Object.assign(env, { HOME: path.join(directory, 'home'), USERPROFILE: path.join(directory, 'home'),
    APPDATA: path.join(directory, 'home', 'AppData', 'Roaming'), LOCALAPPDATA: path.join(directory, 'home', 'AppData', 'Local'),
    TEMP: path.join(directory, 'temp'), TMP: path.join(directory, 'temp'),
    HTTP_PROXY: binding.proxy, HTTPS_PROXY: binding.proxy, ALL_PROXY: binding.proxy,
    http_proxy: binding.proxy, https_proxy: binding.proxy, all_proxy: binding.proxy,
    NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
    NODE_USE_ENV_PROXY: '1', FUTUREAIDE_PROFILE_ID: binding.profileId });
  return env;
}

/** Copy user instructions only; the child keeps independent settings and auth. */
export async function copyClaudeUserInstructions(binding, directory) {
  const source = path.join(binding.faSwitchRoot, 'client-state', 'claude', binding.kind, binding.profileId, 'claude-config');
  await mkdir(directory, { recursive: true });
  for (const name of ['skills', 'rules']) {
    let entries;
    try { entries = await readdir(path.join(source, name), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      // Ordinary files also work on Windows hosts that reject junction traversal.
      if (entry.isSymbolicLink()) continue;
      await cp(path.join(source, name, entry.name), path.join(directory, name, entry.name), {
        recursive: true, filter: async file => !(await lstat(file)).isSymbolicLink(),
      });
    }
  }
  try { await copyFile(path.join(source, 'CLAUDE.md'), path.join(directory, 'CLAUDE.md')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function resolveRuntimeEnvironment({ runtime, binding = {}, directory, config = {} }) {
  if (!path.isAbsolute(directory ?? '') || isDriveC(directory)) throw fail('agent-directory-invalid', 'Agent runtime data must have its own absolute path outside drive C.');
  const selected = await resolveFaSwitchBinding(config, binding);
  const env = isolatedRuntimeEnvironment(selected, directory);
  for (const root of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP]) await mkdir(root, { recursive: true });
  env.FUTUREAIDE_CONTROL_CONFIG = config.configFile;
  if (runtime === 'claude') {
    const auth = await readClaudeDesktopAuthorization(selected);
    const executable = await findClaudeExecutable(selected, config.claudeExecutable);
    Object.assign(env, { CLAUDE_CONFIG_DIR: path.join(directory, 'claude-config'),
      CLAUDE_CODE_OAUTH_TOKEN: auth.token, CLAUDE_CODE_OAUTH_SCOPES: auth.scopes,
      CLAUDE_CODE_ORGANIZATION_UUID: auth.orgId, CLAUDE_CODE_SUBSCRIPTION_TYPE: auth.subscriptionType ?? '',
      CLAUDE_CODE_RATE_LIMIT_TIER: auth.rateLimitTier ?? '',
      ANTHROPIC_BASE_URL: auth.apiHost, DISABLE_AUTOUPDATER: '1' });
    await copyClaudeUserInstructions(selected, env.CLAUDE_CONFIG_DIR);
    return { executable, env, binding: { ...selected, claudeAccountId: auth.accountId, claudeOrgId: auth.orgId },
      model: config.claudeModel ?? 'opus', effort: config.claudeEffort ?? 'medium' };
  }
  if (runtime !== 'codex') throw fail('runtime-unsupported', 'Choose claude or codex.');
  const source = path.join(selected.codexAuthHome, 'auth.json');
  const authText = await readFile(source, 'utf8');
  const auth = JSON.parse(authText);
  const account = auth.tokens?.account_id;
  if (auth.auth_mode !== 'chatgpt' || !account || !auth.tokens?.access_token) throw fail('codex-account-unavailable', 'The bound FaSwitch profile has no Codex account authorization.');
  if (binding.codexAccountId && binding.codexAccountId !== account) throw fail('profile-account-changed', 'The Codex account in this FaSwitch profile changed.');
  const executable = await findCodexExecutable(config, selected);
  env.CODEX_HOME = path.join(directory, 'codex-home');
  await mkdir(env.CODEX_HOME, { recursive: true });
  const authFile = path.join(env.CODEX_HOME, 'auth.json');
  await writeFile(authFile, authText, { mode: 0o600 });
  const cleanup = async () => {
    try {
      // Preserve an account-token refresh without overwriting another desktop
      // login or a concurrently refreshed source profile.
      const refreshedText = await readFile(authFile, 'utf8');
      const refreshed = JSON.parse(refreshedText);
      if (refreshedText !== authText && refreshed.auth_mode === 'chatgpt'
        && refreshed.tokens?.account_id === account && refreshed.tokens?.access_token
        && await readFile(source, 'utf8') === authText) {
        await writeFile(source, refreshedText, { mode: 0o600 });
      }
    } finally { await writeFile(authFile, '{}\n', { mode: 0o600 }); }
  };
  return { executable, env, binding: { ...selected, codexAccountId: account },
    model: config.codexModel, effort: config.codexEffort,
    cleanup };
}
