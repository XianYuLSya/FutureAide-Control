// Optional user-owned role preset resolver (`~/.config/futureaide-control/roles.md`
// or `FUTUREAIDE_ROLES_CONFIG`) and generic managed-CLI privilege classifier.
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

const LEAD_ROLE_LABELS = new Set([
  'lead', 'team-lead', 'tech-lead', 'planner-lead', 'coordinator', 'manager',
  '团队长', '组长', '负责人', '领队',
]);

const REVIEW_ROLE_LABELS = new Set([
  'reviewer', 'code-reviewer', 'auditor',
  '审查', '审查员', '独立审查员', '审核员',
]);

const SCOUT_ROLE_LABELS = new Set([
  'scout', 'researcher', 'investigator',
  '调查', '调研', '调查员', '调研员',
]);

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const isAgyModelId = model => model.startsWith('gemini-4-') || model.startsWith('gemini-3.8-');

function stripParenthetical(value) {
  let text = String(value ?? '');
  let prev;
  do {
    prev = text;
    text = text.replace(/（[^（）]*）|\([^()]*\)/g, ' ');
  } while (text !== prev);
  return text.replace(/\s+/g, ' ').trim();
}

export function normalizeRoleKey(rawRole) {
  if (typeof rawRole !== 'string') return '';
  const cleaned = stripParenthetical(rawRole)
    .replace(/`/g, '')
    .trim();
  if (!cleaned) return '';
  return cleaned.replace(/-?\d+$/u, '').trim() || cleaned;
}

function normalizeCompositeForm(rawRole) {
  return stripParenthetical(String(rawRole ?? '').replace(/`/g, ''))
    .split('/')
    .map(part => part.trim())
    .join('/');
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
  const unsupportedCli = /\b[a-z][a-z0-9-]*-cli\b/i.exec(dispatch);
  if (unsupportedCli) return unsupportedCli[0].toLowerCase();
  const modelText = String(primaryModelClause ?? '');
  if (/\b(?:antigravity|agy)\b/i.test(modelText)) return 'agy-cli';
  if (/\bgemini\b/i.test(modelText) && /\b(?:neon|carbon|argon|hydrogen)\b/i.test(modelText)) return 'agy-cli';
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
    } else if (/\bgemini\s+neon\b|\bneon\b/i.test(clause)) {
      model = 'gemini-4-neon-high';
    } else if (/\bgemini\s+carbon\b|\bcarbon\b/i.test(clause)) {
      model = 'gemini-4-carbon-high';
    } else {
      const claudeHuman = /\bclaude\s+(opus|sonnet|haiku|fable)\s+([0-9]+(?:\.[0-9]+)*)\b/i.exec(clause);
      if (claudeHuman) {
        model = `claude-${claudeHuman[1].toLowerCase()}-${claudeHuman[2].replace(/\./g, '-')}`;
      }
    }
    if (!model) continue;
    if (!target && model.startsWith('gemini-') && !isAgyModelId(model)) continue;

    let effort = null;
    const tokens = clause.split(/[,，\s/]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
    for (const token of tokens) {
      if (VALID_EFFORTS.has(token)) {
        effort = token;
        break;
      }
    }
    const resolvedTarget = target
      ?? (isAgyModelId(model)
        ? 'agy-cli'
        : model.startsWith('claude-') ? 'claude-cli' : 'codex-cli');
    return { model, effort, inferredTarget: resolvedTarget };
  }
  return null;
}

/**
 * Pure parser for optional user `roles.md` markdown table (`| Role | Model | Target |`).
 * Supports composite `Primary / Alias` role headers declared in the table.
 */
