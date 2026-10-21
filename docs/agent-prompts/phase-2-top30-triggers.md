# Phase 2 — Top 30, Triggers, Runtime Hardening, OpenAPI Import

> เริ่มได้หลัง G1 ผ่าน (`phase-1-platform-top10.md`)
> อ่าน `docs/agent-prompts/00-shared-context.md` ก่อน

## เป้าหมาย phase

1. เพิ่ม connector batch C/D อีก 20 services → รวม 30
2. เพิ่ม trigger framework สำหรับ connector (webhook + poll)
3. ทำ pagination, rate limit, retry/backoff ใน runtime
4. ทำ OpenAPI 3.x import ขั้นต้น → connector draft
5. ทำ UI สำหรับ trigger config, dynamic options, test connection
6. รักษา test/typecheck/build ที่ผ่านอยู่

## Gate

- **G2:** 30 services, triggers ใช้ได้, pagination/rate limit, OpenAPI import MVP, tests ผ่าน

## Workstreams

### 2A — Trigger framework + integration owner

**Agent ID:** `P2-TRIGGERS`

**Prompt:**

```text
คุณคือ Agent P2-TRIGGERS integration owner ของ Phase 2

อ่าน:
- packages/shared/src/workflows.ts
- packages/core/src/workflows/workflow-store.ts
- packages/core/src/workflows/trigger-pool.ts
- packages/core/src/workflows/runner.ts
- packages/core/src/server/server.ts
- packages/core/src/core.ts
- packages/core/src/scheduler/*
- docs/connectors/contract.md

งาน:
1. เพิ่ม generic connector trigger:
   - NodeTypeName 'trigger_connector' หรือชื่อที่สอดคล้อง contract
   - config: connector, trigger, account, input
   - รองรับทั้ง webhook และ poll
   - เพิ่มใน NODE_TYPES, workflow-store NODE_TYPES, isTriggerNodeType/trigger pool
2. Trigger runtime:
   - webhook: route รับ event, verify signature ถ้า provider รองรับ, map เป็น items
   - poll: ใช้ scheduler เดิม, cursor/seen ids, ไม่ยิงซ้ำ
   - test trigger ด้วย fake fetch/fake clock
3. ส่ง trigger metadata จาก connector ไป UI
4. Wiring:
   - core.ts สร้าง trigger runtime
   - server.ts route webhook ของ connector
   - คง trigger เดิมทั้งหมด
5. Tests:
   - webhook happy path + signature failure
   - poll dedupe/cursor
   - workflow trigger validation
   - existing trigger tests ผ่าน

ขอบเขตไฟล์:
- packages/shared/src/workflows.ts
- packages/core/src/workflows/workflow-store.ts
- packages/core/src/workflows/trigger-pool.ts
- packages/core/src/workflows/connector-triggers.ts (new)
- packages/core/src/workflows/runner.ts
- packages/core/src/core.ts
- packages/core/src/server/server.ts
- packages/core/src/connectors/trigger-adapter.ts (new)
- packages/core/src/test/connector-triggers.test.ts (new)


ห้าม:
- แก้ service connector files
- แก้ UI
- เปลี่ยน behavior ของ trigger เดิม
- เพิ่ม dependency

Acceptance:
- npm run typecheck ผ่าน
- trigger tests + existing workflow tests ผ่าน
- webhook/poll ทำงานกับ connector อย่างน้อย 1 ตัว
- ไม่มี secret ใน log
```

**Owned files:** ตามรายการใน prompt (แก้ path ให้ถูกจริง)

**Integration owner:** 2A เป็นผู้รวมงาน Phase 2

---

### 2B — Runtime hardening: pagination, rate limit, retry

**Agent ID:** `P2-RUNTIME`

**Prompt:**

