# API contract (HTTP + คำสั่ง WebSocket)

> ใช้คู่กับ `realtime.md` (handshake, streaming, reconnect) และ `auth-and-session.md` (ล็อกอิน)
> client API **1** (ดู `api-versioning.md`) — ส่วนที่เพิ่มใน Phase 1 ระบุว่า **[api 1]**; บรรทัดอ้างอิงเป็นของโค้ดก่อน Phase 1 อาจเลื่อนไปเล็กน้อย
> ทุกข้อมาจากโค้ด `0.8.1-prototype` อ้างอิง `ไฟล์:บรรทัด` ตัวอย่างที่เขียนว่า "จริง" บันทึกจากเซิร์ฟเวอร์ทดสอบในเครื่อง (2026-11-02)
> ชนิดข้อมูล (TypeScript) เป็นแหล่งความจริง: `packages/shared/src/protocol.ts`, `events.ts`, `permissions.ts`, `knowledge.ts`,
> `workflows.ts`, `tools.ts`, `oauth.ts`, `connectors.ts`, `tasks.ts`, `calendar.ts`, `speech.ts`

## 0. กติกาทั่วไป

- **เวอร์ชัน [api 1]:** ทุกคำตอบ HTTP มี header `x-mimi-api: <API_VERSION>`; เช็กความเข้ากันได้ตาม `api-versioning.md` ก่อนใช้งาน
- **Base URL** คือ origin ของเซิร์ฟเวอร์ที่ผู้ใช้กรอก (core หรือ gateway) ทุก path ด้านล่างต่อจาก origin นั้น
  path ที่เซิร์ฟเวอร์ส่งกลับมาใน JSON (เช่น `"/api/files/12"`, `"/api/agent-image/mimi/avatar?v=…"`) เป็น
  **path สัมพัทธ์** ต้องต่อกับ base URL เอง
- **Auth:** `Authorization: Bearer <token>` ทุก `/api/*` ยกเว้น webhook (ดู A.9) — ไม่มี cookie ไม่มี CORS
  (`packages/core/src/server/http-api.ts:279-283, 332`)
- **Error ของ `/api/*`** เป็น JSON เสมอ: `{"error":"<ข้อความภาษาอังกฤษ>"}` status ตาม `HttpError`; error ที่ไม่ได้ระบุ status เป็น `400`
  (`http-api.ts:609-613`) ข้อความไม่มี error code (ต่างจาก WS) — แสดงตามที่ได้หรือแปลตาม status
- JSON body ของ `/api/*` สูงสุด 2 MB (`http-api.ts:125-136`) ต้องเป็น object (`400 "The request body must be a JSON object."`)
- **Rate limit:** มีเฉพาะการยืนยันตัวตนผิด (ดู `auth-and-session.md` ข้อ 4) ไม่มีโควตาจำนวน request
- **Cache:** JSON ทุกตัว `cache-control: no-store`; ไฟล์/รูป `private, max-age=3600` — ใช้ `?v=<version>` เป็น cache key ของรูป
- **รูปแบบเวลา:** ISO-8601 UTC (`2026-11-02T11:00:31.798Z`) ทั้งหมด

---

## ส่วน A — HTTP

### A.1 สาธารณะ (ไม่ต้องใช้ token)

| Method | Path | ตอบ | อ้างอิง |
|---|---|---|---|
| GET | `/health` | core: `{"ok":true,"version":"0.8.1-prototype","api":1,"minClientApi":1}` · gateway: `{…,"accounts":true}` **[api 1: `api`, `minClientApi`]** | `server.ts:2291-2294`, `gateway.ts:209-212` |
| GET | `/backgrounds/<name>.webp` | ภาพฉากหลังสำเร็จรูป (`public, max-age=31536000, immutable`) | `web-files.ts:246-267` |
| GET | `/icon.png`, `/icon-192.png`, `/icon-512.png`, `/icon-maskable-512.png`, `/apple-touch-icon.png` | ไอคอนแอป | `web-files.ts:122-129` |

เพลง (`/mimiamp/*`) เคยอยู่ในตารางนี้ — **ลบแล้วใน api 2** (Mimiamp ถูกเอาออกทั้งหมด — คำตอบ Q5 ใน `README.md`): `/mimiamp/*`, `/api/mimiamp/*`, เสียง YouTube และ frame `mimiamp` ไม่มีแล้ว ตอบ `404` / ไม่ส่ง

