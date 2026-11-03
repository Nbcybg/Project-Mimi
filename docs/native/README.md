# Mimi native clients — สเปก (Phase 0)

แอป Mimi ทุกแพลตฟอร์มจะเป็น **native แท้ ไม่ใช้ WebView** (Android: Kotlin + Jetpack Compose, Mac/iOS: SwiftUI, Windows: WinUI 3)
คุยกับ core ผ่าน HTTP + WebSocket เท่านั้น เอกสารในโฟลเดอร์นี้คือสัญญาระหว่างแอปกับเซิร์ฟเวอร์ — เขียนจากโค้ดจริง `0.8.1-prototype`
(อ้างอิง `ไฟล์:บรรทัด`) และทดสอบกับ core + gateway ที่รันในเครื่องด้วยข้อมูลทดสอบและ LLM จำลอง (2026-11-02) ไม่ได้เรียก Railway

## อ่านตามลำดับนี้

| ไฟล์ | อ่านเมื่อ |
|---|---|
| [auth-and-session.md](auth-and-session.md) | ทำหน้าเชื่อมต่อ/ล็อกอิน, เก็บ token |
| [realtime.md](realtime.md) | ทำ WebSocket, แชต streaming, reconnect |
| [api-contract.md](api-contract.md) | ทุก endpoint HTTP + ทุกคำสั่ง WS และคำตอบ |
| [media.md](media.md) | Mimiamp, ไฟล์แนบ, ข้อความเสียง, รูป, VRM |
| [push-and-background.md](push-and-background.md) | แจ้งเตือน, widget, งานเบื้องหลัง |
| [feature-inventory.md](feature-inventory.md) | รายการฟีเจอร์ทั้งหมดของ UI เดิม + เฟส |
| [api-versioning.md](api-versioning.md) | เช็กเวอร์ชันแอป/เซิร์ฟเวอร์ และนโยบายเลิกรองรับ |
| [server-gaps.md](server-gaps.md) | สิ่งที่เซิร์ฟเวอร์ต้องแก้ พร้อมสถานะหลัง Phase 1 |
| [windows-stack.md](windows-stack.md) | เหตุผลที่เลือก stack ของ Windows |

## สถานะ

- **Phase 0** (สเปก) เสร็จ 2026-11-02
- **Phase 1** (เซิร์ฟเวอร์) เสร็จใน Unreleased: client API **1** — เช็กเวอร์ชัน, push FCM/APNs, Range, Mimiamp ผ่าน gateway,
  `chat-turn-messages` / `chat-open.afterId`, `MIMI_SERVE_WEB=0`, เพลงย้ายไป volume สิ่งที่ยังเหลือดูคอลัมน์สถานะใน [server-gaps.md](server-gaps.md)
  ส่วนที่เพิ่มในสเปกมีป้าย **[api 1]**
- **Phase 2** (Android) โค้ดครบตามขอบเขต MVP ใน `android/` (Kotlin + Compose ไม่มี WebView) build ผ่าน, unit test 21 ตัวผ่าน —
  **ยังไม่ได้ทดสอบ flow เต็มบนเครื่องจริง/emulator** (ดู "สถานะ Phase 2" ใน [android/README.md](../../android/README.md));
  2026-11-03 build + unit test ผ่านบน Windows แล้ว และทำ APK debug ให้ทดสอบบนมือถือจริงกับ core ในเครื่องผ่าน LAN
- **Phase 3/4** (Mac, iOS) ข้ามไปก่อน — ทำบนเครื่อง Windows ไม่ได้
- **Phase 5** (Windows) MVP ใน `apps/windows/` (WinUI 3 + .NET 10, ไม่มี WebView) build ผ่าน, unit test 52 ตัว + UI test (ล็อกอิน → แชต → เล่นเพลง)
  ผ่านกับ core ในเครื่อง — สิ่งที่ยังไม่ทำ/ไม่ได้ทดสอบดู [apps/windows/README.md](../../apps/windows/README.md) (สำคัญ: ยังไม่มี WNS)

## เส้นทางลัด: หน้าล็อกอิน + แชต streaming + Mimiamp บน Android

