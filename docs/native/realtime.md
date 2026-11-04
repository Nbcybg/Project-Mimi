# Realtime: WebSocket `/ws`

> ชนิดข้อมูลทั้งหมดอยู่ใน `packages/shared/src/protocol.ts` (`ClientMessage` บรรทัด 711, `ServerMessage` บรรทัด 943)
> และ `packages/shared/src/events.ts` (`AgentEvent`) — ตัวอย่าง JSON ในไฟล์นี้บันทึกจาก core + gateway ที่รันในเครื่อง
> ด้วย LLM จำลอง (2026-11-02) token ในตัวอย่างถูกตัดออก

## 1. ภาพรวม

- **ทุกอย่างที่ไม่ใช่ไฟล์วิ่งบน WebSocket เส้นเดียว**: แชต, รายการแชต, ตั้งค่า, agent, workflow, การแจ้งเตือนสด ฯลฯ
  HTTP มีไว้สำหรับ bytes (อัปโหลด/ดาวน์โหลดไฟล์, รูป, เพลง) ดู `api-contract.md`
- URL: `wss://<host>/ws` (หรือ `ws://` สำหรับ http) — core `server.ts:2300-2313`, gateway `gateway.ts:394-407`
- ทุก frame เป็น **JSON object หนึ่งตัวต่อหนึ่ง text frame** (`protocol.ts:10-13`) ไม่มี binary frame จาก client
- ขนาด frame สูงสุด **4 MB** ทั้งสองทาง (`maxPayload`, `server.ts:2303`, `gateway.ts:50`) เกินแล้ว socket ถูกปิด (close `1009`)
- frame ที่ parse ไม่ได้ถูกเงียบทิ้ง (`server.ts:2325-2326`)
- **Origin:** ถ้า client ส่ง header `Origin` มา host ต้องตรงกับ `Host` ไม่อย่างนั้น upgrade ถูกปฏิเสธ (HTTP 401) — `server.ts:2306-2312`
  client native ปกติไม่ส่ง `Origin` (OkHttp, `URLSessionWebSocketTask`, `ClientWebSocket`) แต่บาง library ใส่ให้เอง
  (เช่น Starscream บน iOS) ต้องปิดหรือตั้งให้ตรงกับ host
- เซิร์ฟเวอร์ **broadcast** frame ส่วนใหญ่ไปทุก client ของ core นั้น (`server.ts:156-159`) ไม่มีการ subscribe ราย chat:
  แอปต้องกรองเองด้วย `chatId` / `sessionId`

## 2. Handshake

```
client                                   server
  │── WS upgrade /ws ───────────────────────▶│
  │── {"type":"hello","role":"client",       │   ต้องมาภายใน 10 วินาที ไม่อย่างนั้น close 4001 "hello timeout"
  │     "token":"…","name":"android"} ──────▶│   (server.ts:2322, HELLO_TIMEOUT_MS = 10_000 ที่ server.ts:100)
  │◀── {"type":"welcome", …} ────────────────│   token ถูก
  │      หรือ close 4003 "invalid token"     │   token ผิด / frame แรกไม่ใช่ hello (ทดสอบแล้วทั้งสองกรณี)
  │      หรือ close 4029 "too many wrong…"   │   ถูก rate limit
```

- `name` เป็นข้อความอิสระ (เว็บใช้ `"web"`, `app.js:5682`) ปัจจุบันเซิร์ฟเวอร์ไม่ได้ใช้สำหรับ client
- **[api 1]** แอป native ส่ง `"client":{"platform":"android","version":"1.0.0","api":1}` ด้วย ถ้า `api` ต่ำกว่า `minClientApi` ของ core
  จะได้ close `4426` แทน `welcome` และ `welcome` มี `version`, `api`, `minClientApi` — รายละเอียดใน `api-versioning.md`
- `role` ต้องเป็น `"client"` (`"pc"` คือ PC agent ซึ่งเป็นอีกโปรโตคอล — แอป native ไม่ใช้)
- frame ที่ส่งก่อน `welcome` ผ่าน gateway จะถูกพักไว้สูงสุด 200 frame (`gateway.ts:58, 421-427`) แต่ **ให้รอ `welcome` ก่อนส่งอะไร**

