import test from 'node:test';
import assert from 'node:assert/strict';
import { createMutualService } from '../src/mutual-server.mjs';

const claudeOwner = { ownerId: 'owner-claude', threadId: 'claude-session', workspace: process.cwd(), client: 'claude-code', profileId: '11111111-1111-4111-8111-111111111111' };
const codexOwner = { ownerId: 'owner-codex', threadId: 'codex-thread', workspace: process.cwd(), client: 'codex-desktop', profileId: '11111111-1111-4111-8111-111111111111' };

function fakeCli(overrides = {}) {
  return {
    store: { named: () => undefined, list: () => [{ name: 'worker' }] },
    status: async () => ({ agents: 1 }),
    desktopHostStatus: async () => ({ ready: true }),
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
    list: async () => ({ items: [] }),
    wait: async () => ({ items: [] }),
    ...overrides,
  };
}

test('status does not advertise Claude until a matching dispatcher is registered', async () => {
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({ desktopHostStatus: async () => ({ ready: false }) }),
    contextResolver: async () => codexOwner,
    dshFactory: () => fakeDsh(),
  });
  try {
    const status = await service.status({});
    assert.deepEqual(status.runtimes, { dsh: true, claude: false, codex: false });
    assert.equal(status.runtimeErrors.claude, 'desktop-host-not-registered');
  } finally {
    service.close();
  }
});

test('host_register forwards only explicit replace intent', async () => {
  let details;
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({
      registerDesktopHost: async (_extra, value) => { details = value; return { registered: true }; },
    }),
    contextResolver: async () => codexOwner,
    dshFactory: () => fakeDsh(),
  });
  try {
    await service.hostRegister({}, {});
    assert.deepEqual(details, { replace: false });
    await service.hostRegister({ replace: true }, {});
    assert.deepEqual(details, { replace: true });
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

test('Claude default remains codex and is guarded before cli.create', async () => {
  let created = false;
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({ create: async args => { created = true; return { ...args, runtime: args.runtime, created: true }; }, desktopHostStatus: async () => ({ ready: false }) }),
    contextResolver: async () => claudeOwner,
    dshFactory: () => { throw new Error('DSH should not be opened for a Claude caller'); },
  });
  try {
    await assert.rejects(service.create({ name: 'helper', lifetime: 'persistent' }), { code: 'codex-host-not-registered' });
    assert.equal(created, false);
  } finally {
    service.close();
  }
});

test('Claude must opt into the native runtime explicitly', async () => {
  let created = false;
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({ create: async args => { created = true; return { ...args, created: true, transport: 'desktop-native' }; } }),
    contextResolver: async () => claudeOwner,
  });
  try {
    const result = await service.create({ name: 'desktop', lifetime: 'persistent', runtime: 'claude' });
    assert.equal(created, true);
    assert.equal(result.transport, 'desktop-native');
  } finally {
    service.close();
  }
});

test('list is summarized before response and wait by name returns parseable items', async () => {
  const bulky = {
    name: 'worker', runtime: 'claude', state: 'idle',
    task: { text: 'task', state: 'completed', result: { reply: 'x'.repeat(10000), changes: [] } },
    activity: 'idle', changes: { count: 1000, files: Array.from({ length: 1000 }, (_, i) => ({ path: `D:/work/${i}.js` })) },
    tree: { nodes: Array.from({ length: 100 }, (_, i) => ({ name: `n${i}`, status: 'idle' })) },
  };
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({
      list: async () => ({ items: [bulky], total: 1 }),
      wait: async () => ({ items: [{ name: 'worker', state: 'idle' }], reports: [], questions: [] }),
    }),
    contextResolver: async () => codexOwner,
    dshFactory: () => fakeDsh(),
  });
  try {
    const listed = await service.list({});
    assert.equal(listed.items.length, 1);
    assert.ok(JSON.stringify(listed).length < 10000);
    assert.equal(listed.items[0].changes.files.length, 8);
    const waited = await service.wait({ names: ['worker'], timeoutSeconds: 0 }, {});
    assert.deepEqual(waited.items, [{ name: 'worker', state: 'idle' }]);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(waited)));
  } finally { service.close(); }
});

test('Codex must opt into the native runtime and uses the same CLI roster when host is ready', async () => {
  let created = false;
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({
      create: async args => { created = true; return { ...args, created: true, transport: 'desktop-native' }; },
      desktopHostStatus: async (_extra, options = {}) => ({ ready: options.targetRuntime === 'codex' }),
    }),
    contextResolver: async () => codexOwner,
    dshFactory: () => fakeDsh(),
  });
  try {
    const result = await service.create({ name: 'codex-worker', lifetime: 'persistent', runtime: 'codex' });
    assert.equal(created, true);
    assert.equal(result.transport, 'desktop-native');
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
      assert.match(error.message, /Codex Desktop native host binding is required/);
      assert.match(error.message, /credential reuse are prohibited/);
      return true;
    });
    assert.equal(sent, false);
  } finally {
    service.close();
  }
});

test('a native Claude record can answer through the CLI service', async () => {
  const record = { name: 'native-claude', runtime: 'claude', desktopMode: 'native' };
  let answered = false;
  const service = await createMutualService({}, {
    cliFactory: () => fakeCli({
      store: { named: (ownerId, name) => name === record.name ? record : undefined, list: () => [record] },
      answer: async () => { answered = true; return { queued: true, accepted: false }; },
    }),
    contextResolver: async () => claudeOwner,
    dshFactory: () => { throw new Error('DSH should not be opened for a native Claude record'); },
  });
  try {
    const result = await service.answer({ name: record.name, message: 'answer' });
    assert.deepEqual(result, { queued: true, accepted: false });
    assert.equal(answered, true);
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
