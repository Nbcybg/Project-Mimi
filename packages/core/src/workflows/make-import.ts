import type { ConnectorField, ConnectorSpec, JsonValue, NodeTypeName, Operator, WorkflowNode, WorkflowTriggerRef, WorkflowView } from '@mimi/shared';
import { connectorSpecs } from '../connectors/services/index.ts';
import { REDACTED } from './n8n-import.ts';

/**
 * Turns a Make blueprint into a Mimi workflow. Make modules, router routes, error
 * handlers and expressions are walked recursively; anything that cannot be mapped
 * becomes a stop-with-explanation node and is listed in the report.
 */

export interface MakeImportReport {
  source: string[];
  workflows: Array<{ name: string; title: string; trigger: string; nodes: number }>;
  warnings: string[];
  unsupported: Array<{ module: string; type: string; reason: string }>;
  redacted: Array<{ module: string; field: string }>;
  mapped: Array<{ module: string; connector: string; operation: string; fields: string[]; confidence: 'high' | 'medium' }>;
  connections: Array<{ module: string; connector: string; connectionId?: string }>;
}

export interface MakeImportOptions {
  agent: string;
  existingNames: string[];
  hasTool(name: string): boolean;
}

interface MakeModule {
  id?: string | number;
  module?: string;
  parameters?: Record<string, unknown>;
  mapper?: Record<string, unknown> | null;
  filter?: Record<string, unknown>;
  metadata?: { designer?: { name?: string; x?: number; y?: number } };
  routes?: Array<{ flow?: unknown[]; filter?: Record<string, unknown> }>;
  onerror?: { flow?: unknown[] };
}

interface MakeBlueprint {
  name?: string;
  flow?: unknown[];
}

interface Mapping {
  connector: string;
  operation: string;
}