1. `GET /health` → `accounts: true`? → `POST /auth/login` (auth ข้อ 1, 3) หรือรับ token ตรง ๆ (auth ข้อ 2) → เก็บใน Keystore (auth ข้อ 8)
2. OkHttp WebSocket `wss://host/ws` → `hello` → `welcome` → `agents-list`, `chats-list`, `settings-get`, `presence` (realtime ข้อ 2)
0. `GET /health` → เช็ก `api` / `minClientApi` (api-versioning) แล้วส่ง `hello.client` ด้วย
3. `chat-open` → แสดง `chat-history`; `chat-send` พร้อม `clientId` → จัดการ frame ตามตาราง realtime ข้อ 4.3; `chat-turn-messages` แทน bubble ที่ stream มา
4. ping ทุก 25 วินาที, reconnect backoff 1→15 วินาที, close `4003` = กลับหน้าล็อกอิน (realtime ข้อ 7)
5. Mimiamp: `GET /api/mimiamp/state` → เล่น `<base>` + `track.url` ด้วย Media3 พร้อม header Bearer (Range ใช้ได้ทั้ง core และ gateway);
   YouTube: `POST …/prepare` ก่อน (media ข้อ 1.3); ทำตาม frame `mimiamp` (media ข้อ 1.4)
6. Push: `POST /api/push/register {platform:"fcm", token}` ทุกครั้งที่ได้ token; ข้อความจริงดึงจาก `/api/notifications?afterId=` (push ข้อ 2.2)

## ลำดับเฟสที่เสนอ

```
0 สเปก (โฟลเดอร์นี้) ─▶ 1 แก้เซิร์ฟเวอร์ (server-gaps P1) ─▶ 2 Android ─▶ 3 Mac ─▶ 4 iOS ─▶ 5 Windows
                                                       └▶ 6 ฟีเจอร์หนัก: workflow canvas, Node & เครื่องมือ, VRM 3D, Mimiamp ขั้นสูง
                                                       └▶ 7 ปิดงาน: เลิกเสิร์ฟ UI เว็บ (เก็บ asset ที่แอปยังใช้)
```

- Android เริ่มได้ก่อน Phase 1 เสร็จ (ทุกอย่างใน "เส้นทางลัด" ใช้ได้กับเซิร์ฟเวอร์ปัจจุบัน; push ใช้ poll ไปก่อน)
- Mac ก่อน iOS เพราะแอปเดิมบน Mac มีผู้ใช้อยู่แล้ว (Electron) และไม่ติดเรื่อง APNs ตอนเริ่ม; iOS ใช้ Swift package เดียวกัน
- รายละเอียดว่าฟีเจอร์ไหนอยู่เฟสไหน: [feature-inventory.md](feature-inventory.md) ข้อ 5

## คำถามที่ต้องให้เจ้าของโปรเจกต์ตัดสินใจ

