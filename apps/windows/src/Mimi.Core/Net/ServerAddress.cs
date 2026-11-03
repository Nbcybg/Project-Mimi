namespace Mimi.Core.Net;

/// <summary>Checks a server address the way the Electron app did (packages/desktop/remote-lib.cjs normalizeServerUrl).</summary>
public static class ServerAddress
{
    private static readonly HashSet<string> LocalHosts = new(StringComparer.OrdinalIgnoreCase) { "localhost", "127.0.0.1", "[::1]", "::1" };

    public static bool IsLocal(Uri url) => LocalHosts.Contains(url.Host) || url.Host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Only an origin; https, except a server on this computer. A bare host gets https://.
    /// Throws <see cref="FormatException"/> with a message for the person.
    /// </summary>
    public static string Normalize(string raw)
    {
        var text = (raw ?? "").Trim();
        if (text.Length == 0) throw new FormatException("ใส่ที่อยู่เซิร์ฟเวอร์ เช่น https://mimi.example.com");
        if (!text.Contains("://", StringComparison.Ordinal)) text = "https://" + text;
        if (!Uri.TryCreate(text, UriKind.Absolute, out var url) || url.Host.Length == 0) throw new FormatException("ที่อยู่ไม่ถูกต้อง ใส่แบบ https://mimi.example.com");
        if (url.Scheme != Uri.UriSchemeHttps && !(url.Scheme == Uri.UriSchemeHttp && IsLocal(url)))
        {
            throw new FormatException("ต้องเป็น https:// (http:// ใช้ได้เฉพาะเซิร์ฟเวอร์ในเครื่องนี้)");
        }
        if (url.UserInfo.Length > 0) throw new FormatException("ที่อยู่ต้องไม่มีชื่อผู้ใช้หรือรหัสผ่านอยู่ข้างใน");
        return url.GetLeftPart(UriPartial.Authority);
    }

    /// <summary>The socket of a server: ws(s)://host/ws.</summary>
    public static Uri WebSocketUrl(string server)
    {
        var builder = new UriBuilder(new Uri(new Uri(server), "/ws"));
        builder.Scheme = builder.Scheme == Uri.UriSchemeHttps ? "wss" : "ws";
        if (builder.Uri.IsDefaultPort) builder.Port = -1;
        return builder.Uri;
    }
}