**`MIMI_SERVE_WEB=0` [api 1]:** หน้าเว็บ/สคริปต์ (`/`, `/app.js`, `/vendor/*`, `/sounds/*`, `/sw.js` …) ตอบ `404` ข้อความ `…(MIMI_SERVE_WEB=0)…`
ส่วนทุกอย่างในตารางนี้ยังเสิร์ฟตามปกติ — แอป native ต้อง bundle เสียง `chat_1..3.mp3` เอง

### A.2 บัญชี (gateway เท่านั้น)

`POST /auth/login`, `GET /auth/session`, `POST /auth/logout`, `POST /auth/password`, `POST /auth/2fa/{setup,enable,disable,recovery}`
— รายละเอียดเต็มใน `auth-and-session.md` ข้อ 3 บน core คนเดียว path เหล่านี้ตอบ `404`

### A.3 อัปโหลดไฟล์ไปแนบในแชต

```http
POST /api/upload?name=<ชื่อไฟล์ url-encoded>
Authorization: Bearer <token>
Content-Type: <mime ของไฟล์ เช่น image/jpeg, audio/wav, application/pdf>
X-Mimi-Caption: <คำอธิบาย url-encoded>        (ไม่บังคับ)

<bytes ของไฟล์ล้วน ๆ — ไม่ใช่ multipart>
```

- ขนาดสูงสุด **25 MB** (`packages/core/src/chat/attachments.ts:61`) เกิน = `413 {"error":"The file is larger than 25 MB."}` (`http-api.ts:79-95`)
- โควตาสื่อในแชตเต็ม = `507` (`http-api.ts:381-384`) ค่าเริ่มต้น 2,048 MB (`packages/core/src/app/app-settings.ts:119`)
- `kind` ตัดสินจาก mime: `image/*`→`image`, `audio/*`→`audio`, `video/*`→`video`, อื่น ๆ →`file` (`attachments.ts:70-72`)
- ตอบ `AttachmentView` (`protocol.ts:72-84`) — จริง:

```json
{"id":"9f7f9c4d-b7c4-4abe-b079-67ea082368c2","kind":"file","name":"note.txt","mime":"text/plain","size":10,"text":"","caption":"โน้ต","deletedAt":null}
```

- `text` ตอนอัปโหลดยังว่าง: เซิร์ฟเวอร์ถอดความ/อ่านไฟล์ตอน `chat-send` แล้วส่ง `text` ที่เติมแล้วมาใน `chat-message`
- จากนั้นส่ง `{"type":"chat-send","chatId":…,"attachments":["<id>"]}` ทาง WS (สูงสุด 20 ไฟล์ต่อข้อความ)
- เสียงพูด: โมเดลถอดเสียงรับ **WAV / MP3** — เว็บแปลงเสียงที่อัดเป็น WAV 16-bit mono ก่อนส่ง (`packages/core/src/server/web/feature-voice.js:64, 233`)
  ดู `media.md`

### A.4 ดาวน์โหลดไฟล์ในแชต

`GET /api/files/<attachmentId>` → bytes (`http-api.ts:404-408`)

- `content-type` เป็น mime จริงเฉพาะชนิดที่ "แสดงในที่ได้" (`image/png|jpeg|webp|gif`, `audio/*`, `video/webm|mp4|ogg|quicktime`,
  `application/pdf`) อย่างอื่นเป็น `application/octet-stream` + `content-disposition: attachment` (`http-api.ts:98, 103-117`)
  — ใช้ `mime` ใน `AttachmentView` ตัดสินวิธีแสดง ไม่ใช่ header
- **รองรับ `Range` [api 1]**: `accept-ranges: bytes`, `206` + `content-range`, ช่วงผิด = `416` (ก่อน api 1 ส่งทั้งไฟล์ 200 เสมอ) — AVPlayer/ExoPlayer เล่นและเลื่อนจาก URL ตรง ๆ ได้ (ใส่ header Bearer)
- ทุกคำตอบมี `content-security-policy: default-src 'none'; sandbox`
- `404 {"error":"No such file."}`; ไฟล์ถูกลบตามระยะเก็บสื่อ = `410 {"error":"This media was removed after the retention period."}`
  (`AttachmentView.deletedAt` ไม่เป็น null)

### A.5 รูปและโมเดลของ agent, ชุด, ฉาก, แกลเลอรี

ทุกตัวต้องมี token; GET ตอบ bytes, POST (body = bytes ล้วน, `Content-Type` = mime) / DELETE ตอบ `{"ok":true}`
อัปโหลดนับเข้าโควตา "สื่อของผู้ใช้" (เต็ม = `507`, `http-api.ts:335-343`)

