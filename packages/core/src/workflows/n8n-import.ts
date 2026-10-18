import type { JsonValue, NodeTypeName, Operator, WorkflowNode, WorkflowTriggerRef, WorkflowView } from '@mimi/shared';

/**
 * Turns an n8n workflow export into Mimi workflows: one per trigger, nodes mapped to
 * the closest Mimi node, expressions rewritten, credentials and key-looking values
 * dropped. Anything that cannot be mapped becomes a node that stops the run with an
 * explanation, and the report lists it, so nothing is lost silently.
 */

export interface N8nImportReport {
  /** Name of the n8n workflow(s) read. */
  source: string[];
  workflows: Array<{ name: string; title: string; trigger: string; nodes: number }>;
  warnings: string[];
  /** Nodes that became a stop-with-explanation placeholder. */
  unsupported: Array<{ node: string; type: string; reason: string }>;
  /** Fields whose value looked like a secret and was not imported. */
  redacted: Array<{ node: string; field: string }>;
  /** Chat models the n8n flow used (per node), to pick matching models in Mimi. */
  models: Array<{ node: string; model: string }>;
  /** System prompts of n8n AI agents: worth copying into a Mimi agent. */
  prompts: Array<{ node: string; text: string }>;
}

export interface N8nImportOptions {
  /** The agent the imported workflows belong to (and that AI agent nodes use). */
  agent: string;
  /** Workflow names already taken for this agent. */
  existingNames: string[];
  /** Whether a tool exists in the pool (Gmail, Calendar…). */
  hasTool(name: string): boolean;
}

interface N8nNode {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  parameters?: Record<string, unknown>;
  disabled?: boolean;
  onError?: string;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  notes?: string;
  position?: [number, number];
}

interface N8nConnection {
  node: string;
  type?: string;
  index?: number;
}

interface N8nFlow {
  name?: string;
  nodes?: N8nNode[];
  connections?: Record<string, Record<string, Array<N8nConnection[] | null>>>;
}

/** What one n8n node becomes. */
interface Converted {
  type: NodeTypeName;
  config: Record<string, JsonValue>;
  /** n8n output index → Mimi output key. */
  output(index: number): string;
  /** Set for AI nodes whose text output n8n calls `output`. */
  agentLike?: boolean;
}

const LC = '@n8n/n8n-nodes-langchain.';
const BASE = 'n8n-nodes-base.';
const shortType = (type: string) => (type.startsWith(BASE) ? type.slice(BASE.length) : type.startsWith(LC) ? `lc.${type.slice(LC.length)}` : type);

const TRIGGERS = new Set([
  'manualTrigger',
  'scheduleTrigger',
  'cron',
  'interval',
  'webhook',
  'gmailTrigger',
  'microsoftOutlookTrigger',
  'telegramTrigger',
  'lc.chatTrigger',
  'lc.manualChatTrigger',
  'executeWorkflowTrigger',
  'errorTrigger',
  'formTrigger',
  'rssFeedReadTrigger',
]);

/** LangChain nodes that only plug into an AI node (model, memory, tool, parser…). */
const SUB_NODE = /^lc\.(lm|memory|tool|embeddings|outputParser|document|textSplitter|retriever|reranker|mcpClientTool)/;

const SECRET_KEY = /(api[-_ ]?key|apikey|token|secret|password|passwd|authorization|bearer|private[-_ ]?key|client[-_ ]?secret)/i;
const SECRET_VALUE =
  /\b(sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{20,}|\d{8,10}:[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/-]{20,})/;
export const REDACTED = '<<ใส่ค่าเอง: ค่าลับไม่ถูกนำเข้า>>';

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string => (value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

/** Drops values that look like keys, tokens or passwords; expressions stay. */
function redact(value: unknown, node: string, path: string, report: N8nImportReport): unknown {
  if (typeof value === 'string') {
    const literal = !value.startsWith('=');
    const keyLooksSecret = SECRET_KEY.test(path) && literal && value.trim().length >= 8;
    if (keyLooksSecret || SECRET_VALUE.test(value)) {
      report.redacted.push({ node, field: path });
      return REDACTED;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry, index) => redact(entry, node, `${path}[${index}]`, report));
  if (isRecord(value)) {
    // Name/value pairs (headers, query): judge the value by the pair's name.
    const pairName = typeof value.name === 'string' ? value.name : '';
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = key === 'value' && pairName ? `${path}.${pairName}` : path ? `${path}.${key}` : key;
      out[key] = redact(child, node, childPath, report);
    }
    return out;
  }
  return value;
}

