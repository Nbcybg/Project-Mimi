# ย้าย Mimi ไปรันที่อื่น (เข้าจากมือถือได้ทุกที่)

เอกสารที่เกี่ยวข้อง: [admin.md](admin.md) (ดูแลระบบ, backup, ค่าใช้จ่าย) · [user-guide.md](user-guide.md) (คู่มือผู้ใช้) · [security-review.md](security-review.md)

Mimi core เป็นโปรแกรม Node ตัวเดียว ข้อมูลทั้งหมดอยู่ในโฟลเดอร์ `user/` (กับ `mimi.json`)
ย้ายเครื่อง = ย้ายสองอย่างนี้ไป แล้วรัน `npm run serve` หรือ Docker

ตอนว่าง core ใช้ RAM ประมาณ 100 MB และแทบไม่ใช้ CPU งานหนักจริงคือเรียกโมเดล AI
ซึ่งเกิดที่ผู้ให้บริการ ไม่ใช่ที่เครื่องเรา เครื่องเล็ก ๆ (RAM 1 GB) ก็พอ

## เลือกแบบไหนดี

| แบบ | เหมาะกับ | ค่าใช้จ่าย | หมายเหตุ |
|---|---|---|---|
| **A. เครื่องที่บ้าน + Tailscale** (แนะนำ) | PC ที่เปิดทิ้งไว้ / mini PC | ฟรี | เข้าได้เฉพาะเครื่องเราเอง ไม่เปิดสู่อินเทอร์เน็ต ได้ HTTPS (ใช้ Push ได้) |
| **B. เครื่องที่บ้าน + Cloudflare Tunnel** | อยากได้ URL สวย ๆ ให้ webhook จากภายนอกยิงเข้ามาได้ | ฟรี (ต้องมีโดเมน) | เปิดสู่อินเทอร์เน็ต ป้องกันด้วย token ของ Mimi (+ Cloudflare Access ถ้าต้องการ) |
| **C. VPS + Docker** | ไม่อยากเปิดเครื่องที่บ้านตลอด | ~150–200 บาท/เดือน | ใช้ร่วมกับ A หรือ B ได้ |
| **D. Railway** | ไม่อยากดูแลเครื่องเอง ได้ HTTPS ทันที | ตามการใช้งาน (ดูหน้า Usage ของ Railway) | เปิดสู่อินเทอร์เน็ต ป้องกันด้วย token ของ Mimi; ต้องมี volume |

PC agent (`npm run pc-agent`) ยังรันบน PC ของเรา และต่อเข้า core ที่อยู่ที่อื่นได้
เครื่องมือที่แตะเครื่อง PC (run_shell, read_file …) จะไปทำงานบน PC

## ก่อนเริ่ม (ทุกแบบ)

1. ปิดแอปบนเครื่องเดิม แล้วสำรองข้อมูล: `npm run backup` (ได้ไฟล์ใน `backups/`)
2. ตั้ง token ให้ยาวและเดายาก ใส่ในไฟล์ `.env` บนเครื่องใหม่:
   ```
   MIMI_TOKEN=<สุ่มยาว ๆ อย่างน้อย 32 ตัวอักษร>
   MIMI_HOST=127.0.0.1
   ```
   สุ่ม token ได้ด้วย `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
3. ใส่ API key ของผู้ให้บริการโมเดลใน `.env` หรือในหน้า ตั้งค่า → คีย์ / ความลับ ของเครื่องใหม่
   (ค่าลับเก็บใน `user/data/secrets.json` ซึ่งเป็นของเครื่องนั้น ๆ)

## A. เครื่องที่บ้าน + Tailscale

1. ติดตั้ง Tailscale บนเครื่องที่รัน Mimi และบนมือถือ ล็อกอินบัญชีเดียวกัน
2. รัน Mimi บนเครื่องนั้นตามปกติ (`npm run serve` หรือ `npm run app`) โดยให้ `MIMI_HOST=127.0.0.1`
3. เปิด HTTPS ภายใน tailnet:
   ```
   tailscale serve --bg 8787
   ```
4. บนมือถือ เปิด `https://<ชื่อเครื่อง>.<tailnet>.ts.net/#token=<token>` ครั้งแรกครั้งเดียว
   แล้ว "เพิ่มไปยังหน้าจอหลัก" เพื่อใช้เป็นแอป และเปิด Push ได้ (ต้องเป็น HTTPS)

webhook จากบริการภายนอกจะเข้าไม่ได้ (เพราะไม่เปิดสู่อินเทอร์เน็ต) ถ้าต้องการ ใช้ `tailscale funnel` หรือแบบ B

## B. เครื่องที่บ้าน + Cloudflare Tunnel

1. มีโดเมนใน Cloudflare แล้วติดตั้ง `cloudflared`
2. สร้าง tunnel และชี้ไปที่ Mimi:
   ```
   cloudflared tunnel login
   cloudflared tunnel create mimi
   cloudflared tunnel route dns mimi mimi.example.com
   cloudflared tunnel run --url http://127.0.0.1:8787 mimi
   ```