| Path | GET | POST (ขนาดสูงสุด) | DELETE | หลังเปลี่ยน broadcast | อ้างอิง |
|---|---|---|---|---|---|
| `/api/agent-image/<agent>/<avatar\|portrait>` | รูป | 8 MB | ✓ | `agents` | `http-api.ts:409-429` |
| `/api/sprite/agent/<agent>/<emojiKey>` | รูป | 8 MB | ✓ | `agents` | `http-api.ts:472-494` |
| `/api/sprite/outfit/<outfitId>/<emojiKey>` | รูป | 8 MB | ✓ | `wardrobe` | `http-api.ts:472-494` |
| `/api/agent-model/<agent>` | `model/vrm` | 128 MB | ✓ | `agents` | `http-api.ts:429-447` |
| `/api/agent-motions/<agent>` | `{"motions":[{name,version}]}` | – | – | – | `http-api.ts:448-452` |
| `/api/agent-motion/<agent>/<name>` | FBX (`application/octet-stream`) | 64 MB | ✓ | `agents` | `http-api.ts:453-471` |
| `/api/wardrobe-image/<outfitId>` | รูป | 8 MB | ✓ | `wardrobe` | `http-api.ts:584-603` |
| `/api/wardrobe-model/<outfitId>` | `model/vrm` | 128 MB | ✓ | `wardrobe` | `http-api.ts:565-583` |
| `/api/background-image/<backgroundId>` | รูป | 12 MB | ✓ | `backgrounds` | `http-api.ts:545-564` |
| `POST /api/chat-background?chat=<chatId>&name=<ชื่อ>` | – | 12 MB → `{"id":"chatbg-<chatId>-…"}` | – | `backgrounds` | `http-api.ts:528-544` |
| `POST /api/gallery/<agent>?title=&tags=a,b&description=` | – | 12 MB → `GalleryItemView` | – | `gallery-changed` | `http-api.ts:495-515` |
| `GET /api/gallery/<agent>/<id>` / `…/<id>/thumb` | รูป / preview | – | – | – | `http-api.ts:516-519` |
| `POST /api/gallery/<agent>/<id>/thumb` | – | 512 KB (JPEG ที่ client ย่อเอง) | – | – | `http-api.ts:520-525` |

**URL ของรูปใน view:** field `avatar`, `portrait`, `image`, `sprites[key]`, `model` ใน `AgentView` / `WardrobeOutfitView` / `BackgroundView`
คือ **version stamp** (หรือ `null` = ไม่มีรูป) ไม่ใช่ URL — ประกอบ URL เองแล้วต่อ `?v=<stamp>` เพื่อ cache เช่น
`/api/agent-image/mimi/avatar?v=<agent.avatar>` (`app.js` ใช้รูปแบบนี้, `feature-stage.js:331`)
ยกเว้น `GET /api/widget` ที่ให้ path พร้อม `?v=` มาแล้ว

### A.6 Widget และแจ้งเตือนแบบ poll (ออกแบบมาเพื่อ Android)

**`GET /api/widget[?since=<ISO>]`** — แชตล่าสุด 6 แชตที่มีข้อความ (`server.ts:2151-2189`) จริง:

```json
{"chats":[{"id":1,"title":"มิมิ","agent":"mimi","avatar":null,"preview":"สวัสดีค่ะ **ทดสอบ**","lastMessageAt":"2026-11-02T11:00:32.174Z","unread":0}],"busyChat":null}
```

- `title` = ชื่อแสดงของ agent (direct) หรือชื่อกลุ่ม; `avatar` = path พร้อม `?v=` หรือ `null`
- `unread` = จำนวนคำตอบ assistant ใน 60 ข้อความล่าสุดของ session ล่าสุดที่ใหม่กว่า `readAt` (**`since` ถูกรับแต่ไม่ได้ใช้**: พารามิเตอร์ชื่อ `_since` ใน `server.ts:2151`)

**`GET /api/notifications[?since=<ISO>]`** — notification ที่ **ยังไม่อ่าน** สูงสุด 30 รายการ ใหม่สุดก่อน ที่สร้างหลัง `since`
(`server.ts:2190-2197`):

```json
[{"id":12,"kind":"reminder","title":"…","body":"…","chatId":null,"createdAt":"2026-11-02T…"}]
```

แอป Android เดิม poll ตัวนี้ทุก 30 วินาทีจาก foreground service และจำ id ล่าสุดเพื่อไม่แจ้งซ้ำ (`android/…/PushService.java:47-71`,
`WidgetSync.java:305-329`) — ดู `push-and-background.md`

