import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copyClaudeUserInstructions, isDriveC, isolatedRuntimeEnvironment, resolveRuntimeEnvironment } from '../src/runtime-environment.mjs';

test('Claude inherits user instructions while its auth and settings remain private', async () => {
  const parent = path.resolve('.runtime/tests/runtime-environment');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'instructions-'));
  const binding = { faSwitchRoot: root, kind: 'account', profileId: 'profile' };
  const source = path.join(root, 'client-state/claude/account/profile/claude-config');
  const child = path.join(root, 'child/claude-config');
  await mkdir(path.join(source, 'skills/shared'), { recursive: true });
  await mkdir(path.join(source, 'rules'), { recursive: true });
  await mkdir(child, { recursive: true });
  await writeFile(path.join(source, 'skills/shared/SKILL.md'), 'shared skill');
  await writeFile(path.join(source, 'rules/general.md'), 'general rules');
  await writeFile(path.join(source, 'CLAUDE.md'), 'first rules');
  await writeFile(path.join(source, 'settings.json'), 'parent settings');
  await writeFile(path.join(source, '.credentials.json'), 'parent credentials');
  await writeFile(path.join(child, 'settings.json'), 'private settings');
  await copyClaudeUserInstructions(binding, child);
  assert.equal(await readFile(path.join(child, 'skills/shared/SKILL.md'), 'utf8'), 'shared skill');
  assert.equal(await readFile(path.join(child, 'rules/general.md'), 'utf8'), 'general rules');
  assert.equal(await readFile(path.join(child, 'settings.json'), 'utf8'), 'private settings');
  assert.equal((await readdir(child)).includes('.credentials.json'), false);
  await writeFile(path.join(source, 'CLAUDE.md'), 'updated rules');
  await copyClaudeUserInstructions(binding, child);
  assert.equal(await readFile(path.join(child, 'CLAUDE.md'), 'utf8'), 'updated rules');
});

const account = '11111111-1111-4111-8111-111111111111';
test('Windows namespaced paths keep the same drive restriction', { skip: process.platform !== 'win32' }, () => {
  assert.equal(isDriveC('C:\\private'), true);
  assert.equal(isDriveC('\\\\?\\C:\\private'), true);
  assert.equal(isDriveC('D:\\private'), false);
});
test('subprocess uses only the selected profile proxy and excludes inherited API credentials', () => {
  const env = isolatedRuntimeEnvironment({ profileId: account, proxy: 'http://127.0.0.1:17911' }, path.resolve('.runtime/agent'), {
    PATH: 'runtime-path', SystemRoot: 'C:\\Windows', ANTHROPIC_API_KEY: 'wrong-account', OPENAI_API_KEY: 'wrong-account',
    CLAUDE_CODE_OAUTH_TOKEN: 'wrong-account', HTTPS_PROXY: 'http://wrong:1', NO_PROXY: '*', CODEX_HOME: 'wrong-home',
  });
  assert.equal(env.PATH, 'runtime-path');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:17911');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME']) assert.equal(env[key], undefined);
  assert.ok(env.TEMP.startsWith(path.resolve('.runtime/agent')));
});

test('Claude is blocked before config access, credential reads or process launch', async () => {
  const config = new Proxy({}, { get() { throw new Error('Config must not be read'); } });
  await assert.rejects(resolveRuntimeEnvironment({ runtime: 'claude', config }), { code: 'claude-desktop-required' });
});
