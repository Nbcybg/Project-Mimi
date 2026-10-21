# Phase 4 — Reliability, Observability, Security, Release

> เริ่มได้หลัง G3 ผ่าน (`phase-3-top50-migration.md`)
> อ่าน `docs/agent-prompts/00-shared-context.md` ก่อน

## เป้าหมาย phase

1. ทำให้ workflow/connector รันพร้อมกันได้อย่างควบคุมได้
2. เพิ่ม idempotency สำหรับ trigger/retry ที่เสี่ยงทำงานซ้ำ
3. เพิ่ม observability: run history, node logs, trace, redaction
4. ทำ connector versioning + catalog update โดยไม่ทำ workflow เก่าพัง
5. ตรวจ security ทั้งระบบ connector
6. ทำ E2E/performance test และ release checklist

## Gate

- **G4:** reliability/security/performance ผ่าน, build ผ่าน, release checklist ครบ

## Workstreams

### 4A — Concurrency, queue, idempotency + integration owner

**Agent ID:** `P4-RUNTIME`

**Prompt:**

```text
คุณคือ Agent P4-RUNTIME integration owner ของ Phase 4

อ่าน:
- packages/core/src/workflows/runner.ts
- packages/core/src/workflows/workflow-store.ts
- packages/core/src/workflows/trigger-pool.ts
- packages/core/src/workflows/connector-triggers.ts
- packages/core/src/core.ts
- packages/core/src/server/server.ts
- packages/core/src/server/chat-api.ts (แนวทาง queue เดิม)

งาน:
1. Workflow execution queue:
   - จำกัด concurrency ต่อ agent/workflow
   - queue แบบ FIFO
   - abort/cancel
   - ไม่ block event loop
2. Idempotency:
   - webhook event id / poll cursor
   - retry ของ write operation ต้องมี idempotency key ถ้า provider รองรับ
   - เก็บ dedupe แบบมีขอบเขต/หมดอายุ
3. Timeout:
   - per-node timeout
   - per-run timeout
   - graceful error
4. Tests:
   - concurrency limit
   - queue order
   - cancel
   - duplicate webhook
   - retry write ไม่ทำซ้ำโดยไม่ตั้งใจ
5. อัปเดต docs/connectors/reliability.md

ขอบเขตไฟล์:
- packages/core/src/workflows/runner.ts
- packages/core/src/workflows/run-queue.ts (new)
- packages/core/src/workflows/idempotency.ts (new)
- packages/core/src/core.ts
- packages/core/src/server/server.ts
- packages/core/src/test/workflow-reliability.test.ts (new)
- docs/connectors/reliability.md (new)

ห้าม:
- เปลี่ยน behavior ของ chat queue เดิม
- retry write โดยไม่มี idempotency
- เพิ่ม dependency
- แก้ UI

Acceptance:
- typecheck/test ผ่าน
- concurrency/queue/cancel ทำงาน
- duplicate event ไม่รันซ้ำ
- ไม่มี secret ใน log
```

**Owned files:** ตามรายการใน prompt

**Integration owner:** 4A รวมงานและรัน build

---

### 4B — Observability + run history

**Agent ID:** `P4-OBS`

**Prompt:**

```text
คุณคือ Agent P4-OBS เจ้าของ observability

อ่าน:
- packages/core/src/workflows/run-history.ts
- packages/core/src/workflows/runner.ts
- packages/core/src/server/server.ts
- packages/core/src/server/web/feature-workflows.js
- packages/core/src/tools/registry.ts

งาน:
1. Run history:
   - เก็บ run id, workflow, agent, trigger, status, duration
   - node status/error/attempt
   - ขนาดจำกัด + rotate
2. Redaction:
   - ลบ token/secret/authorization จาก error/log
   - ใช้ allowlist field
3. Trace:
   - แสดง connector/operation
   - request id (ไม่ใช่ secret)
   - error code จาก provider
4. UI:
   - หน้า run detail
   - filter ตาม status/workflow
   - ปุ่ม copy error ที่ redact แล้ว
5. Tests:
   - redaction
   - history limit/rotate
   - node error
6. docs/connectors/observability.md

ขอบเขตไฟล์:
- packages/core/src/workflows/run-history.ts
- packages/core/src/server/web/feature-workflows.js
- packages/core/src/test/workflow-observability.test.ts (new)
- docs/connectors/observability.md (new)

หมายเหตุ: ถ้าต้องแก้ server.ts ให้ส่ง integration request ให้ 4A

ห้าม:
- เก็บ request body/header ที่มี secret
- เก็บ token
- ทำ log ใหญ่เกิน limit
- แก้ runtime queue

Acceptance:
- typecheck/test ผ่าน
- run detail แสดง connector/operation
- ไม่มี secret ใน history/log
```

