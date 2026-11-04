using System.Net;
using System.Text;
using System.Text.Json;
using Mimi.Core.Desktop;
using Mimi.Core.Net;
using Mimi.Core.Protocol;

namespace Mimi.Core.Tests;

public class SpeechAndFormatTests
{
    [Fact]
    public void A_direction_line_is_taken_off_and_read()
    {
        var parsed = Speech.Parse("[emotion: ยินดี][speed: 3]\nสวัสดีค่ะ");
        Assert.Equal("สวัสดีค่ะ", parsed.Text);
        Assert.Equal("ยินดี", parsed.Speech?.Emotion);
        Assert.Equal(2.0, parsed.Speech?.Speed);
        Assert.Equal("[link] text", Speech.Parse("[link] text").Text);
        // While streaming, a first line that may still become a direction line is held back.
        Assert.Equal("", Speech.Parse("[emotion: ยิน", live: true).Text);
    }

    [Fact]
    public void Text_is_split_like_the_web_does()
    {
        var blocks = MessageFormat.Blocks("ดู **ตัวหนา** กับ `code` และ *ยิ้ม* ที่ https://example.com/a @มิมิ\n```js\nlet x = 1\n```\nจบ");
        Assert.Equal(3, blocks.Count);
        var spans = Assert.IsType<Block.Paragraph>(blocks[0]).Spans;
        Assert.Contains(spans, span => span is Span.Bold { Value: "ตัวหนา" });
        Assert.Contains(spans, span => span is Span.Code { Value: "code" });
        Assert.Contains(spans, span => span is Span.Action { Value: "ยิ้ม" });
        Assert.Contains(spans, span => span is Span.Link { Url: "https://example.com/a" });
        Assert.Contains(spans, span => span is Span.Mention { Value: "@มิมิ" });
        Assert.Equal("let x = 1", Assert.IsType<Block.Code>(blocks[1]).Text);
        Assert.Equal("x จบ", MessageFormat.Preview("```x```จบ"));
    }
}

public class AddressAndConfigTests
{
    [Theory]
    [InlineData("mimi.example.com", "https://mimi.example.com")]
    [InlineData("https://mimi.example.com/some/page?x=1", "https://mimi.example.com")]
    [InlineData("http://localhost:8787", "http://localhost:8787")]
    [InlineData("http://127.0.0.1:8787/", "http://127.0.0.1:8787")]
    public void Server_addresses_become_an_origin(string input, string expected) => Assert.Equal(expected, ServerAddress.Normalize(input));

    [Theory]
    [InlineData("http://mimi.example.com")]
    [InlineData("http://192.168.0.5:8787")]
    [InlineData("https://user:pass@mimi.example.com")]
    [InlineData("")]
    public void Unsafe_or_empty_addresses_are_refused(string input) => Assert.Throws<FormatException>(() => ServerAddress.Normalize(input));

    [Fact]
    public void The_socket_url_follows_the_scheme()
    {
        Assert.Equal("wss://mimi.example.com/ws", ServerAddress.WebSocketUrl("https://mimi.example.com").ToString());
        Assert.Equal("ws://localhost:8787/ws", ServerAddress.WebSocketUrl("http://localhost:8787").ToString());
    }

    [Fact]
    public void Folders_must_be_inside_home_and_not_system_ones()
    {
        var home = @"C:\Users\someone";
        Assert.Null(AppConfig.FolderProblem(@"C:\Users\someone\Mimi-Workspace", home));
        Assert.NotNull(AppConfig.FolderProblem(home, home));
        Assert.NotNull(AppConfig.FolderProblem(@"C:\Windows", home));
        Assert.NotNull(AppConfig.FolderProblem(@"C:\Users\someone\AppData\Roaming", home));
        Assert.NotNull(AppConfig.FolderProblem(@"relative\dir", home));
    }

