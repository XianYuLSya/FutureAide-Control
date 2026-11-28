import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep copied provider credentials outside the repository and never print them.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = path.resolve(process.env.FUTUREAIDE_VALIDATION_ROOT || 'D:/Work/.futureaide-control-validation/20261030');
const dataRoot = path.join(root, 'dsh');
const sourceHome = path.join(homedir(), '.dsh');
const desktop = path.join(dataRoot, 'profiles', 'control-validation');
const web = path.join(dataRoot, 'profiles', 'web');
await mkdir(desktop, { recursive: true });
for (const file of ['cordis.yml', 'pnpm-workspace.yaml']) await copyFile(path.join(web, file), path.join(desktop, file));
const manifest = JSON.parse(await readFile(path.join(web, 'package.json'), 'utf8'));
manifest.name = 'dsh-profile-control-validation';
await writeFile(path.join(desktop, 'package.json'), JSON.stringify(manifest, null, 2));
let patch = await readFile(path.join(sourceHome, 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8');
const begin = patch.indexOf('# BEGIN futureaide-control host bridge');
const end = patch.indexOf('# END futureaide-control host bridge');
if (begin >= 0 && end > begin) patch = patch.slice(0, begin) + patch.slice(end + '# END futureaide-control host bridge'.length);
if (/[Cc]:[\\/]/.test(patch)) throw new Error('The copied profile contains an absolute C: reference requiring review.');
await writeFile(path.join(desktop, 'cordis.patch.yml'), patch, { mode: 0o600 });
await copyFile(path.join(sourceHome, '.credentials.yaml'), path.join(dataRoot, '.credentials.yaml'));
const config = {
  target: 'dsh', dataRoot, dshDataRoot: dataRoot,
  instanceFile: path.join(root, 'instance.json'),
  hostBridgeFile: path.join(root, 'host-bridge.json'),
};
await writeFile(path.join(root, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
await mkdir(path.join(root, 'temp'), { recursive: true });
await mkdir(path.join(root, 'workspace'), { recursive: true });
process.stdout.write(JSON.stringify({ root, dataRoot, profile: desktop, configFile: path.join(root, 'config.json'), project }) + '\n');
