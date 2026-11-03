using System.Runtime.InteropServices;
using static Mimi.App.Native.Win32;

namespace Mimi.App.Native;

/// <summary>One line of the tray menu. <see cref="Children"/> makes a submenu; null <see cref="Text"/> is a separator.</summary>
internal sealed record TrayItem(string? Text, Action? Click = null, bool Checked = false, bool Enabled = true, bool Radio = false, IReadOnlyList<TrayItem>? Children = null)
{
    public static readonly TrayItem Separator = new((string?)null);
}

/// <summary>
/// The icon in the notification area and its menu (the Electron app's Tray), on a message-only window of
/// its own. A click shows / hides the window; the menu is built fresh each time it opens. The same window
/// hears when the screen is locked (auto-lock: remote.cjs "lock-screen").
/// </summary>
internal sealed class TrayIcon : IDisposable
{
    private const uint CallbackMessage = WM_APP + 1;
    private const uint IconId = 1;

    private readonly WndProc proc;
    private readonly nint window;
    private readonly uint taskbarCreated;
    private readonly nint icon;
    private readonly Func<IReadOnlyList<TrayItem>> menu;
    private string tip = "Mimi";
    private bool added;

    public event Action? Clicked;
    public event Action? ScreenLocked;

    public TrayIcon(string iconFile, Func<IReadOnlyList<TrayItem>> menu)
    {
        this.menu = menu;
        proc = Handle; // kept alive: the window calls it until it is destroyed
        var instance = GetModuleHandleW(null);
        var name = "MimiTray" + Environment.ProcessId;
        var windowClass = new WNDCLASSEXW
        {
            cbSize = Marshal.SizeOf<WNDCLASSEXW>(),
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(proc),
            hInstance = instance,
            lpszClassName = name,
        };
        RegisterClassExW(ref windowClass);
        window = CreateWindowExW(0, name, "Mimi tray", 0, 0, 0, 0, 0, HWND_MESSAGE, 0, instance, 0);
        // Explorer restarted: the icon has to be added again.
        taskbarCreated = RegisterWindowMessageW("TaskbarCreated");
        var size = GetSystemMetrics(49); // SM_CXSMICON
        icon = LoadImageW(0, iconFile, IMAGE_ICON, size, size, LR_LOADFROMFILE);
        WTSRegisterSessionNotification(window, 0);
        Add();
    }

    private NOTIFYICONDATAW Data(uint flags) => new()
    {
        cbSize = Marshal.SizeOf<NOTIFYICONDATAW>(),
        hWnd = window,
        uID = IconId,
        uFlags = flags,
        uCallbackMessage = CallbackMessage,
        hIcon = icon,
        szTip = tip,
        szInfo = "",
        szInfoTitle = "",
    };

    private void Add()
    {
        var data = Data(NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP);
        added = Shell_NotifyIconW(NIM_ADD, ref data);
        data.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIconW(NIM_SETVERSION, ref data);
    }

    public string Tip
    {
        get => tip;
        set
        {
            tip = value.Length > 127 ? value[..127] : value;
            var data = Data(NIF_TIP | NIF_SHOWTIP);
            Shell_NotifyIconW(NIM_MODIFY, ref data);
        }
    }

    private nint Handle(nint hWnd, uint msg, nint wParam, nint lParam)
    {
        if (msg == CallbackMessage)
        {
            // NOTIFYICON_VERSION_4: the event is in the low word of lParam.
            var what = (int)(lParam & 0xFFFF);
            if (what is WM_LBUTTONUP or NIN_SELECT or NIN_KEYSELECT) Clicked?.Invoke();
            else if (what is WM_RBUTTONUP or WM_CONTEXTMENU) ShowMenu();
            return 0;
        }
        if (msg == WM_WTSSESSION_CHANGE && (int)wParam == WTS_SESSION_LOCK)
        {
            ScreenLocked?.Invoke();
            return 0;
        }
        if (msg == taskbarCreated && taskbarCreated != 0)
        {
            Add();
            return 0;
        }
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    private void ShowMenu()
    {
        var actions = new List<Action?>();
        var root = Build(menu(), actions);
        GetCursorPos(out var at);
        // The menu closes when clicking elsewhere only if its window is in front.
        SetForegroundWindow(window);
        var chosen = TrackPopupMenuEx(root, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, at.X, at.Y, window, 0);
        PostMessageW(window, 0, 0, 0);
        DestroyMenu(root);
        if (chosen > 0 && chosen <= actions.Count) actions[chosen - 1]?.Invoke();
    }

    private static nint Build(IReadOnlyList<TrayItem> items, List<Action?> actions)
    {
        var handle = CreatePopupMenu();
        foreach (var item in items)
        {
            if (item.Text is null)
            {
                AppendMenuW(handle, MF_SEPARATOR, 0, null);
            }
            else if (item.Children is not null)
            {
                AppendMenuW(handle, MF_POPUP | (item.Enabled ? 0 : MF_GRAYED), Build(item.Children, actions), item.Text);
            }
            else
            {
                actions.Add(item.Click);
                var flags = MF_STRING | (item.Checked ? MF_CHECKED : 0) | (item.Radio ? MF_RADIOCHECK : 0) | (item.Enabled && item.Click is not null ? 0 : MF_GRAYED);
                AppendMenuW(handle, flags, actions.Count, item.Text);
            }
        }
        return handle;
    }

    public void Dispose()
    {
        if (added)
        {
            var data = Data(0);
            Shell_NotifyIconW(NIM_DELETE, ref data);
            added = false;
        }
        WTSUnRegisterSessionNotification(window);
        DestroyWindow(window);
        if (icon != 0) DestroyIcon(icon);
    }
}
