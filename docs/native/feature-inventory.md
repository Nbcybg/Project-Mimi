# Feature inventory ของ UI เดิม

> รวบรวมจาก `packages/core/src/server/web/app.js` และ `feature-*.js` 25 ไฟล์ (คำสั่ง WS ที่แต่ละไฟล์ส่ง และ HTTP ที่เรียก ดึงจากโค้ดจริง)
> **ความยาก**: S = ไม่กี่วัน, M = 1–2 สัปดาห์, L = มากกว่านั้น / ต้องวิจัย (ต่อหนึ่งแพลตฟอร์ม)
> **เฟส**: A = ต้องมีก่อนปล่อย (ใช้แทนแอปเดิมได้), B = จัดการระบบบนมือถือ, C = ฟีเจอร์หนัก (หลังทุกแพลตฟอร์มมี A+B)
> หน้าจอหลักของเว็บ: แชต, Agent (แก้ไข agent), Hub (10 แท็บ: `app.js:3854-3865`), ~~Mimiamp~~ (ลบแล้ว), Overseer, ตั้งค่า, workflow

## 1. แชตและการใช้งานประจำวัน

| # | ฟีเจอร์ | หน้าจอ | API (WS / HTTP) | ยาก | พึ่ง API แพลตฟอร์ม | เฟส |
|---|---|---|---|---|---|---|
| 1 | เชื่อมต่อเซิร์ฟเวอร์ + ล็อกอิน (token / username+password+2FA) | gate | `GET /health`, `POST /auth/login`, `GET /auth/session`, WS `hello` | S | Keychain/Keystore | A |
| 2 | ออกจากระบบ | ตั้งค่า | `POST /auth/logout`, `push-unsubscribe` | S | – | A |
| 3 | รายการแชต (แท็บ ตัวต่อตัว/กลุ่ม, ใหม่, preview, กำลังพิมพ์) | list | `chats-list`, `chats`, `busy` | S | – | A |
| 4 | แชต streaming (bubble, เครื่องมือ, handoff, sub-agent, หยุด) | chat | `chat-open`, `chat-send`, `chat-event`, `busy`, `abort` | M | – | A |
| 5 | แสดงข้อความ (code block, `code`, **bold**, *action*, ลิงก์, @mention, ป้ายเสียง) | chat | – (`app.js:436-524`) | S | เปิดลิงก์ด้วยเบราว์เซอร์ระบบ | A |
| 6 | แนบไฟล์ / รูป / ถ่ายรูป | composer | `POST /api/upload`, `chat-send.attachments` | M | photo picker, กล้อง, file picker | A |
| 7 | ดูไฟล์แนบ (รูป, เสียง, วิดีโอ, PDF, ดาวน์โหลด) | chat, lightbox | `GET /api/files/:id` | M | image viewer, media player, PDF viewer, บันทึกไฟล์ | A |
| 8 | ข้อความเสียง (กดค้าง/แตะ, waveform, ยกเลิก) | composer | `/api/upload` (WAV), `chat-transcribing` (`feature-voice.js`) | M | ไมค์ (`RECORD_AUDIO` / `NSMicrophoneUsageDescription`), haptics | A |
| 9 | การ์ดขออนุญาต (ครั้งนี้ / งานนี้ / session / ตลอด / ไม่อนุญาต) | chat | `permission-request`, `permission-response`, `permission-resolved` | M | – | A |
| 10 | การ์ดงาน (task: step, plan, receipt, หยุด/ต่อ/ยกเลิก/ย้อน) | chat | `task-*` events, `task-control`, `task-undo`, `task-kill` | M | – | A |
| 11 | อนุมัติคำขอของ workflow ใต้ข้อความ | chat | `ChatMessageView.approval`, `approval-decide` | S | – | A |
| 12 | ตอบกลับ / ส่งต่อ / คัดลอก / react / ปักหมุด + แถบหมุด | chat (`feature-chat.js`) | `chat-send.replyTo/forward`, `message-react`, `message-pin`, `message-marks` | S | clipboard, emoji | A |
| 13 | ย้อนบทสนทนา (rewind) | chat | `rewind` → `rewound` | S | – | A |
| 14 | session: ดูรายการ, เริ่มใหม่, มาตรวัด context/cost | chat header, rail | `session-new`, `session-context`, `chat-session` | S | – | A |
| 15 | ค้นหาข้อความทุกแชต | search | `search` → `search-results` | S | – | A |
| 16 | สร้าง/แก้แชตกลุ่ม (สมาชิก, ลำดับ, ชื่อ) + rail สมาชิก/สถานะ | chat, rail | `chat-create`, `chat-update`, `chat-delete`, `status` | S | – | A |
| 17 | inbox แจ้งเตือน (🔔) + toast | header | `notifications-list`, `notifications-read`, `notification` | S | – | A |
| 18 | push notification | ระบบ | ดู `push-and-background.md` (ยังไม่มี API native) | M–L | FCM / APNs / WNS, notification permission | A |
| 19 | widget แชตล่าสุด (Android มีแล้ว) | home screen | `GET /api/widget` | S | Glance / WidgetKit / Windows Widgets | A (Android), B (อื่น) |
| 20 | อ่านออกเสียง (auto + ปุ่ม 🔊) | chat | `run-finish.speech`, `ui` `mimi.autoSpeak` | S | TTS ของระบบ | A |
| 21 | เสียงแจ้ง (ส่ง / ตอบเสร็จ / ขออนุญาต) | – | `ui` `mimi.chatSound` | S | SoundPool / AVAudioPlayer | A |
| 22 | ~~เครื่องเล่น Mimiamp พื้นฐาน (คลัง, playlist, เล่น/หยุด/ข้าม/เลื่อน, เพิ่ม YouTube, ค้นหา, คำสั่งจาก agent)~~ **ลบแล้ว (Q5, api 2)** | Mimiamp | `/api/mimiamp/*`, `/mimiamp/*`, WS `mimiamp` (ดู `media.md`) | M | media session, background audio | A |
| 23 | ~~Mimiamp ขั้นสูง (EQ 10 แบนด์, pan, visualizer, ไฟล์ในเครื่อง, export/import playlist, หน้าต่างลอย)~~ **ลบแล้ว (Q5, api 2)** | Mimiamp | `/api/mimiamp/playlists/:id/export`, `/api/mimiamp/import` | L | audio DSP, file picker + persistent permission, PiP/overlay | C |
| 24 | ตัวละครบนเวที 2D (sprite ตาม emoji, portrait, ฉากหลัง, ชุด) | chat stage (`feature-stage.js`) | `agents`, `wardrobe-list`, `backgrounds-list`, `/api/sprite/*`, `/api/agent-image/*`, `/api/background-image/*`, `/backgrounds/*.webp` | M | – | B |
| 25 | รูปจากแกลเลอรีทับแชต | chat (`feature-gallery.js`) | `gallery-list`, `/api/gallery/*` | S | – | B |
| 26 | ตั้งค่าหน้าตาต่อแชต (ขนาดตัวอักษร, bubble, ฉาก, ตัวละคร, ธีม) | chat settings | `ui-set` key `mimi.chat.<id>.*`, `POST /api/chat-background` | S | – | B |
| 27 | เปิดแชตจาก notification / widget (`?chat=<id>`) | – | `chat-open` | S | deep link / intent | A |
| 28 | แจ้งเตือนว่ามีการล็อกอินใหม่ | toast | `security-alert` | S | – | A |
| 29 | เช็กเวอร์ชันแอปใหม่ (Android เดิมถาม GitHub releases) | toast (`feature-update.js`) | GitHub API (ไม่ผ่านเซิร์ฟเวอร์) | S | Play Store / TestFlight / App Store / winget แทน | B |

