import { execFile } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const unavailable = message => Object.assign(new Error(message), { code: 'codex-native-rpc-unavailable' });
const discoveryBudgetMs = 10_000;

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
$rows = foreach ($candidate in $candidates) {
  if ($candidate.Name -notmatch '^(ChatGPT|Codex)\.exe$' -or
      -not $candidate.ExecutablePath -or $candidate.CommandLine -notmatch '--remote-debugging-port=' -or
      $candidate.CommandLine -match '--type=') { continue }
  if ($candidate.ExecutablePath -notmatch '\\WindowsApps\\OpenAI\.Codex_' -and
      -not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $candidate.ExecutablePath) 'resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs'))) { continue }
  $started = $candidate.CreationDate.ToUniversalTime().Ticks.ToString()
  $listeners = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -OwningProcess $candidate.ProcessId -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    [pscustomobject]@{ pid = $candidate.ProcessId; port = $listener.LocalPort; started = $started; listenerStarted = [string]$listener.CreationTime.Ticks }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress`;
}

async function queryEndpoints(cached, timeout) {
  if (process.platform !== 'win32') throw unavailable('Desktop renderer discovery is currently implemented for Windows.');
  const shell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', rendererQuery(cached)], {
      timeout, windowsHide: true, encoding: 'utf8', maxBuffer: 65536,
    }, (error, stdout) => {
      if (error) return reject(unavailable('Could not locate the running Desktop native endpoint.'));
      try { resolve(JSON.parse(stdout.trim() || '[]')); }
      catch { reject(unavailable('The Desktop native endpoint discovery returned an invalid response.')); }
    });
  });
}

async function readPages(port, timeout) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!response.ok) return [];
  return response.json();
}

export function createRendererDiscovery({ query = queryEndpoints, pages = readPages } = {}) {
  let cached, inFlight;
  async function discover() {
    const deadline = performance.now() + discoveryBudgetMs;
    const remaining = () => {
      const ms = Math.ceil(deadline - performance.now());
      if (ms <= 0) throw unavailable('Desktop renderer discovery timed out.');
      return ms;
    };
    async function matches(hint) {
      const rows = await query(hint, remaining());
      if (!Array.isArray(rows)) throw unavailable('Invalid Desktop native endpoint discovery result.');
      const valid = rows.filter(row => Number.isSafeInteger(row?.pid) && row.pid > 0 && Number.isSafeInteger(row.port)
        && row.port >= 1 && row.port <= 65535 && typeof row.started === 'string' && row.started);
      const listeners = valid.filter(row => !hint || row.pid === hint.pid);
      const identity = row => [row.pid, row.started, row.port, row.listenerStarted ?? ''].join('/');
      const listenerSet = listeners.map(identity).sort().join(',');
      if (hint && (listeners.length !== valid.length || listenerSet !== hint.listenerSet)) return [];
      const found = [];
      for (const row of hint ? listeners.filter(row => row.port === hint.port) : valid) {
        const timeout = Math.min(1500, remaining());
        try {
          for (const page of await pages(row.port, timeout)) {
            if (page.type !== 'page' || page.url !== 'app://-/index.html' || typeof page.id !== 'string' || !page.id) continue;
            const ws = new URL(page.webSocketDebuggerUrl);
            if (ws.protocol === 'ws:' && ws.hostname === '127.0.0.1' && ws.port === String(row.port)
              && ws.pathname === '/devtools/page/' + page.id && !ws.username && !ws.password && !ws.search && !ws.hash) {
              found.push({ ...row, targetId: page.id, webSocketUrl: ws.href,
                listenerSet: hint ? hint.listenerSet : valid.filter(item => item.pid === row.pid).map(identity).sort().join(',') });
            }
          }
        } catch { /* A listener that does not expose DevTools is not a renderer. */ }
      }
      return found;
    }
    if (cached) {
      const previous = cached;
      let found;
      try { found = await matches(previous); } catch { /* Retry bounded name-based discovery. */ }
      if (found?.length === 1 && found[0].port === previous.port && found[0].targetId === previous.targetId) return found[0];
      cached = undefined;
    }
    const found = await matches(null);
    if (found.length !== 1) throw unavailable('Exactly one running Codex main renderer must be available.');
    cached = found[0];
    return cached;
  }
  return function discoverOnce() {
    inFlight ??= discover().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

export const discoverCodexRenderer = createRendererDiscovery();
