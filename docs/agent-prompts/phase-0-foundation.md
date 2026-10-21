# Phase 0 — Foundation, Contract Freeze, Vertical Slice

> อ่าน `docs/agent-prompts/00-shared-context.md` ก่อน
> Phase นี้ห้ามผลิต connector จำนวนมาก เป้าหมายคือพิสูจน์สถาปัตยกรรมและ freeze contract

## เป้าหมาย phase

1. Freeze `ConnectorSpec` / auth / runtime / node contract
2. พิสูจน์ vertical slice 1 service (Slack) ตั้งแต่ spec → auth → tool → workflow node → test
3. ตรวจ feasibility ของ import n8n / Make / Zapier
4. วางรากฐานให้ Phase 1 แยกงานได้โดยไม่ชนกัน

## Gate

- **G0:** contract freeze + Slack slice ผ่าน + `npm run typecheck` + `npm test` ผ่าน

## Workstreams

### 0A — Contract owner (blocking ทุกงาน)

**Agent ID:** `P0-CONTRACT`

**Prompt:**

```text
คุณคือ Agent P0-CONTRACT เจ้าของ contract กลางของ connector platform

อ่าน 00-shared-context.md และสำรวจไฟล์จริง:
- packages/shared/src/tools.ts
- packages/shared/src/tool-definition.ts
- packages/shared/src/protocol.ts
- packages/shared/src/workflows.ts
- packages/shared/src/index.ts
- packages/core/src/tools/registry.ts
- packages/core/src/workflows/runner.ts

งาน:
1. สร้าง packages/shared/src/connectors.ts ตาม contract ขั้นต่ำใน 00-shared-context
2. เพิ่ม type ที่จำเป็นสำหรับ ConnectorView, ConnectorOperationView, ConnectorAuthView
3. ขยาย ToolSettingField ให้รองรับ options และ optionsFrom โดยไม่ทำ field เดิมพัง
4. เพิ่ม metadata ใน ToolView: connector?, operation?, familyLabel?
5. เพิ่ม NodeTypeName 'connector' และ NodeTypeView ของมันใน NODE_TYPES
6. export type ใหม่จาก packages/shared/src/index.ts
7. เขียน docs/connectors/contract.md อธิบาย field, ตัวอย่าง Slack, และข้อห้าม
8. เพิ่ม type-level test หรือ test ที่ตรวจว่า existing ToolSettingField ยังใช้ได้

ขอบเขตไฟล์:
- packages/shared/src/connectors.ts (new)
- packages/shared/src/index.ts
- packages/shared/src/tools.ts
- packages/shared/src/protocol.ts
- packages/shared/src/workflows.ts
- docs/connectors/contract.md (new)
- packages/core/src/test/connector-contract.test.ts (new)

ห้าม:
- implement runtime
- แก้ core.ts/server.ts/runner.ts
- เปลี่ยนชื่อ tool หรือ preset เดิม
- ตั้งใจแก้ behavior ของ workflow node เดิม

Acceptance:
- npm run typecheck ผ่าน
- npm test ผ่าน
- contract มีตัวอย่างครบ: auth, operation, field, pagination, rateLimit, trigger
- ไม่มี any ที่หลบ type
- รายงาน breaking change ทั้งหมด
```

**Owned files:**

- `packages/shared/src/connectors.ts` (new)
- `packages/shared/src/index.ts`
- `packages/shared/src/tools.ts`
- `packages/shared/src/protocol.ts`
- `packages/shared/src/workflows.ts`
- `docs/connectors/contract.md` (new)
- `packages/core/src/test/connector-contract.test.ts` (new)

**Integration owner:** 0A เป็นผู้ freeze contract และเป็นคนแรกที่ merge

---

### 0B — Auth research

**Agent ID:** `P0-AUTH`

**Prompt:**

```text
คุณคือ Agent P0-AUTH ทำ research เรื่อง authentication ของ top 10 services

อ่าน 00-shared-context.md และเอกสาร official ของ:
Slack, Discord, Notion, Airtable, Google Docs, Google Tasks, Google Forms,
HubSpot, Stripe, GitHub

สำหรับแต่ละ service ให้สรุป:
- auth kinds ที่รองรับ (OAuth2, bot token, API key, PAT)
- ต้องใช้ scopes อะไรสำหรับ read/write ที่เราจะทำ
- token refresh / expiry
- redirect URI หรือ local callback ที่ต้องใช้
- rate limit หลัก
- webhook/polling ที่มี
- ข้อจำกัดที่กระทบ desktop app / local-first
- link เอกสาร official

สร้าง docs/connectors/auth-matrix.md เป็นตาราง + notes
ห้ามเขียนโค้ด production ในงานนี้

Acceptance:
- ครบ 10 services
- ทุกข้อมีแหล่งอ้างอิง
- ระบุชัดว่าอะไรทำได้ด้วย API key และอะไรต้อง OAuth
- มี recommendation ว่า Phase 1 ควรเริ่ม provider ไหนก่อน
```

**Owned files:**

- `docs/connectors/auth-matrix.md` (new)

