# Connector UI smoke checklist

รันด้วยข้อมูลทดสอบเท่านั้น (ห้ามใช้ credential จริง) และปิด network ของ model:

```bash
MIMI_ROOT="$PWD/.tmp-smoke" MIMI_TOKEN=smoke PORT=8799 MIMI_MODELS_OFFLINE=1 node packages/core/src/main.ts
```

เปิด `http://127.0.0.1:8799` แล้วตรวจรายการต่อไปนี้

## Hub → บัญชี

- [ ] Google / Microsoft accounts เดิมยังแสดงและเชื่อมต่อได้
- [ ] panel “Connector connections” แสดงเฉพาะ service ที่ไม่ใช่ Google
- [ ] เพิ่ม Slack connection ด้วย bot token ปลอม → แสดง `● พร้อมใช้` และ `★` เมื่อเป็นตัวแรก
- [ ] เพิ่ม connection ชื่อที่สอง → ไม่ทับของเดิม; กด “ตั้งเป็นค่าเริ่มต้น” แล้วสลับได้
- [ ] แก้ไข connection โดยเว้น credential ว่าง → ค่าเดิมยังอยู่
- [ ] ลบ connection → หายจาก list และ workflow ที่ใช้ connection นั้นแจ้ง error ที่อ่านได้
- [ ] `oauthDir/connections.json` ไม่มีค่า token/secret
- [ ] OAuth2 connection (ถ้ามี service รองรับ) กด “เชื่อมต่อ OAuth2” → เปิดลิงก์ได้ และ callback แล้วสถานะเปลี่ยนเป็นพร้อมใช้

## Workflow editor

- [ ] palette มีกลุ่ม “เชื่อมต่อ” และลาก node `connector` ได้
- [ ] node ใหม่เลือก service แรกและ operation แรกให้อัตโนมัติ
- [ ] เปลี่ยน service → operation reset และ field เปลี่ยนตาม
- [ ] เปลี่ยน operation → field/`allow` เปลี่ยนตาม; operation read ไม่แสดง `allow`
- [ ] field ตรงกับ `ConnectorField` (string/number/boolean/json/select/secret)
- [ ] `optionsFrom` แสดง loading แล้วได้ options; พิมพ์ค่าเองได้ระหว่างรอ/เมื่อโหลดไม่สำเร็จ
- [ ] เปลี่ยน field ที่ dependency → options โหลดใหม่
- [ ] account/connection แสดงชื่อและ `★` ของ default
- [ ] ปุ่ม “ทดสอบ” ของ node ใช้ input ตัวอย่างและแสดงผลโดยไม่ต้องบันทึก workflow
- [ ] บันทึก workflow แล้ว `config.input` เป็น object ที่ merge ค่าล่าสุด; ค่าว่างถูกลบ
- [ ] node write/delete ไม่รันถ้าไม่ได้เปิด `allow`

## Quick Work / agents

- [ ] Quick Work แสดง family ของ connector ทั้ง 10 services จาก metadata
- [ ] การ์ด family แสดงจำนวน operations
- [ ] tool ของ connector ที่ติดตั้งมี setting เลือก connection (Google ใช้ account)
- [ ] Gmail / Sheets / Outlook เดิมยังใช้งานได้

## Console / storage

- [ ] ไม่มี error ใน browser console ระหว่างทำรายการข้างบน
- [ ] ไม่มี secret ใน `connections.json`, log, หรือข้อความ error
