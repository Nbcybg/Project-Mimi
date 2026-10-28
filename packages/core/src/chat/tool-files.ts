import { parseToolFile } from '@mimi/shared';
import type { ToolExecutor } from '../tools/executor.ts';
import type { ToolContext, ToolDefinition } from '../tools/registry.ts';
import { type AttachmentStore, MAX_ATTACHMENT_BYTES } from './attachments.ts';

/**
 * Wraps the executor: a tool that answers with a file (a browser screenshot taken on the
 * user's PC) has it stored as a chat attachment, and the agent gets its id instead of the
 * bytes. The file is kept with the core's data, so nothing has to stay on the PC.
 */
export class ToolFileExecutor implements ToolExecutor {
  private readonly inner: ToolExecutor;
  private readonly attachments: AttachmentStore;

  constructor(inner: ToolExecutor, attachments: AttachmentStore) {
    this.inner = inner;
    this.attachments = attachments;
  }

  async execute(tool: ToolDefinition, input: unknown, context: ToolContext): Promise<string> {
    const output = await this.inner.execute(tool, input, context);
    const file = parseToolFile(output);
    if (!file) return output;
    const data = Buffer.from(file.data, 'base64');
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error(`${tool.name} returned a file that is too large to keep.`);
    const saved = this.attachments.save({ name: file.name, mime: file.mime, data });
    return `Saved ${file.name} as attachment ${saved.id}. Show it to the user with send_file (attachment_id: "${saved.id}").`;
  }
}
