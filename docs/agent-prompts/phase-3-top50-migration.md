# Phase 3 — Top 50 + n8n / Make / Zapier Migration

> เริ่มได้หลัง G2 ผ่าน (`phase-2-top30-triggers.md`)
> อ่าน `docs/agent-prompts/00-shared-context.md` ก่อน

## เป้าหมาย phase

1. เพิ่ม connector batch E/F อีก 20 services → รวม 50
2. ขยาย n8n importer ให้ map service nodes ได้มากขึ้น
3. เพิ่ม Make blueprint importer
4. เพิ่ม Zapier JSON importer (เท่าที่ export เปิดให้)
5. ทำ migration report + UI
6. ทำ long-tail catalog ผ่าน OpenAPI/MCP ให้เลือกใช้ได้

## Gate

- **G3:** 50 services, import ทั้ง 3 แพลตฟอร์ม + report, migration UI, tests ผ่าน

## Workstreams

### 3A — n8n importer + integration owner

**Agent ID:** `P3-N8N`

**Prompt:**

```text
คุณคือ Agent P3-N8N เจ้าของ n8n importer และ integration owner ของ Phase 3

อ่าน:
- packages/core/src/workflows/n8n-import.ts
- packages/core/src/test/*n8n*
- packages/core/src/test/fixtures/import/n8n/**
- packages/shared/src/connectors.ts
- packages/core/src/connectors/*

งาน:
1. ทำ mapping table: n8n node type → connector/operation
   - เริ่มจาก top 50 services
   - parameter mapping ที่พบบ่อย
   - credential → connection/account
2. ขยาย convertNode:
   - app node ที่ map ได้ → node 'connector' หรือ tool node ตามสถาปัตยกรรม
   - parameter ที่ map ไม่ได้ → report
   - credential ห้าม import; ให้ user เลือก connection เอง
3. คง behavior เดิม:
   - redaction
   - unsupported placeholder
   - AI sub-nodes
   - trigger import
4. ขยาย N8nImportReport:
   - mapped operations
   - connection ที่ต้องตั้ง
   - confidence/unsupported
5. Tests:
   - fixture top services
   - parameter mapping
   - secret redaction
   - unsupported report
6. เอกสาร docs/connectors/n8n-mapping.md

ขอบเขตไฟล์:
- packages/core/src/workflows/n8n-import.ts
- packages/core/src/test/n8n-import-*.test.ts
- packages/core/src/test/fixtures/import/n8n/**
- docs/connectors/n8n-mapping.md (new)
- packages/core/src/connectors/services/index.ts (integration owner)
- packages/core/src/core.ts / server.ts (เฉพาะ wiring import)

ห้าม:
- import credential จริง
- เดา parameter โดยไม่มี fallback/report
- ทำ importer อื่น (Make/Zapier)
- แก้ service files

Acceptance:
- typecheck/test ผ่าน
- n8n fixture ทุกตัว import ได้
- report แสดง mapped/unsupported/connection ครบ
- workflow เดิมที่ import ได้ยังทำงาน
```

**Owned files:** ตามรายการใน prompt

**Integration owner:** 3A รวม barrel + wiring + typecheck/test/build

---

### 3B — Make blueprint importer

**Agent ID:** `P3-MAKE`

**Prompt:**

