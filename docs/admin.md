# คู่มือผู้ดูแล Mimi (หลายผู้ใช้บน Railway)

ขั้นตอนตั้งระบบอยู่ใน [hosting.md](hosting.md) หัวข้อ "Railway: หลายผู้ใช้" ไฟล์นี้คือการดูแลหลังจากนั้น:
บัญชีผู้ใช้, เหตุการณ์ผิดปกติ, backup/กู้คืน, อัปเดต และค่าใช้จ่าย ผลทบทวนความปลอดภัยอยู่ที่ [security-review.md](security-review.md)

## ภาพรวม

```
อินเทอร์เน็ต ─HTTPS─> gateway (public, volume: บัญชี)
                        └─private network─> mimi-<คน> (core + volume ของคนนั้น) × N
```

- gateway เก็บแค่บัญชี/session/ที่อยู่และ token ของ core แต่ละคน (เข้ารหัสด้วย `MIMI_GATEWAY_SECRET`)
- ข้อมูลของผู้ใช้ (แชต ความจำ ไฟล์ คีย์ API, token Google/Microsoft) อยู่ใน volume ของ core ของคนนั้นเท่านั้น
- **ผู้ที่เข้า Railway ของโปรเจกต์นี้ได้ อ่านข้อมูลของทุกคนได้** จำกัดสมาชิก workspace ให้น้อยที่สุด เปิด 2FA ของบัญชี Railway

## บัญชีผู้ใช้

คำสั่งทั้งหมดรันใน service gateway (`railway ssh` แล้วเลือก gateway):

| ต้องการ | คำสั่ง (`node packages/core/src/cli/accounts.ts …`) |
|---|---|
| เพิ่มผู้ใช้ | `add <ชื่อ> --core http://mimi-<ชื่อ>.railway.internal:8080` แล้วทำตาม hosting.md (สร้าง service + ใส่ตัวแปรที่พิมพ์ออกมา) |
| ดูรายการ | `list` |
| ลืมรหัสผ่าน | `passwd <ชื่อ>` (ออกจากระบบทุกเครื่องด้วย) ส่งรหัสใหม่ทางช่องทางที่ปลอดภัย |
| พักการใช้ | `disable <ชื่อ>` / `enable <ชื่อ>` |
| เครื่องหาย | `logout <ชื่อ>` (ทุกเครื่องหลุดภายใน ~30 วินาที) |
| ย้าย core | `set-core <ชื่อ> <url>` |
| เปลี่ยน token ของ core | `rotate-core-token <ชื่อ>` แล้วใส่ใน service ของคนนั้น → redeploy |
| สำรองฐานข้อมูลบัญชี | `backup /app/user/backups/accounts-<วันที่>.db` |
| ลบผู้ใช้ | `disable` → ให้ผู้ใช้ดาวน์โหลด backup ของตัวเอง (ถ้าต้องการ) → ลบ service + volume ในหน้า Railway |

ผู้ใช้ใหม่: core ยังไม่มีผู้ให้บริการโมเดลและ agent — ผู้ใช้ใส่ API key ของตัวเองในหน้าตั้งค่า (key ที่ตั้งไว้ใน gateway ไม่ถูกแชร์)

## เหตุการณ์ผิดปกติ

| สถานการณ์ | ทำทันที | ตามด้วย |
|---|---|---|
| รหัสผ่านผู้ใช้รั่ว / เครื่องหาย | `passwd` หรือ `logout` | ให้ผู้ใช้ตรวจ workflow/trigger ที่ไม่ได้สร้างเอง, เปลี่ยนคีย์ API ที่เก็บไว้ |
| สงสัยว่า core ของใครถูกเจาะ (เช่น import workflow แปลก) | `disable` | ดู log ของ service นั้น, `rotate-core-token`, ให้ผู้ใช้เปลี่ยนคีย์ API/ยกเลิกการเชื่อม Google/Microsoft, กู้จาก backup ก่อนเหตุการณ์ |
| `MIMI_GATEWAY_SECRET` รั่ว | ตั้ง secret ใหม่ + `rotate-core-token` ทุกบัญชี (ใส่ใน core ทุกตัว) | ตรวจว่าใครเข้าถึง variables ได้ |
| `MIMI_GATEWAY_SECRET` หาย | gateway จะเปิดได้แต่ต่อ core ไม่ได้ | ตั้ง secret ใหม่ แล้ว `rotate-core-token` ทุกบัญชี (บัญชีและรหัสผ่านยังอยู่) |
| มีคนลองรหัสผ่านถี่ ๆ | ระบบพักเองอัตโนมัติ | ดู log `sign-in failed from <IP>`; ถ้าหนักมาก เปิด WAF / Under Attack Mode ของ Railway |
| แพ็กเกจมีช่องโหว่ | `npm audit` | อัปเดต lockfile, test, redeploy ทุก service |

