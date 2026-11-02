// Normalizes one CLI stdout JSONL event into the small, serializable view a worker needs.
// Raw lines belong to the worker's log; this module never touches the filesystem and never
// scans a workspace, so every extracted value is proven by a field on the event itself.
import path from 'node:path';

const SESSION_KEYS = ['session_id', 'sessionId', 'thread_id', 'threadId'];
const PATH_KEYS = ['path', 'file_path', 'filePath', 'old_path', 'oldPath'];
const OPERATION_KEYS = ['operation', 'action', 'type', 'kind'];
const TOOL_NAME_KEYS = ['tool', 'tool_name', 'name'];
const MAX_TOOLS = 24;

// Codex calls a created file "add" and a changed file "update"; Claude callers tend to use
// create/update/delete/rename. Normalize both to the four operations the worker consumes.
const OPERATIONS = new Map([
  ['create', 'create'], ['created', 'create'], ['add', 'create'], ['added', 'create'], ['write', 'create'], ['new', 'create'],
  ['update', 'update'], ['updated', 'update'], ['modify', 'update'], ['modified', 'update'], ['edit', 'update'], ['edited', 'update'],
  ['delete', 'delete'], ['deleted', 'delete'], ['remove', 'delete'], ['removed', 'delete'],
  ['rename', 'rename'], ['renamed', 'rename'], ['move', 'rename'], ['moved', 'rename'],
]);

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A string that carries information; whitespace-only values are treated as absent. */
function text(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Parse one stdout line. CLI banners, blank lines and partial writes are ordinary input:
 * anything that is not a JSON object returns null instead of throwing.
 * @param {string} line One line from a CLI's stdout.
 * @returns {object|null} The parsed object, or null.
 */
export function parseJsonLine(line) {
  if (typeof line !== 'string') return null;
  const source = line.trim();
  if (!source) return null;
  try {
    const value = JSON.parse(source);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read a session/thread ID from the top level or one of the usual nested envelopes.
 * Claude uses session_id/sessionId; Codex uses thread_id/threadId.
 * @param {object} event Parsed CLI event.
 * @returns {string|undefined} The identifier when the event carries one.
 */
export function extractSessionId(event) {
  if (!isRecord(event)) return undefined;
  const envelopes = [event, event.event, event.item, event.message, event.data].filter(isRecord);
  for (const envelope of envelopes) {
    for (const key of SESSION_KEYS) {
      const value = text(envelope[key]);
      if (value) return value.trim();
    }
  }
  return undefined;
}

/** Concatenate only textual content blocks; tool calls/results and thinking blocks are not reply text. */
function contentText(content) {
  if (typeof content === 'string') return text(content);
  if (!Array.isArray(content)) return undefined;
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.trim()) parts.push(block);
      continue;
    }
    if (!isRecord(block) || block.type === 'tool_use' || block.type === 'tool_result') continue;
    const value = text(block.text);
    if (value) parts.push(value);
  }
  return parts.length ? parts.join('\n') : undefined;
}

/** The explicit role wins; otherwise the event type supplies Claude's user/assistant roles. */
function roleFor(event, message) {
  const explicit = typeof message?.role === 'string' ? message.role.toLowerCase()
    : typeof event.role === 'string' ? event.role.toLowerCase() : undefined;
  if (explicit === 'user' || explicit === 'assistant' || explicit === 'system') return explicit;
  if (event.type === 'user') return 'user';
  if (event.type === 'system') return 'system';
  return 'assistant';
}

/**
 * Extract visible message text from the common Claude and Codex envelopes. The first matching
 * source wins so a final `result` is not also reported as an assistant-message duplicate.
 * @param {object} event Parsed CLI event.
 * @returns {Array<{role: string, text: string}>} Zero or more messages.
 */