`welcome` จริง (เซิร์ฟเวอร์ใหม่ ยังไม่มี agent):

```json
{"type":"welcome","agents":[],"defaultAgent":"","pcOnline":false,"busy":false,"busyChat":null,"busyChats":[],"pendingPermissions":[],"ui":{}}
```

| field | ใช้ทำอะไร |
|---|---|
| `agents[]` | `{name, displayName?, description}` รายการย่อ (รายละเอียดเต็มขอด้วย `agents-list`) |
| `defaultAgent` | agent หลัก ว่างเมื่อยังไม่มี agent |
| `pcOnline` | PC agent ต่ออยู่ไหม (อัปเดตด้วย `pc-status`) |
| `busyChats[]` | chat ที่กำลังมี turn วิ่งอยู่ — แสดง "กำลังพิมพ์" ได้ทันที |
| `pendingPermissions[]` | คำขออนุญาตที่ยังรอคำตอบ (อาจมาจาก chat อื่นหรืองานเบื้องหลัง) ต้องแสดงการ์ดให้ตอบได้ |
| `ui` | ค่าหน้าจอที่ทุกอุปกรณ์ของบัญชีใช้ร่วมกัน (ดูข้อ 8) |

### 2.1 สิ่งที่ต้องขอหลัง `welcome`

เว็บเดิมส่งชุดนี้ทุกครั้งที่ได้ `welcome` (`app.js:5164-5178`):

```json
{"type":"overseer-get"}  {"type":"agents-list"}  {"type":"settings-get"}  {"type":"chats-list"}
{"type":"skills-list"}   {"type":"tools-list"}   {"type":"workflows-list"} {"type":"secrets-list"}
{"type":"mail-watch"}    {"type":"calendar-sync"}
```

ขั้นต่ำสำหรับหน้าแชตคือ `agents-list`, `chats-list`, `settings-get` (เพื่อรู้ `ready`) จากนั้น
`{"type":"presence","chatId":<id|null>,"visible":true}` และถ้ามีแชตเปิดอยู่ `{"type":"chat-open","chatId":<id>}`

## 3. Request / response

**ไม่มี request id กลางของโปรโตคอล** คำตอบผูกกับคำขอด้วย `type` ของ frame ที่ตอบกลับ (ตารางเต็มใน `api-contract.md` ส่วน B)
มีข้อยกเว้นไม่กี่ตัวที่มี `reqId` (`workflow-expr-preview`, `connector-operation-options`, `connector-import-*`, `pack-*`,
`workflow-import-*`) และ `chat-send` มี `clientId`

กติกาที่ต้องรู้:

1. **คำตอบแบบ reply** ไปเฉพาะ socket ที่ขอ, **แบบ broadcast** ไปทุก socket (รวมตัวที่ขอ) — เช่น `chat-create` ได้ `chats` (broadcast)
   ตามด้วย `chat-history` (reply)
2. บางคำสั่ง **ไม่มีคำตอบเลย** เมื่อสำเร็จ (เช่น `abort`, `permission-response`, `status-set`, `approval-decide`, `ui-set`,
   `task-control`) ผลมาเป็น event ภายหลัง
3. ถ้าคำสั่งผิด เซิร์ฟเวอร์ตอบ `error` ไปที่ socket นั้น (`server.ts:2373-2378`):

```json
{"type":"error","message":"Unknown message type","code":"E-INTERNAL"}
{"type":"error","message":"Chat #9999 does not exist.","code":"E-CONFIG","clientId":"c-2"}
```

`error` ไม่บอกว่าเป็นของคำขอไหน (ยกเว้น `clientId` ของ `chat-send` และ `chatId` เมื่อ turn ล้ม) — ดู `server-gaps.md` G-WS-2
ค่า `code` ดู `docs/error-codes.md` (`E-AUTH`, `E-RATE`, `E-CONTEXT`, `E-MODEL`, `E-TIMEOUT`, `E-NETWORK`, `E-BUDGET`,
`E-CONFIG`, `E-PROVIDER`, `E-INTERNAL` อาจต่อท้ายด้วย HTTP status เช่น `E-RATE-429`) — `packages/core/src/errors.ts:37-61`

