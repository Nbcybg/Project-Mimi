# Shared Context — Connector Parity Agents

> ทุก agent ต้องอ่านไฟล์นี้ก่อนเริ่มงาน
> ไฟล์นี้คือสัญญากลางระหว่าง agent ทุกตัว ห้ามเปลี่ยนโดยไม่แจ้ง orchestrator

## 1. ผลิตภัณฑ์และเป้าหมาย

Mimi เป็นแอป AI agent แบบ local-first มี:

- Chat + agent หลายตัว + tools/presets
- Workflow engine แบบ n8n
- Quick Work picker ที่รวม operation ของ service เดียวเป็น node เดียว
- Google / Microsoft / Telegram connectors
- MCP hub, custom HTTP/code/shell tools

เป้าหมายรอบนี้: **connector parity แบบเป็นเฟส**

- Top 50–100 services มี native connector
- Long-tail หลายพัน app เข้าถึงผ่าน OpenAPI import + MCP + HTTP
- Import workflow จาก n8n/Make/Zapier เท่าที่ format เปิดให้
- ไม่พยายามเขียน native connector หลายพันตัวด้วยมือ

## 2. Stack และคำสั่ง

- Node.js >= 24
- TypeScript strict, ESM, import ลงท้าย `.ts`
- Test: `node:test`
- ไม่มี build step สำหรับ server; รัน TS ตรง ๆ

```bash
npm run typecheck
npm test
node --test --test-timeout=60000 packages/core/src/test/<file>.test.ts
npm run serve
npm run build:mac        # เฉพาะ integration owner ก่อนปิด phase
```

กฎการทดสอบ:

- ห้ามยิง API จริงใน test
- ใช้ fixture / fake fetch
- test ต้องรันได้แบบ offline
- ถ้าเพิ่ม test file ให้อยู่ใน `packages/core/src/test/` ตามชื่อที่สื่อความหมาย

## 3. แผนที่โค้ด

| ไฟล์/โฟลเดอร์ | หน้าที่ |
|---|---|
| `packages/shared/src/tools.ts` | `ToolSettingField`, `ToolParamField`, `ToolSpec`, `ToolPreset`, `CustomToolSpec` |
| `packages/shared/src/tool-definition.ts` | `ToolDefinition`, `ToolContext`, `defineTool` |
| `packages/shared/src/protocol.ts` | `ToolView`, `ToolPoolView` และ protocol ฝั่ง server→web |
| `packages/shared/src/workflows.ts` | `NODE_TYPES`, `NodeTypeName`, `WorkflowNode`, trigger types |
| `packages/shared/src/oauth.ts` | `OAuthService`, `OAuthAccountView`, `OAuthAccountInput` |
| `packages/core/src/tools/registry.ts` | `ToolRegistry`, `ToolSource` |
| `packages/core/src/tools/index.ts` | ประกอบ built-in tools ทั้งหมด |
| `packages/core/src/tools/pool.ts` | pool + presets + MCP + custom tools |
| `packages/core/src/oauth/accounts.ts` | Google/Microsoft account store และ token cache |
| `packages/core/src/oauth/settings.ts` | `accountSetting`, `accountOf` |
| `packages/core/src/google/*` | Gmail, Calendar, Sheets, Drive tools |
| `packages/core/src/microsoft/*` | Outlook, Calendar, To Do, OneDrive tools |
| `packages/core/src/workflows/runner.ts` | execute workflow node ทุกชนิด |
| `packages/core/src/workflows/n8n-import.ts` | n8n import + report |
| `packages/core/src/core.ts` | wiring ของ tool registry, pool, runner, services |
| `packages/core/src/server/server.ts` | WebSocket state/handlers, `WEB_FILES` |
| `packages/core/src/server/web/feature-agent-tools.js` | Quick Work picker/families/presets |
| `packages/core/src/server/web/feature-tools.js` | Hub tools/custom/MCP |
| `packages/core/src/server/web/feature-workflows.js` | workflow editor/node config/import UI |
| `packages/core/src/server/web/app.css` | global + feature CSS |

## 4. สถาปัตยกรรม connector เป้าหมาย

### 4.1 หลักการ

1. **หนึ่ง service = หนึ่ง connector spec**
2. **หนึ่ง operation = หนึ่ง tool name** รูปแบบ `<connector>_<operation>`
3. **หนึ่ง service = หนึ่งการ์ดใน Quick Work** สร้างจาก metadata ไม่ hardcode
4. **Workflow ใช้ generic node type `connector`** ไม่เพิ่ม `NodeTypeName` ต่อ service
5. **Connector spec เป็น data ล้วน** ห้ามฝัง `fetch`, secret หรือ side effect
6. **Runtime กลาง** จัดการ auth, retry, pagination, rate limit, error, normalization
7. **เพิ่ม connector ใหม่ = เพิ่มไฟล์เดียว** ใน `packages/core/src/connectors/services/`

