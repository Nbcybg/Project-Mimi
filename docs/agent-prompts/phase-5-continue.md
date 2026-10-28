# Phase 5 (ต่อ) — ส่งต่องานให้ agent ตัวถัดไป

สรุปสถานะ ณ 2026-10-27 หลังทำขั้น 1–5 ของ [phase-5-cloud-accounts.md](phase-5-cloud-accounts.md) และแก้ช่องโหว่ sandbox
คัดลอกบล็อก "Prompt" ด้านล่างไปใช้ได้เลย ส่วนบนเป็นข้อมูลอ้างอิงที่ prompt สั่งให้อ่าน

## ย้ายไปทำที่เครื่องอื่น (ก่อนเปิด agent)

โฟลเดอร์นี้ **ไม่ใช่ git repo** และยังไม่มีอะไร commit — ต้องคัดลอกทั้งโฟลเดอร์ไปเอง

- คัดลอก: ทุกอย่าง **ยกเว้น** `node_modules/`, `dist/` (สร้างใหม่ได้) และ `.env` ถ้ามี (ค่าลับ ไม่ควรติดไปกับไฟล์)
- อย่าคัดลอก `~/Documents/Mimi` (ข้อมูลแอปเวอร์ชันเก่าที่รัน core ในเครื่อง) เว้นแต่ตั้งใจย้ายข้อมูลจริง
- เครื่องใหม่ต้องมี Node ≥ 24 (เครื่องเดิมใช้ 26.5.1) แล้วรัน `npm ci`
- Docker: เครื่องเดิมใช้ colima (`brew install colima docker docker-buildx`, เพิ่ม `cliPluginsExtraDirs` ใน `~/.docker/config.json`)
- แนะนำ: `git init` แล้ว commit สถานะปัจจุบันเป็นจุดเริ่ม (ถามเจ้าของก่อน — กติกาเดิมคือห้าม commit เว้นแต่สั่ง)

## การตัดสินใจที่ user ยืนยันแล้ว (ห้ามเปลี่ยนเอง)

| เรื่อง | คำตอบ |
|---|---|
| โครงสร้างหลายผู้ใช้ | แบบ A: หนึ่ง core ต่อผู้ใช้ เป็น **Railway service แยก volume แยก**; gateway เป็นทางเข้าเดียว ส่งต่อทาง private network |
| สมัครบัญชี | admin สร้างให้เท่านั้น (CLI) ผู้ใช้สมัครเองไม่ได้ |
| PC agent ในแอป desktop | ปิดเป็นค่าเริ่มต้น ผู้ใช้เปิดเอง; โฟลเดอร์เฉพาะในโฮมของผู้ใช้ OS; คำสั่ง shell/power/MCP แยกเปิดอีกชั้น (ปิดเป็นค่าเริ่มต้น) |
| auto-lock | ปิดเป็นค่าเริ่มต้น; เปิดแล้ว = ออกจากระบบเต็มรูปแบบ (5/15/30/60 นาที หรือเมื่อล็อกหน้าจอ) |
| `npm run build:mac` | thin client อย่างเดียว (ไม่มี core); core ในเครื่องยังรันได้จาก source ด้วย `npm run app` |
| อิมเมจ Docker | `node:26-bookworm-slim` (เพื่อให้ permission model ปิดเน็ตของ sandbox) |

## สถานะแต่ละขั้น

| ขั้น | สถานะ | หลักฐาน |
|---|---|---|
| 1 Deploy core บน Railway (คนเดียว) | โค้ด/เอกสารเสร็จ, ทดสอบใน Docker แล้ว | `docs/hosting.md` หัวข้อ D; **ยังไม่ได้ deploy จริง** |
| 2 บัญชี + gateway | เสร็จ | `gateway.test.ts` (13), Docker 3 container ผ่าน |
| 3 Electron thin client | เสร็จ (macOS Intel) | ทดสอบแอปจริง 27 ข้อ, `build:mac` ผ่าน |
| 4 Android PWA | เสร็จ | Edge (Chromium) ไม่มี installability error, push จริงผ่าน WNS |
| 5 ทบทวนความปลอดภัย | เสร็จ | `docs/security-review.md`, `docs/admin.md`, `docs/user-guide.md` |
| sandbox expression/code tool | แก้แล้ว | `sandbox.test.ts`, ตรวจในอิมเมจ Node 26 |

