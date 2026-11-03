# Prompts ทุกเฟส: แอป Mimi แบบ native แท้ (ไม่ใช้ WebView)

Phase 0 อยู่ใน [native-phase0-prompt.md](native-phase0-prompt.md) ไฟล์นี้คือเฟสที่เหลือ
แต่ละเฟสคัดลอกหัวข้อ "Prompt" ไปวางเป็นข้อความแรกของเซสชันใหม่ (working directory = root ของโปรเจกต์)

ลำดับ: 0 สเปก API → 1 แก้เซิร์ฟเวอร์ → 2 Android → 3 Mac → 4 iOS → 5 Windows → 6 ฟีเจอร์หนัก → 7 ปิดงาน
เฟส 2–5 เริ่มได้หลังเฟส 0 และ 1 เสร็จ และแยกเป็นเซสชัน/โค้ดเบสของตัวเอง (ไม่แตะไฟล์ของกันและกัน)

## กติกากลาง (ใส่ท้ายทุก prompt)

- อ่าน `docs/native/` ก่อนเสมอ: เป็นแหล่งความจริงของ API ถ้าสเปกกับเซิร์ฟเวอร์ไม่ตรงกัน ให้บันทึกและถามเจ้าของโปรเจกต์ ห้ามเดา
- ห้ามเรียกเซิร์ฟเวอร์ production บน Railway ด้วยข้อมูลจริง ใช้ core ที่รันในเครื่อง (`npm run serve`) กับข้อมูลทดสอบ
- ห้าม deploy, push, ลบข้อมูล หรือแตะ `user/` ของจริง
- token, รหัสผ่าน, API key เก็บใน Keychain / Keystore เท่านั้น ห้ามลงไฟล์ ห้ามลง log
- ไม่ใช้ WebView ใด ๆ สำหรับ UI ของแอป (เปิดลิงก์ภายนอกด้วยเบราว์เซอร์ระบบได้)
- เขียนคำอธิบายเป็นภาษาไทย ศัพท์เทคนิคเป็นอังกฤษ จบทุกเฟสด้วยรายการสิ่งที่ยังไม่ได้ทำ/ไม่ได้ทดสอบตามจริง

---

## Phase 1 — เซิร์ฟเวอร์ให้พร้อมกับ client native

### Prompt

คุณกำลังทำ Phase 1 ของโปรเจกต์แอป Mimi native: แก้เซิร์ฟเวอร์ให้รองรับ client ที่ไม่ใช่เว็บ
อ่าน `docs/native/server-gaps.md`, `api-contract.md`, `realtime.md` และ `push-and-background.md` ก่อน

ทำตามรายการใน `server-gaps.md` เรียงตามความสำคัญ อย่างน้อย:
1. endpoint `GET /health` หรือ `/api/version` ที่คืนเวอร์ชัน core + เวอร์ชัน API ขั้นต่ำที่ client ต้องมี และ header/ฟิลด์ให้ client เช็กความเข้ากันได้
2. endpoint ลงทะเบียน push token ของ APNs (iOS/Mac) และ FCM (Android) พร้อมส่ง push จริงเมื่อมีคำตอบใหม่/reminder/notification (คงความสามารถ Web Push เดิม)
3. แก้ endpoint ที่ผูกกับ cookie, พาธสัมพัทธ์ หรือ same-origin ให้ใช้ Bearer token ได้
4. ถอดข้อสันนิษฐานว่าเซิร์ฟเวอร์ต้องเสิร์ฟ UI: เพิ่มตัวเลือก `MIMI_SERVE_WEB=0` ให้ปิดการเสิร์ฟไฟล์เว็บ (ค่าเริ่มต้นยังเปิด เพื่อให้ PWA/เว็บเดิมไม่พัง)
5. ย้ายเพลงออกจาก image: เอา `COPY mimiamp` ออกจาก Dockerfile และอ่านเพลงจาก `<user>/mimiamp` ใน volume (มีโค้ดรองรับแล้วใน `mimiamp/library.ts`) พร้อมเขียนวิธีอัปโหลดเพลงขึ้น volume ใน `docs/hosting.md`
6. เพิ่มเอกสารเวอร์ชัน API และนโยบายเมื่อทำให้ client เก่าใช้ไม่ได้ (deprecation)

