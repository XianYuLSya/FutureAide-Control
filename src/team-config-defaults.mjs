// Optional user-owned role preset resolver (`~/.config/futureaide-control/roles.md`
// or `FUTUREAIDE_ROLES_CONFIG`).
//
// By default (when no user preset file exists), `role` only auto-numbers the subagent
// name as-is (e.g. "backend" -> "backend1", "后端" -> "后端1") and leaves `model` and
// `effort` unset (`null`) so every turn follows the user's own configured CLI defaults.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function defaultTeamConfigPath(env = process.env) {
  if (typeof env?.FUTUREAIDE_ROLES_CONFIG === 'string' && env.FUTUREAIDE_ROLES_CONFIG.trim()) {
    return path.resolve(env.FUTUREAIDE_ROLES_CONFIG.trim());
  }
  return path.join(homedir(), '.config', 'futureaide-control', 'roles.md');
}

export const FALLBACK_ROLE_DEFAULTS = Object.freeze({});

export const DEFAULT_HEADLESS_FALLBACK = Object.freeze({
  target: 'codex-cli',
  model: null,
  effort: null,
  lifetime: 'once',
});

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function stripParenthetical(value) {
  let text = String(value ?? '');
  let prev;
  do {
    prev = text;
    text = text.replace(/（[^（）]*）|\([^()]*\)/g, ' ');
  } while (text !== prev);
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeRoleKey(rawRole) {
  if (typeof rawRole !== 'string') return '';
  const cleaned = stripParenthetical(rawRole)
    .replace(/`/g, '')
    .trim();
  if (!cleaned) return '';
  return cleaned.replace(/-?\d+$/u, '').trim() || cleaned;
}

function inferCliBrandTarget(roleKey) {
  const lower = String(roleKey ?? '').trim().toLowerCase();
  if (lower === 'agy' || lower === 'antigravity' || lower === 'agy-cli') return 'agy-cli';
  if (lower === 'claude' || lower === 'claude-cli') return 'claude-cli';
  if (lower === 'codex' || lower === 'codex-cli') return 'codex-cli';
  return null;
}

function extractTarget(dispatchCell, primaryModelClause) {
  const dispatch = String(dispatchCell ?? '');
  const cliMatch = /\b(codex-cli|claude-cli|agy-cli)\b/i.exec(dispatch);
  if (cliMatch) return cliMatch[1].toLowerCase();
  const modelText = String(primaryModelClause ?? '');
  if (/\b(?:gemini|antigravity|agy)\b/i.test(modelText)) return 'agy-cli';
  if (/\bclaude\b/i.test(modelText)) return 'claude-cli';
  if (/\b(?:codex|gpt-|o\d)\b/i.test(modelText)) return 'codex-cli';
  return null;
}

function extractLifetime(dispatchCell) {
  const dispatch = String(dispatchCell ?? '');
  if (/\bpersistent\b/i.test(dispatch)) return 'persistent';
  return 'once';
}

function extractModelAndEffort(modelCell, target) {
  const stripped = stripParenthetical(String(modelCell ?? '').replace(/`/g, ''));
  const clauses = stripped.split(/[；;]/).map(part => part.trim()).filter(Boolean);
  for (const clause of clauses) {
    let model = null;
    const slugMatch = /\b((?:gpt|claude|gemini|o\d)-[a-z0-9][a-z0-9.-]*)\b/i.exec(clause);
    if (slugMatch) {
      model = slugMatch[1].toLowerCase();
    } else {
      const claudeHuman = /\bclaude\s+(opus|sonnet|haiku|fable)\s+([0-9]+(?:\.[0-9]+)*)\b/i.exec(clause);
      if (claudeHuman) {
        model = `claude-${claudeHuman[1].toLowerCase()}-${claudeHuman[2].replace(/\./g, '-')}`;
      }
    }
    if (!model) continue;

    let effort = null;
    const tokens = clause.split(/[,，\s/]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
    for (const token of tokens) {
      if (VALID_EFFORTS.has(token)) {
        effort = token;
        break;
      }
    }
    const resolvedTarget = target
      ?? (model.startsWith('gemini-') ? 'agy-cli' : model.startsWith('claude-') ? 'claude-cli' : 'codex-cli');
    return { model, effort, inferredTarget: resolvedTarget };
  }
  return null;
}

/**
 * Pure parser for optional user `roles.md` markdown table content (`| Role | Model | Target |`).
 * @param {string} markdown
 * @returns {Record<string, {target: string, model: string|null, effort: string|null, lifetime: 'once'|'persistent'}>}
 */
export function parseTeamConfigMarkdown(markdown) {
  const parsed = {};
  const lines = String(markdown ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line.slice(1, -1).split('|').map(cell => cell.trim());
    if (cells.length < 2) continue;
    const [roleCell, modelCell = '', dispatchCell = ''] = cells;
    if (!roleCell || /^(?:role|角色|[-:\s]+)$/i.test(roleCell)) continue;
    const canonicalRole = normalizeRoleKey(roleCell);
    if (!canonicalRole) continue;

    const explicitTarget = extractTarget(dispatchCell, modelCell);
    const modelInfo = extractModelAndEffort(modelCell, explicitTarget);
    const target = explicitTarget ?? modelInfo?.inferredTarget ?? 'codex-cli';
    if (target !== 'codex-cli' && target !== 'claude-cli' && target !== 'agy-cli') continue;
    const lifetime = extractLifetime(dispatchCell);

    const entry = Object.freeze({
      target,
      model: modelInfo?.model ?? null,
      effort: modelInfo?.effort ?? null,
      lifetime,
    });
    parsed[canonicalRole] = entry;
    parsed[canonicalRole.toLowerCase()] = entry;
  }
  return parsed;
}

const fileCache = new Map();

export function clearTeamConfigCache() {
  fileCache.clear();
}

/**
 * Load optional user role presets from `teamConfigPath` with `mtimeMs` + `size` caching.
 * Never mutates user files; returns an empty preset table when no file exists.
 */
export function loadTeamConfigDefaults({ teamConfigPath, env = process.env } = {}) {
  const resolvedPath = path.resolve(
    typeof teamConfigPath === 'string' && teamConfigPath.trim()
      ? teamConfigPath.trim()
      : defaultTeamConfigPath(env),
  );
  try {
    const info = statSync(resolvedPath);
    const cached = fileCache.get(resolvedPath);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return cached.result;
    }
    const content = readFileSync(resolvedPath, 'utf8');
    const parsed = parseTeamConfigMarkdown(content);
    const result = Object.freeze({
      source: 'file',
      path: resolvedPath,
      mtimeMs: info.mtimeMs,
      roles: Object.freeze(parsed),
    });
    fileCache.set(resolvedPath, { mtimeMs: info.mtimeMs, size: info.size, result });
    return result;
  } catch {
    return Object.freeze({
      source: 'fallback',
      path: resolvedPath,
      mtimeMs: null,
      roles: FALLBACK_ROLE_DEFAULTS,
    });
  }
}

/**
 * Resolve `{ target, model, effort, lifetime }` for a role label.
 * When no user preset matches, keeps `model: null` and `effort: null` so the target CLI's
 * own configured default model and reasoning effort are used unchanged.
 */
export function resolveRoleDefaults(role, { teamConfigPath, env = process.env } = {}) {
  const loaded = loadTeamConfigDefaults({ teamConfigPath, env });
  const key = normalizeRoleKey(role);
  const matchedEntry = key ? (loaded.roles[key] ?? loaded.roles[key.toLowerCase()]) : undefined;
  if (matchedEntry) {
    return { ...matchedEntry, roleKey: key, matched: true, source: loaded.source };
  }
  const brandTarget = inferCliBrandTarget(key);
  return {
    target: brandTarget ?? DEFAULT_HEADLESS_FALLBACK.target,
    model: null,
    effort: null,
    lifetime: 'once',
    roleKey: key || null,
    matched: false,
    source: loaded.source,
  };
}
