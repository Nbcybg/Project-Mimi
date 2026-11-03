# Server gaps: สิ่งที่เซิร์ฟเวอร์ต้องเพิ่ม/แก้เพื่อรองรับแอป native

> Phase 0 ไม่แก้โค้ดเซิร์ฟเวอร์ ไฟล์นี้คือรายการงานของ Phase 1 — **Phase 1 ทำแล้ว (Unreleased, client API 1)**: สถานะของแต่ละข้ออยู่ในตารางและใต้หัวข้อ
> **ความสำคัญ**: P1 = ต้องมีก่อนปล่อยแอปแรก, P2 = ต้องมีก่อนปล่อยครบทุกแพลตฟอร์ม, P3 = ทำเมื่อสะดวก
> **ขนาด**: S ≤ 1 วัน, M 2–5 วัน, L > 1 สัปดาห์ (รวมเทสต์)
> แต่ละข้อยืนยันจากโค้ด (และทดสอบกับเซิร์ฟเวอร์ในเครื่องเมื่อเขียนว่า "ทดสอบแล้ว")

## สรุป

| id | เรื่อง | P | ขนาด | สถานะ (Phase 1) |
|---|---|---|---|---|
| G-VER-1 | ไม่มีการเช็กเวอร์ชัน client/server | P1 | S | **แก้แล้ว** (api 1) |
| G-CHAT-1 | ข้อความ assistant ไม่มาเป็น `chat-message` ต้อง `chat-open` ใหม่ทุก turn | P1 | M | **แก้แล้ว** (`chat-turn-messages` + `chat-open.afterId`) |
| G-MEDIA-1 | Mimiamp ผ่าน gateway: `/mimiamp/*` ไม่ถึง core, YouTube 404 | P1 | M | **แก้แล้ว** (gateway ส่งต่อเมื่อมี Bearer; เว็บโหลดผ่าน token) |
| G-MEDIA-2 | `/api/files/:id` และ `/api/mimiamp/youtube/:id/audio` ไม่รองรับ Range | P1 | S | **แก้แล้ว** |
| G-PUSH-1 | ไม่มี endpoint ลงทะเบียน push token ของ native (FCM/APNs/WNS) | P1 | M | **แก้แล้ว** (FCM/APNs; WNS เหลือ) |
| G-PUSH-2 | ไม่มีตัวส่ง FCM / APNs / WNS และที่เก็บกุญแจ | P1 (iOS) | L | **แก้บางส่วน**: ตัวส่ง FCM + APNs เสร็จ; WNS และ relay ที่ gateway เหลือ |
| G-PUSH-3 | `/api/notifications` ใช้ cursor เป็นเวลาและได้เฉพาะยังไม่อ่าน | P2 | S | **แก้แล้ว** |
| G-WS-1 | ไม่มี `reqId` กลางสำหรับจับคู่คำขอ/คำตอบ | P2 | M | **เหลือ** |
| G-WS-2 | `error` ไม่บอกว่าเป็นของคำขอไหน; unknown type ได้ `E-INTERNAL` | P2 | S | **แก้แล้ว** (`requestType`, `E-PROTOCOL`) |
| G-AUTH-1 | โหมด core: token เดียวทุกอุปกรณ์ ไม่มี logout/ถอนรายเครื่อง | P2 | M–L | **เหลือ** (รอ Q2) |
| G-OAUTH-1 | OAuth บน core ในคอมพิวเตอร์ทำจากมือถือไม่ได้ | P3 | M | **เหลือ** |
| G-REST-1 | คำสั่งจาก notification action ต้องเปิด WS | P2 | S | **แก้แล้ว** |
| G-CHAT-2 | `agent` ของข้อความ user ไม่ตรงกันระหว่าง echo กับ history | P3 | S | **เหลือ** |
| G-CHAT-3 | `LiveTurnView.speech` ไม่เคยถูกตั้ง | P3 | S | **เหลือ** |
| G-TYPES-1 | ชนิดข้อมูล Mimiamp / widget / notifications sync ไม่อยู่ใน `@mimi/shared` | P1 | S | **แก้บางส่วน**: Mimiamp/widget/notifications ย้ายแล้ว; JSON Schema เหลือ |
| G-UI-1 | ค่า `ui` key เป็นรูปแบบของเว็บ ไม่มีสเปก | P2 | S | **เหลือ** |
| G-UI-2 | รายการฉากสำเร็จรูป hard-code ใน client | P2 | S | **เหลือ** |
| G-LOGIC-1 | logic ที่ทำฝั่ง client เท่านั้น (ต้องทำซ้ำในทุกแอป หรือย้ายมาเซิร์ฟเวอร์) | P2 | M | **เหลือ** |
| G-WIDGET-1 | `/api/widget?since=` ถูกรับแต่ไม่ได้ใช้ | P3 | S | **เหลือ** |
| G-SRV-1 | ตอนเลิกเสิร์ฟเว็บ ต้องเก็บ asset ที่แอป native ยังใช้ | P3 | S | **แก้บางส่วน**: `MIMI_SERVE_WEB=0` แยก UI ออกจาก asset แล้ว; การลบ UI จริงอยู่ Phase 7 |

