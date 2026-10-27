# Connector integration (Phase 0)

## Workflow node

`connector` เป็น node กลางตัวเดียว ไม่มี node ต่อ service:

```json
{
  "id": "send",
  "type": "connector",
  "title": "Slack",
  "config": {
    "connector": "slack",
    "operation": "send_message",
    "account": "",
    "input": { "channel": "C123", "text": "{{ $json.text }}" }
  },
  "links": { "main": ["done"] }
}
```

- `input` ถูก resolve expression ก่อนเรียก runtime
- `account` ว่าง = บัญชีเริ่มต้น (Phase 0 ยังไม่มี account store)
- operation ที่ `risk !== 'read'` ต้องตั้ง `allow: true` ที่ node หรือ `permissions["<connector>_<operation>"] = "allow"` ใน settings; `deny` ชนะเสมอ
- `retries`, `retryWaitMs`, `onError` ใช้กลไกเดิมของ runner
- ผลลัพธ์เป็น `FlowItem[]` จาก `ConnectorResult.items`; ถ้าไม่มี items แต่มี `text` จะห่อเป็น `{ text }`

## Wiring

`core.ts` สร้าง:

1. `ConnectorRegistry(connectorSpecs)` จาก `packages/core/src/connectors/services/index.ts`
2. `ConnectorRuntimeImpl` (auth resolver + generic OAuth2 + rate limit/pagination)
3. tool ทุก operation ผ่าน `connectorTools()` แล้ว register เข้า `ToolRegistry`
4. ส่ง runtime เป็น `WorkflowRunnerDeps.connector`

Auth (Phase 3):

- static token (`apiKey` / `bearer` / `basic`) → `ConnectorConnections`
  (`account` → connection default → legacy vault key/env)
- Google → `OAuthAccounts` ผ่าน `oauth.google(account)`; YouTube และ Google service
  ใหม่ใช้บัญชีเดียวกัน
- OAuth2 อื่น ๆ → generic flow ต่ออายุ token ให้ (X ใช้ PKCE, Zoho เติม prefix)
- `risk !== 'read'` ต้องมี `allow` ที่ node หรือ permission `allow`; `deny` ชนะเสมอ
- รายละเอียดทุก service: `docs/connectors/auth-matrix.md`

## Quick Work

`ToolPool.views()` คัดลอก metadata จาก connector tool ลง `ToolView`:

- `connector` = service key
- `operation` = operation key
- `familyLabel` = ชื่อ service

`feature-agent-tools.js` จัดกลุ่มด้วย `tool.connector` และใช้ `tool.familyLabel` / `tool.operation`
โดยไม่ hardcode ชื่อ operation; แต่ละ service จึงเป็นการ์ดเดียวที่มีทุก operation ของ spec
(Slack 6, HubSpot 6, GitHub 6, …). long-tail (custom/MCP) แยกเป็น `tool:<name>` ไม่ปน family native.

## Tests

```bash
node --test --test-timeout=60000 packages/core/src/test/connector-node.test.ts
```

ครอบ expression, consent, onError/retries, workflow store และ metadata ของ Quick Work.

## ยังค้าง (Phase 4+)

- concurrency/queue/idempotency/timeout ของ workflow execution
- connector versioning + catalog update โดยไม่ทำ workflow เก่าพัง
- OpenAPI import จากเว็บ (server message + persistence; ดู `longtail-ui.md`)
- multipart streaming สำหรับ `bodyFormat: 'form'` (เช่น Box `upload_file`)

## Phase 4 implementation update (2026-10-23)

The first three Phase 4 items are now implemented:

- queue, cancellation, idempotency and timeouts: `reliability.md`
- run history, redaction, traces and attempts: `observability.md`
- connector versions and pinned workflow nodes: `versioning.md`
- guarded outbound HTTP and credential handling: `security-review.md`
- E2E and performance measurements: `performance.md`

Still open: OpenAPI persistence/runtime registration and multipart streaming.
The 60-node execution cap (`PERF-4E-01`) was raised to 1000 with an explicit
failure when the cap is reached; see `performance.md`.
