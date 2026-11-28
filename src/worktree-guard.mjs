import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { link, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { readProcessIdentities } from './agy-cli-runner.mjs';
import { isProcessAlive, queryWin32ProcessInfo } from './process-cage.mjs';

const run = promisify(execFile);
export const worktreeError = (code, message, fields) => Object.assign(new Error(message), { code, ...fields });
const windows = process.platform === 'win32';
export const worktreePathKey = value => windows ? path.resolve(value).toLowerCase() : path.resolve(value);
const childPath = (root, file) => {
  const relative = path.relative(worktreePathKey(root), worktreePathKey(file));
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
/** Check every directory before following it, including Windows junctions. */
export async function plainDirectoryPath(root, target) {
  if (worktreePathKey(root) !== worktreePathKey(target) && !childPath(root, target)) {
    throw worktreeError('worktree-unverified', 'The directory is outside its owned root.');
  }
  let current = path.resolve(root);
  for (const component of ['.', ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    current = path.join(current, component);
    const meta = await lstat(current).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!meta) return false;
    if (!meta.isDirectory() || meta.isSymbolicLink()
        || worktreePathKey(await realpath(current)) !== worktreePathKey(current)) {
      throw worktreeError('worktree-unverified', 'The directory resolves through a link or is not a plain directory.');
    }
  }
  return true;
}

export function referencesWorktree(record, tree) {
  return [record.worktreePath, record.workspace, record.worktreeMerge?.path]
    .some(value => typeof value === 'string' && (worktreePathKey(value) === worktreePathKey(tree) || childPath(tree, value)));
}

export async function otherProfilesReference(tree, { stateDirectory, rosterPath }) {
  const parent = path.dirname(stateDirectory);
  const root = path.basename(parent) === 'profiles' ? path.dirname(parent) : stateDirectory;
  const profilesDirectory = path.join(root, 'profiles');
  const profiles = await readdir(profilesDirectory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (profiles.some(item => item.isSymbolicLink())) throw worktreeError('worktree-unverified', 'A roster profile resolves through a link.');
  const directories = [root, ...profiles.filter(item => item.isDirectory()).map(item => path.join(profilesDirectory, item.name))];
  for (const directory of directories) {
    const filename = path.join(directory, 'roster.sqlite');
    if (rosterPath && worktreePathKey(filename) === worktreePathKey(rosterPath)) continue;
    const meta = await lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!meta) continue;
    if (!meta.isFile() || meta.isSymbolicLink()) throw worktreeError('worktree-unverified', 'A peer roster is not a regular file.');
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      for (const row of db.prepare('SELECT body FROM agents').iterate()) {
        if (referencesWorktree(JSON.parse(row.body), tree)) return true;
      }
    } finally { db.close(); }
  }
  return false;
}

const repositoryOverrides = new Set(['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE']);
export function git(cwd, args, { env = process.env, indexFile, ...options } = {}) {
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !repositoryOverrides.has(key.toUpperCase())));
  if (indexFile) childEnv.GIT_INDEX_FILE = indexFile;
  return run('git', ['-C', cwd, ...args],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options, env: childEnv });
}
const gitValue = async (cwd, args) => (await git(cwd, args)).stdout.trim();
export const gitRoot = async cwd => realpath(await gitValue(cwd, ['rev-parse', '--show-toplevel']));
const commonDir = async cwd => realpath(await gitValue(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
export const commitSha = (cwd, revision) => gitValue(cwd, ['rev-parse', '--verify', '--end-of-options', revision.toLowerCase() === "head" ? "HEAD^{commit}" : revision.toLowerCase() + "^{commit}"]);
export const fullSha = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);

const readOwner = value => {
  try { return JSON.parse(value); } catch { return undefined; }
};

async function lockProcessStart(pid) {
  if (windows) {
    const fast = await queryWin32ProcessInfo(pid);
    if (fast) return fast.startTime;
    if (!isProcessAlive(pid)) return null;
    return run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '(Get-Process -Id ' + pid + ' -ErrorAction Stop).StartTime.ToFileTimeUtc()'],
    { encoding: 'utf8', timeout: 2000, windowsHide: true }).then(({ stdout }) => {
      const value = stdout.trim();
      return /^\d+$/.test(value) ? value : null;
    }, () => null);
  }
  if (process.platform === 'linux') {
    const stat = await readFile('/proc/' + pid + '/stat', 'utf8').catch(() => '');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  }
  return run('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })
    .then(({ stdout }) => stdout.trim() || null, () => null);
}