---

## G-VER-1 — เช็กเวอร์ชัน client/server (P1, S)

**สถานะ: แก้แล้ว** — `API_VERSION`/`MIN_CLIENT_API` ใน `protocol.ts`, `/health` + `welcome` มี `api`/`minClientApi`/`version`, header `x-mimi-api` ทุกคำตอบ (core + gateway), `hello.client`, close `4426`; นโยบายใน `api-versioning.md` · test: `native-clients.test.ts`

**ปัจจุบัน:** `/health` ตอบแค่ `{ok, version}` (`server.ts:2291-2294`); `welcome` ไม่มีเวอร์ชัน (`server.ts:2351-2361`);
`hello.name` ไม่ได้ใช้ ไม่มีเลขเวอร์ชันของโปรโตคอล เมื่อเซิร์ฟเวอร์เปลี่ยน shape แอปเก่าที่ติดตั้งค้างอยู่จะพังเงียบ ๆ
(เว็บไม่มีปัญหานี้เพราะเซิร์ฟเวอร์เสิร์ฟ UI เวอร์ชันเดียวกันเสมอ)

**เสนอ:**
- `/health` และ `welcome` เพิ่ม `apiVersion` (จำนวนเต็ม เพิ่มเมื่อเปลี่ยนแบบไม่ backward-compatible) และ `minClientApi`
- `hello` เพิ่ม `client: {platform: 'android'|'ios'|'macos'|'windows', version: '1.2.0', api: 1}`
- client เก่ากว่า `minClientApi` → close code ใหม่ (เช่น `4426 "update the app"`) แอปแสดงให้อัปเดต

## G-CHAT-1 — ข้อความ assistant ที่จบแล้ว (P1, M)

**สถานะ: แก้แล้ว (ทั้งสองทาง)** — frame `chat-turn-messages` ก่อน `busy done` และ `chat-open {afterId}` (≤200 ต่อหน้า) เว็บเดิมไม่รู้จัก frame ใหม่จึงข้ามไป (ยังทำงานแบบเดิม) · test: `native-clients.test.ts`

**ปัจจุบัน:** ระหว่าง turn เซิร์ฟเวอร์ส่ง `chat-message` เฉพาะข้อความ user (`chat-api.ts:232-249`); ข้อความ assistant มีแค่ใน
`run-finish.text` ซึ่ง **ไม่มี message id** เว็บจึง `chat-open` ใหม่ทุกครั้งที่ `busy done` (`app.js:5333-5339`) ได้ 40 ข้อความทั้งหน้า
(ทดสอบแล้ว: ไม่มี `chat-message` ของ assistant ในบันทึก) บนมือถือเปลืองข้อมูลและทำให้ต้องเขียน merge เอง

