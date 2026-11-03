using Mimi.Core.Net;
using Mimi.Core.Protocol;

namespace Mimi.Core;

/// <summary>Runs work on the UI thread (WinUI's DispatcherQueue in the app, inline in tests).</summary>
public interface IUiDispatcher
{
    void Post(Action action);
}

public sealed class InlineDispatcher : IUiDispatcher
{
    public void Post(Action action) => action();
}

/// <summary>
/// One signed-in connection to a core or gateway: the HTTP client, the socket, and what every screen
/// shares (agents, chats, who is busy). Frames arrive on the UI thread through <see cref="Frame"/>.
/// </summary>
public sealed class MimiSession : IDisposable
{
    private readonly IUiDispatcher ui;
    private string? server;
    private string? token;

    public MimiSession(HttpClient http, IUiDispatcher ui, string appVersion, Func<IWebSocketConnection>? connect = null, TimeSpan? pingEvery = null)
    {
        this.ui = ui;
        AppVersion = appVersion;
        Api = new MimiApi(http, () => server, () => token);
        Socket = new MimiSocket(connect ?? (() => new ClientWebSocketConnection()), () => (server, token), appVersion, pingEvery);
        Socket.Frame += frame => ui.Post(() => OnFrame(frame));
        Socket.Raw += (type, json) => ui.Post(() => OnRaw(type, json));
        Socket.StateChanged += next => ui.Post(() => OnState(next));
    }

    /// <summary>Every frame but pongs and chat events as JSON (type, frame), on the UI thread: the management screens.</summary>
    public event Action<string, System.Text.Json.JsonElement>? Raw;

    private readonly List<(Func<string, System.Text.Json.JsonElement, bool> Match, TaskCompletionSource<System.Text.Json.JsonElement> Done)> asks = [];

    private readonly Dictionary<string, string> shared = [];

    /// <summary>A screen setting shared by the user's devices (welcome.ui, `ui` frames), or null.</summary>
    public string? UiValue(string key) => shared.TryGetValue(key, out var value) ? value : null;

    /// <summary>Changes a shared screen setting (null removes it); the other devices hear of it.</summary>
    public void SetUi(string key, string? value)
    {
        if (value is null) shared.Remove(key);
        else shared[key] = value;
        Send(ClientFrames.Json("ui-set", new System.Text.Json.Nodes.JsonObject { ["values"] = new System.Text.Json.Nodes.JsonObject { [key] = value } }));
    }

    private void OnRaw(string type, System.Text.Json.JsonElement json)
    {
        if (type is "welcome" or "ui" && json.TryGetProperty(type == "welcome" ? "ui" : "values", out var values) && values.ValueKind == System.Text.Json.JsonValueKind.Object)
        {
            if (type == "welcome") shared.Clear();
            foreach (var entry in values.EnumerateObject())
            {
                if (entry.Value.ValueKind == System.Text.Json.JsonValueKind.String) shared[entry.Name] = entry.Value.GetString()!;
                else shared.Remove(entry.Name);
            }
        }
        foreach (var ask in asks.ToList())
        {
            if (!ask.Match(type, json)) continue;
            asks.Remove(ask);
            ask.Done.TrySetResult(json);
        }
        Raw?.Invoke(type, json);
    }

    /// <summary>
    /// Sends a frame and waits for the answer of type <paramref name="reply"/> (or an <c>error</c> about
    /// <paramref name="requestType"/>, which throws). For the management screens' one-off questions.
    /// </summary>
    public async Task<System.Text.Json.JsonElement> Ask(string frame, string reply, string? requestType = null, Func<System.Text.Json.JsonElement, bool>? match = null, TimeSpan? timeout = null)
    {
        var done = new TaskCompletionSource<System.Text.Json.JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        var entry = ((Func<string, System.Text.Json.JsonElement, bool>)((type, json) =>
            (type == reply && (match is null || match(json)))
            || (type == "error" && requestType is not null && json.TryGetProperty("requestType", out var about) && about.GetString() == requestType)), done);
        ui.Post(() => asks.Add(entry));
        Send(frame);
        var finished = await Task.WhenAny(done.Task, Task.Delay(timeout ?? TimeSpan.FromSeconds(60))).ConfigureAwait(true);
        if (finished != done.Task)
        {
            ui.Post(() => asks.Remove(entry));
            throw new TimeoutException("เซิร์ฟเวอร์ไม่ตอบ");
        }
        var answer = done.Task.Result;
        if (answer.TryGetProperty("type", out var kind) && kind.GetString() == "error" && reply != "error")
        {
            throw new InvalidOperationException(answer.TryGetProperty("message", out var message) ? message.GetString() : "ผิดพลาด");
        }
        return answer;
    }