    [Fact]
    public void The_Electron_config_is_read_and_its_unknown_fields_survive_a_write()
    {
        var dir = Directory.CreateTempSubdirectory("mimi-config-");
        try
        {
            var home = dir.FullName;
            var file = Path.Combine(dir.FullName, "config.json");
            File.WriteAllText(file, JsonSerializer.Serialize(new
            {
                server = "https://mimi.example.com/",
                autoLockMinutes = 15,
                pcAgent = new { enabled = false, autoOn = 1, shell = true, folders = new[] { Path.Combine(home, "Work"), @"C:\Windows" }, apps = new[] { " notepad " } },
                window = new { bounds = new { x = 10, y = 20, width = 410, height = 820 }, maximized = false, hideOnBlur = true, onTop = false },
                somethingNew = "kept",
            }));
            var config = AppConfig.Read(file, home);
            Assert.Equal("https://mimi.example.com", config.Server);
            Assert.Equal(15, config.AutoLockMinutes);
            Assert.False(config.PcAgent.Enabled);
            Assert.True(config.PcAgent.Shell);
            Assert.Equal([Path.Combine(home, "Work")], config.PcAgent.Folders);
            Assert.Equal(["notepad"], config.PcAgent.Apps);
            Assert.Equal(new WindowBounds(10, 20, 410, 820), config.Window.Bounds);
            Assert.True(config.Window.HideOnBlur);

            config.TextSize = 2;
            config.LastNotificationId = 41;
            config.Write(file);
            var json = JsonDocument.Parse(File.ReadAllText(file)).RootElement;
            Assert.Equal("kept", json.GetProperty("somethingNew").GetString());
            Assert.False(json.GetProperty("pcAgent").GetProperty("enabled").GetBoolean());
            Assert.Equal(1, json.GetProperty("pcAgent").GetProperty("autoOn").GetInt32());
            var again = AppConfig.Read(file, home);
            Assert.Equal(2, again.TextSize);
            Assert.Equal(41, again.LastNotificationId);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public void A_config_from_before_the_default_flipped_turns_the_pc_agent_on_once()
    {
        var dir = Directory.CreateTempSubdirectory("mimi-config-");
        try
        {
            var file = Path.Combine(dir.FullName, "config.json");
            File.WriteAllText(file, """{"server":"","pcAgent":{"enabled":false}}""");
            Assert.True(AppConfig.Read(file, dir.FullName).PcAgent.Enabled);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public void The_session_is_sealed_and_only_given_back_for_its_server()
    {
        var dir = Directory.CreateTempSubdirectory("mimi-vault-");
        try
        {
            var vault = new SessionVault(Path.Combine(dir.FullName, "session.dpapi"));
            vault.Store(new SavedSession("https://a.example", "secret-token-123", "tester", true));
            Assert.DoesNotContain("secret-token-123", Encoding.UTF8.GetString(File.ReadAllBytes(vault.File)));
            Assert.Equal("secret-token-123", vault.Load("https://a.example")?.Token);
            Assert.Null(vault.Load("https://b.example"));
            // "Not my device": nothing is written.
            vault.Store(new SavedSession("https://a.example", "t2", "", Remember: false));
            Assert.False(File.Exists(vault.File));
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public void The_agents_browser_profile_does_not_reveal_the_account()
    {
        var folders = AppFolders.For(@"C:\Users\x\AppData\Roaming", @"C:\Users\x\AppData\Local");
        var dir = folders.AgentBrowserDir("https://mimi.example.com", "tester");
        Assert.StartsWith(@"C:\Users\x\AppData\Local\Mimi\agent-browser\", dir);
        Assert.DoesNotContain("tester", dir);
        Assert.Equal(dir, folders.AgentBrowserDir("https://mimi.example.com", "tester"));
    }
}

public class UpdaterTests
{
    [Theory]
    [InlineData("v1.2.10", "1.2.9", true)]
    [InlineData("0.9.0", "0.8.1-prototype", true)]
    [InlineData("0.8.1", "0.8.1-prototype", false)]
    [InlineData("0.8.0", "0.8.1", false)]
    public void Versions_compare_like_the_Electron_updater(string candidate, string current, bool newer) => Assert.Equal(newer, Updater.IsNewer(candidate, current));

    private static JsonElement Release(bool prerelease = false) => JsonDocument.Parse(JsonSerializer.Serialize(new
    {
        tag_name = "v0.9.0",
        draft = false,
        prerelease,
        html_url = "https://github.com/x/y/releases/v0.9.0",
        assets = new object[]
        {
            new { name = "Mimi-0.9.0-win-x64.zip", browser_download_url = "https://dl/x64.zip", size = 1234 },
            new { name = "Mimi-0.9.0-win-arm64.zip", browser_download_url = "https://dl/arm64.zip", size = 1200 },
            new { name = "SHA256SUMS.txt", browser_download_url = "https://dl/sums", size = 100 },
        },
    })).RootElement;

    [Fact]
    public void A_newer_release_with_a_build_for_this_computer_is_offered()
    {
        var update = Updater.FromRelease(Release(), "0.8.1-prototype", "arm64")!;
        Assert.Equal("0.9.0", update.Version);
        Assert.Equal("https://dl/arm64.zip", update.Url);
        Assert.Equal("https://dl/sums", update.SumsUrl);
        Assert.Null(Updater.FromRelease(Release(prerelease: true), "0.8.1", "x64"));
        Assert.Null(Updater.FromRelease(Release(), "0.9.0", "x64"));
    }

    [Fact]
    public void The_download_must_match_the_published_checksum()
    {
        var zip = Path.GetTempFileName();
        try
        {
            File.WriteAllText(zip, "the app");
            var hash = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes("the app")));
            var update = new UpdateInfo("0.9.0", "u", "Mimi-0.9.0-win-x64.zip", 7, null, "s");
            Updater.CheckDownload(zip, update, $"{hash}  Mimi-0.9.0-win-x64.zip\n");
            Assert.Throws<InvalidDataException>(() => Updater.CheckDownload(zip, update, $"{new string('0', 64)} *Mimi-0.9.0-win-x64.zip\n"));
            Assert.Throws<InvalidDataException>(() => Updater.CheckDownload(zip, update, "nothing here"));
            Assert.Throws<InvalidDataException>(() => Updater.CheckDownload(zip, update with { Size = 8 }, $"{hash}  Mimi-0.9.0-win-x64.zip"));
        }
        finally
        {
            File.Delete(zip);
        }
    }

    [Fact]
    public void A_signed_app_takes_only_an_update_from_the_same_publisher()
    {
        (bool, string?) Signed(string file) => file == "next-bad" ? (true, "CN=Someone Else") : file == "unsigned" ? (false, null) : (true, "CN=Mimi");
        Updater.CheckSignature("current", "next", Signed);
        Assert.Throws<InvalidDataException>(() => Updater.CheckSignature("current", "next-bad", Signed));
        Assert.Throws<InvalidDataException>(() => Updater.CheckSignature("current", "unsigned", Signed));
        Updater.CheckSignature("unsigned", "anything", Signed); // nothing to compare against
    }

    [Fact]
    public void The_swap_script_waits_mirrors_and_restarts()
    {
        var script = Updater.SwapScript(42, @"C:\stage\new\Mimi", @"C:\Apps\Mimi", @"C:\stage");
        Assert.Contains("PID eq 42", script);
        Assert.Contains("robocopy \"C:\\stage\\new\\Mimi\" \"C:\\Apps\\Mimi\" /MIR /XF \"Uninstall Mimi.exe\"", script);
        Assert.Contains("start \"\" \"C:\\Apps\\Mimi\\Mimi.exe\"", script);
    }
}

public class PcAgentTests
{
    [Fact]
    public void Consent_lines_and_status_lines_are_read()
    {
        var request = PcAgentHost.ParseConsent("""@@mimi-consent@@{"id":"c1","tool":"write_file","risk":"write","summary":"เขียนไฟล์ a.txt"}""");
        Assert.Equal(new ConsentRequest("c1", "write_file", "write", "เขียนไฟล์ a.txt"), request);
        Assert.Null(PcAgentHost.ParseConsent("@@mimi-consent@@{broken"));
        Assert.Null(PcAgentHost.ParseConsent("hello"));
        Assert.Equal("เชื่อมต่อแล้ว", PcAgentHost.StatusOf("[pc-agent] connected to ws://localhost:8787/ws"));
        Assert.Equal("หลุด กำลังต่อใหม่…", PcAgentHost.StatusOf("[pc-agent] disconnected (1006); retrying"));
        Assert.Equal("เซิร์ฟเวอร์ไม่รับ", PcAgentHost.StatusOf("core rejected the token"));
        Assert.Null(PcAgentHost.StatusOf("tool ran"));
    }

    [Fact]
    public void The_agent_gets_no_token_in_its_environment()
    {
        var env = PcAgentHost.AgentEnvironment("ws://localhost:8787/ws", [@"C:\Users\x\Work"], [], shell: false, @"C:\cache\agent-browser\1",
            new Dictionary<string, string?> { ["PATH"] = @"C:\Windows", ["USERPROFILE"] = @"C:\Users\x", ["MIMI_TOKEN"] = "leak", ["SECRET_KEY"] = "leak" });
        Assert.Equal("1", env["MIMI_TOKEN_STDIN"]);
        Assert.Equal("0", env["MIMI_PC_SHELL"]);
        Assert.Equal(@"C:\Users\x", env["HOME"]);
        Assert.DoesNotContain(env.Values, value => value == "leak");
        Assert.False(env.ContainsKey("MIMI_BROWSER_PATH"));
    }
}

/// <summary>An HTTP server in the test for the range stream and the API client.</summary>
public sealed class LocalServer : IDisposable
{
    private HttpListener listener = new();
    public string Url { get; } = "";
    public List<string> Ranges { get; } = [];
    public Func<HttpListenerContext, Task>? Handle { get; set; }

    public LocalServer()
    {
        // A free port: a random one, again when another test (or program) holds it.
        for (var attempt = 0; ; attempt++)
        {
            Url = $"http://127.0.0.1:{Random.Shared.Next(20000, 60000)}";
            listener = new HttpListener();
            listener.Prefixes.Add(Url + "/");
            try
            {
                listener.Start();
                break;
            }
            catch (HttpListenerException) when (attempt < 20)
            {
                listener.Close();
            }
        }
        _ = Loop();
    }

    private async Task Loop()
    {
        while (listener.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync();
            }
            catch (Exception)
            {
                return;
            }
            Ranges.Add(context.Request.Headers["Range"] ?? "");
            try
            {
                if (Handle is not null) await Handle(context);
            }
            finally
            {
                context.Response.Close();
            }
        }
    }

    public void Dispose() => listener.Close();
}

public class HttpTests
{
    private static async Task ServeRange(HttpListenerContext context, byte[] body, bool honour = true)
    {
        Assert.Equal("Bearer tok", context.Request.Headers["Authorization"]);
        var range = context.Request.Headers["Range"];
        if (!honour || range is null)
        {
            context.Response.StatusCode = 200;
            await context.Response.OutputStream.WriteAsync(body);
            return;
        }
        var parts = range["bytes=".Length..].Split('-');
        var from = long.Parse(parts[0]);
        var to = parts[1].Length > 0 ? Math.Min(long.Parse(parts[1]), body.Length - 1) : body.Length - 1;
        if (from >= body.Length)
        {
            context.Response.StatusCode = 416;
            return;
        }
        context.Response.StatusCode = 206;
        context.Response.Headers["Content-Range"] = $"bytes {from}-{to}/{body.Length}";
        context.Response.ContentType = "audio/wav";
        await context.Response.OutputStream.WriteAsync(body.AsMemory((int)from, (int)(to - from + 1)));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task The_range_stream_reads_and_seeks_with_the_token(bool honour)
    {
        var body = Enumerable.Range(0, 700_000).Select(i => (byte)(i % 251)).ToArray();
        using var server = new LocalServer { Handle = context => ServeRange(context, body, honour) };
        using var http = new HttpClient();
        var api = new MimiApi(http, () => server.Url, () => "tok");
        await using var stream = await HttpRangeStream.Open(http, (from, to) => api.RangeRequest(api.Absolute("/api/files/12"), from, to));
        Assert.Equal(body.Length, stream.Length);
        var buffer = new byte[1000];
        stream.Seek(600_000, SeekOrigin.Begin);
        Assert.Equal(1000, stream.Read(buffer));
        Assert.Equal(body.AsSpan(600_000, 1000).ToArray(), buffer);
        stream.Position = 10;
        var all = new MemoryStream();
        await stream.CopyToAsync(all);
        Assert.Equal(body.Length - 10, all.Length);
        if (honour) Assert.All(server.Ranges, range => Assert.StartsWith("bytes=", range));
        else Assert.Single(server.Ranges); // read once, kept
    }

    [Fact]
    public async Task Errors_of_the_api_carry_the_servers_message_and_two_factor()
    {
        using var server = new LocalServer
        {
            Handle = async context =>
            {
                context.Response.StatusCode = 401;
                await context.Response.OutputStream.WriteAsync(Encoding.UTF8.GetBytes("""{"error":"Enter the code from your authenticator app.","twoFactor":true}"""));
            },
        };
        using var http = new HttpClient();
        var api = new MimiApi(http, () => server.Url, () => null);
        var error = await Assert.ThrowsAsync<MimiHttpException>(() => api.Login(new LoginRequest("tester", "password123")));
        Assert.True(error.TwoFactor);
        Assert.Equal(HttpStatusCode.Unauthorized, error.Status);
        Assert.Equal("Enter the code from your authenticator app.", error.Message);
    }
}
