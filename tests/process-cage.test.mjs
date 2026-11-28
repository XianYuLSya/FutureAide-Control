// Lane A integration & kernel cage tests:
//   1. Windows Job Object (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) kills broken-parent-chain
//      grandchildren across normal exit, error exit, and sudden worker termination.
//   2. killProcessCage sweeps broken-parent-chain orphan grandchildren (intermediate cmd.exe
//      exited early) via PEB CommandLine + Environment markers.
//   3. Codex & Claude CLI Worker/Runner reap broken-parent-chain grandchildren across all 3
//      terminal states (ended / failed / cancelled), and terminal-state cancelCodexTurn /
//      cancelClaudeTurn clean up leaked owned processes & orphans instead of skipping.
//   4. callerEnv, reportConfig.env, dual-MCP collision shield (mcp_servers.futureaide.enabled=false),
//      and Claude/Codex port proxy binding (buildCliProxyEnv + fail-closed TCP check).
//   5. claude-caller-identity.mjs live process cache (<2ms for 9 hits) & 0ms dead-PID short-circuit,
//      with bit-exact StartTime.ToFileTimeUtc() parity.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parentProcessId, processStartTime } from '../src/claude-caller-identity.mjs';
import {
  CLAUDE_TURN_FILES,
  cancelClaudeTurn,
  probeClaudeCli,
  readClaudeTurn,
  startClaudeTurn,
} from '../src/claude-cli-runner.mjs';
import { runClaudeTurn } from '../src/claude-cli-worker.mjs';
import {
  CODEX_TURN_FILES,
  buildCodexCliArgs,
  cancelCodexTurn,
  readCodexTurn,
  startCodexTurn,
} from '../src/codex-cli-runner.mjs';
import { attachCurrentProcessToJobCage, isProcessAlive, killProcessCage } from '../src/process-cage.mjs';

const execFileAsync = promisify(execFile);
const SESSION_ID = '22222222-3333-4444-8555-666666666666';
const cageModuleUrl = pathToFileURL(fileURLToPath(new URL('../src/process-cage.mjs', import.meta.url))).href;

const tempDirs = [];
const trackedPids = new Set();

async function makeTempDir(prefix = 'fa-cage-test-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function registerPid(pid) {
  if (Number.isSafeInteger(pid) && pid > 0) trackedPids.add(pid);
}

async function waitUntil(predicate, { timeoutMs = 15000, intervalMs = 40, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const val = await predicate();
    if (val) return val;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await delay(intervalMs);
  }
}

async function startLoopbackProxy() {
  const server = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    port,
    proxyUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise(resolve => server.close(() => resolve())),
  };
}

async function getUnusedLocalPort() {
  const server = await startLoopbackProxy();
  const { port } = server;
  await server.close();
  return port;
}

/**
 * Helper files run inside stand-in CLIs / workers on Windows: spawns an intermediate
 * `cmd.exe /d /c <detach.cmd> <node> <sleeper> <pidFile>` so `cmd.exe` exits immediately (`0`),
 * breaking the Win32 ParentProcessId chain while the grandchild `node.exe` stays alive indefinitely.
 */
async function writeBrokenChainSpawner(dir) {
  const sleeperPath = path.join(dir, 'orphan-sleeper.mjs');
  const detachCmdPath = path.join(dir, 'detach-orphan.cmd');
  await writeFile(sleeperPath, [
    'import { writeFileSync } from "node:fs";',
    'const pidFile = process.argv[2];',
    'if (pidFile) writeFileSync(pidFile, JSON.stringify({ pid: process.pid, ppid: process.ppid, turnDir: process.env.FUTUREAIDE_TURN_DIR ?? null, runId: process.env.FUTUREAIDE_RUN_ID ?? null }));',
    'setInterval(() => {}, 1000);',
  ].join('\n'), 'utf8');
  await writeFile(detachCmdPath, [
    '@echo off',
    'start "" /b "%~1" "%~2" "%~3"',
    'exit /b 0',
  ].join('\r\n') + '\r\n', 'utf8');
  return { sleeperPath, detachCmdPath };
}

