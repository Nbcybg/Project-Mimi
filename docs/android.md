# แอป Android ของ Mimi = Tauri + Rust

**ตัดสินใจเมื่อ 2026-11-11 (เจ้าของโปรเจกต์):** แอป Android หลักของ Mimi คือแอป **Tauri 2 + Rust** ใน [`apps/tauri`](../apps/tauri)
ที่ครอบ UI เว็บตัวเดียวกับเดสก์ท็อปและ PWA (`packages/ui`) แอป **Kotlin + Jetpack Compose** เดิมที่เคยอยู่ใน `android/` **เลิกใช้และถอดออกจาก repo แล้ว**

เอกสารนี้มีไว้กันสับสนว่า "แอป Android" คืออะไร แก้ตรงไหน และ build ยังไง

## สั้น ๆ

| เรื่อง | คำตอบ |
|---|---|
| แอป Android ที่ใช้จริง | `apps/tauri` (package id `app.mimi.tauri`) |
| หน้าจอทั้งหมดมาจาก | `packages/ui` (JavaScript ธรรมดา ไม่มี build step) ใช้ร่วมกับเว็บ, PWA, Tauri เดสก์ท็อป และ Electron |
| ตรรกะ agent / ข้อมูล / sync | อยู่ที่ core (`packages/core`, Node) ไม่ได้รันบนมือถือ แอปต่อ core ผ่าน HTTP + WebSocket |
| แอป Kotlin เดิม (`android/`) | ถอดออกแล้ว สำรองไว้ที่ git tag `kotlin-android-final` |
| แอป Windows (WinUI) และ macOS (SwiftUI) ใน `apps/` | **ไม่เกี่ยวกับการตัดสินใจนี้** ยังเป็นโค้ดแยกของมันเอง |

## โครงสร้าง: อะไรอยู่ที่ไหน

```
packages/ui/                 หน้าจอทั้งหมด (แชต, agent, hub, ตั้งค่า) — แก้หน้าตา/พฤติกรรมของแอปที่นี่
apps/tauri/src-tauri/src/    ส่วน Rust ของเปลือก: หน้าเชื่อมต่อ, จำที่อยู่ core (core.txt), CSP, ถาด/หน้าต่าง (เดสก์ท็อป)
apps/tauri/src-tauri/gen/android/   โปรเจกต์ Android ที่ Tauri สร้างให้ มี Kotlin เล็กน้อย (MainActivity, NotifyService)
apps/tauri/src-tauri/tauri.conf.json   ชื่อแอป, identifier, CSP, ที่มาของ UI (frontendDist = packages/ui)
```

**อย่าสับสน:** `gen/android/` มีไฟล์ Kotlin จริง แต่เป็น "กาว" เล็ก ๆ ของ WebView (ขอบจอ/คีย์บอร์ด, แจ้งเตือน, ไมค์/กล้อง/ไฟล์แนบ,
บริการแจ้งเตือนเบื้องหลัง) ไม่ใช่แอป Kotlin เดิม และไม่ได้ถูกถอดออก

ถ้าจะ… | แก้ที่
--- | ---
เปลี่ยนหน้าตา/พฤติกรรมในแชต (เช่น ใครพูด) | `packages/ui/app.js`, `app.css`
เปลี่ยนวิธีที่แอปต่อ core / หน้าเชื่อมต่อ | `apps/tauri/src-tauri/src/lib.rs`, `apps/tauri/src-tauri/src/connect.html`
เปลี่ยนการทำงานเฉพาะ Android (แจ้งเตือนเบื้องหลัง, สิทธิ์) | `apps/tauri/src-tauri/gen/android/app/src/main/...`
เปลี่ยนตรรกะ agent / ส่งงานระหว่าง agent | `packages/core` (ต้อง deploy core ที่ใช้อยู่ด้วย)

## Build APK (บน Windows)

เครื่องมือที่ต้องมี: Rust (+ target `aarch64-linux-android`, `tauri android init` เพิ่มให้), JDK 17, Android SDK (platform 34, build-tools 34.0.0),
NDK 27.2.12479018 ตัวแปร `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME` (และ `GRADLE_USER_HOME` ถ้าไม่อยากใช้ไดรฟ์ C:) ตั้งเฉพาะตอนรันคำสั่งก็พอ

