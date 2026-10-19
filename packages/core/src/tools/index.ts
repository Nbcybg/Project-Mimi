import { pcTools } from '@mimi/pc-agent';
import type { AgentCatalog } from '../agents/loader.ts';
import type { ChatStore } from '../chat/chat-store.ts';
import { createSessionTools } from '../chat/session-tools.ts';
import type { MemoStore, StatusStore } from '../chat/state-store.ts';
import { createStateTools } from '../chat/state-tools.ts';
import type { MessagesRepo } from '../db/messages-repo.ts';
import type { KnowledgeStore } from '../knowledge/store.ts';
import { createKnowledgeTools } from '../knowledge/tools.ts';
import type { GalleryStore } from '../gallery/gallery-store.ts';
import { createGalleryTools } from '../gallery/gallery-tools.ts';
import { createProfileTools } from '../profile/tools.ts';
import type { UserProfileStore } from '../profile/user-profile.ts';
import type { GoogleAuth } from '../google/auth.ts';
import { createSheetTools } from '../google/sheets.ts';
import { createGoogleTools } from '../google/tools.ts';
import type { MemoryStore } from '../memory/store.ts';
import type { MicrosoftAuth } from '../microsoft/auth.ts';
import { createDriveTools } from '../microsoft/drive.ts';
import { createMicrosoftTools } from '../microsoft/tools.ts';
import { createTriggerTools } from '../scheduler/trigger-tools.ts';
import type { TriggerStore } from '../scheduler/triggers.ts';
import { createSkillTool, type Skill } from '../skills/skills.ts';
import { createDocumentTools } from './document-tools.ts';
import { createMailAttachmentTools } from './mail-attachments.ts';
import { createMediaTools, type MediaToolDeps } from './media-tools.ts';
import { createMemoryTools } from './memory-tools.ts';
import { ToolRegistry } from './registry.ts';
import { createWebTools } from './web-tools.ts';

export interface ToolServices {
  memory: MemoryStore;
  messages: MessagesRepo;
  triggers: TriggerStore;
  agents: AgentCatalog;
  google: GoogleAuth;
  microsoft: MicrosoftAuth;
  /** API keys of the web tools, by environment variable name; read at call time. */
  key?: (name: string) => string | undefined;
  /** A function is asked on every call, so skills added in the app are found without a restart. */
  skills: Skill[] | (() => Skill[]);
  chats: ChatStore;
  status: StatusStore;
  memos: MemoStore;
  timezone: string;
  /** Knowledge bases; without one the knowledge_search tool is not offered. */
  knowledge?: KnowledgeStore;
  /** Situation galleries; without one the gallery tools are not offered. */
  gallery?: GalleryStore;
  /** The user's profile; without it the profile_update tool is not offered. */
  profile?: UserProfileStore;
  /** Reads a document in the allowed folders as text (read_document). */
  readDocument?: (path: string, agent: string, allowedDirs: string[]) => Promise<string>;
  /** Sending and making files (send_file, generate_image, text_to_speech, generate_video). */
  media?: MediaToolDeps;
}

/** Every tool an agent file may list. The mesh tools (send_to, reply) are added per run. */
export function createToolRegistry(services: ToolServices): ToolRegistry {
  return new ToolRegistry().register(
    ...pcTools,
    ...createMemoryTools(services.memory, services.messages, (agent) =>
      services.chats.sessionsFor(agent, 200).map(({ session }) => session.thread),
    ),
    ...createSessionTools(services.chats, services.messages),
    ...createStateTools(services.status, services.memos),
    ...createTriggerTools(services.triggers, services.agents),
    ...createGoogleTools(services.google, services.timezone),
    ...createSheetTools(services.google),
    ...createMicrosoftTools(services.microsoft, services.timezone),
    ...createDriveTools(services.microsoft),
    ...createMailAttachmentTools(services.google, services.microsoft),
    ...(services.readDocument ? createDocumentTools(services.readDocument) : []),
    ...(services.media ? createMediaTools(services.media) : []),
    ...(services.gallery && services.media ? createGalleryTools(services.gallery, services.status, services.media.attachments) : []),
    ...createWebTools({ key: services.key ?? ((name) => process.env[name]) }),
    createSkillTool(services.skills),
    ...(services.knowledge ? createKnowledgeTools(services.knowledge) : []),
    ...(services.profile ? createProfileTools(services.profile, () => services.agents.names()) : []),
  );
}
