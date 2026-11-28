// Read-only parser and mtimeMs-cached resolver for `~/.config/work-workflow/团队配置.md`.
// Maps human role labels (such as "后端", "前端", "团队长", "秘书", "调查员", "审查员", "设计师", "规划师")
// to { target, model, effort, lifetime } defaults without mutating any user configuration.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function defaultTeamConfigPath(env = process.env) {
  if (typeof env?.WORK_WORKFLOW_TEAM_CONFIG === 'string' && env.WORK_WORKFLOW_TEAM_CONFIG.trim()) {
    return path.resolve(env.WORK_WORKFLOW_TEAM_CONFIG.trim());
  }
  return path.join(homedir(), '.config', 'work-workflow', '团队配置.md');
}

export const FALLBACK_ROLE_DEFAULTS = Object.freeze({
  主策: Object.freeze({ target: 'codex-cli', model: 'gpt-6.2-sol', effort: 'high', lifetime: 'once' }),
  审查官: Object.freeze({ target: 'agy-cli', model: 'gemini-4-neon-high', effort: 'high', lifetime: 'once' }),
  执行师: Object.freeze({ target: 'codex-cli', model: 'gpt-6.1-terra', effort: 'high', lifetime: 'once' }),
  外置大脑: Object.freeze({ target: 'agy-cli', model: 'gemini-4-neon-high', effort: 'high', lifetime: 'once' }),
  秘书: Object.freeze({ target: 'codex-cli', model: 'gpt-6.2-sol', effort: 'high', lifetime: 'persistent' }),
  '秘书：改条文': Object.freeze({ target: 'claude-cli', model: 'claude-opus-5-5', effort: 'max', lifetime: 'once' }),
  团队长: Object.freeze({ target: 'codex-cli', model: 'gpt-6.2-sol', effort: 'high', lifetime: 'once' }),
  规划师: Object.freeze({ target: 'codex-cli', model: 'gpt-6.2-sol', effort: 'high', lifetime: 'once' }),
  设计师: Object.freeze({ target: 'claude-cli', model: 'claude-opus-5-5', effort: 'max', lifetime: 'once' }),
  前端工程师: Object.freeze({ target: 'claude-cli', model: 'claude-opus-5-5', effort: 'max', lifetime: 'once' }),
  后端工程师: Object.freeze({ target: 'codex-cli', model: 'gpt-6.1-terra', effort: 'high', lifetime: 'once' }),
  独立审查员: Object.freeze({ target: 'codex-cli', model: 'gpt-6.2-sol', effort: 'high', lifetime: 'once' }),
  调查员: Object.freeze({ target: 'codex-cli', model: 'gpt-6.1-terra', effort: 'high', lifetime: 'once' }),
  产品经理: Object.freeze({ target: 'codex-cli', model: 'gpt-6.1-terra', effort: 'high', lifetime: 'once' }),
});

export const DEFAULT_HEADLESS_FALLBACK = Object.freeze({
  target: 'codex-cli',
  model: 'gpt-6.1-terra',
  effort: 'high',
  lifetime: 'once',
});

