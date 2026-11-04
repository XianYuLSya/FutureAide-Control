import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createCodexHost, createDesktopToolBridge, emptyProjection, readTranscript, readDefaultModel, markerLine } from '../src/codex-host.mjs';

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

test('current profile files precede trusted project overrides; project cannot change provider/profile', async () => {
  const dir = directory(), home = path.join(dir, '\u6d4b\u8bd5-home'), workspace = path.join(dir, 'workspace');
  await mkdir(home, { recursive: true }); await mkdir(path.join(workspace, '.codex'), { recursive: true });
  await writeFile(path.join(home, 'config.toml'), `model = "base"\n[projects.${JSON.stringify(workspace.replaceAll('\\', '/'))}]\ntrust_level = "trusted"\n`);
  await writeFile(path.join(home, 'review.config.toml'), 'model = "profile-a"\nmodel_reasoning_effort = "high"\n');
  await writeFile(path.join(workspace, '.codex/config.toml'), 'model = "project-b"\nmodel_reasoning_effort = "max"\nmodel_provider = "ignored"\nprofile = "ignored"\n');
  const actual = await readDefaultModel({ home, workspace, profile: 'review' });
  assert.equal(actual.model, 'project-b'); assert.equal(actual.reasoningEffort, 'max');
  assert.equal(actual.provider, 'openai'); assert.equal(actual.profile, 'review');
  assert.equal(actual.sources.length, 3);
});

test('first native creation uses verified anchor and exact saved workspace, never fork', async () => {
  const calls = [];
  const host = createCodexHost({ anchorResolver: async () => ({ threadId: 'anchor', workspace: 'D:/other' }), invoke: async (id, name, args) => {
    calls.push({ id, name, args });
    return name === 'list_projects' ? { projects: [{ projectId: 'project', projectKind: 'local', path: 'D:/work/p', hostId: 'local' }] } : { threadId: 'new' };
  } });
  const result = await host.createFirstTurn({ workspace: 'D:/work/p', message: 'work', title: 'helper', model: { model: 'default', reasoningEffort: 'max' } });
  assert.equal(result.nativeSessionId, 'new'); assert.deepEqual(calls.map(c => c.name), ['list_projects', 'create_thread']);
  assert.equal(calls[1].args.target.projectId, 'project');
  assert.equal(calls[1].id, 'anchor');
  await assert.rejects(host.destroy({ nativeSessionId: 'new' }), { code: 'codex-native-delete-unavailable' });
});

test('desktop bridge shares discovery and handshake, changes caller metadata, and never replays a failed call', async () => {
  let discovered = 0, connected = 0, closed = 0, calls = 0;
  const seen = [];
  const bridge = createDesktopToolBridge({ discover: async () => { discovered++; return {}; }, createTransport: () => ({}),
    createClient: () => ({ connect: async () => { connected++; }, close: async () => { closed++; },
      callTool: async input => { calls++; seen.push(input._meta['openai/threadId']);
        if (input.arguments.fail) throw new Error('lost response');
        return { structuredContent: { ok: true } }; } }) });
  await Promise.all([bridge.invoke('a', 'read_thread', {}), bridge.invoke('b', 'list_projects', {})]);
  assert.equal(discovered, 1); assert.equal(connected, 1); assert.deepEqual(seen, ['a', 'b']);
  await assert.rejects(bridge.invoke('a', 'send_message_to_thread', { fail: true }), /lost response/);
  assert.equal(calls, 3); assert.equal(closed, 1);
  await bridge.invoke('b', 'list_projects', {});
  assert.equal(discovered, 2); assert.equal(connected, 2);
  await bridge.close(); assert.equal(closed, 2);
});
