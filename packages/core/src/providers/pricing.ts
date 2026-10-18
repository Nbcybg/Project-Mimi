import type { ModelCost } from './registry.ts';

export interface TokenUsage {
  /** Total input tokens, cached ones included. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens read from the provider's prompt cache. */
  cachedTokens: number;
  /** Input tokens written to the prompt cache (billed at a premium by some providers). */
  cacheWriteTokens?: number;
}

const TIER_THRESHOLD = 200_000;

/** Cost estimate in USD; models without a known price count as 0. */
export function estimateCost(cost: ModelCost | null, usage: TokenUsage): number {
  if (!cost) return 0;
  const rates = cost.over200k && usage.inputTokens > TIER_THRESHOLD ? cost.over200k : cost;
  const cacheRead = Math.min(usage.cachedTokens, usage.inputTokens);
  const cacheWrite = Math.min(usage.cacheWriteTokens ?? 0, usage.inputTokens - cacheRead);
  const uncached = usage.inputTokens - cacheRead - cacheWrite;
  return (
    (uncached * rates.input +
      cacheRead * rates.cacheRead +
      cacheWrite * rates.cacheWrite +
      usage.outputTokens * rates.output) /
    1_000_000
  );
}