## 2. ตั้งค่าและบัญชี

| # | ฟีเจอร์ | หน้าจอ | API | ยาก | พึ่ง | เฟส |
|---|---|---|---|---|---|---|
| 30 | ตัวช่วยตั้งค่าครั้งแรก (provider → agent → โฟลเดอร์ → PC agent → แชตทดสอบ) | setup (`feature-setup.js`) | `agent-presets`, `provider-connect`, `settings-save`, `agent-save`, `chat-create` | M | – | B |
| 31 | AI Overseer (เลือกโมเดล + แชตกับผู้ช่วยตั้งค่า) | overseer (`feature-overseer.js`) | `overseer-get`, `overseer-save`, แชตปกติ | S | – | A (เพราะผู้ใช้ใหม่ถูกพามาที่นี่: `app.js:5136-5144`) |
| 32 | ผู้ให้บริการโมเดล (เพิ่ม/แก้/ลบ, ChatGPT plan) | settings (`feature-providers.js`) | `provider-connect`, `provider-update`, `provider-remove`, `chatgpt-plan-connect` | M | เบราว์เซอร์ระบบ (OAuth) | B |
| 33 | ตั้งค่าทั่วไป (โมเดลเริ่มต้น, timezone, session rollover, โควตา, งบรายวัน, ช่วงเงียบ, push kinds, ปิดเสียง agent) | settings | `settings-get`, `settings-save`, `preferences-save` | M | – | B |
| 34 | โปรไฟล์ของฉัน (ข้อมูล key/value + ใครเห็น) | settings (`feature-profile.js`) | `profile-get`, `profile-save` | S | – | B |
| 35 | Backup (สร้าง, ดาวน์โหลด) | settings | `backups-list`, `backup-create`, `GET /api/backups/:name` | S | บันทึกไฟล์ | B |
| 36 | export แชตเป็น CSV | settings | `GET /api/export/*.csv` | S | บันทึกไฟล์ / share sheet | B |
| 37 | 2FA + เปลี่ยนรหัสผ่าน (gateway) | settings (`app.js:4307-4420`) | `/auth/2fa/*`, `/auth/password` | S | แสดง QR (`otpauth://`) | B |
| 38 | อุปกรณ์ที่รับ push + ทดสอบ | settings (`feature-notify.js`) | `push-devices`, `push-test` (+ API native ใหม่) | S | – | B |
| 39 | สิทธิ์ "อนุญาตตลอด" (ดู/ถอน) | settings | `settings.permissionAgentGrants`, `permission-revoke` | S | – | B |
| 40 | ความจำ (memory) ดู/แก้/ลบ | settings | `memory-list`, `memory-save`, `memory-delete` | S | – | B |
| 41 | Tunnel (Cloudflare) | settings | `tunnel-start`, `tunnel-stop` | S | – (เฉพาะ core บนคอมพิวเตอร์; แอปมือถือไม่ต้องมี) | – |

