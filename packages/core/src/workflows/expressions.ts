import vm from 'node:vm';
import type { JsonValue, Operator } from '@mimi/shared';

export interface NodeOutput {
  /** First output item of that node (its `.json`). */
  json: Record<string, JsonValue>;
  /** Every output item's `.json`. */
  items: Array<Record<string, JsonValue>>;
}

export interface ExpressionContext {
  $json: Record<string, JsonValue>;
  $index: number;
  $now: string;
  /** `YYYY-MM-DD` in the core's time zone. */
  $today?: string;
  $items: Array<Record<string, JsonValue>>;
  /** Workflow variables (`vars` in the workflow file). */
  $vars?: Record<string, JsonValue>;
  /** Outputs of nodes that already ran, keyed by node title (and id). */
  $node?: Record<string, NodeOutput>;
  $workflow?: { name: string; title: string; agent: string };
  /** What the trigger started the run with (first item and all items). */
  $trigger?: NodeOutput;
  $execution?: { id: string; mode: string };
  /** `$item(i)` — the i-th input item's json. */
  $item?: (index: number) => Record<string, JsonValue>;
  /** `$if(cond, then, else)` — n8n-style helpers. */
  $if?: (condition: unknown, whenTrue: unknown, whenFalse: unknown) => unknown;
  $ifEmpty?: (value: unknown, fallback: unknown) => unknown;
  $max?: (...values: unknown[]) => number;
  $min?: (...values: unknown[]) => number;
  $average?: (...values: unknown[]) => number;
  $number?: (value: unknown) => number;
  $string?: (value: unknown) => string;
}

const toNumber = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

/** The helpers every expression context carries; also keeps the context serializable-safe. */
function helpers(): Pick<
  ExpressionContext,
  '$item' | '$if' | '$ifEmpty' | '$max' | '$min' | '$average' | '$number' | '$string'
> {
  return {
    $if: (condition, whenTrue, whenFalse) => (condition ? whenTrue : whenFalse),
    $ifEmpty: (value, fallback) => (value === undefined || value === null || value === '' ? fallback : value),
    $max: (...values) => Math.max(...values.map(toNumber).filter((entry) => !Number.isNaN(entry))),
    $min: (...values) => Math.min(...values.map(toNumber).filter((entry) => !Number.isNaN(entry))),
    $average: (...values) => {
      const numbers = values.map(toNumber).filter((entry) => !Number.isNaN(entry));
      return numbers.length === 0 ? 0 : numbers.reduce((sum, entry) => sum + entry, 0) / numbers.length;
    },
    $number: toNumber,
    $string: (value) => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)),
  };
}

// A string that is exactly one expression keeps its type. The inner part may not
// contain "}}", so "{{ a }} {{ b }}" is two expressions and stays a string.
const PURE = /^\s*\{\{((?:(?!\}\})[\s\S])+)\}\}\s*$/;
const ANY = /\{\{([\s\S]*?)\}\}/g;

/** Evaluates one n8n-style expression (`$json.From`, `$json.Subject.includes("x")`, ...). */
export function evaluate(expression: string, context: ExpressionContext, timeoutMs = 1000): unknown {
  return vm.runInNewContext(`(${expression}\n)`, { ...context }, { timeout: timeoutMs });
}

function toJson(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') {
    try {
      return JSON.parse(JSON.stringify(value)) as JsonValue;
    } catch {
      return String(value);
    }
  }
  return value as JsonValue;
}

/** A string with expressions: a lone `{{ … }}` keeps its type, otherwise values are interpolated. */
export function resolveString(text: string, context: ExpressionContext): JsonValue {
  const pure = PURE.exec(text);
  if (pure) return toJson(evaluate(pure[1]!, context));
  if (!text.includes('{{')) return text;
  return text.replace(ANY, (_match, expression: string) => {
    const value = toJson(evaluate(expression, context));
    return value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

/** Resolves every string inside a config value, however deeply it is nested. */
export function resolveValue(value: JsonValue, context: ExpressionContext): JsonValue {
  if (typeof value === 'string') return resolveString(value, context);
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, context)]));
  }
  return value;
}

export function contextFor(
  item: { json: Record<string, JsonValue> },
  index: number,
  items: Array<{ json: Record<string, JsonValue> }>,
  extras: Partial<ExpressionContext> = {},
): ExpressionContext {
  const jsons = items.map((entry) => entry.json);
  return {
    ...helpers(),
    $json: item.json,
    $index: index,
    $now: new Date().toISOString(),
    $items: jsons,
    $item: (at: number) => jsons[at] ?? {},
    ...extras,
  };
}

const text = (value: unknown): string =>
  value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const number = (value: unknown): number => (typeof value === 'number' ? value : Number(text(value)));

/** The operators `if` and `switch` understand. Never throws: a bad regex is simply false. */
export function applyOperator(left: unknown, operator: Operator, right: unknown): boolean {
  const a = text(left);
  const b = text(right);
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  switch (operator) {
    case 'equals':
      return a === b;
    case 'not_equals':
      return a !== b;
    case 'contains':
      return lowerA.includes(lowerB);
    case 'not_contains':
      return !lowerA.includes(lowerB);
    case 'starts_with':
      return lowerA.startsWith(lowerB);
    case 'ends_with':
      return lowerA.endsWith(lowerB);
    case 'regex':
      try {
        return new RegExp(b, 'i').test(a);
      } catch {
        return false;
      }
    case 'gt':
      return number(left) > number(right);
    case 'lt':
      return number(left) < number(right);
    case 'gte':
      return number(left) >= number(right);
    case 'lte':
      return number(left) <= number(right);
    case 'is_empty':
      return a.trim() === '';
    case 'is_not_empty':
      return a.trim() !== '';
    case 'is_true':
      return left === true || a === 'true';
    case 'is_false':
      return left === false || a === 'false';
    default:
      return false;
  }
}

export const asText = text;
