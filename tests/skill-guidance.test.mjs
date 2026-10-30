import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const read = relative => readFile(new URL(relative, import.meta.url), 'utf8');

test('the default skill uses named subagents and keeps legacy dispatch in its reference', async () => {
  const skill = await read('../skills/futureaide-control/SKILL.md');
  for (const tool of ['create_agent', 'send_agent', 'answer_agent', 'list_agents', 'wait_agents', 'agent_changes', 'inspect_agent', 'cancel_agent', 'delete_agent', 'status']) {
    assert.ok(skill.includes('futureaide_' + tool), `Missing guidance for ${tool}`);
  }
  assert.doesNotMatch(skill, /futureaide_spawn_agent|codex_thread_id/);
  assert.match(skill, /references\/legacy-workflows\.md/);
  const legacy = await read('../skills/futureaide-control/references/legacy-workflows.md');
  assert.match(legacy, /futureaide_spawn_agent/);
  assert.match(legacy, /codex_thread_id/);
});

test('public README links resolve inside the distributable package', async () => {
  const readme = await read('../README.md');
  const root = new URL('../', import.meta.url);
  const links = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]);
  assert.ok(links.length > 0);
  for (const target of links) {
    if (/^(?:https?:|#)/.test(target)) continue;
    const resolved = new URL(target.split('#')[0], root);
    assert.ok(resolved.href.startsWith(root.href), `Link escapes the package: ${target}`);
    await access(resolved);
  }
});
