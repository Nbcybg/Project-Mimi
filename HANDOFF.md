# Mimi handoff — 2026-11-01

## สถานะ

- HEAD `d722831` (packs); branch `main` นำ `origin/main` **7 commits** และยังไม่ push
  (ตรวจจำนวนจริงด้วย `git status -sb`)
- Calendar sync ถูก commit แล้วตั้งแต่ `a353f2e` (0.7.8) — ไม่มีงาน calendar ค้างใน working tree
- Working tree ที่ยังไม่ commit: Workspace terminal/browser ของเดสก์ท็อป
  (`packages/desktop/workspace-*`, `scripts/build-mac.mjs`, `scripts/build-win.mjs`,
  `package-lock.json`) และไฟล์ใหม่ `scripts/pack-terminal.mjs`; ดู `git status` ก่อนเริ่มงาน
- Full test suite ผ่าน **749 tests** (fail 0, skipped 0) และ typecheck ผ่านทั้ง
  `shared`, `pc-agent`, `core` เมื่อ 2026-11-01
- DB schema ล่าสุด: **version 23** (`023-tool-calls.sql`); calendar sync ใช้ไฟล์ JSON
  (`user/data/calendar-sync.json`) ไม่เพิ่ม migration
- เวอร์ชันใน `package.json` ทุกแพ็กเกจเป็น **0.7.9-prototype**; ยังไม่มี tag
  `v0.7.9-prototype` (`git tag --list`)
- ฟีเจอร์ 0.7.9 ที่ทำแล้ว: first-run setup wizard, OpenAPI import ในแอป, session maximum age +
  TOTP 2FA, Cloudflare tunnel (quick/named), signed/checked desktop updates, packs
- งานใหม่ใน working tree (ยังไม่ commit): ถอนแพ็กพร้อม preview, TOTP recovery codes,
  หน้าเปลี่ยนรหัสผ่านเอง, แจ้งเตือนล็อกอินใหม่, Graph lifecycle notifications,
  เลือกปฏิทิน Google/Microsoft, OpenAPI pagination/rate-limit inference,
  named tunnel, Electron fuses และ remote pack catalog — เอกสารและ test อัปเดตแล้ว

## ทำเสร็จแล้ว

### 0.7.9 (commits `b8cd476` → `d722831`)

- **Setup wizard** — เปิดอัตโนมัติเมื่อเริ่มครั้งแรกแล้วยังแชตไม่ได้: ผู้ให้บริการ (Claude plan,
  ChatGPT plan หรือ API key + โมเดลหลัก) → starter agent (เลขาส่วนตัว / นักค้นคว้า /
  ผู้ช่วยจัดการเครื่อง / ผู้ช่วยเขียนโค้ด) → โฟลเดอร์ที่อนุญาต → PC agent → ทดสอบแชต
  - ใช้ message ปกติ (`provider-connect`, `settings-save`, `agent-save`, `chat-create`)
    จึงได้ผลเหมือนตั้งค่าเองทุกอย่าง; `mimi.setupDone` ถูก sync ข้ามอุปกรณ์
  - เปิดใหม่ได้ที่ปุ่ม **ตัวช่วยตั้งค่า** ในหน้า Settings; preset ที่อ่านเว็บ/อีเมลไม่มี shell
  - โค้ด: `packages/core/src/server/web/feature-setup.js`,
    `packages/core/src/agents/presets.ts`
- **OpenAPI import ในแอป** — Hub → Node & Tools → **+ นำเข้า OpenAPI**
  - preview ก่อน ไม่เขียนอะไร; ยืนยันแล้วเก็บที่ `user/connectors/imported/<key>.json`
    และเพิ่ม tools ทันทีโดยไม่ต้องรีสตาร์ท; แก้ทับ/ลบได้
  - JSON เท่านั้น (2 MB), server ต้องเป็น https และไม่ใช่ LAN/local,
    สูงสุด 50 imported connectors / 200 operations ต่อ connector
  - operation ที่นำเข้าเป็น `untrustedInput` ทั้งหมด, risk ตาม method, เพิ่ม trigger ไม่ได้,
    ใช้ absolute URL หรือยืม Google token ไม่ได้
  - derive pagination จากชื่อ param/response ที่พบบ่อย (page + size, cursor/pageToken + next)
    และอ่าน `x-mimi-rate-limit` (requests, perMs, burst); trigger และ `itemsPath` นอก
    `x-mimi-items-path` ยังไม่ derive
  - โค้ด: `packages/core/src/connectors/{openapi,imported}.ts`,
    `packages/core/src/server/web/feature-tools.js`, `docs/connectors/openapi-import.md`