### 4.2 โฟลเดอร์เป้าหมาย

```text
packages/shared/src/connectors.ts
packages/core/src/connectors/
  types.ts
  registry.ts
  runtime.ts
  auth.ts
  tool-adapter.ts
  node-adapter.ts
  openapi.ts              # Phase 2
  services/
    index.ts              # integration owner เท่านั้นที่แก้
    slack.ts
    notion.ts
    ...
```

### 4.3 Contract ขั้นต่ำที่ต้อง freeze ใน Phase 0

ชื่อ type อาจปรับได้ แต่ต้องรองรับ field เหล่านี้:

```ts
export type ConnectorAuthKind = 'oauth2' | 'oauth1' | 'apiKey' | 'basic' | 'bearer' | 'none';

export interface ConnectorField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'json' | 'secret' | 'select';
  required?: boolean;
  default?: unknown;
  placeholder?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  /** ดึง options จาก operation อื่น เช่น list channels */
  optionsFrom?: {
    connector: string;
    operation: string;
    labelField: string;
    valueField: string;
    dependsOn?: string[];
  };
  dependsOn?: string[];
}

export interface ConnectorOperation {
  key: string;
  label: string;
  description?: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;                 // รองรับ {param}
  fields: ConnectorField[];     // input ที่ user/model กรอก
  risk: 'read' | 'write' | 'shell' | 'delete' | 'network';
  untrustedInput?: boolean;
  /** ผลลัพธ์ที่เอาไปทำ items */
  response?: {
    itemsPath?: string;         // เช่น "messages" หรือ "data.items"
    binary?: boolean;
  };
}

export interface ConnectorAuth {
  kind: ConnectorAuthKind;
  fields: ConnectorField[];
  authorizeUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  /** OAuth2 refresh, PKCE ฯลฯ ตาม provider */
  extra?: Record<string, unknown>;
}

export interface ConnectorTrigger {
  key: string;
  label: string;
  kind: 'webhook' | 'poll';
  events?: string[];
  fields?: ConnectorField[];
}

export interface ConnectorSpec {
  key: string;                  // lower_snake, ใช้เป็น prefix ของ tool
  label: string;
  category: string;
  description: string;
  auth: ConnectorAuth;
  operations: ConnectorOperation[];
  triggers?: ConnectorTrigger[];
  pagination?: {
    mode: 'page' | 'cursor' | 'nextPageToken' | 'link';
    pageParam?: string;
    sizeParam?: string;
    cursorParam?: string;
    itemsPath?: string;
    nextPath?: string;
  };
  rateLimit?: {
    requests: number;
    perMs: number;
    burst?: number;
  };
}
```

### 4.4 Runtime contract

```ts
export interface ConnectorRequest {
  connector: string;
  operation: string;
  input: Record<string, unknown>;
  account?: string;
  signal?: AbortSignal;
  /** ใช้ใน test/permission */
  agent?: string;
}

export interface ConnectorResult {
  items: Array<{ json: Record<string, unknown> }>;
  /** ข้อความสั้นสำหรับ tool output */
  text?: string;
  /** raw response สำหรับ debug (ห้ามมี secret) */
  raw?: unknown;
}

export interface ConnectorRuntime {
  list(): ConnectorView[];
  get(connector: string): ConnectorSpec | undefined;
  execute(request: ConnectorRequest): Promise<ConnectorResult>;
  test(connector: string, operation: string, input: Record<string, unknown>, account?: string): Promise<ConnectorResult>;
}
```

### 4.5 Workflow node `connector`

