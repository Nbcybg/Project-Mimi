using System.Runtime.InteropServices.WindowsRuntime;
using Microsoft.UI.Xaml.Media.Imaging;
using Mimi.Core.Net;
using Windows.Storage.Streams;

namespace Mimi.App.Services;

/// <summary>
/// Pictures that need the token (agent avatars, images in the chat): fetched with the Bearer header and
/// kept in memory for the session (auth-and-session.md 5). The path with its <c>?v=</c> stamp is the key.
/// </summary>
internal sealed class Images(Func<MimiApi> api)
{
    private readonly Dictionary<string, Task<BitmapImage?>> cache = [];

    public Task<BitmapImage?> Get(string path)
    {
        if (!cache.TryGetValue(path, out var image))
        {
            image = Load(path);
            cache[path] = image;
        }
        return image;
    }

    private async Task<BitmapImage?> Load(string path)
    {
        try
        {
            var bytes = await api().Bytes(path);
            using var memory = new InMemoryRandomAccessStream();
            await memory.WriteAsync(bytes.AsBuffer());
            memory.Seek(0);
            var bitmap = new BitmapImage();
            await bitmap.SetSourceAsync(memory);
            return bitmap;
        }
        catch (Exception)
        {
            cache.Remove(path);
            return null;
        }
    }

    public void Clear() => cache.Clear();
}
