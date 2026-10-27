# Connector Contract — Phase 0 (frozen)

สถานะ: **frozen** · contract version **1** (`CONNECTOR_CONTRACT_VERSION`)
เจ้าของ: Agent `P0-CONTRACT`

เอกสารนี้อธิบายสัญญากลางระหว่าง connector spec, runtime, tool adapter, workflow node
และ UI ห้ามแก้ field ที่มีอยู่โดยไม่แจ้ง orchestrator และอัปเดต version

## 1. หลักการ

1. หนึ่ง service = หนึ่ง `ConnectorSpec`
2. หนึ่ง operation = หนึ่ง tool ชื่อ `<connector>_<operation>`
3. Connector spec เป็น **data ล้วน** — ห้ามมี `fetch`, secret หรือ side effect
4. Runtime กลางเป็นคนจัดการ auth, HTTP, timeout, error, normalization
5. Workflow ใช้ node type เดียวคือ `connector` ไม่เพิ่ม node ต่อ service
6. เพิ่ม service ใหม่ = เพิ่มไฟล์เดียวใน `packages/core/src/connectors/services/`

## 2. ไฟล์และ type

| ไฟล์ | type |
|---|---|
| `packages/shared/src/connectors.ts` | `ConnectorSpec`, `ConnectorAuth`, `ConnectorOperation`, `ConnectorField`, `ConnectorTrigger`, view/runtime types |
| `packages/shared/src/tools.ts` | `ToolSettingField`, `ToolSettingOption`, `ToolSettingOptionsFrom` |
| `packages/shared/src/protocol.ts` | `ToolView` metadata (`connector`, `operation`, `familyLabel`) |
| `packages/shared/src/workflows.ts` | `NodeTypeName` + `NODE_TYPES` entry `connector` |

`packages/shared/src/index.ts` export ทุกอย่างจาก `connectors.ts` แล้ว

## 3. `ConnectorSpec`

```ts
interface ConnectorSpec {
  key: string;          // lower_snake, prefix ของ tool
  label: string;
  category: string;
  description: string;
  baseUrl?: string;     // base ของ path ที่เป็น relative
  auth: ConnectorAuth;
  operations: ConnectorOperation[];
  triggers?: ConnectorTrigger[];
  pagination?: ConnectorPagination;
  rateLimit?: ConnectorRateLimit;
}
```

- `key` ต้องตรง `/^[a-z][a-z0-9_]*$/` และไม่ซ้ำกับ connector อื่น
- `baseUrl` เป็น optional เพื่อรองรับ operation ที่ใส่ absolute URL เอง
- ห้ามใส่ credential, token หรือ header ลับลงใน spec

## 4. `ConnectorField`

```ts
interface ConnectorField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'json' | 'secret' | 'select';
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  optionsFrom?: {
    connector: string;
    operation: string;
    labelField: string;
    valueField: string;
    dependsOn?: string[];
  };
  dependsOn?: string[];
}
```

- `secret` ใช้เฉพาะใน `ConnectorAuth.fields` หรือ field ที่ runtime รู้จักเท่านั้น
  ค่าจริงเก็บใน vault ไม่เคยอยู่ใน spec, workflow JSON, log หรือ error
- `optionsFrom` ใช้ดึงตัวเลือกจาก operation อื่น เช่น ช่อง Slack
  `{ connector: 'slack', operation: 'list_channels', labelField: 'name', valueField: 'id' }`
- `dependsOn` ระบุว่า field นี้ต้องรอ field อื่นก่อน (เช่น เลือก workspace ก่อนเลือก channel)

## 5. Auth

```ts
type ConnectorAuthKind = 'oauth2' | 'oauth1' | 'apiKey' | 'basic' | 'bearer' | 'none';

interface ConnectorAuth {
  kind: ConnectorAuthKind;
  fields: ConnectorField[];
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  extra?: Record<string, unknown>;
}
```