**Parallel:** เริ่มได้ทันที ไม่ต้องรอ 0A

---

### 0C1 — Connector runtime + Slack service

**Agent ID:** `P0-RUNTIME`

**Prompt:**

```text
คุณคือ Agent P0-RUNTIME เจ้าของ runtime ขั้นต่ำและ Slack connector

 prerequisite: 0A freeze contract แล้ว (รอจนมี packages/shared/src/connectors.ts)

อ่าน contract และไฟล์:
- packages/shared/src/connectors.ts
- packages/shared/src/tool-definition.ts
- packages/core/src/tools/registry.ts
- packages/core/src/tools/index.ts
- packages/core/src/tools/pool.ts
- packages/core/src/oauth/settings.ts

งาน:
1. สร้าง packages/core/src/connectors/types.ts, registry.ts, runtime.ts
2. Runtime ขั้นต่ำ:
   - resolve auth จาก connection store/fake resolver
   - GET/POST/PUT/PATCH/DELETE ด้วย fetch
   - timeout, error normalization, JSON/text response
   - normalize ผลเป็น FlowItem[]
   - ไม่ทำ pagination/rate limit เต็มใน Phase 0 (ให้เป็น Phase 2)
3. สร้าง packages/core/src/connectors/services/slack.ts และ services/index.ts (Slack only)
   - auth: bot token (API key) ก่อน
   - operations: slack_send_message, slack_list_channels, slack_list_messages
   - field schema ครบ
   - fake-fetch test
4. สร้าง tool adapter ขั้นต่ำที่แปลง operation เป็น ToolDefinition
5. เพิ่ม test:
   - execute สำเร็จ
   - API error → ข้อความ error ที่อ่านได้
   - input validation
   - ไม่มี secret ใน output

ขอบเขตไฟล์:
- packages/core/src/connectors/types.ts (new)
- packages/core/src/connectors/registry.ts (new)
- packages/core/src/connectors/runtime.ts (new)
- packages/core/src/connectors/tool-adapter.ts (new)
- packages/core/src/connectors/services/slack.ts (new)
- packages/core/src/connectors/services/index.ts (new, Slack only)
- packages/core/src/test/connector-runtime.test.ts (new)

ห้าม:
- แก้ core.ts/server.ts/runner.ts (เป็นของ 0C2)
- แก้ UI
- เพิ่ม dependency
- เรียก Slack API จริง

Acceptance:
- npm run typecheck ผ่าน
- test ของ runtime + Slack ผ่าน
- tool ที่ generate มีชื่อ slack_send_message ฯลฯ
- error ไม่มี token หลุด
```

**Owned files:**

- `packages/core/src/connectors/types.ts` (new)
- `packages/core/src/connectors/registry.ts` (new)
- `packages/core/src/connectors/runtime.ts` (new)
- `packages/core/src/connectors/tool-adapter.ts` (new)
- `packages/core/src/connectors/services/slack.ts` (new)
- `packages/core/src/connectors/services/index.ts` (new, Slack only)
- `packages/core/src/test/connector-runtime.test.ts` (new)

**Dependency:** หลัง 0A freeze

---

### 0C2 — Workflow node + wiring + minimal UI

**Agent ID:** `P0-INTEGRATE`

**Prompt:**

```text
คุณคือ Agent P0-INTEGRATE integration owner ของ Phase 0

 prerequisite: 0A freeze contract แล้ว

อ่าน:
- packages/shared/src/connectors.ts
- packages/shared/src/workflows.ts
- packages/core/src/workflows/runner.ts
- packages/core/src/core.ts
- packages/core/src/server/server.ts
- packages/core/src/server/web/feature-agent-tools.js
- packages/core/src/server/web/app.js

งาน:
1. เพิ่ม executeNode case 'connector' ใน runner.ts
   และเพิ่ม 'connector' ใน NODE_TYPES ของ packages/core/src/workflows/workflow-store.ts
   - resolve input expression
   - เรียก deps.connector(...)
   - normalize เป็น FlowItem[]
   - เคารพ onError/retries เดิม
2. เพิ่ม optional connector dep ใน WorkflowRunnerDeps
3. wire ConnectorRegistry/Runtime ใน core.ts
4. ส่ง connector list ไป web state ผ่าน server.ts (hello/tools message)
5. Quick Work: อ่าน metadata connector จาก ToolView เพื่อจัดกลุ่ม Slack
   - ถ้ายังไม่ทำ dynamic ทั้งหมด ให้ทำ fallback ที่ไม่ hardcode ชื่อ operation
6. เพิ่ม test:
   - connector node execute สำเร็จ
   - expression ใน input ถูก resolve
   - connector error ถูกจัดการตาม onError
7. อัปเดต docs/connectors/integration.md สั้น ๆ

ขอบเขตไฟล์:
- packages/core/src/workflows/runner.ts
- packages/core/src/workflows/workflow-store.ts
- packages/core/src/core.ts
- packages/core/src/server/server.ts
- packages/core/src/server/web/feature-agent-tools.js
- packages/core/src/server/web/app.js
- packages/core/src/test/connector-node.test.ts (new)
- docs/connectors/integration.md (new)

ห้าม:
- แก้ connectors runtime/service files ของ 0C1
- แก้ shared types ของ 0A
- ทำ dynamic operation UI เต็ม (แค่ minimal)
- เพิ่ม NodeTypeName ต่อ service

Acceptance:
- npm run typecheck ผ่าน
- test ของ node ผ่าน
- Slack tool ปรากฏใน Quick Work เป็น family เดียว
- workflow ที่ใช้ node connector รันได้ด้วย fake connector
```

