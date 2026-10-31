/** How much the assistant may do on its own for a task. */
export type TaskLevel = 'L1' | 'L2' | 'L3' | 'L4';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting_confirmation'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'undone';

export type TaskStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'cancelled';

export interface TaskStepView {
  id: string;
  title: string;
  status: TaskStepStatus;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface TaskGateView {
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  summary: string;
  decidedAt?: string;
}

export interface TaskVerificationView {
  ok: boolean;
  summary: string;
  checkedAt?: string;
}

export interface TaskReceiptView {
  summary: string;
  moved: number;
  skipped: number;
  failed: number;
  examples: string[];
  /** The journal a later undo reads. Kept local to the user's machine. */
  journal?: string;
  undoable: boolean;
}

export interface TaskPlanGroupView {
  key: string;
  count: number;
  examples: string[];
}

export interface TaskPlanView {
  folder: string;
  policy: 'rename' | 'skip' | 'overwrite';
  total: number;
  /** Files above the per-run limit that were left for a later run. */
  deferred?: number;
  groups: TaskPlanGroupView[];
  skipped: Array<{ name: string; reason: string }>;
}

/** A task as the chat and the task screens show it. */
export interface TaskView {
  id: string;
  goal: string;
  recipe: string;
  level: TaskLevel;
  status: TaskStatus;
  agent: string;
  steps: TaskStepView[];
  gates: TaskGateView[];
  verification?: TaskVerificationView;
  receipt?: TaskReceiptView;
  /** What the undo did, once the user restored the task's files. */
  undoReceipt?: TaskReceiptView;
  plan?: TaskPlanView;
  traceId: string;
  thread: string;
  chatId?: number;
  input: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/** What a recipe exposes to the UI; the executable definition stays in the core. */
export interface TaskRecipeView {
  name: string;
  description: string;
  level: TaskLevel;
  /** Which interfaces the recipe may use; the runner enforces the list. */
  interfaces: TaskInterface[];
}

export type TaskInterface = 'pc' | 'core' | 'browser' | 'api';

export type TaskControlAction = 'pause' | 'resume' | 'cancel';
