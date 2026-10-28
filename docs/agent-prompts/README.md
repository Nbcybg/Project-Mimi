# Agent Prompts — Connector Parity Roadmap

ชุด prompt สำหรับแบ่งงานให้ agent หลายตัวทำพร้อมกัน เพื่อพา Mimi ไปสู่ parity กับ n8n / Make / Zapier แบบเป็นเฟส

## ไฟล์ในชุดนี้

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `00-shared-context.md` | กติกากลาง, สถาปัตยกรรม, contract, invariants, คำสั่งทดสอบ — **ทุก agent ต้องอ่านก่อน** |
| `phase-0-foundation.md` | Freeze contract + vertical slice + import feasibility |
| `phase-1-platform-top10.md` | Connector platform + 10 services + generic OAuth2 + service node UI |
| `phase-2-top30-triggers.md` | Top 30 + trigger framework + pagination/rate limit + OpenAPI import |
| `phase-3-top50-migration.md` | Top 50 + n8n/Make/Zapier import + migration report |
| `phase-4-reliability.md` | Reliability, observability, versioning, security, performance |
| `phase-5-cloud-accounts.md` | Cloud core บน Railway, บัญชีผู้ใช้, แอป thin client (prompt เดิมของ Phase 5) |
| `phase-5-continue.md` | สถานะ Phase 5 ณ 2026-10-27 + prompt สำหรับทำต่อ (ใช้ไฟล์นี้เมื่อเริ่ม agent ใหม่) |

## วิธีใช้

1. เปิด agent ใหม่หนึ่งตัวต่อ **workstream** ไม่ใช่หนึ่งตัวต่อ phase
2. ให้ agent อ่าน `docs/agent-prompts/00-shared-context.md` ทั้งไฟล์
3. ให้ agent อ่านเฉพาะ workstream ของตัวเองใน phase file
4. ระบุ `Agent ID` และไฟล์ที่ agent เป็นเจ้าของให้ชัดเจน
5. ใช้ prompt ด้านล่างเป็น wrapper:

```text
คุณคือ Agent <ID> ในงาน Connector Parity ของ Mimi

ก่อนเริ่ม:
- อ่าน docs/agent-prompts/00-shared-context.md ทั้งไฟล์
- อ่าน docs/agent-prompts/<phase-file>.md เฉพาะ workstream <ID>
- ตรวจไฟล์จริงใน repo ก่อนแก้

ขอบเขต:
- เขียนได้เฉพาะไฟล์ที่ระบุใน "Owned files"
- ห้ามแก้ไฟล์ของ agent อื่น
- ห้ามแตะ dist/, node_modules/, .env, token จริง
- ห้าม commit เว้นแต่ orchestrator สั่ง

ส่งงาน:
- ทำตาม Acceptance ใน workstream
- รันคำสั่งทดสอบที่กำหนด
- รายงานตามรูปแบบท้าย 00-shared-context.md
```

## Prompt สำหรับ orchestrator

```text
คุณคือ Orchestrator ของงาน Connector Parity

เป้าหมาย: พา Mimi จาก Phase 0 ถึง Phase 4 ตาม docs/agent-prompts/README.md

กติกา:
- หนึ่ง workstream = หนึ่ง agent
- agent ต้องอ่าน 00-shared-context.md และ phase file ก่อนเริ่ม
- ห้ามให้ agent สองตัวแก้ไฟล์เดียวกัน
- ไฟล์กลางเป็นของ integration owner เท่านั้น
- ทุก phase ต้องผ่าน gate ก่อนเริ่ม phase ถัดไป
- ตรวจ report ของทุก agent ก่อน merge
- รัน npm run typecheck และ npm test ที่ทุก gate
- รัน npm run build:mac ที่ G1/G2/G3/G4
- ห้าม commit เว้นแต่ user สั่ง

ลำดับเริ่ม:
1. เปิด P0-CONTRACT, P0-AUTH, P0-IMPORT พร้อมกัน
2. เมื่อ contract freeze เปิด P0-RUNTIME และ P0-INTEGRATE
3. รวมงาน ตรวจ G0 แล้วเริ่ม Phase 1 ตาม workstream 1A–1F
4. ทำต่อ Phase 2, 3, 4 ตาม dependency

การรายงาน:
- agent ส่งรายงานตามรูปแบบใน 00-shared-context
- orchestrator สรุปสถานะ: done / blocked / integration request
- ถ้า contract ขัดกับโค้ดจริง ให้หยุดและถาม user ก่อนเดา
```

## ลำดับและ dependency

