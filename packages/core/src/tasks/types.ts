import type {
  AgentEvent,
  PermissionDecision,
  RiskLevel,
  TaskInterface,
  TaskLevel,
  TaskPlanView,
  TaskReceiptView,
  TaskVerificationView,
  TaskView,
} from '@mimi/shared';
import type { z } from 'zod';
import type { TaskUndo } from './repo.ts';

/** Data a recipe carries from one step to the next. */
export interface TaskRunState {
  plan?: TaskPlanView;
  receipt?: TaskReceiptView;
  verification?: TaskVerificationView;
  undo?: TaskUndo;
  data: Record<string, unknown>;
}

export interface TaskConfirmInput {
  tool: string;
  risk: RiskLevel;
  summary: string;
  input: unknown;
}

export interface TaskStepContext<Input> {
  task: TaskView;
  input: Input;
  traceId: string;
  thread: string;
  agent: string;
  taskId: string;
  signal?: AbortSignal;
  state: TaskRunState;
  /** Runs a tool on the user's machine through the core's normal executor. */
  runPc(tool: string, input: unknown): Promise<string>;
  /** Puts the recipe's confirmation in front of the user. */
  confirm(request: TaskConfirmInput): Promise<PermissionDecision>;
  /** Runs a nested agent on the task's thread, for steps that need judgment (developer fix, photo scoring). */
  runAgent(prompt: string, options?: { maxRounds?: number; tools?: string[] }): Promise<string>;
  emit(event: AgentEvent): void;
  update(patch: { plan?: TaskPlanView; receipt?: TaskReceiptView; verification?: TaskVerificationView }): void;
}

export interface TaskStep<Input> {
  id: string;
  title: string;
  run(context: TaskStepContext<Input>): Promise<string | void>;
}

/** A deterministic recipe. The model supplies input; the recipe supplies the order and the gates. */
export interface TaskRecipe<Input = unknown> {
  name: string;
  description: string;
  level: TaskLevel;
  inputSchema: z.ZodType<Input>;
  interfaces: TaskInterface[];
  steps: TaskStep<Input>[];
  /** A background/restart resume may rerun this recipe from its stored input. */
  resumable?: boolean;
}
