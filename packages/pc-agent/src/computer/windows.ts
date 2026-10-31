import type {
  ComputerAdapter,
  ComputerAppInfo,
  ComputerBounds,
  ComputerNode,
  ComputerSnapshot,
} from './types.ts';
import { nodeRef } from './types.ts';
import { runProcess, sanitizedEnv } from '../process.ts';

const KEY_SEND = {
  Enter: '{ENTER}',
  Tab: '{TAB}',
  Escape: '{ESC}',
  Backspace: '{BACKSPACE}',
  Delete: '{DELETE}',
  Space: ' ',
  ArrowUp: '{UP}',
  ArrowDown: '{DOWN}',
  ArrowLeft: '{LEFT}',
  ArrowRight: '{RIGHT}',
  PageUp: '{PGUP}',
  PageDown: '{PGDN}',
  Home: '{HOME}',
  End: '{END}',
} as const;

type KeyName = keyof typeof KEY_SEND;

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MimiNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint id);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
$request = if ($env:MIMI_COMPUTER_INPUT) { $env:MIMI_COMPUTER_INPUT | ConvertFrom-Json } else { [pscustomobject]@{} }
$action = $env:MIMI_COMPUTER_ACTION
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$script:count = 0

function Get-ChildAt($parent, $index) {
  $child = $walker.GetFirstChild($parent)
  $i = 0
  while ($child -ne $null -and $i -lt $index) {
    $child = $walker.GetNextSibling($child)
    $i++
  }
  if ($child -eq $null) { return $null }
  return $child
}

function Get-ByRef($root, $ref) {
  $text = ([string]$ref).Trim()
  if (-not $text.StartsWith('c')) { return $null }
  $rest = $text.Substring(1)
  $element = $root
  if ($rest -ne '') {
    foreach ($part in ($rest -split '\.')) {
      $element = Get-ChildAt $element ([int]$part)
      if ($element -eq $null) { return $null }
    }
  }
  return $element
}

function Get-Bounds($element) {
  try {
    $r = $element.Current.BoundingRectangle
    if ($r.IsEmpty) { return $null }
    return [pscustomobject]@{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
  } catch { return $null }
}

function Get-Node($element, $path) {
  if ($element -eq $null -or $script:count -ge 500) { return $null }
  $script:count++
  $current = $element.Current
  $role = ($current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
  $name = [string]$current.Name
  $value = ''
  if (-not $current.IsPassword) {
    try {
      $pattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $value = [string]$pattern.Current.Value
      }
    } catch { $value = '' }
  }
  $node = [ordered]@{
    ref = (Get-Ref $path)
    role = $role
    name = $name
    secure = [bool]$current.IsPassword
    focused = [bool]$current.HasKeyboardFocus
    disabled = -not [bool]$current.IsEnabled
  }
  if ($value -ne '') { $node.value = $value.Substring(0, [Math]::Min($value.Length, 300)) }
  $bounds = Get-Bounds $element
  if ($bounds -ne $null) { $node.bounds = $bounds }
  if ($request.depth -eq $null -or $path.Count -lt [int]$request.depth) {
    $children = @()
    $child = $walker.GetFirstChild($element)
    $index = 0
    while ($child -ne $null -and $script:count -lt 500) {
      $childPath = @($path) + @($index)
      $built = Get-Node $child $childPath
      if ($built -ne $null) { $children += $built }
      $child = $walker.GetNextSibling($child)
      $index++
    }
    if ($children.Count -gt 0) { $node.children = $children }
  }
  return [pscustomobject]$node
}

function Get-Ref($path) {
  if ($path.Count -eq 0) { return 'c' }
  return 'c' + (($path | ForEach-Object { $_ }) -join '.')
}

function Get-TargetWindow {
  if ($request.app) {
    $wanted = [string]$request.app
    $process = Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and ($_.ProcessName -like "*$wanted*" -or $_.MainWindowTitle -like "*$wanted*")
    } | Select-Object -First 1
    if ($process -eq $null) { throw "No window for app '$wanted'." }
    return $process.MainWindowHandle
  }
  return [MimiNative]::GetForegroundWindow()
}

function Get-ActiveApp {
  $handle = [MimiNative]::GetForegroundWindow()
  $processId = 0
  [void][MimiNative]::GetWindowThreadProcessId($handle, [ref]$processId)
  try { return (Get-Process -Id $processId).ProcessName } catch { return '' }
}

function Get-Windows {
  $items = @()
  foreach ($process in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle })) {
    $items += [pscustomobject]@{
      app = $process.ProcessName
      title = $process.MainWindowTitle
      active = ($process.MainWindowHandle -eq [MimiNative]::GetForegroundWindow())
    }
  }
  return $items
}

