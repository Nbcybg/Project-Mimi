"""Writes C# stubs for what the WinUI XAML compiler would generate (x:Name fields, InitializeComponent,
Bindings), so the app's C# can be type-checked on a machine without the Windows-only XAML compiler."""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

app = Path(sys.argv[1])
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
X = '{http://schemas.microsoft.com/winfx/2006/xaml}'
DEFAULT = 'http://schemas.microsoft.com/winfx/2006/xaml/presentation'


def ns_map(text):
    found = {}
    for prefix, uri in re.findall(r'xmlns(?::(\w+))?="([^"]+)"', text):
        found[uri] = prefix
    return found


def type_of(tag):
    uri, _, name = tag[1:].partition('}')
    if uri == DEFAULT:
        return 'global::Microsoft.UI.Xaml.Controls.' + name if name not in PRIMS else PRIMS[name]
    if uri.startswith('using:'):
        return 'global::' + uri[6:] + '.' + name
    return 'object'


PRIMS = {
    'Grid': 'global::Microsoft.UI.Xaml.Controls.Grid',
    'Border': 'global::Microsoft.UI.Xaml.Controls.Border',
    'Run': 'global::Microsoft.UI.Xaml.Documents.Run',
    'Hyperlink': 'global::Microsoft.UI.Xaml.Documents.Hyperlink',
    'Ellipse': 'global::Microsoft.UI.Xaml.Shapes.Ellipse',
    'Rectangle': 'global::Microsoft.UI.Xaml.Shapes.Rectangle',
    'Path': 'global::Microsoft.UI.Xaml.Shapes.Path',
    'ColumnDefinition': 'global::Microsoft.UI.Xaml.Controls.ColumnDefinition',
    'RowDefinition': 'global::Microsoft.UI.Xaml.Controls.RowDefinition',
    'SolidColorBrush': 'global::Microsoft.UI.Xaml.Media.SolidColorBrush',
    'ImageBrush': 'global::Microsoft.UI.Xaml.Media.ImageBrush',
    'ScaleTransform': 'global::Microsoft.UI.Xaml.Media.ScaleTransform',
    'TranslateTransform': 'global::Microsoft.UI.Xaml.Media.TranslateTransform',
    'CompositeTransform': 'global::Microsoft.UI.Xaml.Media.CompositeTransform',
    'Storyboard': 'global::Microsoft.UI.Xaml.Media.Animation.Storyboard',
    'MenuFlyout': 'global::Microsoft.UI.Xaml.Controls.MenuFlyout',
    'Flyout': 'global::Microsoft.UI.Xaml.Controls.Flyout',
    'MenuFlyoutItem': 'global::Microsoft.UI.Xaml.Controls.MenuFlyoutItem',
    'MenuFlyoutSubItem': 'global::Microsoft.UI.Xaml.Controls.MenuFlyoutSubItem',
    'ToggleMenuFlyoutItem': 'global::Microsoft.UI.Xaml.Controls.ToggleMenuFlyoutItem',
    'Popup': 'global::Microsoft.UI.Xaml.Controls.Primitives.Popup',
    'ToggleButton': 'global::Microsoft.UI.Xaml.Controls.Primitives.ToggleButton',
    'RepeatButton': 'global::Microsoft.UI.Xaml.Controls.Primitives.RepeatButton',
}

for xaml in sorted(list(app.glob('*.xaml')) + list(app.glob('Views/*.xaml'))):
    text = xaml.read_text(encoding='utf-8')
    root = ET.fromstring(text)
    cls = root.get(X + 'Class')
    if not cls:
        continue
    namespace, _, name = cls.rpartition('.')
    base = type_of(root.tag)
    if root.tag.endswith('}Application'):
        base = 'global::Microsoft.UI.Xaml.Application'
    elif root.tag.endswith('}Window'):
        base = 'global::Microsoft.UI.Xaml.Window'
    fields = []
    for element in root.iter():
        named = element.get(X + 'Name')
        if named and element is not root:
            fields.append(f'        internal {type_of(element.tag)} {named} = null!;')
    binds = 'x:Bind' in text
    lines = [
        '#nullable enable',
        f'namespace {namespace}',
        '{',
        f'    partial class {name} : {base}',
        '    {',
        *fields,
        '        public void InitializeComponent() { }',
    ]
    if binds:
        lines += [
            '        private sealed class StubBindings { public void Update() { } public void StopTracking() { } public void Initialize() { } }',
            '        private StubBindings Bindings = new();',
        ]
    lines += ['    }', '}', '']
    (out / f'{name}.g.cs').write_text('\n'.join(lines), encoding='utf-8')
    print(xaml.name, len(fields), 'names')
