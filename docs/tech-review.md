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
