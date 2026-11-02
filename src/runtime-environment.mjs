import { createHash } from 'node:crypto';
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
  if (runtime === 'claude') throw fail('claude-desktop-required', 'Claude CLI execution is disabled. The user requires the existing Claude Desktop window; desktop dispatch is not implemented.');
  if (!path.isAbsolute(directory ?? '') || isDriveC(directory)) throw fail('agent-directory-invalid', 'Agent runtime data must have its own absolute path outside drive C.');
  const selected = await resolveFaSwitchBinding(config, binding);
  const env = isolatedRuntimeEnvironment(selected, directory);
  for (const root of [env.HOME, env.APPDATA, env.LOCALAPPDATA, env.TEMP]) await mkdir(root, { recursive: true });
  env.FUTUREAIDE_CONTROL_CONFIG = config.configFile;
  if (runtime !== 'codex') throw fail('runtime-unsupported', 'Only the Codex CLI runtime is enabled.');
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