```text
คุณคือ Agent P2-RUNTIME เจ้าของ runtime hardening

อ่าน:
- packages/shared/src/connectors.ts
- packages/core/src/connectors/runtime.ts
- packages/core/src/connectors/registry.ts
- docs/connectors/contract.md

งาน:
1. Pagination:
   - page/pageSize
   - cursor
   - nextPageToken
   - Link header
   - maxPages/maxItems safety limit
   - response.itemsPath + nextPath
2. Rate limit:
   - token bucket ต่อ connector
   - burst
   - เคารพ Retry-After
   - ไม่ block event loop
3. Retry:
   - retry เฉพาะ 408/429/5xx/network
   - exponential backoff + jitter
   - max attempts
   - ไม่ retry ถ้า risk เป็น write/delete เว้นแต่ operation ระบุ idempotent
4. Error normalization:
   - provider error code/message
   - ห้าม leak token/header
5. Tests:
   - pagination ทุก mode
   - rate limit
   - retry/backoff ด้วย fake clock
   - non-retryable error
6. อัปเดต docs/connectors/runtime.md

ขอบเขตไฟล์:
- packages/core/src/connectors/runtime.ts
- packages/core/src/connectors/pagination.ts (new)
- packages/core/src/connectors/rate-limit.ts (new)
- packages/core/src/test/connector-pagination.test.ts (new)
- packages/core/src/test/connector-rate-limit.test.ts (new)
- docs/connectors/runtime.md (new)

ห้าม:
- แก้ trigger framework
- แก้ connector service files
- เพิ่ม dependency
- retry write โดยไม่มีการระบุ idempotent

Acceptance:
- typecheck/test ผ่าน
- pagination ทำงานกับ fake API
- rate limit/retry ไม่ทำให้ test ค้าง
- ไม่มี secret ใน error
```

**Owned files:** ตามรายการใน prompt

**Dependency:** ใช้ runtime จาก Phase 1; ทำขนานกับ 2A ได้

---

### 2C — OpenAPI import MVP

**Agent ID:** `P2-OPENAPI`

**Prompt:**

```text
คุณคือ Agent P2-OPENAPI เจ้าของ OpenAPI import MVP

อ่าน:
- packages/shared/src/connectors.ts
- packages/core/src/connectors/*
- packages/core/src/workflows/n8n-import.ts (แนวทาง report)
- package.json (มี yaml อยู่แล้ว)

งาน:
1. สร้าง packages/core/src/connectors/openapi.ts
   - parse OpenAPI 3.x JSON/YAML
   - อ่าน servers, paths, methods, parameters, requestBody, responses
   - map เป็น ConnectorSpec draft
   - auth: apiKey/basic/bearer/oauth2 เท่าที่ spec ระบุ
   - operation key จาก operationId หรือ method+path
   - field จาก parameters/requestBody schema (รองรับ basic types)
2. สร้าง report:
   - operations ที่ map ได้
   - fields ที่ unsupported
   - security scheme ที่ยังไม่รองรับ
3. Safety:
   - validate server URL (https, ไม่ใช่ localhost โดย default)
   - ไม่ execute อะไรตอน import
   - ไม่เก็บ secret จาก spec
4. Tests:
   - petstore-style fixture
   - unsupported schema
   - invalid spec
5. เอกสาร docs/connectors/openapi-import.md

ขอบเขตไฟล์:
- packages/core/src/connectors/openapi.ts (new)
- packages/core/src/test/connector-openapi.test.ts (new)
- packages/core/src/test/fixtures/openapi/** (new)
- docs/connectors/openapi-import.md (new)

ห้าม:
- แก้ runtime/registry (ใช้ interface ที่มี)
- แก้ UI
- รองรับ Swagger 2.0 ใน MVP
- เก็บ secret

Acceptance:
- typecheck/test ผ่าน
- import fixture ได้ ConnectorSpec draft
- report บอก unsupported ครบ
- ไม่มี network call
```

**Owned files:** ตามรายการใน prompt

**Dependency:** ใช้ contract/runtime จาก Phase 1

---

### 2D — Connector batch C

**Agent ID:** `P2-CONN-C`

**Prompt:**

```text
คุณคือ Agent P2-CONN-C เจ้าของ connector batch C (10 services)

อ่าน:
- docs/connectors/contract.md
- packages/core/src/connectors/services/slack.ts
- packages/core/src/connectors/runtime.ts

สร้าง connector:
1. Jira — list_projects, search_issues, create_issue, update_issue, add_comment
2. Trello — list_boards, list_lists, list_cards, create_card, update_card
3. Asana — list_workspaces, list_projects, list_tasks, create_task, complete_task
4. ClickUp — list_spaces, list_lists, list_tasks, create_task, update_task
5. Monday — list_boards, list_items, create_item, update_item
6. Linear — list_teams, list_issues, create_issue, update_issue, add_comment
7. Todoist — list_projects, list_tasks, create_task, complete_task
8. Dropbox — list_folder, search, upload_file, download_file
9. OpenAI — list_models, create_response, create_embedding
10. Google Drive (expand) — list_files, get_file, create_folder, move_file, delete_file

ข้อกำหนด:
- หนึ่งไฟล์ต่อ service, export <service>Connector
- ไม่แก้ services/index.ts
- ระบุ auth ที่ใช้จริง (API key/OAuth2/PAT)
- risk/untrustedInput ถูกต้อง
- response.itemsPath ถูกต้อง
- test fake fetch ต่อ service
- ระบุ pagination/rate limit ที่ยังไม่พร้อม

Acceptance:
- typecheck/test ผ่าน
- ≥40 operations
- ไม่มี tool name ชน
- ไม่มี secret
- report ให้ 2A เรื่อง barrel และ trigger metadata
```