- **Accounts gateway: session maximum age + 2FA** —
  - session หมดอายุ `MIMI_SESSION_MAX_DAYS` (ค่าเริ่มต้น 90) หลังล็อกอิน แม้ใช้งานต่อเนื่อง
  - TOTP ต่อบัญชี (RFC 6238, 6 หลัก, 30 วินาที, รับ clock drift ±1 step):
    ตั้งใน Settings → โปรไฟล์ของฉัน (เฉพาะโหมด gateway), secret เข้ารหัสด้วย
    `MIMI_GATEWAY_SECRET`, รหัสใช้ได้ครั้งเดียว (`totp_last_step`), รหัสผิดนับรวมกับ limiter
  - recovery codes 10 รหัสตอนเปิด 2FA (80 บิต, SHA-256, แสดงครั้งเดียว, ใช้ได้คนละครั้ง;
    สร้างชุดใหม่ได้ด้วยรหัสผ่าน) และหน้าเปลี่ยนรหัสผ่านเอง (ออกจากระบบเครื่องอื่น)
  - admin ปิดให้ด้วย `node packages/core/src/cli/accounts.ts 2fa-reset <ชื่อ>` (ออกจากระบบทุกเครื่อง)
  - แจ้งเตือนอุปกรณ์อื่นที่เปิดอยู่เมื่อมี session ใหม่ (`security-alert`)
  - โค้ด: `packages/core/src/gateway/{accounts,totp,gateway}.ts`,
    `packages/core/src/server/web/app.js` (`twoFactorPanel`, `passwordPanel`)
- **Cloudflare tunnel** — Settings → แอปและระบบ → **เข้าจากอินเทอร์เน็ต (Cloudflare Tunnel)**
  - เรียก `cloudflared tunnel --url http://127.0.0.1:<port>`; หา binary จาก PATH,
    โฟลเดอร์ติดตั้งปกติ หรือ `MIMI_CLOUDFLARED`
  - URL เป็น `https://<random>.trycloudflare.com` และ **เปลี่ยนทุกครั้งที่เริ่ม**;
    ใช้กับ webhook และ calendar push อัตโนมัติเมื่อยังไม่ได้ตั้ง public URL
  - ปฏิเสธเมื่อ core มี public address อยู่แล้ว หรือ `MIMI_TOKEN` สั้นกว่า 16 ตัว;
    ระหว่างเปิด tunnel เชื่อม ChatGPT plan ไม่ได้; limiter นับ `cf-connecting-ip`;
    cloudflared ไม่ได้รับ secret ใน environment
  - named tunnel: ตั้ง `MIMI_CLOUDFLARED_TUNNEL` + `_URL` หรือ `_CONFIG` (อ่าน hostname
    จาก ingress) → URL คงที่ และเริ่มเองตอนเปิด core เว้น `MIMI_CLOUDFLARED_AUTOSTART=0`
  - ไม่ได้ bundle cloudflared (ผู้ใช้ต้องติดตั้งเอง) และไม่มี UI สร้าง tunnel ใน Cloudflare
  - โค้ด: `packages/core/src/app/tunnel.ts`, `packages/shared/src/protocol.ts`,
    `packages/core/src/server/web/app.js` (`tunnelPanel`)
