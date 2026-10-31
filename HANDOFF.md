# Mimi handoff — 2026-10-31

## สถานะ

- Typecheck ผ่านทั้ง `shared`, `pc-agent`, `core`
- Full test suite ผ่าน **683 tests**
- UI smoke test ผ่าน 7/7 ในรอบก่อน (Settings project roots + always grants, agent permissions/lazy, MCP `sse`,
  custom node multi-output, plan/todo tool row) — รอบนี้ยังไม่ได้ smoke test permission matrix/per-agent grants
- DB schema ล่าสุด: **version 23** (`023-tool-calls.sql`)
- รอบล่าสุด: run_log coverage, MCP reconnect/backoff, config rollback (skill/preset/workflow),
  secret redaction, git secret-file guard, permission matrix + per-agent always grants,
  Overseer ชั้น 1 (machine/web tools, mail/notify, cron, vault, OAuth, workflow enable, self-edit, notify node)

## ทำเสร็จแล้ว

### P0

- MCP client: `stdio`, Streamable HTTP และ HTTP+SSE (`McpLink`/`SseLink`)
  - tools ชื่อ `mcp_<server>_<tool>`
  - `{{secret.NAME}}` ใน env/headers/url
  - refresh แล้วบันทึก `latencyMs` เป็น health figure
  - core ตรวจสุขภาพทุก 15 นาทีผ่าน connection เดิม
  - transport หลุด = reconnect ทันที แล้ว backoff 1s → 60s สูงสุด 5 ครั้ง (`reconnect` option)
  - SSE stream ที่จบแจ้ง `onClose`; `SseLink` retry ตอนเปิด stream 2 ครั้ง
- Per-agent permission:
  - `agent.md` มี `permissions: { tool: allow|ask|deny }`
  - ใช้ใน chat agent loop, task gates และ workflow tool/mcp/connector/sheets node
  - approval card มี once / task / session / always
  - always grants เก็บใน app settings **แยกตาม agent** และลบได้จาก Settings
  - grant เก่าแบบ flat list ยังใช้ได้ และถูกอ่านเป็น `*` (ทุก agent)
- UI agent editor: permission matrix (มี filter) แทน textarea, checkbox `Lazy tools`

### P1

- Coding tools:
  - `grep`
  - `apply_patch` หลายไฟล์, validate ก่อนเขียน, rollback ถ้าเขียนพลาด
  - `git_status`, `git_diff`, `git_log`, `git_commit`
  - `run_shell` แบบ `background: true`, `shell_output`, `shell_stop`
  - rewind snapshot รองรับ `apply_patch`
  - project allowlist: `projectRoots` ตั้งได้ใน Settings ใช้จำกัด cwd ของ `run_shell`
    - core ส่ง `projectRoots` ไปกับ `tool-exec`
    - PC agent ตัดกับ allowedDirs ของเครื่อง (intersection) — core ขยายสิทธิ์เองไม่ได้
    - ว่าง = ใช้ allowedDirs เดิม; ถ้าตั้งไว้แต่ไม่มี root ที่เครื่องนี้อนุญาต จะ fail closed
- Secret safety:
  - workflow run history, debug node, run result และ error redact ค่า secret จริงจาก vault (ไม่ใช่แค่ pattern)
- Git safety:
  - `git_commit` ไม่ stage `.env`, key, credentials; ต้องส่ง `allow_secrets: true` ถ้าตั้งใจ
- Subagent:
  - `send_to` จำกัด `max_rounds` / `max_tokens`
  - `send_agents` รันพร้อมกันได้สูงสุด 8 ตัว
- Plan/todo:
  - `plan_set`, `plan_read`, `todo_write`, `todo_read`
  - ถูกเพิ่มให้ agent อัตโนมัติถ้ายังไม่มีใน tool list
  - tool row ของ plan/todo แสดง open ในแชต
- UI smoke test: ผ่านทุกจุดที่ค้างไว้ (Settings, agent editor, MCP form, custom node, plan/todo row)

### P2 / Overseer / Workflow