**Owned files:**

- `packages/core/src/connectors/services/jira.ts` (new)
- `packages/core/src/connectors/services/trello.ts` (new)
- `packages/core/src/connectors/services/asana.ts` (new)
- `packages/core/src/connectors/services/clickup.ts` (new)
- `packages/core/src/connectors/services/monday.ts` (new)
- `packages/core/src/connectors/services/linear.ts` (new)
- `packages/core/src/connectors/services/todoist.ts` (new)
- `packages/core/src/connectors/services/dropbox.ts` (new)
- `packages/core/src/connectors/services/openai.ts` (new)
- `packages/core/src/connectors/services/google-drive.ts` (new/expand)
- `packages/core/src/test/connector-batch-c.test.ts` (new)

---

### 2E — Connector batch D

**Agent ID:** `P2-CONN-D`

**Prompt:**

```text
คุณคือ Agent P2-CONN-D เจ้าของ connector batch D (10 services)

สร้าง connector:
1. Salesforce — search, list_contacts, create_contact, list_opportunities, update_opportunity
2. Pipedrive — list_persons, create_person, list_deals, create_deal, update_deal
3. Shopify — list_products, get_product, list_orders, create_order, update_inventory
4. WooCommerce — list_products, create_product, list_orders, update_order
5. WordPress — list_posts, create_post, update_post, upload_media
6. Mailchimp — list_lists, add_member, list_campaigns, create_campaign
7. SendGrid — send_email, list_templates, get_stats
8. Twilio — send_sms, list_messages, get_message
9. WhatsApp (Meta Graph) — send_text, send_template, list_templates
10. Supabase — select_rows, insert_rows, update_rows, delete_rows

ข้อกำหนดเหมือน batch C:
- หนึ่งไฟล์ต่อ service
- export <service>Connector
- ไม่แก้ services/index.ts
- test fake fetch
- ระบุ auth/ข้อจำกัด
- ระวัง rate limit และ pagination

Acceptance:
- typecheck/test ผ่าน
- ≥35 operations
- ไม่มี tool name ชน
- ไม่มี secret
- report ให้ integration owner
```

**Owned files:**

- `packages/core/src/connectors/services/salesforce.ts` (new)
- `packages/core/src/connectors/services/pipedrive.ts` (new)
- `packages/core/src/connectors/services/shopify.ts` (new)
- `packages/core/src/connectors/services/woocommerce.ts` (new)
- `packages/core/src/connectors/services/wordpress.ts` (new)
- `packages/core/src/connectors/services/mailchimp.ts` (new)
- `packages/core/src/connectors/services/sendgrid.ts` (new)
- `packages/core/src/connectors/services/twilio.ts` (new)
- `packages/core/src/connectors/services/whatsapp.ts` (new)
- `packages/core/src/connectors/services/supabase.ts` (new)
- `packages/core/src/test/connector-batch-d.test.ts` (new)

---

### 2F — Trigger/UI + optionsFrom

**Agent ID:** `P2-UI`

**Prompt:**

