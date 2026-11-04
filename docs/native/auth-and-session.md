# Auth และ session (สำหรับแอป native)

> แหล่งความจริง: โค้ดที่อ้างถึงด้วย `ไฟล์:บรรทัด` (นับจาก root ของ repo) และการทดสอบกับ core + gateway ที่รันในเครื่อง
> ด้วยข้อมูลทดสอบ (2026-11-02, เวอร์ชัน `0.8.1-prototype`) ไม่ได้เรียก Railway

## 1. เซิร์ฟเวอร์มีสองแบบ แอปต้องรู้ก่อนว่ากำลังคุยกับแบบไหน

| แบบ | คืออะไร | ล็อกอินด้วย | `GET /health` ตอบ |
|---|---|---|---|
| **core (คนเดียว)** | core ตัวเดียว เช่นเครื่องที่บ้าน, VPS, Railway แบบคนเดียว | **token เดียวของเครื่อง** (`MIMI_TOKEN`) ที่ผู้ใช้พิมพ์เอง | `{"ok":true,"version":"0.8.1-prototype"}` |
| **gateway (หลายผู้ใช้)** | จุดเข้าเดียวที่มี username/password แล้วส่งต่อไปยัง core ของแต่ละคน | `POST /auth/login` → session token | `{"ok":true,"version":"0.8.1-prototype","accounts":true}` |

- `/health` ไม่ต้องใช้ token: core `packages/core/src/server/server.ts:2291`, gateway `packages/core/src/gateway/gateway.ts:209`
- เว็บเดิมตัดสินโหมดจาก `health.accounts` (`packages/core/src/server/web/app.js:5953-5971`) แอป native ทำแบบเดียวกัน:
  ถ้า `accounts === true` แสดงช่อง username + password (+ code) ถ้าไม่มี แสดงช่อง "รหัสผ่านของ Mimi" ช่องเดียว (คือ token)
- **ทั้งสองแบบ หลังได้ token แล้วใช้ API ชุดเดียวกันทุกอย่าง** (`/api/*` และ `/ws`) gateway แค่ส่งต่อ (`gateway.ts:377-381`, `gateway.ts:442-447`)

ลำดับที่แนะนำตอนเปิดแอป:

```
ผู้ใช้ใส่ URL เซิร์ฟเวอร์ (https://…) ─▶ GET /health
   ├─ accounts: true  ─▶ หน้าล็อกอิน username/password ─▶ POST /auth/login ─▶ เก็บ token
   └─ ไม่มี accounts ─▶ หน้าใส่ token ─▶ ทดสอบด้วย WS hello (ดูข้อ 4)
token ─▶ เปิด WS /ws ─▶ {type:'hello'} ─▶ รอ {type:'welcome'}
```

## 2. โหมด core (token เดียว)

- token คือค่า `MIMI_TOKEN` ของเครื่อง (`packages/core/src/config.ts:202`) ถ้าไม่ตั้ง core สุ่ม token ใหม่ทุกครั้งที่รัน
  และพิมพ์ลิงก์ `/#token=…` ใน log (`packages/core/src/server/run-core.ts:13-25`) — token แบบนี้หายเมื่อ restart
- ไม่มี endpoint ล็อกอิน ไม่มีวันหมดอายุ ไม่มี logout ฝั่งเซิร์ฟเวอร์: ทุกอุปกรณ์ใช้ token เดียวกัน
  ("ออกจากระบบ" = ลบ token ในเครื่องเท่านั้น) ดู `server-gaps.md` G-AUTH-1
- เทียบ token แบบ constant-time (`sameToken`, `server.ts:102-107`)
- การ "ทดสอบ token" ทำได้สองทาง:
  - เปิด WS แล้วส่ง `hello` — ผิดได้ close code `4003` (`server.ts:2333-2336`)
  - หรือ `GET /api/widget` พร้อม `Authorization: Bearer <token>` — ผิดได้ `401 {"error":"Missing or wrong token."}` (ทดสอบแล้ว)
