import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  EventCollector,
  extractChanges,
  extractMessages,
  extractSessionId,
  normalizeCliEvent,
  parseJsonLine,
} from '../src/cli-agent-events.mjs';

// A virtual workspace keeps these tests pure: no directory is created, read or removed.
const WORKSPACE = path.resolve(process.cwd(), '.fixture-workspace');
const resolve = value => path.resolve(WORKSPACE, value);
const CLAUDE_SESSION = 'claude-session-1';
const CODEX_THREAD = 'codex-thread-1';

test('parseJsonLine returns objects and treats every other line as absent', () => {
  assert.deepEqual(parseJsonLine('{"type":"assistant"}'), { type: 'assistant' });
  assert.deepEqual(parseJsonLine('\uFEFF{"type":"result"}'), { type: 'result' });
  assert.equal(parseJsonLine(''), null);
  assert.equal(parseJsonLine('   \t'), null);
  assert.equal(parseJsonLine('not json'), null);
  assert.equal(parseJsonLine('{"type":'), null);
  assert.equal(parseJsonLine('[]'), null);
  assert.equal(parseJsonLine('"text"'), null);
  assert.equal(parseJsonLine('null'), null);
  assert.equal(parseJsonLine(undefined), null);
});

test('a Claude Code stream-json sequence yields session, messages, tools and a terminal state', () => {
  const events = [
    { type: 'system', subtype: 'init', session_id: CLAUDE_SESSION, tools: ['Bash', 'Read'] },
    {
      type: 'assistant',
      session_id: CLAUDE_SESSION,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect the file.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/a.mjs' } },
        ],
      },
    },
    {
      type: 'stream_event',
      session_id: CLAUDE_SESSION,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial answer' } },
    },
    { type: 'result', subtype: 'success', is_error: false, session_id: CLAUDE_SESSION, result: 'The file looks good.' },
  ];
  const normalized = events.map(event => normalizeCliEvent(event, { workspace: WORKSPACE }));

  assert.deepEqual(normalized[0], { type: 'system', sessionId: CLAUDE_SESSION });
  assert.deepEqual(normalized[1], {
    type: 'assistant',
    sessionId: CLAUDE_SESSION,
    messages: [{ role: 'assistant', text: 'I will inspect the file.' }],
    tools: ['Read'],
  });
  assert.deepEqual(normalized[2], {
    type: 'stream_event',
    sessionId: CLAUDE_SESSION,
    messages: [{ role: 'assistant', text: 'partial answer' }],
  });
  assert.deepEqual(normalized[3], {
    type: 'result',
    sessionId: CLAUDE_SESSION,
    messages: [{ role: 'assistant', text: 'The file looks good.' }],
    terminal: { state: 'completed' },
  });
});

test('a Codex exec --json sequence yields thread, item text, file changes and turn terminal states', () => {
  const absolutePath = resolve('src/absolute.mjs');
  const events = [
    { type: 'thread.started', thread_id: CODEX_THREAD },
    { type: 'item.completed', item: { id: 'item-0', type: 'agent_message', text: 'Implemented the parser.' } },
    {
      type: 'item.completed',
      item: {
        id: 'item-1',
        type: 'file_change',
        changes: [
          { path: 'src/new.mjs', kind: 'add' },
          { path: absolutePath, kind: 'delete' },
        ],
      },
    },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 20 } },
  ];
  const normalized = events.map(event => normalizeCliEvent(event, { workspace: WORKSPACE }));

  assert.deepEqual(normalized[0], { type: 'thread.started', sessionId: CODEX_THREAD });
  assert.deepEqual(normalized[1], {
    type: 'item.completed',
    messages: [{ role: 'assistant', text: 'Implemented the parser.' }],
  });
  assert.deepEqual(normalized[2], {
    type: 'item.completed',
    changes: [
      { path: resolve('src/new.mjs'), operation: 'create' },
      { path: path.normalize(absolutePath), operation: 'delete' },
    ],
  });
  assert.deepEqual(normalized[3], { type: 'turn.completed', terminal: { state: 'completed' } });

  assert.deepEqual(normalizeCliEvent({ type: 'turn.failed', thread_id: CODEX_THREAD }, {}), {
    type: 'turn.failed',
    sessionId: CODEX_THREAD,
    terminal: { state: 'failed' },
  });
  assert.deepEqual(normalizeCliEvent({ type: 'turn.cancelled' }, {}), {
    type: 'turn.cancelled',
    terminal: { state: 'cancelled' },
  });
});

