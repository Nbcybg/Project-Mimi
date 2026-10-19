// The MCP client lives in the PC agent package, so the PC agent can host MCP servers on the
// user's machine too; the core uses the same code through this re-export.
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
} from '@mimi/pc-agent';
