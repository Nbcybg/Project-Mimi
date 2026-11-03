using System.Text.Json;
using System.Text.Json.Nodes;
using Mimi.Core.Desktop;
using Mimi.Core.Hub;
using Mimi.Core.Mimiamp;
using Mimi.Core.ViewModels;

namespace Mimi.Core.Tests;

public sealed class WorkflowDraftTests
{
    private static JsonObject Old() => (JsonObject)JsonNode.Parse("""
        {"name":"brief","agent":"mimi","title":"Brief","enabled":false,
         "trigger":{"pool":"schedule","config":{"cron":"0 7 * * *"}},
         "nodes":[{"id":"a","type":"http","config":{},"links":{"main":["b"]}},{"id":"b","type":"chat","config":{},"links":{"main":[]}}]}
        """)!;

    [Fact]
    public void An_old_workflow_gets_its_trigger_as_a_node_feeding_the_start()
    {
        var draft = new WorkflowDraft(Old(), isNew: false, originalName: "brief");
        var trigger = draft.NodeList.First();
        Assert.Equal("trigger_schedule", WorkflowDraft.TypeOf(trigger));
        Assert.Equal(["a"], WorkflowDraft.Targets(trigger));
        Assert.Equal("0 7 * * *", trigger["config"]!["cron"]!.GetValue<string>());
        // Every node got a place on the canvas, start to the left of what it feeds.
        Assert.All(draft.NodeList, node => Assert.NotNull(WorkflowDraft.Position(node)));
        Assert.True(WorkflowDraft.Position(draft.Node("a")!)!.Value.X > WorkflowDraft.Position(trigger)!.Value.X);
    }

    [Fact]
    public void Saving_syncs_the_trigger_reference_and_always_names_the_old_file()
    {
        var draft = new WorkflowDraft(Old(), isNew: false, originalName: "brief");
        draft.NodeList.First()["config"]!["cron"] = "0 9 * * *";
        draft.Workflow["name"] = "brief-2";
        var frame = JsonNode.Parse(draft.SaveFrame())!;
        Assert.Equal("workflow-save", frame["type"]!.GetValue<string>());
        Assert.Equal("brief", frame["renameFrom"]!.GetValue<string>());
        Assert.Equal("schedule", frame["workflow"]!["trigger"]!["pool"]!.GetValue<string>());
        Assert.Equal("0 9 * * *", frame["workflow"]!["trigger"]!["config"]!["cron"]!.GetValue<string>());
        draft.Saved();
        Assert.Equal("brief-2", draft.OriginalName);
        // A new one has no renameFrom at all.
        var fresh = new WorkflowDraft(WorkflowDraft.New("mimi", "mimi"), isNew: true, originalName: null);
        Assert.Null(JsonNode.Parse(fresh.SaveFrame())!["renameFrom"]);
    }

    [Fact]
    public void Links_go_output_to_node_once_never_to_itself_or_into_a_trigger()
    {
        var draft = new WorkflowDraft(WorkflowDraft.New("mimi", "mimi"), isNew: true, originalName: null);
        var added = draft.Add("if", "เงื่อนไข", 800, 120, "mimi");
        var id = WorkflowDraft.IdOf(added);
        Assert.Equal("n4", id);
        Assert.Single((JsonArray)added["config"]!["conditions"]!);
        Assert.True(draft.Link("n3", "main", id));
        Assert.False(draft.Link("n3", "main", id));
        Assert.False(draft.Link(id, "true", id));
        Assert.False(draft.Link(id, "true", "n1"));
        Assert.True(draft.Link(id, "true", "n2"));
        draft.Remove("n2");
        Assert.DoesNotContain("n2", WorkflowDraft.Targets(draft.Node("n1")!));
        Assert.DoesNotContain("n2", WorkflowDraft.Targets(draft.Node(id)!));
        var copy = draft.Duplicate(added);
        Assert.Empty(WorkflowDraft.Targets(copy));
        Assert.NotEqual(id, WorkflowDraft.IdOf(copy));
    }

