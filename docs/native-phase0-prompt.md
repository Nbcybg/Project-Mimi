# Prompt: Native clients, Phase 0 — the API contract

คัดลอกทั้งหมดด้านล่างไปวางเป็นข้อความแรกของเซสชันใหม่ (working directory = root ของโปรเจกต์ Mimi)

---

## เป้าหมายโปรเจกต์

Mimi เป็น AI เลขาส่วนตัว: core (Node) รันบน Railway ทำหน้าที่ 3 อย่างเท่านั้น คือ **ประมวลผล** (เรียก LLM, workflow, trigger, MCP),
**เก็บข้อมูลผู้ใช้** (SQLite, บัญชี, credential ใน volume `/app/user`) และ **sync** ข้อมูลระหว่างอุปกรณ์

ตอนนี้ UI ทุกแพลตฟอร์มเป็นเว็บที่เซิร์ฟเวอร์เสิร์ฟ: Electron (`packages/desktop/remote.cjs` ทำ `loadURL(server)`)
และ Android (`android/…/MainActivity.java` ใช้ WebView) ผลคือ UI เป็นเวอร์ชันเดียวกับที่ deploy บน Railway เสมอ

**เป้าหมายใหม่:** แอป **native แท้ ไม่ใช้ WebView** ทุกแพลตฟอร์ม ทุกฟีเจอร์ และเซิร์ฟเวอร์ไม่ต้องเสิร์ฟ UI อีกต่อไป
- Mac / iOS: SwiftUI · Android: Kotlin + Jetpack Compose · Windows: เลือกใน Phase 0 (แนะนำ WinUI 3 / C#)
- แอปคุยกับ core ผ่าน HTTP + WebSocket เท่านั้น

## งานของเซสชันนี้ (Phase 0): เขียนสเปก API กลาง — ห้ามเขียนโค้ดแอปหรือแก้พฤติกรรมเซิร์ฟเวอร์

ผลลัพธ์คือเอกสารที่ทีมเขียนแอป native ใช้งานได้โดยไม่ต้องอ่านโค้ดเซิร์ฟเวอร์

### ต้องอ่านก่อน
- `packages/shared/src/protocol.ts` (ชนิดข้อความ WebSocket / REST)
- `packages/core/src/server/http-api.ts`, `server.ts`, `web-files.ts` (เส้นทางและ auth)
- `packages/core/src/server/web/app.js` และ `feature-*.js` (25 ไฟล์) — **ดูว่า UI เดิมเรียกอะไรจริง** เพราะนี่คือรายการฟีเจอร์ที่แอป native ต้องทำให้ครบ
- `packages/core/src/accounts/` หรือโค้ดบัญชี/ล็อกอิน (`/auth/login`, session token, โหมด gateway หลายผู้ใช้)
- `android/README.md` และ `android/app/src/main/java/app/mimi/android/` (push, widget, `GET /api/widget`)
- `docs/user-guide.md`, `docs/hosting.md`, `docs/security-review.md`, `docs/error-codes.md`, `CHANGELOG.md` (ส่วน Unreleased)

### ส่งมอบ (เขียนที่ `docs/native/`)
1. `api-contract.md` — ทุก endpoint: method, path, auth, request/response (ชนิดข้อมูล, ตัวอย่าง JSON จริง), error code, ข้อจำกัด (ขนาด, rate limit)
2. `realtime.md` — WebSocket `/ws`: handshake, ชนิดข้อความทุกแบบ, ลำดับเหตุการณ์ของแชตแบบ streaming, reconnect/resume, heartbeat
3. `auth-and-session.md` — ล็อกอิน, token, หมดอายุ, remember-me, โหมดบัญชีหลายผู้ใช้, สิ่งที่แอปต้องเก็บใน keychain/keystore
4. `feature-inventory.md` — ตารางทุกฟีเจอร์ของ UI เดิม (ชื่อ, หน้าจอ, endpoint ที่ใช้, ความยาก S/M/L, พึ่งพา API ของแพลตฟอร์มอะไร เช่น ไมค์ กล้อง Web Audio ฯลฯ) จัดลำดับความสำคัญเป็นเฟส
5. `media.md` — เสียง/Mimiamp (`/mimiamp/tracks.json`, stream, range request, YouTube), ไฟล์อัปโหลด, VRM/3D, รูป — แต่ละอย่างฝั่ง native ต้องใช้อะไร
6. `push-and-background.md` — Web Push เดิมกับสิ่งที่ native ต้องใช้แทน (APNs / FCM / polling) และสิ่งที่เซิร์ฟเวอร์ต้องเพิ่ม
7. `server-gaps.md` — สิ่งที่เซิร์ฟเวอร์ต้องเพิ่มหรือแก้เพื่อรองรับ native (เช่น API ที่ UI เดิมเรียกผ่านโค้ดฝั่ง client เท่านั้น, endpoint ที่ผูกกับ cookie/พาธสัมพัทธ์, การเช็กเวอร์ชัน client/server, endpoint สำหรับ push token) พร้อมประเมินขนาดงาน
8. `windows-stack.md` — เปรียบเทียบสั้น ๆ แล้วแนะนำ stack ของ Windows พร้อมเหตุผล

### กติกา
- ทุกข้อความในสเปกต้องมาจากโค้ดจริง ระบุไฟล์:บรรทัดอ้างอิง ถ้าไม่แน่ใจให้ทดสอบกับเซิร์ฟเวอร์ที่รันในเครื่อง (`npm run serve`, ใช้ข้อมูลทดสอบ) ห้ามเดา
- ห้ามเรียกเซิร์ฟเวอร์ production บน Railway ด้วย token จริง และห้าม deploy
- ถ้าเจอ endpoint ที่ไม่สอดคล้องกับ `protocol.ts` ให้บันทึกใน `server-gaps.md` ไม่ต้องแก้เอง
- เขียนเป็นภาษาไทย ศัพท์เทคนิคเป็นอังกฤษ
- จบด้วยรายการ "คำถามที่ต้องให้เจ้าของโปรเจกต์ตัดสินใจ" และลำดับเฟสที่เสนอ (Android → Mac → iOS → Windows → ฟีเจอร์หนักอย่าง workflow canvas กับ VRM ทีหลัง)

### ถือว่าเสร็จเมื่อ
นักพัฒนา Android คนหนึ่งอ่านเฉพาะ `docs/native/` แล้วเขียนหน้าล็อกอิน + แชตแบบ streaming + เครื่องเล่น Mimiamp ได้โดยไม่ต้องเปิดโค้ดเซิร์ฟเวอร์
