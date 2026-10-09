import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply, inject, name } from '../dsh-plugin/index.mjs';

function context(launchUrl) {
  const handlers = [];
  return {
    connection: { authenticatedUrl: async origin => {
      assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      return launchUrl;
    } },
    webServer: { port: 43891 },
    on(event, handler) {
      assert.equal(event, 'dispose');
      handlers.push(handler);
    },
    async dispose() { await Promise.all(handlers.map(handler => handler())); },
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('registers an authenticated DSH instance privately and cleans it on disposal', async t => {
  const root = await fixture(t);
  const token = 'private-launch-token';
  const logs = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...values) => logs.push(values.join(' '));
  console.warn = (...values) => logs.push(values.join(' '));
  console.error = (...values) => logs.push(values.join(' '));
  const ctx = context(`http://127.0.0.1:43891/?token=${token}`);
  try {
    await apply(ctx, { dataRoot: root });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  const directory = path.join(root, '.runtime', 'dsh-control', 'instances');
  const filename = path.join(directory, `${process.pid}.json`);
  const record = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(name, 'dsh-control-discovery');
  assert.deepEqual(inject, ['connection', 'webServer']);
  assert.deepEqual(Object.keys(record).sort(), ['application', 'dataRoot', 'instanceId', 'launchUrl', 'pid', 'startedAt', 'version']);
  assert.equal(record.application, 'dsh');
  assert.equal(record.dataRoot, root);
  assert.equal(record.launchUrl, `http://127.0.0.1:43891/?token=${token}`);
  assert.equal(record.pid, process.pid);
  assert.match(record.instanceId, /^[0-9a-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(record.startedAt)));
  assert.equal(logs.join('\n').includes(token), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  }
  await ctx.dispose();
  await assert.rejects(readFile(filename, 'utf8'), { code: 'ENOENT' });
});

test('an older dispose cannot delete a replacement instance record', async t => {
  const root = await fixture(t);
  const first = context('http://127.0.0.1:43891/?token=first');
  const second = context('http://127.0.0.1:43891/?token=second');
  await apply(first, { dataRoot: root });
  await apply(second, { dataRoot: root });
  const filename = path.join(root, '.runtime', 'dsh-control', 'instances', `${process.pid}.json`);
  const replacement = JSON.parse(await readFile(filename, 'utf8'));
  await first.dispose();
  assert.equal(JSON.parse(await readFile(filename, 'utf8')).instanceId, replacement.instanceId);
  await second.dispose();
  await assert.rejects(readFile(filename, 'utf8'), { code: 'ENOENT' });
});

test('rejects non-absolute data roots before creating a record', async t => {
  const root = await fixture(t);
  const ctx = context('http://127.0.0.1:43891/?token=unused');
  await assert.rejects(apply(ctx, { dataRoot: 'relative-dsh-home' }), /absolute path/);
  await assert.rejects(readFile(path.join(root, '.runtime', 'dsh-control', 'instances', `${process.pid}.json`), 'utf8'), { code: 'ENOENT' });
});

test('uses DSH_HOME and the default home directory when config omits dataRoot', async t => {
  const root = await fixture(t);
  const prior = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const ctx = context('http://127.0.0.1:43891/?token=environment');
  try {
    await apply(ctx);
    const filename = path.join(root, '.runtime', 'dsh-control', 'instances', `${process.pid}.json`);
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).dataRoot, root);
    await ctx.dispose();
  } finally {
    if (prior === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prior;
  }
  assert.ok(path.isAbsolute(path.join(homedir(), '.dsh')));
});