export function extractMessages(event) {
  if (!isRecord(event)) return [];
  const message = isRecord(event.message) ? event.message : undefined;
  const role = roleFor(event, message);

  // Claude Code result event: the final rendered answer.
  const result = text(event.result);
  if (result) return [{ role: 'assistant', text: result }];

  if (message) {
    const messageText = contentText(message.content) ?? text(message.text);
    if (messageText) return [{ role, text: messageText }];
  }

  // Top-level content is used by some wrappers, and by Claude's stream_event deltas when unwrapped.
  const content = contentText(event.content);
  if (content) return [{ role, text: content }];

  const delta = isRecord(event.delta) ? event.delta : isRecord(event.event?.delta) ? event.event.delta : undefined;
  const deltaText = text(delta?.text);
  if (deltaText) return [{ role: 'assistant', text: deltaText }];

  // Codex exec --json: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}.
  const item = isRecord(event.item) ? event.item : undefined;
  if (item) {
    const itemType = typeof item.type === 'string' ? item.type.toLowerCase() : '';
    if (!itemType || ['agent_message', 'assistant_message', 'assistant', 'message', 'text', 'output_text', 'response'].includes(itemType)) {
      const itemText = text(item.text) ?? contentText(item.content);
      if (itemText) return [{ role: roleFor(item, undefined), text: itemText }];
    }
  }

  const fallback = text(event.text);
  return fallback ? [{ role, text: fallback }] : [];
}

/** Tool-use blocks and tool-call events only; a system/init `tools` inventory is not usage. */
function isToolEventType(value) {
  if (typeof value !== 'string') return false;
  const type = value.toLowerCase();
  return type === 'tool_use' || type === 'tool_call' || type === 'function_call' || type === 'mcp_tool_call'
    || type.endsWith('.tool_use') || type.endsWith('_tool_use') || type.endsWith('.tool_call') || type.endsWith('_tool_call');
}

/** @returns {string[]} Up to 24 unique tool names used by this event. */
function extractTools(event) {
  const names = [];
  const add = value => {
    const name = text(value);
    if (name && !names.includes(name.trim()) && names.length < MAX_TOOLS) names.push(name.trim());
  };
  const addFrom = envelope => {
    if (!isRecord(envelope) || !isToolEventType(envelope.type)) return;
    for (const key of TOOL_NAME_KEYS) add(envelope[key]);
  };

  addFrom(event);
  const item = isRecord(event.item) ? event.item : undefined;
  addFrom(item);
  const message = isRecord(event.message) ? event.message : undefined;
  const blocks = [message?.content, event.content].flatMap(content => Array.isArray(content) ? content : []);
  const itemBlocks = item && Array.isArray(item.content) ? item.content : [];
  for (const block of [...blocks, ...itemBlocks]) {
    if (isRecord(block) && isToolEventType(block.type)) {
      for (const key of TOOL_NAME_KEYS) add(block[key]);
    }
  }
  return names;
}

function operationFor(value) {
  for (const key of OPERATION_KEYS) {
    const raw = value[key];
    if (typeof raw !== 'string') continue;
    const operation = OPERATIONS.get(raw.trim().toLowerCase());
    if (operation) return operation;
  }
  return undefined;
}

/** A file-writing tool often carries a path without an explicit operation. */
function inferToolOperation(event) {
  const name = [event?.tool, event?.tool_name, event?.name].find(value => typeof value === 'string')?.toLowerCase() ?? '';
  if (!name) return undefined;
  if (/delete|remove|unlink/.test(name)) return 'delete';
  if (/rename|move/.test(name)) return 'rename';
  if (/write|edit|patch|create|add|update/.test(name)) return 'update';
  return undefined;
}

function pathFor(value) {
  for (const key of PATH_KEYS) {
    const raw = text(value[key]);
    if (raw && !raw.includes('\0')) return raw.trim();
  }
  return undefined;
}

function absolutePath(raw, workspace) {
  if (path.isAbsolute(raw)) return path.normalize(raw);
  if (typeof workspace !== 'string' || !workspace.trim()) return undefined;
  return path.resolve(workspace, raw);
}

/**
 * Extract only file-change objects that prove both a path and one of the four operations.
 * A relative path is resolved against the workspace; no directory is read or listed.
 * @param {object} event Parsed CLI event.
 * @param {string} [workspace] Absolute workspace used to resolve relative paths.
 * @returns {Array<{path: string, operation: string}>} Deduplicated changes in event order.
 */
export function extractChanges(event, workspace) {
  if (!isRecord(event)) return [];
  const changes = [];
  const seen = new Set();
  const visited = new WeakSet();
  let budget = 1000;

  const visit = (value, depth, inheritedOperation) => {
    if (budget <= 0 || depth > 8 || !isRecord(value) || visited.has(value)) return;
    budget -= 1;
    visited.add(value);
    const operation = operationFor(value) ?? inferToolOperation(value) ?? inheritedOperation;
    if (operation) {
      const raw = pathFor(value);
      const resolved = raw ? absolutePath(raw, workspace) : undefined;
      if (resolved) {
        const key = `${operation}\0${resolved}`;
        if (!seen.has(key)) {
          seen.add(key);
          changes.push({ path: resolved, operation });
        }
      }
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) {
        for (const entry of child.slice(0, 100)) visit(entry, depth + 1, operation);
      } else if (isRecord(child)) {
        visit(child, depth + 1, operation);
      }
    }
  };

  visit(event, 0, undefined);
  return changes;
}