- ลิงก์ `/#token=…` เป็นของเว็บ/แอป Electron เท่านั้น (`app.js:13-24`) แอป native ไม่ต้องรองรับ (ถ้าจะรองรับ deep link
  ให้ทำเฉพาะโหมด core เพราะเว็บเดิมปฏิเสธ token จากลิงก์ในโหมด gateway: `app.js:5957`)

## 3. โหมด gateway (หลายผู้ใช้)

### 3.1 `POST /auth/login`

- ต้องส่ง `Content-Type: application/json` ไม่อย่างนั้น `415 {"error":"Send JSON."}` (`gateway.ts:216-220`, ทดสอบแล้ว)
- body สูงสุด 4096 bytes (`gateway.ts:78`); username ถูก `trim().toLowerCase()` ตัดที่ 64 ตัว (`gateway.ts:222`)
  รูปแบบ username ที่สร้างได้: `^[a-z0-9][a-z0-9._-]{2,31}$`, รหัสผ่าน 10–256 ตัว (`packages/core/src/gateway/accounts.ts:23-25`)

```http
POST /auth/login
Content-Type: application/json

{"username":"tester","password":"…","code":"123456"}   // code ใส่เมื่อถูกขอเท่านั้น
```

| ผล | status | body (ตัวอย่างจริง) |
|---|---|---|
| สำเร็จ | 200 | `{"token":"<43 ตัว base64url>","username":"tester","expiresAt":"2026-12-02T11:00:02.162Z","webhookBase":"/h/lEjytGEaUVwz4c4A"}` |
| รหัสผ่านถูก แต่บัญชีเปิด 2FA และยังไม่ส่ง code | 401 | `{"error":"Enter the code from your authenticator app.","twoFactor":true}` |
| ผิด (ไม่มี code) | 401 | `{"error":"Wrong username or password."}` |
| ผิด (มี code) | 401 | `{"error":"Wrong username, password or code."}` |
| ลองผิดเกินกำหนด | 429 | `{"error":"Too many wrong attempts. Try again later."}` |
| เซิร์ฟเวอร์ตรวจรหัสผ่านพร้อมกันเต็ม | 503 + `retry-after: 5` | `{"error":"Busy. Try again in a moment."}` |

อ้างอิง `gateway.ts:214-252`; token สร้างจาก `randomBytes(32).toString('base64url')` (`accounts.ts:84`)
เก็บฝั่งเซิร์ฟเวอร์เป็น SHA-256 เท่านั้น (`accounts.ts:321-323`)

**2FA:** เมื่อได้ `401` + `twoFactor: true` ให้เก็บ username/password ไว้ในหน่วยความจำ แสดงช่อง code 6 หลัก แล้วส่ง
`/auth/login` ซ้ำพร้อม `code` (พฤติกรรมเว็บเดิม `app.js:5885-5894`) recovery code ใช้ช่องเดียวกัน (`accounts.ts:316`)

### 3.2 อายุ session

- ค่าเริ่มต้น: หมดอายุถ้า **ไม่ใช้ 30 วัน** (`MIMI_SESSION_IDLE_DAYS`) และ **ไม่เกิน 90 วันหลังล็อกอิน** ไม่ว่าจะใช้บ่อยแค่ไหน
  (`MIMI_SESSION_MAX_DAYS`) — `packages/core/src/gateway/main.ts:16-18`, `accounts.ts:190-191`
- ทุกครั้งที่ใช้ token (HTTP หรือ WS hello) ถ้าห่างจากครั้งก่อนเกิน 10 นาที `expiresAt` เลื่อนออกไปอีก idle days
  แต่ไม่เกินเพดาน max days (`accounts.ts:459-475`, `TOUCH_EVERY_MS` ที่ `accounts.ts:27`)
