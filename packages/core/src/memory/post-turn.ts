import type { AgentDefinition } from '../agents/loader.ts';
import type { CompactionResult, Compactor } from './compactor.ts';
import type { MemoryWriter } from './writer.ts';

export interface FinishedTurn {
  thread: string;
  traceId: string;
  agent: AgentDefinition;
  /** Real prompt size after the turn, as reported by the provider. */
  contextTokens: number;
  /** False for failed or aborted turns: nothing reliable to file. */
  completed: boolean;
}

export function describeCompaction(result: CompactionResult): string {
  const parts: string[] = [];
  if (result.summarized) {
    const { fromId, toId, messages } = result.summarized;
    parts.push(`summarized ${messages} messages (#${fromId}-#${toId})`);
  }
  if (result.merged > 0) parts.push(`merged ${result.merged} older summaries`);
  return parts.length > 0 ? `compaction: ${parts.join(', ')}` : 'compaction: memory snapshot refreshed';
}

/**
 * Work that happens after a turn without making the user wait: the memory writer and
 * the compaction check. Jobs run one at a time; failures become notices, never errors
 * in the conversation.
 */
export class PostTurnJobs {
  private readonly writer: MemoryWriter;
  private readonly compactor: Compactor;
  private readonly autoWrite: boolean;
  private queue: Promise<void> = Promise.resolve();
  private readonly notices: string[] = [];

  constructor(writer: MemoryWriter, compactor: Compactor, autoWrite: boolean) {
    this.writer = writer;
    this.compactor = compactor;
    this.autoWrite = autoWrite;
  }

  schedule(turn: FinishedTurn): void {
    this.queue = this.queue.then(() => this.process(turn));
  }

  private async process(turn: FinishedTurn): Promise<void> {
    if (this.autoWrite && turn.completed) {
      try {
        const result = await this.writer.processTrace(turn.traceId, turn.agent, turn.thread);
        if (result.saved.length > 0) this.notices.push(`memory: saved ${[...new Set(result.saved)].join(', ')}`);
        for (const reason of result.rejected) this.notices.push(`memory: skipped a write (${reason})`);
      } catch (error) {
        this.notices.push(`memory writer failed: ${(error as Error).message}`);
      }
    }
    // Compact after the writer, so the new snapshot already contains what it filed.
    try {
      const result = await this.compactor.maybeCompact(
        turn.thread,
        turn.agent,
        turn.contextTokens > 0 ? turn.contextTokens : undefined,
      );
      if (result) this.notices.push(describeCompaction(result));
    } catch (error) {
      this.notices.push(`compaction failed: ${(error as Error).message}`);
    }
  }

  note(notice: string): void {
    this.notices.push(notice);
  }

  /** Resolves once every scheduled job has finished. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Returns and clears what the jobs have to tell the user. */
  drainNotices(): string[] {
    return this.notices.splice(0);
  }
}
