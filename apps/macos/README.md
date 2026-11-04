# แอป Mimi สำหรับ Mac (native, Phase 3)

แอป Mac ของ Mimi เขียนใหม่เป็น **SwiftUI + Swift Concurrency — ไม่มี Electron ไม่มี WebView** คุยกับ core / gateway ผ่าน HTTP + WebSocket
ตามสเปกใน [`docs/native/`](../../docs/native/README.md) · **build ได้ด้วย Command Line Tools อย่างเดียว (ไม่ต้องมี Xcode)**: SwiftPM + `Support/build-app.sh`

## โครง

```
apps/macos/
  Package.swift
  Sources/MimiKit/      ใช้ร่วมกับ iOS (Phase 4): JSON ผ่อนปรน, โมเดล, frame parser, ClientFrames, Speech/MessageFormat,
                        MimiAPI (URLSession), MimiSocket (URLSessionWebSocketTask), MimiSession, ChatTimeline (reducer), Mentions,
                        ViewModels/ (ConnectModel, ChatListModel, ChatModel) — ไม่มีโค้ด UI
  Sources/MimiDesktop/  เฉพาะเครื่องคอมพิวเตอร์: PcAgentHost (PC agent ในตัว, Q7), LocalCore (native-host.ts), AppConfig (config.json),
                        SessionVault (login keychain), AgentBrowser, NodeLocator, ChildProcess
  Sources/Mimi/         ตัวแอป: MimiApp (หน้าต่าง + MenuBarExtra + Settings), AppModel, Notifier, Views/
  Tests/                Swift Testing: MimiKitTests, MimiDesktopTests (รวมเทสต์กับ core จริงแบบเลือกเปิด)
  Support/build-app.sh  ห่อเป็น build/Mimi.app (Info.plist, ไอคอนจาก packages/core/src/app/icon.ts, ลงนามแบบ ad hoc)
```

โค้ดแปลงมาจากแอป Windows (`apps/windows/src/Mimi.Core`) ทีละกติกา — reducer, การต่อ socket ใหม่, ขั้นล็อกอิน, PC agent host เหมือนกัน

## มีอะไรบ้าง (MVP, 2026-11-03)

| ส่วน | ทำอะไร |
|---|---|
| เชื่อมต่อ / ล็อกอิน | ใส่ที่อยู่ → `/health` แยก core คนเดียว (token) กับ gateway (username + password + รหัส 2FA) · เช็ก `minClientApi` · "เครื่องนี้ไม่ใช่ของฉัน" · "ใช้เซิร์ฟเวอร์ในเครื่องนี้" (เปิด core ให้เอง) |
| เก็บ token | login keychain (generic password `app.mimi.macos.session`, `WhenUnlockedThisDeviceOnly`) ลบเมื่อออกจากระบบ · ไม่ลง config |
| socket | `hello` ก่อน, ping 25 วินาที, เงียบเกิน 3 ping = ต่อใหม่, backoff 1→15 วินาที, 4003 = ออกจากระบบ, 4426 = แอปเก่าเกิน, 4029 = รอ 15 นาที · frame ที่ไม่รู้จัก (รวม `mimiamp` ของ core เก่า) ข้ามไป |
| รายการแชต | แท็บ ตัวต่อตัว / กลุ่ม, ยังไม่อ่าน, กำลังพิมพ์, รูป agent (โหลดพร้อม token), แชตใหม่กับ agent, แชตกลุ่มใหม่ |
| แชต | streaming, แถวเครื่องมือ (กดดูผล), sub-agent, handoff, การ์ดขออนุญาต (ครั้งนี้ / งานนี้ / session / ตลอด, `noGrant`), อนุมัติ workflow, การ์ดงาน, ข้อความแบบเว็บ (code block, `code`, **หนา**, *การกระทำ*, ลิงก์, @mention), รูป + ไฟล์ (เปิดด้วยแอปของ Mac), แนบไฟล์ (ปุ่ม / ลากวาง / ⌘V รูป), โหลดข้อความเก่า, กลับ session ล่าสุด, แถบหมุด, เมนูข้อความ (รีแอ็กชัน, ตอบกลับ, ปักหมุด, คัดลอก), `@ชื่อ` ในแชตกลุ่ม, Enter ส่ง / Shift+Enter / Esc หยุด, ตามของที่พลาดหลังต่อใหม่ (`chat-open afterId`) |
| แจ้งเตือน | UserNotifications จาก frame `notification` + ตามของที่พลาดด้วย `/api/notifications?afterId=` · คลิก = เปิดแชตนั้น · เฉพาะใน Mimi.app (ไม่ใช่ `swift run`) |
| menu bar | แทนถาดของ Electron: เปิด Mimi, เบราว์เซอร์ของ Mimi, PC agent + สถานะ, shell, ออกจากระบบอัตโนมัติ, ตั้งค่า, เปลี่ยนเซิร์ฟเวอร์, ออกจากระบบ, ออก · ปิดหน้าต่าง = อยู่ใน menu bar |
| PC agent ในตัว (Q7) | `packages/pc-agent` ด้วย node: token ทาง stdin, env เฉพาะที่ต้องใช้, คำขอ consent เป็นหน้าต่างถาม, เริ่มใหม่เอง (backoff 2 s → 60 s), โฟลเดอร์ต้องอยู่ในโฮม (ไม่ใช่โฮมเอง / Library / .ssh) |
| เซิร์ฟเวอร์ในเครื่องนี้ | `packages/core/src/app/native-host.ts` ตัวเดียวกับแอป Windows: อ่าน `@@mimi-host@@{port,token}` แล้วล็อกอินเอง เปิดพร้อมแอปถ้าเลือกไว้ ปิดเมื่อออกจากแอป |
| ออกจากระบบอัตโนมัติ | ไม่ได้ใช้ครบเวลา (5/15/30/60 นาที) หรือล็อกหน้าจอ |
| ตั้งค่า (⌘,) | บัญชี, PC agent + โฟลเดอร์ + shell, เบราว์เซอร์ของ Mimi, ออกจากระบบอัตโนมัติ |