## 4. แชตแบบ streaming (หัวใจของแอป)

### 4.1 โมเดลข้อมูล

```
Chat (ChatView)             id, kind: direct|group, agents[], title, preview, unread
 └─ Session (SessionView)   ช่วงของบทสนทนา เริ่มใหม่เองเมื่อเงียบนาน/ยาวเกิน (settings.sessionIdleMinutes / sessionMaxTokens)
     └─ Message (ChatMessageView)  id, role: user|assistant|tool, agent, text, attachments[], tools[], speech?, replyTo?, …
```

- แชต direct ของ agent หนึ่งตัวมีได้ตัวเดียว: `chat-create` แบบ `direct` คืนแชตเดิมถ้ามีแล้ว (`chat-api.ts:414-422`)
- `chat-open` คืน **40 ข้อความล่าสุด** ของ session ล่าสุด (หรือ `sessionId` ที่ระบุ) `beforeId` ขอหน้าก่อนหน้า **ทีละ 60**
  (`FIRST_PAGE`/`OLDER_PAGE`, `chat-api.ts:59-60`) `hasMore` บอกว่ายังมีอีก
- `chat-open` ที่ไม่มี `beforeId` = ผู้ใช้อ่าน session นั้นแล้ว: เซิร์ฟเวอร์ mark read และ broadcast `chats` ใหม่ (`chat-api.ts:181-186`)

### 4.2 ลำดับเหตุการณ์จริงของหนึ่ง turn

บันทึกจากการส่ง `chat-send` พร้อมไฟล์แนบหนึ่งไฟล์ ผ่าน gateway (เวลาเป็น ms นับจากต่อ socket):

```text
-> 98  {"type":"chat-send","chatId":1,"text":"สวัสดี","attachments":["9f7f…"],"clientId":"c-1"}
<- 100 {"type":"busy","chatId":1}
<- 104 {"type":"chat-session","chatId":1,"session":{"id":1,"chatId":1,"title":"","summary":"","auto":true,
        "createdAt":"…","lastMessageAt":"…","readAt":"…","unread":false},"started":true}
<- 117 {"type":"chat-message","chatId":1,"sessionId":1,"message":{"id":1,"role":"user","agent":"","text":"สวัสดี",
        "createdAt":"…","attachments":[{"id":"9f7f…","kind":"file","name":"note.txt","mime":"text/plain","size":10,
        "text":"hello file","caption":"โน้ต","deletedAt":null}],"tools":[],"replyTo":null,"forwardedFrom":null,"clientId":"c-1"}}
<- 117 {"type":"chat-event","chatId":1,"sessionId":1,"agent":"mimi","event":{"type":"run-start",
        "traceId":"7cc2…","agent":"mimi","model":"mock/m1","userMessageId":1}}
<- 240 {"type":"chat-event",…,"event":{"type":"text-delta","text":"สวัสดี"}}
<- 319 {"type":"chat-event",…,"event":{"type":"text-delta","text":"ค่ะ "}}
<- 399 {"type":"chat-event",…,"event":{"type":"text-delta","text":"**ทดสอบ**"}}
<- 492 {"type":"chat-event",…,"event":{"type":"usage","round":1,"usage":{"inputTokens":120,"outputTokens":9,"cachedTokens":0,"costUsd":0}}}
<- 492 {"type":"chat-event",…,"event":{"type":"run-finish","traceId":"7cc2…","reason":"stop","rounds":1,
        "usage":{…},"contextTokens":129,"text":"สวัสดีค่ะ **ทดสอบ**","speech":{"emotion":"ยินดี"}}}
<- 497 {"type":"chat-turn-messages","chatId":1,"sessionId":1,"afterId":1,"messages":[{"id":2,"role":"assistant","agent":"mimi",
        "text":"สวัสดีค่ะ **ทดสอบ**","speech":{"emotion":"ยินดี"},"attachments":[],"tools":[],…}]}      ← [api 1]
<- 497 {"type":"chat-transcribing","chatId":1,"on":false}
<- 497 {"type":"chat-session","chatId":1,"session":{"id":1,…,"title":"สวัสดี","unread":true},"started":false}
<- 497 {"type":"chats","chats":[{"id":1,"kind":"direct","title":"","agents":["mimi"],"lastMessageAt":"…","preview":"สวัสดีค่ะ **ทดสอบ**","unread":true}]}
<- 497 {"type":"busy","chatId":1,"done":true}
<- 498 {"type":"busy","chatId":null}
```

