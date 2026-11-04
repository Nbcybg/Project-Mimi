namespace Mimi.Core.Desktop;

/// <summary>
/// "เปิดเบราว์เซอร์ของ Mimi" of the Electron tray (browser-shell.cjs): the agent's own browser profile, opened by
/// hand so the person can sign in to sites the agent will use. Without Electron it is the Edge or Chrome the PC
/// agent drives (packages/pc-agent/src/browser/launcher.ts), started with the same flags: the DevTools port it
/// writes into the profile lets the agent take over this window instead of failing to start a second one.
/// </summary>
public static class AgentBrowser
{
    /// <summary>Where Edge and Chrome live by default, in the order the PC agent tries them.</summary>
    public static IEnumerable<string> Candidates(Func<string, string?> env)
    {
        foreach (var root in new[] { env("ProgramFiles(x86)"), env("ProgramFiles"), env("LOCALAPPDATA") })
        {
            if (string.IsNullOrEmpty(root)) continue;
            yield return Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe");
            yield return Path.Combine(root, "Google", "Chrome", "Application", "chrome.exe");
        }
    }

    /// <summary>MIMI_BROWSER_PATH when it is set (and exists), else the first Edge or Chrome found; null when there is none.</summary>
    public static string? Find(Func<string, string?> env, Func<string, bool> exists)
    {
        if (env("MIMI_BROWSER_PATH") is { Length: > 0 } chosen) return exists(chosen) ? chosen : null;
        return Candidates(env).FirstOrDefault(exists);
    }

    /// <summary>The launcher's flags (browserArguments, not headless) for this profile.</summary>
    public static IReadOnlyList<string> Arguments(string profile) =>
    [
        "--remote-debugging-port=0",
        "--remote-allow-origins=*",
        $"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--window-size=1280,900",
        "about:blank",
    ];
}