**`GET /api/notifications?afterId=<id>` [api 1]** — ทุก notification ที่ `id > afterId` **ทั้งที่อ่านแล้วและยังไม่อ่าน** เก่าสุดก่อน สูงสุด 100 รายการ
มี `read` เพิ่ม (ใช้ลบ notification ที่ผู้ใช้อ่านบนอุปกรณ์อื่นแล้ว) แอป native ใช้ตัวนี้ (`afterId=0` ครั้งแรก แล้วจำ id สุดท้าย) · `afterId` ไม่ใช่จำนวนเต็ม ≥0 = `400`

```json
[{"id":13,"kind":"reminder","title":"ยา","body":"กินยา","chatId":null,"createdAt":"2026-11-02T…","read":false}]
```

ชนิดของคำตอบ widget/notifications อยู่ใน `packages/shared/src/views.ts` (`WidgetView`, `NotificationSyncItem`) **[api 1]**

### A.6.1 Push token ของแอป native [api 1]

| Method | Path | body | ตอบ |
|---|---|---|---|
| POST | `/api/push/register` | `NativePushRegistration`: `{"platform":"fcm"\|"apns"\|"wns","token":"…","label"?:"Pixel 8","appVersion"?:"1.0.0","bundleId"?:"app.mimi.ios","sandbox"?:true}` | `{"ok":true,"device":PushDeviceView,"delivering":true\|false}` |
| POST | `/api/push/unregister` | `{"token":"…"}` | `{"ok":true,"removed":true\|false}` |
| GET | `/api/push/info` **[api 2]** | – | `{"platforms":["fcm"\|"apns"\|"wns"…],"wnsRemoteId"?:"<Entra ID app id>"}` — บริการที่ core นี้ (กุญแจของตัวเองหรือ relay ของ gateway) ส่งได้ · แอป Windows ใช้ `wnsRemoteId` สร้าง channel · core เก่าไม่มี = `404` |

- FCM token: `[\w:.-]{20,4096}`; APNs token: hex 32–200 ตัว; WNS **[api 2]**: channel URI `https://<…>.notify.windows.com/…` เท่านั้น (ไม่มี port/user) ผิดรูปแบบ = `400 {"error":"Native push: …"}`
- ลงทะเบียน token เดิมซ้ำ = อัปเดต (ไม่เพิ่มอุปกรณ์) — เรียกทุกครั้งที่แอปเริ่มและเมื่อ FCM/APNs ให้ token ใหม่ (`onNewToken`, `didRegisterForRemoteNotificationsWithDeviceToken`)
- `delivering: false` = core นี้ไม่มีกุญแจของแพลตฟอร์มนั้น (`MIMI_FCM_SERVICE_ACCOUNT` / `MIMI_APNS_*`): เก็บ token ไว้แต่จะไม่ได้ push → ใช้ poll `afterId` แทน
- `device.endpoint` = `native:<platform>:<id 16 hex>` (ไม่มี token จริง) ใช้กับ `push-unsubscribe` ได้เหมือน endpoint ของ Web Push
- `sandbox: true` = build สำหรับพัฒนา (APNs sandbox) · `bundleId` = topic ของ APNs (ไม่ส่ง = `MIMI_APNS_TOPIC`)
- เนื้อหาของ push ดู `push-and-background.md` ข้อ 2.2

### A.6.2 ตอบจากปุ่มบน notification (ไม่ต้องเปิด WS) [api 1]

| Method | Path | body | ตอบ |
|---|---|---|---|
| POST | `/api/permissions/<requestId>` | `{"allow":true,"scope"?:"once"\|"task"\|"session"\|"always"}` | `{"ok":true}` · ไม่รออยู่แล้ว = `404` |
| POST | `/api/approvals/<approvalId>` | `{"approved":true,"note"?:"…"}` | `{"ok":true}` · ไม่รออยู่แล้ว = `404` · id ไม่ใช่ตัวเลข = `400` |

ผลเหมือน WS `permission-response` / `approval-decide` ทุกอย่าง (อุปกรณ์อื่นได้ `permission-resolved` / `chat-changed`)

### A.7 Mimiamp (เครื่องเล่นเพลง) — ลบแล้ว

**ลบแล้วใน api 2** (Mimiamp ถูกเอาออกทั้งหมด — คำตอบ Q5 ใน `README.md`): `/mimiamp/*`, `/api/mimiamp/*`, เสียง YouTube และ frame `mimiamp` ไม่มีแล้ว ตอบ `404` / ไม่ส่ง
แอปต้องทนเซิร์ฟเวอร์เก่า (api ≤ 1) ที่ยังส่ง `{"type":"mimiamp",…}`: ข้ามไปเงียบ ๆ เหมือน frame ที่ไม่รู้จัก

### A.8 อื่น ๆ ที่ต้องมี token

