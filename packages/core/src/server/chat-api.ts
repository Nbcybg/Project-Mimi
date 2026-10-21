import type {
  AgentEvent,
  ChatMessageView,
  ChatView,
  ClientMessage,
  MessageRole,
  PinView,
  PresetView,
  SearchHit,
  ServerMessage,
  SessionView,
  SkillView,
  StoredMessage,
} from '@mimi/shared';
import { REASONING_EFFORTS, type ReasoningEffort } from '@mimi/shared';
import { saveAgent } from '../agents/loader.ts';
import type { AppSettings } from '../app/app-settings.ts';
import type { AgentImages } from '../chat/agent-images.ts';
import { stripAttachments } from '../chat/attachments.ts';
import type { Chat, Session } from '../chat/chat-store.ts';
import { STATUS_KEYS } from '../chat/state-store.ts';
import type { CoreConfig } from '../config.ts';
import type { Core } from '../core.ts';
import { type ModelRef, parseModelRef } from '../providers/registry.ts';
import { deleteSkill, readSkillBody, saveSkill } from '../skills/skills.ts';
import { toTriggerInfo } from '../scheduler/triggers.ts';
import { toAttachmentView } from './http-api.ts';

export interface ChatApiContext {
  core: Core;
  config: CoreConfig;
  appSettings: AppSettings;
  images: AgentImages;
  broadcast(message: ServerMessage): void;
  /** An agent finished a reply in a chat; notifies the user when nobody is looking at that chat. */
  agentSpoke?(chatId: number, agent: string, text: string): void;
  /** Resolves a model string (preset name or `provider/model`); throws when it is unknown. */
  modelRef(name: string): ModelRef;
  /** Queues a turn; turns run one at a time. The job is given the signal that `abort` fires. */
  enqueue(chatId: number, job: (signal: AbortSignal) => Promise<void>): void;
  busy(): boolean;
  /** Forwards permission decisions found in an event to every client. */
  resolved(event: AgentEvent): void;
  /** Tells every client that settings or agents changed. */
  settingsChanged(): void;
  agentsChanged(): void;
}

type Reply = (message: ServerMessage) => void;

const PAGE_SIZE = 120;
const PREVIEW_LENGTH = 90;
const SNIPPET_RADIUS = 70;
const PRESET_NAME = /^[a-z0-9][a-z0-9_-]*$/;

