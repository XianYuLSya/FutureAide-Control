import { appendFileSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const protocolDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
const nonC = value => path.isAbsolute(value) && !/^c:[\\/]/i.test(value);
const errorFields = error => ({
  errorType: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error?.name ?? '') ? error.name : 'Error',
  ...(/^[A-Za-z0-9_-]{1,48}$/.test(String(error?.code ?? '')) ? { errorCode: error.code } : {}),
});

/** Best-effort local lifecycle evidence. Never log tool payloads or exception messages. */
export function createMcpDiagnostics(configFile = process.env.DSH_CONTROL_CONFIG) {
  let descriptor;
  try {
    if (!configFile || !nonC(configFile)) return;
    const parent = realpathSync(path.dirname(configFile));
    if (!nonC(parent)) return;
    const directory = path.join(parent, 'diagnostics');
    mkdirSync(directory, { recursive: true });
    const actual = realpathSync(directory);
    if (!nonC(actual)) return;
    descriptor = openSync(path.join(actual, `mcp-${process.pid}-${Date.now()}.jsonl`), 'wx', 0o600);
  } catch { return; }
  const record = (event, fields = {}) => {
    try { appendFileSync(descriptor, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...fields }) + '\n'); }
    catch { /* Diagnostic failure must never affect MCP or leak details to stdout. */ }
  };
  const hint = process.env.CODEX_MCP_PROTOCOL_VERSION;
  record('start', { ppid: process.ppid, ...(protocolDate(hint) ? { protocolHint: hint } : {}) });
  process.stdin.on('end', () => record('stdin_end'));
  process.stdin.on('close', () => record('stdin_close'));
  process.on('exit', code => record('exit', { code }));
  process.on('uncaughtExceptionMonitor', error => record('uncaught_exception', errorFields(error)));
  return {
    attach(transport) {
      // SDK Protocol.connect preserves these callbacks; it still receives the
      // original close/error events and owns their behavior.
      const previousClose = transport.onclose;
      transport.onclose = function (...args) { record('transport_close'); return previousClose?.apply(this, args); };
      const previousError = transport.onerror;
      transport.onerror = function (error, ...args) { record('transport_error', errorFields(error)); return previousError?.call(this, error, ...args); };
      const initializations = new Map();
      let receivedFirstMethod = false;
      const previousMessage = transport.onmessage;
      transport.onmessage = function (message, ...args) {
        if (!receivedFirstMethod && typeof message?.method === 'string') {
          receivedFirstMethod = true;
          const method = /^[A-Za-z0-9_/.:-]{1,100}$/.test(message.method) ? message.method : 'unknown';
          record('first_method', { method });
        }
        if (message?.method === 'initialize' && protocolDate(message.params?.protocolVersion)) {
          initializations.set(message.id, message.params.protocolVersion);
          record('initialize_request', { requestedProtocol: message.params.protocolVersion });
        }
        return previousMessage?.call(this, message, ...args);
      };
      const previousSend = transport.send;
      transport.send = function (message, ...args) {
        if (initializations.has(message?.id) && !message?.method) {
          const requestedProtocol = initializations.get(message.id);
          initializations.delete(message.id);
          if (protocolDate(message.result?.protocolVersion)) {
            record('initialize_response', { requestedProtocol, negotiatedProtocol: message.result.protocolVersion });
          }
        }
        return previousSend.call(this, message, ...args);
      };
    },
    tool(name, extra) {
      const id = extra?._meta?.threadId ?? extra?._meta?.['openai/threadId'];
      const fields = { tool: name, ...(typeof id === 'string' && uuid.test(id) ? { chatId: id } : {}) };
      record('tool_start', fields);
      return () => record('tool_end', fields);
    },
  };
}