config อยู่ที่ `~/Library/Application Support/Mimi/config.json` — **ไฟล์เดียวกับแอป Electron** (field ที่ไม่รู้จักถูกเก็บไว้เหมือนเดิม, ค่าของแอปนี้อยู่ใต้ `"macos"`)

## ยังไม่มี (ต้องทำให้ครบเท่าแอป Windows ก่อนปล่อย — Q10)

หน้าจัดการทั้งหมด (Agent, Hub 10 แท็บ, Workflow + editor, AI Overseer, ตั้งค่า Mimi), ตัวช่วยตั้งค่าทีละขั้น, ค้นหา (⌘K), กล่องแจ้งเตือน (กระดิ่ง),
session (แถบ + มาตรวัด context), อ่านออกเสียง, อัดข้อความเสียง, ส่งต่อ / rewind, เวทีตัวละคร 2D + ฉากหลัง + หน้าตาต่อแชต + ภาพสถานการณ์, ธีมสว่าง/มืดของแอปเอง,
Workspace (ไฟล์ / เบราว์เซอร์ / เทอร์มินัล), ตัวอัปเดตแอป, เปิดตอนเข้าสู่ระบบ (`SMAppService`), APNs (ต้องมี Apple Developer + กุญแจที่ gateway),
VRM 3D (Q6: ทำท้ายสุด) · `--bundle-core` ของ build-app.sh ยังไม่ได้ลองเปิดจริง (ใส่ node + core + node_modules ในแอป)

## build / test

```bash
cd apps/macos && swift build          # debug
swift test                            # 28 เทสต์ (2 ตัวกับ core จริงจะข้ามถ้าไม่ตั้ง env ด้านล่าง)
sh Support/build-app.sh               # Release → build/Mimi.app (ช้า ~10 นาทีบน Mac Intel เครื่องนี้)
```

**เทสต์กับ core จริง**: เปิด LLM จำลอง `node apps/windows/tests/tools/mock-llm.cjs` และ core ในโฟลเดอร์ทดสอบ (มี agent หนึ่งตัว; frontmatter ใช้
`display_name` — คีย์ที่ไม่รู้จัก**ทำ core ล่ม**ตอนมีคนต่อ WS ดูหมายเหตุใน HANDOFF) แล้ว
`MIMI_MAC_TEST_CORE=http://127.0.0.1:8790 MIMI_MAC_TEST_TOKEN=<token> swift test`

**เปิดแอปทดสอบ** โดยไม่แตะข้อมูลจริงของแอป Electron / keychain: `open -n --env MIMI_MACOS_HOME=<โฟลเดอร์ว่าง> build/Mimi.app`

## สถานะ

- ✅ build ผ่าน (debug ไม่มี warning; Release x86_64 + Mimi.app ad hoc), เทสต์ 28/28 รวม **ล็อกอิน → socket → สร้างแชต → ส่ง → คำตอบ stream แล้วถูกเก็บ** กับ core จริง +
  LLM จำลอง และ **PC agent จริงต่อ core ได้ด้วย token ทาง stdin**
- ⚠️ ยังไม่ได้กด UI ด้วยตา/ด้วยเครื่องมือ (ขอสิทธิ์คุมแอปแล้วไม่ได้รับ) — หน้าตาของ SwiftUI ยังไม่ได้ตรวจ · ยังไม่ได้ลองบน Apple Silicon (build เป็น x86_64)
- ลงนามแบบ ad hoc: เครื่องอื่นจะโดน Gatekeeper เตือน (ต้องคลิกขวา → Open) · ทุกครั้งที่ build ใหม่ keychain อาจถามสิทธิ์อ่าน token อีกครั้ง
