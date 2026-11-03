# Windows: เลือก stack

เงื่อนไขจากเป้าหมาย: **native แท้ ไม่ใช้ WebView** สำหรับ UI, คุยกับ core ผ่าน HTTP + WebSocket, ต้องมีแชต streaming,
เล่นเสียงพร้อม Range + header, อัดเสียง, toast/push, เก็บ token อย่างปลอดภัย, และ (ภายหลัง) canvas ของ workflow กับ 3D

## เปรียบเทียบ

| ตัวเลือก | Native/WebView | แชร์โค้ดกับแอปอื่น | เสียง/สื่อ | Push / toast | เก็บ token | ความเสี่ยง |
|---|---|---|---|---|---|---|
| **WinUI 3 + Windows App SDK (C#/.NET 8)** | native (XAML/DirectX) | ไม่แชร์ UI; แชร์ได้แค่สเปก/JSON Schema | `MediaPlayer` + `MediaSource` จาก stream ที่ใส่ header เอง, `AudioGraph`, `MediaCapture` อัด WAV | `AppNotificationManager`, `PushNotificationManager` (WNS) | `PasswordVault` / DPAPI | packaging (MSIX หรือ unpackaged) ต้องตั้งให้ดี; ecosystem control เล็กกว่า WPF |
| WPF (.NET 8) | native (DirectX) | ไม่แชร์ | NAudio / `MediaPlayer` | ต้องพึ่ง Windows App SDK แยก | DPAPI | เทคโนโลยีเก่า ไม่ได้ Fluent design โดยตรง |
| .NET MAUI | native (WinUI 3 ข้างใต้) | แชร์ UI กับ Android/iOS ได้ในทฤษฎี | ผ่าน plugin | ผ่าน plugin | `SecureStorage` | ทีมเลือก Kotlin/Swift สำหรับมือถือแล้ว จึงไม่ได้ประโยชน์จากการแชร์; บน Windows คือ WinUI 3 อยู่ดีแต่มีชั้นเพิ่ม |
| Compose Multiplatform (Kotlin, Desktop/JVM) | native (Skia) ไม่ใช่ WebView | **แชร์ model + network + ViewModel กับ Android** ได้มาก (Kotlin Multiplatform) | JVM: ต้องใช้ VLCJ / JavaFX media; ไม่มี media session ของ Windows ในตัว | ต้องเขียน JNI/JNA ไป WinRT เอง | ต้อง JNA ไป DPAPI/Credential Manager | runtime JVM ใหญ่, ดูไม่เป็น Windows, integration ระบบ (toast, SMTC, WNS) ต้องทำเองหมด |
| Flutter | native (Skia/Impeller) | แชร์กับทุกแพลตฟอร์ม (แต่ทีมไม่ได้ใช้ Flutter บนมือถือ) | plugin | plugin | plugin | ขัดกับการเลือก SwiftUI/Compose ของแพลตฟอร์มอื่น |
| Avalonia (C#) | native (Skia) | ไม่แชร์กับมือถือ | ต้องหา library เอง | ต้องทำเอง | DPAPI | ไม่ใช่ UI ของ Windows แท้ ประโยชน์หลักคือ cross-platform ซึ่งไม่ต้องการ |

## ข้อเสนอ: **WinUI 3 + Windows App SDK, C# / .NET 8**

เหตุผล:

1. **ตรงกับหลัก "native ของแต่ละแพลตฟอร์ม"** เหมือน SwiftUI บน Apple และ Compose บน Android — ได้ Fluent, Mica, การรองรับ
   accessibility/IME ภาษาไทยของระบบโดยตรง
2. **API ระบบที่แอปนี้ต้องใช้มีในตัว** โดยไม่ต้อง interop:
   - WebSocket: `System.Net.WebSockets.ClientWebSocket` (ไม่ส่ง `Origin` เอง — ผ่านเงื่อนไขของ `/ws`)
   - เสียง + Range + Bearer: `MediaPlayer` กับ `MediaSource.CreateFromStream` ของ stream ที่อ่านผ่าน `HttpClient`
     และปุ่มสื่อ/หน้าจอล็อกด้วย `SystemMediaTransportControls`
   - อัดเสียง WAV: `MediaCapture` + `MediaEncodingProfile.CreateWav(AudioEncodingQuality.Low)` (ตรงกับที่โมเดลถอดเสียงรับ: `media.md` ข้อ 2.1)
   - TTS: `Windows.Media.SpeechSynthesis.SpeechSynthesizer` (มีเสียงไทยเมื่อติดตั้ง language pack)
   - toast + push: Windows App SDK `AppNotificationManager` / `PushNotificationManager` (WNS)
   - token: `Windows.Security.Credentials.PasswordVault`
3. **ทำ canvas ของ workflow และ 3D ภายหลังได้** ด้วย Win2D (`CanvasControl`) และ SwapChainPanel + DirectX/Direct3D
   (หรือ Unity/glTF viewer ที่ฝังใน SwapChainPanel) โดยไม่ต้องเปลี่ยน stack
4. C# มี `System.Text.Json` source generator — generate model จาก JSON Schema ของ `protocol.ts` (G-TYPES-1) ได้ตรง ๆ

ทางเลือกที่ควรพิจารณาจริง ๆ คือ **Compose Multiplatform** ถ้าเจ้าของโปรเจกต์ให้น้ำหนักกับการแชร์โค้ดกับ Android มากกว่าความเป็น Windows
แท้ — ประหยัด network/model/state layer ได้ แต่ต้องเขียน interop ระบบ (toast, SMTC, WNS, Credential Locker) เองทั้งหมด (คำถาม Q8)

## ที่ทำจริงใน Phase 5 (2026-11-03) — `apps/windows/`

- **WinUI 3 + Windows App SDK 2.6 + C# / .NET 10** (ไม่ใช่ .NET 8: .NET 8 หมดอายุการสนับสนุน 10 พ.ย. 2026; .NET 10 คือ LTS ปัจจุบัน)
- **unpackaged + self-contained** แจกเป็น zip + ตัวติดตั้ง NSIS ต่อผู้ใช้ เหมือนแอป Electron (ตัวอัปเดตและที่ติดตั้งเดิมใช้ต่อได้) — MSIX รอใบรับรอง/Store (Q9)
- เสียง: **NAudio** (Media Foundation + WASAPI) แทน `MediaPlayer` เพราะต้องใส่ header Bearer + Range เอง (`HttpRangeStream`) และต้องได้ EQ 10 แบนด์
  เต็ม (`AudioGraph` มีแค่ 4 แบนด์) — EQ เป็น biquad peaking ที่เขียนเองใน `Mimi.Core`, ปุ่มมีเดียใช้ SMTC จาก `MediaPlayer` ที่ไม่ได้เล่นอะไร
- token: **DPAPI** (`ProtectedData`, CurrentUser) แทน `PasswordVault` — ทดสอบได้ใน unit test และไม่ต้องมี package identity
- ถาดระบบ: `Shell_NotifyIcon` เอง (P/Invoke) ไม่พึ่ง library ภายนอก
- toast: `AppNotificationManager` (ใช้ได้ทั้ง unpackaged) — **WNS ยังไม่ทำ** (ต้อง sparse package + Azure app + ตัวส่งฝั่ง core)
- PC agent: ยังเป็น Node แยก (Q7 = แยกไว้ก่อน) แอปเริ่ม/หยุด/ถาม consent ส่วน build ใส่ `node.exe` ไว้ในโฟลเดอร์แอป
- Windows 10 1809+ ตาม Windows App SDK (ทดสอบจริงบน Windows 11 เท่านั้น)

## สิ่งที่ต้องตัดสินใจเพิ่มสำหรับ Windows

- แจกจ่ายแบบ MSIX (Store / sideload, ได้ WNS และ identity ง่าย) หรือ unpackaged + installer (ต้อง sparse package เพื่อใช้ WNS)
- รองรับ Windows 10 (1809+) ด้วยหรือ Windows 11 เท่านั้น — Windows App SDK รองรับ 10 1809 ขึ้นไป
- PC agent (`packages/pc-agent`) จะรวมเข้าแอป Windows native หรือคงเป็นโปรแกรม Node แยก (คำถาม Q7)
