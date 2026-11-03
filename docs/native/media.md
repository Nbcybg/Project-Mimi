# สื่อ: เพลง (Mimiamp), ไฟล์แนบ, เสียงพูด, รูป, VRM/3D

> endpoint ทั้งหมดอยู่ใน `api-contract.md` ส่วน A ไฟล์นี้บอกว่า **ฝั่ง native ต้องใช้อะไร** และกับดักที่เจอจากโค้ด/การทดสอบ

## 1. Mimiamp (เครื่องเล่นเพลง)

### 1.1 ที่มาของเพลง

| แหล่ง (`MimiampTrack.source`) | คืออะไร | เล่นจาก |
|---|---|---|
| `file` | ไฟล์เสียงในโฟลเดอร์เพลงของเซิร์ฟเวอร์ (`MIMI_MUSIC_DIR` → `<user>/mimiamp` → `<app>/mimiamp` → โฟลเดอร์ demo ในตัว: `packages/core/src/mimiamp/library.ts:73-93`) | `track.url` = `/mimiamp/<ชื่อไฟล์ url-encoded>` (ไม่ต้องใช้ token, รองรับ Range) |
| `youtube` | ลิงก์ YouTube ที่ผู้ใช้เพิ่ม เซิร์ฟเวอร์ดาวน์โหลด **เฉพาะเสียง** มา cache (`packages/core/src/mimiamp/service.ts:355-380`) | ต้อง `POST …/prepare` ก่อน แล้วเล่นจาก `/mimiamp/youtube/<id>.audio` หรือ `/api/mimiamp/youtube/<id>/audio` |
| `local` (เฉพาะใน playlist item) | ไฟล์บน **อุปกรณ์ของผู้ฟังเอง** ไม่เคยอัปโหลด (`playlists.ts:14-15`) เว็บเก็บ handle ใน IndexedDB (`feature-mimiamp.js:527-570`) | ไฟล์ในเครื่อง; อุปกรณ์อื่นแสดงเป็น "ไฟล์บนเครื่องอื่น" เล่นไม่ได้ (`feature-mimiamp.js:411-445`) |

ชนิดไฟล์ที่เซิร์ฟเวอร์เสิร์ฟ: `.mp3 .m4a .aac .ogg .oga .opus .wav .flac .weba .webm` (`library.ts:11-22`)
— ExoPlayer/Media3 เล่นได้ทั้งหมด; **AVPlayer (iOS/macOS) ไม่เล่น `.ogg`/`.opus`/`.webm`/`.weba`** ต้องข้ามหรือใช้ decoder เพิ่ม (เช่น VLCKit / FFmpeg)
Windows `MediaPlayer` เล่น ogg/opus/flac ได้บน Windows 10 1809+ (ต้องมี Web Media Extensions สำหรับ ogg)

### 1.2 Flow ที่แอปต้องทำ

```
เปิดหน้า Mimiamp ─▶ GET /api/mimiamp/state      → tracks[], playlists[], youtube{ready,google,error?}
เล่นเพลง file     ─▶ GET <base>/mimiamp/<file>  (Range)
เล่นเพลง youtube  ─▶ POST /api/mimiamp/youtube/<id>/prepare  (อาจใช้เวลา: แสดง "PREPARING")
                  ─▶ เล่นจาก URL ที่ได้ (ดู 1.3)
เพิ่มจากลิงก์     ─▶ POST /api/mimiamp/youtube {url, playlist?}
ค้นหา YouTube     ─▶ GET  /api/mimiamp/youtube/search?q=
แก้ playlist      ─▶ /api/mimiamp/playlists… (ทุกครั้งเซิร์ฟเวอร์ broadcast mimiamp/refresh)
WS {type:'mimiamp', command} ─▶ ทำตาม command (1.4)
```

เว็บเดิม: `feature-mimiamp.js:486-500` (state), `:736-760` (prepare), `:775-810` (เล่น)

### 1.3 URL เสียงที่ควรใช้ — ขึ้นกับโหมดเซิร์ฟเวอร์

| เพลง | core (คนเดียว) | gateway (หลายผู้ใช้) |
|---|---|---|
| `file` | `/mimiamp/<file>` ✓ Range | `/mimiamp/<file>` ได้ **ไฟล์ในโฟลเดอร์ของ gateway** ไม่ใช่ของ core (`gateway.ts:207` เรียก `serveWebFile` โดยไม่มี service) — ตรงกันเฉพาะเพลง demo ที่มากับ image เดียวกัน; เพลงใน `<user>/mimiamp` ของผู้ใช้ **เข้าไม่ถึง** |
| `youtube` | `/mimiamp/youtube/<id>.audio` ✓ Range | `/mimiamp/youtube/<id>.audio` **404 เสมอ** (ทดสอบแล้ว) → ต้องใช้ `/api/mimiamp/youtube/<id>/audio` + Bearer ซึ่ง **ไม่มี Range** และอ่านทั้งไฟล์ (`http-api.ts:181-187`) |

