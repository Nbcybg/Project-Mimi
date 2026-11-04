using System.Text.Json.Nodes;
using Mimi.Core.Chat;
using Mimi.Core.Desktop;
using Mimi.Core.Net;
using Mimi.Core.Protocol;

namespace Mimi.Core.Tests;

/// <summary>What the Electron app / web client had that this app got in round 6: mentions, background time spans, the agent's browser.</summary>
public sealed class ElectronParityTests
{
    private static readonly (string, string)[] Members = [("mimi", "มิมิ"), ("milo", "Milo"), ("nora", "โนร่า")];

    [Fact]
    public void A_mention_is_offered_only_while_the_caret_ends_an_at_word()
    {
        Assert.Equal((5, "mi"), Mentions.At("hey @mi", 7));
        Assert.Equal((1, ""), Mentions.At("@", 1));
        Assert.Equal((10, "โน"), Mentions.At("ถามหน่อย @โน", 12));
        Assert.Null(Mentions.At("mail@mi", 7)); // inside a word, like an address
        Assert.Null(Mentions.At("@mi there", 9));
        Assert.Null(Mentions.At("x", 5));

        Assert.Equal(["mimi", "milo"], Mentions.Options(Members, "MI").Select(member => member.Name));
        Assert.Equal(["nora"], Mentions.Options(Members, "โน").Select(member => member.Name));
        Assert.Equal(3, Mentions.Options(Members, "").Count);

        var (text, caret) = Mentions.Apply("hey @mi and", 7, 5, "mimi");
        Assert.Equal("hey @mimi  and", text);
        Assert.Equal(10, caret);
    }

    [Fact]
    public void Background_spans_pick_the_first_that_holds_the_time_and_cross_midnight()
    {
        Assert.Equal("06:05", BackgroundRules.Clock("6:05"));
        Assert.Equal("", BackgroundRules.Clock("24:00"));
        Assert.Equal("", BackgroundRules.Clock("7"));
        var night = new JsonObject { ["from"] = "18:00", ["to"] = "06:00", ["type"] = "preset", ["preset"] = "night" };
        Assert.True(BackgroundRules.Active(night, 23 * 60));
        Assert.True(BackgroundRules.Active(night, 5 * 60 + 59));
        Assert.False(BackgroundRules.Active(night, 6 * 60));
        Assert.True(BackgroundRules.Active(new JsonObject { ["from"] = "09:00", ["to"] = "09:00" }, 3));

        var own = new JsonObject { ["type"] = "solid", ["color"] = "#112233", ["from"] = "#000000", ["to"] = "#ffffff", ["preset"] = "floral" };
        var rules = new JsonArray(
            new JsonObject { ["from"] = "08:00", ["to"] = "12:00", ["type"] = "gradient" },
            new JsonObject { ["from"] = "10:00", ["to"] = "20:00", ["type"] = "upload", ["upload"] = "chatbg-1-x" },
            night);
        Assert.Equal("gradient", BackgroundRules.For(own, rules, 11 * 60, _ => true)!["type"]!.GetValue<string>());
        Assert.Equal("#112233", BackgroundRules.For(own, rules, 11 * 60, _ => true)!["color"]!.GetValue<string>());
        Assert.Equal("chatbg-1-x", BackgroundRules.For(own, rules, 13 * 60, _ => true)!["upload"]!.GetValue<string>());
        Assert.Same(own, BackgroundRules.For(own, rules, 13 * 60, _ => false)); // the picture is gone: the chat's own one
        Assert.Equal("night", BackgroundRules.For(own, rules, 22 * 60, _ => true)!["preset"]!.GetValue<string>());
        Assert.Same(own, BackgroundRules.For(own, rules, 7 * 60, _ => true));
        Assert.Null(BackgroundRules.For(null, rules, 22 * 60, _ => true)); // no own background: the app's scene, no spans
    }

    [Fact]
    public void Spans_are_kept_with_the_chat_look()
    {
        var dir = Directory.CreateTempSubdirectory("mimi-rules-");
        try
        {
            var file = Path.Combine(dir.FullName, "config.json");
            var config = AppConfig.Defaults(dir.FullName);
            var look = config.Look(5, create: true);
            look.Background = new JsonObject { ["type"] = "none" };
            look.BackgroundRules = [BackgroundRules.New()];
            config.Write(file);
            var read = AppConfig.Read(file, dir.FullName).Look(5);
            Assert.Equal("18:00", read.BackgroundRules![0]!["from"]!.GetValue<string>());
            Assert.False(read.IsEmpty);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public void The_agents_browser_is_the_one_the_pc_agent_drives_with_its_flags()
    {
        var env = new Dictionary<string, string?> { ["ProgramFiles(x86)"] = @"C:\PF86", ["ProgramFiles"] = @"C:\PF", ["LOCALAPPDATA"] = @"C:\Users\x\AppData\Local" };
        string? Env(string name) => env.GetValueOrDefault(name);
        var chrome = Path.Combine(@"C:\PF", "Google", "Chrome", "Application", "chrome.exe");
        Assert.Equal(chrome, AgentBrowser.Find(Env, file => file == chrome));
        var edge = Path.Combine(@"C:\PF86", "Microsoft", "Edge", "Application", "msedge.exe");
        Assert.Equal(edge, AgentBrowser.Find(Env, _ => true)); // Edge first, as the PC agent tries it
        Assert.Null(AgentBrowser.Find(Env, _ => false));
        env["MIMI_BROWSER_PATH"] = @"D:\brave.exe";
        Assert.Equal(@"D:\brave.exe", AgentBrowser.Find(Env, _ => true));
        Assert.Null(AgentBrowser.Find(Env, file => file != @"D:\brave.exe"));

        var args = AgentBrowser.Arguments(@"C:\profile");
        Assert.Contains("--remote-debugging-port=0", args);
        Assert.Contains(@"--user-data-dir=C:\profile", args);
        Assert.DoesNotContain(args, arg => arg.StartsWith("--headless", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Push_info_says_whether_windows_push_works_and_an_old_server_has_none()
    {
        var reply = "";
        var registered = "";
        using var server = new LocalServer
        {
            Handle = async context =>
            {
                var path = context.Request.Url!.AbsolutePath;
                if (path == "/api/push/register")
                {
                    registered = await new StreamReader(context.Request.InputStream).ReadToEndAsync();
                    await context.Response.OutputStream.WriteAsync(System.Text.Encoding.UTF8.GetBytes("{\"ok\":true,\"delivering\":true}"));
                }
                else if (path == "/api/push/info" && reply.Length > 0) await context.Response.OutputStream.WriteAsync(System.Text.Encoding.UTF8.GetBytes(reply));
                else context.Response.StatusCode = 404;
            },
        };
        using var http = new HttpClient();
        var api = new MimiApi(http, () => server.Url, () => "tok");
        Assert.False((await api.PushInfo()).Wns); // a core from before WNS: no such path
        reply = "{\"platforms\":[\"fcm\",\"wns\"],\"wnsRemoteId\":\"3f2504e0-4f89-11d3-9a0c-0305e82c3301\"}";
        Assert.True((await api.PushInfo()).Wns);
        reply = "{\"platforms\":[\"wns\"],\"wnsRemoteId\":\"not-a-guid\"}";
        Assert.False((await api.PushInfo()).Wns);
        Assert.True(await api.RegisterWns("https://wns2-sg2p.notify.windows.com/w/?token=x", "PC", "1.0"));
        Assert.Contains("\"platform\":\"wns\"", registered);
    }
}
