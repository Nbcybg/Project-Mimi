import type { AgentEvent, UsageSnapshot } from './events.ts';
import type { MessageRole } from './messages.ts';
import type { ConnectorConnectionInput, ConnectorConnectionView, OAuthAccountInput, OAuthAccountView } from './oauth.ts';
import type { ConnectorView } from './connectors.ts';
import type { PermissionDecision, PermissionRequest } from './permissions.ts';
import type { SpeechStyle } from './speech.ts';
import type { CustomToolSpec, McpServerSpec, McpServerView, ToolPreset, ToolSettingField } from './tools.ts';

/**
 * WebSocket protocol between the core and everything that connects to it. Every
 * frame is one JSON object. A connection must send `hello` first.
 */

export interface TriggerInfo {
  id: number;
  kind: 'reminder' | 'agent_task';
  title: string;
  /** The reminder text, or the instruction an agent task runs with. */
  text: string;
  /** One-shot time (UTC ISO-8601), or */
  fireAt: string | null;
  /** recurring cron pattern, evaluated in the core's time zone. */
  cron: string | null;
  /** Set for webhook triggers: the path to POST to, e.g. "/api/webhook/<key>". */
  webhook: string | null;
  agent: string | null;
  repeat: boolean;
  status: 'active' | 'fired' | 'cancelled';
  /** Next time it will fire (UTC ISO-8601); null once it is done. */
  nextFireAt: string | null;
  lastFiredAt: string | null;
  /** Outcome of the last firing: the agent's answer, or an error. */
  lastResult: string | null;
  /** Set when this schedule belongs to a workflow; managed from the Workflow screen. */
  workflow?: string | null;
}

/** What the trigger editor sends to create one. One of fireAt, cron or webhook. */
export interface TriggerInput {
  kind: 'reminder' | 'agent_task';
  title: string;
  text: string;
  agent?: string | null;
  repeat?: boolean;
  /** Local date-time ("2026-10-13T09:00:00") or one with an offset. */
  fireAt?: string;
  /** Recurring cron pattern, evaluated in the core's time zone. */
  cron?: string;
  /** True to fire on a webhook call instead of a schedule. */
  webhook?: boolean;
}

export interface TriggerPatchView {
  title?: string;
  text?: string;
  agent?: string | null;
  repeat?: boolean;
  fireAt?: string;
  cron?: string;
}

export interface HistoryMessage {
  id: number;
  role: MessageRole;
  agent: string;
  text: string;
  createdAt: string;
}

/** A file the user sent. The bytes are fetched from `/api/files/<id>`. */
export interface AttachmentView {
  id: string;
  kind: 'image' | 'audio' | 'video' | 'file';
  name: string;
  mime: string;
  size: number;
  /** What the models were given: image description, voice transcript, document text. */
  text: string;
  /** The user's own note about this file, when they wrote one. */
  caption: string;
  /** Set when the bytes were removed by media retention; the chat still shows the file. */
  deletedAt: string | null;
}

/** One entry of a chat as a client shows it. */
export interface ChatMessageView {
  id: number;
  role: MessageRole;
  agent: string;
  text: string;
  /** How this reply should sound when it is read aloud. */
  speech?: SpeechStyle;
  createdAt: string;
  attachments: AttachmentView[];
  /** Tools the agent called in this step. */
  tools: Array<{ name: string; summary: string }>;
  /** The message this one answers, as a small quote. */
  replyTo?: { id: number; role: MessageRole; agent: string; text: string } | null;
  /** Set when this message was forwarded from elsewhere. */
  forwardedFrom?: { from: string; chat: string } | null;
  /** Set when a workflow asks the user to approve something with this message. */
  approval?: ApprovalView | null;
  /** Set while the user has this message pinned. */
  pinned?: boolean;
  /** Emoji the user reacted with, in the order they were added. */
  reactions?: string[];
}

/** A pinned message, as the pin bar lists it. */
export interface PinView {
  id: number;
  sessionId: number;
  role: MessageRole;
  agent: string;
  text: string;
  createdAt: string;
}

export interface ApprovalView {
  id: number;
  status: 'pending' | 'approved' | 'rejected' | 'timeout' | 'expired';
  /** `<agent>/<name>` of the workflow that asked. */
  workflow: string;
  expiresAt: string;
  note?: string;
}

/**
 * A turn still streaming, so a client that opens (or returns to) its chat mid-turn can
 * rebuild the bubbles and cards shown so far instead of losing the answer. Sent with
 * `chat-history`; the events that follow continue the stream.
 */
export interface LiveTurnView {
  sessionId: number;
  agent: string;
  model: string;
  /** Everything the agent has typed so far. */
  text: string;
  /** How the answer should sound, once the voice direction line was known. */
  speech?: SpeechStyle;
  rounds: number;
  usage: UsageSnapshot;
  /** Tool calls of this turn, in order; `ok` is null while the tool is still running. */
  tools: Array<{ id: string; name: string; arg: string; risk: string | null; ok: boolean | null; output: string }>;
  /** Files the agent sent so far. */
  attachments: AttachmentView[];
  /** Permission questions that are still waiting for an answer. */
  pendingPermissions: PermissionRequest[];
}

