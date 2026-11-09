# Spike: Tauri 2 แทน Electron (Mimi)

สถานะ: **Windows desktop ทำและวัดแล้ว · Android build APK ได้แล้ว แต่ยังไม่ได้รันและยังไม่ได้วัดอะไรบนเครื่อง (ไม่มีมือถือต่ออยู่)** (ดูหัวข้อ Android)
โค้ดอยู่ที่ `apps/tauri/` — ไม่แตะ server, `packages/ui`, `packages/desktop` (Electron), `android/` (Kotlin), `apps/windows/` (C#)

## สิ่งที่ spike นี้ทำ

เปลือก Tauri 2 ที่ทำหน้าที่เดียวกับ `packages/desktop/ui-protocol.cjs` + `main.cjs`:

- เสิร์ฟ `packages/ui` จากตัวแอป (`frontendDist` = `../../../packages/ui` ไม่ copy UI ซ้ำ) — server ไม่จ่าย UI
- เปิดหน้าด้วย `index.html#core=<origin>&token=<token>` (fragment ไม่ออกจากเครื่อง)
- ตั้ง `window.MimiShell` ด้วย `initialization_script` ก่อน script ของหน้าทำงาน → UI ยอมรับ core และเก็บใน `localStorage['mimi-core']`
- CSP ใน `src-tauri/tauri.conf.json` เทียบเท่า `ui-protocol.cjs` (ดูข้อสังเกตด้านล่าง)
- core + token: env `MIMI_CORE_URL` / `MIMI_TOKEN` ตอนรัน (desktop) หรือค่าที่ฝังตอน build (`option_env!`) — default `http://127.0.0.1:8787` ไม่มี token

ไฟล์: `src-tauri/src/lib.rs` (โค้ดทั้งหมด ~70 บรรทัด), `src-tauri/tauri.conf.json`, `package.json`

## วิธีรัน (Windows)

ต้องมี Rust (`winget install Rustlang.Rustup`) และ VS Build Tools (MSVC) — WebView2 มากับ Windows 11

```bash
cd apps/tauri
npm install
# core ทดสอบ (token ทดสอบเท่านั้น ห้ามใช้ token จริง)
#   MIMI_TOKEN=<ค่าทดสอบยาว >=32> MIMI_HOST=127.0.0.1 MIMI_PORT=8787 node packages/core/src/server/main.ts
export MIMI_CORE_URL=http://127.0.0.1:8787 MIMI_TOKEN=<ค่าทดสอบ>
npm run sync-ui                      # สร้าง packages/ui/vendor + icon.png (จำเป็นก่อน build/dev)
npx tauri build --debug --no-bundle  # หรือ: npx tauri build --no-bundle  (release)
src-tauri/target/release/mimi-tauri.exe
```

> **อย่าใช้ `tauri dev` เพื่อตรวจการเชื่อมต่อ** — เมื่อไม่มี `devUrl` CLI เปิด static server ที่ `http://127.0.0.1:1430`
> ซึ่งไม่อยู่ในรายการ origin ของ server (CORS) หน้าเลยขึ้น offline ทั้งที่ shell ถูกต้อง
> ใช้ `tauri build --debug --no-bundle` แทน (origin จริงคือ `http://tauri.localhost`)

`beforeBuildCommand` เรียก `npm run sync-ui` ให้อัตโนมัติตอน `tauri build`

## ผลตรวจ (Windows 11, Ryzen 5 4500, จอ 100 Hz)

| ข้อ | ผล |
|---|---|
| สถานะเชื่อมต่อ | **online** (`#conn`) บน `http://tauri.localhost` |
| `GET /health` | 200 · `GET /api/widget`, `/api/notifications` พร้อม Bearer = 200 · ไม่ส่ง token = 401 · `GET /` ของ server = 404 |
| WebSocket `/ws` จากหน้าแอป | เปิดได้ (origin ผ่านการตรวจของ server) |
| three.js | `import('three')` ผ่าน import map ได้ (REVISION 186, WebGL 2.0) · `@pixiv/three-vrm` โหลดได้ (53 exports) ภายใต้ CSP |
| แก้ UI / server | **ไม่ได้แก้เลย** |

## ตัวเลข Tauri vs Electron (desktop, รันสลับกัน 3 รอบ)

ทั้งสองต่อ core ตัวเดียวกัน, แชตทดสอบ 500 ข้อความ (seed ลง DB ทดสอบแยก ไม่ใช่ข้อมูลจริง), จอ 100 Hz

| ตัวชี้วัด | Tauri 2 (release) | Electron (รันจาก source, `main.cjs`) |
|---|---|---|
| เริ่มโปรเซส → online | 507 / 522 / 505 ms | 312 / 330 / 330 ms |
| RAM ส่วนตัว (private WS รวมทั้งต้นไม้โปรเซส) idle | 99–102 MB (7 โปรเซส) | 110–112 MB (4 โปรเซส) |
| RAM ส่วนตัว หลังโหลดแชต 500 ข้อความ | 141 / 143 / 141 MB | 160 / 159 / 175 MB |
| RAM ส่วนตัว ระหว่างฉาก 3D | 178 / 192 / 188 MB | 180 / 184 / 183 MB |
| Working set รวม (นับ shared ซ้ำ) idle | ~373–377 MB | ~348–351 MB |
| ฉาก 3D สังเคราะห์ 512k สามเหลี่ยม 10 วินาที | 99.9–100 fps, p99 10.3–10.4 ms, ไม่มีเฟรม >20 ms | 99.9–100 fps, p99 10.3–10.4 ms, ไม่มีเฟรม >20 ms |
| ขนาดโปรแกรม | `mimi-tauri.exe` 6.4 MB (รวม UI 7.1 MB ที่บีบแล้ว; ใช้ WebView2 ของระบบ) | `electron.exe` 235 MB (โฟลเดอร์ `dist` 369 MB) + `packages/desktop` |

อ่านผลอย่างระวัง:

- **3D เท่ากัน** เพราะทั้งสองเป็น Chromium (WebView2 = Chromium) บน Windows — ทั้งคู่ติดเพดาน vsync 100 Hz ฉากสังเคราะห์เบาเกินกว่าจะแยกความต่างได้
  ตัวเลขนี้**ไม่ได้บอกอะไรเรื่อง Android WebView**
- ฉาก 3D เป็น **ฉากสังเคราะห์** (TorusKnot 40 ชิ้น) ไม่ใช่ VRM จริง เพราะในโปรเจกต์ไม่มีไฟล์ `.vrm` ตัวอย่าง และผมไม่ได้ดาวน์โหลดจากภายนอกโดยไม่ได้รับอนุญาต
- เวลา online รวมเวลาที่สคริปต์วัดต่อ CDP เข้าไปถาม (เท่ากันทั้งสองฝั่ง) Tauri ช้ากว่า ~190 ms ในชุดนี้ — ไม่ได้ตรวจสาเหตุ (คาดว่าเป็นการสตาร์ต WebView2 แยกโปรเซส แต่ยังไม่ได้พิสูจน์)
- RAM: Tauri นับ 7 โปรเซส (msedgewebview2 หลายตัว) Electron 4 โปรเซส; "private WS" ต่ำกว่าเล็กน้อยใน Tauri แต่ "WS รวม" สูงกว่า สรุปว่า **ไม่ต่างอย่างมีนัย** (ต่างกัน ~10–20 MB บนฐาน ~100–180 MB)
  วัดด้วย `Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate` ของลูกหลานทั้งหมดของโปรเซสที่เปิด
- Electron ที่วัดคือรันจาก source (dev) ไม่ใช่ตัว packaged → ขนาดและเวลาเริ่มของ packaged อาจต่างเล็กน้อย
- ไม่ได้สร้าง installer (NSIS) เพราะ bundler ต้องดาวน์โหลดเครื่องมือเพิ่ม จึงไม่มีตัวเลขขนาด installer
- ไม่ได้วัดเทียบแอป Kotlin (แอป Kotlin ไม่มี WebView / VRM / ฉากเวที ตาม `android/README.md` จึงเทียบ 3D ตรง ๆ ไม่ได้)

## ปัญหาและข้อสังเกตที่เจอ

1. **CSP ของ Tauri เป็นค่าคงที่ต่อ build** — `ui-protocol.cjs` สร้าง CSP ตาม core ที่ใช้อยู่ตอนรัน (`connect-src` = core นั้น + ws) แต่ `tauri.conf.json` เป็นไฟล์ static
   ตอนนี้ใส่ `http://127.0.0.1:8787 ws://127.0.0.1:8787` ถ้าจะชี้ core อื่น (เช่น LAN) ต้องส่ง `--config` override ตอน build หรือเปิด `connect-src` กว้างขึ้น
   ทางออกถ้าต้องการ core เปลี่ยนได้ตอนรัน: ทำ custom protocol ใน Rust ที่เติม header เอง (แต่ origin ต้องอยู่ในรายการ CORS ของ server — ตอนนี้มีแค่ `tauri://localhost`, `http(s)://tauri.localhost`, `app://mimi`)
2. **import map ไม่ติด CSP** — Tauri ใส่ hash ของ inline script ให้เอง (ไม่ต้องทำมือแบบ `ui-protocol.cjs`) แต่ผลที่ได้มี hash ราว 40 ค่า (ทั้งที่มี inline script แค่ 2 ตัว) และ `'self'` ซ้ำ — กว้างกว่า Electron เล็กน้อย ยังไม่ได้หาสาเหตุ
3. `tauri dev` ไม่มี `devUrl` → origin ผิด (ดูด้านบน)
4. UI รับ token เฉพาะเมื่อมี `window.MimiDesktop` ถึงจะเก็บทันที; กรณี `MimiShell` อย่างเดียวจะเก็บหลัง `/health` ผ่านเท่านั้น (ทำงานถูกต้องตามออกแบบ)
5. `MimiShell` ที่ตั้งมีแค่ `{ platform: 'tauri' }` — ฟีเจอร์ของ Electron เช่น ถาดระบบ, เปิดตอนเปิดเครื่อง (`openAtLogin`), notification, workspace/browser window, updater, การคุม origin ของเมนู ฯลฯ **ยังไม่ได้พอร์ต** (ไม่อยู่ในขอบเขต spike)
6. build release ครั้งแรกใช้ ~3 นาที (LTO) ; `src-tauri/target` ~5.7 GB ต่อ build debug+release (อยู่ใน `apps/tauri/.gitignore`)

## Android

ติดตั้ง (ทั้งหมดอยู่ใน `P:Android` เพราะ C: เหลือน้อย): JDK 17 (winget `Microsoft.OpenJDK.17`, ลงที่ C:), Android cmdline-tools → platform-tools, platform 34, build-tools 34.0.0, NDK 27.2.12479018, Rust targets android 4 ตัว (`tauri android init` เพิ่มให้) และตอบรับ license ของ Android SDK ตอนติดตั้ง
ตัวแปรแวดล้อม (ตั้งเฉพาะตอนรันคำสั่ง ไม่ได้เขียนลงระบบ): `JAVA_HOME`, `ANDROID_HOME=P:AndroidSdk`, `NDK_HOME`, `GRADLE_USER_HOME=P:Androidgradle`

| ข้อ | ผล |
|---|---|
| `tauri android init` | ผ่าน (`src-tauri/gen/android`) |
| คอมไพล์ Rust เป็น arm64 (release) | ผ่าน 1 นาที 44 วินาที, `libmimi_tauri_lib.so` 7.5 MB |
| `tauri android build` | **ล้มที่ขั้น symlink** — Windows ไม่อนุญาตสร้าง symbolic link ถ้าไม่เปิด Developer Mode (เป็นการแก้ค่าระบบ ผมไม่ได้เปิด) |
| ทางเลี่ยงที่ใช้ | คัดลอก `.so` ไป `gen/android/app/src/main/jniLibs/arm64-v8a/` เอง แล้วรัน `gradlew :app:assembleArm64Release -x rustBuildArm64Release` → BUILD SUCCESSFUL 2 นาที 46 วินาที |
| ขนาด APK (arm64, release, **ยังไม่เซ็น**) | **9.2 MB** (9,195,110 bytes) — แอป Kotlin เดิม debug APK 24 MB ตาม `android/README.md` (คนละ build type เทียบตรง ๆ ไม่ได้) |
| ติดตั้ง/รันบนอุปกรณ์ | **ยังไม่ได้ทำ** — `adb devices` ว่าง ไม่มีมือถือ; emulator ใช้ไม่ได้บนเครื่องนี้ (README ของ Kotlin ระบุว่าไม่มี Hyper-V; ผมตรวจสถานะ feature ไม่ได้เพราะต้องสิทธิ์ admin) |
| เวลาเปิด→online, RAM (`dumpsys meminfo`), FPS/frame time, แชต 500 ข้อความ | **ไม่ได้วัด — ไม่มีตัวเลข** |

สิ่งที่แก้เฉพาะ Android:
- `gen/android/app/build.gradle.kts` บรรทัด 21: `usesCleartextTraffic` ของ release เป็น `"true"` (core บน LAN เป็น http/ws ไม่ใช่ https; ค่าเดิมคือ false) ก่อนใช้งานจริงต้องเปลี่ยนเป็น https หรือจำกัดด้วย network security config
- CSP ของ build นี้ override ผ่าน `--config` ให้ `connect-src` ชี้ `http://192.168.0.119:8787 ws://...` (IP LAN ของเครื่องนี้ตอน build; ไม่ได้อยู่ใน `tauri.conf.json`)
- core และ token ทดสอบฝังตอน build ผ่าน env `MIMI_CORE_URL` / `MIMI_TOKEN` (APK นี้จึงมี token ทดสอบอยู่ข้างใน ห้ามแจกจ่าย)
- APK ยังไม่เซ็น จึงติดตั้งไม่ได้จนกว่าจะเซ็น (เช่น `apksigner` กับ debug keystore) ; package id `app.mimi.tauri` ต่างจาก Kotlin (`app.mimi.android`) จึงติดตั้งคู่กันได้ ไม่ทับ

### APK ที่เซ็นแล้ว (ติดตั้งเองบนมือถือได้)

**รอบที่ 4 (ผู้ใช้ทดลองบนมือถือ: header ของ Android ทับ UI, ปุ่ม back ไม่กลับ, ไม่มีแจ้งเตือนเมื่อข้อความจบ)** — แก้ใน `gen/android/.../MainActivity.kt` ตามสัญญาที่ `packages/ui` มีกับ shell Android อยู่แล้ว (ไม่แก้ UI):
- Insets: Android 15+ บังคับ edge-to-edge; UI จองที่เฉพาะที่ใช้ `env(safe-area-inset-*)` ส่วนหัวแชตเลยอยู่ใต้ status bar. shell เติม padding ตามขนาด status/navigation bar, รอยบาก และคีย์บอร์ด (พื้นหลังแถบ = #171215 สีธีมมืดของ UI)
- ปุ่ม Back: เรียก `window.__mimiBack()` ของ UI (ปิด popup บนสุด / จากแชตกลับรายการ); ถ้าไม่เหลืออะไรให้ย่อแอปไป background. หน้าเชื่อมต่อใช้ `location.replace` ไม่ทิ้งประวัติให้ Back วนกลับมา
- แจ้งเตือน: ทำ `window.MimiAndroid.notify(...)` เป็นแจ้งเตือนระบบ (ช่อง "ข้อความและการแจ้งเตือน", ข้อความเดิมของแชตเดียวกันแทนที่กันไม่ซ้อน), ขอสิทธิ์ POST_NOTIFICATIONS (Android 13+) ตอนส่งข้อความ. เรียก `__mimiWake` ตอนกลับเข้าแอป
- ข้อจำกัดที่ยังไม่แก้: แจ้งเตือนเกิดได้เฉพาะตอนแอปยังมีการเชื่อมต่อ WebSocket อยู่ — แอปที่ถูกพักเบื้องหลังนานหรือถูกระบบปิดจะไม่ได้รับ (แอป Kotlin เดิมใช้ FCM + WorkManager; Tauri ยังไม่มีส่วนนี้) และแตะแจ้งเตือนแล้วเปิดแอปเฉยๆ ยังไม่พาไปแชตนั้น (UI ไม่มี hook ให้เปิดแชตจากภายนอก)
- build ผ่าน (compile Kotlin สำเร็จ, APK เซ็นแล้ว, มี POST_NOTIFICATIONS) แต่ **ยังไม่ได้ทดสอบบนมือถือ** (ไม่มี adb device)

**รอบที่ 5 (ผู้ใช้ทดสอบรอบ 4 แล้วโอเค; เน้น Android: แจ้งเตือนเบื้องหลัง + ไมค์/กล้อง/ไฟล์แนบ)** — ผู้ใช้ตัดสินใจว่าแอป Kotlin เดิมไม่ต้องอัปเดตต่อ (ไม่จำเป็นต้องใช้) ถ้า Tauri ใช้แทนได้
- ไมค์/กล้อง/ไฟล์แนบ: runtime ของ Tauri (wry) จัดการ `getUserMedia`, file chooser และ `capture` ให้อยู่แล้ว แต่ manifest ไม่มีสิทธิ์ ระบบจึงปฏิเสธ — เพิ่ม `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`, `CAMERA` (uses-feature required=false) ระบบจะถามตอนใช้ครั้งแรก
- แจ้งเตือนเบื้องหลัง: `WebView.onPause()` หยุด JavaScript ของหน้าตอนแอปไปเบื้องหลัง จึงทำฝั่ง native: `NotifyService` (foreground service ชนิด specialUse มีแจ้งเตือนเงียบ ๆ ค้างอยู่) ต่อ WebSocket `/ws` ไป core ด้วย OkHttp ด้วย token เดียวกับที่ล็อกอิน (UI รายงานผ่าน `MimiAndroid.signedIn`; shell.js รายงานให้เองสำหรับ token ที่จำไว้จากรอบก่อน) และยิงแจ้งเตือนระบบเมื่อได้ frame `notification` ขณะแอปไม่อยู่หน้าจอ (ตอนอยู่หน้าจอให้หน้าเว็บยิงเอง id เดียวกันจึงไม่ซ้อน). หยุดเมื่อออกจากระบบหรือ core ปฏิเสธ token (close 4003)
- ตั้ง `allowBackup=false` เพื่อไม่ให้ token ใน SharedPreferences ถูกสำรองขึ้นคลาวด์ของ Google; token เก็บใน SharedPreferences ส่วนตัวของแอปแบบไม่เข้ารหัส (spike)
- ข้อจำกัด: ไม่รอดการรีบูตหรือเมื่อระบบฆ่าแอป (แอป Kotlin เดิมใช้ FCM + WorkManager polling), แตะแจ้งเตือนเปิดแอปแต่ยังไม่พาไปแชตนั้น, Android 15 จำกัดเวลา foreground service บางชนิด (specialUse ไม่จำกัดเวลาเหมือน dataSync แต่ผู้ผลิตบางรายฆ่าแอปเบื้องหลังเอง)
- build ผ่านและเซ็นแล้ว แต่ **ยังไม่ได้ทดสอบบนมือถือ** และ **ยังไม่ได้วัดตัวเลข RAM/FPS/เวลาเปิด** (ยังไม่มี adb device)

**รอบที่ 6 (ผู้ใช้เห็น "กำลังเชื่อมต่อ" ขึ้นซ้ำ ๆ)** — เป็นข้อบกพร่องใน `packages/ui/app.js` (ไม่เกี่ยวกับ shell): ตัวตรวจ heartbeat ส่ง ping ทุก 25 วินาที แต่ตัดการเชื่อมต่อถ้าไม่ได้ยินอะไรเกิน 18 วินาที (สั้นกว่ารอบ ping) การเชื่อมต่อที่ว่างอยู่จึงถูกปิดแล้วต่อใหม่ **ทุกรอบ ~25 วินาที** วัดบน desktop: offline ที่ 18.4 / 43.5 / 68.4 วินาที (รอบละ ~1 วินาที); log HTTP ของ Railway ตรงกัน (WebSocket ของมือถืออายุ 5–33 วินาทีซ้ำ ๆ). แก้ (เปลี่ยนน้อยที่สุด): ถือว่าเสียก็ต่อเมื่อพลาดเกินสองรอบ (`STALE_MS = 55000`) — หลังแก้ idle 130 วินาทีไม่หลุดเลย. ที่ shell เพิ่ม: กล่อง "กำลังเชื่อมต่อ…" ขึ้นเมื่อ offline นานเกิน 4 วินาที ไม่โผล่ทุกครั้งที่ reconnect สั้น ๆ. Electron และเว็บใช้ UI ตัวเดียวกันจึงเคยโดนเหมือนกัน (ยังไม่ได้ push การแก้นี้)

ไฟล์: `apps/tauri/out/mimi-tauri-spike-arm64.apk` (9.3 MB, arm64, minSdk 24, package `app.mimi.tauri`, เซ็น v2/v3 ด้วย keystore ทิ้งได้ที่ `P:Androidspike-debug.keystore` นอกโปรเจกต์ — ไม่ใช่กุญแจ release)
ติดตั้ง: คัดลอกไปมือถือแล้วเปิด (อนุญาต "ติดตั้งจากแหล่งที่ไม่รู้จัก") หรือ `adb install -r mimi-tauri-spike-arm64.apk`

**APK รอบที่ 2 ไม่ฝัง core/token แล้ว** (รอบแรกฝัง `192.168.0.119:8787` + token ทดสอบ ทำให้คนใช้เชื่อมต่อไม่ได้ กรอกรหัสผ่านแล้วไม่เกิดอะไร และ UI ไม่มีที่ให้เปลี่ยนเซิร์ฟเวอร์ — ข้อบกพร่องของ spike ไม่ใช่ของ UI)
ตอนนี้ shell มีหน้าเชื่อมต่อของตัวเอง (`src/connect.html`, custom scheme `mimiconnect`, ไม่ใช้ IPC) แบบเดียวกับ `packages/desktop/connect.html`:
1. เปิดแอปครั้งแรก → หน้า "เชื่อมต่อเซิร์ฟเวอร์ Mimi" ใส่ที่อยู่ core (คลาวด์ `https://…` หรือ LAN `http://192.168.x.x:8787`; พิมพ์ไม่มี scheme ได้ — IP/localhost/.local ถือเป็น http นอกนั้น https)
2. ที่อยู่เก็บใน app data ของแอป (`core.txt`) ครั้งต่อไปเข้า UI เลย
3. ใส่รหัสผ่านที่หน้า sign-in ของ UI เอง (shell ไม่เห็น/ไม่เก็บรหัสผ่าน)
4. ปุ่ม "เปลี่ยนเซิร์ฟเวอร์" (ของ shell ฉีดเข้าหน้า ไม่ได้แก้ UI) ขึ้นที่มุมซ้ายล่างเมื่อ UI ไม่ online หรือเปิดหน้า "ตั้งค่า" → กลับไปหน้าเชื่อมต่อ
5. CSP `connect-src` ถูกเติม core ที่เลือก + ws(s) ตอนรัน (hook `on_web_resource_request`) — แก้ข้อจำกัด "CSP static" ข้างบนแล้ว; ไม่ต้องฝัง IP ใน `tauri.conf.json` อีก
บน desktop ยังตั้ง `MIMI_CORE_URL` / `MIMI_TOKEN` ตอนรันเพื่อพัฒนาได้ (ที่อยู่ที่เก็บไว้มาก่อน env)

ทดสอบแล้วบน Windows (CDP): ไม่มี core → หน้าเชื่อมต่อ; ที่อยู่ `ftp://x`/ว่าง ถูกปฏิเสธ (400); พิมพ์ `localhost:8787` → เก็บเป็น `http://localhost:8787` เข้า UI สถานะ online; CSP มี `http://localhost:8787 ws://localhost:8787`; รหัสผิด → "รหัสผ่านไม่ถูกต้อง", รหัสถูก → online; ปุ่มเปลี่ยนเซิร์ฟเวอร์พากลับหน้าเชื่อมต่อพร้อมค่าเดิม
**ยังไม่ได้ทดสอบบน Android WebView** (ไม่มีเครื่อง): custom scheme `http://mimiconnect.localhost`, การเขียนไฟล์ app data และ hook CSP บน Android ยังไม่ยืนยัน

**รอบที่ 3 (หลังผู้ใช้ต่อ cloud แล้ว "ไม่ขึ้นให้ใส่ password / แจ้งไม่ได้เชื่อมต่อ")**: UI เปิดหน้า sign-in เฉพาะตอนไม่มี token ค้างในเครื่อง และ `/health` ที่ล้มเงียบ ๆ (เช่น CORS) ไม่แสดงอะไร — สาเหตุจริงบนมือถือของผู้ใช้ **ยังไม่ทราบ** (ไม่มีเครื่อง/URL ให้ตรวจ) ที่ทำเพิ่มใน shell (`src/shell.js`, ไม่แก้ UI):
- เลือกเซิร์ฟเวอร์ที่หน้าเชื่อมต่อ → ล้าง token/webhook ที่จำไว้ (`#fresh=1`) เพื่อให้หน้า sign-in ขึ้นเสมอและไม่เอารหัสผ่านของเซิร์ฟเวอร์เก่าไปลองกับเซิร์ฟเวอร์ใหม่
- เมื่อ UI offline เกิน 5 วินาที แถบด้านล่างบอกสาเหตุ: ติดต่อไม่ได้ / server ตอบแต่ไม่อนุญาต origin `http://tauri.localhost` (CORS) / ติดต่อ HTTP ได้แต่ WebSocket ไม่ได้ (token เก่า หรือพร็อกซีไม่รับ WS) / CSP บล็อก — พร้อมปุ่ม "เปลี่ยนเซิร์ฟเวอร์" และ "ล้างการเข้าสู่ระบบ"
- ทดสอบบน Windows แล้ว 3 กรณี (ติดต่อไม่ได้, ไม่มี CORS, token เก่าค้าง) ; บน Android ยังไม่ได้ทดสอบ
- ข้อสงสัยหลัก: server บน cloud อาจเป็นเวอร์ชันก่อนเพิ่มรายการ origin ของ Tauri (`packages/core/src/server/cors.ts`) ต้อง deploy เวอร์ชันปัจจุบัน หรือตั้ง `MIMI_ALLOWED_ORIGINS=http://tauri.localhost`

ไฟล์: `apps/tauri/out/mimi-tauri-spike-arm64.apk` (9.3 MB เซ็นแล้ว ตรวจไม่มีสตริง token/IP ทดสอบในไลบรารี) — core ที่ใช้ต้องเข้าถึงได้จากมือถือ: LAN ต้องให้ core ฟัง `MIMI_HOST=0.0.0.0` และเปิดพอร์ตใน Windows Firewall (ยังไม่ได้เปิดให้ — ต้องทำเอง); release APK เปิด cleartext HTTP ไว้เพื่อ LAN (ดูด้านบน)

วิธีวัดเมื่อมีมือถือ: เปิด USB debugging, ต่อ USB, ให้ core ฟังที่ `MIMI_HOST=0.0.0.0` (และอนุญาตพอร์ตใน firewall), มือถืออยู่ Wi‑Fi เดียวกับเครื่องนี้, เซ็น APK แล้ว `adb install`, วัดด้วย `adb shell dumpsys meminfo app.mimi.tauri`, `dumpsys gfxinfo`, และ `chrome://inspect` (WebView ของ debug build เท่านั้นที่ inspect ได้)

## ยังไม่ได้ทำ (ไม่มีตัวเลข ห้ามเดา)

- **Android: การรันและการวัดทุกอย่างบนอุปกรณ์** (ดูหัวข้อ Android) — ไม่มีมือถือ ไม่มีตัวเลขเวลา/RAM/FPS
- VRM จริง (ต้องมีไฟล์ `.vrm`) และการวัด FPS ด้วย VRM
- installer (NSIS) และ Electron แบบ packaged
- ฟีเจอร์ระดับเปลือกที่ยังไม่ได้พอร์ต: updater, หน้าต่างเบราว์เซอร์ในตัว, หน้าต่าง Workspace (ดูตารางข้างล่าง)

## ย้าย Electron → Tauri: สถานะฟีเจอร์เปลือก (desktop)

โค้ดอยู่ใน `src-tauri/src/desktop.rs` (เฉพาะ desktop, Android ไม่ถูกแตะ) และ `shell.js`

| ฟีเจอร์ของ `packages/desktop/main.cjs` | สถานะ | ตรวจแล้วอย่างไร |
|---|---|---|
| กดปิดหน้าต่าง = ซ่อน (แอปอยู่ต่อ) | ทำแล้ว | ส่ง WM_CLOSE → process ยังอยู่ หน้าต่างไม่แสดง |
| ถาดระบบ + เมนู (เปิดแชต/Agent/Hub/ตั้งค่า/ซ่อนเมื่อคลิกที่อื่น/อยู่บนสุด/ออก) + คลิกซ้ายสลับแสดง/ซ่อน | ทำแล้ว (ยังไม่ได้ลองกดเมนูด้วยมือ) | พบหน้าต่าง `tray_icon_app` ของแอป; ยังไม่ได้เห็นไอคอนและยังไม่ได้กดแต่ละเมนู |
| เปิดซ้ำ = แสดงหน้าต่างเดิม | ทำแล้ว | เปิดตัวที่สอง → ตัวที่สองออก ตัวแรกยังแสดงหน้าต่าง |
| จำขนาด/ตำแหน่ง/สวิตช์ในเมนูถาด | ทำแล้ว | `window-state.json` ถูกเขียน; ครั้งแรกวางมุมขวาล่างของ work area |
| เริ่มพร้อมเครื่อง (`MimiShell.openAtLogin/setOpenAtLogin`) | ทำแล้ว | สวิตช์ในตั้งค่า "แอปและระบบ" เปิด/ปิดได้ เขียน/ลบ registry Run (ทดสอบแล้วคืนค่าเดิม) |
| ลิงก์ภายนอกเปิดในเบราว์เซอร์ระบบ | ทำแล้ว | `window.open` ถูกปฏิเสธและลิงก์ไม่พาหน้าต่างแอปออกจากแอป; ยังไม่ได้ยืนยันด้วยตาว่าเบราว์เซอร์เด้งขึ้นมา |
| แจ้งเตือนเดสก์ท็อป | ทำแล้ว (ไม่มีการกดแล้วเปิดแชต) | Web Notification ถูกปฏิเสธใน WebView จึงครอบด้วย toast ของระบบ; เห็น toast จริงในภาพหน้าจอ |
| เมนูคลิกขวาเฉพาะข้อความ (ตัด/คัดลอก/วาง) | ทำแล้ว | ส่ง event จำลอง: พื้นที่ทั่วไปถูกกัน, ช่องพิมพ์และข้อความที่เลือกแสดงเมนู (ยังไม่ได้กดคลิกขวาด้วยมือ) |
| ปิด pinch zoom | ยังไม่ได้ทำ | — |
| **PC agent** (`remote.cjs` รัน `packages/pc-agent` ~8.5k บรรทัด TypeScript ผ่าน Node ใน Electron: เครื่องมือไฟล์/shell/เบราว์เซอร์/คอมพิวเตอร์ของ agent บน cloud) | ทำแล้วบางส่วน (`src/pcagent.rs`) — ทางที่เลือก: **Node เป็น sidecar** | ตรวจแล้ว: เปิดใช้ → agent เชื่อม core ทดสอบได้ (`pcOnline:true`), ออกจากระบบ → หยุด, เข้าสู่ระบบอีกครั้ง → เริ่มใหม่, ฆ่าแอปกะทันหัน → agent ไม่ค้าง. **ยังไม่ได้ตรวจ**: กล่องขออนุญาตตอน agent จะแก้ไฟล์/รันคำสั่ง, เมนูถาด (เปิด/ปิด, shell, เลือกโฟลเดอร์), การเริ่มใหม่เมื่อ agent ตายเอง. **แนบไปกับตัวติดตั้งแล้ว** (`npm run installer` ใน `apps/tauri`: `scripts/stage-agent.mjs` + `src-tauri/tauri.installer.conf.json`, ใช้ตัวช่วยเดียวกับ build ของ Electron/native) — ดูหัวข้อ "ตัวติดตั้ง" ข้างล่าง |
| ความต่างจาก Electron ใน PC agent | ตั้งใจ | Electron เปิดไว้ตั้งแต่เริ่ม (ค่าเริ่มต้น on) — Tauri เริ่ม **ปิด** จนกว่าจะเปิดในเมนูถาดและกดยืนยัน; session มาจาก localStorage ของ UI (ไม่ใช้ keychain ของระบบเหมือน `remote.cjs`) |
| เบราว์เซอร์ในตัว (`browser-shell.cjs`) | ยังไม่ได้ทำ | PC agent สั่งผ่าน DevTools (`Target.createTarget/closeTarget`, `Browser.setDownloadBehavior`) — ต้องทดลองว่า WebView2 รองรับก่อน และต้องมี PC agent ก่อนถึงจะถูกเรียกใช้ |
| หน้าต่าง Workspace (+ terminal ผ่าน node-pty) | ยังไม่ได้ทำ | ต้องใช้ pty (Rust: `portable-pty`) และ UI ของ workspace เดิม |
| ตัวอัปเดต (`updater.cjs`) | ยังไม่ได้ทำ | — |
| เชื่อม core ในเครื่อง (launcher) / `process.send` IPC | ยังไม่ได้ทำ | ตอนนี้ Tauri ต่อ core ผ่านหน้าเชื่อมต่อหรือ `MIMI_CORE_URL` |

หมายเหตุ: ชื่อแอปใน toast ตอนรัน debug เป็น "Windows PowerShell" (ยังไม่ได้ติดตั้งเป็นแอปจริง) และ build ครั้งแรกล้มเพราะดิสก์ P: เต็ม (ต้องลบแคช `target/debug/incremental`)

## ตัวติดตั้ง Windows (NSIS) พร้อม Node + PC agent

`cd apps/tauri && npm run installer` → `<target>/release/bundle/nsis/Mimi Tauri Spike_0.0.1_x64-setup.exe` (ถ้า P: ไม่พอให้ตั้ง `CARGO_TARGET_DIR` ไปไดรฟ์อื่น; ตัวที่ build ไว้คัดลอกมาที่ `apps/tauri/out/`)

| วัดแล้ว | ค่า |
|---|---|
| ขนาดตัวติดตั้ง | 28.75 MiB (SHA-256 183CBD10…8290F) |
| ติดตั้งแล้วบนดิสก์ | ~125 MB (node.exe 88 MB + โค้ด agent + `mimi-tauri.exe` 7.4 MB) |
| เทียบ Electron | ไดเรกทอรี dist ~369 MB (วัดก่อนหน้า) — Tauri + Node ราว 1/3 แต่ **ไม่ใช่ 6.4 MB** ที่วัดตอน spike เพราะต้องพก Node |

ตรวจแล้ว: ติดตั้งแบบเงียบ (`/S /D=...`) → โครง `agent/{node,pc-agent,shared,node_modules}` อยู่ข้าง exe; รันตัวที่ติดตั้ง **โดยซ่อน Node ของเครื่องออกจาก PATH** → agent เปิดจาก `agent
ode
ode.exe` + `agentpc-agentsrcmain.ts` และเชื่อม core ทดสอบได้ (`pcOnline:true`); ฆ่าแอป → agent ไม่ค้าง; ถอนการติดตั้งแล้วไม่เหลือรายการใน registry (Uninstall/Run)

ยังไม่ได้ตรวจ: Node x64 ของ build เครื่องนี้ใช้กับเครื่อง arm64 ไม่ได้; ตัวติดตั้งยังไม่เซ็นรหัส (SmartScreen จะเตือน); ไม่มีตัวอัปเดตอัตโนมัติ; ชื่อ/ไอคอนเป็นของ spike (`Mimi Tauri Spike`)

## ข้อเสนอ (เฉพาะส่วนที่มีหลักฐาน)

**Windows/desktop: Tauri ใช้แทน Electron ได้ในแง่ที่วัดแล้ว** — UI เดิมทำงานโดยไม่แก้โค้ด, เชื่อม core/API/WS ได้, three.js + three-vrm โหลดผ่าน CSP, 3D และ RAM เทียบเท่า Electron,
ขนาดโปรแกรมเล็กลงมาก (6.4 MB เทียบ 235 MB + runtime) ข้อเสียที่วัดได้: เริ่มช้ากว่า ~190 ms และต้องจัดการ CSP แบบ static
ก่อนตัดสินใจย้ายจริงยังขาด: การพอร์ตฟีเจอร์เปลือกของ Electron (ถาด, auto-start, notification, updater, หน้าต่าง workspace/browser) ซึ่งเป็นงานหลักและยังไม่ได้ประเมิน

**Android: ยังสรุปไม่ได้** เพราะไม่ได้วัดบนอุปกรณ์ (มีแค่ขนาด APK 9.2 MB และยืนยันว่า build ได้) — ผล desktop ใช้ทำนาย Android WebView ไม่ได้ (คนละ engine/ฮาร์ดแวร์) แอป Kotlin เดิมไม่ต้องแตะจนกว่าจะมีตัวเลขจากเครื่องจริง
