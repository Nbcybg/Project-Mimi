# แอป Mimi สำหรับ Android

แอปนี้เป็น Trusted Web Activity: เปิดหน้าเว็บของเซิร์ฟเวอร์ Mimi ใน Chrome แบบเต็มจอ จึงล็อกอิน คุยด้วยเสียง
และรับแจ้งเตือน (Push) ได้เหมือนเว็บ ไม่มีข้อมูลของ Mimi เก็บในแอป (เหมือน PWA ที่ติดตั้งจากเว็บ)

## Build

ไม่ต้อง build เอง: `.github/workflows/release.yml` build ให้ทุกครั้งที่ push tag `v*` แล้วแนบ `Mimi-<version>-android.apk` ใน GitHub release

- เซิร์ฟเวอร์ที่แอปเปิด: repository variable `MIMI_ANDROID_HOST` (ค่าเริ่มต้นคือโดเมน Railway ของ core)
- กุญแจเซ็น: secrets `ANDROID_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PASSWORD` (PKCS#12, alias `mimi`) ต้องใช้กุญแจเดิมตลอด
  ไม่อย่างนั้นติดตั้งทับเวอร์ชันเก่าไม่ได้ สำเนากุญแจเก็บไว้นอก repo (`backups/android/`, git ไม่เก็บ)
- build เองบนเครื่องที่มี JDK 17 + Android SDK: `gradle -p android assembleRelease -PmimiHost=<host> -PversionName=0.6.0 -PversionCode=6000`
  (ไม่ตั้ง `MIMI_KEYSTORE` = เซ็นด้วย debug key)
- ไอคอน: `node scripts/android-icons.mjs` (วาดจากไอคอนเดียวกับแอปอื่น)

## ให้แอปเต็มจอ (ไม่มีแถบที่อยู่)

เซิร์ฟเวอร์ต้องตอบ `/.well-known/assetlinks.json` ด้วย fingerprint ของกุญแจที่เซ็น APK:
ตั้งตัวแปร `MIMI_ANDROID_CERT_SHA256` ให้ core (หรือ gateway) แล้วเปิดแอปใหม่ ถ้าไม่ตั้ง แอปยังใช้ได้แต่มีแถบที่อยู่ของ Chrome ด้านบน

## อัปเดต

แอปเปิดหน้า `/?app=android&appv=<version>`; หน้าเว็บ (`feature-update.js`) ถาม GitHub ว่ามี release ที่ใหม่กว่าไหม
ถ้ามี จะขึ้นแถบให้แตะดาวน์โหลด APK แล้วติดตั้งทับของเดิม (ข้อมูลไม่หาย เพราะอยู่บนเซิร์ฟเวอร์)