/** One stretch of a chat; a new one starts by itself after a long silence. */
export interface SessionView {
  id: number;
  chatId: number;
  title: string;
  summary: string;
  auto: boolean;
  createdAt: string;
  lastMessageAt: string;
  /** When the user last opened this session; null = never opened. */
  readAt: string | null;
  /** True when messages arrived after `readAt` (a "ใหม่" badge in the list). */
  unread: boolean;
}

/** How full a session is: what the header meter and the "Context ของ session" panel show. */
export interface SessionContextView {
  /** Tokens the model was sent last time (real, from the provider) or an estimate of the next prompt. */
  usedTokens: number;
  /** The context window the percentage is measured against (the model's, after any cap). */
  windowTokens: number;
  /** Cache share of the input tokens over the whole session, 0..100; null before any call. */
  cacheHitPct: number | null;
  costUsd: number;
  /** Tokens said in the session so far, against maxTokens after which a new session starts. */
  conversationTokens: number;
  maxTokens: number;
}

/** A conversation: one agent, or a group of them. */
export interface ChatView {
  id: number;
  kind: 'direct' | 'group';
  title: string;
  /** Member agents; the first one answers when nobody is addressed. */
  agents: string[];
  lastMessageAt: string | null;
  /** Start of the latest message. */
  preview: string;
  /** True when the newest session has replies the user has not opened yet. */
  unread: boolean;
}

export type StatusKeyName = 'location' | 'outfit' | 'current_task' | 'mood' | 'situation';
/** What an agent says about itself right now. */
export type AgentStatusView = Partial<Record<StatusKeyName, string>>;

/** A skill of the skill hub. */
export interface SkillView {
  name: string;
  description: string;
  /** Model or preset the skill runs on; empty means the agent follows the instructions itself. */
  model: string;
  /** Tools the skill may use when it runs on its own model. */
  tools: string[];
  /** The instructions. */
  body: string;
  /** Ships with the app; editing it creates a user copy. */
  builtin?: boolean;
}

/** An entry of the model pool: a model plus sampling settings, referred to by name. */
/** How hard a model thinks before it answers (AI SDK's standard setting; each provider maps it). */
export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface PresetView {
  name: string;
  model: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  /** Reasoning effort; left out = the provider's default. */
  reasoning?: ReasoningEffort;
}

export interface SearchHit {
  messageId: number;
  chatId: number;
  sessionId: number;
  chatTitle: string;
  sessionTitle: string;
  role: MessageRole;
  agent: string;
  snippet: string;
  createdAt: string;
}

export interface Notification {
  /** `message`: an agent wrote in a chat the user was not looking at, or called notify_user. */
  kind: 'reminder' | 'task-result' | 'info' | 'approval' | 'message';
  title: string;
  body: string;
  triggerId?: number;
  /** The chat the message was posted in, when there is one. */
  chatId?: number;
  /** Row in the notification inbox, once stored. */
  id?: number;
}

/** Spending limit and notification choices, set on the settings page. */
export interface PreferencesView {
  /** Stop model calls once today's estimated cost reaches this (USD); unset = no limit. */
  dailyBudgetUsd?: number;
  /** Quiet hours ("22:00" to "07:00"): notifications go to the inbox but no push. */
  quietFrom?: string;
  quietTo?: string;
  /** Which kinds are pushed to devices; unset = reminders, task results and approvals. */
  pushKinds?: Array<Notification['kind']>;
  /** Approvals still push during quiet hours. */
  urgentApprovals?: boolean;
}

/** A stored notification, as the inbox shows it. */
export interface NotificationItem extends Notification {
  id: number;
  createdAt: string;
  read: boolean;
}

/** A browser that receives push messages. */
export interface PushDeviceView {
  endpoint: string;
  /** The push service's host (fcm.googleapis.com, web.push.apple.com…). */
  service: string;
  label: string;
  createdAt: string;
  lastOkAt: string | null;
}

/**
 * One model per capability, as `provider/model`. An agent may use a different model for
 * each: `model` talks, `vision_model` looks at images, `transcript_model` turns speech
 * into text, `small_model` does cheap background work (summaries, memory). `image_model`,
 * `speech_model` and `video_model` make pictures, spoken audio and videos (no fallback:
 * a chat model cannot make them).
 */
export interface ModelChoice {
  model?: string;
  small_model?: string;
  vision_model?: string;
  transcript_model?: string;
  image_model?: string;
  speech_model?: string;
  video_model?: string;
}

/** The built-in helper that sets up agents, tools, skills and workflows for the user. */
export interface OverseerView {
  name: string;
  displayName: string;
  /** True once a chat model was chosen and its provider is connected. */
  configured: boolean;
  /** The model string in `agent.md` (empty until chosen). */
  model: string;
  /** The provider of that model is connected on this machine. */
  providerConnected: boolean;
}