ผลล่าสุด: `npm run typecheck` ผ่าน · `npm test` 557/558 (ข้าม 1) · บน Linux Node 26.12.1 ไฟล์ test ด้านความปลอดภัย 72/72

## งานที่เหลือ (เรียงตามที่แนะนำ)

1. **ย้าย workflow node "code" (`workflows/code-sandbox.ts`) มาใช้ sandbox เดียวกับ expression** (`workflows/sandbox.ts`)
   ตอนนี้แยก process อยู่แล้วแต่ยังสร้างโค้ดจากข้อความได้และรันใน global ของ process นั้น
   ต้องคงพฤติกรรมเดิม: `items`, `$json`, `$items`, `$input.all()/first()/last()/item`, `console`, คืนค่า items; ขีดจำกัด 10 MB, timeout 15 วินาที
   test เดิมใน `security.test.ts` (ค้นหา `runCodeIsolated`) และ workflow tests ต้องผ่าน + เพิ่ม test หนีออกแบบเดียวกับ `sandbox.test.ts`
2. **`undici` 7.30.0** (ผ่าน `@ai-sdk/provider-utils`) มีช่องโหว่ high ตาม `npm audit` → ต้องอัปเดต lockfile: **ขออนุมัติ user ก่อน**
3. **deploy จริงบน Railway** — เป็นงานในบัญชีของ user: ทำตามเช็กลิสต์ใน `docs/hosting.md` (หัวข้อ D และ "Railway: หลายผู้ใช้")
   agent ช่วยได้เฉพาะเมื่อ user สั่ง; สิ่งที่ต้องยืนยันหลัง deploy: header `Host` ผ่าน proxy, `*.railway.internal`, IPv6 (`MIMI_HOST=::`),
   push บนโดเมนจริง, การย้ายข้อมูลเดิม (`~/Documents/Mimi` → backup → restore), แล้วแทนตัวเลขค่าใช้จ่ายใน `docs/admin.md` ด้วยของจริง
   บัญชี Railway ตอนนี้มีโปรเจกต์ "Automation" อย่างเดียว (ไม่เกี่ยวกับงานนี้ ห้ามแตะ)
4. ที่ยังไม่ได้ทดสอบ: Android จริง/FCM, iPhone, Apple Silicon (`build:mac` บนเครื่อง arm64), Windows (`build:desktop` ยังเป็นแบบ core ในเครื่อง)
5. ให้ user ตัดสิน: อายุสูงสุดของ session, 2FA, หน้าเปลี่ยนรหัสผ่านเอง, ล้างที่อยู่เซิร์ฟเวอร์ใน `config.json` ตอนออกจากระบบ,
   ลงนาม Developer ID + notarize, Electron fuses, หน้า admin บนเว็บ (ตอนนี้มีแต่ CLI)

## แผนที่โค้ดที่เพิ่ม/เปลี่ยนใน Phase 5

