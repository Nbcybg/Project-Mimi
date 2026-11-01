# แพ็ก (Packs)

แพ็กคือชุด **agent + connector (OpenAPI) + workflow** ที่ใช้คู่กัน ติดตั้งทีเดียวจาก Hub → แพ็ก
พร้อมรายการสิ่งที่ยังต้องตั้งค่า (credential checklist) โค้ดอยู่ที่ `packages/core/src/packs/`
(`packs.ts` = ตรวจ/ติดตั้ง, `catalog.ts` = แพ็กที่มากับแอป) และหน้าจอที่ `server/web/feature-packs.js`

## แพ็กที่มากับแอป

| id | ทำอะไร | ต้องมี |
|---|---|---|
| `morning-brief` | 07:00 ดึงพยากรณ์อากาศจาก Open-Meteo → เลขาสรุป → แจ้งเตือน | ผู้ให้บริการโมเดล |
| `fx-watch` | วันทำการ 09:00 อัตรา USD/THB จาก Frankfurter → แจ้งเตือน | ผู้ให้บริการโมเดล (สำหรับ agent ของแพ็ก) |
| `mail-digest` | 18:00 อีเมลที่ยังไม่อ่านจาก Gmail → เลขาสรุป → แจ้งเตือน | ผู้ให้บริการโมเดล, บัญชี Google |

Open-Meteo และ Frankfurter ไม่ต้องใช้คีย์ จึงใช้ได้ทันทีหลังติดตั้งและเปิด workflow

## ติดตั้งแล้วเกิดอะไรขึ้น

1. **ตรวจก่อน (preview)** — ไม่เปลี่ยนอะไรเลย แสดง agent (พร้อม system prompt และเครื่องมือ, เครื่องมือเสี่ยงอย่าง
   รันคำสั่ง/ลบ ถูกไฮไลต์), connector, workflow, checklist และคำเตือน
2. **ติดตั้ง** ตามลำดับ connector → agent → workflow
   - connector นำเข้าผ่านทางเดียวกับ Hub → Node & Tools → นำเข้า OpenAPI (กฎเดียวกันทั้งหมด: JSON, https,
     ไม่ใช่เครื่องในวง LAN, untrusted, risk ตาม method) ถ้า key นั้นนำเข้าไว้แล้วจะใช้ตัวเดิม
   - agent ที่มีชื่อซ้ำ = ใช้ตัวเดิม ไม่แก้เครื่องมือหรือ prompt ของมัน
   - workflow ชื่อซ้ำ = ได้ชื่อใหม่ (`-2`, `-3`, …) และ **ทุกตัวถูกบันทึกแบบปิด** ให้ตรวจก่อนเปิดเอง
3. บันทึกสิ่งที่ติดตั้งไว้ที่ `user/packs/<id>.json` เพื่อแสดง checklist ในหัวข้อ "ติดตั้งแล้ว" (กด "ตรวจ checklist อีกครั้ง"
   หลังตั้งค่าบัญชีเสร็จ)

## ถอนการติดตั้ง

Hub → แพ็ก → การ์ดที่ติดตั้งแล้ว → **ถอนการติดตั้ง** จะตรวจก่อนว่าจะลบอะไร แล้วค่อยยืนยัน

- ลบเฉพาะสิ่งที่แพ็ก **สร้าง** ตอนติดตั้ง (agent / OpenAPI connector / workflow) และเฉพาะที่ยังมีอยู่
- agent หรือ connector ที่ใช้ของเดิมอยู่แล้วไม่ถูกแตะ; ของที่ workflow/agent อื่นยังใช้จะถูกเก็บไว้และแสดงเหตุผล
- workflow ของแพ็กถูกลบ; agent ที่แพ็กสร้างจะถูกลบเมื่อไม่มี workflow อื่นเหลืออยู่ (ถ้ามี จะเก็บ agent ไว้)
- แพ็กที่ติดตั้งก่อนมีระบบติดตามรายการ: ลบได้เฉพาะรายการติดตั้ง ของที่ติดตั้งไว้ยังอยู่ ต้องลบเองจากหน้าของแต่ละอย่าง
- ไม่มี rollback ย้อนสถานะก่อนติดตั้ง เพราะการติดตั้งไม่เคยทับของเดิม; ถ้าอยากเก็บ workflow ไว้ ให้ทำสำเนาก่อนถอน

## Remote catalog

ตั้ง `MIMI_PACK_CATALOG_URL` เป็น JSON แบบ https (อาร์เรย์ของแพ็ก หรือ `{ "packs": [...] }`) เพื่อเพิ่มแพ็กจากภายนอก
ตอนเปิด core:

- จำกัด 5 วินาทีและ 4 MB; รายการที่ผิดรูปแบบหรือ id ซ้ำกับแพ็กในเครื่องจะถูกข้ามพร้อม log
- แพ็กที่มาจาก remote แสดงป้าย **ระยะไกล** และติดตั้งผ่านกฎเดียวกับแพ็กไฟล์
- **ไม่มีลายเซ็นหรือ central marketplace**: ผู้ดูแลต้องเลือก URL ที่ไว้ใจ; อ่าน prompt/เครื่องมือ/workflow ก่อนติดตั้งเสมอ
- ต้องรีสตาร์ท core เพื่อโหลด catalog ใหม่

## Checklist

ได้มาจากสิ่งที่ **workflow ใช้จริง** บวกกับที่แพ็กประกาศเอง:

- ผู้ให้บริการโมเดล — เสมอ
- connector ที่ต้องมี connection (auth ไม่ใช่ `none`) — จาก connector ของแพ็กและ node `connector`
- บัญชี Google / Microsoft — จาก node `tool` ที่ใช้ `gmail_*`, `calendar_*`, `drive_*`, `sheets_*`, `contacts_*` /
  `outlook_*`, `onedrive_*`, `todo_*` หรือ connector Google
- คีย์ลับ — จาก `$secret.NAME` / `{{secret.NAME}}` ใน workflow

เครื่องมือที่ agent แค่ "มีสิทธิ์ใช้" (เช่น Gmail ของเลขา) ไม่นับเป็นสิ่งที่ต้องมี สถานะ ✓/! ตรวจจากของจริงในเครื่องทุกครั้ง

## รูปแบบไฟล์แพ็ก (`format: 1`)

```json
{
  "format": 1,
  "id": "my-pack",
  "name": "ชื่อที่แสดง",
  "description": "ทำอะไร",
  "version": "1.0.0",
  "author": "ชื่อ",
  "tags": ["daily"],
  "agents": [
    { "name": "helper", "displayName": "ผู้ช่วย", "description": "…", "systemPrompt": "…", "tools": ["web_search"] }
  ],
  "connectors": [
    { "key": "my_api", "label": "My API", "openapi": { "openapi": "3.0.3", "info": {}, "servers": [], "paths": {} } }
  ],
  "workflows": [
    {
      "name": "daily-check", "agent": "helper", "title": "…", "description": "…",
      "trigger": { "pool": "schedule", "config": { "cron": "0 8 * * *" } },
      "nodes": [
        { "id": "call", "type": "connector", "config": { "connector": "my_api", "operation": "list", "input": {} }, "links": { "main": ["notify"] } },
        { "id": "notify", "type": "notify", "config": { "title": "…" }, "links": { "main": [] } }
      ]
    }
  ],
  "credentials": [
    { "kind": "secret", "key": "MY_TOKEN", "label": "Token ของ My API", "why": "…", "url": "https://example.com/tokens" }
  ]
}
```

ข้อจำกัดและการตรวจ:

- JSON เท่านั้น ไม่เกิน 4 MB · agent ≤ 8, connector ≤ 8, workflow ≤ 20 · `id` ห้ามซ้ำกับแพ็กที่มากับแอป
- ชื่อ agent ห้ามเป็น `overseer` · เครื่องมือทุกตัวต้องมีอยู่ (หรือมาจาก connector ในแพ็ก)
- agent ที่มีเครื่องมืออ่านเนื้อหาภายนอก (web, mail, connector ที่นำเข้า) ห้ามมีเครื่องมือ shell ด้วย
- workflow ต้องอ้าง agent ที่อยู่ในแพ็กหรือในแอป, trigger ที่มีจริง, connector/tool ที่มีจริง แล้วผ่าน validation ปกติของ workflow
- `credentials[].kind` = `provider` | `connector` | `google` | `microsoft` | `secret` · ลิงก์ `url` รับเฉพาะ `https://`
- แพ็กไม่มีทางพก credential: ค่าลับต้องตั้งเองใน Hub → คีย์ลับ / บัญชี

**แพ็กจากคนอื่นคือโค้ดที่กระทำการแทนคุณได้** อ่าน system prompt, เครื่องมือ และ workflow ในหน้าตรวจก่อนยืนยันทุกครั้ง

## Messages

| Client | Server |
|---|---|
| `packs-list` | `packs { catalog, installed }` (installed มี `credentials` ปัจจุบัน) |
| `pack-preview { reqId, id \| source }` | `pack-report { reqId, action: 'preview', ok, report, errors }` |
| `pack-install { reqId, id \| source }` | `pack-report { action: 'install', … }` แล้ว broadcast agents / settings / tools / connections / workflows / packs |
| `pack-remove-preview { reqId, id }` | `pack-remove-report { action: 'preview', report, errors }` (ไม่เปลี่ยนอะไร) |
| `pack-remove { reqId, id }` | `pack-remove-report { action: 'remove', report, errors }` แล้ว broadcast เหมือน install |
