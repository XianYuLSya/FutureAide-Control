import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { startHttpService } from '../src/claude-report-server.mjs';
import { RosterStore } from '../src/roster-store.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('installed bootstrap drops the original wait stream on stdin EOF with idle cleanup disabled', {timeout: 20000}, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-eof-'));
  const store = new RosterStore(path.join(root, 'state', 'roster.sqlite'));
  t.after(() => store.close());
  const started = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const service = await startHttpService({ port: 0, rosterId: store.identity(),
    resolveCaller: async () => ({ sessionId: 'isolated', cwd: root }),
    management({server, waitSignal}) {
      server.registerTool('futureaide_wait_agents', {inputSchema:{}}, async () => {
        started.resolve();
        await once(waitSignal, 'abort');
        cancelled.resolve();
        return {content:[]};
      });
    },
  });
  t.after(async () => { service.server.closeAllConnections(); await service.close(); });
  const config = path.join(root, 'config.json');
  await writeFile(config, JSON.stringify({idleSessionCleanup:false, reportPort:service.port, workspace:root}));
  const child = spawn(process.execPath, ['src/claude-report-bootstrap.mjs', '--config', config], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: {...process.env, CODEX_HOME:root, DSH_HOME:root},
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const lines = createInterface({input:child.stdout});
  t.after(() => lines.close());
  const send = envelope => child.stdin.write(JSON.stringify({ jsonrpc:'2.0', ...envelope }) + '\n');
  const initialized = once(lines, 'line');
  send({id:1, method:'initialize', params:{protocolVersion:'2025-11-25', capabilities:{}, clientInfo:{name:'test',version:'1'}}});
  assert.equal(JSON.parse((await initialized)[0]).id, 1);
  send({method:'notifications/initialized'});
  send({id:2, method:'tools/call', params:{name:'futureaide_wait_agents', arguments:{}}});
  await started.promise;
  child.stdin.end();
  await cancelled.promise;
});
const until = async fn => { for (let i=0; i<200 && !fn(); i++) await sleep(20); assert.ok(fn()); };
test('isolated stdio bridge: cancellation, transport loss and long wait', { timeout: 155000 }, async () => {
  const pending = new Map(), counts = { calls: [], aborted: [], completed: [] };
  const service = await startHttpService({ port: 0, rosterId: 'bridge-test-only', resolveCaller: async () => ({ sessionId:'isolated', cwd:'isolated' }), management: ({server, waitSignal}) => {
    server.registerTool('futureaide_status', { inputSchema: {} }, async () => ({content:[{type:'text',text:'ok'}]}));
    server.registerTool('futureaide_wait_agents', { inputSchema: { key: z.string() } }, async ({key}, extra) => {
      counts.calls.push(key);
      return await new Promise((resolve, reject) => {
        const timer = setInterval(() => { if(extra._meta?.progressToken !== undefined) void extra.sendNotification({ method:'notifications/progress', params:{progressToken:extra._meta.progressToken, progress:Date.now()} }); }, 500);
        const done = result => { clearInterval(timer); waitSignal.removeEventListener('abort', abort); pending.delete(key); resolve({content:[{type:'text',text:result}]}); counts.completed.push(key); };
        const abort = () => { clearInterval(timer); pending.delete(key); counts.aborted.push(key); reject(new Error('closed')); };
        waitSignal.addEventListener('abort', abort, {once:true}); pending.set(key, done);
      });
    });
  }});
  const client = new Client({name:'isolated-test',version:'1'});
  const transport = new StdioClientTransport({ command: process.execPath, args:['fixtures/bridge-wait-fixture.mjs'], env:{...process.env,ISOLATED_BRIDGE_PORT:String(service.port),ISOLATED_ROSTER:'bridge-test-only'}, stderr:'pipe' });
  await client.connect(transport);
  try {
    const a = new AbortController();
    const aCall = client.callTool({name:'futureaide_wait_agents',arguments:{key:'A'}}, undefined, {signal:a.signal,timeout:10000}).catch(e=>e);
    const bCall = client.callTool({name:'futureaide_wait_agents',arguments:{key:'B'}}, undefined, {timeout:10000});
    await until(()=>pending.has('A') && pending.has('B')); a.abort(); await aCall;
    await until(()=>counts.aborted.includes('A')); assert.ok(pending.has('B'));
    assert.equal((await client.callTool({name:'futureaide_status',arguments:{}})).content[0].text,'ok');
    pending.get('B')('final-B'); assert.equal((await bCall).content[0].text,'final-B');
    const lostCall = client.callTool({name:'futureaide_wait_agents',arguments:{key:'lost'}}, undefined, {timeout:10000});
    await until(()=>pending.has('lost')); service.server.closeAllConnections();
    const lost = await lostCall; assert.equal(lost.isError,true); assert.match(lost.content[0].text,/transport-lost/); assert.equal(counts.calls.filter(x=>x==='lost').length,1);
    if(process.env.ISOLATED_LONG_WAIT === '1') {
      let progress=0; const start=Date.now();
      const long = client.callTool({name:'futureaide_wait_agents',arguments:{key:'long'}}, undefined, {timeout:150000,onprogress:()=>progress++});
      await until(()=>pending.has('long')); await sleep(135000); pending.get('long')('final-long');
      assert.equal((await long).content[0].text,'final-long'); assert.ok(Date.now()-start>=135000); assert.ok(progress>1);
      assert.equal(counts.calls.filter(x=>x==='long').length,1);
    }
  } finally { await client.close(); service.server.closeAllConnections(); await service.close(); }
});
