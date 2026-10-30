import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
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

export async function discoveryCandidates({ target = 'dsh', dataHome, dshDataHome, preferredInstanceFile } = {}) {
  if (target !== 'dsh') throw new Error('Only target=dsh is supported.');
  const dshRoot = path.resolve(dshDataHome ?? dataHome ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh'));
  const candidates = [];
  if (preferredInstanceFile) candidates.push({ application: 'dsh', dataRoot: dshRoot, instanceFile: preferredInstanceFile });
  const registry = path.join(dshRoot, '.runtime', 'dsh-control', 'instances');
  for (const entry of await entries(registry)) {
    if (entry.isFile() && !entry.isSymbolicLink() && /^\d+\.json$/.test(entry.name)) candidates.push({
      application: 'dsh', dataRoot: dshRoot, instanceFile: path.join(registry, entry.name), registered: true,
    });
  }
  return candidates.filter((candidate, index, all) => !candidate.instanceFile
    || all.findIndex(other => other.instanceFile === candidate.instanceFile) === index);
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
