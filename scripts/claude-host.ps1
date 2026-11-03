# Claude Desktop minimal UI bridge for FutureAide Control.
#
# This is the last-resort operation surface: Claude Desktop exposes no
# programmatic API for "press send" or "stop the running turn". Everything it
# does is UI Automation on the one Claude window, and every action reports what
# it actually did; the Node adapter above verifies the outcome against the
# session transcript instead of trusting this script.
#
# Contract:
#   powershell.exe -File claude-host.ps1 -Action <name> -OutFile <path>
#   stdin : one UTF-8 JSON object (all text, including every localized UI label)
#   Output: UTF-8 JSON { ok: true, value: {...} } | { ok: false, code, message }
#
# This source file is deliberately ASCII-only: Windows PowerShell 5.1 reads a
# BOM-less .ps1 as ANSI, so any non-ASCII literal here would be corrupted. All
# user-visible text arrives in the JSON payload instead.
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Stop'

function Write-Result($value) {
  $json = $value | ConvertTo-Json -Depth 8 -Compress
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Write-Failure([string]$code, [string]$message) {
  Write-Result @{ ok = $false; code = $code; message = $message } | Out-Null
}

function Read-Payload {
  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
  $raw = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { return [pscustomobject]@{} }
  try { return $raw | ConvertFrom-Json } catch { throw "payload is not JSON: $($_.Exception.Message)" }
}

function Initialize-Uia {
  Add-Type -AssemblyName UIAutomationClient | Out-Null
  Add-Type -AssemblyName UIAutomationTypes | Out-Null
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
}

function Add-Win32 {
  if ('FutureAideHost.Win32' -as [type]) { return }
  Add-Type -Namespace FutureAideHost -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, IntPtr dwExtraInfo);
'@ | Out-Null
}

$script:TrueCondition = $null

function Get-Condition {
  if ($null -eq $script:TrueCondition) {
    $script:TrueCondition = [System.Windows.Automation.Condition]::TrueCondition
  }
  return $script:TrueCondition
}

function Get-ClaudeWindow {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $procs = @(Get-Process -Name 'claude' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  foreach ($proc in $procs) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
    $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)
    foreach ($window in $windows) {
      if ($window.Current.ClassName -ne 'Chrome_WidgetWin_1') { continue }
      return [pscustomobject]@{ Element = $window; Pid = $proc.Id; Title = $window.Current.Name; Path = $proc.Path }
    }
  }
  throw 'claude-window-not-found'
}

function Get-WebRoot($window) {
  $documents = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Document)))
  $best = $null
  $bestCount = -1
  foreach ($document in $documents) {
    $count = $document.FindAll([System.Windows.Automation.TreeScope]::Descendants, (Get-Condition)).Count
    if ($document.Current.AutomationId -eq 'RootWebArea' -and $count -gt $bestCount) {
      $best = $document
      $bestCount = $count
    }
  }
  if ($null -eq $best -and $documents.Count -gt 0) { $best = $documents.Item(0) }
  return [pscustomobject]@{ Element = $best; DocumentName = $(if ($null -ne $best) { $best.Current.Name } else { '' }) }
}

function Find-Elements($root, [string]$pattern, [string]$controlType) {
  if ($null -eq $root) { return @() }
  $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (Get-Condition))
  $found = @()
  foreach ($element in $elements) {
    try {
      if ($controlType -and $element.Current.ControlType.ProgrammaticName -ne "ControlType.$controlType") { continue }
      $name = $element.Current.Name
      if ([string]::IsNullOrEmpty($name)) { continue }
      if ($pattern -and ($name -notmatch $pattern)) { continue }
      $found += $element
    } catch { }
  }
  return $found
}

