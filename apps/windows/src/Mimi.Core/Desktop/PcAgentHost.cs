using System.Diagnostics;
using System.Text.Json;

namespace Mimi.Core.Desktop;

/// <summary>A question of the PC agent before it changes something on this computer (MIMI_CONSENT_STDIO).</summary>
public sealed record ConsentRequest(string Id, string Tool, string Risk, string Summary);

/// <summary>
/// The PC agent (packages/pc-agent) stays its own Node program: this app starts and stops it and shows
/// its state, as the Electron app did (remote.cjs startPcAgent). The token goes in through stdin, never
/// the environment; closing stdin stops the agent. The agent asks for consent on stdout lines that start
/// with <c>@@mimi-consent@@</c> and gets the answer back as a JSON line on stdin.
/// </summary>
public sealed class PcAgentHost(Func<PcAgentHost.Launch?> launch) : IDisposable
{
    public const string ConsentPrefix = "@@mimi-consent@@";

    /// <summary>What to run: node and the agent's main.ts, with the token and the environment.</summary>
    public sealed record Launch(string Node, string Entry, string Token, IReadOnlyDictionary<string, string> Environment);

    private readonly object gate = new();
    private Process? process;
    private bool stopping;
    private TimeSpan retry = TimeSpan.FromSeconds(2);
    private CancellationTokenSource? restart;

    public string Status { get; private set; } = "ปิด";
    public bool Running => process is not null;

    public event Action<string>? StatusChanged;
    /// <summary>Answer with <see cref="Answer"/>; no answer is a "no" once the agent gives up.</summary>
    public event Action<ConsentRequest>? Consent;

