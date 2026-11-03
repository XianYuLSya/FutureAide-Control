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

function Invoke-ElementByMouse($element) {
  if ($null -eq $element) { throw 'element-missing' }
  Add-Win32
  $point = $element.GetClickablePoint()
  [FutureAideHost.Win32]::SetCursorPos([int]$point.X, [int]$point.Y) | Out-Null
  [FutureAideHost.Win32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [FutureAideHost.Win32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  return @{ x = [int]$point.X; y = [int]$point.Y }
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

# Deep links go through the registered protocol handler by default: that is the
# user's own launch entry, so the running instance keeps its data root, account
# and window. The executable path is only used when the caller asks for it.
function Test-PrimaryContext([int]$primaryPid, [string]$executable) {
  $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $primaryPid) -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  $cmd = ([string]$proc.CommandLine).Trim()
  $quoted = '"' + $executable + '"'
  return ($cmd -eq $quoted -or $cmd -eq $executable)
}

# The registered protocol handler is the user's own entry, so it is tried first.
# Launching the executable directly is only allowed when the primary instance's
# real command line is exactly that executable: then the URL is handed to the
# same single instance with the same data root. Any other launch context is
# refused rather than guessed.
function Open-DeepLink([string]$url, [string]$launchVia, [int]$primaryPid, [string]$executable) {
  if ($launchVia -eq 'executable') {
    if (-not (Test-PrimaryContext $primaryPid $executable)) { throw 'launch-context-mismatch' }
    Start-Process -FilePath $executable -ArgumentList $url
    return 'executable'
  }
  Start-Process $url
  return 'protocol'
}

function Get-ComposerValue($root) {
  $edits = Find-Elements $root $composerPattern 'Edit'
  if ($edits.Count -eq 0) { return $null }
  try {
    $pattern = $edits[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    return [string]$pattern.Current.Value
  } catch { return $null }
}

function Get-SessionMenuButton([string]$title) {
  if (-not $title) { throw 'session-title-required' }
  $pattern = '^' + (Unescape-Pattern $title) + '\s*' + [char]0x7684 + [char]0x66F4 + [char]0x591A + [char]0x9009 + [char]0x9879 + '$'
  $buttons = @(Find-Elements $web.Element $pattern 'Button')
  if ($buttons.Count -eq 0) { throw 'session-menu-button-not-found' }
  # The same session can show this control twice (page header and sidebar entry);
  # both belong to the session the title names, so the last one is used and the
  # count is reported.
  return [pscustomobject]@{ Element = $buttons[-1]; Count = $buttons.Count }
}

function Get-TrustPattern {
  $zh = [string][char]0x4FE1 + [char]0x4EFB + [char]0x6B64 + [char]0x5DE5 + [char]0x4F5C + [char]0x533A
  return ($zh + '|Trust this workspace|Trust this folder')
}

function Get-FolderLabelPatterns([string]$label) {
  $plain = [regex]::Escape($label)
  $munged = [regex]::Escape(($label -replace '_', '-'))
  $parts = @([regex]::Split($label, '[^A-Za-z0-9]+') | Where-Object { $_ })
  $patterns = @($munged, $plain)
  if ($parts.Count -gt 1) {
    $joined = (($parts | ForEach-Object { [regex]::Escape($_) }) -join '.*')
    $patterns += $joined
    $head = [regex]::Escape($parts[0].Substring(0, [Math]::Min(5, $parts[0].Length)))
    $patterns += ($head + '.*' + [regex]::Escape($parts[-1]))
  }
  return $patterns
}

function Get-PageSignature($windowArg) {
  $windowElement = if ($windowArg -and $windowArg.PSObject.Properties['Element']) { $windowArg.Element } else { $windowArg }
  $webRoot = Get-WebRoot $windowElement
  $composers = Find-Elements $webRoot.Element $composerPattern 'Edit'
  $messagePattern = '^' + [char]0x6D88 + [char]0x606F + ' \d+$'
  $messages = Find-Elements $webRoot.Element $messagePattern 'Group'
  $trust = Find-Elements $webRoot.Element (Get-TrustPattern) 'Text'
  $texts = @()
  foreach ($element in (Find-Elements $webRoot.Element '' 'Text')) {
    if ($texts.Count -ge 14) { break }
    if ($element.Current.Name) { $texts += $element.Current.Name }
  }
  $value = $null
  if ($composers.Count -gt 0) {
    try {
      $pattern = $composers[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $value = [string]$pattern.Current.Value
    } catch { }
  }
  return [pscustomobject]@{
    documentName = $webRoot.DocumentName
    hasComposer = ($composers.Count -gt 0)
    messages = $messages.Count
    trustPrompt = ($trust.Count -gt 0)
    composerValue = $value
    texts = $texts
  }
}
function Get-MenuItems($windowElement) {
  $items = @()
  foreach ($element in (Find-Elements $windowElement '' 'MenuItem')) {
    if ($element.Current.Name) { $items += $element }
  }
  return $items
}

function Get-WindowButtons($windowElement) {
  return @(Find-Elements $windowElement '' 'Button' | Where-Object { $_.Current.Name })
}

function Get-WindowTexts($windowElement, [int]$limit = 30) {
  $texts = @()
  foreach ($element in (Find-Elements $windowElement '' 'Text')) {
    if ($texts.Count -ge $limit) { break }
    if ($element.Current.Name) { $texts += $element.Current.Name }
  }
  return $texts
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
      $texts = @()
      foreach ($element in (Find-Elements $web.Element '' 'Text')) {
        if ($texts.Count -ge 40) { break }
        $name = $element.Current.Name
        if ($name) { $texts += $name }
      }
      $signature = Get-PageSignature $window
      Write-Result @{ ok = $true; value = @{
        available = $true
        documentName = $web.DocumentName
        windowTitle = $window.Title
        composerFound = ($composers.Count -gt 0)
        modelLabel = $(if ($models.Count -gt 0) { $models[0].Current.Name } else { $null })
        messages = $signature.messages
        composerLength = $(if ($null -ne $signature.composerValue) { $signature.composerValue.Length } else { 0 })
        # An empty composer still holds a newline; only real text counts as unsent.
        composerTrimmedLength = $(if ($null -ne $signature.composerValue) { $signature.composerValue.Trim().Length } else { 0 })
        trustPrompt = $signature.trustPrompt
        texts = $texts
      } }
    }
    'submit' {
      $signature = Get-PageSignature $window
      if ($signature.trustPrompt -and $payload.trustWorkspace) {
        $trustButtons = Find-Elements $web.Element ([string]$payload.trustPattern) 'Button'
        if ($trustButtons.Count -eq 1) {
          Invoke-Element $trustButtons[0] | Out-Null
          Start-Sleep -Milliseconds 1500
          $signature = Get-PageSignature $window
        }
      }
      if ($signature.trustPrompt) { throw 'workspace-trust-prompt-blocking' }
      if ($signature.messages -gt 0) { throw 'page-not-empty' }
      if (-not $signature.hasComposer) { throw 'composer-not-found' }
      Focus-Window $window.Element
      $composers = Find-Elements $web.Element $composerPattern 'Edit'
      $composer = $composers[0]
      Invoke-Element $composer | Out-Null
      Start-Sleep -Milliseconds 150
      $typed = $false
      $expected = 0
      $current = Get-ComposerValue $web.Element
      $empty = ($null -eq $current) -or ($current.Trim().Length -eq 0)
      if ($empty -and $payload.prompt) {
        $previous = ''
        try { $previous = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { }
        $text = [string]$payload.prompt
        $expected = $text.Length
        Set-Clipboard -Value $text
        Send-Keys '^v'
        $typed = $true
        # A long message is pasted whole; wait until the composer really holds it
        # rather than trusting the paste keystroke.
        $deadline = (Get-Date).AddSeconds(25)
        while ((Get-Date) -lt $deadline) {
          Start-Sleep -Milliseconds 250
          $value = Get-ComposerValue $web.Element
          if ($null -ne $value -and $value.Length -ge [int]($expected * 0.95)) { break }
        }
        if ($null -ne $previous) { try { Set-Clipboard -Value $previous } catch { } }
      }
      $after = Get-ComposerValue $web.Element
      if ($null -ne $after -and $after.Trim().Length -eq 0) { throw 'composer-still-empty' }
      $composerLength = $(if ($null -ne $after) { $after.Length } else { 0 })
      if ($expected -gt 0 -and $composerLength -lt [int]($expected * 0.95)) { throw 'composer-paste-incomplete' }
      Send-Keys '{ENTER}'
      Write-Result @{ ok = $true; value = @{
        method = $(if ($typed) { 'clipboard-type-then-enter' } else { 'enter-on-prefilled-composer' })
        typed = $typed
        composerFound = $true
        composerLength = $(if ($null -ne $after) { $after.Length } else { 0 })
        expectedLength = $expected
        pageMessages = $signature.messages
        documentName = $signature.documentName
      } }
    }
    'interrupt' {
      Focus-Window $window.Element
      $stops = Find-Elements $web.Element $stopPattern 'Button'
      $method = $null
      if ($stops.Count -gt 0) {
        try { Invoke-Element $stops[0] | Out-Null; $method = 'stop-button' } catch { $method = $null }
      }
      if (-not $method) {
        Send-Keys '{ESC}'
        $method = 'escape'
      }
      Start-Sleep -Milliseconds 400
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
      Start-Sleep -Milliseconds 500
      $effortClicked = $null
      $effortLabel = [string]$payload.effortLabel
      if ($effortLabel) {
        $efforts = Find-Elements $web.Element ('^' + (Unescape-Pattern $effortLabel)) ''
        if ($efforts.Count -gt 0) {
          $effortClicked = $efforts[0].Current.Name
          Invoke-Element $efforts[0] | Out-Null
          Start-Sleep -Milliseconds 500
        }
      }
      $after = Find-Elements $web.Element $modelPattern 'Button'
      Write-Result @{ ok = $true; value = @{
        clicked = $label
        effortClicked = $effortClicked
        observed = $(if ($after.Count -gt 0) { $after[0].Current.Name } else { $null })
      } }
    }
    'reveal' {
      $revealed = $false
      $method = $null
      $hostSessionId = [string]$payload.hostSessionId
      if ($payload.allowDeepLink -and $hostSessionId -match '^local_[A-Za-z0-9-]{1,64}$') {
        $url = 'claude://code/continue?session=' + [uri]::EscapeDataString($hostSessionId)
        $via = Open-DeepLink $url ([string]$payload.launchVia) $window.Pid $window.Path
        $method = 'deep-link-continue-' + $via
        Start-Sleep -Milliseconds 1800
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
    'click-button' {
      $pattern = [string]$payload.namePattern
      if (-not $pattern) { throw 'name-pattern-required' }
      $buttons = Find-Elements $window.Element $pattern 'Button'
      if ($buttons.Count -eq 0) { $buttons = Find-Elements $web.Element $pattern 'Button' }
      if ($buttons.Count -eq 0) { throw ('button-not-found:' + $pattern) }
      if ($buttons.Count -gt 1) { throw ('button-ambiguous:' + $buttons.Count) }
      $name = $buttons[0].Current.Name
      Focus-Window $window.Element
      Invoke-Element $buttons[0] | Out-Null
      Start-Sleep -Milliseconds 900
      $signature = $null
      try { $signature = Get-PageSignature $window } catch { }
      Write-Result @{ ok = $true; value = @{ clicked = $name; signature = $signature } }
    }
    'session-args' {
      $targetPid = [int]$payload.pid
      if ($targetPid -le 0) { throw 'pid-required' }
      $proc = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $targetPid) -ErrorAction SilentlyContinue
      if (-not $proc) { Write-Result @{ ok = $true; value = @{ pid = $targetPid; found = $false } }; break }
      $cmd = [string]$proc.CommandLine
      $model = $null
      $effort = $null
      if ($cmd -match '--model=(\S+)') { $model = $matches[1] }
      if ($cmd -match '--effort=(\S+)') { $effort = $matches[1] }
      Write-Result @{ ok = $true; value = @{ pid = $targetPid; found = $true; model = $model; effort = $effort } }
    }
    'menu-dump' {
      $button = Get-SessionMenuButton ([string]$payload.title)
      Focus-Window $window.Element
      $null = Invoke-ElementByMouse $button.Element
      Start-Sleep -Milliseconds 900
      $items = @(Get-MenuItems $window.Element)
      $names = @($items | ForEach-Object { $_.Current.Name })
      Send-Keys '{ESC}'
      Start-Sleep -Milliseconds 200
      Write-Result @{ ok = $true; value = @{ opened = ($items.Count -gt 0); menuButtons = $button.Count; items = $names } }
    }
    'session-delete' {
      $title = [string]$payload.title
      $deleteLabel = [string]$payload.deleteLabel
      if (-not $deleteLabel) { throw 'delete-label-required' }
      $button = Get-SessionMenuButton $title
      Focus-Window $window.Element
      $null = Invoke-ElementByMouse $button.Element
      Start-Sleep -Milliseconds 900
      $items = @(Get-MenuItems $window.Element)
      $menuNames = @($items | ForEach-Object { $_.Current.Name })
      $target = $items | Where-Object { $_.Current.Name -eq $deleteLabel } | Select-Object -First 1
      if ($null -eq $target) {
        Send-Keys '{ESC}'
        Write-Result @{ ok = $false; code = 'delete-item-not-found'
          message = ('no menu item named ' + $deleteLabel + '; menu items: ' + ($menuNames -join ' | ')) }
        break
      }
      $deleteClickedAt = Invoke-ElementByMouse $target
      Start-Sleep -Milliseconds 1400
      $dialogTexts = @(Get-WindowTexts $window.Element 24)
      $buttons = @(Get-WindowButtons $window.Element)
      $confirmLabels = @($payload.confirmLabels)
      $confirmButton = $null
      $confirmName = $null
      if ($confirmLabels.Count -gt 0) {
        foreach ($candidate in $buttons) {
          if ($confirmLabels -contains $candidate.Current.Name) { $confirmButton = $candidate; $confirmName = $candidate.Current.Name; break }
        }
      }
      if ($null -eq $confirmButton) {
        Write-Result @{ ok = $false; code = 'delete-confirm-not-found'
          message = ('the host asked for confirmation but no expected button was found; buttons: ' + (($buttons | ForEach-Object { $_.Current.Name }) -join ' | '))
          value = @{ dialogTexts = $dialogTexts; menuItems = $menuNames } }
        break
      }
      $confirmClickedAt = Invoke-ElementByMouse $confirmButton
      Start-Sleep -Milliseconds 1200
      $remaining = @(Find-Elements $window.Element ('^' + (Unescape-Pattern $title) + '(s|$)') 'Button')
      Write-Result @{ ok = $true; value = @{
        clicked = $deleteLabel
        confirmed = $confirmName
        menuButtons = $button.Count
        menuItems = $menuNames
        dialogTexts = $dialogTexts
        entryStillPresent = ($remaining.Count -gt 0)
        deleteClickedAt = $deleteClickedAt
        confirmClickedAt = $confirmClickedAt
        documentName = (Get-WebRoot $window.Element).DocumentName
      } }
    }
    'new-session' {
      $workspace = [string]$payload.workspace
      $prompt = [string]$payload.prompt
      $folderLabel = [string]$payload.folderLabel
      $before = Get-PageSignature $window
      $strategy = $null
      $blocked = $null
      # 1) The application's own sidebar action for this folder: one click, no
      #    protocol hop, and it always targets the folder the group is bound to.
      $anchors = @()
      if ($folderLabel) {
        $candidates = @(Find-Elements $web.Element $folderPattern 'Button')
        foreach ($labelPattern in (Get-FolderLabelPatterns $folderLabel)) {
          $matched = @($candidates | Where-Object { $_.Current.Name -match $labelPattern })
          if ($matched.Count -ge 1) { $anchors = $matched; break }
        }
      }
      if ($anchors.Count -eq 1) {
        Invoke-Element $anchors[0] | Out-Null
        Start-Sleep -Milliseconds 1200
        $strategy = 'sidebar-folder-new-session'
      } elseif ($payload.allowDeepLink) {
        $query = 'claude://code/new?src=external&folder=' + [uri]::EscapeDataString($workspace)
        $prefillViaLink = $(if ($null -ne $payload.prefill) { [bool]$payload.prefill } else { [bool]$prompt })
        if ($prefillViaLink -and $prompt) { $query += '&q=' + [uri]::EscapeDataString($prompt) }
        $via = Open-DeepLink $query ([string]$payload.launchVia) $window.Pid $window.Path
        Start-Sleep -Milliseconds 2200
        $strategy = 'deep-link-code-new-' + $via
        $probeAfter = Get-PageSignature $window
        if (-not $probeAfter.hasComposer -and $payload.allowExecutable) {
          try {
            $via2 = Open-DeepLink $query 'executable' $window.Pid $window.Path
            Start-Sleep -Milliseconds 2200
            $strategy = $strategy + '+executable'
          } catch { }
        }
      } else {
        $fallback = Find-Elements $web.Element $newPattern 'Button'
        if ($fallback.Count -eq 0) { throw 'new-session-control-not-found' }
        Invoke-Element $fallback[0] | Out-Null
        Start-Sleep -Milliseconds 1000
        $strategy = 'sidebar-new-session'
      }
      $after = Get-PageSignature $window
      if ($after.trustPrompt -and $payload.trustWorkspace) {
        # A fresh Claude Code page asks the app's own workspace-trust question.
        # The caller decides whether to answer it; it is never answered silently.
        $trustButtons = Find-Elements $web.Element ([string]$payload.trustPattern) 'Button'
        if ($trustButtons.Count -eq 1) {
          $trustedName = $trustButtons[0].Current.Name
          Invoke-Element $trustButtons[0] | Out-Null
          Start-Sleep -Milliseconds 1500
          $after = Get-PageSignature $window
          $trusted = $trustedName
        }
      }
      if ($after.trustPrompt) { $blocked = 'workspace-trust-prompt' }
      $navigated = ($after.hasComposer -and $after.messages -eq 0 -and -not $after.trustPrompt)
      Write-Result @{ ok = $true; value = @{
        strategy = $strategy
        workspace = $workspace
        folderLabel = $folderLabel
        navigated = $navigated
        blocked = $blocked
        prefilled = $false
        prefillViaLink = $(if ($null -ne $prefillViaLink) { $prefillViaLink } else { $false })
        trustClicked = $(if ($trusted) { $trusted } else { $null })
        before = $before
        after = $after
        composerValueLength = $(if ($null -ne $after.composerValue) { $after.composerValue.Length } else { $null })
      } }
    }
    default { throw "unknown-action:$Action" }
  }
} catch {
  Write-Failure 'ui-bridge-error' $_.Exception.Message
}
