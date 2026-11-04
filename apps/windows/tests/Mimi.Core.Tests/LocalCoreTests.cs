using System.Net;
using System.Net.Sockets;
using Mimi.Core.Desktop;

namespace Mimi.Core.Tests;

public sealed class LocalCoreTests
{
    [Fact]
    public void The_ready_line_gives_the_address_and_token_or_the_error()
    {
        var ready = LocalCore.ParseReady("""@@mimi-host@@{"port":8790,"token":"abc","version":"0.8.1"}""")!;
        Assert.Equal((8790, "abc", false, (string?)null), (ready.Port, ready.Token, ready.External, ready.Error));
        Assert.Equal("http://127.0.0.1:8790", ready.Address);
        Assert.True(LocalCore.ParseReady("""@@mimi-host@@{"port":8787,"token":"abc","external":true}""")!.External);
        Assert.Equal("Missing settings file", LocalCore.ParseReady("""@@mimi-host@@{"error":"Missing settings file"}""")!.Error);
        Assert.Null(LocalCore.ParseReady("""{"port":1,"token":"x"}"""));
        Assert.Null(LocalCore.ParseReady("""@@mimi-host@@{"port":1}"""));
        Assert.Null(LocalCore.ParseReady("@@mimi-host@@{oops"));
    }

    private static string? Repository()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "packages", "core", "src", "app", "native-host.ts")) && Directory.Exists(Path.Combine(dir.FullName, "node_modules"))) return dir.FullName;
        }
        return null;
    }

    /// <summary>The real host from the repository (needs node on PATH and npm install); skipped quietly without them.</summary>
    [Fact]
    public async Task The_core_of_this_computer_starts_answers_and_stops()
    {
        if (Repository() is not { } repo) return;
        var launch = LocalCore.Find(AppContext.BaseDirectory, null)!;
        Assert.Equal(Path.Combine(repo, "packages", "core", "src", "app", "native-host.ts"), launch.Entry);
        var root = Directory.CreateTempSubdirectory("mimi-local-core-").FullName;
        File.Copy(Path.Combine(repo, "mimi.json"), Path.Combine(root, "mimi.json"));
        var probe = new TcpListener(IPAddress.Loopback, 0);
        probe.Start();
        var port = ((IPEndPoint)probe.LocalEndpoint).Port;
        probe.Stop();
        using var core = new LocalCore();
        try
        {
            var ready = await core.Start(launch, new Dictionary<string, string?> { ["MIMI_ROOT"] = root, ["PORT"] = port.ToString(), ["MIMI_TOKEN"] = null, ["MIMI_CALENDAR_SYNC"] = "0" }, TimeSpan.FromSeconds(60));
            Assert.Equal(port, ready.Port);
            Assert.False(ready.External);
            Assert.True(core.Running);
            using var http = new HttpClient();
            Assert.Contains("\"ok\":true", await http.GetStringAsync($"{ready.Address}/health"));
            await core.Stop();
            Assert.False(core.Running);
            await Assert.ThrowsAnyAsync<HttpRequestException>(() => http.GetStringAsync($"{ready.Address}/health"));
        }
        finally
        {
            await core.Stop();
            Directory.Delete(root, recursive: true);
        }
    }
}