const MAKE_MAPPINGS: Record<string, Mapping> = {
  'slacksendmessage': { connector: 'slack', operation: 'send_message' },
  'slacklistchannels': { connector: 'slack', operation: 'list_channels' },
  'slackupdatemessage': { connector: 'slack', operation: 'update_message' },
  'slackaddreaction': { connector: 'slack', operation: 'add_reaction' },
  'discordsendmessage': { connector: 'discord', operation: 'send_message' },
  'notioncreatepage': { connector: 'notion', operation: 'create_page' },
  'notiongetpage': { connector: 'notion', operation: 'get_page' },
  'notionquerydatabase': { connector: 'notion', operation: 'query_database' },
  'airtablecreaterecord': { connector: 'airtable', operation: 'create_record' },
  'airtableupdaterecord': { connector: 'airtable', operation: 'update_record' },
  'airtablelistrecords': { connector: 'airtable', operation: 'list_records' },
  'airtablegetrecord': { connector: 'airtable', operation: 'get_record' },
  'airtabledeleterecord': { connector: 'airtable', operation: 'delete_record' },
  'googledocscreatedocument': { connector: 'google_docs', operation: 'create_document' },
  'googledocsgetdocument': { connector: 'google_docs', operation: 'get_document' },
  'googledocsappendtext': { connector: 'google_docs', operation: 'append_text' },
  'googletaskscreatetask': { connector: 'google_tasks', operation: 'create_task' },
  'googletaskslisttasks': { connector: 'google_tasks', operation: 'list_tasks' },
  'googleformslistresponses': { connector: 'google_forms', operation: 'list_responses' },
  'googleformsgetform': { connector: 'google_forms', operation: 'get_form' },
  'hubspotcreatecontact': { connector: 'hubspot', operation: 'create_contact' },
  'hubspotupdatecontact': { connector: 'hubspot', operation: 'update_contact' },
  'hubspotcreatedeal': { connector: 'hubspot', operation: 'create_deal' },
  'hubspotlistdeals': { connector: 'hubspot', operation: 'list_deals' },
  'stripecreatecustomer': { connector: 'stripe', operation: 'create_customer' },
  'stripelistcustomers': { connector: 'stripe', operation: 'list_customers' },
  'stripecreatepaymentlink': { connector: 'stripe', operation: 'create_payment_link' },
  'striperefundpayment': { connector: 'stripe', operation: 'refund_payment' },
  'githubcreateissue': { connector: 'github', operation: 'create_issue' },
  'githublistissues': { connector: 'github', operation: 'list_issues' },
  'githubcreatecomment': { connector: 'github', operation: 'create_comment' },
  'githubgetfile': { connector: 'github', operation: 'get_file' },
  'jiracreateissue': { connector: 'jira', operation: 'create_issue' },
  'jirasearchissues': { connector: 'jira', operation: 'search_issues' },
  'jiraaddcomment': { connector: 'jira', operation: 'add_comment' },
  'trellocreatecard': { connector: 'trello', operation: 'create_card' },
  'trellolistcards': { connector: 'trello', operation: 'list_cards' },
  'asanacreatetask': { connector: 'asana', operation: 'create_task' },
  'asanalisttasks': { connector: 'asana', operation: 'list_tasks' },
  'clickupcreatetask': { connector: 'clickup', operation: 'create_task' },
  'clickuplisttasks': { connector: 'clickup', operation: 'list_tasks' },
  'mondaycreateitem': { connector: 'monday', operation: 'create_item' },
  'mondaylistitems': { connector: 'monday', operation: 'list_items' },
  'linearcreateissue': { connector: 'linear', operation: 'create_issue' },
  'linearlistissues': { connector: 'linear', operation: 'list_issues' },
  'linearaddcomment': { connector: 'linear', operation: 'add_comment' },
  'todoistcreatetask': { connector: 'todoist', operation: 'create_task' },
  'todoistlisttasks': { connector: 'todoist', operation: 'list_tasks' },
  'todoistcompletetask': { connector: 'todoist', operation: 'complete_task' },
  'dropboxuploadfile': { connector: 'dropbox', operation: 'upload_file' },
  'dropboxlistfolder': { connector: 'dropbox', operation: 'list_folder' },
  'dropboxsearch': { connector: 'dropbox', operation: 'search' },
  'openaicreatecompletion': { connector: 'openai', operation: 'chat_completion' },
  'openaicreatechatcompletion': { connector: 'openai', operation: 'chat_completion' },
  'googledrivelistfiles': { connector: 'google_drive', operation: 'list_files' },
  'googledrivecreatefolder': { connector: 'google_drive', operation: 'create_folder' },
  'googledrivedeletefile': { connector: 'google_drive', operation: 'delete_file' },
  'salesforcecreatecontact': { connector: 'salesforce', operation: 'create_contact' },
  'salesforcelistcontacts': { connector: 'salesforce', operation: 'list_contacts' },
  'pipedrivecreatedeal': { connector: 'pipedrive', operation: 'create_deal' },
  'pipedrivelistdeals': { connector: 'pipedrive', operation: 'list_deals' },
  'shopifycreateorder': { connector: 'shopify', operation: 'create_order' },
  'shopifylistproducts': { connector: 'shopify', operation: 'list_products' },
  'woocommercecreateproduct': { connector: 'woocommerce', operation: 'create_product' },
  'woocommercelistorders': { connector: 'woocommerce', operation: 'list_orders' },
  'wordpresscreatepost': { connector: 'wordpress', operation: 'create_post' },
  'wordpressupdatepost': { connector: 'wordpress', operation: 'update_post' },
  'mailchimpaddmember': { connector: 'mailchimp', operation: 'add_member' },
  'mailchimpcreatecampaign': { connector: 'mailchimp', operation: 'create_campaign' },
  'sendgridsendemail': { connector: 'sendgrid', operation: 'send_email' },
  'twiliosendsms': { connector: 'twilio', operation: 'send_sms' },
  'whatsappsendmessage': { connector: 'whatsapp', operation: 'send_text' },
  'supabaseinsertrow': { connector: 'supabase', operation: 'insert_rows' },
  'supabaseselectrows': { connector: 'supabase', operation: 'select_rows' },
  'supabaseupdaterow': { connector: 'supabase', operation: 'update_rows' },
};