async function liveCommandFingerprint(pid) {
  const line = (await readProcessIdentities([pid])).get(pid)?.text;
  return line ? createHash('sha256').update(line).digest('hex') : null;
}

async function captureLockOwner() {
  const startedAt = await lockProcessStart(process.pid);
  const commandFingerprint = startedAt
    ? createHash('sha256').update(JSON.stringify([process.execPath, process.execArgv, process.argv])).digest('hex')
    : await liveCommandFingerprint(process.pid);
  return { startedAt, commandFingerprint };
}

let ownProcessIdentity;
const selfIdentity = () => ownProcessIdentity ??= captureLockOwner();

async function recycledLockPid(old, { mtimeMs }) {
  if (old.startedAt) {
    const current = old.pid === process.pid ? (await selfIdentity()).startedAt : await lockProcessStart(old.pid);
    return Boolean(current && current !== old.startedAt);
  }
  if (old.commandFingerprint) {
    const current = await liveCommandFingerprint(old.pid);
    return Boolean(current && current !== old.commandFingerprint);
  }
  if (windows) {
    const { startTime } = await queryWin32ProcessInfo(old.pid) ?? {};
    // The old format has no process identity. A process born after the lock
    // file was published cannot have written it.
    return Boolean(startTime && Number((BigInt(startTime) - 116444736000000000n) / 10000n) > mtimeMs + 1000);
  }
  return false;
}

async function reclaimWorktreeLock(lock) {
  const meta = lstatSync(lock, { throwIfNoEntry: false });
  if (!meta) return true;
  if (!meta.isFile() || meta.isSymbolicLink()) return false;
  const contents = readFileSync(lock, 'utf8');
  const old = readOwner(contents);
  if (Number.isSafeInteger(old?.pid) && old.pid > 0 && old.nonce) {
    let alive = true;
    try { process.kill(old.pid, 0); }
    catch (error) { if (error.code !== 'ESRCH') return false; alive = false; }
    if (alive && !await recycledLockPid(old, meta)) return false;
  } else if (Date.now() - meta.mtimeMs < 1000) {
    // A previous version may still be in the middle of publishing its owner.
    return false;
  }
  // SQLite releases this short reclamation transaction even if its process dies.
  const guard = new DatabaseSync(lock + '.sqlite');
  try {
    guard.exec('BEGIN IMMEDIATE');
    const live = lstatSync(lock, { throwIfNoEntry: false });
    if (!live?.isFile() || live.isSymbolicLink() || live.ino !== meta.ino || live.mtimeMs !== meta.mtimeMs
        || readFileSync(lock, 'utf8') !== contents) return false;
    unlinkSync(lock);
    return true;
  } catch (error) {
    if (error.errcode === 5 || error.code === 'ENOENT') return false;
    throw error;
  } finally { guard.close(); }
}

