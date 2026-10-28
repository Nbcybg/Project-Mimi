import type { JsonValue, Operator } from '@mimi/shared';
import { type SandboxValue, sandbox } from './sandbox.ts';

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

// A string that is exactly one expression keeps its type. The inner part may not
// contain "}}", so "{{ a }} {{ b }}" is two expressions and stays a string.
const PURE = /^\s*\{\{((?:(?!\}\})[\s\S])+)\}\}\s*$/;
const ANY = /\{\{([\s\S]*?)\}\}/g;

/** The variables an expression may name; the helpers ($if, $item, …) are defined in the sandbox. */
const VARIABLES = ['$json', '$index', '$now', '$today', '$items', '$vars', '$node', '$workflow', '$trigger', '$execution'] as const;

/**
 * Only the variables the expressions mention travel to the sandbox: most use `$json` alone,
 * and sending every item with every call would grow with the square of the item count.
 */
function variablesFor(expressions: string[], context: ExpressionContext): Record<string, unknown> {
  const text = expressions.join('\n');
  const data: Record<string, unknown> = {};
  for (const name of VARIABLES) {
    const used = text.includes(name) || (name === '$items' && text.includes('$item'));
    if (used && context[name] !== undefined) data[name] = context[name];
  }
  return data;
}

/**
 * Evaluates n8n-style expressions (`$json.From`, `$json.Subject.includes("x")`, ...) in the
 * sandbox process (sandbox.ts), never in the core: an expression may come from an imported
 * workflow. One call for the lot; the first that fails throws, as evaluating in order would.
 */
async function evaluateAll(expressions: string[], context: ExpressionContext, timeoutMs = 1000): Promise<SandboxValue[]> {
  const results = await sandbox().evaluate(expressions, variablesFor(expressions, context), timeoutMs);
  return results.map((result) => {
    if (!result.ok) throw new Error(result.error ?? 'expression failed');
    return result.value;
  });
}

/** Evaluates one expression (see evaluateAll). */
export async function evaluate(expression: string, context: ExpressionContext, timeoutMs = 1000): Promise<SandboxValue> {
  return (await evaluateAll([expression], context, timeoutMs))[0];
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

/** The expressions inside one string, in order (a lone `{{ … }}` is one, keeping its type). */
function expressionsIn(text: string): string[] {
  const pure = PURE.exec(text);
  if (pure) return [pure[1]!];
  return [...text.matchAll(ANY)].map((match) => match[1]!);
}

/** Puts a string back together from the values of its expressions (as `expressionsIn` listed them). */
function fill(text: string, values: SandboxValue[]): JsonValue {
  if (PURE.test(text)) return toJson(values[0]);
  let at = 0;
  return text.replace(ANY, () => {
    const value = toJson(values[at++]);
    return value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
}

/** A string with expressions: a lone `{{ … }}` keeps its type, otherwise values are interpolated. */
export async function resolveString(text: string, context: ExpressionContext): Promise<JsonValue> {
  if (!text.includes('{{')) return text;
  return fill(text, await evaluateAll(expressionsIn(text), context));
}

/** Resolves every string inside a config value, however deeply it is nested, with one sandbox call. */
export async function resolveValue(value: JsonValue, context: ExpressionContext): Promise<JsonValue> {
  const strings: string[] = [];
  const collect = (entry: JsonValue): void => {
    if (typeof entry === 'string') {
      if (entry.includes('{{')) strings.push(entry);
    } else if (Array.isArray(entry)) entry.forEach(collect);
    else if (entry && typeof entry === 'object') Object.values(entry).forEach(collect);
  };
  collect(value);
  if (strings.length === 0) return value;
  const lists = strings.map(expressionsIn);
  const values = await evaluateAll(lists.flat(), context);
  let next = 0;
  const filled = new Map<number, JsonValue>();
  lists.forEach((list, index) => {
    filled.set(index, fill(strings[index]!, values.slice(next, next + list.length)));
    next += list.length;
  });
  let seen = 0;
  const rebuild = (entry: JsonValue): JsonValue => {
    if (typeof entry === 'string') return entry.includes('{{') ? filled.get(seen++)! : entry;
    if (Array.isArray(entry)) return entry.map(rebuild);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, rebuild(item)]));
    return entry;
  };
  return rebuild(value);
}

/** Each node's item list is turned into `$items` once, not once per item. */
const itemJsons = new WeakMap<object, Array<Record<string, JsonValue>>>();

/**
 * The variables of one item. `$items` and `$now` are worked out only when an expression reads
 * them: most values have no expression at all, and building `$items` for every item of a node
 * would take time growing with the square of the item count.
 */
export function contextFor(
  item: { json: Record<string, JsonValue> },
  index: number,
  items: Array<{ json: Record<string, JsonValue> }>,
  extras: Partial<ExpressionContext> = {},
): ExpressionContext {
  return {
    $json: item.json,
    $index: index,
    get $now() {
      return new Date().toISOString();
    },
    get $items() {
      let jsons = itemJsons.get(items);
      if (!jsons) itemJsons.set(items, (jsons = items.map((entry) => entry.json)));
      return jsons;
    },
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
