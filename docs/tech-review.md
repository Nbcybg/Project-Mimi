# ทบทวนเทคโนโลยี (0.5.0): ภาษา, engine, ภาษาของ UI, หน้าต่างเนทีฟ

สรุปว่าอะไรพอสำหรับต่อยอด อะไรควรจัดการก่อนโตกว่านี้ (เขียนจากโค้ดจริง ณ 0.5.0)

## 1. ภาษา / runtime
- **TypeScript รันตรงบน Node 24** (type stripping, `erasableSyntaxOnly`, ไม่มีขั้น build) ทดสอบด้วย `node:test` ตรวจชนิดด้วย `tsc --noEmit`
  เหมาะกับโปรเจกต์นี้: ไฟล์ที่รันคือไฟล์ที่เขียน, dependency น้อย (ai SDK, better-sqlite3, ws, zod, yaml, croner, three)
  ข้อจำกัดที่ต้องรู้: ใช้ syntax ที่ลบชนิดแล้วรันได้เท่านั้น (ไม่มี enum / namespace / parameter property) และต้องมี Node ≥ 24 (แพ็กเกจพกพามี Node มาด้วยอยู่แล้ว)
- **SQLite (better-sqlite3)** พอสำหรับผู้ใช้คนเดียว/หลายอุปกรณ์ที่คุยกับ core ตัวเดียว; migration เป็นไฟล์ลำดับ (`db/0NN-*.sql`, ตอนนี้ v15)
  ถ้าจะมีหลายผู้ใช้หรือหลาย core ค่อยคิดเรื่อง Postgres ตอนนั้น
- **ความเสี่ยงที่เลี่ยงไว้**: core ไม่ได้รันใน Electron แต่เป็นโปรเซส Node แยก (`launcher.ts`) จึงไม่ต้อง rebuild better-sqlite3 ให้ตรง ABI ของ Electron
  และ core ยังรันแบบไม่มีหน้าต่าง (Docker / VPS) แล้วเปิดจากมือถือผ่านเบราว์เซอร์ได้เหมือนเดิม

## 2. Engine แชต / agent loop
- `ChatEngine` (chat/engine.ts, ~320 บรรทัด) รับ dependency ผ่าน interface (ไม่ผูกกับ DB/โมเดลจริง) ส่งผลเป็น async generator ของเหตุการณ์ ทำให้ test ง่ายและ client ใดก็ต่อได้ (เว็บ, CLI)
  กลุ่มแชตใช้ @mention เป็นคิว ไม่มี hierarchy ตายตัว
- `AgentLoop` (loop/agent-loop.ts, ~480 บรรทัด) มีงบรอบ/token/ค่าใช้จ่าย, permission gate, parked run, retry เมื่อโมเดลตอบว่าง; มี 335 test คลุมทั้งชุด
- **จุดที่เริ่มบวม**: `core.ts` (~1270 บรรทัด, ประกอบทุกอย่าง) และ `server.ts` (~1420 บรรทัด, HTTP + WebSocket dispatch)
  แนวทาง: แยก handler ของ WebSocket ตามโดเมนแบบที่ `chat-api.ts` ทำไว้แล้ว (wardrobe / backgrounds / gallery / providers / hub) แล้วให้ `server.ts` เหลือแค่ routing และ auth
  ยังไม่จำเป็นต้องเปลี่ยน engine เอง

## 3. เว็บ client
- JavaScript ธรรมดาไม่มี framework (~11k บรรทัด) ต่อกันด้วย `window.Mimi` และ `window.MimiHooks` โหลดตามลำดับ `<script>`
  ใช้ได้ดีที่ขนาดนี้ แต่ `app.js` (~2.8k บรรทัด) ใหญ่แล้ว รอบนี้แยกเสียงอัดออกเป็น `feature-voice.js` และเปลี่ยนแนวคิด `compact` / `?ui=compact` เหลือแค่ "mobile mode = หน้าต่างกว้างไม่เกิน 820px"
- ขั้นต่อไปที่คุ้มกว่าย้าย framework: แปลงไฟล์ feature เป็น ES module ที่ import จากสะพานเล็ก ๆ (`bridge.js`) แทนตัวแปร global; แยก `app.js` ต่อ (chat list, composer, hub, settings)
- CSS: กฎของ mobile mode ใช้ `html[data-mode="mobile"]` ที่เดียว (ไม่มี `.compact` แล้ว) หน้าจอ clean ของแชตตัวละครอยู่ในบล็อกเดียวท้ายไฟล์

