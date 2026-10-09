import { readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

// Only known, user-owned runtime directories are inspected. No port scan or
// process-command-line/token scraping is used to discover a native DSH host.
async function entries(directory) {
  try {
    const values = await readdir(directory, { withFileTypes: true });
    if (values.length > 128) throw Object.assign(new Error('Too many local control discovery records.'), { code: 'discovery-limit' });
    return values.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function discoveryCandidates({ target = 'auto', dataHome, dshDataHome, temporaryRoot = tmpdir(), preferredInstanceFile } = {}) {
  const futureRoot = path.resolve(dataHome ?? process.env.FUTUREAIDE_DATA_ROOT ?? path.join(homedir(), '.futureaide', '.dsh'));
  const dshRoot = path.resolve(dshDataHome ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh'));
  const candidates = [];
  if (target !== 'dsh') {
    if (preferredInstanceFile) candidates.push({ application: 'futureaide', dataRoot: futureRoot, instanceFile: preferredInstanceFile });
    const shellRoot = path.join(temporaryRoot, 'futureaide-shell');
    for (const entry of await entries(shellRoot)) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.push({ application: 'futureaide', dataRoot: futureRoot,
        instanceFile: path.join(shellRoot, entry.name, 'control-instance.json') });
    }
    candidates.push({ application: 'futureaide', dataRoot: futureRoot, legacy: true });
  }
  if (target !== 'futureaide') {
    const registry = path.join(dshRoot, '.runtime', 'dsh-control', 'instances');
    for (const entry of await entries(registry)) {
      if (entry.isFile() && !entry.isSymbolicLink() && /^\d+\.json$/.test(entry.name)) candidates.push({
        application: 'dsh', dataRoot: dshRoot, instanceFile: path.join(registry, entry.name), registered: true,
      });
    }
  }
  return candidates.filter((candidate, index, all) => !candidate.instanceFile
    || all.findIndex(other => other.instanceFile === candidate.instanceFile) === index);
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
