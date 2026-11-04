/**
 * The small views the Android widget and background poll read (`GET /api/widget`,
 * `GET /api/notifications`). Kept here so every client builds its models from the same definitions.
 */

/** One row of `GET /api/widget`. */
export interface WidgetChatView {
  id: number;
  title: string;
  agent: string;
  /** Path of the agent's avatar with its version (`?v=`), or null. */
  avatar: string | null;
  preview: string;
  lastMessageAt: string | null;
  /** Replies in the newest session the user has not opened yet. */
  unread: number;
}

export interface WidgetView {
  chats: WidgetChatView[];
  busyChat: number | null;
}

/** One item of `GET /api/notifications`. */
export interface NotificationSyncItem {
  id: number;
  kind: 'reminder' | 'task-result' | 'info' | 'approval' | 'message';
  title: string;
  body: string;
  chatId: number | null;
  createdAt: string;
  /** Only with `?afterId=`: whether it was read (on any device). */
  read?: boolean;
}