test('Claude result errors and explicit exit events map to failed or completed with an exit code', () => {
  assert.deepEqual(normalizeCliEvent({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'stopped' }, {}), {
    type: 'result',
    messages: [{ role: 'assistant', text: 'stopped' }],
    terminal: { state: 'failed' },
  });
  assert.deepEqual(normalizeCliEvent({ type: 'result', subtype: 'error_during_execution' }, {}).terminal, { state: 'failed' });
  assert.deepEqual(normalizeCliEvent({ type: 'result', subtype: 'interrupted' }, {}).terminal, { state: 'cancelled' });
  assert.deepEqual(normalizeCliEvent({ type: 'exit', exit_code: 0 }, {}).terminal, { state: 'completed', exitCode: 0 });
  assert.deepEqual(normalizeCliEvent({ type: 'exit', exitCode: 2 }, {}).terminal, { state: 'failed', exitCode: 2 });
});

test('extractSessionId checks both Claude and Codex spellings, including nested envelopes', () => {
  assert.equal(extractSessionId({ session_id: 'claude' }), 'claude');
  assert.equal(extractSessionId({ sessionId: 'camel-claude' }), 'camel-claude');
  assert.equal(extractSessionId({ thread_id: 'codex' }), 'codex');
  assert.equal(extractSessionId({ threadId: 'camel-codex' }), 'camel-codex');
  assert.equal(extractSessionId({ item: { threadId: 'nested' } }), 'nested');
  assert.equal(extractSessionId({}), undefined);
  assert.equal(extractSessionId(null), undefined);
});

test('extractMessages reads each common envelope and skips tool-only content', () => {
  assert.deepEqual(extractMessages({ result: 'final answer' }), [{ role: 'assistant', text: 'final answer' }]);
  assert.deepEqual(
    extractMessages({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool_use', name: 'Read' },
          { type: 'text', text: 'second' },
        ],
      },
    }),
    [{ role: 'assistant', text: 'first\nsecond' }],
  );
  assert.deepEqual(extractMessages({ content: [{ type: 'text', text: 'top level' }] }), [{ role: 'assistant', text: 'top level' }]);
  assert.deepEqual(extractMessages({ delta: { text: 'delta text' } }), [{ role: 'assistant', text: 'delta text' }]);
  assert.deepEqual(extractMessages({ event: { delta: { text: 'nested delta' } } }), [{ role: 'assistant', text: 'nested delta' }]);
  assert.deepEqual(extractMessages({ item: { type: 'agent_message', text: 'item text' } }), [{ role: 'assistant', text: 'item text' }]);
  assert.deepEqual(extractMessages({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'question' }] } }), [
    { role: 'user', text: 'question' },
  ]);
  assert.deepEqual(extractMessages({ type: 'user', message: { content: [{ type: 'tool_result', content: 'hidden' }] } }), []);
  assert.deepEqual(extractMessages({ result: 'final', message: { content: [{ type: 'text', text: 'older' }] } }), [
    { role: 'assistant', text: 'final' },
  ]);
  assert.deepEqual(extractMessages({}), []);
});

test('extractChanges resolves relative paths against the workspace and normalizes operations', () => {
  const absolutePath = resolve('src/absolute.mjs');
  const event = {
    type: 'file_change',
    changes: [
      { file_path: 'src/create.mjs', operation: 'create' },
      { filePath: 'src/update.mjs', action: 'update' },
      { path: 'src/delete.mjs', type: 'delete' },
      { old_path: 'src/old.mjs', type: 'rename' },
      { path: absolutePath, kind: 'update' },
    ],
  };
  assert.deepEqual(extractChanges(event, WORKSPACE), [
    { path: resolve('src/create.mjs'), operation: 'create' },
    { path: resolve('src/update.mjs'), operation: 'update' },
    { path: resolve('src/delete.mjs'), operation: 'delete' },
    { path: resolve('src/old.mjs'), operation: 'rename' },
    { path: path.normalize(absolutePath), operation: 'update' },
  ]);
});