function Invoke-Element($element) {
  if ($null -eq $element) { throw 'element-missing' }
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return 'invoke'
  } catch { }
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $pattern.Select()
    return 'select'
  } catch { }
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    $pattern.DoDefaultAction()
    return 'legacy'
  } catch { }
  $rect = $element.Current.BoundingRectangle
  if ($rect.IsEmpty) { throw 'element-not-clickable' }
  Add-Win32
  [FutureAideHost.Win32]::SetCursorPos([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2)) | Out-Null
  [FutureAideHost.Win32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [FutureAideHost.Win32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  return 'mouse'
}

function Focus-Window($window) {
  Add-Win32
  $handle = [IntPtr]$window.Current.NativeWindowHandle
  if ([FutureAideHost.Win32]::IsIconic($handle)) { [FutureAideHost.Win32]::ShowWindow($handle, 9) | Out-Null }
  [FutureAideHost.Win32]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 180
}

function Send-Keys([string]$keys) {
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}

function Unescape-Pattern([string]$value) {
  return [regex]::Escape($value)
}

try {
  Initialize-Uia
  $payload = Read-Payload
  $patterns = $payload.patterns
  $window = Get-ClaudeWindow
  $web = Get-WebRoot $window.Element
  $composerPattern = if ($patterns -and $patterns.composer) { $patterns.composer } else { '^$' }
  $modelPattern = if ($patterns -and $patterns.modelButton) { $patterns.modelButton } else { '^$' }
  $stopPattern = if ($patterns -and $patterns.stop) { $patterns.stop } else { '^$' }
  $sendPattern = if ($patterns -and $patterns.send) { $patterns.send } else { '^$' }
  $folderPattern = if ($patterns -and $patterns.newInFolder) { $patterns.newInFolder } else { '^$' }
  $newPattern = if ($patterns -and $patterns.newSession) { $patterns.newSession } else { '^$' }

  switch ($Action) {
    'probe' {
      $composers = Find-Elements $web.Element $composerPattern 'Edit'
      $models = Find-Elements $web.Element $modelPattern 'Button'
      Write-Result @{ ok = $true; value = @{
        available = $true
        window = @{ pid = $window.Pid; title = $window.Title; executable = $window.Path }
        documentName = $web.DocumentName
        composerFound = ($composers.Count -gt 0)
        modelControlFound = ($models.Count -gt 0)
        modelLabel = $(if ($models.Count -gt 0) { $models[0].Current.Name } else { $null })
      } }
    }
    'view' {
      $composers = Find-Elements $web.Element $composerPattern 'Edit'
      $models = Find-Elements $web.Element $modelPattern 'Button'
      Write-Result @{ ok = $true; value = @{
        available = $true
        documentName = $web.DocumentName
        windowTitle = $window.Title
        composerFound = ($composers.Count -gt 0)
        modelLabel = $(if ($models.Count -gt 0) { $models[0].Current.Name } else { $null })
      } }
    }
    'submit' {
      Focus-Window $window.Element
      $composers = Find-Elements $web.Element $composerPattern 'Edit'
      if ($composers.Count -eq 0) { throw 'composer-not-found' }
      $composer = $composers[0]
      Invoke-Element $composer | Out-Null
      Start-Sleep -Milliseconds 120
      $typed = $false
      $prefilled = [bool]$payload.prefilled
      if (-not $prefilled -and $payload.prompt) {
        $previous = ''
        try { $previous = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { }
        Set-Clipboard -Value ([string]$payload.prompt)
        Send-Keys '^v'
        Start-Sleep -Milliseconds 200
        if ($null -ne $previous) { try { Set-Clipboard -Value $previous } catch { } }
        $typed = $true
      }
      Send-Keys '{ENTER}'
      Write-Result @{ ok = $true; value = @{
        method = $(if ($typed) { 'clipboard-type-then-enter' } else { 'enter-on-prefilled-composer' })
        typed = $typed
        composerFound = $true
      } }
    }
    'interrupt' {
      Focus-Window $window.Element
      Send-Keys '{ESC}'
      $method = 'escape'
      Start-Sleep -Milliseconds 250
      $stops = Find-Elements $web.Element $stopPattern 'Button'
      if ($stops.Count -gt 0) {
        try { Invoke-Element $stops[0] | Out-Null; $method = 'escape+stop-button' } catch { }
      }
      Write-Result @{ ok = $true; value = @{ method = $method; stopButtonFound = ($stops.Count -gt 0) } }
    }
    'model-read' {
      $models = Find-Elements $web.Element $modelPattern 'Button'
      if ($models.Count -eq 0) { Write-Result @{ ok = $true; value = @{ raw = $null } }; break }
      Write-Result @{ ok = $true; value = @{ raw = $models[0].Current.Name } }
    }
    'model-select' {
      $models = Find-Elements $web.Element $modelPattern 'Button'
      if ($models.Count -eq 0) { throw 'model-control-not-found' }
      Invoke-Element $models[0] | Out-Null
      Start-Sleep -Milliseconds 450
      $label = [string]$payload.label
      $options = Find-Elements $web.Element ('^' + (Unescape-Pattern $label)) ''
      if ($options.Count -eq 0) { Send-Keys '{ESC}'; throw "model-option-not-found:$label" }
      Invoke-Element $options[0] | Out-Null
      Start-Sleep -Milliseconds 400
      $after = Find-Elements $web.Element $modelPattern 'Button'
      Write-Result @{ ok = $true; value = @{
        clicked = $label
        observed = $(if ($after.Count -gt 0) { $after[0].Current.Name } else { $null })
      } }
    }
    'reveal' {
      $revealed = $false
      $method = $null
      $hostSessionId = [string]$payload.hostSessionId
      if ($payload.allowDeepLink -and $hostSessionId -match '^local_[A-Za-z0-9-]{1,64}$') {
        $url = 'claude://code/continue?session=' + [uri]::EscapeDataString($hostSessionId)
        Start-Process -FilePath $window.Path -ArgumentList $url
        $method = 'deep-link-continue'
        Start-Sleep -Milliseconds 1500
        $revealed = $true
      } elseif ($payload.title) {
        $titlePattern = '^' + (Unescape-Pattern ([string]$payload.title))
        $titles = Find-Elements $web.Element $titlePattern 'Button'
        if ($titles.Count -eq 0) { throw "session-entry-not-found:$($payload.title)" }
        Invoke-Element $titles[0] | Out-Null
        $method = 'sidebar-entry'
        $revealed = $true
      }
      if (-not $revealed) { throw 'no-reveal-strategy' }
      Write-Result @{ ok = $true; value = @{ revealed = $true; method = $method } }
    }
    'new-session' {
      $workspace = [string]$payload.workspace
      $prompt = [string]$payload.prompt
      $folderLabel = [string]$payload.folderLabel
      $strategy = $null
      $prefilled = $false
      if ($payload.allowDeepLink) {
        $query = 'claude://code/new?src=external&folder=' + [uri]::EscapeDataString($workspace)
        if ($prompt) { $query += '&q=' + [uri]::EscapeDataString($prompt) }
        Start-Process -FilePath $window.Path -ArgumentList $query
        Start-Sleep -Milliseconds 1800
        $strategy = 'deep-link-code-new'
        $prefilled = [bool]$prompt
      } else {
        $anchors = Find-Elements $web.Element $folderPattern 'Button' | Where-Object { $_.Current.Name -match (Unescape-Pattern $folderLabel) }
        if ($anchors.Count -eq 0) {
          $fallback = Find-Elements $web.Element $newPattern 'Button'
          if ($fallback.Count -eq 0) { throw 'new-session-control-not-found' }
          $anchors = @($fallback[0])
        }
        Invoke-Element $anchors[0] | Out-Null
        Start-Sleep -Milliseconds 900
        $strategy = 'sidebar-new-session'
      }
      Write-Result @{ ok = $true; value = @{ strategy = $strategy; prefilled = $prefilled; workspace = $workspace } }
    }
    default { throw "unknown-action:$Action" }
  }
} catch {
  Write-Failure 'ui-bridge-error' $_.Exception.Message
}
