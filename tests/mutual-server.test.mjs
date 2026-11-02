import test from 'node:test';
import assert from 'node:assert/strict';
import { createMutualService } from '../src/mutual-server.mjs';

const claudeOwner = { ownerId: 'owner-claude', threadId: 'claude-session', workspace: process.cwd(), client: 'claude-code' };
const codexOwner = { ownerId: 'owner-codex', threadId: 'codex-thread', workspace: process.cwd(), client: 'codex-desktop' };

function fakeCli(overrides = {}) {
  return {
    store: { named: () => undefined, list: () => [{ name: 'worker' }] },
    status: async () => ({ agents: 1 }),
    create: async args => args,
    wait: async () => ({ items: [], notListed: ['worker'] }),
    close() {},
    ...overrides,
  };
}

function fakeDsh(overrides = {}) {
  return {
    store: { named: () => undefined, list: () => [], close() {} },
    status: async () => ({ agents: 2, ready: true }),
    create: async args => ({ ...args, runtime: 'dsh', created: true }),
    wait: async () => ({ items: [] }),
    ...overrides,
  };
}

test('status reports 0.6.3 with both native desktop runtimes disabled', async () => {
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli(),
    contextResolver: async () => codexOwner,
    dshFactory: () => fakeDsh(),
  });
  try {
    const status = await service.status({});
    assert.equal(status.version, '0.6.3');
    assert.deepEqual(status.runtimes, { dsh: true, claude: false, codex: false });
    assert.deepEqual(status.runtimeErrors, { claude: 'claude-desktop-required', codex: 'codex-desktop-required' });
  } finally {
    service.close();
  }
});

test('Codex Desktop defaults to DSH and creates through the DSH service only', async () => {
  let cliCreated = false;
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({ create: async () => { cliCreated = true; } }),
    contextResolver: async () => codexOwner,
    dshFactory: () => fakeDsh(),
  });
  try {
    const result = await service.create({ name: 'helper', lifetime: 'once' });
    assert.equal(result.runtime, 'dsh');
    assert.equal(result.created, true);
    assert.equal(cliCreated, false);
  } finally {
    service.close();
  }
});

test('a one-shot removed during wait returns immediately instead of waiting out the timeout', async () => {
  const service = await createMutualService({}, { cliFactory: fakeCli, contextResolver: async () => claudeOwner });
  try {
    const began = Date.now();
    const result = await service.wait({ names: ['worker'], timeoutSeconds: 1 });
    assert.deepEqual(result.notListed, ['worker']);
    assert.ok(Date.now() - began < 500);
  } finally {
    service.close();
  }
});

test('Claude default codex is refused before cli.create', async () => {
  let created = false;
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({ create: async () => { created = true; } }),
    contextResolver: async () => claudeOwner,
    dshFactory: () => { throw new Error('DSH should not be opened for a Claude caller'); },
  });
  try {
    await assert.rejects(service.create({ name: 'helper', lifetime: 'once' }), { code: 'codex-desktop-required' });
    assert.equal(created, false);
  } finally {
    service.close();
  }
});

test('Claude dispatch is rejected before reaching an execution adapter', async () => {
  let created = false;
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({ create: async () => { created = true; } }),
    contextResolver: async () => claudeOwner,
  });
  try {
    await assert.rejects(service.create({ name: 'desktop', lifetime: 'once', runtime: 'claude' }), { code: 'claude-desktop-required' });
    assert.equal(created, false);
  } finally {
    service.close();
  }
});

test('a legacy Codex CLI record cannot send before the CLI service', async () => {
  const record = { name: 'legacy-codex', runtime: 'codex' };
  let sent = false;
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({
      store: { named: (ownerId, name) => name === record.name ? record : undefined, list: () => [record] },
      send: async () => { sent = true; return { accepted: true }; },
    }),
    contextResolver: async () => codexOwner,
    dshFactory: () => { throw new Error('DSH should not be opened for a legacy CLI record'); },
  });
  try {
    await assert.rejects(service.send({ name: record.name, message: 'work' }), error => {
      assert.equal(error.code, 'codex-desktop-required');
      assert.match(error.message, /Native Desktop target dispatch is not connected for Codex/);
      assert.match(error.message, /credential reuse are prohibited/);
      return true;
    });
    assert.equal(sent, false);
  } finally {
    service.close();
  }
});

test('a legacy Claude CLI record cannot answer before the CLI service', async () => {
  const record = { name: 'legacy-claude', runtime: 'claude' };
  let answered = false;
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({
      store: { named: (ownerId, name) => name === record.name ? record : undefined, list: () => [record] },
      answer: async () => { answered = true; return { accepted: true }; },
    }),
    contextResolver: async () => claudeOwner,
    dshFactory: () => { throw new Error('DSH should not be opened for a legacy CLI record'); },
  });
  try {
    await assert.rejects(service.answer({ name: record.name, message: 'answer' }), error => {
      assert.equal(error.code, 'claude-desktop-required');
      assert.match(error.message, /Native Desktop target dispatch is not connected for Claude/);
      assert.match(error.message, /credential reuse are prohibited/);
      return true;
    });
    assert.equal(answered, false);
  } finally {
    service.close();
  }
});

test('legacy CLI records remain inspectable, cancellable and deletable', async () => {
  const record = { name: 'legacy-cleanup', runtime: 'codex' };
  const calls = [];
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({
      store: { named: (ownerId, name) => name === record.name ? record : undefined, list: () => [record] },
      inspect: async () => { calls.push('inspect'); return { name: record.name }; },
      cancel: async () => { calls.push('cancel'); return { accepted: true }; },
      delete: async () => { calls.push('delete'); return { deleted: true }; },
    }),
    contextResolver: async () => codexOwner,
    dshFactory: () => { throw new Error('DSH should not be opened for a legacy CLI record'); },
  });
  try {
    await service.inspect({ name: record.name });
    await service.cancel({ name: record.name });
    await service.delete({ name: record.name });
    assert.deepEqual(calls, ['inspect', 'cancel', 'delete']);
  } finally {
    service.close();
  }
});
