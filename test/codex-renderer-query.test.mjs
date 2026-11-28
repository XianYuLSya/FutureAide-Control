import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../src/codex-renderer-query.js', import.meta.url), 'utf8');
const stamp = '20261126034050.167203-300';
const app = {
  ProcessId: 42, Name: 'Codex.exe', ExecutablePath: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_1\\Codex.exe',
  CommandLine: 'Codex.exe --remote-debugging-port=43123', CreationDate: stamp,
};
const listener = { LocalPort: 43123, CreationTime: stamp };

function query({ candidates = [app], listenerRows = [listener], competitor = false, cached } = {}) {
  const output = [], queries = [];
  const args = cached ? ['6', cached] : ['6'];
  function Enumerator(rows) {
    let index = 0;
    this.atEnd = () => index === rows.length;
    this.item = () => rows[index];
    this.moveNext = () => { index++; };
  }
  function ActiveXObject() {
    return { FileExists: () => false, BuildPath: path.win32.join, GetParentFolderName: path.win32.dirname };
  }
  const processQueries = {
    ExecQuery(sql) {
      queries.push(sql);
      if (sql.startsWith('SELECT SessionId')) return [{ SessionId: 5 }];
      if (sql.startsWith('SELECT ProcessId')) return competitor ? [{ ProcessId: 43 }] : [];
      return candidates;
    },
  };
  const listenerQueries = { ExecQuery(sql) { queries.push(sql); return listenerRows; } };
  runInNewContext(script, {
    WScript: { Arguments: { length: args.length, Item: i => args[i] }, Echo: value => output.push(value) },
    GetObject: name => name.endsWith('cimv2') ? processQueries : listenerQueries,
    ActiveXObject, Enumerator,
  });
  return { queries, output };
}

test('WSH queries the caller session and only the verified main process loopback listener', () => {
  const { queries, output } = query({
    candidates: [app, { ...app, CommandLine: app.CommandLine + ' --type=renderer' },
      { ...app, ExecutablePath: 'C:\\other\\Codex.exe' }, { ...app, CommandLine: 'Codex.exe' }],
  });
  assert.match(queries[0], /ProcessId=6$/);
  assert.match(queries[1], /\(Name='ChatGPT.exe' OR Name='Codex.exe'\) AND SessionId=5$/);
  assert.equal(queries.length, 3);
  assert.match(queries[2], /State=2 AND LocalAddress='127\.0\.0\.1' AND OwningProcess=42 AND LocalPort=43123$/);
  assert.deepEqual(output, [`42\t43123\t${stamp}\t${stamp}\t43123`, 'OK']);
});

test('WSH rechecks competitors on a warm lookup and keeps all eligible dynamic listeners', () => {
  const { queries, output } = query({ cached: '42', competitor: true });
  assert.match(queries[1], /SessionId=5 AND ProcessId<>42 .*--remote-debugging-port=.*--type=/);
  assert.equal(queries.length, 2);
  assert.deepEqual(output, ['OK']);
  const dynamic = query({ cached: '42', candidates: [{ ...app, CommandLine: 'Codex.exe --remote-debugging-port=0' }] });
  assert.match(dynamic.queries[2], /ProcessId=42 AND SessionId=5$/);
  assert.match(dynamic.queries[3], /OwningProcess=42$/);
  assert.deepEqual(dynamic.output, [`42\t43123\t${stamp}\t${stamp}\t0`, 'OK']);
});