ที่มาในโค้ด: `busy` (`server.ts:886-925`), `chat-session` / `chat-message` / `chat-event` (`chat-api.ts:210-274`)

### 4.3 สิ่งที่แอปต้องทำในแต่ละ frame

| frame | ทำอะไร |
|---|---|
| (ก่อนส่ง) | แสดง bubble ของผู้ใช้แบบ "กำลังส่ง" ทันที ผูกด้วย `clientId` ที่สร้างเอง (`^[\w.:-]{1,120}$`, `chat-api.ts:447`) |
| `busy {chatId}` | chat นั้นเริ่ม turn: แสดงปุ่มหยุด / "กำลังพิมพ์" ใน list และ header |
| `chat-session` | ถ้า `started: true` และ session ใหม่กว่าที่แสดงอยู่ = บทสนทนาขึ้น session ใหม่: ล้างหน้าจอแล้วใส่เส้นคั่น (`app.js:5251-5270`) ไม่อย่างนั้นอัปเดตชื่อ/สถานะ session |
| `chat-message` (role `user`) | แทน bubble ชั่วคราวที่ `clientId` ตรงกันด้วยข้อความจริง (ได้ `id`, `attachments[].text` ที่ถอดความแล้ว) ถ้าไม่มี `clientId` ที่รู้จัก = ข้อความจากอุปกรณ์อื่น/agent อื่น ให้เพิ่มต่อท้าย |
| `chat-transcribing {on}` / `chat-viewing {on}` | สถานะ "กำลังถอดเสียง…" / "AI กำลังดูรูป…" |
| `chat-event` → `run-start` | สร้าง bubble ของ assistant (agent = `event.agent`) แสดงตัวกำลังคิด |
| `chat-event` → `text-delta` | ต่อ `text` เข้า buffer ของ bubble ปัจจุบัน render ไม่เกินหนึ่งครั้งต่อ frame ของจอ (`app.js:1459-1470`) |
| `chat-event` → `tool-call` | ปิด bubble ข้อความปัจจุบัน แล้วเพิ่มแถวเครื่องมือ `call.name` + preview ของ `call.input` + ป้าย `risk` — **ข้อความที่มาหลังเครื่องมือขึ้น bubble ใหม่** (`app.js:1513-1525`) |
| `chat-event` → `tool-result` | ปิดแถวเครื่องมือที่ `callId` ตรงกัน ✓/✗ + `output` |
| `chat-event` → `attachment` | ไฟล์ที่ agent ส่ง แสดงใต้ข้อความ (โหลดจาก `/api/files/<id>`) |
| `chat-event` → `permission-request` | การ์ดขออนุญาต (ข้อ 5) |
| `chat-event` → `permission-decision` | ปิดการ์ด |
| `chat-event` → `usage` | ตัวนับ token/ค่าใช้จ่ายของรอบ (ไม่จำเป็นต้องแสดง) |
| `chat-event` → `agent-activity` | สิ่งที่ sub-agent ทำ (`event.agent` = sub-agent, `event.event` = AgentEvent ซ้อน) เว็บแสดงเป็นบรรทัดเล็ก ไม่ใช่ bubble (`app.js:1474-1483`) |
| `chat-event` → `task-*` | การ์ดงาน (task) ที่มี step, plan, receipt ควบคุมด้วย `task-control` / `task-undo` |
| `chat-event` → `run-finish` | แทนข้อความใน bubble ด้วย `text` (ฉบับสมบูรณ์) เก็บ `speech` ถ้า `reason` เป็น `error` แสดง `[errorCode] error`; ถ้าไม่ใช่ `stop`/`handoff` แสดง "หยุด: <reason>"; `handoff` = agent `handoff.to` จะตอบต่อใน turn เดียวกัน (มี `run-start` ใหม่ตามมา) |
| `error {chatId, clientId?}` | turn ล้ม: ทำเครื่องหมาย bubble ที่ `clientId` ตรงกันว่าส่งไม่สำเร็จ |
| `chats` | รายการแชตใหม่ทั้งชุด (แทนที่ทั้งหมด) |
| `chat-turn-messages {chatId, sessionId, afterId, messages}` **[api 1]** | ข้อความ assistant ที่ turn นี้เก็บ (หลังข้อความ user `afterId`) พร้อม `id`, `speech`, `tools`, `attachments` — **แทน bubble ที่ stream มาด้วยชุดนี้** (ใช้ pin/react/reply ได้ทันที) มาก่อน `busy done` |
| `busy {chatId, done:true}` | turn จบ: ปิดสถานะ "กำลังพิมพ์" — client ที่ไม่ได้ `chat-turn-messages` (core ก่อน api 1) ต้อง **ส่ง `chat-open` ของแชตนั้นอีกครั้ง** แล้ว merge โดยเทียบ id แบบเว็บ (`app.js:5317-5343`) |
| `busy {chatId:null}` | ไม่มี turn ใดวิ่งอยู่แล้ว (สำหรับ client เก่า) ใช้ล้างสถานะ busy ทั้งหมด |

