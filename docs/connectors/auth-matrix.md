# Connector Auth Matrix — Phase 3

สถานะ: ใช้กับ connector **50 service / 214 operation** ใน `packages/core/src/connectors/services/`
เจ้าของ: Agent `P1-SERVICES` / `P1-CONNECTIONS` (10) + `P3-CONN-E` / `P3-CONN-F` (40)
อัปเดตล่าสุด: Phase 3 (50 services)

## 1. หลักการ

- Credential ทุกตัวเก็บใน vault ผ่าน `SecretStore` ไม่เคยอยู่ใน spec, workflow JSON, log หรือ error
- static connector (API key / bot / PAT / basic / bearer) ใช้ `ConnectorConnections`:
  - metadata อยู่ที่ `oauthDir/connections.json`
  - ค่าจริงอยู่ใต้ key `connector.<connectionId>.<field>`
  - connection แรกของแต่ละ service เป็น default; ตั้ง default ใหม่ได้
  - `account` เว้นว่าง = default connection; ถ้าไม่มีเลยจะ fallback ไป legacy key/env ของ Phase 0
- Google connectors ใช้ `OAuthAccounts` เดิม (`oauth.google(account)`), ไม่สร้าง connection ซ้ำ
- OAuth2 connection ที่ไม่ใช่ Google ต้องมี `authorizeUrl`, `tokenUrl`, `scopes` และ refresh token
  ใน field ที่ประกาศ; runtime ต่ออายุ token ให้ก่อนเรียก API
- ก่อนใช้ operation ที่ risk ไม่ใช่ `read` ต้องเปิด `allow` ที่ node หรือตั้ง permission ของ tool เป็น `allow`

## 2. Matrix (50 services)

Account model:

- **connection** = Hub → บัญชี → Connections (หลายชื่อ + default, `account` เลือกได้)
- **OAuth2** = ปุ่มเชื่อมต่อ OAuth2 ใน Hub → บัญชี (generic flow, ต่ออายุ token เอง)
- **Google** = บัญชี Google เดิมที่เชื่อมไว้ใน Hub → บัญชี (scope เพิ่มตาม service)

| Service | Auth kind | Credential field | Account model | Ops | หมายเหตุ |
|---|---|---|---|---|---|
| `slack` | `apiKey` | `botToken` (`xoxb-…`) | connection | 6 | |
| `discord` | `apiKey` | `botToken` | connection | 5 | runtime เติม prefix `Bot ` ให้ |
| `notion` | `apiKey` | `token` (`ntn_…`) | connection | 5 | ส่ง header `Notion-Version: 2022-06-28` |
| `airtable` | `apiKey` | `token` (`pat…`) | connection | 5 | |
| `google_docs` | `oauth2` | Google account | Google | 4 | provider `google` |
| `google_tasks` | `oauth2` | Google account | Google | 4 | provider `google` |
| `google_forms` | `oauth2` | Google account | Google | 4 | provider `google` |
| `hubspot` | `apiKey` | `token` (`pat-…`) | connection | 6 | |
| `stripe` | `apiKey` | `secretKey` (`sk_test_…` / `sk_live_…`) | connection | 5 | |
| `github` | `apiKey` | `token` (`github_pat_…`) | connection | 6 | ส่ง `Accept` + `X-GitHub-Api-Version` |
| `jira` | `basic` | `username`, `password` | connection | 5 | |
| `trello` | `apiKey` | `key`, `token` | connection | 5 | `key`/`token` ไปทาง query |
| `asana` | `bearer` | `token` | connection | 5 | |
| `clickup` | `bearer` | `token` | connection | 5 | |
| `monday` | `apiKey` | `token` | connection | 5 | ส่ง token เป็น `Authorization` โดยตรง |
| `linear` | `bearer` | `token` | connection | 5 | |
| `todoist` | `bearer` | `token` | connection | 5 | |
| `dropbox` | `bearer` | `token` | connection | 5 | |
| `openai` | `bearer` | `token` | connection | 5 | |
| `google_drive` | `oauth2` | Google account | Google | 5 | provider `google` |
| `salesforce` | `bearer` | `token` | connection | 5 | |
| `pipedrive` | `apiKey` | `token` | connection | 5 | token ไปทาง query `api_token` |
| `shopify` | `apiKey` | `token` | connection | 5 | ส่ง header `X-Shopify-Access-Token` |
| `woocommerce` | `basic` | `username` (consumer key), `password` (consumer secret) | connection | 5 | |
| `wordpress` | `basic` | `username`, `password` | connection | 5 | |
| `mailchimp` | `basic` | `username`, `password` | connection | 5 | |
| `sendgrid` | `bearer` | `token` | connection | 5 | |
| `twilio` | `basic` | `username`, `password` | connection | 5 | |
| `whatsapp` | `bearer` | `token` | connection | 5 | |
| `supabase` | `apiKey` | `apiKey` | connection | 5 | ส่ง header `apikey` |
| `microsoft_teams` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 4 | Microsoft identity platform |
| `excel` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 4 | Microsoft identity platform |
| `zoom` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 4 | |
| `calendly` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 3 | |
| `typeform` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 3 | |
| `box` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 4 | `upload_file` ยังเป็น multipart gap ของ runtime |
| `google_analytics` | `oauth2` | Google account | Google | 2 | provider `google` |
| `google_ads` | `oauth2` | Google account | Google | 3 | provider `google`; ต้องส่ง `developerToken` ต่อ operation |
| `line` | `apiKey` | `channelAccessToken` | connection | 3 | ส่งเป็น `Authorization: Bearer …` |
| `zoho_crm` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 4 | runtime เติม prefix `Zoho-oauthtoken ` |
| `facebook` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 3 | |
| `instagram` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 4 | |
| `linkedin` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 3 | |
| `x` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 3 | ใช้ PKCE (`extra.pkce`) |
| `youtube` | `oauth2` | Google account | Google | 3 | provider `google` |
| `reddit` | `oauth2` | `clientId`, `clientSecret`, `refreshToken` (+ optional `accessToken`, `expiresAt`) | OAuth2 | 3 | ส่ง `User-Agent: mimi-connector/1.0` |
| `google_search_console` | `oauth2` | Google account | Google | 2 | provider `google` |
| `google_chat` | `oauth2` | Google account | Google | 3 | provider `google` |
| `google_slides` | `oauth2` | Google account | Google | 3 | provider `google` |
| `google_classroom` | `oauth2` | Google account | Google | 3 | provider `google` |