/** Rewrites an n8n expression for Mimi; plain strings pass unchanged. */
export function convertExpression(value: string, warn?: (message: string) => void): string {
  if (!value.startsWith('=')) return value;
  let text = value.slice(1);
  text = text.replace(
    /\$\(\s*(['"])(.+?)\1\s*\)(\.item|\.first\(\)|\.last\(\)|\.all\(\)|\.params|\.isExecuted)?/g,
    (_match, _quote: string, name: string, suffix: string | undefined) => {
      const ref = `$node[${JSON.stringify(name)}]`;
      if (suffix === '.last()') return `({ json: ${ref}.items.at(-1) })`;
      if (suffix === '.all()') return `${ref}.items.map((json) => ({ json }))`;
      if (suffix === '.params' || suffix === '.isExecuted') {
        warn?.(`expression uses $('${name}')${suffix}, which Mimi does not have`);
        return '{}';
      }
      return ref;
    },
  );
  text = text
    .replace(/\$items\(\s*(['"])(.+?)\1\s*\)/g, (_match, _quote: string, name: string) => `$node[${JSON.stringify(name)}].items.map((json) => ({ json }))`)
    .replace(/\$input\.item\.json/g, '$json')
    .replace(/\$input\.first\(\)\.json/g, '$items[0]')
    .replace(/\$input\.last\(\)\.json/g, '$items.at(-1)')
    .replace(/\$input\.all\(\)/g, '$items.map((json) => ({ json }))')
    .replace(/\$json\.chatInput/g, '$json.text')
    .replace(/\$json\[(['"])chatInput\1\]/g, '$json.text');
  if (/\.(toFormat|plus|minus|toISO|setZone|startOf|endOf|diff)\(|DateTime\./.test(text)) {
    warn?.('expression uses Luxon date methods ($now.toFormat…); rebuild it with the "วันที่ / เวลา" node');
  }
  if (/\$fromAI\(/.test(text)) warn?.('expression uses $fromAI(), which only exists inside n8n AI tools');
  return text;
}

function convertDeep(value: unknown, warn: (message: string) => void): JsonValue {
  if (typeof value === 'string') return convertExpression(value, warn);
  if (Array.isArray(value)) return value.map((entry) => convertDeep(entry, warn));
  if (isRecord(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) out[key] = convertDeep(child, warn);
    return out;
  }
  return (value ?? null) as JsonValue;
}

const OPERATOR_MAP: Record<string, Operator> = {
  equal: 'equals',
  equals: 'equals',
  notEqual: 'not_equals',
  notEquals: 'not_equals',
  contains: 'contains',
  notContains: 'not_contains',
  startsWith: 'starts_with',
  endsWith: 'ends_with',
  regex: 'regex',
  larger: 'gt',
  gt: 'gt',
  after: 'gt',
  largerEqual: 'gte',
  gte: 'gte',
  smaller: 'lt',
  lt: 'lt',
  before: 'lt',
  smallerEqual: 'lte',
  lte: 'lte',
  isEmpty: 'is_empty',
  empty: 'is_empty',
  notExists: 'is_empty',
  isNotEmpty: 'is_not_empty',
  notEmpty: 'is_not_empty',
  exists: 'is_not_empty',
  true: 'is_true',
  false: 'is_false',
};

function mapOperator(operation: unknown, warn: (message: string) => void): Operator {
  const key = str(operation);
  const mapped = OPERATOR_MAP[key];
  if (!mapped) warn(`condition operator "${key}" has no match; using "equals"`);
  return mapped ?? 'equals';
}

/** n8n IF/Filter/Switch conditions (v1 typed lists or v2 condition objects) as Mimi rules. */
function conditionsOf(raw: unknown, combineAny: boolean, warn: (message: string) => void): { combinator: string; conditions: JsonValue[] } {
  const conv = (value: unknown) => convertDeep(value, warn);
  if (isRecord(raw) && Array.isArray(raw.conditions)) {
    const conditions = raw.conditions.filter(isRecord).map((entry) => {
      const operator = isRecord(entry.operator) ? entry.operator : {};
      return { left: conv(entry.leftValue ?? ''), operator: mapOperator(operator.operation, warn), right: conv(entry.rightValue ?? '') };
    });
    return { combinator: str(raw.combinator) === 'or' ? 'or' : 'and', conditions };
  }
  const conditions: JsonValue[] = [];
  if (isRecord(raw)) {
    for (const group of ['string', 'number', 'boolean', 'dateTime']) {
      const list = raw[group];
      if (!Array.isArray(list)) continue;
      for (const entry of list.filter(isRecord)) {
        conditions.push({ left: conv(entry.value1 ?? ''), operator: mapOperator(entry.operation ?? (group === 'boolean' ? 'equal' : 'equal'), warn), right: conv(entry.value2 ?? '') });
      }
    }
  }
  return { combinator: combineAny ? 'or' : 'and', conditions };
}

const main = () => 'main';

/** A node that stops the run and says what to rebuild. */
function placeholder(name: string, type: string, reason: string, report: N8nImportReport): Converted {
  report.unsupported.push({ node: name, type, reason });
  const message = `n8n node "${name}" (${type}) was not converted: ${reason}`;
  return { type: 'code', config: { code: `throw new Error(${JSON.stringify(message)});` }, output: main };
}

const passthrough = (): Converted => ({ type: 'set', config: { fields: {} }, output: main });

function pairs(list: unknown, warn: (message: string) => void): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const entry of Array.isArray(list) ? list.filter(isRecord) : []) {
    const name = str(entry.name);
    if (name) out[name] = convertDeep(entry.value ?? '', warn);
  }
  return out;
}

function parseJsonParam(value: unknown, warn: (message: string) => void): JsonValue {
  const text = str(value);
  const body = text.startsWith('=') ? text.slice(1) : text;
  try {
    return convertDeep(JSON.parse(body), warn);
  } catch {
    // A JSON template with {{ }} inside: keep it as one expression string.
    return convertExpression(text.startsWith('=') ? text : `=${text}`, warn);
  }
}

function modelName(node: N8nNode): string {
  const model = node.parameters?.model ?? node.parameters?.modelName;
  if (isRecord(model)) return str(model.value ?? model.cachedResultName);
  return str(model) || shortType(node.type);
}

/** The cron of an n8n Schedule / Cron / Interval trigger. */
function cronOf(node: N8nNode, warn: (message: string) => void): string {
  const p = node.parameters ?? {};
  const type = shortType(node.type);
  if (type === 'interval') {
    const value = Number(p.interval ?? 1) || 1;
    const unit = str(p.unit || 'seconds');
    if (unit === 'hours') return `0 */${value} * * *`;
    if (unit === 'minutes') return `*/${Math.max(1, value)} * * * *`;
    warn('interval in seconds runs every minute in Mimi');
    return '* * * * *';
  }
  if (type === 'cron') {
    const item = isRecord(p.triggerTimes) && Array.isArray(p.triggerTimes.item) ? (p.triggerTimes.item[0] as Record<string, unknown> | undefined) : undefined;
    if (!item) return '0 8 * * *';
    if (item.mode === 'custom') return str(item.cronExpression).split(/\s+/).slice(-5).join(' ');
    const hour = Number(item.hour ?? 0);
    const minute = Number(item.minute ?? 0);
    if (item.mode === 'everyHour') return `${minute} * * * *`;
    if (item.mode === 'everyWeek') return `${minute} ${hour} * * ${Number(item.weekday ?? 1)}`;
    if (item.mode === 'everyMonth') return `${minute} ${hour} ${Number(item.dayOfMonth ?? 1)} * *`;
    if (item.mode === 'everyX') return str(item.unit) === 'hours' ? `0 */${Number(item.value ?? 1)} * * *` : `*/${Number(item.value ?? 5)} * * * *`;
    return `${minute} ${hour} * * *`;
  }
  const rule = isRecord(p.rule) && Array.isArray(p.rule.interval) ? (p.rule.interval[0] as Record<string, unknown> | undefined) : undefined;
  if (!rule) return '0 8 * * *';
  const hour = Number(rule.triggerAtHour ?? 0);
  const minute = Number(rule.triggerAtMinute ?? 0);
  switch (str(rule.field || 'days')) {
    case 'cronExpression':
      return str(rule.expression).split(/\s+/).slice(-5).join(' ');
    case 'seconds':
      warn('a schedule in seconds runs every minute in Mimi');
      return '* * * * *';
    case 'minutes':
      return `*/${Math.max(1, Number(rule.minutesInterval ?? 5))} * * * *`;
    case 'hours':
      return `${minute} */${Math.max(1, Number(rule.hoursInterval ?? 1))} * * *`;
    case 'weeks': {
      const days = Array.isArray(rule.triggerAtDay) && rule.triggerAtDay.length > 0 ? rule.triggerAtDay.map(Number).join(',') : '1';
      return `${minute} ${hour} * * ${days}`;
    }
    case 'months':
      return `${minute} ${hour} ${Number(rule.triggerAtDayOfMonth ?? 1)} * *`;
    default: {
      const every = Math.max(1, Number(rule.daysInterval ?? 1));
      return `${minute} ${hour} ${every > 1 ? `*/${every}` : '*'} * *`;
    }
  }
}

function minutesOfPoll(node: N8nNode): number {
  const poll = node.parameters?.pollTimes;
  const item = isRecord(poll) && Array.isArray(poll.item) ? (poll.item[0] as Record<string, unknown> | undefined) : undefined;
  if (!item) return 15;
  if (item.mode === 'everyX') return Math.max(5, Number(item.value ?? 15) * (str(item.unit) === 'hours' ? 60 : 1));
  if (item.mode === 'everyHour') return 60;
  return 5;
}

/** The Mimi trigger for an n8n trigger node. */
function triggerOf(node: N8nNode, report: N8nImportReport, warn: (message: string) => void): WorkflowTriggerRef {
  const type = shortType(node.type);
  const p = node.parameters ?? {};
  switch (type) {
    case 'scheduleTrigger':
    case 'cron':
    case 'interval':
      return { pool: 'schedule', config: { cron: cronOf(node, warn) } };
    case 'webhook':
      return { pool: 'webhook', config: {} };
    case 'gmailTrigger': {
      const filters = isRecord(p.filters) ? p.filters : {};
      const query = [str(filters.q), str(filters.readStatus) === 'unread' ? 'is:unread' : ''].filter(Boolean).join(' ');
      return { pool: 'mail', config: { source: 'google', query, everyMinutes: minutesOfPoll(node), markRead: false } };
    }
    case 'microsoftOutlookTrigger':
      return { pool: 'mail', config: { source: 'microsoft', query: '', everyMinutes: minutesOfPoll(node), markRead: false } };
    case 'telegramTrigger':
      report.warnings.push('Telegram: ใส่ bot token ใน secret "TELEGRAM_BOT_TOKEN" และกรอก chat id ที่อนุญาต · ปิด webhook ของ n8n ก่อน (บอทหนึ่งตัวรับได้ทางเดียว)');
      return { pool: 'telegram', config: { tokenSecret: 'TELEGRAM_BOT_TOKEN', chatIds: '', match: 'any', pattern: '' } };
    case 'lc.chatTrigger':
    case 'lc.manualChatTrigger':
      return { pool: 'chat', config: { match: 'any', pattern: '', reply: 'workflow_only' } };
    case 'errorTrigger':
      warn('an n8n Error Trigger becomes a manual workflow; pick it as another workflow\'s "error workflow"');
      return { pool: 'manual', config: {} };
    case 'formTrigger':
    case 'rssFeedReadTrigger':
      warn(`trigger "${node.name}" (${type}) has no Mimi match; it is imported as a manual run`);
      return { pool: 'manual', config: {} };
    default:
      return { pool: 'manual', config: {} };
  }
}

/** Maps one n8n flow node. `attached` holds the AI sub-nodes plugged into it. */
function convertNode(node: N8nNode, attached: N8nNode[], options: N8nImportOptions, report: N8nImportReport, warn: (message: string) => void): Converted {
  const type = shortType(node.type);
  const p = (node.parameters ?? {}) as Record<string, unknown>;
  const conv = (value: unknown) => convertDeep(value, warn);
  const options_ = isRecord(p.options) ? p.options : {};

  switch (type) {
    case 'if': {
      const { combinator, conditions } = conditionsOf(p.conditions, str(p.combineOperation) === 'any', warn);
      return { type: 'if', config: { combinator, conditions }, output: (index) => (index === 0 ? 'true' : 'false') };
    }
    case 'filter': {
      const { combinator, conditions } = conditionsOf(p.conditions, str(p.combineOperation) === 'any', warn);
      return { type: 'filter', config: { combinator, conditions }, output: main };
    }
    case 'switch': {
      if (str(p.mode) === 'expression') return placeholder(node.name, type, 'switch in "expression" mode (output chosen by a number)', report);
      const rules = isRecord(p.rules) ? p.rules : {};
      if (Array.isArray(rules.values)) {
        const cases = rules.values.filter(isRecord).map((rule) => {
          const { conditions } = conditionsOf(rule.conditions, false, warn);
          if (conditions.length > 1) warn(`switch "${node.name}": a rule with several conditions keeps only the first`);
          return conditions[0] ?? { left: '', operator: 'is_true', right: '' };
        });
        const fallbackExtra = str(options_.fallbackOutput) === 'extra';
        return { type: 'switch', config: { mode: 'rules', cases }, output: (index) => (index < cases.length ? `case${index}` : fallbackExtra ? 'fallback' : `case${index}`) };
      }
      // v1/v2: one value compared against rules that each name an output.
      const list = Array.isArray(rules.rules) ? rules.rules.filter(isRecord) : [];
      const cases = list.map((rule) => ({ left: conv(p.value1 ?? ''), operator: mapOperator(rule.operation ?? 'equal', warn), right: conv(rule.value ?? '') }));
      const outputs = list.map((rule) => Number(rule.output ?? 0));
      const fallback = Number(p.fallbackOutput ?? -1);
      return {
        type: 'switch',
        config: { mode: 'rules', cases },
        output: (index) => {
          const at = outputs.indexOf(index);
          return at >= 0 ? `case${at}` : index === fallback ? 'fallback' : `case${index}`;
        },
      };
    }
    case 'set': {
      const fields: Record<string, JsonValue> = {};
      if (isRecord(p.assignments) && Array.isArray(p.assignments.assignments)) {
        for (const entry of p.assignments.assignments.filter(isRecord)) {
          const name = str(entry.name);
          if (!name) continue;
          const value = conv(entry.value ?? '');
          fields[name] = str(entry.type) === 'number' && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value)) ? Number(value) : value;
        }
      } else if (str(p.mode) === 'raw') {
        const parsed = parseJsonParam(p.jsonOutput ?? '{}', warn);
        if (isRecord(parsed)) Object.assign(fields, parsed);
        else return { type: 'code', config: { code: `return items.map((item) => ({ ...item, ...(${JSON.stringify(parsed)}) }));` }, output: main };
      } else if (isRecord(p.values)) {
        for (const group of ['string', 'number', 'boolean']) {
          for (const entry of Array.isArray(p.values[group]) ? (p.values[group] as unknown[]).filter(isRecord) : []) {
            if (str(entry.name)) fields[str(entry.name)] = conv(entry.value ?? '');
          }
        }
      }
      if (p.includeOtherFields === false || p.keepOnlySet === true) warn(`set "${node.name}": n8n kept only the set fields; Mimi keeps the others too`);
      return { type: 'set', config: { fields }, output: main };
    }
    case 'code':
    case 'function':
    case 'functionItem': {
      if (str(p.language) === 'python' || str(p.language) === 'pythonNative') return placeholder(node.name, type, 'Python code (Mimi runs JavaScript)', report);
      const code = str(p.jsCode ?? p.functionCode ?? '');
      const perItem = str(p.mode) === 'runOnceForEachItem' || type === 'functionItem';
      if (/\$\(|\$node\[|\$env|require\(|this\.helpers|\$getWorkflowStaticData/.test(code)) {
        warn(`code "${node.name}" uses n8n-only helpers ($(), $env, this.helpers…); check it`);
      }
      const body = perItem
        ? `const __out = [];\nfor (const [$itemIndex, $json] of items.entries()) {\n  const item = { json: $json };\n  const __result = await (async () => {\n${code}\n  })();\n  __out.push(__result ?? item);\n}\nreturn __out;`
        : code;
      return { type: 'code', config: { code: body }, output: main };
    }
    case 'httpRequest': {
      const method = str(p.method ?? p.requestMethod ?? 'GET').toUpperCase();
      const config: Record<string, JsonValue> = { method, url: conv(p.url ?? '') };
      const query = isRecord(p.queryParameters) ? pairs(p.queryParameters.parameters, warn) : isRecord(p.queryParametersUi) ? pairs(p.queryParametersUi.parameter, warn) : {};
      const headers = isRecord(p.headerParameters) ? pairs(p.headerParameters.parameters, warn) : isRecord(p.headerParametersUi) ? pairs(p.headerParametersUi.parameter, warn) : {};
      if (Object.keys(query).length > 0) config.query = query;
      if (Object.keys(headers).length > 0) config.headers = headers;
      if (p.sendBody === true || p.bodyParametersUi || p.bodyParameters) {
        if (str(p.specifyBody) === 'json' && p.jsonBody !== undefined) config.body = parseJsonParam(p.jsonBody, warn);
        else if (isRecord(p.bodyParameters)) config.body = pairs(p.bodyParameters.parameters, warn);
        else if (isRecord(p.bodyParametersUi)) config.body = pairs(p.bodyParametersUi.parameter, warn);
      }
      if (str(p.authentication) && str(p.authentication) !== 'none') {
        warn(`HTTP "${node.name}" used n8n credentials (${str(p.nodeCredentialType || p.authentication)}); add the auth header yourself`);
      }
      return { type: 'http', config, output: main };
    }
    case 'merge': {
      const mode = str(p.mode || 'append');
      if (mode === 'combine' || mode === 'mergeByKey' || mode === 'mergeByIndex') {
        const by = str(p.combineBy || p.combinationMode);
        if (mode === 'mergeByKey' || by === 'combineByFields' || by === 'mergeByFields') {
          const fieldsToMatch = isRecord(p.mergeByFields) && Array.isArray(p.mergeByFields.values) ? (p.mergeByFields.values[0] as Record<string, unknown> | undefined)?.field1 : undefined;
          const key = str(p.fieldsToMatchString ?? fieldsToMatch ?? p.propertyName1).split(',')[0]!.trim();
          return { type: 'merge', config: { mode: 'by_key', key }, output: main };
        }
        return { type: 'merge', config: { mode: 'combine' }, output: main };
      }
      if (mode !== 'append') warn(`merge "${node.name}" (${mode}) imported as append`);
      return { type: 'merge', config: { mode: 'append' }, output: main };
    }
    case 'wait': {
      const resume = str(p.resume || 'timeInterval');
      if (resume !== 'timeInterval') {
        warn(`wait "${node.name}" waited for "${resume}"; Mimi waits by time only (an approval node can wait for you)`);
        return passthrough();
      }
      const unit = str(p.unit || 'seconds');
      const amount = Number(p.amount ?? 1);
      if (unit === 'days') warn(`wait "${node.name}" of ${amount} day(s) is capped at 1 hour in Mimi`);
      return { type: 'wait', config: { amount: unit === 'days' ? 1 : amount, unit: unit === 'days' ? 'hours' : unit }, output: main };
    }
    case 'noOp':
      return passthrough();
    case 'stopAndError':
      return { type: 'code', config: { code: `throw new Error(${JSON.stringify(str(p.errorMessage) || 'stopped')});` }, output: main };
    case 'sort': {
      const first = isRecord(p.sortFieldsUi) && Array.isArray(p.sortFieldsUi.sortField) ? (p.sortFieldsUi.sortField[0] as Record<string, unknown> | undefined) : undefined;
      return { type: 'sort', config: { field: str(first?.fieldName), direction: str(first?.order) === 'descending' ? 'desc' : 'asc', type: 'auto' }, output: main };
    }
    case 'limit':
      return { type: 'limit', config: { max: Number(p.maxItems ?? 1), keep: str(p.keep) === 'lastItems' ? 'last' : 'first' }, output: main };
    case 'removeDuplicates':
      return {
        type: 'remove_duplicates',
        config: { fields: str(p.compare) === 'selectedFields' ? str(p.fieldsToCompare).split(',').map((name) => name.trim()).filter(Boolean) : [], keep: 'first' },
        output: main,
      };
    case 'aggregate': {
      if (str(p.aggregate) === 'aggregateAllItemData') {
        warn(`aggregate "${node.name}": n8n put all items under one field; Mimi collects each field into a list`);
        return { type: 'aggregate', config: { mode: 'collect' }, output: main };
      }
      const list = isRecord(p.fieldsToAggregate) && Array.isArray(p.fieldsToAggregate.fieldToAggregate) ? p.fieldsToAggregate.fieldToAggregate.filter(isRecord) : [];
      return { type: 'aggregate', config: { mode: 'collect', fields: list.map((entry) => str(entry.fieldToAggregate)).filter(Boolean) }, output: main };
    }
    case 'splitOut':
      return { type: 'split_out', config: { field: str(p.fieldToSplitOut).split(',')[0]!.trim(), include: str(p.include) === 'noOtherFields' ? 'none' : 'all' }, output: main };
    case 'itemLists': {
      const operation = str(p.operation);
      if (operation === 'splitOutItems') return { type: 'split_out', config: { field: str(p.fieldToSplitOut), include: str(p.include) === 'noOtherFields' ? 'none' : 'all' }, output: main };
      if (operation === 'removeDuplicates') return { type: 'remove_duplicates', config: { fields: [], keep: 'first' }, output: main };
      if (operation === 'limit') return { type: 'limit', config: { max: Number(p.maxItems ?? 1), keep: 'first' }, output: main };
      if (operation === 'aggregateItems') return { type: 'aggregate', config: { mode: 'collect' }, output: main };
      return placeholder(node.name, type, `item lists "${operation}"`, report);
    }
    case 'summarize': {
      const list = isRecord(p.fieldsToSummarize) && Array.isArray(p.fieldsToSummarize.values) ? p.fieldsToSummarize.values.filter(isRecord) : [];
      const first = list[0];
      if (list.length > 1 || p.fieldsToSplitBy) warn(`summarize "${node.name}": only the first summary is kept (no split-by)`);
      const aggregation = str(first?.aggregation || 'count');
      const mode = aggregation === 'concatenate' ? 'join' : ['sum', 'average', 'min', 'max', 'count'].includes(aggregation) ? aggregation : 'count';
      return { type: 'aggregate', config: { mode, field: first?.field ? `{{ $json[${JSON.stringify(str(first.field))}] }}` : '', name: `${aggregation}_${str(first?.field) || 'items'}` }, output: main };
    }
    case 'dateTime': {
      warn(`date & time "${node.name}" converted roughly; check its format`);
      const operation = str(p.operation || 'formatDate');
      const name = str(p.outputFieldName || p.dataPropertyName) || 'date';
      const format = str(p.format === 'custom' ? p.customFormat : p.format).replace(/yyyy/g, 'YYYY').replace(/yy/g, 'YY').replace(/dd/g, 'DD').replace(/\bd\b/g, 'D');
      if (operation === 'getCurrentDate') return { type: 'datetime', config: { operation: 'format', format: format || 'iso', name }, output: main };
      if (operation === 'addToDate' || operation === 'subtractFromDate') {
        return {
          type: 'datetime',
          config: { operation: operation === 'addToDate' ? 'add' : 'subtract', value: conv(p.magnitude ?? ''), amount: Number(p.duration ?? 1), unit: str(p.timeUnit || 'days'), name },
          output: main,
        };
      }
      if (operation === 'getTimeBetweenDates') return { type: 'datetime', config: { operation: 'diff', value: conv(p.startDate ?? ''), other: conv(p.endDate ?? ''), unit: 'days', name }, output: main };
      return { type: 'datetime', config: { operation: 'format', value: conv(p.date ?? p.value ?? ''), format: format || 'datetime', name }, output: main };
    }
    case 'splitInBatches':
      warn(`"${node.name}" (Loop Over Items): its loop-back link was removed and all items go through at once; for real batches use a Loop node with a sub-workflow`);
      return passthrough();
    case 'executeWorkflow':
      return placeholder(node.name, type, 'calls another n8n workflow; import that one too, then use a "เรียก workflow" node', report);
    case 'respondToWebhook': {
      const respondWith = str(p.respondWith || 'firstIncomingItem');
      const config: Record<string, JsonValue> = {};
      const code = Number(options_.responseCode);
      if (Number.isFinite(code) && code > 0) config.status = code;
      const headerList = isRecord(options_.responseHeaders) ? pairs(options_.responseHeaders.entries, warn) : {};
      if (Object.keys(headerList).length > 0) config.headers = headerList;
      if (respondWith === 'json') config.body = parseJsonParam(p.responseBody ?? '{}', warn);
      else if (respondWith === 'text') config.body = conv(p.responseBody ?? '');
      return { type: 'respond', config, output: main };
    }
    case 'telegram': {
      const operation = str(p.operation || 'sendMessage');
      if (operation === 'sendChatAction') return passthrough();
      if (operation !== 'sendMessage') return placeholder(node.name, type, `Telegram "${operation}" (Mimi sends text messages only)`, report);
      const extra = isRecord(p.additionalFields) ? p.additionalFields : {};
      const parse = str(extra.parse_mode);
      return {
        type: 'telegram',
        config: { tokenSecret: 'TELEGRAM_BOT_TOKEN', chatId: conv(p.chatId ?? '{{ $json.chatId }}'), text: conv(p.text ?? ''), parseMode: parse === 'HTML' || parse === 'Markdown' ? parse : 'plain' },
        output: main,
      };
    }
    case 'gmail':
    case 'microsoftOutlook': {
      const google = type === 'gmail';
      const operation = str(p.operation || 'send');
      const tool = (name: string, input: Record<string, JsonValue>): Converted =>
        options.hasTool(name) ? { type: 'tool', config: { tool: name, input }, output: main } : placeholder(node.name, type, `tool "${name}" is not in the tool pool`, report);
      if (operation === 'send') {
        return tool(google ? 'gmail_send' : 'outlook_send', { to: conv(p.sendTo ?? p.toRecipients ?? ''), subject: conv(p.subject ?? ''), body: conv(p.message ?? p.bodyContent ?? '') });
      }
      if (google && operation === 'getAll') {
        const filters = isRecord(p.filters) ? p.filters : {};
        return tool('gmail_search', { query: conv(filters.q ?? 'in:inbox'), max_results: Math.min(20, Number(p.limit ?? 10)) });
      }
      if (google && operation === 'get') return tool('gmail_read', { id: conv(p.messageId ?? '{{ $json.id }}') });
      return placeholder(node.name, type, `${google ? 'Gmail' : 'Outlook'} "${operation}"`, report);
    }
    case 'googleCalendar': {
      const operation = str(p.operation || 'create');
      if (operation === 'create' && options.hasTool('calendar_create')) {
        const extra = isRecord(p.additionalFields) ? p.additionalFields : {};
        return { type: 'tool', config: { tool: 'calendar_create', input: { summary: conv(extra.summary ?? p.summary ?? ''), start: conv(p.start ?? ''), end: conv(p.end ?? '') } }, output: main };
      }
      if (operation === 'getAll' && options.hasTool('calendar_list')) {
        return { type: 'tool', config: { tool: 'calendar_list', input: { from: conv(p.timeMin ?? '{{ $now }}'), to: conv(p.timeMax ?? '{{ $now }}') } }, output: main };
      }
      return placeholder(node.name, type, `Google Calendar "${operation}"`, report);
    }
    case 'googleSheets': {
      const operation = str(p.operation || 'append');
      const document = isRecord(p.documentId) ? str(p.documentId.value || p.documentId.cachedResultName) : str(p.documentId);
      const sheet = isRecord(p.sheetName) ? str(p.sheetName.cachedResultName || p.sheetName.value) : str(p.sheetName);
      warn(`Google Sheets "${node.name}": make a preset of the sheets tool for spreadsheet ${document || '(unknown)'} and pick it in this node`);
      if (operation === 'append' || operation === 'appendOrUpdate') {
        return { type: 'tool', config: { tool: 'sheets_append', input: { range: sheet || 'Sheet1', values: [['{{ $json.text }}']] } }, output: main };
      }
      if (operation === 'read' || operation === 'lookup') return { type: 'tool', config: { tool: 'sheets_read', input: { range: sheet || 'Sheet1' } }, output: main };
      return placeholder(node.name, type, `Google Sheets "${operation}"`, report);
    }
    case 'lc.agent':
    case 'lc.chainLlm': {
      const prompt = str(p.promptType) === 'define' || p.text ? conv(p.text ?? '') : '{{ $json.text }}';
      const systemMessage = str(options_.systemMessage ?? (isRecord(p.messages) && Array.isArray(p.messages.messageValues) ? (p.messages.messageValues.filter(isRecord).find((entry) => str(entry.type).includes('System'))?.message ?? '') : ''));
      for (const sub of attached) {
        const subType = shortType(sub.type);
        if (subType.startsWith('lc.lm')) report.models.push({ node: node.name, model: modelName(sub) });
      }
      const tools = attached.filter((sub) => shortType(sub.type).startsWith('lc.tool') || shortType(sub.type).endsWith('Tool')).map((sub) => sub.name);
      if (tools.length > 0) warn(`AI agent "${node.name}" used n8n tools: ${tools.join(', ')} — give the Mimi agent matching tools on the Agent page`);
      if (attached.some((sub) => shortType(sub.type).startsWith('lc.memory'))) warn(`AI agent "${node.name}" had n8n chat memory; Mimi agents keep their own memory`);
      if (type === 'lc.chainLlm' && tools.length === 0) {
        return { type: 'llm', config: { model: '', system: systemMessage, prompt: typeof prompt === 'string' ? prompt : str(prompt), format: 'text', name: 'text' }, output: main };
      }
      if (systemMessage.trim()) report.prompts.push({ node: node.name, text: systemMessage });
      return { type: 'agent', config: { agent: options.agent, instruction: prompt }, output: main, agentLike: true };
    }
    case 'lc.textClassifier': {
      const list = isRecord(p.categories) && Array.isArray(p.categories.categories) ? p.categories.categories.filter(isRecord) : [];
      const categories = list.map((entry) => ({ name: str(entry.category), description: str(entry.description) }));
      return { type: 'classify', config: { model: '', input: conv(p.inputText ?? '{{ $json.text }}'), categories, instruction: str(options_.systemPromptTemplate) }, output: (index) => (index < categories.length ? `cat${index}` : 'fallback') };
    }
    case 'lc.sentimentAnalysis': {
      const names = str(options_.categories || 'Positive, Neutral, Negative').split(',').map((name) => name.trim()).filter(Boolean);
      return { type: 'classify', config: { model: '', input: conv(p.inputText ?? '{{ $json.text }}'), categories: names.map((name) => ({ name })) }, output: (index) => (index < names.length ? `cat${index}` : 'fallback') };
    }
    case 'lc.informationExtractor': {
      let attributes: JsonValue[] = [];
      if (isRecord(p.attributes) && Array.isArray(p.attributes.attributes)) {
        attributes = p.attributes.attributes.filter(isRecord).map((entry) => ({
          name: str(entry.name),
          type: ['number', 'boolean', 'array', 'object'].includes(str(entry.type)) ? str(entry.type) : 'string',
          description: str(entry.description),
          required: entry.required === true,
        }));
      } else if (p.jsonSchemaExample) {
        try {
          const example = JSON.parse(str(p.jsonSchemaExample)) as Record<string, unknown>;
          attributes = Object.entries(example).map(([name, sample]) => ({
            name,
            type: Array.isArray(sample) ? 'array' : sample === null ? 'string' : typeof sample === 'object' ? 'object' : typeof sample === 'number' ? 'number' : typeof sample === 'boolean' ? 'boolean' : 'string',
            description: '',
            required: false,
          }));
        } catch {
          warn(`extractor "${node.name}": its JSON schema could not be read; add the fields by hand`);
        }
      }
      return { type: 'extract', config: { model: '', input: conv(p.text ?? '{{ $json.text }}'), attributes, target: 'output' }, output: main };
    }
    case 'lc.openAi':
    case 'lc.googleGemini':
    case 'lc.anthropic': {
      const operation = str(p.operation || 'message');
      if (str(p.resource || 'text') === 'text' && (operation === 'message' || operation === 'messageModel')) {
        const messages = isRecord(p.messages) && Array.isArray(p.messages.values) ? p.messages.values.filter(isRecord) : [];
        const system = messages.filter((entry) => str(entry.role) === 'system').map((entry) => str(entry.content)).join('\n');
        const user = messages.filter((entry) => str(entry.role) !== 'system').map((entry) => convertExpression(str(entry.content), warn)).join('\n');
        report.models.push({ node: node.name, model: modelName(node) });
        return { type: 'llm', config: { model: '', system, prompt: user || '{{ $json.text }}', format: 'text', name: 'text' }, output: main };
      }
      return placeholder(node.name, type, `${type} "${str(p.resource)}/${operation}" (images/audio): use "ดึงข้อมูลจากไฟล์" to read files with the vision / transcript model`, report);
    }
    default:
      if (type.startsWith('lc.vectorStore')) {
        const mode = str(p.mode || 'retrieve');
        warn(`vector store "${node.name}" maps to the knowledge base "imported" — create it under Hub → คลังความรู้`);
        if (mode === 'insert') return { type: 'knowledge', config: { operation: 'add', collection: 'imported', text: '{{ $json.text }}' }, output: main };
        return { type: 'knowledge', config: { operation: 'search', collection: 'imported', query: '{{ $json.text }}', output: 'context' }, output: main };
      }
      return placeholder(node.name, type, 'no Mimi node does this yet', report);
  }
}

/** A workflow name: lowercase ASCII, unique among `taken`. */
function uniqueName(base: string, taken: Set<string>): string {
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!/^[a-z]/.test(slug)) slug = `n8n-${slug}`.replace(/-+$/, '');
  let name = slug || 'n8n';
  for (let n = 2; taken.has(name); n++) name = `${slug}-${n}`;
  taken.add(name);
  return name;
}

function flowsOf(raw: unknown): N8nFlow[] {
  if (Array.isArray(raw)) return raw.filter(isRecord) as N8nFlow[];
  if (isRecord(raw) && Array.isArray(raw.workflows)) return raw.workflows.filter(isRecord) as N8nFlow[];
  if (isRecord(raw) && Array.isArray(raw.nodes)) return [raw as N8nFlow];
  throw new Error('This is not an n8n workflow export (no "nodes" list).');
}

/** Converts an n8n export. Nothing is saved here; imported workflows start disabled. */
export function importN8n(raw: unknown, options: N8nImportOptions): { workflows: WorkflowView[]; report: N8nImportReport } {
  const report: N8nImportReport = { source: [], workflows: [], warnings: [], unsupported: [], redacted: [], models: [], prompts: [] };
  const taken = new Set(options.existingNames);
  const workflows: WorkflowView[] = [];
  const warned = new Set<string>();
  const warn = (message: string) => {
    if (warned.has(message)) return;
    warned.add(message);
    report.warnings.push(message);
  };

  for (const flow of flowsOf(raw)) {
    const flowName = str(flow.name) || 'n8n workflow';
    report.source.push(flowName);
    const nodes = (flow.nodes ?? []).filter((node) => isRecord(node) && typeof node.name === 'string' && typeof node.type === 'string');
    const byName = new Map(nodes.map((node) => [node.name, { ...node, parameters: redact(node.parameters ?? {}, node.name, '', report) as Record<string, unknown> }]));
    const connections = isRecord(flow.connections) ? flow.connections : {};

    // AI sub-nodes plug into a root through ai_* connections; they are not flow nodes.
    const attached = new Map<string, N8nNode[]>();
    const subNodes = new Set<string>();
    for (const [source, kinds] of Object.entries(connections)) {
      for (const [kind, outputs] of Object.entries(kinds ?? {})) {
        if (kind === 'main') continue;
        subNodes.add(source);
        for (const target of (outputs ?? []).flat().filter(Boolean) as N8nConnection[]) {
          const node = byName.get(source);
          if (node) attached.set(target.node, [...(attached.get(target.node) ?? []), node]);
        }
      }
    }
    for (const node of byName.values()) if (SUB_NODE.test(shortType(node.type))) subNodes.add(node.name);
    const notes = [...byName.values()].filter((node) => shortType(node.type) === 'stickyNote').map((node) => str(node.parameters?.content).trim()).filter(Boolean);
    const isFlowNode = (node: N8nNode) => !subNodes.has(node.name) && shortType(node.type) !== 'stickyNote';

    const mainTargets = (name: string): Array<{ index: number; target: string }> => {
      const outputs = connections[name]?.main ?? [];
      return outputs.flatMap((list, index) => (list ?? []).filter((entry) => entry && byName.has(entry.node)).map((entry) => ({ index, target: entry.node })));
    };

    let triggers = [...byName.values()].filter((node) => isFlowNode(node) && TRIGGERS.has(shortType(node.type)) && !node.disabled);
    if (triggers.length === 0) {
      // No trigger: every node nothing feeds into starts a manual run.
      const fed = new Set([...byName.keys()].flatMap((name) => mainTargets(name).map((link) => link.target)));
      triggers = [];
      const roots = [...byName.values()].filter((node) => isFlowNode(node) && !fed.has(node.name));
      if (roots.length > 0) triggers.push({ name: '__manual__', type: 'manualTrigger', parameters: {} });
      connections.__manual__ = { main: [roots.map((node) => ({ node: node.name }))] };
    }

    for (const trigger of triggers) {
      // The part of the graph this trigger reaches; links back up the path (loops) are dropped.
      const order: string[] = [];
      const dropped: string[] = [];
      const onPath = new Set<string>();
      const seen = new Set<string>();
      const keep = new Map<string, Array<{ index: number; target: string }>>();
      const visit = (name: string) => {
        seen.add(name);
        onPath.add(name);
        const links: Array<{ index: number; target: string }> = [];
        for (const link of mainTargets(name)) {
          const target = byName.get(link.target);
          if (!target || !isFlowNode(target)) continue;
          if (onPath.has(link.target)) {
            dropped.push(`${name} → ${link.target}`);
            continue;
          }
          links.push(link);
          if (!seen.has(link.target)) visit(link.target);
        }
        keep.set(name, links);
        onPath.delete(name);
        if (name !== trigger.name) order.unshift(name);
      };
      visit(trigger.name);
      if (dropped.length > 0) warn(`loop links removed (Mimi runs a flow once, front to back): ${dropped.join(', ')}`);
      if (order.length === 0) {
        warn(`trigger "${trigger.name}" is not connected to anything; skipped`);
        continue;
      }

      const ids = new Map(order.map((name, index) => [name, `n${index + 1}`]));
      const converted = new Map<string, Converted>();
      const mimiNodes: WorkflowNode[] = order.map((name) => {
        const node = byName.get(name)!;
        const result = node.disabled
          ? passthrough()
          : convertNode(node, attached.get(name) ?? [], options, report, (message) => warn(`${name}: ${message}`));
        converted.set(name, result);
        const mimi: WorkflowNode = { id: ids.get(name)!, type: result.type, title: node.disabled ? `${name} (ปิดไว้ใน n8n)` : name, config: result.config, links: {} };
        // n8n's canvas coordinates carry over, so the layout looks familiar.
        if (Array.isArray(node.position) && node.position.length === 2 && node.position.every((value) => Number.isFinite(Number(value)))) {
          mimi.position = [Math.round(Number(node.position[0])), Math.round(Number(node.position[1]))];
        }
        if (node.onError === 'continueRegularOutput') mimi.onError = 'continue';
        if (node.onError === 'continueErrorOutput') mimi.onError = 'branch';
        if (node.retryOnFail) {
          mimi.retries = Math.max(0, Number(node.maxTries ?? 3) - 1);
          mimi.retryWaitMs = Math.max(0, Number(node.waitBetweenTries ?? 1000));
        }
        return mimi;
      });
      // Links: n8n output index → the Mimi output key of that node type.
      for (const mimi of mimiNodes) {
        const name = order[Number(mimi.id.slice(1)) - 1]!;
        const result = converted.get(name)!;
        const outputs = connections[name]?.main ?? [];
        for (const { index, target } of keep.get(name) ?? []) {
          const targetId = ids.get(target);
          if (!targetId) continue;
          const isErrorOutput = mimi.onError === 'branch' && index === outputs.length - 1 && outputs.length > 1;
          const key = isErrorOutput ? 'error' : result.output(index);
          const list = (mimi.links[key] ??= []);
          if (!list.includes(targetId)) list.push(targetId);
        }
        if (Object.keys(mimi.links).length === 0) mimi.links = { main: [] };
      }
      // n8n AI agents answer in `output`; Mimi's agent node answers in `text`.
      const agentTitles = order.filter((name) => converted.get(name)?.agentLike);
      if (agentTitles.length > 0) {
        const fedByAgent = new Set(agentTitles.flatMap((name) => (keep.get(name) ?? []).map((link) => ids.get(link.target))));
        for (const mimi of mimiNodes) {
          let text = JSON.stringify(mimi.config);
          for (const title of agentTitles) text = text.split(JSON.stringify(`$node[${JSON.stringify(title)}].json.output`).slice(1, -1)).join(JSON.stringify(`$node[${JSON.stringify(title)}].json.text`).slice(1, -1));
          if (fedByAgent.has(mimi.id)) text = text.replace(/\$json\.output\b/g, '$json.text');
          mimi.config = JSON.parse(text) as Record<string, JsonValue>;
        }
      }

      // The trigger is not a node in Mimi: references to it read $trigger, with Mimi's field names.
      const triggerType = shortType(trigger.type);
      const fieldMap: Array<[string, string]> =
        triggerType === 'telegramTrigger'
          ? [
              ['json.message.chat.id', 'json.chatId'],
              ['json.message.message_id', 'json.messageId'],
              ['json.message.from.first_name', 'json.from.firstName'],
              ['json.message.from.last_name', 'json.from.lastName'],
              ['json.message.caption', 'json.text'],
              ['json.message.text', 'json.text'],
              ['json.message.from', 'json.from'],
              ['json.message.chat', 'json'],
            ]
          : triggerType === 'gmailTrigger' || triggerType === 'microsoftOutlookTrigger'
            ? [['json.snippet', 'json.Content'], ['json.subject', 'json.Subject'], ['json.from', 'json.From']]
            : triggerType === 'webhook'
              ? [['json.body.', 'json.']]
              : [];
      if (triggerType === 'telegramTrigger' && /message\.(photo|voice|document|audio|video)/.test(JSON.stringify(mimiNodes))) {
        warn(`${trigger.name}: the flow reads Telegram photos / voice / files, which Mimi's Telegram trigger does not download yet`);
      }
      if (triggerType === 'gmailTrigger') warn(`${trigger.name}: mail items have From, To, Date, Subject, Content (body) and Id`);
      for (const mimi of mimiNodes) {
        let text = JSON.stringify(mimi.config);
        const quoted = JSON.stringify(`$node[${JSON.stringify(trigger.name)}]`).slice(1, -1);
        text = text.split(quoted).join('$trigger');
        for (const [from, to] of fieldMap) text = text.split(from).join(to);
        mimi.config = JSON.parse(text) as Record<string, JsonValue>;
      }

      const triggerRef = trigger.name === '__manual__' ? { pool: 'manual', config: {} } : triggerOf(trigger, report, (message) => warn(`${trigger.name}: ${message}`));
      const title = triggers.length > 1 ? `${flowName} · ${trigger.name}` : flowName;
      const name = uniqueName(triggers.length > 1 ? `${flowName}-${trigger.name}` : flowName, taken);
      workflows.push({
        name,
        agent: options.agent,
        title,
        description: [`นำเข้าจาก n8n "${flowName}"`, ...notes].join('\n\n').slice(0, 2000),
        enabled: false,
        trigger: triggerRef,
        webhook: null,
        vars: {},
        nodes: mimiNodes,
      });
      report.workflows.push({ name, title, trigger: triggerRef.pool, nodes: mimiNodes.length });
    }
  }
  if (workflows.length === 0) throw new Error('Nothing to import: the export has no connected nodes.');
  return { workflows, report };
}