/** An agent as the agent editor shows and saves it. */
export interface AgentView {
  name: string;
  /** Name shown in chats; empty means the id is shown. */
  displayName?: string;
  description: string;
  /** Card the other agents see. */
  intro?: string;
  /** Reasoning effort of its chat model. */
  effort?: ReasoningEffort;
  systemPrompt: string;
  models: ModelChoice;
  tools: string[];
  /** Agents this one may message. */
  canMessage: string[];
  budgets: { maxRounds: number; maxTokens: number };
  /** Skills from the skill hub this agent may use. */
  skills?: string[];
  /** Read-only: the current status, and a version stamp per picture that exists. */
  status?: AgentStatusView;
  avatar?: string | null;
  portrait?: string | null;
  /** Expression pictures by emoji key (see SPRITE_KEY), each with a version. */
  sprites?: Record<string, string>;
  /** How the agent is shown: a static picture (sprite) or a 3D VRM model. */
  character?: 'sprite' | 'vrm';
  /** The motion that loops by default while the VRM stands idle (a Mixamo clip name). */
  idleMotion?: string | null;
  /** Read-only: version stamp of the VRM model, null when there is none. */
  model?: string | null;
  /** Read-only: the uploaded motion clips (Mixamo FBX files). */
  motions?: MotionView[];
}

/** A motion clip of an agent's VRM, as the editor lists it. */
export interface MotionView {
  name: string;
  version: string;
}

export interface ToolView {
  name: string;
  description: string;
  risk: string;
  target: 'core' | 'pc';
  /** False for tools the user added to the pool. */
  builtin: boolean;
  /** Settings the tool accepts; empty means it cannot be made into a preset. */
  settings: ToolSettingField[];
  /** The presets that instantiate this tool. */
  presets?: string[];
  /** The MCP server the tool comes from. */
  mcp?: string;
  /** For connector tools: the service key (`slack`). */
  connector?: string;
  /** For connector tools: the operation key (`send_message`). */
  operation?: string;
  /** Grouping label for Quick Work, e.g. "Slack". */
  familyLabel?: string;
  /** Connector category for Quick Work filtering, e.g. "communication". */
  connectorCategory?: string;
}

/** What the tools screen shows: the whole pool, the presets and the custom definitions. */
export interface ToolPoolView {
  tools: ToolView[];
  presets: ToolPreset[];
  custom: CustomToolSpec[];
  /** Per preset: which `secret`-type setting has a value stored in this machine's vault. */
  secretKeys: Record<string, string[]>;
  /** MCP servers and the tools each one offers. */
  mcp?: McpServerView[];
  /** Native connector specs and their credential state, for the service node and hub. */
  connectors?: ConnectorView[];
  /** Stored connector credentials (never their values). */
  connections?: ConnectorConnectionView[];
}

import type { KnowledgeCollectionView, KnowledgeDocumentView, KnowledgeHit, UserProfileView, WardrobeOutfitView, BackgroundView, BackgroundSettingsView, GalleryItemView } from './knowledge.ts';

/** The importer's account of a migration (n8n, Make or Zapier). */
export interface ImportReportView {
  source: string | string[];
  workflows: Array<{ name: string; title: string; trigger: string; nodes: number }>;
  warnings: string[];
  unsupported: Array<{ node?: string; module?: string; step?: string; type?: string; api?: string; action?: string; reason: string }>;
  redacted: Array<{ node?: string; module?: string; step?: string; field: string }>;
  mapped?: Array<{
    node?: string;
    module?: string;
    step?: string;
    connector: string;
    operation: string;
    fields: string[];
    confidence: 'high' | 'medium';
  }>;
  connections?: Array<{
    node?: string;
    module?: string;
    step?: string;
    connector: string;
    credentialType?: string;
    credentialName?: string;
    connectionId?: string;
    authenticationId?: string;
  }>;
  models?: Array<{ node: string; model: string }>;
  prompts?: Array<{ node: string; text: string }>;
}

/** Kept for compatibility: the n8n report is a migration report. */
export type N8nImportReportView = ImportReportView;

/** Workflow types live in ./workflows.ts; re-exported so clients import them from here. */
import type {
  FlowItem,
  JsonValue,
  NodeTypeView,
  TriggerPoolView,
  WorkflowNode,
  WorkflowNodeTestResult,
  WorkflowRunRecord,
  WorkflowRunResult,
  WorkflowRunSummary,
  WorkflowView,
} from './workflows.ts';
export type {
  FlowItem,
  JsonValue,
  NodeTypeName,
  NodeTypeView,
  TriggerPoolView,
  WorkflowNode,
  WorkflowNodeTestResult,
  WorkflowRunNodeView,
  WorkflowRunRecord,
  WorkflowRunResult,
  WorkflowRunSummary,
  WorkflowView,
} from './workflows.ts';
export { BUILTIN_TRIGGERS, NODE_TYPES, OPERATORS } from './workflows.ts';