```text
คุณคือ Agent P3-MAKE เจ้าของ Make blueprint importer

อ่าน:
- packages/core/src/workflows/n8n-import.ts (แนวทาง report/conversion)
- packages/core/src/test/fixtures/import/make/**
- docs/connectors/import-feasibility.md
- packages/shared/src/connectors.ts

งาน:
1. สร้าง packages/core/src/workflows/make-import.ts
   - parse Make blueprint JSON
   - อ่าน flow/modules/parameters/mapper/connections
   - map module → connector/operation เท่าที่มี mapping
   - trigger module → trigger_connector/trigger เดิม
   - unsupported module → placeholder + report
2. Report:
   - modules mapped
   - modules unsupported + reason
   - connections ที่ต้องตั้ง
   - secrets ที่ถูก redact
3. Tests:
   - blueprint fixture 2–3 แบบ
   - module ที่ map ไม่ได้
   - secret redaction
   - flow ที่มี router/filter
4. เอกสาร docs/connectors/make-import.md + ข้อจำกัด schema

ขอบเขตไฟล์:
- packages/core/src/workflows/make-import.ts (new)
- packages/core/src/test/make-import.test.ts (new)
- packages/core/src/test/fixtures/import/make/**
- docs/connectors/make-import.md (new)

ห้าม:
- แก้ n8n importer
- แก้ UI
- อ้างว่ารองรับ 100%
- import credential

Acceptance:
- typecheck/test ผ่าน
- fixture import ได้ workflow
- report ครบ
- ไม่มี secret
```

**Owned files:** ตามรายการใน prompt

---

### 3C — Zapier JSON importer

**Agent ID:** `P3-ZAPIER`

**Prompt:**

```text
คุณคือ Agent P3-ZAPIER เจ้าของ Zapier JSON importer

อ่าน:
- packages/core/src/workflows/n8n-import.ts
- packages/core/src/test/fixtures/import/zapier/**
- docs/connectors/import-feasibility.md
- packages/shared/src/connectors.ts

งาน:
1. สร้าง packages/core/src/workflows/zapier-import.ts
   - parse Zapier exported Zap JSON
   - map trigger/action steps → trigger/connector/tool
   - รองรับเฉพาะ format ที่ export ได้ (Team/Enterprise)
   - ถ้าไม่มี field ที่จำเป็น → report ไม่ throw
2. Report:
   - steps mapped
   - steps unsupported
   - connection ที่ต้องตั้ง
   - ข้อจำกัด: ไม่มี official public API สำหรับ export ทุก Zap
3. Tests:
   - fixture แบบ trigger + action
   - action ที่ map ไม่ได้
   - JSON ผิดรูปแบบ
   - secret redaction
4. เอกสาร docs/connectors/zapier-import.md

ขอบเขตไฟล์:
- packages/core/src/workflows/zapier-import.ts (new)
- packages/core/src/test/zapier-import.test.ts (new)
- packages/core/src/test/fixtures/import/zapier/**
- docs/connectors/zapier-import.md (new)

ห้าม:
- แก้ n8n/Make importer
- แก้ UI
- ใช้ undocumented API
- import credential

Acceptance:
- typecheck/test ผ่าน
- fixture import ได้
- report ระบุข้อจำกัดชัดเจน
- ไม่มี secret
```

**Owned files:** ตามรายการใน prompt

---

### 3D — Connector batch E

**Agent ID:** `P3-CONN-E`

**Prompt:**

```text
คุณคือ Agent P3-CONN-E เจ้าของ connector batch E (10 services)

สร้าง connector:
1. Microsoft Teams — list_teams, list_channels, send_message, list_messages
2. Excel (Microsoft Graph) — list_worksheets, read_range, write_range, add_row
3. Zoom — list_meetings, create_meeting, get_meeting, delete_meeting
4. Calendly — list_event_types, list_scheduled_events, create_invitee
5. Typeform — list_forms, get_form, list_responses
6. Box — list_folder, search, upload_file, download_file
7. Google Analytics — list_properties, run_report
8. Google Ads — list_campaigns, get_campaign, update_campaign_status
9. LINE — send_text, send_flex, list_followers
10. Zoho CRM — list_contacts, create_contact, list_deals, create_deal

ข้อกำหนด:
- หนึ่งไฟล์ต่อ service, export <service>Connector
- ไม่แก้ services/index.ts
- ระบุ auth จริง
- test fake fetch
- ระวัง rate limit/pagination
- รายงาน integration owner

Acceptance:
- typecheck/test ผ่าน
- ≥30 operations
- ไม่มี secret
- report ครบ
```

**Owned files:** `packages/core/src/connectors/services/{microsoft-teams,excel,zoom,calendly,typeform,box,google-analytics,google-ads,line,zoho-crm}.ts` (new), `packages/core/src/test/connector-batch-e.test.ts` (new)

