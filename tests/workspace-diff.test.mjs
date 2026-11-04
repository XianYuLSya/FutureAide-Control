import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureWorkspace, diffWorkspace } from '../src/workspace-diff.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(workspace, '.runtime', 'tests');

// Fixtures are kept: this project forbids destructive cleanup in tests.
function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
}

async function repository(files = {}) {
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'wsdiff-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'workspace-diff@example.invalid');
  git(root, 'config', 'user.name', 'Workspace Diff');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  if (Object.keys(files).length) { git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init'); }
  return root;
}

const asPosix = value => value.split(path.sep).join('/');
const operations = (changes, root) => changes.map(change => [asPosix(path.relative(root, change.path)), change.operation]);

test('a snapshot reports created, updated and deleted files as sorted absolute paths', async () => {
  const root = await repository({ 'changed.txt': 'one', 'removed.txt': 'gone', 'nested/stable.txt': 'same' });
  const before = await captureWorkspace(root);
  assert.equal(before.available, true);
  assert.deepEqual(before.files, {}, 'a clean tree has no entries');
  await writeFile(path.join(root, 'changed.txt'), 'one plus more');
  await writeFile(path.join(root, 'added.txt'), 'new');
  await rm(path.join(root, 'removed.txt'));
  const after = await captureWorkspace(root);
  const changes = diffWorkspace(before, after);
  assert.deepEqual(operations(changes, root), [['added.txt', 'create'], ['changed.txt', 'update'], ['removed.txt', 'delete']]);
  assert.ok(changes.every(change => path.isAbsolute(change.path)), 'a change names an absolute path');
  assert.equal(changes[0].path, path.join(root, 'added.txt'));
});

test('a dirty file edited again during the task is one update, not a second entry', async () => {
  const root = await repository({ 'dirty.txt': 'base' });
  await writeFile(path.join(root, 'dirty.txt'), 'dirty one');
  const before = await captureWorkspace(root);
  assert.equal(before.files['dirty.txt'].code, ' M', 'the file was already dirty when the task started');
  await writeFile(path.join(root, 'dirty.txt'), 'dirty one and a longer tail');
  const after = await captureWorkspace(root);
  assert.equal(after.files['dirty.txt'].code, ' M');
  assert.notEqual(after.files['dirty.txt'].stamp, before.files['dirty.txt'].stamp);
  assert.deepEqual(operations(diffWorkspace(before, after), root), [['dirty.txt', 'update']]);
});

test('a dirty file restored during the task still counts as touched', async () => {
  const root = await repository({ 'restored.txt': 'base' });
  await writeFile(path.join(root, 'restored.txt'), 'temporary edit');
  const before = await captureWorkspace(root);
  git(root, 'checkout', '--', 'restored.txt');
  const after = await captureWorkspace(root);
  assert.deepEqual(after.files, {}, 'nothing is dirty after the restore');
  assert.deepEqual(operations(diffWorkspace(before, after), root), [['restored.txt', 'update']]);
});

test('a rename consumes its old path field and reports the new path once', async () => {
  const root = await repository({ 'old-name.txt': 'content to move' });
  const before = await captureWorkspace(root);
  git(root, 'mv', 'old-name.txt', 'new-name.txt');
  const after = await captureWorkspace(root);
  assert.deepEqual(Object.keys(after.files), ['new-name.txt'], 'the trailing old path is not read as an entry');
  assert.equal(after.files['new-name.txt'].code[0], 'R');
  assert.deepEqual(operations(diffWorkspace(before, after), root), [['new-name.txt', 'update']]);
});

test('Chinese paths survive the snapshot and the diff unchanged', async () => {
  const root = await repository({ '文档/说明.md': '原内容' });
  const before = await captureWorkspace(root);
  await writeFile(path.join(root, '文档', '说明.md'), '修改后的内容');
  await writeFile(path.join(root, '文档', '新增.txt'), '新内容');
  const after = await captureWorkspace(root);
  assert.deepEqual(Object.keys(after.files).sort(), ['文档/说明.md', '文档/新增.txt'].sort());
  const changes = diffWorkspace(before, after);
  assert.deepEqual(changes.map(change => change.path), [path.join(root, '文档', '新增.txt'), path.join(root, '文档', '说明.md')]);
  assert.deepEqual(changes.map(change => change.operation), ['create', 'update']);
});

test('a directory that is not a git repository is unavailable, never an error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wsdiff-nongit-'));
  assert.deepEqual(await captureWorkspace(root), { available: false, reason: 'not-a-repository' });
});

test('a timed-out status call is reported with the flags that keep it read-only', async () => {
  const root = await repository({ 'file.txt': 'content' });
  let seen;
  const capture = await captureWorkspace(root, { exec: async (file, args, options) => {
    seen = { file, args, options };
    throw Object.assign(new Error('spawn timed out'), { killed: true, code: 'ETIMEDOUT' });
  } });
  assert.deepEqual(capture, { available: false, reason: 'timeout' });
  assert.equal(seen.file, 'git');
  assert.deepEqual(seen.args, ['--no-optional-locks', '-C', path.resolve(root), 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
  assert.equal(seen.options.timeout, 5000);
  assert.equal(seen.options.windowsHide, true);
});

test('an unavailable git binary and an unusable snapshot are distinguishable', async () => {
  const root = await repository({ 'file.txt': 'content' });
  assert.deepEqual(await captureWorkspace(root, { exec: async () => {
    throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
  } }), { available: false, reason: 'git-unavailable' });
  assert.deepEqual(await captureWorkspace(''), { available: false, reason: 'no-workspace' });
  assert.deepEqual(diffWorkspace({ available: false, reason: 'timeout' }, { available: true, files: {} }), [],
    'an unavailable snapshot never produces changes');
});

test('a status with too many paths is refused before any file is statted', async () => {
  const root = await repository({ 'file.txt': 'content' });
  const many = Array.from({ length: 5001 }, (_, index) => `?? f${index}.txt`).join('\0') + '\0';
  let stats = 0;
  const capture = await captureWorkspace(root, { exec: async () => many,
    stat: async () => { stats++; return { mtimeMs: 1, size: 1 }; } });
  assert.deepEqual(capture, { available: false, reason: 'too-many-paths' });
  assert.equal(stats, 0);
});

test('a diff is clipped at 500 entries and says so', async () => {
  const files = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [
    `f${String(index).padStart(4, '0')}.txt`, { code: '??', stamp: '1:1' }]));
  const root = path.join(workspace, '.runtime', 'tests', 'wsdiff-clip');
  const changes = diffWorkspace({ available: true, workspace: root, files: {} }, { available: true, workspace: root, files });
  assert.equal(changes.length, 500);
  assert.equal(changes.truncated, true);
  assert.equal(path.basename(changes.at(-1).path), 'f0499.txt');
  const small = diffWorkspace({ available: true, workspace: root, files: {} },
    { available: true, workspace: root, files: { 'only.txt': { code: '??', stamp: '1:1' } } });
  assert.equal(small.truncated, undefined, 'a complete diff carries no truncation mark');
});
