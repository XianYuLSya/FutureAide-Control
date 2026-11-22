import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile } from 'node:fs/promises';

const storage = new AsyncLocalStorage();
const fields = ['operationId', 'source', 'currentStage', 'initiatorRole', 'initiatorPid', 'agentId', 'rootId', 'nodeId', 'dispatchId'];
export function codexInstrumentationEnabled() {
  return process.env.FUTUREAIDE_CODEX_INSTRUMENTATION === '1' || Boolean(process.env.FUTUREAIDE_CODEX_METRICS_FILE);
}
function clean(value) {
  const result = {};
  for (const key of fields) {
    const item = value?.[key];
    if (typeof item === 'string' && item.length <= 160 && /^[\w.:/-]+$/.test(item)) result[key] = item;
    else if (key === 'initiatorPid' && Number.isSafeInteger(item) && item >= 0) result[key] = item;
  }
  return result;
}
export function getCodexInstrumentation() { return { ...(storage.getStore() ?? {}) }; }
export function withCodexInstrumentation(value, action) {
  if (!codexInstrumentationEnabled()) return action();
  return storage.run({ ...getCodexInstrumentation(), ...clean(value) }, action);
}
export function codexInstrumentationFields(value) { return { ...getCodexInstrumentation(), ...clean(value) }; }
// Bounded per-process queue: a slow or failed disk never blocks native requests.
export function createCodexMeasurementWriter(destination, { capacity = 4096, batchSize = 128, append = appendFile } = {}) {
  let queue = [], dropped = 0, writing = false, scheduled = false;
  const schedule = () => {
    if (scheduled || writing || (!queue.length && !dropped)) return;
    scheduled = true;
    setImmediate(flush);
  };
  async function flush() {
    scheduled = false;
    if (writing || (!queue.length && !dropped)) return;
    writing = true;
    const batch = queue.splice(0, batchSize);
    const lost = dropped; dropped = 0;
    const lines = [...(lost ? [{ event: 'metrics_dropped', time: new Date().toISOString(), pid: process.pid, count: lost }] : []), ...batch];
    try { await append(destination, lines.map(item => JSON.stringify(item)).join('\n') + '\n', 'utf8'); }
    catch { dropped += batch.length + lost; }
    writing = false;
    if (queue.length) schedule();
  }
  return event => { if (queue.length >= capacity) dropped++; else queue.push(event); schedule(); };
}
export const writeCodexMeasurement = process.env.FUTUREAIDE_CODEX_METRICS_FILE
  ? createCodexMeasurementWriter(process.env.FUTUREAIDE_CODEX_METRICS_FILE) : null;
