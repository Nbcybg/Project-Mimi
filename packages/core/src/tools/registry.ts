import type { ToolDefinition } from '@mimi/shared';

export { defineTool, type ToolContext, type ToolDefinition } from '@mimi/shared';

/** What the agent loop needs from a tool collection: turn names into runnable tools. */
export interface ToolSource {
  get(name: string): ToolDefinition | undefined;
  select(names: string[]): ToolDefinition[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(...tools: ToolDefinition<any>[]): this {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
      this.tools.set(tool.name, tool);
    }
    return this;
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * The tools an agent declared in its frontmatter. Unknown names are a config error,
   * and so is combining a tool that reads third-party content with a shell tool:
   * injected text must never be one step away from running commands.
   */
  select(names: string[]): ToolDefinition[] {
    const selected = names.map((name) => {
      const tool = this.tools.get(name);
      if (!tool) {
        throw new Error(`Unknown tool "${name}". Registered: ${this.names().join(', ')}`);
      }
      return tool;
    });
    const untrusted = selected.find((tool) => tool.untrustedInput);
    const shell = selected.find((tool) => tool.risk === 'shell');
    if (untrusted && shell) {
      throw new Error(
        `An agent cannot have both "${untrusted.name}" (reads third-party content) and "${shell.name}" (shell). Give them to different agents.`,
      );
    }
    return selected;
  }
}
