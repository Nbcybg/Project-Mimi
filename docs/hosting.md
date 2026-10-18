# ย้าย Mimi ไปรันที่อื่น (เข้าจากมือถือได้ทุกที่)

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

## ต่อ PC agent เข้ากับ core ที่อยู่ที่อื่น

บน PC ของเรา ใส่ใน `.env`:

```
MIMI_CORE_URL=wss://<ที่อยู่ของ core>/ws
MIMI_TOKEN=<token เดียวกับ core>
ALLOWED_DIRS=C:\Users\<ชื่อ>\Documents
```

แล้วรัน `npm run pc-agent` และบน core ตั้ง `MIMI_LOCAL_PC_TOOLS=0` (Docker ตั้งไว้ให้แล้ว)
เพื่อให้คำสั่งบนเครื่องไปทำที่ PC แทนที่จะทำบน server

## เช็กลิสต์หลังย้าย

- [ ] เปิดหน้าเว็บจากมือถือได้ (HTTPS)
- [ ] ลองคุยกับ agent สักประโยค (คีย์โมเดลใช้ได้)
- [ ] กดกระดิ่ง 🔔 → "เปิดแจ้งเตือนเครื่องนี้" บนมือถือ แล้วลองส่งทดสอบ
- [ ] workflow ที่ตั้งเวลาไว้ยังเปิดอยู่ (ดูหน้า Agent → Workflow)
- [ ] ปิดแอปบนเครื่องเดิม เพื่อไม่ให้ trigger ทำงานซ้ำสองที่
- [ ] Google / Microsoft: ถ้าใช้ ให้ล็อกอินใหม่บนเครื่องใหม่ (token เก็บแยกเครื่อง)