function exitCodeFor(event) {
  for (const key of ['exit_code', 'exitCode', 'exit_status', 'exitStatus']) {
    const value = event[key];
    if (Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
  }
  return undefined;
}

/** A final Claude result / Codex turn event is the only proof that the turn ended. */
function extractTerminal(event) {
  if (isRecord(event.terminal) && ['completed', 'failed', 'cancelled'].includes(event.terminal.state)) {
    const exitCode = exitCodeFor(event) ?? (Number.isInteger(event.terminal.exitCode) ? event.terminal.exitCode : undefined);
    return { state: event.terminal.state, ...(exitCode === undefined ? {} : { exitCode }) };
  }

  const type = typeof event.type === 'string' ? event.type.trim().toLowerCase() : '';
  let state;
  if (type === 'result') {
    const subtype = typeof event.subtype === 'string' ? event.subtype.toLowerCase() : '';
    if (event.is_error === true || subtype.startsWith('error') || subtype.includes('fail')) state = 'failed';
    else if (subtype.includes('cancel') || subtype.includes('abort') || subtype.includes('interrupt')) state = 'cancelled';
    else state = 'completed';
  } else if (type === 'turn.completed' || type === 'turn_completed' || type === 'completed') {
    state = 'completed';
  } else if (type === 'turn.failed' || type === 'turn_failed' || type === 'failed') {
    state = 'failed';
  } else if (['turn.cancelled', 'turn.canceled', 'turn_cancelled', 'turn_canceled', 'cancelled', 'canceled', 'aborted'].includes(type)) {
    state = 'cancelled';
  } else if (type === 'exit' || type === 'process_exit') {
    const code = exitCodeFor(event);
    if (code !== undefined) state = code === 0 ? 'completed' : 'failed';
  }
  if (!state) return undefined;
  const exitCode = exitCodeFor(event);
  return { state, ...(exitCode === undefined ? {} : { exitCode }) };
}

function eventType(event) {
  const direct = text(event.type);
  if (direct) return direct.trim();
  if (isRecord(event.event)) {
    const nested = text(event.event.type);
    if (nested) return nested.trim();
  }
  return text(event.kind)?.trim() ?? text(event.eventType)?.trim() ?? 'unknown';
}

/**
 * Normalize one parsed event. Unknown fields are ignored; an otherwise unrecognized object
 * still yields a type so the collector can record that the event existed.
 * @param {object} event Parsed CLI event.
 * @param {{workspace?: string}} [options] Workspace for relative change paths.
 * @returns {object|null} The normalized event shape, or null for a non-object.
 */
export function normalizeCliEvent(event, options = {}) {
  if (!isRecord(event)) return null;
  const workspace = options?.workspace;
  const sessionId = extractSessionId(event);
  const messages = extractMessages(event);
  const changes = extractChanges(event, workspace);
  const tools = extractTools(event);
  const terminal = extractTerminal(event);
  return {
    type: eventType(event),
    ...(sessionId ? { sessionId } : {}),
    ...(messages.length ? { messages } : {}),
    ...(changes.length ? { changes } : {}),
    ...(tools.length ? { tools } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

function limit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Bounded in-memory view of a running CLI turn. The worker writes raw JSONL itself; this class
 * keeps only event summaries plus capped messages, changes and tool names, so a long or noisy
 * run cannot grow the parent process without bound. Bad lines are skipped, never thrown.
 */
export class EventCollector {
  #events = [];
  #messages = [];
  #changes = [];
  #tools = [];
  #sessionId;
  #lastEventType;
  #workspace;
  #maxEvents;
  #maxMessages;
  #maxChanges;
  #maxText;
  #pendingWrites = new Map();

  constructor({ workspace, maxEvents = 2000, maxMessages = 50, maxChanges = 100, maxText = 8000 } = {}) {
    this.#workspace = typeof workspace === 'string' ? workspace : undefined;
    this.#maxEvents = limit(maxEvents, 2000);
    this.#maxMessages = limit(maxMessages, 50);
    this.#maxChanges = limit(maxChanges, 100);
    this.#maxText = limit(maxText, 8000);
  }

  #rememberEvent(event) {
    const summary = { type: event.type };
    if (event.sessionId) summary.sessionId = event.sessionId;
    if (event.tools?.length) summary.tools = [...event.tools];
    if (event.terminal) summary.terminal = { ...event.terminal };
    if (event.messages?.length) summary.messageCount = event.messages.length;
    if (event.changes?.length) summary.changeCount = event.changes.length;
    this.#events.push(summary);
    while (this.#events.length > this.#maxEvents) this.#events.shift();
  }

  #rememberMessage(message) {
    const source = typeof message?.text === 'string' ? message.text : '';
    if (!source.trim()) return;
    const value = source.length > this.#maxText ? source.slice(0, this.#maxText) : source;
    if (!value) return;
    const role = typeof message?.role === 'string' ? message.role : 'assistant';
    if (this.#messages.some(item => item.role === role && item.text === value)) return;
    this.#messages.push({ role, text: value });
    while (this.#messages.length > this.#maxMessages) this.#messages.shift();
  }

  #rememberChange(change) {
    const changePath = typeof change?.path === 'string' ? change.path : '';
    const operation = typeof change?.operation === 'string' ? change.operation : '';
    if (!changePath || !operation) return;
    if (this.#changes.some(item => item.path === changePath && item.operation === operation)) return;
    this.#changes.push({ path: changePath, operation });
    while (this.#changes.length > this.#maxChanges) this.#changes.shift();
  }

  #rememberTool(tool) {
    if (typeof tool !== 'string' || !tool.trim()) return;
    const name = tool.trim();
    if (this.#tools.includes(name) || this.#tools.length >= MAX_TOOLS) return;
    this.#tools.push(name);
  }

  /**
   * Parse, normalize and remember one stdout line.
   * @param {string} line One JSONL line.
   * @returns {object|null} The normalized event, or null when the line was not usable.
   */
  pushLine(line) {
    try {
      const event = parseJsonLine(line);
      if (!event) return null;
      const normalized = normalizeCliEvent(event, { workspace: this.#workspace });
      if (!normalized) return null;
      // A proposed Write/Edit is not evidence that the file changed. Claude
      // confirms it in a matching successful tool_result; Codex in item.completed.
      const blocks = [event, ...(Array.isArray(event.message?.content) ? event.message.content : [])];
      const uses = blocks.filter(block => block?.type === 'tool_use');
      if (uses.length) {
        for (const block of uses) if (block.id) this.#pendingWrites.set(block.id, extractChanges(block, this.#workspace));
        while (this.#pendingWrites.size > 200) this.#pendingWrites.delete(this.#pendingWrites.keys().next().value);
        normalized.changes = [];
      }
      for (const block of blocks.filter(block => block?.type === 'tool_result')) {
        const pending = this.#pendingWrites.get(block.tool_use_id);
        if (pending && !block.is_error) normalized.changes = [...(normalized.changes ?? []), ...pending];
        this.#pendingWrites.delete(block.tool_use_id);
      }
      if (event.type === 'item.started' || event.item?.status === 'failed' || event.is_error) normalized.changes = [];
      this.#lastEventType = normalized.type;
      if (normalized.sessionId) this.#sessionId = normalized.sessionId;
      this.#rememberEvent(normalized);
      for (const message of normalized.messages ?? []) this.#rememberMessage(message);
      for (const change of normalized.changes ?? []) this.#rememberChange(change);
      for (const tool of normalized.tools ?? []) this.#rememberTool(tool);
      return normalized;
    } catch {
      return null;
    }
  }

  /** @returns {{events: object[], messages: object[], changes: object[], tools: string[], sessionId: string|undefined, lastEventType: string|undefined}} A detached copy. */
  snapshot() {
    return {
      events: this.#events.map(event => ({
        ...event,
        ...(event.tools ? { tools: [...event.tools] } : {}),
        ...(event.terminal ? { terminal: { ...event.terminal } } : {}),
      })),
      messages: this.#messages.map(message => ({ ...message })),
      changes: this.#changes.map(change => ({ ...change })),
      tools: [...this.#tools],
      sessionId: this.#sessionId,
      lastEventType: this.#lastEventType,
    };
  }
}
