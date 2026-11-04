# Push notification และงานเบื้องหลัง

## 1. ระบบเดิมทำงานอย่างไร

### 1.1 Notification บนเซิร์ฟเวอร์

ทุกอย่างที่ควรแจ้งผู้ใช้เข้า **inbox** ในฐานข้อมูลของ core ก่อน (`packages/core/src/notify/notifications.ts`) แล้วจึงตัดสินว่าจะ push ไหม

| `kind` | เกิดเมื่อ |
|---|---|
| `reminder` | trigger แบบเตือนความจำถึงเวลา |
| `task-result` | agent task ตามเวลาทำเสร็จ |
| `approval` | workflow ขออนุมัติ หรือเครื่องมือขออนุญาตในแชตที่ผู้ใช้ไม่ได้ดูอยู่ (`server.ts:952-959`) |
| `message` | agent ตอบในแชตที่ผู้ใช้ไม่ได้ดูอยู่ หรือเรียก `notify_user` (`server.ts:864-872`) |
| `info` | ข้อความสั้นในแชต (ไม่ push) |

"ไม่ได้ดูอยู่" = ไม่มี socket ใดส่ง `presence {chatId, visible:true}` ของแชตนั้น (ดู `realtime.md` ข้อ 7.2)

**กติกา push** (`notifications.ts:99-122`):
- push เฉพาะ `kind` ใน `preferences.pushKinds` (ค่าเริ่มต้น `reminder`, `task-result`, `approval`, `message`: `notifications.ts:7`)
- agent ใน `preferences.mutedAgents` ไม่ push
- ช่วง `quietFrom`–`quietTo` (เวลาตาม timezone ของ core ข้ามเที่ยงคืนได้) ไม่ push ยกเว้น `approval` เมื่อ `urgentApprovals !== false`
- `urgency`: `high` สำหรับ approval/reminder, `normal` อย่างอื่น (`notifications.ts:193`)

payload ที่ push (`notifications.ts:192`):

```json
{"id":12,"kind":"message","title":"มิมิ","body":"ข้อความ… (≤1000 ตัว)","chatId":1}
```

### 1.2 ช่องทางที่มีอยู่ตอนนี้

| ช่องทาง | ใช้กับ | ข้อจำกัด |
|---|---|---|
| **Web Push** (VAPID, RFC 8291/8292 เขียนเอง ไม่ใช้ library: `packages/core/src/notify/web-push.ts`) | browser / PWA ผ่าน service worker | ต้องมี `PushSubscription` ของ browser (`endpoint` https + `p256dh` + `auth`: `notifications.ts:157-172`) — **แอป native ไม่มีสิ่งนี้** |
| frame `notification` ทาง WS | แอปที่เปิดอยู่ | หายเมื่อไม่มี socket |
| `GET /api/notifications` (poll) | แอป Android เดิม | ต้อง poll; ได้เฉพาะที่ยังไม่อ่าน ≤30 รายการ |
| `GET /api/widget` (poll) | widget Android | เฉพาะจำนวนคำตอบที่ยังไม่อ่าน |

แอป Android เดิม (WebView รับ Web Push ไม่ได้: `android/README.md`) จึงใช้:
- foreground service ที่ poll `/api/notifications` ทุก **30 วินาที** และแสดง notification ถาวร "เชื่อมต่ออยู่"
  (`android/app/src/main/java/app/mimi/android/PushService.java:14-71`)
- `JobScheduler` ทุก ~15 นาทีเป็นตัวสำรอง (`SyncJob.java`) และ refresh widget
- จำ id ล่าสุดที่เห็น การดูครั้งแรกไม่แจ้ง (กันแจ้งของเก่า) (`WidgetSync.java:305-329`)

## 2. สิ่งที่ native ควรใช้แทน

| แพลตฟอร์ม | ช่องทางหลัก | ต้องมีฝั่งเซิร์ฟเวอร์ | ระหว่างรอ |
|---|---|---|---|
| Android | **FCM** (Firebase Cloud Messaging) data/notification message | ส่งผ่าน FCM HTTP v1 (`https://fcm.googleapis.com/v1/projects/<id>/messages:send`) ด้วย service account (OAuth2 JWT) | poll `/api/notifications` ด้วย WorkManager (ขั้นต่ำ 15 นาที) + foreground service แบบเดิมถ้าผู้ใช้เปิด "แจ้งเตือนทันที" |
| iOS | **APNs** (alert push; `mutable-content` ถ้าจะใส่รูป) | HTTP/2 ไป `api.push.apple.com` ด้วย token-based auth (.p8 key, Team ID, Key ID, bundle id) | iOS ไม่อนุญาต poll ต่อเนื่อง: `BGAppRefreshTask` ไม่รับประกันเวลา — **ไม่มีทางแจ้งเตือนตรงเวลาโดยไม่มี APNs** |
| macOS | APNs (แอปเดียวกับ iOS ได้ถ้าใช้ bundle id / key เดียวกัน) | เหมือน iOS | แอปเปิดค้าง (menu bar) ฟัง WS ได้ |
| Windows | **WNS** ผ่าน Windows App SDK `PushNotificationManager` | ต้องลงทะเบียน Azure AD app + ส่งไป channel URI | แอปอยู่ใน tray ฟัง WS + `AppNotificationManager` แสดง toast |

