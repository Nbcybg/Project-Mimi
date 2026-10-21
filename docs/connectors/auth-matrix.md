# Connector Auth Matrix — Phase 1

สถานะ: ใช้กับ connector 10 service / 50 operation ใน `packages/core/src/connectors/services/`
เจ้าของ: Agent `P1-SERVICES` / `P1-CONNECTIONS`

## 1. หลักการ

- Credential ทุกตัวเก็บใน vault ผ่าน `SecretStore` ไม่เคยอยู่ใน spec, workflow JSON, log หรือ error
- static connector (API key / bot / PAT) ใช้ `ConnectorConnections`:
  - metadata อยู่ที่ `oauthDir/connections.json`
  - ค่าจริงอยู่ใต้ key `connector.<connectionId>.<field>`
  - connection แรกของแต่ละ service เป็น default; ตั้ง default ใหม่ได้
  - `account` เว้นว่าง = default connection; ถ้าไม่มีเลยจะ fallback ไป legacy key/env ของ Phase 0
- Google connectors ใช้ `OAuthAccounts` เดิม (`oauth.google(account)`), ไม่สร้าง connection ซ้ำ
- OAuth2 connection ที่ไม่ใช่ Google ต้องมี `authorizeUrl`, `tokenUrl`, `scopes` และ refresh token
  ใน field ที่ประกาศ; runtime ต่ออายุ token ให้ก่อนเรียก API
- ก่อนใช้ operation ที่ risk ไม่ใช่ `read` ต้องเปิด `allow` ที่ node หรือตั้ง permission ของ tool เป็น `allow`

## 2. Matrix

| Service | Auth kind | Credential field | Scopes / header | Account model | Ops |
|---|---|---|---|---|---|
| `slack` | `apiKey` | `botToken` (`xoxb-…`) | `chat:write`, `channels:read`, `channels:history` | connection หลายชื่อ + default | 6 |
| `discord` | `apiKey` | `botToken` | `bot`; ส่ง `Authorization: Bot …` | connection หลายชื่อ + default | 5 |
| `notion` | `apiKey` | `token` (`ntn_…`) | header `Notion-Version: 2022-06-28` | connection หลายชื่อ + default | 5 |
| `airtable` | `apiKey` | `token` (`pat…`) | `data.records:read`, `data.records:write` | connection หลายชื่อ + default | 5 |
| `google_docs` | `oauth2` | Google OAuth account | `documents`, `drive.file` | Google account เดิม | 4 |
| `google_tasks` | `oauth2` | Google OAuth account | `tasks` | Google account เดิม | 4 |
| `google_forms` | `oauth2` | Google OAuth account | `forms.body`, `forms.responses.readonly` | Google account เดิม | 4 |
| `hubspot` | `apiKey` | `token` (`pat-…`) | contacts read/write, deals read/write, tickets read | connection หลายชื่อ + default | 6 |
| `stripe` | `apiKey` | `secretKey` (`sk_test_…` / `sk_live_…`) | customers read/write, charges read, payment links write, refunds write | connection หลายชื่อ + default | 5 |
| `github` | `apiKey` | `token` (`github_pat_…`) | `repo`; headers `Accept`, `X-GitHub-Api-Version` | connection หลายชื่อ + default | 6 |

## 3. การขอ credential

- Slack: สร้าง app ที่ Slack → OAuth & Permissions แล้วคัดลอก Bot User OAuth Token
- Discord: Developer Portal → Bot → Reset Token; เปิด intent ที่ operation ต้องใช้
- Notion: Settings → Connections → Develop or manage integrations; แชร์หน้าที่ต้องการให้ integration เห็น
- Airtable: Developer hub → Personal access tokens; ต้องมี scope ของ base ที่ใช้
- Google: ใช้หน้า Hub → บัญชี เชื่อมต่อ Google; ต้องยินยอม scope ใหม่หลังเพิ่ม Docs/Tasks/Forms
- HubSpot: Settings → Integrations → Private apps
- Stripe: Dashboard → Developers → API keys (เริ่มด้วย test key)
- GitHub: Settings → Developer settings → Personal access tokens (fine-grained หรือ classic ที่มี `repo`)

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
- การทดสอบอัตโนมัติใช้ fake fetch; ห้ามยิง API จริงระหว่าง `npm test`
- connection ที่ยังไม่ครบ field จะแสดง `connected: false` และใช้เรียก operation ไม่ได้
- write/delete operation ต้องมี consent ทุกครั้งที่รัน workflow เว้นแต่ permission ตั้งเป็น `allow`
- OAuth2 generic ทดสอบ authorization-code + refresh ด้วย token ปลอม และตรวจว่าไม่รั่ว client secret / refresh token ใน error
- OAuth2 connection ที่ไม่ใช่ Google มีปุ่ม “เชื่อมต่อ OAuth2” ใน Hub → บัญชี
