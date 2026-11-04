using System.Text.Json;
using System.Text.Json.Nodes;
using Mimi.Core.Hub;

namespace Mimi.Core.Tests;

public sealed class WorkflowAssistTests
{
    private static List<JsonElement> List(string json) => JsonDocument.Parse(json).RootElement.EnumerateArray().Select(item => item.Clone()).ToList();

    private static readonly List<JsonElement> Connectors = List("""
        [{"key":"slack","label":"Slack","description":"chat","version":"2","versions":["1","2"],"auth":{"kind":"token"},
          "operations":[
            {"key":"post","label":"Post","risk":"write","fields":[
              {"key":"channel","label":"Channel","type":"string","optionsFrom":{"connector":"slack","operation":"channels","labelField":"name","valueField":"id","dependsOn":["team"]}},
              {"key":"team","label":"Team","type":"string"},
              {"key":"mode","label":"Mode","type":"select","options":[{"value":"plain","label":"Plain"}]}]},
            {"key":"channels","label":"Channels","risk":"read","fields":[]}],
          "triggers":[{"key":"message","label":"New message"}]},
         {"key":"google_drive","label":"Drive","operations":[{"key":"list","risk":"read","fields":[]}]}]
        """);

    private static readonly List<JsonElement> Connections = List("""
        [{"id":"c1","connector":"slack","name":"Work","default":true,"connected":true},
         {"id":"c2","connector":"slack","name":"Home","connected":false}]
        """);

    private static JsonObject Node(string type, string config) => new() { ["id"] = "n9", ["type"] = type, ["config"] = JsonNode.Parse(config) };

    [Fact]
    public void A_connector_node_gets_service_operation_connection_and_the_operations_own_fields()
    {
        var fields = WorkflowAssist.FieldsOf(Node("connector", """{"connector":"slack","operation":"post"}"""), [], [], Connectors, Connections);
        Assert.Equal(["connector", "version", "operation", "account", "channel", "team", "mode", "allow"], fields.Select(field => field.S("key")));
        var account = fields.Single(field => field.S("key") == "account");
        // The default connection first, then this service's connections only.
        Assert.Equal(["", "c1", "c2"], account.A("options").Select(option => option[0].GetString()));
        Assert.Contains("ยังไม่เชื่อมต่อ", account.A("options").Last()[1].GetString());
        Assert.True(fields.Single(field => field.S("key") == "channel").B("connectorInput"));
        Assert.Equal("plain", fields.Single(field => field.S("key") == "mode").A("options").First()[0].GetString());
        // A read operation needs no "allow"; a Google service picks a Google account instead of a connection.
        var read = WorkflowAssist.FieldsOf(Node("connector", """{"connector":"slack","operation":"channels"}"""), [], [], Connectors, Connections);
        Assert.DoesNotContain(read, field => field.S("key") == "allow");
        var drive = WorkflowAssist.FieldsOf(Node("connector", """{"connector":"google_drive"}"""), [], [], Connectors, Connections);
        Assert.Equal("account", drive.Single(field => field.S("key") == "account").S("type"));
        Assert.True(WorkflowAssist.Reshapes("connector", "operation"));
        Assert.False(WorkflowAssist.Reshapes("connector", "channel"));
    }

    [Fact]
    public void Options_are_asked_only_once_the_fields_they_depend_on_are_set()
    {
        var fields = WorkflowAssist.FieldsOf(Node("connector", """{"connector":"slack","operation":"post"}"""), [], [], Connectors, Connections);
        var channel = fields.Single(field => field.S("key") == "channel");
        var config = (JsonObject)JsonNode.Parse("""{"connector":"slack","operation":"post","account":"c2","input":{}}""")!;
        Assert.Null(WorkflowAssist.OptionsQuestion(channel, config, 1, out var missing));
        Assert.Equal(["team"], missing);
        config["input"]!["team"] = "T1";
        var question = WorkflowAssist.OptionsQuestion(channel, config, 7, out missing)!;
        Assert.Empty(missing);
        Assert.Equal("connector-operation-options", question["type"]!.GetValue<string>());
        Assert.Equal(7, question["reqId"]!.GetValue<long>());
        Assert.Equal("channels", question["operation"]!.GetValue<string>());
        Assert.Equal("T1", question["input"]!["team"]!.GetValue<string>());
        Assert.Equal("c2", question["account"]!.GetValue<string>());
        Assert.Equal(["channel"], WorkflowAssist.DependentsOf(fields, "team"));
    }