## 3. Hub (จัดการระบบ)

| # | ฟีเจอร์ | แท็บ | API | ยาก | พึ่ง | เฟส |
|---|---|---|---|---|---|---|
| 42 | แก้ไข agent (ข้อมูล, prompt, โมเดลต่อความสามารถ, เครื่องมือ, สิทธิ์, งบ, skill, รูป avatar/portrait/sprite) | Agent | `agents-list`, `agent-save`, `agent-delete`, `/api/agent-image/*`, `/api/sprite/agent/*` | L | photo picker, crop | B |
| 43 | VRM 3D (อัปโหลด, ท่า Mixamo, expression, lipsync, idle motion) | Agent (`feature-vrm.js`) | `/api/agent-model/*`, `/api/agent-motion(s)/*` | L | 3D engine (ดู `media.md` ข้อ 5) | C |
| 44 | แกลเลอรีของ agent (ค้นหา, หน้า, อัปโหลดหลายรูป, แก้, ลบ) | Agent (`feature-gallery.js`) | `gallery-*`, `/api/gallery/*` | M | photo picker หลายรูป, ทำ thumbnail | B |
| 45 | กองโมเดล (preset: temperature, top_p, …) | Hub → models | `preset-save`, `preset-delete`, `settings.presets` | S | – | B |
| 46 | Skill (แก้, import/export .md) | Hub → skills | `skills-list`, `skill-save`, `skill-delete` | M | file picker | B |
| 47 | Node & เครื่องมือ (เครื่องมือ custom, preset, MCP, connector, import OpenAPI) | Hub → nodes (`feature-tools.js`, `feature-agent-tools.js`) | `tools-list`, `tool-*`, `mcp-*`, `connector-import-*` | L | file picker | C |
| 48 | Trigger (เตือน, agent task, cron, webhook, mail, calendar) | Hub → triggers (`feature-triggers.js`) | `triggers-list`, `trigger-*`, `trigger-pool-*`, `calendar-*`, `mail-watch` | M | date/time picker, copy webhook URL | B |
| 49 | บัญชี (Google/Microsoft OAuth, connector connection, กล่องเมล IMAP/POP3/SMTP) | Hub → accounts (`feature-accounts.js`, `feature-mail.js`) | `oauth-*`, `connector-connection-*`, `mail-watch*`, `mail-account-test` | M | เบราว์เซอร์ระบบ | B |
| 50 | คีย์ลับ (vault: ชื่อเท่านั้น, นำเข้า .env) | Hub → secrets (`feature-secrets.js`) | `secrets-list`, `secrets-save` | S | file picker | B |
| 51 | คลังความรู้ (collection, เพิ่มข้อความ/URL/ไฟล์, ค้นหา, embed) | Hub → knowledge (`feature-knowledge.js`) | `knowledge-*`, `/api/upload` | M | file picker | B |
| 52 | ตู้เสื้อผ้า (ชุด, รูป, sprite, VRM ของชุด) | Hub → wardrobe (`feature-wardrobe.js`) | `wardrobe-*`, `/api/wardrobe-image/*`, `/api/wardrobe-model/*`, `/api/sprite/outfit/*` | M | photo picker | B (VRM: C) |
| 53 | ฉากหลัง (ฉากสำเร็จรูป, อัปโหลด, keyword สำหรับ auto, เลือกต่อ agent) | Hub → backgrounds (`feature-backgrounds.js`) | `backgrounds-*`, `background-select`, `/api/background-image/*` | M | photo picker | B |
| 54 | แพ็กสำเร็จรูป (preview, ติดตั้ง, ลบ, checklist ค่าที่ขาด) | Hub → packs (`feature-packs.js`) | `packs-list`, `pack-*` | M | file picker (แพ็กจากไฟล์) | B |
| 55 | Workflow: รายการ, เปิด/ปิด, รันเอง, ประวัติการรัน | workflows (`feature-workflows.js`) | `workflows-list`, `workflow-save`, `workflow-run`, `workflow-runs`, `workflow-run-get` | M | – | B |
| 56 | Workflow canvas (ลาก node, เส้นเชื่อม, ตั้งค่า node, ทดสอบ node, expression preview, import n8n/Make/Zapier) | workflows (`feature-canvas.js`, `feature-workflows.js` 2,697 บรรทัด) | `workflow-test-node`, `workflow-expr-preview`, `workflow-run-from`, `workflow-import-*` | L | canvas/gesture (pan, zoom, drag) | C |