| Method | Path | ตอบ | อ้างอิง |
|---|---|---|---|
| GET | `/api/backups/<mimi-backup-….tar.gz>` | `application/gzip` (ชื่อได้จาก frame `backups`) · ชื่อผิดรูปแบบ = `404` | `http-api.ts:387-399` |
| GET | `/api/export/chats.csv` | CSV ทุกแชต (UTF-8 + BOM) | `http-api.ts:345-360` |
| GET | `/api/export/chat/<chatId>.csv` | CSV แชตเดียว | `http-api.ts:345-360` |
| POST | `/app/<action>` | ของแอป Electron (ให้ launcher เปิดหน้าต่าง) **แอป native ไม่ใช้**; ผ่าน gateway = 404 | `server.ts:2279-2286` |

### A.9 Webhook (เรียกจากบริการภายนอก ไม่ใช่แอป)

`POST|PUT|GET /api/webhook/<key>` และ `/api/workflow/<key>` บน core; บน gateway ต้องผ่าน `<gateway>/h/<id>/api/...`
(`http-api.ts:294-330`, `gateway.ts:366-381`) แอป native แค่ **แสดง URL ให้ผู้ใช้ copy**:
`<base>` + (`webhookBase` ถ้าเป็น gateway) + `TriggerInfo.webhook` (`app.js:5617`)

---

## ส่วน B — คำสั่ง WebSocket (ClientMessage → ServerMessage)

สัญลักษณ์: **R** = ตอบเฉพาะ socket ที่ขอ, **B** = broadcast ทุก socket, `—` = ไม่มีคำตอบเมื่อสำเร็จ
ผิดพลาดทุกตัว = `{"type":"error","message","code","requestType"}` (R; `requestType` = type ของคำสั่งที่ล้ม **[api 1]**, คำสั่งที่ core ไม่รู้จัก = `code: "E-PROTOCOL"`) อ้างอิงบรรทัดคือ `case` ใน `packages/core/src/server/server.ts`
(หรือ `chat-api.ts`) — ชนิดเต็มของแต่ละ field ดู `protocol.ts:711-926` (client) และ `protocol.ts:943-1110` (server)

### B.1 เชื่อมต่อ / ระบบ

| ส่ง | ได้ | หมายเหตุ |
|---|---|---|
| `hello {role:'client', token, name?, client?}` | R `welcome` (มี `version`, `api`, `minClientApi` **[api 1]**) · `client.api < minClientApi` = close `4426` | ดู `realtime.md` ข้อ 2, `api-versioning.md` |
| `ping` | R `pong` | `server.ts:1153` |
| `presence {chatId\|null, visible}` | — (อาจ B `notifications`) | `server.ts:1156` |
| `ui-set {values}` | — (ส่ง `ui` ไปอุปกรณ์อื่น) | `server.ts:1736` |
| `tunnel-start` / `tunnel-stop` | — (สถานะมาใน `settings.tunnel`) | เฉพาะ core บนคอมพิวเตอร์ `server.ts:1294-1300` |

### B.2 แชต (`packages/core/src/server/chat-api.ts`)

| ส่ง | ได้ | หมายเหตุ |
|---|---|---|
| `chats-list` | R `chats {chats: ChatView[]}` | :411 |
| `chat-create {kind, agents[], title?}` | B `chats` + R `chat-history` | direct คืนแชตเดิมถ้ามี :414 |
| `chat-update {chatId, title?, agents?}` | B `chats` | :424 |
| `chat-delete {chatId}` | B `chats` | :433 |
| `chat-open {chatId, sessionId?, beforeId?, afterId?}` | R `chat-history` (+ B `chats` เมื่อ mark read) | 40/60 ข้อความต่อหน้า; `afterId` **[api 1]** = เฉพาะข้อความหลัง id นั้น เก่าสุดก่อน ≤200 (`hasMore` = ขอต่อจากตัวสุดท้าย) คำตอบมี `afterId` :437 |
| `chat-send {chatId, text, attachments?, replyTo?, clientId?, forward?}` | B `busy`, `chat-session`, `chat-message`, `chat-event`…, `chat-turn-messages` **[api 1]**, `chats`, `busy done` | `realtime.md` ข้อ 4 :440 |
| `abort {chatId?}` | — | `server.ts:1176` |
| `session-new {chatId}` | B `chat-session (started)` + R `chat-history` | :473 |
| `session-context {chatId, sessionId?}` | R `session-context {context: SessionContextView}` | ไม่มี agent = ไม่มีคำตอบ :481 |
| `rewind {sessionId, messageId}` | R `rewound {text, restored?, skipped?}` + B `chat-changed`, `chats` | ข้อความนั้นและหลังจากนั้นถูกซ่อน :506 |
| `message-pin {messageId, pinned}` | B `message-marks` | :525 |
| `message-react {messageId, emoji}` | B `message-marks` | emoji ≤16 ตัว toggle :526 |
| `search {query}` | R `search-results {query, hits: SearchHit[]}` | สูงสุด 80 ผล :549 |
| `approval-decide {id, approved, note?}` | — (แชตได้ `chat-changed`) | ไม่รอแล้ว = `error` `server.ts:1904` |
| `permission-response {requestId, allow, scope?}` | — (B `permission-resolved`) | `server.ts:1183` |
| `permission-revoke {tool, agent?}` | B `settings` | `server.ts:1199` |
| `task-control {taskId, action: pause\|resume\|cancel}` | — (event `task-update`) | |
| `task-undo {taskId}` | B `chat-event` (task-*) | |
| `task-kill` | — | หยุดทุกงาน |
| `status-set {agent, key, value}` | — (B `status`) | key: location/outfit/current_task/mood/situation :577 |

