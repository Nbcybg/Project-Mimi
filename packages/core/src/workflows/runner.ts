import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  FlowItem,
  JsonValue,
  Operator,
  WorkflowNode,
  WorkflowNodeTestResult,
  WorkflowResponse,
  WorkflowRunNodeView,
  WorkflowRunResult,
  WorkflowView,
} from '@mimi/shared';
import type { ToolContext, ToolDefinition } from '../tools/registry.ts';
import { type Ask, askJson, attributesOf, categoriesOf, classifyText, extractFields } from './ai-nodes.ts';
import type { KnowledgeStore } from '../knowledge/store.ts';
import { renderHits } from '../knowledge/store.ts';
import type { ApprovalDecision } from './approvals.ts';
import { DEFAULT_TOKEN_SECRET, sendTelegram } from './telegram.ts';
import { runCodeIsolated } from './code-sandbox.ts';
import { assertPublicUrl, type Lookup } from './net-guard.ts';
import { readXlsx, sheetItems } from './xlsx.ts';
import fsp from 'node:fs/promises';
import { addTo, type DateUnit, diffIn, formatDate, parseDate, startOf } from './datetime.ts';
import {
  allowedPath,
  htmlToText,
  kindOfFile,
  MAX_MEDIA_BYTES,
  MAX_READ_BYTES,
  parseCsv,
  parseJsonFile,
  readLimited,
  toCsv,
  wildcard,
} from './file-nodes.ts';
import {
  applyOperator,
  asText,
  contextFor,
  type ExpressionContext,
  type NodeOutput,
  resolveValue,
} from './expressions.ts';
import type { TriggerPool } from './trigger-pool.ts';

export interface WorkflowMailItem {
  id: string;
  from: string;
  to: string;
  date?: string;
  subject: string;
  content: string;
}

export interface WorkflowRunnerDeps {
  /** Runs a configured agent and returns its final answer. */
  runAgent(agentName: string, prompt: string, thread: string, signal?: AbortSignal): Promise<string>;
  /** A tool or preset from the pool, by name. */
  tool(name: string): ToolDefinition | undefined;
  /** Posts a message into an agent's chat with the user. */
  /**
   * Posts into an agent's chat. `files` are chat attachment ids (any text holding them, e.g.
   * a tool's "attachment id: …" answer) or paths in the allowed folders. Throws when one is not found.
   */
  speak(agentName: string | null, text: string, files?: string[]): void;
  mail: {
    list(source: 'google' | 'microsoft', query: string, max: number): Promise<WorkflowMailItem[]>;
    markRead(source: 'google' | 'microsoft', ids: string[]): Promise<void>;
  };
  state: WorkflowState;
  allowedDirs: string[];
  /** For `$today`; defaults to the machine's zone. */
  timezone?: string;
  /** Runs another workflow of the same agent (the `workflow` node). */
  runSubWorkflow?(agent: string, name: string, items: FlowItem[], depth: number): Promise<FlowItem[]>;
  /** Stores a paused run (approval / long wait) and returns its id; without it nodes wait in memory. */
  park?(parked: ParkedRun): number;
  /** One direct model call (llm / classify / extract nodes); returns the answer's text. */
  complete?(request: ModelRequest): Promise<string>;
  /** Posts a question into an agent's chat and waits for the user's answer (the approval node). */
  requestApproval?(request: { workflow: string; agent: string; text: string; timeoutMs: number; signal?: AbortSignal }): Promise<ApprovalDecision>;
  /** A secret from the app's vault (Telegram bot token). */
  secret?(name: string): string | undefined;
  /** Per-tool overrides from the settings file (`permission` block): allow / ask / deny. */
  permissions?: Record<string, 'allow' | 'ask' | 'deny'>;
  /** DNS for the local-network guard of HTTP calls; tests that bring their own fetch skip the guard. */
  lookup?: Lookup;
  /** Telegram Bot API base URL (tests point it elsewhere). */
  telegramApi?: string;
  /** The knowledge bases (the knowledge node). */
  knowledge?: Pick<KnowledgeStore, 'search' | 'add' | 'collection' | 'allows'>;
  /** Reads a PDF / image (vision model) or audio (transcript model) for the extract_file node. */
  readMedia?(request: { agent: string; data: Buffer; mime: string; name: string; instruction: string; signal?: AbortSignal }): Promise<string>;
  /** A file sent in a chat, by attachment id. */
  attachmentFile?(id: string): { data: Buffer; mime: string; name: string } | undefined;
  fetchFn?: typeof fetch;
}

export interface ModelRequest {
  /** The workflow's agent: whose models an empty `model` means, and who the usage is logged under. */
  agent: string;
  /** "" = the agent's chat model, "@small" = its small model, else a preset name or "provider/model". */
  model: string;
  system: string;
  prompt: string;
  signal?: AbortSignal;
}

/** Message ids a mail- or poll-triggered workflow has already handled; machine-local. */
export class WorkflowState {
  private readonly file: string;
  private data: Record<string, { seen: string[]; cursor?: string }>;