- `lazy_tools` + `tool_search`: schema ถูกโหลดเมื่อ model ขอ
- Custom node เป็น type จริง `custom:<name>` และประกาศหลาย output ได้; item ใช้ `$output` เลือก output
- Overseer:
  - `agent_test` (alias ของ `agent_message`)
  - `secret_audit`
  - `config_diff` รองรับ agent/tool/preset/skill/workflow (มี list add/remove สำหรับ tools/skills/canMessage)
  - `config_rollback` รองรับ agent/tool/preset/skill/workflow; save ก่อนเขียนทับอัตโนมัติ
  - `run_log` อ่าน `tool_calls` (migration 023); log แล้วทั้ง chat tools,
    workflow `tool`/`mcp`/`connector`/`sheets` และ tool ที่ถูกเรียกผ่าน `tool_test`
- Workflow nodes:
  - `assert`, `debug`, `json_schema`, `mcp`, `agent_call`
  - `$secret.NAME` ใช้ได้ในทุก expression และ code node
  - `try/catch`/retry เดิมใช้ `onError` + `retries`; pin/mock เดิมใช้ `pinned`

### Overseer ชั้น 1

- Machine/web: `read_file`, `run_shell` / `shell_output` / `shell_stop`,
  `browser_open` / `browser_snapshot` / `browser_check` / `browser_screenshot` / `browser_wait` / `browser_close`,
  `computer_screenshot` (browser tools เป็นข้อยกเว้นที่อยู่กับ shell ได้)
- ติดต่อผู้ใช้: `notify_user`, `gmail_send`, `outlook_send`, `smtp_send`
- ตั้งเวลาให้ตัวเอง/agent อื่น: `create_trigger`, `list_triggers`, `cancel_trigger`, `update_trigger`
- Vault: `secret_set` / `secret_delete`; ค่า secret ถูกซ่อนจาก permission card, chat tool row และ history
- OAuth: `oauth_accounts` / `oauth_start` (ผู้ใช้ยังกรอกรหัสและกด consent เอง); core รับ receiver จาก server
- Workflow: `workflow_enable` / `workflow_disable` เป็นขั้นแยกหลัง `workflow_save` และต้องผ่าน approval
- แก้ agent `overseer` ได้ (model/budget/prompt/tools) แต่สร้างใหม่/เปลี่ยนชื่อไม่ได้; กันการเพิ่ม `web_search`
  เพราะมี `run_shell` อยู่แล้ว
- Workflow node ใหม่: `notify` (notification + โพสต์ในแชต, redact secret)

### Integrations

- Google Calendar: `calendar_update`, `calendar_delete`
- Google Drive: `drive_upload` (multipart, <= 50 MB), `drive_share`, `drive_update_metadata`
- Google Contacts: `contacts_search`, `contacts_create`, `contacts_update`
- Outlook Contacts: `outlook_contacts_search`, `outlook_contacts_create`, `outlook_contacts_update`
- OneDrive: `onedrive_upload` (`Files.ReadWrite`, <= 50 MB)
- Media: `media_trim` ตัดวิดีโอ/เสียงเป็นไฟล์ใหม่
- PDF: `pdf_merge`, `pdf_split`, `pdf_delete_pages`, `pdf_rotate` (pdf-lib; ต้นฉบับไม่ถูกแก้)
- รูป/วิดีโอ: `image_crop`, `image_rotate`, `video_merge`, `media_subtitle` (soft SRT)
- Scope: Google `contacts`, `drive` (เต็ม); Microsoft `Contacts.ReadWrite`, `Files.ReadWrite`
  - ผู้ใช้ต้อง reconnect Google/Microsoft หนึ่งครั้ง
- Packaging: `pdf-lib` เป็น dependency ของ `@mimi/pc-agent`
  - `scripts/pack-pc-agent.mjs` มี `copyPcAgentPackages()` คัดลอก zod/pdf-lib/pako/tslib/@pdf-lib
  - build-win/build-mac และ test `pc-stdin` ใช้ตัวเดียวกันแล้ว

## ไฟล์สำคัญ