**จุดที่ต้องระวัง**

- ข้อความ assistant ไม่มาเป็น `chat-message` (เว็บจะแสดงเป็นแถวของผู้ใช้) — ฉบับที่มี `id` มาใน `chat-turn-messages` **[api 1]**
  ตอนจบ turn; ก่อน api 1 ได้จาก `chat-open` เท่านั้น (`server-gaps.md` G-CHAT-1)
- turn ที่ workflow รับข้อความไป (chat trigger) ไม่มี `chat-turn-messages`; turn ที่ล้มก่อนเก็บข้อความ user ก็ไม่มี
- **บรรทัดกำกับเสียง** (`[emotion: …][tone: …][voice: …][speed: …]` บรรทัดแรกของคำตอบ) ถูกเซิร์ฟเวอร์ตัดออกจาก `text-delta`
  แล้ว (เซิร์ฟเวอร์พัก delta ที่ขึ้นต้นด้วย `[` จนถึง newline หรือ 600 ตัว: `packages/core/src/loop/agent-loop.ts:492-512`; ทดสอบแล้ว —
  `[emotion: ยินดี]\nสวัสดี` ส่งออกมาเป็น `สวัสดี`) ค่า `speech` มาใน `run-finish.speech` และใน `ChatMessageView.speech`
  เว็บยัง parse ซ้ำฝั่ง client เพื่อกันพลาด (`app.js:201-215`) แอป native ควรทำแบบเดียวกัน (กติกา: `packages/shared/src/speech.ts`)
- chat ต่างกันวิ่ง **พร้อมกันได้** (สูงสุด 4 turn ทั้งเซิร์ฟเวอร์, `server.ts:877`) ในแชตเดียวกัน turn ต่อคิวตามลำดับที่ส่ง
  แอปต้องเก็บสถานะ streaming แยกต่อ `chatId`
- `chat-event` ของแชตที่ไม่ได้เปิดอยู่ ให้ทิ้งได้ (เว็บกรองด้วย `showing(chatId, sessionId)`, `app.js:1673`) เพราะเปิดทีหลัง
  `chat-history.live` จะสร้าง bubble ที่ค้างอยู่ให้
- ข้อความ user ใน `chat-message` มี `agent: ""` แต่ใน `chat-history` เป็นชื่อ agent ของแชต (`"mimi"`) — อย่าใช้ `agent` ของข้อความ user ตัดสินอะไร (G-CHAT-2)

### 4.4 เปิดแชตกลางคันที่ turn ยังวิ่ง (`live`)

`chat-history.live` (`LiveTurnView`, `protocol.ts:136-152`) คือ turn ที่ยัง stream อยู่ใน session ที่เปิด:
`text` ที่พิมพ์มาแล้ว, `tools[]` (`ok: null` = ยังวิ่ง), `attachments[]`, `pendingPermissions[]`
แอปสร้าง bubble จาก `live` แล้ว **ต่อด้วย `text-delta` ที่ตามมา** (`server.ts:965-1034`)
หมายเหตุ: `live.speech` ไม่เคยถูกตั้งค่า (G-CHAT-3) ใช้ `run-finish.speech` แทน