```text
คุณคือ Agent P2-UI เจ้าของ UI ของ Phase 2

อ่าน:
- packages/core/src/server/web/feature-workflows.js
- packages/core/src/server/web/feature-agent-tools.js
- packages/core/src/server/web/app.css
- packages/shared/src/connectors.ts

งาน:
1. Trigger UI:
   - เลือก connector trigger
   - แสดง field ตาม ConnectorTrigger
   - webhook URL/secret
   - poll interval
   - sample output
2. Operation UI:
   - optionsFrom โหลดตัวเลือกจริง
   - dependsOn reset ค่าที่ไม่เกี่ยว
   - test connection/test operation
3. แสดงสถานะ auth/connection ที่ขาด
4. Quick Work:
   - family จาก connector metadata
   - filter ตาม category
5. CSS responsive
6. docs/connectors/ui-smoke-phase2.md

ขอบเขตไฟล์:
- packages/core/src/server/web/feature-workflows.js
- packages/core/src/server/web/feature-agent-tools.js
- packages/core/src/server/web/feature-tools.js
- packages/core/src/server/web/app.css
- docs/connectors/ui-smoke-phase2.md (new)

ห้าม:
- แก้ core/server/runtime
- hardcode operation
- ทำ layout เดิมพัง

Acceptance:
- trigger config ใช้งานได้
- optionsFrom ใช้งานได้กับอย่างน้อย 1 service
- typecheck ผ่าน
- smoke checklist ครบ
```

**Owned files:** ตามรายการใน prompt

---

### 2G — Contract + integration tests

**Agent ID:** `P2-TEST`

**Prompt:**

```text
คุณคือ Agent P2-TEST เจ้าของ test รวมของ Phase 2

อ่าน:
- packages/core/src/test/connector-*.test.ts
- packages/core/src/connectors/services/*
- docs/connectors/contract.md

งาน:
1. ขยาย contract test ให้ครอบทุก connector:
   - unique keys/tool names
   - auth completeness
   - field types
   - risk/untrusted
   - pagination config ถ้ามี
   - trigger metadata
2. Integration test:
   - tool adapter → runtime → fake API
   - connector node → runtime
   - trigger webhook/poll → workflow
   - pagination หลายหน้า
3. Regression test:
   - Gmail/Sheets/Outlook tools ยังทำงาน
   - preset เดิมยังใช้ได้
4. รายงานช่องว่างที่ test ยังครอบไม่ได้

ขอบเขตไฟล์:
- packages/core/src/test/connector-phase2.test.ts (new)
- packages/core/src/test/fixtures/connectors/** (ขยาย)
- packages/core/src/test/helpers/fake-fetch.ts

ห้าม:
- แก้ production code
- ยิง network จริง

Acceptance:
- test ผ่าน
- ครอบ 30 services ตามที่ merge แล้ว
- ไม่มี secret
```

**Owned files:** ตามรายการใน prompt

---

## Shared files / integration owner

Integration owner ของ Phase 2 คือ `P2-TRIGGERS` (2A)

ไฟล์กลางที่ห้าม agent อื่นแก้:

- `packages/shared/src/connectors.ts`
- `packages/shared/src/workflows.ts`
- `packages/core/src/core.ts`
- `packages/core/src/server/server.ts`
- `packages/core/src/workflows/runner.ts`
- `packages/core/src/workflows/workflow-store.ts`
- `packages/core/src/connectors/services/index.ts`
- `packages/core/src/connectors/runtime.ts` (owner 2B)
- UI web files (owner 2F)

## ลำดับรันที่แนะนำ

```text
ต้น phase:
- 2D + 2E เขียน connector/test
- 2B ทำ runtime hardening
- 2C ทำ OpenAPI import
- 2A ทำ trigger framework
- 2F ทำ UI กับ mock

กลาง phase:
- 2A รวม barrel + trigger routes
- 2B merge runtime
- 2D/2E merge service files
- 2F merge UI
- 2G รัน contract/integration tests

ท้าย phase:
- 2A รัน typecheck/test/build
```

## Phase exit criteria

- [ ] 30 services (10 เดิม + 20 ใหม่)
- [ ] ≥150 operations
- [ ] connector trigger webhook/poll ใช้ได้
- [ ] pagination 4 modes + rate limit + retry
- [ ] OpenAPI import MVP ใช้งานได้
- [ ] optionsFrom + trigger UI ใช้ได้
- [ ] contract/integration tests ผ่าน
- [ ] `npm run typecheck` ผ่าน
- [ ] `npm test` ผ่าน
- [ ] `npm run build:mac` ผ่าน
- [ ] ไม่มี secret ใน log/fixture/JSON

## Handoff ไป Phase 3

ส่งต่อ:

1. รายการ 30 services + operations
2. trigger ที่รองรับ
3. runtime capabilities/limits
4. OpenAPI import limitations
5. test coverage gaps
6. integration requests