**เสนอ (เลือกหนึ่ง):**
- ส่ง `chat-message` ของ assistant (role `assistant`, มี `id`, `speech`, `tools`, `attachments`) หลังข้อความถูกเก็บในแต่ละขั้น — คู่กับ `run-finish`
- หรือ `chat-open` รับ `afterId` แล้วคืนเฉพาะข้อความที่ใหม่กว่า (ใช้ตอน reconnect ด้วย)

## G-MEDIA-1 — Mimiamp ผ่าน gateway (P1, M)

**สถานะ: แก้แล้ว** — gateway ส่ง `GET/HEAD /mimiamp/*` ที่มี Bearer ไป core ของคนนั้น (token ผิด = 401); ไม่มี Bearer = ไฟล์ของ gateway เหมือนเดิม เว็บในโหมด gateway โหลดเพลงในโฟลเดอร์ผ่าน `api()` + blob แล้ว (`feature-mimiamp.js` `gatewayFileUrl`) เพราะเพลงย้ายไป volume ของ core · image ไม่ copy `mimiamp/` แล้ว, อัปโหลดด้วย `POST /api/mimiamp/files` · test: `native-clients.test.ts`

**ปัจจุบัน:**
- gateway เรียก `serveWebFile(url.pathname, response, request.headers.range)` **โดยไม่มี MimiampService** (`gateway.ts:207`)
  `/mimiamp/tracks.json` และ `/mimiamp/<file>` จึงมาจากโฟลเดอร์ของ gateway ไม่ใช่ของ core (ทดสอบแล้ว: ตอบ 200 จาก gateway เอง)
  เพลงใน `<user>/mimiamp` ของผู้ใช้ (`library.ts:73-93`) เข้าไม่ถึง
- `/mimiamp/youtube/<id>.audio` ผ่าน gateway ได้ `404` เสมอ (`web-files.ts:202-214`, ทดสอบแล้ว) ขณะที่ `prepare` คืน `url` ชี้ไปที่ path นี้
  (`http-api.ts:178`) และ `MimiampTrack.url` ของ YouTube ก็เป็น path นี้ (`service.ts:143`)
- เว็บหลบด้วยการดาวน์โหลด `/api/mimiamp/youtube/<id>/audio` ทั้งไฟล์ (`feature-mimiamp.js:750-757`)

**เสนอ:** ให้ gateway ส่ง `/mimiamp/*` ต่อไป core ของผู้ใช้เมื่อมี Bearer (แบบ `/api/*`) หรือย้ายเพลงทั้งหมดไปอยู่ใต้ `/api/mimiamp/audio/<trackId>`
ที่ต้องใช้ token และรองรับ Range แล้วให้ `track.url` ชี้ไปที่นั่น — แนวหลังสอดคล้องกับเป้าหมาย "เซิร์ฟเวอร์ไม่เสิร์ฟ UI" มากกว่า

## G-MEDIA-2 — Range ของไฟล์ (P1, S)

**สถานะ: แก้แล้ว** — ทั้งสองเส้นใช้ `serveFileRange` (stream จากไฟล์, 206/416) `/api/files` ยังคง CSP sandbox และ octet-stream สำหรับชนิดที่ไม่แสดงในที่ · test: `native-clients.test.ts`

**ปัจจุบัน:** `sendBytes` อ่านไฟล์ทั้งก้อนแล้วตอบ 200 (`http-api.ts:103-117`) ใช้กับ `/api/files/:id` (`:404-408`) และ
`/api/mimiamp/youtube/:id/audio` (`:181-187`) AVPlayer เล่นวิดีโอ/เสียงจาก URL ที่ไม่รองรับ byte-range ไม่ได้ ExoPlayer เลื่อนตำแหน่งไม่ได้
และไฟล์ใหญ่ถูกโหลดเข้าหน่วยความจำเซิร์ฟเวอร์ทั้งไฟล์

