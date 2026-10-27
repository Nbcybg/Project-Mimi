import type { ConnectorField, ConnectorSpec, JsonValue, NodeTypeName, Operator, WorkflowNode, WorkflowTriggerRef, WorkflowView } from '@mimi/shared';
import { connectorSpecs } from '../connectors/services/index.ts';
import { REDACTED } from './n8n-import.ts';

/**
 * Converts a Zapier account export or a per-Zap JSON file into disabled Mimi
 * workflows. Steps are ordered by parent_id, Zapier `{{step__field}}` references
 * are rewritten, and every unmapped step is reported instead of being dropped.
 */

export interface ZapierImportReport {
  source: string[];
  workflows: Array<{ name: string; title: string; trigger: string; nodes: number }>;
  warnings: string[];
  unsupported: Array<{ step: string; api: string; action: string; reason: string }>;
  redacted: Array<{ step: string; field: string }>;
  mapped: Array<{ step: string; connector: string; operation: string; fields: string[]; confidence: 'high' | 'medium' }>;
  connections: Array<{ step: string; connector: string; authenticationId?: string }>;
}

export interface ZapierImportOptions {
  agent: string;
  existingNames: string[];
  hasTool(name: string): boolean;
}

interface ZapStep {
  id?: string | number;
  type_of?: string;
  action?: string;
  selected_api?: string;
  authentication_id?: string | number | null;
  parent_id?: string | number | null;
  root_id?: string | number | null;
  params?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

interface Zap {
  id?: string | number;
  title?: string;
  name?: string;
  enabled?: boolean;
  nodes?: Record<string, unknown> | unknown[];
  steps?: Record<string, unknown> | unknown[];
}

interface ZapMapping {
  connector: string;
  actions: Record<string, string>;
}

const ZAP_MAPPINGS: Record<string, ZapMapping> = {
  slack: {
    connector: 'slack',
    actions: {
      channelmessage: 'send_message',
      sendchannelmessage: 'send_message',
      senddirectmessage: 'send_message',
      updatemessage: 'update_message',
      addreaction: 'add_reaction',
      listchannels: 'list_channels',
    },
  },
  discord: { connector: 'discord', actions: { sendchannelmessage: 'send_message' } },
  notion: {
    connector: 'notion',
    actions: {
      createdatabaseitem: 'create_page',
      createpage: 'create_page',
      appendblock: 'append_blocks',
      findpage: 'get_page',
      querydatabase: 'query_database',
    },
  },
  airtable: {
    connector: 'airtable',
    actions: {
      createrecord: 'create_record',
      updaterecord: 'update_record',
      findrecord: 'list_records',
      listrecords: 'list_records',
      getrecord: 'get_record',
    },
  },
  googledocs: { connector: 'google_docs', actions: { createdocument: 'create_document', appendtext: 'append_text' } },
  googletasks: { connector: 'google_tasks', actions: { createtask: 'create_task', listtasks: 'list_tasks' } },
  googleforms: { connector: 'google_forms', actions: { listresponses: 'list_responses', getform: 'get_form' } },
  hubspot: {
    connector: 'hubspot',
    actions: {
      createcontact: 'create_contact',
      updatecontact: 'update_contact',
      createdeal: 'create_deal',
      listdeals: 'list_deals',
    },
  },
  stripe: {
    connector: 'stripe',
    actions: {
      createcustomer: 'create_customer',
      listcustomers: 'list_customers',
      createpaymentlink: 'create_payment_link',
      refundpayment: 'refund_payment',
    },
  },
  github: {
    connector: 'github',
    actions: { createissue: 'create_issue', createcomment: 'create_comment', getfile: 'get_file', listissues: 'list_issues' },
  },
  jira: { connector: 'jira', actions: { createissue: 'create_issue', addcomment: 'add_comment', searchissues: 'search_issues' } },
  trello: { connector: 'trello', actions: { createcard: 'create_card', listcards: 'list_cards' } },
  asana: { connector: 'asana', actions: { createtask: 'create_task', listtasks: 'list_tasks' } },
  clickup: { connector: 'clickup', actions: { createtask: 'create_task', listtasks: 'list_tasks' } },
  monday: { connector: 'monday', actions: { createitem: 'create_item', listitems: 'list_items' } },
  linear: { connector: 'linear', actions: { createissue: 'create_issue', addcomment: 'add_comment', listissues: 'list_issues' } },
  todoist: { connector: 'todoist', actions: { createtask: 'create_task', completetask: 'complete_task', listtasks: 'list_tasks' } },
  dropbox: { connector: 'dropbox', actions: { uploadfile: 'upload_file', listfolder: 'list_folder', search: 'search' } },
  openai: { connector: 'openai', actions: { sendprompt: 'chat_completion', chatcompletion: 'chat_completion' } },
  googledrive: {
    connector: 'google_drive',
    actions: { listfiles: 'list_files', createfolder: 'create_folder', deletefile: 'delete_file' },
  },
  salesforce: { connector: 'salesforce', actions: { createcontact: 'create_contact', listcontacts: 'list_contacts' } },
  pipedrive: { connector: 'pipedrive', actions: { createdeal: 'create_deal', listdeals: 'list_deals' } },
  shopify: { connector: 'shopify', actions: { createorder: 'create_order', listproducts: 'list_products' } },
  woocommerce: { connector: 'woocommerce', actions: { createproduct: 'create_product', listorders: 'list_orders' } },
  wordpress: { connector: 'wordpress', actions: { createpost: 'create_post', updatepost: 'update_post' } },
  mailchimp: { connector: 'mailchimp', actions: { addmember: 'add_member', createcampaign: 'create_campaign' } },
  sendgrid: { connector: 'sendgrid', actions: { sendemail: 'send_email' } },
  twilio: { connector: 'twilio', actions: { sendsms: 'send_sms' } },
  whatsapp: { connector: 'whatsapp', actions: { sendmessage: 'send_text', sendtext: 'send_text' } },
  supabase: {
    connector: 'supabase',
    actions: { insertrow: 'insert_rows', selectrow: 'select_rows', updaterow: 'update_rows' },
  },
  microsoftteams: { connector: 'microsoft_teams', actions: { sendchannelmessage: 'send_message' } },
  zoom: { connector: 'zoom', actions: { createmeeting: 'create_meeting', listmeetings: 'list_meetings' } },
  calendly: { connector: 'calendly', actions: { listscheduledevents: 'list_scheduled_events' } },
  typeform: { connector: 'typeform', actions: { listresponses: 'list_responses' } },
  box: { connector: 'box', actions: { uploadfile: 'upload_file', listfolder: 'list_folder' } },
  googleanalytics: { connector: 'google_analytics', actions: { runreport: 'run_report' } },
  googleads: { connector: 'google_ads', actions: { listcampaigns: 'list_campaigns' } },
  line: { connector: 'line', actions: { sendtext: 'send_text' } },
  zohocrm: { connector: 'zoho_crm', actions: { createcontact: 'create_contact', createdeal: 'create_deal' } },
  facebook: { connector: 'facebook', actions: { createpost: 'create_post' } },
  instagram: { connector: 'instagram', actions: { createpost: 'create_post' } },
  linkedin: { connector: 'linkedin', actions: { createpost: 'create_post' } },
  x: { connector: 'x', actions: { createpost: 'create_post' } },
  youtube: { connector: 'youtube', actions: { uploadvideo: 'upload_video' } },
  reddit: { connector: 'reddit', actions: { createcomment: 'create_comment' } },
  googlesearchconsole: { connector: 'google_search_console', actions: { querysearchanalytics: 'query_search_analytics' } },
  googlechat: { connector: 'google_chat', actions: { sendmessage: 'send_message' } },
  googleslides: { connector: 'google_slides', actions: { createpresentation: 'create_presentation' } },
  googleclassroom: { connector: 'google_classroom', actions: { createcoursework: 'create_coursework' } },
};

const ALIASES: Record<string, string[]> = {
  channel: ['channel', 'channel_id', 'channelId', 'channel_name'],
  channelId: ['channelId', 'channel', 'channel_id'],
  text: ['text', 'message', 'content', 'message_text'],
  content: ['content', 'text', 'message', 'body'],
  body: ['body', 'content', 'text', 'message'],
  title: ['title', 'name', 'summary', 'subject'],
  name: ['name', 'title', 'full_name'],
  email: ['email', 'email_address', 'emailAddress'],
  subject: ['subject', 'title'],
  baseId: ['baseId', 'base', 'base_id', 'app', 'app_id'],
  table: ['table', 'table_name', 'tableName'],
  databaseId: ['databaseId', 'database', 'database_id'],
  properties: ['properties', 'fields', 'record', 'records'],
  fields: ['fields', 'properties', 'record'],
  repository: ['repository', 'repo', 'repository_name'],
  repo: ['repo', 'repository', 'repository_name'],
  owner: ['owner', 'organization', 'org'],
  boardId: ['boardId', 'board', 'board_id'],
  listId: ['listId', 'list', 'list_id'],
  projectId: ['projectId', 'project', 'project_id'],
  folderId: ['folderId', 'folder', 'folder_id'],
  fileId: ['fileId', 'file', 'file_id'],
  spreadsheetId: ['spreadsheetId', 'spreadsheet', 'spreadsheet_id'],
  sheetName: ['sheetName', 'worksheet', 'sheet', 'sheet_name'],
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

const META_KEYS = new Set(['meta', 'authentication_id', 'authenticationid', 'auth']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function stepId(step: ZapStep): string {
  return step.id === undefined || step.id === null ? '' : String(step.id);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function appKey(api: string): string {
  return normalize(api).replace(/v\d+api?$/, '').replace(/api$/, '').replace(/v\d+$/, '');
}

function stepsOf(zap: Zap): ZapStep[] {
  const raw = zap.nodes ?? zap.steps;
  if (Array.isArray(raw)) return raw.filter(isRecord) as ZapStep[];
  if (isRecord(raw)) {
    return Object.entries(raw).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])).map(([id, step]) => ({
      ...step,
      id: step.id ?? id,
    })) as ZapStep[];
  }
  return [];
}

function zapsOf(raw: unknown): Zap[] {
  if (Array.isArray(raw)) return raw.filter(isRecord) as Zap[];
  if (!isRecord(raw)) throw new Error('This is not a Zapier export.');
  if (Array.isArray(raw.zaps)) return raw.zaps.filter(isRecord) as Zap[];
  if (isRecord(raw.zap)) return [raw.zap as Zap];
  if (raw.nodes !== undefined || raw.steps !== undefined) return [raw as Zap];
  throw new Error('This Zapier export has no "zaps" or step list.');
}

function uniqueName(base: string, taken: Set<string>): string {
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!/^[a-z]/.test(slug)) slug = `zapier-${slug}`.replace(/-+$/, '');
  let name = slug || 'zapier';
  for (let n = 2; taken.has(name); n++) name = `${slug}-${n}`;
  taken.add(name);
  return name;
}

