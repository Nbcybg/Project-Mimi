import type {
  AgentEvent,
  PermissionDecision,
  TaskGateView,
  TaskReceiptView,
  TaskStepView,
  TaskVerificationView,
  TaskView,
} from '@mimi/shared';
import { z } from 'zod';
import type { PermissionGate } from '../permissions/gate.ts';
import { type TaskRecord, TaskRepo, taskView } from './repo.ts';
import type { RecipeRegistry } from './recipes.ts';
import type { TaskConfirmInput, TaskRecipe, TaskRunState, TaskStepContext } from './types.ts';
import { TaskStoppedError, parseToolJson, receiptFrom, verificationFrom } from './util.ts';

export interface TaskExecutorContext {
  traceId: string;
  thread: string;
  agent: string;
  taskId: string;
  signal?: AbortSignal;
}

export interface TaskAgentStepInput {
  agent: string;
  prompt: string;
  traceId: string;
  thread: string;
  taskId: string;
  signal?: AbortSignal;
  maxRounds?: number;
  /** Tool allowlist for the nested run; the core picks a safe default when absent. */
  tools?: string[];
  emit(event: AgentEvent): void;
}

export interface TaskRunnerDeps {
  repo: TaskRepo;
  recipes: RecipeRegistry;
  gate: PermissionGate;
  execute(tool: string, input: unknown, context: TaskExecutorContext): Promise<string>;
  /** The core supplies this; a recipe step may use it for work that needs a model. */
  runAgentStep?: (input: TaskAgentStepInput) => Promise<string>;
  now?: () => Date;
}

export interface TaskRunOptions {
  recipe: string;
  goal: string;
  input: Record<string, unknown>;
  traceId: string;
  thread: string;
  agent: string;
  chatId?: number;
  signal?: AbortSignal;
}

interface ActiveTask {
  record: TaskRecord;
  controller: AbortController;
  paused: boolean;
  waiters: Set<() => void>;
  emit(event: AgentEvent): void;
}

/**
 * Runs a deterministic recipe. The recipe owns the order, the interfaces it may use
 * and its confirmation gates; the model only supplies the input. This is the seam a
 * later sprint can widen to wrap the open-ended agent loop.
 */
export class TaskRunner {
  private readonly deps: TaskRunnerDeps;
  private readonly now: () => Date;
  private readonly active = new Map<string, ActiveTask>();
  private readonly undoing = new Set<string>();

