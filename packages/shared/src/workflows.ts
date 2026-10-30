/** Values a flow carries: plain JSON, so expressions and stored runs stay readable. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** One item flowing between nodes (n8n-style: nodes pass arrays of these). */
export interface FlowItem {
  json: Record<string, JsonValue>;
}

export type NodeTypeName =
  | 'agent'
  | 'chat'
  | 'if'
  | 'switch'
  | 'set'
  | 'code'
  | 'http'
  | 'tool'
  | 'connector'
  | 'filter'
  | 'sort'
  | 'limit'
  | 'aggregate'
  | 'remove_duplicates'
  | 'merge'
  | 'wait'
  | 'stop'
  | 'workflow'
  | 'respond'
  | 'llm'
  | 'classify'
  | 'extract'
  | 'split_out'
  | 'loop'
  | 'approval'
  | 'telegram'
  | 'datetime'
  | 'file'
  | 'extract_file'
  | 'knowledge'
  | 'sheets'
  | 'plugin'
  | 'trigger_manual'
  | 'trigger_schedule'
  | 'trigger_webhook'
  | 'trigger_form'
  | 'trigger_mail'
  | 'trigger_poll'
  | 'trigger_chat'
  | 'trigger_telegram'
  | 'trigger_tool'
  | 'trigger_connector'
  | 'trigger_custom';

export type NodeFieldType = 'string' | 'number' | 'boolean' | 'text' | 'json' | 'expression' | 'account';

/** One field the extract node asks the model for. */
export interface ExtractAttribute {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
  required?: boolean;
}

/** One category of the classify node; its output is `cat<index>`. */
export interface ClassifyCategory {
  name: string;
  description?: string;
}

export interface WorkflowNode {
  id: string;
  type: NodeTypeName;
  title?: string;
  /** Field values; strings may hold {{ $json.x }} expressions. */
  config: Record<string, JsonValue>;
  /** Output key (see NodeTypeView.outputs) -> target node ids. */
  links: Record<string, string[]>;
  /** What a failing node does: "stop" fails the run (default), "continue" passes the input on, "branch" sends it to the "error" output. */
  onError?: 'stop' | 'continue' | 'branch';
  /** Extra attempts after the first failure. */
  retries?: number;
  /** Milliseconds between attempts. */
  retryWaitMs?: number;
  /** Where the node sits on the editor canvas, `[x, y]`. */
  position?: [number, number];
  /** Switched off: the node does not run and passes its input straight on. */
  disabled?: boolean;
  /** Fixed output used instead of running the node, in runs started from the editor only. */
  pinned?: Array<Record<string, JsonValue>>;
}

/** A sticky note on the editor canvas; it never runs. */
export interface WorkflowNote {
  id: string;
  text: string;
  position: [number, number];
  width?: number;
  height?: number;
  color?: string;
}

/** A trigger is chosen from the trigger pool and configured per workflow. */
export interface WorkflowTriggerRef {
  pool: string;
  config: Record<string, JsonValue>;
}

export interface WorkflowView {
  name: string;
  /** The agent this workflow belongs to; it lives in workflows/<agent>/<name>.json. */
  agent: string;
  title: string;
  description: string;
  enabled: boolean;
  trigger: WorkflowTriggerRef;
  /** Path to POST to when the trigger pool entry is a webhook, e.g. "/api/workflow/<key>". */
  webhook: string | null;
  /** Workflow variables, read in expressions as `{{ $vars.x }}`. */
  vars?: Record<string, JsonValue>;
  /** Workflow of the same agent that runs when this one fails, with `workflow`/`error` items. */
  errorWorkflow?: string;
  nodes: WorkflowNode[];
  /** Sticky notes on the canvas. */
  notes?: WorkflowNote[];
  /** Where the virtual trigger box sits on the editor canvas; missing = beside the start nodes. */
  triggerPosition?: [number, number];
}

export interface WorkflowRunNodeView {
  id: string;
  title: string;
  type: string;
  /** "waiting": the run paused here (an approval, a long wait) and goes on later. */
  status: 'ok' | 'error' | 'waiting';
  /** What flowed in and out (raw items), exactly as the expressions saw it. */
  input: FlowItem[];
  output: FlowItem[];
  error?: string;
  /** How many tries the node needed (set when it retried at least once). */
  attempts?: number;
  /** Where the work went, for the run detail: connector + operation and a correlation id. */
  trace?: WorkflowNodeTrace;
  /** Why the node did not really run: switched off, or its pinned output was used. */
  note?: 'disabled' | 'pinned';
}

/** Non-secret debugging context of a node, safe to store and show. */
export interface WorkflowNodeTrace {
  connector?: string;
  operation?: string;
  /** Connector spec version that actually ran. */
  connectorVersion?: string;
  /** True when the pinned spec is older than the installed latest. */
  deprecated?: boolean;
  /** Latest installed version, when `deprecated` is true. */
  latestVersion?: string;
  /** Correlation id (run id + node id); not a provider credential. */
  requestId?: string;
  /** Provider/application error code when one was reported. */
  errorCode?: string;
}

/** The HTTP answer a webhook-triggered run sends back (set by a `respond` node). */
export interface WorkflowResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Body to send back; missing means "send the run result as JSON". */
  body?: JsonValue;
}

/** One stored run of a workflow, as the history list shows it. */
export interface WorkflowRunSummary {
  id: number;
  /** `<agent>/<name>`. */
  workflow: string;
  /** Agent that owns the workflow (the part before `/`). */
  agent: string;
  /** What started it: manual / schedule / webhook / mail / poll. */
  trigger: string;
  /** What started it: manual / schedule / webhook / mail / poll. */
  mode: string;
  ok: boolean;
  result: string;
  startedAt: string;
  durationMs: number;
  nodeCount: number;
}

/** A stored run with every node's input and output (long item lists are cut). */
export interface WorkflowRunRecord extends WorkflowRunSummary {
  nodes: WorkflowRunNodeView[];
}

export interface WorkflowRunResult {
  /** Row in the run history, when the run was stored. */
  runId?: number;
  name: string;
  ok: boolean;
  /** A short human summary (used for toasts and the trigger's lastResult). */
  result: string;
  /** Present when a `respond` node shaped the webhook answer. */
  response?: WorkflowResponse;
  /** Set when the run paused: it is stored and finishes when the answer or the time comes. */
  suspended?: { id: number; nodeId: string; kind: 'approval' | 'wait'; resumeAt?: string };
  nodes: WorkflowRunNodeView[];
}