**Owned files:**

- `packages/core/src/workflows/runner.ts`
- `packages/core/src/core.ts`
- `packages/core/src/server/server.ts`
- `packages/core/src/server/web/feature-agent-tools.js`
- `packages/core/src/server/web/app.js`
- `packages/core/src/test/connector-node.test.ts` (new)
- `docs/connectors/integration.md` (new)

**Dependency:** หลัง 0A; ประสานกับ 0C1 เรื่อง interface

---

### 0D — Import feasibility

**Agent ID:** `P0-IMPORT`

**Prompt:**

```text
คุณคือ Agent P0-IMPORT ตรวจความเป็นไปได้ของ import n8n / Make / Zapier

อ่าน:
- packages/core/src/workflows/n8n-import.ts
- packages/core/src/test/*n8n*
- docs/connectors/contract.md (ถ้ามีแล้ว)

งาน:
1. สร้าง fixture ขั้นต่ำใน packages/core/src/test/fixtures/import/:
   - n8n: workflow ที่มี trigger + HTTP + Gmail/Sheets
   - Make: blueprint JSON ขั้นต่ำ (ถ้าหา schema ไม่ได้ ให้สร้างจากเอกสาร official และระบุสมมติฐาน)
   - Zapier: exported Zap JSON ขั้นต่ำ (Team/Enterprise format)
2. เขียน docs/connectors/import-feasibility.md:
   - format ที่อ่านได้
   - field ที่ map ตรง/ไม่ได้
   - auth/credential ที่ต้อง map
   - ข้อจำกัดทางกฎ/แพลตฟอร์ม
   - recommendation สำหรับ Phase 3
3. เขียน test ที่ parse fixture ได้และรายงาน unsupported ครบ (ยังไม่ต้อง implement importer เต็ม)
4. ห้ามใส่ secret จริงหรือ token ใน fixture

ขอบเขตไฟล์:
- packages/core/src/test/fixtures/import/** (new)
- docs/connectors/import-feasibility.md (new)
- packages/core/src/test/connector-import-fixtures.test.ts (new)

Acceptance:
- fixture อ่านได้ด้วย JSON parser
- เอกสารระบุชัดว่า Zapier import ทำได้เฉพาะ export ที่ผู้ใช้มีสิทธิ์
- test ผ่าน
```

**Owned files:**

- `packages/core/src/test/fixtures/import/**` (new)
- `docs/connectors/import-feasibility.md` (new)
- `packages/core/src/test/connector-import-fixtures.test.ts` (new)

**Parallel:** เริ่มได้ทันที

---

## Shared files / integration owner

Integration owner ของ Phase 0 คือ `P0-INTEGRATE` (0C2)

ไฟล์กลางที่ห้าม agent อื่นแก้:

- `packages/shared/src/connectors.ts`
- `packages/shared/src/tools.ts`
- `packages/shared/src/protocol.ts`
- `packages/shared/src/workflows.ts`
- `packages/core/src/core.ts`
- `packages/core/src/workflows/runner.ts`
- `packages/core/src/server/server.ts`
- `packages/core/src/server/web/feature-agent-tools.js`
- `packages/core/src/server/web/app.js`

## ลำดับรันที่แนะนำ

```text
วันแรก:   0A + 0B + 0D  (ขนาน)
หลัง 0A:  0C1 + 0C2     (ขนาน, ประสาน interface)
สุดท้าย:  P0-INTEGRATE รวม + typecheck + test
```

## Phase exit criteria

- [ ] `docs/connectors/contract.md` frozen
- [ ] `ConnectorSpec` ครอบคลุม auth/operation/trigger/pagination/rateLimit
- [ ] Slack 3 operations ทำงานกับ fake fetch
- [ ] tool adapter สร้าง tool name ถูกต้อง
- [ ] workflow node `connector` รันได้
- [ ] Quick Work แสดง Slack เป็น family เดียว
- [ ] import feasibility report ครบ 3 แพลตฟอร์ม
- [ ] `npm run typecheck` ผ่าน
- [ ] `npm test` ผ่าน
- [ ] ไม่มี secret ใน fixture/log

## Handoff ไป Phase 1

ส่งต่อ:

1. Contract version
2. Interface ของ `ConnectorRuntime` และ tool adapter
3. รายชื่อไฟล์ที่ Phase 1 ต้องใช้
4. ช่องว่างที่ยังไม่ทำ (pagination, rate limit, OAuth2)
5. Integration requests ที่ค้าง