เพิ่ม `NodeTypeName = 'connector'` หนึ่งตัวใน `NODE_TYPES`:

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
  ],
  outputs: [{ key: 'main', label: 'main' }],
}
```

Runtime ของ node:

- resolve expression ใน `input`
- เรียก `deps.connector(...)`
- แปลงผลเป็น `FlowItem[]`
- เคารพ `onError`, `retries`, `retryWaitMs` ที่มีอยู่แล้ว
- tool ที่ risk ไม่ใช่ read ต้องมี consent เหมือน node `tool` ปัจจุบัน

UI จะ render field ของ operation แบบ dynamic จาก `ConnectorSpec` แทนการให้พิมพ์ JSON อย่างเดียว

### 4.6 Tool adapter

ทุก operation ต้องถูก expose เป็น tool:

```text
<connector>_<operation>  เช่น slack_send_message, notion_search
```

ข้อกำหนด:

- `description` มาจาก operation description
- `inputSchema` สร้างจาก `fields` (zod)
- `risk` และ `untrustedInput` ตาม operation
- `settings` มี `account` เมื่อ connector ใช้ account
- `execute` เรียก `ConnectorRuntime.execute`
- Quick Work ใช้ metadata `connector`, `operation`, `familyLabel` เพื่อจัดกลุ่ม
- ห้ามสร้าง tool ซ้ำชื่อเดิม; ถ้าชนให้เติม suffix หรือเปลี่ยน operation key

### 4.7 Generic auth

- `OAuthService` ปัจจุบันเป็น `'google' | 'microsoft'`
- Phase 1 ต้องขยายให้รองรับ provider id อื่นโดยไม่ทำ Google/Microsoft พัง
- แนวทางที่แนะนำ: คง type เดิมเป็น built-in แล้วเพิ่ม type กว้างสำหรับ connector
- token/secret เก็บใน vault เดิม
- connection ต้องมี: list, add, edit, remove, set default, test
- ห้าม log token, refresh token, client secret

## 5. Invariants ที่ห้ามละเมิด

1. Tool ชื่อเดิมและ preset ของ user ต้องใช้ได้เหมือนเดิม
2. Agent ที่มี tool อ่านข้อมูล third-party (`untrustedInput`) ห้ามมี shell tool พร้อมกัน
3. Tool ที่ risk เป็น write/delete/network ต้องขออนุญาตตาม policy เดิม
4. Workflow node `tool` ต้องคง `allow` consent behavior
5. Secret ต้องไม่อยู่ใน workflow JSON, log, error message, fixture
6. ห้ามแก้ `dist/`, `node_modules/`, lockfile, `.env`
7. ห้ามลบหรือ rename ไฟล์/ฟังก์ชันสาธารณะโดยไม่แจ้ง
8. ห้ามใช้ `any` เพื่อหลบ type; ถ้าจำเป็นให้แคบและมี comment เหตุผล
9. การเขียนไฟล์ config ต้องใช้ store ที่มีอยู่และ atomic write
10. ห้ามเรียก API จริงใน test; ใช้ fake fetch/fixture

## 6. กติกาการทำงานร่วมกัน

### 6.1 Ownership

- หนึ่ง workstream เป็นเจ้าของไฟล์ตามรายการใน phase prompt
- ไฟล์กลางเป็นของ integration owner เท่านั้น
- Agent อื่นที่ต้องการเปลี่ยนไฟล์กลางให้ส่ง request ในรายงาน

### 6.2 Contract change

ถ้าต้องเปลี่ยน type ใน `packages/shared/src/connectors.ts`:

1. หยุดงานที่พึ่งพา
2. เขียน proposal สั้น ๆ: field ที่เพิ่ม, เหตุผล, ผลกระทบ
3. แจ้ง orchestrator
4. หลัง freeze แล้วเท่านั้นจึงแก้

### 6.3 Conflict

- ถ้าไฟล์ที่ต้องแก้ถูก agent อื่นแก้ไปแล้ว ให้ rebase/รวมด้วยมือ
- ห้าม revert งานคนอื่น
- ถ้า resolve ไม่ได้ ให้หยุดและรายงาน

### 6.4 ห้ามทำเกิน scope

- ไม่เพิ่ม dependency ใหม่โดยไม่อนุมัติ
- ไม่ refactor ไฟล์กลางแบบกว้าง
- ไม่แก้ UI ที่ไม่เกี่ยวกับงาน
- ไม่สร้าง connector ที่ไม่อยู่ในรายการ phase

## 7. Definition of Done ของทุก workstream

- โค้ด compile ผ่าน `npm run typecheck`
- test ที่เกี่ยวข้องผ่าน
- test ใหม่ครอบคลุม happy path + error หลัก
- ไม่มี secret ในไฟล์ที่แก้
- อัปเดตเอกสาร/contract ถ้ามีการเปลี่ยน interface
- รายงานตามรูปแบบด้านล่าง
- ไม่ commit เว้นแต่ orchestrator สั่ง

## 8. รูปแบบรายงานกลับ

```md
## Agent <ID> — <ชื่องาน>

Status: done | blocked | partial

### Files changed
- path — สรุปสั้น ๆ

### Contract changes
- ไม่มี / ระบุ type + เหตุผล

### Tests
- command
- ผลลัพธ์

### Integration requests
- ไฟล์กลางที่ต้องแก้ / owner ที่ต้องทำ

### Risks / follow-ups
- ...
```