- **ไม่มี refresh token** และไม่มี endpoint ต่ออายุ: ต่ออายุด้วยการใช้งานเอง ครบ 90 วันต้องล็อกอินใหม่
- `expiresAt` ใน `/auth/login` และ `/auth/session` คือค่าล่าสุด ใช้แสดงผลได้ แต่ **อย่าใช้ตัดสินว่าหมดอายุ** — ให้เชื่อ `401` / close `4003`

### 3.3 endpoint อื่นของบัญชี (ต้องมี `Authorization: Bearer <session token>`)

| Method + path | body | สำเร็จ | ผิด |
|---|---|---|---|
| `GET /auth/session` | – | `200 {"username":"tester","expiresAt":"…","webhookBase":"/h/…","twoFactor":false,"recoveryCodes":0}` | `401 {"error":"Signed out."}` |
| `POST /auth/logout` | – | `204` (ปิด WS ทุกตัวของ session นี้ด้วย close `4003 "signed out"`) | `204` เสมอ |
| `POST /auth/password` | `{"current":"…","next":"…"}` | `200 {"ok":true}` (session อื่นของบัญชีถูกปิด) | `400 {"error":"…"}` |
| `POST /auth/2fa/setup` | `{"password":"…"}` | `200 {"secret":"…","uri":"otpauth://…"}` | `400 {"error":"Wrong password."}` |
| `POST /auth/2fa/enable` | `{"code":"123456"}` | `200 {"twoFactor":true,"recoveryCodes":[…]}` | `400` |
| `POST /auth/2fa/disable` | `{"password":"…","code":"…"}` | `200 {"twoFactor":false}` | `400 {"error":"Wrong password or code."}` |
| `POST /auth/2fa/recovery` | `{"password":"…"}` | `200 {"recoveryCodes":[…]}` | `400` |

- POST ทุกตัวในตารางนี้ (ยกเว้น logout) ต้องเป็น `Content-Type: application/json` ไม่อย่างนั้น `415`
- อ้างอิง `gateway.ts:253-364`; logout + ปิด socket ทดสอบแล้ว (`/auth/session` หลัง logout ได้ `401 {"error":"Signed out."}`)
- `uri` ของ 2FA setup เป็น `otpauth://` เอาไปทำ QR หรือเปิดแอป authenticator ได้ (`packages/core/src/gateway/totp.ts`)
- `webhookBase` คือ prefix ของ webhook ของบัญชีนี้ (`/h/<id>`) ใช้ประกอบ URL webhook ที่แสดงให้ผู้ใช้ copy (`app.js:5617`)

### 3.4 การแจ้งเตือนความปลอดภัย

เมื่อ session ใหม่ของบัญชีเดียวกันล็อกอิน gateway ส่ง frame นี้ไปยังอุปกรณ์อื่นที่เปิด WS อยู่ (`gateway.ts:171-176`):

```json
{"type":"security-alert","kind":"new-signin","at":"2026-11-02T11:00:02.170Z"}
```

frame นี้มาจาก gateway ไม่ได้มาจาก core (core ไม่เคยส่ง) แอปควรแสดงเป็น banner/notification

## 4. Rate limit ของการยืนยันตัวตน

ใช้ `AuthLimiter` (`packages/core/src/server/auth-limiter.ts:18-55`): **ผิด 10 ครั้งใน 10 นาทีจาก address เดียว → ปฏิเสธ 15 นาที
แม้ token ถูก** ใช้กับ

- core: ทุก `/api/*` ที่ต้องใช้ token (`server.ts:2135-2142`) และ WS hello (`server.ts:2329-2338`)
- gateway: `/auth/*`, `/api/*`, WS hello ต่อ address (`gateway.ts:132, 155-162`) และ **ต่อบัญชี 20 ครั้ง** สำหรับรหัสผ่าน (`gateway.ts:133`)

