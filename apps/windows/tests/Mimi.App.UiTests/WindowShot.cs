using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using FlaUI.Core.AutomationElements;

namespace Mimi.App.UiTests;

/// <summary>A picture of the app's window alone (PrintWindow), so nothing else on the screen ends up in a test's pictures.</summary>
internal static class WindowShot
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(nint window, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(nint window, nint dc, uint flags);

    public static void Save(Window window, string file)
    {
        var handle = window.Properties.NativeWindowHandle.ValueOrDefault;
        if (handle == 0 || !GetWindowRect(handle, out var rect)) return;
        using var bitmap = new Bitmap(Math.Max(1, rect.Right - rect.Left), Math.Max(1, rect.Bottom - rect.Top));
        using (var graphics = Graphics.FromImage(bitmap))
        {
            var dc = graphics.GetHdc();
            // PW_RENDERFULLCONTENT: the WinUI composition content too.
            PrintWindow(handle, dc, 2);
            graphics.ReleaseHdc(dc);
        }
        bitmap.Save(file, ImageFormat.Png);
    }
}
