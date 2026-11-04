# เวอร์ชันของ API และนโยบายเลิกรองรับ (deprecation)

เว็บเดิมไม่ต้องมีเรื่องนี้เพราะเซิร์ฟเวอร์เสิร์ฟ UI เวอร์ชันเดียวกับตัวเองเสมอ แอป native ติดตั้งค้างอยู่ในเครื่องผู้ใช้ได้นานหลายเดือน
และอาจคุยกับ core ที่เก่ากว่าหรือใหม่กว่าตัวเอง จึงต้องมีเลขที่บอกว่าเข้ากันได้ไหม

## เลขสองตัว

| ค่า | ที่อยู่ในโค้ด | ความหมาย |
|---|---|---|
| `API_VERSION` | `packages/shared/src/protocol.ts` | เวอร์ชันของ client API ที่ core นี้พูด: ชนิดข้อความ WS, path HTTP และ JSON ของมัน — **เพิ่มเมื่อมีการเปลี่ยนที่ทำให้แอปที่ build กับเลขเดิมพัง** เท่านั้น |
| `MIN_CLIENT_API` | ที่เดียวกัน | client API ที่เก่าที่สุดที่ core นี้ยังรับ แอปที่ต่ำกว่านี้ถูกปิด socket ด้วย `4426` |

ปัจจุบัน: `API_VERSION = 2`, `MIN_CLIENT_API = 1`

เลขเหล่านี้ **ไม่ใช่** เลข release ของแอป (`version` ใน `package.json`, เช่น `0.8.1-prototype`) — release เปลี่ยนบ่อย API เปลี่ยนน้อยครั้ง

## core บอกเลขที่ไหน

- `GET /health` (ไม่ต้องใช้ token): `{"ok":true,"version":"0.8.1-prototype","api":2,"minClientApi":1}` (gateway มี `"accounts":true` เพิ่ม)
- header `x-mimi-api: 2` ในทุกคำตอบ HTTP ของ core และ gateway (รวม 401/404) — ผ่าน gateway จะเห็นทั้งสองตัวเป็นค่าเดียวกันเมื่อ deploy พร้อมกัน
- frame `welcome`: `version`, `api`, `minClientApi`

core เวอร์ชันก่อน Phase 1 ไม่มี field เหล่านี้ → แอปถือว่าเป็น `api = 0`

## แอปบอกเลขของตัวเอง

```json
{"type":"hello","role":"client","token":"…","client":{"platform":"android","version":"1.0.0","api":1}}
```

`platform`: `web` | `android` | `ios` | `macos` | `windows` | `desktop` | `other` — ถ้าไม่ส่ง `client` (เว็บเดิม) core ไม่ตรวจอะไร

ถ้า `client.api < MIN_CLIENT_API` core ปิด socket ทันทีหลังตรวจ token ด้วย **close code `4426`** และ reason
`update the app: this server needs client API <n> or newer` (ไม่มี `welcome`) แอปต้องแสดงหน้า "กรุณาอัปเดตแอป" และ **ไม่ reconnect**

## สิ่งที่แอปต้องทำตอนเริ่ม

1. `GET /health` → อ่าน `api` (ไม่มี = 0) และ `minClientApi` (ไม่มี = 0)
2. ถ้า `client.api < minClientApi` → หน้าอัปเดตแอป
3. ถ้า `api < client ต้องการขั้นต่ำ` (เช่นแอปต้องใช้ `chat-turn-messages` ซึ่งมีตั้งแต่ api 1) → แจ้งว่าเซิร์ฟเวอร์เก่าเกินไป ให้ผู้ดูแลอัปเดต core
4. ถ้า `api > client.api` → ใช้งานได้ตามปกติ (core ใหม่กว่ายังรับแอปเก่าจนกว่า `minClientApi` จะขึ้น)
5. ระหว่างใช้งาน: frame หรือ field ที่ไม่รู้จักให้ **ข้ามไปเงียบ ๆ** (ไม่ล้ม) และ `error` ที่มี `code: "E-PROTOCOL"` = core ไม่รู้จักคำสั่งนี้
   (`requestType` บอกว่าคำสั่งไหน) — ปิดฟีเจอร์นั้นแทนการแสดง error ซ้ำ

## อะไรนับเป็น "การเปลี่ยนที่ทำให้พัง" (ต้องเพิ่ม `API_VERSION`)

