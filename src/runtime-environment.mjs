import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const fail = (code, message) => Object.assign(new Error(message), { code });
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

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

/**
 * CLI targets are disabled; native Desktop hosts are not connected yet. Refuse
 * every runtime before touching config, binding or the filesystem. No executable
 * environment, auth copy or cleanup write-back is available here.
 * @param {{runtime?: string}} input Runtime selector.
 */
export async function resolveRuntimeEnvironment({ runtime } = {}) {
  if (runtime === 'codex') {
    throw fail('codex-desktop-required', 'The native Codex Desktop target is not connected; independent Codex CLI execution and credential reuse are prohibited.');
  }
  if (runtime === 'claude') {
    throw fail('claude-desktop-required', 'The native Claude Desktop target is not connected; independent Claude CLI execution and credential reuse are prohibited.');
  }
  throw fail('runtime-unsupported', `Unsupported runtime: ${String(runtime)}. No CLI runtime is available; use the Codex Desktop → DSH target.`);
}
