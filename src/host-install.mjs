import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOST_PRESET = 'codex-control-bridge';

/** Return the module revision embedded in a bootstrap preset without changing local state. */
export async function hostBridgeRevision() {
  const plugin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'host-plugin.mjs');
  return createHash('sha256').update(await readFile(plugin)).digest('hex').slice(0, 16);
}

/** Register the bridge in the current Desktop profile (DSH 0.2 declarations).
 * Its normal profile watcher hot-loads the row; no application restart is needed.
 */
export async function installDesktopHostBridge(config, profileDirectory) {
  if (!path.isAbsolute(profileDirectory || '')) throw new Error('Desktop profile directory must be absolute.');
  const manifest = JSON.parse(await readFile(path.join(profileDirectory, 'package.json'), 'utf8'));
  if (!manifest.dsh?.profile?.bundles?.includes('@deepseek-ai/dsh-web-app')) {
    throw new Error('The selected profile does not contain the native DSH Web application.');
  }
  const credentialFile = config.hostBridgeFile;
  if (!path.isAbsolute(credentialFile || '')) throw new Error('A host bridge credential path is required.');
  await mkdir(path.dirname(credentialFile), { recursive: true });
  await writeFile(credentialFile, JSON.stringify({ version: 1, token: randomBytes(32).toString('hex') }) + '\n',
    { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const credential = JSON.parse(await readFile(credentialFile, 'utf8'));
  if (credential.version !== 1 || !/^[a-f0-9]{64}$/.test(credential.token ?? '')) throw new Error('Existing bridge credential is invalid.');
  const filename = path.join(profileDirectory, 'cordis.patch.yml');
  const begin = '# BEGIN futureaide-control host bridge';
  const end = '# END futureaide-control host bridge';
  const original = await readFile(filename, 'utf8');
  let before = original;
  if (original.includes(begin) || original.includes(end)) {
    const start = original.indexOf(begin), finish = original.indexOf(end);
    if (start < 0 || finish < start || original.indexOf(begin, start + 1) !== -1 || original.indexOf(end, finish + 1) !== -1) {
      throw new Error('The owned bridge patch markers are inconsistent; inspect the profile before installing.');
    }
    before = original.slice(0, start) + original.slice(finish + end.length).replace(/^\r?\n/, '');
  }
  if (/^\s*-\s*id:\s*['"]?codex-control-host-bridge\b/m.test(before)) throw new Error('An unowned host bridge row already exists.');
  before = before.replace(/^\s*\[\]\s*$/m, '');
  const revision = await hostBridgeRevision();
  const module = new URL('./host-plugin.mjs', import.meta.url);
  module.searchParams.set('v', revision);
  const patch = `${begin}\n- insert:\n    - id: codex-control-host-bridge-${revision}\n      name: ${JSON.stringify(module.href)}\n      config:\n        credentialFile: ${JSON.stringify(credentialFile)}\n${end}\n`;
  const content = before.trimEnd() + '\n' + patch;
  if (content !== original) {
    const backup = path.join(path.dirname(credentialFile), 'rollback', `desktop-bridge-${Date.now()}`);
    await mkdir(backup, { recursive: true });
    await copyFile(filename, path.join(backup, 'cordis.patch.yml'));
    const temporary = filename + '.futureaide-control.tmp';
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, filename);
    return { installed: true, profileDirectory, revision, backupDirectory: backup, requiresBootstrapSession: false };
  }
  return { installed: true, profileDirectory, revision, unchanged: true, requiresBootstrapSession: false };
}

/** Install only the owned bootstrap preset; creation loads it without starting a model. */
export async function installHostBridge(config) {
  const credentialFile = config.hostBridgeFile;
  if (!credentialFile || !path.isAbsolute(credentialFile)) throw new Error('A host bridge credential path is required.');
  await mkdir(path.dirname(credentialFile), { recursive: true });
  try {
    await writeFile(credentialFile, JSON.stringify({ version: 1, token: randomBytes(32).toString('hex') }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const credential = JSON.parse(await readFile(credentialFile, 'utf8'));
  if (credential.version !== 1 || !/^[a-f0-9]{64}$/.test(credential.token ?? '')) throw new Error('Existing bridge credential is invalid.');
  const root = path.join(config.dataRoot, '.agent-presets', HOST_PRESET);
  const marker = path.join(root, 'codex-control-owner.json');
  try {
    const previous = JSON.parse(await readFile(marker, 'utf8'));
    if (previous.owner !== 'futureaide-control') throw new Error('Bootstrap preset belongs to another owner.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await mkdir(root); }
    catch (mkdirError) {
      if (mkdirError.code === 'EEXIST') throw new Error('Unowned bootstrap preset already exists.');
      if (mkdirError.code !== 'ENOENT') throw mkdirError;
      await mkdir(path.dirname(root), { recursive: true });
      await mkdir(root);
    }
  }
  const plugin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'host-plugin.mjs');
  const revision = await hostBridgeRevision();
  await writeFile(marker, JSON.stringify({ owner: 'futureaide-control', version: 1 }) + '\n');
  await writeFile(path.join(root, 'preset.yml'), 'name: Codex Control Bridge\ndescription: Local control transport bootstrap. No model prompt is submitted.\norder: 999\n');
  await writeFile(path.join(root, 'agent.cordis.yml'), JSON.stringify([{ id: 'codex-control-host', name: pathToFileURL(plugin).href + '?v=' + revision, config: { credentialFile } }], null, 2) + '\n');
  return { installed: true, preset: HOST_PRESET, presetDirectory: root, revision, requiresBootstrapSession: true };
}
