[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($PSScriptRoot)
$pluginName = 'futureaide-control'
$pluginParent = Join-Path $env:USERPROFILE 'plugins'
$destination = [System.IO.Path]::GetFullPath((Join-Path $pluginParent $pluginName))
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$creator = Join-Path $codexRoot 'skills\.system\plugin-creator'
$marketplace = Join-Path $env:USERPROFILE '.agents\plugins\marketplace.json'
$backupRoot = Join-Path $codexRoot 'futureaide-control\rollback'
$nodePath = (Get-Command node -ErrorAction Stop).Source

if ($destination -eq $source) { throw 'Install destination must differ from the source.' }
$backup = $null
if (Test-Path -LiteralPath $destination) {
    $backup = Join-Path $backupRoot (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Copy-Item -LiteralPath $destination -Destination (Join-Path $backup 'plugin') -Recurse
    if (Test-Path -LiteralPath $marketplace) {
        Copy-Item -LiteralPath $marketplace -Destination (Join-Path $backup 'marketplace.before.json')
    }
} else {
    & python -X utf8 (Join-Path $creator 'scripts\create_basic_plugin.py') $pluginName --with-mcp --with-skills --with-marketplace
    if ($LASTEXITCODE -ne 0) { throw 'Personal plugin scaffold failed.' }
}

foreach ($name in @('.codex-plugin', 'skills', 'src', 'dsh-plugin')) {
    $target = Join-Path $destination $name
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $source $name) -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
    }
}
foreach ($name in @('package.json', 'package-lock.json', 'README.md')) {
    Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $destination $name) -Force
}

$mcp = @{ mcpServers = @{ futureaide = @{
    command = $nodePath
    args = @((Join-Path $destination 'src\mcp-server.mjs'))
    startup_timeout_sec = 15
    tool_timeout_sec = 60
} } }
[System.IO.File]::WriteAllText((Join-Path $destination '.mcp.json'), ($mcp | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))

Push-Location $destination
try {
    & npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Plugin dependency install failed.' }
} finally { Pop-Location }

& python -X utf8 (Join-Path $creator 'scripts\update_plugin_cachebuster.py') $destination
if ($LASTEXITCODE -ne 0) { throw 'Plugin cache version update failed.' }
& python -X utf8 (Join-Path $creator 'scripts\validate_plugin.py') $destination
if ($LASTEXITCODE -ne 0) { throw 'Plugin manifest validation failed.' }
$marketName = & python -X utf8 (Join-Path $creator 'scripts\read_marketplace_name.py')
if ($LASTEXITCODE -ne 0) { throw 'Marketplace name validation failed.' }
& codex plugin add "$pluginName@$($marketName.Trim())" --json
if ($LASTEXITCODE -ne 0) { throw "Codex plugin registration failed. Previous plugin copy: $backup" }

if (Test-Path -LiteralPath $backupRoot) {
    $prefix = [System.IO.Path]::GetFullPath($backupRoot).TrimEnd('\') + '\'
    Get-ChildItem -LiteralPath $backupRoot -Directory | Sort-Object Name -Descending | Select-Object -Skip 2 | ForEach-Object {
        $target = [System.IO.Path]::GetFullPath($_.FullName)
        if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid rollback cleanup target.' }
        if ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Refusing to recursively clean a linked rollback directory.' }
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

Write-Output "Installed $pluginName at $destination"
if ($backup) { Write-Output "Previous plugin: $backup" }
