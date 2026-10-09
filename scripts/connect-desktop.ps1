[CmdletBinding()]
param(
    [string]$DshCli,
    [string]$DataRoot,
    [string]$Config
)
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
if (-not $DshCli) { $DshCli = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' }
if (-not (Test-Path -LiteralPath $DshCli)) { throw 'Cannot find the desktop DSH CLI. Supply -DshCli with its absolute path.' }
if (-not $DataRoot) { $DataRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
$profileDirectory = Join-Path $DataRoot 'profiles\desktop'
$manifestFile = Join-Path $profileDirectory 'package.json'
$manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
$plugin = Join-Path $source 'dsh-plugin'
$node = (Get-Command node -ErrorAction Stop).Source
$cli = Join-Path $source 'src\cli.mjs'
$configArgs = if ($Config) { @('--config', $Config) } else { @() }
if (-not $manifest.dependencies.'dsh-control-discovery') {
    $controlRoot = if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'futureaide-control' } else { Join-Path $env:USERPROFILE '.codex\futureaide-control' }
    $backup = Join-Path $controlRoot ('rollback\desktop-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    foreach ($name in @('package.json', 'cordis.patch.yml', 'pnpm-lock.yaml')) {
        $file = Join-Path $profileDirectory $name
        if (Test-Path -LiteralPath $file) { Copy-Item -LiteralPath $file -Destination (Join-Path $backup $name) }
    }
    $previousDshHome = $env:DSH_HOME
    try {
        $env:DSH_HOME = $DataRoot
        & $DshCli plugin --profile desktop add -w $plugin
        if ($LASTEXITCODE -ne 0) { throw 'DSH discovery plugin installation failed.' }
    } finally { $env:DSH_HOME = $previousDshHome }
}
$previousControlDshHome = $env:DSH_HOME
try {
$env:DSH_HOME = $DataRoot
& $node $cli desktop-host-install @configArgs --host-profile-directory $profileDirectory
if ($LASTEXITCODE -ne 0) { throw 'Desktop capability bridge installation failed.' }
# Allow the native profile watcher to reconcile the owned row before connect;
# otherwise the old compatibility bootstrap would create an unnecessary session.
$bridgeReady = $false
for ($attempt = 0; $attempt -lt 10; $attempt++) {
    & $node $cli host-status @configArgs 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $bridgeReady = $true; break }
    Start-Sleep -Seconds 1
}
if (-not $bridgeReady) { throw 'The desktop host has not loaded the bridge. Check its plugin panel; no application was restarted.' }
& $node $cli connect @configArgs --request-id ('desktop-connect-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
if ($LASTEXITCODE -ne 0) { throw 'The host has not loaded the bridge. Check the DSH plugin panel; no application was restarted.' }
} finally { $env:DSH_HOME = $previousControlDshHome }
