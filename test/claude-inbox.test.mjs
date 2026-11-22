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

test('enqueue acknowledges only the exact transport envelope, before busy insertion', async () => {
  const envelope = `<cross-session-message from-name="FutureAide Control">\n[FutureAide request ${requestId}]\nDo work.\n</cross-session-message>`;
  const binding = await fixture(
    line({ type: 'queue-operation', operation: 'enqueue', content: 'Quoted: ' + envelope })
    + line({ type: 'queue-operation', operation: 'enqueue', content: envelope.replace('FutureAide Control', 'Other peer') })
    + line({ type: 'queue-operation', operation: 'enqueue', content: envelope }));
  const result = await readClaudeEvents(binding);
  assert.deepEqual(result.deliveries.map(({ requestId: id, stage }) => [id, stage]), [[requestId, 'accepted']]);
});

const desktopUuid = '47a1f490-11b6-4685-a1ad-cbdbccac4fdc';
const envelope = id => `<cross-session-message from-name="FutureAide Control">\r\n[FutureAide request ${id}]\r\nReport body\r\n</cross-session-message>`;

test('an explicit FutureAide peer is identified from the bare origin body marker', async () => {
  const noticeId = 'notice-submission-e11591f0f2cb415a9e747e04b594b167';
  const binding = await fixture(line({ type: 'attachment', attachment: { type: 'queued_command',
    source_uuid: desktopUuid, delivery_id: 'native-delivery',
    origin: { kind: 'peer', from: 'FutureAide Control', name: 'FutureAide Control',
      body: `[FutureAide request ${noticeId}]\r\nReport body` } } }));
  const result = await readClaudeEvents(binding);
  assert.deepEqual(result.deliveries.map(({ requestId: id, stage }) => [id, stage]), [[noticeId, 'accepted']]);
});

test('an explicit FutureAide peer may also carry the bare marker in prompt', async () => {
  const noticeId = 'notice-prompt-bare';
  const binding = await fixture(line({ type: 'attachment', attachment: { type: 'queued_command',
    prompt: `[FutureAide request ${noticeId}]\r\nReport body`, source_uuid: desktopUuid, delivery_id: 'prompt-bare',
    origin: { kind: 'peer', from: 'FutureAide Control', name: 'FutureAide Control' } } }));
  const result = await readClaudeEvents(binding);
  assert.deepEqual(result.deliveries.map(({ requestId: id, stage }) => [id, stage]), [[noticeId, 'accepted']]);
});

test('an attachment without sender metadata is identified only by its complete prompt envelope', async () => {
  const promptOnlyId = 'notice-prompt-only';
  const bareId = 'notice-bare-no-sender';
  const binding = await fixture(
    line({ type: 'attachment', attachment: { type: 'queued_command', prompt: envelope(promptOnlyId),
      source_uuid: desktopUuid, delivery_id: 'prompt-only', origin: { kind: 'peer' } } })
    + line({ type: 'attachment', attachment: { type: 'queued_command', source_uuid: desktopUuid,
      delivery_id: 'bare', origin: { kind: 'peer', body: `[FutureAide request ${bareId}]\r\nReport body` } } }));
  const result = await readClaudeEvents(binding);
  assert.equal(result.deliveries.some(({ requestId: id }) => id === promptOnlyId), true);
  assert.equal(result.deliveries.some(({ requestId: id }) => id === bareId), false);
});

test('remove is identified only by the complete FutureAide envelope', async () => {
  const noticeId = 'notice-remove-envelope';
  const binding = await fixture(line({ type: 'queue-operation', operation: 'remove',
    reason: 'absorbed_mid_turn', commandUuid: desktopUuid, deliveryId: 'native-delivery',
    content: envelope(noticeId) }));
  const result = await readClaudeEvents(binding);
  assert.deepEqual(result.deliveries.map(({ requestId: id, stage }) => [id, stage]), [[noticeId, 'inserted']]);
});

test('a bare remove marker, a foreign peer bare body and its prompt envelope are not receipts', async () => {
  const bareRemoveId = 'notice-bare-remove';
  const foreignId = 'notice-foreign-peer';
  const foreignPromptId = 'notice-foreign-prompt';
  const quotedId = 'notice-quoted';
  const binding = await fixture(
    line({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn',
      commandUuid: desktopUuid, deliveryId: 'bare-remove', content: `[FutureAide request ${bareRemoveId}]\r\nReport body` })
    + line({ type: 'attachment', attachment: { type: 'queued_command', source_uuid: desktopUuid,
      delivery_id: 'foreign', origin: { kind: 'peer', from: 'Other peer', name: 'Other peer',
        body: `[FutureAide request ${foreignId}]\r\nReport body` } } })
    + line({ type: 'attachment', attachment: { type: 'queued_command', prompt: envelope(foreignPromptId),
      source_uuid: desktopUuid, delivery_id: 'foreign-prompt',
      origin: { kind: 'peer', from: 'Other peer', name: 'Other peer' } } })
    + line({ type: 'attachment', attachment: { type: 'queued_command',
      prompt: 'Quoted: ' + envelope(quotedId), source_uuid: desktopUuid, delivery_id: 'quoted',
      origin: { kind: 'peer', body: `Quoted: [FutureAide request ${quotedId}]\r\nReport body` } } }));
  const result = await readClaudeEvents(binding);
  for (const id of [bareRemoveId, foreignId, foreignPromptId, quotedId]) {
    assert.equal(result.deliveries.some(item => item.requestId === id), false, `${id} is not a receipt`);
  }
});