3. เปิด `https://mimi.example.com/#token=<token>` บนมือถือ
4. แนะนำเพิ่ม Cloudflare Access (Zero Trust → Access → Application) ให้ล็อกอินด้วยอีเมลก่อนเข้าถึงหน้าเว็บ
   และยกเว้น path `/api/workflow/*` ถ้าใช้ webhook (webhook ตั้ง `x-mimi-secret` ได้ในหน้า workflow)

proxy ต้องส่ง header `Host` เดิมไปให้ Mimi (ค่าเริ่มต้นของ cloudflared และ tailscale serve ทำอยู่แล้ว)
ไม่อย่างนั้นหน้าเว็บจะต่อ WebSocket ไม่ได้

Mimi บล็อก IP ที่ใส่ token ผิดหลายครั้งอยู่แล้ว แต่ยังควรใช้ token ยาว ๆ เสมอ

## C. VPS + Docker

บนเครื่อง VPS (Ubuntu / Debian ที่มี Docker แล้ว):

```
git clone <repo ของคุณ> mimi && cd mimi
# คัดลอกโฟลเดอร์ user/ และ mimi.json จากเครื่องเดิมมาไว้ที่นี่ (หรือ restore จาก backup)
nano .env            # MIMI_TOKEN=..., API keys
docker compose up -d
```

- `docker-compose.yml` เปิดพอร์ตเฉพาะ `127.0.0.1:8787` แล้วค่อยเข้าผ่าน Tailscale (แบบ A) หรือ Cloudflare Tunnel (แบบ B)
  อย่าเปิดพอร์ต 8787 ตรง ๆ สู่อินเทอร์เน็ตโดยไม่มี HTTPS
- ข้อมูลอยู่ใน `./user` และ backup อัตโนมัติรายวันอยู่ใน `./backups` บนเครื่อง VPS
- อัปเดต: `git pull && docker compose up -d --build`
- ดู log: `docker compose logs -f mimi`

กู้ข้อมูลจากไฟล์ backup บน VPS (หยุด container ก่อน):

```
docker compose stop mimi
docker compose run --rm mimi node packages/core/src/cli/backup.ts restore /app/backups/<ไฟล์>.tar.gz
docker compose start mimi
```

## D. Railway

Railway build จาก `Dockerfile` ใน repo ให้เอง ได้โดเมน `https://<ชื่อ>.up.railway.app` พร้อม HTTPS (ใช้ Push ได้)
หัวข้อนี้คือแบบ **ผู้ใช้คนเดียว** ใช้ `MIMI_TOKEN` ตัวเดียว ถ้าจะให้หลายคนใช้ ดู "Railway: หลายผู้ใช้" ด้านล่าง

ข้อจำกัดที่ต้องรู้ก่อน:

- **instance เดียวเท่านั้น** ข้อมูลอยู่ใน SQLite บน volume และ scheduler/trigger รันใน process เดียว
  ถ้ามีสองตัว trigger จะทำงานซ้ำและ DB อาจเสีย (Railway ไม่ยอมให้ service ที่มี volume มี replica อยู่แล้ว
  แต่อย่าเปิด multi-region / replicas และอย่ารัน Mimi ตัวอื่นที่ใช้ข้อมูลชุดเดียวกัน)
- **volume ได้ตัวเดียวต่อ service** จึงเก็บ backup ไว้ใน volume เดียวกับข้อมูล (`/app/user/backups`)
  backup ชุดนี้กันพลาดในแอปได้ แต่กันไม่ได้ถ้า volume หาย ต้องมีสำเนานอก Railway ด้วย (ดูหัวข้อ backup ด้านล่าง)
- ตอน redeploy service ที่มี volume จะดับไปสั้น ๆ (Railway ต้องหยุดตัวเก่าก่อนต่อ volume กับตัวใหม่)
- `mimi.json` อยู่ในอิมเมจ แก้แล้วต้อง push + redeploy (ค่าที่ตั้งในหน้าแอปเก็บใน volume ไม่หาย)
- Railway ไม่อ่าน `railway.json` สำหรับ service ใหม่แล้ว (Config as Code เลิกใช้ ตัดจริง 2026-12-01)
  ค่าทั้งหมดด้านล่างจึงตั้งในหน้า Settings / Variables ของ service

### เช็กลิสต์ในบัญชี Railway (ผู้ใช้ทำเอง)

