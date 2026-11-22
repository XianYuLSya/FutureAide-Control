import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_RECEIPT_PARSER, findClaudeReceipt } from '../src/scoped-agents.mjs';

const page = (offset, deliveries = [], hasMore = false) => ({ deliveries, events: [], taskNotifications: [],
  badLines: 0, offset, size: offset, hasMore });

test('an old notice cursor is discarded once and the read-only backscan resumes from its page cursor', async () => {
  const notice = { id: 'notice-old', state: 'unknown', cursor: 4096 };
  const offsets = [];
  const readEvents = async (binding, { offset }) => {
    offsets.push(offset);
    return offset === 0 ? page(1024, [], true) : page(2048);
  };
  assert.equal(await findClaudeReceipt({}, notice, readEvents), undefined);
  assert.deepEqual(offsets, [0, 1024], 'the old cursor must not hide the receipt');
  assert.equal(notice.cursor, 2048);
  assert.equal(notice.receiptParser, CLAUDE_RECEIPT_PARSER);

  offsets.length = 0;
  await findClaudeReceipt({}, notice, readEvents);
  assert.deepEqual(offsets, [2048], 'a later poll continues instead of scanning the history again');
});

test('a notice written by the current parser starts at its pre-send cursor', async () => {
  const notice = { id: 'notice-new', state: 'unknown', cursor: 4096, receiptParser: CLAUDE_RECEIPT_PARSER };
  let seen;
  const readEvents = async (binding, { offset }) => {
    seen = offset;
    return page(5000, [{ requestId: 'notice-new', stage: 'accepted', seq: 1 }]);
  };
  const matched = await findClaudeReceipt({}, notice, readEvents);
  assert.equal(seen, 4096);
  assert.equal(matched.stage, 'accepted');
  assert.equal(notice.cursor, 5000);
});

test('a bounded upgrade scan stops at its cutoff, then follows new records from the saved cursor', async () => {
  const notice = { id: 'notice-cutoff', state: 'unknown', cursor: 0, receiptParser: CLAUDE_RECEIPT_PARSER,
    receiptScan: { parser: CLAUDE_RECEIPT_PARSER, through: 1 << 20, complete: false } };
  const calls = [];
  const readEvents = async (binding, { offset, maxBytes }) => {
    calls.push({ offset, maxBytes });
    return page(offset + (1 << 20), [], true);
  };
  assert.equal(await findClaudeReceipt({}, notice, readEvents), undefined);
  assert.deepEqual(calls, [{ offset: 0, maxBytes: 1 << 20 }], 'the scan never reads past its fixed cutoff');
  assert.equal(notice.receiptScan.complete, true);
  assert.equal(notice.receiptScan.through, undefined, 'a completed scan drops the cutoff');

  calls.length = 0;
  await findClaudeReceipt({}, notice, readEvents);
  assert.deepEqual(calls[0], { offset: 1 << 20, maxBytes: 1 << 20 },
    'later polls follow new records from the saved cursor');
});

test('an ordinary long line retries at the reader ceiling, not the page size', async () => {
  const notice = { id: 'notice-long-line', state: 'unknown', cursor: 0, receiptParser: CLAUDE_RECEIPT_PARSER };
  const sizes = [];
  const readEvents = async (binding, { offset, maxBytes }) => {
    sizes.push(maxBytes);
    if (sizes.length === 1) throw new Error('claude-transcript-line-exceeds-page');
    return page(offset + 1, [{ requestId: 'notice-long-line', stage: 'accepted', seq: 1 }]);
  };
  const matched = await findClaudeReceipt({}, notice, readEvents);
  assert.deepEqual(sizes, [1 << 20, 16 << 20]);
  assert.equal(matched.stage, 'accepted');
});

test('a fixed window ending inside a trailing line completes at its last complete cursor', async () => {
  const notice = { id: 'notice-partial', state: 'unknown', cursor: 0, receiptParser: CLAUDE_RECEIPT_PARSER,
    receiptScan: { parser: CLAUDE_RECEIPT_PARSER, through: 136, complete: false } };
  const calls = [];
  const readEvents = async (binding, { offset, maxBytes }) => {
    calls.push({ offset, maxBytes });
    if (offset === 0) return page(100, [], true);
    throw new Error('claude-transcript-line-exceeds-page');
  };
  assert.equal(await findClaudeReceipt({}, notice, readEvents), undefined);
  assert.deepEqual(calls, [{ offset: 0, maxBytes: 136 }, { offset: 100, maxBytes: 36 }],
    'the fixed window cannot fit the trailing partial line');
  assert.equal(notice.cursor, 100, 'the last complete line is kept');
  assert.equal(notice.receiptScan.complete, true);
  assert.equal(notice.receiptScan.through, undefined);

  calls.length = 0;
  const later = async (binding, { offset, maxBytes }) => {
    calls.push({ offset, maxBytes });
    return page(offset + 36, [{ requestId: 'notice-partial', stage: 'inserted', seq: 2 }]);
  };
  const matched = await findClaudeReceipt({}, notice, later);
  assert.deepEqual(calls[0], { offset: 100, maxBytes: 1 << 20 }, 'the next read is an ordinary increment');
  assert.equal(matched.stage, 'inserted');
});

test('a fixed window still expands a long line to the 16MiB ceiling', async () => {
  const notice = { id: 'notice-long-fixed', state: 'unknown', cursor: 0, receiptParser: CLAUDE_RECEIPT_PARSER,
    receiptScan: { parser: CLAUDE_RECEIPT_PARSER, through: 20 << 20, complete: false } };
  const sizes = [];
  const readEvents = async (binding, { offset, maxBytes }) => {
    sizes.push(maxBytes);
    if (sizes.length === 1) throw new Error('claude-transcript-line-exceeds-page');
    return page(offset + maxBytes, [{ requestId: 'notice-long-fixed', stage: 'accepted', seq: 1 }]);
  };
  const matched = await findClaudeReceipt({}, notice, readEvents);
  assert.deepEqual(sizes, [1 << 20, 16 << 20]);
  assert.equal(matched.stage, 'accepted');
});

test('a backscan that spans more than one poll saves every page before finding the receipt', async () => {
  const notice = { id: 'notice-paged', state: 'unknown', cursor: 999999 };
  const offsets = [];
  let pageNumber = 0;
  const readEvents = async (binding, { offset }) => {
    offsets.push(offset);
    pageNumber++;
    if (pageNumber <= 8) return page(offset + (1 << 20), [], true);
    return page(offset + 1, [{ requestId: 'notice-paged', stage: 'inserted', seq: 9 }]);
  };
  assert.equal(await findClaudeReceipt({}, notice, readEvents), undefined);
  assert.equal(offsets.length, 8);
  assert.equal(notice.cursor, 8 << 20, 'the cursor is persisted at the last complete page');
  const matched = await findClaudeReceipt({}, notice, readEvents);
  assert.equal(offsets[8], 8 << 20, 'the next poll resumes where the last one stopped');
  assert.equal(matched.stage, 'inserted');
});
