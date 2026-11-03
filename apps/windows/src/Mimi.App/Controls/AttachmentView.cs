using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Mimi.Core.ViewModels;

namespace Mimi.App.Controls;

/// <summary>
/// A file in the chat (media.md 2.2): a picture shows inline (loaded with the token, click = full size in
/// the default viewer), anything else is a button that downloads it to the cache and opens it with its app.
/// A file removed after the retention period shows its name and caption only.
/// </summary>
public sealed class AttachmentView : ContentControl
{
    public static readonly DependencyProperty FileProperty =
        DependencyProperty.Register(nameof(File), typeof(FileItem), typeof(AttachmentView), new PropertyMetadata(null, (d, _) => ((AttachmentView)d).Build()));

    public FileItem? File
    {
        get => (FileItem?)GetValue(FileProperty);
        set => SetValue(FileProperty, value);
    }

    private static Brush Brush(string key) => (Brush)Application.Current.Resources[key];

    private async void Build()
    {
        var file = File;
        if (file is null)
        {
            Content = null;
            return;
        }
        if (file.Gone)
        {
            Content = new TextBlock { Text = $"🗑 {file.Name} (ไฟล์ถูกลบตามระยะเก็บแล้ว) {file.Caption}", Foreground = Brush("MimiMutedBrush"), FontSize = 12, TextWrapping = TextWrapping.Wrap };
            return;
        }
        var open = new Button { Padding = new Thickness(8, 4, 8, 4), HorizontalAlignment = HorizontalAlignment.Left };
        open.Click += async (_, _) => await (App.Instance?.OpenFile(file) ?? Task.CompletedTask);
        var isImage = file.Kind == "image" && file.Mime is "image/png" or "image/jpeg" or "image/webp" or "image/gif";
        if (isImage && App.Instance?.Images is { } images)
        {
            var picture = new Image { MaxHeight = 260, MaxWidth = 360, Stretch = Stretch.Uniform };
            open.Padding = new Thickness(0);
            open.Content = picture;
            Content = open;
            var bitmap = await images.Get(file.Path);
            if (bitmap is not null && File == file) picture.Source = bitmap;
            else if (File == file) open.Content = new TextBlock { Text = $"🖼 {file.Name}" };
            return;
        }
        var icon = file.Kind switch { "audio" => "🎵", "video" => "🎬", "image" => "🖼", _ => "📄" };
        var label = new StackPanel { Spacing = 2 };
        label.Children.Add(new TextBlock { Text = $"{icon} {file.Name}", FontSize = 13, TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 320 });
        if (file.Caption.Length > 0) label.Children.Add(new TextBlock { Text = file.Caption, FontSize = 11, Foreground = Brush("MimiMutedBrush"), TextWrapping = TextWrapping.Wrap, MaxLines = 3, MaxWidth = 320 });
        open.Content = label;
        Content = open;
    }
}
