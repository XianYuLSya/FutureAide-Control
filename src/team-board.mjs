// The team board: the roster as the designer's page shows it, built only when somebody
// asks for it. Nothing here runs on a timer, enumerates processes or reads a conversation
// body: one read of the roster projections and, at most, one directory listing of the
// local Claude session titles per request.
//
// The shape is the one in docs/grill/Boss协议/团队看板/样例数据.json, minus `machine`
// (that block is the export script's machine snapshot; the board never looks at it).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOARD_PATH = '/board';
export const BOARD_DATA_PATH = '/board/data';
// A name nobody touched for this long is history, not a live seat on the board.
const WINDOW_MS = 36 * 3600 * 1000;
const ROLE_TEXT_CHARS = 400, ACTIVITY_CHARS = 80, TASK_CHARS = 90, SUMMARY_CHARS = 140;
// Same vocabulary the approved export used: the first task names the seat's role.
const ROLE_WORDS = [['独立审查员', '独立审查员'], ['审查员', '独立审查员'], ['团队长', '团队长'], ['规划师', '规划师'],
  ['设计师', '设计师'], ['前端工程师', '前端工程师'], ['后端工程师', '后端工程师'], ['产品经理', '产品经理'],
  ['调查员', '调查员'], ['秘书', '秘书']];

const first = (text, limit) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

function localTime(iso) {
  if (!iso) return null;
  const value = new Date(iso);
  return Number.isNaN(value.getTime()) ? null : value.toLocaleString('zh-CN',
    { timeZone: 'America/New_York', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function roleOf(name, text) {
  const value = String(text ?? '').slice(0, ROLE_TEXT_CHARS);
  return (ROLE_WORDS.find(([word]) => value.includes(word))
    ?? ROLE_WORDS.find(([word]) => String(name ?? '').includes(word.slice(0, 2)))
    ?? [null, '未标注'])[1];
}

/** The folder a project path ends in: the page shows it when a chat has no title. */
export function projectName(project) {
  const value = typeof project === 'string' ? project.replace(/[\\/]+$/, '') : '';
  return value ? path.basename(value) : null;
}

/**
 * Claude session titles, read from the local session registry. A missing or unreadable
 * registry is simply "no titles": the board then shows the project folder name.
 */
export function claudeTitles({ root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), read = readFileSync, list = readdirSync } = {}) {
  const titles = new Map();
  let entries;
  try { entries = list(path.join(root, 'sessions')); } catch { return titles; }
  for (const name of entries) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const value = JSON.parse(read(path.join(root, 'sessions', name), 'utf8'));
      if (typeof value?.sessionId === 'string' && typeof value?.name === 'string' && value.name.trim()) titles.set(value.sessionId, value.name.trim());
    } catch { /* a half-written session file is not a title */ }
  }
  return titles;
}

/** One name as the board shows it, from the snapshot row the store already projected. */
export function boardName(row) {
  return {
    id: row.id,
    name: row.name,
    role: roleOf(row.name, `${row.firstTaskMessage ?? ''} ${row.task ?? ''}`),
    target: row.target ?? 'dsh',
    model: row.taskModel ?? row.selectionModel ?? null,
    effort: row.taskEffort ?? row.selectionEffort ?? null,
    state: row.state ?? null,
    activity: first(row.activity, ACTIVITY_CHARS) || null,
    task: first(row.task, TASK_CHARS),
    report: row.reportSummary === null || row.reportSummary === undefined ? null
      : { final: Boolean(row.reportFinal), summary: first(row.reportSummary, SUMMARY_CHARS), delivery: row.reportDelivery ?? null },
    pendingQuestions: Number(row.pendingQuestions ?? 0),
    files: row.fileCount === null || row.fileCount === undefined ? null : Number(row.fileCount),
    release: row.release ?? null,
    nativeChildren: Number(row.treeNodes ?? 0) > 1 ? Number(row.treeNodes) - 1 : 0,
    updated: localTime(row.updatedAt),
    parent: row.parent ?? null,
  };
}

