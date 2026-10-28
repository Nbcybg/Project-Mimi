# Phase 5 — Cloud core, บัญชีผู้ใช้, แอป thin client 3 ระดับ

Prompt นี้สำหรับ agent ตัวเดียว (Opus) ที่ทำงานเป็นขั้นตามลำดับ ไม่ใช่หลาย workstream พร้อมกัน
คัดลอกบล็อก "Prompt" ด้านล่างไปใช้ได้เลย

## ข้อเท็จจริงที่ตรวจแล้ว (ณ v0.5.0 — ตรวจซ้ำก่อนพึ่ง)

- core เป็น Node process เดียว (`packages/core/src/server/main.ts`) ใช้ SQLite (`better-sqlite3`) ข้อมูลอยู่ใน `user/` + `mimi.json`
- auth ปัจจุบัน = shared secret `MIMI_TOKEN` ตัวเดียว (`server/http-api.ts`, `server/auth-limiter.ts`) **ไม่มีบัญชีผู้ใช้/รหัสผ่านรายคน**
- schema/migration (`packages/core/src/db/`) ไม่มี `user_id` ในตาราง chat/memory/trigger/workflow — ข้อมูลทั้งหมดเป็นของคนเดียว
- `packages/core/src/app/launcher.ts` เปิด core ในเครื่องแล้วให้ Electron (`packages/desktop/main.cjs`) ต่อ; ข้อมูลอยู่ที่ `Documents/Mimi`
- ปิดหน้าต่าง Electron = ซ่อนใน tray (state ค้าง)
- โปรไฟล์ผู้ใช้มีฟิลด์ `localOnly` เก็บนอกโฟลเดอร์ที่ sync (`profile/user-profile.ts`)
- PC agent (`packages/pc-agent`) ทำ shell/ไฟล์/เบราว์เซอร์บนเครื่อง; โปรไฟล์เบราว์เซอร์ที่ `~/.mimi/browser-profile`; ภาพหน้าจอลงโฟลเดอร์แรกใน `ALLOWED_DIRS`
- มี `Dockerfile`, `docker-compose.yml`, `docs/hosting.md` (แบบ A Tailscale / B Cloudflare Tunnel / C VPS+Docker)
- ผลตรวจล่าสุด: `npm run typecheck` ผ่าน, `npm test` ผ่าน 529/530 (ข้าม 1); core ว่างใช้ RAM ≈ 180 MB, CPU ≈ 0%
- `npm ci` เตือนว่า `better-sqlite3` install script ยังไม่ถูก approve (`allowScripts`) — ตรวจว่า Docker build ได้ native module จริง
- ต้องใช้ Node >= 24

## การตัดสินใจที่ user ยืนยันแล้ว

1. core ตัวเดียวอยู่บนคลาวด์ (Railway) เป็น source of truth; ทุก client เป็นแค่หน้าจอ
2. client มี 3 ระดับ: เว็บ (PWA) → Android → Windows/macOS (Electron)
3. จะเปิดให้คนอื่นใช้ในอนาคต: เริ่มแอปต้องมีหน้าล็อกอิน username + password แล้วจำ session ไว้จนกว่าจะ logout
4. คอมพิวเตอร์อาจถูกใช้หลายคน → **ห้ามฝังข้อมูลของ Mimi ในเครื่อง** (DB, secrets, token Google/Microsoft, ไฟล์แนบ, คลังความรู้, โปรไฟล์เบราว์เซอร์ของ agent)
   เครื่องเก็บได้เฉพาะ session token (OS keychain) และ cache ชั่วคราวที่ล้างตอน logout
5. ลำดับงาน: deploy core ปัจจุบันขึ้น Railway ก่อน → บัญชี/ล็อกอิน → Electron โหมดต่อ core ระยะไกล → Android → เปิดให้ผู้อื่นใช้

## การตัดสินใจที่ user ยังไม่ได้ตอบ — ห้ามเดา

