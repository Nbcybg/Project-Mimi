using System.Text.Json;
using System.Text.Json.Nodes;
using Mimi.Core.Desktop;
using Mimi.Core.Hub;
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

public sealed class LookTests
{
    [Fact]
    public void Chat_looks_and_theme_survive_a_restart()
    {
        var dir = Directory.CreateTempSubdirectory("mimi-look-");
        try
        {
            var file = Path.Combine(dir.FullName, "config.json");
            var config = AppConfig.Defaults(dir.FullName);
            config.Theme = "light";
            config.TextSize = 2;
            var look = config.Look(42, create: true);
            look.Theme = "dark";
            look.Background = new JsonObject { ["type"] = "preset", ["preset"] = "floral" };
            look.Zoom = 1.4;
            config.Look(7, create: true); // left as the app: not written
            config.Write(file);

            var read = AppConfig.Read(file, dir.FullName);
            Assert.Equal("light", read.Theme);
            Assert.Equal(2, read.TextSize);
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
}