const ALIASES: Record<string, string[]> = {
  channel: ['channel', 'channelId', 'channelName'],
  channelId: ['channelId', 'channel'],
  text: ['text', 'message', 'content', 'messageText'],
  content: ['content', 'text', 'message', 'body'],
  body: ['body', 'content', 'text', 'message'],
  title: ['title', 'name', 'summary', 'subject'],
  name: ['name', 'title', 'fullName'],
  email: ['email', 'emailAddress', 'email_address'],
  subject: ['subject', 'title'],
  message: ['message', 'text', 'body'],
  parentId: ['parentId', 'parent_id', 'databaseId', 'database_id', 'pageId', 'page_id'],
  databaseId: ['databaseId', 'database_id', 'baseId', 'base_id'],
  tableId: ['tableId', 'table_id', 'table'],
  baseId: ['baseId', 'base_id', 'appId', 'app_id'],
  issueNumber: ['issueNumber', 'issue_number', 'number'],
  repo: ['repo', 'repository', 'repositoryName'],
  repository: ['repository', 'repo', 'repositoryName'],
  owner: ['owner', 'organization', 'org'],
  boardId: ['boardId', 'board_id', 'board'],
  listId: ['listId', 'list_id', 'list'],
  projectId: ['projectId', 'project_id', 'project'],
  folderId: ['folderId', 'folder_id', 'folder'],
  fileId: ['fileId', 'file_id', 'file'],
  spreadsheetId: ['spreadsheetId', 'spreadsheet_id', 'spreadsheet'],
  sheetName: ['sheetName', 'sheet_name', 'sheet'],
  to: ['to', 'recipient', 'email', 'phone'],
  from: ['from', 'sender'],
  url: ['url', 'link', 'href'],
  status: ['status', 'state'],
  amount: ['amount', 'total', 'value'],
  quantity: ['quantity', 'qty'],
};

const SECRET_KEY = /(api[-_ ]?key|apikey|token|secret|password|passwd|authorization|bearer|private[-_ ]?key|client[-_ ]?secret)/i;
const SECRET_VALUE =
  /\b(sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{20,}|\d{8,10}:[A-Za-z0-9_-]{35}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/-]{20,})/;