    [Fact]
    public void A_custom_pool_trigger_keeps_the_pool_out_of_the_reference_config()
    {
        var flow = Old();
        flow["trigger"] = new JsonObject { ["pool"] = "my-feed", ["config"] = new JsonObject { ["url"] = "https://example.com" } };
        var draft = new WorkflowDraft(flow, isNew: false, originalName: "brief");
        var trigger = draft.NodeList.First();
        Assert.Equal("trigger_custom", WorkflowDraft.TypeOf(trigger));
        Assert.Equal("my-feed", WorkflowDraft.PoolOf(trigger));
        draft.SyncTrigger();
        Assert.Equal("my-feed", draft.Workflow["trigger"]!["pool"]!.GetValue<string>());
        Assert.Null(draft.Workflow["trigger"]!["config"]!["pool"]);
    }

    [Fact]
    public void Test_input_becomes_flow_items()
    {
        Assert.Equal("""[{"json":{"a":1}}]""", WorkflowDraft.Items("""{"a":1}""").ToJsonString());
        Assert.Equal("""[{"json":{"a":1}},{"json":{"value":2}}]""", WorkflowDraft.Items("""[{"a":1},2]""").ToJsonString());
        Assert.Equal("""[{"json":{}}]""", WorkflowDraft.Items("  ").ToJsonString());
        Assert.ThrowsAny<JsonException>(() => WorkflowDraft.Items("{oops"));
    }
}

public sealed class SpectrumAndLookTests
{
    [Fact]
    public void A_tone_lights_the_bar_of_its_frequency()
    {
        var spectrum = new Spectrum();
        var samples = new float[Spectrum.Size * 2];
        for (var i = 0; i < Spectrum.Size; i++)
        {
            var value = (float)Math.Sin(2 * Math.PI * 1000 * i / 44100.0);
            samples[2 * i] = value;
            samples[2 * i + 1] = value;
        }
        spectrum.Feed(samples, 2, 44100);
        var bars = spectrum.Bars(16);
        var loudest = Array.IndexOf(bars, bars.Max());
        // 40 Hz–16 kHz in 16 log steps: 1 kHz falls in bar 8 or 9.
        Assert.InRange(loudest, 7, 9);
        Assert.True(bars[0] < bars[loudest]);
        spectrum.Clear();
        Assert.All(spectrum.Bars(16), level => Assert.True(level < 0.05f));
    }

    [Fact]
    public void Pan_keeps_the_centre_and_fades_one_side()
    {
        Assert.Equal((1f, 1f), Spectrum.PanGains(0));
        Assert.Equal((1f, 0f), Spectrum.PanGains(-1));
        Assert.Equal((0.5f, 1f), Spectrum.PanGains(0.5f));
        Assert.Equal((0f, 1f), Spectrum.PanGains(3));
    }

    [Fact]
    public void Chat_looks_theme_and_mimiamp_choices_survive_a_restart()
    {
        var dir = Directory.CreateTempSubdirectory("mimi-look-");
        try
        {
            var file = Path.Combine(dir.FullName, "config.json");
            var song = Path.Combine(dir.FullName, "song.mp3");
            File.WriteAllBytes(song, [0]);
            var config = AppConfig.Defaults(dir.FullName);
            config.Theme = "light";
            config.TextSize = 2;
            config.Pan = -0.25f;
            config.LocalTracks.Add(song);
            config.LocalTracks.Add(Path.Combine(dir.FullName, "gone.mp3"));
            var look = config.Look(42, create: true);
            look.Theme = "dark";
            look.Background = new JsonObject { ["type"] = "preset", ["preset"] = "floral" };
            look.Zoom = 1.4;
            config.Look(7, create: true); // left as the app: not written
            config.Write(file);

            var read = AppConfig.Read(file, dir.FullName);
            Assert.Equal("light", read.Theme);
            Assert.Equal(2, read.TextSize);
            Assert.Equal(-0.25f, read.Pan);
            Assert.Equal([song], read.LocalTracks);
            Assert.Equal("dark", read.Look(42).Theme);
            Assert.Equal("floral", read.Look(42).Background!["preset"]!.GetValue<string>());
            Assert.Equal(1.4, read.Look(42).Zoom);
            Assert.False(read.Looks.ContainsKey("7"));
            Assert.True(read.Look(99).IsEmpty);
            read.ForgetLook(42);
            Assert.True(read.Look(42).IsEmpty);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public void A_song_of_this_computer_plays_from_its_file()
    {
        var track = MimiampViewModel.LocalTrack(@"C:\Music\เพลง ดี.mp3");
        Assert.Equal("local", track.Source);
        Assert.Equal("เพลง ดี", track.Title);
        Assert.StartsWith("file:///", track.Url);
        Assert.True(new Uri(track.Url).IsFile);
    }
}