  constructor(file: string) {
    this.file = file;
    this.data = {};
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { seen?: unknown }>;
      for (const [name, entry] of Object.entries(stored)) {
        const cursor = (entry as { cursor?: unknown }).cursor;
        if (Array.isArray(entry?.seen)) this.data[name] = { seen: entry.seen.map(String).slice(-500), ...(typeof cursor === 'string' ? { cursor } : {}) };
      }
    } catch {
      // first start or an unreadable file
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  seen(workflow: string): Set<string> {
    return new Set(this.data[workflow]?.seen ?? []);
  }

  mark(workflow: string, ids: string[]): void {
    const seen = this.data[workflow]?.seen ?? [];
    for (const id of ids) if (!seen.includes(id)) seen.push(id);
    this.data[workflow] = { ...this.data[workflow], seen: seen.slice(-500) };
    this.persist();
  }

  /** A position to resume from (the next Telegram update id of a bot). */
  cursor(key: string): string | undefined {
    return this.data[key]?.cursor;
  }

  setCursor(key: string, value: string): void {
    this.data[key] = { seen: this.data[key]?.seen ?? [], cursor: value };
    this.persist();
  }
}

/** Code results: n8n-style `[{ json }]` (or one `{ json }`) unwraps; anything else normalizes. */
export function unwrapItems(value: unknown): FlowItem[] {
  const isWrapped = (entry: unknown) =>
    !!entry && typeof entry === 'object' && !Array.isArray(entry) && 'json' in entry && Object.keys(entry).every((key) => key === 'json' || key === 'binary' || key === 'pairedItem');
  if (Array.isArray(value) && value.length > 0 && value.every(isWrapped)) {
    return value.map((entry) => ({ json: ((entry as { json: unknown }).json ?? {}) as Record<string, JsonValue> }));
  }
  if (isWrapped(value)) return [{ json: ((value as { json: unknown }).json ?? {}) as Record<string, JsonValue> }];
  return normalizeItems(value);
}

/** Anything JSON-shaped becomes items the way n8n does: arrays split, values wrap. */
export function normalizeItems(value: unknown): FlowItem[] {
  if (Array.isArray(value)) {
    return value.map((entry) =>
      entry && typeof entry === 'object' ? { json: entry as Record<string, JsonValue> } : { json: { value: entry as JsonValue } },
    );
  }
  if (value && typeof value === 'object') return [{ json: value as Record<string, JsonValue> }];
  return [{ json: { value: (value ?? null) as JsonValue } }];
}

interface NodeContext {
  workflow: WorkflowView;
  deps: WorkflowRunnerDeps;
  signal?: AbortSignal;
  thread: string;
  /** Identity of this run, exposed as `$execution`. */
  execution: { id: string; mode: string };
  /** Outputs of nodes that already ran, exposed as `$node` (keyed by title and id). */
  outputs: Record<string, NodeOutput>;
  /** The items the run started with, exposed as `$trigger`. */
  trigger: NodeOutput;
  /** Items routed to each node, per source node — what the merge node joins. */
  incoming: Record<string, Record<string, FlowItem[]>>;
  vars: Record<string, JsonValue>;
  today: string;
  /** How many sub-workflows deep this run is. */
  depth: number;
  /** The HTTP answer a `respond` node shaped; sent by the webhook endpoint. */
  response?: WorkflowResponse;
  /** Approvals and long waits pause the run (stored) instead of waiting in memory. */
  suspendable?: boolean;
}

/** Waits, but lets an abort end the wait immediately. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function todayIn(timezone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-CA', timezone ? { timeZone: timezone } : undefined).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Everything an expression may reference in this run. */
function contextAt(ctx: NodeContext, item: FlowItem, index: number, items: FlowItem[]): ExpressionContext {
  return contextFor(item, index, items, {
    $vars: ctx.vars,
    $node: ctx.outputs,
    $workflow: { name: ctx.workflow.name, title: ctx.workflow.title, agent: ctx.workflow.agent },
    $execution: ctx.execution,
    $today: ctx.today,
    $trigger: ctx.trigger,
  });
}

interface Condition {
  left: JsonValue;
  operator: Operator;
  right: JsonValue;
}

/**
 * Conditions of if/filter: the `conditions` array (any length), or the single
 * `left`/`operator`/`right` of workflows written before the array existed.
 */
function conditionsOf(config: Record<string, JsonValue>): Condition[] {
  const list: Condition[] = [];
  if (Array.isArray(config.conditions)) {
    for (const entry of config.conditions) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const rule = entry as Record<string, JsonValue>;
      list.push({ left: rule.left ?? null, operator: asText(rule.operator || 'is_true') as Operator, right: rule.right ?? null });
    }
  }
  if (list.length === 0 && (config.left !== undefined || config.right !== undefined || config.operator !== undefined)) {
    list.push({ left: config.left ?? null, operator: asText(config.operator || 'is_true') as Operator, right: config.right ?? null });
  }
  return list;
}

/** No conditions means "pass": a filter without rules keeps everything. */
function passesConditions(conditions: Condition[], combinator: string): boolean {
  if (conditions.length === 0) return true;
  const test = (condition: Condition) => applyOperator(condition.left, condition.operator, condition.right);
  return combinator === 'or' ? conditions.some(test) : conditions.every(test);
}

/** `a.b.c` lookups for sort/aggregate field names. */
function valueAt(json: Record<string, JsonValue>, path: string): JsonValue {
  let value: JsonValue | undefined = json;
  for (const part of path.split('.')) {
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    value = (value as Record<string, JsonValue>)[part];
  }
  return value ?? null;
}

const toFinite = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const compareText = (a: unknown, b: unknown): number => {
  const left = asText(a);
  const right = asText(b);
  return left < right ? -1 : left > right ? 1 : 0;
};

function firstOrEmpty(items: FlowItem[]): FlowItem {
  return items[0] ?? { json: {} };
}

/** The model call of the llm / classify / extract nodes, bound to one node's model choice. */
function askFor(ctx: NodeContext, nodeType: string, model: JsonValue | undefined): Ask {
  const complete = ctx.deps.complete;
  if (!complete) throw new Error(`${nodeType} node: model calls are not available here`);
  return (system, prompt) =>
    complete({ agent: ctx.workflow.agent, model: asText(model).trim(), system, prompt, signal: ctx.signal });
}

