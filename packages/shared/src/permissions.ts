import type { RiskLevel } from './tools.ts';

export interface PermissionRequest {
  id: string;
  traceId: string;
  /** The session thread, so a "allow for this session" grant covers exactly that conversation. */
  thread?: string;
  agent: string;
  tool: string;
  risk: RiskLevel;
  input: unknown;
  /** One-line human readable description of what the tool call will do. */
  summary: string;
  timeoutMs: number;
  /** When the tool asked (UTC ISO-8601), so the client can show the session it belongs to. */
  createdAt: string;
}

export type PermissionDecision =
  | { allow: true; via: 'auto' | 'user' }
  | { allow: false; reason: 'denied' | 'timeout' | 'error' };

/**
 * How long an approval lasts: this one call, every call of the same tool family in this
 * task (trace), in this chat session, or until the user removes it (stored on the machine).
 */
export type PermissionScope = 'once' | 'task' | 'session' | 'always';

/**
 * Tools that are one family for "allow for this task". Approving the organizer also
 * covers its undo, which only moves those same files back.
 */
const TOOL_FAMILIES: Record<string, string> = {
  organize_files: 'files.organize',
  undo_organize: 'files.organize',
  workspace_create: 'files.workspace',
  workspace_info: 'files.workspace',
  workspace_run: 'files.workspace',
  workspace_checkpoint: 'files.workspace',
  workspace_diff: 'files.workspace',
  workspace_undo: 'files.workspace',
  write_file: 'files.workspace',
  edit_file: 'files.workspace',
  photo_apply: 'media.photos',
  photo_undo: 'media.photos',
  photo_verify: 'media.photos',
  media_contact_sheet: 'media.photos',
  media_transform: 'media.photos',
  media_mux_cover: 'media.photos',
  image_crop: 'media.photos',
  image_rotate: 'media.photos',
  media_trim: 'media.video',
  media_subtitle: 'media.video',
  video_merge: 'media.video',
  pdf_merge: 'files.pdf',
  pdf_split: 'files.pdf',
  pdf_delete_pages: 'files.pdf',
  pdf_rotate: 'files.pdf',
  browser_open: 'browser.task',
  browser_upload: 'browser.task',
  browser_click: 'browser.task',
  browser_type: 'browser.task',
  browser_select: 'browser.task',
  browser_press: 'browser.task',
  browser_focus: 'browser.task',
  browser_wait: 'browser.task',
  computer_observe: 'computer.desktop',
  computer_click: 'computer.desktop',
  computer_type: 'computer.desktop',
  computer_key: 'computer.desktop',
  computer_scroll: 'computer.desktop',
  computer_app: 'computer.desktop',
  computer_menu: 'computer.desktop',
  computer_wait: 'computer.desktop',
  computer_screenshot: 'computer.desktop',
  computer_highlight: 'computer.desktop',
};

export function toolFamily(tool: string): string {
  return TOOL_FAMILIES[tool] ?? tool;
}