1. **New Project → Deploy from GitHub repo** เลือก repo ของ Mimi (Railway จะขึ้นว่า `Using detected Dockerfile!`)
2. **Variables** ของ service:
   | ตัวแปร | ค่า | หมายเหตุ |
   |---|---|---|
   | `MIMI_TOKEN` | สุ่มยาว ≥ 32 ตัวอักษร | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` ถ้าสั้นกว่า 32 core จะเตือนใน log |
   | `MIMI_HOST` | `0.0.0.0` | อิมเมจตั้งไว้แล้ว ใส่ซ้ำได้ |
   | `MIMI_LOCAL_PC_TOOLS` | `0` | อิมเมจตั้งไว้แล้ว: shell/ไฟล์ไปทำที่ PC agent ไม่ใช่บน server |
   | `MIMI_BACKUP_DIR` | `/app/user/backups` | **ต้องตั้ง** เพราะมี volume ตัวเดียว (ค่าเดิมของอิมเมจ `/app/backups` จะหายทุกครั้งที่ deploy) |
   | `MIMI_CLIENT_IP_HEADER` | `x-real-ip` | ให้การบล็อก token ผิดนับตาม IP จริงของผู้ใช้ ไม่ใช่ IP ของ proxy ของ Railway (ไม่ตั้ง = คนเดาผิด 10 ครั้งทำให้ทุกคนเข้าไม่ได้ 15 นาที) |
   | `MIMI_PUSH_CONTACT` | `mailto:<อีเมลของคุณ>` | บริการ Push บางเจ้าไม่รับค่าเริ่มต้น `mailto:mimi@localhost` |
   | `MIMI_TIMEZONE` | `Asia/Bangkok` | server ของ Railway เป็น UTC; ค่าเริ่มต้นของ Mimi คือ Asia/Bangkok อยู่แล้ว |
   | API key ของโมเดล | เช่น `DEEPSEEK_API_KEY` | หรือใส่ทีหลังในหน้า ตั้งค่า → คีย์ / ความลับ |

   **ไม่ต้อง** ตั้ง `PORT` (Railway ใส่ให้ และ Mimi ฟังพอร์ตนั้นเอง) และ **ไม่ต้อง** ตั้ง `RAILWAY_RUN_UID`
   (อิมเมจแก้สิทธิ์ของ volume ให้ผู้ใช้ `node` เองแล้วค่อยรัน ไม่ต้องรันเป็น root)
3. **Volume**: คลิกขวาที่ service → Attach volume → mount path **`/app/user`**
4. **Settings → Deploy**
   - Healthcheck Path: `/health` (ไม่ต้องใช้ token ตอบแค่ `{"ok":true,"version":…}`)
   - Restart Policy: On Failure
   - Replicas: 1 · ไม่เปิด multi-region
   - **ปิด Serverless / App Sleeping** ถ้าเปิด core จะหลับ แล้ว workflow ที่ตั้งเวลาไว้กับ trigger จะไม่ทำงาน
5. **Settings → Networking → Generate Domain** (Railway เลือกพอร์ตจาก `PORT` ให้เอง)
6. Deploy แล้วดู log ว่ามี `Mimi core listening on …` และ `File/shell tools need a connected PC agent`
7. เปิด `https://<ชื่อ>.up.railway.app/` ใส่ `MIMI_TOKEN` (หรือเปิด `…/#token=<token>` ครั้งเดียว — token อยู่หลัง `#` จึงไม่ถูกส่งไปที่ server หรือ log ของ Railway)
8. ทำตาม "เช็กลิสต์หลังย้าย" ท้ายไฟล์นี้ โดยเฉพาะ **ปิดแอปบนเครื่องเดิม** ไม่อย่างนั้น trigger จะทำงานซ้ำสองที่

### ตรวจแล้วบน Railway จริง (2026-10-29)

- build จาก `Dockerfile` ผ่าน (~2 นาที) log มี `Mimi core listening on http://localhost:8080` และ `File/shell tools need a connected PC agent`
- `/health` ผ่านโดเมน `*.up.railway.app` ได้ 200 · healthcheck ของ Railway ผ่าน
- header `Host` ผ่าน proxy ไม่เปลี่ยน: WebSocket ที่ `Origin` ตรงกับโดเมนได้ `welcome`, `Origin` อื่นถูกปฏิเสธตอน upgrade (401),
  ไม่มี `Origin` (แบบ PC agent) ต่อได้, token ผิดได้ close 4003
- private network: service อื่นในโปรเจกต์เรียก `http://mimi.railway.internal:8080/health` ได้ 200 ผ่าน IPv6 (`fd12:…`)
  เมื่อตั้ง `MIMI_HOST=::` และ `PORT=8080` (แนะนำให้ตั้งสองค่านี้กับ core ทุกตัว ใช้ได้ทั้งโดเมนสาธารณะและ private network)
- `MIMI_PUSH_CONTACT` ใส่เป็น `https://<โดเมน>` ได้ (VAPID รับ URL https) ถ้าไม่อยากใส่อีเมล
- ยังไม่ได้ตรวจ: Push บนมือถือจริง, การย้ายข้อมูลเดิม (ต้องใช้ Railway CLI)

### ย้ายข้อมูลเดิมขึ้น Railway (ยังไม่ได้ทดสอบกับบัญชีจริง)

`restore` จะไม่ยอมทำงานขณะ core เปิดอยู่ และบน Railway ตัว container ก็คือ core ที่เปิดอยู่ จึงต้องหยุดชั่วคราว:

1. บนเครื่องเดิม: ปิดแอป แล้ว `npm run backup` (ได้ไฟล์ `mimi-backup-….tar.gz`)
2. ติดตั้ง Railway CLI แล้ว `railway login` และ `railway link` ไปที่โปรเจกต์
3. อัปโหลดไฟล์เข้า volume: `railway volume files upload ./backups/<ไฟล์>.tar.gz /backups/<ไฟล์>.tar.gz`
   (path ใน volume เริ่มจาก `/` = `/app/user` ใน container)