ผลที่แอปเห็น: HTTP `401` (core) / `429` (gateway login), WS close `4029 "too many wrong tokens; try again later"`
**อย่า retry อัตโนมัติด้วย token เดิมที่ถูกปฏิเสธ** — จะทำให้ address ถูกบล็อกเร็วขึ้น

"address" คือ IP ของผู้เรียก หรือ header ที่ตั้งใน `MIMI_CLIENT_IP_HEADER` เมื่ออยู่หลัง proxy (`auth-limiter.ts:8-12`)

## 5. ใช้ token อย่างไร

| ช่องทาง | วิธีส่ง |
|---|---|
| HTTP `/api/*` | header `Authorization: Bearer <token>` (`server.ts:2138`) — ไม่มี cookie, ไม่มี query token |
| WebSocket `/ws` | ส่งใน frame แรก `{"type":"hello","role":"client","token":"<token>","name":"android"}` ภายใน 10 วินาที |
| `/backgrounds/*.webp`, `/health`, `/icon*.png` | ไม่ต้องใช้ token (ไฟล์สาธารณะของแอป: `packages/core/src/server/web-files.ts:239-290`) |

`<img>` ในเว็บส่ง header ไม่ได้ เว็บจึง fetch แล้วทำ blob URL (`app.js:261-270`) แอป native ใช้ HTTP client ใส่ header ได้ตรง ๆ
(Coil/Glide/Kingfisher/URLSession ตั้ง header ได้)

## 6. หมดอายุ / ถูกถอน: แอปรู้ได้อย่างไร

| สัญญาณ | ความหมาย | สิ่งที่แอปต้องทำ |
|---|---|---|
| HTTP `401` จาก `/api/*` หรือ `/auth/session` | token ผิด / หมดอายุ / ถูก logout / บัญชีถูกปิด | ลบ token, กลับหน้าล็อกอิน |
| WS close `4003` | เหมือนด้านบน (`invalid token` ตอน hello หรือ `signed out` ระหว่างใช้) — gateway ตรวจ socket ที่เปิดอยู่ทุก 30 วินาที (`gateway.ts:478-481`) | ลบ token, **ห้าม reconnect** (`app.js:5740-5750`) |
| WS close `4029` | ถูก rate limit | รอ ≥15 นาที หรือให้ผู้ใช้กดลองใหม่ |
| WS close `4502` | gateway ต่อ core ไม่ได้เพราะ core ปฏิเสธ token ของ gateway (ตั้งค่าผิดฝั่ง admin) — **session ของอุปกรณ์ยังดี** (`gateway.ts:113-118`) | reconnect แบบ backoff, แสดง "เซิร์ฟเวอร์มีปัญหา" |
| WS close `1013` | gateway ต่อ core ไม่ได้ (`gateway.ts:456`) | reconnect แบบ backoff |
| HTTP `502 {"error":"Your Mimi core cannot be reached right now."}` | เหมือนด้านบนสำหรับ HTTP (`gateway.ts:194-197`) | retry ภายหลัง |

## 7. Remember-me และ "เครื่องนี้ไม่ใช่ของฉัน"

เว็บเดิมมีกล่อง "เครื่องนี้ไม่ใช่ของฉัน": ติ๊ก = token อยู่ใน `sessionStorage` (หายเมื่อปิดแท็บ) ไม่ติ๊ก = `localStorage`
(`app.js:142-152`); แอป Mac เดิมเก็บใน Keychain ผ่าน `safeStorage` เมื่อ remember เท่านั้น (`packages/desktop/remote.cjs:108-135`)

ฝั่งเซิร์ฟเวอร์ **ไม่มีความต่าง** ระหว่าง remember หรือไม่ (session อายุเท่ากัน) — เป็นเรื่องของ client ล้วน แอป native:

- remember (ค่าเริ่มต้น): เก็บ token ใน Keychain/Keystore
- ไม่ remember: เก็บ token ในหน่วยความจำของ process เท่านั้น และเรียก `POST /auth/logout` ตอนผู้ใช้ออก/ปิดแอป (gateway)