**เสนอ:** ใช้ `serveAudioFile` (มี Range อยู่แล้ว: `web-files.ts:138-188`) กับสองเส้นนี้ (stream จากไฟล์ ไม่อ่านเข้า memory)

## G-PUSH-1 / G-PUSH-2 — push ของ native (P1, M + L)

**สถานะ: แก้บางส่วน** — ทำแล้ว: `native-push-register/unregister` + `POST /api/push/register|unregister`, ตาราง `native_push_tokens`, ตัวส่ง FCM HTTP v1 และ APNs (`notify/native-push.ts`), ลบ token ที่ตาย, payload แบบ `minimal` เป็นค่าเริ่มต้น (`MIMI_NATIVE_PUSH_CONTENT=full` ได้) · **เหลือ**: WNS, relay ผ่าน gateway (Q3), ทดสอบกับ Google/Apple จริง (ทดสอบแล้วเฉพาะบริการจำลองในเครื่อง)

**ปัจจุบัน:** `push-subscribe` รับเฉพาะ Web Push subscription (`endpoint` https + `p256dh` + `auth`: `notifications.ts:157-172`, `server.ts:1765-1771`)
และส่งด้วย VAPID เท่านั้น (`notifications.ts:186-191`) แอป Android เดิม poll ทุก 30 วินาทีแทน (`PushService.java`) — iOS ทำแบบนี้ไม่ได้

**เสนอ:** ดูรายละเอียดใน `push-and-background.md` ข้อ 3 — คำสั่ง `native-push-register/unregister`, ตาราง/คอลัมน์ `platform`,
ตัวส่ง FCM HTTP v1 / APNs (HTTP/2 + .p8) / WNS, ลบ token ที่ตาย, และตัดสินใจเรื่องที่เก็บกุญแจ (relay ที่ gateway)

## G-PUSH-3 — cursor ของ `/api/notifications` (P2, S)

**สถานะ: แก้แล้ว** — `?afterId=` ได้ทั้งอ่านแล้ว/ยังไม่อ่าน พร้อม `read` ≤100 รายการ เก่าสุดก่อน; ไม่มี `afterId` = พฤติกรรมเดิม (แอป Android เดิมไม่พัง)

**ปัจจุบัน:** ได้เฉพาะ `!item.read` สูงสุด 30 รายการ กรองด้วย `createdAt > since` (`server.ts:2190-2197`) แอปจึงต้องจำ id เอง
(`WidgetSync.java:308-322`) และไม่รู้ว่ารายการไหนถูกอ่านบนอุปกรณ์อื่นแล้ว (ลบ notification ที่ค้างไม่ได้)

**เสนอ:** `?afterId=<id>` + field `read` + `unread` รวม ในคำตอบ

## G-WS-1 — `reqId` กลาง (P2, M)

**สถานะ: เหลือ** (P2)

**ปัจจุบัน:** คำตอบจับคู่ด้วย `type` มีแค่บางคำสั่งที่มี `reqId` (`protocol.ts:758, 764, 774, 776, 836, 851`) คำสั่งที่ตอบด้วย broadcast
(เช่น `agent-save` → `agents`) แยกไม่ออกว่าเป็นผลของคำขอนี้หรือของอุปกรณ์อื่น หลายคำสั่งไม่มีคำตอบเลยเมื่อสำเร็จ (`abort`, `status-set`, `approval-decide`, `ui-set`)
UI native ที่ต้องแสดง "กำลังบันทึก… / บันทึกแล้ว" ทำได้ยาก

**เสนอ:** client ใส่ `reqId` (string) ในคำสั่งใดก็ได้ เซิร์ฟเวอร์ใส่ `reqId` เดิมกลับใน reply และใน `error` และตอบ `{"type":"ack","reqId"}` สำหรับคำสั่งที่ไม่มีคำตอบ
backward-compatible (เว็บเดิมไม่ส่ง reqId ก็ทำงานเหมือนเดิม)

