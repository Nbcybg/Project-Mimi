import type { ToolDefinition } from '@mimi/shared';
import { readFileTool } from './tools/read-file.ts';
import { browserTools } from './tools/browser.ts';
import { fileTools } from './tools/files.ts';
import { pcInternalTools } from './tools/mcp-session.ts';
import { mediaTools } from './tools/media.ts';
import { organizeTools } from './tools/organize.ts';
import { workspaceTools } from './tools/workspace.ts';
import { runShellTool } from './tools/run-shell.ts';
import { screenTools } from './tools/screen.ts';
import { systemTools } from './tools/system.ts';
import { writeFileTool } from './tools/write-file.ts';

export { PcAgent, type PcAgentOptions } from './client.ts';
export {
  type ConsentPrompt,
  type ConsentRequest,
  LineReader,
  LocalConsent,
  type LocalConsentOptions,
  osConsentPrompt,
  StdioConsentPrompt,
} from './local-consent.ts';
export { PathNotAllowedError, missingPathError, resolveAllowedPath } from './tools/path-guard.ts';
export { type CdpClient, connectCdp } from './browser/cdp.ts';
export {
  callResultText,
  HttpLink,
  type JsonRpcMessage,
  MCP_PROTOCOL_VERSION,
  McpClient,
  type McpCallResult,
  type McpContent,
  type McpLink,
  type McpTool,
  StdioLink,
} from './mcp/client.ts';
export { closeMcpSessions, type McpRunSpec, mcpSessionTool, pcInternalTools } from './tools/mcp-session.ts';
export { BrowserSession, checkUrl, isLocalHost } from './browser/session.ts';
export { browserArguments, browserProfileDir, findBrowserExecutable, readDevToolsAddress, startBrowser } from './browser/launcher.ts';
export { browserSession, browserTools, formatSnapshot, setBrowserSession } from './tools/browser.ts';
export { fileTools, moveToTrash, wildcardToRegExp } from './tools/files.ts';
export { isOrganizerReadOnly, organizeFilesTool, organizeTools, undoOrganizeTool } from './tools/organize.ts';
export {
  detectMediaTools,
  mediaContactSheetTool,
  mediaMuxCoverTool,
  mediaProbeTool,
  mediaTools,
  mediaTransformTool,
  photoApplyTool,
  photoScanTool,
  photoUndoTool,
  photoVerifyTool,
} from './tools/media.ts';
export {
  isWorkspaceCommandBlocked,
  isWorkspaceDestructive,
  workspaceCheckpointTool,
  workspaceCreateTool,
  workspaceDiffTool,
  workspaceInfoTool,
  workspaceRunTool,
  workspaceTools,
  workspaceUndoTool,
} from './tools/workspace.ts';
export { parseProcessList, powerInvocation, systemTools } from './tools/system.ts';
export { clipboardTool, screenshotTool, screenTools } from './tools/screen.ts';
export { readFileTool, runShellTool, writeFileTool };

/** Tools that act on the user's machine. The core holds their schemas; the PC agent runs them. */
export const pcTools: ToolDefinition<any>[] = [
  readFileTool,
  writeFileTool,
  runShellTool,
  ...fileTools,
  ...organizeTools,
  ...workspaceTools,
  ...mediaTools,
  ...systemTools,
  ...browserTools,
  ...screenTools,
];
