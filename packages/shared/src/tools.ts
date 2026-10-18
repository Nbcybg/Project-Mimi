export const RISK_LEVELS = ['read', 'write', 'shell', 'delete', 'network'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Where a tool physically runs. `pc` tools are routed to the PC agent once it exists. */
export type ToolTarget = 'core' | 'pc';

/** One setting a tool accepts; the app renders a form field per entry. */
export interface ToolSettingField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'secret' | 'text';
  description?: string;
  required?: boolean;
  placeholder?: string;
  default?: string | number | boolean;
}

/** The values a preset fills in; secrets are read from the environment at call time. */
export type ToolSettingValues = Record<string, string | number | boolean | undefined>;

/** A parameter of a user-defined tool, the input the model provides per call. */
export interface ToolParamField {
  key: string;
  type: 'string' | 'number' | 'boolean';
  description?: string;
  /** Defaults to true. */
  required?: boolean;
}

export type CustomToolKind = 'http' | 'code' | 'shell';

/** A tool the user added to the pool, stored as `tools/custom/<name>.json`. */
export interface CustomToolSpec {
  name: string;
  description: string;
  kind: CustomToolKind;
  /** What the model may pass to the tool. */
  params: ToolParamField[];
  /** What a preset fills in; used in templates as {{settings.key}}. */
  settings: ToolSettingField[];
  /** Kind-specific: method/url/headers/body, code, or command. */
  config: Record<string, unknown>;
}

/** A configured instance of a pool tool, stored as `tools/presets/<name>.json`. */
export interface ToolPreset {
  name: string;
  /** The pool tool this is a configured copy of. */
  tool: string;
  /** Short name shown in the UI, e.g. "Manager Sheet". */
  label?: string;
  /** Overrides the tool's description for the model. */
  description?: string;
  settings: ToolSettingValues;
}

export interface ToolSpec {
  name: string;
  description: string;
  risk: RiskLevel;
  target: ToolTarget;
  /**
   * The tool returns content written by third parties (web pages, e-mail). Agents that
   * have such a tool may not also have a shell tool.
   */
  untrustedInput?: boolean;
  /** Settings this tool accepts; a tool without settings cannot be made into a preset. */
  settings?: ToolSettingField[];
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  callId: string;
  name: string;
  ok: boolean;
  output: string;
}

/** How Mimi reaches an MCP server: a local command (stdio) or a URL (Streamable HTTP). */
export type McpTransport = 'stdio' | 'http';

/** An MCP server the user added, stored in `tools/mcp/servers.json`. Values may use {{secret.NAME}}. */
export interface McpServerSpec {
  /** Lower case letters, digits and "-"; tools appear as `mcp_<name>_<tool>`. */
  name: string;
  title?: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Risk of tools that do not say they only read; defaults to "write". */
  risk?: RiskLevel;
  /** Results may carry third-party text (web pages, mail); defaults to true. */
  untrusted?: boolean;
}

/** One tool an MCP server offers, under the name agents use. */
export interface McpToolView {
  name: string;
  tool: string;
  description: string;
  risk: RiskLevel;
}

export interface McpServerView extends McpServerSpec {
  tools: McpToolView[];
  /** When the tool list was last read from the server. */
  checkedAt?: string;
  error?: string;
}
