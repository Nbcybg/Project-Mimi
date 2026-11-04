# สื่อ: ไฟล์แนบ, เสียงพูด, รูป, VRM/3D

> endpoint ทั้งหมดอยู่ใน `api-contract.md` ส่วน A ไฟล์นี้บอกว่า **ฝั่ง native ต้องใช้อะไร** และกับดักที่เจอจากโค้ด/การทดสอบ

## 1. Mimiamp (เครื่องเล่นเพลง) — ลบแล้ว

**ลบแล้วใน api 2** (Mimiamp ถูกเอาออกทั้งหมด — คำตอบ Q5 ใน `README.md`): `/mimiamp/*`, `/api/mimiamp/*`, เสียง YouTube และ frame `mimiamp` ไม่มีแล้ว ตอบ `404` / ไม่ส่ง
ถ้าผู้ใช้อยากฟังเพลง agent เปิดแอปเพลงของเครื่องด้วยเครื่องมือ PC (`open_path`, `computer_app`, `computer_key`) แทน

## 2. ไฟล์แนบในแชต

### 2.1 ส่ง

1. เลือกไฟล์ / ถ่ายรูป / อัดเสียง
2. `POST /api/upload?name=…` body = bytes, `Content-Type` = mime จริง (สูงสุด 25 MB) → ได้ `AttachmentView.id`
3. `chat-send` พร้อม `attachments: [id]`

| ชนิด | ข้อแนะนำ |
|---|---|
| รูป | ส่ง JPEG/PNG/WebP/GIF (โมเดลอ่านได้เฉพาะชนิดนี้: `attachments.ts:257`) — HEIC จาก iPhone ต้องแปลงเป็น JPEG ก่อน ย่อด้านยาว ≤2048 px เพื่อลดขนาด |
| เสียงพูด | **WAV 16-bit mono** (เว็บแปลงทุกครั้ง เพราะโมเดลถอดเสียงรับ mp3/wav ไม่รับ webm: `feature-voice.js:64-70, 233-238`) 16 kHz พอ — Android `AudioRecord` เขียน WAV เอง, iOS `AVAudioRecorder` (`kAudioFormatLinearPCM`), Windows `MediaCapture` + `MediaEncodingProfile.CreateWav` |
| วิดีโอ | mp4 (H.264/AAC) — ระวังเพดาน 25 MB |
| PDF / เอกสาร | ส่งตรง ๆ เซิร์ฟเวอร์อ่าน text ของไฟล์ข้อความ, `.xlsx`, PDF ให้เอง (`attachments.ts:497-520`) |

เสียงที่เงียบทั้งไฟล์ถูกแทนด้วยข้อความ "เงียบ" ไม่ถูกส่งให้โมเดล (`attachments.ts:514, 570`)
ระหว่างถอดเสียง/ดูรูปเซิร์ฟเวอร์ส่ง `chat-transcribing` / `chat-viewing` (ดู `realtime.md`)

### 2.2 แสดง

- `GET /api/files/<id>` + Bearer ใช้ `AttachmentView.mime` ตัดสินวิธีแสดง (header อาจเป็น `octet-stream`)
- `deletedAt` ไม่ใช่ null = ไฟล์ถูกลบตามระยะเก็บแล้ว แสดงชื่อ + `text` (คำบรรยาย/คำถอดเสียง) แทน (`protocol.ts:82-83`) — GET จะได้ `410`
- `/api/files` **รองรับ Range [api 1]**: AVPlayer/ExoPlayer เล่นวิดีโอ/เสียงจาก URL ตรง ๆ ได้ (ใส่ Bearer) — core ก่อน api 1 ต้องดาวน์โหลดลงไฟล์ก่อน
- ไฟล์ที่ agent สร้าง (`chat-event` → `attachment`) ใช้ endpoint เดียวกัน
- "บันทึกลงเครื่อง": Android `MediaStore` / SAF, iOS `UIActivityViewController` / Photos, Windows `FileSavePicker`

## 3. อ่านออกเสียง (TTS)

เว็บใช้เสียงของระบบ (`speechSynthesis`) ไม่ได้ใช้ API ของเซิร์ฟเวอร์ (`app.js:483-505`):

- ตัดโค้ด/ลิงก์/สัญลักษณ์ Markdown/บรรทัดกำกับเสียงออกก่อนอ่าน (`speakable`, `app.js:483-491`)
- ภาษา `th-TH` ถ้ามีอักษรไทย ไม่อย่างนั้น `en-US`; `speech.speed` → rate; `speech.voice` → เลือกเสียงที่ชื่อมีคำนั้น
  ไม่งั้นเลือกเสียงชื่อมี natural/online/neural