function mapOperator(value: string, warn: (message: string) => void): Operator {
  const key = normalize(value);
  const operators: Record<string, Operator> = {
    exists: 'is_not_empty',
    iexist: 'is_not_empty',
    notexists: 'is_empty',
    inotexists: 'is_empty',
    textcontains: 'contains',
    textdoesnotcontain: 'not_contains',
    textexactly: 'equals',
    textdoesnotequal: 'not_equals',
    textstartswith: 'starts_with',
    textendswith: 'ends_with',
    numbergreater: 'gt',
    numberless: 'lt',
    numberequals: 'equals',
    numbernotequals: 'not_equals',
    booleanequals: 'equals',
    dateafter: 'gt',
    datebefore: 'lt',
  };
  const mapped = operators[key];
  if (mapped) return mapped;
  if (key.includes('not')) return 'not_equals';
  warn(`Zapier filter operator "${value}" was mapped to equals`);
  return 'equals';
}

function pathSuffix(field: string): string {
  return field
    .split('__')
    .filter((part) => part !== '')
    .map((part) => (/^[A-Za-z_$][\w$]*$/.test(part) ? `.${part}` : `[${JSON.stringify(part)}]`))
    .join('');
}

function placeholder(name: string, api: string, action: string, reason: string): { type: NodeTypeName; config: Record<string, JsonValue> } {
  const message = `Zapier step "${name}" (${api}/${action}) was not converted: ${reason}`;
  return { type: 'code', config: { code: `throw new Error(${JSON.stringify(message)});` } };
}