- **Signed builds + checked updates** — `scripts/signing.mjs` และ `release.yml`
  - Windows Authenticode (`WIN_CSC_*`, signtool), macOS Developer ID + hardened runtime
    (`APPLE_SIGN_IDENTITY`), notarize (`APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID`)
  - ทุก release มี `SHA256SUMS.txt`; updater ตรวจขนาด + SHA-256 และถ้าแอปเดิมลงนามแล้ว
    ตัวใหม่ต้องลงนามโดย publisher เดียวกัน (Authenticode subject / Team ID)
  - **ยังไม่ได้ตั้ง certificate/secrets จริง** จึงยังได้ build แบบ unsigned (Windows) /
    ad hoc (macOS)
  - Electron fuses ตั้งก่อนลงนาม (`scripts/fuses.mjs`): RunAsNode เปิด, NODE_OPTIONS/CLI inspect ปิด
  - โค้ด: `scripts/signing.mjs`, `scripts/fuses.mjs`, `scripts/build-{mac,win}.mjs`,
    `packages/desktop/updater.cjs`, `.github/workflows/release.yml`
- **Packs** — Hub → แพ็ก; ชุด agent + OpenAPI connector + workflow พร้อม credential checklist
  - 3 แพ็กในเครื่อง: `morning-brief` (Open-Meteo), `fx-watch` (Frankfurter),
    `mail-digest` (Gmail) — สองตัวแรกไม่ต้องใช้คีย์
  - preview ไม่เปลี่ยนอะไร; ติดตั้งตามลำดับ connector → agent → workflow;
    workflow ถูกบันทึกแบบปิดทุกตัว; ชื่อซ้ำไม่ทับ; บันทึกสถานะที่ `user/packs/<id>.json`
  - รับไฟล์แพ็ก `format: 1` (JSON ≤ 4 MB, agent ≤ 8, connector ≤ 8, workflow ≤ 20)
  - **ถอนการติดตั้งได้แล้ว** (working tree): preview ก่อนลบ, ลบเฉพาะของที่แพ็กสร้างและยังมีอยู่,
    เก็บของที่ workflow/agent อื่นใช้; record เก่าที่ไม่มีข้อมูล ownership ลบได้แต่ของยังอยู่
  - remote catalog ผ่าน `MIMI_PACK_CATALOG_URL` (https, 5 วินาที, 4 MB, ตรวจทุกแพ็ก,
    ไม่มีลายเซ็น); catalog ในเครื่องยังเป็น 3 แพ็ก
  - โค้ด: `packages/core/src/packs/{packs,catalog}.ts`,
    `packages/core/src/server/web/feature-packs.js`, `docs/packs.md`

### ก่อนหน้า (0.7.8 และเก่ากว่า)

- MCP: stdio, Streamable HTTP, HTTP+SSE; `mcp_<server>_<tool>`; `{{secret.NAME}}`;
  health check ทุก 15 นาที; reconnect + backoff 1s → 60s สูงสุด 5 ครั้ง
- Per-agent permission matrix (`permissions` ใน `agent.md`), approval แบบ
  once/task/session/always, always grants แยกตาม agent, grant เก่าแบบ flat list
- Coding tools: `grep`, multi-file `apply_patch`, `git_status/diff/log/commit`,
  background `run_shell` + `shell_output/shell_stop`, rewind รองรับ `apply_patch`,
  project allowlist (core narrowing, PC agent intersect)
- Secret safety: redact ค่า vault จริงจาก run history/debug/error; `git_commit`
  ปฏิเสธไฟล์ secret เว้น `allow_secrets: true`
- Subagent (`send_to` cap, `send_agents` ≤ 8), plan/todo tools, `lazy_tools` + `tool_search`
- Custom node `custom:<name>` หลาย output; workflow nodes `assert`, `debug`,
  `json_schema`, `mcp`, `agent_call`, `notify`; `$secret.NAME` ในทุก expression
- Overseer ชั้น 1: machine/web tools, mail/notify, trigger control, vault, OAuth,
  workflow enable/disable, self-edit (สร้าง/เปลี่ยนชื่อไม่ได้)
