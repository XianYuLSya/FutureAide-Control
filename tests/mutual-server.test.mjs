import test from 'node:test';
import assert from 'node:assert/strict';
import { createMutualService } from '../src/mutual-server.mjs';

const owner = { ownerId: 'owner-claude', threadId: 'claude-session', workspace: process.cwd(), client: 'claude-code' };
function fakeCli() {
  return { store: { named: () => undefined, list: () => [{ name: 'worker' }] },
    create: async args => args, wait: async () => ({ items: [], notListed: ['worker'] }), close() {} };
}
test('native Claude defaults to Codex without opening the DSH service', async () => {
  const service = await createMutualService({}, { cliFactory: fakeCli, contextResolver: async () => owner,
    dshFactory: () => { throw new Error('DSH should not be opened'); } });
  try { assert.equal((await service.create({ name: 'helper', lifetime: 'once' })).runtime, 'codex'); }
  finally { service.close(); }
});
test('a one-shot removed during wait returns immediately instead of waiting out the timeout', async () => {
  const service = await createMutualService({}, { cliFactory: fakeCli, contextResolver: async () => owner });
  try {
    const began = Date.now();
    const result = await service.wait({ names: ['worker'], timeoutSeconds: 1 });
    assert.deepEqual(result.notListed, ['worker']);
    assert.ok(Date.now() - began < 500);
  } finally { service.close(); }
});

test('Claude dispatch is rejected before reaching an execution adapter', async () => {
  let created = false;
  const service = await createMutualService({}, { cliFactory: () => ({ ...fakeCli(), create: async () => { created = true; } }), contextResolver: async () => owner });
  try {
    await assert.rejects(service.create({ name: 'desktop', lifetime: 'once', runtime: 'claude' }), { code: 'claude-desktop-required' });
    assert.equal(created, false);
  } finally { service.close(); }
});
