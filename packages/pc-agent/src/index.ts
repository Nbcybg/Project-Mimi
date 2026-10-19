import type { ToolDefinition } from '@mimi/shared';
import { readFileTool } from './tools/read-file.ts';
import { browserTools } from './tools/browser.ts';
import { fileTools } from './tools/files.ts';
import { pcInternalTools } from './tools/mcp-session.ts';
import { runShellTool } from './tools/run-shell.ts';
import { systemTools } from './tools/system.ts';
import { writeFileTool } from './tools/write-file.ts';

export { PcAgent, type PcAgentOptions } from './client.ts';
export { PathNotAllowedError, resolveAllowedPath } from './tools/path-guard.ts';
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
export { parseProcessList, powerInvocation, systemTools } from './tools/system.ts';
export { readFileTool, runShellTool, writeFileTool };

/** Tools that act on the user's machine. The core holds their schemas; the PC agent runs them. */
export const pcTools: ToolDefinition<any>[] = [readFileTool, writeFileTool, runShellTool, ...fileTools, ...systemTools, ...browserTools];