ข้อกำหนด: ไม่ทำให้ client เว็บ/Electron/Android เดิมพัง, เพิ่ม test ใน `packages/core/src/test/` ให้ทุกอย่างที่เพิ่ม, รัน `npm run typecheck` และ `npm test` ให้ผ่าน,
อัปเดต `CHANGELOG.md` (Unreleased) และ `docs/native/api-contract.md` ให้ตรงกับที่แก้ ห้าม deploy

เสร็จเมื่อ: test ผ่านทั้งหมด, client เดิมยังทำงานกับ core ในเครื่อง, และ `server-gaps.md` มีสถานะ "แก้แล้ว/เหลือ" ต่อทุกข้อ

---

## Phase 2 — Android (Kotlin + Jetpack Compose)

### Prompt

คุณกำลังทำ Phase 2: แอป Android native แท้ แทน WebView ใน `android/` (ปัจจุบัน `MainActivity.java` เป็น WebView)
อ่าน `docs/native/*` ทั้งหมด และโค้ดเดิมใน `android/app/src/main/java/app/mimi/android/` (push, widget, sync) ก่อน

สร้างโมดูลใหม่ (เช่น `android/app` เขียนใหม่เป็น Kotlin + Compose, Material 3, ธีมมืดตามแอปเดิม) โดย:
- สถาปัตยกรรม: MVVM + Kotlin Coroutines/Flow, Retrofit/Ktor + OkHttp WebSocket, Room สำหรับ cache, Hilt, token ใน Android Keystore (EncryptedSharedPreferences)
- ขอบเขตรอบนี้ (MVP): ตั้งค่าเซิร์ฟเวอร์ + ล็อกอิน, รายการแชต, แชตแบบ streaming (markdown, รูป, ไฟล์แนบ, เสียง), เครื่องเล่น **Mimiamp** ครบ (playlist, shuffle/repeat, EQ 10 band ด้วย `android.media.audiofx.Equalizer`, background playback ด้วย Media3 + MediaSession + notification), FCM push, widget แชตเดิม, การเช็กเวอร์ชัน core, ตัวอัปเดตแอป
- ฟีเจอร์อื่นของ `feature-inventory.md` ที่เป็นระดับ M/L ให้ทำเป็นเฟส 6 ไม่ต้องทำตอนนี้ แต่วางโครงให้เพิ่มได้ (navigation, module แยกต่อฟีเจอร์)
- Mimiamp ต้องทำงานร่วมกับ `/mimiamp/tracks.json` และ range request ตาม `media.md`
- ย้าย package id/ลายเซ็นให้ติดตั้งทับแอปเดิมได้ (`app.mimi.android`, ใช้ keystore เดิมตาม `android/README.md` — ห้ามสร้างหรือแตะกุญแจจริง)
- เขียน UI test (Compose) และ unit test ของ ViewModel/repository, ทดสอบกับ core ในเครื่อง (emulator ใช้ `10.0.2.2`)
- อัปเดต `.github/workflows/release.yml` เฉพาะส่วน build Android ถ้าจำเป็น

เสร็จเมื่อ: build ผ่าน, ล็อกอิน → คุยแชต → เล่นเพลง Mimiamp ในพื้นหลังได้บน emulator, ไม่มี `WebView` ใน UI หลัก, README ของ `android/` อัปเดต, รายงานสิ่งที่ยังไม่ทำ

---

## Phase 3 — macOS (SwiftUI)

### Prompt

