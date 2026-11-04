using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Mimi.Core.Hub;

namespace Mimi.App.Controls;

/// <summary>
/// An edit form built from a JSON object and its <see cref="FieldSpec"/>s (or, without specs, from the
/// object's own fields). Edits go straight into the object; fields the form does not show stay as they were.
/// Objects and lists get their own small forms instead of JSON: name → value rows, a card per entry, who sees it,
/// and fields worked out from the item (a connector's credentials once the connector is chosen).
/// </summary>
public sealed class JsonForm : StackPanel
{
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private readonly JsonObject item;
    private readonly Lookups lookups;
    private readonly List<string> problems = [];

    private readonly List<(FrameworkElement Element, FieldSpec Field)> conditional = [];
    private readonly List<(StackPanel Box, FieldSpec Field, string[] Shape)> dynamics = [];

    public JsonForm(JsonObject item, IReadOnlyList<FieldSpec>? fields, Lookups lookups)
    {
        this.item = item;
        this.lookups = lookups;
        Spacing = 10;
        foreach (var field in fields ?? Infer(item)) Children.Add(Build(field));
        Refresh();
    }

    /// <summary>Fields that show only for some values (an IMAP account's server, not a Gmail one's) follow the item.</summary>
    private void Refresh()
    {
        foreach (var (element, field) in conditional) element.Visibility = field.ShowWhen!(item) ? Visibility.Visible : Visibility.Collapsed;
        for (var i = 0; i < dynamics.Count; i++)
        {
            var (box, field, shape) = dynamics[i];
            var fields = field.Expand!(item, lookups);
            var now = fields.Select(entry => $"{entry.Path}:{entry.Kind}:{entry.Label}").ToArray();
            if (now.SequenceEqual(shape)) continue;
            dynamics[i] = (box, field, now);
            Fill(box, field, fields);
        }
    }

    /// <summary>The fields of a <see cref="FieldKind.Dynamic"/> field as the item is now; values of fields that went away are dropped.</summary>
    private void Fill(StackPanel box, FieldSpec field, IReadOnlyList<FieldSpec> fields)
    {
        box.Children.Clear();
        box.Children.Add(new TextBlock { Text = field.Label, FontSize = 13, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Brush("MimiInk2Brush") });
        if (field.Hint is { Length: > 0 } hint) box.Children.Add(Caption(hint));
        var keep = fields.Select(entry => entry.Path).ToHashSet();
        if (field.Path.Length > 0 && Get(field.Path) is JsonObject values)
        {
            foreach (var key in values.Select(entry => entry.Key).ToList())
            {
                if (!keep.Contains($"{field.Path}.{key}") && !keep.Contains(field.Path)) values.Remove(key);
            }
        }
        foreach (var entry in fields) box.Children.Add(Build(entry));
    }

    /// <summary>Fields whose JSON does not parse; saving waits until there are none.</summary>
    public IReadOnlyList<string> Problems => problems;

    public static string Show(JsonNode? node) => node switch
    {
        null => "",
        JsonValue value when value.TryGetValue<string>(out var text) => text,
        JsonValue value => value.ToJsonString(),
        _ => node.ToJsonString(Pretty),
    };

    private static IEnumerable<FieldSpec> Infer(JsonObject item)
    {
        foreach (var (key, value) in item)
        {
            yield return value switch
            {
                JsonValue boolean when boolean.GetValueKind() is JsonValueKind.True or JsonValueKind.False => new FieldSpec(key, key, FieldKind.Bool),
                JsonValue number when number.GetValueKind() == JsonValueKind.Number => new FieldSpec(key, key, FieldKind.Number),
                JsonArray array when array.All(entry => entry is JsonValue text && text.GetValueKind() == JsonValueKind.String) => new FieldSpec(key, key, FieldKind.List),
                JsonObject or JsonArray => new FieldSpec(key, key, FieldKind.Json),
                JsonValue text when (text.TryGetValue<string>(out var s) && (s.Length > 80 || s.Contains('\n'))) => new FieldSpec(key, key, FieldKind.Multiline),
                _ => new FieldSpec(key, key),
            };
        }
    }