export async function withWorktreeLock(cwd, fn, { waitMs = 4000 } = {}) {
  const directory = await commonDir(cwd);
  const lock = path.join(directory, 'futureaide-worktree.lock');
  const nonce = randomUUID();
  const pending = path.join(directory, 'fa-' + nonce);
  const identity = await selfIdentity();
  const deadline = Date.now() + waitMs;
  let acquired = false;
  await writeFile(pending, JSON.stringify({ pid: process.pid, nonce, ...identity }), { flag: 'wx', mode: 0o600 });
  try {
    while (!acquired) {
      try {
        // A hard link publishes the complete record without replacing another owner.
        await link(pending, lock);
        acquired = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (await reclaimWorktreeLock(lock).catch(error => {
          if (error.code === 'ENOENT') return true;
          throw error;
        })) continue;
        if (Date.now() >= deadline) throw worktreeError('worktree-busy', 'Another operation holds the repository worktree lock.');
        await delay(35);
      }
    }
    return await fn();
  } finally {
    try {
      if (acquired && readOwner(await readFile(lock, 'utf8').catch(() => ''))?.nonce === nonce) await rm(lock, { force: true });
    } finally { await rm(pending, { force: true }); }
  }
}

export async function createWorktree(cwd, leaf, baseSha) {
  const root = await gitRoot(cwd);
  const callerWorkspace = await realpath(cwd);
  if (worktreePathKey(callerWorkspace) !== worktreePathKey(root) && !childPath(root, callerWorkspace)) {
    throw worktreeError('invalid-workspace', 'The caller workspace resolves outside the repository.');
  }
  return withWorktreeLock(root, async () => {
    let base;
    try { base = await commitSha(root, baseSha ?? 'HEAD'); }
    catch { throw worktreeError('invalid-base-sha', 'The requested worktree base is unavailable.'); }
    if (baseSha && base.toLowerCase() !== baseSha.toLowerCase()) {
      throw worktreeError('invalid-base-sha', 'The worktree base must identify a commit directly.');
    }
    let subdir = path.relative(root, callerWorkspace).split(path.sep).join('/');
    if (subdir) {
      const { stdout } = await git(root, ['ls-tree', '-d', '-r', '-z', '--name-only', base]);
      const matches = stdout.split('\0').filter(Boolean).filter(candidate =>
        windows ? candidate.toLowerCase() === subdir.toLowerCase() : candidate === subdir);
      if (matches.length !== 1) throw worktreeError('invalid-workspace', 'The caller directory is unavailable at the requested base.');
      [subdir] = matches;
    }
    const parent = path.join(root, '.work', 'worktrees');
    await mkdir(parent, { recursive: true });
    if (worktreePathKey(await realpath(parent)) !== worktreePathKey(parent)) {
      throw worktreeError('worktree-unverified', 'The worktree parent resolves through a link.');
    }
    const worktreePath = path.join(parent, leaf);
    await git(root, ['worktree', 'add', '--detach', worktreePath, base]);
    try {
      if (await commitSha(worktreePath, 'HEAD') !== base) throw worktreeError('worktree-base-mismatch', 'The new worktree did not check out the requested base.');
      return { repoRoot: root, callerWorkspace, worktreePath, worktreeBaseHead: base, workspace: path.join(worktreePath, subdir) };
    } catch (error) {
      await git(root, ['worktree', 'remove', worktreePath]);
      throw error;
    }
  });
}

export function hasWorktreeEvidence(record) {
  return Boolean(record?.worktreePath || record?.unmergedWorktree || record?.worktreeMerge);
}

async function registered(root, worktreePath) {
  const { stdout } = await git(root, ['worktree', 'list', '--porcelain', '-z']);
  return stdout.split('\0').some(line => line.startsWith('worktree ')
    && worktreePathKey(line.slice(9)) === worktreePathKey(worktreePath));
}

