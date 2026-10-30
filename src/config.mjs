import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const defaultConfigPath = () => path.join(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'futureaide-control', 'config.json');

const configPath = filename => path.resolve(filename || process.env.DSH_CONTROL_CONFIG || process.env.FUTUREAIDE_CONTROL_CONFIG || defaultConfigPath());
const transportFields = ['dataRoot', 'dshDataRoot', 'target', 'baseUrl', 'instanceFile', 'preferredInstanceFile', 'timeoutMs', 'hostBridgeFile'];
const targetFields = ['futureaideSessionId', 'codexThreadId'];
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
export const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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
  return { ...pick(value, [...transportFields, ...targetFields]), workspace: path.resolve(workspace) };
}

async function profileDirectory(filename, { create = false } = {}) {
  const directory = path.join(path.dirname(filename), 'profiles');
  if (create) await mkdir(directory, { recursive: true });
  try {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Profiles directory must be a local directory, not a link.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
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
  const supplied = await readConfiguration(filename, { optional: true });
  if (profile !== undefined) {
    const profileFile = path.join(await profileDirectory(filename), `${profile}.json`);
    try {
      if ((await lstat(profileFile)).isSymbolicLink()) throw new Error('Profile configuration must not be a link.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const selected = validateProfile(await readConfiguration(profileFile));
    return {
      dataRoot: path.join(homedir(), '.futureaide', '.dsh'),
      ...(!supplied.dataRoot && !supplied.instanceFile && !supplied.baseUrl && !selected.dataRoot && !selected.instanceFile && !selected.baseUrl ? { target: 'auto' } : {}),
      hostBridgeFile: path.join(path.dirname(filename), 'host-bridge.json'),
      ...pick(supplied, transportFields),
      ...selected,
      ...(selected.target === undefined && (selected.instanceFile || selected.baseUrl) ? { target: undefined } : {}),
      stateDirectory: path.join(path.dirname(filename), 'state', 'profiles', profile),
      registryDirectory: path.join(path.dirname(filename), 'agents'),
      configFile: filename,
    };
  }
  return {
    dataRoot: path.join(homedir(), '.futureaide', '.dsh'),
    ...(!supplied.dataRoot && !supplied.instanceFile && !supplied.baseUrl ? { target: 'auto' } : {}),
    hostBridgeFile: path.join(path.dirname(filename), 'host-bridge.json'),
    workspace: process.cwd(),
    ...supplied,
    stateDirectory: path.join(path.dirname(filename), 'state'),
    registryDirectory: path.join(path.dirname(filename), 'agents'),
    configFile: filename,
  };
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
  const supplied = await readConfiguration(filename, { optional: true });
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