- อ่านอัตโนมัติเมื่อ `run-finish.reason === 'stop'` และเปิด `mimi.autoSpeak` (`app.js:1651`)
- native: Android `TextToSpeech`, iOS/macOS `AVSpeechSynthesizer`, Windows `SpeechSynthesizer` (Windows.Media.SpeechSynthesis)
- `speech.emotion` / `speech.tone` ไม่มีผลกับเสียงระบบ ใช้แสดงป้ายบน bubble เท่านั้น (`speechBadge`, `app.js:231`)

## 4. รูปของ agent, ฉาก, ชุด (stage แบบ visual novel)

- รูปทั้งหมดต้องใช้ Bearer: ใช้ image loader ที่ใส่ header ได้ (Coil `ImageRequest.Builder().httpHeaders`, Kingfisher `AnyModifier`,
  `HttpClient` บน Windows) cache key = path + `?v=<stamp>`
- เลือกรูปตัวละครตาม emoji ล่าสุดที่ agent พิมพ์: sprite ของชุดที่ใส่ → sprite ของ agent → รูปชุด → portrait → avatar
  (`feature-stage.js:1-12`) emoji key ตามกติกาใน `packages/core/src/chat/agent-images.ts`
- ฉากหลัง: `backgrounds-list` ให้ `items` (รูปของผู้ใช้ → `/api/background-image/<id>?v=<image>`) และ `settings`
  (`default`, `agents[agent]` = id, `"none"`, `"auto"` เลือกจาก keyword ใน status `location`)
  **ฉากสำเร็จรูป 11 ภาพ** (`floral`, `mint`, `blush`, `sky`, `grid`, `starlight`, `dawn`, `ember`, `crimson`, `waves`, `confetti`)
  ถูก hard-code ใน client (`feature-backgrounds.js:20-31`) และเสิร์ฟที่ `/backgrounds/<id>.webp` ไม่ต้องใช้ token
  — ไม่มี API บอกรายการนี้ (G-UI-2)
- ค่าฉากของแต่ละแชตอยู่ใน `ui` key `mimi.chat.<chatId>.background` (ดู `realtime.md` ข้อ 8)
- แกลเลอรี: agent สั่งแสดงรูปทับแชตด้วยเครื่องมือ `gallery_show` (`feature-gallery.js:1-4`) รูป `GET /api/gallery/<agent>/<id>`,
  thumbnail `/thumb` (ถ้า `thumb: true`) — client ที่อัปโหลดควรสร้าง JPEG ย่อแล้ว `POST …/thumb` เอง (≤512 KB)

## 5. VRM / 3D

- เว็บใช้ three.js + `@pixiv/three-vrm` เล่นท่า Mixamo FBX ด้วยการ retarget ลง humanoid rig มี expression, กะพริบตา, lipsync ตามจังหวะพิมพ์
  (`feature-vrm.js:1-3, 121-210`) ไฟล์: `GET /api/agent-model/<agent>` (`.vrm` = glTF 2.0 + extension VRM), `GET /api/agent-motions/<agent>`,
  `GET /api/agent-motion/<agent>/<name>` (FBX)
- **ไม่มี library native ที่เทียบเท่า three-vrm ตรง ๆ** ทางเลือก:

| ทาง | ข้อดี | ข้อเสีย |
|---|---|---|
| Unity as a Library (UniVRM) ฝังในแอป | VRM + Mixamo ครบที่สุด | แอปใหญ่ขึ้นมาก, build ซับซ้อน, 3 แพลตฟอร์มคนละ integration |
| Filament (Android) / RealityKit-SceneKit (Apple) โหลด glTF เอง + เขียน VRM extension (spring bone, expression) เอง | native แท้ | งานหนักมาก (L+) และ FBX ต้องแปลงเป็น glTF ที่เซิร์ฟเวอร์ก่อน |
| แปลง VRM/FBX เป็น glTF + animation ที่เซิร์ฟเวอร์ แล้วใช้ viewer glTF ธรรมดา | ง่ายกว่า | เสีย spring bone / expression บางส่วน |

ข้อเสนอ: เฟสแรกแสดงตัวละครเป็นรูป 2D (sprite/portrait) เหมือนที่เว็บทำเมื่อโหลด VRM ไม่ได้ (CHANGELOG 0.8.0 "keeps its 2D picture")
แล้วตัดสินใจเรื่อง 3D ในเฟสฟีเจอร์หนัก — คำถาม Q6

## 6. เสียงของแอป

เสียงแจ้งเตือนในแชต 3 ไฟล์: `/sounds/chat_1.mp3` (ส่ง), `chat_2.mp3` (ตอบเสร็จ), `chat_3.mp3` (ขออนุญาต) (`web-files.ts:55-58`)
มีสำเนาใน `android/app/src/main/res/raw/` แล้ว — แอป native ควร bundle ไฟล์เหล่านี้เอง ไม่ต้องโหลดจากเซิร์ฟเวอร์