/**
 * The whole board, in one request and from one snapshot: every read comes out of
 * `store.boardSnapshot()` (a projection the roster already caches), and the 36-hour
 * window is applied here so that an old row never forces the projection to rebuild.
 */
export function boardData(store, { titles = claudeTitles(), now = Date.now() } = {}) {
  const snapshot = store.boardSnapshot();
  const since = new Date(now - WINDOW_MS).toISOString();
  const rows = snapshot.filter(row => typeof row.updatedAt === 'string' && row.updatedAt > since);
  const names = rows.map(boardName);
  const mine = new Map();
  rows.forEach((row, index) => {
    if (!mine.has(row.owner)) mine.set(row.owner, []);
    mine.get(row.owner).push({ row, name: names[index] });
  });

  const children = (entries, parentId) => entries.filter(entry => entry.name.parent === parentId)
    .map(entry => ({ ...entry.name, children: children(entries, entry.name.id) }));
  const chats = [];
  for (const entries of mine.values()) {
    const { row } = entries[0];
    const project = row.ownerWorkspace ?? row.ownerBindingWorkspace ?? null;
    const known = new Set(entries.map(entry => entry.name.id));
    const title = (row.ownerNativeSessionId && titles.get(row.ownerNativeSessionId)) || (row.ownerThread ? 'Codex 对话' : null);
    chats.push({
      source: row.ownerSource ?? (row.ownerThread ? 'codex' : 'unknown'),
      project,
      // An empty title falls back to the project folder: the page always has something to show.
      chat: title ?? projectName(project),
      ownerThread: row.ownerThread ?? null,
      names: entries.filter(entry => !entry.name.parent || !known.has(entry.name.parent))
        .map(entry => ({ ...entry.name, children: children(entries, entry.name.id) })),
    });
  }

  // A Codex lead's own thread owns the helpers it dispatched: they hang under it, marked
  // with how they got there, and their chat no longer appears on its own.
  const threads = new Map(rows.filter(row => typeof row.thread === 'string' && row.thread).map(row => [row.thread, row.id]));
  const index = new Map();
  const walk = list => list.forEach(item => { index.set(item.id, item); walk(item.children ?? []); });
  chats.forEach(chat => walk(chat.names));
  const rest = [];
  for (const chat of chats) {
    const own = new Set();
    const collect = list => list.forEach(item => { own.add(item.id); collect(item.children ?? []); });
    collect(chat.names);
    const parentId = chat.ownerThread && threads.get(chat.ownerThread);
    // A chat is never nested into itself: a lead's own thread names the lead it contains.
    const parent = parentId && !own.has(parentId) ? index.get(parentId) : undefined;
    if (parent) parent.children.push(...chat.names.map(item => ({ ...item, via: 'lead-dispatch' })));
    else rest.push(chat);
  }
  rest.sort((left, right) => right.names.length - left.names.length);

  const states = {};
  for (const name of names) if (name.state) states[name.state] = (states[name.state] ?? 0) + 1;
  return { exportedAt: localTime(new Date(now).toISOString()), states, chats: rest };
}

/**
 * Where the page lives: the packaged asset of this build first, then the approved design
 * in the plugin's docs (a checkout has the design before the asset is packaged). Both are
 * read-only; nothing here ever writes a page.
 */
export function boardPageFile({ here = path.dirname(fileURLToPath(import.meta.url)) } = {}) {
  const candidates = [
    path.join(here, '..', 'assets', 'team-board', 'index.html'),
    path.join(here, '..', 'docs', 'grill', 'Boss协议', '团队看板', '小看板.html'),
  ];
  return candidates.find(file => { try { return statSync(file).isFile(); } catch { return false; } });
}

/**
 * The two read-only routes, as one object the HTTP listener can mount. The page is
 * returned byte for byte; the data never carries the export script's `machine` block.
 */
export function boardRoutes(store, { titles = claudeTitles, now = Date.now, pageFile = boardPageFile } = {}) {
  return {
    page() {
      const file = pageFile();
      if (!file) return undefined;
      return { body: readFileSync(file), type: 'text/html; charset=utf-8' };
    },
    data() { return boardData(store, { titles: titles(), now: now() }); },
  };
}