after(async () => {
  for (const pid of trackedPids) {
    if (isProcessAlive(pid)) {
      await killProcessCage({ pids: [pid] }).catch(() => undefined);
    }
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('buildCodexCliArgs shields global futureaide MCP collision and injects reportConfig.env & callerEnv', () => {
  const args = buildCodexCliArgs({
    workspace: 'D:\\repo',
    turnDir: 'D:\\turns\\req-001',
    reportConfig: {
      serverName: 'futureaide_report',
      command: process.execPath,
      args: ['cli-callback-bridge.mjs'],
      disableGlobalFutureaide: true,
      callerEnv: {
        FUTUREAIDE_MANAGED_CLI: '1',
        FUTUREAIDE_PARENT_AGENT_ID: 'agent-lead-1',
      },
      env: {
        CUSTOM_TOKEN: 'tok_abc',
        WIN_DIR: 'D:\\work\\sub',
      },
    },
  });

  assert.ok(args.includes('mcp_servers.futureaide.enabled=false'), 'global futureaide MCP must be disabled');
  assert.ok(args.includes('mcp_servers.futureaide_report.enabled=true'));
  assert.ok(args.includes('mcp_servers.futureaide_report.env.FUTUREAIDE_MANAGED_CLI="1"'));
  assert.ok(args.includes('mcp_servers.futureaide_report.env.FUTUREAIDE_PARENT_AGENT_ID="agent-lead-1"'));
  assert.ok(args.includes('mcp_servers.futureaide_report.env.CUSTOM_TOKEN="tok_abc"'));
  assert.ok(args.includes('mcp_servers.futureaide_report.env.WIN_DIR="D:\\\\work\\\\sub"'));
  assert.equal(args.at(-1), '-');

  // Explicit opt-out or serverName === 'futureaide' must not emit enabled=false.
  const optedOut = buildCodexCliArgs({
    workspace: 'D:\\repo',
    reportConfig: {
      serverName: 'futureaide_report',
      command: process.execPath,
      disableGlobalFutureaide: false,
    },
  });
  assert.ok(!optedOut.includes('mcp_servers.futureaide.enabled=false'));

  const sameName = buildCodexCliArgs({
    workspace: 'D:\\repo',
    reportConfig: {
      serverName: 'futureaide',
      command: process.execPath,
      disableGlobalFutureaide: true,
    },
  });
  assert.ok(!sameName.includes('mcp_servers.futureaide.enabled=false'));
});

test('attachCurrentProcessToJobCage kills broken-parent-chain grandchildren on exit, error, and hard kill',
  { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
    const dir = await makeTempDir('fa-job-cage-');
    const { sleeperPath, detachCmdPath } = await writeBrokenChainSpawner(dir);
    const workerScript = path.join(dir, 'dummy-caged-worker.mjs');

    await writeFile(workerScript, [
      `import { spawn } from 'node:child_process';`,
      `import { writeFileSync, existsSync } from 'node:fs';`,
      `import { attachCurrentProcessToJobCage } from ${JSON.stringify(cageModuleUrl)};`,
      `const [mode, pidFile, workerReadyFile] = process.argv.slice(2);`,
      `const cage = await attachCurrentProcessToJobCage();`,
      `if (!cage.ok) { console.error('cage failed', cage); process.exit(9); }`,
      `const cmd = spawn('cmd.exe', ['/d', '/c', ${JSON.stringify(detachCmdPath)}, process.execPath, ${JSON.stringify(sleeperPath)}, pidFile], { windowsHide: true, stdio: 'ignore' });`,
      `await new Promise(r => cmd.once('exit', r));`,
      `while (!existsSync(pidFile)) await new Promise(r => setTimeout(r, 20));`,
      `writeFileSync(workerReadyFile, JSON.stringify({ workerPid: process.pid, cmdPid: cmd.pid, cagePid: cage.cagePid }));`,
      `if (mode === 'exit0') process.exit(0);`,
      `if (mode === 'exit1') process.exit(1);`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'), 'utf8');

    for (const mode of ['exit0', 'exit1', 'hardkill']) {
      const pidFile = path.join(dir, `grandchild-${mode}.json`);
      const readyFile = path.join(dir, `ready-${mode}.json`);
      const worker = spawn(process.execPath, [workerScript, mode, pidFile, readyFile], {
        stdio: 'ignore',
        windowsHide: true,
      });
      registerPid(worker.pid);

      const ready = await waitUntil(async () => {
        try { return JSON.parse(await readFile(readyFile, 'utf8')); } catch { return null; }
      }, { label: `worker ready (${mode})` });
      const grandchild = JSON.parse(await readFile(pidFile, 'utf8'));
      registerPid(grandchild.pid);
      registerPid(ready.cagePid);

      // Intermediate cmd.exe has already exited, breaking the parent chain!
      await waitUntil(() => !isProcessAlive(ready.cmdPid), { label: 'intermediate cmd.exe exit' });

      if (mode === 'hardkill') {
        assert.equal(isProcessAlive(grandchild.pid), true, 'broken-chain grandchild should be alive while worker lives');
        // Kill ONLY the worker PID directly (no /T tree walk, no JS cleanup!).
        process.kill(worker.pid);
      }

      await waitUntil(() => !isProcessAlive(worker.pid), { label: `worker exit (${mode})` });
      await waitUntil(() => !isProcessAlive(grandchild.pid), { label: `grandchild reaped by Job Object (${mode})` });
      await waitUntil(() => !isProcessAlive(ready.cagePid), { label: `cage holder exit (${mode})` });

      assert.equal(isProcessAlive(grandchild.pid), false, `grandchild must be dead in mode=${mode}`);
      trackedPids.delete(worker.pid);
      trackedPids.delete(grandchild.pid);
      trackedPids.delete(ready.cagePid);
    }
  });

test('killProcessCage sweeps broken-parent-chain orphan via FUTUREAIDE_TURN_DIR / FUTUREAIDE_RUN_ID env',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    const dir = await makeTempDir('fa-orphan-env-');
    const { detachCmdPath } = await writeBrokenChainSpawner(dir);
    const turnDir = path.join(dir, 'turn-folder-alpha-98765');
    const runId = 'run-orphan-sweep-123456789';
    const pidFile = path.join(dir, 'env-only-orphan.json');

    // Note: neither turnDir nor runId appears in sleeper's command line — ONLY in its environment!
    const sleeperScript = path.join(dir, 'env-only-sleeper.mjs');
    await writeFile(sleeperScript, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ pid: process.pid }));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'), 'utf8');

    const cmd = spawn('cmd.exe', ['/d', '/c', detachCmdPath, process.execPath, sleeperScript, 'noop'], {
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        FUTUREAIDE_TURN_DIR: turnDir,
        FUTUREAIDE_RUN_ID: runId,
      },
    });
    await new Promise(resolve => cmd.once('exit', resolve));

    const orphan = await waitUntil(async () => {
      try { return JSON.parse(await readFile(pidFile, 'utf8')); } catch { return null; }
    }, { label: 'env-only orphan pid file' });
    registerPid(orphan.pid);

    assert.equal(isProcessAlive(cmd.pid), false, 'intermediate cmd.exe already exited');
    assert.equal(isProcessAlive(orphan.pid), true, 'orphan grandchild is alive with broken parent chain');

    const result = await killProcessCage({ pids: [cmd.pid], turnDir, runId });
    assert.equal(result.ok, true);
    assert.ok(result.killed.includes(orphan.pid), 'orphan pid must be detected and killed');
    assert.equal(isProcessAlive(orphan.pid), false);
    trackedPids.delete(orphan.pid);
  });

test('Codex CLI Runner/Worker reaps broken-parent-chain grandchildren in ended, failed, cancelled & terminal-cancel states',
  { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const dir = await makeTempDir('fa-codex-cage-');
    const proxy = await startLoopbackProxy();
    try {
      const { sleeperPath, detachCmdPath } = await writeBrokenChainSpawner(dir);
      const fakeCodex = path.join(dir, 'fake-codex-orphan.mjs');
      await writeFile(fakeCodex, [
        'import { spawn } from "node:child_process";',
        'import { existsSync, writeFileSync } from "node:fs";',
        'let stdin = "";',
        'for await (const chunk of process.stdin) stdin += chunk;',
        'const pidFile = process.env.TEST_ORPHAN_PID_FILE;',
        'const envDumpFile = process.env.TEST_ENV_DUMP_FILE;',
        'if (envDumpFile) {',
        '  writeFileSync(envDumpFile, JSON.stringify({',
        '    turnDir: process.env.FUTUREAIDE_TURN_DIR,',
        '    runId: process.env.FUTUREAIDE_RUN_ID,',
        '    managed: process.env.FUTUREAIDE_MANAGED_CLI,',
        '    parentAgentId: process.env.FUTUREAIDE_PARENT_AGENT_ID,',
        '    reportExtra: process.env.REPORT_EXTRA_FLAG,',
        '    httpProxy: process.env.HTTP_PROXY,',
        '    noProxy: process.env.NO_PROXY,',
        '    args: process.argv.slice(2),',
        '  }));',
        '}',
        `const cmd = spawn('cmd.exe', ['/d', '/c', ${JSON.stringify(detachCmdPath)}, process.execPath, ${JSON.stringify(sleeperPath)}, pidFile], { windowsHide: true, stdio: 'ignore' });`,
        'await new Promise(r => cmd.once("exit", r));',
        'while (pidFile && !existsSync(pidFile)) await new Promise(r => setTimeout(r, 20));',
        'console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-cage-1" }));',
        'console.log(JSON.stringify({ type: "turn.started" }));',
        'if (stdin.includes("SCENARIO_FAIL")) { console.error("simulated crash"); process.exit(3); }',
        'if (stdin.includes("SCENARIO_HANG")) { setInterval(() => {}, 1000); await new Promise(() => {}); }',
        'console.log(JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "done" } }));',
        'console.log(JSON.stringify({ type: "turn.completed" }));',
        'process.exit(0);',
      ].join('\n'), 'utf8');

      const cliSpec = { command: process.execPath, prefixArgs: [fakeCodex] };
      const route = { ok: true, source: 'manual', mode: 'proxy', proxyUrl: proxy.proxyUrl, port: proxy.port };

      for (const scenario of ['SCENARIO_OK', 'SCENARIO_FAIL', 'SCENARIO_HANG']) {
        const turnDir = path.join(dir, `codex-${scenario.toLowerCase()}`);
        const pidFile = path.join(dir, `pid-${scenario}.json`);
        const envDumpFile = path.join(dir, `env-${scenario}.json`);

        await startCodexTurn({
          cli: cliSpec,
          directory: turnDir,
          workspace: dir,
          message: scenario,
          requestId: `req-codex-${scenario.toLowerCase()}-12345`,
          agentId: 'agent-codex-1',
          taskId: 'task-codex-1',
          sessionId: SESSION_ID,
          route,
          callerEnv: {
            FUTUREAIDE_MANAGED_CLI: '1',
            FUTUREAIDE_PARENT_AGENT_ID: 'lead-agent-99',
            TEST_ORPHAN_PID_FILE: pidFile,
            TEST_ENV_DUMP_FILE: envDumpFile,
          },
          reportConfig: {
            serverName: 'futureaide_report',
            command: process.execPath,
            args: ['bridge.mjs'],
            disableGlobalFutureaide: true,
            env: { REPORT_EXTRA_FLAG: 'enabled-1' },
          },
        });

        const orphanInfo = await waitUntil(async () => {
          try { return JSON.parse(await readFile(pidFile, 'utf8')); } catch { return null; }
        }, { label: `orphan spawned (${scenario})` });
        registerPid(orphanInfo.pid);

        if (scenario === 'SCENARIO_HANG') {
          const cancelled = await cancelCodexTurn(turnDir);
          assert.equal(cancelled.ok, true);
          assert.equal(cancelled.stopped, true);
          const finalTurn = await readCodexTurn(turnDir);
          assert.equal(finalTurn.state, 'cancelled');
        } else {
          const settled = await waitUntil(async () => {
            const t = await readCodexTurn(turnDir);
            return t.state !== 'running' ? t : null;
          }, { label: `codex settled (${scenario})` });
          assert.equal(settled.state, scenario === 'SCENARIO_OK' ? 'ended' : 'failed');
        }

        await waitUntil(() => !isProcessAlive(orphanInfo.pid), { label: `orphan reaped (${scenario})` });
        assert.equal(isProcessAlive(orphanInfo.pid), false, `grandchild must be 0 alive after ${scenario}`);
        trackedPids.delete(orphanInfo.pid);

        if (scenario === 'SCENARIO_OK') {
          const dump = JSON.parse(await readFile(envDumpFile, 'utf8'));
          assert.equal(dump.turnDir, turnDir);
          assert.equal(dump.runId, 'req-codex-scenario_ok-12345');
          assert.equal(dump.managed, '1');
          assert.equal(dump.parentAgentId, 'lead-agent-99');
          assert.equal(dump.reportExtra, 'enabled-1');
          assert.equal(dump.httpProxy, proxy.proxyUrl);
          assert.ok(dump.noProxy.includes('127.0.0.1'));
          assert.ok(dump.args.includes('mcp_servers.futureaide.enabled=false'));

          // Now simulate a stray orphan appearing AFTER state.json already reached 'ended':
          // cancelCodexTurn MUST still sweep and kill it instead of skipping terminal turns!
          const latePidFile = path.join(dir, 'late-codex-orphan.json');
          const lateCmd = spawn('cmd.exe', ['/d', '/c', detachCmdPath, process.execPath, sleeperPath, latePidFile], {
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, FUTUREAIDE_TURN_DIR: turnDir, FUTUREAIDE_RUN_ID: 'req-codex-scenario_ok-12345' },
          });
          await new Promise(r => lateCmd.once('exit', r));
          const lateOrphan = await waitUntil(async () => {
            try { return JSON.parse(await readFile(latePidFile, 'utf8')); } catch { return null; }
          }, { label: 'late codex orphan' });
          registerPid(lateOrphan.pid);
          assert.equal(isProcessAlive(lateOrphan.pid), true);

          const postCancel = await cancelCodexTurn(turnDir);
          assert.equal(postCancel.ok, true);
          assert.equal(postCancel.stopped, true);
          assert.equal(isProcessAlive(lateOrphan.pid), false, 'cancelCodexTurn must reap orphans even on ended turns');
          trackedPids.delete(lateOrphan.pid);
        }
      }
    } finally {
      await proxy.close();
    }
  });

