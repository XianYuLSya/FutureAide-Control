// Workspace snapshots for the shared layer: an assistant that writes files through a
// shell never reports a native file-tool result, so the workspace itself is compared
// before and after a task instead of trusting the tools a target happens to expose.
import { execFile } from 'node:child_process';
import { stat as statPath } from 'node:fs/promises';
import path from 'node:path';

const STATUS_TIMEOUT_MS = 5000;
const MAX_PATHS = 5000;
const MAX_CHANGES = 500;
const MAX_STATUS_BYTES = 16 << 20;

// --no-optional-locks keeps this read-only status from taking the index lock that a
// git command the user runs at the same time needs.
const statusArgs = workspace => ['--no-optional-locks', '-C', workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all'];

const execGitStatus = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/**
 * Why a status call produced nothing usable. Every branch is a coverage reason, so a
 * snapshot must never turn into a thrown error that would fail a delivery.
 */
function failureReason(error) {
  if (!error) return 'git-failed';
  if (error.code === 'ENOENT') return 'git-unavailable';
  if (error.killed === true || error.code === 'ETIMEDOUT' || error.signal) return 'timeout';
  if (/not a git repository/i.test(String(error.stderr ?? error.message ?? ''))) return 'not-a-repository';
  return 'git-failed';
}

/**
 * Porcelain v1 with -z: "XY path" NUL-separated. A rename or copy entry names its old
 * path in the next field, which has to be consumed or it would read as an entry of
 * its own with an invalid code.
 */
function parseStatus(stdout) {
  const entries = [];
  const fields = stdout.split('\0');
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const code = field.slice(0, 2);
    const file = field.slice(3);
    if (code[0] === 'R' || code[0] === 'C') index += 1;
    if (file) entries.push({ code, path: file });
  }
  return entries;
}

/** A file that git reports but the filesystem no longer has is exactly a deletion. */
const stampOf = async (file, stat) => {
  try {
    const info = await stat(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch (error) {
    return error?.code === 'ENOENT' ? 'deleted' : 'unreadable';
  }
};

/**
 * One snapshot of the workspace's dirty paths, keyed by the path git prints (relative
 * to the workspace) and fingerprinted by mtime and size so any later edit is visible
 * even when the status code stays the same.
 * @param {string} workspace Absolute workspace directory.
 * @param {{exec?: Function, stat?: Function}} deps Injected for tests.
 */
export async function captureWorkspace(workspace, { exec = execGitStatus, stat = statPath } = {}) {
  if (typeof workspace !== 'string' || !workspace) return { available: false, reason: 'no-workspace' };
  const root = path.resolve(workspace);
  let stdout;
  try {
    stdout = await exec('git', statusArgs(root),
      { timeout: STATUS_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_STATUS_BYTES, encoding: 'utf8' });
  } catch (error) { return { available: false, reason: failureReason(error) }; }
  if (typeof stdout !== 'string') return { available: false, reason: 'git-failed' };
  const entries = parseStatus(stdout);
  // A tree that large is a checkout in motion or generated output: statting every
  // path would cost more than the answer is worth.
  if (entries.length > MAX_PATHS) return { available: false, reason: 'too-many-paths' };
  const files = {};
  for (const entry of entries) {
    files[entry.path] = { code: entry.code, stamp: await stampOf(path.resolve(root, entry.path), stat) };
  }
  return { available: true, workspace: root, files };
}

/**
 * Compare two snapshots of the same workspace. A path that became clean again was
 * still touched during the task, so it is reported rather than dropped.
 * @returns {Array<{path: string, operation: string}>} Sorted, at most 500 entries;
 *   `truncated` marks a clipped result.
 */
export function diffWorkspace(before, after) {
  const changes = [];
  if (before?.available !== true || after?.available !== true) return changes;
  const root = after.workspace ?? before.workspace ?? '';
  const absolute = file => path.resolve(root, file);
  const beforeFiles = before.files ?? {}, afterFiles = after.files ?? {};
  for (const [file, entry] of Object.entries(afterFiles)) {
    const previous = beforeFiles[file];
    if (!previous) {
      changes.push({ path: absolute(file), operation: entry.code.includes('?') || entry.code.includes('A') ? 'create'
        : entry.code.includes('D') ? 'delete' : 'update' });
      continue;
    }
    if (previous.stamp !== entry.stamp) {
      changes.push({ path: absolute(file), operation: entry.stamp === 'deleted' ? 'delete' : 'update' });
    }
  }
  for (const file of Object.keys(beforeFiles)) {
    if (afterFiles[file]) continue;
    changes.push({ path: absolute(file), operation: 'update' });
  }
  changes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (changes.length <= MAX_CHANGES) return changes;
  const kept = changes.slice(0, MAX_CHANGES);
  kept.truncated = true;
  return kept;
}