export function importZapier(raw: unknown, options: ZapierImportOptions): { workflows: WorkflowView[]; report: ZapierImportReport } {
  const zaps = zapsOf(raw);
  if (zaps.length === 0) throw new Error('The Zapier export has no Zaps.');
  const warnings: string[] = [];
  const report: ZapierImportReport = {
    source: [],
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
  const workflows: WorkflowView[] = [];
  const taken = new Set(options.existingNames);

  for (const [zapIndex, zap] of zaps.entries()) {
    const title = asText(zap.title ?? zap.name) || `Zap ${zapIndex + 1}`;
    report.source.push(title);
    const steps = stepsOf(zap);
    if (steps.length === 0) {
      warn(`${title}: the Zap has no steps`);
      continue;
    }

    const byId = new Map<string, ZapStep>();
    for (const step of steps) {
      const id = stepId(step);
      if (!id) {
        warn(`${title}: a step has no id and was skipped`);
        continue;
      }
      if (byId.has(id)) warn(`${title}: duplicate step id "${id}"; the last one wins`);
      byId.set(id, step);
    }

    const parentOf = (step: ZapStep): string => {
      const parent = asText(step.parent_id);
      if (parent && byId.has(parent)) return parent;
      const root = asText(step.root_id);
      return root && root !== stepId(step) && byId.has(root) ? root : '';
    };
    const children = new Map<string, string[]>();
    for (const step of byId.values()) {
      const parent = parentOf(step);
      if (!parent) continue;
      const list = children.get(parent) ?? [];
      list.push(stepId(step));
      children.set(parent, list);
    }
    for (const list of children.values()) {
      list.sort((a, b) => (Number(a) || 0) - (Number(b) || 0));
      if (list.length > 1) warn(`${title}: branches were flattened in Zapier step order; check the workflow`);
    }

    const roots = [...byId.values()].filter((step) => !parentOf(step));
    const triggerStep = roots.find((step) => asText(step.selected_api) === 'WebHookAPI') ?? roots[0];
    if (!triggerStep) {
      warn(`${title}: no trigger step was found; a manual trigger was used`);
    } else if (asText(triggerStep.selected_api) !== 'WebHookAPI') {
      warn(`${title}: ${asText(triggerStep.selected_api) || 'the trigger'} was imported as a manual trigger`);
    }

    const ordered: ZapStep[] = [];
    const seen = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      const step = byId.get(id);
      if (!step) return;
      seen.add(id);
      ordered.push(step);
      for (const child of children.get(id) ?? []) visit(child);
    };
    if (triggerStep) visit(stepId(triggerStep));
    for (const root of roots) {
      if (seen.has(stepId(root))) continue;
      warn(`${title}: more than one start step; "${asText(root.action) || stepId(root)}" was chained after the trigger`);
      visit(stepId(root));
    }
    for (const step of byId.values()) {
      if (!seen.has(stepId(step))) {
        warn(`${title}: step "${asText(step.action) || stepId(step)}" was not connected to the trigger; it was appended`);
        visit(stepId(step));
      }
    }
    if (ordered.length === 0) {
      warn(`${title}: no readable steps were found`);
      continue;
    }

    const titles = new Map<string, string>();
    const usedTitles = new Set<string>();
    const titleOf = (step: ZapStep): string => {
      const id = stepId(step);
      const cached = titles.get(id);
      if (cached) return cached;
      const meta = isRecord(step.meta) ? step.meta : {};
      const base = asText(meta.title ?? meta.name) || `${asText(step.selected_api) || 'Step'}: ${asText(step.action) || id}`;
      let stepTitle = base;
      for (let n = 2; usedTitles.has(stepTitle); n++) stepTitle = `${base} (${n})`;
      usedTitles.add(stepTitle);
      titles.set(id, stepTitle);
      return stepTitle;
    };
    for (const step of ordered) titleOf(step);

    const triggerId = triggerStep ? stepId(triggerStep) : '';
    const trigger: WorkflowTriggerRef = asText(triggerStep?.selected_api) === 'WebHookAPI'
      ? { pool: 'webhook', config: {} }
      : { pool: 'manual', config: {} };

    const convertText = (value: string, node: string): string => {
      let text = value;
      text = text.replace(/\{\{\s*([A-Za-z0-9]+?)__([^{}]+?)\s*\}\}/g, (_match, id: string, field: string) => {
        const target = titles.get(id);
        const suffix = pathSuffix(field.trim());
        if (id === triggerId) return `{{ $trigger.json${suffix} }}`;
        if (!target) {
          warn(`${node}: Zapier reference {{${id}__${field}}} points at a missing step; used $json`);
          return `{{ $json${suffix} }}`;
        }
        return `{{ $node[${JSON.stringify(target)}].json${suffix} }}`;
      });
      text = text.replace(/\{\{\s*(?:zap_meta_human_now|now)\s*\}\}/gi, '{{ $now }}');
      if (/\{\{[^}]*[A-Za-z_]\s*\(/.test(text)) {
        warn(`${node}: Zapier formatter functions in "${text}" were kept as-is; rewrite them for Mimi`);
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

    const redact = (value: unknown, node: string, path: string): unknown => {
      if (typeof value === 'string') {
        const literal = !value.includes('{{');
        if ((SECRET_KEY.test(path) && literal && value.trim().length >= 8) || SECRET_VALUE.test(value)) {
          report.redacted.push({ step: node, field: path });
          return REDACTED;
        }
        return value;
      }
      if (Array.isArray(value)) return value.map((entry, index) => redact(entry, node, `${path}[${index}]`));
      if (isRecord(value)) {
        const pairName = asText(value.name);
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
          const childPath = key === 'value' && pairName ? `${path}.${pairName}` : path ? `${path}.${key}` : key;
          out[key] = redact(child, node, childPath);
        }
        return out;
      }
      return value;
    };

    const typedValue = (value: unknown, field: ConnectorField, node: string): JsonValue => {
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
    };

    const connectorInput = (
      connector: string,
      operation: string,
      params: Record<string, unknown>,
      node: string,
    ): { input: Record<string, JsonValue>; fields: string[]; missing: string[] } => {
      const bag: Record<string, unknown> = { ...params };
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
        let value: unknown;
        if (Object.prototype.hasOwnProperty.call(bag, field.key)) value = bag[field.key];
        else {
          const lowered = lower.get(field.key.toLowerCase());
          if (lowered !== undefined) value = bag[lowered];
          else {
            for (const alias of ALIASES[field.key] ?? []) {
              if (Object.prototype.hasOwnProperty.call(bag, alias)) {
                value = bag[alias];
                break;
              }
              const candidate = lower.get(alias.toLowerCase());
              if (candidate !== undefined) {
                value = bag[candidate];
                break;
              }
            }
          }
        }
        if (value === undefined) {
          if (field.required) missing.push(field.key);
          if (field.default !== undefined) input[field.key] = field.default as JsonValue;
          continue;
        }
        input[field.key] = typedValue(convertValue(value, node), field, node);
      }
      return { input, fields: Object.keys(input), missing };
    };

    const addConnection = (step: ZapStep, connector: string) => {
      const rawAuth = asText(step.authentication_id).trim();
      const authenticationId = rawAuth && rawAuth !== '-' && rawAuth.toLowerCase() !== 'null' ? rawAuth : undefined;
      report.connections.push({ step: titleOf(step), connector, ...(authenticationId ? { authenticationId } : {}) });
      warn(`${titleOf(step)}: choose a Mimi connection for "${connector}"`);
    };

    const pairs = (value: unknown, node: string): Record<string, JsonValue> => {
      if (isRecord(value)) {
        const out: Record<string, JsonValue> = {};
        for (const [key, child] of Object.entries(value)) out[key] = convertValue(child, node);
        return out;
      }
      const out: Record<string, JsonValue> = {};
      for (const entry of Array.isArray(value) ? value.filter(isRecord) : []) {
        const name = asText(entry.name);
        if (name) out[name] = convertValue(entry.value ?? '', node);
      }
      return out;
    };

    const sheetTool = (step: ZapStep, params: Record<string, unknown>, node: string): { type: NodeTypeName; config: Record<string, JsonValue> } => {
      const raw = params.values;
      let values: JsonValue[][] = [];
      if (Array.isArray(raw)) {
        values = raw.map((entry) => (Array.isArray(entry) ? entry.map((item) => convertValue(item, node)) : [convertValue(entry, node)]));
      } else if (isRecord(raw)) {
        values = [Object.values(raw).map((entry) => convertValue(entry, node))];
      }
      const range = asText(params.worksheet ?? params.sheetName) || 'Sheet1';
      if (!options.hasTool('sheets_append')) warn(`${node}: the Google Sheets tool is not available; connect Google Sheets first`);
      warn(`${node}: choose the spreadsheet in the Mimi Google Sheets tool; Zapier sent "${asText(params.spreadsheet) || 'unknown'}"`);
      return { type: 'tool', config: { tool: 'sheets_append', input: { range: convertValue(range, node), values } } };
    };

    const convertStep = (step: ZapStep): { type: NodeTypeName; config: Record<string, JsonValue> } | undefined => {
      if (stepId(step) === triggerId) return undefined;
      const node = titleOf(step);
      const api = asText(step.selected_api);
      const action = asText(step.action);
      const app = appKey(api);
      const normalizedAction = normalize(action);
      const rawParams = redact(step.params ?? {}, node, 'params');
      const params = isRecord(rawParams) ? rawParams : {};

      if (asText(step.type_of) === 'filter' || app === 'filter') {
        const criteria = Array.isArray(params.filter_criteria) ? params.filter_criteria.filter(isRecord) : [];
        if (criteria.length === 0) warn(`${node}: the filter has no criteria and will pass everything`);
        const conditions = criteria.map((criterion) => {
          const key = asText(criterion.key);
          return {
            left: key.includes('{{') ? convertValue(key, node) : convertText(`{{${key}}}`, node),
            operator: mapOperator(asText(criterion.match), warn),
            right: convertValue(criterion.value ?? '', node),
          };
        });
        return { type: 'filter', config: { combinator: 'and', conditions } };
      }

      if (app === 'googlesheets' && (normalizedAction === 'appendrow' || normalizedAction === 'addrow')) {
        addConnection(step, 'google_sheets');
        return sheetTool(step, params, node);
      }

      if (app === 'code') {
        if (normalizedAction.includes('python')) {
          const reason = 'Python code is not run by Mimi; move the logic to a JavaScript code node';
          report.unsupported.push({ step: node, api, action, reason });
          return placeholder(node, api, action, reason);
        }
        warn(`${node}: review the imported JavaScript; Zapier helpers are not available`);
        return { type: 'code', config: { code: asText(params.code) || 'return items;' } };
      }

      if (app === 'webhooks' && normalizedAction === 'post') {
        return {
          type: 'http',
          config: {
            method: asText(params.method).toUpperCase() || 'POST',
            url: convertValue(params.url ?? '', node),
            ...(params.headers !== undefined ? { headers: pairs(params.headers, node) } : {}),
            ...(params.data !== undefined ? { body: convertValue(params.data, node) } : {}),
          },
        };
      }

      const mapping = ZAP_MAPPINGS[app];
      const operation = mapping?.actions[normalizedAction];
      if (!mapping || !operation) {
        const reason = mapping
          ? `no connector operation mapping for "${api}/${action}"`
          : `no connector mapping for "${api}"`;
        report.unsupported.push({ step: node, api, action, reason });
        return placeholder(node, api, action, reason);
      }

      const { input, fields, missing } = connectorInput(mapping.connector, operation, params, node);
      addConnection(step, mapping.connector);
      if (missing.length > 0) warn(`${node}: required fields missing for ${mapping.connector}/${operation}: ${missing.join(', ')}`);
      report.mapped.push({
        step: node,
        connector: mapping.connector,
        operation,
        fields,
        confidence: missing.length > 0 || !connectorSpecs.some((entry) => entry.key === mapping.connector) ? 'medium' : 'high',
      });
      return {
        type: 'connector',
        config: { connector: mapping.connector, operation, input, allow: false },
      };
    };

    const nodes: WorkflowNode[] = [];
    let previous: string | undefined;
    for (const step of ordered) {
      const converted = convertStep(step);
      if (!converted) continue;
      const node: WorkflowNode = {
        id: `z${nodes.length + 1}`,
        type: converted.type,
        title: titleOf(step),
        config: converted.config,
        links: {},
      };
      nodes.push(node);
      if (previous) {
        const from = nodes.find((entry) => entry.id === previous);
        if (from) (from.links.main ??= []).push(node.id);
      }
      previous = node.id;
    }

    const name = uniqueName(title, taken);
    const workflow: WorkflowView = {
      name,
      agent: options.agent,
      title,
      description: 'Imported from a Zapier Zap.',
      enabled: false,
      trigger,
      webhook: null,
      vars: {},
      nodes,
    };
    workflows.push(workflow);
    report.workflows.push({ name, title, trigger: trigger.pool, nodes: nodes.length });
  }

  if (workflows.length === 0) throw new Error('No readable Zaps were found in the export.');
  return { workflows, report };
}