ทางเลือกที่ไม่ต้องพึ่ง Google บน Android: **UnifiedPush** (ผู้ใช้ติดตั้ง distributor เช่น ntfy) — endpoint ของ UnifiedPush รับ
Web Push (RFC 8030/8291) ได้ จึงใช้ `push-subscribe` เดิมได้เกือบทั้งหมด แต่ผู้ใช้ทั่วไปต้องติดตั้งแอปเพิ่ม (คำถาม Q3)

### 2.1 ความปลอดภัยของ payload

payload ปัจจุบันมี `title`/`body` เต็ม (ข้อความของ agent) — Web Push เข้ารหัส end-to-end แต่ FCM/APNs **ไม่เข้ารหัส payload จากผู้ให้บริการ**
(Google/Apple เห็นข้อความ) ทางเลือก:

1. ส่งแค่ `{id, kind, chatId}` แล้วให้แอปดึงเนื้อหาด้วย `/api/notifications` (iOS ใช้ Notification Service Extension ดึงก่อนแสดง)
2. ส่งเนื้อหาเข้ารหัสด้วยกุญแจที่แอปสร้างและลงทะเบียนตอน subscribe (แบบเดียวกับ Web Push `p256dh`/`auth`) แล้วถอดใน extension

ข้อเสนอ: แบบ 1 ก่อน (ง่าย, รั่วน้อยสุด) — คำถาม Q4

### 2.2 สิ่งที่ push มีให้ [api 1]

core ส่ง push ไปแอป native ตามกติกาเดียวกับ Web Push (kind, ปิดเสียง agent, ช่วงเงียบ: ข้อ 1.1) ตั้งค่าด้วย env ใน `docs/hosting.md`
"แอป native: ตัวแปรเพิ่มเติม" — โค้ด `packages/core/src/notify/native-push.ts`

**FCM (Android)** — เป็น *data message* เสมอ (แอปสร้าง notification เอง ได้ทั้งตอนแอปปิด) `android.priority` = `HIGH` สำหรับ approval/reminder:

```json
{"message":{"token":"<FCM token>","android":{"priority":"HIGH"},
 "data":{"id":"12","kind":"message","chatId":"3","unread":"2","title":"Mimi","body":"มีข้อความใหม่","content":"minimal"}}}
```

ค่าใน `data` เป็น string ทั้งหมด (`chatId` ว่าง = ไม่มีแชต) — `content: "minimal"` (ค่าเริ่มต้น) = `title`/`body` เป็นข้อความกลาง ๆ ตาม kind
(`เตือนความจำ`, `งานเสร็จแล้ว`, `มีเรื่องรออนุมัติ`, `มีข้อความใหม่`) แอปควรดึงข้อความจริงจาก `GET /api/notifications?afterId=<id-1>` ก่อนแสดง;
`content: "full"` (`MIMI_NATIVE_PUSH_CONTENT=full`) = มีหัวข้อและเนื้อหาจริง (≤1000 ตัว)

**APNs (iOS / macOS)** — alert push, `apns-priority` 10 (approval/reminder) หรือ 5, topic = `bundleId` ที่ลงทะเบียน หรือ `MIMI_APNS_TOPIC`:

```json
{"aps":{"alert":{"title":"Mimi","body":"มีข้อความใหม่"},"sound":"default","badge":2,"mutable-content":1,"thread-id":"chat-3"},
 "id":12,"kind":"message","chatId":3,"content":"minimal"}
```

`mutable-content: 1` ให้ Notification Service Extension ของแอปดึงข้อความจริงก่อนแสดง · `badge` = จำนวน notification ที่ยังไม่อ่านทั้งหมด
· `thread-id` จัดกลุ่มตามแชต · `sandbox: true` ตอนลงทะเบียน = ส่งไป `api.sandbox.push.apple.com`

**token ที่ตาย** (FCM `404`/`UNREGISTERED`, APNs `410` / `BadDeviceToken` / `Unregistered`) ถูกลบเอง; ล้ม 20 ครั้งติดต่อกันก็ถูกลบ
เหมือน Web Push

## 3. สิ่งที่เซิร์ฟเวอร์เพิ่มแล้ว / ยังเหลือ

