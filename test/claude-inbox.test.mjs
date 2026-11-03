import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readClaudeEvents } from '../src/claude-inbox.mjs';

const sessionId = '3725418e-ac07-45d6-877b-2ab22ef89017';
const requestId = '275da961-d841-4f01-a532-5300fdd4fbcd';
const line = value => JSON.stringify({ sessionId, ...value }) + '\n';
const accepted = () => ({ type: 'attachment', attachment: { type: 'queued_command',
  source_uuid: requestId, delivery_id: 'native-delivery', origin: { kind: 'peer' } } });

async function fixture(content) {
  // Retain test artifacts in this project's clean directory; never remove C: files.
  const directory = new URL(`../clean/validation/claude-inbox/${randomUUID()}/`, import.meta.url);
  await mkdir(directory, { recursive: true });
  const transcriptFile = fileURLToPath(new URL('transcript.jsonl', directory));
  await writeFile(transcriptFile, content);
  return { sessionId, transcriptFile };
}

test('busy inbox receipts use native IDs and remain separate from model output', async () => {
  const binding = await fixture(
    line({ type: 'queue-operation', operation: 'enqueue', content: requestId })
    + line({ ...accepted(), sessionId: 'another-session' })
    + line(accepted())
    + line({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn',
      commandUuid: requestId, deliveryId: 'native-delivery' })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } }));
  const result = await readClaudeEvents(binding);
  assert.deepEqual(result.deliveries.map(({ requestId: id, stage }) => [id, stage]),
    [[requestId, 'accepted'], [requestId, 'inserted']]);
  assert.deepEqual(result.events.map(event => event.text), ['Working.']);
  assert.equal(result.hasMore, false);
});

test('byte cursor defers an unfinished UTF-8 line and does not replay prior receipts', async () => {
  const prefix = Buffer.from(line(accepted()));
  const reply = Buffer.from(line({ type: 'assistant', message: { content: '收到方案，继续讨论。' } }));
  const cut = reply.indexOf(Buffer.from('到')) + 1;
  const binding = await fixture(Buffer.concat([prefix, reply.subarray(0, cut)]));
  const first = await readClaudeEvents(binding);
  assert.equal(first.offset, prefix.length);
  assert.equal(first.deliveries.length, 1);
  assert.equal(first.events.length, 0);
  await appendFile(binding.transcriptFile, reply.subarray(cut));
  const second = await readClaudeEvents(binding, { offset: first.offset });
  assert.equal(second.deliveries.length, 0);
  assert.equal(second.events[0].text, '收到方案，继续讨论。');
  const third = await readClaudeEvents(binding, { offset: second.offset });
  assert.equal(third.events.length, 0);
  assert.equal(third.deliveries.length, 0);
  assert.equal(third.offset, second.offset);
  await assert.rejects(readClaudeEvents(binding, { maxBytes: 16 }), /claude-transcript-line-exceeds-page/);
});

test('idle inbox delivery retains the user-frame UUID, unlike a tool result', async () => {
  const binding = await fixture(
    line({ type: 'user', uuid: requestId, message: { role: 'user', content: 'Peer request.' } })
    + line({ type: 'user', uuid: 'tool-result-id', message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Done.' }] } }));
  const result = await readClaudeEvents(binding);
  assert.deepEqual(result.deliveries.map(({ requestId: id, stage }) => [id, stage]), [[requestId, 'inserted']]);
});