- Layer 2: in-place PDF/image/media (temp + rename, backup), `install_app` ผ่าน
  winget/brew/choco/scoop/apt, `statement_read` (CSV/TSV/OFX/QFX/QIF), Stripe
  payment/refund พร้อม `confirmPhrase` + `alwaysAsk`, `browser_fill_secret`
- Realtime calendar sync Google/Microsoft: watch/subscription, sync token/delta link,
  `GET/POST /api/calendar/push/<token>`, gateway `/h/<id>`, trigger `calendar`,
  dedupe + lock, poll ทุก 15 นาทีเป็น safety net, ปิดด้วย `MIMI_CALENDAR_SYNC=0`
  - Google watch ปฏิทินที่เลือก (ค่าเริ่มต้น primary); Graph ใช้ `/me/events`
    หรือ `/me/calendars/<id>/events` ตามที่เลือก
- Integrations: Google Calendar update/delete, Drive upload/share/metadata,
  Contacts (Google/Outlook), OneDrive upload, PDF merge/split/delete/rotate,
  image crop/rotate, video merge, subtitle (soft/burn), extract audio
- Packaging: `pdf-lib` เป็น dependency ของ `@mimi/pc-agent`;
  `scripts/pack-pc-agent.mjs` คัดลอก zod/pdf-lib/pako/tslib/@pdf-lib;
  build-win/build-mac/test `pc-stdin` ใช้ตัวเดียวกัน

## ไฟล์สำคัญ

- Setup wizard: `packages/core/src/server/web/feature-setup.js`,
  `packages/core/src/agents/presets.ts`
- Packs: `packages/core/src/packs/{packs,catalog}.ts`,
  `packages/core/src/server/web/feature-packs.js`, `docs/packs.md`
- OpenAPI import: `packages/core/src/connectors/{openapi,imported}.ts`,
  `packages/core/src/server/web/feature-tools.js`, `docs/connectors/openapi-import.md`
- Tunnel: `packages/core/src/app/tunnel.ts`, `packages/shared/src/protocol.ts`,
  `packages/core/src/core.ts` (calendar follow), `packages/core/src/server/web/app.js`
- Signing/update: `scripts/signing.mjs`, `scripts/fuses.mjs`, `scripts/build-{mac,win}.mjs`,
  `packages/desktop/updater.cjs`, `.github/workflows/release.yml`, `docs/admin.md`
- Gateway/2FA: `packages/core/src/gateway/{accounts,totp,main,gateway}.ts`,
  `packages/core/src/cli/accounts.ts`, `packages/core/src/server/web/app.js`
- Calendar sync: `packages/core/src/calendar/{sync,api,push}.ts`,
  `packages/core/src/server/server.ts` (push route/listeners),
  `packages/core/src/gateway/gateway.ts` (`/h` route),
  `packages/core/src/workflows/runner.ts` (calendar trigger items),
  `packages/shared/src/calendar.ts`
- MCP: `packages/pc-agent/src/mcp/client.ts`, `packages/core/src/mcp/hub.ts`
- Permissions: `packages/core/src/permissions/gate.ts`,
  `packages/core/src/loop/agent-loop.ts`, `packages/core/src/tasks/runner.ts`,
  `packages/core/src/workflows/runner.ts`
- Agent flags: `packages/core/src/agents/loader.ts`
- Coding tools: `packages/pc-agent/src/tools/{search,patch,git,background,run-shell}.ts`
- In-place output: `packages/pc-agent/src/tools/output-target.ts`
- Apps: `packages/pc-agent/src/tools/apps.ts`
- Statements: `packages/pc-agent/src/tools/statement.ts`
- Vault fills: `packages/pc-agent/src/tools/secret-fill.ts`,
  `packages/core/src/tools/browser-secret-tools.ts`,
  `packages/pc-agent/src/tools/browser/session.ts`
- Payment guard: `packages/core/src/connectors/{runtime,tool-adapter,registry}.ts`,
  `packages/core/src/connectors/services/stripe.ts`
- PDF/media editing: `packages/pc-agent/src/tools/{pdf,media}.ts`
- Drive/contacts: `packages/core/src/google/{tools,sheets}.ts`,
  `packages/core/src/microsoft/tools.ts`