    // ---------- the value at a dotted path ----------

    private JsonNode? Get(string path)
    {
        if (path.Length == 0) return item;
        JsonNode? current = item;
        foreach (var part in path.Split('.'))
        {
            if (current is not JsonObject json || !json.TryGetPropertyValue(part, out current)) return null;
        }
        return current;
    }

    private void Set(string path, JsonNode? value)
    {
        var parts = path.Split('.');
        var parent = item;
        foreach (var part in parts[..^1])
        {
            if (parent[part] is not JsonObject next)
            {
                next = new JsonObject();
                parent[part] = next;
            }
            parent = next;
        }
        if (value is null) parent.Remove(parts[^1]);
        else parent[parts[^1]] = value;
        Edited?.Invoke();
    }

    /// <summary>A value of the item changed (the editor marks its draft unsaved).</summary>
    public event Action? Edited;

    // ---------- controls ----------

    private static Brush Brush(string key) => (Brush)Application.Current.Resources[key];

    private static TextBlock Caption(string text) => new() { Text = text, FontSize = 12, Foreground = Brush("MimiMutedBrush"), TextWrapping = TextWrapping.Wrap };

    private FrameworkElement Build(FieldSpec field)
    {
        if (field.Kind == FieldKind.Dynamic && field.Expand is not null)
        {
            var box = new StackPanel { Spacing = 10 };
            var fields = field.Expand(item, lookups);
            dynamics.Add((box, field, fields.Select(entry => $"{entry.Path}:{entry.Kind}:{entry.Label}").ToArray()));
            Fill(box, field, fields);
            return box;
        }
        var built = BuildField(field);
        if (field.ShowWhen is not null) conditional.Add((built, field));
        return built;
    }

    /// <summary>A sub-card of fields for an object inside the item (a mailbox's incoming server).</summary>
    private FrameworkElement Group(FieldSpec field)
    {
        var stack = new StackPanel { Spacing = 10 };
        stack.Children.Add(new TextBlock { Text = field.Label, FontSize = 13, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Brush("MimiAccentTextBrush") });
        if (field.Hint is { Length: > 0 } hint) stack.Children.Add(Caption(hint));
        foreach (var child in field.Children ?? []) stack.Children.Add(Build(child with { Path = $"{field.Path}.{child.Path}" }));
        return new Border
        {
            Child = stack,
            BorderBrush = Brush("MimiLineBrush"),
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(12, 10, 12, 12),
            Background = Brush("MimiRaisedBrush"),
        };
    }

    private FrameworkElement BuildField(FieldSpec field)
    {
        if (field.Kind == FieldKind.Group) return Group(field);
        var box = new StackPanel { Spacing = 4 };
        var label = new TextBlock { Text = field.Label, FontSize = 13, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Brush("MimiInk2Brush"), TextWrapping = TextWrapping.Wrap };
        if (field.Kind != FieldKind.Bool) box.Children.Add(label);
        box.Children.Add(field.Kind switch
        {
            FieldKind.Multiline => Text(field, multiline: true),
            FieldKind.Number => Number(field),
            FieldKind.Bool => Toggle(field),
            FieldKind.Choice => Choice(field),
            FieldKind.List => List(field),
            FieldKind.Json => Json(field),
            FieldKind.Secret => Secret(field),
            FieldKind.ReadOnly => ReadOnly(field),
            FieldKind.KeyValue => KeyValue(field),
            FieldKind.Rows => Rows(field),
            FieldKind.Audience => Audience(field),
            _ => field.OptionsFrom is not null || field.Options is not null ? Choice(field) : Text(field, multiline: false),
        });
        if (field.Hint is { Length: > 0 } hint) box.Children.Add(Caption(hint));
        return box;
    }