## 4. สิ่งที่มีเฉพาะเว็บ/เดสก์ท็อปและไม่ต้องย้าย

- ลิงก์ `#token=` และ `window.MimiDesktop` / `window.MimiAndroid` bridge (`app.js:13-24, 145-152`) — แทนด้วยโค้ด native
- `POST /app/<action>` ของ Electron launcher (`server.ts:2279-2286`)
- service worker / PWA / `offline.html` / `manifest.webmanifest`
- PC agent (`packages/pc-agent`) เป็นโปรแกรมแยกที่ต่อ `/ws` ด้วย `role: 'pc'` — แอป Mac/Windows native อาจรวม PC agent เข้าไปภายหลัง
  แต่ **ไม่อยู่ในขอบเขตของแอป UI** (คำถาม Q7)

## 5. ลำดับเฟสที่เสนอ

```
Phase 0  สเปก (เอกสารนี้)
Phase 1  เซิร์ฟเวอร์: server-gaps.md ระดับ P1 (version, Range, Mimiamp ผ่าน gateway, chat-message ของ assistant, reqId, push token)
Phase 2  Android  : เฟส A ครบ (#1–22, 27–29, 31) + push แบบ poll ก่อน แล้วเปลี่ยนเป็น FCM เมื่อ Phase 1 มี
                  → จากนั้นเฟส B
Phase 3  Mac      : เฟส A + B (SwiftUI; แชร์ model/network layer กับ iOS ผ่าน Swift package)
Phase 4  iOS      : เฟส A + B (ต้องมี APNs ก่อนปล่อย)
Phase 5  Windows  : เฟส A + B (stack ตาม windows-stack.md)
Phase 6  ฟีเจอร์หนัก (เฟส C): workflow canvas (#56), Node & เครื่องมือ (#47), VRM (#43)
Phase 7  ปิดงาน: เลิกเสิร์ฟ UI เว็บ (เก็บ /health, /backgrounds/*, /api/*, /ws ไว้) — ดู server-gaps.md G-SRV-1
```