- Lazy tools: `packages/core/src/tools/tool-search.ts`
- Plan/todo: `packages/core/src/chat/plan-tools.ts`
- Workflow runner: `packages/core/src/workflows/runner.ts`
- Run history/redaction: `packages/core/src/workflows/{run-history,redact}.ts`
- Workflow authoring: `packages/core/src/workflows/author-tools.ts`
- Custom nodes: `packages/core/src/workflows/custom-nodes.ts`
- Overseer: `packages/core/src/overseer/{tools,diagnostics,versions}.ts`
- Tool log: `packages/core/src/usage/logger.ts`, `packages/core/src/db/023-tool-calls.sql`
- Google/Microsoft APIs: `packages/core/src/google/{auth,tools,sheets}.ts`,
  `packages/core/src/microsoft/{auth,tools,drive}.ts`
- UI: `packages/core/src/server/web/app.js`, `feature-tools.js`, `feature-agent-tools.js`

## งานที่เหลือ

### ฟีเจอร์/ขอบเขตที่ยังขาด (ตรวจจากโค้ด 2026-11-01)

- **Packs**: remote catalog ผ่าน `MIMI_PACK_CATALOG_URL` มีแล้ว (working tree) แต่ยังไม่มี
  ลายเซ็น/central marketplace — ต้องเลือก URL ที่ไว้ใจ; catalog ในเครื่องยังเป็น 3 แพ็ก
- **TOTP**: recovery codes, หน้าเปลี่ยนรหัสผ่าน และแจ้งเตือนอุปกรณ์อื่นเมื่อมีล็อกอินใหม่มีแล้ว
  (working tree); ยังไม่มีประวัติ/อีเมลแจ้งเตือนสำหรับอุปกรณ์ที่ปิดอยู่
- **Tunnel**: quick tunnel ยังเป็นค่าเริ่มต้น (URL เปลี่ยนทุกครั้ง); named tunnel
  ใช้ได้ผ่าน `MIMI_CLOUDFLARED_TUNNEL` + `_URL`/`_CONFIG` และเริ่มเองได้
  (working tree) — แต่ยังไม่มี UI สร้าง/ล็อกอิน Cloudflare และต้องติดตั้ง cloudflared เอง
- **Signing**: โค้ด/runtime พร้อม (`scripts/signing.mjs`, `release.yml`, `SHA256SUMS.txt`,
  publisher check) และ Electron fuses ตั้งแล้ว (`scripts/fuses.mjs`) แต่ยังไม่ได้ตั้ง
  certificate/secrets จริง; build ที่ปล่อยจึงยัง unsigned/ad hoc
- **OpenAPI import**: JSON only (แอป), 2 MB, 50 connectors / 200 operations;
  pagination (page/cursor/nextPageToken) และ `x-mimi-rate-limit` ทำแล้ว (working tree);
  ยังไม่ derive triggers และ `itemsPath` นอก `x-mimi-items-path`; operation ที่ import
  เป็น untrusted และใช้ร่วมกับ shell ไม่ได้
- **Calendar**: ทั้ง Google และ Microsoft เลือกปฏิทินได้แล้ว (working tree: list/พิมพ์ id,
  Microsoft มีตัวเลือก "ทุกปฏิทิน"; เปลี่ยนแล้วหยุด subscription/channel เก่าและเริ่ม baseline ใหม่)
  — Graph lifecycle notifications ทำแล้ว (`subscriptionRemoved` สร้างใหม่, `missed` ทำให้ sync,
  `reauthorizationRequired` แจ้งให้ reconnect)
- **Strategic (ตั้งใจยังไม่ทำ)**: RBAC/SSO/audit retention, voice realtime,
  IDE extension/repo index, iOS native, local model runtime

### การตรวจที่ยังไม่ได้ทำ

- UI smoke: setup wizard, packs install/remove, OpenAPI import, tunnel start/stop,
  2FA enable/disable, recovery codes, เปลี่ยนรหัสผ่าน และแจ้งเตือนล็อกอินใหม่
