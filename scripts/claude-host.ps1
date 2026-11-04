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
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
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
  # A Claude process can own several Chrome_WidgetWin_1 windows: the one the user
  # is looking at, plus hidden ones left over from earlier pages. Picking the
  # first one read the wrong page's accessibility tree, so the window is chosen
  # by being the foreground visible window, then the largest visible one.
  Add-Win32
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $foreground = [FutureAideHost.Win32]::GetForegroundWindow()
  $candidates = @()
  $procs = @(Get-Process -Name 'claude' -ErrorAction SilentlyContinue)
  foreach ($proc in $procs) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
    foreach ($window in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition)) {
      if ($window.Current.ClassName -ne 'Chrome_WidgetWin_1') { continue }
      $handle = [IntPtr]$window.Current.NativeWindowHandle
      $rect = $window.Current.BoundingRectangle
      $area = if ($rect.IsEmpty) { 0 } else { $rect.Width * $rect.Height }
      $candidates += [pscustomobject]@{
        Element = $window; Pid = $proc.Id; Title = $window.Current.Name; Path = $proc.Path
        Hwnd = $handle.ToInt64()
        Foreground = ($handle -eq $foreground)
        Visible = (-not $rect.IsEmpty) -and ($area -gt 0)
        Area = $area
      }
    }
  }
  if ($candidates.Count -eq 0) { throw 'claude-window-not-found' }
  $chosen = $candidates | Sort-Object -Property @{ Expression = 'Foreground'; Descending = $true },
    @{ Expression = 'Visible'; Descending = $true }, @{ Expression = 'Area'; Descending = $true } | Select-Object -First 1
  $chosen | Add-Member -NotePropertyName Candidates -NotePropertyValue @($candidates | ForEach-Object {
    @{ hwnd = $_.Hwnd; pid = $_.Pid; foreground = $_.Foreground; visible = $_.Visible; area = $_.Area; title = $_.Title }
  }) -Force
  return $chosen
}

