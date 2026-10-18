import type { StoredMessage } from '@mimi/shared';

/**
 * Rough token count without a tokenizer. UTF-8 bytes / 3 lands near real counts for
 * Thai (3 bytes per character) and over-estimates English a little, which is the
 * safe direction for budget checks.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

/** Estimated prompt size of a stored message, including tool calls and results. */
export function estimateMessageTokens(message: StoredMessage): number {
  const content =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  return estimateTokens(content) + estimateTokens(message.context ?? '') + 4;
}