/** How much disk the user's own space is using, and what they allow for each part. */
export interface StorageView {
  /** Files and pictures sent in chats (bytes still on disk); removed after `retentionDays`. */
  media: { usedBytes: number; quotaBytes: number; files: number };
  /** The user's own pictures and models (agent images, backdrops, outfits, gallery); kept until the user deletes them. */
  userMedia: { usedBytes: number; quotaBytes: number };
  /** Chat text and attachment text kept in the database; never deleted by retention. */
  chat: { usedBytes: number; quotaBytes: number; messages: number };
  /** Chat media older than this many days is removed automatically (user media is not). */
  retentionDays: number;
}

/** What the settings screen shows. Secrets never travel in this direction: only "is it set". */
export interface SettingsView {
  /** Providers that are connected (have a credential) or were added in the app. */
  providers: Array<{
    id: string;
    name: string;
    baseURL: string | null;
    /** True when a credential exists, so the provider can be called. */
    connected: boolean;
    /** Not in the models.dev catalog: added by hand with its own URL. */
    custom: boolean;
    models: number;
    /** The model ids it offers, for the edit form. */
    modelIds: string[];
  }>;
  /** Every provider of the models.dev catalog, to pick from when adding one. */
  catalog: Array<{ id: string; name: string; baseURL: string | null }>;
  /**
   * Models of the connected providers, with what each can take and make (`text`, `image`,
   * `audio`, `video`, `pdf`). `input` / `output` are absent when the catalog does not say:
   * unknown abilities, so a picker still offers the model.
   */
  models: Array<{ ref: string; label: string; type?: string; input?: string[]; output?: string[] }>;
  /** Default model per capability, used by agents that leave that capability empty. */
  defaults: ModelChoice;
  /** The model pool. A preset name can be used wherever a model is chosen. */
  presets: PresetView[];
  /** How many agents exist. */
  agents: number;
  allowedDirs: string[];
  google: { hasClient: boolean; connected: boolean };
  /** Outlook mail, calendar and To Do: `hasClient` once the Azure app's client ID is saved. */
  microsoft: { hasClient: boolean; connected: boolean; hasSecret?: boolean };
  /**
   * On a server: the address OAuth providers send the browser back to, which has to be
   * registered with the Google / Azure app. Absent on a computer (temporary local port).
   */
  oauthRedirectUri?: string;
  /** Every OAuth account (Google / Microsoft) with its own client and token. */
  accounts: OAuthAccountView[];
  /** Spending limit and notification choices, plus what was spent today. */
  preferences: PreferencesView;
  spentTodayUsd: number;
  /** Disk use and the user's quotas for chat media and chat text. */
  storage: StorageView;
  /** Which API keys of the web tools are set (never the keys themselves). */
  toolKeys: { serper: boolean; openweather: boolean };
  /** A chat that stays silent this long starts a new session with its next message. */
  sessionIdleMinutes: number;
  /** A session this long (tokens of conversation) is followed by a new one; 0 = no limit. */
  sessionMaxTokens: number;
  /** Share of the context window at which older messages are summarized automatically (0..1). */
  compactAt: number;
  /** False until an agent exists and its chat model's provider is connected. */
  ready: boolean;
}

/**
 * Connects a provider the way opencode's `/connect` does: pick one from the catalog or
 * name your own and give its URL, hand over the API key, and the core lists the
 * provider's models and stores the credential.
 */
export interface ProviderConnect {
  /** Catalog id (e.g. "opencode", "deepseek") or a new id for a custom provider. */
  id: string;
  /** Display name for a custom provider. */
  name?: string;
  /** API base URL. Required for a custom provider; overrides the catalog's URL otherwise. */
  baseURL?: string;
  /** Omit to keep the stored credential (when only refreshing the model list). */
  apiKey?: string;
  /** Model ids typed by hand, for endpoints that cannot list their models. */
  models?: string[];
}

export interface SettingsChange {
  /** Account and tool keys (environment variable name -> value); an empty value removes one. */
  keys?: Record<string, string>;
  /** Default model per capability; an empty string clears one. */
  defaults?: ModelChoice;
  allowedDirs?: string[];
  /** Quotas in megabytes; 0 restores the default. */
  storage?: { mediaQuotaMb?: number; userMediaQuotaMb?: number; chatQuotaMb?: number };
  /** Session rollover: minutes of silence, and tokens of conversation (0 = no limit). */
  session?: { idleMinutes?: number; maxTokens?: number };
}

export interface MemoryView {
  path: string;
  layer: 1 | 2;
  description: string;
  content: string;
  updatedAt: string;
}