### 4.5 คำสั่งที่ใช้ระหว่าง turn

```json
{"type":"abort","chatId":1}                                     // หยุด turn ของแชตนี้ (ไม่มี chatId = หยุดทุก turn) ไม่มีคำตอบ ผลคือ run-finish reason "aborted"
{"type":"chat-send","chatId":1,"text":"…","attachments":["<id>"],"replyTo":12,"clientId":"c-2"}
{"type":"chat-send","chatId":1,"text":"…","forward":{"from":"มิมิ","chat":"งาน"}}   // ส่งต่อข้อความ
```

ข้อจำกัด `chat-send` (`chat-api.ts:440-470`): ข้อความถูก trim; ไม่มีข้อความและไม่มีไฟล์ = เงียบทิ้ง; ไฟล์แนบสูงสุด 20 รายการ
(id จาก `POST /api/upload`); `chatId` ที่ไม่มีจริง = `error` code `E-CONFIG`
ถ้า workflow ที่มี chat trigger รับข้อความไป agent จะไม่ตอบ (ได้แค่ `chat-message` ของผู้ใช้ ไม่มี `busy`)

## 5. ขออนุญาตใช้เครื่องมือ (permission)

```json
// เซิร์ฟเวอร์ (ใน chat-event หรือใน event สำหรับงานเบื้องหลัง)
{"type":"permission-request","request":{"id":"<uuid>","traceId":"…","thread":"…","agent":"mimi","tool":"write_file",
 "risk":"write","input":{…},"summary":"เขียนไฟล์ …","timeoutMs":900000,"noGrant":false,"createdAt":"…"}}

// แอปตอบ
{"type":"permission-response","requestId":"<uuid>","allow":true,"scope":"once"}   // scope: once | task | session | always
```

- ชนิด: `packages/shared/src/permissions.ts:3-30`; หมดเวลา 15 นาที (`packages/core/src/permissions/gate.ts:16`)
- `noGrant: true` = ให้เลือกได้แค่ "ครั้งนี้" หรือ "ไม่อนุญาต" (เช่นเติมรหัสผ่าน หรือเครื่องมือเกี่ยวกับเงิน: `permissions.ts:97-104`)
- ผลมาเป็น `permission-resolved` (`{requestId, decision}`) ทุก socket — ปิดการ์ดบนทุกอุปกรณ์ (`server.ts:1048-1052`)
- คำขอที่ค้างอยู่มาใน `welcome.pendingPermissions` และ `chat-history.live.pendingPermissions`
- ถ้าผู้ใช้ไม่ได้ดูแชตนั้น เซิร์ฟเวอร์สร้าง notification ชนิด `approval` ด้วย (`server.ts:952-959`)
- ถอน "อนุญาตตลอด": `{"type":"permission-revoke","tool":"<family>","agent":"<agent>"}`

## 6. Frame ที่มาเองโดยไม่ได้ขอ (ต้องรองรับ)

