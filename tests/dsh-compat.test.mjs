// DSH compatibility: the plugin borrows a fixed set of host internals, and 0.2.2
// renamed one of them. The catalogue below is what a check can see, so it has to
// come from the calls in host-plugin.mjs rather than from memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DSH_INTERNALS, checkHostCompatibility, createHostHandler } from '../src/host-plugin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A host that provides everything the catalogue names.
function hostServices() {
  const tools = { register() {}, guard() {}, schemas: () => [] };
  return { tools, services: {
    sessionController: { agents: { composeAgent: async () => ({}) }, resolveAgent: async () => ({}), inspect: async () => ({}) },
    sessionQuery: { readSession: async () => ({}), _observations: { cache: { has: () => false, delete: () => {} } } },
    sessionPersistence: { resolveCurrentLog: async () => undefined, stat: async () => undefined, config: { root: 'C:/sessions' } },
    workspaceRegistry: { resolveByPath: async () => undefined, create: async () => undefined, get: () => undefined, list: () => [] },
    subagents: { listDescendants: async () => [], waitForChildren: async () => false, drainDescendants: async () => {} },
    apiProxy: { sessions: { list: async () => ({}) } },
    agentDefaultModel: { currentSelection: () => undefined },
    sessionProjectionCache: { requireTable: () => ({ delete: async () => {}, get: () => undefined }) },
    spillStore: { root: 'C:/spill' },
    agentPresets: { generationFor: () => ({}) },
    loader: { unwrapExports: () => {} },
    sessionProjections: { snapshot: () => ({ values: {} }) },
    sandboxPolicy: { resolve: () => ({}) },
    sandbox: {},
    approval: { overrideOf: () => undefined },
    permissionPresets: { current: () => undefined },
    planMode: {},
    systemPrompt: { context: () => {} },
  } };
}

const lookup = ({ services, tools }) => name => name === 'tools' ? tools : services[name];

const dropMember = (value, dotted) => {
  const keys = dotted.split('.');
  const owner = keys.slice(0, -1).reduce((current, key) => current?.[key], value);
  if (owner) delete owner[keys.at(-1)];
};

test('the catalogue covers every host service the plugin actually looks up', async () => {
  const source = await readFile(path.join(root, 'src', 'host-plugin.mjs'), 'utf8');
  // Several spellings, because one grep missed a real call site before.
  const patterns = [/service\('([^']+)'\)/g, /\bctx\.get\('([^']+)'\)/g, /\bagentCtx\.get\('([^']+)'\)/g,
    /agent\.ctx\?\.get\('([^']+)'\)/g, /(?:^|[^.\w])get\('([^']+)'\)/gm];
  const found = new Set();
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(match[1]);
  assert.ok(found.size >= 15, `the scan must find the lookups it is meant to guard (found ${found.size})`);
  const catalogued = new Set(DSH_INTERNALS.flatMap(entry => entry.choices
    ? entry.choices.map(choice => choice.service) : [entry.service]));
  assert.deepEqual([...found].filter(name => !catalogued.has(name)), [],
    'a host service used by the plugin but absent from DSH_INTERNALS cannot be checked');
});

test('a complete host reports nothing missing', () => {
  const host = hostServices();
  assert.deepEqual(checkHostCompatibility(lookup(host), lookup(host)).missing, []);
});

test('removing any required internal shows up as missing', () => {
  for (const entry of DSH_INTERNALS) {
    if (entry.optional) continue;
    const host = hostServices();
    const lookupFor = lookup(host);
    const expected = [];
    if (entry.choices) {
      for (const choice of entry.choices) {
        if (choice.service === 'tools') dropMember(host.tools, choice.member);
        else if (host.services[choice.service]) dropMember(host.services[choice.service], choice.member);
      }
      expected.push(entry.choices.map(choice => `${choice.service}.${choice.member}`).join(' or '));
    } else if (entry.members) {
      for (const member of entry.members) dropMember(lookupFor(entry.service), member);
      expected.push(...entry.members.map(member => `${entry.service}.${member}`));
    } else {
      delete host.services[entry.service];
      expected.push(entry.service);
    }
    const { missing } = checkHostCompatibility(lookupFor, lookupFor);
    for (const label of expected) assert.ok(missing.includes(label), `${label} must be reported, got ${missing.join(', ')}`);
  }
});

test('either reader satisfies the session inspection pair, and only losing both is missing', () => {
  const modern = hostServices();
  delete modern.services.sessionController.inspect;
  assert.deepEqual(checkHostCompatibility(lookup(modern), lookup(modern)).missing, [],
    'DSH 0.2.2 serves reads through the query service');

  const legacy = hostServices();
  delete legacy.services.sessionQuery.readSession;
  assert.deepEqual(checkHostCompatibility(lookup(legacy), lookup(legacy)).missing, [],
    'the previous host keeps working through the controller');

  const neither = hostServices();
  delete neither.services.sessionController.inspect;
  delete neither.services.sessionQuery.readSession;
  assert.deepEqual(checkHostCompatibility(lookup(neither), lookup(neither)).missing,
    ['sessionController.inspect or sessionQuery.readSession']);
});

test('optional services may be absent without reading as a changed host', () => {
  const host = hostServices();
  for (const entry of DSH_INTERNALS.filter(item => item.optional)) delete host.services[entry.service];
  assert.deepEqual(checkHostCompatibility(lookup(host), lookup(host)).missing, []);
});

test('an agent-scope internal is judged only when an agent can be asked', () => {
  const host = hostServices();
  delete host.services.subagents.waitForChildren;
  assert.deepEqual(checkHostCompatibility(lookup(host)).missing, ['subagents.waitForChildren'],
    'host-scope entries are always checked');
  assert.deepEqual(checkHostCompatibility(lookup(host), lookup(host)).missing, ['subagents.waitForChildren']);
  const agentOnly = hostServices();
  agentOnly.tools = {};
  assert.deepEqual(checkHostCompatibility(lookup(agentOnly), lookup(agentOnly)).missing, ['tools.register', 'tools.guard'],
    'agent-scope entries are checked when an agent exists');
});

test('ping carries the same compatibility answer as the catalogue check', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-compat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const host = hostServices();
  const ctx = { get: lookup(host), agents: { get: () => undefined }, sessions: { get: () => undefined } };
  const handler = createHostHandler(ctx, 'e'.repeat(64), { stateDirectory: path.join(directory, 'managed') });
  const ok = await handler('ping', { args: { token: 'e'.repeat(64) } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value.compatibility.missing, []);

  delete host.services.sessionQuery.readSession;
  delete host.services.sessionController.inspect;
  const changed = await handler('ping', { args: { token: 'e'.repeat(64) } });
  assert.deepEqual(changed.value.compatibility.missing, ['sessionController.inspect or sessionQuery.readSession']);
});