    [Fact]
    public void A_connector_trigger_and_a_custom_trigger_show_their_pool_entrys_fields()
    {
        var pool = List("""
            [{"name":"connector:slack:message","builtin":true,"fields":[{"key":"channel","label":"Channel","type":"string"}]},
             {"name":"my-feed","fields":[{"key":"url","label":"URL","type":"string"}]},
             {"name":"manual","builtin":true}]
            """);
        var trigger = WorkflowAssist.FieldsOf(Node("trigger_connector", """{"connector":"slack","trigger":"message"}"""), [], pool, Connectors, Connections);
        Assert.Equal(["connector", "trigger", "account", "channel", "input"], trigger.Select(field => field.S("key")));
        var custom = WorkflowAssist.FieldsOf(Node("trigger_custom", """{"pool":"my-feed"}"""), [], pool, Connectors, Connections);
        Assert.Equal(["pool", "url"], custom.Select(field => field.S("key")));
        Assert.Equal(["my-feed"], custom[0].A("options").Select(option => option.GetString()));
    }

    private static WorkflowDraft Chain() => new((JsonObject)JsonNode.Parse("""
        {"name":"w","agent":"mimi","title":"W","vars":{"city":"Bangkok"},
         "nodes":[
          {"id":"t","type":"trigger_manual","config":{"input":{"text":"hi"}},"links":{"main":["a"]},"position":[0,0]},
          {"id":"a","type":"http","title":"Fetch","config":{},"links":{"main":["b"]},"position":[300,0]},
          {"id":"b","type":"chat","config":{},"links":{"main":[]},"position":[600,0]}]}
        """)!, isNew: false, originalName: "w");

    [Fact]
    public void Expressions_are_previewed_with_the_last_run_else_the_trigger_sample()
    {
        var draft = Chain();
        var b = draft.Node("b")!;
        var (json, nodes, note) = WorkflowAssist.Sample(draft, b, default, []);
        Assert.Equal("""{"text":"hi"}""", json.ToJsonString());
        Assert.Empty(nodes);
        Assert.Contains("ตัวอย่าง", note);
        var run = JsonDocument.Parse("""
            {"nodes":[{"id":"a","title":"Fetch","input":[{"json":{"text":"hi"}}],"output":[{"json":{"temp":31,"list":[{"x":1}]}}]}]}
            """).RootElement;
        (json, nodes, _) = WorkflowAssist.Sample(draft, b, run, []);
        Assert.Equal(31, json["temp"]!.GetValue<int>());
        Assert.Equal(31, nodes["Fetch"]!["json"]!["temp"]!.GetValue<int>());
        Assert.NotNull(nodes["a"]);
        var frame = JsonNode.Parse(WorkflowAssist.PreviewFrame(3, "{{ $json.temp }}", json, nodes, draft.Workflow["vars"]))!;
        Assert.Equal("workflow-expr-preview", frame["type"]!.GetValue<string>());
        Assert.Equal("Bangkok", frame["vars"]!["city"]!.GetValue<string>());

        var groups = WorkflowAssist.Groups(draft, b, run, []);
        var paths = groups.SelectMany(group => group.Items).Select(item => item.Path).ToList();
        Assert.Contains("$json.temp", paths);
        Assert.Contains("$json.list[0].x", paths);
        Assert.Contains("$node[\"Fetch\"].json.temp", paths);
        Assert.Contains("$vars.city", paths);
        Assert.Contains("$today", paths);
    }

    [Fact]
    public void Suggestions_continue_the_path_typed_inside_braces()
    {
        var groups = new[] { new WorkflowAssist.PathGroup("x", [new("$json.temp", "31"), new("$json.text", "hi"), new("$vars.city", "B")]) };
        const string text = "Hot: {{ $json.te";
        Assert.Equal(["$json.temp", "$json.text"], WorkflowAssist.Suggest(groups, text, text.Length).Select(item => item.Path));
        Assert.Empty(WorkflowAssist.Suggest(groups, "{{ $json.temp }} $json.te", 25));
        var (picked, caret) = WorkflowAssist.Pick(text, text.Length, "$json.temp");
        Assert.Equal("Hot: {{ $json.temp }}", picked);
        Assert.Equal(picked.Length, caret);
        (picked, _) = WorkflowAssist.Pick("{{ $js }}", 6, "$json.temp");
        Assert.Equal("{{ $json.temp }}", picked);
        Assert.Equal(("a {{ $vars.city }}!", 18), WorkflowAssist.Insert("a X!", 2, 1, "$vars.city"));
        Assert.Equal(".name", WorkflowAssist.Segment("name"));
        Assert.Equal("[\"ชื่อ ลูกค้า\"]", WorkflowAssist.Segment("ชื่อ ลูกค้า"));
    }

