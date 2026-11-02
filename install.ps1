[CmdletBinding()]
param(
    [string]$CodexHome,
    [string]$DshHome,
    [switch]$SkipHost
)
$ErrorActionPreference = 'Stop'
if ([IO.Path]::GetPathRoot($PSScriptRoot).TrimEnd('\') -ieq 'C:') {
    throw 'Keep the runtime package on D: or another non-C: drive before installing. Setup will not move or delete anything on C:.'
}
$nodePath = (Get-Command node -ErrorAction Stop).Source
& $nodePath -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 24 || (major === 24 && minor < 14)) { process.stderr.write('Node.js 24.14 or newer is required.\n'); process.exit(1); }"
if ($LASTEXITCODE -ne 0) { throw 'Update Node.js before installing FutureAide Control.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\@modelcontextprotocol\sdk\package.json'))) {
    $runtime = Join-Path $PSScriptRoot '.runtime'
    $npmCache = Join-Path $runtime 'npm-cache'
    $installTemp = Join-Path $runtime 'temp'
    New-Item -ItemType Directory -Path $npmCache, $installTemp -Force | Out-Null
    $previousCache = $env:npm_config_cache
    $previousTemp = $env:TEMP
    $previousTmp = $env:TMP
    Push-Location $PSScriptRoot
    try {
        $env:npm_config_cache = $npmCache
        $env:TEMP = $installTemp
        $env:TMP = $installTemp
        & npm install --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the bundled Node dependencies.' }
    } finally {
        Pop-Location
        $env:npm_config_cache = $previousCache
        $env:TEMP = $previousTemp
        $env:TMP = $previousTmp
    }
}
$installerArgs = @((Join-Path $PSScriptRoot 'scripts\install-plugin.mjs'))
if ($CodexHome) { $installerArgs += @('--codex-home', $CodexHome) }
if ($DshHome) { $installerArgs += @('--dsh-home', $DshHome) }
if ($SkipHost) { $installerArgs += '--skip-host' }
& $nodePath @installerArgs
if ($LASTEXITCODE -ne 0) { throw 'FutureAide Control setup is incomplete. See the error above.' }
