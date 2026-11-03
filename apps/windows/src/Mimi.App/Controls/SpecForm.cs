using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Mimi.App.Services;
using Mimi.Core.Hub;

namespace Mimi.App.Controls;

/// <summary>
/// A form from the field specs the server sends with the node types and the trigger pool
/// (<c>NodeTypeField</c>: key, label, type, options, placeholder, description, required) — so every node and
/// trigger gets its own fields, the way the web's workflow editor draws them (feature-workflows.js fieldInput).
/// Conditions get rows (left / operator / right) instead of JSON.
/// </summary>
internal sealed partial class SpecForm : StackPanel
{
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
    public static readonly string[] Operators = ["equals", "not_equals", "contains", "not_contains", "starts_with", "ends_with", "regex", "gt", "lt", "gte", "lte", "is_empty", "is_not_empty", "is_true", "is_false"];

    private readonly JsonObject config;
    private readonly Lookups lookups;
    private readonly HashSet<string> problems = [];

    public SpecForm(JsonObject config, IEnumerable<JsonElement> fields, Lookups lookups)
    {
        this.config = config;
        this.lookups = lookups;
        Spacing = 10;
        foreach (var field in fields) Children.Add(Field(field));
        if (Children.Count == 0) Children.Add(Ui.Hint("node นี้ไม่มีค่าที่ต้องตั้ง", "Faint"));
    }

    /// <summary>JSON fields that do not parse; saving should wait.</summary>
    public IReadOnlyCollection<string> Problems => problems;

    /// <summary>Something was edited (the canvas redraws a title, the editor marks the draft unsaved).</summary>
    public event Action? Edited;

    private void Set(string key, JsonNode? value)
    {
        if (value is null) config.Remove(key);
        else config[key] = value;
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
        var label = field.S("label") is { Length: > 0 } shown ? shown : key;
        if (field.B("required")) label += " *";
        var type = field.S("type");
        var hint = field.S("description");
        FrameworkElement control;
        if (key == "conditions") control = Conditions(key);
        else if (field.A("options").Any()) control = Choice(key, OptionsOf(field), label);
        else if (key is "agent" && type is "string") control = Choice(key, lookups.Get("agents"), label);
        else if (key is "model" && type is "string") control = Choice(key, lookups.Get("models"), label);
        else
        {
            control = type switch
            {
                "boolean" => Toggle(key, label),
                "number" => Number(key, label, field.S("placeholder")),
                "json" => Json(key, label, field.S("placeholder")),
                "text" => Text(key, label, field.S("placeholder"), multiline: true),
                _ => Text(key, label, field.S("placeholder"), multiline: false, expression: type == "expression"),
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

    private string Current(string key) => config[key] switch
    {
        null => "",
        JsonValue value when value.TryGetValue<string>(out var text) => text,
        JsonValue value => value.ToJsonString(),
        var node => node.ToJsonString(Pretty),
    };

    private FrameworkElement Text(string key, string label, string placeholder, bool multiline, bool expression = false)
    {
        var box = new TextBox
        {
            Text = Current(key),
            PlaceholderText = placeholder,
            AcceptsReturn = multiline,
            TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap,
            IsSpellCheckEnabled = false,
            MinHeight = multiline ? 80 : 0,
            MaxHeight = multiline ? 260 : double.PositiveInfinity,
        };
        if (expression) box.FontFamily = new FontFamily("Cascadia Mono, Consolas");
        AutomationProperties.SetName(box, label);
        box.TextChanged += (_, _) => Set(key, box.Text.Length == 0 ? null : JsonValue.Create(box.Text));
        return box;
    }

    private FrameworkElement Number(string key, string label, string placeholder)
    {
        var box = new NumberBox
        {
            Value = config[key] is JsonValue value && value.TryGetValue<double>(out var number) ? number : double.NaN,
            PlaceholderText = placeholder,
            SpinButtonPlacementMode = NumberBoxSpinButtonPlacementMode.Hidden,
        };
        AutomationProperties.SetName(box, label);
        box.ValueChanged += (_, args) => Set(key, double.IsNaN(args.NewValue) ? null : args.NewValue == Math.Floor(args.NewValue) ? JsonValue.Create((long)args.NewValue) : JsonValue.Create(args.NewValue));
        return box;
    }

    private FrameworkElement Toggle(string key, string label)
    {
        var box = new CheckBox { Content = label, IsChecked = config[key] is JsonValue value && value.GetValueKind() == JsonValueKind.True };
        box.Click += (_, _) => Set(key, JsonValue.Create(box.IsChecked == true));
        return box;
    }

    private FrameworkElement Choice(string key, IReadOnlyList<(string Value, string Label)> options, string label)
    {
        var current = Current(key);
        var box = new ComboBox { IsEditable = true, HorizontalAlignment = HorizontalAlignment.Stretch, PlaceholderText = "(ว่าง)" };
        AutomationProperties.SetName(box, label);
        var list = options.ToList();
        if (!list.Any(option => option.Value.Length == 0)) list.Insert(0, ("", "(ว่าง)"));
        if (current.Length > 0 && !list.Any(option => option.Value == current)) list.Add((current, current));
        foreach (var (value, text) in list) box.Items.Add(new ComboBoxItem { Content = text, Tag = value });
        box.SelectedItem = box.Items.OfType<ComboBoxItem>().FirstOrDefault(item => (string)item.Tag == current);
        box.SelectionChanged += (_, _) =>
        {
            if (box.SelectedItem is ComboBoxItem chosen) Set(key, ((string)chosen.Tag).Length == 0 ? null : JsonValue.Create((string)chosen.Tag));
        };
        box.TextSubmitted += (_, args) =>
        {
            var typed = args.Text.Trim();
            if (box.Items.OfType<ComboBoxItem>().Any(item => (string)item.Content == typed || (string)item.Tag == typed)) return;
            Set(key, typed.Length == 0 ? null : JsonValue.Create(typed));
            var entry = new ComboBoxItem { Content = typed, Tag = typed };
            box.Items.Add(entry);
            box.SelectedItem = entry;
            args.Handled = true;
        };
        return box;
    }

    private FrameworkElement Json(string key, string label, string placeholder)
    {
        var box = new TextBox
        {
            Text = config[key] is { } node ? node.ToJsonString(Pretty) : "",
            PlaceholderText = placeholder,
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            FontFamily = new FontFamily("Cascadia Mono, Consolas"),
            FontSize = 12,
            MinHeight = 64,
            MaxHeight = 300,
            IsSpellCheckEnabled = false,
        };
        AutomationProperties.SetName(box, label);
        var problem = Ui.Hint("", "Bad");
        box.TextChanged += (_, _) =>
        {
            problems.Remove(key);
            problem.Text = "";
            if (box.Text.Trim().Length == 0)
            {
                Set(key, null);
                return;
            }
            try
            {
                Set(key, JsonNode.Parse(box.Text));
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