| frame | เมื่อไร |
|---|---|
| `chats` | รายการแชตเปลี่ยน (ข้อความใหม่, อ่านแล้ว, สร้าง/ลบ) |
| `chat-changed {chatId, sessionId}` | ข้อความถูกเพิ่ม/ซ่อนนอก turn (workflow โพสต์, approval, rewind) → ถ้ากำลังเปิดและไม่ busy ส่ง `chat-open` ใหม่; ถ้า busy รอจน `busy done` (`app.js:5345-5353`) |
| `message-marks` | pin/reaction ของข้อความเปลี่ยน (มี `pins[]` ใหม่ทั้งชุด) |
| `notification {notification}` | แจ้งเตือนสด (`kind`: reminder / task-result / info / approval / message) — `info` แสดงเป็นบรรทัดในแชต ที่เหลือเป็น toast/notification |
| `notifications {items, unread}` | inbox เปลี่ยน |
| `event {event}` | AgentEvent ของงานเบื้องหลัง (trigger, agent task) ที่ไม่ได้อยู่ในแชต — **อาจมี `permission-request`** ที่ต้องแสดงการ์ด (`server.ts:847-852`) |
| `permission-resolved` | ข้อ 5 |
| `pc-status {online, name?}` | PC agent ต่อ/หลุด |
| `status {agent, status}` | สถานะของ agent (location, outfit, mood, current_task, situation) |
| `agents`, `settings`, `skills`, `tools`, `workflows`, `triggers`, `knowledge`, `wardrobe`, `backgrounds`, `profile`, `secrets`, `oauth-accounts`, `connector-connections`, `packs`, `overseer` | ข้อมูลชุดนั้นเปลี่ยน (มักมี `saved`) — แทนที่ทั้งชุด |
| `gallery-changed {agent}` | รูปในแกลเลอรีของ agent เปลี่ยน → ขอ `gallery-list` ใหม่ถ้ากำลังเปิด |
| `mimiamp {command}` | **ลบแล้วใน api 2** — core เก่า (api ≤ 1) ยังส่งได้ แอปข้ามไป |
| `ui {values}` | ค่าหน้าจอที่ใช้ร่วมกันเปลี่ยนจากอุปกรณ์อื่น |
| `security-alert` | gateway เท่านั้น (ดู `auth-and-session.md`) |
| `user-message`, `history` | ของคำสั่งเก่า `send`/`history` (CLI) แอป native ไม่ต้องใช้ |

แอปต้อง **ไม่ล้ม** เมื่อเจอ `type` ที่ไม่รู้จัก (เซิร์ฟเวอร์ใหม่อาจเพิ่ม) ให้ log แล้วข้าม

## 7. Heartbeat, presence, reconnect

### 7.1 Heartbeat

- เซิร์ฟเวอร์ส่ง WebSocket **ping control frame** ทุก 30 วินาที socket ที่ไม่ตอบ pong ภายในรอบถัดไปถูกตัด (`server.ts:2391-2401`,
  gateway `gateway.ts:467-476`) — library native ตอบ pong ให้เองอัตโนมัติ
- client ควรส่ง **ping ระดับแอป** ด้วย: `{"type":"ping"}` → `{"type":"pong"}` (`server.ts:1153-1155`, ทดสอบแล้ว)
  เว็บส่งทุก 25 วินาที ถ้าไม่ได้ยินอะไรเลยเกิน 18 วินาทีให้ปิด socket แล้วต่อใหม่ (`app.js:5838-5855`)
  เพราะโทรศัพท์ที่ตื่นจาก sleep มักถือ socket ที่ตายแล้วโดยไม่รู้ตัว
- เมื่อแอปกลับมา foreground: ถ้าไม่มี traffic เกิน 12 วินาที ปิดแล้วต่อใหม่ทันที; ถ้ายังดี ส่ง `presence` และ `chat-open` ของแชตที่เปิดเพื่อตามสิ่งที่พลาด (`app.js:5760-5784`)

### 7.2 Presence (สำคัญต่อการแจ้งเตือน)

```json
{"type":"presence","chatId":1,"visible":true}
{"type":"presence","chatId":null,"visible":false}
```

เซิร์ฟเวอร์ใช้ presence ตัดสินว่าผู้ใช้ "กำลังดู" แชตไหน: ถ้ามี socket ใดที่ `visible: true` และ `chatId` ตรง จะ **ไม่สร้าง**
notification `message`/`approval` ของแชตนั้น (`server.ts:860-872, 952-953`) และ `visible: true` ของแชตหนึ่ง mark notification ของแชตนั้นว่าอ่านแล้ว (`server.ts:1156-1166`)

แอป native ต้องส่ง `visible: false` เมื่อเข้า background / จอดับ / ออกจากหน้าแชต ไม่อย่างนั้นผู้ใช้จะไม่ได้รับแจ้งเตือน
(presence ถูกลบเมื่อ socket ปิด: `server.ts:2384`)

### 7.3 Reconnect / resume

- ไม่มี resume token หรือ sequence number: **frame ที่เกิดระหว่างหลุดหายไป** การกลับมาคือขอสถานะใหม่ทั้งหมด
- ลำดับหลังต่อใหม่: `hello` → `welcome` → ชุดขอข้อมูลในข้อ 2.1 → `presence` → `chat-open` ของแชตที่เปิด
  (`chat-history.live` จะต่อ turn ที่ยังวิ่งให้) — เว็บทำแบบนี้ (`app.js:5164-5178`)
