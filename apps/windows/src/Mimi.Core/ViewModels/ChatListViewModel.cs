using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Mimi.Core.Protocol;

namespace Mimi.Core.ViewModels;

public sealed record ChatRow(long Id, string Title, string Preview, string When, bool Unread, bool Busy, bool Group, string? Avatar, string Initial);

public sealed record AgentChoice(string Name, string Shown, string Description);

/// <summary>The list of chats (realtime.md 4): direct and group tabs, unread, typing, and a new chat with an agent.</summary>
public sealed partial class ChatListViewModel : ObservableObject
{
    private readonly MimiSession session;

    public ChatListViewModel(MimiSession session)
    {
        this.session = session;
        session.ChatsChanged += Refresh;
        session.AgentsChanged += () =>
        {
            Refresh();
            Agents.Clear();
            foreach (var agent in session.Agents.Values.OrderBy(agent => agent.Name != session.DefaultAgent).ThenBy(agent => agent.ShownName))
            {
                Agents.Add(new AgentChoice(agent.Name, agent.ShownName, agent.Description));
            }
            OnPropertyChanged(nameof(HasAgents));
        };
        session.Frame += frame =>
        {
            // chat-create answers this socket with the chat's history: open it.
            if (frame is ServerFrame.ChatHistory history && waitingFor is not null && history.Chat.AgentNames.Contains(waitingFor))
            {
                waitingFor = null;
                OpenRequested?.Invoke(history.Chat.Id);
            }
            else if (frame is ServerFrame.ChatHistory group && waitingGroup is not null && group.Chat.Kind == "group" && group.Chat.AgentNames.SequenceEqual(waitingGroup))
            {
                waitingGroup = null;
                ShowingDirect = false;
                OpenRequested?.Invoke(group.Chat.Id);
            }
        };
    }

    public ObservableCollection<ChatRow> Rows { get; } = [];
    public ObservableCollection<AgentChoice> Agents { get; } = [];
    public bool HasAgents => Agents.Count > 0;

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(ShowingGroups))]
    private bool showingDirect = true;

    public bool ShowingGroups => !ShowingDirect;

    [ObservableProperty]
    private bool empty;

    private string? waitingFor;

    /// <summary>The screen opens this chat.</summary>
    public event Action<long>? OpenRequested;

    partial void OnShowingDirectChanged(bool value) => Refresh();

    public static string When(string? iso, DateTimeOffset now)
    {
        if (iso is null || !DateTimeOffset.TryParse(iso, out var at)) return "";
        var local = at.ToLocalTime();
        if (local.Date == now.ToLocalTime().Date) return local.ToString("HH:mm");
        if (local.Year == now.Year) return local.ToString("d MMM", new System.Globalization.CultureInfo("th-TH"));
        return local.ToString("d MMM yy", new System.Globalization.CultureInfo("th-TH"));
    }

    public void Refresh()
    {
        var now = DateTimeOffset.Now;
        var rows = session.Chats
            .Where(chat => (chat.Kind == "group") != ShowingDirect)
            .OrderByDescending(chat => chat.LastMessageAt ?? "")
            .Select(chat =>
            {
                var agent = chat.AgentNames.Count > 0 && session.Agents.TryGetValue(chat.AgentNames[0], out var found) ? found : null;
                var title = session.ChatTitle(chat);
                return new ChatRow(
                    chat.Id,
                    title,
                    MessageFormat.Preview(chat.Preview, 90),
                    When(chat.LastMessageAt, now),
                    chat.Unread,
                    session.BusyChats.Contains(chat.Id),
                    chat.Kind == "group",
                    agent?.Avatar is { } stamp ? Net.MimiApi.AgentImagePath(agent.Name, "avatar", stamp) : null,
                    title.Length > 0 ? title[..1].ToUpperInvariant() : "?");
            })
            .ToList();
        // Replace in place so the list keeps its scroll and selection.
        for (var i = 0; i < rows.Count; i++)
        {
            if (i < Rows.Count)
            {
                if (Rows[i] != rows[i]) Rows[i] = rows[i];
            }
            else
            {
                Rows.Add(rows[i]);
            }
        }
        while (Rows.Count > rows.Count) Rows.RemoveAt(Rows.Count - 1);
        Empty = Rows.Count == 0;
    }

    [RelayCommand]
    public void ShowDirect() => ShowingDirect = true;

    [RelayCommand]
    public void ShowGroups() => ShowingDirect = false;

    /// <summary>Starts (or reopens: one direct chat per agent) the chat with an agent.</summary>
    [RelayCommand]
    public void NewChat(string agent)
    {
        var existing = session.Chats.FirstOrDefault(chat => chat.Kind == "direct" && chat.AgentNames.Count == 1 && chat.AgentNames[0] == agent);
        if (existing is not null)
        {
            OpenRequested?.Invoke(existing.Id);
            return;
        }
        waitingFor = agent;
        session.Send(ClientFrames.ChatCreateDirect(agent));
    }

    private IReadOnlyList<string>? waitingGroup;

    /// <summary>A group chat: at least two agents, the first answers when nobody is addressed.</summary>
    public string? NewGroup(string title, IReadOnlyList<string> agents)
    {
        if (agents.Count < 2) return "กลุ่มต้องมี agent อย่างน้อย 2 ตัว";
        waitingGroup = agents;
        var json = new System.Text.Json.Nodes.JsonObject
        {
            ["kind"] = "group",
            ["agents"] = new System.Text.Json.Nodes.JsonArray(agents.Select(agent => (System.Text.Json.Nodes.JsonNode?)agent).ToArray()),
        };
        if (title.Trim().Length > 0) json["title"] = title.Trim();
        session.Send(ClientFrames.Json("chat-create", json));
        return null;
    }
}