- MCP: `packages/pc-agent/src/mcp/client.ts`, `packages/core/src/mcp/hub.ts`
- Permissions: `packages/core/src/permissions/gate.ts`, `packages/core/src/loop/agent-loop.ts`, `packages/core/src/tasks/runner.ts`, `packages/core/src/workflows/runner.ts`
- Agent flags: `packages/core/src/agents/loader.ts`
- Coding tools: `packages/pc-agent/src/tools/{search,patch,git,background,run-shell}.ts`
- PDF/media editing: `packages/pc-agent/src/tools/pdf.ts`, `packages/pc-agent/src/tools/media.ts`
- Drive/contacts: `packages/core/src/google/{tools,sheets}.ts`, `packages/core/src/microsoft/tools.ts`
- Lazy tools: `packages/core/src/tools/tool-search.ts`
- Plan/todo: `packages/core/src/chat/plan-tools.ts`
- Workflow runner: `packages/core/src/workflows/runner.ts`
- Run history/redaction: `packages/core/src/workflows/{run-history,redact}.ts`
- Workflow authoring: `packages/core/src/workflows/author-tools.ts`
- Custom nodes: `packages/core/src/workflows/custom-nodes.ts`
- Overseer: `packages/core/src/overseer/{tools,diagnostics,versions}.ts`
- Tool log: `packages/core/src/usage/logger.ts`, `packages/core/src/db/023-tool-calls.sql`
- Google/Microsoft APIs: `packages/core/src/google/{auth,tools,sheets}.ts`, `packages/core/src/microsoft/{auth,tools,drive}.ts`
- UI: `packages/core/src/server/web/app.js`, `feature-tools.js`, `feature-agent-tools.js`

## งานที่เหลือ

### ควรเก็บ

ไม่มีงานค้างในลิสต์เดิมแล้ว (config rollback, permission UX, secret redaction, git safety ทำครบ)
งานที่เหลือคือสองหัวข้อด้านล่างซึ่งเป็นขอบเขตที่ตั้งใจยังไม่ทำ

### ยังไม่แตะ (Layer 2 เดิม)

- ธนาคาร / statement / จ่ายเงิน
- พิมพ์รหัสผ่านหรือข้อมูลบัตรในเว็บ (ตั้งใจบล็อก)
- ติดตั้ง/อัปเดตแอปแทนผู้ใช้
- Google Drive share/upload ผ่าน **connector operations** (native `drive_share`/`drive_upload` ทำแล้ว แต่ connector `google_drive` ยังไม่มี operation เหล่านี้)
- PDF แก้ไฟล์เดิมในที่, ตัดต่อรูป/วิดีโอขั้นสูง (native PDF/รูป/วิดีโอทำได้แต่เขียนไฟล์ใหม่เท่านั้น)
- LINE/Telegram ต้องมี token ( connector มีอยู่แล้วถ้าเชื่อมบัญชี )

### Overseer ชั้น 1

ทำครบแล้ว (ดูหัวข้อ "Overseer ชั้น 1" ด้านบน) เหลือเพียง UI smoke test ของหน้าจอใหม่

## ตรวจสอบ

บน PowerShell นี้ `npm run ...` อาจติด execution policy; ใช้ node ตรง:

```powershell
node node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/pc-agent/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json
node --test --test-timeout=60000 "packages/*/src/**/*.test.ts"
```

ถ้าเครื่องอื่นรัน npm ได้:

```bash
npm run typecheck
npm test
```

## จุดเริ่มของ session ถัดไป

1. อ่าน `HANDOFF.md` นี้
2. `git status` และ `git diff --stat`
3. งานในลิสต์เดิมและ Overseer ชั้น 1 ทำครบแล้ว (683 tests); ต่อไปเหลือ **Layer 2** และ UI smoke test
4. ก่อนแก้ อย่าลืมว่า DB schema เป็น 23 และเทสต์บางตัวผูก version นี้
5. commit ได้ตามที่ผู้ใช้สั่ง; ตรวจ `git log --oneline` ก่อนเริ่มงานใหม่