function snippet(text: string, term: string): string {
  const flat = text.replace(/\s+/g, ' ');
  const at = Math.max(flat.toLowerCase().indexOf(term.toLowerCase()), 0);
  const start = Math.max(at - SNIPPET_RADIUS, 0);
  const end = Math.min(at + term.length + SNIPPET_RADIUS, flat.length);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * Everything the chat-based client asks for over the socket: chats and their sessions,
 * sending, going back, search, and the hubs (skills, model pool, triggers).
 */
export function createChatApi(context: ChatApiContext) {
  const { core, config, appSettings, broadcast } = context;
  const { chats } = core;
  const messages = core.deps.messages;

  const sessionView = (session: Session): SessionView => ({
    id: session.id,
    chatId: session.chatId,
    title: session.title,
    summary: session.summary,
    auto: session.auto,
    createdAt: session.createdAt,
    lastMessageAt: session.lastMessageAt,
  });

  const chatView = (chat: Chat): ChatView => {
    const [latest] = chats.sessions(chat.id, 1);
    const [last] = latest ? messages.page(latest.thread, undefined, 1) : [];
    return {
      id: chat.id,
      kind: chat.kind,
      title: chat.title,
      agents: chat.agents,
      lastMessageAt: last ? last.createdAt : null,
      preview: last ? stripAttachments(last.text).replace(/\s+/g, ' ').slice(0, PREVIEW_LENGTH) : '',
    };
  };
  const chatsMessage = (): ServerMessage => ({ type: 'chats', chats: chats.listChats().map(chatView) });

  const toolsOf = (message: StoredMessage): ChatMessageView['tools'] => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
    const calls = (message.content as Array<{ type?: string; toolName?: unknown; input?: unknown }>).filter(
      (part) => part?.type === 'tool-call',
    );
    return calls.map((call) => {
      const name = String(call.toolName);
      let summary = '';
      try {
        const tool = core.deps.tools.get(name);
        const parsed = tool?.inputSchema.safeParse(call.input);
        summary = tool && parsed?.success ? tool.summarize(parsed.data) : JSON.stringify(call.input ?? {});
      } catch {
        summary = '';
      }
      return { name, summary: summary.slice(0, 200) };
    });
  };

  const messageViews = (rows: StoredMessage[]): ChatMessageView[] => {
    // The user's files, and the files agents sent (under the message whose tool sent them).
    const files = core.attachments.forMessages(rows.filter((row) => row.role !== 'tool').map((row) => row.id));
    const quoted = new Map<number, { id: number; role: MessageRole; agent: string; text: string }>();
    for (const row of rows) {
      if (row.replyTo === undefined || quoted.has(row.replyTo)) continue;
      const original = messages.get(row.replyTo);
      if (original) {
        quoted.set(row.replyTo, {
          id: original.id,
          role: original.role,
          agent: original.agent,
          text: stripAttachments(original.text).replace(/\s+/g, ' ').slice(0, 160),
        });
      }
    }
    const views: ChatMessageView[] = [];
    const approvals = core.approvals.byMessages(rows.map((row) => row.id));
    for (const row of rows) {
      const tools = toolsOf(row);
      const text = row.role === 'user' ? stripAttachments(row.text) : row.text;
      const attachments = (files.get(row.id) ?? []).map(toAttachmentView);
      const replyTo = row.replyTo !== undefined ? (quoted.get(row.replyTo) ?? null) : null;
      const forwardedFrom = row.forwardFrom ? { from: row.forwardFrom, chat: row.forwardChat ?? '' } : null;
      if (!text && tools.length === 0 && attachments.length === 0) continue;
      const approval = approvals.get(row.id) ?? null;
      views.push({ id: row.id, role: row.role, agent: row.agent, text, speech: row.speech, createdAt: row.createdAt, attachments, tools, replyTo, forwardedFrom, approval, pinned: row.pinnedAt !== undefined, reactions: row.reactions ?? [] });
    }
    return views;
  };

  const pinsOf = (chat: Chat): PinView[] => {
    const sessions = chats.sessions(chat.id, 200);
    const byThread = new Map(sessions.map((session) => [session.thread, session.id]));
    return messages.pinned([...byThread.keys()]).map((row) => ({
      id: row.id,
      sessionId: byThread.get(row.thread) ?? 0,
      role: row.role,
      agent: row.agent,
      text: (row.role === 'user' ? stripAttachments(row.text) : row.text).replace(/\s+/g, ' ').slice(0, 160),
      createdAt: row.createdAt,
    }));
  };

  const historyMessage = (chatId: number, sessionId?: number, beforeId?: number): ServerMessage => {
    const chat = chats.getChat(chatId);
    if (!chat) throw new Error(`Chat #${chatId} does not exist.`);
    const sessions = chats.sessions(chat.id, 200);
    const session = sessionId === undefined ? sessions[0] : sessions.find((entry) => entry.id === sessionId);
    if (sessionId !== undefined && !session) throw new Error(`Session #${sessionId} does not exist.`);
    const rows = session ? messages.timeline(session.thread, beforeId, PAGE_SIZE + 1) : [];
    const hasMore = rows.length > PAGE_SIZE;
    return {
      type: 'chat-history',
      chat: chatView(chat),
      session: session ? sessionView(session) : null,
      sessions: sessions.map(sessionView),
      messages: messageViews(hasMore ? rows.slice(1) : rows),
      hasMore,
      beforeId,
      pins: pinsOf(chat),
    };
  };

  const checkMembers = (names: string[]): string[] => {
    const known = core.agents.names();
    const members = [...new Set(names.map(String))];
    for (const name of members) if (!known.includes(name)) throw new Error(`Agent "${name}" does not exist.`);
    return members;
  };

  const runTurn = async (
    chatId: number,
    turn: { text: string; attachments: string[]; replyTo?: number; forward?: { from: string; chat: string } },
    signal: AbortSignal,
    /** Runs once the user's message is stored (or the turn ends without storing it). */
    afterStored?: () => void,
  ) => {
    let sessionId = 0;
    let stored = false;
    const markStored = () => {
      if (stored) return;
      stored = true;
      afterStored?.();
    };
    try {
      for await (const item of core.engine.runTurn({ chatId, ...turn, signal })) {
        if (item.type === 'session') {
          sessionId = item.session.id;
          broadcast({ type: 'chat-session', chatId, session: sessionView(item.session), started: item.started });
        } else if (item.type === 'user-message') {
          broadcast({
            type: 'chat-message',
            chatId,
            sessionId,
            message: {
              id: item.id,
              role: 'user',
              agent: '',
              text: item.text,
              createdAt: item.createdAt,
              attachments: item.attachments.map(toAttachmentView),
              tools: [],
              replyTo: item.replyTo ?? null,
              forwardedFrom: item.forwardedFrom ?? null,
            },
          });
          markStored();
        } else {
          broadcast({ type: 'chat-event', chatId, sessionId, agent: item.agent, event: item.event });
          context.resolved(item.event);
          if (item.event.type === 'run-finish' && item.event.reason !== 'aborted' && item.event.text) {
            context.agentSpoke?.(chatId, item.agent, item.event.text);
          }
        }
      }
    } catch (error) {
      broadcast({ type: 'error', message: (error as Error).message, chatId });
    }
    markStored();
    // The session may have been given its title during the turn.
    const session = chats.getSession(sessionId);
    if (session) broadcast({ type: 'chat-session', chatId, session: sessionView(session), started: false });
    broadcast(chatsMessage());
  };

  const search = (query: string): SearchHit[] => {
    const text = query.trim();
    if (!text) return [];
    const sessions = new Map(chats.allSessions().map((session) => [session.thread, session]));
    const titles = new Map(chats.listChats().map((chat) => [chat.id, chat]));
    const firstTerm = text.split(/\s+/)[0]!;
    const hits: SearchHit[] = [];
    for (const message of messages.search([...sessions.keys()], text, 80)) {
      const session = sessions.get(message.thread);
      const chat = session && titles.get(session.chatId);
      if (!session || !chat || message.role === 'tool' || !message.text) continue;
      hits.push({
        messageId: message.id,
        chatId: chat.id,
        sessionId: session.id,
        chatTitle: chat.title,
        sessionTitle: session.title,
        role: message.role,
        agent: message.role === 'user' ? '' : message.agent,
        // What a file said is part of the message; show it under the file's name.
        snippet: snippet(
          message.text.replace(/<attachment [^>]*name="([^"]*)">/g, '[$1] ').replaceAll('</attachment>', ''),
          firstTerm,
        ),
        createdAt: message.createdAt,
      });
      if (hits.length >= 40) break;
    }
    return hits;
  };

  const skillViews = (): SkillView[] =>
    core.skills().map((skill) => ({
      name: skill.name,
      description: skill.description,
      model: skill.model ?? '',
      tools: skill.tools,
      body: readSkillBody(skill),
      ...(skill.builtin ? { builtin: true } : {}),
    }));
  const skillsMessage = (saved?: string): ServerMessage => ({ type: 'skills', skills: skillViews(), saved });

  /** Rewrites every agent file whose skill list changes under `change`. */
  const updateAgentSkills = (change: (skills: string[]) => string[]) => {
    for (const name of core.agents.names()) {
      const agent = core.agents.get(name);
      const next = change(agent.skills);
      if (next.join('\n') !== agent.skills.join('\n')) saveAgent(config.agentsDir, { ...agent, skills: next });
    }
  };

  const saveSkillView = (view: SkillView, renameFrom?: string): string => {
    const name = String(view.name ?? '').trim().toLowerCase();
    const model = String(view.model ?? '').trim();
    if (model) core.registry.info(context.modelRef(model));
    const tools = (view.tools ?? []).map(String);
    core.deps.tools.select(tools); // unknown tools, or untrusted content next to a shell
    if (renameFrom !== name && core.skills().some((skill) => skill.name === name)) {
      throw new Error(`A skill named "${name}" already exists.`);
    }
    saveSkill(config.skillsDir, {
      name,
      description: String(view.description ?? ''),
      model: model || undefined,
      tools,
      body: String(view.body ?? ''),
    });
    if (renameFrom && renameFrom !== name) {
      deleteSkill(config.skillsDir, renameFrom);
      updateAgentSkills((skills) => skills.map((skill) => (skill === renameFrom ? name : skill)));
    }
    return name;
  };

  const presetViews = (): PresetView[] =>
    Object.entries(appSettings.presets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, preset]) => ({ name, ...preset }));

  const savePreset = (view: PresetView) => {
    const name = String(view.name ?? '').trim().toLowerCase();
    if (!PRESET_NAME.test(name)) throw new Error('Preset name: lowercase letters, digits, "-" or "_", e.g. "creative".');
    const model = String(view.model ?? '').trim();
    if (!model.includes('/')) throw new Error('A preset points at a model of a connected provider.');
    core.registry.info(parseModelRef(model));
    const number = (value: unknown, min: number, max: number, label: string, whole = false) => {
      if (value === undefined || value === null || value === '') return undefined;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < min || parsed > max || (whole && !Number.isInteger(parsed))) {
        throw new Error(`${label} must be ${whole ? 'a whole number ' : ''}between ${min} and ${max}.`);
      }
      return parsed;
    };
    appSettings.setPreset(name, {
      model,
      temperature: number(view.temperature, 0, 2, 'Temperature'),
      topP: number(view.topP, 0, 1, 'Top P'),
      topK: number(view.topK, 1, 1000, 'Top K', true),
      maxOutputTokens: number(view.maxOutputTokens, 1, 1_000_000, 'Max tokens', true),
      reasoning: reasoningOf(view.reasoning),
    });
  };

  /** An effort the AI SDK knows, or nothing (the provider's default). */
  const reasoningOf = (value: unknown): ReasoningEffort | undefined => {
    if (value === undefined || value === null || value === '' || value === 'provider-default') return undefined;
    if (!(REASONING_EFFORTS as readonly string[]).includes(String(value))) {
      throw new Error(`Reasoning effort must be one of: ${REASONING_EFFORTS.join(', ')}.`);
    }
    return value as ReasoningEffort;
  };

  const removePreset = (rawName: string) => {
    const name = String(rawName);
    const users = [
      ...core.agents
        .names()
        .filter((agent) => Object.values(core.agents.get(agent).models).includes(name))
        .map((agent) => `agent ${agent}`),
      ...core
        .skills()
        .filter((skill) => skill.model === name)
        .map((skill) => `skill ${skill.name}`),
    ];
    if (users.length > 0) throw new Error(`Preset "${name}" is still used by: ${users.join(', ')}.`);
    appSettings.removePreset(name);
  };

  /** Handles one client message. Returns false when the message is not part of this API. */
  const handle = (message: ClientMessage, reply: Reply): boolean => {
    switch (message.type) {
      case 'chats-list':
        reply(chatsMessage());
        return true;
      case 'chat-create': {
        const members = checkMembers(message.agents ?? []);
        const chat =
          message.kind === 'group'
            ? chats.createChat({ kind: 'group', agents: members, title: message.title })
            : chats.directChat(members[0] ?? '');
        broadcast(chatsMessage());
        reply(historyMessage(chat.id));
        return true;
      }
      case 'chat-update': {
        const change = {
          title: typeof message.title === 'string' ? message.title : undefined,
          agents: message.agents ? checkMembers(message.agents) : undefined,
        };
        chats.updateChat(Number(message.chatId), change);
        broadcast(chatsMessage());
        return true;
      }
      case 'chat-delete':
        chats.deleteChat(Number(message.chatId));
        broadcast(chatsMessage());
        return true;
      case 'chat-open':
        reply(historyMessage(Number(message.chatId), message.sessionId, message.beforeId));
        return true;
      case 'chat-send': {
        const chatId = Number(message.chatId);
        const text = typeof message.text === 'string' ? message.text.trim() : '';
        const attachments = (message.attachments ?? []).map(String).slice(0, 20);
        if (!text && attachments.length === 0) return true;
        if (!chats.getChat(chatId)) throw new Error(`Chat #${chatId} does not exist.`);
        const replyTo = message.replyTo === undefined ? undefined : Number(message.replyTo);
        const forward = message.forward ? { from: String(message.forward.from), chat: String(message.forward.chat) } : undefined;
        // A workflow with a chat trigger may take the message; then the agent stays quiet.
        const triggered = !forward ? core.chatTriggers(chatId, text, attachments) : null;
        if (triggered?.consumed) {
          const posted = core.postUserMessage(chatId, text, attachments);
          const sent = attachments.map((id) => core.attachments.get(id)).filter((file) => file !== undefined);
          const session = chats.getSession(posted.sessionId);
          if (session) broadcast({ type: 'chat-session', chatId, session: sessionView(session), started: false });
          broadcast({
            type: 'chat-message',
            chatId,
            sessionId: posted.sessionId,
            message: { id: posted.id, role: 'user', agent: '', text, createdAt: posted.createdAt, attachments: sent.map(toAttachmentView), tools: [], replyTo: null, forwardedFrom: null },
          });
          broadcast(chatsMessage());
          triggered.run();
          return true;
        }
        // Workflows that let the agent answer too start after the message is stored, so their replies come after it.
        context.enqueue(chatId, (signal) => runTurn(chatId, { text, attachments, replyTo, forward }, signal, triggered?.run));
        return true;
      }
      case 'session-new': {
        const chat = chats.getChat(Number(message.chatId));
        if (!chat) throw new Error(`Chat #${message.chatId} does not exist.`);
        const session = chats.newSession(chat.id, false);
        broadcast({ type: 'chat-session', chatId: chat.id, session: sessionView(session), started: true });
        reply(historyMessage(chat.id, session.id));
        return true;
      }
      case 'rewind': {
        if (context.busy()) throw new Error('Wait for the running turn to finish, or stop it, before going back.');
        const session = chats.getSession(Number(message.sessionId));
        const target = messages.get(Number(message.messageId));
        if (!session || !target || target.thread !== session.thread || target.role !== 'user') {
          throw new Error('Pick one of your own messages in this session.');
        }
        const state = core.deps.threads.ensureState(session.thread, () => core.memory.renderSnapshot());
        if (target.id <= state.summarizedThrough) {
          throw new Error('That part of the conversation was already summarized. Start a new session instead.');
        }
        messages.hideFrom(session.thread, target.id);
        // Files the agents wrote since that message go back to how they were.
        const files = core.fileSnapshots.restoreSince(session.thread, target.createdAt);
        reply({ type: 'rewound', chatId: session.chatId, sessionId: session.id, text: stripAttachments(target.text), restored: files.restored, skipped: files.skipped });
        broadcast({ type: 'chat-changed', chatId: session.chatId, sessionId: session.id });
        broadcast(chatsMessage());
        return true;
      }
      case 'message-pin':
      case 'message-react': {
        const target = messages.get(Number(message.messageId));
        const session = target && chats.allSessions().find((entry) => entry.thread === target.thread);
        const chat = session && chats.getChat(session.chatId);
        if (!target || !session || !chat || target.role === 'tool') throw new Error('Pick a message of a chat.');
        if (message.type === 'message-pin') messages.setPinned(target.id, Boolean(message.pinned));
        else {
          const emoji = String(message.emoji ?? '').trim();
          if (!emoji || emoji.length > 16) throw new Error('A reaction is one emoji.');
          messages.toggleReaction(target.id, emoji);
        }
        const after = messages.get(target.id);
        broadcast({
          type: 'message-marks',
          chatId: chat.id,
          sessionId: session.id,
          messageId: target.id,
          pinned: after?.pinnedAt !== undefined,
          reactions: after?.reactions ?? [],
          pins: pinsOf(chat),
        });
        return true;
      }
      case 'search':
        reply({ type: 'search-results', query: String(message.query ?? ''), hits: search(String(message.query ?? '')) });
        return true;
      case 'skills-list':
        reply(skillsMessage());
        return true;
      case 'skill-save': {
        const saved = saveSkillView(message.skill, message.renameFrom);
        broadcast(skillsMessage(saved));
        context.agentsChanged();
        return true;
      }
      case 'skill-delete': {
        const name = String(message.name);
        deleteSkill(config.skillsDir, name);
        updateAgentSkills((skills) => skills.filter((skill) => skill !== name));
        broadcast(skillsMessage());
        context.agentsChanged();
        return true;
      }
      case 'preset-save':
        savePreset(message.preset);
        context.settingsChanged();
        return true;
      case 'preset-delete':
        removePreset(message.name);
        context.settingsChanged();
        return true;
      case 'status-set': {
        const key = STATUS_KEYS.find((candidate) => candidate === message.key);
        if (!key || !core.agents.names().includes(String(message.agent))) throw new Error('Unknown agent or status key.');
        core.status.set(String(message.agent), key, String(message.value ?? ''));
        return true;
      }
      case 'triggers-list':
        reply({ type: 'triggers', triggers: core.triggers.list().map(toTriggerInfo) });
        return true;
      case 'trigger-cancel':
        core.triggers.cancel(Number(message.id));
        reply({ type: 'triggers', triggers: core.triggers.list().map(toTriggerInfo) });
        return true;
      default:
        return false;
    }
  };

  return { handle, chatsMessage, presetViews };
}