4. ตั้ง Custom Start Command ของ service ชั่วคราวเป็น `sleep 3600` และลบ Healthcheck Path ออก แล้ว redeploy
5. `railway ssh` เข้าไปแล้วรัน `node packages/core/src/cli/backup.ts restore /app/user/backups/<ไฟล์>.tar.gz`
   (มันจะ backup สภาพปัจจุบันไว้ก่อนทับเสมอ)
6. ลบ Custom Start Command ใส่ Healthcheck Path `/health` กลับ แล้ว redeploy

### Backup บน Railway

- core ทำ backup อัตโนมัติวันละครั้ง เก็บ 7 ชุดล่าสุดใน `/app/user/backups` (มีค่าลับรวมอยู่ด้วย เก็บไฟล์ให้ดี)
- **ต้องมีสำเนานอก Railway**: ในแอป ตั้งค่า → "สำรอง / กู้คืนข้อมูล" กด "สำรองตอนนี้" แล้วดาวน์โหลด หรือ
  `railway volume files download /backups/<ไฟล์>.tar.gz ./` เป็นประจำ (เช่น สัปดาห์ละครั้ง)
- เปิด Backups ของ volume ในหน้า Railway ด้วย (ตามแผนที่ใช้อยู่) ใช้กู้ทั้ง volume เมื่อพลาดหนัก

### WebSocket, HTTPS, Push บน Railway

- Railway รับเฉพาะ HTTPS (HTTP ถูก redirect) และรองรับ WebSocket บน HTTP/1.1 โดยไม่ตัดตอนว่าง หน้าเว็บต่อ `wss://<โดเมน>/ws` เอง
- หน้าเว็บที่มาจากโดเมนอื่นต่อ WebSocket ไม่ได้ (Mimi เทียบ `Origin` กับ `Host`) ใช้โดเมนเดียวกับที่เปิดหน้าเว็บเสมอ
- Push ใช้ได้เพราะเป็น HTTPS · คีย์ VAPID อยู่ใน volume (`data/push-vapid.json`) จึงไม่เปลี่ยนเมื่อ redeploy
  มือถือที่เคยเปิดแจ้งเตือนกับ core เครื่องเดิม ต้องกดเปิดแจ้งเตือนใหม่กับโดเมน Railway
- PC agent: `MIMI_CORE_URL=wss://<ชื่อ>.up.railway.app/ws`

## Railway: หลายผู้ใช้ (gateway + core แยกต่อคน)

แต่ละคนมี **core ของตัวเอง เป็น Railway service แยก มี volume ของตัวเอง** ข้อมูลของแต่ละคนจึงอยู่คนละ container
และ **gateway** ตัวเดียวเป็นทางเข้าสาธารณะ: แสดงหน้าเว็บ, รับล็อกอิน (username + password), แล้วส่งต่อไปยัง core ของคนนั้น
ทาง private network ของ Railway ด้วย token ของ core ที่มีแต่ gateway รู้ ผู้ใช้สมัครเองไม่ได้ admin เป็นคนสร้างบัญชี

```
อินเทอร์เน็ต ──HTTPS──> gateway (public domain, volume: บัญชี) ──private network──> mimi-alice (core + volume)
                                                                          └──> mimi-bob   (core + volume)
```

ทำไมไม่รวมทุกคนไว้ใน core เดียว: ผู้ใช้เขียน expression ใน workflow, custom tool แบบ code/shell และ MCP ได้
ซึ่งรันโค้ดบน core ได้ ถ้าอยู่ใน process/เครื่องเดียวกันก็อ่านข้อมูลกันได้ แยก container จึงเป็นเส้นแบ่งที่ถือได้จริง

### ตั้ง gateway (ครั้งเดียว)

1. New service จาก repo เดียวกัน ตั้งชื่อเช่น `mimi-gateway`
2. Variables:
   | ตัวแปร | ค่า |
   |---|---|
   | `MIMI_MODE` | `gateway` |
   | `MIMI_GATEWAY_SECRET` | สุ่มยาว ≥ 32 ตัวอักษร (ใช้เข้ารหัส token ของ core ในฐานข้อมูลบัญชี) **ห้ามเปลี่ยน/ทำหาย** ไม่อย่างนั้น gateway จะอ่าน token ของ core ไม่ได้ ต้อง `rotate-core-token` ทุกบัญชี |
   | `MIMI_CLIENT_IP_HEADER` | `x-real-ip` |
   | `MIMI_SESSION_IDLE_DAYS` | ไม่ต้องตั้ง (ค่าเริ่มต้น 30: ไม่ได้ใช้ 30 วันต้องล็อกอินใหม่ ใช้อยู่เรื่อย ๆ ต่ออายุเอง) |
3. Volume ที่ `/app/user` (ฐานข้อมูลบัญชีอยู่ที่ `/app/user/data/accounts.db`)
4. Healthcheck `/health` · Replicas 1 · Generate Domain (gateway เป็น service เดียวที่มี public domain)

### เพิ่มผู้ใช้หนึ่งคน (admin)

