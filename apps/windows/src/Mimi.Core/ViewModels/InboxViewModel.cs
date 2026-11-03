using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Mimi.Core.Protocol;

namespace Mimi.Core.ViewModels;

public sealed record InboxRow(long Id, string Icon, string Title, string Body, string When, bool Unread, long? ChatId);

/// <summary>
/// The notification inbox behind the bell (feature-inventory #17, feature-notify.js): the core's list on every
/// connect, new ones as they come, read one (and open its chat) or all.
/// </summary>
public sealed partial class InboxViewModel : ObservableObject
{
    private static readonly Dictionary<string, string> Icons = new()
    {
        ["reminder"] = "⏰",
        ["approval"] = "✋",
        ["task-result"] = "📋",
        ["message"] = "💬",
        ["info"] = "·",
    };

    private readonly MimiSession session;
    private readonly Func<long?> looking;
    private List<NotificationSyncItem> items = [];

    /// <param name="looking">The chat the person is looking at right now (on screen, window active), or null.</param>
    public InboxViewModel(MimiSession session, Func<long?> looking)
    {
        this.session = session;
        this.looking = looking;
        session.StateChanged += state =>
        {
            if (state is Net.SocketState.Online) session.Send(ClientFrames.Simple("notifications-list"));
        };
        session.Frame += OnFrame;
    }

    public ObservableCollection<InboxRow> Rows { get; } = [];

    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasUnread), nameof(Badge), nameof(Heading))]
    private int unread;

    public bool HasUnread => Unread > 0;
    public string Badge => Unread > 99 ? "99+" : Unread.ToString();
    public string Heading => Unread > 0 ? $"การแจ้งเตือน ({Unread} ใหม่)" : "การแจ้งเตือน";
    public bool Empty => Rows.Count == 0;

    /// <summary>The screen opens this chat.</summary>
    public event Action<long>? OpenRequested;

    private void OnFrame(ServerFrame frame)
    {
        switch (frame)
        {
            case ServerFrame.Notifications list:
                items = list.Items.ToList();
                Unread = list.Unread;
                Render();
                break;
            case ServerFrame.Notification { Id: { } id } note:
                // About the chat on screen right now: seen already, not a new count.
                if (note.ChatId is { } chat && looking() == chat)
                {
                    session.Send(ClientFrames.NotificationsRead([id]));
                    break;
                }
                if (items.Any(item => item.Id == id)) break;
                items.Insert(0, new NotificationSyncItem(id, note.Kind, note.Title, note.Body, note.ChatId, DateTimeOffset.UtcNow.ToString("O"), false));
                if (items.Count > 50) items.RemoveRange(50, items.Count - 50);
                Unread++;
                Render();
                break;
        }
    }

    private void Render()
    {
        var now = DateTimeOffset.Now;
        Rows.Clear();
        foreach (var item in items)
        {
            Rows.Add(new InboxRow(item.Id, Icons.GetValueOrDefault(item.Kind, "·"), item.Title, MessageFormat.Preview(item.Body, 220),
                ChatListViewModel.When(item.CreatedAt, now), !item.Read, item.ChatId));
        }
        OnPropertyChanged(nameof(Empty));
    }

    /// <summary>Marks it read and opens its chat, when it has one.</summary>
    public void Open(InboxRow row)
    {
        if (row.Unread) session.Send(ClientFrames.NotificationsRead([row.Id]));
        if (row.ChatId is { } chat) OpenRequested?.Invoke(chat);
    }

    [RelayCommand]
    public void ReadAll() => session.Send(ClientFrames.NotificationsRead());

    /// <summary>Signed out: nothing of that account stays on screen.</summary>
    public void Clear()
    {
        items = [];
        Unread = 0;
        Render();
    }
}
