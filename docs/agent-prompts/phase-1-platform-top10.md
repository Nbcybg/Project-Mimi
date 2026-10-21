# Phase 1 — Connector Platform + Top 10 Services

> เริ่มได้หลัง G0 ผ่าน (`phase-0-foundation.md`)
> อ่าน `docs/agent-prompts/00-shared-context.md` ก่อน

## เป้าหมาย phase

1. Productionize connector runtime/registry/tool adapter
2. เพิ่ม generic connection layer (OAuth2 + API key/bot token/PAT)
3. เพิ่ม workflow service node UI + dynamic operation fields
4. เชื่อม Quick Work ให้สร้าง family จาก connector metadata
5. ส่งมอบ connector ใหม่ 10 services / ≥50 operations
6. รักษา Google/Microsoft/Telegram และ preset เดิมทั้งหมด

## Gate

- **G1:** 10 services, OAuth2/connection layer, service node, Quick Work grouping, tests ผ่าน

## Workstreams

### 1A — Runtime, registry, integration owner

**Agent ID:** `P1-RUNTIME`

**Prompt:**

```text
คุณคือ Agent P1-RUNTIME integration owner ของ Phase 1

อ่าน:
- docs/connectors/contract.md
- docs/connectors/integration.md
- packages/shared/src/connectors.ts
- packages/core/src/connectors/*
- packages/core/src/workflows/runner.ts
- packages/core/src/core.ts
- packages/core/src/server/server.ts
- packages/core/src/tools/index.ts
- packages/core/src/tools/pool.ts

งาน:
1. Productionize ConnectorRegistry:
   - register specs จาก services/index.ts
   - validate unique connector key/operation key/tool name
   - list views สำหรับ UI
2. Productionize ConnectorRuntime:
   - auth resolver interface
   - timeout, retry พื้นฐาน, error normalization
   - response itemsPath
   - JSON/text/binary handling
3. Tool adapter:
   - สร้าง ToolDefinition ต่อ operation
   - zod schema จาก ConnectorField
   - risk/untrustedInput/settings
   - execute ผ่าน runtime
4. Workflow connector node:
   - resolve input expression
   - execute ผ่าน runtime
   - permission/consent สำหรับ risk != read
   - normalize output
5. Wiring:
   - core.ts สร้าง registry/runtime/tools
   - server.ts ส่ง connector views ใน hello/tools state
   - tools/index.ts หรือ pool.ts ลงทะเบียน connector tools
6. Barrel:
   - เป็นเจ้าของ packages/core/src/connectors/services/index.ts
   - เพิ่ม import/export ของ connector ทุกตัวเมื่อ batch A/B ส่งงาน
7. Tests:
   - registry validation
   - tool adapter happy/error
   - node permission
   - existing tool/preset regression

ขอบเขตไฟล์:
- packages/core/src/connectors/registry.ts
- packages/core/src/connectors/runtime.ts
- packages/core/src/connectors/tool-adapter.ts
- packages/core/src/connectors/node-adapter.ts (ถ้าจำเป็น)
- packages/core/src/connectors/services/index.ts
- packages/core/src/workflows/runner.ts
- packages/core/src/core.ts
- packages/core/src/server/server.ts
- packages/core/src/tools/index.ts
- packages/core/src/tools/pool.ts
- packages/core/src/test/connector-platform.test.ts (new)

ห้าม:
- แก้ service files ของ 1D/1E
- แก้ OAuth store ของ 1B
- แก้ UI ของ 1C
- เปลี่ยนชื่อ tool เดิม
- เพิ่ม dependency

Acceptance:
- npm run typecheck ผ่าน
- test ใหม่ + test เดิมผ่าน
- connector tools ปรากฏใน pool
- workflow connector node ใช้ได้
- ไม่มี secret ใน error/log
```

**Owned files:** ตามรายการใน prompt

**Integration owner:** 1A เป็นผู้รวม barrel, core/server wiring และเป็นคนสุดท้ายที่ merge

---

### 1B — Generic connection layer

**Agent ID:** `P1-AUTH`

**Prompt:**