1. สร้าง service ของ core ให้คนนั้น จาก repo เดียวกัน ชื่อเช่น `mimi-alice` แล้วผูก volume ที่ `/app/user`
   **ไม่ต้อง Generate Domain** (ห้ามมี public domain: ให้เข้าได้ทาง gateway เท่านั้น)
2. เข้า gateway แล้วสร้างบัญชี: `railway ssh` แล้วเลือก service `mimi-gateway` จากนั้น
   ```
   node packages/core/src/cli/accounts.ts add alice --core http://mimi-alice.railway.internal:8080
   ```
   พิมพ์รหัสผ่านให้เขา (ไม่แสดงบนจอ ≥ 10 ตัวอักษร) คำสั่งจะพิมพ์ตัวแปรของ core ออกมา **ครั้งเดียว**
3. ใส่ตัวแปรที่ได้ใน service `mimi-alice`: `MIMI_TOKEN=…`, `MIMI_HOST=::`, `MIMI_LOCAL_PC_TOOLS=0`, `MIMI_BACKUP_DIR=/app/user/backups`
   และตั้ง `PORT=8080` ให้ตรงกับ URL ในข้อ 2 (`MIMI_HOST=::` จำเป็นสำหรับ environment ของ Railway ที่สร้างก่อน 16 ต.ค. 2025 ซึ่ง private network เป็น IPv6 อย่างเดียว)
   ปิด Serverless/App Sleeping เหมือน core ปกติ
4. ส่ง URL ของ gateway + username + รหัสผ่านให้เขาทางช่องทางที่ปลอดภัย (ตอนนี้ผู้ใช้ยังเปลี่ยนรหัสผ่านเองไม่ได้ admin เปลี่ยนให้ด้วย `passwd`)

คำสั่ง admin อื่น ๆ (รันใน gateway เหมือนกัน):

```
node packages/core/src/cli/accounts.ts list                    # บัญชี, core, จำนวน session ที่เปิดอยู่
node packages/core/src/cli/accounts.ts passwd alice            # รหัสผ่านใหม่ (ออกจากระบบทุกเครื่อง)
node packages/core/src/cli/accounts.ts disable alice           # ระงับบัญชี (ตัดการเชื่อมต่อภายใน ~30 วินาที)
node packages/core/src/cli/accounts.ts enable alice
node packages/core/src/cli/accounts.ts logout alice            # ออกจากระบบทุกเครื่อง
node packages/core/src/cli/accounts.ts set-core alice <url>    # ย้าย core
node packages/core/src/cli/accounts.ts rotate-core-token alice # token ใหม่ของ core แล้วใส่ใน service นั้นแล้ว redeploy
node packages/core/src/cli/accounts.ts backup /app/user/backups/accounts-<วันที่>.db  # สำเนาฐานข้อมูลบัญชี
```

ลบผู้ใช้: `disable` ก่อน แล้วลบ service + volume ของเขาในหน้า Railway เอง (ลบแล้วกู้ได้ภายใน 48 ชั่วโมงตามนโยบายของ Railway)

### สิ่งที่ผู้ใช้เห็น

- หน้าเว็บของ gateway ขึ้นหน้า "เข้าสู่ระบบ Mimi" (ชื่อผู้ใช้ + รหัสผ่าน) จำ session ไว้จนกว่าจะออกจากระบบหรือไม่ได้ใช้ 30 วัน
- ตั้งค่า → บัญชี → "ออกจากระบบ" เพิกถอน session ที่เซิร์ฟเวอร์ด้วย (token เดิมใช้ไม่ได้อีก) แล้วตัด WebSocket ที่เปิดอยู่
- ล็อกอินผิดซ้ำ: 10 ครั้งจากที่อยู่เดียวใน 10 นาที หรือ 20 ครั้งต่อบัญชี (จากที่ไหนก็ได้) จะถูกพักไว้ 15 นาที
- URL ของ webhook จะขึ้นต้นด้วย `/h/<รหัสของบัญชี>/api/...` (หน้าแอปแสดงให้เองแล้ว)
- API key ของโมเดล: แต่ละคนใส่ของตัวเองในหน้าตั้งค่าของตัวเอง (key ที่ตั้งเป็นตัวแปรของ gateway ไม่ถูกแชร์)

### Backup และค่าใช้จ่าย

- backup ของแต่ละคนอยู่ใน volume ของ core ของคนนั้น (`/app/user/backups`) และดาวน์โหลดได้จากหน้าแอปของเขาเอง
- backup ฐานข้อมูลบัญชี: เปิด Backups ของ volume ของ gateway ในหน้า Railway (และเก็บ `MIMI_GATEWAY_SECRET` ไว้ในที่ปลอดภัยแยกต่างหาก)
- ทุก core เปิดตลอดเพื่อให้ trigger/workflow ทำงาน: ค่า RAM ประมาณ core ละ 100–200 MB บวก gateway อีกตัว ดูยอดจริงในหน้า Usage

### PC agent ในโหมดหลายผู้ใช้