const META_KEYS = new Set(['__imtconn__', '__imtconnid__', 'hook', 'module', 'version']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function modulesOf(value: unknown): MakeModule[] {
  return Array.isArray(value) ? value.filter(isRecord) as MakeModule[] : [];
}

function moduleType(module: MakeModule): string {
  return str(module.module);
}

function moduleId(module: MakeModule): string {
  return module.id === undefined || module.id === null ? '' : String(module.id);
}

function normalizedModule(module: MakeModule): string {
  return moduleType(module).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isTriggerModule(module: MakeModule): boolean {
  const name = moduleType(module);
  const normalized = normalizedModule(module);
  if (normalized.includes('webhookrespond')) return false;
  return /^gateway:/i.test(name) || /^schedule:/i.test(name) || normalized === 'builtinbasicscheduling';
}

function mapOperator(value: unknown, warn: (message: string) => void): Operator {
  const operator = str(value).toLowerCase();
  const known: Record<string, Operator> = {
    'text:exist': 'is_not_empty',
    'text:notexist': 'is_empty',
    'text:equal': 'equals',
    'text:notequal': 'not_equals',
    'text:contain': 'contains',
    'text:notcontain': 'not_contains',
    'text:startwith': 'starts_with',
    'text:endwith': 'ends_with',
    'number:equal': 'equals',
    'number:notequal': 'not_equals',
    'number:greater': 'gt',
    'number:less': 'lt',
    'number:greaterorequal': 'gte',
    'number:lessorequal': 'lte',
    'boolean:equal': 'equals',
    'date:equal': 'equals',
    'date:notequal': 'not_equals',
    'date:after': 'gt',
    'date:before': 'lt',
    'date:afterorequal': 'gte',
    'date:beforeorequal': 'lte',
    'array:contain': 'contains',
    'array:notcontain': 'not_contains',
  };
  const mapped = known[operator];
  if (mapped) return mapped;
  if (operator.includes('not')) return 'not_equals';
  if (operator.includes('empty') || operator.includes('exist')) return 'is_not_empty';
  warn(`condition operator "${operator}" was mapped to equals`);
  return 'equals';
}

function uniqueName(base: string, taken: Set<string>): string {
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!/^[a-z]/.test(slug)) slug = `make-${slug}`.replace(/-+$/, '');
  let name = slug || 'make';
  for (let n = 2; taken.has(name); n++) name = `${slug}-${n}`;
  taken.add(name);
  return name;
}

function fieldValue(
  bag: Record<string, unknown>,
  lower: Map<string, string>,
  field: ConnectorField,
): unknown {
  if (Object.prototype.hasOwnProperty.call(bag, field.key)) return bag[field.key];
  const lowered = lower.get(field.key.toLowerCase());
  if (lowered !== undefined) return bag[lowered];
  for (const alias of ALIASES[field.key] ?? []) {
    if (Object.prototype.hasOwnProperty.call(bag, alias)) return bag[alias];
    const candidate = lower.get(alias.toLowerCase());
    if (candidate !== undefined) return bag[candidate];
  }
  return undefined;
}

function typedValue(value: unknown, field: ConnectorField, warn: (message: string) => void, node: string): JsonValue {
  if (field.type === 'number' && typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
    warn(`${node}: "${field.key}" is not a number; it was kept as text`);
  }
  if (field.type === 'boolean' && typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  if (field.type === 'json' && typeof value === 'string') {
    try {
      return JSON.parse(value) as JsonValue;
    } catch {
      warn(`${node}: "${field.key}" is not valid JSON; it was kept as text`);
    }
  }
  return value as JsonValue;
}

function placeholder(name: string, type: string, reason: string): { type: NodeTypeName; config: Record<string, JsonValue> } {
  const message = `Make module "${name}" (${type}) was not converted: ${reason}`;
  return { type: 'code', config: { code: `throw new Error(${JSON.stringify(message)});` } };
}

export function importMake(raw: unknown, options: MakeImportOptions): { workflows: WorkflowView[]; report: MakeImportReport } {
  if (!isRecord(raw)) throw new Error('This is not a Make blueprint.');
  const blueprint = (isRecord(raw.blueprint) ? raw.blueprint : raw) as MakeBlueprint;
  if (!Array.isArray(blueprint.flow)) throw new Error('This Make blueprint has no "flow" list.');

  const scenarioName = str(blueprint.name) || 'Make scenario';
  const warnings: string[] = [];
  const report: MakeImportReport = {
    source: [scenarioName],
    workflows: [],
    warnings,
    unsupported: [],
    redacted: [],
    mapped: [],
    connections: [],
  };
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const root = modulesOf(blueprint.flow);
  const titles = new Map<string, string>();
  const usedTitles = new Set<string>();
  const titleOf = (module: MakeModule): string => {
    const id = moduleId(module);
    const cached = titles.get(id);
    if (cached) return cached;
    const designer = str(module.metadata?.designer?.name);
    const fallback = moduleType(module).split(':')[1] || moduleType(module) || 'Module';
    let title = designer || `${fallback}${id ? ` ${id}` : ''}`;
    for (let n = 2; usedTitles.has(title); n++) title = `${designer || fallback} (${n})`;
    usedTitles.add(title);
    if (id) titles.set(id, title);
    return title;
  };

  const walk = (modules: MakeModule[]) => {
    for (const module of modules) {
      titleOf(module);
      for (const route of Array.isArray(module.routes) ? module.routes : []) {
        if (isRecord(route)) walk(modulesOf(route.flow));
      }
      if (isRecord(module.onerror)) walk(modulesOf(module.onerror.flow));
    }
  };
  walk(root);

  const rootTrigger = root.find(isTriggerModule);
  const triggerId = rootTrigger ? moduleId(rootTrigger) : '';
  const trigger: WorkflowTriggerRef = (() => {
    if (!rootTrigger) return { pool: 'manual', config: {} };
    const normalized = normalizedModule(rootTrigger);
    if (normalized.includes('customwebhook') || normalized.includes('webhook')) {
      return { pool: 'webhook', config: {} };
    }
    warn(`${titleOf(rootTrigger)}: ${moduleType(rootTrigger)} was imported as a manual trigger`);
    return { pool: 'manual', config: {} };
  })();

  const nodes: WorkflowNode[] = [];
  const byId = new Map<string, WorkflowNode>();
  let sequence = 0;

  const addNode = (module: MakeModule, type: NodeTypeName, config: Record<string, JsonValue>): WorkflowNode => {
    const title = titleOf(module);
    const x = module.metadata?.designer?.x;
    const y = module.metadata?.designer?.y;
    const node: WorkflowNode = {
      id: `n${++sequence}`,
      type,
      title,
      config,
      links: {},
      ...(typeof x === 'number' && typeof y === 'number' ? { position: [x, y] as [number, number] } : {}),
    };
    nodes.push(node);
    byId.set(node.id, node);
    return node;
  };

  const link = (fromIds: string[], key: string, toIds: string[]) => {
    for (const fromId of fromIds) {
      const from = byId.get(fromId);
      if (!from) continue;
      const list = (from.links[key] ??= []);
      for (const toId of toIds) if (!list.includes(toId)) list.push(toId);
    }
  };

  const redact = (value: unknown, node: string, path: string): unknown => {
    if (typeof value === 'string') {
      const literal = !value.includes('{{');
      if ((SECRET_KEY.test(path) && literal && value.trim().length >= 8) || SECRET_VALUE.test(value)) {
        report.redacted.push({ module: node, field: path });
        return REDACTED;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map((entry, index) => redact(entry, node, `${path}[${index}]`));
    if (isRecord(value)) {
      const pairName = str(value.name);
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        const childPath = key === 'value' && pairName ? `${path}.${pairName}` : path ? `${path}.${key}` : key;
        out[key] = redact(child, node, childPath);
      }
      return out;
    }
    return value;
  };

  const convertText = (value: string, node: string): string => {
    let text = value;
    text = text.replace(/\{\{\s*(\d+)\.([^{}]+?)\s*\}\}/g, (_match, id: string, path: string) => {
      const target = titles.get(id);
      if (id === triggerId) return `{{ $trigger.json.${path.trim()} }}`;
      if (!target) {
        warn(`${node}: Make reference {{${id}.${path}}} points at a missing module; used $json`);
        return `{{ $json.${path.trim()} }}`;
      }
      return `{{ $node[${JSON.stringify(target)}].json.${path.trim()} }}`;
    });
    text = text.replace(/\{\{\s*now\s*\}\}/gi, '{{ $now }}');
    if (/\{\{[^}]*[A-Za-z_]\s*\(/.test(text)) {
      warn(`${node}: Make formula functions in "${text}" were kept as-is; rewrite them for Mimi`);
    }
    return text;
  };

  const convertValue = (value: unknown, node: string): JsonValue => {
    if (typeof value === 'string') return convertText(value, node);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) return value.map((entry) => convertValue(entry, node));
    if (isRecord(value)) {
      const out: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(value)) out[key] = convertValue(child, node);
      return out;
    }
    return null;
  };

  const conditionsOf = (filter: Record<string, unknown> | undefined, node: string): Array<{ left: JsonValue; operator: Operator; right: JsonValue }> => {
    if (!isRecord(filter) || !Array.isArray(filter.conditions)) return [];
    const groups = filter.conditions.filter(Array.isArray) as unknown[][];
    if (groups.length > 1) warn(`${node}: Make AND groups were flattened; check the condition`);
    const result: Array<{ left: JsonValue; operator: Operator; right: JsonValue }> = [];
    for (const group of groups) {
      const entries = group.filter(isRecord);
      if (entries.length > 1) warn(`${node}: Make OR conditions were flattened; check the condition`);
      const entry = entries[0];
      if (!entry) continue;
      result.push({
        left: convertValue(entry.a ?? '', node),
        operator: mapOperator(entry.o, warn),
        right: convertValue(entry.b ?? '', node),
      });
    }
    return result;
  };

  const pairs = (list: unknown, node: string): Record<string, JsonValue> => {
    const out: Record<string, JsonValue> = {};
    for (const entry of Array.isArray(list) ? list.filter(isRecord) : []) {
      const name = str(entry.name);
      if (name) out[name] = convertValue(entry.value ?? '', node);
    }
    return out;
  };

  const connectorInput = (
    connector: string,
    operation: string,
    mapper: Record<string, unknown>,
    parameters: Record<string, unknown>,
    node: string,
  ): { input: Record<string, JsonValue>; fields: string[]; missing: string[] } => {
    const bag: Record<string, unknown> = { ...parameters, ...mapper };
    for (const key of Object.keys(bag)) if (META_KEYS.has(key.toLowerCase())) delete bag[key];
    const lower = new Map<string, string>();
    for (const key of Object.keys(bag)) lower.set(key.toLowerCase(), key);
    const spec: ConnectorSpec | undefined = connectorSpecs.find((entry) => entry.key === connector);
    const target = spec?.operations.find((entry) => entry.key === operation);
    if (!target) {
      const input: Record<string, JsonValue> = {};
      for (const [key, value] of Object.entries(bag)) input[key] = convertValue(value, node);
      return { input, fields: Object.keys(input), missing: [] };
    }
    const input: Record<string, JsonValue> = {};
    const missing: string[] = [];
    for (const field of target.fields) {
      const value = fieldValue(bag, lower, field);
      if (value === undefined) {
        if (field.required) missing.push(field.key);
        if (field.default !== undefined) input[field.key] = field.default as JsonValue;
        continue;
      }
      input[field.key] = typedValue(convertValue(value, node), field, warn, node);
    }
    return { input, fields: Object.keys(input), missing };
  };

  const connectionOf = (module: MakeModule, connector: string): void => {
    const parameters = isRecord(module.parameters) ? module.parameters : {};
    const id = parameters.__IMTCONN__ ?? parameters.__IMTCONNID__;
    const connectionId = id === undefined || id === null || id === '' ? undefined : String(id);
    report.connections.push({ module: titleOf(module), connector, ...(connectionId ? { connectionId } : {}) });
    warn(`${titleOf(module)}: choose a Mimi connection for "${connector}"`);
  };

  const toolSheets = (module: MakeModule, mapper: Record<string, unknown>, node: string): { type: NodeTypeName; config: Record<string, JsonValue> } => {
    const raw = mapper.values;
    let values: JsonValue[][] = [];
    if (Array.isArray(raw)) {
      values = raw.map((entry) => (Array.isArray(entry) ? entry.map((item) => convertValue(item, node)) : [convertValue(entry, node)]));
    } else if (isRecord(raw)) {
      const keys = Object.keys(raw).sort((a, b) => Number(a) - Number(b));
      values = [keys.map((key) => convertValue(raw[key], node))];
    }
    const range = str(mapper.sheetName) || str(mapper.sheet_name) || 'Sheet1';
    if (!options.hasTool('sheets_append')) warn(`${node}: the Google Sheets tool is not available; connect Google Sheets first`);
    warn(`${node}: choose the spreadsheet in the Mimi Google Sheets tool; Make sent spreadsheet "${str(mapper.spreadsheetId) || 'unknown'}"`);
    return { type: 'tool', config: { tool: 'sheets_append', input: { range: convertValue(range, node), values } } };
  };

  const convertModule = (module: MakeModule): { type: NodeTypeName; config: Record<string, JsonValue> } => {
    const title = titleOf(module);
    const type = moduleType(module);
    const normalized = normalizedModule(module);
    const redactedMapper = redact(module.mapper ?? {}, title, 'mapper');
    const redactedParameters = redact(module.parameters ?? {}, title, 'parameters');
    const mapper = isRecord(redactedMapper) ? redactedMapper : {};
    const parameters = isRecord(redactedParameters) ? redactedParameters : {};

    if (normalized === 'httpactionsenddata') {
      const config: Record<string, JsonValue> = {
        method: str(mapper.method || 'GET').toUpperCase(),
        url: convertValue(mapper.url ?? '', title),
      };
      const headers = pairs(mapper.headers, title);
      const query = pairs(mapper.qs ?? mapper.query, title);
      if (Object.keys(headers).length > 0) config.headers = headers;
      if (Object.keys(query).length > 0) config.query = query;
      if (mapper.body !== undefined) config.body = convertValue(mapper.body, title);
      return { type: 'http', config };
    }

    if (normalized === 'gatewaywebhookrespond') {
      return {
        type: 'respond',
        config: {
          status: Number(mapper.status ?? 200) || 200,
          ...(mapper.headers !== undefined ? { headers: pairs(mapper.headers, title) } : {}),
          ...(mapper.body !== undefined ? { body: convertValue(mapper.body, title) } : {}),
        },
      };
    }

    if (normalized === 'builtinbasicfilter') {
      return {
        type: 'filter',
        config: {
          combinator: 'and',
          conditions: conditionsOf(module.filter, title),
        },
      };
    }

    if (normalized === 'codeexecutecode') {
      warn(`${title}: Make JavaScript syntax differs from Mimi; review the imported code`);
      const code = str(mapper.code);
      return { type: 'code', config: { code: code || 'return items;' } };
    }

    if (normalized === 'googlesheetsaddrow') {
      connectionOf(module, 'google_sheets');
      return toolSheets(module, mapper, title);
    }

    const mapped = MAKE_MAPPINGS[normalized];
    if (!mapped) {
      const reason = `no connector mapping for "${type}"`;
      report.unsupported.push({ module: title, type, reason });
      return placeholder(title, type, reason);
    }

    const { input, fields, missing } = connectorInput(mapped.connector, mapped.operation, mapper, parameters, title);
    connectionOf(module, mapped.connector);
    if (missing.length > 0) {
      warn(`${title}: required fields missing for ${mapped.connector}/${mapped.operation}: ${missing.join(', ')}`);
    }
    report.mapped.push({
      module: title,
      connector: mapped.connector,
      operation: mapped.operation,
      fields,
      confidence: missing.length > 0 || !connectorSpecs.some((entry) => entry.key === mapped.connector) ? 'medium' : 'high',
    });
    return {
      type: 'connector',
      config: {
        connector: mapped.connector,
        operation: mapped.operation,
        input,
        allow: false,
      },
    };
  };

  const convertFlow = (flow: MakeModule[], incoming: string[]): { firsts: string[]; tails: string[] } => {
    const firsts: string[] = [];
    let tails = incoming;
    for (const module of flow) {
      if (isTriggerModule(module)) {
        if (module !== rootTrigger) warn(`${titleOf(module)}: nested triggers are not supported and were skipped`);
        continue;
      }
      const normalized = normalizedModule(module);
      if (normalized === 'builtinbasicrouter') {
        const routes = (Array.isArray(module.routes) ? module.routes : [])
          .filter(isRecord)
          .map((route) => route as { flow?: unknown[]; filter?: Record<string, unknown> });
        if (routes.length === 0) {
          const node = addNode(module, 'set', { fields: {} });
          link(tails, 'main', [node.id]);
          if (firsts.length === 0) firsts.push(node.id);
          tails = [node.id];
          warn(`${titleOf(module)}: empty router became a passthrough`);
          continue;
        }
        const cases: Array<Record<string, JsonValue>> = [];
        const routeFlows: Array<{ flow: MakeModule[] }> = [];
        for (const route of routes) {
          let flow = modulesOf(route.flow);
          let conditions = conditionsOf(route.filter, titleOf(module));
          const first = flow[0];
          if (conditions.length === 0 && first && normalizedModule(first) === 'builtinbasicfilter') {
            conditions = conditionsOf(first.filter, titleOf(module));
            flow = flow.slice(1);
          }
          const condition = conditions[0] ?? { left: true, operator: 'is_true' as Operator, right: '' };
          if (conditions.length > 1) warn(`${titleOf(module)}: a route kept only its first condition`);
          cases.push(condition as unknown as Record<string, JsonValue>);
          routeFlows.push({ flow });
        }
        if (routes.length > 1 && cases.some((entry) => entry.left === true && entry.operator === 'is_true')) {
          warn(`${titleOf(module)}: routes without filters use always-true cases; review the branches`);
        }
        const node = addNode(module, 'switch', { mode: 'rules', cases });
        link(tails, 'main', [node.id]);
        if (firsts.length === 0) firsts.push(node.id);
        const routeTails: string[] = [];
        for (const [index, route] of routeFlows.entries()) {
          const built = convertFlow(route.flow, []);
          if (built.firsts.length > 0) node.links[`case${index}`] = built.firsts;
          routeTails.push(...built.tails);
        }
        tails = routeTails;
        if (tails.length === 0) warn(`${titleOf(module)}: routes have no mapped modules after the router`);
        for (const route of routes) {
          if (isRecord(route) && isRecord(route.filter) && route.filter.conditions === undefined) {
            warn(`${titleOf(module)}: a route filter had no conditions; it uses an always-true case`);
          }
        }
        continue;
      }

      const converted = convertModule(module);
      const node = addNode(module, converted.type, converted.config);
      link(tails, 'main', [node.id]);
      if (firsts.length === 0) firsts.push(node.id);
      tails = [node.id];

      if (isRecord(module.onerror) && Array.isArray(module.onerror.flow)) {
        const errorFlow = modulesOf(module.onerror.flow);
        if (errorFlow.length > 0) {
          const built = convertFlow(errorFlow, []);
          if (built.firsts.length > 0) {
            node.onError = 'branch';
            node.links.error = built.firsts;
          }
        }
      }
    }
    return { firsts, tails };
  };

  convertFlow(root, []);
  const name = uniqueName(scenarioName, new Set(options.existingNames));
  const title = scenarioName;
  const workflow: WorkflowView = {
    name,
    agent: options.agent,
    title,
    description: 'Imported from a Make blueprint.',
    enabled: false,
    trigger,
    webhook: null,
    vars: {},
    nodes,
  };
  const triggerPosition = rootTrigger ? (() => {
    const x = rootTrigger.metadata?.designer?.x;
    const y = rootTrigger.metadata?.designer?.y;
    return typeof x === 'number' && typeof y === 'number' ? [x, y] as [number, number] : undefined;
  })() : undefined;
  if (triggerPosition) workflow.triggerPosition = triggerPosition;
  report.workflows.push({ name, title, trigger: trigger.pool, nodes: nodes.length });
  return { workflows: [workflow], report };
}
