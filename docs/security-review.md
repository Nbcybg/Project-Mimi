# ทบทวนความปลอดภัยก่อนเปิดให้ผู้อื่นใช้ (Phase 5 ขั้น 5)

ทบทวนจากโค้ดจริง ณ 2026-10-27 ครอบคลุม gateway (บัญชี/session), การแยกข้อมูลระหว่างผู้ใช้, ค่าลับ, แอป Mac, เว็บ/PWA และ PC agent
แต่ละข้อบอกว่า **แก้แล้ว** (มี test) หรือ **ยังเปิดอยู่** (พร้อมสิ่งที่แนะนำ)

## สรุป

| ระดับ | เรื่อง | สถานะ |
|---|---|---|
| สูง | expression ใน workflow และ custom tool แบบ code หลุด sandbox (`vm`) รันโค้ดใน core ได้ | แก้แล้ว: ย้ายไปรันใน process แยกที่ล็อกไว้ (ดูข้อ 2) |
| สูง | ลิงก์ `/#token=` บน gateway ทำให้เหยื่อเข้าบัญชีของผู้โจมตีได้ (chat ของเหยื่อไปอยู่ในบัญชีผู้โจมตี) | แก้แล้ว |
| กลาง | หน้าเว็บไม่มี CSP และถูกฝังใน iframe ของเว็บอื่นได้ (clickjacking) | แก้แล้ว |
| กลาง | ปลายทาง push มาจากอุปกรณ์ core ส่ง POST ไปที่อยู่ภายในเครือข่ายเซิร์ฟเวอร์ได้ (SSRF) | แก้แล้ว (ขั้น 4) |
| กลาง | PC agent: คำสั่ง shell/power/MCP ทำงานด้วยสิทธิ์เต็มของผู้ใช้ OS ไม่ถูกจำกัดด้วยโฟลเดอร์ที่อนุญาต | แก้แล้ว: ปิดเป็นค่าเริ่มต้นในแอป Mac |
| กลาง | ล็อกอินพร้อมกันจำนวนมากกิน CPU ได้ไม่จำกัด (scrypt ตั้งใจให้ช้า) | แก้แล้ว |
| กลาง | `undici` 7.30.0 (ผ่าน `@ai-sdk/provider-utils`) มีช่องโหว่ระดับ high ตาม `npm audit` | **ยังเปิด** — ต้องอัปเดต lockfile (รออนุมัติ) |
| ต่ำ | `/auth/login` รับ body ทุก content-type | แก้แล้ว |
| ต่ำ | ไม่มีอายุสูงสุดของ session (ใช้อยู่เรื่อย ๆ ต่ออายุได้ไม่จำกัด), ไม่มี 2FA, ผู้ใช้เปลี่ยนรหัสผ่านเองไม่ได้ | ยังเปิด (การตัดสินใจของเจ้าของระบบ) |
| ต่ำ | แอป Mac ลงนามแบบ ad hoc, Electron fuses ค่าเริ่มต้น | ยังเปิด |

## 1. ล็อกอินและ session (gateway)

ตรวจแล้วถูกต้อง:
- รหัสผ่าน: scrypt N=32768, r=8, p=1, salt 16 byte ต่อบัญชี, เทียบแบบ timing-safe; ผู้ใช้ที่ไม่มีอยู่/ถูกระงับ/รหัสผิด ตอบเหมือนกันและใช้เวลาเท่ากัน (dummy hash)
- session token สุ่ม 32 byte, เก็บเฉพาะ SHA-256, หมดอายุเมื่อไม่ได้ใช้ 30 วัน, ออกจากระบบ = เพิกถอนที่ server และปิด WebSocket ที่เปิดอยู่ทันที, คำสั่ง admin จากอีก process มีผลภายใน ~30 วินาที
- ลองผิด: 10 ครั้ง/ที่อยู่/10 นาที และ 20 ครั้ง/บัญชี → พัก 15 นาที (ใช้ `AuthLimiter` เดิม)
- log มีแค่ "ใคร ล็อกอินจาก IP ไหน" ไม่มีรหัสผ่านหรือ token (ตรวจใน container แล้ว)
- token อยู่ใน localStorage (หรือ sessionStorage เมื่อ "เครื่องนี้ไม่ใช่ของฉัน") ไม่ใช้ cookie จึงไม่มี CSRF แบบ cookie

แก้ในรอบนี้:
- **ลิงก์ที่มี token**: เดิมเว็บรับ `#token=` จาก URL เสมอ ผู้โจมตีส่งลิงก์ที่มี session ของตัวเองให้เหยื่อ เหยื่อจะอยู่ในบัญชีผู้โจมตีโดยไม่รู้ตัว
  ตอนนี้บน gateway รับเฉพาะในแอป Mac (ซึ่งใส่ลิงก์เอง) ส่วน core คนเดียวยังรับได้ (launcher ใช้) — ทดสอบกับ Edge จริงทั้งสองแบบ