ใช้แอป Mac (หัวข้อถัดไป) แล้วเปิด "ให้ Mimi ใช้เครื่องนี้" ที่ไอคอนบนแถบเมนู แอปจะเริ่ม PC agent ด้วย session ของคนที่ล็อกอินอยู่
และตัดทันทีเมื่อออกจากระบบ ถ้ารัน `npm run pc-agent` เอง ให้ใช้ session token เป็น `MIMI_TOKEN` และ
`MIMI_CORE_URL=wss://<โดเมนของ gateway>/ws` (session หมดอายุหรือออกจากระบบแล้ว PC agent จะถูกตัด)

## แอป Mac (ต่อเซิร์ฟเวอร์ ไม่เก็บข้อมูลในเครื่อง)

`npm run build:mac` สร้าง `dist/mac/Mimi.app` และ `dist/Mimi-<version>-mac-<arch>.zip` สำหรับแจกผู้ใช้
แอปนี้เป็นแค่หน้าต่างของเซิร์ฟเวอร์ (gateway หรือ core ตัวเดียว) **ไม่มี core ไม่มีฐานข้อมูล** แชต ความจำ ไฟล์ และคีย์อยู่บนเซิร์ฟเวอร์ทั้งหมด
(การรัน Mimi ทั้งตัวบนเครื่องตัวเองยังทำได้จาก source ด้วย `npm run app`; ลองแอปนี้จาก source ด้วย `npm run desktop`)

- เปิดครั้งแรก: ใส่ที่อยู่เซิร์ฟเวอร์ (ต้องเป็น `https://` ยกเว้นเซิร์ฟเวอร์ในเครื่องนี้) แล้วเข้าสู่ระบบด้วยหน้าล็อกอินของเซิร์ฟเวอร์
- จำการเข้าสู่ระบบด้วย Keychain ของ macOS (ผูกกับผู้ใช้ OS ที่ล็อกอินอยู่) จนกว่าจะออกจากระบบ
- **เครื่องนี้ไม่ใช่ของฉัน** (ติ๊กตอนเข้าสู่ระบบ): ไม่บันทึก token ปิดแอปเมื่อไร = ออกจากระบบที่เซิร์ฟเวอร์ด้วย
  (บนเว็บ ติ๊กเดียวกันนี้เก็บ token ใน sessionStorage: ปิดแท็บแล้วหายไป)
- เมนูที่ไอคอน Mimi บนแถบเมนู:
  - **ให้ Mimi ใช้เครื่องนี้ (PC agent)** ปิดเป็นค่าเริ่มต้น เปิดแล้ว agent บนเซิร์ฟเวอร์สั่งไฟล์/คำสั่ง/เบราว์เซอร์บนเครื่องนี้ได้ในชื่อผู้ใช้ OS นั้น
    เฉพาะโฟลเดอร์ที่อนุญาต (ค่าเริ่มต้น `~/Mimi-Workspace`; เลือกได้เฉพาะโฟลเดอร์ย่อยในโฮม ไม่รับโฮมทั้งหมด, `Library`, `.ssh`)
    คำสั่งที่เสี่ยงยังต้องกดอนุญาตในแชต · token ส่งให้ PC agent ทาง stdin ไม่อยู่ใน environment หรือรายการ process
  - **อนุญาตให้รันคำสั่งบนเครื่องนี้ (shell)** ปิดเป็นค่าเริ่มต้น: `run_shell`, ปิด/หยุดโปรแกรม, ปิดเครื่อง และ MCP server บนเครื่อง
    ทำงานด้วยสิทธิ์เต็มของผู้ใช้ OS (ไม่จำกัดโฟลเดอร์) จึงแยกให้เปิดเองอีกชั้น
  - **ออกจากระบบอัตโนมัติ** ปิดเป็นค่าเริ่มต้น เลือก 5/15/30/60 นาทีที่ไม่ได้ใช้เครื่องได้ (ล็อกหน้าจอเครื่องก็นับด้วย):
    เมื่อถึงเวลา = ออกจากระบบเต็มรูปแบบ ต้องใส่รหัสผ่านใหม่
  - เปลี่ยนเซิร์ฟเวอร์ / ออกจากระบบ / ออกจาก Mimi
- ภาพหน้าจอเบราว์เซอร์ของ agent ส่งขึ้นเซิร์ฟเวอร์เป็นไฟล์แนบของแชตทันที ไม่เขียนลงเครื่อง
- โปรไฟล์เบราว์เซอร์ของ agent แยกตามบัญชี Mimi และถูกลบตอนออกจากระบบ (เว็บไซต์ที่ agent ล็อกอินไว้ต้องล็อกอินใหม่ทุกครั้งหลังออกจากระบบ)
- ข้อมูลโปรไฟล์ที่เป็น "เฉพาะเครื่อง" (`localOnly`) อยู่ใน `data/profile-local.json` ของ core ของคนนั้นบนเซิร์ฟเวอร์ ไม่ได้อยู่บนเครื่องที่ใช้แอป

### แอปเก็บอะไรบนเครื่อง (macOS)