**Owned files:** ตามรายการใน prompt

---

### 4C — Connector versioning + catalog lifecycle

**Agent ID:** `P4-VERSION`

**Prompt:**

```text
คุณคือ Agent P4-VERSION เจ้าของ connector versioning

อ่าน:
- packages/shared/src/connectors.ts
- packages/core/src/connectors/registry.ts
- packages/core/src/connectors/runtime.ts
- packages/core/src/workflows/workflow-store.ts

งาน:
1. เพิ่ม version ใน ConnectorSpec
2. Runtime รองรับหลาย version:
   - workflow เก่าอ้าง version เดิม
   - new workflow ใช้ version ใหม่
   - migration/deprecation warning
3. Registry:
   - list versions
   - validate duplicate
   - fallback/default version
4. UI/state ส่ง version ให้ editor
5. Tests:
   - workflow เก่ายังรันได้หลัง connector update
   - operation ที่ถูกลบ → error ที่อ่านได้
   - deprecation warning
6. docs/connectors/versioning.md

ขอบเขตไฟล์:
- packages/shared/src/connectors.ts
- packages/core/src/connectors/registry.ts
- packages/core/src/connectors/runtime.ts
- packages/core/src/test/connector-versioning.test.ts (new)
- docs/connectors/versioning.md (new)

ห้าม:
- ลบ operation โดยไม่มี migration path
- เปลี่ยนชื่อ tool เดิมแบบเงียบ
- แก้ UI
- แก้ queue

Acceptance:
- typecheck/test ผ่าน
- workflow เก่าไม่พัง
- deprecation/migration ชัดเจน
```

**Owned files:** ตามรายการใน prompt

---

### 4D — Security audit + hardening

**Agent ID:** `P4-SECURITY`

**Prompt:**

```text
คุณคือ Agent P4-SECURITY เจ้าของ security review

อ่าน:
- packages/core/src/connectors/runtime.ts
- packages/core/src/connectors/openapi.ts
- packages/core/src/oauth/*
- packages/core/src/workflows/net-guard.ts
- packages/core/src/workflows/runner.ts
- packages/core/src/tools/custom-tools.ts
- packages/core/src/mcp/hub.ts
- packages/shared/src/tools.ts
- docs/connectors/contract.md

งาน:
1. ตรวจ SSRF:
   - connector base URL / OpenAPI server URL
   - redirect ไป internal
   - DNS rebinding
   - HTTP node allowLocal
2. ตรวจ secret handling:
   - vault
   - token file permission
   - log/error/run history
   - import redaction
3. ตรวจ auth:
   - OAuth state/PKCE
   - refresh race
   - token revocation/removal
4. ตรวจ permission:
   - risk mapping
   - untrustedInput + shell
   - workflow tool consent
   - MCP risk default
5. เขียน security test:
   - SSRF blocked
   - secret ไม่หลุด
   - permission bypass ไม่ได้
6. เขียน docs/connectors/security-review.md พร้อม severity + fix owner

ขอบเขตไฟล์:
- packages/core/src/test/connector-security.test.ts (new)
- docs/connectors/security-review.md (new)
- แก้เฉพาะ security bug ที่อยู่ในไฟล์ที่ได้รับมอบหมาย:
  - packages/core/src/connectors/runtime.ts
  - packages/core/src/workflows/net-guard.ts
  - packages/core/src/oauth/*
  - packages/core/src/tools/custom-tools.ts

ห้าม:
- แก้ behavior ที่ไม่เกี่ยวกับ security
- เก็บ secret ใน test
- ยิง network จริง
- ทำ refactor กว้าง

Acceptance:
- security tests ผ่าน
- ไม่มี critical/high ที่ไม่มี owner
- secret/SSRF/permission ครอบคลุม
```

**Owned files:** ตามรายการใน prompt

**หมายเหตุ:** ถ้า fix ต้องแตะไฟล์ของ 4A/4B/4C ให้ส่ง integration request

---

### 4E — E2E + performance

**Agent ID:** `P4-E2E`

**Prompt:**

