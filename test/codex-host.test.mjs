import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createCodexHost, emptyProjection, readTranscript, readDefaultModel, markerLine } from '../src/codex-host.mjs';

const directory = () => fileURLToPath(new URL(`../clean/validation/codex/${randomUUID()}/`, import.meta.url));
test('native transcript cursor admits exact marker, keeps partial line and attributes FileChange', async () => {
  const dir = directory(); await mkdir(dir, { recursive: true }); const file = path.join(dir, 'events.jsonl');
  const marker = markerLine('r', 'nonce');
  const events = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } },
    { type: 'response_item', payload: { type: 'function_call_output', namespace: 'codex_app', name: 'create_thread',
      id: 'u', output: `<codex_delegation><input>${marker}</input></codex_delegation>` } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', status: 'completed', changes: { 'D:/work/a.txt': { type: 'add' } } } } },
  ];
  await writeFile(file, events.map(e => JSON.stringify(e)).join('\n') + '\n{"type":');
  const first = await readTranscript({ rollout_path: file }, emptyProjection(), { r: { marker } });
  assert.equal(first.projection.deliveries.r.turnId, 't');
  assert.equal(first.projection.changes[0].kind, 'add');
  assert.equal(first.hasMore, true);
  await appendFile(file, '"event_msg","payload":{"type":"task_complete","turn_id":"t"}}\n');
  const next = await readTranscript({ rollout_path: file }, first.projection, { r: { marker } });
  assert.equal(next.projection.running, false); assert.equal(next.projection.messages.length, 1);
  assert.equal(next.hasMore, false);
});

test('real TOML parser resolves trusted project and quoted profile without exposing unrelated config', async () => {
  const dir = directory(), home = path.join(dir, 'home'), workspace = path.join(dir, 'workspace');
  await mkdir(home, { recursive: true }); await mkdir(path.join(workspace, '.codex'), { recursive: true });
  await writeFile(path.join(home, 'config.toml'), `model = "base"\nprofile = "my.profile"\n[projects.${JSON.stringify(workspace.replaceAll('\\', '/'))}]\ntrust_level = "trusted"\n[profiles."my.profile"]\nmodel = "profile-a"\nmodel_reasoning_effort = "high"\n`);
  await writeFile(path.join(workspace, '.codex/config.toml'), '[profiles."my.profile"]\nmodel = "project-b"\nmodel_reasoning_effort = "max"\n');
  const actual = await readDefaultModel({ home, workspace });
  assert.equal(actual.model, 'project-b'); assert.equal(actual.reasoningEffort, 'max');
  assert.equal(actual.sources.length, 2);
});

test('first native creation uses verified anchor and exact saved workspace, never fork', async () => {
  const calls = [];
  const host = createCodexHost({ anchorResolver: async () => 'anchor', invoke: async (id, name, args) => {
    calls.push({ id, name, args });
    return name === 'list_projects' ? { projects: [{ projectId: 'project', projectKind: 'local', path: 'D:/work/p', hostId: 'local' }] } : { threadId: 'new' };
  } });
  const result = await host.createFirstTurn({ workspace: 'D:/work/p', message: 'work', title: 'helper', model: { model: 'default', reasoningEffort: 'max' } });
  assert.equal(result.nativeSessionId, 'new'); assert.deepEqual(calls.map(c => c.name), ['list_projects', 'create_thread']);
  assert.equal(calls[1].args.target.projectId, 'project');
  await assert.rejects(host.destroy({ nativeSessionId: 'new' }), { code: 'codex-native-delete-unavailable' });
});