คุณกำลังทำ Phase 3: แอป macOS native แท้ (SwiftUI + AppKit เมื่อจำเป็น) แทน Electron `packages/desktop/remote.cjs`
อ่าน `docs/native/*` และ `packages/desktop/` (tray, workspace, updater, auto-start, PC agent) ก่อน

สร้างโปรเจกต์ที่ `apps/macos/` (Xcode project/Swift Package) โดย:
- สถาปัตยกรรม: SwiftUI + Observation, URLSession + `URLSessionWebSocketTask`, Swift Concurrency, Keychain สำหรับ token, SwiftData/SQLite สำหรับ cache
- แยก **MimiKit** (Swift Package: โมเดล, API client, WebSocket, auth, repository) ให้ iOS (Phase 4) ใช้ร่วมกัน ห้ามใส่โค้ด UI เฉพาะ macOS ใน MimiKit
- ขอบเขต MVP: ล็อกอิน, แชต streaming, Mimiamp ครบ (AVAudioEngine + EQ 10 band ด้วย `AVAudioUnitEQ`, Now Playing/ปุ่มมีเดีย), menu bar item (แทน tray), หน้าต่างลอยขนาดเดียวกับแอปเดิม, การแจ้งเตือน (APNs + local), เปิดตอนเข้าสู่ระบบ (`SMAppService`), ล็อกอัตโนมัติ/ออกจากระบบเหมือน `remote.cjs`
- PC agent (`packages/pc-agent`, เรียกเครื่องมือไฟล์/เชลล์/เบราว์เซอร์ในเครื่อง): ยังคงเป็นโปรเซสแยก — ให้แอป native เริ่ม/หยุดมันและแสดงสถานะ ไม่ต้องเขียนใหม่ในเฟสนี้ ระบุใน `docs/native/` ว่าเป็นงานต่อไป
- Workspace (เบราว์เซอร์/เทอร์มินัล/ไฟล์ในหน้าต่าง) เป็นฟีเจอร์เฟส 6 ไม่ต้องทำตอนนี้
- App Sandbox + Hardened Runtime + entitlements เท่าที่จำเป็น, ลายเซ็น/notarization ใช้สคริปต์ที่ผู้ใช้ตั้งค่าเอง ห้ามสร้างหรือแตะใบรับรองจริง
- ตัวอัปเดต: ใช้ Sparkle หรือเทียบ GitHub release ตามที่ `updater.cjs` ทำอยู่ (เลือกและบอกเหตุผล)
- test: XCTest/Swift Testing ของ MimiKit และ UI test พื้นฐาน

เสร็จเมื่อ: `xcodebuild` ผ่านทั้ง arm64 และ x86_64, ล็อกอิน → แชต → เล่น Mimiamp ได้กับ core ในเครื่อง, ไม่มี `WKWebView`/Electron ใน UI หลัก, รายงานสิ่งที่ยังไม่ทำ

---

## Phase 4 — iOS (SwiftUI)

### Prompt

คุณกำลังทำ Phase 4: แอป iOS/iPadOS native ด้วย SwiftUI ใช้ **MimiKit** ร่วมกับแอป macOS (Phase 3) ที่ `apps/macos/` หรือ package ที่ย้ายไปไว้ส่วนกลาง
อ่าน `docs/native/*` และโค้ด MimiKit ที่มีอยู่ก่อน ถ้ายังไม่มี MimiKit ให้หยุดและรายงาน