| ที่อยู่ | อะไร | ออกจากระบบแล้ว |
|---|---|---|
| `~/Library/Application Support/Mimi/config.json` | ที่อยู่เซิร์ฟเวอร์, ขนาดหน้าต่าง, ตัวเลือก PC agent / ออกจากระบบอัตโนมัติ (ไม่มีข้อมูลส่วนตัวหรือ token) | คงอยู่ (ล้างได้ด้วย "เปลี่ยนเซิร์ฟเวอร์") |
| `~/Library/Application Support/Mimi/session.bin` | token เข้ารหัสด้วย Keychain | ลบ |
| `~/Library/Application Support/Mimi/chromium/` | ไฟล์ทั่วไปของ Chromium (ค่าเริ่มต้น, GPU cache) ข้อมูลเว็บของหน้าต่างอยู่ในหน่วยความจำเท่านั้น | ล้างทุกครั้งที่แอปเริ่ม (ออกจากระบบ = แอปเริ่มใหม่) |
| `~/Library/Caches/Mimi/` | โปรไฟล์เบราว์เซอร์ของ agent (เมื่อเปิด PC agent) | ลบ |
| Keychain: "Mimi Safe Storage" | กุญแจที่ใช้เข้ารหัส `session.bin` (ไม่ใช่ข้อมูล) | คงอยู่ |
| โฟลเดอร์ที่อนุญาตให้ PC agent | ไฟล์ที่ agent เขียนตามที่สั่ง (ของผู้ใช้เอง) | คงอยู่ |

แอปเวอร์ชันเก่าที่รัน core ในเครื่องเก็บข้อมูลไว้ที่ `~/Documents/Mimi`, `~/Library/Application Support/Electron` และ `~/Library/Logs/Mimi.log`
แอปใหม่ไม่แตะที่เหล่านี้ ถ้าย้ายขึ้นเซิร์ฟเวอร์แล้วให้ `npm run backup` ก่อน แล้วลบเองเมื่อแน่ใจ

ยังไม่ได้ทำ: ลงนามด้วย Developer ID / notarize (ตอนนี้ลงนามแบบ ad hoc ครั้งแรกต้องคลิกขวา → Open), อัปเดตอัตโนมัติ

## แอป Windows (ต่อเซิร์ฟเวอร์ ไม่เก็บข้อมูลในเครื่อง)

`npm run build:win` (บน Windows) สร้าง `dist/win/Mimi/Mimi.exe` และ `dist/Mimi-<version>-win-x64.zip` เป็นแอปเดียวกับแอป Mac
(`packages/desktop/remote.cjs`): ไม่มี core ไม่มีฐานข้อมูล ทุกเมนูและตัวเลือกเหมือนหัวข้อ Mac ด้านบน ไอคอนอยู่ที่ถาดระบบมุมขวาล่าง
(`build:desktop` แบบเดิมที่รัน core บนเครื่องนี้ยังอยู่ สำหรับคนที่ไม่ใช้เซิร์ฟเวอร์)

- ติดตั้ง: แตก zip ไว้ในที่ถาวร (เช่น `%LOCALAPPDATA%\Programs\Mimi`) แล้วดับเบิลคลิก `install.cmd` ได้ทางลัดบน Desktop และ Start menu
- ยังไม่ได้ลงนาม: SmartScreen เตือนครั้งแรก กด "More info" → "Run anyway" · ไอคอนของไฟล์ `.exe` ยังเป็นของ Electron (หน้าต่างและถาดเป็นไอคอน Mimi)
- เก็บบนเครื่อง: `%APPDATA%\Mimi\config.json` (ที่อยู่เซิร์ฟเวอร์, ตัวเลือก), `%APPDATA%\Mimi\session.bin` (token เข้ารหัสด้วย DPAPI ของผู้ใช้ Windows นั้น),
  `%APPDATA%\Mimi\chromium\` (ล้างทุกครั้งที่เริ่ม), `%LOCALAPPDATA%\Mimi\` (โปรไฟล์เบราว์เซอร์ของ PC agent ลบตอนออกจากระบบ)
- PC agent เลือกโฟลเดอร์ได้เฉพาะในโฟลเดอร์ผู้ใช้ ค่าเริ่มต้น `%USERPROFILE%\Mimi-Workspace`

## มือถือ Android (ติดตั้งเป็นแอปจากเว็บ / PWA)

ไม่ต้องมีไฟล์ APK: เว็บของ Mimi ติดตั้งเป็นแอปบน Android ได้เลย ต้องเปิดผ่าน **HTTPS** (Railway, Tailscale, Cloudflare Tunnel)

1. เปิด `https://<โดเมนของ gateway หรือ core>/` ด้วย Chrome บน Android แล้วเข้าสู่ระบบ
   (เครื่องที่ใช้ร่วมกับคนอื่น: ติ๊ก "เครื่องนี้ไม่ใช่ของฉัน" แล้วไม่ต้องติดตั้งเป็นแอป)
2. เมนู ⋮ → **ติดตั้งแอป** (หรือ "เพิ่มลงในหน้าจอหลัก") ได้ไอคอน Mimi บนหน้าจอ เปิดแล้วเต็มจอไม่มีแถบเบราว์เซอร์
3. ในแอป กดกระดิ่ง 🔔 → **เปิดแจ้งเตือนเครื่องนี้** แล้วกด "ส่งทดสอบ"
   แจ้งเตือนมาถึงแม้ปิดแอปอยู่ (ส่งผ่านบริการ Push ของ Google ข้อความถูกเข้ารหัสจาก core ถึงเครื่องโดยตรง บริการกลางอ่านไม่ได้)
