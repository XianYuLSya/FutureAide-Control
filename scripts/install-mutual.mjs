import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { resolveFaSwitchBinding } from '../src/runtime-environment.mjs';

async function optionalJson(filename) {
  try { return JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

function quotePath(value) {
  const text = path.resolve(value).replaceAll('\\', '/');
  if (/["`$\r\n]/.test(text)) throw new Error('This hook path contains unsupported shell characters.');
  return `"${text}"`;
}

/** Register only this plugin's Code MCP entry and identity hook in the selected profile. */
export async function installClaudeCaller({ configFile, project, sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url))) }) {
  const config = await loadConfig(configFile);
  const binding = await resolveFaSwitchBinding(config);
  const savedConfig = await optionalJson(config.configFile);
  savedConfig.faSwitchRoot = binding.faSwitchRoot;
  savedConfig.codexProfileHome ??= binding.codexAuthHome;
  await writeFile(config.configFile, JSON.stringify(savedConfig, null, 2) + '\n', { mode: 0o600 });
  const codeConfig = path.join(binding.faSwitchRoot, 'client-state', 'claude', binding.kind, binding.profileId, 'claude-config');
  await mkdir(codeConfig, { recursive: true });
  const entry = path.join(sourceRoot, 'src', 'mutual-server.mjs');
  await lstat(entry);
  const mcpFile = path.join(codeConfig, '.claude.json');
  const settingsFile = path.join(codeConfig, 'settings.json');
  for (const filename of [mcpFile, settingsFile]) {
    try { if ((await lstat(filename)).isSymbolicLink()) throw new Error('Account settings must not be shared through a link.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const nativeConfig = await optionalJson(mcpFile);
  const settings = await optionalJson(settingsFile);
  const server = { type: 'stdio', command: process.execPath, args: [entry, '--config', config.configFile],
    env: { FUTUREAIDE_CONTROL_CONFIG: config.configFile, FUTUREAIDE_PROFILE_ID: binding.profileId } };
  nativeConfig.mcpServers ??= {};
  nativeConfig.mcpServers.futureaide = server;
  const isOldEntry = value => (value?.args ?? []).some(arg => typeof arg === 'string'
    && /futureaide-control[\\/].*src[\\/](?:mcp|mutual)-server\.mjs$/i.test(arg));
  if (isOldEntry(nativeConfig.mcpServers['futureaide-control'])) delete nativeConfig.mcpServers['futureaide-control'];
  settings.env ??= {};
  settings.env.FUTUREAIDE_PROFILE_ID = binding.profileId;
  // Keep a host_receive call pending in the initial model turn. This is a
  // non-network Claude Code setting; it is applied to the profile settings and
  // takes effect on the next Code session.
  settings.env.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS ??= '0';
  settings.permissions ??= {};
  settings.permissions.allow = [...new Set([...(settings.permissions.allow ?? []), 'mcp__futureaide__*'])];
  settings.hooks ??= {};
  const entries = settings.hooks.SessionStart ?? [];
  const ownHook = hook => typeof hook.command === 'string' && hook.command.includes('mutual-server.mjs') && hook.command.includes('--register-claude-context');
  const preserved = entries.map(entry => ({ ...entry, hooks: (entry.hooks ?? []).filter(hook => !ownHook(hook)) })).filter(entry => entry.hooks.length);
  preserved.push({ matcher: '', hooks: [{ type: 'command', command: `${quotePath(process.execPath)} ${quotePath(entry)} --register-claude-context --config ${quotePath(config.configFile)}`, timeout: 15 }] });
  settings.hooks.SessionStart = preserved;
  await writeFile(mcpFile, JSON.stringify(nativeConfig, null, 2) + '\n', { mode: 0o600 });
  await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  const skillRoot = path.join(codeConfig, 'skills', 'futureaide-control');
  await mkdir(path.join(skillRoot, 'references'), { recursive: true });
  await copyFile(path.join(sourceRoot, 'skills', 'futureaide-control', 'SKILL.md'), path.join(skillRoot, 'SKILL.md'));
  await copyFile(path.join(sourceRoot, 'skills', 'futureaide-control', 'references', 'legacy-workflows.md'), path.join(skillRoot, 'references', 'legacy-workflows.md'));
  // Remove only the superseded registration, preserving the project file and
  // every unrelated MCP server. The account-scoped entry now owns this plugin.
  if (project) {
    const projectFile = path.join(path.resolve(project), '.mcp.json');
    const projectConfig = await optionalJson(projectFile);
    if (isOldEntry(projectConfig.mcpServers?.['futureaide-control'])) {
      delete projectConfig.mcpServers['futureaide-control'];
      await writeFile(projectFile, JSON.stringify(projectConfig, null, 2) + '\n');
    }
  }
  return { installed: true, profile: binding.name, mcpFile, settingsFile,
    nextSession: 'Open or continue the existing Claude Code session once; call host_register, then host_receive. No login and no per-task UI click are needed.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf('--config');
  const projectIndex = process.argv.indexOf('--project');
  console.log(JSON.stringify(await installClaudeCaller({ configFile: index >= 0 ? process.argv[index + 1] : undefined,
    project: projectIndex >= 0 ? process.argv[projectIndex + 1] : undefined }), null, 2));
}