## Backup และการกู้คืน

เป้าหมาย: เสียข้อมูลได้ไม่เกิน 24 ชั่วโมง (RPO) กลับมาใช้ได้ภายใน 1 ชั่วโมง (RTO)

สามชั้น เพราะชั้นเดียวไม่พอ (Railway: ล้าง volume = backup ของ volume นั้นหายด้วย และกู้ได้เฉพาะในโปรเจกต์เดิม):

| ชั้น | อะไร | ความถี่ / เก็บนาน | กันอะไร |
|---|---|---|---|
| 1. backup ในแอป | core ทำเองวันละครั้ง ที่ `/app/user/backups` (7 ชุดล่าสุด, มีค่าลับ) | ทุกวัน / 7 วัน | ผู้ใช้ลบ/แก้พลาด |
| 2. Railway volume backups | เปิดที่ service → Backups: **Daily + Weekly** สำหรับ gateway และทุก core | 6 วัน + 27 วัน | volume เสีย, deploy พลาด |
| 3. สำเนานอก Railway | admin ดาวน์โหลดสัปดาห์ละครั้ง (ด้านล่าง) เก็บในที่เข้ารหัส | ทุกสัปดาห์ / 3 เดือน | บัญชี Railway มีปัญหา, ลบโปรเจกต์พลาด |

สำเนานอก Railway (สัปดาห์ละครั้ง, จากเครื่องที่มี Railway CLI):

```
# gateway: สำเนาที่ถูกต้องขณะระบบทำงาน แล้วดาวน์โหลด
railway ssh   # เลือก gateway แล้วรัน:
node packages/core/src/cli/accounts.ts backup /app/user/backups/accounts-$(date +%F).db
railway volume files download /backups/accounts-<วันที่>.db ./mimi-backups/
# core ของแต่ละคน: ไฟล์ backup อัตโนมัติล่าสุด
railway volume files list /backups        # เลือก service ของคนนั้น
railway volume files download /backups/<ไฟล์ล่าสุด>-auto.tar.gz ./mimi-backups/<ชื่อ>/
```

เก็บ `MIMI_GATEWAY_SECRET` ในตัวจัดการรหัสผ่าน แยกจากไฟล์ backup · ไฟล์ backup ของ core มีคีย์ API ของผู้ใช้อยู่ด้วย ต้องเก็บแบบเข้ารหัส

กู้คืน:

| กรณี | วิธี |
|---|---|
| ผู้ใช้คนเดียวพลาด (ลบแชต/agent) | ชั้น 1: ทำตาม hosting.md "ย้ายข้อมูลเดิมขึ้น Railway" ข้อ 4–6 กับไฟล์ใน `/app/user/backups` (core หยุดชั่วคราว) |
| volume ของ core หรือ gateway เสีย | ชั้น 2: service → Backups → Restore → ดู staged changes → Deploy |
| โปรเจกต์ Railway หาย | สร้างใหม่ตาม hosting.md, คืนฐานข้อมูลบัญชีด้วย `railway volume files upload` ไปที่ `/data/accounts.db` (หยุด gateway ก่อน), ตั้ง `MIMI_GATEWAY_SECRET` ค่าเดิม, กู้ core แต่ละคนจากไฟล์ `.tar.gz` |

ซ้อมกู้คืนทุก 3 เดือน: สร้าง environment ทดสอบใน Railway แล้วกู้ gateway + core หนึ่งคนจากสำเนานอก Railway ล่าสุด จดเวลาที่ใช้

## อัปเดต

