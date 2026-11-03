using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using Mimi.Core.Protocol;

namespace Mimi.Core.ViewModels;

/// <summary>A found message: where it is, who wrote it, and the snippet cut into plain and matched parts.</summary>
public sealed record SearchRow(long ChatId, long SessionId, long MessageId, string Where, IReadOnlyList<(string Text, bool Match)> Parts, string When)
{
    public string Snippet => string.Concat(Parts.Select(part => part.Text));
}

/// <summary>
/// Searching every session of every chat (feature-inventory #15, app.js searchDialog): the screen calls
/// <see cref="Run"/> a moment after typing stops; only the answer to the latest query is shown.
/// </summary>
public sealed partial class SearchViewModel : ObservableObject
{
    private readonly MimiSession session;
    private string asked = "";

    public SearchViewModel(MimiSession session)
    {
        this.session = session;
        session.Frame += frame =>
        {
            if (frame is ServerFrame.SearchResults results) Show(results);
        };
    }

    public ObservableCollection<SearchRow> Results { get; } = [];

    [ObservableProperty]
    private string query = "";

    [ObservableProperty]
    private string status = "พิมพ์คำที่ต้องการหา (คำไทยไม่ต้องเว้นวรรค)";

    /// <summary>The screen opens this chat at this session and message.</summary>
    public event Action<long, long, long>? OpenRequested;

    public void Run()
    {
        var text = Query.Trim();
        if (text.Length == 0)
        {
            asked = "";
            Results.Clear();
            Status = "พิมพ์คำที่ต้องการหา (คำไทยไม่ต้องเว้นวรรค)";
            return;
        }
        if (text == asked) return;
        asked = text;
        Status = "กำลังค้นหา…";
        session.Send(ClientFrames.Search(text));
    }

    private void Show(ServerFrame.SearchResults results)
    {
        if (results.Query != asked) return; // an older query answered late
        var now = DateTimeOffset.Now;
        Results.Clear();
        foreach (var hit in results.Hits)
        {
            var chat = session.Chats.FirstOrDefault(entry => entry.Id == hit.ChatId);
            var who = hit.Role == "user" ? "คุณ" : session.AgentName(hit.Agent);
            var title = chat is not null ? session.ChatTitle(chat) : hit.ChatTitle.Length > 0 ? hit.ChatTitle : "แชต";
            Results.Add(new SearchRow(hit.ChatId, hit.SessionId, hit.MessageId, title == who ? title : $"{title} · {who}",
                MessageFormat.Highlight(hit.Snippet.Replace("**", ""), results.Query), ChatListViewModel.When(hit.CreatedAt, now)));
        }
        Status = results.Hits.Count == 0 ? $"ไม่พบ \"{results.Query}\"" : $"พบ {results.Hits.Count} ข้อความ";
    }

    public void Open(SearchRow row) => OpenRequested?.Invoke(row.ChatId, row.SessionId, row.MessageId);

    /// <summary>Signed out: the query and what it found go.</summary>
    public void Clear()
    {
        Query = "";
        Run();
    }
}