- `/auth/login` รับเฉพาะ `application/json` (415 ถ้าไม่ใช่)
- ตรวจรหัสผ่านพร้อมกันได้ 4 ตัว รอคิวได้ 32 ที่เหลือได้ 503 + `Retry-After` (test: 40 คำขอพร้อมกัน)

ยังเปิด (ให้เจ้าของระบบตัดสิน): อายุสูงสุดของ session (เช่น 180 วัน), 2FA, หน้าเปลี่ยนรหัสผ่านเอง, แจ้งเตือนเมื่อมีการล็อกอินใหม่

## 2. การแยกข้อมูลระหว่างผู้ใช้

โครงสร้าง: core ของแต่ละคนเป็น Railway service แยก volume แยก ไม่มี public domain; gateway เป็นทางเข้าเดียว
- ทดสอบแล้ว (unit + Docker 3 container): HTTP, WebSocket, workflow, trigger, webhook, tool และการขออนุญาต ไม่ข้ามคน; token ของ core ไม่ออกจาก gateway; session token ใช้ตรงกับ core ไม่ได้
- private network ของ Railway เปิดถึงกันทุก service ในโปรเจกต์: core ของคนหนึ่งต่อ core อีกคนได้ แต่ทุกอย่างต้องใช้ token 256 บิตของ core นั้น
  ยกเว้น `/health`, หน้าเว็บ และ webhook (key สุ่ม 18 byte) — ทดสอบการเดา token ข้าม container แล้วถูกปฏิเสธ
- คำขอที่มาทาง private network ถึง gateway ปลอม `x-real-ip` ได้ (ไม่ผ่าน edge ของ Railway) จึงหลบการนับตาม IP ได้ แต่ยังติดการนับตามบัญชี (20 ครั้ง)
- **แก้แล้ว (เดิมระดับสูง)**: expression ใน workflow (`workflows/expressions.ts`) และ custom tool แบบ code (`tools/custom-tools.ts`)
  เดิมรันด้วย `vm` ใน process ของ core จึงหลุดไปถึง `process` ได้ (คีย์ API, token, ไฟล์) ตอนนี้รันใน **process แยก** (`workflows/sandbox.ts`)
  ที่เปิดค้างไว้หนึ่งตัวต่อ core หลายชั้น:
  - permission model ของ Node: อ่าน/เขียนไฟล์ไม่ได้, เปิด process ลูกไม่ได้, worker ไม่ได้, native addon ไม่ได้ (Node 25 ขึ้นไป: ออกเน็ตไม่ได้ด้วย)
  - environment ว่าง (ไม่มีคีย์), `--disallow-code-generation-from-strings` (eval / new Function ใช้ไม่ได้ทั้ง process)
  - ทุกคำขอได้ context ใหม่ที่ข้อมูลเข้ามาเป็นข้อความ JSON จึงไม่มี object ของ process นั้นให้เอื้อมถึง
  - จำกัดเวลา: expression 1 วินาที, code tool ตามที่ตั้ง (ค่าเริ่มต้น 10 วินาที) วนไม่จบ = process ถูกฆ่าแล้วเริ่มใหม่
  - ส่งเฉพาะตัวแปรที่ expression ใช้ (`$json`, `$items`, …) และรวมทุก expression ของ config หนึ่งเป็นคำขอเดียว (1,000 item ≈ 0.75 วินาที)
  test (`sandbox.test.ts`): ทางหนีที่รู้จัก 7 แบบ (constructor.constructor, eval, new Function, import ฯลฯ) ล้มทั้งใน expression และ code tool,
  ค่าที่ core ถือไว้ (canary ใน env และ global) มองไม่เห็น, probe ที่รันด้วย command line เดียวกับ sandbox อ่าน/เขียนไฟล์ เปิด process
  สร้าง worker และสร้างโค้ดจากข้อความไม่ได้ และ env ว่าง · ทดสอบซ้ำบน Linux + Node 24.22.1 (อิมเมจ production) ผ่าน ·
  ลองใส่แบบเดิม (vm ใน process) กลับไปชั่วคราว test จับได้ว่าเข้าถึง `process` ของ core ได้
- อิมเมจ Docker ใช้ **Node 26** (`node:26-bookworm-slim`) ตั้งแต่ 2026-10-27: permission model ปิดเน็ตของ process sandbox ด้วย
  ตรวจในอิมเมจจริงแล้ว: TCP และ `fetch` ได้ `ERR_ACCESS_DENIED` (ถ้ารัน core เองบน Node 24 ชั้นนี้จะไม่มี เหลือชั้นอื่นทั้งหมด)
- node "code" ของ workflow (`code-sandbox.ts`) แยก process อยู่แล้วตั้งแต่ก่อน (ไม่มีไฟล์ ไม่มี env และบน Node 26 ไม่มีเน็ต)
  แต่ยังไม่ปิดการสร้างโค้ดจากข้อความและรันใน global ของ process นั้น ถ้าจะให้เท่ากันควรย้ายมาใช้ sandbox เดียวกัน

## 3. ค่าลับ

