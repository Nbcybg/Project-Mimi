using Mimi.Core.Protocol;

namespace Mimi.Core.Chat;

/// <summary>One thing waiting for the user: a tool asking permission in some chat, or the PC agent asking at the PC's own screen.</summary>
public sealed record AttentionItem(
    string Id,
    bool AtPc,
    string Agent,
    long? ChatId,
    string Summary,
    string Tool,
    DateTimeOffset? ExpiresAt = null,
    string? PcName = null);

/// <summary>
/// Everything still waiting for the user, from every chat (the web's bar above the message box): a card is only drawn in its own
/// chat, but the question names the agent and the chat, so there is no reason to hide it from the others. Plus the questions the
/// PC agent put on the computer's own screen, which only someone at that screen can answer.
/// </summary>
public sealed class AttentionBoard
{
    private readonly OrderedDictionary<string, AttentionItem> permissions = [];
    private readonly OrderedDictionary<string, AttentionItem> consents = [];

    /// <summary>The PC's questions first (nothing else can answer them), then the permissions, each oldest first.</summary>
    public IReadOnlyList<AttentionItem> Items => [.. consents.Values, .. permissions.Values];

    public bool Any => consents.Count > 0 || permissions.Count > 0;

    /// <summary>Applies one frame; true when what is waiting changed.</summary>
    public bool Apply(ServerFrame frame)
    {
        switch (frame)
        {
            case ServerFrame.Welcome welcome:
            {
                // A new connection starts from what the core says is still open.
                var changed = Any || welcome.PendingPermissions.Count > 0 || welcome.PcConsents is { Count: > 0 };
                permissions.Clear();
                consents.Clear();
                foreach (var request in welcome.PendingPermissions) AddPermission(request, request.ChatId);
                foreach (var view in welcome.PcConsents ?? []) AddConsent(view);
                return changed;
            }
            case ServerFrame.ChatEvent chat:
                return ApplyEvent(chat.Event, chat.ChatId);
            case ServerFrame.Background background:
                return ApplyEvent(background.Event, null);
            case ServerFrame.PermissionResolved resolved:
                return permissions.Remove(resolved.RequestId);
            case ServerFrame.PcConsent waiting:
                AddConsent(waiting.Request);
                return true;
            case ServerFrame.PcConsentDone done:
                return consents.Remove(done.Id);
            case ServerFrame.PcStatus { Online: false }:
                if (consents.Count == 0) return false;
                consents.Clear();
                return true;
            default:
                return false;
        }
    }

    private bool ApplyEvent(AgentEvent ev, long? chatId)
    {
        switch (ev)
        {
            case AgentEvent.Permission permission:
                AddPermission(permission.Request, chatId ?? permission.Request.ChatId);
                return true;
            case AgentEvent.PermissionDecision decision:
                return permissions.Remove(decision.RequestId);
            case AgentEvent.Activity activity:
                return ApplyEvent(activity.Event, chatId);
            default:
                return false;
        }
    }

    private void AddPermission(PermissionRequest request, long? chatId) =>
        permissions[request.Id] = new AttentionItem(request.Id, false, request.Agent, chatId, request.Summary.Length > 0 ? request.Summary : request.Tool, request.Tool);

    private void AddConsent(PcConsentView view) =>
        consents[view.Id] = new AttentionItem(
            view.Id,
            true,
            view.Agent,
            view.ChatId,
            view.Summary.Length > 0 ? view.Summary : view.Tool,
            view.Tool,
            DateTimeOffset.TryParse(view.ExpiresAt, out var expires) ? expires : null,
            view.PcName);
}