4. ออกจากระบบ (ตั้งค่า → บัญชี) = เลิกส่งแจ้งเตือนมาเครื่องนี้ด้วย และล้างข้อมูลของ Mimi ในแอป

สิ่งที่แอปบนมือถือเก็บ: token การเข้าสู่ระบบ (หรือไม่เก็บถ้าติ๊ก "เครื่องนี้ไม่ใช่ของฉัน") ตัวเลือกหน้าจอเล็กน้อย
และหน้า "ยังต่อเซิร์ฟเวอร์ Mimi ไม่ได้" ที่แสดงตอนไม่มีเน็ต (ไม่มีแชตหรือข้อมูลส่วนตัว) · core ส่ง Push ไปได้เฉพาะบริการบนอินเทอร์เน็ต
(ปลายทางที่ชี้เข้าเครือข่ายภายในของเซิร์ฟเวอร์ถูกปฏิเสธ)

ยังไม่ได้ทำ (ทำเมื่อต้องการ): ห่อเป็นแอปใน Play Store ด้วย TWA หรือ Capacitor · iPhone ติดตั้งได้แบบเดียวกันผ่าน Safari → แชร์ → "เพิ่มลงหน้าจอโฮม" (iOS 16.4 ขึ้นไปสำหรับ Push)

## ต่อ PC agent เข้ากับ core ที่อยู่ที่อื่น

บน PC ของเรา ใส่ใน `.env`:

```
MIMI_CORE_URL=wss://<ที่อยู่ของ core>/ws
MIMI_TOKEN=<token เดียวกับ core>
ALLOWED_DIRS=C:\Users\<ชื่อ>\Documents
```

แล้วรัน `npm run pc-agent` และบน core ตั้ง `MIMI_LOCAL_PC_TOOLS=0` (Docker ตั้งไว้ให้แล้ว)
เพื่อให้คำสั่งบนเครื่องไปทำที่ PC แทนที่จะทำบน server

### MCP server และคำสั่ง CLI ที่ต้องรันบน PC

เมื่อ core อยู่บนเครื่องอื่น ปกติ MCP server (แบบ stdio) และเครื่องมือชนิด shell จะรันบน server
ถ้าต้องการให้รันบน PC ของเรา (เช่น โปรแกรมที่ลงไว้เฉพาะในเครื่อง หรือ MCP server ในวง LAN บ้าน):

- Hub → เครื่องมือ → MCP: เลือก "รันที่" = `pc`
- Hub → เครื่องมือ → เครื่องมือแบบ shell: เลือก "รันที่" = `pc`

ตอนเรียกใช้ core ส่งคำสั่ง (และค่า `{{secret.NAME}}` ที่เติมแล้ว) ไปทางช่อง WebSocket ของ PC agent
จึงควรใช้ `wss://` หรือ Tailscale เท่านั้น · โฟลเดอร์ทำงานต้องอยู่ใน `ALLOWED_DIRS` ของ PC ·
ถ้า PC agent ไม่ได้เชื่อมอยู่ จะขึ้นว่า PC offline (รายการเครื่องมือเดิมยังเห็นอยู่)

### Browser, ไฟล์ และการควบคุมเครื่อง

เครื่องมือ `browser_*`, `list_dir`/`move_path`/`delete_path`, `power` ฯลฯ ทำงานที่ PC agent เช่นกัน ·
เบราว์เซอร์ของ agent ใช้โปรไฟล์แยกที่ `~/.mimi/browser-profile` (ปรับได้ด้วย `MIMI_BROWSER_PROFILE`,
เลือกโปรแกรมด้วย `MIMI_BROWSER_PATH`, ซ่อนหน้าต่างด้วย `MIMI_BROWSER_HEADLESS=1`,
อนุญาต localhost/LAN ด้วย `MIMI_BROWSER_ALLOW_LOCAL=1`) · ภาพหน้าจอเก็บใน `browser-screenshots/` ของโฟลเดอร์แรกที่อนุญาต ·
`wake_pc` (ปลุกเครื่องด้วย Wake-on-LAN) ส่งจาก core จึงต้องมี core ที่เปิดอยู่ตลอดในวง LAN เดียวกับเครื่องที่จะปลุก

## เช็กลิสต์หลังย้าย

- [ ] เปิดหน้าเว็บจากมือถือได้ (HTTPS)
- [ ] ลองคุยกับ agent สักประโยค (คีย์โมเดลใช้ได้)
- [ ] กดกระดิ่ง 🔔 → "เปิดแจ้งเตือนเครื่องนี้" บนมือถือ แล้วลองส่งทดสอบ
- [ ] workflow ที่ตั้งเวลาไว้ยังเปิดอยู่ (ดูหน้า Agent → Workflow)
- [ ] ปิดแอปบนเครื่องเดิม เพื่อไม่ให้ trigger ทำงานซ้ำสองที่
- [ ] Google / Microsoft: ถ้าใช้ ให้ล็อกอินใหม่บนเครื่องใหม่ (token เก็บแยกเครื่อง)