- `fields` เป็น schema ของ credential ที่ผู้ใช้กรอกหรือระบบเก็บ (ไม่ใช่ค่า)
- `apiKey` / `bearer` ใช้กับ bot token หรือ PAT ได้
- OAuth2 ต้องระบุ `authorizeUrl`, `tokenUrl`, `scopes` และ `extra` ตาม provider
  (เช่น `{ pkce: true }`, `authorizeParams`, `tokenParams`) — token refresh อยู่ใน runtime ไม่ใช่ spec
- OAuth2 connection ที่ไม่ใช่ Google ต้องประกาศ field `clientId`, `accessToken`,
  `refreshToken` และ `expiresAt` ตามที่ใช้; `clientSecret` เป็น optional สำหรับ public client
  และ flow จะเก็บ token ลง vault ให้หลัง callback
- ห้าม log ค่า token, refresh token, client secret

## 6. Operation

```ts
interface ConnectorOperation {
  key: string;
  label: string;
  description?: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;             // relative to baseUrl หรือ absolute
  body?: unknown;           // optional template; {{field}} is replaced from input
  bodyFormat?: 'json' | 'form'; // default json
  fields: ConnectorField[];
  risk: 'read' | 'write' | 'shell' | 'delete' | 'network';
  untrustedInput?: boolean;
  response?: { itemsPath?: string; binary?: boolean };
}
```

- `risk` ใช้ policy เดิมของ tool: `write`/`delete`/`network` ต้องขออนุญาต
- `untrustedInput: true` เมื่อผลมีข้อความจากบุคคลที่สาม — agent ที่ใช้ tool นี้
  ห้ามมี shell tool พร้อมกัน
- `response.itemsPath` เป็น dot path เช่น `messages` หรือ `data.items`;
  ไม่ระบุ = ใช้ body ทั้งก้อนเป็น item เดียว
- `body` ใช้เมื่อ API ต้องส่ง nested body หรือเลือกเฉพาะบาง field; placeholder
  `{{field}}` ต้องอ้าง field ที่ประกาศไว้ และถ้าเป็น placeholder ทั้งค่า จะคง type เดิม
- `bodyFormat: 'form'` เข้ารหัสเป็น `application/x-www-form-urlencoded` รองรับ
  nested object/array แบบ `line_items[0][price]` สำหรับ Stripe
- `auth.extra.headers` ใช้เพิ่ม header ที่ไม่ใช่ credential เช่น `Notion-Version`
- `auth.extra.provider: 'google'` บอก runtime ให้ใช้ Google OAuth account เดิม
- `response.binary: true` สำหรับไฟล์ดาวน์โหลด

## 7. Pagination และ rate limit

```ts
interface ConnectorPagination {
  mode: 'page' | 'cursor' | 'nextPageToken' | 'link';
  pageParam?: string;
  sizeParam?: string;
  cursorParam?: string;
  itemsPath?: string;
  nextPath?: string;
}

interface ConnectorRateLimit {
  requests: number;
  perMs: number;
  burst?: number;
}
```

Phase 0 runtime ยังไม่ต้องทำ pagination/rate limit เต็ม แต่ spec ต้องประกาศไว้
เพื่อให้ Phase 2 เปิดใช้ได้โดยไม่ต้องแก้ service files

## 8. Trigger

```ts
interface ConnectorTrigger {
  key: string;
  label: string;
  kind: 'webhook' | 'poll';
  events?: string[];
  fields?: ConnectorField[];
}
```

Trigger เป็น metadata ของ service; การรับ event จริงเป็นงานของ trigger framework ใน Phase 2

## 9. View types (ส่งให้ client)

`ConnectorView`, `ConnectorOperationView`, `ConnectorAuthView` มีเฉพาะ metadata
ที่ปลอดภัยต่อการส่งออก:

- ไม่มีค่า secret
- `ConnectorAuthView.connected` บอกแค่ว่าเครื่องนี้มี credential ที่ใช้ได้
- `ConnectorView.operations` ใช้สร้าง UI และ Quick Work แบบ dynamic
- `ConnectorAuthView.authorizeUrl` ใช้เริ่ม OAuth flow ฝั่ง server

## 10. Runtime contract

```ts
interface ConnectorRequest {
  connector: string;
  operation: string;
  input: Record<string, unknown>;
  account?: string;
  signal?: AbortSignal;
  agent?: string;
}

interface ConnectorResult {
  items: FlowItem[];
  text?: string;
  raw?: unknown;   // ต้องถูก strip secret ก่อนส่งออก
}

interface ConnectorRuntime {
  list(): ConnectorView[];
  get(connector: string): ConnectorSpec | undefined;
  execute(request: ConnectorRequest): Promise<ConnectorResult>;
  test(connector: string, operation: string, input: Record<string, unknown>, account?: string): Promise<ConnectorResult>;
}
```

Runtime ต้อง:

- resolve auth จาก connection store
- ทำ timeout และ normalize error เป็นข้อความที่อ่านได้
- แปลงผลเป็น `FlowItem[]`
- ไม่ใส่ secret ใน `text`, `raw` หรือ error

## 11. Tool และ Quick Work

- tool name: `<connector>_<operation>` เช่น `slack_send_message`
- `description` มาจาก operation description
- `inputSchema` สร้างจาก `fields`
- `risk` / `untrustedInput` ตาม operation
- `settings` มี `account` เสมอ: Google ใช้ `type: 'account'`, service อื่นใช้ `type: 'connection'` + `connector`
- `ToolView` เพิ่ม metadata:
  - `connector?: string`
  - `operation?: string`
  - `familyLabel?: string`
- Quick Work จัดกลุ่มด้วย `connector` + `familyLabel` ไม่ hardcode ชื่อ operation

## 12. Workflow node `connector`

`NodeTypeName` มี `'connector'` หนึ่งตัว และ `NODE_TYPES` มี entry:

```ts
{
  type: 'connector',
  label: 'Connector',
  description: 'เรียก operation ของ service ที่ติดตั้งไว้',
  fields: [
    { key: 'connector', label: 'service', type: 'string', required: true },
    { key: 'operation', label: 'operation', type: 'string', required: true },
    { key: 'account', label: 'บัญชี', type: 'string' },
    { key: 'input', label: 'input (JSON + expression)', type: 'json' },
    { key: 'allow', label: 'อนุญาตให้ทำงานนี้ (write/delete)', type: 'boolean' },
  ],
  outputs: [{ key: 'main', label: 'main' }],
}
```

Runtime ของ node (Phase 0C2) ต้อง resolve expression ใน `input`, เรียก
`deps.connector(...)`, แปลงเป็น `FlowItem[]` และเคารพ `onError` / `retries` เดิม
ส่วน tool ที่ risk ไม่ใช่ `read` ต้องมี consent เหมือน node `tool`

## 13. ตัวอย่าง Slack (bot token)

