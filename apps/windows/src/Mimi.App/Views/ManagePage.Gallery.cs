using System.Runtime.InteropServices.WindowsRuntime;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Mimi.App.Controls;
using Mimi.App.Services;
using Mimi.Core.Hub;
using Mimi.Core.Protocol;
using Windows.Graphics.Imaging;
using Windows.Storage.Pickers;
using Windows.Storage.Streams;

namespace Mimi.App.Views;

public sealed partial class ManagePage
{
    private const int GalleryPage = 48;

    /// <summary>
    /// The agent's situation gallery (feature-gallery.js manager, #44): search by name / tag / description, pages of
    /// 48, many pictures at once (each gets a 256 px preview), and for the chosen one its name, tags and description
    /// (what the agent reads to pick it), "แสดงในแชต" and delete.
    /// </summary>
    private async Task Gallery(EntityList list, JsonElement agent)
    {
        var name = agent.S("name");
        var e = Uri.EscapeDataString(name);
        var situation = agent.S("status.situation");
        var query = "";
        var offset = 0;
        var total = 0;
        string? chosen = null;
        List<JsonElement> items = [];
        var thumbs = new Dictionary<string, BitmapImage?>();

        var search = new TextBox { PlaceholderText = "ค้นหาจากชื่อ แท็ก คำอธิบาย", IsSpellCheckEnabled = false };
        AutomationProperties.SetName(search, "ค้นหารูป");
        var info = Ui.Hint("กำลังโหลด…");
        AutomationProperties.SetAutomationId(info, "GalleryInfo");
        var grid = new GridView { SelectionMode = ListViewSelectionMode.Single, MaxHeight = 330, IsItemClickEnabled = false };
        AutomationProperties.SetAutomationId(grid, "GalleryGrid");
        var pages = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        var detail = new ContentControl { HorizontalContentAlignment = HorizontalAlignment.Stretch };

        async Task<BitmapImage?> Picture(string path)
        {
            try
            {
                var bytes = await session.Api.Bytes(path);
                using var memory = new InMemoryRandomAccessStream();
                await memory.WriteAsync(bytes.AsBuffer());
                memory.Seek(0);
                var bitmap = new BitmapImage();
                await bitmap.SetSourceAsync(memory);
                return bitmap;
            }
            catch (Exception)
            {
                return null;
            }
        }

        async Task Load()
        {
            info.Text = "กำลังโหลด…";
            try
            {
                var (asked, from) = (query, offset);
                var reply = await session.Ask(ClientFrames.Json("gallery-list", new JsonObject { ["agent"] = name, ["query"] = query, ["offset"] = offset, ["limit"] = GalleryPage }),
                    "gallery", "gallery-list", answer => answer.S("agent") == name && answer.S("query") == asked && answer.At("offset").ValueKind == JsonValueKind.Number && answer.At("offset").GetInt32() == from);
                if (asked != query || from != offset) return;
                items = reply.A("items").Select(item => item.Clone()).ToList();
                total = reply.At("total").ValueKind == JsonValueKind.Number ? reply.At("total").GetInt32() : items.Count;
                Draw();
            }
            catch (Exception error) when (error is TimeoutException or InvalidOperationException)
            {
                info.Text = $"โหลดแกลเลอรีไม่ได้: {error.Message}";
            }
        }

        void Draw()
        {
            info.Text = $"{total:N0} รูป{(query.Length > 0 ? $" ที่ตรงกับ \"{query}\"" : "")}";
            grid.Items.Clear();
            if (items.Count == 0) info.Text += query.Length > 0 ? " — ไม่พบรูปที่ตรงกัน" : " — ยังไม่มีรูป เพิ่มรูปเพื่อให้ agent เลือกใช้ตามสถานการณ์";
            foreach (var item in items)
            {
                var id = item.S("id");
                var image = new Image { Width = 112, Height = 84, Stretch = Stretch.UniformToFill };
                var tile = new StackPanel { Width = 116, Spacing = 2, Tag = id };
                tile.Children.Add(new Border { Child = image, CornerRadius = new CornerRadius(6), Background = Theme.Brush("Raised") });
                tile.Children.Add(new TextBlock { Text = item.S("title"), FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis, Foreground = Theme.Brush(id == situation ? "Accent" : "Ink2") });
                AutomationProperties.SetName(tile, item.S("title"));
                ToolTipService.SetToolTip(tile, item.S("title"));
                grid.Items.Add(tile);
                if (id == chosen) grid.SelectedItem = tile;
                _ = Thumb();

                async Task Thumb()
                {
                    var key = $"{id}|{item.B("thumb")}";
                    if (!thumbs.TryGetValue(key, out var bitmap))
                    {
                        bitmap = await Picture($"/api/gallery/{e}/{Uri.EscapeDataString(id)}/thumb?t={(item.B("thumb") ? 1 : 0)}");
                        thumbs[key] = bitmap;
                    }
                    image.Source = bitmap;
                }
            }
            pages.Children.Clear();
            if (total > GalleryPage)
            {
                pages.Children.Add(Ui.Button("‹ ก่อนหน้า", () =>
                {
                    if (offset == 0) return;
                    offset = Math.Max(0, offset - GalleryPage);
                    _ = Load();
                }, "ghost"));
                pages.Children.Add(Ui.Hint($"{(total == 0 ? 0 : offset + 1)}–{Math.Min(total, offset + GalleryPage)} จาก {total}"));
                pages.Children.Add(Ui.Button("ถัดไป ›", () =>
                {
                    if (offset + GalleryPage >= total) return;
                    offset += GalleryPage;
                    _ = Load();
                }, "ghost"));
            }
            ShowDetail();
        }

        void ShowDetail()
        {
            var item = items.FirstOrDefault(entry => entry.S("id") == chosen);
            if (item.ValueKind != JsonValueKind.Object)
            {
                detail.Content = null;
                return;
            }
            var id = item.S("id");
            var preview = new Image { MaxHeight = 220, MaxWidth = 300, Stretch = Stretch.Uniform };
            _ = Show();
            async Task Show() => preview.Source = await Picture($"/api/gallery/{e}/{Uri.EscapeDataString(id)}");
            var title = new TextBox { Text = item.S("title"), PlaceholderText = "ชื่อภาพ" };
            var tags = new TextBox { Text = string.Join(", ", item.Strings("tags")), PlaceholderText = "แท็ก คั่นด้วย , เช่น ฝน, คาเฟ่" };
            var description = new TextBox
            {
                PlaceholderText = "คำอธิบาย (ไม่ใส่ก็ได้ — ใช้ค้นหา/แสดงในแกลเลอรี และ agent เห็นในภาพสถานการณ์)",
                AcceptsReturn = true,
                TextWrapping = TextWrapping.Wrap,
                MinHeight = 70,
            };
            description.Text = item.S("description");
            var onShow = situation == id;
            var form = new StackPanel { Spacing = 8 };
            form.Children.Add(Ui.Title($"{id} · {(item.S("source") == "agent" ? "agent เพิ่มเอง" : "ผู้ใช้เพิ่ม")}", 13));
            form.Children.Add(Ui.Field("ชื่อ", title));
            form.Children.Add(Ui.Field("แท็ก", tags));
            form.Children.Add(Ui.Field("คำอธิบาย", description));
            form.Children.Add(Ui.Row(6,
                Ui.Button("บันทึก", () =>
                {
                    session.Send(ClientFrames.Json("gallery-update", new JsonObject
                    {
                        ["agent"] = name,
                        ["id"] = id,
                        ["title"] = title.Text,
                        ["tags"] = new JsonArray(tags.Text.Split([',', '،', '、'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(tag => (JsonNode)JsonValue.Create(tag)!).ToArray()),
                        ["description"] = description.Text,
                    }));
                    info.Text = "บันทึกแล้ว";
                }, "pri", "SaveGalleryItem"),
                Ui.Button(onShow ? "เอาออกจากแชต" : "แสดงในแชต", () =>
                {
                    situation = onShow ? "" : id;
                    session.Send(ClientFrames.Json("status-set", new JsonObject { ["agent"] = name, ["key"] = "situation", ["value"] = situation }));
                    Draw();
                }),
                Ui.Button("ลบภาพ", () =>
                {
                    chosen = null;
                    session.Send(ClientFrames.Json("gallery-delete", new JsonObject { ["agent"] = name, ["id"] = id }));
                }, "ghost")));
            var row = new Grid { ColumnSpacing = 14 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.Children.Add(new Border { Child = preview, CornerRadius = new CornerRadius(8), VerticalAlignment = VerticalAlignment.Top });
            Grid.SetColumn(form, 1);
            row.Children.Add(form);
            detail.Content = Ui.Card(row);
        }

        async Task Upload()
        {
            var picker = new FileOpenPicker();
            WinRT.Interop.InitializeWithWindow.Initialize(picker, window());
            foreach (var extension in new[] { ".png", ".jpg", ".jpeg", ".webp", ".gif" }) picker.FileTypeFilter.Add(extension);
            var files = await picker.PickMultipleFilesAsync();
            if (files is null || files.Count == 0) return;
            var failed = 0;
            for (var i = 0; i < files.Count; i++)
            {
                var file = files[i];
                info.Text = $"กำลังอัปโหลด {i + 1}/{files.Count}";
                try
                {
                    var bytes = await File.ReadAllBytesAsync(file.Path);
                    var type = file.ContentType is { Length: > 0 } known ? known : "image/png";
                    using var body = new MemoryStream(bytes);
                    var added = await session.Api.SendBody(HttpMethod.Post, $"/api/gallery/{e}?title={Uri.EscapeDataString(Path.GetFileNameWithoutExtension(file.Name))}", body, type);
                    if (added.ValueKind == JsonValueKind.Object && added.S("id") is { Length: > 0 } id && await Preview(bytes) is { } thumb)
                    {
                        using var small = new MemoryStream(thumb);
                        await session.Api.SendBody(HttpMethod.Post, $"/api/gallery/{e}/{Uri.EscapeDataString(id)}/thumb", small, "image/jpeg");
                    }
                }
                catch (Exception error) when (error is HttpRequestException or IOException or InvalidOperationException or TaskCanceledException)
                {
                    failed++;
                }
            }
            offset = 0;
            await Load();
            info.Text = $"เพิ่มรูปแล้ว {files.Count - failed} รูป{(failed > 0 ? $" · ไม่สำเร็จ {failed}" : "")}";
        }

        void OnRaw(string type, JsonElement json)
        {
            if (type == "gallery-changed" && json.S("agent") == name) _ = Load();
            if (type == "agents" && json.A("agents").FirstOrDefault(entry => entry.S("name") == name) is { ValueKind: JsonValueKind.Object } fresh)
            {
                situation = fresh.S("status.situation");
            }
        }

        var timer = 0;
        search.TextChanged += async (_, _) =>
        {
            var mine = ++timer;
            await Task.Delay(300);
            if (mine != timer) return;
            query = search.Text.Trim();
            offset = 0;
            await Load();
        };
        grid.SelectionChanged += (_, _) =>
        {
            chosen = (grid.SelectedItem as FrameworkElement)?.Tag as string;
            ShowDetail();
        };

        var head = new Grid { ColumnSpacing = 8 };
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        head.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        head.Children.Add(search);
        var add = Ui.Button("เพิ่มรูป (เลือกได้หลายไฟล์)", () => _ = Upload(), id: "GalleryUpload");
        Grid.SetColumn(add, 1);
        head.Children.Add(add);
        var body = new StackPanel { Spacing = 8, Width = 640 };
        body.Children.Add(head);
        body.Children.Add(info);
        body.Children.Add(grid);
        body.Children.Add(pages);
        body.Children.Add(detail);

        session.Raw += OnRaw;
        _ = Load();
        try
        {
            await ShowDialog(new ContentDialog
            {
                Title = $"แกลเลอรีของ {(agent.S("displayName") is { Length: > 0 } shown ? shown : name)}",
                Content = new ScrollViewer { Content = body, MaxHeight = 640, VerticalScrollBarVisibility = ScrollBarVisibility.Auto },
                CloseButtonText = "ปิด",
            });
        }
        finally
        {
            session.Raw -= OnRaw;
            list.Refresh();
        }
    }

    /// <summary>A JPEG preview at most 256 px on the long side (the web's makeThumb), or null when the picture cannot be read.</summary>
    private static async Task<byte[]?> Preview(byte[] picture)
    {
        try
        {
            using var input = new InMemoryRandomAccessStream();
            await input.WriteAsync(picture.AsBuffer());
            input.Seek(0);
            var decoder = await BitmapDecoder.CreateAsync(input);
            var scale = Math.Min(1.0, 256.0 / Math.Max(decoder.PixelWidth, decoder.PixelHeight));
            using var pixels = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore);
            using var output = new InMemoryRandomAccessStream();
            var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, output);
            encoder.SetSoftwareBitmap(pixels);
            encoder.BitmapTransform.ScaledWidth = (uint)Math.Max(1, Math.Round(decoder.PixelWidth * scale));
            encoder.BitmapTransform.ScaledHeight = (uint)Math.Max(1, Math.Round(decoder.PixelHeight * scale));
            encoder.BitmapTransform.InterpolationMode = BitmapInterpolationMode.Fant;
            await encoder.FlushAsync();
            var bytes = new byte[output.Size];
            output.Seek(0);
            await output.ReadAsync(bytes.AsBuffer(), (uint)bytes.Length, InputStreamOptions.None);
            return bytes;
        }
        catch (Exception)
        {
            return null;
        }
    }
}
