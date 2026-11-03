using System.Text.Json;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Mimi.Core.Hub;

namespace Mimi.App.Controls;

/// <summary>
/// A workflow drawn the way the web's canvas lays it out (feature-canvas.js): the trigger and the nodes at
/// their positions, a line from each output to the nodes it links to. Pan and zoom with the scroll viewer;
/// nodes are edited in the workflow's form (JSON), not here.
/// </summary>
public static class WorkflowGraph
{
    private const double Width0 = 190;
    private const double Height0 = 64;

    /// <summary>The diagram in a scroll viewer that pans and zooms (Ctrl + wheel, pinch).</summary>
    public static ScrollViewer Create(JsonElement workflow, double width, double height) => new()
    {
        Width = width,
        Height = height,
        ZoomMode = ZoomMode.Enabled,
        MinZoomFactor = 0.25f,
        MaxZoomFactor = 3f,
        HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        HorizontalScrollMode = ScrollMode.Enabled,
        VerticalScrollMode = ScrollMode.Enabled,
        Content = Draw(workflow),
    };

    private static Brush Brush(string key) => (Brush)Application.Current.Resources[key];

    private static (double X, double Y)? Position(JsonElement json, string key)
    {
        var at = json.At(key);
        if (at.ValueKind != JsonValueKind.Array || at.GetArrayLength() < 2) return null;
        return (at[0].GetDouble(), at[1].GetDouble());
    }

    private static Canvas Draw(JsonElement workflow)
    {
        var canvas = new Canvas { Background = Brush("MimiBgBrush") };
        var nodes = workflow.A("nodes").ToList();
        var places = new Dictionary<string, (double X, double Y)>();
        // Where the web stored a position use it; otherwise left to right in file order.
        var trigger = Position(workflow, "triggerPosition") ?? (40, 160);
        places["@trigger"] = trigger;
        for (var i = 0; i < nodes.Count; i++)
        {
            places[nodes[i].S("id")] = Position(nodes[i], "position") ?? (trigger.X + 240 * (i + 1), trigger.Y + (i % 2 == 0 ? 0 : 90));
        }
        var minX = places.Values.Min(place => place.X) - 30;
        var minY = places.Values.Min(place => place.Y) - 30;
        (double X, double Y) At(string id) => (places[id].X - minX, places[id].Y - minY);

        // Lines first, under the boxes: the trigger to the nodes no one links to, then every link.
        var linked = nodes.SelectMany(node => node.At("links").ValueKind == JsonValueKind.Object
            ? node.At("links").EnumerateObject().SelectMany(output => output.Value.ValueKind == JsonValueKind.Array ? output.Value.EnumerateArray().Select(target => target.GetString() ?? "") : [])
            : []).ToHashSet();
        void Line(string from, string to, string label)
        {
            if (!places.ContainsKey(from) || !places.ContainsKey(to)) return;
            var (x1, y1) = At(from);
            var (x2, y2) = At(to);
            var path = new Microsoft.UI.Xaml.Shapes.Path
            {
                Stroke = Brush("MimiAccentBrush"),
                StrokeThickness = 2,
                Data = new PathGeometry
                {
                    Figures =
                    {
                        new PathFigure
                        {
                            StartPoint = new Windows.Foundation.Point(x1 + Width0, y1 + Height0 / 2),
                            Segments = { new BezierSegment { Point1 = new(x1 + Width0 + 60, y1 + Height0 / 2), Point2 = new(x2 - 60, y2 + Height0 / 2), Point3 = new(x2, y2 + Height0 / 2) } },
                        },
                    },
                },
            };
            canvas.Children.Add(path);
            if (label.Length > 0 && label != "main")
            {
                var text = new TextBlock { Text = label, FontSize = 11, Foreground = Brush("MimiMutedBrush") };
                Canvas.SetLeft(text, (x1 + Width0 + x2) / 2 - 10);
                Canvas.SetTop(text, (y1 + y2) / 2 + Height0 / 2 - 16);
                canvas.Children.Add(text);
            }
        }
        foreach (var node in nodes)
        {
            // Nodes nobody links to start from the trigger.
            if (!linked.Contains(node.S("id")) && !node.S("type").StartsWith("trigger", StringComparison.Ordinal)) Line("@trigger", node.S("id"), "");
            if (node.At("links").ValueKind != JsonValueKind.Object) continue;
            foreach (var output in node.At("links").EnumerateObject())
            {
                if (output.Value.ValueKind != JsonValueKind.Array) continue;
                foreach (var target in output.Value.EnumerateArray()) Line(node.S("id"), target.GetString() ?? "", output.Name);
            }
        }

        void Box(string id, string title, string type, bool disabled, bool isTrigger)
        {
            var (x, y) = At(id);
            var panel = new StackPanel { Spacing = 2 };
            panel.Children.Add(new TextBlock { Text = title, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Brush("MimiInkBrush"), TextTrimming = TextTrimming.CharacterEllipsis });
            panel.Children.Add(new TextBlock { Text = disabled ? $"{type} · ปิดอยู่" : type, FontSize = 11, Foreground = Brush("MimiMutedBrush"), TextTrimming = TextTrimming.CharacterEllipsis });
            var border = new Border
            {
                Width = Width0,
                Height = Height0,
                Padding = new Thickness(10, 8, 10, 8),
                CornerRadius = new CornerRadius(isTrigger ? 32 : 10),
                Background = Brush(isTrigger ? "MimiUserBrush" : "MimiPanelBrush"),
                BorderBrush = Brush(isTrigger ? "MimiAccentBrush" : "MimiLineBrush"),
                BorderThickness = new Thickness(isTrigger ? 2 : 1),
                Opacity = disabled ? 0.5 : 1,
                Child = panel,
            };
            ToolTipService.SetToolTip(border, $"{title}\n{type}\nid: {id}");
            Canvas.SetLeft(border, x);
            Canvas.SetTop(border, y);
            canvas.Children.Add(border);
        }
        var triggerType = workflow.S("trigger.type") is { Length: > 0 } kind ? kind : "manual";
        Box("@trigger", "เริ่มเมื่อ", triggerType, false, true);
        foreach (var node in nodes)
        {
            Box(node.S("id"), node.S("title") is { Length: > 0 } title ? title : node.S("id"), node.S("type"), node.B("disabled"), node.S("type").StartsWith("trigger", StringComparison.Ordinal));
        }

        foreach (var note in workflow.A("notes"))
        {
            if (Position(note, "position") is not { } place) continue;
            var text = new Border
            {
                Width = note.At("width").ValueKind == JsonValueKind.Number ? note.At("width").GetDouble() : 200,
                Padding = new Thickness(8),
                CornerRadius = new CornerRadius(6),
                Background = Brush("MimiRaisedBrush"),
                Child = new TextBlock { Text = note.S("text"), TextWrapping = TextWrapping.Wrap, FontSize = 12, Foreground = Brush("MimiInk2Brush") },
            };
            Canvas.SetLeft(text, place.X - minX);
            Canvas.SetTop(text, place.Y - minY);
            canvas.Children.Add(text);
        }
        canvas.Width = places.Values.Max(place => place.X) - minX + Width0 + 60;
        canvas.Height = places.Values.Max(place => place.Y) - minY + Height0 + 60;
        return canvas;
    }
}