สร้าง `apps/ios/` โดย:
- ขอบเขต MVP: ล็อกอิน, แชต streaming, Mimiamp (background audio, Control Center/Lock Screen, EQ), APNs push (ใช้ endpoint จาก Phase 1), Widget (WidgetKit) แทน widget แชตของ Android, Share Extension ส่งข้อความ/ไฟล์เข้าแชต, ไมค์/กล้อง/ไฟล์ตามสิทธิ์ของ iOS
- Adaptive layout สำหรับ iPhone/iPad, Dynamic Type, VoiceOver, ธีมมืด
- Background: `BGAppRefreshTask` สำหรับ sync เบา ๆ ข้อจำกัดของ iOS (ไม่มี PC agent, ไม่มีเชลล์) ต้องเขียนไว้ในเอกสารและซ่อนฟีเจอร์ที่ใช้ไม่ได้
- ย้ายโค้ดที่เป็นของ macOS ออกจาก MimiKit ถ้าพบ แล้วบันทึกการเปลี่ยนแปลง
- ลายเซ็น/provisioning ผู้ใช้ตั้งค่าเอง ห้ามสร้างหรือแตะใบรับรอง TestFlight/App Store ขั้นตอนอัปโหลดให้เขียนเป็นเอกสารเท่านั้น
- test: unit test ของ view model + UI test บน simulator กับ core ในเครื่อง (`localhost`)

เสร็จเมื่อ: build ผ่านบน iOS Simulator, ล็อกอิน → แชต → เล่นเพลงพื้นหลังได้, ไม่มี `WKWebView` ใน UI หลัก, รายงานสิ่งที่ยังไม่ทำ

---

## Phase 5 — Windows

### Prompt