| พัง (เพิ่มเลข) | ไม่พัง (ไม่ต้องเพิ่มเลข) |
|---|---|
| ลบหรือเปลี่ยนชื่อ frame / คำสั่ง / path / field | เพิ่ม frame, คำสั่ง, path, field ใหม่ที่ไม่บังคับ |
| เปลี่ยนชนิดของ field (string → number, object → array) | เพิ่มค่าใหม่ใน enum ที่แอปข้ามได้ (เช่น `kind` ใหม่ของ notification) |
| เปลี่ยนความหมายของค่าเดิม (เช่น หน่วยเวลา, `unread` จาก boolean เป็นจำนวน) | เพิ่ม error code ใหม่ |
| ทำให้ field ที่เคยมีเสมอกลายเป็นบางครั้งไม่มี | ทำให้ field ที่ไม่บังคับมีบ่อยขึ้น |
| เปลี่ยน auth, close code, หรือลำดับเหตุการณ์ที่สเปกบอกไว้ (`realtime.md` ข้อ 4.2) | ปรับข้อความ error (`message`) — แอปไม่ควรเทียบข้อความ |

## นโยบายเลิกรองรับ

1. **ประกาศก่อน**: ของที่จะลบ ให้ระบุใน `CHANGELOG.md` หัวข้อ "Deprecated" พร้อมเวอร์ชัน API ที่จะลบ และใน `docs/native/api-contract.md`
   ทำเครื่องหมาย "(deprecated, ลบใน api N)" — ของเดิมยังทำงานต่อ
2. **ระยะเวลา**: ของที่ประกาศ deprecated ต้องอยู่ต่ออย่างน้อย **90 วัน** และอย่างน้อย **1 release ของแอปทุกแพลตฟอร์ม** ที่เลิกใช้ของนั้นแล้ว
   (ร้านแอปใช้เวลารีวิว และผู้ใช้ไม่ได้อัปเดตทันที)
3. **ขึ้นเลข**: เมื่อลบจริง เพิ่ม `API_VERSION` และ (ถ้าแอปเก่าจะพัง) ขึ้น `MIN_CLIENT_API` ใน release เดียวกัน
4. **ของที่ native ยังไม่ได้ใช้แต่เว็บใช้** (เช่น `send` / `history` แบบเก่า, `/app/<action>`, `push-subscribe` ของ Web Push) ไม่อยู่ในนโยบายนี้จนกว่า
   Phase 7 จะเลิกเสิร์ฟเว็บ — ตอนนั้นประกาศตามข้อ 1–3
5. **gateway กับ core**: ระหว่างอัปเดต core ของผู้ใช้แต่ละคนไม่พร้อมกัน แอปอาจเจอ gateway ใหม่ + core เก่า ให้เชื่อ `welcome.api`
   (มาจาก core) มากกว่า `/health` ของ gateway

## ประวัติ

| API | release | การเปลี่ยน |
|---|---|---|
| 0 | ≤ 0.8.1-prototype | ไม่มีเลขเวอร์ชัน (สเปก Phase 0) |
| 1 | Unreleased (Phase 1) | เพิ่ม: `/health.api/minClientApi`, `x-mimi-api`, `hello.client`, close `4426`, `welcome.version/api/minClientApi`, `chat-turn-messages`, `chat-open.afterId`, `error.requestType`, `E-PROTOCOL`, native push (`native-push-register/unregister`, `/api/push/*`), `/api/notifications?afterId=`, `/api/permissions/:id`, `/api/approvals/:id`, `/api/mimiamp/files`, Range ของ `/api/files/:id` และ `/api/mimiamp/youtube/:id/audio`, gateway ส่ง `/mimiamp/*` ต่อเมื่อมี Bearer — ไม่มีอะไรถูกลบ |
| 2 | Unreleased | **ลบ Mimiamp** (เจ้าของโปรเจกต์ตัดสิน Q5, 2026-11-03): `/mimiamp/*`, `/api/mimiamp/*` (state, files, youtube, playlists, import), frame `mimiamp`, เครื่องมือ `mimiamp` ของ agent · `MIN_CLIENT_API` ยังเป็น 1: แอปที่ build กับ api 1 ยังต่อได้ แค่หน้าเพลงใช้ไม่ได้ (404) · ไม่ได้ประกาศ deprecated 90 วันตามนโยบายข้อ 1–2 เพราะแอป native ยังไม่ได้ปล่อย · **เพิ่ม**: platform `wns`, `GET /api/push/info`, `/push/relay` ของ gateway (ระหว่าง core กับ gateway ไม่ใช่ของแอป) |