- **[api 1]** ถ้าแอปมีข้อความของ session นี้อยู่แล้ว ส่ง `{"type":"chat-open","chatId":…,"sessionId":…,"afterId":<id ล่าสุดที่มี>}`
  ได้เฉพาะข้อความใหม่ (≤200 ต่อครั้ง; `hasMore: true` = ขอต่อจาก id สุดท้าย) แทนการโหลด 40 ข้อความใหม่ทั้งหน้า
  — ถ้าคำตอบ `session.id` ไม่ใช่ session ที่มีอยู่ = บทสนทนาขึ้น session ใหม่ระหว่างหลุด ให้เปิดใหม่แบบไม่มี `afterId`
- backoff: เริ่ม 1 วินาที คูณ 2 สูงสุด 15 วินาที รีเซ็ตเป็น 1 วินาทีเมื่อต่อได้หรือเครือข่ายกลับมา (`app.js:5667-5752, 5830-5833`)
- **ห้าม reconnect** เมื่อ close `4003` (token ใช้ไม่ได้) และหน่วงนานเมื่อ `4029`
- เปิด socket ได้ทีละเส้นต่อแอป (เว็บกันซ้อน: `app.js:5672-5675`)
- bubble ที่ส่งไปแล้วแต่ยังไม่ได้ `chat-message` echo: หลังต่อใหม่ให้เทียบกับ `chat-history` (ข้อความเดียวกัน + ไฟล์เดียวกัน) เพราะ `clientId` ไม่ถูกเก็บในประวัติ (`app.js:2534`)

### 7.4 Close code ที่ต้องรู้

| code | จาก | ความหมาย | reconnect? |
|---|---|---|---|
| `4001` | core/gateway | ไม่ส่ง `hello` ใน 10 วินาที | ได้ |
| `4426` | core (ผ่าน gateway ได้) | `hello.client.api` ต่ำกว่า `minClientApi` **[api 1]** | **ไม่** — แสดง "กรุณาอัปเดตแอป" |
| `4003` | core/gateway | token ผิด / หมดอายุ / ออกจากระบบ | **ไม่** — กลับหน้าล็อกอิน |
| `4029` | core/gateway | ถูก rate limit | รอ ≥15 นาที |
| `4502` | gateway | core ปฏิเสธ token ของ gateway (ตั้งค่าฝั่ง admin) | ได้ แบบ backoff |
| `1013` | gateway | ต่อ core ไม่ได้ | ได้ แบบ backoff |
| `1008` | gateway | ส่งเกิน 200 frame ก่อน core ตอบ | ได้ (และแก้ client) |
| `1009` | core/gateway | frame ใหญ่เกิน 4 MB | แก้ client |
| `1005`/`1006` | เครือข่าย | หลุดเฉย ๆ | ได้ |

## 8. ค่าหน้าจอที่ใช้ร่วมกัน (`ui`)

`{"type":"ui-set","values":{"<key>":"<string>"|null}}` เก็บค่า string ที่ทุกอุปกรณ์ของบัญชีเห็น (`server.ts:1736-1744`)
ได้กลับใน `welcome.ui` และ frame `ui` ไปที่ **อุปกรณ์อื่น** (ตัวที่ตั้งไม่ได้รับ)
key ที่เว็บใช้ (`app.js:30-37`): `mimi.setupDone`, `mimi.chatSound`, `mimi.notifySound`, `mimi.autoSpeak`, `mimi.lang`,
`mimi.theme`, `mimi.textSize`, `mimi.chat.<chatId>.(textSize|bubbles|character|theme|background|backgroundRules)`,
`mimi.(view|bubbles|character|nodePreset).*` — แอป native ควรอ่าน/เขียน key ชุดเดียวกันเพื่อให้ตรงกับเว็บ
(ค่าภายในเป็นรูปแบบที่เว็บกำหนดเอง ไม่ได้อยู่ใน `protocol.ts` — G-UI-1)