## 4. ภาษาของ UI (i18n)
- ข้อความไทยฝังในโค้ดราว 1,000 บรรทัด (29 ไฟล์) ข้อความฝั่ง server เป็นอังกฤษอยู่แล้ว
- ตอนนี้มี `i18n.js`: `t('key', { vars })`, ไทย + อังกฤษ, เดาจากภาษาเบราว์เซอร์, สลับได้ใน Chat setting, ถ้าคีย์หายจะ fallback เป็นไทยแล้วเป็นชื่อคีย์
  ย้ายแล้ว: ปุ่มและเมนูของข้อความ, เสียง, Chat setting, ตำแหน่งตัวละคร, placeholder ช่องพิมพ์
  ยังเป็นไทยฝังอยู่: หน้า Agent / Hub / ตั้งค่า / workflow (~900 บรรทัด) ย้ายทีละหน้าเมื่อแตะหน้านั้น แล้วแยกตารางภาษาเป็นไฟล์ต่อภาษาเมื่อมีมากกว่าสอง
- prompt ของ agent และข้อความที่ผู้ใช้เขียนเป็นข้อมูลของผู้ใช้ ไม่ใช่ UI จึงไม่เข้าระบบนี้

## 5. หน้าต่างเนทีฟ (Electron)
- `packages/desktop/main.cjs` เป็นเปลือกบาง ๆ: หน้าต่างเดียวขนาดมือถือ (410×820) ย่อ/ขยายได้ จำขนาดและตำแหน่ง, กดปิด = ซ่อน (สถานะแชตอยู่ครบ), ไอคอน tray, notification, เมนู tray (เปิดแชต / Agent / Hub / ตั้งค่า / ซ่อนเมื่อคลิกที่อื่น / อยู่บนสุด / ออก)
  ไม่มีเมนูแบบเบราว์เซอร์, ไม่มี zoom, คลิกขวาเฉพาะช่องข้อความ, ลิงก์ภายนอกเปิดในเบราว์เซอร์ปกติ, ขออนุญาตเฉพาะไมค์/กล้อง/แจ้งเตือน
