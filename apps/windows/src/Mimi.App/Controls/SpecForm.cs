using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Services;
using Mimi.Core.Hub;
using Windows.System;

namespace Mimi.App.Controls;

/// <summary>
/// What the workflow editor lends a form (feature-workflows.js exprAssist / addPicker / connectorOptionsField):
/// the "= value" preview of an expression, the paths it can pick from, and the options a connector field reads
/// from its service. Any of them may be missing (the trigger pool's forms have none).
/// </summary>
internal sealed record SpecFormHelp(
    Func<string, Task<(bool Ok, string Text)>>? Preview = null,
    Func<IReadOnlyList<WorkflowAssist.PathGroup>>? Paths = null,
    Func<JsonElement, JsonObject, Task<IReadOnlyList<(string Value, string Label)>?>>? ConnectorOptions = null);

/// <summary>
/// A form from the field specs the server sends with the node types and the trigger pool
/// (<c>NodeTypeField</c>: key, label, type, options, placeholder, description, required) — so every node and
/// trigger gets its own fields, the way the web's workflow editor draws them (feature-workflows.js fieldInput).
/// Conditions get rows (left / operator / right) instead of JSON; a connector operation's fields
/// (<c>connectorInput</c>) live in <c>config.input</c>; expression fields preview their value and suggest paths.
/// </summary>
internal sealed partial class SpecForm : StackPanel
{
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    public static readonly string[] Operators = ["equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "regex", "gt", "lt", "gte", "lte", "is_empty", "is_not_empty", "is_true", "is_false"];

    private readonly JsonObject config;
    private readonly Lookups lookups;
    private readonly SpecFormHelp help;
    private readonly HashSet<string> problems = [];

    public SpecForm(JsonObject config, IEnumerable<JsonElement> fields, Lookups lookups, SpecFormHelp? help = null)
    {
        this.config = config;
        this.lookups = lookups;
        this.help = help ?? new SpecFormHelp();
        Spacing = 10;
        foreach (var field in fields) Children.Add(Field(field));
        if (Children.Count == 0) Children.Add(Ui.Hint("node นี้ไม่มีค่าที่ต้องตั้ง", "Faint"));
    }

    /// <summary>JSON fields that do not parse; saving should wait.</summary>
    public IReadOnlyCollection<string> Problems => problems;

    /// <summary>Something was edited (the canvas redraws a title, the editor marks the draft unsaved).</summary>
    public event Action? Edited;

    /// <summary>A choice was made in this field (key): the service or operation of a connector picks the other fields.</summary>
    public event Action<string>? Picked;

    /// <summary>Where a field's value lives: the node's config, or config.input for a connector operation's own fields.</summary>
    private JsonObject Home(JsonElement field)
    {
        if (!field.B("connectorInput")) return config;
        if (config["input"] is not JsonObject input)
        {
            input = [];
            config["input"] = input;
        }
        return input;
    }

    private void Set(JsonObject home, string key, JsonNode? value)
    {
        if (value is null) home.Remove(key);
        else home[key] = value;
        Edited?.Invoke();
    }

    private static IReadOnlyList<(string Value, string Label)> OptionsOf(JsonElement field)
    {
        var options = new List<(string, string)>();
        foreach (var option in field.A("options"))
        {
            switch (option.ValueKind)
            {
                case JsonValueKind.String:
                    options.Add((option.GetString()!, option.GetString()!));
                    break;
                case JsonValueKind.Array when option.GetArrayLength() >= 2:
                    options.Add((option[0].ToString(), option[1].ToString()));
                    break;
                case JsonValueKind.Object:
                    options.Add((option.S("value"), option.S("label") is { Length: > 0 } label ? label : option.S("value")));
                    break;
            }
        }
        return options;
    }

    private FrameworkElement Field(JsonElement field)
    {
        var key = field.S("key");
        var home = Home(field);
        var label = field.S("label") is { Length: > 0 } shown ? shown : key;
        if (field.B("required")) label += " *";
        var type = field.S("type");
        var hint = field.S("description");
        FrameworkElement control;
        if (key == "conditions" && !field.B("connectorInput")) control = Conditions(key);
        else if (field.B("connectorInput") && field.At("optionsFrom").ValueKind == JsonValueKind.Object) control = FromService(field, home, key, label);
        else if (field.A("options").Any()) control = Choice(home, key, OptionsOf(field), label);
        else if (type == "account") control = Choice(home, key, [("", "— บัญชีเริ่มต้น —"), .. lookups.Accounts(field.S("service") is { Length: > 0 } service ? service : null)], label);
        else if (key is "agent" && type is "string") control = Choice(home, key, lookups.Get("agents"), label);
        else if (key is "model" && type is "string") control = Choice(home, key, lookups.Get("models"), label);
        else
        {
            control = type switch
            {
                "boolean" => Toggle(home, key, label),
                "number" => Number(home, key, label, field.S("placeholder")),
                "json" => Json(home, key, label, field.S("placeholder")),
                "text" => Text(home, key, label, field.S("placeholder"), multiline: true),
                _ => Text(home, key, label, field.S("placeholder"), multiline: false, expression: type == "expression"),
            };
        }
        if (type == "boolean") return Hinted(control, hint);
        return Ui.Field(label, control, hint);
    }

    private static FrameworkElement Hinted(FrameworkElement control, string hint)
    {
        if (hint.Length == 0) return control;
        var stack = new StackPanel { Spacing = 2 };
        stack.Children.Add(control);
        stack.Children.Add(Ui.Hint(hint));
        return stack;
    }

    private static string Current(JsonObject home, string key) => home[key] switch
    {
        null => "",
        JsonValue value when value.TryGetValue<string>(out var text) => text,
        JsonValue value => value.ToJsonString(),
        var node => node.ToJsonString(Pretty),
    };

    private FrameworkElement Text(JsonObject home, string key, string label, string placeholder, bool multiline, bool expression = false)
    {
        var box = new TextBox
        {
            Text = Current(home, key),
            PlaceholderText = placeholder,
            AcceptsReturn = multiline,
            TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap,
            IsSpellCheckEnabled = false,
            MinHeight = multiline ? 80 : 0,
            MaxHeight = multiline ? 260 : double.PositiveInfinity,
        };
        if (expression) box.FontFamily = new FontFamily("Cascadia Mono, Consolas");
        AutomationProperties.SetName(box, label);
        box.TextChanged += (_, _) => Set(home, key, box.Text.Length == 0 ? null : JsonValue.Create(box.Text));
        return help.Preview is null && help.Paths is null ? box : Assisted(box, label);
    }

    // ---------- expression help: the preview line, the suggestions, the picker ----------

    /// <summary>
    /// A text field with the web's expression help: "= value" for the sample data once it holds <c>{{</c>,
    /// suggestions after <c>$json.</c> / <c>$node[…]</c> inside the braces (↑ ↓ Enter/Tab, Esc), and
    /// "{ } เลือกข้อมูล" — a searchable list of every path that puts <c>{{ path }}</c> at the cursor.
    /// </summary>
    private FrameworkElement Assisted(TextBox box, string label)
    {
        var stack = new StackPanel { Spacing = 3 };
        var suggestions = new ListView { Visibility = Visibility.Collapsed, MaxHeight = 220, SelectionMode = ListViewSelectionMode.Single, IsItemClickEnabled = true, Background = Theme.Brush("Raised"), BorderBrush = Theme.Brush("Line"), BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8) };
        AutomationProperties.SetName(suggestions, $"คำแนะนำของ {label}");
        var preview = new TextBlock { FontSize = 11.5, FontFamily = new FontFamily("Cascadia Mono, Consolas"), TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed, IsTextSelectionEnabled = true };
        AutomationProperties.SetName(preview, $"ผลของ {label}");
        List<WorkflowAssist.PathItem> items = [];
        CancellationTokenSource? pending = null;

        void Close() => suggestions.Visibility = Visibility.Collapsed;

        void Pick(WorkflowAssist.PathItem? item)
        {
            if (item is null)
            {
                Close();
                return;
            }
            var (text, caret) = WorkflowAssist.Pick(box.Text, box.SelectionStart, item.Path);
            box.Text = text;
            box.SelectionStart = Math.Min(caret, text.Length);
            box.Focus(FocusState.Programmatic);
            Close();
        }

        void Suggest()
        {
            if (help.Paths is null) return;
            items = WorkflowAssist.Suggest(help.Paths(), box.Text, box.SelectionStart).ToList();
            if (items.Count == 0)
            {
                Close();
                return;
            }
            suggestions.Items.Clear();
            foreach (var item in items) suggestions.Items.Add(PathRow(item));
            suggestions.SelectedIndex = 0;
            suggestions.Visibility = Visibility.Visible;
        }

        async void Update()
        {
            pending?.Cancel();
            if (help.Preview is null || !box.Text.Contains("{{", StringComparison.Ordinal))
            {
                preview.Visibility = Visibility.Collapsed;
                return;
            }
            var mine = pending = new CancellationTokenSource();
            try
            {
                await Task.Delay(350, mine.Token);
                var (ok, text) = await help.Preview(box.Text);
                if (mine.IsCancellationRequested) return;
                preview.Text = ok ? $"= {(text.Length == 0 ? "(ว่าง)" : text)}" : $"⚠ {text}";
                preview.Foreground = Theme.Brush(ok ? "Ok" : "Bad");
                preview.Visibility = Visibility.Visible;
            }
            catch (TaskCanceledException)
            {
                // a newer keystroke asks again
            }
        }

        box.TextChanged += (_, _) =>
        {
            Update();
            Suggest();
        };
        box.GotFocus += (_, _) => Update();
        box.LostFocus += async (_, _) =>
        {
            // A click on a suggestion lands after the focus left the box.
            await Task.Delay(180);
            if (box.FocusState == FocusState.Unfocused) Close();
        };
        box.PreviewKeyDown += (_, e) =>
        {
            if (suggestions.Visibility != Visibility.Visible || items.Count == 0) return;
            switch (e.Key)
            {
                case VirtualKey.Down or VirtualKey.Up:
                    suggestions.SelectedIndex = (suggestions.SelectedIndex + (e.Key == VirtualKey.Down ? 1 : items.Count - 1)) % items.Count;
                    e.Handled = true;
                    break;
                case VirtualKey.Enter or VirtualKey.Tab:
                    Pick(items.ElementAtOrDefault(suggestions.SelectedIndex));
                    e.Handled = true;
                    break;
                case VirtualKey.Escape:
                    Close();
                    e.Handled = true;
                    break;
            }
        };
        suggestions.ItemClick += (_, e) => Pick(items.ElementAtOrDefault(suggestions.Items.IndexOf(e.ClickedItem)));

        stack.Children.Add(box);
        stack.Children.Add(suggestions);
        stack.Children.Add(preview);
        if (help.Paths is not null) stack.Children.Add(Picker(box, label));
        if (box.Text.Contains("{{", StringComparison.Ordinal)) Update();
        return stack;
    }