ตัวอย่าง `chat-history` จริง (ตัด field ซ้ำ):

```json
{"type":"chat-history",
 "chat":{"id":1,"kind":"direct","title":"","agents":["mimi"],"lastMessageAt":"2026-11-02T11:00:32.174Z","preview":"สวัสดีค่ะ **ทดสอบ**","unread":false},
 "session":{"id":1,"chatId":1,"title":"สวัสดี","summary":"","auto":true,"createdAt":"…","lastMessageAt":"…","readAt":"…","unread":true},
 "sessions":[{…}],
 "messages":[
  {"id":1,"role":"user","agent":"mimi","text":"สวัสดี","createdAt":"…","attachments":[{"id":"9f7f…","kind":"file","name":"note.txt","mime":"text/plain","size":10,"text":"hello file","caption":"โน้ต","deletedAt":null}],
   "tools":[],"replyTo":null,"forwardedFrom":null,"approval":null,"pinned":false,"reactions":[]},
  {"id":2,"role":"assistant","agent":"mimi","text":"สวัสดีค่ะ **ทดสอบ**","speech":{"emotion":"ยินดี"},"createdAt":"…","attachments":[],
   "tools":[],"replyTo":null,"forwardedFrom":null,"approval":null,"pinned":false,"reactions":[]}],
 "hasMore":false,"pins":[],"live":null}
```

`tools[]` ของข้อความ assistant คือ `{name, summary}` ของเครื่องมือที่เรียกในขั้นนั้น; `approval` มีเมื่อ workflow ขออนุมัติ
(แสดงปุ่ม อนุมัติ/ปฏิเสธ → `approval-decide`)

**การแสดงข้อความ (`text`)** — เว็บไม่ได้ render Markdown เต็ม แค่ (`app.js:436-524`):
- ` ```…``` ` = code block
- `` `x` `` = inline code, `**x**` = ตัวหนา, `*x*` = "การกระทำ" (ตัวเอียงสีจาง), `https?://…` = ลิงก์ (เปิดเบราว์เซอร์), `@ชื่อ` = mention
- อย่างอื่นเป็นข้อความธรรมดา (ห้าม render เป็น HTML) — ข้อความ user ไม่มีแท็ก `<attachment>` แล้ว (ถูกตัดที่เซิร์ฟเวอร์: `chat-api.ts:148`)

### B.3 Agent, overseer, setup

| ส่ง | ได้ |
|---|---|
| `agents-list` | R `agents {agents: AgentView[], tools: ToolView[], defaultAgent}` (`server.ts:1530`) |
| `agent-save {agent: AgentView, renameFrom?}` | B `agents (saved)`, `settings` (`server.ts:2004`) |
| `agent-delete {name}` | B `agents`, `settings` |
| `agent-presets` | R `agent-presets {presets: AgentPresetView[]}` |
| `overseer-get` / `overseer-save {model}` | R/B `overseer {overseer: OverseerView}` |
| `memory-list` / `memory-save {path, description?, content}` / `memory-delete {path}` | R `memory {entries: MemoryView[]}` |
| `skills-list` / `skill-save {skill, renameFrom?}` / `skill-delete {name}` | R/B `skills` (`chat-api.ts:552-565`) |
| `preset-save {preset: PresetView, renameFrom?}` / `preset-delete {name}` | B `settings` (`chat-api.ts:569-576`) |

### B.4 ตั้งค่า, ผู้ให้บริการโมเดล, บัญชี