| # | คำถาม | ทางเลือก (ข้อเสนอเป็นตัวหนา) | กระทบ |
|---|---|---|---|
| Q1 | ลำดับเฟสตามที่เสนอ (Android → Mac → iOS → Windows) ใช่ไหม | **ใช่** / สลับ iOS ก่อน Mac | แผนทั้งหมด |
| Q2 | โหมด core คนเดียว (token เดียวทุกเครื่อง) ยังรองรับในแอป native ไหม | **รองรับ แต่แนะนำ gateway** / ออก device token บน core (G-AUTH-1) / gateway เท่านั้น | ความปลอดภัยของ token บนมือถือ |
| Q3 | push ของ native: กุญแจ FCM/APNs อยู่ที่ไหน | **relay ที่ gateway** / env ของทุก core / relay กลางของผู้พัฒนา / UnifiedPush บน Android | G-PUSH-2, ต้องมีบัญชี Firebase + Apple Developer |
| Q4 | เนื้อหาข้อความใน push ผ่าน Google/Apple ได้ไหม | **ส่งแค่ id แล้วแอปดึงเนื้อหาเอง** / ส่งข้อความเต็ม / เข้ารหัสเอง | ความเป็นส่วนตัว vs ความง่าย |
| Q5 | คำสั่ง Mimiamp จาก agent ให้เล่นบนทุกอุปกรณ์ที่เปิดอยู่ (แบบเว็บ) หรืออุปกรณ์เดียว | ทุกเครื่อง / **อุปกรณ์ที่ foreground ล่าสุด** / ให้ผู้ใช้เลือก | ต้องเพิ่ม presence ของเครื่องเล่น |
| Q6 | VRM 3D บน native: ทำไหม และด้วยอะไร | **ทีหลัง (Phase 6) ระหว่างนี้ 2D** / Unity as a Library / glTF viewer + เขียน VRM เอง | ขนาดงาน L+ |
| Q7 | PC agent รวมเข้าแอป Mac/Windows native หรือคงเป็นโปรแกรม Node แยก | **แยกไว้ก่อน** / รวมใน Phase 3/5 | ขอบเขตแอปเดสก์ท็อป |
| Q8 | Windows ใช้ WinUI 3 (C#) หรือ Compose Multiplatform (แชร์กับ Android) | **WinUI 3** / Compose Multiplatform | ดู windows-stack.md |
| Q9 | ช่องทางแจกจ่าย: Play Store / App Store / TestFlight / Microsoft Store หรือไฟล์ติดตั้งเองแบบเดิม (APK/zip จาก GitHub release) | ต้องตัดสินใจต่อแพลตฟอร์ม | การอัปเดตแอป, G-VER-1, ต้องมีบัญชีนักพัฒนา |
| Q10 | ระหว่างที่แอป native ยังไม่ครบ หน้า Hub/workflow ให้ผู้ใช้ทำผ่านเว็บ (เปิดในเบราว์เซอร์ระบบ) ได้ไหม | **ได้ จนถึง Phase 7** / ต้องครบใน native ก่อนปล่อย | ขอบเขตเฟส A/B |
| Q11 | แอป native จะเลิกรองรับเซิร์ฟเวอร์เวอร์ชันเก่ากว่าเท่าไร | **ต้องมี `apiVersion` (G-VER-1) ก่อนปล่อย** / รองรับทุกเวอร์ชัน | การทดสอบ |
| Q12 | ชื่อ bundle id / package name / signing key ของแอปใหม่ ใช้ `app.mimi.android` เดิม (อัปเดตทับแอป WebView ได้) หรือแอปใหม่ | **ใช้เดิมบน Android** (ต้องใช้ keystore เดิม) / ใหม่ | การย้ายผู้ใช้เดิม |

## สิ่งที่ Phase 0 ยังไม่ได้ทำ / ยังไม่ได้ทดสอบ (ตามจริง)

- ทดสอบจริงด้วยเซิร์ฟเวอร์ในเครื่อง: `/health`, `/auth/login` (สำเร็จ, ผิด, 415), `/auth/session`, `/auth/logout` + socket ถูกปิด `4003`,
  WS hello (ถูก, ผิด, frame แรกไม่ใช่ hello), `ping`/`pong`, `provider-connect`, `agent-save`, `chat-create`, `/api/upload`, `chat-send` แบบ streaming
  พร้อมไฟล์แนบ, `chat-open`, `error` (คำสั่งไม่รู้จัก, แชตไม่มี), `/api/files/:id`, `/api/widget`, `/api/notifications`, `/api/mimiamp/state`,
  `/mimiamp/tracks.json` และ Range ผ่าน gateway, `/mimiamp/youtube/*.audio` 404 ผ่าน gateway
- **ไม่ได้ทดสอบจริง** (เขียนจากการอ่านโค้ดเท่านั้น): 2FA, `/auth/password`, rate limit (`4029`/`429`), การเรียกเครื่องมือ + permission card,
  task card, handoff ระหว่าง agent, approval ของ workflow, การดาวน์โหลด YouTube จริง (`prepare`), Web Push, OAuth ของ Google/Microsoft,
  อัปโหลดรูป/VRM/แกลเลอรี, backup/CSV, คำสั่ง Hub ทั้งหมด (ตาราง B.3–B.7 มาจากการไล่ `case` ในโค้ด), พฤติกรรมบน Railway
- ตัวอย่าง JSON ของ `settings`, `agents`, `tools`, `workflows` ไม่ได้ใส่ทั้งก้อน (ใหญ่มาก) — ใช้ชนิดใน `protocol.ts` เป็นหลัก