    private static Grid PathRow(WorkflowAssist.PathItem item)
    {
        var row = new Grid { ColumnSpacing = 10, Padding = new Thickness(2, 1, 2, 1) };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.Children.Add(new TextBlock { Text = item.Path, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12, Foreground = Theme.Brush("Ink") });
        var value = new TextBlock { Text = item.Preview, FontSize = 11.5, Foreground = Theme.Brush("Faint"), TextTrimming = TextTrimming.CharacterEllipsis };
        Grid.SetColumn(value, 1);
        row.Children.Add(value);
        AutomationProperties.SetName(row, item.Path);
        return row;
    }

    /// <summary>"{ } เลือกข้อมูล": every path (the input, earlier nodes, variables, built-ins) with a search box.</summary>
    private FrameworkElement Picker(TextBox box, string label)
    {
        var open = new Button { Content = "{ } เลือกข้อมูล", FontSize = 11.5, Padding = new Thickness(8, 2, 8, 3), CornerRadius = new CornerRadius(6) };
        AutomationProperties.SetName(open, $"เลือกข้อมูลใส่ {label}");
        var search = new TextBox { PlaceholderText = "ค้นหา field…", IsSpellCheckEnabled = false };
        var list = new StackPanel { Spacing = 1 };
        var flyout = new Flyout
        {
            Content = new StackPanel { Width = 420, Spacing = 8, Children = { search, new ScrollViewer { Content = list, MaxHeight = 360, VerticalScrollBarVisibility = ScrollBarVisibility.Auto } } },
        };
        // Where the cursor was when the picker opened (the box loses its selection to the search field).
        var (start, length) = (0, 0);
        void Draw()
        {
            list.Children.Clear();
            var query = search.Text.Trim().ToLowerInvariant();
            foreach (var group in help.Paths!())
            {
                var rows = group.Items.Where(item => query.Length == 0 || item.Path.ToLowerInvariant().Contains(query) || item.Preview.ToLowerInvariant().Contains(query)).ToList();
                if (rows.Count == 0) continue;
                list.Children.Add(new TextBlock { Text = group.Label, FontSize = 11, Foreground = Theme.Brush("Muted"), Margin = new Thickness(0, 6, 0, 2), TextWrapping = TextWrapping.Wrap });
                foreach (var item in rows)
                {
                    var row = new Button { Content = PathRow(item), HorizontalAlignment = HorizontalAlignment.Stretch, HorizontalContentAlignment = HorizontalAlignment.Left, Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent), BorderThickness = new Thickness(0), Padding = new Thickness(6, 3, 6, 3) };
                    AutomationProperties.SetName(row, item.Path);
                    row.Click += (_, _) =>
                    {
                        var (text, caret) = WorkflowAssist.Insert(box.Text, start, length, item.Path);
                        flyout.Hide();
                        box.Text = text;
                        box.Focus(FocusState.Programmatic);
                        box.SelectionStart = Math.Min(caret, text.Length);
                    };
                    list.Children.Add(row);
                }
            }
            if (list.Children.Count == 0) list.Children.Add(Ui.Hint("ไม่มี field ที่ตรงกับคำค้น", "Faint"));
        }
        search.TextChanged += (_, _) => Draw();
        flyout.Opening += (_, _) =>
        {
            (start, length) = (box.SelectionStart, box.SelectionLength);
            search.Text = "";
            Draw();
        };
        open.Flyout = flyout;
        return open;
    }

    // ---------- the other kinds of field ----------

    private FrameworkElement Number(JsonObject home, string key, string label, string placeholder)
    {
        var box = new NumberBox
        {
            Value = home[key] is JsonValue value && value.TryGetValue<double>(out var number) ? number : double.NaN,
            PlaceholderText = placeholder,
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Hidden,
        };
        AutomationProperties.SetName(box, label);
        box.ValueChanged += (_, args) => Set(home, key, double.IsNaN(args.NewValue) ? null : args.NewValue == Math.Floor(args.NewValue) ? JsonValue.Create((long)args.NewValue) : JsonValue.Create(args.NewValue));
        return box;
    }

    private FrameworkElement Toggle(JsonObject home, string key, string label)
    {
        var box = new CheckBox { Content = label, IsChecked = home[key] is JsonValue value && value.GetValueKind() == JsonValueKind.True };
        box.Click += (_, _) => Set(home, key, JsonValue.Create(box.IsChecked == true));
        return box;
    }

    private ComboBox Choice(JsonObject home, string key, IReadOnlyList<(string Value, string Label)> options, string label)
    {
        var current = Current(home, key);
        var box = new ComboBox { IsEditable = true, HorizontalAlignment = HorizontalAlignment.Stretch, PlaceholderText = "(ว่าง)" };
        AutomationProperties.SetName(box, label);
        Fill(box, options, current);
        box.SelectionChanged += (_, _) =>
        {
            if (box.SelectedItem is not ComboBoxItem chosen) return;
            var value = (string)chosen.Tag;
            if (value == Current(home, key)) return;
            Set(home, key, value.Length == 0 ? null : JsonValue.Create(value));
            Picked?.Invoke(key);
        };
        box.TextSubmitted += (_, args) =>
        {
            var typed = args.Text.Trim();
            if (box.Items.OfType<ComboBoxItem>().Any(item => (string)item.Content == typed || (string)item.Tag == typed)) return;
            Set(home, key, typed.Length == 0 ? null : JsonValue.Create(typed));
            var entry = new ComboBoxItem { Content = typed, Tag = typed };
            box.Items.Add(entry);
            box.SelectedItem = entry;
            args.Handled = true;
            Picked?.Invoke(key);
        };
        return box;
    }

    private static void Fill(ComboBox box, IReadOnlyList<(string Value, string Label)> options, string current)
    {
        var list = options.ToList();
        if (!list.Any(option => option.Value.Length == 0)) list.Insert(0, ("", "(ว่าง)"));
        if (current.Length > 0 && !list.Any(option => option.Value == current)) list.Add((current, current));
        box.Items.Clear();
        foreach (var (value, text) in list) box.Items.Add(new ComboBoxItem { Content = text, Tag = value });
        box.SelectedItem = box.Items.OfType<ComboBoxItem>().FirstOrDefault(item => (string)item.Tag == current);
    }

    /// <summary>A connector field whose choices come from the service itself (a Slack channel, a Notion database…): typed by hand until they arrive.</summary>
    private FrameworkElement FromService(JsonElement field, JsonObject home, string key, string label)
    {
        var box = Choice(home, key, [], label);
        var missing = field.At("optionsFrom").Strings("dependsOn").Where(other => home[other] is null || Current(home, other).Length == 0).ToList();
        if (missing.Count > 0)
        {
            box.PlaceholderText = $"เลือก {string.Join(", ", missing)} ก่อน หรือพิมพ์ค่าเอง";
            return box;
        }
        if (help.ConnectorOptions is null) return box;
        box.PlaceholderText = "กำลังโหลดตัวเลือก… (พิมพ์ค่าเองได้)";
        _ = Load();
        return box;

        async Task Load()
        {
            var options = await help.ConnectorOptions(field, config);
            if (options is null)
            {
                box.PlaceholderText = "โหลดตัวเลือกไม่ได้ — พิมพ์ค่าเอง";
                return;
            }
            Fill(box, options, Current(home, key));
            box.PlaceholderText = field.S("placeholder") is { Length: > 0 } placeholder ? placeholder : "พิมพ์ค่า หรือเลือกจากรายการ";
        }
    }

    private FrameworkElement Json(JsonObject home, string key, string label, string placeholder)
    {
        var box = new TextBox
        {
            PlaceholderText = placeholder,
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            FontFamily = new FontFamily("Cascadia Mono, Consolas"),
            FontSize = 12,
            MinHeight = 64,
            MaxHeight = 300,
            IsSpellCheckEnabled = false,
        };
        box.Text = home[key] is { } node ? node.ToJsonString(Pretty) : "";
        AutomationProperties.SetName(box, label);
        var problem = Ui.Hint("", "Bad");
        box.TextChanged += (_, _) =>
        {
            problems.Remove(key);
            problem.Text = "";
            if (box.Text.Trim().Length == 0)
            {
                Set(home, key, null);
                return;
            }
            try
            {
                Set(home, key, JsonNode.Parse(box.Text));
            }
            catch (JsonException error)
            {
                problems.Add(key);
                problem.Text = $"JSON ไม่ถูกต้อง: {error.Message}";
            }
        };
        var panel = new StackPanel();
        panel.Children.Add(box);
        panel.Children.Add(problem);
        return panel;
    }

    /// <summary>The conditions editor: one row per condition (left / operator / right), plus a row to add.</summary>
    private FrameworkElement Conditions(string key)
    {
        var rows = new StackPanel { Spacing = 6 };
        JsonArray List()
        {
            if (config[key] is not JsonArray list)
            {
                list = [];
                config[key] = list;
            }
            return list;
        }
        void Paint()
        {
            rows.Children.Clear();
            var list = List();
            for (var i = 0; i < list.Count; i++)
            {
                var index = i;
                var condition = list[i] as JsonObject ?? [];
                list[i] = condition;
                var grid = new Grid { ColumnSpacing = 4 };
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(110) });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                var left = new TextBox { Text = condition.Str("left"), PlaceholderText = "{{ $json.text }}", FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12, IsSpellCheckEnabled = false };
                AutomationProperties.SetName(left, $"เงื่อนไข {index + 1} ซ้าย");
                left.TextChanged += (_, _) =>
                {
                    condition["left"] = left.Text;
                    Edited?.Invoke();
                };
                var op = new ComboBox { HorizontalAlignment = HorizontalAlignment.Stretch, FontSize = 12 };
                foreach (var name in Operators) op.Items.Add(name);
                op.SelectedItem = condition.Str("operator") is { Length: > 0 } chosen ? chosen : "contains";
                op.SelectionChanged += (_, _) =>
                {
                    condition["operator"] = op.SelectedItem as string ?? "contains";
                    Edited?.Invoke();
                };
                var right = new TextBox { Text = condition.Str("right"), PlaceholderText = "ค่า", FontSize = 12, IsSpellCheckEnabled = false };
                AutomationProperties.SetName(right, $"เงื่อนไข {index + 1} ขวา");
                right.TextChanged += (_, _) =>
                {
                    condition["right"] = right.Text;
                    Edited?.Invoke();
                };
                var remove = new Button { Content = "✕", Padding = new Thickness(8, 4, 8, 4) };
                AutomationProperties.SetName(remove, $"ลบเงื่อนไข {index + 1}");
                remove.Click += (_, _) =>
                {
                    List().RemoveAt(index);
                    Edited?.Invoke();
                    Paint();
                };
                Grid.SetColumn(op, 1);
                Grid.SetColumn(right, 2);
                Grid.SetColumn(remove, 3);
                grid.Children.Add(left);
                grid.Children.Add(op);
                grid.Children.Add(right);
                grid.Children.Add(remove);
                rows.Children.Add(grid);
            }
            rows.Children.Add(Ui.Button("+ เงื่อนไข", () =>
            {
                List().Add(new JsonObject { ["left"] = "", ["operator"] = "contains", ["right"] = "" });
                Edited?.Invoke();
                Paint();
            }, "ghost"));
        }
        Paint();
        return rows;
    }
}