/** Sent by UI clients. */
export type ClientMessage =
  | { type: 'hello'; role: 'client'; token: string; name?: string }
  | { type: 'send'; text: string; agent?: string }
  /** Stops the turn of this chat; without a chat id, stops every running turn. */
  | { type: 'abort'; chatId?: number }
  /** Keepalive, answered with `pong`; the client reconnects when no answer comes. */
  | { type: 'ping' }
  | { type: 'permission-response'; requestId: string; allow: boolean }
  | { type: 'history'; beforeId?: number; limit?: number }
  /** Asks for the active triggers so the device can set its own alarms. */
  | { type: 'triggers-sync' }
  | { type: 'settings-get' }
  | ({ type: 'settings-save' } & SettingsChange)
  | ({ type: 'provider-connect' } & ProviderConnect)
  /** Edits a provider without touching its credential: name, base URL, model list. */
  | { type: 'provider-update'; id: string; name?: string; baseURL?: string; models?: string[] }
  /** Forgets the credential and, for a provider added in the app, the provider itself. */
  | { type: 'provider-remove'; id: string }
  /** Starts the Google sign-in; the core answers with the link to open. */
  | { type: 'google-connect' }
  /** Starts the Microsoft sign-in; the core answers with the link to open. */
  | { type: 'microsoft-connect' }
  /** The OAuth account hub: list, add/edit, remove, choose default, connect one. */
  | { type: 'oauth-accounts' }
  | { type: 'oauth-account-save'; account: OAuthAccountInput; id?: string }
  | { type: 'oauth-account-remove'; id: string }
  | { type: 'oauth-account-default'; id: string }
  | { type: 'oauth-account-connect'; id: string }
  /** Native connector connections (API key, bot token, PAT, OAuth2). */
  | { type: 'connector-connections' }
  | { type: 'connector-connection-save'; connection: ConnectorConnectionInput; id?: string }
  | { type: 'connector-connection-remove'; id: string }
  | { type: 'connector-connection-default'; id: string }
  | { type: 'connector-connection-test'; connector: string; operation: string; input: Record<string, unknown>; account?: string }
  /** Starts the generic OAuth2 authorization-code flow for a connection. */
  | { type: 'connector-connection-connect'; id: string }
  /** Loads choices for a select field (`optionsFrom`) by running a read operation. */
  | { type: 'connector-operation-options'; reqId: number; connector: string; operation: string; labelField: string; valueField: string; input?: Record<string, unknown>; account?: string }
  | { type: 'agents-list' }
  /** The built-in AI Overseer; created on first use. */
  | { type: 'overseer-get' }
  /** Chooses the model the Overseer runs on (its provider must be connected first). */
  | { type: 'overseer-save'; model: string }
  /** Creates or replaces an agent. `renameFrom` is the old name when the name changed. */
  | { type: 'agent-save'; agent: AgentView; renameFrom?: string }
  | { type: 'agent-delete'; name: string }
  | { type: 'memory-list' }
  | { type: 'memory-save'; path: string; description?: string; content: string }
  | { type: 'memory-delete'; path: string }
  | { type: 'chats-list' }
  | { type: 'chat-create'; kind: 'direct' | 'group'; agents: string[]; title?: string }
  | { type: 'chat-update'; chatId: number; title?: string; agents?: string[] }
  | { type: 'chat-delete'; chatId: number }
  /** Asks for a session of a chat (the latest one by default) and its messages. */
  | { type: 'chat-open'; chatId: number; sessionId?: number; beforeId?: number }
  /** Sends a message to a chat. `attachments` are ids returned by `POST /api/upload`. */
  | { type: 'chat-send'; chatId: number; text: string; attachments?: string[]; replyTo?: number; forward?: { from: string; chat: string } }
  /** Starts a new session by hand; the next message goes there. */
  | { type: 'session-new'; chatId: number }
  /** Asks for the size, cache hit and cost of a session (the latest by default). */
  | { type: 'session-context'; chatId: number; sessionId?: number }
  /** Pins a message (or removes the pin). */
  | { type: 'message-pin'; messageId: number; pinned: boolean }
  /** Adds the emoji as a reaction to a message, or takes it away when it is already there. */
  | { type: 'message-react'; messageId: number; emoji: string }
  /** Takes the conversation back to just before a message of the user; that message and everything after it is hidden. */
  | { type: 'rewind'; sessionId: number; messageId: number }
  /** Searches every session of every chat. */
  | { type: 'search'; query: string }
  | { type: 'skills-list' }
  | { type: 'skill-save'; skill: SkillView; renameFrom?: string }
  | { type: 'skill-delete'; name: string }
  | { type: 'tools-list' }
  /** Adds or replaces a custom tool in the pool. `renameFrom` is the old name when it changed. */
  | { type: 'tool-save'; tool: CustomToolSpec; renameFrom?: string }
  | { type: 'tool-delete'; name: string }
  /** Adds or replaces a tool preset (a configured instance of a pool tool). */
  | { type: 'tool-preset-save'; preset: ToolPreset; secrets?: Record<string, string>; renameFrom?: string }
  | { type: 'tool-preset-delete'; name: string }
  | { type: 'mcp-save'; server: McpServerSpec; renameFrom?: string }
  | { type: 'mcp-delete'; name: string }
  | { type: 'mcp-refresh'; name: string }
  /** The vault of API keys: names only, never values. */
  | { type: 'secrets-list' }
  /** Stores or (with an empty value) removes secrets by name. */
  | { type: 'secrets-save'; values: Record<string, string> }
  | { type: 'workflows-list'; agent?: string }
  /** Creates or replaces a workflow file under workflows/<agent>/; its schedule stays in step. */
  | { type: 'workflow-save'; workflow: WorkflowView; renameFrom?: string }
  | { type: 'workflow-delete'; agent: string; name: string }
  /** Runs a workflow by hand with optional input JSON; the answer comes back as `workflow-result`. */
  | { type: 'workflow-run'; agent: string; name: string; input?: Record<string, JsonValue>; pins?: boolean }
  /** Runs again from one node with what it got in an earlier run (the nodes before it are not run). */
  | { type: 'workflow-run-from'; agent: string; name: string; nodeId: string; runId: number }
  /** What an expression gives for sample data (the editor's preview line). */
  | {
      type: 'workflow-expr-preview';
      reqId: number;
      text: string;
      json: Record<string, JsonValue>;
      nodes?: Record<string, { json: Record<string, JsonValue>; items: Array<Record<string, JsonValue>> }>;
      vars?: Record<string, JsonValue>;
    }
  /** Runs one node alone with sample items, to see what it produces (draft config is fine). */
  | { type: 'workflow-test-node'; workflow: WorkflowView; node: WorkflowNode; input: FlowItem[] }
  /** Converts an n8n, Make or Zapier export (JSON text); `save` writes the result as disabled workflows of `agent`. */
  | {
      type: 'workflow-import-n8n' | 'workflow-import-make' | 'workflow-import-zapier';
      agent: string;
      json: string;
      save: boolean;
      reqId?: number;
    }
  /** The notification inbox; `notifications-read` without ids marks everything read. */
  | { type: 'notifications-list' }
  | { type: 'notifications-read'; ids?: number[] }
  /** Which chat this client shows, and whether its window is on screen (decides "message" notifications). */
  | { type: 'presence'; chatId: number | null; visible: boolean }
  /** Push messages to this browser: the server key, (un)subscribe, list, test. */
  | { type: 'push-key' }
  | { type: 'push-subscribe'; subscription: { endpoint: string; keys: { p256dh: string; auth: string } }; label: string }
  | { type: 'push-unsubscribe'; endpoint: string }
  | { type: 'push-devices' }
  | { type: 'push-test' }
  | { type: 'preferences-save'; preferences: PreferencesView }
  /** Screen settings shared by all the user's devices (null removes one). */
  | { type: 'ui-set'; values: Record<string, string | null> }
  /** Backups of the user folder: list, make one now (download with GET /api/backups/<name>). */
  | { type: 'backups-list' }
  | { type: 'backup-create'; includeSecrets: boolean }
  /** The user's profile (key/value facts and who may see them). */
  | { type: 'profile-get' }
  | { type: 'profile-save'; profile: UserProfileView }
  /** Knowledge bases: list, create / edit, delete. */
  | { type: 'knowledge-list' }
  | { type: 'gallery-list'; agent: string; query?: string; offset?: number; limit?: number }
  | { type: 'gallery-update'; agent: string; id: string; title?: string; tags?: string[]; description?: string }
  | { type: 'gallery-delete'; agent: string; id: string }
  | { type: 'backgrounds-list' }
  | { type: 'background-save'; background: { id: string; name?: string; keywords?: string[] }; renameFrom?: string }
  | { type: 'background-delete'; id: string }
  /** Chooses the backdrop: for one agent, or (no agent) for the whole app. */
  | { type: 'background-select'; agent?: string; choice: string }
  | { type: 'wardrobe-list' }
  /** Saves an outfit; `renameFrom` moves an existing one to a new id. */
  | { type: 'wardrobe-save'; outfit: { id: string; name?: string; description?: string }; renameFrom?: string }
  | { type: 'wardrobe-delete'; id: string }
  | { type: 'knowledge-save'; collection: { name: string; title?: string; description?: string; embeddingModel?: string | null; agents?: string[] } }
  | { type: 'knowledge-delete'; name: string }
  | { type: 'knowledge-documents'; collection: string }
  /** Adds one source: typed text, a file in the allowed folders, a URL, or an uploaded attachment. */
  | { type: 'knowledge-add'; collection: string; title?: string; text?: string; path?: string; url?: string; attachmentId?: string }
  | { type: 'knowledge-remove-document'; collection: string; id: number }
  | { type: 'knowledge-search'; query: string; collection?: string }
  /** Makes the missing vectors of a collection (after choosing or changing its embedding model). */
  | { type: 'knowledge-embed'; collection: string }
  /** Answers a workflow's approval request (the buttons under its chat message). */
  | { type: 'approval-decide'; id: number; approved: boolean; note?: string }
  /** The run history of one workflow (newest first); answered with `workflow-runs`. */
  | { type: 'workflow-runs'; agent: string; name: string }
  /** One stored run with its node input/output; answered with `workflow-run-record`. */
  | { type: 'workflow-run-get'; id: number }
  /** Adds or edits a trigger type in the pool (kinds: poll follow url/method/headers). */
  | { type: 'trigger-pool-save'; entry: TriggerPoolView }
  | { type: 'trigger-pool-delete'; name: string }
  | { type: 'preset-save'; preset: PresetView; renameFrom?: string }
  | { type: 'preset-delete'; name: string }
  | { type: 'status-set'; agent: string; key: StatusKeyName; value: string }
  | { type: 'triggers-list' }
  | { type: 'trigger-create'; trigger: TriggerInput }
  | { type: 'trigger-update'; id: number; patch: TriggerPatchView }
  | { type: 'trigger-delete'; id: number }
  /** Fires a trigger right now (also used to test a webhook by hand). */
  | { type: 'trigger-run'; id: number }
  | { type: 'trigger-cancel'; id: number }
  /** The push-mail watcher: list, save (with an optional new password), remove, check now. */
  | { type: 'mail-watch' }
  | { type: 'mail-watch-save'; account: MailWatchAccount; password?: string }
  | { type: 'mail-watch-delete'; id: string }
  | { type: 'mail-watch-check' };