```text
คุณคือ Agent P4-E2E เจ้าของ E2E/performance test

อ่าน:
- packages/core/src/test/*
- packages/core/src/workflows/runner.ts
- packages/core/src/connectors/*
- scripts/

งาน:
1. E2E:
   - สร้าง workflow ด้วย connector node
   - trigger → connector → if → tool → respond
   - error workflow
   - import → run
2. Performance:
   - 50 connectors โหลด/ลงทะเบียน
   - workflow 100 nodes
   - 1,000 items
   - pagination หลายหน้า
   - วัดเวลา/memory แบบคร่าว ๆ
3. Stress:
   - concurrency queue
   - rate limit
   - timeout
4. รายงานผลใน docs/connectors/performance.md
5. ถ้าเจอบั๊ก ให้รายงาน owner ไม่แก้ production เอง

ขอบเขตไฟล์:
- packages/core/src/test/e2e/** (new)
- packages/core/src/test/connector-performance.test.ts (new)
- docs/connectors/performance.md (new)

ห้าม:
- ยิง API จริง
- ใช้เวลานานเกิน 60s ต่อ test
- แก้ production code
- ผูก test กับเวลาจริงแบบเปราะ

Acceptance:
- E2E ผ่าน
- performance test รันได้ใน CI/local
- รายงานตัวเลขและ bottleneck
```

**Owned files:** ตามรายการใน prompt

---

### 4F — Docs, templates, release checklist

**Agent ID:** `P4-RELEASE`

**Prompt:**

```text
คุณคือ Agent P4-RELEASE เจ้าของ docs/release

อ่าน:
- README ถ้ามี
- CHANGELOG.md
- docs/connectors/*
- docs/agent-prompts/*
- package.json

งาน:
1. อัปเดต docs ให้ตรงกับ connector platform:
   - วิธีเพิ่ม connector ใหม่
   - auth/connection
   - trigger
   - import
   - troubleshooting
2. เพิ่ม template connector:
   - docs/connectors/template-service.md
   - ตัวอย่าง spec + test checklist
3. Release checklist:
   - typecheck/test/build
   - migration
   - secret scan
   - compatibility
4. อัปเดต CHANGELOG.md เฉพาะหัวข้อที่มีจริง
5. ห้ามสร้างเอกสารซ้ำซ้อนกับ docs/connectors/contract.md

ขอบเขตไฟล์:
- docs/connectors/*.md
- CHANGELOG.md
- docs/connectors/template-service.md (new)

ห้าม:
- แก้โค้ด production
- อ้างว่ารองรับสิ่งที่ยังไม่ทำ
- ใส่ secret/ตัวอย่าง token จริง

Acceptance:
- docs ครอบคลุมการเพิ่ม connector
- checklist ใช้ได้จริง
- ไม่มีข้อมูลเท็จ
```

**Owned files:** ตามรายการใน prompt

---

## Shared files / integration owner

Integration owner ของ Phase 4 คือ `P4-RUNTIME` (4A)

ไฟล์กลางที่ห้าม agent อื่นแก้:

- `packages/shared/src/connectors.ts` (owner 4C)
- `packages/core/src/core.ts`
- `packages/core/src/server/server.ts`
- `packages/core/src/workflows/runner.ts`
- `packages/core/src/connectors/runtime.ts` (owner 4C/4D เฉพาะ security)
- `packages/core/src/server/web/feature-workflows.js` (owner 4B)
- `packages/core/src/workflows/run-history.ts` (owner 4B)

## ลำดับรันที่แนะนำ

```text
ต้น phase:
- 4A queue/idempotency
- 4B observability
- 4C versioning
- 4D security audit (ขนาน)
- 4E E2E/perf (ขนาน)
- 4F docs

กลาง phase:
- 4A/4B/4C merge
- 4D ส่ง fix/integration request
- 4E รัน E2E/perf
- 4F อัปเดต docs

ท้าย phase:
- 4A รัน typecheck/test/build
- 4D ปิด critical/high
- 4E ยืนยัน performance
- 4F ปิด release checklist
```

## Phase exit criteria

- [ ] concurrency/queue/cancel ทำงาน
- [ ] idempotency สำหรับ webhook/retry
- [ ] run history + redaction
- [ ] connector versioning ไม่ทำ workflow เก่าพัง
- [ ] security critical/high = 0 หรือมี owner/แผนชัด
- [ ] E2E + performance ผ่าน
- [ ] docs/template/release checklist ครบ
- [ ] `npm run typecheck` ผ่าน
- [ ] `npm test` ผ่าน
- [ ] `npm run build:mac` ผ่าน
- [ ] ไม่มี secret ใน log/fixture/JSON

## Release handoff

ส่งต่อ:

1. สรุป 50 services + operations
2. import coverage
3. performance ตัวเลข
4. security findings ที่เหลือ
5. build artifact
6. ข้อจำกัดที่ต้องสื่อสารกับ user
