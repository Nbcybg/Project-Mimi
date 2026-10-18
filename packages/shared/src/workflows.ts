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
  | 'filter'
  | 'sort'
  | 'limit'
  | 'aggregate'
  | 'remove_duplicates'
  | 'merge'
  | 'wait'
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
  | 'knowledge';

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
  type: 'string' | 'number' | 'boolean' | 'text' | 'json' | 'expression';
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
    description: 'ส่งข้อความเข้าแชตของ agent (ค่าเริ่มต้น = agent เจ้าของ workflow)',
    fields: [
      { key: 'agent', label: 'agent ปลายทาง (เว้นว่าง = เจ้าของ workflow)', type: 'string' },
      { key: 'text', label: 'ข้อความ', type: 'text', required: true, placeholder: '📬 {{ $json.Subject }} — {{ $json.text }}' },
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
      { key: 'mode', label: 'โหมด', type: 'string', options: ['value', 'rules'] },
      { key: 'value', label: 'ค่า (expression) — โหมด value', type: 'expression', placeholder: '{{ $json.Subject }}' },
      {
        key: 'cases',
        label: 'กรณี (JSON array)',
        type: 'json',
        placeholder: '["urgent","invoice"] หรือ [{"left":"{{ $json.n }}","operator":"gt","right":10}]',
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
      { key: 'input', label: 'input (JSON + expression)', type: 'json', placeholder: '{"range": "A1", "values": [["{{ $json.Subject }}"]]}' },
      { key: 'allow', label: 'อนุญาตให้ทำงานนี้ (เครื่องมือที่ส่ง / แก้ / ลบข้อมูล ต้องติ๊ก เพราะ workflow รันเองโดยไม่มีใครกดยืนยัน)', type: 'boolean' },
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
    description: 'รอตามเวลาก่อนไปต่อ · เกิน 1 นาที run จะถูกพักเก็บไว้แล้วปลุกเมื่อถึงเวลา (สูงสุด 30 วัน แม้ปิดแอประหว่างนั้น)',
    fields: [
      { key: 'amount', label: 'จำนวน', type: 'number', required: true, placeholder: '1' },
      { key: 'unit', label: 'หน่วย', type: 'string', options: ['seconds', 'minutes', 'hours', 'days'] },
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
    label: 'ไฟล์ (อ่าน / เขียน)',
    description: 'อ่าน เขียน ต่อท้าย หรือดูรายชื่อไฟล์ ในโฟลเดอร์ที่อนุญาตเท่านั้น (path สั้น ๆ = นับจากโฟลเดอร์แรก)',
    fields: [
      { key: 'operation', label: 'ทำอะไร', type: 'string', options: ['read', 'write', 'append', 'list'] },
      { key: 'path', label: 'path ของไฟล์ / โฟลเดอร์', type: 'expression', required: true, placeholder: 'notes/{{ $today }}.md' },
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
    description: 'CSV / JSON / Excel (.xlsx) → items · ข้อความ / HTML → text · PDF / รูป → ให้ vision model อ่าน (OCR) · เสียง → ถอดเสียง',
    fields: [
      { key: 'path', label: 'path ของไฟล์', type: 'expression', required: true, placeholder: '{{ $json.path }}' },
      { key: 'type', label: 'ชนิดไฟล์', type: 'string', options: ['auto', 'csv', 'xlsx', 'json', 'text', 'html', 'pdf', 'image', 'audio'] },
      { key: 'sheet', label: 'ชื่อชีต (Excel; ว่าง = ชีตแรก)', type: 'string', placeholder: 'Sheet1' },
      { key: 'header', label: 'แถวแรกของ CSV', type: 'string', options: ['header', 'data'] },
      { key: 'instruction', label: 'บอก model ว่าให้อ่านอะไร (PDF / รูป)', type: 'text', placeholder: 'เช่น อ่านใบเสร็จ: ร้าน วันที่ รายการ ยอดรวม' },
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
];

export interface TriggerPoolView {
  name: string;
  label: string;
  description: string;
  kind: 'manual' | 'schedule' | 'webhook' | 'mail' | 'poll' | 'chat' | 'telegram';
  builtin: boolean;
  fields: NodeTypeField[];
  /** Example of the JSON this trigger produces; shown in the editor. */
  sample: Record<string, JsonValue>;
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
    name: 'mail',
    label: 'อีเมลใหม่ (Gmail / Outlook)',
    description: 'เช็คอีเมลใหม่เป็นรอบ แล้วรันทีละฉบับ',
    kind: 'mail',
    builtin: true,
    fields: [
      { key: 'source', label: 'บัญชี', type: 'string', placeholder: 'google | microsoft' },
      { key: 'query', label: 'ค้นหา (Gmail query)', type: 'string', placeholder: 'เว้นว่าง = is:unread' },
      { key: 'everyMinutes', label: 'เช็คทุก (นาที)', type: 'number', placeholder: '15' },
      { key: 'markRead', label: 'มาร์คอ่านแล้ว', type: 'boolean' },
    ],
    sample: { Id: '18c...', From: 'somchai@example.com', To: 'me@example.com', Date: '2026-10-13', Subject: 'ใบแจ้งหนี้', Content: 'กรุณาชำระภายในสิ้นเดือน' },
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
    ],
    sample: { text: '/จด ซื้อนม 2 ขวด', rest: 'ซื้อนม 2 ขวด', chatId: 1, agent: 'mimi' },
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
];
