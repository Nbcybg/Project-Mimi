export const CAPABILITIES = ['chat', 'vision', 'transcript', 'summarize', 'image', 'speech', 'video'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type MessageRole = 'user' | 'assistant' | 'tool';

/** A row of the raw, never-deleted message log. */
export interface StoredMessage {
  id: number;
  thread: string;
  traceId: string;
  agent: string;
  role: MessageRole;
  /** Provider-layer message content (string or content parts), stored as JSON. */
  content: unknown;
  /** Plain text used for display and full-text search. */
  text: string;
  /** Volatile prompt block (current time, status) that was sent with this user message. */
  context?: string;
  /** Id of the message this one answers. */
  replyTo?: number;
  /** When forwarded: who wrote the original, and where. */
  forwardFrom?: string;
  forwardChat?: string;
  /** When the user pinned this message. */
  pinnedAt?: string;
  /** Emoji the user reacted with. */
  reactions?: string[];
  createdAt: string;
}
