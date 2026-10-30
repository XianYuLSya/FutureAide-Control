import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/recover-codex.ps1', import.meta.url));
function run(source) {
  const command = `$ProgressPreference = 'SilentlyContinue'\n. $env:FUTUREAIDE_RECOVERY_SCRIPT\n${source}`;
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    env: { ...process.env, FUTUREAIDE_RECOVERY_SCRIPT: script }, encoding: 'utf8', windowsHide: true,
  }).trim();
}
const fixture = `
$desktop = [pscustomobject]@{ Name='ChatGPT.exe'; ProcessId=100; ParentProcessId=1; CreationDate='2026-10-30'; ExecutablePath='D:\\Apps\\Codex\\ChatGPT.exe'; CommandLine='"D:\\Apps\\Codex\\ChatGPT.exe" --proxy-server=http://127.0.0.1:17911 --accept-lang=en-US' }
$child = [pscustomobject]@{ Name='codex.exe'; ProcessId=101; ParentProcessId=100; CommandLine='codex.exe app-server' }
$renderer = [pscustomobject]@{ Name='ChatGPT.exe'; ProcessId=102; ParentProcessId=100; ExecutablePath=$desktop.ExecutablePath; CommandLine='"D:\\Apps\\Codex\\ChatGPT.exe" --type=renderer' }
$other = [pscustomobject]@{ Name='ChatGPT.exe'; ProcessId=200; ParentProcessId=1; ExecutablePath='D:\\Apps\\Other\\ChatGPT.exe'; CommandLine='"D:\\Apps\\Other\\ChatGPT.exe"' }
$valid = { param($value) $value -eq 'D:\\Apps\\Codex\\ChatGPT.exe' }
`;

test('recovery selects the verified desktop, not its renderers or another app, and preserves proxy options', { skip: process.platform !== 'win32' }, () => {
  const result = JSON.parse(run(fixture + '\nSelect-CodexDesktop -Processes @($desktop,$child,$renderer,$other) -ValidatePath $valid | ConvertTo-Json -Compress'));
  assert.equal(result.ProcessId, 100);
  assert.deepEqual(result.AppServerProcessIds, [101]);
  assert.equal(result.Arguments, '--proxy-server=http://127.0.0.1:17911 --accept-lang=en-US');
  assert.deepEqual(result.DescendantProcessIds.sort(), [100, 101, 102]);
});

test('recovery refuses ambiguous desktops instead of stopping all matching processes', { skip: process.platform !== 'win32' }, () => {
  assert.match(run(fixture + `
$second = $desktop.PSObject.Copy(); $second.ProcessId = 300
try { Select-CodexDesktop -Processes @($desktop,$second) -ValidatePath $valid; throw 'unexpected selection' }
catch { $_.Exception.Message }
`), /More than one Codex desktop/);
});

test('recovery refuses a launch command that does not match the verified executable', { skip: process.platform !== 'win32' }, () => {
  assert.match(run(`try { Get-CodexLaunchArguments 'D:\\Apps\\Codex\\ChatGPT.exe' 'something-else.exe --flag' }
catch { $_.Exception.Message }`), /Cannot preserve the original Codex launch command/);
});

test('recovery cannot kill its own Codex parent, even without a thread environment variable', { skip: process.platform !== 'win32' }, () => {
  assert.match(run(fixture + `
$target = Select-CodexDesktop -Processes @($desktop,$child) -ValidatePath $valid
try { Assert-ExternalRecovery $target -CallerPid 101 -ThreadId '' }
catch { $_.Exception.Message }
`), /Start recover.cmd from File Explorer/);
});