```text
Phase 0A Contract
   ├── Phase 0B Auth research        (ขนานได้ทันที)
   ├── Phase 0D Import feasibility   (ขนานได้ทันที)
   └── Phase 0C Slack vertical slice (หลัง 0A freeze)

Phase 1A Runtime/Registry ──┐
Phase 1B Generic OAuth2 ─────┤
Phase 1C Service node UI ────┼──> Phase 2
Phase 1D Connector batch A ──┤
Phase 1E Connector batch B ──┘

Phase 2A Triggers ───────────┐
Phase 2B Runtime hardening ──┤
Phase 2C OpenAPI import ─────┼──> Phase 3
Phase 2D/2E Connector batches┘
Phase 2F Trigger UI ─────────┘

Phase 3A/3B/3C Importers ────┐
Phase 3D/3E Connector batches┼──> Phase 4
Phase 3F Migration UI ───────┘

Phase 4A–4F (ขนานกันได้ตาม file ownership)
```

## จำนวน agent ที่แนะนำต่อ phase

| Phase | Workstreams | หมายเหตุ |
|---|---:|---|
| 0 | 5 | 0A ต้องเสร็จก่อน 0C1/0C2; 0B/0D ขนานได้ทันที |
| 1 | 6 | 1A/1B/1C/1D/1E/1F ขนานได้หลัง G0 |
| 2 | 7 | 2A/2B/2C/2D/2E/2F/2G; 2A เป็น integration owner |
| 3 | 8 | 3A–3H; importer คนละไฟล์และ connector batch คนละไฟล์ |
| 4 | 6 | 4A–4F; 4D/4E เป็น read-only/ทดสอบเป็นหลัก |

## กติกาการทำพร้อมกัน

### 1. หนึ่งไฟล์ มีเจ้าของคนเดียว

ห้าม agent สองตัวแก้ไฟล์เดียวกันพร้อมกัน โดยเฉพาะ:

- `packages/shared/src/connectors.ts`
- `packages/shared/src/tools.ts`
- `packages/shared/src/protocol.ts`
- `packages/shared/src/workflows.ts`
- `packages/core/src/core.ts`
- `packages/core/src/workflows/runner.ts`
- `packages/core/src/server/server.ts`
- `packages/core/src/server/web/feature-workflows.js`
- `packages/core/src/server/web/feature-agent-tools.js`
- `packages/core/src/server/web/app.css`
- `packages/core/src/connectors/services/index.ts`

ถ้าจำเป็นต้องแก้ไฟล์กลาง ให้ส่ง “integration request” ถึง integration owner ไม่แก้เอง

### 2. Contract freeze ก่อน

Phase 0A ต้อง freeze `packages/shared/src/connectors.ts` ก่อน agent อื่นเริ่มเขียน runtime/connectors
หลัง freeze แล้ว การเปลี่ยน contract ต้องแจ้งทุก agent และอัปเดตเวอร์ชันในเอกสาร

### 3. Integration owner

แต่ละ phase มี integration owner 1 คน ทำหน้าที่:

- รวมงานจาก workstream อื่น
- แก้ไฟล์กลาง (`core.ts`, `server.ts`, `runner.ts`, barrel)
- รัน typecheck/test รวม
- อัปเดต contract และแจ้ง breaking change

### 4. Merge order

1. Contract / shared types
2. Runtime + auth
3. Connector service files
4. Tool/workflow adapter + wiring
5. UI
6. Tests/fixtures
7. Docs

### 5. ห้ามทำสิ่งเหล่านี้

- ห้ามเดา API response โดยไม่มี fixture หรือเอกสาร
- ห้ามยิง API จริงใน test
- ห้ามใส่ token/secret ลง fixture, log, workflow JSON
- ห้ามเปลี่ยนชื่อ tool เดิมหรือลบ preset ของ user
- ห้ามสร้าง `NodeTypeName` ใหม่หนึ่งตัวต่อ service
- ห้ามใช้ browser automation แทน API integration

## Gate ระหว่าง phase

| Gate | ต้องผ่านก่อนไป phase ถัดไป |
|---|---|
| G0 | Contract freeze, Slack vertical slice ผ่าน, typecheck/test ผ่าน |
| G1 | 10 services, generic OAuth2, service node, Quick Work grouping, tests ผ่าน |
| G2 | 30 services, triggers, pagination/rate limit, OpenAPI import, tests ผ่าน |
| G3 | 50 services, import reports, migration UI, tests ผ่าน |
| G4 | Reliability/security/performance ผ่าน, build ผ่าน |

## หมายเหตุเรื่องจำนวน

Roadmap นี้ไม่ได้สัญญาว่าจะมี native connector ครบ 2,000–9,000 apps
เป้าหมายคือ top 50–100 native + long-tail ผ่าน OpenAPI/MCP/HTTP