1. `npm run typecheck && npm test` บนเครื่อง
2. push → Railway build อิมเมจเดียวกันให้ทุก service (gateway และ core ใช้ Dockerfile เดียวกัน)
3. service ที่มี volume จะดับสั้น ๆ ตอน redeploy — อัปเดตนอกเวลาที่มีคนใช้, gateway เป็นตัวสุดท้าย
4. แอป Mac: `npm run build:mac` แล้วแจก zip ใหม่ (ยังไม่มีอัปเดตอัตโนมัติ)

## ค่าใช้จ่าย

### วัดจริงบน Railway (2026-10-29)

โปรเจกต์ `Mimi` service `mimi` (core คนเดียว, region sfo, volume 5 GB ที่ `/app/user`) วัดจากหน้า Metrics ของ Railway
ช่วง ~30 นาทีแรกหลัง deploy **core ยังว่าง** (ยังไม่ย้ายข้อมูลเดิม ไม่มี agent/workflow/แชต):

| ค่า | วัดได้ | คิดเป็น/เดือน |
|---|---|---|
| RAM | 0.11 GB ขณะว่าง, สูงสุด 0.17 GB (ตอนเริ่ม) | $1.10–1.70 |
| CPU | ~0 vCPU ขณะว่าง, สูงสุด 0.019 vCPU (ตอนเริ่ม) | < $0.05 |
| volume ที่ใช้จริง | 0.09 GB | ~$0.01 |
| egress | ~0 | ~$0 |
| **รวม** | | **~$1.2–1.8** (อยู่ในเครดิต $5 ของแผน Hobby) |

ยังต้องดูซ้ำ: หลังย้ายข้อมูลเดิมและใช้งานจริงสักสัปดาห์ ดูหน้า Usage ของ Railway (ยอดเงินจริงแยกตาม service) แล้วแก้ตารางนี้
— RAM จะขึ้นเมื่อมี agent, MCP server และแชตยาว ๆ

### ประเมินหลายผู้ใช้

ตัวเลขด้านล่างประเมินจากการวัด container บนเครื่อง (2026-10-27, ไม่มีงานเข้า) และราคา Railway
(RAM $10/GB/เดือน, CPU $20/vCPU/เดือน, volume $0.15/GB/เดือน, egress $0.05/GB) · RAM ของ core บน Railway ขณะว่างตรงกับช่วงที่วัดบนเครื่อง

| ส่วน | วัดได้ (ว่าง) | ใช้ประเมิน | ประมาณ/เดือน |
|---|---|---|---|
| gateway | RAM 41 MiB, CPU ~0% | 0.05 GB, CPU เฉลี่ย 1% | ~$0.70 |
| core ต่อคน | RAM 74–97 MiB (ยังไม่มี agent/ข้อมูล), CPU ~0% | 0.2 GB (มี agent, MCP, แชต), CPU เฉลี่ย 2% | ~$2.40 |
| volume ต่อคน | — | 0.5 GB รวม backup | ~$0.08 |
| egress | — | 1 GB/คน (แชต, ไฟล์แนบ) | ~$0.05 |

| จำนวนผู้ใช้ | การใช้ทรัพยากร | แผน Hobby ($5 รวมเครดิต $5) | แผน Pro ($20 รวมเครดิต $20) |
|---|---|---|---|
| 1 (คุณเอง) | ~$3.2 | $5 | $20 |
| 3 | ~$8.3 | ~$8.3 | $20 |
| 10 | ~$26 | ~$26 | ~$26 |

- **ค่าโมเดล AI (DeepSeek/Anthropic/Google) แยกต่างหากและมักเป็นค่าใช้จ่ายหลัก** แต่ละคนใช้คีย์ของตัวเอง ดูต่อคนได้ด้วย `npm run cost` ใน core หรือหน้าตั้งค่า → งบประมาณ
- ตั้ง Usage Limit ใน Railway (Workspace → Usage) เพื่อไม่ให้เกินงบ
- หลัง deploy จริง 1 เดือน: ดูหน้า Usage ของ Railway (แยกตาม service) แล้วแทนตัวเลขในตารางนี้ — RAM ของ core ที่ใช้งานจริงคือตัวแปรหลัก