- `MIMI_GATEWAY_SECRET` (≥ 32) เข้ารหัส token ของ core ในฐานข้อมูลบัญชี (AES-256-GCM, กุญแจจาก HKDF) ไฟล์ฐานข้อมูล mode 600
  สำเนาฐานข้อมูล (`accounts.ts backup`) ใช้ไม่ได้ถ้าไม่มี secret — เก็บ secret แยกจากสำเนา
- token ของ core อยู่ในตัวแปรของ service นั้นเท่านั้น; คำสั่ง `add`/`rotate-core-token` แสดงครั้งเดียวบนจอของ admin
- ใน core: `secrets.json`, `auth.json` mode 600 อยู่ใน volume ของคนนั้น; backup อัตโนมัติมีค่าลับด้วย (mode 600 อยู่ใน volume เดียวกัน)
- แนะนำบน Railway: ตั้ง `MIMI_GATEWAY_SECRET` และ `MIMI_TOKEN` เป็น sealed variable, จำกัดสมาชิก workspace ที่เห็น variables
- ข้อควรรู้: **admin ที่เข้า Railway ได้ อ่านข้อมูลของผู้ใช้ทุกคนได้** (volume, ตัวแปร) แจ้งผู้ใช้ไว้ในคู่มือแล้ว

## 4. เว็บ / PWA

- ไม่พบจุดที่ข้อความจากโมเดลหรือผู้ใช้กลายเป็น HTML: render ด้วย `textContent`, ลิงก์เฉพาะ `http(s)` (innerHTML มีแค่ไอคอนคงที่)
- แก้แล้ว: หน้าเว็บส่ง CSP (สคริปต์เฉพาะจาก server + import map ตาม hash, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`),
  `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, HSTS (180 วัน) — ตรวจกับ Edge จริงแล้วทุกหน้า
  รวม three.js/VRM ไม่มีการละเมิด CSP และเว็บอื่นฝังแอปใน iframe ไม่ได้
- ออกจากระบบ: เลิก push ของเครื่องนี้ทั้งที่เบราว์เซอร์และที่ core, ล้าง localStorage/sessionStorage (ทดสอบกับ Edge จริง)

## 5. แอป Mac

- หน้าต่างใช้ partition ในหน่วยความจำ, `contextIsolation` + `sandbox`, preload รับคำสั่งเฉพาะจาก server ที่ตั้งไว้/หน้า connect, นำทางออกนอก server ไม่ได้
- token เก็บด้วย safeStorage (Keychain); ออกจากระบบ/ล็อกอัตโนมัติ = เพิกถอน + ล้าง + เริ่มใหม่ (ทดสอบ 27 ข้อ)
- แอปที่ build แล้วไม่ยอมเปิดเมื่อมี `--remote-debugging-port`
- ยังเปิด: ลงนาม Developer ID + notarize, Electron fuses (`RunAsNode` ต้องเปิดไว้เพราะ PC agent ใช้)

## 6. PC agent (การเข้าถึงไฟล์บนเครื่องผู้ใช้)

- path guard แปลง symlink ด้วย realpath ก่อนเทียบ, ปฏิเสธ `\0`, ทดสอบ `/etc/hosts` แล้วถูกปฏิเสธ
- แอป Mac เลือกโฟลเดอร์ได้เฉพาะโฟลเดอร์ย่อยในโฮมของผู้ใช้ OS (ไม่รับโฮมทั้งหมด, `Library`, `.ssh`, `.gnupg`)
- token ส่งทาง stdin ไม่อยู่ใน environment/รายการ process; ออกจากระบบแล้ว process หยุดและ gateway ตัดการเชื่อมต่อ
- เบราว์เซอร์ของ agent: ไม่ดาวน์โหลดไฟล์เอง, ไม่เปิด localhost/LAN (เว้นตั้ง `MIMI_BROWSER_ALLOW_LOCAL=1`), โปรไฟล์ถูกลบตอนออกจากระบบ
- **แก้แล้ว**: `run_shell`, `stop_process`, `power` และ MCP บน PC ทำงานด้วยสิทธิ์เต็มของผู้ใช้ OS (อ่านไฟล์นอกโฟลเดอร์ที่อนุญาตได้)
  ตอนนี้ในแอป Mac ปิดเป็นค่าเริ่มต้น เปิดได้ที่เมนู "อนุญาตให้รันคำสั่งบนเครื่องนี้ (shell)" (มีคำเตือน) ทุกคำสั่งยังต้องกดอนุญาตในแชต
  `npm run pc-agent` แบบเดิมยังเปิดอยู่ (ตั้ง `MIMI_PC_SHELL=0` เพื่อปิด)

## สิ่งที่ยังไม่ได้ตรวจ

deploy จริงบน Railway (header `Host`, `*.railway.internal`, IPv6), Android จริง/FCM, iPhone, Apple Silicon, Windows,
การทดสอบเจาะระบบโดยบุคคลภายนอก, การทบทวน dependency ทั้งหมด (ทำแค่ `npm audit`)
