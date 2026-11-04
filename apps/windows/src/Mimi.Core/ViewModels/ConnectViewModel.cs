using System.Net;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Mimi.Core.Desktop;
using Mimi.Core.Net;
using Mimi.Core.Protocol;

namespace Mimi.Core.ViewModels;

public enum ConnectStep
{
    /// <summary>Which server (core or gateway).</summary>
    Server,
    /// <summary>A single core: its token ("รหัสผ่านของ Mimi").</summary>
    Token,
    /// <summary>The accounts gateway: username + password (+ code when asked).</summary>
    Credentials,
}

/// <summary>What a successful sign-in hands to the app.</summary>
public sealed record SignedIn(string Server, string Token, string Username, bool Gateway, bool Remember, Health Health);

/// <summary>
/// Connecting and signing in (docs/native/auth-and-session.md): <c>/health</c> tells a single core
/// (type its token) from the gateway (username, password, and the 2FA code when the gateway asks).
/// The password is only held in memory until the sign-in ends; it is never stored.
/// </summary>
public sealed partial class ConnectViewModel(MimiApi api) : ObservableObject
{
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(OnServer), nameof(OnToken), nameof(OnCredentials))]
    private ConnectStep step = ConnectStep.Server;

    [ObservableProperty]
    private string serverText = "";

    [ObservableProperty]
    private string token = "";

    [ObservableProperty]
    private string username = "";

    [ObservableProperty]
    private string password = "";

    [ObservableProperty]
    private string code = "";

    /// <summary>The gateway asked for the authenticator code.</summary>
    [ObservableProperty]
    private bool needsCode;

    /// <summary>"เครื่องนี้ไม่ใช่ของฉัน": the session lives in memory only and ends when the app quits.</summary>
    [ObservableProperty]
    private bool notMyDevice;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasError))]
    private string error = "";

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(Idle))]
    private bool busy;

    public bool OnServer => Step == ConnectStep.Server;
    public bool OnToken => Step == ConnectStep.Token;
    public bool OnCredentials => Step == ConnectStep.Credentials;
    public bool HasError => Error.Length > 0;
    public bool Idle => !Busy;

    /// <summary>The server that was checked (an origin).</summary>
    public string Server { get; private set; } = "";
    public Health Health { get; private set; } = new();

    public event Action<SignedIn>? Done;

    /// <summary>A start with a server already chosen (config.json) goes straight to its sign-in.</summary>
    public async Task Resume(string server)
    {
        ServerText = server;
        await Check();
    }

    [RelayCommand]
    public async Task Check()
    {
        Error = "";
        string address;
        try
        {
            address = ServerAddress.Normalize(ServerText);
        }
        catch (FormatException problem)
        {
            Error = problem.Message;
            return;
        }
        Busy = true;
        try
        {
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            var health = await api.Health(address, cancel.Token);
            if (!health.Ok) throw new MimiHttpException(HttpStatusCode.BadGateway, "not Mimi");
            if (health.MinClientApi > ClientApi.Version)
            {
                Error = $"เซิร์ฟเวอร์นี้ (Mimi {health.Version}) ต้องใช้แอปที่ใหม่กว่านี้ กรุณาอัปเดตแอป";
                return;
            }
            Server = address;
            OnPropertyChanged(nameof(Server));
            Health = health;
            ServerText = address;
            Step = health.Accounts ? ConnectStep.Credentials : ConnectStep.Token;
        }
        catch (Exception problem) when (problem is HttpRequestException or MimiHttpException or TaskCanceledException or System.Text.Json.JsonException or UriFormatException)
        {
            Error = "ติดต่อเซิร์ฟเวอร์นี้ไม่ได้ หรือไม่ใช่เซิร์ฟเวอร์ Mimi";
        }
        finally
        {
            Busy = false;
        }
    }

    [RelayCommand]
    public void Back()
    {
        Step = ConnectStep.Server;
        NeedsCode = false;
        Password = "";
        Code = "";
        Error = "";
    }

    [RelayCommand]
    public async Task SignIn()
    {
        Error = "";
        Busy = true;
        try
        {
            if (Step == ConnectStep.Token) await SignInWithToken();
            else await SignInWithPassword();
        }
        finally
        {
            Busy = false;
        }
    }

    private async Task SignInWithToken()
    {
        var value = Token.Trim();
        if (value.Length == 0)
        {
            Error = "ใส่รหัสผ่านของ Mimi (MIMI_TOKEN ของเครื่องที่รัน core)";
            return;
        }
        // A core has no login endpoint: a call that needs the token tells right from wrong (auth 2).
        var check = new MimiApi(api.Http, () => Server, () => value);
        try
        {
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            await check.Widget(cancel.Token);
        }
        catch (MimiHttpException problem) when (problem.Status == HttpStatusCode.Unauthorized)
        {
            Error = "รหัสผ่านไม่ถูกต้อง (หรือผิดหลายครั้งเกินไป รอ 15 นาทีแล้วลองใหม่)";
            return;
        }
        catch (Exception problem) when (problem is HttpRequestException or MimiHttpException or TaskCanceledException)
        {
            Error = $"ติดต่อเซิร์ฟเวอร์ไม่ได้: {problem.Message}";
            return;
        }
        Token = "";
        Done?.Invoke(new SignedIn(Server, value, "", Gateway: false, Remember: !NotMyDevice, Health));
    }

    private async Task SignInWithPassword()
    {
        var name = Username.Trim();
        if (name.Length == 0 || Password.Length == 0)
        {
            Error = "ใส่ชื่อผู้ใช้และรหัสผ่าน";
            return;
        }
        var login = new MimiApi(api.Http, () => Server, () => null);
        try
        {
            using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var reply = await login.Login(new LoginRequest(name, Password, NeedsCode && Code.Trim().Length > 0 ? Code.Trim() : null), cancel.Token);
            Password = "";
            Code = "";
            NeedsCode = false;
            Done?.Invoke(new SignedIn(Server, reply.Token, reply.Username.Length > 0 ? reply.Username : name, Gateway: true, Remember: !NotMyDevice, Health));
        }
        catch (MimiHttpException problem) when (problem.TwoFactor)
        {
            NeedsCode = true;
            Error = NeedsCode && Code.Length > 0 ? problem.Message : "ใส่รหัส 6 หลักจากแอป authenticator (หรือรหัสกู้คืน)";
        }
        catch (MimiHttpException problem)
        {
            Error = problem.Status switch
            {
                HttpStatusCode.Unauthorized => "ชื่อผู้ใช้ รหัสผ่าน หรือรหัสไม่ถูกต้อง",
                HttpStatusCode.TooManyRequests => "ลองผิดหลายครั้งเกินไป รอสักพักแล้วลองใหม่",
                HttpStatusCode.ServiceUnavailable => "เซิร์ฟเวอร์ไม่ว่าง ลองใหม่อีกครั้ง",
                _ => problem.Message,
            };
        }
        catch (Exception problem) when (problem is HttpRequestException or TaskCanceledException)
        {
            Error = $"ติดต่อเซิร์ฟเวอร์ไม่ได้: {problem.Message}";
        }
    }

    /// <summary>The app can run the core on this computer itself (its files are there).</summary>
    [ObservableProperty]
    private bool canUseLocal;

    /// <summary>
    /// "ใช้เซิร์ฟเวอร์ในเครื่องนี้": starts the core on this computer (<paramref name="start"/>) and signs in to it with
    /// its own token, with no address or password to type (launcher.ts did the same for the Electron app).
    /// </summary>
    public async Task UseLocal(Func<Task<LocalCoreReady>> start)
    {
        Error = "";
        Busy = true;
        LocalCoreReady ready;
        try
        {
            ready = await start();
        }
        catch (InvalidOperationException problem)
        {
            Error = $"เปิดเซิร์ฟเวอร์ในเครื่องนี้ไม่ได้: {problem.Message}";
            return;
        }
        finally
        {
            Busy = false;
        }
        ServerText = ready.Address;
        await Check();
        if (Step != ConnectStep.Token)
        {
            if (Error.Length == 0) Error = "เซิร์ฟเวอร์ในเครื่องนี้เป็นแบบหลายบัญชี — เข้าสู่ระบบด้วยชื่อผู้ใช้";
            return;
        }
        Token = ready.Token;
        NotMyDevice = false;
        await SignIn();
    }

    /// <summary>A config.json server the app starts with; a bad one is ignored.</summary>
    public static string StartServer(AppConfig config) => config.Server;
}
