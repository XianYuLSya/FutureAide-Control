import { EFFORT_ORDER, FACTORY_MODEL_DEFAULT_EFFORTS } from './model-selection.mjs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { claudeCallbackReminderMs } from './claude-report-reminder.mjs';
import { normalizeProxySpec } from './cli-proxy.mjs';
import { replaceStateFile } from './replace-state-file.mjs';
import { randomBytes } from 'node:crypto';

export const defaultConfigPath = () => path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'futureaide-control', 'config.json');

const configPath = filename => path.resolve(filename || process.env.FUTUREAIDE_CONFIG || process.env.DSH_CONTROL_CONFIG || process.env.FUTUREAIDE_CONTROL_CONFIG || defaultConfigPath());
const transportFields = ['dataRoot', 'dshDataRoot', 'target', 'baseUrl', 'instanceFile', 'preferredInstanceFile', 'timeoutMs', 'hostBridgeFile', 'managedStateDirectory', 'reportPort'];
// Behaviour switches a named profile may set for itself. They are deliberately not
// transport fields: creating a profile copies only the connection, and a profile that
// says nothing inherits the base configuration.
const cleanupDefaults = {
  agentAutoCleanup: true,
  codexAutoCleanup: true,
  onceTerminalRetentionMs: 86400000,
  agentIdleRetentionMs: 43200000,
  diagnosticRetentionMs: 604800000,
  agentCleanupIntervalMs: 900000,
  cleanupGraceMs: 86400000,
};
const cliRouteFields = ['faswitchHome', 'cliRoutes', 'codexCliPath', 'agyCliPath', 'codexCliProxy', 'codexCliProxyPort', 'claudeCliProxy', 'claudeCliProxyPort', 'agyCliProxy', 'agyCliProxyPort', 'antigravityProxy', 'antigravityProxyPort', 'requireProxy', 'autoWakeFaswitch'];
const behaviorFields = ['idleSessionCleanup', 'teamBoard', 'teamConfigPath', 'claudeCallbackReminderMs', 'dshDefaultModelOnly', 'disabledTargets', 'antigravityCallerTokenFile', 'antigravityColdStartMonitor', 'turnTimeoutMinutes', 'turnTimeoutMs', ...cliRouteFields, ...Object.keys(cleanupDefaults), 'defaultEffort', 'modelDefaultEfforts'];

export function normalizeDisabledTargets(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('disabledTargets must be an array of non-empty strings.');
  const normalized = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Error('disabledTargets must be an array of non-empty strings.');
    }
    const item = entry.trim().toLowerCase();
    if (!seen.has(item)) {
      seen.add(item);
      normalized.push(item);
    }
  }
  return normalized;
}

