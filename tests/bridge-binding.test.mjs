import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installDesktopHostBridge, maintenanceConfigPath } from '../src/host-install.mjs';
import { createProfile, loadConfig } from '../src/config.mjs';

test('maintenance config selects installed root unless explicitly overridden', async () => {
  const root = await mkdtemp(path.resolve('.runtime/bridge-binding-'));
  await mkdir(path.join(root, '.runtime'));
  const installed = path.join(root, '.runtime', 'config.json');
  await writeFile(installed, '{}');
  const oldDsh = process.env.DSH_CONTROL_CONFIG, oldLegacy = process.env.FUTUREAIDE_CONTROL_CONFIG;
  delete process.env.DSH_CONTROL_CONFIG; delete process.env.FUTUREAIDE_CONTROL_CONFIG;
  try {
    assert.equal(await maintenanceConfigPath(undefined, root), installed);
    assert.equal(await maintenanceConfigPath('explicit.json', root), 'explicit.json');
    await assert.rejects(maintenanceConfigPath(undefined, path.join(root, 'not-installed')), /configuration not found/);
    process.env.DSH_CONTROL_CONFIG = 'environment.json';
    assert.equal(await maintenanceConfigPath(undefined, root), undefined);
  } finally {
    if (oldDsh === undefined) delete process.env.DSH_CONTROL_CONFIG; else process.env.DSH_CONTROL_CONFIG = oldDsh;
    if (oldLegacy === undefined) delete process.env.FUTUREAIDE_CONTROL_CONFIG; else process.env.FUTUREAIDE_CONTROL_CONFIG = oldLegacy;
  }
});

test('named profiles preserve managed host state and desktop resolver uses selected data root', async () => {
  const root = await mkdtemp(path.resolve('.runtime/bridge-binding-'));
  const configFile = path.join(root, 'config.json');
  const dataRoot = path.join(root, 'dsh');
  const managedStateDirectory = path.join(root, 'managed');
  await writeFile(configFile, JSON.stringify({ target:'dsh', dshDataRoot:dataRoot, managedStateDirectory }));
  await createProfile({profile:'fixture',workspace:root}, configFile);
  assert.equal((await loadConfig(configFile, 'fixture')).managedStateDirectory, managedStateDirectory);
  const saved = JSON.parse(await readFile(path.join(root, 'profiles', 'fixture.json'), 'utf8'));
  assert.equal(saved.managedStateDirectory, managedStateDirectory);
  const resolved = JSON.parse(execFileSync(process.execPath, ['src/cli.mjs','desktop-config','--config',configFile,'--profile','fixture'], {encoding:'utf8'}));
  assert.equal(resolved.dataRoot, dataRoot);
  const viaEnv = JSON.parse(execFileSync(process.execPath, ['src/cli.mjs','desktop-config'], {encoding:'utf8',env:{...process.env, DSH_CONTROL_CONFIG:configFile, DSH_HOME:path.join(root,'other')}}));
  assert.equal(viaEnv.dataRoot, dataRoot);
  saved.managedStateDirectory = 'relative';
  await writeFile(path.join(root, 'profiles', 'fixture.json'), JSON.stringify(saved));
  await assert.rejects(loadConfig(configFile, 'fixture'), /state path must be absolute/);
});

test('different desktop binding requires explicit rebind without changing the existing one', async () => {
  const root = await mkdtemp(path.resolve('.runtime/bridge-binding-'));
  const profile = path.join(root, 'desktop'); await mkdir(profile);
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({dsh:{profile:{bundles:['@deepseek-ai/dsh-web-app']}}}));
  const patch = path.join(profile, 'cordis.patch.yml'); await writeFile(patch, '[]\n');
  const first = {hostBridgeFile:path.join(root,'one','credential.json')};
  const second = {hostBridgeFile:path.join(root,'two','credential.json')};
  await installDesktopHostBridge(first, profile);
  const before = await readFile(patch, 'utf8'); const credential = await readFile(first.hostBridgeFile, 'utf8');
  await assert.rejects(installDesktopHostBridge(second, profile), /binding differs/);
  assert.equal(await readFile(patch,'utf8'), before);
  assert.equal(await readFile(first.hostBridgeFile,'utf8'), credential);
  await assert.rejects(access(second.hostBridgeFile), {code:'ENOENT'});
  await assert.rejects(installDesktopHostBridge({...first, managedStateDirectory:path.join(root,'different-state')}, profile), /binding differs/);
  await installDesktopHostBridge(second, profile, {rebind:true});
  assert.ok((await readFile(patch,'utf8')).includes(JSON.stringify(second.hostBridgeFile)));
  assert.equal(await readFile(first.hostBridgeFile,'utf8'), credential);
  assert.equal((await installDesktopHostBridge(second, profile)).unchanged, true);
});

test('DSH escaped line folding preserves bridge identity and still rejects rebinding', async () => {
  const root = await mkdtemp(path.resolve('.runtime/bridge-binding-'));
  const profile = path.join(root, 'desktop'); await mkdir(profile);
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({dsh:{profile:{bundles:['@deepseek-ai/dsh-web-app']}}}));
  const patch = path.join(profile, 'cordis.patch.yml'); await writeFile(patch, '[]\n');
  const config = {hostBridgeFile:path.join(root,'credentials','host-bridge.json'),managedStateDirectory:path.join(root,'managed-state')};
  await installDesktopHostBridge(config, profile);
  const original = await readFile(patch, 'utf8');
  const folded = original.replace(/^(\s+(?:name|credentialFile|managedStateDirectory): ")([^\r\n"]+)/gm,
    (_whole, prefix, value) => prefix + value.slice(0, 18) + '\\\n          ' + value.slice(18));
  await writeFile(patch, folded);
  const credential = await readFile(config.hostBridgeFile, 'utf8');
  await assert.rejects(installDesktopHostBridge({...config, managedStateDirectory:path.join(root,'other')}, profile), /binding differs/);
  assert.equal(await readFile(patch, 'utf8'), folded);
  assert.equal(await readFile(config.hostBridgeFile, 'utf8'), credential);
  await installDesktopHostBridge(config, profile);
  assert.equal(await readFile(config.hostBridgeFile, 'utf8'), credential);
});
