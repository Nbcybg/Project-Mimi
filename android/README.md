# แอป Mimi สำหรับ Android (native)

ตั้งแต่ Phase 2 ของแอป native แอปนี้เป็น **Kotlin + Jetpack Compose ทั้งหมด ไม่มี WebView** คุยกับ Mimi core ผ่าน HTTP + WebSocket
ตามสเปกใน [`docs/native/`](../docs/native/README.md) (ก่อนหน้านี้ 0.7.x–0.8.x เป็น WebView ที่เปิดหน้าเว็บของเซิร์ฟเวอร์)

package id ยังเป็น `app.mimi.android` และเซ็นด้วยกุญแจเดิม จึงติดตั้งทับแอป WebView ได้ ข้อมูลไม่หาย (อยู่บนเซิร์ฟเวอร์)
แต่ต้อง **ล็อกอินใหม่ครั้งแรก** เพราะ token เดิมอยู่ในหน้าเว็บ ไม่ได้ย้ายมา

## มีอะไรบ้าง (MVP)

| ส่วน | ทำอะไร | สเปก |
|---|---|---|
| เชื่อมต่อ / ล็อกอิน | ใส่ที่อยู่เซิร์ฟเวอร์ → `/health` บอกว่าเป็น core คนเดียว (ใส่ token) หรือ gateway (username + password + รหัส 2FA) · เช็ก `minClientApi` · "เครื่องนี้ไม่ใช่ของฉัน" = ไม่จำ token | `auth-and-session.md`, `api-versioning.md` |
| รายการแชต | แท็บ ตัวต่อตัว / กลุ่ม, ยังไม่อ่าน, กำลังพิมพ์, รูป agent · ปุ่ม + เริ่มแชตกับ agent | `realtime.md` 4 |
| แชต | streaming ทีละ delta, แถวเครื่องมือ, sub-agent, handoff, การ์ดขออนุญาต (ครั้งนี้/งานนี้/session/ตลอด), อนุมัติ workflow, ข้อความแบบเว็บ (code block, `code`, **ตัวหนา**, *การกระทำ*, ลิงก์, @mention), รูปในแชต + ดูเต็มจอ, แนบไฟล์, ข้อความเสียง (WAV 16 kHz), หยุด, โหลดข้อความเก่า | `realtime.md`, `media.md` 2 |
| ~~Mimiamp~~ | **เอาออกแล้ว** (Q5, 2026-11-03: `feature/mimiamp` ถูกลบ, frame `mimiamp` ของ core เก่าถูกข้าม) | – |
| แจ้งเตือน | FCM (เมื่อ build มี Firebase ids และ core มีกุญแจ FCM) + poll `/api/notifications?afterId=` ทุก ~15 นาทีด้วย WorkManager | `push-and-background.md` |
| Widget | แชตล่าสุดบนหน้าจอหลัก (`GET /api/widget`) แตะแถว = เปิดแชตนั้น | `api-contract.md` A.6 |
| อัปเดตแอป | ถาม GitHub ว่ามี release ที่ใหม่กว่าไหม แล้วขึ้นแถบให้ดาวน์โหลด APK | – |

ยังไม่มี (ดูรายการเต็มใน `docs/native/feature-inventory.md`): หน้า Hub / Agent / ตั้งค่า / workflow / trigger / คลังความรู้ (ทำผ่านเว็บไปก่อน),
แชตกลุ่มแบบสร้าง/แก้, ค้นหา, pin / react / reply / rewind, อ่านออกเสียง, ตัวละครบนเวที, VRM

## สถานะ Phase 2 (2026-11-02)

ทำแล้วและตรวจแล้ว:
- build `assembleDebug` ผ่าน (APK debug 24 MB), unit test 21 ตัวผ่าน: frame parser + reducer ของแชตด้วย frame ที่บันทึกจาก core จริง (`core:model`),
  การจัดรูปข้อความแบบเว็บ (`core:ui`), ViewModel ของล็อกอิน (gateway + 2FA, token, เซิร์ฟเวอร์ต้องการแอปใหม่กว่า), WAV header, จับคู่คำสั่งเพลงของ agent และ EQ 10 → แบนด์ของเครื่อง, เทียบเวอร์ชันอัปเดต
- ติดตั้งบน emulator (API 36) แล้วเปิดได้ ไม่ crash แสดงหน้า "เชื่อมต่อ Mimi" ในธีมมืด

