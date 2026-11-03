using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Mimi.App.Native;

/// <summary>
/// A real terminal for the Workspace (what node-pty gives the Electron app): a shell under a Windows pseudo
/// console (ConPTY), so colours, prompts, Ctrl+C, full-screen programs and resizing work. Output arrives as text
/// with VT sequences for xterm.js to draw; input goes in as the keys typed.
/// </summary>
internal sealed partial class ConPty : IDisposable
{
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const int ProcThreadAttributePseudoConsole = 0x00020016;
    private const int StartfUseStdHandles = 0x00000100;

    [StructLayout(LayoutKind.Sequential)]
    private struct Coord
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public nint lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public nint lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public nint hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out SafeFileHandle read, out SafeFileHandle write, nint attributes, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(Coord size, SafeFileHandle input, SafeFileHandle output, uint flags, out nint console);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int ResizePseudoConsole(nint console, Coord size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void ClosePseudoConsole(nint console);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(nint list, int count, int flags, ref nint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(nint list, uint flags, nint attribute, nint value, nint size, nint previous, nint returned);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern void DeleteProcThreadAttributeList(nint list);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string? application, StringBuilder command, nint processAttributes, nint threadAttributes, bool inherit,
        uint flags, nint environment, string? directory, ref StartupInfoEx startup, out ProcessInformation info);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(nint process, uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(nint handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(nint handle, uint milliseconds);

    private readonly nint console;
    private readonly nint attributes;
    private readonly ProcessInformation process;
    private readonly FileStream input;
    private readonly FileStream output;
    private bool disposed;

    /// <summary>Text from the shell (VT sequences included), on a worker thread.</summary>
    public event Action<string>? Output;

    /// <summary>The shell ended.</summary>
    public event Action? Exited;

    public ConPty(string command, string directory, int columns, int rows)
    {
        if (!CreatePipe(out var inRead, out var inWrite, 0, 0) || !CreatePipe(out var outRead, out var outWrite, 0, 0)) throw new Win32Exception();
        var result = CreatePseudoConsole(new Coord { X = (short)columns, Y = (short)rows }, inRead, outWrite, 0, out console);
        if (result != 0) throw new Win32Exception(result, "ConPTY ใช้ไม่ได้บน Windows รุ่นนี้");
        // The console holds its own copies now.
        inRead.Dispose();
        outWrite.Dispose();

        nint size = 0;
        InitializeProcThreadAttributeList(0, 1, 0, ref size);
        attributes = Marshal.AllocHGlobal(size);
        if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref size)) throw new Win32Exception();
        if (!UpdateProcThreadAttribute(attributes, 0, ProcThreadAttributePseudoConsole, console, IntPtr.Size, 0, 0)) throw new Win32Exception();
        var startup = new StartupInfoEx { lpAttributeList = attributes };
        startup.StartupInfo.cb = Marshal.SizeOf<StartupInfoEx>();
        // No standard handles of ours: when the app's own are redirected (started by a test, a launcher), the shell
        // would otherwise write to them instead of the pseudo console.
        startup.StartupInfo.dwFlags = StartfUseStdHandles;
        if (!CreateProcessW(null, new StringBuilder(command), 0, 0, false, ExtendedStartupInfoPresent | CreateUnicodeEnvironment, 0, directory, ref startup, out process))
        {
            throw new Win32Exception();
        }
        input = new FileStream(inWrite, FileAccess.Write);
        output = new FileStream(outRead, FileAccess.Read);
        new Thread(ReadLoop) { IsBackground = true, Name = "workspace terminal" }.Start();
        new Thread(() =>
        {
            WaitForSingleObject(process.hProcess, uint.MaxValue);
            if (!disposed) Exited?.Invoke();
        }) { IsBackground = true }.Start();
    }

    private void ReadLoop()
    {
        var buffer = new byte[8192];
        var decoder = Encoding.UTF8.GetDecoder();
        var chars = new char[Encoding.UTF8.GetMaxCharCount(buffer.Length)];
        try
        {
            while (!disposed)
            {
                var read = output.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                var count = decoder.GetChars(buffer, 0, read, chars, 0);
                if (count > 0) Output?.Invoke(new string(chars, 0, count));
            }
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            // the console closed
        }
    }

    public void Write(string text)
    {
        if (disposed) return;
        try
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            input.Write(bytes, 0, bytes.Length);
            input.Flush();
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException)
        {
            // the shell has gone
        }
    }

    public void Resize(int columns, int rows)
    {
        if (!disposed && columns > 0 && rows > 0) ResizePseudoConsole(console, new Coord { X = (short)columns, Y = (short)rows });
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        TerminateProcess(process.hProcess, 0);
        ClosePseudoConsole(console);
        input.Dispose();
        output.Dispose();
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        DeleteProcThreadAttributeList(attributes);
        Marshal.FreeHGlobal(attributes);
    }
}