    /// <summary>The variables the agent runs with: only what a shell needs, plus where to connect (remote.cjs).</summary>
    public static Dictionary<string, string> AgentEnvironment(
        string coreWsUrl,
        IReadOnlyList<string> folders,
        IReadOnlyList<string> apps,
        bool shell,
        string browserProfile,
        IReadOnlyDictionary<string, string?> current)
    {
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in new[] { "PATH", "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH", "USERNAME", "COMPUTERNAME", "PATHEXT", "ComSpec", "ProgramFiles", "ProgramFiles(x86)", "ProgramData" })
        {
            if (current.TryGetValue(name, out var value) && value is not null) env[name] = value;
        }
        if (current.TryGetValue("USERPROFILE", out var home) && home is not null) env["HOME"] = home;
        env["MIMI_TOKEN_STDIN"] = "1";
        env["MIMI_CONSENT_STDIO"] = "1";
        env["MIMI_PC_SHELL"] = shell ? "1" : "0";
        env["MIMI_CORE_URL"] = coreWsUrl;
        env["ALLOWED_DIRS"] = string.Join(';', folders);
        env["MIMI_ALLOWED_APPS"] = string.Join(';', apps);
        env["MIMI_BROWSER_PROFILE"] = browserProfile;
        // No MIMI_BROWSER_PATH: without the Electron shell the agent drives the Edge or Chrome it finds.
        env["MIMI_PC_NAME"] = $"{Environment.UserName}@{Environment.MachineName}";
        return env;
    }

    /// <summary>What one line of the agent's output means for its status; null = nothing to show.</summary>
    public static string? StatusOf(string line) =>
        line.Contains("connected to ", StringComparison.Ordinal) && !line.Contains("disconnected", StringComparison.Ordinal) ? "เชื่อมต่อแล้ว"
        : line.Contains("rejected the token", StringComparison.Ordinal) ? "เซิร์ฟเวอร์ไม่รับ"
        : line.Contains("disconnected", StringComparison.Ordinal) ? "หลุด กำลังต่อใหม่…"
        : null;

    public static ConsentRequest? ParseConsent(string line)
    {
        if (!line.StartsWith(ConsentPrefix, StringComparison.Ordinal)) return null;
        try
        {
            using var json = JsonDocument.Parse(line[ConsentPrefix.Length..]);
            var root = json.RootElement;
            if (!root.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String) return null;
            string Text(string key) => root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString()! : "";
            return new ConsentRequest(id.GetString()!, Text("tool"), Text("risk"), Text("summary"));
        }
        catch (JsonException)
        {
            // a malformed line can only be a bug; no action is safer than a guess
            return null;
        }
    }

    private void SetStatus(string text)
    {
        Status = text;
        StatusChanged?.Invoke(text);
    }

    public void Start()
    {
        lock (gate)
        {
            if (process is not null) return;
            restart?.Cancel();
            stopping = false;
        }
        var what = launch();
        if (what is null)
        {
            SetStatus("ไม่มีโฟลเดอร์ที่ใช้ได้");
            return;
        }
        var start = new ProcessStartInfo(what.Node, [what.Entry])
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
            WorkingDirectory = Path.GetDirectoryName(what.Entry)!,
        };
        start.Environment.Clear();
        foreach (var (name, value) in what.Environment) start.Environment[name] = value;
        Process child;
        try
        {
            child = Process.Start(start)!;
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            SetStatus($"เริ่มไม่ได้: {error.Message}");
            return;
        }
        lock (gate) process = child;
        SetStatus("กำลังเชื่อมต่อ…");
        child.StandardInput.AutoFlush = true;
        // stdin stays open: closing it stops the agent.
        child.StandardInput.WriteLine(what.Token);
        child.EnableRaisingEvents = true;
        child.OutputDataReceived += (_, line) =>
        {
            if (line.Data is null) return;
            if (ParseConsent(line.Data) is { } request) Consent?.Invoke(request);
            else if (StatusOf(line.Data) is { } status)
            {
                if (status == "เชื่อมต่อแล้ว") retry = TimeSpan.FromSeconds(2);
                SetStatus(status);
            }
        };
        child.ErrorDataReceived += (_, line) =>
        {
            if (line.Data is not null && StatusOf(line.Data) is { } status) SetStatus(status);
        };
        child.Exited += (_, _) => OnExit(child);
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();
    }

    private void OnExit(Process child)
    {
        bool again;
        TimeSpan wait;
        CancellationToken cancel;
        lock (gate)
        {
            if (!ReferenceEquals(process, child)) return;
            process = null;
            again = !stopping;
            wait = retry;
            retry = TimeSpan.FromTicks(Math.Min(retry.Ticks * 2, TimeSpan.FromMinutes(1).Ticks));
            restart = new CancellationTokenSource();
            cancel = restart.Token;
        }
        child.Dispose();
        if (!again)
        {
            SetStatus("ปิด");
            return;
        }
        SetStatus("หยุดไป กำลังเริ่มใหม่…");
        _ = Task.Delay(wait, cancel).ContinueWith(task =>
        {
            if (!task.IsCanceled) Start();
        }, TaskScheduler.Default);
    }

    /// <summary>The user's answer to a consent question.</summary>
    public void Answer(string id, bool allow)
    {
        Process? child;
        lock (gate) child = process;
        try
        {
            child?.StandardInput.WriteLine(JsonSerializer.Serialize(new { type = "consent-response", id, allow }));
        }
        catch (Exception error) when (error is IOException or InvalidOperationException or ObjectDisposedException)
        {
            // the agent is gone; its tool call fails anyway
        }
    }

    /// <summary>Stops the agent at once; it closes its browser on the way out (a few seconds at most).</summary>
    public async Task Stop()
    {
        Process? child;
        lock (gate)
        {
            stopping = true;
            restart?.Cancel();
            child = process;
        }
        if (child is null)
        {
            SetStatus("ปิด");
            return;
        }
        try
        {
            child.StandardInput.Close();
        }
        catch (Exception error) when (error is IOException or InvalidOperationException)
        {
        }
        using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(4));
        try
        {
            await child.WaitForExitAsync(wait.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            try
            {
                child.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
            }
        }
        SetStatus("ปิด");
    }

    public void Dispose() => _ = Stop();
}