- launcher ↔ หน้าต่างคุยกันทาง node IPC (โปรแกรม GUI บน Windows ไม่มี stdin ที่ใช้ได้)
- ราคาที่ต้องจ่าย: Electron ~100 MB+ ในแพ็กเกจ และต้องตามอัปเดตความปลอดภัยของ Chromium; ยังไม่ได้ทำ: เริ่มพร้อม Windows, ลงนามโค้ด, อัปเดตอัตโนมัติ
- **PC agent ในแพ็กเกจ**: Node 24 ไม่ยอม strip TypeScript ใต้ `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) ทำให้แพ็กเกจเก่าเปิด PC agent ไม่ขึ้นทั้งที่ติ๊กแล้ว
  `scripts/pack-pc-agent.mjs` จึงคัดลอก `pc-agent` และ `shared` ไปไว้ข้างแอป (`resources/app/pc-agent`, `resources/app/shared`) แล้ว rewrite import `@mimi/shared` เป็น relative
  `remote.cjs` เลือก entry ที่ `resources/app/pc-agent/src/main.ts` ก่อน — อย่าย้ายกลับเข้า `node_modules`

## 6. Task model และ deterministic runner (Sprint 1)

- `packages/shared/src/tasks.ts` นิยาม `TaskView`, steps, gates, plan, verification, receipt และ task events ที่ไหลผ่าน `AgentEvent` เดียวกับ run ปกติ
- `packages/core/src/db/022-tasks.sql` + `tasks/repo.ts`: task เก็บใน SQLite เป็น JSON columns; `undo` descriptor ไม่ส่งออก UI
- `tasks/recipes.ts` + `tasks/file-organizer.ts`: recipe ประกาศ level (`L3`), input schema (zod), interface (`pc`) และขั้น plan → confirm → apply → verify; recipe เรียก PC tools ผ่าน executor เดียวกับ agent loop
- `tasks/runner.ts`: async generator ที่ emit `task-start` / `task-step` / `task-plan` / `task-receipt` / `task-update` / `task-finish`; รองรับ pause/resume/cancel ผ่าน `task-control`, ผูก `AbortSignal` ของ turn, ถือว่าจบเฉพาะเมื่อ verification ผ่าน, และ undo จาก journal
- `tasks/tools.ts`: `task_run` (risk `read` เพราะ orchestration; gate อยู่ที่ recipe) และ `task_undo` (risk `write`) ถูกเพิ่มให้ทุก agent ผ่าน `extraTools` โดยไม่ต้องแก้ไฟล์ agent
- `packages/pc-agent/src/tools/organize.ts`: planner/apply/verify/undo ในไฟล์เดียว, journal ใต้ `.mimi-organize`; `local-consent.ts` + `client.ts` เพิ่มการถามบนเครื่อง
- Server: `permission-response` รับ `scope` เพื่อสร้าง grant; `task-control` และ `task-undo` ส่ง events กลับเข้าแชต; web client วาดการ์ดงาน/แผน/ใบเสร็จและปุ่ม undo
- Tests: `packages/core/src/test/tasks.test.ts`, `file-organizer.test.ts`, `local-consent.test.ts`, `permission-gate.test.ts`, `pc-stdin.test.ts` (token ทาง stdin และ layout ของแพ็กเกจ); รัน `npm run typecheck && npm test` (matrix macOS/Windows ใน `.github/workflows/test.yml`)

## 7. Workspace / developer recipe (Sprint 2)

- `packages/pc-agent/src/process.ts`: shell adapter เดียว (PowerShell บน Windows, sh บน macOS), timeout, output cap, kill process tree, sanitized environment
- `packages/pc-agent/src/tools/workspace.ts`: `workspace_create`, `workspace_info`, `workspace_run`, `workspace_checkpoint`, `workspace_diff`, `workspace_undo`; git checkpoint เก็บใน `refs/mimi/checkpoints/*` ผ่าน temporary index, undo มี backup ใน `.mimi-workspace/undo`
- `packages/core/src/tasks/developer.ts`: recipe inspect → confirm → prepare → reproduce → checkpoint → fix → verify → diff → report; fix ใช้ `TaskStepContext.runAgent`
- `TaskRunnerDeps.runAgentStep` + `RunInput.noTaskTools`: nested agent ใช้ tool allowlist, thread `task-<id>`, ส่ง events กลับเป็น `agent-activity`, ไม่ให้เริ่ม task ซ้อน
- session grant family `files.workspace` ครอบ workspace tools + `write_file`/`edit_file`
- Tests: `workspace.test.ts` (temp repo, policy, checkpoint/diff/undo), `developer.test.ts` (failing test → agent edit → pass → diff → undo); `npm run typecheck && npm test`

## 8. Media / photo pipeline (Sprint 3)

- `packages/pc-agent/src/tools/media.ts`: `media_probe`, `photo_scan`, `photo_apply`, `photo_undo`, `photo_verify`, `media_contact_sheet`, `media_transform`
- ffprobe metadata + exact SHA-256 + ffmpeg 9x8 grayscale dHash + 64x64 Laplacian variance (blur); duplicate grouping with union-find; optional vision sample budget
- `process.ts` binary stdout mode for ffmpeg raw pixels; retry once for transient decode failures
- `packages/core/src/tasks/photo-cull.ts`: scan → confirm → optional vision → contact sheet → copy keep/reject → verify → receipt/undo; originals are never written
- TaskRunner supplies the batch progress/pause/cancel/resume; photo scan enforces `max_cost_usd` before any vision step
- Tests: `photo-pipeline.test.ts` with ffmpeg-generated fixtures (exact duplicate, blur, contact sheet, transform, apply/verify/undo); skipped when ffmpeg/ffprobe are absent
- `npm run typecheck && npm test`

## 9. Browser task layer / YouTube (Sprint 4)

- `packages/pc-agent/src/browser/session.ts`: `upload` (DOM.getDocument/querySelector/setFileInputFiles), `focus`, `waitFor`; snapshot scans password/OTP/CAPTCHA and returns `handoff`
- `packages/pc-agent/src/tools/browser.ts`: `browser_upload`, `browser_wait`, `browser_focus`, `browser_check`; upload path guard with `context.allowedDirs`
- `packages/core/src/tasks/youtube-upload.ts`: validate/mux → confirm → open → handoff → upload → details → public publish gate → final button → verify URL → receipt (no undo)
- session grant family `browser.task` covers open/upload/click/type/select/press/focus/wait
- Tests: `browser-task.test.ts` (fake CDP upload/wait/focus/handoff), `youtube-upload.test.ts` (unlisted/public/login handoff with a scripted browser executor); real YouTube needs a manual run
- `npm run typecheck && npm test`