const ROLE_ALIASES = Object.freeze({
  主策: '主策',
  '主策/领队': '主策',
  '主策 / 领队': '主策',
  主策领队: '主策',
  领队: '主策',
  策划: '主策',
  策划师: '主策',
  架构师: '主策',
  'planner-lead': '主策',
  执行: '执行师',
  执行师: '执行师',
  builder: '执行师',
  前端执行师: '前端工程师',
  后端执行师: '后端工程师',
  审查官: '审查官',
  探子: '调查员',
  scout: '调查员',
  秘书: '秘书',
  secretary: '秘书',
  '秘书：改条文': '秘书：改条文',
  '秘书:改条文': '秘书：改条文',
  团队长: '团队长',
  组长: '团队长',
  'team-lead': '团队长',
  lead: '团队长',
  规划: '规划师',
  规划师: '规划师',
  planner: '规划师',
  设计: '设计师',
  设计师: '设计师',
  designer: '设计师',
  前端: '前端工程师',
  前端工程师: '前端工程师',
  frontend: '前端工程师',
  'frontend-engineer': '前端工程师',
  后端: '后端工程师',
  后端工程师: '后端工程师',
  backend: '后端工程师',
  'backend-engineer': '后端工程师',
  审查: '独立审查员',
  审查员: '独立审查员',
  独立审查员: '独立审查员',
  reviewer: '独立审查员',
  调查: '调查员',
  调研: '调查员',
  调查员: '调查员',
  红队: '调查员',
  researcher: '调查员',
  产品: '产品经理',
  产品经理: '产品经理',
  pm: '产品经理',
  'product-manager': '产品经理',
  外置大脑: '外置大脑',
  'external-brain': '外置大脑',
  antigravity: '外置大脑',
  agy: '外置大脑',
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
    .replace(/:/g, '：')
    .trim();
  if (!cleaned) return '';
  const withoutTrailingDigits = cleaned.replace(/-?\d+$/u, '').trim() || cleaned;
  const lower = withoutTrailingDigits.toLowerCase();
  return ROLE_ALIASES[withoutTrailingDigits] ?? ROLE_ALIASES[lower] ?? withoutTrailingDigits;
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

function extractLifetime(dispatchCell, canonicalRole) {
  const dispatch = String(dispatchCell ?? '');
  if (/\bpersistent\b/i.test(dispatch)) return 'persistent';
  if (/\bonce\b/i.test(dispatch)) return 'once';
  if (canonicalRole === '秘书') return 'persistent';
  return 'once';
}

function extractModelAndEffort(modelCell, target) {
  const stripped = stripParenthetical(String(modelCell ?? '').replace(/`/g, ''));
  const clauses = stripped.split(/[；;]/).map(part => part.trim()).filter(Boolean);
  for (const clause of clauses) {
    let model = null;
    const slugMatch = /\b((?:gpt|claude|gemini)-[a-z0-9][a-z0-9.-]*)\b/i.exec(clause);
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
    if (!effort) {
      effort = resolvedTarget === 'claude-cli' ? 'max' : 'high';
    }
    return { model, effort, inferredTarget: resolvedTarget };
  }
  return null;
}

/**
 * Pure parser for `团队配置.md` markdown table content.
 * @param {string} markdown
 * @returns {Record<string, {target: string, model: string, effort: string, lifetime: 'once'|'persistent'}>}
 */
export function parseTeamConfigMarkdown(markdown) {
  const parsed = {};
  const lines = String(markdown ?? '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const cells = line.slice(1, -1).split('|').map(cell => cell.trim());
    if (cells.length < 3) continue;
    const [roleCell, modelCell, dispatchCell] = cells;
    if (!roleCell || roleCell === '角色' || /^[-:\s]+$/.test(roleCell)) continue;
    const canonicalRole = normalizeRoleKey(roleCell);
    if (!canonicalRole || canonicalRole === 'Boss') continue;

    const explicitTarget = extractTarget(dispatchCell, canonicalRole === '外置大脑' ? modelCell : '');
    const modelInfo = extractModelAndEffort(modelCell, explicitTarget);
    if (!modelInfo) continue;
    const target = explicitTarget ?? modelInfo.inferredTarget;
    if (target !== 'codex-cli' && target !== 'claude-cli' && target !== 'agy-cli') continue;
    const lifetime = extractLifetime(dispatchCell, canonicalRole);

    const entry = Object.freeze({
      target,
      model: modelInfo.model,
      effort: modelInfo.effort,
      lifetime,
    });
    parsed[canonicalRole] = entry;
    const rawTrimmed = stripParenthetical(roleCell).replace(/`/g, '').trim();
    if (rawTrimmed && !parsed[rawTrimmed]) parsed[rawTrimmed] = entry;
  }
  return parsed;
}

const fileCache = new Map();

export function clearTeamConfigCache() {
  fileCache.clear();
}

/**
 * Load role defaults from `teamConfigPath` with `mtimeMs` + `size` hot caching.
 * Never writes or modifies the file; falls back cleanly to `FALLBACK_ROLE_DEFAULTS` when absent.
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
    const roles = { ...FALLBACK_ROLE_DEFAULTS, ...parsed };
    const result = Object.freeze({
      source: 'file',
      path: resolvedPath,
      mtimeMs: info.mtimeMs,
      roles: Object.freeze(roles),
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
 * Resolve `{ target, model, effort, lifetime }` for a role label (or headless fallback).
 */
export function resolveRoleDefaults(role, { teamConfigPath, env = process.env } = {}) {
  const loaded = loadTeamConfigDefaults({ teamConfigPath, env });
  const key = normalizeRoleKey(role);
  if (key && loaded.roles[key]) {
    return { ...loaded.roles[key], roleKey: key, matched: true, source: loaded.source };
  }
  const fallback = loaded.roles.后端工程师 ?? DEFAULT_HEADLESS_FALLBACK;
  return {
    target: fallback.target ?? DEFAULT_HEADLESS_FALLBACK.target,
    model: fallback.model ?? DEFAULT_HEADLESS_FALLBACK.model,
    effort: fallback.effort ?? DEFAULT_HEADLESS_FALLBACK.effort,
    lifetime: 'once',
    roleKey: key || null,
    matched: false,
    source: loaded.source,
  };
}