/** Up to `limit` jobs at a time; the first failure stops new jobs from starting. */
async function runPooled<T>(count: number, limit: number, job: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < count) {
      const at = next++;
      try {
        results[at] = await job(at);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return results;
}

const MAX_LOOP_ROUNDS = 1000;

async function runHttp(config: Record<string, JsonValue>, item: FlowItem, index: number, items: FlowItem[], ctx: NodeContext): Promise<FlowItem[]> {
  const resolved = resolveValue(config, contextAt(ctx, item, index, items)) as {
    method?: JsonValue;
    url?: JsonValue;
    headers?: JsonValue;
    query?: JsonValue;
    body?: JsonValue;
  };
  const url = asText(resolved.url);
  if (!url) throw new Error('HTTP node: no URL');
  await guardUrl(url, config.allowLocal === true, ctx.deps);
  let target = url;
  const query = resolved.query;
  if (query && typeof query === 'object' && !Array.isArray(query)) {
    const parsed = new URL(url);
    for (const [key, value] of Object.entries(query)) parsed.searchParams.set(key, asText(value));
    target = parsed.toString();
  }
  const method = asText(resolved.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  if (resolved.headers && typeof resolved.headers === 'object' && !Array.isArray(resolved.headers)) {
    for (const [key, value] of Object.entries(resolved.headers)) headers[key] = asText(value);
  }
  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD' && resolved.body !== undefined && resolved.body !== null) {
    body = typeof resolved.body === 'string' ? resolved.body : JSON.stringify(resolved.body);
    headers['content-type'] ??= 'application/json';
  }
  const timeout = AbortSignal.timeout(60_000);
  const response = await (ctx.deps.fetchFn ?? fetch)(target, {
    method,
    headers,
    body,
    signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${target}: ${text.slice(0, 300)}`);
  try {
    return normalizeItems(JSON.parse(text));
  } catch {
    return [{ json: { text } }];
  }
}

async function executeNode(node: WorkflowNode, items: FlowItem[], ctx: NodeContext): Promise<Record<string, FlowItem[]>> {
  const { deps, workflow } = ctx;
  switch (node.type) {
    case 'agent': {
      const first = firstOrEmpty(items);
      const config = resolveValue(node.config, contextAt(ctx, first, 0, items)) as { agent?: JsonValue; instruction?: JsonValue };
      const agentName = asText(config.agent) || workflow.agent;
      const instruction = asText(config.instruction) || 'ประมวลผลข้อมูลที่ได้รับ';
      const prompt = [
        `<workflow_step workflow="${workflow.title}">`,
        instruction,
        `<input_items>\n${JSON.stringify(items.map((item) => item.json), null, 1)}\n</input_items>`,
        'ตอบเฉพาะผลลัพธ์ของขั้นนี้ ไม่ต้องมีคำนำ',
        '</workflow_step>',
      ].join('\n');
      const text = await deps.runAgent(agentName, prompt, `${ctx.thread}:${randomUUID().slice(0, 8)}`, ctx.signal);
      return { main: [{ json: { ...first.json, text } }] };
    }
    case 'chat': {
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as { agent?: JsonValue; text?: JsonValue; files?: JsonValue };
        const agent = asText(config.agent) || workflow.agent;
        const files = (Array.isArray(config.files) ? config.files.map(asText) : asText(config.files).split(/[\n,]+/))
          .map((entry) => entry.trim())
          .filter(Boolean);
        const text = asText(config.text).trim() || (files.length > 0 ? '' : asText(item.json.text));
        if (text || files.length > 0) deps.speak(agent, text, files);
        out.push(item);
      }
      return { main: out };
    }
    case 'if': {
      const pass: FlowItem[] = [];
      const fail: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as Record<string, JsonValue>;
        const passed = passesConditions(conditionsOf(config), asText(config.combinator || 'and'));
        (passed ? pass : fail).push(item);
      }
      return { true: pass, false: fail };
    }
    case 'filter': {
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as Record<string, JsonValue>;
        if (passesConditions(conditionsOf(config), asText(config.combinator || 'and'))) out.push(item);
      }
      return { main: out };
    }
    case 'switch': {
      const outputs: Record<string, FlowItem[]> = { fallback: [] };
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as Record<string, JsonValue>;
        const rules = asText(config.mode || 'value') === 'rules';
        const value = asText(config.value);
        const cases = Array.isArray(config.cases) ? config.cases : [];
        const at = cases.findIndex((entry) => {
          if (rules && entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const rule = entry as Record<string, JsonValue>;
            return applyOperator(rule.left, asText(rule.operator || 'is_true') as Operator, rule.right);
          }
          return asText(entry) === value;
        });
        const key = at >= 0 ? `case${at}` : 'fallback';
        (outputs[key] ??= []).push(item);
      }
      return outputs;
    }
    case 'sort': {
      const direction = asText(node.config.direction || 'asc') === 'desc' ? -1 : 1;
      const type = asText(node.config.type || 'auto');
      const field = asText(node.config.field);
      const keyed = items.map((item, index) => {
        const raw = field.includes('{{')
          ? resolveValue(field, contextAt(ctx, item, index, items))
          : valueAt(item.json, field);
        return { item, key: raw };
      });
      const compare = (a: JsonValue, b: JsonValue): number => {
        if (type === 'number') return toFinite(a) - toFinite(b);
        if (type === 'date') return Date.parse(asText(a) || '') - Date.parse(asText(b) || '') || 0;
        if (type === 'string') return compareText(a, b);
        const na = Number(a);
        const nb = Number(b);
        const numeric = a !== null && a !== '' && b !== null && b !== '' && Number.isFinite(na) && Number.isFinite(nb);
        return numeric ? na - nb : compareText(a, b);
      };
      const sorted = [...keyed].sort((x, y) => compare(x.key, y.key) * direction);
      return { main: sorted.map((entry) => entry.item) };
    }
    case 'limit': {
      const max = Math.max(0, Math.floor(Number(node.config.max)));
      if (!Number.isFinite(max)) throw new Error('limit node: "max" must be a number');
      if (max === 0) return { main: [] };
      return { main: asText(node.config.keep || 'first') === 'last' ? items.slice(-max) : items.slice(0, max) };
    }
    case 'aggregate': {
      const mode = asText(node.config.mode || 'collect');
      const name = asText(node.config.name) || 'value';
      const field = asText(node.config.field);
      const valueOf = (item: FlowItem, index: number): JsonValue =>
        field ? resolveValue(field, contextAt(ctx, item, index, items)) : (item.json.value ?? null);
      if (mode === 'collect') {
        const configured = Array.isArray(node.config.fields)
          ? node.config.fields.map((entry) => asText(entry)).filter(Boolean)
          : [];
        const names = configured.length > 0 ? configured : [...new Set(items.flatMap((item) => Object.keys(item.json)))];
        const json: Record<string, JsonValue> = {};
        for (const key of names) json[key] = items.map((item) => item.json[key] ?? null);
        return { main: [{ json }] };
      }
      if (mode === 'count') return { main: [{ json: { count: items.length } }] };
      if (mode === 'join') {
        const separator = node.config.separator === undefined ? '\n' : asText(node.config.separator);
        return { main: [{ json: { [name]: items.map((item, index) => asText(valueOf(item, index))).join(separator) } }] };
      }
      const numbers = items.map((item, index) => Number(valueOf(item, index))).filter((value) => Number.isFinite(value));
      const sum = numbers.reduce((total, value) => total + value, 0);
      const result =
        mode === 'sum'
          ? sum
          : mode === 'average'
            ? numbers.length === 0
              ? 0
              : sum / numbers.length
            : mode === 'min'
              ? numbers.length === 0
                ? 0
                : Math.min(...numbers)
              : mode === 'max'
                ? numbers.length === 0
                  ? 0
                  : Math.max(...numbers)
                : Number.NaN;
      if (Number.isNaN(result)) throw new Error(`aggregate node: unknown mode "${mode}"`);
      return { main: [{ json: { [name]: result } }] };
    }
    case 'remove_duplicates': {
      const fields = Array.isArray(node.config.fields)
        ? node.config.fields.map((entry) => asText(entry)).filter(Boolean)
        : [];
      const keyOf = (item: FlowItem) =>
        fields.length > 0 ? JSON.stringify(fields.map((key) => item.json[key] ?? null)) : JSON.stringify(item.json);
      const seen = new Set<string>();
      if (asText(node.config.keep || 'first') === 'last') {
        const out: FlowItem[] = [];
        for (let index = items.length - 1; index >= 0; index--) {
          const item = items[index]!;
          const key = keyOf(item);
          if (seen.has(key)) continue;
          seen.add(key);
          out.unshift(item);
        }
        return { main: out };
      }
      const out: FlowItem[] = [];
      for (const item of items) {
        const key = keyOf(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
      }
      return { main: out };
    }
    case 'set': {
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const fields = resolveValue(node.config.fields ?? {}, contextAt(ctx, item, index, items));
        out.push({ json: { ...item.json, ...((fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {}) as Record<string, JsonValue>) } });
      }
      return { main: out };
    }
    case 'code': {
      const code = String(node.config.code ?? '');
      if (!code.trim()) throw new Error('code node: no code');
      // A separate locked-down process: no files, no programs, no keys (see code-sandbox.ts).
      const { result } = await runCodeIsolated(code, items.map((item) => item.json), { signal: ctx.signal });
      if (result === undefined) return { main: items };
      return { main: unwrapItems(result) };
    }
    case 'tool': {
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as { tool?: JsonValue; input?: JsonValue };
        const toolName = asText(config.tool);
        const tool = deps.tool(toolName);
        if (!tool) throw new Error(`tool node: unknown tool "${toolName}"`);
        // Unattended runs cannot ask: anything beyond reading needs the node's own consent
        // (or an "allow" for the tool in the settings file). A "deny" there always wins.
        const policy = deps.permissions?.[toolName];
        if (policy === 'deny') throw new Error(`tool node: "${toolName}" is denied in the settings file`);
        if (tool.risk !== 'read' && policy !== 'allow' && node.config.allow !== true) {
          throw new Error(`tool node: "${toolName}" can change things (${tool.risk}); tick "อนุญาตให้ทำงานนี้" on the node to let the workflow run it`);
        }
        const parsed = tool.inputSchema.safeParse(config.input ?? {});
        if (!parsed.success) throw new Error(`tool node "${toolName}": invalid input`);
        const context: ToolContext = {
          traceId: `workflow:${ctx.thread}`,
          thread: ctx.thread,
          agent: 'workflow',
          allowedDirs: deps.allowedDirs,
          signal: ctx.signal,
        };
        const text = await tool.execute(parsed.data, context, {});
        out.push({ json: { ...item.json, text } });
      }
      return { main: out };
    }
    case 'http': {
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) out.push(...(await runHttp(node.config, item, index, items, ctx)));
      return { main: out };
    }
    case 'merge': {
      const streams = Object.values(ctx.incoming[node.id] ?? {});
      const mode = asText(node.config.mode || 'append');
      if (mode === 'append' || streams.length <= 1) return { main: items };
      if (mode === 'combine') {
        const length = Math.max(0, ...streams.map((stream) => stream.length));
        const out: FlowItem[] = [];
        for (let at = 0; at < length; at++) {
          const json: Record<string, JsonValue> = {};
          for (const stream of streams) Object.assign(json, stream[at]?.json ?? {});
          out.push({ json });
        }
        return { main: out };
      }
      if (mode === 'by_key') {
        const key = asText(node.config.key);
        if (!key) throw new Error('merge node: "key" is required for by_key');
        const merged = new Map<string, Record<string, JsonValue>>();
        const order: string[] = [];
        for (const stream of streams) {
          for (const item of stream) {
            const value = asText(item.json[key]);
            if (!merged.has(value)) {
              merged.set(value, {});
              order.push(value);
            }
            Object.assign(merged.get(value)!, item.json);
          }
        }
        return { main: order.map((value) => ({ json: merged.get(value)! })) };
      }
      throw new Error(`merge node: unknown mode "${mode}"`);
    }
    case 'wait': {
      const config = resolveValue(node.config, contextAt(ctx, firstOrEmpty(items), 0, items)) as Record<string, JsonValue>;
      const amount = Math.max(0, Number(config.amount ?? 0));
      const unit = asText(config.unit || 'seconds');
      const factor = unit === 'days' ? 86_400 : unit === 'hours' ? 3600 : unit === 'minutes' ? 60 : 1;
      const wanted = amount * factor * 1000;
      if (!Number.isFinite(wanted)) throw new Error('wait node: "amount" must be a number');
      // Over a minute, a stored run is paused and woken up later (up to 30 days); in memory the cap is an hour.
      if (ctx.suspendable && wanted > 60_000) throw new RunSuspended({ kind: 'wait', resumeAt: new Date(Date.now() + Math.min(wanted, 30 * 86_400_000)).toISOString() });
      const ms = Math.min(3_600_000, wanted);
      if (ms > 0) await sleep(ms, ctx.signal);
      return { main: items };
    }
    case 'workflow': {
      const config = resolveValue(node.config, contextAt(ctx, firstOrEmpty(items), 0, items)) as Record<string, JsonValue>;
      const name = asText(config.workflow);
      if (!name) throw new Error('workflow node: pick a workflow');
      if (!deps.runSubWorkflow) throw new Error('workflow node: sub-workflows are not available here');
      if (ctx.depth >= 5) throw new Error('workflow node: too many nested workflows (max 5)');
      const input = config.input === undefined || config.input === null ? items : normalizeItems(config.input);
      return { main: await deps.runSubWorkflow(ctx.workflow.agent, name, input, ctx.depth + 1) };
    }
    case 'respond': {
      const config = resolveValue(node.config, contextAt(ctx, firstOrEmpty(items), 0, items)) as Record<string, JsonValue>;
      const rawStatus = Number(config.status ?? 200);
      const status = Number.isFinite(rawStatus) ? Math.min(599, Math.max(100, Math.floor(rawStatus))) : 200;
      const headers: Record<string, string> = {};
      if (config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)) {
        for (const [key, value] of Object.entries(config.headers)) headers[key] = asText(value);
      }
      const body =
        config.body === undefined || config.body === null
          ? items.length === 1
            ? items[0]!.json
            : items.map((item) => item.json)
          : config.body;
      ctx.response = { status, headers, body };
      return { main: items };
    }
    case 'llm': {
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as Record<string, JsonValue>;
        const prompt = asText(config.prompt).trim();
        if (!prompt) throw new Error('llm node: the prompt is empty');
        const ask = askFor(ctx, 'llm', config.model);
        const system = asText(config.system).trim();
        const value = asText(config.format) === 'json' ? await askJson(ask, system, prompt) : (await ask(system, prompt)).trim();
        out.push({ json: { ...item.json, [asText(config.name).trim() || 'text']: value } });
      }
      return { main: out };
    }
    case 'classify': {
      const outputs: Record<string, FlowItem[]> = { fallback: [] };
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as Record<string, JsonValue>;
        const categories = categoriesOf(config.categories);
        if (categories.length === 0) throw new Error('classify node: add at least one category');
        const at = await classifyText(askFor(ctx, 'classify', config.model), asText(config.input), categories, asText(config.instruction));
        const key = at >= 0 ? `cat${at}` : 'fallback';
        (outputs[key] ??= []).push({ json: { ...item.json, category: at >= 0 ? categories[at]!.name : null } });
      }
      return outputs;
    }
    case 'extract': {
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as Record<string, JsonValue>;
        const attributes = attributesOf(config.attributes);
        if (attributes.length === 0) throw new Error('extract node: add at least one field');
        const values = await extractFields(askFor(ctx, 'extract', config.model), asText(config.input), attributes, asText(config.instruction));
        const target = asText(config.target).trim();
        out.push({ json: target ? { ...item.json, [target]: values } : { ...item.json, ...values } });
      }
      return { main: out };
    }
    case 'split_out': {
      const field = asText(node.config.field).trim();
      if (!field) throw new Error('split_out node: name the field that holds the array');
      const dynamic = field.includes('{{');
      const keepOthers = asText(node.config.include || 'none') === 'all';
      const name = asText(node.config.name).trim() || (dynamic ? 'value' : field.split('.').at(-1)!);
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const raw = dynamic ? resolveValue(field, contextAt(ctx, item, index, items)) : valueAt(item.json, field);
        const list = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
        const base: Record<string, JsonValue> = keepOthers ? { ...item.json } : {};
        // The array itself is not carried along next to its own entries.
        if (keepOthers && !dynamic) delete base[field.split('.')[0]!];
        for (const entry of list) {
          out.push({
            json: entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...base, ...entry } : { ...base, [name]: entry },
          });
        }
      }
      return { main: out };
    }
    case 'loop': {
      const config = resolveValue(node.config, contextAt(ctx, firstOrEmpty(items), 0, items)) as Record<string, JsonValue>;
      const name = asText(config.workflow);
      if (!name) throw new Error('loop node: pick a workflow to run');
      if (!deps.runSubWorkflow) throw new Error('loop node: sub-workflows are not available here');
      if (ctx.depth >= 5) throw new Error('loop node: too many nested workflows (max 5)');
      const size = Math.max(1, Math.floor(Number(config.batchSize) || 1));
      const parallel = Math.min(5, Math.max(1, Math.floor(Number(config.parallel) || 1)));
      const skip = asText(config.onItemError) === 'skip';
      const batches: FlowItem[][] = [];
      for (let at = 0; at < items.length; at += size) batches.push(items.slice(at, at + size));
      if (batches.length > MAX_LOOP_ROUNDS) throw new Error(`loop node: ${batches.length} rounds is too many (max ${MAX_LOOP_ROUNDS}); raise the batch size`);
      const results = await runPooled(batches.length, parallel, async (at) => {
        if (ctx.signal?.aborted) throw new Error('aborted');
        const batch = batches[at]!;
        try {
          return await deps.runSubWorkflow!(workflow.agent, name, batch, ctx.depth + 1);
        } catch (error) {
          if (!skip) throw new Error(`loop round ${at + 1}: ${(error as Error).message}`);
          // A skipped round passes its items on, marked with what went wrong.
          return batch.map((item) => ({ json: { ...item.json, error: (error as Error).message } }));
        }
      });
      return { main: results.flat() };
    }
    case 'approval': {
      const config = resolveValue(node.config, contextAt(ctx, firstOrEmpty(items), 0, items)) as Record<string, JsonValue>;
      if (!deps.requestApproval && !ctx.suspendable) throw new Error('approval node: approvals are not available here');
      const text = asText(config.message).trim();
      if (!text) throw new Error('approval node: write the question to ask');
      const minutes = Number(config.timeoutMinutes);
      const timeoutMs = Math.min(1440 * 30, Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
      // A stored run survives a restart: the answer resumes it whenever it comes.
      if (ctx.suspendable) throw new RunSuspended({ kind: 'approval', agent: asText(config.agent) || workflow.agent, text, timeoutMs });
      if (timeoutMs > 1440 * 60_000) throw new Error('approval node: waiting longer than a day needs a top-level run (not a sub-workflow or a node test)');
      const answer = await deps.requestApproval!({
        workflow: `${workflow.agent}/${workflow.name}`,
        agent: asText(config.agent) || workflow.agent,
        text,
        timeoutMs,
        signal: ctx.signal,
      });
      const approval: Record<string, JsonValue> = { decision: answer.decision, at: new Date().toISOString(), ...(answer.note ? { note: answer.note } : {}) };
      return { [answer.decision]: items.map((item) => ({ json: { ...item.json, approval } })) };
    }
    case 'telegram': {
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as Record<string, JsonValue>;
        const secretName = asText(config.tokenSecret).trim() || DEFAULT_TOKEN_SECRET;
        const token = deps.secret?.(secretName);
        if (!token) throw new Error(`telegram node: no secret "${secretName}" — add the bot token under Settings → secrets`);
        const chatId = asText(config.chatId).trim();
        if (!chatId) throw new Error('telegram node: no chat id');
        const text = asText(config.text).trim() || asText(item.json.text);
        if (!text) throw new Error('telegram node: the message is empty');
        const parseMode = asText(config.parseMode);
        const messageId = await sendTelegram(token, chatId, text, {
          parseMode: parseMode === 'Markdown' || parseMode === 'HTML' ? parseMode : undefined,
          fetchFn: deps.fetchFn,
          apiBase: deps.telegramApi,
          signal: ctx.signal,
        });
        out.push({ json: { ...item.json, telegram: { chatId, messageId } } });
      }
      return { main: out };
    }
    case 'datetime': {
      const timeZone = (zone: JsonValue | undefined) => asText(zone).trim() || deps.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as Record<string, JsonValue>;
        const zone = timeZone(config.timezone);
        const operation = asText(config.operation || 'format');
        const unit = (asText(config.unit) || 'days') as DateUnit;
        const date = parseDate(config.value, zone);
        const name = asText(config.name).trim() || 'date';
        let value: JsonValue;
        if (operation === 'diff') {
          value = diffIn(date, parseDate(config.other, zone), unit, zone);
        } else {
          const amount = Number(config.amount ?? 1);
          if (!Number.isFinite(amount)) throw new Error('datetime node: "amount" must be a number');
          const shifted =
            operation === 'add'
              ? addTo(date, amount, unit, zone)
              : operation === 'subtract'
                ? addTo(date, -amount, unit, zone)
                : operation === 'start_of'
                  ? startOf(date, unit === 'weeks' ? 'week' : unit === 'months' ? 'month' : unit === 'years' ? 'year' : 'day', zone)
                  : date;
          value = formatDate(shifted, asText(config.format), zone);
        }
        out.push({ json: { ...item.json, [name]: value } });
      }
      return { main: out };
    }
    case 'file': {
      const operation = asText(node.config.operation || 'read');
      const at = (item: FlowItem, index: number) => resolveValue(node.config, contextAt(ctx, item, index, items)) as Record<string, JsonValue>;
      if (operation === 'write' && asText(node.config.source || 'content') !== 'content') {
        // All items go into one file, as JSON or CSV.
        const config = at(firstOrEmpty(items), 0);
        const file = allowedPath(asText(config.path), deps.allowedDirs);
        const body = asText(config.source) === 'items_csv' ? toCsv(items) : `${JSON.stringify(items.map((item) => item.json), null, 2)}\n`;
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, body, 'utf8');
        return { main: [{ json: { path: file, bytes: Buffer.byteLength(body), items: items.length } }] };
      }
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const config = at(item, index);
        const file = allowedPath(asText(config.path), deps.allowedDirs);
        if (operation === 'list') {
          const filter = asText(config.pattern).trim() ? wildcard(asText(config.pattern).trim()) : null;
          const entries = await fsp.readdir(file, { withFileTypes: true });
          for (const entry of entries) {
            if (filter && !filter.test(entry.name)) continue;
            const full = path.join(file, entry.name);
            const stat = await fsp.stat(full).catch(() => null);
            out.push({ json: { name: entry.name, path: full, isDir: entry.isDirectory(), size: stat?.size ?? 0, modified: stat?.mtime.toISOString() ?? '' } });
          }
          continue;
        }
        if (operation === 'write' || operation === 'append') {
          const content = asText(config.content);
          await fsp.mkdir(path.dirname(file), { recursive: true });
          if (operation === 'write') await fsp.writeFile(file, content, 'utf8');
          else {
            // Each appended entry starts on its own line.
            const existing = await fsp.stat(file).then((stat) => stat.size, () => 0);
            const needsBreak = existing > 0 && !(await fsp.readFile(file, 'utf8')).endsWith('\n');
            await fsp.appendFile(file, `${needsBreak ? '\n' : ''}${content}${content.endsWith('\n') ? '' : '\n'}`, 'utf8');
          }
          out.push({ json: { ...item.json, file: { path: file, bytes: Buffer.byteLength(content) } } });
          continue;
        }
        const text = (await readLimited(file, MAX_READ_BYTES)).toString('utf8');
        const format = asText(config.format || 'text');
        if (format === 'json') out.push(...parseJsonFile(text, normalizeItems));
        else if (format === 'csv') out.push(...parseCsv(text));
        else if (format === 'lines') out.push(...text.split(/\r?\n/).filter((line) => line.trim()).map((line, number) => ({ json: { line, number: number + 1 } })));
        else out.push({ json: { ...item.json, [asText(config.name).trim() || 'content']: text, path: file } });
      }
      return { main: out };
    }
    case 'extract_file': {
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as Record<string, JsonValue>;
        // A file in the allowed folders, or one sent in the chat (by attachment id).
        const attachmentId = asText(config.attachment).trim();
        let fileName: string;
        let load: (limit: number) => Promise<Buffer>;
        let fileMime = '';
        if (attachmentId) {
          const sent = deps.attachmentFile?.(attachmentId);
          if (!sent) throw new Error(`extract_file node: no chat file "${attachmentId}"`);
          fileName = sent.name;
          fileMime = sent.mime;
          load = async (limit) => {
            if (sent.data.length > limit) throw new Error(`"${sent.name}" is ${(sent.data.length / 1048576).toFixed(1)} MB; the limit is ${limit / 1048576} MB`);
            return sent.data;
          };
        } else {
          if (!asText(config.path).trim()) throw new Error('extract_file node: set a path or a chat file id');
          const file = allowedPath(asText(config.path), deps.allowedDirs);
          fileName = file;
          load = (limit) => readLimited(file, limit);
        }
        const detected = kindOfFile(fileName);
        // A chat file's own type wins when its name has no telling extension.
        if (fileMime && detected.kind === 'text' && /^(image|audio|video)\//.test(fileMime)) {
          detected.kind = fileMime.split('/')[0] as 'image' | 'audio' | 'video';
          detected.mime = fileMime;
        } else if (fileMime === 'application/pdf') {
          detected.kind = 'pdf';
          detected.mime = fileMime;
        }
        const wanted = asText(config.type || 'auto');
        const kind = wanted === 'auto' ? detected.kind : wanted;
        const name = asText(config.name).trim() || 'text';
        const base = { ...item.json, file: path.basename(fileName) };
        if (kind === 'xls') throw new Error('extract_file node: old .xls files are not supported; save it as .xlsx or CSV');
        if (kind === 'xlsx') {
          const sheets = readXlsx(await load(MAX_READ_BYTES));
          const wanted = asText(config.sheet).trim();
          const sheet = wanted ? sheets.find((entry) => entry.name === wanted) : sheets[0];
          if (!sheet) throw new Error(`extract_file node: no sheet "${wanted}" (sheets: ${sheets.map((entry) => entry.name).join(', ')})`);
          for (const row of sheetItems(sheet, asText(config.header || 'header') !== 'data')) out.push({ json: row as Record<string, JsonValue> });
          continue;
        }
        if (kind === 'csv') {
          const text = (await load(MAX_READ_BYTES)).toString('utf8');
          out.push(...parseCsv(text, asText(config.header || 'header') !== 'data'));
        } else if (kind === 'json') {
          out.push(...parseJsonFile((await load(MAX_READ_BYTES)).toString('utf8'), normalizeItems));
        } else if (kind === 'text' || kind === 'html') {
          const text = (await load(MAX_READ_BYTES)).toString('utf8');
          out.push({ json: { ...base, [name]: kind === 'html' ? htmlToText(text) : text } });
        } else {
          if (!deps.readMedia) throw new Error('extract_file node: reading PDFs, images, audio and video is not available here');
          const data = await load(MAX_MEDIA_BYTES);
          const mime = detected.kind === kind ? detected.mime : kind === 'pdf' ? 'application/pdf' : detected.mime;
          const text = await deps.readMedia({ agent: workflow.agent, data, mime, name: path.basename(fileName), instruction: asText(config.instruction).trim(), signal: ctx.signal });
          out.push({ json: { ...base, [name]: text } });
        }
      }
      return { main: out };
    }
    case 'knowledge': {
      const knowledge = deps.knowledge;
      if (!knowledge) throw new Error('knowledge node: knowledge bases are not available here');
      const out: FlowItem[] = [];
      for (const [index, item] of items.entries()) {
        const config = resolveValue(node.config, contextAt(ctx, item, index, items)) as Record<string, JsonValue>;
        const collection = asText(config.collection).trim();
        if (asText(config.operation || 'search') === 'add') {
          if (!collection) throw new Error('knowledge node: pick the knowledge base to add to');
          const target = knowledge.collection(collection);
          if (target && !knowledge.allows(target, workflow.agent)) throw new Error(`knowledge node: "${collection}" is not open to ${workflow.agent}`);
          const text = asText(config.text).trim() || asText(item.json.text).trim();
          if (!text) throw new Error('knowledge node: nothing to add (the text is empty)');
          const added = await knowledge.add(collection, { title: asText(config.title), text, source: asText(config.source) }, ctx.signal);
          out.push({ json: { ...item.json, knowledge: { documentId: added.document.id, chunks: added.document.chunks, ...(added.warning ? { warning: added.warning } : {}) } } });
          continue;
        }
        const query = asText(config.query).trim() || asText(item.json.text).trim();
        if (!query) throw new Error('knowledge node: the search query is empty');
        const limit = Number(config.limit) || 5;
        const hits = await knowledge.search(query, { collection: collection || undefined, limit, signal: ctx.signal, agent: workflow.agent });
        if (asText(config.output || 'context') === 'items') {
          for (const hit of hits) out.push({ json: { query, text: hit.text, document: hit.document, source: hit.source, collection: hit.collection, score: hit.score } });
        } else {
          out.push({
            json: {
              ...item.json,
              context: renderHits(hits),
              hits: hits.map((hit) => ({ document: hit.document, source: hit.source, text: hit.text, score: hit.score })),
            },
          });
        }
      }
      return { main: out };
    }
    default:
      throw new Error(`Unknown node type "${String((node as { type: string }).type)}".`);
  }
}

const MAX_NODES = 60;

/**
 * Everything a run needs to go on: plain JSON, so a run that pauses (an approval, a
 * long wait) can be stored in the database and finished after a restart.
 */
export interface RunState {
  thread: string;
  execution: { id: string; mode: string };
  depth: number;
  trigger: NodeOutput;
  outputs: Record<string, NodeOutput>;
  /** Items routed to each node so far. */
  collected: Record<string, FlowItem[]>;
  /** Predecessors each node still waits for. */
  remaining: Record<string, number>;
  /** Items routed to each node, per source node (what merge joins). */
  incoming: Record<string, Record<string, FlowItem[]>>;
  queue: string[];
  views: WorkflowRunNodeView[];
  startIds: string[];
  failed: boolean;
  response?: WorkflowResponse;
  /** Pinned node outputs stand in for running those nodes (runs from the editor). */
  usePins?: boolean;
}

/** Extra ways to start a run from the editor. */
export interface RunOptions {
  usePins?: boolean;
  /** Start at this node with these items; only it and what follows it run. */
  startAt?: { nodeId: string; input: FlowItem[]; outputs?: Record<string, NodeOutput> };
}

/** Where a node that does not run sends its items: "main" when linked, else its first linked output. */
function passOutput(node: WorkflowNode): string {
  const links = node.links ?? {};
  if ((links.main ?? []).length > 0) return 'main';
  return Object.keys(links).find((key) => key !== 'error' && (links[key] ?? []).length > 0) ?? 'main';
}

/** What a paused node waits for. */
export type SuspendWait =
  | { kind: 'approval'; agent: string; text: string; timeoutMs: number }
  | { kind: 'wait'; resumeAt: string };

/** Thrown by a node that waits for something outside the run; the run is stored instead. */
export class RunSuspended extends Error {
  readonly wait: SuspendWait;
  constructor(wait: SuspendWait) {
    super(wait.kind === 'approval' ? 'waiting for approval' : `waiting until ${wait.resumeAt}`);
    this.wait = wait;
  }
}

/** A stored, paused run: the state plus the node that waits and the items it got. */
export interface ParkedRun {
  workflow: { agent: string; name: string };
  nodeId: string;
  input: FlowItem[];
  wait: SuspendWait;
  state: RunState;
}

/** How a paused node ends: the approval's answer, or the wait being over. */
export type ResumeOutcome = { kind: 'approval'; decision: 'approved' | 'rejected' | 'timeout'; note?: string } | { kind: 'wait' };

function contextFrom(workflow: WorkflowView, state: RunState, deps: WorkflowRunnerDeps, signal?: AbortSignal): NodeContext {
  return {
    workflow,
    deps,
    signal,
    thread: state.thread,
    execution: state.execution,
    outputs: state.outputs,
    trigger: state.trigger,
    incoming: state.incoming,
    vars: workflow.vars ?? {},
    today: todayIn(deps.timezone),
    depth: state.depth,
    suspendable: Boolean(deps.park) && state.depth === 0,
  };
}

function recordOutput(state: RunState, node: WorkflowNode, view: WorkflowRunNodeView): void {
  if (view.output.length === 0) return;
  // Later nodes can read this one's output through `$node` (by title and by id).
  const record: NodeOutput = { json: view.output[0]?.json ?? {}, items: view.output.map((entry) => entry.json) };
  state.outputs[node.title?.trim() || node.id] = record;
  state.outputs[node.id] = record;
}

function settle(state: RunState, node: WorkflowNode, outputs: Record<string, FlowItem[]>): void {
  for (const [outputKey, targets] of Object.entries(node.links ?? {})) {
    const routed = outputs[outputKey] ?? [];
    for (const target of new Set(targets)) {
      if (routed.length > 0) {
        state.collected[target] = [...(state.collected[target] ?? []), ...routed];
        const perSource = (state.incoming[target] ??= {});
        perSource[node.id] = [...(perSource[node.id] ?? []), ...routed];
      }
      const left = (state.remaining[target] ?? 1) - 1;
      state.remaining[target] = left;
      if (left <= 0 && !state.queue.includes(target)) state.queue.push(target);
    }
  }
}

function resultOf(workflow: WorkflowView, state: RunState, suspended?: WorkflowRunResult['suspended']): WorkflowRunResult {
  const views = state.views;
  if (suspended) {
    return {
      name: workflow.name,
      ok: true,
      result: suspended.kind === 'approval' ? '⏸ รออนุมัติ' : `⏸ รอถึง ${suspended.resumeAt}`,
      suspended,
      ...(state.response ? { response: state.response } : {}),
      nodes: views,
    };
  }
  const last = views.findLast((view) => view.status === 'ok' && view.output.length > 0) ?? views.at(-1);
  const finalItem = last?.output[0]?.json ?? {};
  const result = finalItem.text !== undefined ? asText(finalItem.text) : asText(finalItem);
  const error = views.find((view) => view.status === 'error')?.error;
  return {
    name: workflow.name,
    ok: !state.failed,
    result: error ? `error: ${error}` : `${last?.title ?? ''}: ${result}`.trim().slice(0, 500),
    ...(state.response ? { response: state.response } : {}),
    nodes: views,
  };
}

/** Runs queued nodes until the run ends or a node pauses it. */
async function drive(workflow: WorkflowView, state: RunState, deps: WorkflowRunnerDeps, signal?: AbortSignal): Promise<WorkflowRunResult> {
  const context = contextFrom(workflow, state, deps, signal);
  const nodes = workflow.nodes;
  const startIds = new Set(state.startIds);
  while (state.queue.length > 0 && state.views.length < MAX_NODES) {
    if (state.failed) break;
    const id = state.queue.shift()!;
    const node = nodes.find((entry) => entry.id === id);
    if (!node) continue; // the workflow changed while the run was paused
    const input = state.collected[id] ?? [];
    // Nothing reached this node (the other branch of an if, an empty poll): it does not
    // run, but its successors still settle so a merge-style node downstream can finish.
    if (input.length === 0 && !startIds.has(id)) {
      settle(state, node, {});
      continue;
    }
    const view: WorkflowRunNodeView = { id, title: node.title?.trim() || node.id, type: node.type, status: 'ok', input, output: [] };
    // Switched off, or pinned in an editor run: the node is not run.
    if (node.disabled || (state.usePins && Array.isArray(node.pinned))) {
      const items = node.disabled ? input : node.pinned!.map((json) => ({ json: { ...json } }));
      const passed = { [passOutput(node)]: items };
      view.note = node.disabled ? 'disabled' : 'pinned';
      view.output = items;
      state.views.push(view);
      recordOutput(state, node, view);
      settle(state, node, passed);
      continue;
    }
    // A failing node retries first; what happens after that is its onError policy.
    let outputs: Record<string, FlowItem[]> = {};
    let error: string | undefined;
    const attempts = 1 + Math.max(0, Math.floor(Number(node.retries ?? 0)));
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        outputs = await executeNode(node, input, context);
        error = undefined;
        break;
      } catch (caught) {
        if (caught instanceof RunSuspended && deps.park) {
          // The run is stored and ends here; it goes on when the answer / time comes.
          view.status = 'waiting';
          state.views.push(view);
          state.response = context.response;
          const parked: ParkedRun = { workflow: { agent: workflow.agent, name: workflow.name }, nodeId: id, input, wait: caught.wait, state };
          const parkedId = deps.park(parked);
          return resultOf(workflow, state, { id: parkedId, nodeId: id, kind: caught.wait.kind, ...(caught.wait.kind === 'wait' ? { resumeAt: caught.wait.resumeAt } : {}) });
        }
        error = (caught as Error).message;
        if (attempt < attempts - 1 && Number(node.retryWaitMs ?? 0) > 0) {
          await sleep(Number(node.retryWaitMs), context.signal);
        }
      }
    }
    if (error !== undefined) {
      view.status = 'error';
      view.error = attempts > 1 ? `${error} (${attempts} attempts)` : error;
      const onError = node.onError ?? 'stop';
      if (onError === 'continue') outputs = { main: input };
      else if (onError === 'branch') outputs = { error: input };
      else state.failed = true;
    }
    view.output = outputs.main ?? Object.values(outputs).flat();
    state.views.push(view);
    recordOutput(state, node, view);
    settle(state, node, outputs);
  }
  state.response = context.response ?? state.response;
  return resultOf(workflow, state);
}

/**
 * Runs a workflow as a DAG: trigger items enter at the node(s) nothing links into;
 * a node waits until every predecessor has finished, then runs once with all items
 * routed its way. Every node's input and output is kept for the run view.
 */
export async function runWorkflow(
  workflow: WorkflowView,
  initialItems: FlowItem[],
  deps: WorkflowRunnerDeps,
  signal?: AbortSignal,
  mode = 'manual',
  depth = 0,
  options: RunOptions = {},
): Promise<WorkflowRunResult> {
  let nodes = workflow.nodes;
  const startAt = options.startAt;
  if (startAt) {
    // Only the node and everything after it take part.
    const keep = new Set<string>();
    const walk = (id: string) => {
      if (keep.has(id)) return;
      keep.add(id);
      for (const targets of Object.values(nodes.find((node) => node.id === id)?.links ?? {})) for (const target of targets) walk(target);
    };
    if (!nodes.some((node) => node.id === startAt.nodeId)) return { name: workflow.name, ok: false, result: `no node "${startAt.nodeId}"`, nodes: [] };
    walk(startAt.nodeId);
    nodes = nodes.filter((node) => keep.has(node.id));
  }
  const linkedIn = new Set(Object.values(nodes.flatMap((node) => Object.values(node.links ?? {}))).flat());
  const starts = startAt ? nodes.filter((node) => node.id === startAt.nodeId) : nodes.filter((node) => !linkedIn.has(node.id));
  if (starts.length === 0) return { name: workflow.name, ok: false, result: 'the workflow has no start node', nodes: [] };
  const kept = new Set(nodes.map((node) => node.id));
  const state: RunState = {
    thread: `workflow:${workflow.agent}/${workflow.name}:${randomUUID().slice(0, 8)}`,
    execution: { id: randomUUID(), mode },
    depth,
    trigger: { json: initialItems[0]?.json ?? {}, items: initialItems.map((item) => item.json) },
    outputs: { ...(startAt?.outputs ?? {}) },
    collected: {},
    remaining: Object.fromEntries(nodes.map((node) => [node.id, 0])),
    incoming: {},
    queue: [],
    views: [],
    startIds: starts.map((node) => node.id),
    failed: false,
    ...(options.usePins ? { usePins: true } : {}),
  };
  for (const node of nodes) {
    for (const targets of Object.values(node.links ?? {})) {
      for (const target of new Set(targets)) if (kept.has(target)) state.remaining[target] = (state.remaining[target] ?? 0) + 1;
    }
  }
  for (const start of starts) {
    state.collected[start.id] = (startAt ? startAt.input : initialItems).map((item) => ({ json: { ...item.json } }));
    state.queue.push(start.id);
  }
  return drive(workflow, state, deps, signal);
}

/** Finishes a paused run: the waiting node ends with `outcome`, then the rest runs. */
export async function resumeWorkflow(
  workflow: WorkflowView,
  parked: ParkedRun,
  outcome: ResumeOutcome,
  deps: WorkflowRunnerDeps,
  signal?: AbortSignal,
): Promise<WorkflowRunResult> {
  const state = parked.state;
  const node = workflow.nodes.find((entry) => entry.id === parked.nodeId);
  const at = state.views.findIndex((view) => view.id === parked.nodeId && view.status === 'waiting');
  if (!node) {
    state.failed = true;
    if (at >= 0) state.views[at] = { ...state.views[at]!, status: 'error', error: 'the node was removed while the run was paused' };
    return resultOf(workflow, state);
  }
  let outputs: Record<string, FlowItem[]>;
  if (outcome.kind === 'approval') {
    const approval: Record<string, JsonValue> = { decision: outcome.decision, at: new Date().toISOString(), ...(outcome.note ? { note: outcome.note } : {}) };
    outputs = { [outcome.decision]: parked.input.map((item) => ({ json: { ...item.json, approval } })) };
  } else {
    outputs = { main: parked.input };
  }
  const view: WorkflowRunNodeView = {
    id: node.id,
    title: node.title?.trim() || node.id,
    type: node.type,
    status: 'ok',
    input: parked.input,
    output: outputs.main ?? Object.values(outputs).flat(),
  };
  if (at >= 0) state.views[at] = view;
  else state.views.push(view);
  recordOutput(state, node, view);
  settle(state, node, outputs);
  return drive(workflow, state, deps, signal);
}

/** The local-network guard; a custom fetch (tests) brings its own network and skips it. */
async function guardUrl(url: string, allowLocal: boolean, deps: WorkflowRunnerDeps): Promise<void> {
  if (allowLocal) return;
  if (deps.fetchFn && !deps.lookup) return;
  await assertPublicUrl(url, deps.lookup);
}

/** The items a trigger starts a run with; `payload` carries a webhook body or manual input. */export async function triggerItems(
  workflow: WorkflowView,
  pool: TriggerPool,
  deps: WorkflowRunnerDeps,
  payload: { body?: JsonValue; input?: JsonValue } = {},
): Promise<FlowItem[]> {
  const entry = pool.get(workflow.trigger.pool);
  if (!entry) throw new Error(`Unknown trigger "${workflow.trigger.pool}".`);
  const config = (workflow.trigger.config ?? {}) as Record<string, JsonValue>;
  const empty = contextFor({ json: {} }, 0, [], {
    $vars: workflow.vars ?? {},
    $workflow: { name: workflow.name, title: workflow.title, agent: workflow.agent },
    $today: todayIn(deps.timezone),
    $execution: { id: randomUUID(), mode: entry.kind },
  });
  // What the caller hands over (a webhook body, the manual run dialog) always wins.
  if (payload.body !== undefined) return normalizeItems(payload.body);
  if (payload.input !== undefined) return normalizeItems(payload.input);
  switch (entry.kind) {
    case 'manual':
      return normalizeItems((config.input as JsonValue) ?? entry.sample ?? {});
    case 'schedule':
      return [{ json: { timestamp: new Date().toISOString(), workflow: `${workflow.agent}/${workflow.name}` } }];
    case 'webhook':
    case 'chat':
    case 'telegram':
    case 'tool':
      // Real messages (or an agent's call) arrive as payloads; a manual run uses the sample.
      return normalizeItems(entry.sample ?? {});
    case 'mail': {
      const source = asText(config.source) === 'microsoft' ? 'microsoft' : 'google';
      const query = asText(resolveValue(config.query ?? '', empty));
      const items = await deps.mail.list(source, query, 5);
      return items.map((mail) => ({
        json: { Id: mail.id, From: mail.from, To: mail.to, Date: mail.date ?? '', Subject: mail.subject, Content: mail.content },
      }));
    }
    case 'poll': {
      const resolved = resolveValue(config, empty) as { url?: JsonValue; method?: JsonValue; headers?: JsonValue };
      const url = asText(resolved.url);
      if (!url) throw new Error('poll trigger: no URL');
      await guardUrl(url, config.allowLocal === true, deps);
      const headers: Record<string, string> = {};
      if (resolved.headers && typeof resolved.headers === 'object' && !Array.isArray(resolved.headers)) {
        for (const [key, value] of Object.entries(resolved.headers)) headers[key] = asText(value);
      }
      const response = await (deps.fetchFn ?? fetch)(url, {
        method: asText(resolved.method || 'GET').toUpperCase(),
        headers,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`poll ${url}: HTTP ${response.status} ${text.slice(0, 200)}`);
      try {
        return normalizeItems(JSON.parse(text));
      } catch {
        return [{ json: { text } }];
      }
    }
  }
}

/**
 * Runs a single node with sample items (the editor's "test node" button). The draft
 * workflow may be unsaved: only its agent and title are used for context.
 */
export async function runWorkflowNode(
  workflow: WorkflowView,
  node: WorkflowNode,
  input: FlowItem[],
  deps: WorkflowRunnerDeps,
  signal?: AbortSignal,
): Promise<WorkflowNodeTestResult> {
  const context: NodeContext = {
    workflow,
    deps,
    signal,
    thread: `workflow-test:${workflow.agent}/${workflow.name || 'draft'}:${randomUUID().slice(0, 8)}`,
    execution: { id: randomUUID(), mode: 'test' },
    outputs: {},
    trigger: { json: input[0]?.json ?? {}, items: input.map((item) => item.json) },
    incoming: {},
    vars: workflow.vars ?? {},
    today: todayIn(deps.timezone),
    depth: 0,
  };
  // Testing with no input still gives per-item nodes one empty item to chew on.
  const items = input.length > 0 ? input : [{ json: {} }];
  try {
    const outputs = await executeNode(node, items, context);
    return { ok: true, input: items, outputs };
  } catch (error) {
    return { ok: false, error: (error as Error).message, input: items, outputs: {} };
  }
}
