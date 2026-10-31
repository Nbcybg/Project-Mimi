import { z } from 'zod';
import { defineTool, type ToolDefinition } from '../tools/registry.ts';
import type { MemoStore } from './state-store.ts';

const TODO_KEY = 'work-todos';
const PLAN_KEY = 'work-plan';

const todo = z.object({
  text: z.string().min(1).max(300),
  status: z.enum(['pending', 'in_progress', 'done', 'skipped']).default('pending'),
});

const planStep = z.object({
  title: z.string().min(1).max(300),
  detail: z.string().max(2000).optional(),
  done: z.boolean().optional(),
});

function renderTodos(todos: Array<z.infer<typeof todo>>): string {
  const mark = { pending: '[ ]', in_progress: '[~]', done: '[x]', skipped: '[-]' } as const;
  return todos.map((entry) => `${mark[entry.status]} ${entry.text}`).join('\n') || '(empty todo list)';
}

function readJson<T>(memos: MemoStore, agent: string, key: string, fallback: T): T {
  const memo = memos.get(agent, key);
  if (!memo) return fallback;
  try {
    return JSON.parse(memo.value) as T;
  } catch {
    return fallback;
  }
}

/** `todo_read` / `todo_write`: the visible checklist for long work in a chat. */
export function createTodoTools(memos: MemoStore): ToolDefinition<any>[] {
  const read = defineTool({
    name: 'todo_read',
    description: 'Read the current task checklist for this conversation.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'Read the todo list',
    async execute(_input, context) {
      const todos = readJson<Array<z.infer<typeof todo>>>(memos, context.agent, TODO_KEY, []);
      return renderTodos(todos);
    },
  });

  const write = defineTool({
    name: 'todo_write',
    description:
      'Replace the task checklist for longer work. Keep each step short; mark exactly one step in_progress at a time and update it as you go. Send the full list every time.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({
      todos: z.array(todo).max(50),
    }),
    summarize: (input) => `Write ${input.todos.length} todo step(s)`,
    async execute(input, context) {
      memos.save(context.agent, TODO_KEY, JSON.stringify(input.todos));
      return renderTodos(input.todos);
    },
  });

  return [read, write];
}

/** `plan_read` / `plan_set`: propose a plan; saving it asks the user for approval. */
export function createPlanTools(memos: MemoStore): ToolDefinition<any>[] {
  const read = defineTool({
    name: 'plan_read',
    description: 'Read the current plan for this conversation.',
    risk: 'read',
    target: 'core',
    inputSchema: z.object({}),
    summarize: () => 'Read the plan',
    async execute(_input, context) {
      const plan = readJson<{ goal?: string; steps?: Array<z.infer<typeof planStep>>; approvedAt?: string }>(memos, context.agent, PLAN_KEY, {});
      if (!plan.goal || !plan.steps) return 'No plan yet.';
      return [`Goal: ${plan.goal}`, ...plan.steps.map((step, index) => `${index + 1}. [${step.done ? 'x' : ' '}] ${step.title}${step.detail ? ` — ${step.detail}` : ''}`), plan.approvedAt ? `Approved at ${plan.approvedAt}` : 'Waiting for approval.'].join('\n');
    },
  });

  const set = defineTool({
    name: 'plan_set',
    description:
      'Propose the plan for a longer job before doing it. Saving a plan asks the user to approve it (a permission prompt); after approval, execute the steps and use todo_write to track progress.',
    risk: 'write',
    target: 'core',
    inputSchema: z.object({
      goal: z.string().min(1).max(1000),
      steps: z.array(planStep).min(1).max(30),
    }),
    summarize: (input) => `Plan: ${input.goal.slice(0, 100)} (${input.steps.length} step(s))`,
    async execute(input, context) {
      memos.save(context.agent, PLAN_KEY, JSON.stringify({ goal: input.goal, steps: input.steps, approvedAt: new Date().toISOString() }));
      memos.save(context.agent, TODO_KEY, JSON.stringify(input.steps.map((step) => ({ text: step.title, status: step.done ? 'done' : 'pending' }))));
      return `Plan approved and saved:\n${input.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n')}`;
    },
  });

  return [read, set];
}