เว็บเดิมหลบปัญหานี้ด้วยการดาวน์โหลด `/api/mimiamp/youtube/<id>/audio` ทั้งไฟล์มาเป็น blob ก่อนเล่น (`feature-mimiamp.js:750-755`)
**[api 1] แก้แล้ว:** gateway ส่ง `/mimiamp/*` ที่มี `Authorization: Bearer` ต่อไป core ของคนนั้น (Range ผ่านได้) และ
`/api/mimiamp/youtube/<id>/audio` รองรับ Range → **แอป native เล่นทุกเพลงจาก `<base>` + `track.url` พร้อม header Bearer ได้เลย ทั้งสองโหมด**
(YouTube: `POST …/prepare` ก่อน) ตารางด้านบนคือพฤติกรรมของ core ก่อน api 1 — ถ้า `/health.api` ไม่มี ให้ดาวน์โหลดเพลง YouTube ทั้งไฟล์ลง cache ก่อนเล่นแบบเว็บ

เพลงของผู้ใช้อยู่ใน `<user>/mimiamp` บน volume (image ไม่มีเพลงแล้ว) อัปโหลดได้ด้วย `POST /api/mimiamp/files?name=` (`api-contract.md` A.7, `docs/hosting.md`)

### 1.4 คำสั่งจาก agent (`{"type":"mimiamp","command":MimiampCommand}`)

`protocol.ts:685-708`; เว็บทำตาม `feature-mimiamp.js:2235-2339`

| `action` | ทำอะไร |
|---|---|
| `open` | เปิด/แสดงเครื่องเล่น (เว็บเปิดแบบลอย) |
| `play` + `query?` | ไม่มี query = เล่นต่อ/เล่นเพลงแรก; มี query = หาเพลงที่ `id/title/artist/album/file/videoId` ตรง (ไม่สนตัวพิมพ์) ก่อน แล้วค่อยหาแบบ "มีคำนี้" ในคิวปัจจุบัน → ถ้าไม่เจอ โหลด state ใหม่แล้วหาในคลังทั้งหมด |
| `pause` / `stop` / `next` / `previous` | ตามชื่อ |
| `volume` + `level` (0–100) | ตั้งเสียง |
| `seek` + `seconds` | เลื่อนตำแหน่ง |
| `playlist-play` + `query` (id หรือชื่อ playlist) | เปิด playlist แล้วเล่นเพลงแรก |
| `refresh` | โหลด `/api/mimiamp/state` ใหม่ |

เซิร์ฟเวอร์ broadcast ไป **ทุกอุปกรณ์ที่เปิดอยู่** (`server.ts:854-857`) แอปควรมีตัวเลือก "เล่นบนอุปกรณ์นี้เท่านั้นเมื่อถูกสั่ง"
หรือทำตามเฉพาะอุปกรณ์ที่ foreground (เว็บทำตามทุกตัว) — คำถามให้เจ้าของโปรเจกต์ข้อ Q5

### 1.5 สิ่งที่ native ต้องใช้

| ความสามารถ | เว็บใช้ | Android | iOS / macOS | Windows |
|---|---|---|---|---|
| เล่น + Range + header | `<audio>` + blob | Media3 ExoPlayer, `DefaultHttpDataSource.Factory().setDefaultRequestProperties(mapOf("Authorization" to …))` | `AVPlayer` + `AVURLAsset(url, options: ["AVURLAssetHTTPHeaderFieldsKey": …])` (key ไม่เป็นทางการ) หรือดาวน์โหลดลงไฟล์ก่อน | `MediaPlayer` + `MediaSource.CreateFromStream` / `HttpRandomAccessStream` ที่ใส่ header เอง |
| เล่นต่อเมื่อออกจากแอป + ปุ่มบนหน้าจอล็อก | Media Session API (`feature-mimiamp.js:263-282, 384-410`) | `MediaSessionService` (Media3) + foreground service type `mediaPlayback` | `AVAudioSession(.playback)` + `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter`, Background Modes: audio | `SystemMediaTransportControls` |
| EQ 10 แบนด์ (60–16k Hz, ±12 dB) + pan | Web Audio `BiquadFilter` + `StereoPanner` (`feature-mimiamp.js:17-28, 285-310`) | `android.media.audiofx.Equalizer` (แบนด์ตามเครื่อง) หรือ `AudioProcessor` เองใน ExoPlayer | `AVAudioEngine` + `AVAudioUnitEQ` (ใช้กับ `AVPlayer` ตรง ๆ ไม่ได้ ต้องเล่นผ่าน engine) | `AudioGraph` + `EqualizerEffectDefinition` (4 แบนด์) หรือ NAudio |
| spectrum / visualizer | `AnalyserNode` | `Visualizer` (ต้องสิทธิ์ `RECORD_AUDIO`) หรือ `AudioProcessor` | `installTap` บน `AVAudioEngine` | `AudioGraph` frame output |
| ไฟล์ในเครื่อง (`local`) | IndexedDB + File System Access | `ACTION_OPEN_DOCUMENT` + `takePersistableUriPermission` | `UIDocumentPickerViewController` + security-scoped bookmark | `FileOpenPicker` + `FutureAccessList` |

EQ/visualizer เป็นงาน L ที่ไม่ต้องมีในรอบแรก (ดู `feature-inventory.md`)

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
