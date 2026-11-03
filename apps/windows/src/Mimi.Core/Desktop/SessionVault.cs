using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Mimi.Core.Desktop;

/// <summary>The signed-in session: the token never leaves memory or this vault (auth-and-session.md 8).</summary>
public sealed record SavedSession(string Server, string Token, string Username, bool Remember);

/// <summary>
/// Keeps the session token sealed with Windows DPAPI for this Windows account (CurrentUser scope), in
/// <c>%APPDATA%\Mimi\session.dpapi</c>, only while signed in and only when "remember" is on. Nothing in it
/// is readable by another Windows account or on another computer. (The Electron app's session.bin is
/// sealed with Chromium's own key and is not read: the first start of this app asks to sign in again.)
/// </summary>
public sealed class SessionVault(string file)
{
    // Extra entropy: other programs of the same account that call DPAPI without it cannot unseal the file.
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("app.mimi.windows/session/v1");

    public string File => file;

    public SavedSession? Load(string server)
    {
        try
        {
            var plain = ProtectedData.Unprotect(System.IO.File.ReadAllBytes(file), Entropy, DataProtectionScope.CurrentUser);
            var saved = JsonSerializer.Deserialize<SavedSession>(plain);
            if (saved is null || saved.Server != server || string.IsNullOrEmpty(saved.Token)) return null;
            return saved with { Remember = true };
        }
        catch (Exception error) when (error is IOException or CryptographicException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Seals the session, or removes the file when it should not be remembered.</summary>
    public void Store(SavedSession? session)
    {
        if (session is null || !session.Remember)
        {
            Clear();
            return;
        }
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var sealedBytes = ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(session), Entropy, DataProtectionScope.CurrentUser);
        var tmp = file + ".tmp";
        System.IO.File.WriteAllBytes(tmp, sealedBytes);
        System.IO.File.Move(tmp, file, overwrite: true);
    }

    public void Clear()
    {
        try
        {
            System.IO.File.Delete(file);
        }
        catch (IOException)
        {
        }
    }
}

/// <summary>Where this app keeps things, under the Windows account's own folders (the same places as the Electron app).</summary>
public sealed record AppFolders(string Root, string Config, string Session, string Cache)
{
    /// <summary>
    /// The account's folders, or <c>MIMI_WINDOWS_HOME</c> when set (a test, or a second install that must not
    /// share the sign-in of the first).
    /// </summary>
    public static AppFolders ForUser()
    {
        if (Environment.GetEnvironmentVariable("MIMI_WINDOWS_HOME") is { Length: > 0 } custom)
        {
            var root = Path.GetFullPath(custom);
            return For(Path.Combine(root, "Roaming"), Path.Combine(root, "Local"));
        }
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return For(appData, local);
    }

    public static AppFolders For(string appData, string localAppData)
    {
        var root = Path.Combine(appData, "Mimi");
        return new AppFolders(root, Path.Combine(root, "config.json"), Path.Combine(root, "session.dpapi"), Path.Combine(localAppData, "Mimi"));
    }

    /// <summary>The agent's browser profile of one Mimi account on one server; the name does not reveal the account.</summary>
    public string AgentBrowserDir(string server, string username)
    {
        var id = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"{server}\n{username}")))[..16];
        return Path.Combine(Cache, "agent-browser", id);
    }
}