test('extractChanges keeps one entry per path and operation and ignores unprovable changes', () => {
  assert.deepEqual(
    extractChanges({ type: 'file_change', changes: [{ path: 'src/a.mjs', operation: 'update' }, { path: 'src/a.mjs', action: 'update' }] }, WORKSPACE),
    [{ path: resolve('src/a.mjs'), operation: 'update' }],
  );
  assert.deepEqual(extractChanges({ changes: [{ path: 'src/a.mjs' }] }, WORKSPACE), []);
  assert.deepEqual(extractChanges({ changes: [{ path: 'src/a.mjs', operation: 'update' }] }), []);
  assert.deepEqual(extractChanges({}, WORKSPACE), []);
  assert.deepEqual(
    extractChanges({ changes: [{ path: 'src/new.mjs', old_path: 'src/old.mjs', operation: 'rename' }] }, WORKSPACE),
    [{ path: resolve('src/new.mjs'), operation: 'rename' }],
  );
});

test('file-writing tool calls can supply a path when the tool name proves the operation', () => {
  assert.deepEqual(
    extractChanges({ type: 'tool_use', name: 'Write', input: { file_path: 'src/written.mjs', content: 'x' } }, WORKSPACE),
    [{ path: resolve('src/written.mjs'), operation: 'update' }],
  );
  const normalized = normalizeCliEvent({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: 'src/edited.mjs' } },
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/read.mjs' } },
      ],
    },
  }, { workspace: WORKSPACE });
  assert.deepEqual(normalized.changes, [{ path: resolve('src/edited.mjs'), operation: 'update' }]);
});

test('tool names come only from tool_use/tool_call events and are capped at 24', () => {
  const blocks = Array.from({ length: 30 }, (_, index) => ({ type: 'tool_use', name: `Tool${index + 1}` }));
  const normalized = normalizeCliEvent({
    type: 'assistant',
    message: { role: 'assistant', content: blocks },
  });
  assert.equal(normalized.messages, undefined);
  assert.deepEqual(normalized.tools, blocks.slice(0, 24).map(block => block.name));
  assert.deepEqual(normalizeCliEvent({ type: 'system', tools: ['Bash', 'Read'] }, {}), { type: 'system' });
  assert.deepEqual(
    normalizeCliEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Read' }] } }, {}).tools,
    ['Read'],
  );
});

test('normalizeCliEvent always returns a type and null only for non-objects', () => {
  assert.equal(normalizeCliEvent(null), null);
  assert.equal(normalizeCliEvent('assistant'), null);
  assert.deepEqual(normalizeCliEvent({}), { type: 'unknown' });
  assert.deepEqual(normalizeCliEvent({ event: { type: 'content_block_delta' } }, {}), { type: 'content_block_delta' });
});

test('EventCollector bounds event history, messages and per-message text', () => {
  const collector = new EventCollector({ workspace: WORKSPACE, maxEvents: 2, maxMessages: 2, maxText: 5 });
  collector.pushLine(JSON.stringify({ type: 'system', session_id: 'session-x' }));
  collector.pushLine(JSON.stringify({
    type: 'assistant',
    session_id: 'session-x',
    message: { role: 'assistant', content: [{ type: 'text', text: 'first message' }] },
  }));
  collector.pushLine(JSON.stringify({
    type: 'assistant',
    session_id: 'session-x',
    message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
  }));
  collector.pushLine(JSON.stringify({ type: 'result', result: 'third' }));

  const snapshot = collector.snapshot();
  assert.deepEqual(snapshot.events.map(event => event.type), ['assistant', 'result']);
  assert.doesNotMatch(JSON.stringify(snapshot.events), /first message|second|third/);
  assert.deepEqual(snapshot.messages, [
    { role: 'assistant', text: 'secon' },
    { role: 'assistant', text: 'third' },
  ]);
  assert.equal(snapshot.sessionId, 'session-x');
  assert.equal(snapshot.lastEventType, 'result');
});