## G-WS-2 — error ของ WS (P2, S)

**สถานะ: แก้แล้ว** — `error.requestType` ทุกครั้งที่ error ตอบคำสั่ง, คำสั่งที่ไม่รู้จัก = `E-PROTOCOL` (เพิ่มใน `errors.ts` และ `docs/error-codes.md`); `reqId` รอ G-WS-1

**ปัจจุบัน:** `error` มีแค่ `message`, `code`, และ `clientId` เฉพาะ `chat-send` (`server.ts:2373-2378`) ข้อความเป็นภาษาอังกฤษจาก exception
คำสั่งที่ไม่รู้จักได้ `"Unknown message type"` + `E-INTERNAL` (ทดสอบแล้ว) ซึ่งควรเป็นโค้ดเฉพาะ (เช่น `E-PROTOCOL`) เพื่อให้แอปเก่ารู้ว่าเซิร์ฟเวอร์ไม่รองรับคำสั่ง
**เสนอ:** ใส่ `reqId` (G-WS-1), `requestType` (type ของคำสั่งที่ล้ม), โค้ด `E-PROTOCOL` สำหรับคำสั่ง/รูปแบบที่ไม่รู้จัก

## G-AUTH-1 — โหมด core คนเดียว (P2, M–L)

**สถานะ: เหลือ** — รอคำตอบ Q2

**ปัจจุบัน:** ทุกอุปกรณ์ใช้ `MIMI_TOKEN` เดียวกัน (`server.ts:2138, 2333`) ทำหาย = ต้องเปลี่ยน token ของเซิร์ฟเวอร์และล็อกอินใหม่ทุกเครื่อง
ไม่มี `expiresAt` ไม่มี logout ฝั่งเซิร์ฟเวอร์ ไม่มี `security-alert` แอป native เก็บ token ระดับ "กุญแจของเซิร์ฟเวอร์" ไว้บนมือถือ
**เสนอ (เลือก):** (ก) แนะนำให้ทุกคนใช้ gateway แม้คนเดียว, (ข) ให้ core ออก device token ของตัวเอง (`POST /auth/device` ด้วย MIMI_TOKEN แล้วได้ token รายเครื่องที่ถอนได้) — คำถาม Q2

## G-OAUTH-1 — OAuth บนคอมพิวเตอร์ (P3, M)

**สถานะ: เหลือ**

core ที่ไม่มี `MIMI_PUBLIC_URL` ใช้ port ชั่วคราวบนเครื่องนั้นเป็น redirect (`server.ts:504-506`) → เปิดลิงก์บนมือถือแล้ว redirect กลับไม่ถึง
แก้ได้ด้วยการใช้ tunnel URL (`settings.tunnel.url`) เป็น redirect เมื่อ tunnel เปิด หรือบอกผู้ใช้ให้ทำบนคอมพิวเตอร์ (พฤติกรรมปัจจุบัน)

## G-REST-1 — คำสั่งจาก notification action (P2, S)

**สถานะ: แก้แล้ว** — `POST /api/permissions/<requestId>` และ `POST /api/approvals/<id>` (404 เมื่อไม่รออยู่แล้ว) · WS `permission-response` ใช้ฟังก์ชันเดียวกัน

ปุ่ม "อนุญาต" / "อนุมัติ" บน notification (Android action, iOS `UNNotificationAction`) ทำงานตอนแอปไม่ได้เปิด WS
ปัจจุบันต้องเปิด WS → hello → `permission-response` / `approval-decide` → ปิด **เสนอ:** `POST /api/permissions/<requestId>` `{allow, scope}`
และ `POST /api/approvals/<id>` `{approved, note?}` (เรียก `broker.respond` / `core.approvals.decide` เดิม: `server.ts:1183-1198, 1904-1908`)