| ไฟล์ | หน้าที่ |
|---|---|
| `Dockerfile`, `scripts/docker-entrypoint.sh` | Node 26, เริ่มเป็น root แค่ chown volume แล้วรันเป็น `node` |
| `packages/core/src/server/main.ts` → `run-core.ts` | เลือกบทบาท (`MIMI_MODE=gateway`) / เริ่ม core |
| `packages/core/src/server/web-files.ts` | ไฟล์หน้าเว็บ, ไอคอน PWA, CSP/security headers (ใช้ทั้ง core และ gateway) |
| `packages/core/src/server/auth-limiter.ts` | `clientAddress()` (IP จริงหลัง proxy ด้วย `MIMI_CLIENT_IP_HEADER`) |
| `packages/core/src/gateway/accounts.ts` | บัญชี: scrypt, session (hash), core token เข้ารหัส, backup |
| `packages/core/src/gateway/gateway.ts`, `gateway/main.ts` | login/logout/session, ส่งต่อ HTTP/WS, webhook `/h/<id>`, จำกัดการตรวจรหัสผ่านพร้อมกัน |
| `packages/core/src/cli/accounts.ts` (`npm run accounts`) | คำสั่ง admin |
| `packages/core/src/workflows/sandbox.ts` | process แยกสำหรับ expression และ custom code tool |
| `packages/core/src/workflows/expressions.ts` | async, ส่งเฉพาะตัวแปรที่ใช้, `$items` คำนวณเมื่อใช้ |
| `packages/core/src/chat/tool-files.ts` | ไฟล์จาก tool (ภาพหน้าจอ) → ไฟล์แนบของแชต |
| `packages/core/src/notify/web-push.ts` | ส่ง push ผ่าน `safeFetch` (กัน SSRF) |
| `packages/core/src/app/icon.ts` | ไอคอนหลายขนาด + maskable |
| `packages/core/src/server/web/*` | หน้าเข้าสู่ระบบ, "เครื่องนี้ไม่ใช่ของฉัน", ออกจากระบบล้างข้อมูล, กัน `#token=` บน gateway, offline page, SW |
| `packages/desktop/remote.cjs`, `remote-lib.cjs`, `preload.cjs`, `connect.html` | แอป Mac thin client (`npm run desktop` จาก source) |
| `packages/pc-agent/src/main.ts`, `client.ts`, `tools/browser.ts` | token ทาง stdin, `shell: false`, ปิดเบราว์เซอร์ตอนหยุด, ภาพหน้าจอส่งเป็นข้อมูล |
| `scripts/build-mac.mjs`, `electron-dist.mjs`, `run-desktop.mjs` | build thin client, ดาวน์โหลด Electron ด้วย checksum |
| test ใหม่ใน `packages/core/src/test/` | `gateway`, `sandbox`, `pwa`, `tool-files`, `desktop-remote` |

## ข้อควรรู้ก่อนเริ่ม

- test ที่ผลไม่แน่นอนอยู่แล้วตั้งแต่ก่อนเริ่ม: `chat.test.ts` "attachments are read once…" (ลำดับสลับ) — รันเดี่ยว ๆ ก็ล้มเป็นบางครั้ง
- test วัดเวลา "100-node workflow" (เกณฑ์ 5 วินาที) ล้มเมื่อเครื่องโหลดสูง (เคยเห็น load average 70–170 จากโปรแกรมอื่น)
  ถ้าล้ม ให้ดู `uptime` แล้วรันเดี่ยวหรือ `node --test --test-concurrency=4 "packages/*/src/**/*.test.ts"` ก่อนสรุปว่าโค้ดพัง (ปกติ ~1.8 วินาที)
- `browser.test.ts` ทิ้งโฟลเดอร์ `mimi-browser-*` ไว้ใน `$TMPDIR` ทุกครั้งที่รัน (พฤติกรรมเดิม) ลบได้
- `npm ci` เตือน `allowScripts` ของ better-sqlite3 — ไม่เป็นไร ใช้ไฟล์ native สำเร็จรูปของแต่ละ platform
- Electron ไม่ได้ติดตั้งผ่าน `npm ci` (install script ไม่ได้อนุมัติ) — `npm run desktop` / `build:mac` ดาวน์โหลดลง `dist/.cache` เอง
- แอปเวอร์ชันเก่าบน Mac ของ user เก็บข้อมูลที่ `~/Documents/Mimi`, `~/Library/Application Support/Electron`, `~/Library/Logs/Mimi.log` — **ห้ามลบ**
- ทดสอบแอป desktop จาก source: `MIMI_DESKTOP_DEBUG_PORT=9333 npm run desktop` แล้วคุมผ่าน DevTools protocol (แอปที่ build แล้วไม่รับ debug switch)
  แอปเขียนที่ `~/Library/Application Support/Mimi` และ `~/Library/Caches/Mimi` — ลบหลังทดสอบ

## Prompt