## 8. สิ่งที่แอปต้องเก็บ และเก็บที่ไหน

| ค่า | ความลับ? | Android | iOS / macOS | Windows |
|---|---|---|---|---|
| session token / `MIMI_TOKEN` | **ลับ** | Android Keystore (เช่น `EncryptedSharedPreferences` หรือ key ใน Keystore เข้ารหัสค่าเอง) | Keychain (`kSecClassGenericPassword`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) | `PasswordVault` (Credential Locker) หรือ DPAPI |
| URL เซิร์ฟเวอร์ | ไม่ลับ | DataStore / SharedPreferences | UserDefaults | `ApplicationData.LocalSettings` |
| username (แสดงผล) | ไม่ลับ | DataStore | UserDefaults | LocalSettings |
| `webhookBase` | ไม่ลับ | DataStore | UserDefaults | LocalSettings |
| โหมด (core / gateway) | ไม่ลับ | DataStore | UserDefaults | LocalSettings |
| แชตที่เปิดล่าสุด, id ของ notification ล่าสุดที่เห็น | ไม่ลับ | DataStore | UserDefaults | LocalSettings |

**ห้าม** เก็บรหัสผ่านของผู้ใช้หลังล็อกอินสำเร็จ (ต้องใช้แค่ตอน 2FA รอบที่สองในหน่วยความจำ) และห้ามเขียน token ลง log

ข้อควรระวังจากของเดิม: แอป Android เดิมเก็บ token ใน `SharedPreferences` แบบไม่เข้ารหัส
(`android/app/src/main/java/app/mimi/android/WidgetSync.java:55-60`) แอป native ต้องไม่ทำแบบนี้
widget/background job ที่ต้องใช้ token ให้อ่านจาก Keystore เช่นกัน (iOS: ใช้ Keychain access group ร่วมกับ widget extension)

## 9. ออกจากระบบ (sign out) ให้ครบ

ตามเว็บเดิม (`app.js:5912-5931`):

1. ยกเลิก push ของเครื่องนี้ (ปัจจุบันคือ `push-unsubscribe` ของ Web Push; native ดู `push-and-background.md`)
2. gateway: `POST /auth/logout` (offline ไม่เป็นไร token จะหมดอายุเอง)
3. ลบ token, cache รูป/ไฟล์ที่ดาวน์โหลดมา, widget data, notification ที่ค้าง
4. ปิด WS

## 10. OAuth ของบริการภายนอก (Google, Microsoft, ChatGPT plan, connector OAuth2)

ไม่เกี่ยวกับการล็อกอิน Mimi แต่แอปต้องรองรับ: เซิร์ฟเวอร์ส่ง URL มาทาง WS (`google-auth-url`, `microsoft-auth-url`,
`oauth-auth-url`, `provider-auth-url`, `connector-auth-url`) แอป **เปิดด้วยเบราว์เซอร์ของระบบ** (Custom Tabs / `ASWebAuthenticationSession`
/ `Launcher.LaunchUriAsync`) ผู้ให้บริการ redirect กลับไปที่ **เซิร์ฟเวอร์** (`/oauth/callback` หรือ `/h/<id>/oauth/callback`)
ไม่ใช่กลับเข้าแอป จากนั้นเซิร์ฟเวอร์ broadcast `oauth-accounts` / `settings` ที่ `saved: true` (`server.ts:1134-1150`)
— แอปแค่รอ frame นั้นแล้วปิด/รีเฟรชหน้าจอ

ข้อจำกัด: บน core ที่รันในคอมพิวเตอร์ (ไม่มี `MIMI_PUBLIC_URL`) การ sign-in ใช้ port ชั่วคราวบนเครื่องนั้น (`server.ts:504-506`)
จึงทำจากมือถือไม่ได้ — ดู `server-gaps.md` G-OAUTH-1