    public string AppVersion { get; }
    public MimiApi Api { get; }
    public MimiSocket Socket { get; }
    public string? Server => server;
    public string Username { get; private set; } = "";
    /// <summary>Signed in through the accounts gateway (username + password) rather than one core's token.</summary>
    public bool Gateway { get; private set; }
    public int CoreApi { get; private set; }
    public SocketState State { get; private set; } = new SocketState.Idle();
    public IReadOnlyDictionary<string, AgentView> Agents => agents;
    public string DefaultAgent { get; private set; } = "";
    public IReadOnlyList<ChatView> Chats { get; private set; } = [];
    public IReadOnlySet<long> BusyChats => busy;
    public bool PcOnline { get; private set; }

    private readonly Dictionary<string, AgentView> agents = [];
    private readonly HashSet<long> busy = [];

    /// <summary>Every frame of the socket, on the UI thread, after the shared state above is updated.</summary>
    public event Action<ServerFrame>? Frame;
    public event Action<SocketState>? StateChanged;
    public event Action? ChatsChanged;
    public event Action? AgentsChanged;

    public void Begin(string serverAddress, string sessionToken, string username, bool gateway, int coreApi)
    {
        server = serverAddress;
        token = sessionToken;
        Username = username;
        Gateway = gateway;
        CoreApi = coreApi;
        Socket.Start();
    }

    /// <summary>Forgets the token and closes the socket (the caller ends the gateway session first).</summary>
    public void End()
    {
        Socket.Stop();
        token = null;
        Username = "";
        agents.Clear();
        busy.Clear();
        Chats = [];
    }

    public string? Token => token;

    public void Send(string frame) => Socket.Send(frame);

    public string AgentName(string name) => agents.TryGetValue(name, out var agent) ? agent.ShownName : name;

    public string ChatTitle(ChatView chat)
    {
        if (chat.Title.Length > 0) return chat.Title;
        var names = chat.AgentNames.Select(AgentName).ToList();
        return names.Count > 0 ? string.Join(", ", names) : $"แชต #{chat.Id}";
    }

    private void OnState(SocketState next)
    {
        State = next;
        if (next is SocketState.Online online)
        {
            CoreApi = online.Welcome.Api;
            busy.Clear();
            foreach (var id in online.Welcome.BusyChats) busy.Add(id);
            foreach (var summary in online.Welcome.AgentSummaries)
            {
                if (!agents.ContainsKey(summary.Name)) agents[summary.Name] = new AgentView(summary.Name, summary.DisplayName, summary.Description);
            }
            DefaultAgent = online.Welcome.DefaultAgent;
            // The minimum for the chat screens (realtime.md 2.1).
            Send(ClientFrames.Simple("agents-list"));
            Send(ClientFrames.Simple("chats-list"));
            AgentsChanged?.Invoke();
        }
        StateChanged?.Invoke(next);
    }

    private void OnFrame(ServerFrame frame)
    {
        switch (frame)
        {
            case ServerFrame.Agents list:
                agents.Clear();
                foreach (var agent in list.List) agents[agent.Name] = agent;
                if (!string.IsNullOrEmpty(list.DefaultAgent)) DefaultAgent = list.DefaultAgent!;
                AgentsChanged?.Invoke();
                break;
            case ServerFrame.Chats chats:
                Chats = chats.List;
                ChatsChanged?.Invoke();
                break;
            case ServerFrame.Busy { ChatId: null }:
                busy.Clear();
                ChatsChanged?.Invoke();
                break;
            case ServerFrame.Busy one:
                if (one.Done) busy.Remove(one.ChatId!.Value);
                else busy.Add(one.ChatId!.Value);
                ChatsChanged?.Invoke();
                break;
            case ServerFrame.PcStatus pc:
                PcOnline = pc.Online;
                break;
            case ServerFrame.Welcome welcome:
                PcOnline = false;
                break;
        }
        Frame?.Invoke(frame);
    }

    public void Dispose() => Socket.Dispose();
}