**สถานะ Windows (Phase 5, 2026-11-03):** ทำเฉพาะขอบเขต MVP ของ prompt Phase 5 ไม่ใช่เฟส A + B ทั้งหมด —
ล็อกอิน, รายการแชต, แชต streaming (เครื่องมือ, ขออนุญาต, อนุมัติ, รูป/ไฟล์, แนบไฟล์, ข้อความเสียง), Mimiamp (คลัง, เพลย์ลิสต์, YouTube,
shuffle/repeat, EQ 10 แบนด์, SMTC, คำสั่งจาก agent), ถาดระบบ, toast ขณะเปิดอยู่, เปิดตอนเข้าสู่ระบบ, ล็อกอัตโนมัติ, PC agent, ตัวอัปเดต
ที่เหลือของเฟส A/B (Hub, ตั้งค่า, ค้นหา, pin/react/reply/rewind, TTS, ตัวละคร ฯลฯ) ยังไม่มี — รายละเอียด `apps/windows/README.md`

**สถานะ Windows หลัง Phase 6 (2026-11-03, อัปเดตรอบที่ 4) — ทำแล้ว/เหลือ ต่อฟีเจอร์:**
("ทั่วไป" = ทำผ่านหน้าจัดการแบบ generic ของแอป Windows: ใช้งานได้ครบตาม API — รอบที่ 4 เพิ่มฟอร์มย่อยแทน JSON (เช่น เซิร์ฟเวอร์ของกล่องเมล),
ฟอร์มจาก field spec ของเซิร์ฟเวอร์ (node/trigger ของ workflow) และผลลัพธ์แบบอ่านได้แทน JSON — ดู `apps/windows/README.md`)