test('Claude CLI Runner/Worker reaps broken-parent-chain grandchildren across all 3 terminal states and binds proxy fail-closed',
  { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    const dir = await makeTempDir('fa-claude-cage-');
    const proxy = await startLoopbackProxy();
    try {
      const { sleeperPath, detachCmdPath } = await writeBrokenChainSpawner(dir);
      const fakeClaude = path.join(dir, 'fake-claude-orphan.mjs');
      await writeFile(fakeClaude, [
        'import { spawn } from "node:child_process";',
        'import { existsSync, writeFileSync } from "node:fs";',
        'let prompt = "";',
        'for await (const chunk of process.stdin) prompt += chunk;',
        'const pidFile = process.env.TEST_CLAUDE_ORPHAN_PID_FILE;',
        'const envDumpFile = process.env.TEST_CLAUDE_ENV_DUMP_FILE;',
        'if (envDumpFile) {',
        '  writeFileSync(envDumpFile, JSON.stringify({',
        '    turnDir: process.env.FUTUREAIDE_TURN_DIR,',
        '    runId: process.env.FUTUREAIDE_RUN_ID,',
        '    managed: process.env.FUTUREAIDE_MANAGED_CLI,',
        '    parentAgentId: process.env.FUTUREAIDE_PARENT_AGENT_ID,',
        '    reportExtra: process.env.CLAUDE_REPORT_EXTRA,',
        '    httpProxy: process.env.HTTP_PROXY,',
        '    httpsProxy: process.env.HTTPS_PROXY,',
        '    allProxy: process.env.ALL_PROXY,',
        '    httpProxyLower: process.env.http_proxy,',
        '    noProxy: process.env.NO_PROXY,',
        '  }));',
        '}',
        `const cmd = spawn('cmd.exe', ['/d', '/c', ${JSON.stringify(detachCmdPath)}, process.execPath, ${JSON.stringify(sleeperPath)}, pidFile], { windowsHide: true, stdio: 'ignore' });`,
        'await new Promise(r => cmd.once("exit", r));',
        'while (pidFile && !existsSync(pidFile)) await new Promise(r => setTimeout(r, 20));',
        `console.log(JSON.stringify({ type: "system", subtype: "init", session_id: ${JSON.stringify(SESSION_ID)}, model: "claude-test", permissionMode: "auto", mcp_servers: [{ name: "futureaide", status: "connected" }] }));`,
        'if (prompt.includes("CLAUDE_FAIL")) { console.error("claude boom"); process.exit(4); }',
        'if (prompt.includes("CLAUDE_HANG")) { setInterval(() => {}, 1000); await new Promise(() => {}); }',
        'console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }));',
        'process.exit(0);',
      ].join('\n'), 'utf8');

      const cliSpec = { command: process.execPath, prefixArgs: [fakeClaude] };
      const mcpConfig = { mcpServers: { futureaide: { command: process.execPath, args: ['bridge.mjs'] } } };
      const route = { ok: true, source: 'manual', mode: 'proxy', proxyUrl: proxy.proxyUrl, port: proxy.port };

      // 1. Fail-closed proxy check in startClaudeTurn & probeClaudeCli & runClaudeTurn when bound port is dead!
      const deadPort = await getUnusedLocalPort();
      await assert.rejects(
        () => startClaudeTurn({
          directory: path.join(dir, 'claude-dead-proxy'),
          cli: cliSpec,
          workspace: dir,
          sessionId: SESSION_ID,
          message: 'Must not send',
          config: { claudeCliProxyPort: deadPort },
        }),
        err => err.code === 'proxy-unavailable' && err.notSent === true,
      );

      await assert.rejects(
        () => probeClaudeCli({
          findCli: async () => 'claude.exe',
          config: { claudeCliProxyPort: deadPort },
        }),
        err => err.code === 'proxy-unavailable',
      );

      // Also verify worker-level fail-closed check if proxy dies right before runClaudeTurn spawns child:
      const workerProxyDir = path.join(dir, 'claude-worker-dead-proxy');
      await startClaudeTurn({
        directory: workerProxyDir,
        cli: cliSpec,
        workspace: dir,
        sessionId: SESSION_ID,
        message: 'Worker preflight check',
        route,
      }, { spawnWorker: () => ({ pid: 999998 }) });
      const turnJsonPath = path.join(workerProxyDir, CLAUDE_TURN_FILES.turn);
      const savedTurn = JSON.parse(await readFile(turnJsonPath, 'utf8'));
      savedTurn.route = { ok: true, source: 'manual', mode: 'proxy', proxyUrl: `http://127.0.0.1:${deadPort}`, port: deadPort };
      await writeFile(turnJsonPath, JSON.stringify(savedTurn, null, 2));
      const workerOutcome = await runClaudeTurn({ directory: workerProxyDir });
      assert.equal(workerOutcome.state, 'failed');
      assert.equal(workerOutcome.error.code, 'proxy-unavailable');
      assert.equal(workerOutcome.error.notSent, true);

      // 2. All 3 terminal states (ended / failed / cancelled) + env & proxy injection + terminal cancel cleanup:
      for (const scenario of ['CLAUDE_OK', 'CLAUDE_FAIL', 'CLAUDE_HANG']) {
        const turnDir = path.join(dir, `claude-${scenario.toLowerCase()}`);
        const pidFile = path.join(dir, `claude-pid-${scenario}.json`);
        const envDumpFile = path.join(dir, `claude-env-${scenario}.json`);

        const started = await startClaudeTurn({
          directory: turnDir,
          cli: cliSpec,
          workspace: dir,
          sessionId: SESSION_ID,
          message: scenario,
          mcpConfig,
          route,
          callerEnv: {
            FUTUREAIDE_MANAGED_CLI: '1',
            FUTUREAIDE_PARENT_AGENT_ID: 'claude-lead-77',
            TEST_CLAUDE_ORPHAN_PID_FILE: pidFile,
            TEST_CLAUDE_ENV_DUMP_FILE: envDumpFile,
          },
          reportConfig: {
            env: { CLAUDE_REPORT_EXTRA: 'yes-2' },
          },
        });

        const orphanInfo = await waitUntil(async () => {
          try { return JSON.parse(await readFile(pidFile, 'utf8')); } catch { return null; }
        }, { label: `claude orphan spawned (${scenario})` });
        registerPid(orphanInfo.pid);

        if (scenario === 'CLAUDE_HANG') {
          const cancelled = await cancelClaudeTurn(turnDir);
          assert.equal(cancelled.ok, true);
          assert.equal(cancelled.stopped, true);
          assert.equal((await readClaudeTurn(turnDir)).state, 'cancelled');
        } else {
          const settled = await waitUntil(async () => {
            const t = await readClaudeTurn(turnDir);
            return t.state !== 'running' ? t : null;
          }, { label: `claude settled (${scenario})` });
          assert.equal(settled.state, scenario === 'CLAUDE_OK' ? 'ended' : 'failed');
        }

        await waitUntil(() => !isProcessAlive(orphanInfo.pid), { label: `claude orphan reaped (${scenario})` });
        assert.equal(isProcessAlive(orphanInfo.pid), false, `claude grandchild must be 0 alive after ${scenario}`);
        trackedPids.delete(orphanInfo.pid);

        if (scenario === 'CLAUDE_OK') {
          const dump = JSON.parse(await readFile(envDumpFile, 'utf8'));
          assert.equal(dump.turnDir, turnDir);
          assert.equal(dump.runId, started.requestId);
          assert.equal(dump.managed, '1');
          assert.equal(dump.parentAgentId, 'claude-lead-77');
          assert.equal(dump.reportExtra, 'yes-2');
          assert.equal(dump.httpProxy, proxy.proxyUrl);
          assert.equal(dump.httpsProxy, proxy.proxyUrl);
          assert.equal(dump.allProxy, proxy.proxyUrl);
          assert.equal(dump.httpProxyLower, proxy.proxyUrl);
          assert.ok(dump.noProxy.includes('127.0.0.1'));
          assert.ok(dump.noProxy.includes('localhost'));

          // Simulate a surviving owned process & orphan on a terminal ('failed' / 'ended') Claude turn:
          const latePidFile = path.join(dir, 'late-claude-orphan.json');
          const lateCmd = spawn('cmd.exe', ['/d', '/c', detachCmdPath, process.execPath, sleeperPath, latePidFile], {
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, FUTUREAIDE_TURN_DIR: turnDir, FUTUREAIDE_RUN_ID: started.requestId },
          });
          await new Promise(r => lateCmd.once('exit', r));
          const lateOrphan = await waitUntil(async () => {
            try { return JSON.parse(await readFile(latePidFile, 'utf8')); } catch { return null; }
          }, { label: 'late claude orphan' });
          registerPid(lateOrphan.pid);
          assert.equal(isProcessAlive(lateOrphan.pid), true);

          const postCancel = await cancelClaudeTurn(turnDir);
          assert.equal(postCancel.ok, true);
          assert.equal(postCancel.stopped, true);
          assert.equal(isProcessAlive(lateOrphan.pid), false, 'cancelClaudeTurn must reap orphans even on ended turns');
          trackedPids.delete(lateOrphan.pid);
        }
      }
    } finally {
      await proxy.close();
    }
  });