function Invoke-Element($element) {
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
    return
  }
  $bounds = Get-Bounds $element
  if ($bounds -eq $null) { throw 'The element has no bounds to click.' }
  $x = $bounds.x + [int]($bounds.width / 2)
  $y = $bounds.y + [int]($bounds.height / 2)
  [void][MimiNative]::SetCursorPos($x, $y)
  [MimiNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [MimiNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

if ($action -eq 'observe') {
  $handle = Get-TargetWindow
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  if ($root -eq $null) { throw 'The target window is not accessible.' }
  $node = Get-Node $root @()
  $result = [ordered]@{
    platform = 'win32'
    activeApp = Get-ActiveApp
    windows = @(Get-Windows)
    nodes = @($node)
    capturedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  $result | ConvertTo-Json -Depth 12 -Compress
} elseif ($action -eq 'click') {
  $handle = Get-TargetWindow
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $element = Get-ByRef $root $request.ref
  if ($element -eq $null) { throw "No element $($request.ref)." }
  Invoke-Element $element
  [pscustomobject]@{ ref = $request.ref; target = [string]$element.Current.Name } | ConvertTo-Json -Compress
} elseif ($action -eq 'type') {
  $handle = Get-TargetWindow
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $element = Get-ByRef $root $request.ref
  if ($element -eq $null) { throw "No element $($request.ref)." }
  if ($element.Current.IsPassword) { throw 'This is a secure field. The user must type the password or OTP themselves.' }
  [void][MimiNative]::SetForegroundWindow($handle)
  $element.SetFocus()
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    if (-not $pattern.Current.IsReadOnly) { $pattern.SetValue([string]$request.text) }
    else { throw 'This field is read-only.' }
  } else {
    [System.Windows.Forms.SendKeys]::SendWait([string]$request.text)
  }
  [pscustomobject]@{ ref = $request.ref; target = [string]$element.Current.Name } | ConvertTo-Json -Compress
} elseif ($action -eq 'key') {
  $send = $request.send
  if (-not $send) { throw 'Unknown key.' }
  [System.Windows.Forms.SendKeys]::SendWait([string]$send)
  [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
} elseif ($action -eq 'scroll') {
  $handle = Get-TargetWindow
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  if ($request.ref) {
    $element = Get-ByRef $root $request.ref
    if ($element -eq $null) { throw "No element $($request.ref)." }
    $bounds = Get-Bounds $element
    if ($bounds -ne $null) {
      [void][MimiNative]::SetCursorPos(($bounds.x + [int]($bounds.width / 2)), ($bounds.y + [int]($bounds.height / 2)))
    }
  }
  $delta = 120 * [int]$request.amount * [int]$request.direction
  [MimiNative]::mouse_event(0x0800, 0, 0, [uint32]$delta, [UIntPtr]::Zero)
  [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
} elseif ($action -eq 'apps') {
  $items = @()
  foreach ($item in (Get-Windows)) {
    $windows = @()
    $process = Get-Process -Name $item.app -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($process -ne $null) { $windows = @($process.MainWindowTitle) }
    $items += [pscustomobject]@{ name = $item.app; active = $item.active; windows = $windows }
  }
  $items | ConvertTo-Json -Depth 5 -Compress
} elseif ($action -eq 'activate') {
  $handle = Get-TargetWindow
  [void][MimiNative]::SetForegroundWindow($handle)
  [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
} elseif ($action -eq 'menu') {
  $handle = Get-TargetWindow
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $name = [string]$request.name
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $found = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($found -eq $null) { throw "No menu item '$name'." }
  Invoke-Element $found
  [pscustomobject]@{ ok = $true } | ConvertTo-Json -Compress
} elseif ($action -eq 'capture') {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
  [pscustomobject]@{ base64 = [Convert]::ToBase64String($stream.ToArray()) } | ConvertTo-Json -Compress
  $stream.Dispose()
} else {
  throw "Unknown action '$action'."
}
`;

async function run(action: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-Command', SCRIPT], {
    cwd: process.cwd(),
    env: sanitizedEnv({ MIMI_COMPUTER_ACTION: action, MIMI_COMPUTER_INPUT: JSON.stringify(input) }),
    timeoutMs: 60_000,
    maxOutput: 8 * 1024 * 1024,
  });
  if (result.exitCode !== 0) throw new Error(result.output.trim() || `PowerShell exited with ${result.exitCode}`);
  const text = result.output.trim();
  if (!text) throw new Error('The Windows accessibility helper returned nothing.');
  return JSON.parse(text) as Record<string, unknown>;
}

/** Windows UI Automation plus SendInput/mouse events. */
export class WindowsComputerAdapter implements ComputerAdapter {
  private lastApp: string | undefined;

  async observe(options: { app?: string; depth?: number }): Promise<ComputerSnapshot> {
    this.lastApp = options.app;
    const data = await run('observe', { ...(options.app ? { app: options.app } : {}), depth: options.depth ?? 4 });
    return data as unknown as ComputerSnapshot;
  }

  async click(ref: string): Promise<{ ref: string; target: string }> {
    const data = await run('click', { ref, ...(this.lastApp ? { app: this.lastApp } : {}) });
    return { ref, target: String(data.target ?? ref) };
  }

  async type(ref: string, text: string): Promise<{ ref: string; target: string }> {
    const data = await run('type', { ref, text, ...(this.lastApp ? { app: this.lastApp } : {}) });
    return { ref, target: String(data.target ?? ref) };
  }

  async key(key: string): Promise<void> {
    const send = KEY_SEND[key as KeyName];
    if (!send) throw new Error(`Unsupported key "${key}". Use ${Object.keys(KEY_SEND).join(', ')}.`);
    await run('key', { send });
  }

  async scroll(ref: string | undefined, direction: 'up' | 'down', amount: number): Promise<void> {
    await run('scroll', {
      ...(ref ? { ref } : {}),
      direction: direction === 'up' ? 1 : -1,
      amount,
      ...(this.lastApp ? { app: this.lastApp } : {}),
    });
  }

  async apps(): Promise<ComputerAppInfo[]> {
    const data = await run('apps');
    return data as unknown as ComputerAppInfo[];
  }

  async activate(app: string): Promise<void> {
    await run('activate', { app });
    this.lastApp = app;
  }

  async menu(app: string, path: string[]): Promise<void> {
    await run('menu', { app, name: path[path.length - 1] ?? '' });
    this.lastApp = app;
  }

  async capture(): Promise<Buffer> {
    const data = await run('capture');
    return Buffer.from(String(data.base64 ?? ''), 'base64');
  }
}

export const WINDOWS_KEY_NAMES = Object.keys(KEY_SEND);