| # | ฟีเจอร์ | Windows |
|---|---|---|
| 1–9, 11, 21, 22, 27–29 | เฟส A เดิม (MVP Phase 5) | ทำแล้ว |
| 10 | การ์ดงาน (task) | ทำแล้ว |
| 12 | ตอบกลับ / ส่งต่อ / คัดลอก / react / ปักหมุด + แถบหมุด + อีโมจิ | ทำแล้ว |
| 13 | ย้อนบทสนทนา (rewind) | ทำแล้ว |
| 14 | session: รายการ, เริ่มใหม่, มาตรวัด context/cost | ทำแล้ว |
| 15 | ค้นหาข้อความทุกแชต | ทำแล้ว |
| 16 | สร้าง/แก้แชตกลุ่ม + rail สมาชิก | ทำแล้ว (แผง "ข้อมูล" ของแชต: สมาชิก + สถานะของ agent แก้ได้) |
| 17 | inbox แจ้งเตือน + toast | ทำแล้ว |
| 18 | push ตอนแอปปิด (WNS) | เหลือ (รอ Q3) |
| 19 | widget | เหลือ (Windows Widgets ต้องมี package identity) |
| 20 | อ่านออกเสียง | ทำแล้ว (เสียงของ Windows) |
| 23 | ~~Mimiamp ขั้นสูง~~ **ลบแล้ว (Q5, api 2)** | เอาออกจากแอป Windows แล้ว (2026-11-03 รอบ 6) |
| 24 | เวทีตัวละคร 2D (รูปตามอีโมจิ + ฉากหลัง) | ทำแล้ว |
| 25 | รูปแกลเลอรี/ภาพสถานการณ์ทับแชต | ทำแล้ว (รอบ 5: เปิด / ย่อ / ปิด จำต่อ agent) |
| 26 | หน้าตาต่อแชต (ธีม, ขนาดตัวอักษร, ตัวละคร, ข้อความบนตัวละคร, ตำแหน่ง, ฉากหลัง) | ทำแล้ว (เก็บในเครื่อง เหมือน localStorage ของเว็บ) |
| – | ธีมสว่าง/มืด | ทำแล้ว (`mimi.theme` ใช้ร่วมทุกเครื่อง, ต่อแชตแยกได้) |
| 30 | ตัวช่วยตั้งค่าครั้งแรก | ทำแล้ว (5 ขั้นแบบเว็บ, เปิดเองเมื่อยังแชตไม่ได้) |
| 31 | AI Overseer | ทำแล้ว (เลือกโมเดล + คุย) |
| 32–41 | ผู้ให้บริการ, ตั้งค่าทั่วไป, โปรไฟล์, backup, export CSV, 2FA/รหัสผ่าน, อุปกรณ์ push, สิทธิ์ตลอด, ความจำ, tunnel | ทำแล้ว (ทั่วไป) |
| 42 | แก้ไข agent (+ รูป, VRM file, ท่า) | ทำแล้ว (ทั่วไป) |
| 43 | VRM 3D แสดงผล | ทำแล้ว (WebView2 + three-vrm: หายใจ, กะพริบตา, อารมณ์ตามอีโมจิ, ขยับปากตอนตอบ) · รอบ 5: ท่า Mixamo (retarget), ท่ายืนเฉยบนหน้าแชต, หน้าตัวละคร 3D ใน Agent · ยังไม่ได้ลองกับไฟล์ .vrm/.fbx จริง |
| 44 | แกลเลอรีของ agent | ทำแล้ว (รอบ 5: ค้นหา, หน้า, รูปย่อ, เพิ่มหลายรูป, แก้, แสดงในแชต, ลบ) |
| 45–54 | Hub ทั้ง 10 แท็บ | ทำแล้ว (ทั่วไป) |
| 55 | Workflow: รายการ, เปิด/ปิด, รันเอง, ประวัติ, นำเข้า | ทำแล้ว (ทั่วไป) |
| 56 | Workflow canvas | ทำแล้ว: ลาก node, ลากเส้นเชื่อมจากจุดทางออก, ลบเส้น/node, ทำสำเนา, ปิด node, ฟอร์มของ node จาก spec, เงื่อนไขเป็นแถว, ทดสอบ node ทีละตัว, รัน, รันใหม่จาก node, ประวัติ · รอบ 5: preview expression, คำแนะนำ path + เลือกข้อมูล, โน้ตบนผัง, node connector + ตัวเลือกจากบริการ, ย้อน/ทำซ้ำ, คัดลอก/วาง, จัดเรียงอัตโนมัติ, node preset |
| – | Workspace (เบราว์เซอร์/เทอร์มินัล/ไฟล์) | ทำแล้ว (หน้าต่างแยก: ไฟล์ + แก้ข้อความ, เบราว์เซอร์ WebView2 + วาดบนภาพหน้าเว็บ, เทอร์มินัล ConPTY + xterm.js) · รอบ 5: ส่งภาพที่วาดเข้าแชต |
| – | ฟอร์มย่อยแทน JSON | ทำแล้ว (รอบ 5: preset เครื่องมือ, connection, โปรไฟล์, vars ของ workflow) |
| – | เซิร์ฟเวอร์ในเครื่องนี้ (core บนเครื่อง, แบบ `npm run app`) | ทำแล้ว (รอบ 5: แอปเปิด/ปิด core เอง, `native-host.ts`) |

เหตุผลเรื่องลำดับใน A: ผู้ใช้เดิมใช้แอปเกือบทั้งหมดผ่านแชต (เปิดแอปแล้วเข้าแชตล่าสุดทันที: `app.js:5145-5160`) ส่วน Hub ใช้ตอนตั้งค่า
ซึ่งระหว่างนี้ยังทำผ่านเว็บได้ (เซิร์ฟเวอร์ยังเสิร์ฟ UI จนถึง Phase 7)

**แอป Windows รอบ 6 (2026-11-03):** เพิ่มอัปโหลดฉากหลังของแชต + ตั้งเวลาสลับฉากหลัง, "เปิดเบราว์เซอร์ของ Mimi", `@ชื่อ` ในแชตกลุ่ม, Esc หยุดคำตอบ,
วางรูปจาก clipboard, ตรวจรูป + คำบรรยายก่อนส่ง · เอา Mimiamp ออก (#22, #23) — ยังขาดเหมือนเดิม: WNS (#push), widget (#19)
