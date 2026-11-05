import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FINAL_REPORT_CONTRACT, QUESTION_CONTRACT } from '../src/report-contract.mjs';
import * as dsh from '../src/host-plugin.mjs';
import { makeScopedServer } from '../src/mcp-server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const connected = async server => {
  const client = new Client({ name: 'report-contract-test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return { client, close: async () => { await client.close(); await server.close(); } };
};

test('the final report contract names every part a lead wants to check', () => {
  for (const part of ['Result:', 'Changes:', 'Verified:', 'Not verified:', 'Decisions:', '300 words']) {
    assert.ok(FINAL_REPORT_CONTRACT.includes(part), `the contract must name ${part}`);
  }
  assert.match(FINAL_REPORT_CONTRACT, /spot-check it, not re-read your work/);
  assert.match(FINAL_REPORT_CONTRACT, /A lead that ran a team sends one summary/,
    'a team lead reports the team, not each member');
  assert.match(QUESTION_CONTRACT, /recommendation/);
  assert.ok(QUESTION_CONTRACT.length < 300, 'a question stays short enough to answer without the work');
});

test('the DSH plugin repeats the contract word for word', async () => {
  assert.equal(dsh.FINAL_REPORT_CONTRACT, FINAL_REPORT_CONTRACT);
  assert.equal(dsh.QUESTION_CONTRACT, QUESTION_CONTRACT);
  // It may import only Node builtins, so the copy is literal and a drift shows up here.
  const source = await readFile(path.join(root, 'src', 'host-plugin.mjs'), 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
  assert.deepEqual(imports.filter(specifier => !specifier.startsWith('node:')), [],
    'the DSH plugin must stay a Node-only module');
  assert.doesNotMatch(source, /controlling Codex agent/, 'a controlling agent is not necessarily Codex');
});

test('the Codex surface carries both contracts in its parent tools', async () => {
  const service = { async resume() {}, async ensureIdleMonitor() {}, async submitToParent(args) { return { accepted: true, ...args }; } };
  const server = makeScopedServer({ configPath: path.join(root, 'clean', 'report-contract-config-absent.json'), scopedFactory: () => service });
  const { client, close } = await connected(server);
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.find(tool => tool.name === 'report_parent').description.includes(FINAL_REPORT_CONTRACT));
    assert.ok(tools.find(tool => tool.name === 'ask_parent').description.includes(QUESTION_CONTRACT));
    // The parent may be Claude or Codex, so no tool text may name Codex as the parent.
    assert.doesNotMatch(JSON.stringify(tools), /Codex parent chat|Codex chat/);
  } finally { await close(); }
});