- Tunnel จริงกับ Cloudflare (quick + named) + calendar push จริง (end-to-end กับ Google/Graph)
- เลือกปฏิทิน Google/Microsoft และ Graph lifecycle notifications กับบัญชีจริง
- TOTP กับ authenticator app จริง (Google Authenticator/1Password/Authy)
- Signed + notarized desktop build, ตรวจ fuses ในไฟล์ที่ build แล้ว และ Android release signing
- OpenAPI import กับ spec จริง และ packs ที่ต้องใช้ credential จริง
- Manual OS matrix (macOS/Windows), real Gmail/Outlook/YouTube
- Backup/restore และ multi-user gateway บน deploy จริง (Railway headers, IPv6)

### สิ่งที่ต้องตัดสินใจก่อนเริ่มงานใหม่

- branch `main` มี 7 commits ที่ยังไม่ push + งาน Workspace terminal ใน working tree —
  commit/push เมื่อผู้ใช้สั่งเท่านั้น
- DB schema เป็น 23; เทสต์บางตัวผูก version นี้ ถ้าจะเพิ่ม migration ต้องอัปเดตเทสต์ด้วย
- calendar sync ใช้ไฟล์ `calendar-sync.json` ไม่มี migration; การแก้ schema ไฟล์ต้องรองรับของเก่า
- push ต้องมี public HTTPS จริง (tunnel/gateway) ถึงจะทดสอบ end-to-end กับ Graph/Google ได้;
  เทสต์ใน repo ใช้ fake fetch
- UI smoke ของฟีเจอร์ 0.7.9 (setup wizard / packs / OpenAPI import / tunnel / 2FA /
  recovery codes / เปลี่ยนรหัสผ่าน / security alert) ยังไม่ได้รัน; ไม่มีในชุดเทสต์อัตโนมัติ
  จึงไม่ถูกตรวจซ้ำโดย `npm test`
- ก่อน tag `v0.7.9-prototype` ต้อง commit งาน Workspace terminal และตัดสินใจเรื่อง
  CHANGELOG (ปัจจุบัน 0.7.9 มีหัวข้อของตัวเองแล้ว)

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

ผลล่าสุด (2026-11-01): typecheck ผ่านทั้ง 3 แพ็กเกจ, **749 tests pass** (fail 0, skipped 0),
connector E2E 3/3, connector performance 5/5

## จุดเริ่มของ session ถัดไป

1. อ่าน `HANDOFF.md` นี้
2. `git status` และ `git diff --stat` (มีงาน Workspace terminal ที่ยังไม่ commit)
3. เลือกงานจาก "ฟีเจอร์/ขอบเขตที่ยังขาด" หรือ "การตรวจที่ยังไม่ได้ทำ" — งานที่ปิดไปแล้ว
   ไม่ต้องทำซ้ำ
4. ก่อนแก้ อย่าลืมว่า DB schema เป็น 23 และเทสต์บางตัวผูก version นี้
5. อย่า push/commit/tag จนกว่าผู้ใช้จะสั่ง; ตรวจ `git log --oneline` ก่อนเริ่มงานใหม่
6. ถ้าทดสอบ `browser_fill_secret` ต้องอัปเดต PC agent ฝั่งเครื่องให้มี internal tool นี้ก่อน
   (core เก่า + PC ใหม่ หรือกลับกัน จะได้ error ว่า PC ไม่มี tool)
7. Payment ops ของ Stripe ต้องส่ง `confirm: "CONFIRM PAYMENT"` หรือ `"CONFIRM REFUND"`
   ให้ตรง และจะถูกบังคับให้ถามทุกครั้ง; ถ้าเพิ่ม connector ที่เคลื่อนเงิน ให้ใส่ `confirmPhrase`
8. Quick tunnel ทดสอบกับ Cloudflare จริงได้ แต่ URL เปลี่ยนทุกครั้ง; อย่าใช้แทน
   `MIMI_PUBLIC_URL` สำหรับงานถาวร