  constructor(deps: TaskRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  recipe(name: string): TaskRecipe<any> | undefined {
    return this.deps.recipes.get(name);
  }

  /** Stops, pauses or resumes a running task. Returns false when it is not running. */
  control(taskId: string, action: 'pause' | 'resume' | 'cancel'): boolean {
    const active = this.active.get(taskId);
    if (!active) return false;
    if (action === 'pause') {
      active.paused = true;
      if (active.record.status === 'running' || active.record.status === 'awaiting_confirmation') {
        active.record.status = 'paused';
        this.deps.repo.save(active.record);
        active.emit({ type: 'task-update', task: taskView(active.record) });
        for (const wake of active.waiters) wake();
        active.waiters.clear();
      }
      return true;
    }
    if (action === 'resume') {
      active.paused = false;
      if (active.record.status === 'paused') {
        active.record.status = 'running';
        this.deps.repo.save(active.record);
        active.emit({ type: 'task-update', task: taskView(active.record) });
      }
      for (const wake of active.waiters) wake();
      active.waiters.clear();
      return true;
    }
    active.paused = false;
    active.controller.abort(new TaskStoppedError('The task was stopped.'));
    for (const wake of active.waiters) wake();
    active.waiters.clear();
    return true;
  }

  async *run(options: TaskRunOptions): AsyncGenerator<AgentEvent, TaskView> {
    const recipe = this.deps.recipes.get(options.recipe);
    if (!recipe) {
      throw new Error(`Unknown task recipe "${options.recipe}". Available: ${this.deps.recipes.names().join(', ') || 'none'}.`);
    }
    const parsed = recipe.inputSchema.safeParse(options.input);
    if (!parsed.success) throw new Error(`Invalid input for "${recipe.name}":\n${z.prettifyError(parsed.error)}`);

    const record = this.deps.repo.create({
      goal: options.goal,
      recipe: recipe.name,
      level: recipe.level,
      agent: options.agent,
      traceId: options.traceId,
      thread: options.thread,
      ...(options.chatId !== undefined ? { chatId: options.chatId } : {}),
      input: parsed.data as Record<string, unknown>,
      steps: recipe.steps.map((step) => ({ id: step.id, title: step.title })),
    });

    const controller = new AbortController();
    const onAbort = () => controller.abort(new TaskStoppedError('The task was stopped.'));
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const pending: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    const emit = (event: AgentEvent) => {
      pending.push(event);
      wake?.();
      wake = null;
    };
    const active: ActiveTask = { record, controller, paused: false, waiters: new Set(), emit };
    this.active.set(record.id, active);

    async function* stream<T>(work: Promise<T>): AsyncGenerator<AgentEvent, T> {
      let settled = false;
      let failed = false;
      let value: T | undefined;
      let failure: unknown;
      work.then(
        (settledValue) => {
          value = settledValue;
          settled = true;
          wake?.();
          wake = null;
        },
        (error) => {
          failed = true;
          failure = error;
          settled = true;
          wake?.();
          wake = null;
        },
      );
      while (true) {
        while (pending.length > 0) yield pending.shift()!;
        if (settled) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      if (failed) throw failure;
      return value as T;
    }

    const state: TaskRunState = { data: {} };
    const taskRepo = this.deps.repo;
    let planSent = false;
    let receiptSent = false;

    /** Between steps: hold here while paused, and keep yielding status changes. */
    async function* waitPaused(): AsyncGenerator<AgentEvent, void> {
      if (!active.paused) return;
      record.status = 'paused';
      taskRepo.save(record);
      yield { type: 'task-update', task: taskView(record) };
      while (active.paused && !controller.signal.aborted) {
        while (pending.length > 0) yield pending.shift()!;
        if (!active.paused) break;
        await new Promise<void>((resolve) => active.waiters.add(resolve));
      }
      if (!controller.signal.aborted) {
        record.status = 'running';
        taskRepo.save(record);
        yield { type: 'task-update', task: taskView(record) };
      }
    }

    const context: TaskStepContext<unknown> = {
      task: taskView(record),
      input: parsed.data,
      traceId: options.traceId,
      thread: options.thread,
      agent: options.agent,
      taskId: record.id,
      signal: controller.signal,
      state,
      runPc: (tool, input) => {
        if (!recipe.interfaces.includes('pc')) throw new Error(`Recipe "${recipe.name}" may not use PC tools.`);
        return this.deps.execute(tool, input, {
          traceId: record.traceId,
          thread: record.thread,
          agent: record.agent,
          taskId: record.id,
          signal: controller.signal,
        });
      },
      runAgent: async (prompt, runOptions) => {
        if (!this.deps.runAgentStep) throw new Error('This task runner cannot run an agent step.');
        return this.deps.runAgentStep({
          agent: record.agent,
          prompt,
          traceId: record.traceId,
          thread: record.thread,
          taskId: record.id,
          signal: controller.signal,
          ...(runOptions?.maxRounds !== undefined ? { maxRounds: runOptions.maxRounds } : {}),
          ...(runOptions?.tools ? { tools: runOptions.tools } : {}),
          emit,
        });
      },
      confirm: async (request: TaskConfirmInput): Promise<PermissionDecision> => {
        const permission = this.deps.gate.createRequest({
          traceId: record.traceId,
          agent: record.agent,
          tool: request.tool,
          risk: request.risk,
          input: request.input,
          summary: request.summary,
        });
        const gate: TaskGateView = { id: permission.id, status: 'pending', summary: permission.summary };
        record.gates.push(gate);
        record.status = 'awaiting_confirmation';
        this.deps.repo.save(record);
        emit({ type: 'task-update', task: taskView(record) });
        emit({ type: 'permission-request', request: permission });
        const decision = await this.deps.gate.decide(permission, controller.signal);
        emit({ type: 'permission-decision', requestId: permission.id, decision });
        gate.status = decision.allow ? 'approved' : decision.reason === 'timeout' ? 'expired' : 'denied';
        gate.decidedAt = this.now().toISOString();
        record.status = 'running';
        this.deps.repo.save(record);
        emit({ type: 'task-update', task: taskView(record) });
        return decision;
      },
      emit,
      update: (patch) => {
        if (patch.plan) {
          state.plan = patch.plan;
          record.plan = patch.plan;
          planSent = true;
          emit({ type: 'task-plan', taskId: record.id, plan: patch.plan });
        }
        if (patch.receipt) {
          state.receipt = patch.receipt;
          record.receipt = patch.receipt;
          receiptSent = true;
          emit({ type: 'task-receipt', taskId: record.id, receipt: patch.receipt });
        }
        if (patch.verification) {
          state.verification = patch.verification;
          record.verification = patch.verification;
        }
        this.deps.repo.save(record);
      },
    };

    yield { type: 'task-start', task: taskView(record) };

    try {
      for (const step of recipe.steps) {
        if (controller.signal.aborted) throw new TaskStoppedError('The task was stopped.');
        yield* waitPaused();
        if (controller.signal.aborted) throw new TaskStoppedError('The task was stopped.');

        const viewStep = record.steps.find((candidate) => candidate.id === step.id);
        if (!viewStep) throw new Error(`Task step "${step.id}" is missing.`);
        viewStep.status = 'running';
        viewStep.startedAt = this.now().toISOString();
        record.status = 'running';
        this.deps.repo.save(record);
        yield { type: 'task-step', taskId: record.id, step: { ...viewStep } };

        try {
          const detail = yield* stream(Promise.resolve().then(() => step.run(context)));
          viewStep.status = 'done';
          viewStep.detail = typeof detail === 'string' && detail ? detail : viewStep.detail;
          viewStep.finishedAt = this.now().toISOString();
          record.plan = state.plan ?? record.plan;
          record.receipt = state.receipt ?? record.receipt;
          record.verification = state.verification ?? record.verification;
          record.undo = state.undo ?? record.undo;
          this.deps.repo.save(record);
          yield { type: 'task-step', taskId: record.id, step: { ...viewStep } };
        } catch (error) {
          viewStep.status = error instanceof TaskStoppedError || controller.signal.aborted ? 'cancelled' : 'failed';
          viewStep.detail = error instanceof Error ? error.message : String(error);
          viewStep.finishedAt = this.now().toISOString();
          this.deps.repo.save(record);
          yield { type: 'task-step', taskId: record.id, step: { ...viewStep } };
          throw error;
        }
      }

      record.plan = state.plan ?? record.plan;
      record.receipt = state.receipt ?? record.receipt;
      record.verification = state.verification ?? record.verification;
      record.undo = state.undo ?? record.undo;
      if (!record.verification) {
        record.verification = { ok: false, summary: 'The recipe finished without verifying the result.' };
      }
      if (!record.receipt) {
        record.receipt = { summary: 'The recipe finished without a receipt.', moved: 0, skipped: 0, failed: 0, examples: [], undoable: false };
      }
      if (!receiptSent && record.receipt) yield { type: 'task-receipt', taskId: record.id, receipt: record.receipt };
      if (!planSent && record.plan) yield { type: 'task-plan', taskId: record.id, plan: record.plan };
      record.status = record.verification.ok ? 'completed' : 'failed';
      record.error = record.verification.ok ? undefined : record.verification.summary;
      record.finishedAt = this.now().toISOString();
      this.deps.repo.save(record);
      yield {
        type: 'task-finish',
        taskId: record.id,
        status: record.status,
        ...(record.receipt ? { receipt: record.receipt } : {}),
      };
    } catch (error) {
      const stopped = error instanceof TaskStoppedError || controller.signal.aborted;
      record.status = stopped ? 'cancelled' : 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.plan = state.plan ?? record.plan;
      record.receipt = state.receipt ?? record.receipt;
      record.verification = state.verification ?? record.verification;
      record.undo = state.undo ?? record.undo;
      for (const step of record.steps) {
        if (step.status !== 'running') continue;
        step.status = stopped ? 'cancelled' : 'failed';
        step.detail ??= record.error;
        step.finishedAt = this.now().toISOString();
        yield { type: 'task-step', taskId: record.id, step: { ...step } };
      }
      record.finishedAt = this.now().toISOString();
      this.deps.repo.save(record);
      yield {
        type: 'task-finish',
        taskId: record.id,
        status: record.status,
        ...(record.receipt ? { receipt: record.receipt } : {}),
      };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.active.delete(record.id);
    }

    return taskView(record);
  }

  /** Restores what a finished task changed; the journal is the source of truth. */
  async *undo(
    task: TaskRecord,
    options: { traceId?: string; thread?: string; agent?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<AgentEvent, TaskView> {
    const undo = task.undo;
    if (!undo) throw new Error('This task has no recorded undo path.');
    if (task.status === 'undone') return taskView(task);
    if (this.undoing.has(task.id)) throw new Error('Undo is already running for this task.');
    this.undoing.add(task.id);

    const controller = new AbortController();
    const onAbort = () => controller.abort(new TaskStoppedError('Undo was stopped.'));
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }
    const traceId = options.traceId ?? task.traceId;
    const agent = options.agent ?? task.agent;

    const step: TaskStepView = {
      id: 'undo',
      title: 'Restore the moved files',
      status: 'running',
      startedAt: this.now().toISOString(),
    };
    task.steps.push(step);
    task.status = 'running';
    this.deps.repo.save(task);
    yield { type: 'task-update', task: taskView(task) };
    yield { type: 'task-step', taskId: task.id, step: { ...step } };

    try {
      const output = await this.deps.execute(undo.tool, undo.input, {
        traceId,
        thread: options.thread ?? task.thread,
        agent,
        taskId: task.id,
        signal: controller.signal,
      });
      const raw = parseToolJson<Record<string, unknown>>(output);
      const receipt: TaskReceiptView = {
        summary: String(raw.summary ?? ''),
        moved: Number(raw.restored ?? 0),
        skipped: 0,
        failed: Number(raw.failed ?? 0),
        examples: [],
        ...(task.receipt?.journal ? { journal: task.receipt.journal } : {}),
        undoable: false,
      };
      task.undoReceipt = receipt;

      let verification: TaskVerificationView | undefined;
      if (undo.verify) {
        try {
          const checked = await this.deps.execute(undo.verify.tool, undo.verify.input, {
            traceId,
            thread: options.thread ?? task.thread,
            agent,
            taskId: task.id,
            signal: controller.signal,
          });
          verification = verificationFrom(parseToolJson<Record<string, unknown>>(checked));
          task.verification = verification;
        } catch {
          verification = undefined;
        }
      }

      const ok = receipt.failed === 0 && (verification === undefined || verification.ok);
      step.status = ok ? 'done' : 'failed';
      step.detail = receipt.summary;
      step.finishedAt = this.now().toISOString();
      task.status = ok ? 'undone' : 'failed';
      task.error = ok ? undefined : receipt.summary || verification?.summary;
      task.finishedAt = this.now().toISOString();
      this.deps.repo.save(task);
      yield { type: 'task-receipt', taskId: task.id, receipt, undo: true };
      yield {
        type: 'task-finish',
        taskId: task.id,
        status: task.status,
        ...(task.receipt ? { receipt: task.receipt } : {}),
      };
    } catch (error) {
      const stopped = error instanceof TaskStoppedError || controller.signal.aborted;
      step.status = stopped ? 'cancelled' : 'failed';
      step.detail = error instanceof Error ? error.message : String(error);
      step.finishedAt = this.now().toISOString();
      task.status = stopped ? 'cancelled' : 'failed';
      task.error = step.detail;
      task.finishedAt = this.now().toISOString();
      this.deps.repo.save(task);
      yield { type: 'task-finish', taskId: task.id, status: task.status };
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      this.undoing.delete(task.id);
    }

    return taskView(task);
  }
}