    private FrameworkElement Text(FieldSpec field, bool multiline)
    {
        // AcceptsReturn must be on before Text: a TextBox that cannot take returns keeps only the first line.
        var box = new TextBox { IsSpellCheckEnabled = false, AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap, PlaceholderText = field.Placeholder ?? "" };
        box.Text = Show(Get(field.Path));
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, field.Label);
        if (multiline)
        {
            box.MinHeight = 90;
            // A long system prompt scrolls inside its own box, so the form keeps its size and the
            // scrollbar stays within the field (the web form's textarea never grows the page).
            box.MaxHeight = field.Path == "systemPrompt" ? 420 : 520;
            ScrollViewer.SetVerticalScrollBarVisibility(box, ScrollBarVisibility.Auto);
            ScrollViewer.SetHorizontalScrollBarVisibility(box, ScrollBarVisibility.Disabled);
        }
        box.TextChanged += (_, _) => Set(field.Path, field.OmitEmpty && box.Text.Trim().Length == 0 ? null : JsonValue.Create(box.Text));
        return box;
    }

    private FrameworkElement Number(FieldSpec field)
    {
        var current = Get(field.Path);
        var box = new NumberBox
        {
            Value = current is JsonValue value && value.TryGetValue<double>(out var number) ? number : double.NaN,
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Hidden,
            AcceptsExpression = false,
        };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, field.Label);
        box.ValueChanged += (_, args) =>
        {
            var next = args.NewValue;
            Set(field.Path, double.IsNaN(next) ? null : next == Math.Floor(next) && Math.Abs(next) < 9e15 ? JsonValue.Create((long)next) : JsonValue.Create(next));
        };
        return box;
    }

    private FrameworkElement Toggle(FieldSpec field)
    {
        var box = new CheckBox { Content = field.Label, IsChecked = Get(field.Path) is JsonValue value && value.GetValueKind() == JsonValueKind.True };
        box.Click += (_, _) =>
        {
            Set(field.Path, JsonValue.Create(box.IsChecked == true));
            Refresh();
        };
        return box;
    }

    private IReadOnlyList<(string Value, string Label)> Options(FieldSpec field) =>
        field.Options ?? (field.OptionsFrom is { } name ? lookups.Get(name) : []);

    private FrameworkElement Choice(FieldSpec field)
    {
        var current = Show(Get(field.Path));
        var box = new ComboBox { IsEditable = true, HorizontalAlignment = HorizontalAlignment.Stretch, PlaceholderText = "(ว่าง)" };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, field.Label);
        var options = Options(field).ToList();
        if (!options.Any(option => option.Value.Length == 0)) options.Insert(0, ("", "(ว่าง)"));
        if (current.Length > 0 && !options.Any(option => option.Value == current)) options.Add((current, current));
        foreach (var (value, label) in options) box.Items.Add(new ComboBoxItem { Content = label, Tag = value });
        box.SelectedItem = box.Items.OfType<ComboBoxItem>().FirstOrDefault(entry => (string)entry.Tag == current);
        box.SelectionChanged += (_, _) =>
        {
            if (box.SelectedItem is ComboBoxItem chosen) Set(field.Path, ((string)chosen.Tag).Length == 0 ? null : JsonValue.Create((string)chosen.Tag));
            Refresh();
        };
        // A value typed by hand (a model id not in the list yet).
        box.TextSubmitted += (_, args) =>
        {
            var typed = args.Text.Trim();
            var known = box.Items.OfType<ComboBoxItem>().FirstOrDefault(entry => (string)entry.Content == typed || (string)entry.Tag == typed);
            if (known is not null) return;
            Set(field.Path, typed.Length == 0 ? null : JsonValue.Create(typed));
            var entry = new ComboBoxItem { Content = typed, Tag = typed };
            box.Items.Add(entry);
            box.SelectedItem = entry;
            args.Handled = true;
        };
        return box;
    }

    private FrameworkElement List(FieldSpec field)
    {
        var lines = Get(field.Path) is JsonArray array ? array.Select(Show).ToList() : [];
        var box = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 60, MaxHeight = 220, IsSpellCheckEnabled = false };
        box.Text = string.Join("\r", lines);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, field.Label);
        ScrollViewer.SetVerticalScrollBarVisibility(box, ScrollBarVisibility.Auto);
        void Store()
        {
            var entries = box.Text.Split(['\r', '\n', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            Set(field.Path, new JsonArray(entries.Select(entry => (JsonNode?)JsonValue.Create(entry)).ToArray()));
        }
        box.TextChanged += (_, _) => Store();
        var options = Options(field);
        if (options.Count == 0) return box;
        // Pick from the list as well as typing.
        var pick = new DropDownButton { Content = "เลือกจากรายการ…", Margin = new Thickness(0, 4, 0, 0) };
        var menu = new MenuFlyout();
        menu.Opening += (_, _) =>
        {
            menu.Items.Clear();
            var have = box.Text.Split(['\r', '\n', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet();
            foreach (var (value, label) in options)
            {
                var entry = new ToggleMenuFlyoutItem { Text = label, IsChecked = have.Contains(value) };
                entry.Click += (_, _) =>
                {
                    var now = box.Text.Split(['\r', '\n', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
                    if (now.Contains(value)) now.Remove(value);
                    else now.Add(value);
                    box.Text = string.Join("\r", now);
                };
                menu.Items.Add(entry);
            }
        };
        pick.Flyout = menu;
        var panel = new StackPanel();
        panel.Children.Add(box);
        panel.Children.Add(pick);
        return panel;
    }

    private FrameworkElement Json(FieldSpec field)
    {
        var current = Get(field.Path);
        var box = new TextBox
        {
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            FontFamily = new FontFamily("Cascadia Mono, Consolas"),
            FontSize = 12,
            MinHeight = 70,
            MaxHeight = 360,
            IsSpellCheckEnabled = false,
        };
        box.Text = current is null ? "" : current.ToJsonString(Pretty);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, field.Label);
        ScrollViewer.SetVerticalScrollBarVisibility(box, ScrollBarVisibility.Auto);
        var problem = Caption("");
        problem.Foreground = Brush("MimiBadBrush");
        box.TextChanged += (_, _) =>
        {
            problems.Remove(field.Label);
            problem.Text = "";
            if (box.Text.Trim().Length == 0)
            {
                Set(field.Path, null);
                return;
            }
            try
            {
                Set(field.Path, JsonNode.Parse(box.Text));
            }
            catch (JsonException error)
            {
                problems.Add(field.Label);
                problem.Text = $"JSON ไม่ถูกต้อง: {error.Message}";
            }
        };
        var panel = new StackPanel();
        panel.Children.Add(box);
        panel.Children.Add(problem);
        return panel;
    }

    private FrameworkElement Secret(FieldSpec field)
    {
        var box = new PasswordBox { PlaceholderText = field.Placeholder ?? "••••••" };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, field.Label);
        box.PasswordChanged += (_, _) => Set(field.Path, box.Password.Length == 0 ? null : JsonValue.Create(box.Password));
        return box;
    }

    // ---------- small forms instead of JSON ----------

    private static Button Small(string text, string name, Action act)
    {
        var button = new Button { Content = text, Padding = new Thickness(8, 3, 8, 4), FontSize = 12 };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(button, name);
        button.Click += (_, _) => act();
        return button;
    }

    /// <summary>A value as typed: JSON when it reads as JSON (a number, true/false, a list, an object, "quoted text"), else the text itself.</summary>
    public static JsonNode? Typed(string text)
    {
        var trimmed = text.Trim();
        if (trimmed.Length > 0 && (char.IsDigit(trimmed[0]) || trimmed[0] is '-' or '[' or '{' or '"' || trimmed is "true" or "false" or "null"))
        {
            try
            {
                return JsonNode.Parse(trimmed);
            }
            catch (JsonException)
            {
                // not JSON: kept as text
            }
        }
        return JsonValue.Create(text);
    }

    /// <summary>An object of name → value as rows (name, value, ✕) and "+ เพิ่ม"; the order of the rows is kept.</summary>
    private FrameworkElement KeyValue(FieldSpec field)
    {
        var rows = new StackPanel { Spacing = 4 };
        var entries = (Get(field.Path) as JsonObject)?.Select(entry => (Key: entry.Key, Value: Show(entry.Value))).ToList() ?? [];
        void Store()
        {
            var json = new JsonObject();
            foreach (var (key, value) in entries)
            {
                if (key.Trim().Length > 0) json[key.Trim()] = Typed(value);
            }
            Set(field.Path, json);
        }
        void Paint()
        {
            rows.Children.Clear();
            for (var i = 0; i < entries.Count; i++)
            {
                var index = i;
                var grid = new Grid { ColumnSpacing = 4 };
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(2, GridUnitType.Star) });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(3, GridUnitType.Star) });
                grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                var name = new TextBox { Text = entries[i].Key, PlaceholderText = "ชื่อ", IsSpellCheckEnabled = false, FontFamily = new FontFamily("Cascadia Mono, Consolas"), FontSize = 12 };
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(name, $"{field.Label} แถว {index + 1} ชื่อ");
                var value = new TextBox { Text = entries[i].Value, PlaceholderText = "ค่า", IsSpellCheckEnabled = false, FontSize = 12 };
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(value, $"{field.Label} แถว {index + 1} ค่า");
                name.TextChanged += (_, _) =>
                {
                    entries[index] = (name.Text, entries[index].Value);
                    Store();
                };
                value.TextChanged += (_, _) =>
                {
                    entries[index] = (entries[index].Key, value.Text);
                    Store();
                };
                var remove = Small("✕", $"ลบแถว {index + 1} ของ {field.Label}", () =>
                {
                    entries.RemoveAt(index);
                    Store();
                    Paint();
                });
                Grid.SetColumn(value, 1);
                Grid.SetColumn(remove, 2);
                grid.Children.Add(name);
                grid.Children.Add(value);
                grid.Children.Add(remove);
                rows.Children.Add(grid);
            }
            rows.Children.Add(Small("+ เพิ่ม", $"เพิ่มแถวใน {field.Label}", () =>
            {
                entries.Add(("", ""));
                Paint();
            }));
            if (entries.Count == 0) rows.Children.Insert(0, Caption("ยังไม่มี — กด \"+ เพิ่ม\""));
        }
        Paint();
        var panel = new StackPanel { Spacing = 2 };
        panel.Children.Add(rows);
        panel.Children.Add(Caption("ตัวเลข true/false หรือ JSON ใส่ได้ตรง ๆ · ข้อความใส่ได้เลย (\"123\" = ข้อความ 123)"));
        return panel;
    }

    /// <summary>A list of objects: a card per entry with the entry's own fields, ✕ to remove, "+ เพิ่ม" for a new one.</summary>
    private FrameworkElement Rows(FieldSpec field)
    {
        var stack = new StackPanel { Spacing = 8 };
        JsonArray List()
        {
            if (Get(field.Path) is JsonArray list) return list;
            list = [];
            Set(field.Path, list);
            return list;
        }
        void Paint()
        {
            stack.Children.Clear();
            var list = List();
            for (var i = 0; i < list.Count; i++)
            {
                if (list[i] is not JsonObject entry)
                {
                    entry = [];
                    list[i] = entry;
                }
                var index = i;
                var head = new Grid();
                head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                head.Children.Add(new TextBlock { Text = entry.Str("label") is { Length: > 0 } title ? title : $"#{index + 1}", FontSize = 12.5, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, Foreground = Brush("MimiAccentTextBrush"), VerticalAlignment = VerticalAlignment.Center });
                var remove = Small("✕", $"ลบ {field.Label} #{index + 1}", () =>
                {
                    List().RemoveAt(index);
                    Paint();
                });
                Grid.SetColumn(remove, 1);
                head.Children.Add(remove);
                var card = new StackPanel { Spacing = 8 };
                card.Children.Add(head);
                card.Children.Add(new JsonForm(entry, field.Children ?? [], lookups));
                stack.Children.Add(new Border
                {
                    Child = card,
                    BorderBrush = Brush("MimiLineBrush"),
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(10),
                    Padding = new Thickness(12, 8, 12, 10),
                    Background = Brush("MimiRaisedBrush"),
                });
            }
            if (list.Count == 0) stack.Children.Add(Caption("ยังไม่มี — กด \"+ เพิ่ม\""));
            stack.Children.Add(Small("+ เพิ่ม", $"เพิ่ม {field.Label}", () =>
            {
                var list = List();
                list.Add(field.NewRow?.Invoke(list) ?? new JsonObject());
                Paint();
            }));
        }
        Paint();
        return stack;
    }

    /// <summary>Who sees it: every agent (<c>"*"</c>) or only the agents ticked (a list; empty = nobody).</summary>
    private FrameworkElement Audience(FieldSpec field)
    {
        var panel = new StackPanel { Spacing = 4 };
        var everyone = new RadioButton { Content = "agent ทุกตัวเห็น", GroupName = $"aud{GetHashCode()}{field.Path}" };
        var some = new RadioButton { Content = "เฉพาะ agent ที่เลือก", GroupName = everyone.GroupName };
        var picks = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, Margin = new Thickness(26, 0, 0, 0) };
        void Paint()
        {
            var current = Get(field.Path);
            var all = current is null || current is JsonValue star && star.TryGetValue<string>(out var text) && text == "*";
            everyone.IsChecked = all;
            some.IsChecked = !all;
            picks.Children.Clear();
            picks.Visibility = all ? Visibility.Collapsed : Visibility.Visible;
            if (all) return;
            var chosen = (current as JsonArray)?.Select(Show).ToHashSet() ?? [];
            foreach (var (value, label) in lookups.Get("agents"))
            {
                var box = new CheckBox { Content = label, IsChecked = chosen.Contains(value), MinWidth = 0 };
                box.Click += (_, _) =>
                {
                    if (box.IsChecked == true) chosen.Add(value);
                    else chosen.Remove(value);
                    Set(field.Path, new JsonArray(chosen.Select(name => (JsonNode?)JsonValue.Create(name)).ToArray()));
                };
                picks.Children.Add(box);
            }
            if (picks.Children.Count == 0) picks.Children.Add(Caption("ยังไม่มี agent"));
        }
        everyone.Checked += (_, _) =>
        {
            if (Get(field.Path) is JsonValue) return;
            Set(field.Path, JsonValue.Create("*"));
            Paint();
        };
        some.Checked += (_, _) =>
        {
            if (Get(field.Path) is JsonArray) return;
            Set(field.Path, new JsonArray());
            Paint();
        };
        Paint();
        panel.Children.Add(everyone);
        panel.Children.Add(some);
        panel.Children.Add(new ScrollViewer { Content = picks, HorizontalScrollBarVisibility = ScrollBarVisibility.Auto, VerticalScrollBarVisibility = ScrollBarVisibility.Disabled, HorizontalScrollMode = ScrollMode.Enabled });
        return panel;
    }

    private FrameworkElement ReadOnly(FieldSpec field)
    {
        var text = Show(Get(field.Path));
        return new TextBlock
        {
            Text = text.Length == 0 ? "—" : text,
            IsTextSelectionEnabled = true,
            TextWrapping = TextWrapping.Wrap,
            FontSize = 12,
            Foreground = Brush("MimiInkBrush"),
            FontFamily = new FontFamily(text.StartsWith('{') || text.StartsWith('[') ? "Cascadia Mono, Consolas" : "Segoe UI Variable Text, Segoe UI"),
            MaxLines = 40,
        };
    }
}
