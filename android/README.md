# แอป Mimi สำหรับ Android

แอปนี้เปิดหน้าเว็บของเซิร์ฟเวอร์ Mimi ใน WebView ของแอปเอง (ตั้งแต่ 0.7.0; ก่อนหน้านั้นเป็น Trusted Web Activity ของ Chrome)
ไม่มีข้อมูลของ Mimi เก็บในแอป นอกจาก token สำหรับ widget และรายการแชตล่าสุดที่ widget แสดง

- **ไมค์ / กล้อง** เป็นสิทธิ์ของแอปนี้ (เดิมเป็นของ Chrome จึงไม่มีให้กดอนุญาตในแอป): ถามตอนเปิดครั้งแรก
  และถามอีกเมื่อหน้าเว็บขอใช้ ปุ่มกล้องเปิดแอปกล้อง ไฟล์ที่หน้าเว็บบันทึกไปอยู่ใน Download
- **Widget "แชต Mimi"**: แชตล่าสุด (รูป ชื่อ เวลา ข้อความล่าสุด จำนวนคำตอบที่ยังไม่เห็น) แตะแถวเพื่อเปิดแชตนั้น
  ดึงจาก `GET /api/widget` ด้วย token เดียวกับที่ล็อกอินในแอป รีเฟรชเมื่อเปิด/ปิดแอป และทุก ~15 นาที
- **แจ้งเตือน**: WebView รับ Web Push ไม่ได้ แอปจึงเช็กคำตอบใหม่ทุก ~15 นาทีแล้วแจ้งเตือนเอง
- ลิงก์นอกเซิร์ฟเวอร์ Mimi (หน้าล็อกอิน OAuth, ดาวน์โหลด APK) เปิดในเบราว์เซอร์

โค้ดอยู่ที่ `app/src/main/java/app/mimi/android/`: `MainActivity` (WebView + สิทธิ์ + เลือกไฟล์),
`ChatWidget` / `ChatWidgetService` (widget), `WidgetSync` (ดึงข้อมูล + แจ้งเตือน), `SyncJob` (รอบ 15 นาที)

## Build

ไม่ต้อง build เอง: `.github/workflows/release.yml` build ให้ทุกครั้งที่ push tag `v*` แล้วแนบ `Mimi-<version>-android.apk` ใน GitHub release
(tag ที่มี `-` เช่น `v0.7.0-prototype` เป็น pre-release: ตัวเช็กอัปเดตของแอปข้ามไป)

- เซิร์ฟเวอร์ที่แอปเปิด: repository variable `MIMI_ANDROID_HOST` (ค่าเริ่มต้นคือโดเมน Railway ของ core)
- กุญแจเซ็น: secrets `ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD` (PKCS#12, alias `mimi`) ต้องใช้กุญแจเดิมตลอด
  ไม่อย่างนั้นติดตั้งทับเวอร์ชันเก่าไม่ได้ สำเนากุญแจเก็บไว้นอก repo (`backups/android/`, git ไม่เก็บ)
- build เองบนเครื่องที่มี JDK 17 + Android SDK: `gradle -p android assembleRelease -PmimiHost=<host> -PversionName=0.7.0 -PversionCode=7000`
  (ไม่ตั้ง `MIMI_KEYSTORE` = เซ็นด้วย debug key)
- ไอคอน: `node scripts/android-icons.mjs` (วาดจากไอคอนเดียวกับแอปอื่น)

## อัปเดต

แอปเปิดหน้า `/?app=android&appv=<version>`; หน้าเว็บ (`feature-update.js`) ถาม GitHub ว่ามี release ที่ใหม่กว่าไหม
ถ้ามี จะขึ้นแถบให้แตะดาวน์โหลด APK (เปิดในเบราว์เซอร์) แล้วติดตั้งทับของเดิม (ข้อมูลไม่หาย เพราะอยู่บนเซิร์ฟเวอร์)