```ts
import type { ConnectorSpec } from '@mimi/shared';

export const slack: ConnectorSpec = {
  key: 'slack',
  label: 'Slack',
  category: 'communication',
  description: 'ส่งข้อความและอ่านประวัติช่องของ Slack workspace',
  baseUrl: 'https://slack.com/api',
  auth: {
    kind: 'apiKey',
    fields: [
      {
        key: 'botToken',
        label: 'Bot token',
        type: 'secret',
        required: true,
        placeholder: 'xoxb-…',
        description: 'สร้างที่ Slack app → OAuth & Permissions',
      },
    ],
    scopes: ['chat:write', 'channels:read', 'channels:history'],
  },
  operations: [
    {
      key: 'send_message',
      label: 'ส่งข้อความ',
      description: 'ส่งข้อความเข้า channel ด้วย bot',
      method: 'POST',
      path: '/chat.postMessage',
      risk: 'write',
      fields: [
        {
          key: 'channel',
          label: 'channel',
          type: 'select',
          required: true,
          optionsFrom: { connector: 'slack', operation: 'list_channels', labelField: 'name', valueField: 'id' },
        },
        { key: 'text', label: 'ข้อความ', type: 'string', required: true },
      ],
      response: { itemsPath: 'message' },
    },
    {
      key: 'list_channels',
      label: 'ดูรายชื่อ channel',
      method: 'GET',
      path: '/conversations.list',
      risk: 'read',
      fields: [{ key: 'limit', label: 'จำนวน', type: 'number', default: 100 }],
      response: { itemsPath: 'channels' },
    },
    {
      key: 'list_messages',
      label: 'อ่านข้อความใน channel',
      method: 'GET',
      path: '/conversations.history',
      risk: 'read',
      untrustedInput: true,
      fields: [
        {
          key: 'channel',
          label: 'channel',
          type: 'select',
          required: true,
          optionsFrom: { connector: 'slack', operation: 'list_channels', labelField: 'name', valueField: 'id' },
        },
        { key: 'limit', label: 'จำนวน', type: 'number', default: 50 },
      ],
      response: { itemsPath: 'messages' },
    },
  ],
  triggers: [{ key: 'events', label: 'Slack Events', kind: 'webhook', events: ['message.channels', 'app_mention'] }],
  pagination: { mode: 'cursor', cursorParam: 'cursor', nextPath: 'response_metadata.next_cursor', itemsPath: 'channels' },
  rateLimit: { requests: 1, perMs: 1000, burst: 1 },
};
```

หมายเหตุ: ตัวอย่างนี้ใช้ placeholder ไม่ใช่ token จริง และเป็น spec ที่ยังไม่ผูกกับ
implementation ของ runtime

## 14. ข้อห้าม

1. ห้ามฝัง `fetch`, `setTimeout`, secret หรือ side effect ใน spec
2. ห้ามสร้าง `NodeTypeName` ใหม่ต่อ service — ใช้ `connector` เท่านั้น
3. ห้ามเปลี่ยนชื่อ tool หรือ preset เดิมของ user
4. ห้ามส่ง secret ออกทาง `ConnectorView`, tool output, log หรือ error
5. ห้ามยิง API จริงใน test; ใช้ fake fetch/fixture
6. ห้ามใช้ `any` เพื่อหลบ type

## 15. Phase 2 contract + integration tests

`packages/core/src/test/connector-phase2.test.ts` enforces the Phase 2 surface:

1. Every installed spec has a valid key, category, HTTPS base URL, auth kind and credential fields (no secret defaults).
2. Operation and tool names are unique; methods, risks, field types, `select` choices and `optionsFrom` targets resolve.
3. Pagination and rate-limit settings are well formed when present.
4. Connector triggers have a sample; webhooks declare a signature and secret field; poll triggers reference a read operation and valid input/field/cursor keys.
5. A core poll workflow runs only unseen items across scheduler fires and records one run per new item.
6. The HTTP webhook route rejects a bad Slack signature, accepts a valid HMAC and runs the workflow.

Regression coverage for Gmail, Sheets, Outlook and tool presets remains in the existing integration and tool-pool tests.

## 16. Contract change

การเปลี่ยนแบบ breaking (rename, เปลี่ยนความหมาย, ทำให้ field required):

1. หยุดงานที่พึ่งพา
2. เขียน proposal: field, เหตุผล, ผลกระทบ
3. แจ้ง orchestrator
4. เพิ่ม `CONNECTOR_CONTRACT_VERSION`
5. อัปเดตเอกสารนี้และแจ้ง owner ของ runtime/tool/workflow adapter

การเพิ่ม optional field ใหม่ทำได้โดยไม่ bump version แต่ต้องอัปเดตเอกสาร