```text
คุณคือ Agent P1-AUTH เจ้าของ generic connection/auth layer

อ่าน:
- packages/shared/src/oauth.ts
- packages/core/src/oauth/accounts.ts
- packages/core/src/oauth/settings.ts
- packages/core/src/google/auth.ts
- packages/core/src/microsoft/auth.ts
- packages/core/src/server/web/feature-accounts.js
- docs/connectors/auth-matrix.md

งาน:
1. ออกแบบ connection model ที่รองรับ:
   - OAuth2 (authorize/token/refresh, PKCE ถ้าจำเป็น)
   - API key
   - bot token / PAT
   - Basic/Bearer
2. คง Google/Microsoft account เดิมให้ทำงานเหมือนเดิม
   - ห้ามลบ account, token, legacy migration
   - ห้าม rename message types เดิม
3. เพิ่ม packages/core/src/oauth/connections.ts (หรือชื่อที่เหมาะ):
   - list/add/update/remove/set default/test
   - secret เก็บใน SecretStore
   - metadata ไม่มี secret
4. เพิ่ม generic OAuth2 flow module:
   - startConnect(connectionId)
   - handleCallback
   - refreshToken
   - revoke/remove
5. ทำ API module สำหรับ server โดยไม่แก้ server.ts เอง
   - export handlers ที่ 1A ไป wire
6. อัปเดต feature-accounts.js ให้แสดง connection ของ connector ได้
   - UI ต้องไม่ทำให้ Google/Microsoft เดิมพัง
7. Tests:
   - save/list/remove connection
   - secret ไม่รั่วใน view
   - refresh success/failure
   - legacy accounts ยังใช้ได้

ขอบเขตไฟล์:
- packages/shared/src/oauth.ts
- packages/core/src/oauth/connections.ts (new)
- packages/core/src/oauth/generic-flow.ts (new)
- packages/core/src/oauth/api.ts (new)
- packages/core/src/oauth/accounts.ts (ถ้าจำเป็น, รักษา behavior)
- packages/core/src/server/web/feature-accounts.js
- packages/core/src/test/connector-auth.test.ts (new)

ห้าม:
- แก้ server.ts/core.ts (ส่ง integration request ให้ 1A)
- แก้ service connector files
- เก็บ token ใน JSON ที่ไม่ใช่ vault
- ทำ OAuth จริงใน test

Acceptance:
- npm run typecheck ผ่าน
- test ผ่าน
- existing Google/Microsoft tests ผ่าน
- connection view ไม่มี secret
- มี integration request ระบุ handler ที่ 1A ต้อง wire
```

**Owned files:** ตามรายการใน prompt

**Dependency:** ใช้ `ConnectorAuth` จาก Phase 0; ประสาน 1A เรื่อง server wiring

---

### 1C — Service node UI + dynamic fields + Quick Work

**Agent ID:** `P1-UI`

**Prompt:**

```text
คุณคือ Agent P1-UI เจ้าของ UI ของ connector platform

อ่าน:
- packages/core/src/server/web/feature-workflows.js
- packages/core/src/server/web/feature-agent-tools.js
- packages/core/src/server/web/feature-tools.js
- packages/core/src/server/web/app.js
- packages/core/src/server/web/app.css
- packages/shared/src/connectors.ts
- packages/shared/src/protocol.ts

งาน:
1. Workflow editor:
   - node `connector` เลือก service + operation
   - render field ตาม ConnectorField
   - field type: string/number/boolean/json/select/secret
   - optionsFrom: โหลด options จาก operation (พร้อม loading/error)
   - dependsOn: clear/disable field ที่ไม่เกี่ยว
   - ปุ่ม Test operation
   - แสดง account/credential ที่ใช้
2. Quick Work:
   - สร้าง family จาก connector metadata (connector, familyLabel)
   - ไม่ hardcode ชื่อ operation
   - คง fallback FAMILIES เดิมไว้สำหรับ tool ที่ยังไม่มี metadata
   - การ์ด family แสดงจำนวน operations, installed count
3. Node palette:
   - แสดง connector ตาม category
   - เลือก service แล้วสร้าง node `connector` พร้อม config
4. CSS:
   - responsive, ไม่ทำ layout เดิมพัง
   - รองรับ picker card compact
5. Tests:
   - unit test ของ helper ที่ไม่ต้อง DOM (ถ้ามี)
   - manual smoke checklist ใน docs/connectors/ui-smoke.md

ขอบเขตไฟล์:
- packages/core/src/server/web/feature-workflows.js
- packages/core/src/server/web/feature-agent-tools.js
- packages/core/src/server/web/feature-tools.js
- packages/core/src/server/web/app.js
- packages/core/src/server/web/app.css
- docs/connectors/ui-smoke.md (new)

ห้าม:
- แก้ server.ts/core.ts
- แก้ connector service files
- เปลี่ยน DOM structure ของหน้าอื่นโดยไม่จำเป็น
- ใส่ข้อความ hardcode รายชื่อ operation

Acceptance:
- service node เลือก operation และกรอก field ได้
- Quick Work แสดง 10 services เป็น family
- ไม่มี regression กับ Gmail/Sheets/Outlook
- typecheck ผ่าน
- smoke checklist ครบ
```

