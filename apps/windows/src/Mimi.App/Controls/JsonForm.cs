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
/// </summary>
public sealed class JsonForm : StackPanel
{
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    private readonly JsonObject item;
    private readonly Lookups lookups;
    private readonly List<string> problems = [];

    private readonly List<(FrameworkElement Element, FieldSpec Field)> conditional = [];

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
    }

    // ---------- controls ----------

    private static Brush Brush(string key) => (Brush)Application.Current.Resources[key];

    private static TextBlock Caption(string text) => new() { Text = text, FontSize = 12, Foreground = Brush("MimiMutedBrush"), TextWrapping = TextWrapping.Wrap };

    private FrameworkElement Build(FieldSpec field)
    {
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
            _ => field.OptionsFrom is not null || field.Options is not null ? Choice(field) : Text(field, multiline: false),
        });
        if (field.Hint is { Length: > 0 } hint) box.Children.Add(Caption(hint));
        return box;
    }

    private FrameworkElement Text(FieldSpec field, bool multiline)
    {
        var box = new TextBox { Text = Show(Get(field.Path)), IsSpellCheckEnabled = false, AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, field.Label);
        if (multiline)
        {
            box.MinHeight = 90;
            box.MaxHeight = 320;
            ScrollViewer.SetVerticalScrollBarVisibility(box, ScrollBarVisibility.Auto);
        }
        box.TextChanged += (_, _) => Set(field.Path, JsonValue.Create(box.Text));
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
        var box = new TextBox { Text = string.Join("\r", lines), AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 60, MaxHeight = 220, IsSpellCheckEnabled = false };
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
            Text = current is null ? "" : current.ToJsonString(Pretty),
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            FontFamily = new FontFamily("Cascadia Mono, Consolas"),
            FontSize = 12,
            MinHeight = 70,
            MaxHeight = 360,
            IsSpellCheckEnabled = false,
        };
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
        var box = new PasswordBox { PlaceholderText = "••••••" };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, field.Label);
        box.PasswordChanged += (_, _) => Set(field.Path, box.Password.Length == 0 ? null : JsonValue.Create(box.Password));
        return box;
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
