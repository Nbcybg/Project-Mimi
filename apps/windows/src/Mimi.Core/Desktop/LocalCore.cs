using System.Diagnostics;
using System.Text.Json;

namespace Mimi.Core.Desktop;

/// <summary>Where the core on this computer listens and its token (or why it could not start).</summary>
public sealed record LocalCoreReady(int Port, string Token, bool External, string? Error)
{
    public string Address => $"http://127.0.0.1:{Port}";
}

/// <summary>
/// "เซิร์ฟเวอร์ในเครื่องนี้": the app starts the core on this computer itself, as `npm run app` (launcher.ts) did for
/// the Electron app — packages/core/src/app/native-host.ts with the bundled node.exe — reads its address and token
/// from one stdout line, and stops it by closing its stdin when the app quits. A Mimi already running on the
/// port (the Electron app) is used as it is and left running.
/// </summary>
public sealed class LocalCore : IDisposable
{
    public const string Mark = "@@mimi-host@@";

    /// <summary>What to run: node and native-host.ts (from the app folder or the repository).</summary>
    public sealed record Launch(string Node, string Entry, string WorkingDirectory);

    private readonly object gate = new();
    private Process? process;
    private TaskCompletionSource<LocalCoreReady>? starting;

    public bool Running => process is not null;

    /// <summary>The core stopped by itself (not asked to).</summary>
    public event Action<int>? Ended;

    /// <summary>One line of the host's stdout, read: null when it is not the ready line.</summary>
    public static LocalCoreReady? ParseReady(string line)
    {
        if (!line.StartsWith(Mark, StringComparison.Ordinal)) return null;
        try
        {
            using var json = JsonDocument.Parse(line[Mark.Length..]);
            var root = json.RootElement;
            if (root.TryGetProperty("error", out var error) && error.ValueKind == JsonValueKind.String) return new LocalCoreReady(0, "", false, error.GetString());
            if (!root.TryGetProperty("port", out var port) || !port.TryGetInt32(out var number) || number <= 0) return null;
            if (!root.TryGetProperty("token", out var token) || token.ValueKind != JsonValueKind.String || token.GetString()!.Length == 0) return null;
            var external = root.TryGetProperty("external", out var outside) && outside.ValueKind == JsonValueKind.True;
            return new LocalCoreReady(number, token.GetString()!, external, null);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// The packaged app carries the core beside Mimi.exe (core/packages/core/src/app/native-host.ts, scripts/build-win-native.mjs);
    /// from the sources, the repository's copy runs with the node on PATH. Null when neither is there.
    /// </summary>
    public static Launch? Find(string baseDir, string? bundledNode)
    {
        var packaged = Path.Combine(baseDir, "core", "packages", "core", "src", "app", "native-host.ts");
        var node = bundledNode is not null && File.Exists(bundledNode) ? bundledNode : "node";
        if (File.Exists(packaged)) return new Launch(node, packaged, Path.Combine(baseDir, "core"));
        for (var dir = new DirectoryInfo(baseDir); dir is not null; dir = dir.Parent)
        {
            var source = Path.Combine(dir.FullName, "packages", "core", "src", "app", "native-host.ts");
            if (File.Exists(source)) return new Launch("node", source, dir.FullName);
        }
        return null;
    }

    /// <summary>Starts the core (once) and waits for its address; throws when it cannot start.</summary>
    public Task<LocalCoreReady> Start(Launch launch, IReadOnlyDictionary<string, string?>? environment = null, TimeSpan? timeout = null)
    {
        TaskCompletionSource<LocalCoreReady> done;
        lock (gate)
        {
            if (starting is not null) return starting.Task;
            done = starting = new TaskCompletionSource<LocalCoreReady>(TaskCreationOptions.RunContinuationsAsynchronously);
        }
        var start = new ProcessStartInfo(launch.Node)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = System.Text.Encoding.UTF8,
            StandardErrorEncoding = System.Text.Encoding.UTF8,
            WorkingDirectory = launch.WorkingDirectory,
        };
        var env = Path.Combine(launch.WorkingDirectory, ".env");
        if (File.Exists(env)) start.ArgumentList.Add($"--env-file={env}");
        start.ArgumentList.Add(launch.Entry);
        foreach (var (name, value) in environment ?? new Dictionary<string, string?>())
        {
            if (value is null) start.Environment.Remove(name);
            else start.Environment[name] = value;
        }
        Process child;
        try
        {
            child = Process.Start(start)!;
        }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Fail(done, $"เปิด node ไม่ได้: {error.Message}");
            return done.Task;
        }
        lock (gate) process = child;
        child.EnableRaisingEvents = true;
        var lastError = "";
        child.OutputDataReceived += (_, line) =>
        {
            if (line.Data is null || ParseReady(line.Data) is not { } ready) return;
            if (ready.Error is not null) Fail(done, ready.Error);
            else done.TrySetResult(ready);
        };
        child.ErrorDataReceived += (_, line) =>
        {
            if (line.Data is { Length: > 0 } text) lastError = text;
        };
        child.Exited += (_, _) =>
        {
            int code;
            try
            {
                code = child.ExitCode;
            }
            catch (InvalidOperationException)
            {
                code = -1;
            }
            bool asked;
            lock (gate)
            {
                asked = !ReferenceEquals(process, child);
                if (!asked) process = null;
                starting = null;
            }
            // A host that handed over to a Mimi already running ends at once with 0: that is not a failure.
            if (!done.Task.IsCompleted) Fail(done, lastError.Length > 0 ? lastError : $"core หยุดไปก่อนพร้อม (รหัส {code})");
            else if (!asked && done.Task.IsCompletedSuccessfully && !done.Task.Result.External) Ended?.Invoke(code);
            child.Dispose();
        };
        child.BeginOutputReadLine();
        child.BeginErrorReadLine();
        _ = Task.Delay(timeout ?? TimeSpan.FromSeconds(60)).ContinueWith(_ =>
        {
            if (done.Task.IsCompleted) return;
            Fail(done, "core ไม่ตอบภายในเวลาที่กำหนด");
            _ = Stop();
        }, TaskScheduler.Default);
        return done.Task;
    }

    private void Fail(TaskCompletionSource<LocalCoreReady> done, string message)
    {
        lock (gate)
        {
            if (ReferenceEquals(starting, done)) starting = null;
        }
        done.TrySetException(new InvalidOperationException(message));
    }

    /// <summary>Asks the core to stop (stdin closes) and kills it when it has not gone after a few seconds.</summary>
    public async Task Stop()
    {
        Process? child;
        lock (gate)
        {
            child = process;
            process = null;
            starting = null;
        }
        if (child is null) return;
        try
        {
            child.StandardInput.Close();
        }
        catch (Exception error) when (error is IOException or InvalidOperationException)
        {
        }
        using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(6));
        try
        {
            await child.WaitForExitAsync(wait.Token).ConfigureAwait(false);
        }
        catch (Exception error) when (error is OperationCanceledException or InvalidOperationException)
        {
            try
            {
                child.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
            }
        }
    }

    public void Dispose() => _ = Stop();
}