```bash
cd apps/tauri
npm run sync-ui                                  # เติม vendor/ และไอคอนที่ UI ต้องใช้ (ไม่ได้เก็บใน git)
npx tauri android build --apk --target aarch64   # คอมไพล์ Rust ได้ .so แล้วล้มที่ขั้น symlink บน Windows (ปกติ ดูด้านล่าง)
```

บน Windows ขั้นสุดท้ายของ `tauri android build` ล้มเพราะสร้าง symbolic link ไม่ได้ (ต้องเปิด Developer Mode ซึ่งเป็นการแก้ค่าระบบ) ใช้ทางเลี่ยง:

1. คัดลอก `src-tauri/target/aarch64-linux-android/release/libmimi_tauri_lib.so` ไปที่ `src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/`
2. `cd src-tauri/gen/android && ./gradlew :app:assembleArm64Release -x rustBuildArm64Release` ได้ `app-arm64-release-unsigned.apk`
3. `zipalign -p 4` แล้ว `apksigner sign` (ด้วย keystore ที่เก็บนอก repo — อย่า commit keystore)

ไฟล์ UI ถูกฝังในไลบรารี `.so` ตอนคอมไพล์ ดังนั้น **แก้ `packages/ui` แล้วต้อง build ใหม่** ถึงจะอยู่ในแอป (เว็บ/PWA ได้การแก้ทันทีที่ deploy core)

เลขเวอร์ชันของแอปอยู่ที่ `gen/android/app/tauri.properties` (`versionName`, `versionCode`)

## สถานะและข้อจำกัดที่รู้ (ณ 2026-11-11)

รายละเอียดการวัดและประวัติทั้งหมดอยู่ใน [`tauri-spike.md`](tauri-spike.md)

- ชื่อแอปและ package ยังเป็นชื่อ spike (`Mimi Tauri Spike`, `app.mimi.tauri`, เวอร์ชัน 0.0.1) **ก่อนขึ้น Play Store ต้องตัดสินใจชื่อ/package id ให้เรียบร้อย เพราะ package id เปลี่ยนไม่ได้หลังเผยแพร่**
- เซ็นด้วย keystore ทดลองเท่านั้น ยังไม่มีกุญแจ release
- release build เปิด cleartext HTTP ไว้ (เพื่อ core บน LAN) ต้องจำกัดก่อนแจกจริง
- แจ้งเตือนเบื้องหลังทำด้วย foreground service ที่ต่อ WebSocket ไม่ใช่ FCM — ไม่รอดการรีบูตหรือเมื่อระบบฆ่าแอป และยังไม่มี widget
- ยังไม่มีตัวอัปเดตในแอป (ติดตั้ง APK ใหม่ทับเอง ด้วยกุญแจเซ็นเดิม)
- ยังไม่มี build อัตโนมัติบน GitHub Actions (`release.yml` ไม่มี job Android แล้ว) — build ด้วยมือตามขั้นตอนด้านบน
- เอกสาร `tauri-spike.md` ระบุว่ายังไม่ได้วัด RAM/FPS บนอุปกรณ์จริง

## แอป Kotlin เดิม (เลิกใช้)

ถอดออกจาก `main` แล้ว เก็บไว้ที่ git tag **`kotlin-android-final`** (commit `8a0f917`, ก่อนถอด) เปิดดูหรือกู้คืนได้:

```bash
git show kotlin-android-final:android/README.md           # อ่านไฟล์เดียว
git checkout kotlin-android-final -- android              # กู้ทั้งโฟลเดอร์กลับมาในเครื่อง
```

สิ่งที่แอป Kotlin เคยมีและแอป Tauri ตอนนี้ยังไม่มี (ถ้าต้องการค่อยพอร์ต): push ผ่าน FCM, widget หน้าจอหลัก, ตัวเช็กอัปเดตจาก GitHub release
เอกสารเก่าที่พูดถึง `android/` (เช่น `docs/native/`, `docs/native-phases-prompts.md`, `HANDOFF.md`) เก็บไว้เป็นประวัติ ไม่ได้แก้ตามนี้