test('EventCollector bounds changes and unique tool names', () => {
  const collector = new EventCollector({ workspace: WORKSPACE, maxChanges: 2, maxEvents: 100 });
  for (let index = 0; index < 3; index += 1) {
    collector.pushLine(JSON.stringify({ type: 'file_change', changes: [{ path: `src/${index}.mjs`, operation: 'update' }] }));
  }
  let snapshot = collector.snapshot();
  assert.deepEqual(snapshot.changes, [
    { path: resolve('src/1.mjs'), operation: 'update' },
    { path: resolve('src/2.mjs'), operation: 'update' },
  ]);

  const tools = new EventCollector({ workspace: WORKSPACE });
  for (let index = 0; index < 30; index += 1) {
    tools.pushLine(JSON.stringify({ type: 'tool_call', name: `Tool${index + 1}` }));
  }
  snapshot = tools.snapshot();
  assert.equal(snapshot.tools.length, 24);
  assert.equal(snapshot.tools.at(-1), 'Tool24');
});

test('file attribution waits for successful write results and excludes rejected writes', () => {
  const collector = new EventCollector({ workspace: WORKSPACE });
  const use = id => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: `src/${id}.mjs` } }] } });
  collector.pushLine(JSON.stringify(use('denied')));
  assert.deepEqual(collector.snapshot().changes, []);
  collector.pushLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'denied', is_error: true }] } }));
  assert.deepEqual(collector.snapshot().changes, []);
  collector.pushLine(JSON.stringify(use('written')));
  collector.pushLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'written' }] } }));
  assert.deepEqual(collector.snapshot().changes.map(item => item.path), [resolve('src/written.mjs')]);
});

test('EventCollector deduplicates repeated messages, changes and tools', () => {
  const collector = new EventCollector({ workspace: WORKSPACE });
  const messageLine = JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'same text' }] },
  });
  const changeLine = JSON.stringify({ type: 'file_change', changes: [{ path: 'src/a.mjs', operation: 'update' }] });
  const toolLine = JSON.stringify({ type: 'tool_call', name: 'Read' });

  assert.ok(collector.pushLine(messageLine));
  assert.ok(collector.pushLine(messageLine));
  assert.ok(collector.pushLine(changeLine));
  assert.ok(collector.pushLine(changeLine));
  assert.ok(collector.pushLine(toolLine));
  assert.ok(collector.pushLine(toolLine));

  const snapshot = collector.snapshot();
  assert.equal(snapshot.events.length, 6);
  assert.deepEqual(snapshot.messages, [{ role: 'assistant', text: 'same text' }]);
  assert.deepEqual(snapshot.changes, [{ path: resolve('src/a.mjs'), operation: 'update' }]);
  assert.deepEqual(snapshot.tools, ['Read']);
});

test('EventCollector snapshots are detached copies', () => {
  const collector = new EventCollector({ workspace: WORKSPACE });
  collector.pushLine(JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'original' }] },
  }));
  collector.pushLine(JSON.stringify({ type: 'file_change', changes: [{ path: 'src/a.mjs', operation: 'update' }] }));
  collector.pushLine(JSON.stringify({ type: 'tool_call', name: 'Read' }));

  const first = collector.snapshot();
  first.messages[0].text = 'mutated';
  first.changes[0].path = 'mutated';
  first.tools.push('Mutated');
  first.events[0].type = 'mutated';

  const second = collector.snapshot();
  assert.deepEqual(second.messages, [{ role: 'assistant', text: 'original' }]);
  assert.deepEqual(second.changes, [{ path: resolve('src/a.mjs'), operation: 'update' }]);
  assert.deepEqual(second.tools, ['Read']);
  assert.equal(second.events[0].type, 'assistant');
});

test('EventCollector retains terminal evidence in its bounded event summary', () => {
  const collector = new EventCollector({ workspace: WORKSPACE });
  collector.pushLine(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'failed' }));
  const snapshot = collector.snapshot();
  assert.equal(snapshot.events.at(-1).terminal.state, 'failed');
  assert.equal(snapshot.messages.at(-1).text, 'failed');
});

test('EventCollector skips bad lines without throwing and leaves its state untouched', () => {
  const collector = new EventCollector({ workspace: WORKSPACE });
  for (const line of ['', '   ', 'not json', '{"type":', '[]', 'null', '42', undefined]) {
    assert.doesNotThrow(() => collector.pushLine(line));
    assert.equal(collector.pushLine(line), null);
  }
  assert.deepEqual(collector.snapshot(), {
    events: [],
    messages: [],
    changes: [],
    tools: [],
    sessionId: undefined,
    lastEventType: undefined,
  });
});
