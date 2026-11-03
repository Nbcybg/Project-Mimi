using System.Text.Json;
using System.Text.Json.Nodes;

namespace Mimi.Core.Hub;

/// <summary>
/// A workflow being edited (feature-workflows.js draft): the trigger lives on the canvas as a node, nodes
/// sit at positions and link output → node. Pure JSON work, so the editor's rules are tested without a screen.
/// </summary>
public sealed class WorkflowDraft
{
    /// <summary>Trigger node types and the trigger-pool entry each stands for.</summary>
    public static readonly IReadOnlyDictionary<string, string> TriggerPools = new Dictionary<string, string>
    {
        ["trigger_manual"] = "manual",
        ["trigger_schedule"] = "schedule",
        ["trigger_webhook"] = "webhook",
        ["trigger_form"] = "form",
        ["trigger_mail"] = "mail",
        ["trigger_calendar"] = "calendar",
        ["trigger_poll"] = "poll",
        ["trigger_chat"] = "chat",
        ["trigger_telegram"] = "telegram",
        ["trigger_tool"] = "agent_tool",
    };

    private const string ConnectorPrefix = "connector:";

    public WorkflowDraft(JsonObject workflow, bool isNew, string? originalName)
    {
        Workflow = workflow;
        IsNew = isNew;
        OriginalName = originalName;
        Migrate();
        Layout();
    }

    public JsonObject Workflow { get; }
    public bool IsNew { get; private set; }
    /// <summary>The name it was saved under (renameFrom must always be sent for an existing one).</summary>
    public string? OriginalName { get; private set; }

    public JsonArray Nodes => Workflow["nodes"] as JsonArray ?? (JsonArray)(Workflow["nodes"] = new JsonArray());

    public IEnumerable<JsonObject> NodeList => Nodes.OfType<JsonObject>();

    public static bool IsTrigger(string type) => type is "trigger_custom" or "trigger_connector" || TriggerPools.ContainsKey(type);

    public static JsonObject New(string agent, string firstAgent) => new()
    {
        ["name"] = "",
        ["agent"] = agent,
        ["title"] = "",
        ["description"] = "",
        ["enabled"] = true,
        ["trigger"] = new JsonObject { ["pool"] = "manual", ["config"] = new JsonObject() },
        ["vars"] = new JsonObject(),
        ["nodes"] = new JsonArray(
            new JsonObject { ["id"] = "n1", ["type"] = "trigger_manual", ["title"] = "ทริกเกอร์: กดรันเอง", ["config"] = new JsonObject(), ["links"] = new JsonObject { ["main"] = new JsonArray("n2") }, ["position"] = new JsonArray(60, 120) },
            new JsonObject { ["id"] = "n2", ["type"] = "agent", ["title"] = "AI agent", ["config"] = new JsonObject { ["agent"] = firstAgent, ["instruction"] = "" }, ["links"] = new JsonObject { ["main"] = new JsonArray("n3") }, ["position"] = new JsonArray(320, 120) },
            new JsonObject { ["id"] = "n3", ["type"] = "chat", ["title"] = "ส่งเข้าแชต", ["config"] = new JsonObject { ["text"] = "{{ $json.text }}" }, ["links"] = new JsonObject { ["main"] = new JsonArray() }, ["position"] = new JsonArray(580, 120) }),
    };