function validateOptionalPath(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string path.`);
  }
  return value.trim();
}

function validateCliRoutes(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('cliRoutes must be an object mapping target names to a port, proxy URL, "direct", or route object.');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key.trim()) throw new Error('cliRoutes contains an empty target key.');
    if (entry !== undefined && entry !== null) normalizeProxySpec(entry);
  }
  return value;
}

function cleanupSettings(base, overrides = {}) {
  const result = { ...cleanupDefaults, ...pick(base, Object.keys(cleanupDefaults)), ...pick(overrides, Object.keys(cleanupDefaults)) };
  for (const [key, value] of Object.entries(result)) {
    if (typeof cleanupDefaults[key] === 'boolean' ? typeof value !== 'boolean' : !(Number.isSafeInteger(value) && value > 0)) {
      return { ...cleanupDefaults, cleanupConfigurationError: key };
    }
  }
  return result;
}
const targetFields = ['futureaideSessionId', 'codexThreadId'];
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function dshConfig(value, filename) {
  if (value.defaultEffort !== undefined && (typeof value.defaultEffort !== 'string' || !EFFORT_ORDER.includes(value.defaultEffort.toLowerCase()))) throw new Error('defaultEffort must be a valid effort.');
  if (value.modelDefaultEfforts !== undefined) {
    if (!value.modelDefaultEfforts || typeof value.modelDefaultEfforts !== 'object' || Array.isArray(value.modelDefaultEfforts)) throw new Error('modelDefaultEfforts must be an object.');
    for (const [key, effort] of Object.entries(value.modelDefaultEfforts)) {
      if (!key.trim()) throw new Error('modelDefaultEfforts contains an empty model key.');
      if (typeof effort !== 'string' || !EFFORT_ORDER.includes(effort.toLowerCase())) throw new Error('modelDefaultEfforts.' + key + ' must be a valid effort.');
    }
  }
  if (value.target !== undefined && value.target !== 'dsh') throw new Error('Only target=dsh is supported. Select the DSH data directory or an explicit DSH instance.');
  if (value.managedStateDirectory !== undefined && (typeof value.managedStateDirectory !== 'string' || !path.isAbsolute(value.managedStateDirectory))) throw new Error('The managed host state path must be absolute.');
  if (value.reportPort !== undefined && (!Number.isInteger(value.reportPort) || value.reportPort < 0 || value.reportPort > 65535)) throw new Error('The loopback report port must be an integer between 0 and 65535.');
  if (value.idleSessionCleanup !== undefined && typeof value.idleSessionCleanup !== 'boolean') throw new Error('idleSessionCleanup must be true or false.');
  if (value.teamBoard !== undefined && typeof value.teamBoard !== 'boolean') throw new Error('teamBoard must be true or false.');
  if (value.dshDefaultModelOnly !== undefined && typeof value.dshDefaultModelOnly !== 'boolean') throw new Error('dshDefaultModelOnly must be true or false.');
  if (value.antigravityColdStartMonitor !== undefined && typeof value.antigravityColdStartMonitor !== 'boolean') throw new Error('antigravityColdStartMonitor must be true or false.');
  if (value.disabledTargets !== undefined) normalizeDisabledTargets(value.disabledTargets);
  const teamConfigPath = validateOptionalPath(value.teamConfigPath, 'teamConfigPath');
  if (value.antigravityCallerTokenFile !== undefined) validateOptionalPath(value.antigravityCallerTokenFile, 'antigravityCallerTokenFile');
  if (value.faswitchHome !== undefined) validateOptionalPath(value.faswitchHome, 'faswitchHome');
  if (value.codexCliPath !== undefined) validateOptionalPath(value.codexCliPath, 'codexCliPath');
  if (value.agyCliPath !== undefined) validateOptionalPath(value.agyCliPath, 'agyCliPath');
  if (value.turnTimeoutMinutes !== undefined && (typeof value.turnTimeoutMinutes !== 'number' || !Number.isFinite(value.turnTimeoutMinutes) || value.turnTimeoutMinutes <= 0)) {
    throw new Error('turnTimeoutMinutes must be a positive finite number.');
  }
  if (value.turnTimeoutMs !== undefined && (typeof value.turnTimeoutMs !== 'number' || !Number.isFinite(value.turnTimeoutMs) || value.turnTimeoutMs <= 0)) {
    throw new Error('turnTimeoutMs must be a positive finite number.');
  }
  if (value.cliRoutes !== undefined) validateCliRoutes(value.cliRoutes);
  if (value.requireProxy !== undefined && typeof value.requireProxy !== 'boolean') throw new Error('requireProxy must be true or false.');
  if (value.autoWakeFaswitch !== undefined && typeof value.autoWakeFaswitch !== 'boolean') throw new Error('autoWakeFaswitch must be true or false.');
  for (const field of ['codexCliProxy', 'codexCliProxyPort', 'claudeCliProxy', 'claudeCliProxyPort', 'agyCliProxy', 'agyCliProxyPort', 'antigravityProxy', 'antigravityProxyPort']) {
    if (value[field] !== undefined) normalizeProxySpec(value[field]);
  }
  // A wait that is not a whole number of milliseconds cannot be scheduled; 0 is allowed
  // and means the first definite absence is enough.
  if (value.claudeCallbackReminderMs !== undefined) claudeCallbackReminderMs(value.claudeCallbackReminderMs);
  const dataRoot = value.dshDataRoot ?? value.dataRoot ?? process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
  return { ...value, target: 'dsh', dataRoot, dshDataRoot: dataRoot,
    ...(teamConfigPath !== undefined ? { teamConfigPath: path.resolve(path.dirname(filename), teamConfigPath) } : {}) };
}

/** Defaults on for unsubscribe, EOF shutdown, cold reads and monitor recovery.
 * Cancelled-round rejection and inbox delivery apply at either setting. */
const idleSessionCleanup = (value, fallback = true) => typeof value === 'boolean' ? value : fallback;
const antigravityColdStartMonitor = (value, fallback = true) => typeof value === 'boolean' ? value : fallback;

/**
 * The team board is a viewer, not a feature of the monitor: it stays off unless the
 * installation asks for it, and off means the listener never registers a board route,
 * never imports the board module and never reads a projection for it.
 */
const teamBoard = (value, fallback = false) => typeof value === 'boolean' ? value : fallback;

/**
 * Off unless the installation asks for it. On, every DSH name runs DSH's own default
 * model and effort: a caller's model and effort are ignored for DSH, and the host
 * bridge installed from this configuration refuses any other session selection.
 */
const dshDefaultModelOnly = (value, fallback = false) => typeof value === 'boolean' ? value : fallback;

function mergeEfforts(...tables) {
  return Object.assign({}, ...tables.filter(Boolean).map(table => Object.fromEntries(Object.entries(table).map(([key, value]) => [key.trim().toLowerCase(), value.toLowerCase()]))));
}

function validateProfileName(profile) {
  if (typeof profile !== 'string' || !PROFILE_NAME_PATTERN.test(profile)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(profile)) {
    throw new Error('Profile names must contain 1-64 lowercase letters, digits, underscores, or hyphens, start with a letter or digit, and not be a reserved device name.');
  }
  return profile;
}

function pick(source, fields) {
  return Object.fromEntries(fields.filter(field => source[field] !== undefined).map(field => [field, source[field]]));
}

async function readConfiguration(filename, { optional = false } = {}) {
  let content;
  try {
    content = await readFile(filename, 'utf8');
  } catch (error) {
    if (optional && error.code === 'ENOENT') return {};
    if (error.code === 'ENOENT') throw new Error('FutureAide profile does not exist.');
    throw new Error('Cannot read FutureAide control configuration.');
  }
  try {
    const value = JSON.parse(content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
    return value;
  } catch {
    throw new Error('Cannot parse FutureAide control configuration.');
  }
}

function validateProfile(value) {
  const workspace = value.workspace;
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)
    || (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(workspace))) {
    throw new Error('Profile workspace must be a fully qualified absolute path.');
  }
  if (value.futureaideSessionId !== undefined && (typeof value.futureaideSessionId !== 'string'
    || !value.futureaideSessionId.trim() || value.futureaideSessionId.length > 200)) {
    throw new Error('FutureAide session ID must contain 1-200 characters.');
  }
  if (value.codexThreadId !== undefined && (typeof value.codexThreadId !== 'string' || !UUID.test(value.codexThreadId))) {
    throw new Error('Configure a valid target Codex task ID.');
  }
  return { ...pick(value, [...transportFields, ...targetFields, ...behaviorFields]), workspace: path.resolve(workspace) };
}

async function profileDirectory(filename, { create = false } = {}) {
  const directory = path.join(path.dirname(filename), 'profiles');
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return directory;
    await mkdir(directory, { recursive: true });
    metadata = await lstat(directory);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Profiles directory must be a local directory, not a link.');
  return directory;
}

/**
 * Load the default connection or a named profile without changing either selection.
 * @param {string} [filename] Base configuration path; defaults to the configured Codex location.
 * @param {string} [profile] Named connection; omission retains the original default.
 * @returns {Promise<object>} Connection settings with an isolated receipt directory.
 */
export async function loadConfig(filename, profile) {
  filename = configPath(filename);
  if (profile !== undefined) validateProfileName(profile);
  const supplied = dshConfig(await readConfiguration(filename, { optional: true }), filename);
  const envCallerTokenFile = typeof process.env.FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE === 'string' && process.env.FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE.trim()
    ? process.env.FUTUREAIDE_ANTIGRAVITY_CALLER_TOKEN_FILE.trim() : undefined;
  if (profile !== undefined) {
    const profileFile = path.join(await profileDirectory(filename), `${profile}.json`);
    try {
      if ((await lstat(profileFile)).isSymbolicLink()) throw new Error('Profile configuration must not be a link.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const selectedValue = validateProfile(await readConfiguration(profileFile));
    const selected = dshConfig({ ...selectedValue,
      dshDataRoot: selectedValue.dshDataRoot ?? selectedValue.dataRoot ?? supplied.dshDataRoot }, profileFile);
    const antigravityCallerTokenFile = envCallerTokenFile
      ?? validateOptionalPath(selected.antigravityCallerTokenFile ?? supplied.antigravityCallerTokenFile, 'antigravityCallerTokenFile');
    const mergedCliRoutes = (supplied.cliRoutes || selected.cliRoutes)
      ? { ...(supplied.cliRoutes ?? {}), ...(selected.cliRoutes ?? {}) } : undefined;
    return {
      hostBridgeFile: path.join(path.dirname(filename), 'host-bridge.json'),
      ...pick(supplied, [...transportFields, ...cliRouteFields, 'teamConfigPath']),
      ...selected,
      ...(mergedCliRoutes ? { cliRoutes: mergedCliRoutes } : {}),
      ...cleanupSettings(supplied, selectedValue), profile,
      // A selected profile overrides the base value it inherits; the switch is on by
      // default so an older configuration keeps releasing.
      idleSessionCleanup: idleSessionCleanup(selected.idleSessionCleanup, idleSessionCleanup(supplied.idleSessionCleanup)),
      teamBoard: teamBoard(selected.teamBoard, teamBoard(supplied.teamBoard)),
      claudeCallbackReminderMs: claudeCallbackReminderMs(selected.claudeCallbackReminderMs,
        claudeCallbackReminderMs(supplied.claudeCallbackReminderMs)),
      dshDefaultModelOnly: dshDefaultModelOnly(selected.dshDefaultModelOnly, dshDefaultModelOnly(supplied.dshDefaultModelOnly)),
      disabledTargets: normalizeDisabledTargets(selected.disabledTargets ?? supplied.disabledTargets),
      antigravityColdStartMonitor: antigravityColdStartMonitor(selected.antigravityColdStartMonitor,
        antigravityColdStartMonitor(supplied.antigravityColdStartMonitor)),
      ...(antigravityCallerTokenFile !== undefined ? { antigravityCallerTokenFile } : {}),
      defaultEffort: selected.defaultEffort ?? supplied.defaultEffort ?? 'max',
      modelDefaultEfforts: mergeEfforts(FACTORY_MODEL_DEFAULT_EFFORTS, supplied.modelDefaultEfforts, selected.modelDefaultEfforts),
      stateDirectory: path.join(path.dirname(filename), 'state', 'profiles', profile),
      registryDirectory: path.join(path.dirname(filename), 'agents'),
      configFile: filename,
    };
  }
  const antigravityCallerTokenFile = envCallerTokenFile
    ?? validateOptionalPath(supplied.antigravityCallerTokenFile, 'antigravityCallerTokenFile');
  return {
    hostBridgeFile: path.join(path.dirname(filename), 'host-bridge.json'),
    workspace: process.cwd(),
    ...supplied,
    ...cleanupSettings(supplied), profile: null,
    idleSessionCleanup: idleSessionCleanup(supplied.idleSessionCleanup),
    teamBoard: teamBoard(supplied.teamBoard),
    claudeCallbackReminderMs: claudeCallbackReminderMs(supplied.claudeCallbackReminderMs),
    dshDefaultModelOnly: dshDefaultModelOnly(supplied.dshDefaultModelOnly),
    disabledTargets: normalizeDisabledTargets(supplied.disabledTargets),
    antigravityColdStartMonitor: antigravityColdStartMonitor(supplied.antigravityColdStartMonitor),
    ...(antigravityCallerTokenFile !== undefined ? { antigravityCallerTokenFile } : {}),
    defaultEffort: supplied.defaultEffort ?? 'max',
    modelDefaultEfforts: mergeEfforts(FACTORY_MODEL_DEFAULT_EFFORTS, supplied.modelDefaultEfforts),
    stateDirectory: path.join(path.dirname(filename), 'state'),
    registryDirectory: path.join(path.dirname(filename), 'agents'),
    configFile: filename,
  };
}

/** A managed launch binds the connection to the roster chosen by its parent. */
export async function loadManagedRosterConfig(filename, roster) {
  const base = await loadConfig(filename);
  if (!roster || !path.isAbsolute(roster)) return base;
  const stateDirectory = path.dirname(path.resolve(roster));
  const [group, profile, ...rest] = path.relative(base.stateDirectory, stateDirectory).split(path.sep);
  if (group?.toLowerCase() === 'profiles' && profile && !rest.length) return loadConfig(filename, profile);
  return base;
}

function profileSummary(config, profile = null) {
  return {
    profile, workspace: config.workspace,
    futureaideSessionId: config.futureaideSessionId || null,
    codexThreadId: config.codexThreadId || null,
    callbacksConfigured: UUID.test(config.codexThreadId || ''),
  };
}

/**
 * List connection targets only; transport configuration and credentials are omitted.
 * @param {string} [filename] Base configuration path.
 * @param {string} [profile] Optional exact profile filter.
 * @returns {Promise<object>} Named targets, plus the default target when unfiltered.
 */
export async function listProfiles(filename, profile) {
  filename = configPath(filename);
  if (profile !== undefined) return { items: [profileSummary(await loadConfig(filename, profile), profile)] };
  let entries = [];
  try {
    entries = await readdir(await profileDirectory(filename), { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const names = entries.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name.slice(0, -5)).filter(name => PROFILE_NAME_PATTERN.test(name)).sort();
  const items = [];
  for (const name of names) items.push(profileSummary(await loadConfig(filename, name), name));
  return { defaultProfile: profileSummary(await loadConfig(filename)), items };
}

/**
 * Create a named connection exclusively, inheriting shared transport fields but no task targets.
 * @param {object} input Profile name, absolute workspace, and optional explicit task targets.
 * @param {string} [filename] Base configuration path.
 * @returns {Promise<object>} Created profile target metadata without transport details.
 */
export async function createProfile({ profile, workspace, futureaideSessionId, codexThreadId }, filename) {
  validateProfileName(profile);
  filename = configPath(filename);
  const selected = validateProfile({ workspace, futureaideSessionId, codexThreadId });
  const supplied = dshConfig(await readConfiguration(filename, { optional: true }), filename);
  const value = { ...pick(supplied, transportFields), ...selected };
  const profileFile = path.join(await profileDirectory(filename, { create: true }), `${profile}.json`);
  try {
    await writeFile(profileFile, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('FutureAide profile already exists. Choose a new profile name.');
    throw error;
  }
  return { created: true, ...profileSummary(value, profile) };
}

export function requireWorkspace(candidate, workspace) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  const relative = path.relative(path.resolve(workspace), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

const LEGACY_PROXY_KEYS = {
  'codex-cli': ['codexCliProxy', 'codexCliProxyPort'],
  'claude-cli': ['claudeCliProxy', 'claudeCliProxyPort'],
  'agy-cli': ['agyCliProxy', 'agyCliProxyPort'],
  antigravity: ['antigravityProxy', 'antigravityProxyPort'],
};

/**
 * Atomically persist CLI route bindings into `config.configFile` and synchronize
 * the in-memory `config` object. Passing `resetToFaswitch: true` removes manual
 * overrides so resolution resumes following FAswitch automatically.
 */
export async function updateCliRoutes(config, { targets = [], value, resetToFaswitch = false } = {}) {
  const filename = configPath(config?.configFile);
  const raw = await readConfiguration(filename, { optional: true });
  const nextRoutes = raw.cliRoutes && typeof raw.cliRoutes === 'object' && !Array.isArray(raw.cliRoutes)
    ? { ...raw.cliRoutes }
    : {};
  for (const target of targets) {
    if (resetToFaswitch) {
      delete nextRoutes[target];
      for (const legacyKey of LEGACY_PROXY_KEYS[target] ?? []) {
        delete raw[legacyKey];
        if (config && typeof config === 'object') delete config[legacyKey];
      }
    } else {
      normalizeProxySpec(value);
      nextRoutes[target] = value;
      for (const legacyKey of LEGACY_PROXY_KEYS[target] ?? []) {
        delete raw[legacyKey];
        if (config && typeof config === 'object') delete config[legacyKey];
      }
    }
  }
  if (Object.keys(nextRoutes).length > 0) {
    raw.cliRoutes = nextRoutes;
  } else {
    delete raw.cliRoutes;
  }
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  await replaceStateFile(temp, filename);
  if (config && typeof config === 'object') {
    if (Object.keys(nextRoutes).length > 0) config.cliRoutes = { ...nextRoutes };
    else delete config.cliRoutes;
  }
  return nextRoutes;
}
