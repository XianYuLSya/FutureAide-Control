import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDriveC, isolatedRuntimeEnvironment, readClaudeDesktopAuthorization } from '../src/runtime-environment.mjs';

const account = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const cacheKey = (id, scope) => `acct:${id}|client:org:https://api.anthropic.com:${scope}`;
test('Windows namespaced paths keep the same drive restriction', { skip: process.platform !== 'win32' }, () => {
  assert.equal(isDriveC('C:\\private'), true);
  assert.equal(isDriveC('\\\\?\\C:\\private'), true);
  assert.equal(isDriveC('D:\\private'), false);
});
async function desktop(cache) {
  const root = path.resolve('.runtime/tests/runtime-environment');
  await mkdir(root, { recursive: true });
  const desktopData = await mkdtemp(path.join(root, 'case-'));
  const key = randomBytes(32), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(cache)), cipher.final()]);
  const blob = Buffer.concat([Buffer.from('v10'), iv, body, cipher.getAuthTag()]);
  await writeFile(path.join(desktopData, 'config.json'), JSON.stringify({ lastKnownAccountUuid: account, 'oauth:tokenCacheV2': blob.toString('base64') }));
  await writeFile(path.join(desktopData, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPIfixture').toString('base64') } }));
  return { binding: { desktopData }, unprotect: async () => Buffer.from(key) };
}

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

test('Desktop authorization selects current account Code scope instead of another cached account or generic token', async () => {
  const expiresAt = Date.now() + 600000;
  const fixture = await desktop({
    [cacheKey(other, 'user:sessions:claude_code')]: { token: 'other-token', expiresAt },
    [cacheKey(account, 'user:profile')]: { token: 'profile-token', expiresAt },
    [cacheKey(account, 'user:inference user:sessions:claude_code')]: { token: 'code-token', expiresAt },
  });
  const auth = await readClaudeDesktopAuthorization(fixture.binding, fixture);
  assert.equal(auth.token, 'code-token');
  assert.equal(auth.accountId, account);
});

test('expired Code authorization and an account changed inside the profile are rejected', async () => {
  const fixture = await desktop({ [cacheKey(account, 'user:sessions:claude_code')]: { token: 'expired', expiresAt: Date.now() - 1 } });
  await assert.rejects(readClaudeDesktopAuthorization(fixture.binding, fixture), { code: 'desktop-code-auth-unavailable' });
  await assert.rejects(readClaudeDesktopAuthorization({ ...fixture.binding, claudeAccountId: other }, fixture), { code: 'profile-account-changed' });
});
