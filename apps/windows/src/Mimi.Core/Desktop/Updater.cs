using System.Diagnostics;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Mimi.Core.Desktop;

public sealed record UpdateInfo(string Version, string Url, string Name, long Size, string? Notes, string? SumsUrl);

/// <summary>
/// Updates of the app from the GitHub releases of Mimi, the same way and from the same assets as the
/// Electron app (packages/desktop/updater.cjs): <c>Mimi-&lt;version&gt;-win-&lt;arch&gt;.zip</c> with the app in
/// <c>Mimi/Mimi.exe</c>, checked against the release's <c>SHA256SUMS.txt</c> and, when this app is signed,
/// against the same Authenticode publisher. It asks first; nothing installs on its own. A small script
/// waits for the app to quit, mirrors the new files over the install folder and starts it again.
/// </summary>
public static partial class Updater
{
    public const string SumsName = "SHA256SUMS.txt";

    /// <summary>1.2.10 &gt; 1.2.9; a leading "v" and anything after "-" are ignored.</summary>
    public static bool IsNewer(string candidate, string current)
    {
        static int[] Parts(string text) => text.TrimStart('v').Split('-')[0].Split('.').Select(part => int.TryParse(part, out var n) ? n : 0).ToArray();
        var (a, b) = (Parts(candidate), Parts(current));
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++)
        {
            var (x, y) = (i < a.Length ? a[i] : 0, i < b.Length ? b[i] : 0);
            if (x != y) return x > y;
        }
        return false;
    }

    public static string ArchTag(Architecture arch = default) =>
        (arch == default ? RuntimeInformation.ProcessArchitecture : arch) == Architecture.Arm64 ? "arm64" : "x64";

    /// <summary>The release asset for this computer, e.g. Mimi-0.9.0-win-x64.zip; null when there is none.</summary>
    public static JsonElement? AssetFor(JsonElement release, string arch)
    {
        if (!release.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Array) return null;
        foreach (var asset in assets.EnumerateArray())
        {
            var name = asset.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
            if (name.EndsWith($"-win-{arch}.zip", StringComparison.OrdinalIgnoreCase)) return asset;
        }
        return null;
    }

    public static UpdateInfo? FromRelease(JsonElement release, string current, string arch)
    {
        if (Flag(release, "draft") || Flag(release, "prerelease")) return null;
        var tag = release.TryGetProperty("tag_name", out var t) ? t.GetString() ?? "" : "";
        if (!IsNewer(tag, current)) return null;
        if (AssetFor(release, arch) is not { } asset) return null;
        string? sums = null;
        foreach (var entry in release.GetProperty("assets").EnumerateArray())
        {
            if (entry.TryGetProperty("name", out var name) && name.GetString() == SumsName) sums = entry.GetProperty("browser_download_url").GetString();
        }
        return new UpdateInfo(
            tag.TrimStart('v'),
            asset.GetProperty("browser_download_url").GetString() ?? "",
            asset.GetProperty("name").GetString() ?? "",
            asset.TryGetProperty("size", out var size) && size.TryGetInt64(out var bytes) ? bytes : 0,
            release.TryGetProperty("html_url", out var notes) ? notes.GetString() : null,
            sums);
    }

    private static bool Flag(JsonElement json, string key) => json.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.True;

    /// <summary>The latest release when it is newer than <paramref name="current"/> and has a build for this computer; else null.</summary>
    public static async Task<UpdateInfo?> FindUpdate(HttpClient http, string repo, string current, CancellationToken cancel = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"https://api.github.com/repos/{repo}/releases/latest");
        request.Headers.Add("Accept", "application/vnd.github+json");
        request.Headers.Add("User-Agent", "mimi-windows");
        using var response = await http.SendAsync(request, cancel).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) return null;
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancel).ConfigureAwait(false));
        return FromRelease(json.RootElement, current, ArchTag());
    }

    [GeneratedRegex(@"^([0-9a-f]{64})\s+\*?(.+)$", RegexOptions.IgnoreCase)]
    private static partial Regex SumLine();

    /// <summary>The SHA-256 a sums file gives for <paramref name="name"/> (sha256sum format, text or binary mode), or null.</summary>
    public static string? ExpectedHash(string sums, string name)
    {
        foreach (var line in sums.Split('\n'))
        {
            var found = SumLine().Match(line.Trim());
            if (found.Success && found.Groups[2].Value.Trim() == name) return found.Groups[1].Value.ToLowerInvariant();
        }
        return null;
    }

    /// <summary>Refuses a downloaded zip whose size or SHA-256 differs from what the release published.</summary>
    public static void CheckDownload(string zip, UpdateInfo update, string sums)
    {
        var expected = ExpectedHash(sums, update.Name) ?? throw new InvalidDataException($"{SumsName} of this release does not list {update.Name}");
        var size = new FileInfo(zip).Length;
        if (update.Size > 0 && size != update.Size) throw new InvalidDataException($"the download is {size} bytes, the release says {update.Size}");
        using var stream = File.OpenRead(zip);
        var actual = Convert.ToHexStringLower(SHA256.HashData(stream));
        if (actual != expected) throw new InvalidDataException("the download does not match the checksum of the release (damaged or replaced)");
    }

    /// <summary>Downloads the zip into <paramref name="stageDir"/> and unpacks it there; returns the unpacked app folder.</summary>
    public static async Task<string> Download(HttpClient http, UpdateInfo update, string stageDir, CancellationToken cancel = default)
    {
        if (update.SumsUrl is null) throw new InvalidDataException($"this release has no {SumsName}, so the download cannot be checked");
        if (Directory.Exists(stageDir)) Directory.Delete(stageDir, recursive: true);
        Directory.CreateDirectory(stageDir);
        var sums = await http.GetStringAsync(update.SumsUrl, cancel).ConfigureAwait(false);
        var zip = Path.Combine(stageDir, update.Name);
        await using (var source = await http.GetStreamAsync(update.Url, cancel).ConfigureAwait(false))
        await using (var target = File.Create(zip))
        {
            await source.CopyToAsync(target, cancel).ConfigureAwait(false);
        }
        CheckDownload(zip, update, sums);
        var output = Path.Combine(stageDir, "new");
        ZipFile.ExtractToDirectory(zip, output);
        File.Delete(zip);
        var unpacked = Path.Combine(output, "Mimi");
        if (!File.Exists(Path.Combine(unpacked, "Mimi.exe"))) throw new InvalidDataException("the downloaded update does not contain the app");
        return unpacked;
    }

    /// <summary>Who signed a file (Authenticode subject), or null for an unsigned one; <c>Valid</c> says whether the signature checks out.</summary>
    public static (bool Valid, string? Signer) SignatureOf(string file)
    {
        // The path goes through the environment, never into the command text.
        var start = new ProcessStartInfo("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$s = Get-AuthenticodeSignature -LiteralPath $env:MIMI_SIGNED_FILE; \"$($s.Status)|$($s.SignerCertificate.Subject)\""])
        {
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        start.Environment["MIMI_SIGNED_FILE"] = file;
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEnd().Trim();
        process.WaitForExit();
        var parts = output.Split('|');
        var valid = parts[0] == "Valid";
        return (valid, valid && parts.Length > 1 && parts[1].Trim().Length > 0 ? parts[1].Trim() : null);
    }

    /// <summary>
    /// When this app carries a publisher signature, the update must carry a valid one from the same
    /// publisher. An unsigned build has nothing to compare against; the checksum is then the only check.
    /// </summary>
    public static void CheckSignature(string current, string next, Func<string, (bool Valid, string? Signer)>? signatureOf = null)
    {
        signatureOf ??= SignatureOf;
        var mine = signatureOf(current);
        if (mine.Signer is null) return;
        var theirs = signatureOf(next);
        if (!theirs.Valid || theirs.Signer != mine.Signer) throw new InvalidDataException($"the update is not signed by the same publisher as this app ({mine.Signer})");
    }

    /// <summary>The script that swaps the app once process <paramref name="pid"/> has quit, then starts it again.</summary>
    public static string SwapScript(int pid, string source, string target, string stageDir) => string.Join("\r\n",
        "@echo off",
        ":wait",
        $"tasklist /FI \"PID eq {pid}\" 2>nul | find \"{pid}\" >nul && (timeout /t 1 /nobreak >nul & goto wait)",
        // /XF: the installer's uninstaller is not in the zip and stays.
        $"robocopy \"{source}\" \"{target}\" /MIR /XF \"Uninstall Mimi.exe\" /R:5 /W:1 /NFL /NDL /NJH /NJS /NP >nul",
        $"start \"\" \"{Path.Combine(target, "Mimi.exe")}\"",
        $"rmdir /s /q \"{stageDir}\"",
        "");

    /// <summary>Writes and starts the swap script, detached so it outlives the app; the caller then quits.</summary>
    public static void StartSwap(string source, string target, string stageDir)
    {
        var script = Path.Combine(stageDir, "update.cmd");
        File.WriteAllText(script, SwapScript(Environment.ProcessId, source, target, stageDir));
        Process.Start(new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", ["/d", "/c", script])
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        });
    }
}