test('claude-caller-identity processStartTime & parentProcessId match ToFileTimeUtc(), hit cache <2ms, and 0ms short-circuit dead PIDs',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    // 1. Dead PID short-circuit: 0ms, no subprocess spawned.
    let deadPid = 999999;
    if (isProcessAlive(deadPid)) deadPid = 2147483000;
    const tDead0 = performance.now();
    const deadStart = await processStartTime(deadPid);
    const deadParent = await parentProcessId(deadPid);
    const deadElapsed = performance.now() - tDead0;
    assert.equal(deadStart, null);
    assert.equal(deadParent, null);
    assert.ok(deadElapsed < 5, `dead PID must short-circuit near 0ms (got ${deadElapsed.toFixed(2)}ms)`);

    // 2. First query on live process.pid: exact parity with PowerShell ToFileTimeUtc() and process.ppid.
    const firstStart = await processStartTime(process.pid);
    const firstParent = await parentProcessId(process.pid);
    assert.match(String(firstStart), /^\d+$/);
    assert.equal(firstParent, process.ppid);

    const { stdout: psExpected } = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`,
    ], { encoding: 'utf8', windowsHide: true });
    assert.equal(firstStart, psExpected.trim(), 'Win32 FileTimeUtc must match PowerShell StartTime.ToFileTimeUtc()');

    // 3. Calls 2..10 on live process.pid hit in-memory cache in <2ms total (<5ms required).
    const tHit0 = performance.now();
    for (let i = 0; i < 9; i++) {
      const s = await processStartTime(process.pid);
      const p = await parentProcessId(process.pid);
      assert.equal(s, firstStart);
      assert.equal(p, process.ppid);
    }
    const hitElapsed = performance.now() - tHit0;
    assert.ok(hitElapsed < 2, `9 cached lookups took ${hitElapsed.toFixed(3)}ms, expected < 2ms`);

    // 4. Child process parentProcessId (non-self PID) and cache eviction once child exits.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    registerPid(child.pid);
    const childStart = await processStartTime(child.pid);
    const childParent = await parentProcessId(child.pid);
    assert.match(String(childStart), /^\d+$/);
    assert.equal(childParent, process.pid);

    process.kill(child.pid);
    await waitUntil(() => !isProcessAlive(child.pid), { label: 'child exit' });
    trackedPids.delete(child.pid);

    const tAfterDeath = performance.now();
    assert.equal(await processStartTime(child.pid), null);
    assert.equal(await parentProcessId(child.pid), null);
    assert.ok(performance.now() - tAfterDeath < 5, 'exited cached PID must immediately return null');
  });