| เรื่อง | สถานะ |
|---|---|
| ลงทะเบียน token (`native-push-register/unregister`, `POST /api/push/register` / `unregister`) — `api-contract.md` A.6.1 | **แก้แล้ว** (api 1) ตาราง `native_push_tokens` (migration 024), `push-devices` แสดงรวมกับ Web Push |
| ตัวส่ง FCM HTTP v1 (service account JWT → access token, cache) และ APNs (HTTP/2, ES256 provider token, cache 50 นาที) | **แก้แล้ว** ทดสอบกับบริการจำลองในเครื่อง (ยังไม่ได้ทดสอบกับ Google/Apple จริง) |
| cursor `GET /api/notifications?afterId=` (ได้ทั้งอ่านแล้ว/ยังไม่อ่าน) | **แก้แล้ว** |
| badge (`unread`) | **แก้แล้ว** (APNs `badge`, FCM `data.unread`) |
| ตอบ permission/approval จากปุ่มบน notification ผ่าน HTTP | **แก้แล้ว** (`api-contract.md` A.6.2) |
| WNS (Windows) | **แก้แล้ว** (api 2): raw push `{id, kind, chatId, unread, title, body, content}` ไป channel URI ด้วย token ของ Entra ID app (`MIMI_WNS_*`) · แอป Windows ดึงข้อความเองแล้วแสดง toast · ยังไม่ได้ทดสอบกับ WNS จริง · แอปแบบ self-contained ต้องมี Singleton package ของ Windows App Runtime ในเครื่อง ไม่งั้น `IsSupported()` = false และใช้ socket แบบเดิม |
| relay ผ่าน gateway (กุญแจอยู่ที่เดียว) | **แก้แล้ว** (Q3): core ตั้ง `MIMI_PUSH_RELAY_URL` → `POST /push/relay` ของ gateway ด้วย core token ของตัวเอง ได้คำตอบของบริการ push กลับ (token ที่ตายก็ถูกลบที่ core) · กุญแจของ core เองถ้ามีใช้ก่อน |
| เข้ารหัสเนื้อหาเอง (แบบ Web Push) | **ไม่ทำ** — ใช้ `minimal` + แอปดึงข้อความเองแทน (ตามข้อเสนอ Q4) |

## 4. งานเบื้องหลังของแอป (ไม่ใช่ push)

| งาน | Android | iOS | หมายเหตุ |
|---|---|---|---|
| refresh widget | WorkManager 15 นาที + เมื่อได้ push | WidgetKit timeline + `WidgetCenter.reloadAllTimelines()` เมื่อได้ push | ใช้ `GET /api/widget` |
| ตอบ permission/approval จาก notification | notification action → `BroadcastReceiver` เปิด WS สั้น ๆ ส่ง `permission-response` / `approval-decide` | `UNNotificationAction` → app extension/foreground | ต้องเปิด WS เพราะไม่มี REST สำหรับคำสั่งนี้ (G-REST-1) |
| เล่นเพลงต่อ | Media3 `MediaSessionService` | Background audio | ดู `media.md` |
| อัปโหลดไฟล์ใหญ่ตอนออกจากแอป | WorkManager (expedited) | `URLSession` background upload | `/api/upload` ไม่รองรับ resume |
| reconnect WS | **ไม่ต้องค้าง** ใน background (เปลืองแบต และ Android/iOS จะตัดอยู่ดี) ส่ง `presence visible:false` แล้วปิด; กลับ foreground ค่อยต่อใหม่และ `chat-open` | เหมือนกัน | ยกเว้นผู้ใช้เลือก "แจ้งเตือนทันที" บน Android ที่ยังไม่มี FCM |

**trigger บนเครื่อง** — `triggers-sync` ให้รายการ trigger ที่ active เพื่อให้อุปกรณ์ตั้งนาฬิกาปลุกเอง (`protocol.ts:728-729`, `server.ts:1238-1243`)
ใช้เป็นตัวสำรองเมื่อ push ไม่มาได้ (Android `AlarmManager.setExactAndAllowWhileIdle` ต้องสิทธิ์ `SCHEDULE_EXACT_ALARM`;
iOS `UNCalendarNotificationTrigger` ได้สูงสุด 64 รายการ) — reminder ที่ถึงเวลาจริงยังมาจากเซิร์ฟเวอร์ ต้องกันแจ้งซ้ำด้วย `triggerId`

## 5. ลำดับที่แนะนำ

1. Android Phase 2: poll `/api/notifications` แบบเดิม (WorkManager + foreground service เป็นตัวเลือก) — ใช้ได้ทันทีไม่ต้องแก้เซิร์ฟเวอร์
2. Phase 1 (เซิร์ฟเวอร์): ลงทะเบียน token + ตัวส่ง FCM ผ่าน relay ที่ gateway
3. iOS/macOS: APNs เป็นเงื่อนไขก่อนปล่อย (ไม่มีทางเลือกอื่นที่ใช้ได้จริง)
4. Windows: แอปอยู่ใน tray ฟัง WS ก่อน แล้วเพิ่ม WNS ภายหลัง