export function parseTeamConfigMarkdown(markdown, { includeAliases = false } = {}) {
  const parsed = {};
  const aliases = {};
  const lines = String(markdown ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line.slice(1, -1).split('|').map(cell => cell.trim());
    if (cells.length < 2) continue;
    const [roleCell, modelCell = '', dispatchCell = ''] = cells;
    if (!roleCell || /^(?:role|角色|[-:\s]+)$/i.test(roleCell)) continue;

    const rawSegments = stripParenthetical(roleCell.replace(/`/g, '')).split('/').map(s => s.trim());
    if (rawSegments.some(s => !s || /[\x00-\x1f\x7f]/.test(s))) continue;
    const canonicalRole = normalizeRoleKey(rawSegments[0]);
    if (!canonicalRole || canonicalRole.toLowerCase() === 'boss' || canonicalRole.toLowerCase() === 'root') continue;

    const explicitTarget = extractTarget(dispatchCell, modelCell);
    const modelInfo = extractModelAndEffort(modelCell, explicitTarget);
    const target = explicitTarget ?? modelInfo?.inferredTarget ?? 'codex-cli';
    if (!['codex-cli', 'claude-cli', 'agy-cli'].includes(target)) continue;
    const lifetime = extractLifetime(dispatchCell);

    const entry = Object.freeze({
      target,
      model: modelInfo?.model ?? null,
      ...(modelInfo?.effort ? { effort: modelInfo.effort } : {}),
      lifetime,
      ...(rawSegments.length > 1 ? { declaredNames: Object.freeze(rawSegments) } : {}),
    });
    parsed[canonicalRole] = entry;
    aliases[canonicalRole] = canonicalRole;
    aliases[canonicalRole.toLowerCase()] = canonicalRole;
    if (rawSegments.length > 1) {
      const compositeKey = rawSegments.join('/');
      aliases[compositeKey] = canonicalRole;
      aliases[compositeKey.toLowerCase()] = canonicalRole;
      for (const seg of rawSegments.slice(1)) {
        const segKey = normalizeRoleKey(seg);
        if (segKey && segKey.toLowerCase() !== 'boss' && segKey.toLowerCase() !== 'root') {
          aliases[segKey] = canonicalRole;
          aliases[segKey.toLowerCase()] = canonicalRole;
        }
      }
    }
  }
  return includeAliases ? { roles: parsed, aliases } : parsed;
}

const fileCache = new Map();

export function clearTeamConfigCache() {
  fileCache.clear();
}

/**
 * Load optional user role presets from `teamConfigPath` with `mtimeMs` + `size` caching.
 * Returns an empty fallback table when `ENOENT`; throws `invalid-team-config` when a
 * present file is unreadable or contains zero valid dispatch roles.
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
    const { roles, aliases } = parseTeamConfigMarkdown(content, { includeAliases: true });
    if (!Object.keys(roles).length) {
      throw Object.assign(new Error('Role configuration has no valid dispatch roles.'), { code: 'invalid-team-config' });
    }
    const result = Object.freeze({
      source: 'file',
      path: resolvedPath,
      mtimeMs: info.mtimeMs,
      roles: Object.freeze(roles),
      aliases: Object.freeze(aliases),
    });
    fileCache.set(resolvedPath, { mtimeMs: info.mtimeMs, size: info.size, result });
    return result;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw Object.assign(new Error('Role configuration is unreadable or has no valid dispatch roles.'), { code: 'invalid-team-config' });
    }
    return Object.freeze({
      source: 'fallback',
      path: resolvedPath,
      mtimeMs: null,
      roles: FALLBACK_ROLE_DEFAULTS,
      aliases: Object.freeze({}),
    });
  }
}

/**
 * Resolve `{ target, model, effort, lifetime, roleKey, matched, source }` for a role label.
 * When no user preset file exists, keeps `model: null` and `effort: null` so the target
 * CLI's own configured default model and reasoning effort are used unchanged.
 */
export function resolveRoleDefaults(role, { teamConfigPath, env = process.env } = {}) {
  const loaded = loadTeamConfigDefaults({ teamConfigPath, env });
  const composite = typeof role === 'string' && role.includes('/') ? normalizeCompositeForm(role) : '';
  const rawKey = composite || normalizeRoleKey(role);
  let canonical = loaded.aliases?.[rawKey] ?? loaded.aliases?.[rawKey.toLowerCase()] ?? normalizeRoleKey(role);
  if (loaded.source === 'file' && rawKey && !Object.hasOwn(loaded.roles, canonical)) {
    const prefix = rawKey.toLowerCase();
    const matches = Object.entries(loaded.roles).filter(([key, preset]) =>
      [key, ...(preset.declaredNames ?? [])].some(name => normalizeRoleKey(name).toLowerCase().startsWith(prefix)));
    if (matches.length === 1) canonical = matches[0][0];
  }
  if (canonical && Object.hasOwn(loaded.roles, canonical)) {
    return {
      effort: null,
      ...loaded.roles[canonical],
      roleKey: canonical,
      matched: true,
      source: loaded.source,
    };
  }
  const brandTarget = inferCliBrandTarget(canonical);
  return {
    target: brandTarget ?? DEFAULT_HEADLESS_FALLBACK.target,
    model: null,
    effort: null,
    lifetime: 'once',
    roleKey: canonical || null,
    matched: false,
    source: loaded.source,
  };
}

/**
 * Classify a role label into `'lead' | 'review' | 'scout' | 'base'` using generic
 * team-role labels (honoring active `roles.md` membership when present).
 */
export function classifyManagedRole(role, { teamConfigPath, env = process.env, allowUnlisted = false } = {}) {
  let resolved;
  try {
    resolved = resolveRoleDefaults(role, { teamConfigPath, env });
  } catch {
    if (!allowUnlisted) return 'base';
    resolved = {};
  }
  if (!allowUnlisted && resolved.source === 'file' && !resolved.matched) return 'base';
  const candidates = [
    resolved.roleKey,
    ...(resolved.declaredNames ?? []).map(normalizeRoleKey),
    normalizeRoleKey(role),
    ...(typeof role === 'string' && role.includes('/') ? role.split('/').map(s => normalizeRoleKey(s)) : []),
  ].filter(Boolean);
  for (const item of candidates) {
    const lower = item.toLowerCase();
    if (LEAD_ROLE_LABELS.has(lower)) return 'lead';
    if (REVIEW_ROLE_LABELS.has(lower) || /^(?:审查|审核)/u.test(item)) return 'review';
    if (SCOUT_ROLE_LABELS.has(lower) || /^(?:调查|调研)/u.test(item)) return 'scout';
    if (/(?:团队长|组长|领队|负责人)/u.test(item)) return 'lead';
  }
  return 'base';
}