**Owned files:** ตามรายการใน prompt

**Dependency:** ใช้ state shape จาก 1A; ถ้า state ยังไม่พร้อมให้ใช้ mock และระบุ integration request

---

### 1D — Connector batch A

**Agent ID:** `P1-CONN-A`

**Prompt:**

```text
คุณคือ Agent P1-CONN-A เจ้าของ connector batch A

อ่าน:
- docs/connectors/contract.md
- docs/connectors/auth-matrix.md
- packages/core/src/connectors/runtime.ts
- packages/core/src/connectors/services/slack.ts
- packages/core/src/test/connector-runtime.test.ts

สร้าง connector 5 services ใน packages/core/src/connectors/services/:
1. Slack (ขยายจาก Phase 0)
   - send_message, list_channels, list_messages, update_message, add_reaction
2. Discord
   - send_message, list_guilds, list_channels, list_messages
3. Notion
   - search, get_page, create_page, append_blocks, query_database
4. Airtable
   - list_records, get_record, create_record, update_record, delete_record
5. Google Docs
   - create_document, get_document, append_text, replace_text

ข้อกำหนด:
- หนึ่งไฟล์ต่อ service
- export ชื่อ <service>Connector
- ไม่แก้ services/index.ts (1A เป็นเจ้าของ)
- field ต้องมี label/description/required ครบ
- risk ถูกต้อง; read ที่ได้ third-party text ต้อง untrustedInput
- response.itemsPath ถูกต้อง
- test ด้วย fake fetch ต่อ service
- ห้าม secret/token จริง
- ถ้า API ต้องใช้ OAuth ที่ยังไม่รองรับ ให้ใช้ API key/bot token ก่อนและระบุใน report

Acceptance:
- npm run typecheck ผ่าน
- test ของ batch A ผ่าน
- ทุก operation มี test อย่างน้อย 1 กรณี
- ไม่มี tool name ชนกัน
- report บอก 1A ว่าต้อง import export อะไร
```

**Owned files:**

- `packages/core/src/connectors/services/slack.ts`
- `packages/core/src/connectors/services/discord.ts` (new)
- `packages/core/src/connectors/services/notion.ts` (new)
- `packages/core/src/connectors/services/airtable.ts` (new)
- `packages/core/src/connectors/services/google-docs.ts` (new)
- `packages/core/src/test/connector-batch-a.test.ts` (new)

**Dependency:** หลัง 0A/1A interface พร้อม; เริ่มเขียน spec ได้ก่อน runtime merge

---

### 1E — Connector batch B

**Agent ID:** `P1-CONN-B`

**Prompt:**

```text
คุณคือ Agent P1-CONN-B เจ้าของ connector batch B

อ่าน:
- docs/connectors/contract.md
- docs/connectors/auth-matrix.md
- packages/core/src/connectors/runtime.ts
- packages/core/src/connectors/services/slack.ts

สร้าง connector 5 services:
1. Google Tasks
   - list_tasklists, list_tasks, create_task, complete_task
2. Google Forms
   - get_form, list_responses, create_form
3. HubSpot
   - search_contacts, create_contact, list_deals, create_deal, list_tickets
4. Stripe
   - list_customers, create_customer, list_payments, create_payment_link, refund_payment
5. GitHub
   - list_repos, get_file, create_issue, list_issues, create_comment

ข้อกำหนด:
- หนึ่งไฟล์ต่อ service
- export ชื่อ <service>Connector
- ไม่แก้ services/index.ts
- Google Tasks/Forms ใช้ Google OAuth เดิมผ่าน auth resolver
- Stripe ใช้ API key
- GitHub ใช้ PAT/OAuth
- test fake fetch
- ระบุ rate limit/pagination ที่ยังไม่ทำใน report

Acceptance:
- npm run typecheck ผ่าน
- test ของ batch B ผ่าน
- ทุก operation มี test อย่างน้อย 1 กรณี
- ไม่มี secret ใน fixture
- report บอก 1A ว่าต้อง import export อะไร
```

**Owned files:**

