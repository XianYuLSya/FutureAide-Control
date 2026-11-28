import { execFile } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const RENDERER_DISCOVERY_BUDGET_MS = 10_000;
const discoveryMessages = {
  timeout: 'Desktop renderer discovery timed out.',
  'list-failed': 'Could not read the Desktop renderer discovery lists.',
  'no-match': 'No running Codex main renderer was found.',
  'multiple-main-targets': 'More than one running Codex main renderer was found.',
};

export function rendererDiscoveryError(discoveryReason) {
  return Object.assign(new Error(discoveryMessages[discoveryReason]), {
    code: 'codex-native-rpc-unavailable', discoveryReason, notSent: true,
  });
}

function listingFailure(error) {
  return rendererDiscoveryError(error?.discoveryReason === 'timeout' || error?.name === 'TimeoutError'
    ? 'timeout' : 'list-failed');
}

// The generated filter and port contain only numbers from a previously verified endpoint.
// WMI filters the process query; the TCP cmdlet receives the owner and loopback address.
export function rendererQuery(cached) {
  const filter = cached ? `ProcessId=${cached.pid}` : "(Name='ChatGPT.exe' OR Name='Codex.exe')";
  // Only candidate *changes* invalidate a good cache. This existence check
  // asks WMI for the PID column of competing debug-enabled main processes;
  // it never enumerates their endpoints on the warm path.
  const competitorCheck = cached ? `
$competitor = Get-CimInstance Win32_Process -Property ProcessId -Filter "(Name='ChatGPT.exe' OR Name='Codex.exe') AND SessionId=$sessionId AND ProcessId<>${cached.pid} AND CommandLine LIKE '%--remote-debugging-port=%' AND NOT CommandLine LIKE '%--type=%'"
if ($competitor) { '[]'; return }` : '';
  return String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
${competitorCheck}
$candidates = Get-CimInstance Win32_Process -Filter "${filter} AND SessionId=$sessionId"
$rows = @(foreach ($candidate in $candidates) {
  if ($candidate.Name -notmatch '^(ChatGPT|Codex)\.exe$' -or
      -not $candidate.ExecutablePath -or $candidate.CommandLine -notmatch '--remote-debugging-port=' -or
      $candidate.CommandLine -match '--type=') { continue }
  if ($candidate.ExecutablePath -notmatch '\\WindowsApps\\OpenAI\.Codex_' -and
      -not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $candidate.ExecutablePath) 'resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs'))) { continue }
  $started = $candidate.CreationDate.ToUniversalTime().Ticks.ToString()
  $debugPort = $null
  $listenerFilter = @{}
  $portArgs = [regex]::Matches($candidate.CommandLine, '(?i)(?:^|[\s"])--remote-debugging-port=(?:"(?<port>[^"]*)"|(?<port>[^\s"]*))(?=$|[\s"])')
  if ($portArgs.Count -eq 1 -and $portArgs[0].Groups['port'].Value -match '^[0-9]{1,5}$') {
    $portNumber = [int]$Matches[0]
    if ($portNumber -ge 1 -and $portNumber -le 65535) {
      $debugPort = $portNumber
      $listenerFilter.LocalPort = $portNumber
    }
  }
  try {
    $listeners = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -OwningProcess $candidate.ProcessId @listenerFilter -ErrorAction Stop
  } catch {
    if ($_.FullyQualifiedErrorId -ne 'CmdletizationQuery_NotFound,Get-NetTCPConnection') { throw }
    continue
  }
  foreach ($listener in $listeners) {
    [pscustomobject]@{ pid = $candidate.ProcessId; port = $listener.LocalPort; started = $started; listenerStarted = [string]$listener.CreationTime.Ticks; debugPort = $debugPort }
  }
})
ConvertTo-Json -InputObject @($rows) -Compress`;
}

const runFile = promisify(execFile);
const queryScript = fileURLToPath(new URL('./codex-renderer-query.js', import.meta.url));

async function queryEndpoints(cached, timeout) {
  if (process.platform !== 'win32') throw rendererDiscoveryError('list-failed');
  const system = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const deadline = performance.now() + timeout;
  async function run(program, args) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0) throw rendererDiscoveryError('timeout');
    const { stdout } = await runFile(path.win32.join(system, program), args, {
      timeout: remaining, windowsHide: true, encoding: 'utf8', maxBuffer: 65536,
    });
    return stdout.trim();
  }
  try {
    const args = ['//NoLogo', '//E:JScript', queryScript, String(process.pid)];
    if (cached) args.push(String(cached.pid));
    const lines = (await run('cscript.exe', args)).split(/\r?\n/);
    if (lines.pop() === 'OK') {
      return lines.map(line => {
        const [pid, port, started, listenerStarted, debugPort] = line.split('\t');
        return { pid: Number(pid), port: Number(port), started, listenerStarted, debugPort: Number(debugPort) || null };
      });
    }
  } catch (error) {
    if (error.killed || error.discoveryReason === 'timeout') throw rendererDiscoveryError('timeout');
  }
  // Windows Script Host can be disabled by local policy. Retain the original
  // provider and spend only the time left on this discovery attempt.
  try {
    return JSON.parse(await run('WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', rendererQuery(cached)]));
  } catch (error) {
    throw rendererDiscoveryError(error.killed || error.discoveryReason === 'timeout' ? 'timeout' : 'list-failed');
  }
}

async function readPages(port, timeout, debugPort) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
  // A dynamic-port lookup can include ordinary HTTP listeners owned by this process.
  if (response.status === 404 && port !== debugPort) return [];
  if (!response.ok) throw rendererDiscoveryError('list-failed');
  return response.json();
}

const listenerIdentity = row => [row.pid, row.started, row.port, row.listenerStarted ?? ''].join('/');
const validListener = row => Number.isSafeInteger(row?.pid) && row.pid > 0 && Number.isSafeInteger(row.port)
  && row.port >= 1 && row.port <= 65535 && typeof row.started === 'string' && row.started;

function mainPageUrl(page, port) {
  if (page?.type !== 'page' || page.url !== 'app://-/index.html' || typeof page.id !== 'string' || !page.id
    || typeof page.webSocketDebuggerUrl !== 'string') return;
  try {
    const ws = new URL(page.webSocketDebuggerUrl);
    if (ws.protocol === 'ws:' && ws.hostname === '127.0.0.1' && ws.port === String(port)
      && ws.pathname === '/devtools/page/' + page.id && !ws.username && !ws.password && !ws.search && !ws.hash) return ws.href;
  } catch { /* An invalid target URL cannot identify a renderer. */ }
}

export function createRendererDiscovery({ query = queryEndpoints, pages = readPages } = {}) {
  let cached, inFlight;
  async function discover(deadline) {
    const remaining = () => {
      const ms = Math.ceil(deadline - performance.now());
      if (ms <= 0) throw rendererDiscoveryError('timeout');
      return ms;
    };
    async function matches(hint) {
      let rows;
      try { rows = await query(hint, remaining()); }
      catch (error) { throw listingFailure(error); }
      remaining();
      if (!Array.isArray(rows) || !rows.every(validListener)) throw rendererDiscoveryError('list-failed');
      const listeners = [...new Map(rows.map(row => [listenerIdentity(row), row])).values()];
      const listenerSetFor = pid => listeners.filter(row => row.pid === pid).map(listenerIdentity).sort().join(',');
      if (hint && (listeners.some(row => row.pid !== hint.pid) || listenerSetFor(hint.pid) !== hint.listenerSet)) return;
      let found, failure;
      // Even an unchanged listener can begin publishing a second main page.
      for (const row of listeners) {
        const timeout = Math.min(1500, remaining());
        let targets;
        try {
          targets = await pages(row.port, timeout, row.debugPort);
          if (!Array.isArray(targets)) throw rendererDiscoveryError('list-failed');
        } catch (error) {
          const currentFailure = listingFailure(error);
          if (!failure || currentFailure.discoveryReason === 'timeout') failure = currentFailure;
          continue;
        }
        remaining();
        for (const page of targets) {
          const webSocketUrl = mainPageUrl(page, row.port);
          if (!webSocketUrl || found?.webSocketUrl === webSocketUrl) continue;
          if (found) throw rendererDiscoveryError('multiple-main-targets');
          found = { ...row, targetId: page.id, webSocketUrl, listenerSet: listenerSetFor(row.pid) };
        }
      }
      if (failure) throw failure;
      return found;
    }
    if (cached) {
      const previous = cached;
      cached = undefined;
      const found = await matches(previous);
      if (found?.port === previous.port && found.targetId === previous.targetId) return cached = found;
    }
    const found = await matches(null);
    if (!found) throw rendererDiscoveryError('no-match');
    return cached = found;
  }
  return function discoverOnce() {
    if (!inFlight) {
      const deadline = performance.now() + RENDERER_DISCOVERY_BUDGET_MS;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(rendererDiscoveryError('timeout')), RENDERER_DISCOVERY_BUDGET_MS);
      });
      inFlight = Promise.race([discover(deadline), timeout]).finally(() => {
        clearTimeout(timer);
        inFlight = undefined;
      });
    }
    return inFlight;
  };
}

export const discoverCodexRenderer = createRendererDiscovery();
