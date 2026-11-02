import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { copyClaudeUserInstructions, resolveRuntimeEnvironment } from '../src/runtime-environment.mjs';

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

function guarded(label) {
  const fail = () => { throw new Error(`${label} must not be read`); };
  return new Proxy({}, { get: fail, has: fail, ownKeys: fail, getOwnPropertyDescriptor: fail });
}

for (const [runtime, code] of [['codex', 'codex-desktop-required'], ['claude', 'claude-desktop-required']]) {
  test(`${runtime} is refused before config, binding or filesystem access`, async () => {
    await assert.rejects(
      resolveRuntimeEnvironment({ runtime, config: guarded('config'), binding: guarded('binding'), directory: 'C:\\private\\agent' }),
      error => {
        assert.equal(error.code, code);
        assert.match(error.message, /native .* Desktop target is not connected/i);
        assert.match(error.message, /independent .* CLI .* prohibited/i);
        return true;
      },
    );
  });
}

test('unknown runtimes are refused before config access with runtime-unsupported', async () => {
  await assert.rejects(
    resolveRuntimeEnvironment({ runtime: 'dsh', config: guarded('config') }),
    { code: 'runtime-unsupported' },
  );
});