- `packages/core/src/connectors/services/google-tasks.ts` (new)
- `packages/core/src/connectors/services/google-forms.ts` (new)
- `packages/core/src/connectors/services/hubspot.ts` (new)
- `packages/core/src/connectors/services/stripe.ts` (new)
- `packages/core/src/connectors/services/github.ts` (new)
- `packages/core/src/test/connector-batch-b.test.ts` (new)

**Dependency:** หลัง 0A/1A interface พร้อม

---

### 1F — Connector fixtures + contract tests

**Agent ID:** `P1-TEST`

**Prompt:**

```text
คุณคือ Agent P1-TEST เจ้าของ fixture และ contract test ของ connector

อ่าน:
- packages/shared/src/connectors.ts
- packages/core/src/connectors/*
- packages/core/src/test/connector-*.test.ts

งาน:
1. สร้าง test helper สำหรับ fake fetch:
   - จับ request
   - ตอบ fixture ตาม path/method
   - assert headers/query/body
2. สร้าง fixture กลางใน packages/core/src/test/fixtures/connectors/
3. เขียน contract test ที่ตรวจทุก connector:
   - key unique
   - operation key unique
   - tool name unique
   - field required/default ถูกต้อง
   - risk ไม่เป็น read ถ้าเป็น write/delete
   - ไม่มี secret ใน spec
   - OAuth scope/URL ครบเมื่อ kind = oauth2
4. เขียน test ที่โหลด connector ทุกตัวจาก services/index.ts (ถ้า barrel ยังไม่ครบ ให้ skip พร้อมเหตุผล)
5. ห้ามแก้ production code; ถ้าเจอบั๊กให้รายงาน owner

Acceptance:
- test ผ่าน
- helper ใช้ซ้ำได้ใน Phase 2
- ไม่มี network call
```

**Owned files:**

- `packages/core/src/test/fixtures/connectors/**` (new)
- `packages/core/src/test/connector-contract.test.ts`
- `packages/core/src/test/helpers/fake-fetch.ts` (new)

**Dependency:** เริ่มได้หลัง contract freeze; test จะสมบูรณ์เมื่อ 1D/1E merge

---

## Shared files / integration owner

Integration owner ของ Phase 1 คือ `P1-RUNTIME` (1A)

ไฟล์กลางที่ห้าม agent อื่นแก้:

- `packages/shared/src/connectors.ts`
- `packages/shared/src/tools.ts`
- `packages/shared/src/protocol.ts`
- `packages/shared/src/workflows.ts`
- `packages/core/src/core.ts`
- `packages/core/src/workflows/runner.ts`
- `packages/core/src/server/server.ts`
- `packages/core/src/connectors/services/index.ts`
- `packages/core/src/tools/index.ts`
- `packages/core/src/tools/pool.ts`

## ลำดับรันที่แนะนำ

```text
สัปดาห์แรก:
- 1D + 1E เขียน spec/test ได้ทันที
- 1B เริ่ม connection layer
- 1C ทำ UI กับ mock state
- 1A วาง runtime/registry + wiring

กลาง phase:
- 1D/1E ส่ง service files
- 1A รวม barrel
- 1B ส่ง integration request
- 1C merge UI
- 1F รัน contract tests

ท้าย phase:
- 1A รัน typecheck/test รวม
- 1A รัน build:mac หนึ่งครั้ง
```

## Phase exit criteria

- [ ] 10 services ใหม่/ขยายครบ
- [ ] ≥50 operations
- [ ] tool name ทุกตัวไม่ชนและอยู่ใน pool
- [ ] generic connection layer ใช้ได้กับ OAuth2 + API key/bot token/PAT
- [ ] Google/Microsoft account เดิมยังทำงาน
- [ ] workflow node `connector` ใช้ได้
- [ ] Quick Work สร้าง family จาก metadata
- [ ] dynamic operation fields + optionsFrom ใช้ได้
- [ ] test ทุก batch ผ่าน
- [ ] `npm run typecheck` ผ่าน
- [ ] `npm test` ผ่าน
- [ ] `npm run build:mac` ผ่าน (integration owner)
- [ ] ไม่มี secret ใน log/fixture/JSON

## Handoff ไป Phase 2

ส่งต่อ:

1. Connector spec version
2. รายชื่อ 10 services + operations
3. Auth ที่รองรับจริง
4. ช่องว่าง: pagination, rate limit, triggers, dynamic options ที่ยังไม่ครบ
5. Integration requests
6. ผล build/test
