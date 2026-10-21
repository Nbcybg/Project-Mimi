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
2. `ConnectorRuntimeImpl`
3. tool ทุก operation ผ่าน `connectorTools()` แล้ว register เข้า `ToolRegistry`
4. ส่ง runtime เป็น `WorkflowRunnerDeps.connector`

Auth ของ Phase 0 เป็น bridge จนกว่าจะมี connection store:

- vault key: `connector.<connector>.<field>` เช่น `connector.slack.botToken`
- environment fallback: `<CONNECTOR>_<FIELD>` เช่น `SLACK_BOT_TOKEN`
- ถ้าระบุ `account` จะยังไม่ resolve (OAuth accounts เป็น Phase 1)

## Quick Work

`ToolPool.views()` คัดลอก metadata จาก connector tool ลง `ToolView`:

- `connector` = service key
- `operation` = operation key
- `familyLabel` = ชื่อ service

`feature-agent-tools.js` จัดกลุ่มด้วย `tool.connector` และใช้ `tool.familyLabel` / `tool.operation` โดยไม่ hardcode ชื่อ operation. Slack จึงเป็นการ์ดเดียวที่มี 3 operations.

## Tests

```bash
node --test --test-timeout=60000 packages/core/src/test/connector-node.test.ts
```

ครอบ expression, consent, onError/retries, workflow store และ metadata ของ Quick Work.

## ยังค้าง (Phase 1+)

- ส่ง `ConnectorView[]` เต็มไป web ต้องเพิ่ม field ใน `ServerMessage`/`ToolPoolView` (shared protocol ของ 0A) — Phase 0 ส่งเฉพาะ metadata บน `ToolView`
- เพิ่ม field `allow` ใน `NODE_TYPES.connector` เพื่อให้ติ๊กใน editor ได้ (contract 0A ยังไม่มี)
- connection store / OAuth account picker
- pagination, rate limit เต็มรูปแบบ และ trigger ของ connector
