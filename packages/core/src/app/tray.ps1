# Mimi's icon in the Windows notification area (system tray).
# Started by launcher.ts; talks to it over stdin/stdout, one line per message.
#   out: "ready <x> <y> <width> <height>"  (work area of the main screen)
#        "open" | "desktop" | "quit"
#   in:  "toggle <pid>"                     show/raise or minimise the window of that process
#        "focus <pid>"                      show/raise it
#        "balloon<TAB>title<TAB>body"       a Windows notification from the icon
#        "tip <text>"                       hover text of the icon
# Menu labels come from environment variables so this file stays plain ASCII
# (Windows PowerShell 5.1 reads scripts without a BOM in the ANSI code page).
param([string]$IconPng)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MimiTray {
  public static readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();

  // stdin is read on a thread of its own; the WinForms loop polls the queue.
  public static void StartReading() {
    var thread = new Thread(() => {
      string line;
      try { while ((line = Console.In.ReadLine()) != null) Lines.Enqueue(line); } catch { }
      Lines.Enqueue("__eof");
    });
    thread.IsBackground = true;
    thread.Start();
  }

  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

  // The first visible, titled top-level window of a process.
  public static IntPtr WindowOf(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, l) => {
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if (owner == pid && IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0) { found = hWnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // 0 = no such window, 1 = shown, 2 = minimised.
  public static int Toggle(uint pid, bool onlyShow) {
    IntPtr hWnd = WindowOf(pid);
    if (hWnd == IntPtr.Zero) return 0;
    if (!onlyShow && !IsIconic(hWnd) && GetForegroundWindow() == hWnd) { ShowWindow(hWnd, 6); return 2; }
    ShowWindow(hWnd, IsIconic(hWnd) ? 9 : 5);
    SetForegroundWindow(hWnd);
    return 1;
  }
}
'@

function Say([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}
function Label([string]$name, [string]$fallback) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrEmpty($value)) { return $fallback } else { return $value }
}

$icon = New-Object System.Windows.Forms.NotifyIcon
try {
  $bitmap = New-Object System.Drawing.Bitmap $IconPng
  $small = New-Object System.Drawing.Bitmap $bitmap, 32, 32
  $icon.Icon = [System.Drawing.Icon]::FromHandle($small.GetHicon())
} catch {
  $icon.Icon = [System.Drawing.SystemIcons]::Application
}
$icon.Text = Label 'MIMI_TRAY_TIP' 'Mimi'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add((Label 'MIMI_TRAY_OPEN' 'Open Mimi'))
$openItem.Font = New-Object System.Drawing.Font($openItem.Font, [System.Drawing.FontStyle]::Bold)
$openItem.add_Click({ Say 'open' })
$desktopItem = $menu.Items.Add((Label 'MIMI_TRAY_DESKTOP' 'Settings (full window)'))
$desktopItem.add_Click({ Say 'desktop' })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quitItem = $menu.Items.Add((Label 'MIMI_TRAY_QUIT' 'Quit'))
$quitItem.add_Click({ Say 'quit' })
$icon.ContextMenuStrip = $menu

$icon.add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Say 'open' }
})
$icon.add_BalloonTipClicked({ Say 'open' })
$icon.Visible = $true

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.add_Tick({
  $line = $null
  while ([MimiTray]::Lines.TryDequeue([ref]$line)) {
    if ($line -eq '__eof') {
      $icon.Visible = $false
      [System.Windows.Forms.Application]::Exit()
      return
    }
    $parts = $line.Split([char]9)
    if ($parts[0] -eq 'balloon' -and $parts.Length -ge 3) {
      $body = $parts[2].Replace('\n', [Environment]::NewLine)
      if ($body.Length -eq 0) { $body = ' ' }
      $icon.ShowBalloonTip(8000, $parts[1], $body, [System.Windows.Forms.ToolTipIcon]::None)
    } elseif ($line.StartsWith('toggle ') -or $line.StartsWith('focus ')) {
      $words = $line.Split(' ')
      $state = [MimiTray]::Toggle([uint32]$words[1], $words[0] -eq 'focus')
      Say ("window $($words[1]) $state")
    } elseif ($line.StartsWith('tip ')) {
      $text = $line.Substring(4)
      if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
      $icon.Text = $text
    }
  }
})
$timer.Start()

[MimiTray]::StartReading()
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
Say ("ready $($area.X) $($area.Y) $($area.Width) $($area.Height)")
[System.Windows.Forms.Application]::Run()
$icon.Dispose()
