import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const name = 'dsh-control-discovery';
export const inject = ['connection', 'webServer'];

function dataRootFor(config) {
  const dataRoot = config.dataRoot ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  if (typeof dataRoot !== 'string' || !isAbsolute(dataRoot)) {
    throw new TypeError('DSH dataRoot must be an absolute path.');
  }
  return dataRoot;
}

export async function apply(ctx, config = {}) {
  const dataRoot = dataRootFor(config);
  const directory = join(dataRoot, '.runtime', 'dsh-control', 'instances');
  const filename = join(directory, `${process.pid}.json`);
  const instanceId = randomUUID();
  const temporaryFiles = new Set();

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const launchUrl = await ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`);
  const record = {
    version: 1,
    application: 'dsh',
    pid: process.pid,
    instanceId,
    dataRoot,
    launchUrl,
    startedAt: new Date().toISOString(),
  };
  const temporary = join(directory, `.${process.pid}.${instanceId}.tmp`);
  temporaryFiles.add(temporary);
  try {
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
    await chmod(filename, 0o600);
    temporaryFiles.delete(temporary);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    temporaryFiles.delete(temporary);
    throw error;
  }

  ctx.on('dispose', async () => {
    for (const path of temporaryFiles) await rm(path, { force: true }).catch(() => {});
    try {
      const current = JSON.parse(await readFile(filename, 'utf8'));
      if (current?.instanceId === instanceId) await rm(filename, { force: true });
    } catch {
      // A replaced, removed, or malformed record must never be removed by an older instance.
    }
  });
}
