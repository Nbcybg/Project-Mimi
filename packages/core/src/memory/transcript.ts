import type { StoredMessage } from '@mimi/shared';

const TOOL_INPUT_LIMIT = 300;
const TOOL_OUTPUT_LIMIT = 800;

interface ContentPart {
  type: string;
  [key: string]: unknown;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}... [${flat.length - limit} more chars]` : flat;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
}

/**
 * One part of a message as transcript text. Images and files become short text
 * placeholders: once a message is summarized, its binary content never returns to the prompt.
 */
function renderPart(part: ContentPart): string | null {
  switch (part.type) {
    case 'text':
      return typeof part.text === 'string' ? part.text : null;
    case 'tool-call':
      return `-> called ${String(part.toolName)} ${clip(stringify(part.input), TOOL_INPUT_LIMIT)}`;
    case 'tool-result': {
      const output = (part.output as { value?: unknown } | undefined)?.value;
      return `${String(part.toolName)} returned: ${clip(stringify(output), TOOL_OUTPUT_LIMIT)}`;
    }
    case 'image':
    case 'file': {
      const description = typeof part.description === 'string' ? part.description : null;
      return description ? `[${part.type}: ${description}]` : `[${part.type}, not described]`;
    }
    default:
      return null; // reasoning and other provider-internal parts
  }
}

function speaker(message: StoredMessage): string {
  if (message.role === 'user') return 'user';
  return message.role === 'assistant' ? `assistant ${message.agent}` : 'tool';
}

/** Renders raw messages as a compact, id-tagged transcript for the summarizer. */
export function renderTranscript(messages: StoredMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    const body = Array.isArray(message.content)
      ? (message.content as ContentPart[]).map(renderPart).filter((part) => part !== null).join('\n')
      : message.text;
    if (!body.trim()) continue;
    lines.push(`#${message.id} [${message.createdAt.slice(0, 16)}Z ${speaker(message)}]\n${body}`);
  }
  return lines.join('\n\n');
}
