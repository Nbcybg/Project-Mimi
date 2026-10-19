# Mimi's icon in the Windows notification area (system tray), and the chat flyout.
# Started by launcher.ts; talks to it over stdin/stdout, one line per message.
#   out: "ready"
#        "open"      the icon was clicked and there is no chat window yet: open one
#        "desktop"   menu: open the big window (Agent / Hub / Settings)
#        "quit"      menu: quit
#        "flyout <ok|none>"   answer to "flyout"
#   in:  "flyout <pid> <width> <height> <margin>"
#                    turn that process's window into the chat flyout: no frame, rounded
#                    corners, not on the taskbar, above the tray; it hides when it loses focus
#        "focus <pid>"      show and raise that process's window (the big window)
#        "balloon<TAB>title<TAB>body"   a Windows notification from the icon
#        "tip <text>"       hover text of the icon
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
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hWnd, int index, int value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hWnd, int attribute, ref int value, int size);

  const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
  const int WS_CAPTION = 0x00C00000, WS_THICKFRAME = 0x00040000, WS_SYSMENU = 0x00080000;
  const int WS_MINIMIZEBOX = 0x00020000, WS_MAXIMIZEBOX = 0x00010000;
  const int WS_EX_TOOLWINDOW = 0x00000080, WS_EX_APPWINDOW = 0x00040000;
  const uint SWP_NOZORDER = 0x0004, SWP_FRAMECHANGED = 0x0020, SWP_SHOWWINDOW = 0x0040;

  public static IntPtr Flyout = IntPtr.Zero;
  public static bool FlyoutSeenActive = false;
  public static long HiddenAt = 0;

  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);

  // The main window of a process: visible, titled and owned by nobody (bubbles and
  // prompts of the browser are owned by it).
  public static IntPtr WindowOf(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hWnd, l) => {
      uint owner;
      GetWindowThreadProcessId(hWnd, out owner);
      if (owner == pid && IsWindowVisible(hWnd) && GetWindowTextLength(hWnd) > 0 && GetWindow(hWnd, 4) == IntPtr.Zero) { found = hWnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void Raise(IntPtr hWnd) {
    ShowWindow(hWnd, IsIconic(hWnd) ? 9 : 5);
    SetForegroundWindow(hWnd);
  }

  const int FRAME = WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;

  // Rounded corners and not on the taskbar: a panel of the tray icon, not an app of its own.
  // (The browser draws its own title bar inside the window, so the frame is left alone.)
  public static void Restyle(IntPtr hWnd) {
    int style = GetWindowLong(hWnd, GWL_STYLE);
    SetWindowLong(hWnd, GWL_STYLE, style & ~(WS_MINIMIZEBOX | WS_MAXIMIZEBOX));
    int ex = GetWindowLong(hWnd, GWL_EXSTYLE);
    SetWindowLong(hWnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW);
    int round = 2; // DWMWCP_ROUND
    DwmSetWindowAttribute(hWnd, 33, ref round, 4);
    SetWindowPos(hWnd, IntPtr.Zero, 0, 0, 0, 0, 0x0001 | 0x0002 | SWP_NOZORDER | SWP_FRAMECHANGED | 0x0010);
  }

  // In the corner above the tray.
  public static void MakeFlyout(IntPtr hWnd, int width, int height, int margin, int areaRight, int areaBottom, int areaTop) {
    Restyle(hWnd);
    double scale = GetDpiForWindow(hWnd) / 96.0;
    if (scale <= 0) scale = 1;
    int w = (int)(width * scale), h = (int)(height * scale), m = (int)(margin * scale);
    if (h > areaBottom - areaTop - 2 * m) h = areaBottom - areaTop - 2 * m;
    // Above other windows, like the flyouts Windows itself opens from the tray.
    SetWindowPos(hWnd, new IntPtr(-1), areaRight - w - m, areaBottom - h - m, w, h, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    Flyout = hWnd;
    ShowFlyout();
  }

  public static void ShowFlyout() {
    FlyoutSeenActive = false;
    SetWindowPos(Flyout, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | SWP_SHOWWINDOW);
    Raise(Flyout);
  }

  public static bool FlyoutShown() {
    return Flyout != IntPtr.Zero && IsWindow(Flyout) && IsWindowVisible(Flyout);
  }

  public static void HideFlyout() {
    if (Flyout == IntPtr.Zero) return;
    ShowWindow(Flyout, 0);
    HiddenAt = DateTime.Now.Ticks;
  }

  // Called by a timer: a flyout that lost the focus goes away, like the ones Windows has.
  public static void Watch() {
    if (!FlyoutShown()) return;
    IntPtr fg = GetForegroundWindow();
    IntPtr root = fg == IntPtr.Zero ? IntPtr.Zero : GetAncestor(fg, 3);
    if (fg == Flyout || root == Flyout) { FlyoutSeenActive = true; return; }
    if (FlyoutSeenActive) HideFlyout();
  }

  // Left click on the icon: true when the flyout handled it (shown or hidden).
  public static bool ToggleFlyout() {
    if (Flyout == IntPtr.Zero || !IsWindow(Flyout)) return false;
    if (FlyoutShown()) { HideFlyout(); return true; }
    // A click that itself took the focus away has just hidden it: leave it hidden.
    if ((DateTime.Now.Ticks - HiddenAt) < 4000000) return true;
    ShowFlyout();
    return true;
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

[void][MimiTray]::SetProcessDPIAware()
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
$openItem.add_Click({ if (-not [MimiTray]::FlyoutShown()) { if (-not [MimiTray]::ToggleFlyout()) { Say 'open' } } })
$desktopItem = $menu.Items.Add((Label 'MIMI_TRAY_DESKTOP' 'Settings (full window)'))
$desktopItem.add_Click({ Say 'desktop' })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quitItem = $menu.Items.Add((Label 'MIMI_TRAY_QUIT' 'Quit'))
$quitItem.add_Click({ Say 'quit' })
$icon.ContextMenuStrip = $menu

$icon.add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    if (-not [MimiTray]::ToggleFlyout()) { Say 'open' }
  }
})
$icon.add_BalloonTipClicked({ if (-not [MimiTray]::ToggleFlyout()) { Say 'open' } })
$icon.Visible = $true

# Waiting for a new chat window to appear: pid, size, deadline.
$script:pending = $null

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.add_Tick({
  [MimiTray]::Watch()
  if ($script:pending) {
    $p = $script:pending
    $hWnd = [MimiTray]::WindowOf([uint32]$p.Pid)
    if ($hWnd -ne [IntPtr]::Zero) {
      $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
      [MimiTray]::MakeFlyout($hWnd, $p.Width, $p.Height, $p.Margin, $area.Right, $area.Bottom, $area.Top)
      $script:pending = $null
      Say 'flyout ok'
    } elseif ([DateTime]::Now -gt $p.Deadline) {
      $script:pending = $null
      Say 'flyout none'
    }
  }
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
    } elseif ($line.StartsWith('flyout ')) {
      $w = $line.Split(' ')
      $script:pending = @{ Pid = $w[1]; Width = [int]$w[2]; Height = [int]$w[3]; Margin = [int]$w[4]; Deadline = [DateTime]::Now.AddSeconds(15) }
    } elseif ($line -eq 'showflyout') {
      if ([MimiTray]::Flyout -ne [IntPtr]::Zero -and [MimiTray]::IsWindow([MimiTray]::Flyout)) {
        [MimiTray]::ShowFlyout()
        Say 'flyout ok'
      } else { Say 'flyout none' }
    } elseif ($line.StartsWith('focus ')) {
      $hWnd = [MimiTray]::WindowOf([uint32]$line.Split(' ')[1])
      if ($hWnd -ne [IntPtr]::Zero) { [MimiTray]::Raise($hWnd); Say 'focus ok' } else { Say 'focus none' }
    } elseif ($line.StartsWith('tip ')) {
      $text = $line.Substring(4)
      if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
      $icon.Text = $text
    }
  }
})
$timer.Start()

[MimiTray]::StartReading()
Say 'ready'
[System.Windows.Forms.Application]::Run()
$icon.Dispose()