    [Fact]
    public void Undo_and_redo_walk_the_snapshots()
    {
        var history = new DraftHistory();
        var flow = new JsonObject { ["title"] = "a" };
        history.Reset(flow);
        flow["title"] = "b";
        history.Checkpoint(flow);
        history.Checkpoint(flow);
        flow["title"] = "c";
        var back = history.Undo(flow)!;
        Assert.Equal("b", back.Str("title"));
        Assert.Equal("a", history.Undo(back)!.Str("title"));
        Assert.Null(history.Undo(new JsonObject { ["title"] = "a" }));
        Assert.Equal("b", history.Redo()!.Str("title"));
        Assert.Equal("c", history.Redo()!.Str("title"));
        Assert.Null(history.Redo());
    }

    [Fact]
    public void Auto_layout_puts_nodes_in_columns_by_distance_from_the_start()
    {
        var draft = Chain();
        draft.Add("if", "if", 0, 0, "mimi");
        draft.Link("a", "main", "n4");
        draft.AutoLayout(_ => 1);
        double X(string id) => WorkflowDraft.Position(draft.Node(id)!)!.Value.X;
        Assert.True(X("t") < X("a"));
        Assert.True(X("a") < X("b"));
        Assert.Equal(X("b"), X("n4"));
        Assert.NotEqual(WorkflowDraft.Position(draft.Node("b")!)!.Value.Y, WorkflowDraft.Position(draft.Node("n4")!)!.Value.Y);
    }

    [Fact]
    public void New_nodes_start_with_the_settings_the_web_gives_them()
    {
        var draft = Chain();
        var file = draft.Add("extract_file", "อ่านไฟล์", 0, 0, "mimi")["config"]!.AsObject();
        Assert.Equal(("{{ $json.path }}", "auto", "header"), (file.Str("path"), file.Str("type"), file.Str("header")));
        var loop = draft.Add("loop", "วน", 0, 0, "mimi")["config"]!.AsObject();
        Assert.Equal((1, 1, "stop"), ((int)loop["batchSize"]!, (int)loop["parallel"]!, loop.Str("onItemError")));
        var approval = draft.Add("approval", "อนุมัติ", 0, 0, "mimi")["config"]!.AsObject();
        Assert.Equal(("mimi", 60), (approval.Str("agent"), (int)approval["timeoutMinutes"]!));
        Assert.Equal("", draft.Add("switch", "switch", 0, 0, "mimi")["config"]!["cases"]!.AsArray().Single()!.GetValue<string>());
    }

    [Fact]
    public void Notes_are_added_recoloured_and_removed()
    {
        var draft = Chain();
        var first = draft.AddNote(300, 200);
        var second = draft.AddNote(10, 10);
        Assert.Equal("note1", first.Str("id"));
        Assert.Equal("note2", second.Str("id"));
        Assert.Equal("[190,135]", first["position"]!.ToJsonString());
        Assert.Equal("[0,0]", second["position"]!.ToJsonString());
        WorkflowDraft.CycleColor(first);
        Assert.Equal("blue", first.Str("color"));
        draft.RemoveNote("note1");
        Assert.Equal(["note2"], draft.NoteList.Select(note => note.Str("id")));
    }

    [Fact]
    public void Node_presets_round_trip_through_the_shared_settings()
    {
        var node = Chain().Node("a")!;
        node["config"] = new JsonObject { ["url"] = "https://example.com" };
        var (key, value) = NodePresets.Make("ดึงข้อมูล", "", node, DateTimeOffset.FromUnixTimeSeconds(1_700_000_000), "p1");
        Assert.Equal("mimi.nodePreset.p1", key);
        var presets = NodePresets.Read([new(key, value), new("mimi.theme", "dark"), new("mimi.nodePreset.bad", "{oops")]);
        var preset = Assert.Single(presets);
        Assert.Equal(("p1", "ดึงข้อมูล", "http"), (preset.Id, preset.Title, preset.Type));
        Assert.Equal("https://example.com", preset.Config.Str("url"));
        node["config"] = new JsonObject { ["body"] = new string('x', 5000) };
        Assert.Throws<InvalidOperationException>(() => NodePresets.Make("big", "", node, DateTimeOffset.UnixEpoch));
    }
}