## 3. การขอ credential

- **apiKey / bearer**: สร้าง token ในหน้าตั้งค่าของ service แล้วเพิ่มใน Hub → บัญชี → Connections
  (ชื่ออะไรก็ได้; ตั้งตัวแรกเป็น default). `account` ของ operation เว้นว่าง = default
- **basic**: ใส่ username/password (WooCommerce ใช้ consumer key/secret) ใน Connections
- **OAuth2 (ไม่ใช่ Google)**: สร้าง OAuth app ที่ service นั้น, ใส่ redirect URI ที่ Hub แสดง,
  แล้วกดเชื่อมต่อ OAuth2 ใน Hub → บัญชี; Mimi เก็บ refresh token และต่ออายุให้
  - X ใช้ PKCE; Zoho เติม prefix `Zoho-oauthtoken `; Microsoft ใช้ tenant `common` หรือ tenant id
- **Google**: เชื่อมบัญชี Google ครั้งเดียวที่ Hub → บัญชี; service ใหม่จะขอ scope เพิ่ม
  (YouTube, Search Console, Chat, Slides, Classroom ใช้บัญชีเดียวกัน)
- **Google Ads**: นอกจากบัญชี Google ต้องมี developer token ของ Google Ads ใน operation ที่เรียก
- **LINE**: channel access token ส่งเป็น Bearer ให้อัตโนมัติ
- **Reddit**: runtime ส่ง User-Agent คงที่ `mimi-connector/1.0`
- **Discord**: bot token ถูกส่งเป็น `Authorization: Bot …`

## 4. ที่เก็บและการ resolve

```
connections.json           metadata: id, connector, name, default, authKind, fields (ไม่ใช่ค่า secret)
SecretStore                connector.<id>.<field> = ค่า credential
Google OAuthAccounts       token ของบัญชี Google เดิม
legacy vault/env           fallback สำหรับการติดตั้ง Phase 0 ที่ยังไม่ย้ายมา connection
```

ลำดับ resolve ของ `ConnectorConnections`:

1. `account` ที่ระบุ → connection นั้น
2. ไม่ระบุ → connection default ของ service
3. ไม่มี connection → legacy key/env ของ service (ถ้ามี)
4. ไม่พบ → error ที่บอกวิธีตั้งค่า โดยไม่เปิดเผยค่า secret

## 5. สิทธิ์และการทดสอบ

- Workflow node มีปุ่ม “ทดสอบ” สำหรับรัน node เดียวด้วย input ตัวอย่าง
- Hub แสดง `connected` / `hasSecret` จาก field ที่บันทึก; ไม่มีปุ่มทดสอบใน Hub
- Catalog UI (Hub → Node & Tools) แสดง auth kind, credential fields และสถานะ connection
  โดยไม่แสดงค่า secret (`docs/connectors/longtail-ui.md`)
- การทดสอบอัตโนมัติใช้ fake fetch; ห้ามยิง API จริงระหว่าง `npm test`
- connection ที่ยังไม่ครบ field จะแสดง `connected: false` และใช้เรียก operation ไม่ได้
- write/delete operation ต้องมี consent ทุกครั้งที่รัน workflow เว้นแต่ permission ตั้งเป็น `allow`
- OAuth2 generic ทดสอบ authorization-code + refresh ด้วย token ปลอม และตรวจว่าไม่รั่ว client secret / refresh token ใน error
- test ที่ครอบ auth: `connector-auth.test.ts`, `connector-runtime.test.ts`, `connector-runtime-hardening.test.ts`,
  `connector-batch-a`…`f.test.ts`, `connector-catalog.test.ts`; ทั้ง suite 528 tests ผ่านใน Phase 3