/** Sent by the PC agent. */
export type PcMessage =
  | { type: 'hello'; role: 'pc'; token: string; name?: string; allowedDirs: string[]; tools: string[] }
  | { type: 'tool-result'; id: string; ok: boolean; output: string };

/** Sent by the core to UI clients. */
export type ServerMessage =
  | {
      type: 'welcome';
      agents: Array<{ name: string; displayName?: string; description: string }>;
      /** Empty when no agent exists yet. */
      defaultAgent: string;
      pcOnline: boolean;
      busy: boolean;
      /** The chat a turn is running in right now, if any. */
      busyChat?: number | null;
      /** Every chat with a turn running right now (turns in different chats run in parallel). */
      busyChats?: number[];
      pendingPermissions: PermissionRequest[];
      /** Screen settings shared by all the user's devices (character position, sounds, …). */
      ui?: Record<string, string>;
    }
  /** Shared screen settings that changed on another device (null: removed). */
  | { type: 'ui'; values: Record<string, string | null> }
  | { type: 'event'; event: AgentEvent }
  /** A turn started by one client, echoed so every client shows it. */
  | { type: 'user-message'; text: string; agent: string }
  | { type: 'history'; messages: HistoryMessage[] }
  | { type: 'permission-resolved'; requestId: string; decision: PermissionDecision }
  | { type: 'notification'; notification: Notification }
  | { type: 'triggers'; triggers: TriggerInfo[] }
  | { type: 'pc-status'; online: boolean; name?: string }
  | { type: 'settings'; settings: SettingsView; saved?: boolean }
  | { type: 'google-auth-url'; url: string }
  | { type: 'microsoft-auth-url'; url: string }
  /** The OAuth account hub list. */
  | { type: 'oauth-accounts'; accounts: OAuthAccountView[]; saved?: boolean }
  /** Sign-in link for one account; `accountId` tells the hub where to show it. */
  | { type: 'oauth-auth-url'; accountId: string; service: 'google' | 'microsoft'; url: string }
  /** Connector connections plus the specs they belong to. */
  | { type: 'connector-connections'; connections: ConnectorConnectionView[]; connectors: ConnectorView[]; saved?: boolean }
  /** The provider page for a generic OAuth2 connection; the callback stores the tokens. */
  | { type: 'connector-auth-url'; connectionId: string; url: string }
  /** Result of testing one operation with stored credentials; never includes the credential. */
  | { type: 'connector-test-result'; ok: boolean; message: string }
  /** Options for a connector select field; values are opaque ids from the provider. */
  | { type: 'connector-options'; reqId: number; ok: boolean; options: Array<{ value: string; label: string }>; error?: string }
  /** The agents, plus what the editor offers: tools and the effective default models. */
  | { type: 'agents'; agents: AgentView[]; tools: ToolView[]; defaultAgent: string | null; saved?: string }
  /** The AI Overseer setup; `saved` after choosing its model. */
  | { type: 'overseer'; overseer: OverseerView; saved?: boolean }
  | { type: 'memory'; entries: MemoryView[] }
  | { type: 'chats'; chats: ChatView[] }
  | {
      type: 'chat-history';
      chat: ChatView;
      /** Null while the chat has no session yet. */
      session: SessionView | null;
      sessions: SessionView[];
      messages: ChatMessageView[];
      /** True when the list continues before the first message returned. */
      hasMore: boolean;
      /** Set when this answers a request for older messages. */
      beforeId?: number;
      /** Every pinned message of the chat, newest pin first. */
      pins?: PinView[];
      /** A turn still streaming in this chat, to rebuild while it continues. */
      live?: LiveTurnView | null;
    }
  /** A message was pinned or unpinned, or its reactions changed. */
  | { type: 'message-marks'; chatId: number; sessionId: number; messageId: number; pinned: boolean; reactions: string[]; pins: PinView[] }
  /** A turn landed in this session; `started` when the session was opened for it. */
  | { type: 'chat-session'; chatId: number; session: SessionView; started: boolean }
  | { type: 'session-context'; chatId: number; sessionId: number; context: SessionContextView }
  | { type: 'chat-message'; chatId: number; sessionId: number; message: ChatMessageView }
  | { type: 'chat-event'; chatId: number; sessionId: number; agent: string; event: AgentEvent }
  /** A turn started (`done` unset) or finished (`done: true`) in this chat; turns in different chats run in parallel. */
  | { type: 'busy'; chatId: number | null; done?: boolean }
  /** Answer to a client `ping`. */
  | { type: 'pong' }
  /** Messages of a session were hidden or added outside a turn; clients showing it reload it. */
  | { type: 'chat-changed'; chatId: number; sessionId: number }
  /** Answer to `rewind`: the text of the message that was taken back, to edit and resend. */
  | { type: 'rewound'; chatId: number; sessionId: number; text: string; restored?: string[]; skipped?: string[] }
  | { type: 'search-results'; query: string; hits: SearchHit[] }
  | { type: 'skills'; skills: SkillView[]; saved?: string }
  /** The tool pool, its presets and the custom tool definitions. */
  | ({ type: 'tools' } & ToolPoolView & { saved?: string })
  | { type: 'workflow-expr-preview'; reqId: number; ok: boolean; value?: string; error?: string }
  /** Secret names stored in this machine's vault (values are never sent). */
  | { type: 'secrets'; names: string[] }
  | { type: 'workflows'; workflows: WorkflowView[]; pool: TriggerPoolView[]; nodeTypes: NodeTypeView[]; saved?: string }
  /** Answer to a manual `workflow-run`, with every node's input and output. */
  | { type: 'workflow-result'; result: WorkflowRunResult }
  /** Answer to `workflow-test-node`: the tested node's input and per-output items. */
  | { type: 'workflow-node-result'; result: WorkflowNodeTestResult }
  | { type: 'workflow-runs'; workflow: string; runs: WorkflowRunSummary[] }
  | { type: 'knowledge'; collections: KnowledgeCollectionView[]; saved?: string }
  | { type: 'wardrobe'; outfits: WardrobeOutfitView[]; saved?: string }
  | { type: 'gallery'; agent: string; query: string; offset: number; total: number; items: GalleryItemView[] }
  /** A picture was added, changed or removed (the manager asks for the list again). */
  | { type: 'gallery-changed'; agent: string }
  | { type: 'backgrounds'; items: BackgroundView[]; settings: BackgroundSettingsView; saved?: string }
  | { type: 'profile'; profile: UserProfileView; saved?: boolean }
  | { type: 'notifications'; items: NotificationItem[]; unread: number }
  | { type: 'backups'; backups: Array<{ name: string; bytes: number; createdAt: string }>; dir: string; created?: string }
  | { type: 'push-key'; publicKey: string }
  | { type: 'push-devices'; devices: PushDeviceView[]; tested?: number }
  /** What a migration import produced (a preview, or what was saved and what failed). */
  | {
      type: 'workflow-import';
      agent: string;
      source: 'n8n' | 'make' | 'zapier';
      reqId?: number;
      saved: boolean;
      workflows: WorkflowView[];
      report: ImportReportView;
      errors: string[];
    }
  | { type: 'knowledge-documents'; collection: string; documents: KnowledgeDocumentView[] }
  | { type: 'knowledge-added'; collection: string; documentId: number; chunks: number; warning?: string }
  | { type: 'knowledge-results'; query: string; hits: KnowledgeHit[] }
  | { type: 'knowledge-embedded'; collection: string; count: number }
  | { type: 'workflow-run-record'; run: WorkflowRunRecord }
  | { type: 'status'; agent: string; status: AgentStatusView }
  | { type: 'error'; message: string; chatId?: number }
  /** The push-mail watcher: watched accounts and when they were last checked. */
  | {
      type: 'mail-watch';
      accounts: MailWatchAccount[];
      lastCheckedAt: string | null;
      /** Set when this answers a manual `mail-watch-check`. */
      checked?: { found: number; at: string };
    };

/** A mailbox the push-mail watcher looks at. Passwords never travel over the socket. */
export type MailWatchAccount =
  | { id: string; kind: 'google'; query: string }
  | { id: string; kind: 'microsoft'; query: string }
  | { id: string; kind: 'imap'; host: string; port: number; tls: boolean; user: string; query?: string }
  | { id: string; kind: 'pop3'; host: string; port: number; tls: boolean; user: string };

/** Sent by the core to the PC agent. */
export type PcRequest = {
  type: 'tool-exec';
  id: string;
  tool: string;
  input: unknown;
  traceId: string;
  thread: string;
  agent: string;
};
