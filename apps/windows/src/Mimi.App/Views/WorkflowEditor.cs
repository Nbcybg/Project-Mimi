using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Input;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Mimi.App.Controls;
using Mimi.App.Services;
using Mimi.Core;
using Mimi.Core.Hub;
using Mimi.Core.Protocol;
using Windows.Foundation;
using Windows.System;
using Path = Microsoft.UI.Xaml.Shapes.Path;

namespace Mimi.App.Views;

/// <summary>
/// The workflow editor (feature-workflows.js / feature-canvas.js): nodes on a canvas you drag around, links drawn
/// by dragging from a node's output dot onto another node, sticky notes, a panel with the selected node's own fields
/// (from the server's node specs; a connector node's from the service and operation, with options read from the
/// service), expressions previewed against the last run, "test this node" with input you type, undo / redo,
/// auto-layout and node presets. Save, run and the run history sit on top.
/// </summary>
internal sealed partial class WorkflowEditor : UserControl
{
    private const double CardWidth = 200;
    private readonly MimiSession session;
    private readonly Lookups lookups;
    private readonly Canvas canvas = new() { Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
    private readonly Canvas linkLayer = new();
    private readonly Canvas nodeLayer = new();
    private readonly Canvas noteLayer = new();
    private readonly ScrollViewer scroller;
    private readonly ContentControl panel = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch };
    private readonly TextBlock heading = new() { FontSize = 15, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
    private readonly TextBlock status = new() { FontSize = 12, TextWrapping = TextWrapping.Wrap };
    private readonly Dictionary<string, Border> cards = [];
    private List<JsonElement> nodeTypes = [];
    private List<JsonElement> pool = [];
    private List<JsonElement> connectors = [];
    private List<JsonElement> connections = [];
    /// <summary>The last run's result (workflow-result.result): what the expressions are previewed with.</summary>
    private JsonElement lastRun;
    private readonly DraftHistory history = new();
    private readonly Dictionary<string, IReadOnlyList<(string Value, string Label)>> optionCache = [];
    private long requests;
    private int checkpointTicket;
    private static JsonObject? clipboard;
    private WorkflowDraft? draft;
    private string? selected;
    private (string From, string Output, string To)? selectedLink;
    private bool dirty;
    // dragging a card
    private string? dragging;
    private Point dragStart;
    private (double X, double Y) dragOrigin;
    // drawing a link
    private (string From, string Output)? linking;
    private Path? rubber;
    private bool dialogOpen;

    public WorkflowEditor(MimiSession session, Lookups lookups)
    {
        this.session = session;
        this.lookups = lookups;
        AutomationProperties.SetAutomationId(this, "WorkflowEditor");
        canvas.Children.Add(noteLayer);
        canvas.Children.Add(linkLayer);
        canvas.Children.Add(nodeLayer);
        scroller = new ScrollViewer
        {
            Content = canvas,
            ZoomMode = ZoomMode.Enabled,
            MinZoomFactor = 0.3f,
            MaxZoomFactor = 2f,
            HorizontalScrollMode = ScrollMode.Enabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            Background = Theme.Brush("Bg"),
        };
        AutomationProperties.SetAutomationId(scroller, "WorkflowCanvas");
        canvas.PointerMoved += OnCanvasMoved;
        canvas.PointerReleased += OnCanvasReleased;
        canvas.Tapped += (_, e) =>
        {
            if (ReferenceEquals(e.OriginalSource, canvas)) Select(null);
        };

        var toolbar = new Grid { Padding = new Thickness(10, 6, 10, 6), ColumnSpacing = 6, Background = Theme.Brush("Panel"), BorderBrush = Theme.Brush("Line"), BorderThickness = new Thickness(0, 0, 0, 1) };
        toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        toolbar.Children.Add(heading);
        var add = new DropDownButton { Content = "+ node", FontSize = 12.5, CornerRadius = new CornerRadius(8) };
        AutomationProperties.SetAutomationId(add, "AddNode");
        var addMenu = new MenuFlyout();
        addMenu.Opening += (_, _) => FillAddMenu(addMenu);
        add.Flyout = addMenu;
        var tools = Ui.Row(4,
            Ui.Button("↶", Undo, "ghost", "UndoWorkflow", "ย้อน (Ctrl+Z)"),
            Ui.Button("↷", Redo, "ghost", "RedoWorkflow", "ทำซ้ำ (Ctrl+Y)"),
            Ui.Button("📝", AddNote, "ghost", "AddNote", "เพิ่มโน้ต"),
            add,
            Ui.Button("บันทึก", () => _ = Save(), "pri", "SaveWorkflow"),
            Ui.Button("รัน", () => _ = Run(), id: "RunWorkflow", tip: "บันทึกแล้วรันด้วยข้อมูลเข้าที่พิมพ์"),
            More());
        Grid.SetColumn(tools, 1);
        toolbar.Children.Add(tools);

        var bottom = new Border
        {
            Background = Theme.Brush("Panel"),
            BorderBrush = Theme.Brush("Line"),
            BorderThickness = new Thickness(0, 1, 0, 0),
            Child = new ScrollViewer { Content = panel, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(12, 10, 12, 12) },
        };
        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star), MinHeight = 160 });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star), MaxHeight = 520 });
        var statusBar = new Border { Child = status, Padding = new Thickness(12, 2, 12, 2) };
        Grid.SetRow(statusBar, 1);
        Grid.SetRow(scroller, 2);
        Grid.SetRow(bottom, 3);
        root.Children.Add(toolbar);
        root.Children.Add(statusBar);
        root.Children.Add(scroller);
        root.Children.Add(bottom);
        Content = root;

        session.Raw += OnRaw;
        Shortcuts();
        Theme.Changed += () =>
        {
            scroller.Background = Theme.Brush("Bg");
            Redraw();
        };
    }

    /// <summary>The editor is done (deleted, or the person went back): the workflow list opens.</summary>
    public event Action? Closed;

    private void OnRaw(string type, JsonElement json)
    {
        switch (type)
        {
            case "workflows":
                nodeTypes = json.A("nodeTypes").Select(item => item.Clone()).ToList();
                pool = json.A("pool").Select(item => item.Clone()).ToList();
                break;
            case "tools" or "connector-connections":
                if (json.At("connectors").ValueKind == JsonValueKind.Array) connectors = json.A("connectors").Select(item => item.Clone()).ToList();
                if (json.At("connections").ValueKind == JsonValueKind.Array) connections = json.A("connections").Select(item => item.Clone()).ToList();
                break;
        }
    }

    private JsonElement? Spec(string type) => nodeTypes.FirstOrDefault(spec => spec.S("type") == type) is { ValueKind: JsonValueKind.Object } spec ? spec : null;

    // ---------- opening ----------

    /// <summary>Opens a workflow (a row of the list) or a new one (null).</summary>
    public void Open(JsonElement? workflow)
    {
        if (nodeTypes.Count == 0) session.Send(ClientFrames.Simple("workflows-list"));
        if (connectors.Count == 0) session.Send(ClientFrames.Simple("connector-connections"));
        var firstAgent = lookups.Get("agents").FirstOrDefault().Value ?? session.DefaultAgent;
        draft = workflow is { } existing
            ? new WorkflowDraft(existing.Obj(), isNew: false, originalName: existing.S("name"))
            : new WorkflowDraft(WorkflowDraft.New(session.DefaultAgent.Length > 0 ? session.DefaultAgent : firstAgent ?? "", firstAgent ?? ""), isNew: true, originalName: null);
        dirty = false;
        selected = null;
        selectedLink = null;
        lastRun = default;
        optionCache.Clear();
        history.Reset(draft.Workflow);
        Status(draft.IsNew ? "workflow ใหม่ — ตั้งชื่อในแผงด้านล่างแล้วกดบันทึก" : "", "Muted");
        Redraw();
        ShowPanel();
        scroller.ChangeView(0, 0, 1f, disableAnimation: true);
    }

    private void Status(string text, string brush)
    {
        status.Text = text;
        status.Foreground = Theme.Brush(brush);
    }

    private void Dirty()
    {
        dirty = true;
        Heading();
        _ = Checkpoint();
    }

    /// <summary>An undo step once the edits pause (a step per keystroke would fill the history while typing).</summary>
    private async Task Checkpoint()
    {
        var ticket = ++checkpointTicket;
        await Task.Delay(500);
        if (ticket == checkpointTicket && draft is not null) history.Checkpoint(draft.Workflow);
    }

    private void Undo() => Restore(draft is null ? null : history.Undo(draft.Workflow), "ย้อนไม่ได้แล้ว");

    private void Redo() => Restore(history.Redo(), "ไม่มีอะไรให้ทำซ้ำ");

    private void Restore(JsonObject? workflow, string none)
    {
        if (draft is null) return;
        checkpointTicket++;
        if (workflow is null)
        {
            Status(none, "Muted");
            return;
        }
        // The file it is saved under stays (the web keeps draft.name of an existing workflow).
        if (!draft.IsNew) workflow["name"] = draft.Workflow.Str("name");
        draft = new WorkflowDraft(workflow, draft.IsNew, draft.OriginalName);
        if (selected is { } id && draft.Node(id) is null) selected = null;
        selectedLink = null;
        dirty = true;
        Status("", "Muted");
        Redraw();
        ShowPanel();
    }

    /// <summary>Ctrl+Z / Ctrl+Y / Ctrl+C / Ctrl+V / Ctrl+D / Delete on the canvas; a text field keeps its own.</summary>
    private void Shortcuts()
    {
        void Add(VirtualKey key, VirtualKeyModifiers modifiers, Action act)
        {
            var accelerator = new KeyboardAccelerator { Key = key, Modifiers = modifiers };
            accelerator.Invoked += (_, args) =>
            {
                if (XamlRoot is null || FocusManager.GetFocusedElement(XamlRoot) is TextBox or PasswordBox or NumberBox or ComboBox { IsEditable: true }) return;
                args.Handled = true;
                act();
            };
            KeyboardAccelerators.Add(accelerator);
        }
        Add(VirtualKey.Z, VirtualKeyModifiers.Control, Undo);
        Add(VirtualKey.Y, VirtualKeyModifiers.Control, Redo);
        Add(VirtualKey.Z, VirtualKeyModifiers.Control | VirtualKeyModifiers.Shift, Redo);
        Add(VirtualKey.C, VirtualKeyModifiers.Control, () =>
        {
            if (selected is { } id && draft?.Node(id) is { } node && !WorkflowDraft.IsTrigger(WorkflowDraft.TypeOf(node)))
            {
                clipboard = (JsonObject)node.DeepClone();
                Status($"คัดลอก {id} แล้ว — Ctrl+V เพื่อวาง", "Muted");
            }
        });
        Add(VirtualKey.V, VirtualKeyModifiers.Control, () =>
        {
            if (draft is null || clipboard is null) return;
            var copy = draft.Paste(clipboard);
            Dirty();
            Select(WorkflowDraft.IdOf(copy));
        });
        Add(VirtualKey.D, VirtualKeyModifiers.Control, () =>
        {
            if (selected is not { } id || draft?.Node(id) is not { } node || WorkflowDraft.IsTrigger(WorkflowDraft.TypeOf(node))) return;
            var copy = draft.Duplicate(node);
            Dirty();
            Select(WorkflowDraft.IdOf(copy));
        });
        Add(VirtualKey.Delete, VirtualKeyModifiers.None, () =>
        {
            if (selectedLink is { } link) RemoveLink(link.From, link.Output, link.To);
            else if (selected is { } id) RemoveNode(id);
        });
    }

    private void Heading()
    {
        if (draft is null) return;
        var flow = draft.Workflow;
        var title = flow.Str("title") is { Length: > 0 } shown ? shown : flow.Str("name") is { Length: > 0 } name ? name : "workflow ใหม่";
        heading.Text = $"{(dirty ? "● " : "")}{title}";
        heading.Foreground = Theme.Brush("Ink");
    }

    // ---------- drawing ----------

    private static int OutputsCount(JsonElement? spec) => Math.Max(1, spec?.A("outputs").Count() ?? 1);

    private IReadOnlyList<(string Key, string Label)> Outputs(JsonObject node)
    {
        var spec = Spec(WorkflowDraft.TypeOf(node));
        var list = spec?.A("outputs").Select(output => (output.S("key"), output.S("label"))).ToList() ?? [];
        if (list.Count == 0) list.Add(("main", ""));
        // Outputs that hold links but the spec does not list (switch cases, the error branch) still show.
        foreach (var key in (node["links"] as JsonObject)?.Select(link => link.Key) ?? [])
        {
            if (!list.Any(entry => entry.Item1 == key)) list.Add((key, key));
        }
        if (node["onError"]?.GetValue<string>() == "branch" && !list.Any(entry => entry.Item1 == "error")) list.Add(("error", "error"));
        return list;
    }

    private static double CardHeight(int outputs) => Math.Max(62, 30 + outputs * 20);

    private void Redraw()
    {
        nodeLayer.Children.Clear();
        cards.Clear();
        if (draft is null) return;
        Heading();
        double width = 900, height = 600;
        foreach (var node in draft.NodeList)
        {
            var card = Card(node);
            var (x, y) = WorkflowDraft.Position(node) ?? (60, 60);
            Canvas.SetLeft(card, x);
            Canvas.SetTop(card, y);
            nodeLayer.Children.Add(card);
            cards[WorkflowDraft.IdOf(node)] = card;
            width = Math.Max(width, x + CardWidth + 300);
            height = Math.Max(height, y + 300);
        }
        DrawNotes();
        foreach (var note in draft.NoteList)
        {
            var (x, y) = NotePlace(note);
            width = Math.Max(width, x + NoteSize(note).Width + 200);
            height = Math.Max(height, y + NoteSize(note).Height + 200);
        }
        canvas.Width = width;
        canvas.Height = height;
        DrawLinks();
    }

    private Border Card(JsonObject node)
    {
        var id = WorkflowDraft.IdOf(node);
        var type = WorkflowDraft.TypeOf(node);
        var spec = Spec(type);
        var outputs = Outputs(node);
        var trigger = WorkflowDraft.IsTrigger(type);
        var disabled = node["disabled"] is JsonValue off && off.GetValueKind() == JsonValueKind.True;
        var grid = new Grid { Width = CardWidth, Height = CardHeight(outputs.Count) };
        var text = new StackPanel { Margin = new Thickness(14, 8, 26, 8), Spacing = 2, VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = spec?.S("label") is { Length: > 0 } typeLabel ? typeLabel : type, FontSize = 10.5, Foreground = Theme.Brush(trigger ? "Warn" : "Muted"), TextTrimming = TextTrimming.CharacterEllipsis });
        var titleText = new TextBlock { Text = node.Str("title") is { Length: > 0 } title ? title : id, FontSize = 13, FontWeight = FontWeights.SemiBold, Foreground = Theme.Brush("Ink"), TextTrimming = TextTrimming.CharacterEllipsis };
        // UI Automation sees text, not borders: the card is found by its title.
        AutomationProperties.SetAutomationId(titleText, $"node-{id}");
        text.Children.Add(titleText);
        grid.Children.Add(text);
        // The input dot (not on a trigger: nothing feeds it).
        if (!trigger)
        {
            var input = new Ellipse { Width = 12, Height = 12, Fill = Theme.Brush("Panel"), Stroke = Theme.Brush("LineStrong"), StrokeThickness = 2, HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(-6, 0, 0, 0) };
            grid.Children.Add(input);
        }
        for (var i = 0; i < outputs.Count; i++)
        {
            var (key, label) = outputs[i];
            var dot = new Ellipse
            {
                Width = 14,
                Height = 14,
                Fill = Theme.Brush(key == "error" ? "Bad" : "Accent"),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Top,
                Margin = new Thickness(0, PortY(outputs.Count, i) - 7, -7, 0),
            };
            AutomationProperties.SetName(dot, $"ทางออก {key} ของ {id}");
            ToolTipService.SetToolTip(dot, $"ลากไปวางบน node เพื่อเชื่อม ({(label.Length > 0 ? label : key)})");
            var output = key;
            dot.PointerPressed += (_, e) =>
            {
                e.Handled = true;
                linking = (id, output);
                rubber = new Path { Stroke = Theme.Brush("Accent"), StrokeThickness = 2, StrokeDashArray = [4, 3] };
                linkLayer.Children.Add(rubber);
                canvas.CapturePointer(e.Pointer);
            };
            grid.Children.Add(dot);
            if (outputs.Count > 1 && label.Length + key.Length > 0)
            {
                grid.Children.Add(new TextBlock
                {
                    Text = label.Length > 0 ? label.Split(' ')[0] : key,
                    FontSize = 9.5,
                    Foreground = Theme.Brush("Faint"),
                    HorizontalAlignment = HorizontalAlignment.Right,
                    VerticalAlignment = VerticalAlignment.Top,
                    Margin = new Thickness(0, PortY(outputs.Count, i) - 8, 10, 0),
                });
            }
        }
        var card = new Border
        {
            Child = grid,
            Background = Theme.Brush(trigger ? "Raised" : "Panel"),
            BorderBrush = Theme.Brush(id == selected ? "Accent" : trigger ? "Warn" : "Line"),
            BorderThickness = new Thickness(id == selected ? 2 : 1),
            CornerRadius = new CornerRadius(10),
            Opacity = disabled ? 0.5 : 1,
        };
        card.PointerPressed += (_, e) =>
        {
            if (e.GetCurrentPoint(canvas).Properties.IsRightButtonPressed) return;
            dragging = id;
            dragStart = e.GetCurrentPoint(canvas).Position;
            dragOrigin = WorkflowDraft.Position(node) ?? (0, 0);
            card.CapturePointer(e.Pointer);
            e.Handled = true;
        };
        card.PointerMoved += (_, e) =>
        {
            if (dragging != id) return;
            var at = e.GetCurrentPoint(canvas).Position;
            Canvas.SetLeft(card, Math.Max(0, dragOrigin.X + at.X - dragStart.X));
            Canvas.SetTop(card, Math.Max(0, dragOrigin.Y + at.Y - dragStart.Y));
            DrawLinks();
        };
        card.PointerReleased += (_, e) =>
        {
            if (dragging != id) return;
            dragging = null;
            card.ReleasePointerCapture(e.Pointer);
            var at = e.GetCurrentPoint(canvas).Position;
            if (Math.Abs(at.X - dragStart.X) + Math.Abs(at.Y - dragStart.Y) < 4)
            {
                Select(id);
                return;
            }
            // Snap to a 10-unit grid, like the web canvas.
            WorkflowDraft.Move(node, Math.Round((dragOrigin.X + at.X - dragStart.X) / 10) * 10, Math.Round((dragOrigin.Y + at.Y - dragStart.Y) / 10) * 10);
            Dirty();
            Redraw();
        };
        var menu = new MenuFlyout();
        menu.Items.Add(Item("แก้ node นี้", () => Select(id)));
        menu.Items.Add(Item("ทดสอบ node นี้", () =>
        {
            Select(id);
            _ = TestNode(node, null);
        }));
        menu.Items.Add(Item(disabled ? "เปิด node นี้" : "ปิด node นี้ (ส่งผ่าน)", () =>
        {
            node["disabled"] = !disabled;
            Dirty();
            Redraw();
        }));
        menu.Items.Add(Item("ทำสำเนา", () =>
        {
            var copy = draft!.Duplicate(node);
            Dirty();
            Select(WorkflowDraft.IdOf(copy));
        }));
        menu.Items.Add(Item("บันทึกเป็น preset…", () => _ = SavePreset(node)));
        menu.Items.Add(Item("ลบ node", () => RemoveNode(id)));
        card.ContextFlyout = menu;
        return card;
    }

    private static double PortY(int count, int index) => count == 1 ? CardHeight(1) / 2 : 22 + index * 20;

    private static MenuFlyoutItem Item(string text, Action act)
    {
        var item = new MenuFlyoutItem { Text = text };
        item.Click += (_, _) => act();
        return item;
    }

    private Point PortOf(string id, string output)
    {
        var card = cards[id];
        var node = draft!.Node(id)!;
        var outputs = Outputs(node);
        var index = Math.Max(0, outputs.ToList().FindIndex(entry => entry.Key == output));
        return new Point(Canvas.GetLeft(card) + CardWidth, Canvas.GetTop(card) + PortY(outputs.Count, index));
    }

    private Point InputOf(string id)
    {
        var card = cards[id];
        return new Point(Canvas.GetLeft(card), Canvas.GetTop(card) + CardHeight(Outputs(draft!.Node(id)!).Count) / 2);
    }

    private static PathGeometry Curve(Point from, Point to)
    {
        var dx = Math.Max(40, Math.Abs(to.X - from.X) / 2);
        var figure = new PathFigure { StartPoint = from };
        figure.Segments.Add(new BezierSegment { Point1 = new Point(from.X + dx, from.Y), Point2 = new Point(to.X - dx, to.Y), Point3 = to });
        var geometry = new PathGeometry();
        geometry.Figures.Add(figure);
        return geometry;
    }

    private void DrawLinks()
    {
        linkLayer.Children.Clear();
        if (draft is null) return;
        foreach (var node in draft.NodeList)
        {
            var from = WorkflowDraft.IdOf(node);
            if (!cards.ContainsKey(from) || node["links"] is not JsonObject links) continue;
            foreach (var (output, targets) in links)
            {
                foreach (var target in (targets as JsonArray)?.Select(entry => entry?.GetValue<string>() ?? "") ?? [])
                {
                    if (!cards.ContainsKey(target)) continue;
                    var geometry = Curve(PortOf(from, output), InputOf(target));
                    var chosen = selectedLink is { } link && link.From == from && link.Output == output && link.To == target;
                    var line = new Path { Data = geometry, Stroke = Theme.Brush(chosen ? "Accent" : output == "error" ? "Bad" : "LineStrong"), StrokeThickness = chosen ? 3 : 2 };
                    // A wide see-through twin takes the clicks.
                    var hit = new Path { Data = Curve(PortOf(from, output), InputOf(target)), Stroke = new SolidColorBrush(Microsoft.UI.Colors.Transparent), StrokeThickness = 12 };
                    var (f, o, t) = (from, output, target);
                    hit.Tapped += (_, e) =>
                    {
                        e.Handled = true;
                        selectedLink = (f, o, t);
                        selected = null;
                        DrawLinks();
                        ShowPanel();
                    };
                    var menu = new MenuFlyout();
                    menu.Items.Add(Item("ลบเส้นเชื่อม", () => RemoveLink(f, o, t)));
                    hit.ContextFlyout = menu;
                    linkLayer.Children.Add(line);
                    linkLayer.Children.Add(hit);
                }
            }
        }
        if (rubber is not null) linkLayer.Children.Add(rubber);
    }

    private void OnCanvasMoved(object sender, PointerRoutedEventArgs e)
    {
        if (linking is not { } link || rubber is null) return;
        rubber.Data = Curve(PortOf(link.From, link.Output), e.GetCurrentPoint(canvas).Position);
    }

    private void OnCanvasReleased(object sender, PointerRoutedEventArgs e)
    {
        if (linking is not { } link) return;
        linking = null;
        canvas.ReleasePointerCapture(e.Pointer);
        if (rubber is not null) linkLayer.Children.Remove(rubber);
        rubber = null;
        var at = e.GetCurrentPoint(canvas).Position;
        var target = cards.FirstOrDefault(entry =>
        {
            var left = Canvas.GetLeft(entry.Value);
            var top = Canvas.GetTop(entry.Value);
            return at.X >= left && at.X <= left + CardWidth && at.Y >= top && at.Y <= top + Math.Max(62, entry.Value.ActualHeight);
        }).Key;
        if (target is null) return;
        if (draft!.Link(link.From, link.Output, target))
        {
            Dirty();
            Status($"เชื่อม {link.From} → {target} แล้ว", "Ok");
        }
        DrawLinks();
    }

    private void RemoveLink(string from, string output, string to)
    {
        if (draft?.Node(from) is not { } node) return;
        WorkflowDraft.Unlink(node, output, to);
        selectedLink = null;
        Dirty();
        Redraw();
        ShowPanel();
    }

    private void RemoveNode(string id)
    {
        draft?.Remove(id);
        if (selected == id) selected = null;
        Dirty();
        Redraw();
        ShowPanel();
    }

    private void Select(string? id)
    {
        selected = id;
        selectedLink = null;
        Redraw();
        ShowPanel();
    }

    private void FillAddMenu(MenuFlyout menu)
    {
        menu.Items.Clear();
        if (nodeTypes.Count == 0)
        {
            menu.Items.Add(new MenuFlyoutItem { Text = "กำลังโหลดชนิดของ node…", IsEnabled = false });
            session.Send(ClientFrames.Simple("workflows-list"));
            return;
        }
        var triggers = new MenuFlyoutSubItem { Text = "ทริกเกอร์" };
        var ai = new MenuFlyoutSubItem { Text = "AI" };
        var data = new MenuFlyoutSubItem { Text = "ข้อมูล" };
        var flow = new MenuFlyoutSubItem { Text = "ทางแยก / ควบคุม" };
        var files = new MenuFlyoutSubItem { Text = "ไฟล์" };
        var other = new MenuFlyoutSubItem { Text = "บริการ / อื่น ๆ" };
        foreach (var spec in nodeTypes)
        {
            var type = spec.S("type");
            var target = WorkflowDraft.IsTrigger(type) ? triggers
                : type is "agent" or "agent_call" or "llm" or "classify" or "extract" or "knowledge" ? ai
                : type is "set" or "code" or "filter" or "sort" or "limit" or "aggregate" or "remove_duplicates" or "split_out" or "datetime" or "json_schema" or "debug" or "assert" or "plugin" ? data
                : type is "file" or "extract_file" or "sheets" ? files
                : type is "if" or "switch" or "merge" or "wait" or "stop" or "loop" or "workflow" or "approval" or "respond" ? flow
                : other;
            var item = new MenuFlyoutItem { Text = spec.S("label") };
            ToolTipService.SetToolTip(item, spec.S("description"));
            item.Click += (_, _) => AddNode(type, spec.S("label"));
            target.Items.Add(item);
        }
        foreach (var group in new[] { triggers, ai, data, files, flow, other }.Where(group => group.Items.Count > 0)) menu.Items.Add(group);
        var presets = NodePresets.Read(session.UiValues);
        if (presets.Count == 0) return;
        var mine = new MenuFlyoutSubItem { Text = "Preset ของฉัน" };
        var forget = new MenuFlyoutSubItem { Text = "ลบ preset" };
        foreach (var preset in presets)
        {
            var item = new MenuFlyoutItem { Text = preset.Title };
            ToolTipService.SetToolTip(item, $"{preset.Type}{(preset.Description.Length > 0 ? $" · {preset.Description}" : "")}");
            item.Click += (_, _) => AddPreset(preset);
            mine.Items.Add(item);
            var remove = new MenuFlyoutItem { Text = preset.Title };
            remove.Click += (_, _) =>
            {
                session.SetUi(NodePresets.Prefix + preset.Id, null);
                Status($"ลบ preset \"{preset.Title}\" แล้ว", "Muted");
            };
            forget.Items.Add(remove);
        }
        menu.Items.Add(new MenuFlyoutSeparator());
        menu.Items.Add(mine);
        menu.Items.Add(forget);
    }

    /// <summary>A node from a preset: its type with the saved settings copied in, placed as "+ node" places one.</summary>
    private void AddPreset(NodePresets.Preset preset)
    {
        if (draft is null) return;
        var label = Spec(preset.Type)?.S("label") is { Length: > 0 } typeLabel ? typeLabel : preset.Type;
        var before = selected;
        AddNode(preset.Type, preset.Title.Length > 0 ? preset.Title : label);
        if (selected is { } id && id != before && draft.Node(id) is { } node)
        {
            node["config"] = preset.Config.DeepClone();
            Dirty();
            Select(id);
        }
    }

    private async Task SavePreset(JsonObject node)
    {
        var name = new TextBox { Text = node.Str("title") is { Length: > 0 } title ? title : Spec(WorkflowDraft.TypeOf(node))?.S("label") ?? WorkflowDraft.TypeOf(node), PlaceholderText = "ชื่อ preset" };
        var description = new TextBox { PlaceholderText = "ไว้ทำอะไร (ไม่บังคับ)" };
        var body = new StackPanel { Spacing = 8 };
        body.Children.Add(Ui.Hint("ค่าที่ตั้งไว้ใน node นี้จะถูกเก็บไว้ (ใช้ร่วมทุกเครื่องของบัญชีนี้) · วางซ้ำได้จาก \"+ node\" → Preset ของฉัน"));
        body.Children.Add(Ui.Field("ชื่อ preset", name));
        body.Children.Add(Ui.Field("คำอธิบาย", description));
        if (await Dialog("บันทึกเป็น node preset", body, "บันทึก") != ContentDialogResult.Primary) return;
        if (name.Text.Trim().Length == 0)
        {
            Status("ยังไม่ได้ตั้งชื่อ preset", "Bad");
            return;
        }
        try
        {
            var (key, value) = NodePresets.Make(name.Text.Trim(), description.Text.Trim(), node, DateTimeOffset.Now);
            session.SetUi(key, value);
            Status($"บันทึก preset \"{name.Text.Trim()}\" แล้ว ✓", "Ok");
        }
        catch (InvalidOperationException error)
        {
            Status($"บันทึกไม่ได้: {error.Message}", "Bad");
        }
    }

    private void AddNode(string type, string label)
    {
        if (draft is null) return;
        if (WorkflowDraft.IsTrigger(type) && draft.NodeList.Any(node => WorkflowDraft.IsTrigger(WorkflowDraft.TypeOf(node))))
        {
            Status("workflow หนึ่งมีทริกเกอร์ได้ตัวเดียว — ลบตัวเดิมก่อน หรือแก้ตัวเดิม", "Warn");
            return;
        }
        // Next to the selected node, else at the right of everything.
        var at = selected is { } id && draft.Node(id) is { } near && WorkflowDraft.Position(near) is { } place
            ? (place.X + 260, place.Y)
            : (draft.NodeList.Select(node => WorkflowDraft.Position(node)?.X ?? 0).DefaultIfEmpty(0).Max() + 260, 120.0);
        var firstAgent = lookups.Get("agents").FirstOrDefault().Value ?? "";
        var node = draft.Add(type, label, at.Item1, at.Item2, firstAgent);
        if (selected is { } from && !WorkflowDraft.IsTrigger(type)) draft.Link(from, "main", WorkflowDraft.IdOf(node));
        Dirty();
        Select(WorkflowDraft.IdOf(node));
    }

    // ---------- the panel ----------

    private void ShowPanel()
    {
        if (draft is null) return;
        if (selectedLink is { } link)
        {
            panel.Content = Ui.Card(
                Ui.Section("เส้นเชื่อม"),
                Ui.Title($"{link.From} ({link.Output}) → {link.To}", 14),
                Ui.Button("ลบเส้นเชื่อม", () => RemoveLink(link.From, link.Output, link.To), id: "RemoveLink"));
            return;
        }
        if (selected is { } id && draft.Node(id) is { } node)
        {
            panel.Content = NodePanel(node);
            return;
        }
        panel.Content = WorkflowPanel();
    }

    private FrameworkElement WorkflowPanel()
    {
        var flow = draft!.Workflow;
        var stack = new StackPanel { Spacing = 10 };
        stack.Children.Add(Ui.Section("workflow นี้"));
        stack.Children.Add(Ui.Hint("คลิก node เพื่อแก้ · ลากจุดสีชมพูด้านขวาของ node ไปวางบน node อื่นเพื่อเชื่อม · คลิกเส้นเพื่อลบ · คลิกขวาที่ node = ทดสอบ/ทำสำเนา/ลบ · Ctrl+ล้อเมาส์ = ซูม"));
        var fields = new List<FieldSpec>
        {
            new("name", "ชื่อไฟล์ (a-z, 0-9, -)", Hint: draft.IsNew ? null : "เปลี่ยนชื่อ = ย้ายไฟล์ (ประวัติการรันยังอยู่)"),
            new("title", "ชื่อที่แสดง"),
            new("description", "คำอธิบาย", FieldKind.Multiline),
            new("agent", "เป็นของ agent", FieldKind.Choice, OptionsFrom: "agents"),
            new("enabled", "เปิดใช้ (ทริกเกอร์ทำงานเอง)", FieldKind.Bool),
            new("errorWorkflow", "workflow ที่รันเมื่อผิดพลาด", Hint: "ชื่อ workflow ของ agent เดียวกัน (ไม่บังคับ)"),
            new("vars", "ตัวแปร ($vars)", FieldKind.KeyValue, "เช่น city = Bangkok แล้วใช้ {{ $vars.city }}"),
        };
        var form = new JsonForm(flow, fields, lookups);
        // Every edit marks the draft unsaved.
        form.Edited += Dirty;
        stack.Children.Add(form);
        if (flow.Str("webhook") is { Length: > 0 } hook) stack.Children.Add(Ui.Field("Webhook", Ui.Mono($"{session.Server?.TrimEnd('/')}{hook}")));
        if (!draft.IsNew)
        {
            stack.Children.Add(Ui.Row(6,
                Ui.Button("ประวัติการรัน", () => _ = History()),
                Ui.Button("ลบ workflow นี้", () => _ = Delete(), "ghost")));
        }
        return stack;
    }

    private FrameworkElement NodePanel(JsonObject node)
    {
        var id = WorkflowDraft.IdOf(node);
        var type = WorkflowDraft.TypeOf(node);
        var spec = Spec(type);
        var stack = new StackPanel { Spacing = 10 };
        var head = new Grid();
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(Ui.Section($"node {id} · {spec?.S("label") ?? type}"));
        var close = Ui.Button("✕", () => Select(null), "ghost", tip: "กลับไปที่ตั้งค่า workflow");
        Grid.SetColumn(close, 1);
        head.Children.Add(close);
        stack.Children.Add(head);
        if (spec?.S("description") is { Length: > 0 } description) stack.Children.Add(Ui.Hint(description));
        var title = new TextBox { Text = node.Str("title"), PlaceholderText = id };
        AutomationProperties.SetName(title, "ชื่อ node");
        title.TextChanged += (_, _) =>
        {
            node["title"] = title.Text;
            Dirty();
            if (cards.TryGetValue(id, out var card) && card.Child is Grid grid && grid.Children[0] is StackPanel texts && texts.Children[1] is TextBlock shown) shown.Text = title.Text.Length > 0 ? title.Text : id;
        };
        stack.Children.Add(Ui.Field("ชื่อ node", title));
        var config = node["config"] as JsonObject ?? (JsonObject)(node["config"] = new JsonObject());
        // Connector nodes and pool triggers get the fields of what they are set to (feature-workflows.js fieldsOfNode).
        var fields = WorkflowAssist.FieldsOf(node, nodeTypes, pool, connectors, connections);
        var form = new SpecForm(config, fields, lookups, Help(node));
        form.Edited += Dirty;
        form.Picked += key =>
        {
            // A connector field that reads its options from this one starts over; a new service or operation redraws the fields.
            var dependents = WorkflowAssist.DependentsOf(fields, key).ToList();
            if (dependents.Count > 0 && config["input"] is JsonObject input)
            {
                foreach (var dependent in dependents) input.Remove(dependent);
                optionCache.Clear();
            }
            if (WorkflowAssist.Reshapes(type, key) || dependents.Count > 0) panel.Content = NodePanel(node);
        };
        stack.Children.Add(form);

        // How the node behaves when it fails, and switching it off.
        if (!WorkflowDraft.IsTrigger(type))
        {
            var onError = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch };
            foreach (var (value, label) in new[] { ("stop", "หยุดทั้ง workflow (ปกติ)"), ("continue", "ทำต่อด้วยข้อมูลเดิม"), ("branch", "ส่งไปทางออก error") }) onError.Items.Add(new ComboBoxItem { Content = label, Tag = value });
            onError.SelectedItem = onError.Items.OfType<ComboBoxItem>().FirstOrDefault(item => (string)item.Tag == (node.Str("onError") is { Length: > 0 } chosen ? chosen : "stop"));
            onError.SelectionChanged += (_, _) =>
            {
                if (onError.SelectedItem is not ComboBoxItem item) return;
                if ((string)item.Tag == "stop") node.Remove("onError");
                else node["onError"] = (string)item.Tag;
                Dirty();
                Redraw();
            };
            var retries = new NumberBox { Value = node["retries"] is JsonValue r && r.TryGetValue<double>(out var count) ? count : 0, Minimum = 0, Maximum = 10, SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Compact };
            retries.ValueChanged += (_, args) =>
            {
                if (double.IsNaN(args.NewValue) || args.NewValue <= 0) node.Remove("retries");
                else node["retries"] = (int)args.NewValue;
                Dirty();
            };
            var advanced = new Expander { Header = "เมื่อผิดพลาด / ลองใหม่", HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch };
            var inner = new StackPanel { Spacing = 8 };
            inner.Children.Add(Ui.Field("เมื่อ node นี้ผิดพลาด", onError));
            inner.Children.Add(Ui.Field("ลองใหม่กี่ครั้ง", retries));
            advanced.Content = inner;
            stack.Children.Add(advanced);
        }

        // Test this node alone (workflow-test-node).
        var input = new TextBox
        {
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            FontFamily = new FontFamily("Cascadia Mono, Consolas"),
            FontSize = 12,
            MinHeight = 64,
            MaxHeight = 200,
            IsSpellCheckEnabled = false,
            Text = SampleInput(),
        };
        AutomationProperties.SetName(input, "ข้อมูลเข้าสำหรับทดสอบ");
        AutomationProperties.SetAutomationId(input, "TestInput");
        var result = new ContentControl { HorizontalContentAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetAutomationId(result, "TestResult");
        var test = new Expander { Header = "ทดสอบ node นี้", IsExpanded = false, HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetAutomationId(test, "TestExpander");
        var testBody = new StackPanel { Spacing = 8 };
        testBody.Children.Add(Ui.Hint("รันเฉพาะ node นี้กับข้อมูลเข้าด้านล่าง (object หรือ list ของ object) — ไม่บันทึก ไม่รัน node อื่น"));
        testBody.Children.Add(input);
        testBody.Children.Add(Ui.Button("รัน node นี้", () => _ = TestNode(node, input.Text, result), "pri", "RunNodeTest"));
        testBody.Children.Add(result);
        test.Content = testBody;
        stack.Children.Add(test);
        stack.Children.Add(Ui.Row(6,
            Ui.Button("ทำสำเนา", () =>
            {
                var copy = draft!.Duplicate(node);
                Dirty();
                Select(WorkflowDraft.IdOf(copy));
            }, "ghost"),
            Ui.Button("ลบ node", () => RemoveNode(id), "ghost", "RemoveNode"),
            Ui.Button("รันใหม่จากตรงนี้", () => _ = RunFrom(id), "ghost", tip: "ใช้ข้อมูลของการรันครั้งล่าสุด รันตั้งแต่ node นี้ไป")));
        return stack;
    }

    /// <summary>The trigger's sample (what a run would start with), as the web prefills the test box.</summary>
    private string SampleInput() =>
        draft is null ? "{}" : WorkflowAssist.TriggerSample(draft, pool).ToJsonString(new JsonSerializerOptions { WriteIndented = true, Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });

    /// <summary>The expression preview, the path picker and the connector options for one node's form.</summary>
    private SpecFormHelp Help(JsonObject node) => new(
        Preview: async text =>
        {
            if (draft is null) return (false, "");
            var (json, nodes, _) = WorkflowAssist.Sample(draft, node, lastRun, pool);
            var reqId = ++requests;
            try
            {
                var reply = await session.Ask(WorkflowAssist.PreviewFrame(reqId, text, json, nodes, draft.Workflow["vars"]), "workflow-expr-preview", "workflow-expr-preview",
                    answer => answer.At("reqId").ValueKind == JsonValueKind.Number && answer.At("reqId").GetInt64() == reqId, TimeSpan.FromSeconds(15));
                return reply.B("ok") ? (true, reply.S("value")) : (false, reply.S("error"));
            }
            catch (Exception error) when (error is TimeoutException or InvalidOperationException)
            {
                return (false, error.Message);
            }
        },
        Paths: () => draft is null ? [] : WorkflowAssist.Groups(draft, node, lastRun, pool),
        ConnectorOptions: async (field, config) =>
        {
            var reqId = ++requests;
            if (WorkflowAssist.OptionsQuestion(field, config, reqId, out _) is not { } question) return null;
            var cacheKey = question.Without("reqId").ToJsonString();
            if (optionCache.TryGetValue(cacheKey, out var cached)) return cached;
            try
            {
                var reply = await session.Ask(question.ToJsonString(), "connector-options", "connector-operation-options",
                    answer => answer.At("reqId").ValueKind == JsonValueKind.Number && answer.At("reqId").GetInt64() == reqId, TimeSpan.FromSeconds(30));
                if (!reply.B("ok")) return null;
                IReadOnlyList<(string Value, string Label)> options = reply.A("options").Select(option => (option.S("value"), option.S("label") is { Length: > 0 } label ? label : option.S("value"))).ToList();
                optionCache[cacheKey] = options;
                return options;
            }
            catch (Exception error) when (error is TimeoutException or InvalidOperationException)
            {
                return null;
            }
        });

    // ---------- sticky notes ----------

    private static readonly Dictionary<string, (byte R, byte G, byte B)> NoteTint = new()
    {
        ["yellow"] = (255, 236, 153),
        ["blue"] = (179, 218, 255),
        ["green"] = (190, 236, 186),
        ["pink"] = (255, 200, 221),
    };

    private static (double X, double Y) NotePlace(JsonObject note) =>
        note["position"] is JsonArray { Count: 2 } at && at[0] is JsonValue x && at[1] is JsonValue y && x.TryGetValue<double>(out var px) && y.TryGetValue<double>(out var py) ? (px, py) : (60, 60);

    private static (double Width, double Height) NoteSize(JsonObject note) =>
        (note["width"] is JsonValue w && w.TryGetValue<double>(out var width) ? width : 220, note["height"] is JsonValue h && h.TryGetValue<double>(out var height) ? height : 130);

    private void AddNote()
    {
        if (draft is null) return;
        // In the middle of what is on screen.
        var zoom = Math.Max(0.1, scroller.ZoomFactor);
        var note = draft.AddNote((scroller.HorizontalOffset + scroller.ActualWidth / 2) / zoom, (scroller.VerticalOffset + scroller.ActualHeight / 2) / zoom);
        Dirty();
        Redraw();
        if (noteLayer.Children.OfType<Border>().LastOrDefault()?.Child is Grid { Children: [_, TextBox text, ..] }) text.Focus(FocusState.Programmatic);
        Status($"เพิ่มโน้ต {note.Str("id")} แล้ว — ลากแถบบนเพื่อย้าย, มุมขวาล่างเพื่อขยาย", "Muted");
    }

    /// <summary>The notes under the nodes (feature-canvas.js drawNotes): dragged by their strip, resized by the corner, text edited in place.</summary>
    private void DrawNotes()
    {
        noteLayer.Children.Clear();
        if (draft is null) return;
        foreach (var note in draft.NoteList)
        {
            var id = note.Str("id");
            var (r, g, b) = NoteTint.TryGetValue(note.Str("color"), out var tint) ? tint : NoteTint["yellow"];
            var ink = new SolidColorBrush(Windows.UI.Color.FromArgb(255, 60, 50, 20));
            var (w, h) = NoteSize(note);
            var grid = new Grid();
            grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(22) });
            grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            var strip = new Grid { Background = new SolidColorBrush(Windows.UI.Color.FromArgb(40, 0, 0, 0)) };
            strip.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            strip.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            strip.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            AutomationProperties.SetName(strip, $"แถบของโน้ต {id}");
            var color = new Button { Content = "●", FontSize = 11, Padding = new Thickness(6, 0, 6, 0), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Foreground = ink };
            ToolTipService.SetToolTip(color, "เปลี่ยนสี");
            AutomationProperties.SetName(color, $"เปลี่ยนสีโน้ต {id}");
            color.Click += (_, _) =>
            {
                WorkflowDraft.CycleColor(note);
                Dirty();
                DrawNotes();
            };
            var remove = new Button { Content = "✕", FontSize = 11, Padding = new Thickness(6, 0, 6, 0), Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Foreground = ink };
            ToolTipService.SetToolTip(remove, "ลบโน้ต");
            AutomationProperties.SetName(remove, $"ลบโน้ต {id}");
            remove.Click += (_, _) =>
            {
                draft!.RemoveNote(id);
                Dirty();
                DrawNotes();
            };
            Grid.SetColumn(color, 1);
            Grid.SetColumn(remove, 2);
            strip.Children.Add(color);
            strip.Children.Add(remove);
            var text = new TextBox
            {
                Text = note.Str("text"),
                PlaceholderText = "โน้ต…",
                AcceptsReturn = true,
                TextWrapping = TextWrapping.Wrap,
                FontSize = 12,
                Foreground = ink,
                Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                BorderThickness = new Thickness(0),
                IsSpellCheckEnabled = false,
            };
            AutomationProperties.SetName(text, $"โน้ต {id}");
            text.TextChanged += (_, _) =>
            {
                if (note.Str("text") == text.Text) return;
                note["text"] = text.Text;
                Dirty();
            };
            Grid.SetRow(text, 1);
            var corner = new Microsoft.UI.Xaml.Shapes.Polygon
            {
                Points = { new Point(14, 0), new Point(14, 14), new Point(0, 14) },
                Fill = new SolidColorBrush(Windows.UI.Color.FromArgb(90, 0, 0, 0)),
                HorizontalAlignment = HorizontalAlignment.Right,
                VerticalAlignment = VerticalAlignment.Bottom,
            };
            AutomationProperties.SetName(corner, $"ขยายโน้ต {id}");
            Grid.SetRow(corner, 1);
            grid.Children.Add(strip);
            grid.Children.Add(text);
            grid.Children.Add(corner);
            var box = new Border
            {
                Width = w,
                Height = h,
                Child = grid,
                Background = new SolidColorBrush(Windows.UI.Color.FromArgb(235, r, g, b)),
                CornerRadius = new CornerRadius(6),
                BorderBrush = new SolidColorBrush(Windows.UI.Color.FromArgb(60, 0, 0, 0)),
                BorderThickness = new Thickness(1),
            };
            var (x, y) = NotePlace(note);
            Canvas.SetLeft(box, x);
            Canvas.SetTop(box, y);
            noteLayer.Children.Add(box);

            // Dragging the strip moves the note; dragging the corner resizes it.
            Point start = default;
            (double X, double Y, double W, double H) origin = default;
            string? gesture = null;
            void Begin(UIElement handle, string kind, PointerRoutedEventArgs e)
            {
                if (e.OriginalSource is DependencyObject source && (IsWithin(source, color) || IsWithin(source, remove))) return;
                gesture = kind;
                start = e.GetCurrentPoint(canvas).Position;
                var (nx, ny) = NotePlace(note);
                origin = (nx, ny, box.Width, box.Height);
                handle.CapturePointer(e.Pointer);
                e.Handled = true;
            }
            void Track(PointerRoutedEventArgs e)
            {
                if (gesture is null) return;
                var at = e.GetCurrentPoint(canvas).Position;
                if (gesture == "move")
                {
                    Canvas.SetLeft(box, Math.Max(0, origin.X + at.X - start.X));
                    Canvas.SetTop(box, Math.Max(0, origin.Y + at.Y - start.Y));
                }
                else
                {
                    box.Width = Math.Max(140, origin.W + at.X - start.X);
                    box.Height = Math.Max(70, origin.H + at.Y - start.Y);
                }
                e.Handled = true;
            }
            void End(UIElement handle, PointerRoutedEventArgs e)
            {
                if (gesture is null) return;
                handle.ReleasePointerCapture(e.Pointer);
                var at = e.GetCurrentPoint(canvas).Position;
                var moved = Math.Abs(at.X - start.X) + Math.Abs(at.Y - start.Y) >= 3;
                if (moved && gesture == "move") note["position"] = new JsonArray(Math.Round(Math.Max(0, origin.X + at.X - start.X)), Math.Round(Math.Max(0, origin.Y + at.Y - start.Y)));
                if (moved && gesture == "size")
                {
                    note["width"] = Math.Round(box.Width);
                    note["height"] = Math.Round(box.Height);
                }
                gesture = null;
                if (moved) Dirty();
                e.Handled = true;
            }
            strip.PointerPressed += (_, e) => Begin(strip, "move", e);
            strip.PointerMoved += (_, e) => Track(e);
            strip.PointerReleased += (_, e) => End(strip, e);
            corner.PointerPressed += (_, e) => Begin(corner, "size", e);
            corner.PointerMoved += (_, e) => Track(e);
            corner.PointerReleased += (_, e) => End(corner, e);
        }
    }

    private static bool IsWithin(DependencyObject element, DependencyObject parent)
    {
        for (var current = element; current is not null; current = VisualTreeHelper.GetParent(current))
        {
            if (ReferenceEquals(current, parent)) return true;
        }
        return false;
    }

    // ---------- talking to the server ----------

    private async Task<bool> Save()
    {
        if (draft is null) return false;
        var name = draft.Workflow.Str("name");
        var agent = draft.Workflow.Str("agent");
        if (name.Length == 0 || agent.Length == 0)
        {
            Status("ใส่ชื่อไฟล์และเลือก agent ก่อนบันทึก (แผงด้านล่าง)", "Bad");
            Select(null);
            return false;
        }
        // The server wants a title; the file name stands in until one is typed.
        if (draft.Workflow.Str("title").Trim().Length == 0) draft.Workflow["title"] = name;
        Status("กำลังบันทึก…", "Muted");
        try
        {
            var reply = await session.Ask(draft.SaveFrame(), "workflows", "workflow-save", json => json.S("saved") == $"{agent}/{name}", TimeSpan.FromSeconds(30));
            draft.Saved();
            dirty = false;
            Heading();
            Status("บันทึกแล้ว", "Ok");
            if (reply.A("workflows").FirstOrDefault(flow => flow.S("agent") == agent && flow.S("name") == name) is { ValueKind: JsonValueKind.Object } saved)
            {
                draft.Workflow["webhook"] = saved.At("webhook").ValueKind == JsonValueKind.String ? saved.S("webhook") : null;
            }
            return true;
        }
        catch (Exception error) when (error is TimeoutException or InvalidOperationException)
        {
            Status($"บันทึกไม่ได้: {error.Message}", "Bad");
            return false;
        }
    }

    private async Task Run()
    {
        if (draft is null || (dirty || draft.IsNew) && !await Save()) return;
        var input = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12, MinHeight = 120, Text = SampleInput() };
        if (await Dialog("รัน workflow", Ui.Field("ข้อมูลเข้า (JSON)", input, "เหมือนกดรันเอง: ข้อมูลนี้เป็น item แรก"), "รัน") != ContentDialogResult.Primary) return;
        JsonNode? data;
        try
        {
            data = string.IsNullOrWhiteSpace(input.Text) ? null : JsonNode.Parse(input.Text);
        }
        catch (JsonException error)
        {
            Status($"JSON ไม่ถูกต้อง: {error.Message}", "Bad");
            return;
        }
        Status("กำลังรัน…", "Muted");
        try
        {
            var reply = await session.Ask(ClientFrames.Json("workflow-run", new JsonObject
            {
                ["agent"] = draft.Workflow.Str("agent"),
                ["name"] = draft.Workflow.Str("name"),
                ["input"] = data as JsonObject,
                ["pins"] = true,
            }), "workflow-result", "workflow-run", timeout: TimeSpan.FromMinutes(5));
            lastRun = reply.At("result").Clone();
            Status(reply.At("result").B("ok") ? "รันเสร็จ" : "รันแล้วมีข้อผิดพลาด", reply.At("result").B("ok") ? "Ok" : "Bad");
            await Dialog("ผลการรัน", ResultView.Build("workflow-result", reply));
        }
        catch (Exception error) when (error is TimeoutException or InvalidOperationException)
        {
            Status($"รันไม่ได้: {error.Message}", "Bad");
        }
    }

    private async Task TestNode(JsonObject node, string? text, ContentControl? into = null)
    {
        if (draft is null) return;
        JsonArray items;
        try
        {
            items = WorkflowDraft.Items(text ?? SampleInput());
        }
        catch (JsonException error)
        {
            Status($"ข้อมูลเข้าไม่ใช่ JSON: {error.Message}", "Bad");
            return;
        }
        Status($"กำลังทดสอบ {WorkflowDraft.IdOf(node)}…", "Muted");
        try
        {
            var reply = await session.Ask(draft.TestFrame(node, items), "workflow-node-result", "workflow-test-node", timeout: TimeSpan.FromMinutes(3));
            var ok = reply.At("result").B("ok");
            Status(ok ? "ทดสอบผ่าน" : "node นี้ผิดพลาด", ok ? "Ok" : "Bad");
            var view = ResultView.Build("workflow-node-result", reply);
            if (into is not null) into.Content = view;
            else await Dialog($"ทดสอบ {WorkflowDraft.IdOf(node)}", view);
        }
        catch (Exception error) when (error is TimeoutException or InvalidOperationException)
        {
            Status($"ทดสอบไม่ได้: {error.Message}", "Bad");
        }
    }

    private async Task RunFrom(string nodeId)
    {
        if (draft is null || draft.IsNew) return;
        try
        {
            var runs = await session.Ask(ClientFrames.Json("workflow-runs", new JsonObject { ["agent"] = draft.Workflow.Str("agent"), ["name"] = draft.Workflow.Str("name") }), "workflow-runs", "workflow-runs");
            if (runs.A("runs").FirstOrDefault() is not { ValueKind: JsonValueKind.Object } last)
            {
                Status("ยังไม่เคยรัน — รันทั้ง workflow ก่อนหนึ่งครั้ง", "Warn");
                return;
            }
            if (dirty && !await Save()) return;
            var reply = await session.Ask(ClientFrames.Json("workflow-run-from", new JsonObject
            {
                ["agent"] = draft.Workflow.Str("agent"),
                ["name"] = draft.Workflow.Str("name"),
                ["nodeId"] = nodeId,
                ["runId"] = last.At("id").GetInt64(),
            }), "workflow-result", "workflow-run-from", timeout: TimeSpan.FromMinutes(5));
            lastRun = reply.At("result").Clone();
            await Dialog($"รันจาก {nodeId}", ResultView.Build("workflow-result", reply));
        }
        catch (Exception error) when (error is TimeoutException or InvalidOperationException or FormatException)
        {
            Status($"รันไม่ได้: {error.Message}", "Bad");
        }
    }

    private async Task History()
    {
        if (draft is null || draft.IsNew) return;
        try
        {
            var runs = await session.Ask(ClientFrames.Json("workflow-runs", new JsonObject { ["agent"] = draft.Workflow.Str("agent"), ["name"] = draft.OriginalName }), "workflow-runs", "workflow-runs");
            await Dialog("ประวัติการรัน", ResultView.Build("workflow-runs", runs));
        }
        catch (Exception error) when (error is TimeoutException or InvalidOperationException)
        {
            Status($"โหลดประวัติไม่ได้: {error.Message}", "Bad");
        }
    }

    private async Task Delete()
    {
        if (draft is null || draft.IsNew) return;
        if (await Dialog("ลบ workflow", Ui.Hint($"ลบ \"{draft.OriginalName}\"? ประวัติการรันยังเก็บไว้"), "ลบ") != ContentDialogResult.Primary) return;
        session.Send(ClientFrames.Json("workflow-delete", new JsonObject { ["agent"] = draft.Workflow.Str("agent"), ["name"] = draft.OriginalName }));
        draft = null;
        Closed?.Invoke();
    }

    private async Task<ContentDialogResult> Dialog(string title, UIElement content, string? primary = null)
    {
        for (var tries = 0; dialogOpen && tries < 50; tries++) await Task.Delay(50);
        dialogOpen = true;
        try
        {
            var dialog = new ContentDialog
            {
                XamlRoot = XamlRoot,
                RequestedTheme = Theme.Element,
                Title = title,
                Content = Ui.Scroll(content, 560),
                CloseButtonText = primary is null ? "ปิด" : "ยกเลิก",
                DefaultButton = primary is null ? ContentDialogButton.Close : ContentDialogButton.Primary,
            };
            if (primary is not null) dialog.PrimaryButtonText = primary;
            return await dialog.ShowAsync();
        }
        finally
        {
            dialogOpen = false;
        }
    }

    private MenuFlyout? moreMenu;

    private DropDownButton More()
    {
        var more = new DropDownButton { Content = "⋯", CornerRadius = new CornerRadius(8) };
        AutomationProperties.SetName(more, "เพิ่มเติม");
        moreMenu = new MenuFlyout();
        moreMenu.Items.Add(Item("ตั้งค่า workflow", () => Select(null)));
        moreMenu.Items.Add(Item("ประวัติการรัน", () => _ = History()));
        moreMenu.Items.Add(Item("จัดเรียง node อัตโนมัติ", () =>
        {
            if (draft is null) return;
            draft.AutoLayout(node => Outputs(node).Count);
            Dirty();
            Redraw();
            Fit();
        }));
        moreMenu.Items.Add(Item("ย้อน (Ctrl+Z)", Undo));
        moreMenu.Items.Add(Item("ทำซ้ำ (Ctrl+Y)", Redo));
        moreMenu.Items.Add(Item("พอดีจอ", Fit));
        moreMenu.Items.Add(Item("ซูม 100%", () => scroller.ChangeView(null, null, 1f)));
        moreMenu.Items.Add(new MenuFlyoutSeparator());
        moreMenu.Items.Add(Item("ลบ workflow นี้", () => _ = Delete()));
        more.Flyout = moreMenu;
        return more;
    }

    private void Fit()
    {
        if (canvas.Width <= 0 || scroller.ActualWidth <= 0) return;
        var zoom = (float)Math.Clamp(Math.Min(scroller.ActualWidth / canvas.Width, scroller.ActualHeight / canvas.Height), 0.3, 1);
        scroller.ChangeView(0, 0, zoom);
    }

    /// <summary>Leaving with unsaved changes asks first; true = go.</summary>
    public async Task<bool> CanLeave()
    {
        if (!dirty) return true;
        return await Dialog("ยังไม่ได้บันทึก", Ui.Hint("ออกจาก workflow นี้โดยไม่บันทึก? การแก้ไขจะหาย"), "ออกโดยไม่บันทึก") == ContentDialogResult.Primary;
    }
}