export async function worktreeIdentity(record, { workspace, shared = () => false } = {}) {
  const worktreePath = record.worktreePath && path.resolve(record.worktreePath);
  if (!worktreePath) throw worktreeError('worktree-unverified', 'The roster has no verified worktree path.');
  const anchor = record.repoRoot ?? record.rootWorkspace ?? workspace;
  const root = await gitRoot(anchor);
  // Older rows may anchor the managed directory under the original project subdirectory.
  const allowed = [...new Set([root, path.resolve(anchor)])].map(base => path.join(base, '.work', 'worktrees'));
  if (!allowed.some(parent => childPath(parent, worktreePath)) || await shared(worktreePath)) {
    throw worktreeError('worktree-unverified', 'The worktree is outside the managed directory or shares another roster reference.');
  }
  let meta;
  try { meta = await lstat(worktreePath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const inGit = await registered(root, worktreePath);
  if (!meta && !inGit) return { root, worktreePath, missing: true };
  if (!meta?.isDirectory() || meta.isSymbolicLink() || !inGit
      || worktreePathKey(await realpath(worktreePath)) !== worktreePathKey(worktreePath)
      || worktreePathKey(await gitRoot(worktreePath)) !== worktreePathKey(worktreePath)
      || worktreePathKey(await commonDir(worktreePath)) !== worktreePathKey(await commonDir(root))) {
    throw worktreeError('worktree-unverified', 'The directory and Git registration do not identify the same managed worktree.');
  }
  return { root, worktreePath, missing: false };
}

export async function inspectWorktree(record, options) {
  if (!hasWorktreeEvidence(record)) return { state: 'clean' };
  try {
    const identity = await worktreeIdentity(record, options);
    if (record.worktreeMerge?.applied && record.worktreeMerge?.worktreeRemoved && identity.missing) {
      return { ...identity, state: 'clean' };
    }
    const terminal = record.task?.state ?? record.state;
    const failure = [terminal, record.state].some(state => ['failed', 'cancelled', 'turn-timeout'].includes(state));
    if (failure || record.worktreeMerge || record.unmergedWorktree) return { ...identity, state: 'retained' };
    if (identity.missing || !fullSha(record.worktreeBaseHead)) return { ...identity, state: 'unknown' };
    const base = await commitSha(identity.root, record.worktreeBaseHead);
    if (base.toLowerCase() !== record.worktreeBaseHead.toLowerCase()) return { ...identity, state: 'unknown' };
    const head = await commitSha(identity.worktreePath, 'HEAD');
    const { stdout } = await git(identity.worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
    return { ...identity, state: head !== base || stdout.length ? 'retained' : 'clean' };
  } catch (error) {
    return { state: 'unknown', reason: error.code ?? 'worktree-unverified' };
  }
}

export async function removeVerifiedWorktree(record, options, { force = false, recheck = () => true } = {}) {
  const identity = await worktreeIdentity(record, options);
  if (identity.missing) {
    if (force || record.worktreeMerge?.applied) return;
    throw worktreeError('worktree-unverified', 'The worktree disappeared before its removal could be verified.');
  }
  if (!force && (await inspectWorktree(record, options)).state !== 'clean') {
    throw worktreeError('worktree-retained', 'The worktree has changes or its state could not be verified.');
  }
  if (!recheck()) throw worktreeError('worktree-binding-changed', 'The roster changed before the worktree could be removed.');
  await git(identity.root, ['worktree', 'remove', ...(force ? ['--force'] : []), identity.worktreePath]);
  if (!(await worktreeIdentity(record, options)).missing) {
    throw worktreeError('worktree-remove-unverified', 'The worktree directory or Git registration remains.');
  }
}

export async function workspaceEvidence(root, files, { gitRoot: indexRoot = root, indexFile } = {}) {
  const hash = createHash('sha256');
  const index = await git(indexRoot, ['ls-files', '--stage', '-z', '--', ...files],
    { env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' }, indexFile });
  hash.update(index.stdout);
  for (const file of files) {
    const filename = path.resolve(root, file);
    if (!childPath(root, filename)) throw worktreeError('worktree-unverified', 'A patch path resolves outside the repository.');
    await plainDirectoryPath(root, path.dirname(filename));
    const meta = await lstat(filename).catch(error => {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    });
    if (meta && (!meta.isFile() || worktreePathKey(await realpath(filename)) !== worktreePathKey(filename))) {
      throw worktreeError('worktree-unverified', 'A patch path is not a regular repository file.');
    }
    hash.update(JSON.stringify([file, meta ? meta.mode : null, meta ? meta.size : null]));
    if (meta) hash.update(await readFile(filename));
  }
  return hash.digest('hex');
}