คุณกำลังทำ Phase 5: แอป Windows native แท้ แทน Electron ใช้ stack ที่แนะนำใน `docs/native/windows-stack.md` (ถ้าไม่มีหรือเจ้าของโปรเจกต์เปลี่ยนใจ ให้ถามก่อน; ค่าเริ่มต้น WinUI 3 + C#/.NET)
อ่าน `docs/native/*`, `packages/desktop/` (tray, updater, auto-start, `patch-exe.mjs`, `build-win.mjs`) และ `packages/pc-agent` ก่อน

สร้าง `apps/windows/` โดย:
- ขอบเขต MVP: ล็อกอิน, แชต streaming, Mimiamp ครบ (WASAPI/NAudio หรือ MediaPlayer + EQ 10 band, SMTC/ปุ่มมีเดีย), tray icon + หน้าต่างลอย, Toast notification (ใช้ WNS หรือ polling ตามที่ Phase 0 ตัดสินใจ), เปิดตอนเข้าสู่ระบบ, ล็อกอัตโนมัติ/ออกจากระบบ, token ใน Windows Credential Locker/DPAPI
- PC agent คงเป็นโปรเซส Node แยก: แอปเริ่ม/หยุด/แสดงสถานะ (เหมือน Phase 3)
- แพ็กเกจ MSIX หรือ installer + ตัวอัปเดต (เลือกและให้เหตุผล) ชื่อ/ไอคอน/เวอร์ชันของ exe ต้องเป็น Mimi (แทนที่ `patch-exe.mjs`) ห้ามสร้างหรือแตะใบรับรองจริง
- test: unit test ของ ViewModel/ API client และ UI automation พื้นฐาน

เสร็จเมื่อ: build ผ่านบน Windows x64 (และ arm64 ถ้าทำได้), ล็อกอิน → แชต → เล่น Mimiamp ได้, ไม่มี WebView2 ใน UI หลัก, รายงานสิ่งที่ยังไม่ทำและสิ่งที่ยังไม่ได้ทดสอบบนเครื่องจริง

---

## Phase 6 — ฟีเจอร์ที่เหลือ (ทำทีละชุด ทีละแพลตฟอร์ม)

### Prompt (ใส่ชื่อชุดฟีเจอร์และแพลตฟอร์ม แล้วใช้ซ้ำ)

ชุดฟีเจอร์: `<ชื่อ>` · แพลตฟอร์ม: `<Android | macOS | iOS | Windows>`

คุณกำลังเพิ่มฟีเจอร์ที่เหลือของแอป Mimi native ทีละชุด อ่าน `docs/native/feature-inventory.md` และ `api-contract.md` ก่อน
หยิบเฉพาะชุดที่ระบุ ทำให้พฤติกรรมเทียบเท่า UI เว็บเดิม (อ่านโค้ด `packages/core/src/server/web/feature-<ชื่อ>.js` เป็นข้อกำหนด) แล้ว:
1. เขียนแผนสั้น ๆ + ขอบเขตของชุดนี้ก่อนลงมือ ถามถ้าฟีเจอร์เว็บเดิมกำกวม
2. ทำตามสถาปัตยกรรมและ module ที่มีอยู่ของแอปนั้น ห้ามรื้อโครง
3. เพิ่ม test และอัปเดต `feature-inventory.md` ให้เป็น "ทำแล้ว/เหลือ" ต่อฟีเจอร์

ลำดับที่แนะนำของชุดฟีเจอร์: Hub และตั้งค่า → Trigger/Reminder → Mail และ Calendar → Knowledge/Gallery/Wardrobe → Voice → Agents/Overseer → Workflow canvas → ตัวละคร VRM 3D → Workspace (เบราว์เซอร์/เทอร์มินัล/ไฟล์, เฉพาะเดสก์ท็อป)

หมายเหตุสองชุดหนักที่ควรทำเป็นเซสชันของตัวเอง:
- **Workflow canvas** (`feature-workflows.js` ~125 KB, `feature-canvas.js`): ต้องมี node graph editor ที่ลาก/ซูมได้ ใช้ Canvas/SwiftUI Canvas/Compose Canvas เขียนเอง ห้ามฝัง WebView
- **VRM 3D** (`feature-vrm.js`, `feature-stage.js`): ใช้ SceneKit/RealityKit (Apple), Filament หรือ SceneView (Android), และ engine ที่เลือกไว้ใน `windows-stack.md` สำหรับ Windows; ต้องมี loader ของ VRM + กระดูก/blendshape ก่อน ให้ประเมินความเป็นไปได้ก่อนเริ่ม และรายงานถ้าเกินขอบเขต

---

## Phase 7 — ปิดงาน: ตัดการเสิร์ฟ UI ออกจากเซิร์ฟเวอร์

### Prompt

คุณกำลังทำ Phase 7 เมื่อแอป native ทุกแพลตฟอร์มปล่อยแล้วและเจ้าของโปรเจกต์ยืนยันว่าจะเลิกใช้ UI เว็บ
**ก่อนเริ่มต้องถามเจ้าของโปรเจกต์ให้ชัดว่า PWA/เว็บเบราว์เซอร์/iOS-ที่ยังไม่มีแอป จะหายไปจริงหรือไม่ และได้ข้อความยืนยันแล้ว**

งาน:
1. ตั้ง `MIMI_SERVE_WEB=0` เป็นค่าเริ่มต้นใน Dockerfile/`docker-compose.yml`/`docs/hosting.md`, ให้ `/` ตอบหน้าข้อความสั้น ๆ ที่ชี้ไปดาวน์โหลดแอป
2. ลบ `packages/core/src/server/web/` ส่วนที่ไม่ใช้แล้ว, `sw.js`, `manifest.webmanifest`, `packages/desktop/` (Electron) และ `scripts/build-*.mjs` ที่ไม่ใช้ **เฉพาะหลังเจ้าของโปรเจกต์อนุมัติรายการไฟล์ที่จะลบ** (แสดงรายการก่อน ห้ามลบเอง)
3. อัปเดต `README.md`, `HANDOFF.md`, `docs/*`, `.github/workflows/release.yml` ให้ตรงกับของจริง, บันทึกใน `CHANGELOG.md`
4. รัน `npm run typecheck` และ `npm test` ให้ผ่าน

เสร็จเมื่อ: เซิร์ฟเวอร์รันได้โดยไม่มีไฟล์เว็บ, test ผ่าน, เอกสารไม่อ้างถึงสิ่งที่ลบไปแล้ว, และมีรายการไฟล์ที่ลบพร้อมหลักฐานว่าได้รับอนุมัติ
