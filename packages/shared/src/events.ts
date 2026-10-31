import type { PermissionDecision, PermissionRequest } from './permissions.ts';
import type { AttachmentView } from './protocol.ts';
import type { SpeechStyle } from './speech.ts';
import type { TaskPlanView, TaskReceiptView, TaskStatus, TaskStepView, TaskView } from './tasks.ts';
import type { RiskLevel, ToolCall, ToolResult } from './tools.ts';

export type RunFinishReason =
  | 'stop'
  | 'max_rounds'
  | 'max_tokens'
  /** The trace-wide budget (tokens, rounds or time across all agents) ran out. */
  | 'trace_budget'
  /** The agent passed the turn to another agent, which now answers the user. */
  | 'handoff'
  | 'aborted'
  | 'error';

export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

/** Everything an agent run emits. The CLI renders these; clients receive the same stream. */
export type AgentEvent =
  | {
      type: 'run-start';
      traceId: string;
      agent: string;
      model: string;
      /** Id of the stored message that woke the agent, when the run stored one. */
      userMessageId?: number;
    }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall; risk: RiskLevel | null }
  | { type: 'permission-request'; request: PermissionRequest }
  | { type: 'permission-decision'; requestId: string; decision: PermissionDecision }
  | { type: 'tool-result'; result: ToolResult }
  /** A file the agent sent to the user (made or picked by a tool), shown under its message. */
  | { type: 'attachment'; attachment: AttachmentView }
  | { type: 'usage'; round: number; usage: UsageSnapshot }
  /** Something a sub-agent did while working on agent-to-agent message `messageId`. */
  | { type: 'agent-activity'; agent: string; messageId: number; event: AgentEvent }
  /** A task started, changed or finished; the chat renders these as a task card. */
  | { type: 'task-start'; task: TaskView }
  | { type: 'task-update'; task: TaskView }
  | { type: 'task-step'; taskId: string; step: TaskStepView }
  | { type: 'task-plan'; taskId: string; plan: TaskPlanView }
  | { type: 'task-receipt'; taskId: string; receipt: TaskReceiptView; undo?: boolean }
  | { type: 'task-finish'; taskId: string; status: TaskStatus; receipt?: TaskReceiptView }
  | {
      type: 'run-finish';
      traceId: string;
      reason: RunFinishReason;
      rounds: number;
      usage: UsageSnapshot;
      /** Size of the conversation in the model's context after this run (last prompt + reply). */
      contextTokens: number;
      /** The text of the agent's final answer, without its voice direction line. */
      text: string;
      /** How the final answer should sound when it is read aloud. */
      speech?: SpeechStyle;
      /** Set when reason is `handoff`. */
      handoff?: { messageId: number; to: string };
      error?: string;
      /** Stable code for `error`, e.g. E-RATE-429. */
      errorCode?: string;
    };