function Get-WebRoot($window, [string]$titleHint = '') {
  # The window can hold more than one document: the app shell (an empty
  # RootWebArea) and the page the user is on. The page is the document with a
  # real subtree and a name; the shell and empty snapshots are reported but not
  # chosen. A stale tree (only the shell) is retried once after focusing.
  function Read-Documents {
    $documents = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Document)))
    $list = @()
    foreach ($document in $documents) {
      if ($document.Current.AutomationId -ne 'RootWebArea') { continue }
      $count = $document.FindAll([System.Windows.Automation.TreeScope]::Descendants, (Get-Condition)).Count
      $list += [pscustomobject]@{ Element = $document; Name = $document.Current.Name; Descendants = $count }
    }
    return $list
  }
  $documents = @(Read-Documents)
  $named = @($documents | Where-Object { $_.Name -and $_.Descendants -gt 2 })
  $best = $null
  if ($titleHint) {
    $best = $named | Where-Object { $_.Name.StartsWith($titleHint) } | Sort-Object Descendants -Descending | Select-Object -First 1
  }
  if ($null -eq $best) { $best = $named | Sort-Object Descendants -Descending | Select-Object -First 1 }
  $refreshed = $false
  if ($null -eq $best -and $documents.Count -gt 0) {
    # Only shells or an empty snapshot were readable: focus the window (allowed
    # refresh, no input) and look once more before reporting staleness.
    try { Focus-Window $window } catch { }
    Start-Sleep -Milliseconds 500
    $documents = @(Read-Documents)
    $named = @($documents | Where-Object { $_.Name -and $_.Descendants -gt 2 })
    if ($titleHint) {
      $best = $named | Where-Object { $_.Name.StartsWith($titleHint) } | Sort-Object Descendants -Descending | Select-Object -First 1
    }
    if ($null -eq $best) { $best = $named | Sort-Object Descendants -Descending | Select-Object -First 1 }
    $refreshed = $true
  }
  $summary = @($documents | ForEach-Object { @{ name = $_.Name; descendants = $_.Descendants } })
  return [pscustomobject]@{
    Element = $(if ($null -ne $best) { $best.Element } else { $null })
    DocumentName = $(if ($null -ne $best) { $best.Name } else { '' })
    DocumentCount = $documents.Count
    Documents = $summary
    Refreshed = $refreshed
    Stale = ($null -eq $best)
  }
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
  # A control can be scrolled out of view or rendered without geometry, and then
  # it has no clickable point. That is reported as a result instead of thrown, so
  # the caller can fall back to another route (the link, or the automation
  # pattern) rather than failing the whole operation.
  if ($null -eq $element) { return @{ clicked = $false; reason = 'element-missing' } }
  $name = $element.Current.Name
  try {
    $scrollItem = $element.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
    $scrollItem.ScrollIntoView()
    Start-Sleep -Milliseconds 150
  } catch { }
  Add-Win32
  $point = $null
  try { $point = $element.GetClickablePoint() } catch { $point = $null }
  if ($null -eq $point) {
    $rect = $element.Current.BoundingRectangle
    if (-not $rect.IsEmpty -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
      $point = New-Object System.Windows.Point([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
    }
  }
  if ($null -ne $point) {
    [FutureAideHost.Win32]::SetCursorPos([int]$point.X, [int]$point.Y) | Out-Null
    [FutureAideHost.Win32]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
    [FutureAideHost.Win32]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 120
    return @{ clicked = $true; method = 'mouse'; name = $name; x = [int]$point.X; y = [int]$point.Y }
  }
  $patternMethod = $null
  try { $patternMethod = Invoke-Element $element } catch { $patternMethod = $null }
  if ($patternMethod) { return @{ clicked = $true; method = $patternMethod; name = $name } }
  return @{ clicked = $false; reason = 'no-clickable-point'; name = $name }
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

function ZH([int[]]$codes) {
  return (-join ($codes | ForEach-Object { [char]$_ }))
}

function Get-StopButtonPattern {
  return ('^(' + (ZH @(0x505C, 0x6B62, 0x6B64, 0x4EFB, 0x52A1)) + '|Stop this task)$')
}

function Get-StopBusyPattern {
  return ('(' + (ZH @(0x6B63, 0x5728, 0x505C, 0x6B62)) + '|Stopping)')
}

function Get-StopDonePattern {
  return ('(' + (ZH @(0x5DF2, 0x505C, 0x6B62)) + '|Stopped)')
}

function Get-TasksPanelPattern {
  return ('(' + (ZH @(0x540E, 0x53F0, 0x4EFB, 0x52A1)) + '|background tasks)')
}

# Every background task row carries one stop button whose accessible name is the
# same for all rows, so a row is identified by its own text, never by position.
function Get-TaskRows {
  $stopPattern = Get-StopButtonPattern
  $busyPattern = Get-StopBusyPattern
  $donePattern = Get-StopDonePattern
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $rows = @()
  $index = 0
  foreach ($button in @(Find-Elements $web.Element $stopPattern 'Button')) {
    $rowElement = $null
    try { $rowElement = $walker.GetParent($button) } catch { }
    $depth = 0
    while ($null -ne $rowElement -and $depth -lt 6 -and
      $rowElement.Current.ControlType -ne [System.Windows.Automation.ControlType]::ListItem -and
      $rowElement.Current.ControlType -ne [System.Windows.Automation.ControlType]::DataItem -and
      $rowElement.Current.ControlType -ne [System.Windows.Automation.ControlType]::Group) {
      $rowElement = $walker.GetParent($rowElement)
      $depth += 1
    }
    $texts = @()
    if ($null -ne $rowElement) {
      if ($rowElement.Current.Name) { $texts += $rowElement.Current.Name }
      foreach ($node in $rowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, (Get-Condition))) {
        $name = $node.Current.Name
        if ($name -and $name -notmatch $stopPattern) { $texts += $name }
      }
    }
    $rowText = ((@($texts | Select-Object -Unique)) -join ' | ')
    $rows += [pscustomobject]@{
      index = $index
      buttonName = $button.Current.Name
      rowName = $(if ($null -ne $rowElement) { $rowElement.Current.Name } else { '' })
      rowText = $rowText
      depth = $depth
      busy = ($rowText -match $busyPattern)
      done = ($rowText -match $donePattern)
      enabled = $button.Current.IsEnabled
      Button = $button
    }
    $index += 1
  }
  return $rows
}

function Get-TaskRowSummary($rows) {
  return @($rows | ForEach-Object {
    @{ index = $_.index; buttonName = $_.buttonName; rowName = $_.rowName; rowText = $_.rowText
       depth = $_.depth; busy = $_.busy; done = $_.done; enabled = $_.enabled }
  })
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
        window = @{ pid = $window.Pid; title = $window.Title; executable = $window.Path
          hwnd = $window.Hwnd; foreground = $window.Foreground; visible = $window.Visible
          candidates = $window.Candidates }
        documents = $web.Documents
        stale = $web.Stale
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
        windowHwnd = $window.Hwnd
        windowForeground = $window.Foreground
        documents = $web.Documents
        stale = $web.Stale
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
    'model-snapshot' {
      # One process, one page visit: the control on screen, the control on a fresh
      # draft for this workspace, and the way back. A caller that needs both pays
      # one bridge start instead of six, which is where most of the wait came from.
      $title = [string]$payload.title
      $workspace = [string]$payload.workspace
      $folderLabel = [string]$payload.folderLabel
      $wantDefault = [bool]$payload.wantDefault
      $notes = @()
      $view0 = Get-PageSignature $window
      $previousTitle = ($view0.documentName -replace '\s+-\s+Claude Code$', '')
      $readModelName = {
        $found = @(Find-Elements $web.Element $modelPattern 'Button')
        if ($found.Count -eq 0) { return $null }
        return $found[0].Current.Name
      }
      $currentRaw = & $readModelName
      $defaultRaw = $null
      $navigation = @{ navigated = $false; draft = 'none'; restored = 'not-needed' }
      if ($wantDefault) {
        $composerTrimmed = $(if ($null -ne $view0.composerValue) { $view0.composerValue.Trim().Length } else { 0 })
        if ($view0.hasComposer -and $view0.messages -eq 0 -and $composerTrimmed -eq 0) {
          $defaultRaw = $currentRaw
          $navigation = @{ navigated = $false; draft = 'in-place'; restored = 'not-needed' }
        } elseif ($composerTrimmed -gt 0) {
          $notes += 'unsent-text-present'
        } else {
          $opened = $false
          $anchors = @()
          if ($folderLabel) {
            $candidates = @(Find-Elements $web.Element $folderPattern 'Button')
            foreach ($labelPattern in (Get-FolderLabelPatterns $folderLabel)) {
              $matched = @($candidates | Where-Object { $_.Current.Name -match $labelPattern })
              if ($matched.Count -ge 1) { $anchors = $matched; break }
            }
          }
          if ($anchors.Count -eq 1) {
            Focus-Window $window.Element
            $click = Invoke-ElementByMouse $anchors[0]
            if ($click.clicked) {
              Start-Sleep -Milliseconds 1500
              $probe = Get-PageSignature $window
              $opened = ($probe.hasComposer -and $probe.messages -eq 0)
              if ($opened) { $notes += 'draft:sidebar' }
            } else { $notes += ('sidebar-click-unavailable:' + [string]$click.reason) }
          }
          if (-not $opened -and $workspace) {
            try {
              $query = 'claude://code/new?src=external&folder=' + [uri]::EscapeDataString($workspace)
              $via = Open-DeepLink $query 'protocol' $window.Pid $window.Path
              Start-Sleep -Milliseconds 1800
              $probe = Get-PageSignature $window
              $opened = ($probe.hasComposer -and $probe.messages -eq 0)
              if ($opened) { $notes += ('draft:deep-link-' + [string]$via) }
            } catch { $notes += 'deep-link-refused' }
          }
          if ($opened) {
            $defaultRaw = & $readModelName
            $navigation = @{ navigated = $true; draft = 'fresh'; restored = 'unconfirmed' }
            $restoreTitle = $(if ($title) { $title } else { $previousTitle })
            if ($restoreTitle) {
              $titlePattern = '^' + (Unescape-Pattern $restoreTitle) + '($|\s)'
              $entries = @(Find-Elements $web.Element $titlePattern 'Button' | Where-Object { $_.Current.Name -notmatch ('\s*' + [char]0x7684 + [char]0x66F4 + [char]0x591A + [char]0x9009 + [char]0x9879 + '$') })
              if ($entries.Count -gt 0) {
                $restoreClick = Invoke-ElementByMouse $entries[0]
                if ($restoreClick.clicked) {
                  Start-Sleep -Milliseconds 1000
                  $back = Get-PageSignature $window
                  if ($back.documentName.StartsWith($restoreTitle)) { $navigation.restored = 'session' }
                  else { $notes += 'restore-unconfirmed' }
                } else { $notes += ('restore-click-unavailable:' + [string]$restoreClick.reason) }
              } else { $notes += 'restore-entry-not-found' }
            }
          } else { $notes += 'draft-not-opened' }
        }
      }
      $after = Get-PageSignature $window
      Write-Result @{ ok = $true; value = @{
        documentName = $after.documentName; windowHwnd = $window.Hwnd; documents = $web.Documents
        previousDocumentName = $view0.documentName; stale = $web.Stale
        current = @{ raw = $currentRaw }; default = @{ raw = $defaultRaw }
        navigation = $navigation; notes = $notes } }
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
      $attempted = @()
      $title = [string]$payload.title
      function Test-OnTitle([string]$wanted) {
        if (-not $wanted) { return $true }
        $signature = Get-PageSignature $window
        return $signature.documentName.StartsWith($wanted)
      }
      $hostSessionId = [string]$payload.hostSessionId
      if ($payload.allowDeepLink -and $hostSessionId -match '^local_[A-Za-z0-9-]{1,64}$') {
        $url = 'claude://code/continue?session=' + [uri]::EscapeDataString($hostSessionId)
        $via = Open-DeepLink $url ([string]$payload.launchVia) $window.Pid $window.Path
        Start-Sleep -Milliseconds 1800
        $attempted += ('deep-link-continue-' + $via)
        if (Test-OnTitle $title) { $revealed = $true; $method = 'deep-link-continue-' + $via }
      }
      if (-not $revealed -and $title) {
        # The sidebar entry is the reliable path when the link is not consumed.
        $titlePattern = '^' + (Unescape-Pattern $title) + '($|\s)'
        $entries = @(Find-Elements $web.Element $titlePattern 'Button' |
          Where-Object { $_.Current.Name -notmatch ('\s*' + [char]0x7684 + [char]0x66F4 + [char]0x591A + [char]0x9009 + [char]0x9879 + '$') })
        if ($entries.Count -eq 0) { throw "session-entry-not-found:$title" }
        Focus-Window $window.Element
        $entryClick = Invoke-ElementByMouse $entries[0]
        if ($entryClick.clicked) {
          Start-Sleep -Milliseconds 1200
          $attempted += 'sidebar-entry'
          if (Test-OnTitle $title) { $revealed = $true; $method = 'sidebar-entry' }
        } else {
          $attempted += ('sidebar-entry-click-unavailable:' + $entryClick.reason)
        }
      }
      if (-not $revealed) {
        Write-Result @{ ok = $false; code = 'reveal-not-confirmed'
          message = ('the window did not reach ' + $title + '; attempts: ' + ($attempted -join ', '))
          value = @{ attempts = $attempted; documentName = (Get-PageSignature $window).documentName } }
        break
      }
      Write-Result @{ ok = $true; value = @{ revealed = $true; method = $method; attempts = $attempted
        documentName = (Get-PageSignature $window).documentName } }
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
    'tasks-panel' {
      # The panel is a snapshot: it does not refresh itself, so a task that starts
      # later only shows up after it is closed and opened again.
      $title = [string]$payload.title
      $mode = [string]$payload.mode
      $attempts = @()
      if ($mode -eq 'close') {
        Send-Keys '{ESC}'
        Start-Sleep -Milliseconds 350
        Write-Result @{ ok = $true; value = @{ opened = $false; mode = 'close'; rows = @() } }
        break
      }
      if ($mode -eq 'refresh') {
        Send-Keys '{ESC}'
        Start-Sleep -Milliseconds 400
      }
      $menu = Get-SessionMenuButton $title
      Focus-Window $window.Element
      $menuClick = Invoke-ElementByMouse $menu.Element
      $attempts += ('menu:' + $(if ($menuClick.clicked) { $menuClick.method } else { $menuClick.reason }))
      Start-Sleep -Milliseconds 800
      $panelPattern = Get-TasksPanelPattern
      $entries = @(Get-MenuItems $window.Element | Where-Object { $_.Current.Name -match $panelPattern })
      if ($entries.Count -eq 0) {
        $names = @(Get-MenuItems $window.Element | ForEach-Object { $_.Current.Name })
        Send-Keys '{ESC}'
        Write-Result @{ ok = $false; code = 'tasks-panel-entry-not-found'
          message = 'the session menu has no background tasks entry'
          value = @{ attempts = $attempts; menuItems = $names } }
        break
      }
      $entry = $entries[0]
      $entryClick = Invoke-Element $entry
      $attempts += ('entry:' + $entryClick)
      Start-Sleep -Milliseconds 1000
      $rows = @(Get-TaskRows)
      Write-Result @{ ok = $true; value = @{ opened = $true; mode = $(if ($mode) { $mode } else { 'open' })
        entry = $entry.Current.Name; attempts = $attempts; rows = (Get-TaskRowSummary $rows) } }
    }
    'tasks-rows' {
      $rows = @(Get-TaskRows)
      Write-Result @{ ok = $true; value = @{ rows = (Get-TaskRowSummary $rows); count = $rows.Count } }
    }
    'task-stop' {
      # One row, chosen by its own text; a name shared by several rows is refused
      # rather than clicking the first one.
      $match = [string]$payload.match
      $index = $payload.index
      $rows = @(Get-TaskRows)
      $candidates = @($rows | Where-Object { -not $_.busy -and -not $_.done -and $_.enabled })
      if ($null -ne $index) { $candidates = @($candidates | Where-Object { $_.index -eq [int]$index }) }
      if ($match) {
        $needle = $match.ToLowerInvariant()
        $candidates = @($candidates | Where-Object { (($_.rowText + ' ' + $_.rowName).ToLowerInvariant()).Contains($needle) })
      }
      if ($candidates.Count -eq 0) {
        Write-Result @{ ok = $false; code = 'task-not-found'; message = ('no running row matches ' + $match)
          value = @{ rows = (Get-TaskRowSummary $rows) } }
        break
      }
      if ($candidates.Count -gt 1 -and -not $match) {
        Write-Result @{ ok = $false; code = 'task-ambiguous'; message = 'several running rows and no text match'
          value = @{ rows = (Get-TaskRowSummary $rows) } }
        break
      }
      $row = $candidates[0]
      $before = $row.rowText
      $click = Invoke-ElementByMouse $row.Button
      $busySeen = $false
      $doneSeen = $false
      $after = $before
      if ($click.clicked) {
        for ($step = 0; $step -lt 15; $step++) {
          Start-Sleep -Milliseconds 400
          $now = @(Get-TaskRows | Where-Object { $_.index -eq $row.index })
          if ($now.Count -eq 0) { break }
          $after = $now[0].rowText
          if ($now[0].busy) { $busySeen = $true }
          if ($now[0].done) { $doneSeen = $true }
          if ($doneSeen) { break }
        }
      }
      Write-Result @{ ok = [bool]$click.clicked
        code = $(if ($click.clicked) { $null } else { 'task-stop-click-unavailable' })
        message = $(if ($click.clicked) { $null } else { [string]$click.reason })
        value = @{ index = $row.index; buttonName = $row.buttonName; rowName = $row.rowName
          before = $before; after = $after; busySeen = $busySeen; doneSeen = $doneSeen
          method = $click.method; at = (Get-Date).ToUniversalTime().ToString('o') } }
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
      if (-not $deleteClickedAt.clicked) {
        Send-Keys '{ESC}'
        Write-Result @{ ok = $false; code = 'delete-click-unavailable'
          message = ('the delete item has no clickable point: ' + $deleteClickedAt.reason)
          value = @{ menuItems = $menuNames } }
        break
      }
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
      $attempted = @()
      # 1) the app's own sidebar action for this folder, with a real click: this
      #    control does not answer the automation Invoke pattern.
      $opened = $false
      if ($anchors.Count -eq 1) {
        Focus-Window $window.Element
        $sidebarClick = Invoke-ElementByMouse $anchors[0]
        if ($sidebarClick.clicked) {
          Start-Sleep -Milliseconds 1800
          $attempted += 'sidebar-folder-new-session'
          $probeSidebar = Get-PageSignature $window
          $opened = ($probeSidebar.hasComposer -and $probeSidebar.messages -eq 0)
          if ($opened) { $strategy = 'sidebar-folder-new-session' }
        } else {
          $attempted += ('sidebar-click-unavailable:' + $sidebarClick.reason)
        }
      }
      # 2) the renderer's own code-new link (prefill only), protocol first and the
      #    context-verified executable as the second attempt.
      if (-not $opened -and $payload.allowDeepLink) {
        $query = 'claude://code/new?src=external&folder=' + [uri]::EscapeDataString($workspace)
        $prefillViaLink = $(if ($null -ne $payload.prefill) { [bool]$payload.prefill } else { [bool]$prompt })
        if ($prefillViaLink -and $prompt) { $query += '&q=' + [uri]::EscapeDataString($prompt) }
        $via = Open-DeepLink $query ([string]$payload.launchVia) $window.Pid $window.Path
        Start-Sleep -Milliseconds 2200
        $attempted += ('deep-link-code-new-' + $via)
        $probeAfter = Get-PageSignature $window
        $opened = ($probeAfter.hasComposer -and $probeAfter.messages -eq 0)
        if ($opened) { $strategy = 'deep-link-code-new-' + $via }
        if (-not $opened -and $payload.allowExecutable) {
          try {
            $via2 = Open-DeepLink $query 'executable' $window.Pid $window.Path
            Start-Sleep -Milliseconds 2200
            $attempted += ('deep-link-code-new-' + $via2)
            $probeExec = Get-PageSignature $window
            $opened = ($probeExec.hasComposer -and $probeExec.messages -eq 0)
            if ($opened) { $strategy = $strategy + '+executable' }
          } catch { $attempted += 'executable-refused' }
        }
      }
      # 3) last resort: the global new-session control.
      if (-not $opened -and -not $payload.allowDeepLink) {
        $fallback = Find-Elements $web.Element $newPattern 'Button'
        if ($fallback.Count -eq 0) { throw 'new-session-control-not-found' }
        Focus-Window $window.Element
        $null = Invoke-ElementByMouse $fallback[0]
        Start-Sleep -Milliseconds 1500
        $attempted += 'sidebar-new-session'
        $strategy = 'sidebar-new-session'
      }
      $strategy = $(if ($strategy) { $strategy } else { 'none' })
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
        attempted = $attempted
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