| ส่ง | ได้ |
|---|---|
| `settings-get` | R `settings {settings: SettingsView}` (`protocol.ts:570-640`) |
| `settings-save {keys?, defaults?, allowedDirs?, projectRoots?, storage?, session?, timezone?}` | R `settings (saved)` |
| `preferences-save {preferences: PreferencesView}` | B `settings` |
| `provider-connect {id, name?, baseURL?, apiKey?, models?}` | B `settings` (หรือ `error` ถ้าเรียกรายชื่อโมเดลไม่ได้) |
| `provider-update {id, name?, baseURL?, models?}` / `provider-remove {id}` | B `settings` |
| `chatgpt-plan-connect` | R `provider-auth-url {id, url}` → เปิดเบราว์เซอร์ → B `settings` |
| `google-connect` / `microsoft-connect` | R `google-auth-url` / `microsoft-auth-url {url}` → เปิดเบราว์เซอร์ |
| `oauth-accounts` / `oauth-account-save {account, id?}` / `-remove {id}` / `-default {id}` | R/B `oauth-accounts` |
| `oauth-account-connect {id}` | R `oauth-auth-url {accountId, service, url}` → เมื่อเสร็จ B `oauth-accounts (saved)` |
| `connector-connections` / `connector-connection-save` / `-remove` / `-default` | R/B `connector-connections` (+ B `tools`) |
| `connector-connection-connect {id}` | R `connector-auth-url {connectionId, url}` |
| `connector-connection-test {connector, operation, input, account?}` | R `connector-test-result {ok, message}` |
| `connector-operation-options {reqId, …}` | R `connector-options {reqId, ok, options[]}` |
| `secrets-list` / `secrets-save {values}` | R/B `secrets {names[]}` (ค่าไม่เคยส่งกลับ) |
| `mail-watch` / `mail-watch-save {account, password?, smtpPassword?}` / `-delete {id}` / `-check` / `mail-account-test {id}` | R `mail-watch` |
| `calendar-sync` / `calendar-sync-now` / `calendar-calendars {account}` / `calendar-set {account, calendarId}` | R `calendar-sync` / `calendar-calendars` |
| `profile-get` / `profile-save {profile}` | R/B `profile` |
| `backups-list` / `backup-create {includeSecrets}` | R `backups {backups[], dir, created?}` → ดาวน์โหลด `GET /api/backups/<name>` |

**ความลับเดินทางทางเดียว:** API key, รหัสผ่านเมล, secret ส่งจาก client ไป server เท่านั้น (`settings-save.keys`,
`provider-connect.apiKey`, `secrets-save`, `mail-watch-save.password`) เซิร์ฟเวอร์ไม่ส่งค่ากลับ (`protocol.ts:569`)
แอปห้ามเก็บค่าเหล่านี้ในเครื่องหลังส่งแล้ว

### B.5 แจ้งเตือน

| ส่ง | ได้ |
|---|---|
| `notifications-list` | R `notifications {items: NotificationItem[], unread}` (50 ล่าสุด) |
| `notifications-read {ids?}` | B `notifications` (ไม่ใส่ ids = อ่านทั้งหมด) |
| `push-key` / `push-subscribe` / `push-test` | Web Push — ดู `push-and-background.md` |
| `push-devices` / `push-unsubscribe {endpoint}` | R/B `push-devices` — รายการมีทั้ง Web Push และแอป native (`platform`), ลบได้ทั้งสองแบบ |
| `native-push-register {platform, token, label?, appVersion?, bundleId?, sandbox?}` / `native-push-unregister {token}` **[api 1]** | B `push-devices` (เหมือน A.6.1) |

### B.6 Trigger, workflow, เครื่องมือ (หน้าจัดการ)