```text
คุณคือ agent ที่รับงาน Phase 5 ของ Mimi ต่อ (cloud core + บัญชีผู้ใช้ + แอป thin client)

ก่อนเริ่ม:
- อ่าน docs/agent-prompts/phase-5-continue.md ทั้งไฟล์ (สถานะ, การตัดสินใจที่ยืนยันแล้ว, งานที่เหลือ, ข้อควรรู้)
- อ่าน docs/agent-prompts/phase-5-cloud-accounts.md (เป้าหมายเดิมและกติกา), docs/security-review.md, docs/hosting.md, docs/admin.md
- อ่าน docs/agent-prompts/00-shared-context.md (กติกากลางของ repo)
- ตรวจไฟล์จริงก่อนแก้ ข้อเท็จจริงในเอกสารอาจล้าสมัย
- npm ci แล้วรัน npm run typecheck และ npm test เก็บ baseline (คาด 557/558 ผ่าน ข้าม 1; ดู "ข้อควรรู้" เรื่อง test ที่ผลไม่แน่นอน)
  แล้วรายงาน baseline ก่อนแก้อะไร

งาน (ทำทีละข้อ จบแต่ละข้อต้องผ่าน gate แล้วรายงานก่อนไปต่อ):

1. ย้าย workflow node "code" (packages/core/src/workflows/code-sandbox.ts) มาใช้ sandbox ใน workflows/sandbox.ts
   - คงพฤติกรรมเดิมทั้งหมด (ตัวแปร, การคืนค่า, ขีดจำกัดขนาดและเวลา, ข้อความ error ที่ test เดิมตรวจ)
   - เพิ่ม test: ทางหนีแบบเดียวกับ sandbox.test.ts ล้ม, process/require/import/fetch เข้าไม่ถึง, ค่าลับของ core มองไม่เห็น
   - ลองใส่แบบเดิมกลับชั่วคราวเพื่อยืนยันว่า test จับได้ แล้วคืนของจริง
   - Gate: typecheck, npm test, รัน test ด้านความปลอดภัยบน Linux Node 26 ใน Docker (mount repo เข้า node:26-bookworm-slim)

2. อัปเดต undici (npm audit) — **ถาม user และรอคำอนุมัติก่อนแก้ lockfile**
   - Gate: npm audit ไม่มี high, typecheck, npm test, docker build ผ่าน

3. เฉพาะเมื่อ user สั่ง: ช่วย deploy บน Railway ตามเช็กลิสต์ใน docs/hosting.md
   - ห้ามสร้าง/ลบ/แก้ทรัพยากรในบัญชี Railway เอง ถ้า user ไม่ได้สั่งในแชตทีละอย่าง; อ่านอย่างเดียวได้
   - ห้ามแตะโปรเจกต์ "Automation"
   - หลัง deploy: ยืนยันข้อที่ระบุใน "งานที่เหลือ" ข้อ 3 และแทนตัวเลขค่าใช้จ่ายใน docs/admin.md ด้วยของจริง

กติกา:
- ห้าม commit เว้นแต่ user สั่ง; ห้ามแตะ .env, token/คีย์จริง, dist/ (ยกเว้นผลของ build:mac), node_modules/ (ยกเว้น npm ci)
- ห้ามฝัง secret ใน fixture, log, ไฟล์ตั้งค่า; ห้ามยิง API ภายนอกจริงใน test
- ห้ามทำ action ที่กระทบบัญชีจริงของ user (Railway, Google, Microsoft, ส่งอีเมล) ถ้า user ไม่ได้สั่ง
- ไม่ลดความปลอดภัยที่มีอยู่ (ดู docs/security-review.md); ไม่ลบข้อมูลของ user (~/Documents/Mimi และอื่น ๆ)
- การตัดสินใจในตาราง "การตัดสินใจที่ user ยืนยันแล้ว" ห้ามเปลี่ยนเอง; เรื่องในข้อ 5 ของ "งานที่เหลือ" ให้ถามก่อน
- ถ้าโค้ดจริงขัดกับเอกสาร หรือเจอการตัดสินใจที่เป็นของ user ให้หยุดและถาม
- ทดสอบหรือรัน container เสร็จแล้วลบสิ่งที่สร้าง (container, volume, ไฟล์ชั่วคราว, โฟลเดอร์ของแอป desktop)
- อัปเดต docs/security-review.md และไฟล์นี้ (phase-5-continue.md) ให้ตรงกับสถานะใหม่เมื่อจบแต่ละข้อ

รายงานทุกข้อ:
- ไฟล์ที่แก้/เพิ่ม และเหตุผล
- ผล typecheck/test (จำนวนผ่าน/ล้ม/ข้าม) และ load ของเครื่องถ้ามี test วัดเวลาล้ม
- สิ่งที่ตรวจแล้วจริง vs สิ่งที่ยังไม่ได้ตรวจ
- ความเสี่ยงที่เหลือ และคำถามที่ต้องให้ user ตัดสิน
```