    private static string S(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : "";

    public static string TypeOf(JsonObject node) => S(node["type"]);
    public static string IdOf(JsonObject node) => S(node["id"]);

    public JsonObject? Node(string id) => NodeList.FirstOrDefault(node => IdOf(node) == id);

    /// <summary>The pool entry a trigger node stands for.</summary>
    public static string? PoolOf(JsonObject node)
    {
        var config = node["config"] as JsonObject;
        return TypeOf(node) switch
        {
            "trigger_custom" => S(config?["pool"]) is { Length: > 0 } pool ? pool : null,
            "trigger_connector" => S(config?["connector"]) is { Length: > 0 } connector && S(config?["trigger"]) is { Length: > 0 } trigger ? $"{ConnectorPrefix}{connector}:{trigger}" : null,
            var type => TriggerPools.TryGetValue(type, out var pool) ? pool : null,
        };
    }

    /// <summary>Old workflows kept the trigger outside the graph: it becomes a node feeding the start nodes.</summary>
    private void Migrate()
    {
        if (NodeList.Any(node => IsTrigger(TypeOf(node))))
        {
            SyncTrigger();
            return;
        }
        var reference = Workflow["trigger"] as JsonObject ?? new JsonObject { ["pool"] = "manual" };
        var pool = S(reference["pool"]) is { Length: > 0 } named ? named : "manual";
        var type = pool.StartsWith(ConnectorPrefix, StringComparison.Ordinal) ? "trigger_connector"
            : TriggerPools.FirstOrDefault(entry => entry.Value == pool).Key ?? "trigger_custom";
        var fed = NodeList.SelectMany(Targets).ToHashSet();
        var starts = NodeList.Where(node => !fed.Contains(IdOf(node))).Select(IdOf).ToList();
        var id = "trigger";
        for (var n = 1; Node(id) is not null; n++) id = $"trigger{n}";
        var config = (reference["config"] as JsonObject)?.DeepClone() as JsonObject ?? [];
        if (type == "trigger_custom") config["pool"] = pool;
        if (type == "trigger_connector")
        {
            var parts = pool[ConnectorPrefix.Length..].Split(':');
            if (parts.Length == 2)
            {
                config["connector"] = parts[0];
                config["trigger"] = parts[1];
            }
        }
        Nodes.Insert(0, new JsonObject
        {
            ["id"] = id,
            ["type"] = type,
            ["title"] = $"ทริกเกอร์: {pool}",
            ["config"] = config,
            ["links"] = new JsonObject { ["main"] = new JsonArray(starts.Select(start => (JsonNode)JsonValue.Create(start)!).ToArray()) },
        });
        SyncTrigger();
    }

    /// <summary>The workflow's trigger reference follows its trigger node (as the web does before saving).</summary>
    public void SyncTrigger()
    {
        var node = NodeList.FirstOrDefault(entry => IsTrigger(TypeOf(entry)));
        if (node is null) return;
        var config = (node["config"] as JsonObject)?.DeepClone() as JsonObject ?? [];
        if (TypeOf(node) == "trigger_custom") config.Remove("pool");
        Workflow["trigger"] = new JsonObject { ["pool"] = PoolOf(node) ?? "manual", ["config"] = config };
    }

    public static IEnumerable<string> Targets(JsonObject node) =>
        (node["links"] as JsonObject)?.SelectMany(link => (link.Value as JsonArray)?.Select(S) ?? []).Where(id => id.Length > 0) ?? [];

    public static (double X, double Y)? Position(JsonObject node) =>
        node["position"] is JsonArray { Count: 2 } at && at[0] is JsonValue x && at[1] is JsonValue y && x.TryGetValue<double>(out var px) && y.TryGetValue<double>(out var py) ? (px, py) : null;

    public static void Move(JsonObject node, double x, double y) => node["position"] = new JsonArray(Math.Round(Math.Max(0, x)), Math.Round(Math.Max(0, y)));

    /// <summary>Nodes without a place go in columns by their distance from the start.</summary>
    public void Layout()
    {
        var missing = NodeList.Where(node => Position(node) is null).ToList();
        if (missing.Count == 0) return;
        var depth = new Dictionary<string, int>();
        var fed = NodeList.SelectMany(Targets).ToHashSet();
        var queue = new Queue<string>(NodeList.Where(node => !fed.Contains(IdOf(node))).Select(IdOf));
        foreach (var id in queue) depth[id] = 0;
        while (queue.Count > 0)
        {
            var id = queue.Dequeue();
            if (Node(id) is not { } node) continue;
            foreach (var target in Targets(node))
            {
                if (depth.ContainsKey(target) || depth.Count > 500) continue;
                depth[target] = depth[id] + 1;
                queue.Enqueue(target);
            }
        }
        var rows = new Dictionary<int, int>();
        foreach (var node in missing)
        {
            var column = depth.TryGetValue(IdOf(node), out var d) ? d : 0;
            var row = rows.TryGetValue(column, out var r) ? r : 0;
            rows[column] = row + 1;
            Move(node, 60 + column * 260, 60 + row * 120);
        }
    }

    public string NextId()
    {
        var n = NodeList.Count() + 1;
        while (Node($"n{n}") is not null) n++;
        return $"n{n}";
    }

    /// <summary>Adds a node of a type (with the defaults the web gives it) at a place; returns it.</summary>
    public JsonObject Add(string type, string title, double x, double y, string firstAgent)
    {
        var config = new JsonObject();
        switch (type)
        {
            case "agent" or "agent_call" or "chat" or "notify" or "approval":
                config["agent"] = S(Workflow["agent"]) is { Length: > 0 } owner ? owner : firstAgent;
                break;
            case "if" or "filter" or "assert":
                config["combinator"] = "and";
                config["conditions"] = new JsonArray(new JsonObject { ["left"] = "", ["operator"] = "contains", ["right"] = "" });
                break;
            case "classify":
                config["input"] = "{{ $json.text }}";
                config["categories"] = new JsonArray();
                break;
            case "extract":
                config["input"] = "{{ $json.text }}";
                config["attributes"] = new JsonArray();
                break;
            case "http":
                config["method"] = "GET";
                break;
        }
        var node = new JsonObject { ["id"] = NextId(), ["type"] = type, ["title"] = title, ["config"] = config, ["links"] = new JsonObject { ["main"] = new JsonArray() } };
        Move(node, x, y);
        Nodes.Add(node);
        return node;
    }

    public JsonObject Duplicate(JsonObject node)
    {
        var copy = (JsonObject)node.DeepClone();
        copy["id"] = NextId();
        copy["links"] = new JsonObject { ["main"] = new JsonArray() };
        var at = Position(node) ?? (60, 60);
        Move(copy, at.X + 40, at.Y + 90);
        Nodes.Add(copy);
        return copy;
    }

    public void Remove(string id)
    {
        if (Node(id) is not { } node) return;
        Nodes.Remove(node);
        foreach (var other in NodeList) Unlink(other, null, id);
    }

    /// <summary>output → target; false when it would be a loop on itself or is already there.</summary>
    public bool Link(string fromId, string output, string toId)
    {
        if (fromId == toId || Node(fromId) is not { } from || Node(toId) is not { } to) return false;
        if (IsTrigger(TypeOf(to))) return false;
        var links = from["links"] as JsonObject ?? (JsonObject)(from["links"] = new JsonObject());
        var list = links[output] as JsonArray ?? (JsonArray)(links[output] = new JsonArray());
        if (list.Any(entry => S(entry) == toId)) return false;
        list.Add(toId);
        return true;
    }

    /// <summary>Removes the link from <paramref name="from"/> (one output, or every output when null) to <paramref name="toId"/>.</summary>
    public static void Unlink(JsonObject from, string? output, string toId)
    {
        if (from["links"] is not JsonObject links) return;
        foreach (var (key, value) in links.ToList())
        {
            if (output is not null && key != output) continue;
            if (value is not JsonArray list) continue;
            foreach (var entry in list.Where(entry => S(entry) == toId).ToList()) list.Remove(entry);
        }
    }

    /// <summary>The frame that stores the draft (the trigger reference synced first).</summary>
    public string SaveFrame()
    {
        SyncTrigger();
        var workflow = (JsonObject)Workflow.DeepClone();
        workflow.Remove("webhook");
        return Protocol.ClientFrames.Json("workflow-save", new JsonObject
        {
            ["workflow"] = workflow,
            ["renameFrom"] = IsNew ? null : OriginalName,
        });
    }

    /// <summary>The save went through: from now on it is an existing workflow under this name.</summary>
    public void Saved()
    {
        IsNew = false;
        OriginalName = S(Workflow["name"]);
    }

    public string TestFrame(JsonObject node, JsonArray items)
    {
        SyncTrigger();
        var workflow = (JsonObject)Workflow.DeepClone();
        workflow.Remove("webhook");
        return Protocol.ClientFrames.Json("workflow-test-node", new JsonObject { ["workflow"] = workflow, ["node"] = node.DeepClone(), ["input"] = items });
    }

    /// <summary>Test input as typed (an object or a list of objects) → flow items.</summary>
    public static JsonArray Items(string text)
    {
        var parsed = string.IsNullOrWhiteSpace(text) ? new JsonObject() : JsonNode.Parse(text);
        var list = parsed is JsonArray array ? array.ToList() : [parsed];
        return new JsonArray(list.Select(entry => (JsonNode)new JsonObject { ["json"] = entry is JsonObject obj ? obj.DeepClone() : new JsonObject { ["value"] = entry?.DeepClone() } }).ToArray());
    }

    public static JsonElement Element(JsonNode node) => JsonDocument.Parse(node.ToJsonString()).RootElement;
}
