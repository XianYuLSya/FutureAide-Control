[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$RestartCodex,
    [switch]$Interactive
)

$ErrorActionPreference = 'Stop'

function Test-CodexDesktopPath {
    param([string]$ExecutablePath)
    if (-not $ExecutablePath) { return $false }
    $root = Split-Path -Parent $ExecutablePath
    $entry = Join-Path $root 'resources\plugins\openai-bundled\plugins\codex-app-tools\server.mjs'
    return (Test-Path -LiteralPath $entry -PathType Leaf)
}

function Get-CodexLaunchArguments {
    param([string]$ExecutablePath, [string]$CommandLine)
    $prefix = '^\s*(?:"' + [regex]::Escape($ExecutablePath) + '"|' + [regex]::Escape($ExecutablePath) + ')(?=\s|$)'
    $match = [regex]::Match($CommandLine, $prefix, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) { throw 'Cannot preserve the original Codex launch command. No process was stopped.' }
    return $CommandLine.Substring($match.Length).TrimStart()
}

function Select-CodexDesktop {
    param(
        [object[]]$Processes,
        [scriptblock]$ValidatePath = { param($value) Test-CodexDesktopPath $value }
    )
    $candidates = @($Processes | Where-Object {
        $_.Name -in @('ChatGPT.exe', 'Codex.exe') -and
        $_.ExecutablePath -and $_.CommandLine -and
        $_.CommandLine -notmatch '(?i)(?:^|\s)--type(?:=|\s)' -and
        (& $ValidatePath $_.ExecutablePath)
    })
    if ($candidates.Count -eq 0) { throw 'No running Codex desktop was found. Open Codex normally, then retry the tool in the affected chat.' }
    if ($candidates.Count -ne 1) { throw 'More than one Codex desktop was found. Close the extra desktop before using recovery.' }
    $desktop = $candidates[0]
    $arguments = Get-CodexLaunchArguments $desktop.ExecutablePath $desktop.CommandLine
    $descendants = @{}
    $descendants[[int]$desktop.ProcessId] = $true
    do {
        $added = $false
        foreach ($process in $Processes) {
            if ($descendants.ContainsKey([int]$process.ParentProcessId) -and -not $descendants.ContainsKey([int]$process.ProcessId)) {
                $descendants[[int]$process.ProcessId] = $true
                $added = $true
            }
        }
    } while ($added)
    $servers = @($Processes | Where-Object {
        $_.Name -eq 'codex.exe' -and $_.CommandLine -match '(?:^|\s)app-server(?:\s|$)' -and
        $descendants.ContainsKey([int]$_.ProcessId)
    })
    return [pscustomobject]@{
        ProcessId = [int]$desktop.ProcessId
        CreatedAt = $desktop.CreationDate
        ExecutablePath = $desktop.ExecutablePath
        Arguments = $arguments
        AppServerProcessIds = @($servers | ForEach-Object { [int]$_.ProcessId })
        DescendantProcessIds = @($descendants.Keys)
    }
}

function Assert-ExternalRecovery {
    param($Target, [int]$CallerPid = $PID, [string]$ThreadId = $env:CODEX_THREAD_ID)
    if ($ThreadId -or $Target.DescendantProcessIds -contains $CallerPid) {
        throw 'Start recover.cmd from File Explorer, outside Codex. Restarting from inside Codex would stop this recovery process too. Use -Check for read-only diagnosis here.'
    }
}

function Invoke-CodexRecovery {
    param([switch]$Restart, [switch]$ShowMenu)
    $allProcesses = @(Get-CimInstance Win32_Process)
    $target = Select-CodexDesktop -Processes $allProcesses
    if (-not $Restart -and -not $ShowMenu) {
        [pscustomobject]@{
            action = 'check'
            desktopFound = $true
            desktopPid = $target.ProcessId
            appServerPids = @($target.AppServerProcessIds)
            executable = $target.ExecutablePath
            launchArgumentsWillBePreserved = $true
            chatTransportVerified = $false
            next = 'If a chat returns Transport closed, open recover.cmd outside Codex. After restart, call futureaide_status and futureaide_list_agents in each affected chat.'
        } | ConvertTo-Json -Depth 3
        return
    }
    Assert-ExternalRecovery $target
    Write-Host 'FutureAide Control - Codex connection recovery'
    Write-Host ('Codex desktop PID: ' + $target.ProcessId)
    Write-Host 'This fully restarts Codex and interrupts its active chats.'
    Write-Host 'DSH is not restarted. Saved chats, agent records and project files are not deleted.'
    Write-Host 'The original Codex executable and launch options are preserved.'
    if ($ShowMenu) {
        $choice = Read-Host 'Enter R to restart Codex, or press Enter to cancel'
        if ($choice -cne 'R' -and $choice -cne 'r') { Write-Host 'Cancelled.'; return }
    }
    # Recheck the exact process after the user has read the prompt. Never kill by image name.
    $current = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $target.ProcessId)
    if (-not $current -or $current.ExecutablePath -ne $target.ExecutablePath -or $current.CreationDate -ne $target.CreatedAt) {
        throw 'The Codex process changed during recovery. Run recovery again; no process was stopped.'
    }
    # A window close can leave the desktop backend and old transports alive. A process-tree
    # restart releases those handles as well. This helper must be outside that tree.
    & "$env:SystemRoot\System32\taskkill.exe" /PID $target.ProcessId /T /F
    if ($LASTEXITCODE -ne 0) { throw 'Codex could not be stopped completely. It was not relaunched.' }
    $remaining = Get-Process -Id $target.ProcessId -ErrorAction SilentlyContinue
    if ($remaining) {
        try { $remaining.WaitForExit(10000) | Out-Null } catch { }
        if (-not $remaining.HasExited) { throw 'Codex is still running. It was not relaunched.' }
    }
    $launch = @{
        FilePath = $target.ExecutablePath
        WorkingDirectory = (Split-Path -Parent $target.ExecutablePath)
        WindowStyle = 'Normal'
    }
    if ($target.Arguments) { $launch.ArgumentList = $target.Arguments }
    try { Start-Process @launch | Out-Null }
    catch { throw ('Codex stopped, but relaunch failed. Open Codex from Start. Details: ' + $_.Exception.Message) }
    Write-Host 'Codex relaunched. Verify status and agent list in each affected chat.'
    Write-Host 'A new process alone does not prove that an old chat has reconnected.'
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if ($Check -and ($RestartCodex -or $Interactive)) { throw 'Use -Check separately from restart options.' }
        Invoke-CodexRecovery -Restart:$RestartCodex -ShowMenu:$Interactive
    } catch {
        [Console]::Error.WriteLine($_.Exception.Message)
        exit 1
    }
}
