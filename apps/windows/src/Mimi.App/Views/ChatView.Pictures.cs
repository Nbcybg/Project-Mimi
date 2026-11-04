using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;
using Windows.Storage;
using Windows.Storage.Streams;

namespace Mimi.App.Views;

/// <summary>
/// Files into the composer (app.js stageFiles): anything else goes up at once, pictures first open a review
/// like the web's photo sheet (openPhotoReview) — each one can be left out and given a caption, which the
/// agent reads with the picture (X-Mimi-Caption).
/// </summary>
public sealed partial class ChatView
{
    private const long MaxAttachmentBytes = 25 * 1024 * 1024;

    private sealed record Picture(string Name, string Mime, byte[] Bytes);

    private static bool IsPicture(string mime) => mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase);

    private async Task UploadAll(IReadOnlyList<StorageFile> files)
    {
        var pictures = new List<Picture>();
        foreach (var file in files)
        {
            var properties = await file.GetBasicPropertiesAsync();
            if (properties.Size > MaxAttachmentBytes)
            {
                ViewModel.Error = $"{file.Name} ใหญ่เกิน 25 MB";
                continue;
            }
            var mime = string.IsNullOrEmpty(file.ContentType) ? "application/octet-stream" : file.ContentType;
            if (IsPicture(mime))
            {
                var buffer = await FileIO.ReadBufferAsync(file);
                pictures.Add(new Picture(file.Name, mime, buffer.ToArray()));
                continue;
            }
            await using var stream = await file.OpenStreamForReadAsync();
            await ViewModel.Attach(stream, file.Name, mime);
        }
        if (pictures.Count > 0) await SendPictures(pictures);
    }

    /// <summary>A picture made in this app (the Workspace's drawing): the same review, the caption box focused.</summary>
    internal Task SendPicture(byte[] png, string name) => SendPictures([new Picture(name, "image/png", png)]);

    /// <summary>The review: a preview, a tick and a caption per picture; "แนบ" uploads the ticked ones.</summary>
    private async Task SendPictures(IReadOnlyList<Picture> pictures)
    {
        var list = new StackPanel { Spacing = 10 };
        var rows = new List<(Picture Picture, CheckBox Keep, TextBox Caption)>();
        foreach (var picture in pictures)
        {
            var preview = new Image { MaxHeight = pictures.Count == 1 ? 320 : 140, Stretch = Microsoft.UI.Xaml.Media.Stretch.Uniform, HorizontalAlignment = HorizontalAlignment.Left };
            try
            {
                using var memory = new InMemoryRandomAccessStream();
                await memory.WriteAsync(picture.Bytes.AsBuffer());
                memory.Seek(0);
                var bitmap = new BitmapImage();
                await bitmap.SetSourceAsync(memory);
                preview.Source = bitmap;
            }
            catch (Exception)
            {
                // a picture Windows cannot draw (HEIC without the extension): the name still shows
            }
            var keep = new CheckBox { Content = picture.Name, IsChecked = true };
            var caption = new TextBox { PlaceholderText = "คำบรรยาย (ไม่บังคับ)", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MaxLength = 1000 };
            AutomationProperties.SetName(caption, $"คำบรรยายของ {picture.Name}");
            rows.Add((picture, keep, caption));
            list.Children.Add(new StackPanel { Spacing = 4, Children = { preview, keep, caption } });
        }
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = pictures.Count == 1 ? "ส่งรูป" : $"ส่งรูป {pictures.Count} รูป",
            Content = new ScrollViewer { Content = list, MaxHeight = 520 },
            PrimaryButtonText = "แนบ",
            CloseButtonText = "ยกเลิก",
            DefaultButton = ContentDialogButton.Primary,
        };
        if (pictures.Count == 1) dialog.Opened += (_, _) => rows[0].Caption.Focus(FocusState.Programmatic);
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        foreach (var (picture, keep, caption) in rows)
        {
            if (keep.IsChecked != true) continue;
            using var stream = new MemoryStream(picture.Bytes, writable: false);
            await ViewModel.Attach(stream, picture.Name, picture.Mime, caption.Text);
        }
    }
}