- **A (หนึ่ง core/โฟลเดอร์ `user/` ต่อผู้ใช้) หรือ B (core เดียว หลายผู้ใช้ ใส่ `user_id` ทุกตาราง)** — Opus ที่ทำงานนี้แนะนำ A ในช่วงแรก แต่ user ยังไม่ยืนยัน
- **ผู้ใช้สมัครเองได้ หรือ admin สร้างบัญชีให้**

ขั้น 1 ทำได้เลยโดยไม่ต้องรู้คำตอบ ส่วนขั้น 2 เป็นต้นไปต้อง **หยุดและถาม user** ถ้ายังไม่มีคำตอบสองข้อนี้

## Prompt

```text
คุณคือ agent ที่ดูแลงาน Phase 5 ของ Mimi (cloud core + บัญชีผู้ใช้ + แอป thin client)

ก่อนเริ่ม:
- อ่าน docs/agent-prompts/phase-5-cloud-accounts.md ทั้งไฟล์ (ข้อเท็จจริง, การตัดสินใจ, คำถามที่ยังเปิด)
- อ่าน docs/agent-prompts/00-shared-context.md, docs/hosting.md, docs/tech-review.md
- ตรวจไฟล์จริงใน repo ก่อนแก้ ข้อเท็จจริงในเอกสารอาจล้าสมัย
- รัน npm run typecheck และ npm test เพื่อเก็บ baseline (คาดว่า 529/530 ผ่าน)

เป้าหมายเรียงตามลำดับ (ทำทีละขั้น จบแต่ละขั้นต้องผ่าน gate แล้วรายงานก่อนไปต่อ):

ขั้น 1 — Deploy core ปัจจุบันขึ้น Railway (single-user, ใช้ MIMI_TOKEN เดิม)
  - ตรวจ Dockerfile/docker-compose ว่าสร้างอิมเมจได้จริง รวมถึง native module better-sqlite3
  - เพิ่มไฟล์ตั้งค่า Railway ที่จำเป็น (เช่น railway.json/health check) และ endpoint health check ถ้ายังไม่มี
    (ต้องไม่ต้องใช้ token และไม่เปิดเผยข้อมูล)
  - เอกสารขั้นตอนสำหรับ user ใน docs/hosting.md (หัวข้อ Railway): volume ที่ /app/user, MIMI_HOST=0.0.0.0,
    MIMI_TOKEN ยาว >= 32 ตัวอักษร, MIMI_LOCAL_PC_TOOLS=0, instance เดียวเท่านั้น (SQLite + trigger ห้ามซ้ำ), backup
  - ตรวจ WebSocket ผ่าน proxy (header Host), HTTPS, Push notification
  - Gate: build อิมเมจผ่าน, รัน container ในเครื่องแล้วเปิดหน้าเว็บ/WS ได้, typecheck/test ผ่าน
  - ส่วนที่ต้องทำในบัญชี Railway (สร้างโปรเจกต์, ผูก volume, ใส่ secret) เป็นของ user — เขียนเป็นเช็กลิสต์ให้ ไม่ต้องพยายามทำเอง

ขั้น 2 — บัญชีผู้ใช้และการล็อกอิน  [ต้องมีคำตอบ A/B และเรื่องการสมัคร ก่อนเริ่ม; ถ้าไม่มี ให้หยุดและถาม]
  - username + password, เก็บ hash ด้วย scrypt/argon2 (ใช้ crypto ของ Node ถ้าไม่อยากเพิ่ม dependency), salt ต่อบัญชี
  - session token สุ่มยาว, เก็บ hash ฝั่งเซิร์ฟเวอร์, หมดอายุได้, logout = เพิกถอน token ที่ server
  - ใช้ AuthLimiter เดิมกับการล็อกอิน; ไม่ log รหัสผ่านหรือ token
  - ถ้าเลือก A: ตัวกำหนดเส้นทางที่ส่งผู้ใช้ไป core/โฟลเดอร์ของตนเอง โดยข้อมูลต้องแยกขาด
    ถ้าเลือก B: เพิ่ม migration ใส่ user_id ทุกตาราง + ทุก query + scheduler/trigger/secrets/connector/PC agent ต้องกรองตามผู้ใช้
  - Gate: test ที่พิสูจน์ว่าผู้ใช้ X ไม่เห็น/แก้ข้อมูลของผู้ใช้ Y ในทุกพื้นผิว (HTTP, WS, workflow, trigger, tool),
    ล็อกอินผิดซ้ำถูกบล็อก, logout แล้ว token เดิมใช้ไม่ได้

ขั้น 3 — Electron โหมดต่อ core ระยะไกล (ไม่เก็บข้อมูลในเครื่อง)
  - ช่องใส่ URL ของ core + หน้าล็อกอิน; ตัดการรัน core ในเครื่องออกจากแอปที่แจกผู้อื่น
  - เก็บ session token ด้วย safeStorage/OS keychain ผูกกับ OS account; logout ล้าง token และ cache ทั้งหมด
  - auto-lock เมื่อไม่ได้ใช้ (ตั้งเวลาได้) เพราะปิดหน้าต่างแค่ซ่อนใน tray
  - ย้ายฟิลด์โปรไฟล์ localOnly ไปฝั่ง core ต่อผู้ใช้; ภาพหน้าจอเบราว์เซอร์ของ agent ส่งขึ้น core แล้วลบจากเครื่อง;
    โปรไฟล์เบราว์เซอร์ของ agent แยกตามผู้ใช้ Mimi
  - PC agent ผูกกับ OS account ที่รันอยู่ ตัดการเชื่อมต่อทันทีเมื่อ logout; ขอบเขตไฟล์ตาม OS account
  - เว็บ: ช่อง "เครื่องนี้ไม่ใช่ของฉัน" = เก็บ session แค่ตอน tab เปิด (sessionStorage)
  - Gate: ตรวจว่าหลัง logout ไม่มีไฟล์/ข้อมูลของ Mimi เหลือในเครื่อง (รายการตำแหน่งที่ตรวจต้องอยู่ในรายงาน), npm run build:mac ผ่าน

ขั้น 4 — Android: เริ่มจาก PWA (manifest, service worker, Push บน HTTPS) ตรวจ UI ที่ความกว้างมือถือ;
  ห่อ Capacitor/TWA เฉพาะเมื่อ user ขอ

ขั้น 5 — ก่อนเปิดให้ผู้อื่นใช้: ทบทวนความปลอดภัย (ล็อกอิน, session, การแยกข้อมูล, secrets, การเข้าถึงไฟล์ของ PC agent),
  เอกสารสำหรับ admin และผู้ใช้, แผน backup/กู้คืน, สรุปต้นทุนจากข้อมูลใช้งานจริงบน Railway

กติกา:
- ห้าม commit เว้นแต่ user สั่ง; ห้ามแตะ .env, token/คีย์จริง, dist/, node_modules/
- ห้ามฝัง secret ใน fixture, log, ไฟล์ตั้งค่า; ห้ามยิง API ภายนอกจริงใน test
- ห้ามทำ action ที่กระทบบัญชีจริงของ user (Railway, Google, Microsoft, ส่งอีเมล) ถ้า user ไม่ได้สั่ง
- ไม่ลดความปลอดภัยเดิม (AuthLimiter, guarded outbound HTTP, redaction); ไม่ลบ preset/ข้อมูลเดิมของ user
- ถ้ามีไฟล์กลางที่เสี่ยงชน (server.ts, core.ts, shared/*) ให้แก้ทีละขั้นและรัน test ทุกครั้ง
- ถ้าโค้ดจริงขัดกับเอกสารนี้ หรือเจอการตัดสินใจที่เป็นของ user ให้หยุดและถามก่อนเดา
- รัน npm run typecheck และ npm test ที่ทุก gate; รายงานตามจริง รวมสิ่งที่ยังไม่ได้ทำหรือไม่ได้ตรวจ

รายงานส่งทุกขั้น:
- ไฟล์ที่แก้/เพิ่ม และเหตุผล
- ผล typecheck/test (จำนวนผ่าน/ล้ม/ข้าม)
- สิ่งที่ตรวจแล้วจริง vs สิ่งที่ยังไม่ได้ตรวจ
- ความเสี่ยงที่เหลือ และคำถามที่ต้องให้ user ตัดสิน
```