/** The answer to a single-node test: what went in, and what came out per output. */
export interface WorkflowNodeTestResult {
  ok: boolean;
  error?: string;
  input: FlowItem[];
  /** Items per output key (main / true / false / case0 / fallback), so branches are visible. */
  outputs: Record<string, FlowItem[]>;
}

export interface NodeTypeField {
  key: string;
  label: string;
  type: NodeFieldType;
  /** For `account` fields: which accounts the dropdown offers; missing = every service. */
  service?: import('./tools.ts').AccountService;
  placeholder?: string;
  required?: boolean;
  description?: string;
  /** Fixed choices; the editor renders a select instead of a text input. */
  options?: string[];
}

export interface NodeTypeView {
  type: NodeTypeName;
  label: string;
  description: string;
  fields: NodeTypeField[];
  outputs: Array<{ key: string; label: string }>;
  /** Set for trigger nodes: the trigger-pool entry whose settings and sample this node uses. */
  triggerPool?: string;
}

/** The condition operators `if` and `switch` understand. */
export const OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'regex',
  'gt',
  'lt',
  'gte',
  'lte',
  'is_empty',
  'is_not_empty',
  'is_true',
  'is_false',
] as const;
export type Operator = (typeof OPERATORS)[number];

export const NODE_TYPES: NodeTypeView[] = [
  {
    type: 'agent',
    label: 'AI agent',
    description: 'รัน agent ที่ตั้งค่าไว้แล้วกับข้อมูลที่ไหลเข้ามา ผลลัพธ์ถูก merge กลับเข้า item',
    fields: [
      { key: 'agent', label: 'agent', type: 'string', required: true, placeholder: 'ชื่อ agent' },
      { key: 'instruction', label: 'คำสั่ง', type: 'text', placeholder: 'เช่น วิเคราะห์ว่าเมลนี้สแปมไหม แล้วตอบ "SPAM" หรือ "OK"' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'chat',
    label: 'ส่งเข้าแชต',
    description: 'ส่งข้อความ และ/หรือ ไฟล์ (รูป เสียง วิดีโอ เอกสาร) เข้าแชตของ agent (ค่าเริ่มต้น = agent เจ้าของ workflow)',
    fields: [
      { key: 'agent', label: 'agent ปลายทาง (เว้นว่าง = เจ้าของ workflow)', type: 'string' },
      { key: 'text', label: 'ข้อความ', type: 'text', placeholder: '📬 {{ $json.Subject }} — {{ $json.text }}' },
      {
        key: 'files',
        label: 'ไฟล์แนบ (id ไฟล์ในแชต หรือ path; หลายไฟล์คั่นด้วย , หรือขึ้นบรรทัด)',
        type: 'expression',
        placeholder: '{{ $json.files[0].id }}',
        description: 'ใส่ผลของ tool generate_image / text_to_speech / send_file ทั้งก้อนได้เลย ระบบหา "attachment id" ในข้อความเอง',
      },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'if',
    label: 'เงื่อนไข if',
    description: 'แยกทางด้วยเงื่อนไขหลายข้อ (และ/หรือ); item เดิมไหลต่อไปทั้งสองทาง',
    fields: [
      { key: 'combinator', label: 'รวมเงื่อนไขแบบ', type: 'string', options: ['and', 'or'] },
      {
        key: 'conditions',
        label: 'เงื่อนไข',
        type: 'json',
        required: true,
        placeholder: '[{"left":"{{ $json.text }}","operator":"contains","right":"spam"}]',
        description: 'แต่ละแถวคือหนึ่งเงื่อนไข · ใช้ and/or จากช่อง "รวมเงื่อนไขแบบ"',
      },
    ],
    outputs: [
      { key: 'true', label: 'จริง (true)' },
      { key: 'false', label: 'เท็จ (false)' },
    ],
  },
  {
    type: 'switch',
    label: 'switch',
    description: 'เทียบกับหลายกรณี ไม่จำกัดจำนวน (โหมด value = เทียบค่า, rules = เงื่อนไข)',
    fields: [
      { key: 'mode', label: 'โหมด', type: 'string', options: ['value', 'rules'], description: 'value = เทียบค่าตรง ๆ กับแต่ละกรณี · rules = ตั้งเงื่อนไขของแต่ละกรณีเอง' },
      { key: 'value', label: 'ค่า (expression) — โหมด value', type: 'expression', placeholder: '{{ $json.Subject }}', description: 'ค่าที่จะเอาไปเทียบกับแต่ละกรณี' },
      {
        key: 'cases',
        label: 'กรณี',
        type: 'json',
        placeholder: '["urgent","invoice"] หรือ [{"left":"{{ $json.n }}","operator":"gt","right":10}]',
        description: 'แต่ละกรณีมี output ของตัวเอง (case0, case1, …) · item ที่ไม่ตรงกรณีไหนไปที่ fallback',
      },
    ],
    outputs: [
      { key: 'case0', label: 'กรณี 1' },
      { key: 'fallback', label: 'อื่น ๆ' },
    ],
  },
  {
    type: 'set',
    label: 'set (กำหนดค่า)',
    description: 'เพิ่ม/แก้ field ใน item ด้วย expression',
    fields: [{ key: 'fields', label: 'field ที่จะตั้ง (JSON)', type: 'json', required: true, placeholder: '{"subject": "{{ $json.Subject }}", "urgent": true}' }],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'code',
    label: 'code (JavaScript)',
    description: 'รันโค้ดสั้น ๆ รับ items และ return items ใหม่',
    fields: [{ key: 'code', label: 'โค้ด', type: 'text', required: true, placeholder: 'return items.map((item) => ({ json: { ...item, upper: String(item.Subject).toUpperCase() } }));' }],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'http',
    label: 'HTTP Request',
    description: 'เรียก HTTP API; คำตอบ JSON กลายเป็น items',
    fields: [
      { key: 'method', label: 'method', type: 'string', placeholder: 'GET' },
      { key: 'url', label: 'URL', type: 'string', required: true, placeholder: 'https://api.example.com/items/{{ $json.Id }}' },
      { key: 'headers', label: 'headers (JSON)', type: 'json', placeholder: '{"authorization": "Bearer {{ $vars.key }}"}' },
      { key: 'query', label: 'query (JSON)', type: 'json', placeholder: '{"limit": 5}' },
      { key: 'body', label: 'body (JSON)', type: 'json', placeholder: '{"subject": "{{ $json.Subject }}"}' },
      { key: 'timeoutMs', label: 'timeout (ms)', type: 'number', placeholder: '60000', description: '1000-120000; ค่าเริ่มต้น 60000' },
      { key: 'allowLocal', label: 'อนุญาตเรียกเครือข่ายภายใน (localhost, 192.168.x.x, เครื่องในบ้าน)', type: 'boolean' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'tool',
    label: 'เรียก tool',
    description: 'เรียกเครื่องมือ/preset จากกองเครื่องมือ',
    fields: [
      { key: 'tool', label: 'เครื่องมือ / preset', type: 'string', required: true },
      { key: 'agent', label: 'agent เจ้าของเครื่องมือ (เว้นว่าง = เจ้าของ workflow)', type: 'string', description: 'ใช้กับเครื่องมือที่อ่านค่าจาก agent เช่น ไฟล์ ความจำ โปรไฟล์ หรือการแจ้งเตือน' },
      { key: 'input', label: 'input (JSON + expression)', type: 'json', placeholder: '{"range": "A1", "values": [["{{ $json.Subject }}"]]}' },
      { key: 'allow', label: 'อนุญาตให้ทำงานนี้ (เครื่องมือที่ส่ง / แก้ / ลบข้อมูล ต้องติ๊ก เพราะ workflow รันเองโดยไม่มีใครกดยืนยัน)', type: 'boolean' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'connector',
    label: 'Connector',
    description: 'เรียก operation ของ service ที่ติดตั้งไว้ (auth และ rate limit มาจาก connector runtime)',
    fields: [
      { key: 'connector', label: 'service', type: 'string', required: true, placeholder: 'slack' },
      { key: 'operation', label: 'operation', type: 'string', required: true, placeholder: 'send_message' },
      { key: 'account', label: 'บัญชี (เว้นว่าง = บัญชีเริ่มต้น)', type: 'string' },
      { key: 'input', label: 'input (JSON + expression)', type: 'json', placeholder: '{"channel": "C123", "text": "{{ $json.text }}"}' },
      { key: 'allow', label: 'อนุญาตให้ทำงานนี้ (write/delete)', type: 'boolean', description: 'ต้องเปิดสำหรับ operation ที่เปลี่ยนข้อมูล เว้นแต่ permission ของ tool เป็น allow' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'trigger_connector',
    label: 'ทริกเกอร์: Connector',
    description: 'เริ่ม workflow จาก webhook หรือ poll ของ connector ที่ติดตั้งไว้',
    fields: [
      { key: 'connector', label: 'service', type: 'string', required: true, placeholder: 'slack' },
      { key: 'trigger', label: 'trigger', type: 'string', required: true, placeholder: 'events' },
      { key: 'account', label: 'connection (ไม่ระบุ = connection เริ่มต้น)', type: 'string' },
      { key: 'input', label: 'input (JSON + expression)', type: 'json', placeholder: '{"channel": "C123"}' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'filter',
    label: 'filter',
    description: 'เก็บเฉพาะ item ที่ผ่านเงื่อนไข (หลายข้อ และ/หรือ)',
    fields: [
      { key: 'combinator', label: 'รวมเงื่อนไขแบบ', type: 'string', options: ['and', 'or'] },
      {
        key: 'conditions',
        label: 'เงื่อนไข',
        type: 'json',
        required: true,
        placeholder: '[{"left":"{{ $json.text }}","operator":"not_contains","right":"spam"}]',
        description: 'แต่ละแถวคือหนึ่งเงื่อนไข · item ที่ผ่านทุกเงื่อนไข (หรือข้อใดข้อหนึ่งเมื่อเลือก or) จะไหลต่อไป',
      },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'sort',
    label: 'sort',
    description: 'เรียง item ตามค่า (expression หรือชื่อ field)',
    fields: [
      { key: 'field', label: 'ค่า/field ที่ใช้เรียง', type: 'expression', placeholder: '{{ $json.amount }} หรือ amount' },
      { key: 'direction', label: 'ทิศทาง', type: 'string', options: ['asc', 'desc'] },
      { key: 'type', label: 'ชนิดข้อมูล', type: 'string', options: ['auto', 'number', 'string', 'date'] },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'limit',
    label: 'limit',
    description: 'จำกัดจำนวน item (เก็บตัวแรกหรือตัวท้าย)',
    fields: [
      { key: 'max', label: 'จำนวนสูงสุด', type: 'number', required: true, placeholder: '10' },
      { key: 'keep', label: 'เก็บ', type: 'string', options: ['first', 'last'] },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'aggregate',
    label: 'aggregate (รวม item)',
    description: 'รวมหลาย item เป็นหนึ่ง: collect/count/sum/average/min/max/join',
    fields: [
      { key: 'mode', label: 'โหมด', type: 'string', options: ['collect', 'count', 'sum', 'average', 'min', 'max', 'join'] },
      { key: 'field', label: 'ค่า (expression) — sum/average/min/max/join', type: 'expression', placeholder: '{{ $json.amount }}' },
      { key: 'name', label: 'ชื่อ field ผลลัพธ์', type: 'string', placeholder: 'value' },
      { key: 'separator', label: 'ตัวคั่น (join)', type: 'string', placeholder: '\\n' },
      { key: 'fields', label: 'field ที่จะ collect (JSON array; ว่าง = ทุก field)', type: 'json', placeholder: '["Subject", "From"]' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'remove_duplicates',
    label: 'remove duplicates',
    description: 'ตัด item ซ้ำตาม field ที่เลือก',
    fields: [
      { key: 'fields', label: 'field ที่ใช้เทียบ (JSON array; ว่าง = ทั้ง item)', type: 'json', placeholder: '["Id"]' },
      { key: 'keep', label: 'เก็บตัวไหน', type: 'string', options: ['first', 'last'] },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'merge',
    label: 'merge (รวมสาย)',
    description: 'รวม item จากหลายสายที่ไหลเข้ามา: ต่อกัน (append) / จับคู่ตามลำดับ (combine) / จับคู่ตาม key',
    fields: [
      { key: 'mode', label: 'โหมด', type: 'string', options: ['append', 'combine', 'by_key'] },
      { key: 'key', label: 'field ที่ใช้จับคู่ — โหมด by_key', type: 'string', placeholder: 'Id' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'wait',
    label: 'wait (หน่วงเวลา)',
    description: 'รอตามเวลาหรือรอถึงเวลาที่กำหนดก่อนไปต่อ · เกิน 1 นาที run จะถูกพักเก็บไว้แล้วปลุกเมื่อถึงเวลา (สูงสุด 30 วัน แม้ปิดแอประหว่างนั้น)',
    fields: [
      { key: 'mode', label: 'แบบ', type: 'string', options: ['duration', 'until'] },
      { key: 'amount', label: 'จำนวน (โหมด duration)', type: 'number', placeholder: '1' },
      { key: 'unit', label: 'หน่วย (โหมด duration)', type: 'string', options: ['seconds', 'minutes', 'hours', 'days'] },
      { key: 'until', label: 'รอถึงวันที่ / เวลา (โหมด until)', type: 'expression', placeholder: '{{ $json.due }} หรือ 2026-10-31 09:00' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'stop',
    label: 'หยุด workflow',
    description: 'จบ workflow ที่ node นี้ทันที: success = จบแบบสำเร็จ, error = ทำให้ run ล้มเหลวพร้อมข้อความ',
    fields: [
      { key: 'mode', label: 'แบบ', type: 'string', options: ['success', 'error'] },
      { key: 'message', label: 'ข้อความ (error / หมายเหตุ)', type: 'text', placeholder: 'หยุดเพราะไม่พบข้อมูลที่ต้องใช้' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'workflow',
    label: 'เรียก workflow',
    description: 'รัน workflow อื่นของ agent เดียวกัน แล้วส่งผลลัพธ์ออกมาเป็น items',
    fields: [
      { key: 'workflow', label: 'workflow (ของ agent นี้)', type: 'string', required: true },
      { key: 'input', label: 'input (JSON + expression; ว่าง = ส่ง items ที่ไหลเข้ามา)', type: 'json', placeholder: '{"n": "{{ $json.n }}"}' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'respond',
    label: 'respond (ตอบกลับ webhook)',
    description: 'กำหนดคำตอบ HTTP ของ webhook นี้: status / headers / body แล้วส่ง items ต่อไปตามปกติ',
    fields: [
      { key: 'status', label: 'HTTP status', type: 'number', placeholder: '200' },
      { key: 'headers', label: 'headers (JSON)', type: 'json', placeholder: '{"x-source": "mimi"}' },
      { key: 'body', label: 'body (JSON + expression; ว่าง = ส่ง items ที่ไหลเข้ามา)', type: 'json', placeholder: '{"received": true, "subject": "{{ $json.Subject }}"}' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'llm',
    label: 'LLM (เรียก model ตรง)',
    description: 'ส่ง prompt ให้ model ตรง ๆ ทีละ item (ไม่ผ่าน agent ไม่มี tool) เร็วและถูกกว่า; ผลอยู่ใน field ที่ตั้งชื่อไว้',
    fields: [
      { key: 'model', label: 'model', type: 'string' },
      { key: 'system', label: 'system prompt', type: 'text', placeholder: 'คุณเป็นผู้ช่วยสรุปอีเมลภาษาไทย ตอบสั้น ๆ' },
      { key: 'prompt', label: 'prompt', type: 'text', required: true, placeholder: 'สรุปเมลนี้ใน 1 บรรทัด:\n{{ $json.Subject }}\n{{ $json.Content }}' },
      { key: 'format', label: 'รูปแบบคำตอบ', type: 'string', options: ['text', 'json'] },
      { key: 'name', label: 'ชื่อ field ผลลัพธ์', type: 'string', placeholder: 'text' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'classify',
    label: 'Classifier (จัดหมวด)',
    description: 'ให้ model เลือกหมวดของแต่ละ item แล้วแยกทางตามหมวด; ชื่อหมวดถูกเก็บใน field "category"',
    fields: [
      { key: 'model', label: 'model', type: 'string' },
      { key: 'input', label: 'ข้อความที่จะจัดหมวด', type: 'expression', required: true, placeholder: '{{ $json.Subject }} {{ $json.Content }}' },
      { key: 'categories', label: 'หมวด', type: 'json', required: true },
      { key: 'instruction', label: 'คำแนะนำเพิ่ม', type: 'text', placeholder: 'เช่น ถ้าเป็นโฆษณาให้ถือเป็น "สแปม"' },
    ],
    outputs: [
      { key: 'cat0', label: 'หมวด 1' },
      { key: 'fallback', label: 'ไม่เข้าหมวดไหน' },
    ],
  },
  {
    type: 'extract',
    label: 'Extractor (ดึงข้อมูลเป็นโครงสร้าง)',
    description: 'ให้ model ดึง field ที่กำหนดออกจากข้อความ (ชื่อ / ชนิด / คำอธิบาย) ได้ JSON ที่ชนิดถูกต้อง',
    fields: [
      { key: 'model', label: 'model', type: 'string' },
      { key: 'input', label: 'ข้อความต้นทาง', type: 'expression', required: true, placeholder: '{{ $json.Content }}' },
      { key: 'attributes', label: 'field ที่ต้องการ', type: 'json', required: true },
      { key: 'instruction', label: 'คำแนะนำเพิ่ม', type: 'text', placeholder: 'เช่น จำนวนเงินเป็นบาท ไม่มีจุลภาค' },
      { key: 'target', label: 'เก็บไว้ใน field (เว้นว่าง = รวมเข้า item ตรง ๆ)', type: 'string', placeholder: 'output' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'split_out',
    label: 'Split Out (แตก array เป็นหลาย item)',
    description: 'เอา array ใน field หนึ่งมาแตกเป็น item ละตัว เช่น รายการสินค้าในใบเสร็จ → item ละรายการ',
    fields: [
      { key: 'field', label: 'field ที่เป็น array', type: 'expression', required: true, placeholder: 'lines หรือ {{ $json.data.lines }}' },
      { key: 'include', label: 'field อื่นของ item เดิม', type: 'string', options: ['none', 'all'] },
      { key: 'name', label: 'ชื่อ field เมื่อค่าไม่ใช่ object', type: 'string', placeholder: 'value' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'loop',
    label: 'Loop (วนรัน workflow ทีละชุด)',
    description: 'แบ่ง item เป็นชุดละ N แล้วรัน workflow ย่อยของ agent นี้กับแต่ละชุด; ผลทุกชุดต่อกันเป็น output',
    fields: [
      { key: 'workflow', label: 'workflow ที่จะวนรัน (ของ agent นี้)', type: 'string', required: true },
      { key: 'batchSize', label: 'ขนาดชุด (item ต่อรอบ)', type: 'number', placeholder: '1' },
      { key: 'parallel', label: 'รันพร้อมกันได้ (รอบ, สูงสุด 5)', type: 'number', placeholder: '1' },
      { key: 'onItemError', label: 'ถ้ารอบไหนล้ม', type: 'string', options: ['stop', 'skip'] },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'approval',
    label: 'รออนุมัติ (ถามในแชต)',
    description: 'หยุดรอให้คุณกด "อนุมัติ" / "ไม่อนุมัติ" ในแชตของ agent แล้วไปต่อตามคำตอบ; ถ้าเกินเวลาจะไปทาง "หมดเวลา" · run ถูกพักเก็บไว้ ปิด/เปิดแอปก็ยังตอบได้',
    fields: [
      { key: 'agent', label: 'ถามในแชตของ (เว้นว่าง = เจ้าของ workflow)', type: 'string' },
      { key: 'message', label: 'ข้อความที่ถาม', type: 'text', required: true, placeholder: 'อนุมัติจ่าย {{ $json.amount }} บาท ให้ {{ $json.vendor }} ไหม?' },
      { key: 'timeoutMinutes', label: 'รอได้นานสุด (นาที, สูงสุด 43200 = 30 วัน)', type: 'number', placeholder: '60' },
    ],
    outputs: [
      { key: 'approved', label: 'อนุมัติ' },
      { key: 'rejected', label: 'ไม่อนุมัติ' },
      { key: 'timeout', label: 'หมดเวลา' },
    ],
  },
  {
    type: 'telegram',
    label: 'ส่ง Telegram',
    description: 'ส่งข้อความผ่าน Telegram bot (token เก็บในตู้ secret ของแอป) ทีละ item',
    fields: [
      { key: 'tokenSecret', label: 'ชื่อ secret ที่เก็บ bot token', type: 'string', placeholder: 'TELEGRAM_BOT_TOKEN' },
      { key: 'chatId', label: 'chat id ปลายทาง', type: 'expression', required: true, placeholder: '{{ $json.chatId }}' },
      { key: 'text', label: 'ข้อความ', type: 'text', required: true, placeholder: 'รับทราบ: {{ $json.text }}' },
      { key: 'parseMode', label: 'รูปแบบข้อความ', type: 'string', options: ['plain', 'Markdown', 'HTML'] },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'datetime',
    label: 'วันที่ / เวลา',
    description: 'จัดรูปแบบ / บวกลบ / หาต้นวัน-สัปดาห์-เดือน / หาระยะห่าง ของวันที่ ตามเขตเวลา · รูปแบบ: th, th-full, th-time, date, datetime, iso หรือเขียนเอง เช่น D MMM BBBB HH:mm',
    fields: [
      { key: 'operation', label: 'ทำอะไร', type: 'string', options: ['format', 'add', 'subtract', 'start_of', 'diff'] },
      { key: 'value', label: 'วันที่ (ว่าง = ตอนนี้)', type: 'expression', placeholder: '{{ $json.Date }}' },
      { key: 'amount', label: 'จำนวน (add / subtract)', type: 'number', placeholder: '1' },
      { key: 'unit', label: 'หน่วย', type: 'string', options: ['days', 'hours', 'minutes', 'seconds', 'weeks', 'months', 'years'] },
      { key: 'other', label: 'วันที่ปลายทาง (diff: ปลายทาง − วันที่)', type: 'expression', placeholder: '{{ $json.due }}' },
      { key: 'format', label: 'รูปแบบผลลัพธ์', type: 'string', placeholder: 'th  (ว่าง = iso)' },
      { key: 'timezone', label: 'เขตเวลา (ว่าง = ของเครื่อง)', type: 'string', placeholder: 'Asia/Bangkok' },
      { key: 'name', label: 'ชื่อ field ผลลัพธ์', type: 'string', placeholder: 'date' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'file',
    label: 'ไฟล์ (อ่าน / เขียน / คัดลอก / ลบ)',
    description: 'อ่าน เขียน ต่อท้าย ดูรายชื่อ คัดลอก ย้าย ลบ หรือดูข้อมูลไฟล์ ในโฟลเดอร์ที่อนุญาตเท่านั้น (path สั้น ๆ = นับจากโฟลเดอร์แรก)',
    fields: [
      { key: 'operation', label: 'ทำอะไร', type: 'string', options: ['read', 'write', 'append', 'list', 'copy', 'move', 'delete', 'stat'] },
      { key: 'path', label: 'path ของไฟล์ / โฟลเดอร์', type: 'expression', required: true, placeholder: 'notes/{{ $today }}.md' },
      { key: 'destination', label: 'path ปลายทาง (copy / move)', type: 'expression', placeholder: 'backup/{{ $today }}.md' },
      { key: 'overwrite', label: 'เขียนทับถ้าปลายทางมีอยู่แล้ว (copy / move)', type: 'boolean' },
      { key: 'recursive', label: 'ลบทั้งโฟลเดอร์ (delete)', type: 'boolean', description: 'ถ้าไม่ติ๊ก จะลบได้เฉพาะไฟล์' },
      { key: 'format', label: 'อ่านเป็น (read)', type: 'string', options: ['text', 'json', 'csv', 'lines'] },
      { key: 'source', label: 'เขียนอะไร (write)', type: 'string', options: ['content', 'items_json', 'items_csv'] },
      { key: 'content', label: 'เนื้อหา (write / append)', type: 'text', placeholder: '- {{ $json.rest }}' },
      { key: 'pattern', label: 'กรองชื่อไฟล์ (list)', type: 'string', placeholder: '*.pdf' },
      { key: 'name', label: 'ชื่อ field ของเนื้อหา (read แบบ text)', type: 'string', placeholder: 'content' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'extract_file',
    label: 'ดึงข้อมูลจากไฟล์',
    description: 'CSV / JSON / Excel (.xlsx) → items · ข้อความ / HTML → text · PDF / รูป / วิดีโอ → ให้ vision model อ่าน · เสียง → ถอดเสียง · ใช้ได้ทั้งไฟล์ในโฟลเดอร์และไฟล์ที่ส่งมาในแชต',
    fields: [
      { key: 'path', label: 'path ของไฟล์', type: 'expression', placeholder: '{{ $json.path }}' },
      { key: 'attachment', label: 'หรือ ไฟล์จากแชต (id)', type: 'expression', placeholder: '{{ $json.files[0].id }}' },
      { key: 'type', label: 'ชนิดไฟล์', type: 'string', options: ['auto', 'csv', 'xlsx', 'json', 'text', 'html', 'pdf', 'image', 'audio', 'video'] },
      { key: 'sheet', label: 'ชื่อชีต (Excel; ว่าง = ชีตแรก)', type: 'string', placeholder: 'Sheet1' },
      { key: 'header', label: 'แถวแรกของ CSV', type: 'string', options: ['header', 'data'] },
      { key: 'instruction', label: 'บอก model ว่าให้อ่านอะไร (PDF / รูป / วิดีโอ)', type: 'text', placeholder: 'เช่น อ่านใบเสร็จ: ร้าน วันที่ รายการ ยอดรวม' },
      { key: 'name', label: 'ชื่อ field ของข้อความ', type: 'string', placeholder: 'text' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'knowledge',
    label: 'คลังความรู้ (ค้น / เพิ่ม)',
    description: 'search = ค้นคลังความรู้ด้วยคำถาม แล้วได้ context ไปใส่ prompt ของ LLM / agent · add = เก็บข้อความของ item เข้าคลัง (แหล่งเดิมจะถูกแทนที่)',
    fields: [
      { key: 'operation', label: 'ทำอะไร', type: 'string', options: ['search', 'add'] },
      { key: 'collection', label: 'คลัง (search: เว้นว่าง = ทุกคลัง)', type: 'string' },
      { key: 'query', label: 'คำค้น (search)', type: 'expression', placeholder: '{{ $json.text }}' },
      { key: 'limit', label: 'จำนวนผล (search)', type: 'number', placeholder: '5' },
      { key: 'output', label: 'ผลลัพธ์ (search)', type: 'string', options: ['context', 'items'] },
      { key: 'text', label: 'ข้อความที่จะเก็บ (add)', type: 'expression', placeholder: '{{ $json.text }}' },
      { key: 'title', label: 'ชื่อเอกสาร (add)', type: 'expression', placeholder: '{{ $json.Subject }}' },
      { key: 'source', label: 'แหล่งที่มา (add; ซ้ำ = แทนที่ของเดิม)', type: 'expression', placeholder: 'mail:{{ $json.Id }}' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'sheets',
    label: 'Google Sheets',
    description:
      'อ่าน/เขียน Google Sheets โดยตรง: เลือกบัญชีและไฟล์ แล้วใส่ช่วง (range) กับค่าที่จะเขียน · ไม่ต้องสร้าง tool preset ก่อน',
    fields: [
      { key: 'account', label: 'บัญชี Google (เว้นว่าง = บัญชีเริ่มต้น)', type: 'account', service: 'google' },
      {
        key: 'spreadsheetId',
        label: 'สเปรดชีต (ID หรือ URL)',
        type: 'expression',
        required: true,
        placeholder: 'https://docs.google.com/spreadsheets/d/…',
      },
      { key: 'operation', label: 'ทำอะไร', type: 'string', options: ['info', 'read', 'append', 'update'] },
      { key: 'range', label: 'ช่วง (range)', type: 'expression', placeholder: 'Sheet1!A1:D20', description: 'read/append/update' },
      { key: 'values', label: 'ค่าที่จะเขียน (JSON rows)', type: 'json', placeholder: '[["มกราคม", 1200]]', description: 'append/update' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'plugin',
    label: 'Custom node (plugin)',
    description:
      'node ที่ AI Overseer หรือผู้ใช้สร้างเอง เก็บไว้ในโฟลเดอร์ user/nodes · รันโค้ดใน sandbox แยก process เห็น items และ $config แล้ว return items ใหม่',
    fields: [
      { key: 'plugin', label: 'plugin', type: 'string', required: true, placeholder: 'ชื่อ plugin', description: 'รายการมาจาก user/nodes · Overseer สร้างให้ได้ด้วย node_save' },
      { key: 'config', label: 'config (JSON + expression)', type: 'json', placeholder: '{"key": "{{ $json.Subject }}"}' },
    ],
    outputs: [{ key: 'main', label: 'main' }],
  },
  {
    type: 'trigger_custom',
    label: 'ทริกเกอร์จาก pool',
    description: 'จุดเริ่มของ workflow จาก trigger ที่ผู้ใช้สร้างเองใน Hub → Trigger · เลือก trigger แล้วกรอกค่าตามที่ trigger นั้นกำหนด',
    fields: [{ key: 'pool', label: 'trigger จาก pool', type: 'string', required: true }],
    outputs: [{ key: 'main', label: 'main' }],
  },
];

export interface TriggerPoolView {
  name: string;
  label: string;
  description: string;
  kind: 'manual' | 'schedule' | 'webhook' | 'mail' | 'poll' | 'chat' | 'telegram' | 'tool';
  builtin: boolean;
  fields: NodeTypeField[];
  /** Example of the JSON this trigger produces; shown in the editor. */
  sample: Record<string, JsonValue>;
}

/** Trigger nodes are real nodes on the canvas; each one maps to a trigger-pool entry. */
export const TRIGGER_NODE_POOLS: Partial<Record<NodeTypeName, string>> = {
  trigger_manual: 'manual',
  trigger_schedule: 'schedule',
  trigger_webhook: 'webhook',
  trigger_form: 'form',
  trigger_mail: 'mail',
  trigger_poll: 'poll',
  trigger_chat: 'chat',
  trigger_telegram: 'telegram',
  trigger_tool: 'agent_tool',
};

export function isTriggerNodeType(type: string): boolean {
  return type === 'trigger_custom' || type === 'trigger_connector' || Object.hasOwn(TRIGGER_NODE_POOLS, type);
}

export function triggerPoolOfNode(type: string): string | undefined {
  return isTriggerNodeType(type) ? TRIGGER_NODE_POOLS[type as NodeTypeName] : undefined;
}

/** The pool a trigger node points at; `trigger_custom` keeps the name in its config. */
export function triggerPoolOfNodeConfig(node: { type: string; config: WorkflowNode['config'] }): string | undefined {
  if (node.type === 'trigger_custom') {
    const name = node.config.pool;
    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
  }
  if (node.type === 'trigger_connector') {
    const connector = node.config.connector;
    const trigger = node.config.trigger;
    if (typeof connector !== 'string' || !connector.trim()) return undefined;
    if (typeof trigger !== 'string' || !trigger.trim()) return undefined;
    return `connector:${connector.trim()}:${trigger.trim()}`;
  }
  return triggerPoolOfNode(node.type);
}

/** The one trigger node of a workflow (the editor keeps exactly one). */
export function triggerNodeOf(nodes: readonly WorkflowNode[]): WorkflowNode | undefined {
  return nodes.find((node) => isTriggerNodeType(node.type));
}

export const BUILTIN_TRIGGERS: TriggerPoolView[] = [
  {
    name: 'manual',
    label: 'กดรันเอง',
    description: 'รันจากปุ่ม Run พร้อม input JSON ที่พิมพ์เอง',
    kind: 'manual',
    builtin: true,
    fields: [],
    sample: { From: 'somchai@example.com', To: 'me@example.com', Date: '2026-10-13', Subject: 'ใบแจ้งหนี้', Content: 'กรุณาชำระภายในสิ้นเดือน' },
  },
  {
    name: 'schedule',
    label: 'ตามเวลา (cron)',
    description: 'รันตาม cron ในเขตเวลาของเครื่อง',
    kind: 'schedule',
    builtin: true,
    fields: [{ key: 'cron', label: 'cron', type: 'string', required: true, placeholder: '0 8 * * *' }],
    sample: { timestamp: '2026-10-13T08:00:00.000Z' },
  },
  {
    name: 'webhook',
    label: 'Webhook',
    description: 'บริการอื่น POST เข้ามา; body กลายเป็น items',
    kind: 'webhook',
    builtin: true,
    fields: [{ key: 'secret', label: 'รหัสลับ (ไม่บังคับ) — ผู้เรียกต้องส่ง header x-mimi-secret ให้ตรง', type: 'string', placeholder: 'ตั้งเองยาว ๆ' }],
    sample: { event: 'order.created', orderId: 42 },
  },
  {
    name: 'form',
    label: 'ฟอร์ม / HTML form',
    description: 'รับค่าจาก HTML form (application/x-www-form-urlencoded) หรือ GET query; ทุกค่าในฟอร์มกลายเป็น item เดียว',
    kind: 'webhook',
    builtin: true,
    fields: [{ key: 'secret', label: 'secret (ไม่บังคับ) - ส่งมาทาง ?secret= หรือ header x-mimi-secret', type: 'string', placeholder: 'ปล่อยว่างได้' }],
    sample: { name: 'สมชาย', email: 'somchai@example.com', message: 'สวัสดี' },
  },
  {
    name: 'mail',
    label: 'อีเมลใหม่ (Gmail / Outlook / IMAP / POP3)',
    description: 'เช็คอีเมลใหม่เป็นรอบ แล้วรันทีละฉบับ · IMAP/POP3 ใช้บัญชีที่ตั้งไว้ที่ Hub → Mail',
    kind: 'mail',
    builtin: true,
    fields: [
      { key: 'source', label: 'แหล่งเมล', type: 'string', options: ['google', 'microsoft', 'imap', 'pop3'], required: true },
      { key: 'account', label: 'บัญชี (เว้นว่าง = บัญชีเริ่มต้นของแหล่งนั้น)', type: 'account' },
      { key: 'query', label: 'ค้นหา (Gmail query / IMAP criteria / คำในเมล)', type: 'string', placeholder: 'เว้นว่าง = is:unread / unseen' },
      { key: 'folder', label: 'โฟลเดอร์ IMAP (เว้นว่าง = INBOX)', type: 'string', placeholder: 'INBOX' },
      { key: 'unseenOnly', label: 'เอาเฉพาะที่ยังไม่เปิดอ่าน', type: 'boolean' },
      { key: 'sinceDays', label: 'ย้อนหลังกี่วัน (0 = ไม่จำกัด)', type: 'number', placeholder: '7' },
      { key: 'maxMessages', label: 'จำนวนสูงสุดต่อรอบ (1-100)', type: 'number', placeholder: '10' },
      { key: 'everyMinutes', label: 'เช็คทุก (นาที)', type: 'number', placeholder: '15' },
      { key: 'markRead', label: 'มาร์คอ่านแล้วหลังประมวลผล', type: 'boolean' },
    ],
    sample: { Id: '18c...', From: 'somchai@example.com', To: 'me@example.com', Cc: '', Date: '2026-10-13', Subject: 'ใบแจ้งหนี้', Content: 'กรุณาชำระภายในสิ้นเดือน', Folder: 'INBOX', Seen: false },
  },
  {
    name: 'poll',
    label: 'HTTP poll',
    description: 'เรียก URL เป็นรอบ; JSON ที่ได้กลายเป็น items',
    kind: 'poll',
    builtin: true,
    fields: [
      { key: 'url', label: 'URL', type: 'string', required: true },
      { key: 'method', label: 'method', type: 'string', placeholder: 'GET' },
      { key: 'headers', label: 'headers (JSON)', type: 'json' },
      { key: 'everyMinutes', label: 'เช็คทุก (นาที)', type: 'number', placeholder: '15' },
      { key: 'allowLocal', label: 'อนุญาตเรียกเครือข่ายภายใน', type: 'boolean' },
    ],
    sample: { value: 42 },
  },
  {
    name: 'chat',
    label: 'ข้อความในแชต',
    description: 'รันเมื่อคุณพิมพ์ในแชตตรงกับ agent เจ้าของ workflow และข้อความตรงเงื่อนไข (เช่น ขึ้นต้นด้วย /จด)',
    kind: 'chat',
    builtin: true,
    fields: [
      { key: 'match', label: 'เงื่อนไข', type: 'string', options: ['starts_with', 'contains', 'regex', 'any'] },
      { key: 'pattern', label: 'คำ / pattern', type: 'string', placeholder: '/จด' },
      { key: 'reply', label: 'agent ยังตอบไหม', type: 'string', options: ['workflow_only', 'agent_also'] },
      { key: 'files', label: 'ไฟล์แนบ', type: 'string', options: ['any', 'none', 'some', 'image', 'audio', 'video', 'file'] },
      { key: 'read_files', label: 'อ่านไฟล์ให้ก่อน (บรรยายรูป/วิดีโอ, ถอดเสียง, ดึงข้อความ)', type: 'string', options: ['yes', 'no'] },
    ],
    sample: {
      text: '/จด ซื้อนม 2 ขวด',
      rest: 'ซื้อนม 2 ขวด',
      chatId: 1,
      agent: 'mimi',
      files: [{ id: '00000000-0000-0000-0000-000000000000', kind: 'image', name: 'receipt.jpg', mime: 'image/jpeg', size: 182044, text: 'ใบเสร็จร้าน ... ยอดรวม 125 บาท' }],
    },
  },
  {
    name: 'telegram',
    label: 'Telegram (ข้อความเข้า bot)',
    description: 'ดึงข้อความที่ส่งเข้า Telegram bot (long polling) แล้วรันทีละข้อความ · ใส่ chat id ที่อนุญาตไว้ด้วย ไม่งั้นใครทักบอทก็สั่งได้ · ถ้าบอทยังผูก webhook กับ n8n อยู่ จะดึงไม่ได้',
    kind: 'telegram',
    builtin: true,
    fields: [
      { key: 'tokenSecret', label: 'ชื่อ secret ที่เก็บ bot token', type: 'string', placeholder: 'TELEGRAM_BOT_TOKEN' },
      { key: 'chatIds', label: 'chat id ที่อนุญาต (คั่นด้วย , ; ว่าง = ทุกคน)', type: 'string', placeholder: '123456789' },
      { key: 'match', label: 'เงื่อนไข', type: 'string', options: ['any', 'starts_with', 'contains', 'regex'] },
      { key: 'pattern', label: 'คำ / pattern', type: 'string', placeholder: '/start' },
    ],
    sample: { text: 'สวัสดี', rest: 'สวัสดี', chatId: 123456789, messageId: 10, from: { id: 123456789, username: 'me', firstName: 'Me' }, date: '2026-10-18T09:00:00.000Z' },
  },
  {
    name: 'agent_tool',
    label: 'agent เรียกใช้ (เป็นเครื่องมือ)',
    description:
      'agent เจ้าของ workflow (และ agent ที่ระบุ) เห็น workflow นี้เป็นเครื่องมือชื่อ workflow_<ชื่อ> แล้วเลือกเรียกเองเมื่อเหมาะ โดยดูจาก "ใช้เมื่อไหร่" · ค่าที่ agent ส่งมาอยู่ใน {{ $json.<ชื่อ> }} · ผลที่ agent ได้กลับ = body ของ node "ตอบกลับ" ถ้ามี ไม่งั้นเป็น output ของ node สุดท้าย',
    kind: 'tool',
    builtin: true,
    fields: [
      {
        key: 'when',
        label: 'ใช้เมื่อไหร่ / ทำอะไร (agent อ่านช่องนี้เพื่อตัดสินใจ)',
        type: 'text',
        required: true,
        placeholder: 'บันทึกรายจ่ายลงชีตบัญชี ใช้เมื่อผู้ใช้บอกว่าจ่ายเงินซื้ออะไร',
      },
      {
        key: 'inputs',
        label: 'ค่าที่ agent ต้องส่งมา (บรรทัดละช่อง: ชื่อ: คำอธิบาย · ชื่อ? = ไม่บังคับ · ชื่อ (number) = ตัวเลข)',
        type: 'text',
        placeholder: 'item: ซื้ออะไร\namount (number): กี่บาท\nnote?: หมายเหตุ',
      },
      { key: 'agents', label: 'agent อื่นที่เรียกได้ (คั่นด้วย , ; เจ้าของเรียกได้เสมอ)', type: 'string', placeholder: 'tim, karen' },
      { key: 'ask', label: 'ถามคุณก่อนรันไหม', type: 'string', options: ['ask', 'no'] },
    ],
    sample: { item: 'กาแฟ', amount: 65, note: '', agent: 'mimi' },
  },
];

const TRIGGER_NODE_LABELS: Partial<Record<NodeTypeName, string>> = {
  trigger_manual: 'ทริกเกอร์: กดรันเอง',
  trigger_schedule: 'ทริกเกอร์: ตามเวลา (cron)',
  trigger_webhook: 'ทริกเกอร์: Webhook',
  trigger_form: 'ทริกเกอร์: ฟอร์ม / HTML form',
  trigger_mail: 'ทริกเกอร์: อีเมลใหม่',
  trigger_poll: 'ทริกเกอร์: HTTP poll',
  trigger_chat: 'ทริกเกอร์: ข้อความในแชต',
  trigger_telegram: 'ทริกเกอร์: Telegram',
  trigger_tool: 'ทริกเกอร์: agent เรียกใช้',
};

for (const [type, pool] of Object.entries(TRIGGER_NODE_POOLS)) {
  const entry = BUILTIN_TRIGGERS.find((trigger) => trigger.name === pool);
  if (!entry) continue;
  NODE_TYPES.push({
    type: type as NodeTypeName,
    label: TRIGGER_NODE_LABELS[type as NodeTypeName] ?? entry.label,
    description: `จุดเริ่มของ workflow · ${entry.description}`,
    fields: entry.fields,
    outputs: [{ key: 'main', label: 'main' }],
    triggerPool: entry.name,
  });
}
