import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';
import { startRendererFixture } from '../test/assembly/renderer.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOSS = '11111111-1111-4111-8111-111111111111';
const extra = threadId => ({ _meta: { threadId } });

async function fixture(configuration, configRoot) {
  const stateDirectory = await mkdtemp(path.join(configRoot, 'state-'));
  const store = new RosterStore(':memory:');
  const codex = await startRendererFixture({ workspace, callerThreadId: BOSS });
  const configFile = path.join(configRoot, 'config.json');
  await writeFile(configFile, JSON.stringify(configuration));
  const config = await loadConfig(configFile);
  const service = createScopedAgents({ ...config, stateDirectory, workspace }, {
    store,
    clientFactory: () => { throw new Error('no DSH host is needed for these cases'); },
    // The calling chat: what it is told arrives here.
    callCodex: async (threadId, tool) => {
      if (tool === 'read_thread') return { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } };
      return { accepted: true };
    },
    backendAdapters: { 'codex-desktop': (record, deps) => createCodexBackend(record, { ...deps, hostOptions: { nativeRequest: async (method, params) => codex.rpc(method, params) } }) },
    codexProbeRegistration: async () => ({ ready: true, registered: true, tools: ['ask_parent', 'report_parent'], sessionVerified: false }),
    startSharedMonitor: () => true,
    removeTree: async () => {},
  });
  const record = name => store.named(ownerIdFor(BOSS), name);
  return {
    service, codex,
    async start() {
      await service.create({ name: 'worker', lifetime: 'persistent', target: 'codex-desktop' }, extra(BOSS));
      const receipt = await service.send({ name: 'worker', message: 'Identical business input.' }, extra(BOSS));
      await service.poll(record('worker').agentId);
      return receipt;
    },
    async close() { service.close(); await codex.close(); },
  };
}

// Each case creates a new process-equivalent service after writing the config. Both
// model and business text stay fixed; only one plugin default is changed.
for (const [label, first, second, source] of [
  ['per-model', { defaultEffort: 'max', modelDefaultEfforts: { 'gpt-6-astra': 'max' } }, { defaultEffort: 'max', modelDefaultEfforts: { 'gpt-6-astra': 'high' } }, 'model-default'],
  ['global', { defaultEffort: 'max' }, { defaultEffort: 'high' }, 'global-default'],
]) {
  test('configuration reload changes ' + label + ' default through scoped and Codex adapter', async () => {
    const configRoot = await mkdtemp(path.join(tmpdir(), 'effort-reload-'));
    try {
      for (const [configuration, expected] of [[first, 'max'], [second, 'high']]) {
        const f = await fixture(configuration, configRoot);
        try {
          const receipt = await f.start();
          assert.ok(receipt.requestId);
          assert.equal(receipt.requestedEffort, expected);
          assert.equal(receipt.selectedEffort, expected);
          assert.equal(receipt.effortSource, source);
          assert.equal(receipt.actualEffort, null);
          const starts = f.codex.calls().filter(call => call.method === 'turn/start');
          assert.equal(starts.length, 1);
          assert.equal(starts[0].params.model, 'gpt-6-astra');
          assert.equal(starts[0].params.effort, expected);
          assert.ok(starts[0].params.input[0].text.startsWith('Identical business input.'));
          const item = (await f.service.list(extra(BOSS))).items[0];
          assert.equal(item.actualEffort, expected);
          assert.equal(item.effortSource, source);
        } finally { await f.close(); }
      }
    } finally { await rm(configRoot, { recursive: true, force: true }); }
  });
}
