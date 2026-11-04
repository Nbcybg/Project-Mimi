using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Mimi.Core.Chat;
using Windows.ApplicationModel.DataTransfer;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Storage.Streams;
using Windows.System;

namespace Mimi.App.Views;

/// <summary>
/// What the web's composer does besides typing (app.js): the "@…" members list of a group, a picture or
/// file pasted from the clipboard goes in as an attachment, and Esc on an empty box stops the reply.
/// </summary>
public sealed partial class ChatView
{
    private StackPanel? mentionList;
    private Border? mentionBox;

    /// <summary>Called once from the constructor, after InitializeComponent.</summary>
    private void SetUpComposer()
    {
        mentionList = new StackPanel { Spacing = 1 };
        mentionBox = new Border
        {
            Child = mentionList,
            Background = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["MimiRaisedBrush"],
            BorderBrush = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["MimiLineBrush"],
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(4),
            Visibility = Visibility.Collapsed,
        };
        AutomationProperties.SetAutomationId(mentionBox, "MentionList");
        if (ComposerBox.Parent is Panel composer) composer.Children.Insert(0, mentionBox);
        Composer.TextChanged += (_, _) => RenderMention();
        Composer.SelectionChanged += (_, _) => RenderMention();
        Composer.LostFocus += (_, _) => DispatcherQueue.TryEnqueue(() =>
        {
            // A click on a name moves the focus there first; the list goes once the focus is elsewhere.
            if (FocusManager.GetFocusedElement(XamlRoot) is not Button { Tag: "mention" }) HideMention();
        });
        Composer.Paste += OnComposerPaste;
    }

    private bool MentionShown => mentionBox?.Visibility == Visibility.Visible;

    private void HideMention()
    {
        if (mentionBox is not null) mentionBox.Visibility = Visibility.Collapsed;
    }

    private void RenderMention()
    {
        if (mentionList is null || mentionBox is null) return;
        var options = ViewModel.MentionOptions(Composer.Text, Composer.SelectionStart);
        mentionList.Children.Clear();
        foreach (var (name, shown) in options)
        {
            var row = new Button
            {
                Tag = "mention",
                HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Left,
                Background = mentionList.Children.Count == 0 ? (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["MimiAccentSoftBrush"] : null,
                BorderThickness = new Thickness(0),
                Padding = new Thickness(8, 4, 8, 4),
                Content = new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    Spacing = 8,
                    Children =
                    {
                        new TextBlock { Text = shown, Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["MimiInkBrush"] },
                        new TextBlock { Text = $"@{name}", FontSize = 12, Foreground = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["MimiFaintBrush"], VerticalAlignment = VerticalAlignment.Center },
                    },
                },
            };
            AutomationProperties.SetName(row, $"{shown} @{name}");
            row.Click += (_, _) => PickMention(name);
            mentionList.Children.Add(row);
        }
        mentionBox.Visibility = options.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
    }

    private void PickMention(string name)
    {
        if (Mentions.At(Composer.Text, Composer.SelectionStart) is not { } typing) return;
        var (text, caret) = Mentions.Apply(Composer.Text, Composer.SelectionStart, typing.Start, name);
        Composer.Text = text;
        Composer.Select(caret, 0);
        HideMention();
        Composer.Focus(FocusState.Programmatic);
    }

    /// <summary>Keys the composer handles before the text box: Tab/Enter pick the first name of the list, Esc closes it or stops the reply.</summary>
    private bool ComposerKey(KeyRoutedEventArgs e)
    {
        if (MentionShown && e.Key is VirtualKey.Tab or VirtualKey.Enter && ViewModel.MentionOptions(Composer.Text, Composer.SelectionStart) is [var first, ..])
        {
            PickMention(first.Name);
            return true;
        }
        if (e.Key != VirtualKey.Escape) return false;
        if (MentionShown)
        {
            HideMention();
            return true;
        }
        if (Composer.Text.Length == 0 && ViewModel.Busy)
        {
            ViewModel.Stop();
            return true;
        }
        return false;
    }

    /// <summary>Ctrl+V of files or a picture (a screenshot, a copied image) attaches them instead of pasting text.</summary>
    private async void OnComposerPaste(object sender, TextControlPasteEventArgs e)
    {
        var content = Clipboard.GetContent();
        if (content.Contains(StandardDataFormats.StorageItems))
        {
            e.Handled = true;
            await UploadAll((await content.GetStorageItemsAsync()).OfType<StorageFile>().ToList());
            return;
        }
        if (!content.Contains(StandardDataFormats.Bitmap) || content.Contains(StandardDataFormats.Text)) return;
        e.Handled = true;
        try
        {
            var reference = await content.GetBitmapAsync();
            using var source = await reference.OpenReadAsync();
            var decoder = await BitmapDecoder.CreateAsync(source);
            using var pixels = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
            using var png = new InMemoryRandomAccessStream();
            var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, png);
            encoder.SetSoftwareBitmap(pixels);
            await encoder.FlushAsync();
            var bytes = new byte[png.Size];
            png.Seek(0);
            await png.ReadAsync(bytes.AsBuffer(), (uint)bytes.Length, InputStreamOptions.None);
            await SendPictures([new Picture($"pasted-{DateTime.Now:yyyyMMdd-HHmmss}.png", "image/png", bytes)]);
        }
        catch (Exception error)
        {
            ViewModel.Error = $"วางรูปไม่ได้: {error.Message}";
        }
    }
}