---

### 3E — Connector batch F

**Agent ID:** `P3-CONN-F`

**Prompt:**

```text
คุณคือ Agent P3-CONN-F เจ้าของ connector batch F (10 services)

สร้าง connector:
1. Facebook Pages — list_pages, create_post, list_posts
2. Instagram — list_media, create_post, get_insights
3. LinkedIn — list_organizations, create_post, get_profile
4. X — create_post, list_posts, delete_post
5. YouTube — search, list_channel_videos, upload_video
6. Reddit — search, list_subreddit_posts, create_comment
7. Google Search Console — list_sites, query_search_analytics
8. Google Chat — list_spaces, send_message, list_messages
9. Google Slides — create_presentation, get_presentation, add_text
10. Google Classroom — list_courses, list_coursework, create_coursework

ข้อกำหนดเหมือน batch E:
- หนึ่งไฟล์ต่อ service
- export <service>Connector
- ไม่แก้ services/index.ts
- test fake fetch
- ระบุ auth/ข้อจำกัด (บาง API ต้อง review หรือมีค่าใช้จ่าย)
- report

Acceptance:
- typecheck/test ผ่าน
- ≥25 operations
- ไม่มี secret
- report ครบ
```

**Owned files:** `packages/core/src/connectors/services/{facebook,instagram,linkedin,x,youtube,reddit,google-search-console,google-chat,google-slides,google-classroom}.ts` (new), `packages/core/src/test/connector-batch-f.test.ts` (new)

---

### 3F — Migration UI

**Agent ID:** `P3-UI`

**Prompt:**

```text
คุณคือ Agent P3-UI เจ้าของ migration UI

อ่าน:
- packages/core/src/server/web/feature-workflows.js
- packages/core/src/server/web/app.css
- packages/core/src/workflows/n8n-import.ts
- packages/core/src/workflows/make-import.ts (ถ้ามี)
- packages/core/src/workflows/zapier-import.ts (ถ้ามี)

งาน:
1. Import dialog:
   - เลือก source: n8n / Make / Zapier
   - upload JSON
   - แสดง preview จำนวน workflow/nodes
2. Report UI:
   - mapped
   - unsupported + reason
   - connection ที่ต้องตั้ง
   - secret ที่ถูก redact
3. หลัง import:
   - workflow เริ่ม disabled
   - link ไปหน้าตั้งค่า connection
4. UX:
   - error ที่อ่านได้
   - ไม่ทำให้ import n8n เดิมพัง
5. docs/connectors/migration-ui.md

ขอบเขตไฟล์:
- packages/core/src/server/web/feature-workflows.js
- packages/core/src/server/web/app.css
- docs/connectors/migration-ui.md (new)

ห้าม:
- แก้ importer core
- แก้ server.ts
- hardcode ตัวอย่าง workflow
- import credential

Acceptance:
- UI import ได้ทั้ง 3 source ตาม fixture
- report แสดงครบ
- typecheck ผ่าน
- smoke checklist ผ่าน
```

**Owned files:** ตามรายการใน prompt

---

### 3G — Long-tail catalog + MCP/OpenAPI UI

**Agent ID:** `P3-LONGTAIL`

**Prompt:**

```text
คุณคือ Agent P3-LONGTAIL เจ้าของ long-tail catalog UI

อ่าน:
- packages/core/src/server/web/feature-tools.js
- packages/core/src/server/web/app.js
- packages/core/src/server/web/feature-workflows.js
- packages/core/src/mcp/hub.ts
- packages/core/src/connectors/openapi.ts
- packages/shared/src/connectors.ts

งาน:
1. Hub → Tools:
   - แสดง connector catalog แยก native / OpenAPI / MCP
   - ค้นหา/กรองตาม category
   - แสดงว่าตัวไหนต้องตั้ง connection
2. MCP:
   - จัดกลุ่ม tool ตาม server/service
   - แสดง tool count และ risk
3. OpenAPI:
   - ปุ่ม import spec (ถ้า core พร้อม)
   - preview operations ก่อน save
4. Quick Work:
   - long-tail tools ยังแสดงได้ ไม่ปนกับ native family
5. docs/connectors/longtail-ui.md

ขอบเขตไฟล์:
- packages/core/src/server/web/feature-tools.js
- packages/core/src/server/web/app.js
- docs/connectors/longtail-ui.md (new)

ห้าม:
- แก้ MCP hub/OpenAPI core
- แก้ server.ts
- ทำ native connector ใหม่
- hardcode catalog

Acceptance:
- catalog แสดง source ชัด
- MCP tools จัดกลุ่ม
- typecheck ผ่าน
- smoke checklist ผ่าน
```