ยังไม่ได้ทดสอบ (เครื่องที่ใช้พัฒนามี load สูงมาก emulator ค้างจน Android ขึ้น "Process system isn't responding" ก่อนกรอกข้อมูลได้):
- ล็อกอิน → แชต streaming → เล่น Mimiamp ในพื้นหลัง บน emulator **ยังไม่ได้ทำจริง** (เกณฑ์ "เสร็จ" ของ Phase 2 ข้อนี้ยังไม่ผ่าน)
- Compose UI test (`feature/auth/src/androidTest`) เขียนแล้วแต่ยังไม่ได้รัน (`connectedDebugAndroidTest`)
- FCM จริง (ต้องมีโปรเจกต์ Firebase), widget บนหน้าจอหลัก, EQ บนเครื่องจริง, ติดตั้งทับแอป WebView ที่เซ็นด้วยกุญแจจริง

2026-11-03 (เครื่อง Windows, ไม่มี emulator เพราะไม่มี Hyper-V): `:core:model:test testDebugUnitTest assembleDebug` ผ่าน (21/21)
แล้วทำ APK debug ที่เสนอ `http://<IP ของเครื่อง>:8787` (`-PmimiHost=...`) เพื่อทดสอบบนมือถือจริงใน Wi‑Fi เดียวกันกับ core ทดสอบ —
รอผลจากมือถือจริง (ล็อกอิน → แชต → Mimiamp เล่นพื้นหลัง)

ขั้นต่อไปที่ต้องทำ: ปิดโปรแกรมที่กินเครื่อง แล้วรัน `./gradlew connectedDebugAndroidTest` และทดสอบมือกับ core ในเครื่อง (`http://10.0.2.2:8787`)

## โครงสร้าง

```
android/
  app/              Application (Hilt), MainActivity + navigation, แจ้งเตือน, FCM, WorkManager, widget, ตัวเช็กอัปเดต
  core/model/       ชนิดข้อมูลของโปรโตคอล + ตัวแปลง frame + reducer ของแชต (Kotlin ล้วน ทดสอบบน JVM)
  core/data/        session (EncryptedSharedPreferences/Keystore), Retrofit + OkHttp, WebSocket, Room cache, repositories
  core/ui/          ธีมมืดแบบเว็บ, การแสดงข้อความ, avatar
  feature/auth/     เชื่อมต่อ + ล็อกอิน
  feature/chat/     รายการแชต + หน้าแชต + อัดเสียง
```

MVVM + Coroutines/Flow + Hilt · ฟีเจอร์ใหม่ = โมดูลใหม่ใต้ `feature/` + route ใน `MainActivity`

## Build และทดสอบ

ต้องมี JDK 17 และ Android SDK (platform 35) — ใช้ Gradle wrapper ในโฟลเดอร์นี้

```bash
cd android && ./gradlew assembleDebug
```

```bash
cd android && ./gradlew testDebugUnitTest :core:model:test
```

```bash
cd android && ./gradlew connectedDebugAndroidTest
```

- ทดสอบกับ core ในเครื่อง: `npm run serve` (หรือ gateway) แล้วใน emulator ใส่เซิร์ฟเวอร์ `http://10.0.2.2:8787`
  (build แบบ debug เท่านั้นที่อนุญาต http ไม่เข้ารหัส: `app/src/debug/AndroidManifest.xml`)
- เซิร์ฟเวอร์ที่เสนอตอนเปิดครั้งแรก: `-PmimiHost=<host>` (ค่าเริ่มต้นคือโดเมน Railway ของ core)
- Firebase (ไม่ใช้ `google-services.json`): `-PfcmProjectId=… -PfcmAppId=… -PfcmApiKey=… -PfcmSenderId=…`
  ไม่ใส่ = ไม่มี FCM แอปใช้ poll แทน · ฝั่ง core ต้องตั้ง `MIMI_FCM_SERVICE_ACCOUNT` (ดู `docs/hosting.md`)

## Release

`.github/workflows/release.yml` build ให้ทุกครั้งที่ push tag `v*` แล้วแนบ `Mimi-<version>-android.apk` ใน GitHub release

- กุญแจเซ็น: secrets `ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD` (PKCS#12, alias `mimi`) **ต้องใช้กุญแจเดิมตลอด**
  ไม่อย่างนั้นติดตั้งทับเวอร์ชันเก่าไม่ได้ สำเนากุญแจเก็บไว้นอก repo (`backups/android/`, git ไม่เก็บ)
- ไม่ตั้ง `MIMI_KEYSTORE` = เซ็นด้วย debug key (ติดตั้งทับแอปที่เซ็นด้วยกุญแจจริงไม่ได้)
- ไอคอน: `node scripts/android-icons.mjs`
- tag ที่ลงท้าย `-rc` / `-beta` เป็น pre-release ซึ่งตัวเช็กอัปเดตข้าม