| ส่ง | ได้ |
|---|---|
| `triggers-list` / `triggers-sync` | R `triggers {triggers: TriggerInfo[]}` (`triggers-sync` = เฉพาะ active และ mark ว่า sync แล้ว) |
| `trigger-create {trigger}` / `trigger-update {id, patch}` / `trigger-delete {id}` / `trigger-run {id}` / `trigger-cancel {id}` | B `triggers` |
| `workflows-list {agent?}` | R `workflows {workflows, pool, nodeTypes, customNodes}` |
| `workflow-save {workflow, renameFrom?}` / `workflow-delete {agent, name}` | B `workflows (saved)`, `triggers` |
| `workflow-run {agent, name, input?, pins?}` / `workflow-run-from {…, nodeId, runId}` | R `workflow-result {result}` + B `workflow-runs` |
| `workflow-runs {agent, name}` / `workflow-run-get {id}` | R `workflow-runs` / `workflow-run-record` |
| `workflow-test-node {workflow, node, input}` | R `workflow-node-result` |
| `workflow-expr-preview {reqId, text, json, nodes?, vars?}` | R `workflow-expr-preview {reqId, ok, value?, error?}` |
| `workflow-import-n8n\|make\|zapier {agent, json, save, reqId?}` | R `workflow-import` (+ B `workflows` เมื่อ save) |
| `trigger-pool-save {entry}` / `trigger-pool-delete {name}` | B `workflows` |
| `tools-list` | R `tools` (`ToolPoolView`) |
| `tool-save` / `tool-delete` / `tool-preset-save` / `tool-preset-delete` / `mcp-save` / `mcp-delete` / `mcp-refresh` | B `tools`, `agents` |
| `connector-import-preview\|save {source, key?, label?, replace?, reqId?}` / `connector-import-delete {key}` | R `connector-import-report` (+ B `tools`) |
| `packs-list` / `pack-preview\|pack-install {id?\|source?, reqId?}` / `pack-remove-preview\|pack-remove {id}` | R `packs` / `pack-report` / `pack-remove-report` |

### B.7 คลังความรู้, ตู้เสื้อผ้า, ฉาก, แกลเลอรี

| ส่ง | ได้ |
|---|---|
| `knowledge-list` / `knowledge-save {collection}` / `knowledge-delete {name}` | R/B `knowledge` |
| `knowledge-documents {collection}` / `knowledge-remove-document {collection, id}` | R `knowledge-documents` |
| `knowledge-add {collection, title?, text?, url?, attachmentId?, path?}` | R `knowledge-added {documentId, chunks, warning?}` + `knowledge-documents` (ไฟล์: อัปโหลดด้วย `/api/upload` ก่อนแล้วส่ง `attachmentId`) |
| `knowledge-search {query, collection?}` / `knowledge-embed {collection}` | R `knowledge-results` / `knowledge-embedded` |
| `wardrobe-list` / `wardrobe-save {outfit, renameFrom?}` / `wardrobe-delete {id}` | R/B `wardrobe {outfits}` |
| `backgrounds-list` / `background-save` / `background-delete` / `background-select {agent?, choice}` | R/B `backgrounds {items, settings}` (`choice`: id, `"none"`, `"auto"`, `""`) |
| `gallery-list {agent, query?, offset?, limit?}` / `gallery-update` / `gallery-delete` | R `gallery {…, total, items}` / B `gallery-changed` |

### B.8 คำสั่งเก่าที่แอป native ไม่ต้องใช้

`send {text, agent?}` (คุยแบบไม่มีแชต สำหรับ CLI: `server.ts:1168`) และ `history` → `history` (`server.ts:1235`)
frame `user-message` และ `event` ของ turn แบบนี้ไม่มี `chatId`

---

## ส่วน C — ชนิดข้อมูลหลักที่แอปแชตต้องใช้ (สรุป)

| ชนิด | ที่ | สาระ |
|---|---|---|
| `ChatView` | `protocol.ts:184-195` | `id, kind, title, agents[], lastMessageAt, preview, unread` — direct ที่ `title` ว่างให้ใช้ชื่อแสดงของ agent |
| `SessionView` | `protocol.ts:155-167` | `id, chatId, title, summary, auto, createdAt, lastMessageAt, readAt, unread` |
| `ChatMessageView` | `protocol.ts:87-110` | ดูตัวอย่าง B.2 |
| `AttachmentView` | `protocol.ts:72-84` | ดู A.3 |
| `AgentEvent` | `events.ts:26-69` | `run-start`, `text-delta`, `tool-call`, `tool-result`, `attachment`, `usage`, `permission-request`, `permission-decision`, `agent-activity`, `task-*`, `run-finish` |
| `RunFinishReason` | `events.ts:7-16` | `stop`, `max_rounds`, `max_tokens`, `trace_budget`, `handoff`, `aborted`, `error` |
| `PermissionRequest` | `permissions.ts:3-19` | ดู `realtime.md` ข้อ 5 |
| `LiveTurnView` | `protocol.ts:136-152` | turn ที่ยังวิ่งตอนเปิดแชต |
| `AgentView` | `protocol.ts:414-447` | `name, displayName?, avatar?, portrait?, sprites?, character?, status?, …` |
| `NotificationItem` | `protocol.ts:247-281` | `id, kind, title, body, chatId?, agent?, createdAt, read` |
| `SettingsView.ready` | `protocol.ts:637` | `false` = ยังไม่มี agent หรือ provider ยังไม่ต่อ → พาไปหน้า setup |
