import type { ToolDefinition } from '@mimi/shared';
import { readFileTool } from './tools/read-file.ts';
import { browserTools } from './tools/browser.ts';
import { fileTools } from './tools/files.ts';
import { computerTools } from './tools/computer.ts';
import { mediaTools } from './tools/media.ts';
import { organizeTools } from './tools/organize.ts';
import { workspaceTools } from './tools/workspace.ts';
import { runShellTool } from './tools/run-shell.ts';
import { screenTools } from './tools/screen.ts';
import { systemTools } from './tools/system.ts';
import { writeFileTool } from './tools/write-file.ts';
import { backgroundTools } from './tools/background.ts';
import { applyPatchTool } from './tools/patch.ts';
import { grepTool } from './tools/search.ts';
import { gitTools } from './tools/git.ts';
import { pdfTools } from './tools/pdf.ts';
import { installAppTool } from './tools/apps.ts';
import { statementReadTool } from './tools/statement.ts';
import { browserFillSecretTool } from './tools/secret-fill.ts';
import { pcInternalTools as mcpInternalTools } from './tools/mcp-session.ts';

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
export {
  PathNotAllowedError,
  ProjectNotAllowedError,
  missingPathError,
  resolveAllowedPath,
  resolveProjectPath,
} from './tools/path-guard.ts';
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
  type   McpTool,
  SseLink,
  StdioLink,
} from './mcp/client.ts';
export { closeMcpSessions, type McpRunSpec, mcpSessionTool } from './tools/mcp-session.ts';
/** Internal tools the core calls itself; agents never see their schemas. */
export const pcInternalTools = [...mcpInternalTools, browserFillSecretTool];
export { browserFillSecretTool } from './tools/secret-fill.ts';
export { atomicOutput, backupFilePath, resolveSingleOutput, type AtomicOutput, type SingleOutput } from './tools/output-target.ts';
export { APP_MANAGERS, installAppTool, packageCommand, pickAppManager, setPackageProbe, setPackageRunner, type AppManager, type PackageRunner } from './tools/apps.ts';
export {
  csvDelimiter,
  detectStatementFormat,
  parseAmount,
  parseCsvStatement,
  parseOfxStatement,
  parseQifStatement,
  parseStatement,
  parseStatementDate,
  statementReadTool,
  type ParsedStatement,
  type StatementFormat,
  type StatementTransaction,
} from './tools/statement.ts';
export { BrowserSession, checkUrl, isLocalHost } from './browser/session.ts';
export { browserArguments, browserProfileDir, findBrowserExecutable, readDevToolsAddress, startBrowser } from './browser/launcher.ts';
export { browserSession, browserTools, formatSnapshot, setBrowserSession } from './tools/browser.ts';
export { fileTools, moveToTrash, wildcardToRegExp } from './tools/files.ts';
export { isOrganizerReadOnly, organizeFilesTool, organizeTools, undoOrganizeTool } from './tools/organize.ts';
export {
  allowedComputerApps,
  assertActiveApp,
  assertComputerApp,
  computerAdapter,
  computerSnapshotView,
  findComputerNode,
  flattenComputerNodes,
  setComputerAdapter,
  type ComputerAdapter,
  type ComputerAppInfo,
  type ComputerBounds,
  type ComputerNode,
  type ComputerSnapshot,
} from './computer/index.ts';
export { computerTools } from './tools/computer.ts';
export {
  detectMediaTools,
  imageCropTool,
  imageRotateTool,
  mediaContactSheetTool,
  mediaExtractAudioTool,
  mediaMuxCoverTool,
  mediaProbeTool,
  mediaSubtitleTool,
  mediaTools,
  mediaTransformTool,
  mediaTrimTool,
  photoApplyTool,
  photoScanTool,
  photoUndoTool,
  photoVerifyTool,
  videoMergeTool,
} from './tools/media.ts';
export { pageRange, pdfDeletePagesTool, pdfMergeTool, pdfRotateTool, pdfSplitTool, pdfTools } from './tools/pdf.ts';
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
export { applyPatchTool } from './tools/patch.ts';
export { grepTool } from './tools/search.ts';
export { gitCommitTool, gitDiffTool, gitLogTool, gitStatusTool, gitTools } from './tools/git.ts';
export { backgroundTools, shellOutputTool, shellStopTool, startBackground } from './tools/background.ts';

/** Tools that act on the user's machine. The core holds their schemas; the PC agent runs them. */
export const pcTools: ToolDefinition<any>[] = [
  readFileTool,
  writeFileTool,
  applyPatchTool,
  grepTool,
  runShellTool,
  ...backgroundTools,
  ...gitTools,
  ...fileTools,
  ...organizeTools,
  ...workspaceTools,
  ...mediaTools,
  ...pdfTools,
  installAppTool,
  statementReadTool,
  ...computerTools,
  ...systemTools,
  ...browserTools,
  ...screenTools,
];