**Owned files:** ตามรายการใน prompt

---

### 3H — Migration + catalog tests

**Agent ID:** `P3-TEST`

**Prompt:**

```text
คุณคือ Agent P3-TEST เจ้าของ test รวม Phase 3

อ่าน:
- packages/core/src/test/*import*.test.ts
- packages/core/src/test/connector-*.test.ts
- fixtures ทั้งหมด

งาน:
1. Test import ทั้ง 3 แพลตฟอร์ม:
   - happy path
   - unsupported
   - invalid JSON
   - secret redaction
   - connection report
2. Test 50 services:
   - unique keys
   - required auth
   - tool names
3. Regression:
   - n8n import เดิม
   - workflow ที่ import แล้วรันได้
4. รายงาน coverage gaps

ขอบเขตไฟล์:
- packages/core/src/test/connector-migration.test.ts (new)
- packages/core/src/test/fixtures/import/** (ขยาย)
- packages/core/src/test/connector-catalog.test.ts (new)

ห้าม:
- แก้ production code
- ยิง network จริง

Acceptance:
- test ผ่าน
- ครอบ 3 importer
- ไม่มี secret
```

**Owned files:** ตามรายการใน prompt

---

## Shared files / integration owner

Integration owner ของ Phase 3 คือ `P3-N8N` (3A)

ไฟล์กลางที่ห้าม agent อื่นแก้:

- `packages/shared/src/connectors.ts`
- `packages/core/src/core.ts`
- `packages/core/src/server/server.ts`
- `packages/core/src/connectors/services/index.ts`
- `packages/core/src/workflows/n8n-import.ts` (owner 3A)
- `packages/core/src/workflows/make-import.ts` (owner 3B)
- `packages/core/src/workflows/zapier-import.ts` (owner 3C)
- `packages/core/src/server/web/feature-workflows.js` (owner 3F)
- `packages/core/src/server/web/feature-tools.js` (owner 3G)

## ลำดับรันที่แนะนำ

```text
ต้น phase:
- 3D + 3E เขียน connector/test
- 3A/3B/3C ทำ importer คนละไฟล์
- 3F ทำ UI กับ fixture
- 3G ทำ catalog UI กับ mock

กลาง phase:
- 3A รวม barrel + wiring
- 3B/3C merge importer
- 3D/3E merge services
- 3F/3G merge UI
- 3H รัน test รวม

ท้าย phase:
- 3A รัน typecheck/test/build
```

## Phase exit criteria

- [ ] 50 services
- [ ] n8n importer map top services ได้ + report
- [ ] Make importer อ่าน blueprint ได้ + report
- [ ] Zapier importer อ่าน export ได้ + report
- [ ] migration UI ใช้ได้ทั้ง 3 source
- [ ] long-tail catalog + MCP grouping ใช้ได้
- [ ] contract/migration tests ผ่าน
- [ ] `npm run typecheck` ผ่าน
- [ ] `npm test` ผ่าน
- [ ] `npm run build:mac` ผ่าน
- [ ] ไม่มี secret ใน log/fixture/JSON

## Handoff ไป Phase 4

ส่งต่อ:

1. 50 services + operations
2. import coverage/mapping report
3. connection/auth ที่รองรับ
4. long-tail limitations
5. test gaps
6. integration requests