## G-CHAT-2 — `agent` ของข้อความ user (P3, S)

**สถานะ: เหลือ** — ไม่แก้ใน Phase 1 เพราะ `confirmEcho` ของเว็บเทียบข้อความ echo อยู่

echo ระหว่าง turn ใส่ `agent: ""` (`chat-api.ts:240`) แต่ `chat-history` ได้ชื่อ agent ของแชต (ทดสอบแล้ว: `"agent":"mimi"`)
**เสนอ:** ให้ตรงกัน (น่าจะเป็น `""` สำหรับ user)

## G-CHAT-3 — `LiveTurnView.speech` (P3, S)

**สถานะ: เหลือ**

`liveTurns` มี field `speech` (`server.ts:935`) แต่ `liveEvent` ไม่เคยตั้งค่า (`server.ts:965-1018`) client ที่เปิดแชตกลาง turn ไม่รู้ป้ายเสียงจนจบ
**เสนอ:** ส่ง event ใหม่ (เช่น `speech`) เมื่อ agent-loop parse บรรทัดกำกับเสียงได้ (`agent-loop.ts:504-509`) และเก็บลง live

## G-TYPES-1 — ชนิดข้อมูลที่อยู่นอก `@mimi/shared` (P1, S)

**สถานะ: แก้บางส่วน** — ชนิดย้ายไป `packages/shared/src/mimiamp.ts` แล้ว (core re-export ชื่อเดิม) · JSON Schema สำหรับ generate model ยังไม่ทำ

`MimiampTrack`, `MimiampPlaylist`, `MimiampStateView`, `YoutubeSearchReply` อยู่ใน `packages/core/src/mimiamp/*` และคำตอบของ
`/api/widget`, `/api/notifications` เป็น `unknown` ใน `HttpApiDeps` (`http-api.ts:56-58`) — ไม่อยู่ในสัญญาที่ทีม native ใช้ generate model ได้
**เสนอ:** ย้ายชนิดเหล่านี้ไป `packages/shared/src/` และ (P2) generate JSON Schema จาก `protocol.ts` เพื่อสร้าง model ของ Kotlin/Swift/C#

## G-UI-1 — `ui` key (P2, S)

**สถานะ: เหลือ**

`ui-set` รับ key/value อะไรก็ได้ที่เป็น string (`app-settings.ts:257-272`) ความหมายของ key กำหนดในเว็บ (`app.js:30-37`) ค่าภายในบางตัวเป็น JSON ของเว็บ
**เสนอ:** เขียนสเปก key ที่ใช้ร่วม (ภาษา, ธีม, ขนาดตัวอักษร, เสียง, auto-speak, ค่าต่อแชต) ลง `protocol.ts` และแยก namespace `native.*` สำหรับค่าที่เว็บไม่ใช้

## G-UI-2 — ฉากสำเร็จรูป (P2, S)

**สถานะ: เหลือ**

11 ฉากอยู่ในตัวแปร `PRESETS` ของเว็บ (`feature-backgrounds.js:20-31`) ไฟล์เสิร์ฟที่ `/backgrounds/*.webp`
**เสนอ:** ให้ `backgrounds` frame มี `presets: [{id, name, url}]`

## G-LOGIC-1 — logic ที่อยู่ฝั่ง client เท่านั้น (P2, M)

**สถานะ: เหลือ**

ต้องเขียนซ้ำในทุกแอป native (4 ภาษา) ถ้าไม่ย้ายมาเซิร์ฟเวอร์:

| logic | ที่อยู่ในเว็บ | เสนอ |
|---|---|---|
| หาเพลงจากคำสั่ง `mimiamp play {query}` (ตรงทุกตัว → มีคำนี้ → โหลดใหม่ → หาในคลัง) | `feature-mimiamp.js:2287-2333` | เซิร์ฟเวอร์ resolve แล้วส่ง `trackId` มาใน command (มี `findTrack` อยู่แล้ว: `service.ts:164-170`) |
| แปลงเสียงเป็น WAV ก่อนส่ง | `feature-voice.js:64-140` | เซิร์ฟเวอร์รับ m4a/aac/opus แล้วแปลงเอง (ffmpeg) — ทำให้ native ใช้ encoder ของระบบได้ |
| ทำ thumbnail ของแกลเลอรี | `POST /api/gallery/:agent/:id/thumb` จาก client (`http-api.ts:496-525`) | เซิร์ฟเวอร์ทำ thumbnail เอง (sharp) |
| parse บรรทัดกำกับเสียงซ้ำ | `app.js:201-230` | ไม่จำเป็นแล้วถ้า G-CHAT-3 เสร็จ (เซิร์ฟเวอร์ตัดใน delta อยู่แล้ว) |
| เลือกรูปตัวละครจาก emoji (`SPRITE_KEY`) | `feature-stage.js:1-12` | คงไว้ฝั่ง client ได้ แต่ต้องเขียนกติกาลงสเปก |
| จัดรูปแบบข้อความ (inline formatting) | `app.js:436-524` | คงไว้ (เป็นเรื่องการแสดงผล) — สเปกอยู่ใน `api-contract.md` B.2 |

## G-WIDGET-1 — `since` ของ widget (P3, S)

**สถานะ: เหลือ**

`widgetChats: (_since) => …` (`server.ts:2151`) รับแต่ไม่ใช้ แอป Android เดิมส่งมา (`WidgetSync.java:79-81`) — ลบพารามิเตอร์จากสเปก หรือทำให้ใช้ได้

## G-SRV-1 — ตอนเลิกเสิร์ฟเว็บ (P3, S)

**สถานะ: แก้บางส่วน** — `MIMI_SERVE_WEB=0` (core และ gateway) ปิดหน้าเว็บ/สคริปต์/`/sounds`/`/vendor` แต่ยังเสิร์ฟ `/mimiamp/*`, `/backgrounds/*`, ไอคอน, `/health` · การลบ UI ออกจริงคือ Phase 7

`serveWebFile` (`web-files.ts:239-290`) เสิร์ฟทั้ง UI และ asset ที่แอป native ยังต้องใช้: `/mimiamp/*` (ถ้าไม่ทำ G-MEDIA-1 แบบย้าย),
`/backgrounds/*.webp`, ไอคอน, `/health` ตอนลบ UI ต้องแยกสองส่วนนี้ออกจากกัน และ `/sounds/*` ให้แอป bundle เองแทน

---

## ความไม่สอดคล้องระหว่าง `protocol.ts` กับโค้ด

| เรื่อง | `protocol.ts` | โค้ดจริง |
|---|---|---|
| `LiveTurnView.speech` | มี (`:142`) | ไม่เคยถูกตั้ง (G-CHAT-3) |
| `ClientMessage.hello.name` | มี (`:712`) | ไม่ได้ใช้สำหรับ client |
| `run-finish` | ไม่มี `agent` (`events.ts:52-68`) | เว็บอ่าน `event.agent` แล้ว fallback (`app.js:1655`) — agent อยู่ใน `chat-event.agent` |
| `ChatMessageView.agent` ของ user | ไม่ระบุ | `""` ใน echo, ชื่อ agent ใน history (G-CHAT-2) |
| `security-alert` | อยู่ใน `ServerMessage` (`:1110`) | core ไม่ส่ง มีแต่ gateway (`gateway.ts:171-176`) |
| คำตอบ HTTP ของ widget / notifications / mimiamp | ไม่มีชนิด | ดู G-TYPES-1 |
| `prepare` ของ YouTube | – | คืน `url` ที่ใช้ไม่ได้ผ่าน gateway (G-MEDIA-1) |
