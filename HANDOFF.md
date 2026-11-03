# Mimi handoff — 2026-11-03 (เครื่อง Windows → ทำต่อบน Mac)

## ทำต่อบน Mac (อ่านก่อน)

- งานทั้งหมดถึงรอบที่ 4 อยู่บน GitHub `main` แล้ว (`Nbcybg/Project-Mimi`) · `main` เดิมก่อนรวมงานแอป native สำรองไว้ที่ branch
  `backup/main-2026-11-03-before-native` · บน Mac: `git clone` (หรือ `git pull`) → `npm install` → `npm test`
- ไม่อยู่ใน git (สร้างใหม่ได้): `node_modules/`, `dist/` (ตัวติดตั้ง Windows x64/arm64 ของรอบที่ 4 อยู่ที่เครื่อง Windows `P:\Project_Code\New folder\Project-Mimi-main\dist\win-native\`),
  `apps/windows/**/bin|obj`, `android/local.properties`, `_old/`, `user/`, `.env` · core ทดสอบ + LLM จำลองของ session นี้อยู่ใน scratchpad ของเครื่อง Windows (สร้างใหม่ตาม `apps/windows/README.md` หัวข้อ "UI test")
- แอป Windows **build/ทดสอบบน Mac ไม่ได้** (WinUI 3 ต้องใช้ Windows) — บน Mac ทำได้: แก้โค้ด C# (ไม่ได้ compile), งานเซิร์ฟเวอร์ (`packages/`), Phase 3 (แอป Mac), Android

### ฟีเจอร์ที่ยังขาดของแอป Windows (ตามจริง หลังรอบที่ 4)

- ยังไม่มี:
  - workflow editor: preview expression (`workflow-expr-preview`), สร้าง/แก้/ย้ายโน้ตบนผัง (ตอนนี้แสดงอย่างเดียว), ตัวเลือกของ node Connector จากบริการ (`connector-operation-options`)
  - VRM: ท่า Mixamo (`motions`, `idleMotion`) ยังไม่เล่น (มีแค่หายใจ/กะพริบ/อารมณ์/ขยับปาก)
  - รูปแกลเลอรี/ภาพสถานการณ์ทับแชต (#25) — ตอนนี้แค่สั่งเอาออกได้
  - ฟอร์มย่อยแทน JSON ทำแล้วเฉพาะกล่องเมล — preset เครื่องมือ, ช่องของ connection, ข้อมูลโปรไฟล์, `vars` ของ workflow ยังเป็น JSON
  - Workspace: ปุ่ม "ส่งภาพที่วาดเข้าแชต" (Electron มี; ตอนนี้คัดลอกแล้ววาง)
  - WNS (แจ้งเตือนตอนแอปปิด, รอ Q3), Windows widget (#19, ต้อง package identity)
  - **โหมด "เซิร์ฟเวอร์ในเครื่องนี้"**: แอป native ยังไม่เปิด core ให้เองแบบ `npm run app` (launcher.ts) ของเดิม — ตอนนี้ต้องรัน core เองแล้วต่อ `http://localhost:8787`
    (ถ้าทำ: ใส่ core ลงชุดติดตั้ง (มี `node.exe` อยู่แล้ว), แอปเปิด/ปิด core เอง, สร้าง token ให้, ชี้ localhost อัตโนมัติ)
- ทำแล้วแต่ยังไม่ได้ลองของจริง: VRM กับไฟล์ `.vrm` จริง, เบราว์เซอร์ Workspace กับเว็บจริง, ตัวช่วยตั้งค่ากับผู้ให้บริการจริง, รายการทดสอบมือเดิม
  (ถาด, toast, ปุ่มมีเดีย, ไมค์, PC agent + consent, setup.exe ทับ Electron, gateway + 2FA), arm64 บนเครื่องจริง, Windows 10

### ต้องตัดสินใจ

- **คลังเพลงของ Mimiamp** (คุยค้างไว้): ตอนนี้คลังอยู่บนเซิร์ฟเวอร์ (`<user>/mimiamp` บน volume, เพลง demo 285 MB เป็น .wav ใน `mimiamp/` ของ repo)
  และสตรีมด้วย Range — กิน bandwidth มากสุดของเซิร์ฟเวอร์ · แอป Windows เล่นไฟล์ในเครื่องได้แล้ว (เพิ่มเองทีละไฟล์, `config.json` → `windows.localTracks`) ทางเลือก:
  1. ฝังเพลงในตัวติดตั้ง — ไฟล์ติดตั้งใหญ่ขึ้นเท่าคลัง (ตอนนี้ +285 MB ถ้าไม่แปลงเป็น mp3/opus), เปลี่ยนเพลงต้องออกเวอร์ชันใหม่
  2. โฟลเดอร์ในเครื่อง (เช่น `เพลง\Mimiamp`) ที่แอปสแกนเอง — เพิ่ม/ลบเพลงได้เอง ไม่ต้องผ่านเซิร์ฟเวอร์ (ผู้เขียนแนะนำข้อนี้ + เพลง demo ชุดเล็กเป็น mp3 ในตัวติดตั้ง)
  - ต้องคิดต่อ: คำสั่ง `mimiamp` จาก agent และเพลย์ลิสต์ที่เก็บบนเซิร์ฟเวอร์อ้างถึง track ของคลังเซิร์ฟเวอร์ — ถ้าคลังอยู่ในเครื่อง agent จะไม่เห็นรายชื่อเพลง
    (ต้องให้แอปส่งรายชื่อเพลงในเครื่องขึ้นไป หรือให้ agent สั่งด้วยชื่อ/คำค้นแทน id) และมือถือจะเปิดเพลงในเครื่อง PC ไม่ได้
- เดิม: `release.yml` แจกแอป native แทน Electron ไหม, ผลทดสอบ APK บนมือถือ, คำตอบ Q1–Q12 (`docs/native/README.md`)

## งาน 2026-11-03 รอบที่ 4 (อ่านก่อน) — หน้าตาแบบต้นแบบ Electron + ส่วนที่ขาดของแอป Windows

คำสั่งของเจ้าของโปรเจกต์: ทำส่วนที่ขาดให้จบ (ฟอร์มเฉพาะแทน JSON, workflow ลากวาง + ทดสอบ node, ตัวละคร 2D + VRM 3D, หน้าตาต่อแชต,
ตัวช่วยตั้งค่าทีละขั้น, ธีมสว่าง, Workspace) + **UI แชต / ตั้งค่า / Mimiamp ให้เหมือนตัวต้นแบบ Electron** แล้ว build เพื่อ test
**กติกาเปลี่ยน: ใช้ WebView ได้ถ้าจำเป็น** — ใช้ WebView2 แค่ 3 ที่: เบราว์เซอร์ของ Workspace, ตัวละคร VRM 3D (three-vrm), จอเทอร์มินัล (xterm.js)

- **ทำแล้ว** (รายละเอียด + ไฟล์: ตาราง "รอบที่ 4" ใน `apps/windows/README.md`, CHANGELOG หัวข้อ "the Electron look, the editors and the Workspace"):
  ธีมมืด/สว่าง (`Services/Theme.cs`), หน้ารายการแชตเป็นแผงข้างแบบเว็บ + nav, ตั้งค่า 4 แท็บแบบเว็บ, แชตแบบเว็บ + เวที (ฉากหลัง + ตัวละคร 2D/3D) +
  แผง "ข้อมูล" (สถานะ agent, หน้าตาต่อแชต), Mimiamp สกิน blue edition + visualizer + pan + เพลงในเครื่อง, ฟอร์มย่อย (กล่องเมล) + ผลลัพธ์แบบอ่านได้ (รายงานแพ็ก,
  ผลรัน workflow), workflow editor ลากวาง + ทดสอบ node, ตัวช่วยตั้งค่า 5 ขั้น, หน้าต่าง Workspace (ไฟล์ / เบราว์เซอร์ + วาด / เทอร์มินัล ConPTY)
- ไฟล์ใหม่: `Mimi.App/{Services/Theme.cs, Services/StageData.cs, Controls/{Ui,StageView,VrmView,ResultView,SpecForm}.cs, Views/{ChatView.Stage,SettingsSections,
  WorkflowEditor,SetupWizard,Workspace}.cs, Native/ConPty.cs, Assets/web/{vrm,terminal}.html}`, `Mimi.Core/{Hub/WorkflowDraft.cs, Mimiamp/Spectrum.cs}`,
  `tests/Mimi.Core.Tests/EditorAndLookTests.cs`, `tests/Mimi.App.UiTests/{FeatureTourTests,WindowShot}.cs` · csproj คัดลอก three/three-vrm/xterm จาก
  `node_modules` และ `backgrounds/*.webp` เข้า `Assets/` (ต้อง `npm install` ก่อน build)
- ผลตรวจ: build 0 error, unit test **75/75**, UI test **3/3** (ตัวใหม่: ธีม, หน้าตาแชต + ฉากหลัง, Mimiamp, สร้าง workflow + เพิ่ม node + ทดสอบ node, ตัวช่วยตั้งค่า,
  Workspace จนเทอร์มินัลขึ้น prompt) กับ core ทดสอบ + LLM จำลองในเครื่อง · `dist/win-native/` build ใหม่ทั้ง x64 และ arm64 (zip + setup.exe, unsigned)
  และ UI test 3/3 ผ่านกับ `dist/win-native/Mimi/Mimi.exe` (self-contained Release) ด้วย
- ⚠️ **ยังไม่ได้ลอง**: VRM กับไฟล์ `.vrm` จริง (ไม่มีไฟล์ตัวอย่างในเครื่อง — ตรวจแค่ว่าหน้า three-vrm โหลดได้), ท่า Mixamo ยังไม่เล่น, เบราว์เซอร์ Workspace
  กับเว็บจริง (ไม่ได้เปิดเว็บภายนอกระหว่างทดสอบ), ตัวช่วยตั้งค่ากับผู้ให้บริการจริง (ChatGPT/Claude/API key)
- ยังไม่มี: preview expression ใน workflow editor, แก้โน้ตบนผัง, รูปแกลเลอรี/ภาพสถานการณ์ทับแชต, ฟอร์มย่อยของ preset เครื่องมือ/connection/โปรไฟล์ (ยัง JSON), WNS
- กับดักที่เจอ: `OpacityTransition` กับ `RenderTransform*` บน element เดียวกันไม่ได้ (แอป crash ตอนเริ่ม → ย้าย transform ไปที่ตัวห่อ);
  ConPTY ต้องตั้ง `STARTF_USESTDHANDLES` (ไม่งั้นเมื่อ std handle ของแอปถูก redirect shell จะเขียนไปที่นั่นแทน); `TextBox.TextChanged` ของ WinUI มาแบบ async
  (UI test ต้องรอสักครู่หลังพิมพ์ก่อนกดบันทึก); UIA มองไม่เห็นป้ายข้าง WebView2 บางตัว; เริ่มแอปไม่สำเร็จจะเขียน `start-error.txt` ใน `%LOCALAPPDATA%\Mimi`
- ⚠️ เครื่องนี้มีแอป Mimi ที่ติดตั้งจริงและล็อกอินอยู่ (`%LOCALAPPDATA%\Programs\Mimi`) — ทดสอบด้วย `MIMI_WINDOWS_HOME` เสมอ และ UI test ถ่ายภาพเฉพาะหน้าต่างของแอปทดสอบ
  (PrintWindow) ไม่ถ่ายจอ
- ไม่ได้แตะเซิร์ฟเวอร์ (`packages/`) — ไม่ต้องขึ้น `API_VERSION`

## งาน 2026-11-03 รอบที่ 3 — แอป Windows ให้ครบเท่าแอป Electron

คำสั่งของเจ้าของโปรเจกต์: "เอาให้ครบเหมือนตัวที่เป็น electron … function ทุกอย่างใช้ได้เหมือนกัน UI เหมือนกัน จบแล้วปิดเครื่อง" —
session นี้จบด้วยการสั่งปิดเครื่อง (`shutdown /s /t 120`) หลังเขียนไฟล์นี้; **core ทดสอบ (8787) และ LLM จำลอง (9911) ที่รันไว้ในเครื่องจะหายไป**
(สร้างใหม่ตาม `apps/windows/README.md` หัวข้อ "UI test")

- **ทำแล้ว**: ทุกหน้าของเว็บอยู่ในแอป Windows ผ่านเมนู ☰ — Agent, Hub 10 แท็บ, Workflow, AI Overseer, ตั้งค่า Mimi (3 แท็บ) — ด้วยหน้าจัดการแบบ generic
  (`apps/windows/src/Mimi.Core/Hub/{Entities,Catalog,Lookups}.cs`, `Mimi.App/Views/ManagePage.cs`, `Mimi.App/Controls/{JsonForm,WorkflowGraph}.cs`)
  + แชตที่เหลือ: การ์ด task, แถบ session + มาตรวัด context, อ่านออกเสียง, อีโมจิ, แชตกลุ่ม, ดาวน์โหลด CSV/ลบแชต; Mimiamp เปลี่ยนชื่อ/ส่งออก/นำเข้าเพลย์ลิสต์
- โครงใหม่ใน Core: `MimiSession.Raw` (ทุก frame เป็น JSON), `MimiSession.Ask` (ส่ง frame แล้วรอคำตอบ/error), `UiValue/SetUi` (`ui-set`),
  `MimiApi.SendBody/PostJson`, `ClientFrames.Json` (ตัด field ระดับบนที่เป็น null ทิ้ง)
- กับดักที่เจอ: แก้ของเดิมต้องส่ง `renameFrom` = ชื่อเดิม**เสมอ** (core เช็ก `renameFrom !== name && exists`); WinUI เปิด ContentDialog ได้ทีละอัน
  (`ManagePage.ShowDialog` รอ/ลองใหม่); TextBox แบบอ่านอย่างเดียวหลายบรรทัดไม่ส่งข้อความให้ UI Automation (ใช้ TextBlock ที่เลือกข้อความได้);
  ScrollViewer ของ WinUI 3 เป็น sealed; `MIMI_DEBUG_LOG=<ไฟล์>` เปิด log ขั้นตอนของ dialog ในหน้าจัดการ
- **ยังไม่เหมือน/ยังไม่มี** (ตามจริง): ฟอร์มเป็นแบบทั่วไป (ค่าซับซ้อนแก้เป็น JSON, ผลแสดงเป็น JSON) ไม่ใช่หน้าตาเดียวกับเว็บ; workflow canvas ลากวาง/ทดสอบ node;
  เวทีตัวละคร 2D + VRM 3D + หน้าตาต่อแชต; Workspace; setup wizard แบบทีละขั้น; ธีมสว่าง; Mimiamp pan/visualizer/ไฟล์ในเครื่อง; WNS — รายละเอียด
  `apps/windows/README.md` และตารางท้าย `docs/native/feature-inventory.md`
- ผลตรวจ: build 0 warning (x64 Debug + Release x64/arm64), unit test **66/66**, UI test **2/2** ผ่าน 3 รอบติด
  (ตัวใหม่เปิดทุกหน้าทุกแท็บ, เพิ่ม/แก้/ลบ skill, ติดตั้งแพ็ก → ดูผัง workflow → ถอนแพ็ก); `dist/win-native/` มี zip + setup.exe ทั้ง x64 และ arm64 ของรอบนี้
- ไม่ได้แตะเซิร์ฟเวอร์ (`packages/`) รอบนี้ — `npm test` ไม่ได้รันซ้ำ (ผลล่าสุด 768/768)
- ยังรออยู่เหมือนเดิม: ผลทดสอบ APK บนมือถือ, ตัดสินใจ `release.yml`, คำตอบ Q3 (WNS) และ Q1–Q12
- ถัดไปที่แนะนำ: เปิดแอปด้วยตาบนเครื่องจริงทีละหน้า (ภาพหน้าจอใน UI test ของหน้าจัดการบน VM นี้ออกมาดำ) → ฟอร์มเฉพาะของหน้าที่ใช้บ่อย
  (agent, trigger, กล่องเมล) แทน JSON → workflow canvas → เวทีตัวละคร 2D

## งาน 2026-11-03 รอบที่ 2

- **arm64**: `node scripts/build-win-native.mjs --arch arm64` ผ่าน (exe เป็น ARM64 จริง) — ไม่มี node.exe arm64 ในชุด (PC agent ใช้ node ใน PATH),
  ยังไม่ได้รันบนเครื่อง arm64 · ⚠️ สคริปต์ล้าง `dist/win-native/` ทุกครั้ง: build arm64 แล้ว x64 ต้องเก็บไฟล์ของ arch แรกไว้ก่อน
  (ตอนนี้ใน `dist/win-native/` มีทั้ง x64 และ arm64 zip + setup.exe ที่รวมงานรอบนี้แล้ว)
- **Phase 6 ชุดแรกบน Windows = ฟีเจอร์แชตเฟส A ที่ขาด** (เลือกก่อน Hub เพราะ feature-inventory จัดเป็น "ต้องมีก่อนปล่อย"):
  เมนูข้อความ (ถูกใจ/รีแอ็กชัน/ตอบกลับ/ส่งต่อ/คัดลอก/ปักหมุด/rewind), แถบหมุด, ค้นหา (Ctrl+K), กล่องแจ้งเตือน (กระดิ่ง)
  - โค้ด: `apps/windows/src/Mimi.Core/{Protocol/Models.cs, Protocol/Frames.cs, Protocol/MessageFormat.cs (Highlight), Chat/ChatTimeline.cs (Pins, Latest),
    ViewModels/ChatViewModel.cs, ViewModels/SearchViewModel.cs, ViewModels/InboxViewModel.cs}`,
    `apps/windows/src/Mimi.App/{Views/ChatView.*, Views/SearchView.*, Views/InboxView.*, Controls/HighlightText.cs, MainWindow.*, App.xaml.cs}`
  - ไม่ได้แตะเซิร์ฟเวอร์ (ใช้ frame ที่มีอยู่แล้ว) จึงไม่ต้องขึ้น `API_VERSION`
  - ผลตรวจ: build 0 warning, unit test **59/59** (5 รอบ), UI test 1/1 (เพิ่มขั้นปักหมุด/ตอบกลับ/ค้นหา/เลิกปักหมุด/กล่องแจ้งเตือน) กับ core ทดสอบในเครื่อง
  - สถานะทำแล้ว/เหลือต่อฟีเจอร์: ตารางท้าย `docs/native/feature-inventory.md`; สิ่งที่ยังไม่ได้ทดสอบมือ: `apps/windows/README.md`
- ชุดถัดไปที่แนะนำ (Windows): การ์ดงาน #10 + session #14 → TTS #20 → Overseer #31 → แชตกลุ่ม #16 → แล้วจึง Hub/ตั้งค่า (เฟส B)
- ยังรออยู่เหมือนเดิม: ผลทดสอบ APK บนมือถือ, ตัดสินใจ `release.yml`, คำตอบ Q3 (WNS)

## งาน 2026-11-03 บนเครื่อง Windows

- เครื่องนี้: Windows 11 x64, Node 24.18 — เครื่องมืออยู่ที่ `P:\tools\` (ไม่ได้ติดตั้งลงระบบ):
  JDK `P:\tools\jdk-17.0.20.1+1`, Android SDK `P:\tools\android-sdk` (platform 35/36, build-tools 35, platform-tools; `cmdline-tools\latest`
  ถูกแทนด้วยเวอร์ชันใหม่ 2026-11-02), Gradle home `P:\tools\gradle-home`, .NET 10 SDK `P:\tools\dotnet`, NuGet cache `P:\tools\nuget-packages`, NSIS `P:\tools\nsis-3.10`
  — ไม่มี Hyper-V/WHPX จึงไม่มี emulator
- `node_modules` ที่คัดลอกมาจาก Mac ใช้ไม่ได้ (workspace link เป็นโฟลเดอร์จริง → Node ไม่ strip type) — ลบแล้ว `npm install` ใหม่
  (`better-sqlite3`/`node-pty` install script ถูก allowScripts บล็อก แต่ better-sqlite3 มี prebuild win32-x64 อยู่แล้ว)
- เซิร์ฟเวอร์: typecheck ผ่าน, **`npm test` 768/768 ผ่าน** (ไม่มี skip บน Windows)
- **Phase 2 (Android)**: `:core:model:test testDebugUnitTest assembleDebug` ผ่านบน Windows (unit test 21/21) —
  ทำ APK debug ที่ชี้ `http://192.168.0.119:8787` ไว้ที่ `dist/android/Mimi-p2test-debug.apk` ให้เจ้าของโปรเจกต์ทดสอบบนมือถือจริง
  (ไม่มี emulator) กับ core ทดสอบ + LLM จำลองบนเครื่องนี้ — **ผลทดสอบบนมือถือยังไม่ได้รับ** เกณฑ์ "เสร็จ" ของ Phase 2 ยังเปิดอยู่
  ```powershell
  $env:JAVA_HOME="P:\tools\jdk-17.0.20.1+1"; $env:GRADLE_USER_HOME="P:\tools\gradle-home"; cd android; .\gradlew.bat "-PmimiHost=http://<IP>:8787" assembleDebug
  ```
- **Phase 3/4 ข้าม** (ต้องใช้ Mac) — ตามที่เจ้าของโปรเจกต์สั่ง "test p2 แล้วไป p5"
- **Phase 5 (Windows native) — MVP เสร็จ**: `apps/windows/` — WinUI 3 (Windows App SDK 2.6.4) + .NET 10 ไม่มี WebView;
  ดู [`apps/windows/README.md`](apps/windows/README.md) (ขอบเขต, เหตุผลที่เลือก, สถานะ, สิ่งที่ยังไม่ทำ/ไม่ได้ทดสอบ)
  - ผลตรวจ: build ผ่าน (0 warning), unit test 52 ตัวผ่าน (รัน 10 รอบไม่ล้ม), UI test (FlaUI) ล็อกอิน → แชตใหม่ → คำตอบ stream ครบ →
    Mimiamp เล่นเพลง (นาฬิกาเดิน) → ออกจากระบบ (token หาย) ผ่านทั้ง Debug และ Release self-contained
  - แจกจ่าย: `node scripts/build-win-native.mjs` → `dist/win-native/Mimi/`, `Mimi-0.8.1-prototype-win-x64.zip` (131 MB),
    `Mimi-0.8.1-prototype-win-x64-setup.exe` (88 MB, NSIS) — **ยังไม่ได้ลองติดตั้ง setup.exe จริง**, unsigned
  - `release.yml` ยังไม่เปลี่ยน (ยังแจก Electron; ชื่อ zip ชนกัน ต้องเลือกตัวใดตัวหนึ่ง)
  - ไฟล์ใหม่นอก `apps/windows/`: `scripts/build-win-native.mjs`, `scripts/windows-icons.mjs`; แก้ `.gitignore`, `CHANGELOG.md`,
    `docs/native/{README,windows-stack,feature-inventory}.md`, `android/README.md`
  - กับดักที่เจอ (แก้แล้ว): CommunityToolkit.Mvvm 8.4 โหลด generator ซ้ำกับ SDK 10 → `apps/windows/Directory.Build.targets` ตัดให้เหลือ roslyn5.0;
    `EnableMsixTooling=false` ทำให้ publish ไม่มี `Mimi.pri` → แอป crash `0xC000027B` ตอนเปิด (ต้องเป็น `true` แม้ไม่ใช่ MSIX);
    build Debug เป็น framework-dependent ต้องตั้ง `DOTNET_ROOT=P:\tools\dotnet` ก่อนเปิด exe
- ⚠️ เครื่องนี้มีแอป Electron ที่ล็อกอินอยู่จริงที่ `%APPDATA%\Mimi` (มี session.bin) — ทดสอบแอป native ให้ตั้ง `MIMI_WINDOWS_HOME`
  เป็นโฟลเดอร์อื่นเสมอ (UI test ตั้งให้เอง และปิด PC agent ใน config ทดสอบ) และ**อย่า**เปิดแอป native แบบไม่ตั้งตัวแปรนี้บนเครื่องนี้
- ยังไม่มี git ในโฟลเดอร์นี้ — ไม่มีอะไรถูก commit

### สภาพแวดล้อมทดสอบที่รันอยู่ (ชั่วคราว หายเมื่อปิด session)

- core ทดสอบ `0.0.0.0:8787` (LAN `http://192.168.0.119:8787`) + LLM จำลอง `127.0.0.1:9911` — ข้อมูลอยู่ในโฟลเดอร์ scratchpad ของ session
  (`...\scratchpad\mimi-test\`: `mimi.json`, `user/agents/mimi/agent.md`, `test-token.txt`, `run-core.ps1`, `ws-smoke.mjs`) ไม่ใช่ `user/` จริง
- token ทดสอบอยู่ใน `test-token.txt` (31 ตัว, core เตือนว่าสั้นกว่า 32 — ตั้งใจให้พิมพ์บนมือถือได้ ใช้กับข้อมูลทดสอบเท่านั้น)
- สร้างใหม่ได้ตาม `apps/windows/README.md` หัวข้อ "UI test" (LLM จำลองอยู่ที่ `apps/windows/tests/tools/mock-llm.cjs`) — firewall ของ Windows
  อนุญาต Node บน Private network แล้ว มือถือจึงต่อเข้ามาได้

### กำลังรอ

- **ผลทดสอบ APK บนมือถือจริงจากเจ้าของโปรเจกต์** (เริ่มทดสอบ 2026-11-03): ล็อกอินด้วย token → แชต streaming → Mimiamp เล่นต่อเมื่อปิดจอ
  → ถ้าผ่าน: อัปเดต "สถานะ Phase 2" ใน `android/README.md` + `docs/native/README.md`; ถ้ามีปัญหา: แก้ใน `android/` แล้ว build APK ใหม่ (คำสั่งด้านบน)

### งานถัดไปของ Phase 5 (เรียงตามความสำคัญ)

1. ทดสอบมือ: ติดตั้ง `setup.exe` (ทับแอป Electron ในโฟลเดอร์เดิม — ระวัง session จริง), ถาด/เมนู, toast + คลิกเปิดแชต, ปุ่มมีเดีย/SMTC,
   ไมค์, แนบไฟล์/ลากวาง, การ์ดขออนุญาตกับเครื่องมือจริง, PC agent + กล่อง consent, ล็อกอัตโนมัติ, เปิดตอนเข้าสู่ระบบ, gateway + 2FA จริง
2. ตัดสินใจ `release.yml`: แจกแอป native แทน Electron ไหม (ถ้าใช่ แทนขั้น `build:win` ด้วย setup-dotnet 10 + `build-win-native.mjs`)
3. WNS (ต้อง sparse package + Azure app + ตัวส่งใน `packages/core/src/notify/native-push.ts`) — คำถาม Q3 ยังไม่มีคำตอบ
4. build arm64, ทดสอบ Windows 10
5. Phase 6 ฟีเจอร์ที่เหลือ (Hub, ตั้งค่า, ค้นหา, pin/react/reply, TTS ฯลฯ) ตาม `docs/native/feature-inventory.md`

## สถานะ (2026-11-02, เครื่องเดิม)

- เวอร์ชันใน `package.json` **0.8.1-prototype** · DB schema ล่าสุด **version 24** (`024-native-push.sql`)
- **โฟลเดอร์นี้ไม่มี `.git`** (สำเนาที่ทำงานอยู่ไม่ใช่ git repo) — งานตั้งแต่ 2026-11-02 ยังไม่ถูก commit ที่ไหนเลย
  ตอนย้ายเครื่องต้อง **คัดลอกทั้งโฟลเดอร์** (หรือคัดลอกทับลงใน clone ของ repo แล้ว commit) ไม่อย่างนั้นงานหาย
- ข้อมูลในส่วน "ทำเสร็จแล้ว / 0.7.9" ด้านล่างเป็นของ 2026-11-01 (อ้าง commit/branch ของเครื่องเดิม) — ตรวจกับ repo จริงอีกครั้ง
- งานใหม่ 2026-11-02: **แอป native** (เลิกครอบเว็บ) — Phase 0 สเปก, Phase 1 เซิร์ฟเวอร์, Phase 2 Android (รายละเอียดข้อถัดไป)
- เทสต์ล่าสุด (2026-11-02): typecheck ผ่าน; `npm test` **759 pass / 2 fail / 7 skipped (768)** — 2 ตัวที่ fail
  (`connector-performance` 100-node ≤5 s และ `pc-stdin` packaged layout ≤8 s) เป็นเรื่องเวลาเพราะเครื่องโหลดหนัก
  ทั้งคู่ fail กับโค้ด **ก่อน** แก้ด้วยเมื่อโหลดเท่ากัน (ทดสอบเทียบแล้ว) — บนเครื่องใหม่ที่ว่าง ควรรันซ้ำให้ผ่านครบ
- Android: build ผ่าน, unit test 21 ตัวผ่าน; **ยังไม่ได้ทดสอบ flow เต็มบน emulator** (emulator ค้างเพราะเครื่องเดิมโหลด 40–130 และ RAM หมด)
- สำเนาก่อนแก้: `_old/2026-11-02-before-native/` (server ก่อน Phase 1 + แอป Android WebView เดิม; อยู่ใน `.gitignore`)

## แอป native (2026-11-02)

เป้าหมาย: แอป **native แท้ ไม่ใช้ WebView** ทุกแพลตฟอร์ม เซิร์ฟเวอร์ทำหน้าที่ประมวลผล เก็บข้อมูล และ sync เท่านั้น
prompt ของแต่ละเฟสอยู่ที่ `docs/native-phase0-prompt.md` และ `docs/native-phases-prompts.md`
ลำดับ: 0 สเปก → 1 เซิร์ฟเวอร์ → 2 Android → 3 Mac → 4 iOS → 5 Windows → 6 ฟีเจอร์หนัก → 7 ปิดงาน

### Phase 0 — สเปก API (เสร็จ)

- `docs/native/` 10 ไฟล์: `README.md` (สารบัญ + คำถาม Q1–Q12 + ลำดับเฟส), `api-contract.md`, `realtime.md`,
  `auth-and-session.md`, `feature-inventory.md` (56 ฟีเจอร์ แบ่งเฟส A/B/C), `media.md`, `push-and-background.md`,
  `server-gaps.md` (มีสถานะ แก้แล้ว/เหลือ ทุกข้อ), `windows-stack.md` (แนะนำ WinUI 3 + C#), `api-versioning.md`
- ทุกข้ออ้าง `ไฟล์:บรรทัด` ของโค้ดก่อน Phase 1 (บรรทัดอาจเลื่อนไปเล็กน้อยหลังแก้) ส่วนที่เพิ่มใน Phase 1 มีป้าย **[api 1]**
- **คำถาม Q1–Q12 ใน `docs/native/README.md` ยังไม่มีใครตอบ** — สำคัญสุด: Q3 (กุญแจ FCM/APNs อยู่ที่ไหน),
  Q4 (ข้อความผ่าน Google/Apple ได้ไหม; ตอนนี้ค่าเริ่มต้นคือไม่ส่งข้อความจริง), Q9 (ช่องทางแจกจ่าย), Q2 (โหมด token เดียว)

### Phase 1 — เซิร์ฟเวอร์ (เสร็จ, client API 1)

รายละเอียดใน `CHANGELOG.md` (Unreleased → "Native clients, Phase 1") และ `docs/native/server-gaps.md`

- เช็กเวอร์ชัน: `API_VERSION` / `MIN_CLIENT_API` / close `4426` ใน `packages/shared/src/protocol.ts`; `/health` + `welcome` มี `api`,
  header `x-mimi-api`, `hello.client`; นโยบายใน `docs/native/api-versioning.md`
- Push native: `packages/core/src/notify/native-push.ts` (FCM HTTP v1 + APNs HTTP/2, payload `minimal` เป็นค่าเริ่มต้น),
  ตาราง `native_push_tokens` (`db/024-native-push.sql`), WS `native-push-register/unregister`, `POST /api/push/register|unregister`
  — env: `MIMI_FCM_SERVICE_ACCOUNT`, `MIMI_APNS_KEY` / `_KEY_ID` / `_TEAM_ID` / `_TOPIC`, `MIMI_NATIVE_PUSH_CONTENT`
- แชต: frame `chat-turn-messages` + `chat-open {afterId}` (`packages/core/src/server/chat-api.ts`)
- สื่อ: Range ของ `/api/files/:id` และ `/api/mimiamp/youtube/:id/audio`; gateway ส่ง `/mimiamp/*` ที่มี Bearer ไป core ของคนนั้น;
  เว็บในโหมด gateway โหลดเพลงด้วย token (`feature-mimiamp.js` `gatewayFileUrl`)
- **เพลงออกจาก Docker image แล้ว** (`Dockerfile`, `.dockerignore`) — อยู่ใน `<user>/mimiamp` บน volume, อัปโหลดด้วย
  `POST /api/mimiamp/files?name=` หรือ `railway volume files upload` (`docs/hosting.md` "เพลงของ Mimiamp บนเซิร์ฟเวอร์")
  ⚠️ ก่อน deploy ครั้งถัดไปต้องอัปโหลดเพลงในโฟลเดอร์ `mimiamp/` ขึ้น volume ไม่อย่างนั้นบน Railway เหลือแค่เพลง demo
- `MIMI_SERVE_WEB=0` (core + gateway), `GET /api/notifications?afterId=`, `POST /api/permissions/:id`, `POST /api/approvals/:id`,
  `E-PROTOCOL` + `error.requestType`, ชนิด Mimiamp/widget ย้ายไป `packages/shared/src/mimiamp.ts`
- เทสต์ใหม่ `packages/core/src/test/native-clients.test.ts` (12 ตัว รวม FCM/APNs กับบริการจำลอง); แก้เทสต์ที่ผูก schema 23 → 24
  และรูป `/health` (`db`, `chat-media`, `gateway`, `server` tests)
- ยังเหลือ: WNS (Windows), relay push ผ่าน gateway, ทดสอบ FCM/APNs กับ Google/Apple จริง, ข้อ P2/P3 ใน `server-gaps.md`
  (reqId กลาง, device token ของโหมด core, ฯลฯ)

### Phase 2 — Android (โค้ดครบ MVP, ยังไม่ผ่านเกณฑ์ "เสร็จ")

รายละเอียดใน `android/README.md` (หัวข้อ "สถานะ Phase 2")

- `android/` เขียนใหม่ทั้งหมด: Kotlin + Compose + Material 3, MVVM + Hilt + Coroutines/Flow, Retrofit + OkHttp WebSocket, Room cache,
  token ใน EncryptedSharedPreferences — 7 module: `app`, `core:{model,data,ui}`, `feature:{auth,chat,mimiamp}`
- Gradle wrapper 8.13, AGP 8.7.3, Kotlin 2.0.21, compileSdk/targetSdk 35, minSdk 23; package `app.mimi.android` (ติดตั้งทับแอปเดิมได้ถ้าเซ็นด้วยกุญแจเดิม)
- MVP: เชื่อมต่อ/ล็อกอิน (core token หรือ gateway + 2FA) + เช็กเวอร์ชัน, รายการแชต, แชต streaming (เครื่องมือ, การ์ดขออนุญาต,
  อนุมัติ, รูป, ไฟล์แนบ, ข้อความเสียง WAV), Mimiamp (Media3 + MediaSession เล่นพื้นหลัง, เพลย์ลิสต์, YouTube, shuffle/repeat,
  EQ 10 แบนด์, คำสั่งจาก agent), FCM (เมื่อใส่ `-PfcmProjectId/AppId/ApiKey/SenderId`) + poll ทุก 15 นาที, widget, ตัวเช็กอัปเดตจาก GitHub
- `.github/workflows/release.yml` job Android ใช้ `./gradlew` + Firebase ids จาก repository variables (ไม่บังคับ)
- **ยังไม่ได้ทดสอบ**: ล็อกอิน → แชต → เล่นเพลงในพื้นหลัง บน emulator, `connectedDebugAndroidTest` (Compose UI test เขียนแล้ว),
  FCM จริง, widget, EQ บนเครื่องจริง, ติดตั้งทับแอป WebView ที่เซ็นด้วยกุญแจจริง
- ไม่มีในแอป (ใช้เว็บไปก่อน): Hub, Agent, ตั้งค่า, workflow, trigger, คลังความรู้, ค้นหา, pin/react/reply/rewind, อ่านออกเสียง, ตัวละคร/VRM

## ทำเสร็จแล้ว (ก่อน 2026-11-02)

### 0.7.9 (commits `b8cd476` → `d722831`)

- **Setup wizard** — เปิดอัตโนมัติเมื่อเริ่มครั้งแรกแล้วยังแชตไม่ได้: ผู้ให้บริการ (Claude plan,
  ChatGPT plan หรือ API key + โมเดลหลัก) → starter agent (เลขาส่วนตัว / นักค้นคว้า /
  ผู้ช่วยจัดการเครื่อง / ผู้ช่วยเขียนโค้ด) → โฟลเดอร์ที่อนุญาต → PC agent → ทดสอบแชต
  - ใช้ message ปกติ (`provider-connect`, `settings-save`, `agent-save`, `chat-create`)
    จึงได้ผลเหมือนตั้งค่าเองทุกอย่าง; `mimi.setupDone` ถูก sync ข้ามอุปกรณ์
  - เปิดใหม่ได้ที่ปุ่ม **ตัวช่วยตั้งค่า** ในหน้า Settings; preset ที่อ่านเว็บ/อีเมลไม่มี shell
  - โค้ด: `packages/core/src/server/web/feature-setup.js`,
    `packages/core/src/agents/presets.ts`
- **OpenAPI import ในแอป** — Hub → Node & Tools → **+ นำเข้า OpenAPI**
  - preview ก่อน ไม่เขียนอะไร; ยืนยันแล้วเก็บที่ `user/connectors/imported/<key>.json`
    และเพิ่ม tools ทันทีโดยไม่ต้องรีสตาร์ท; แก้ทับ/ลบได้
  - JSON เท่านั้น (2 MB), server ต้องเป็น https และไม่ใช่ LAN/local,
    สูงสุด 50 imported connectors / 200 operations ต่อ connector
  - operation ที่นำเข้าเป็น `untrustedInput` ทั้งหมด, risk ตาม method, เพิ่ม trigger ไม่ได้,
    ใช้ absolute URL หรือยืม Google token ไม่ได้
  - derive pagination จากชื่อ param/response ที่พบบ่อย (page + size, cursor/pageToken + next)
    และอ่าน `x-mimi-rate-limit` (requests, perMs, burst); trigger และ `itemsPath` นอก
    `x-mimi-items-path` ยังไม่ derive
  - โค้ด: `packages/core/src/connectors/{openapi,imported}.ts`,
    `packages/core/src/server/web/feature-tools.js`, `docs/connectors/openapi-import.md`
- **Accounts gateway: session maximum age + 2FA** —
  - session หมดอายุ `MIMI_SESSION_MAX_DAYS` (ค่าเริ่มต้น 90) หลังล็อกอิน แม้ใช้งานต่อเนื่อง
  - TOTP ต่อบัญชี (RFC 6238, 6 หลัก, 30 วินาที, รับ clock drift ±1 step):
    ตั้งใน Settings → โปรไฟล์ของฉัน (เฉพาะโหมด gateway), secret เข้ารหัสด้วย
    `MIMI_GATEWAY_SECRET`, รหัสใช้ได้ครั้งเดียว (`totp_last_step`), รหัสผิดนับรวมกับ limiter
  - recovery codes 10 รหัสตอนเปิด 2FA (80 บิต, SHA-256, แสดงครั้งเดียว, ใช้ได้คนละครั้ง;
    สร้างชุดใหม่ได้ด้วยรหัสผ่าน) และหน้าเปลี่ยนรหัสผ่านเอง (ออกจากระบบเครื่องอื่น)
  - admin ปิดให้ด้วย `node packages/core/src/cli/accounts.ts 2fa-reset <ชื่อ>` (ออกจากระบบทุกเครื่อง)
  - แจ้งเตือนอุปกรณ์อื่นที่เปิดอยู่เมื่อมี session ใหม่ (`security-alert`)
  - โค้ด: `packages/core/src/gateway/{accounts,totp,gateway}.ts`,
    `packages/core/src/server/web/app.js` (`twoFactorPanel`, `passwordPanel`)
- **Cloudflare tunnel** — Settings → แอปและระบบ → **เข้าจากอินเทอร์เน็ต (Cloudflare Tunnel)**
  - เรียก `cloudflared tunnel --url http://127.0.0.1:<port>`; หา binary จาก PATH,
    โฟลเดอร์ติดตั้งปกติ หรือ `MIMI_CLOUDFLARED`
  - URL เป็น `https://<random>.trycloudflare.com` และ **เปลี่ยนทุกครั้งที่เริ่ม**;
    ใช้กับ webhook และ calendar push อัตโนมัติเมื่อยังไม่ได้ตั้ง public URL
  - ปฏิเสธเมื่อ core มี public address อยู่แล้ว หรือ `MIMI_TOKEN` สั้นกว่า 16 ตัว;
    ระหว่างเปิด tunnel เชื่อม ChatGPT plan ไม่ได้; limiter นับ `cf-connecting-ip`;
    cloudflared ไม่ได้รับ secret ใน environment
  - named tunnel: ตั้ง `MIMI_CLOUDFLARED_TUNNEL` + `_URL` หรือ `_CONFIG` (อ่าน hostname
    จาก ingress) → URL คงที่ และเริ่มเองตอนเปิด core เว้น `MIMI_CLOUDFLARED_AUTOSTART=0`
  - ไม่ได้ bundle cloudflared (ผู้ใช้ต้องติดตั้งเอง) และไม่มี UI สร้าง tunnel ใน Cloudflare
  - โค้ด: `packages/core/src/app/tunnel.ts`, `packages/shared/src/protocol.ts`,
    `packages/core/src/server/web/app.js` (`tunnelPanel`)
- **Signed builds + checked updates** — `scripts/signing.mjs` และ `release.yml`
  - Windows Authenticode (`WIN_CSC_*`, signtool), macOS Developer ID + hardened runtime
    (`APPLE_SIGN_IDENTITY`), notarize (`APPLE_ID`, `APPLE_APP_PASSWORD`, `APPLE_TEAM_ID`)
  - ทุก release มี `SHA256SUMS.txt`; updater ตรวจขนาด + SHA-256 และถ้าแอปเดิมลงนามแล้ว
    ตัวใหม่ต้องลงนามโดย publisher เดียวกัน (Authenticode subject / Team ID)
  - **ยังไม่ได้ตั้ง certificate/secrets จริง** จึงยังได้ build แบบ unsigned (Windows) /
    ad hoc (macOS)
  - Electron fuses ตั้งก่อนลงนาม (`scripts/fuses.mjs`): RunAsNode เปิด, NODE_OPTIONS/CLI inspect ปิด
  - โค้ด: `scripts/signing.mjs`, `scripts/fuses.mjs`, `scripts/build-{mac,win}.mjs`,
    `packages/desktop/updater.cjs`, `.github/workflows/release.yml`
- **Packs** — Hub → แพ็ก; ชุด agent + OpenAPI connector + workflow พร้อม credential checklist
  - 3 แพ็กในเครื่อง: `morning-brief` (Open-Meteo), `fx-watch` (Frankfurter),
    `mail-digest` (Gmail) — สองตัวแรกไม่ต้องใช้คีย์
  - preview ไม่เปลี่ยนอะไร; ติดตั้งตามลำดับ connector → agent → workflow;
    workflow ถูกบันทึกแบบปิดทุกตัว; ชื่อซ้ำไม่ทับ; บันทึกสถานะที่ `user/packs/<id>.json`
  - รับไฟล์แพ็ก `format: 1` (JSON ≤ 4 MB, agent ≤ 8, connector ≤ 8, workflow ≤ 20)
  - **ถอนการติดตั้งได้แล้ว** (working tree): preview ก่อนลบ, ลบเฉพาะของที่แพ็กสร้างและยังมีอยู่,
    เก็บของที่ workflow/agent อื่นใช้; record เก่าที่ไม่มีข้อมูล ownership ลบได้แต่ของยังอยู่
  - remote catalog ผ่าน `MIMI_PACK_CATALOG_URL` (https, 5 วินาที, 4 MB, ตรวจทุกแพ็ก,
    ไม่มีลายเซ็น); catalog ในเครื่องยังเป็น 3 แพ็ก
  - โค้ด: `packages/core/src/packs/{packs,catalog}.ts`,
    `packages/core/src/server/web/feature-packs.js`, `docs/packs.md`

### ก่อนหน้า (0.7.8 และเก่ากว่า)

- MCP: stdio, Streamable HTTP, HTTP+SSE; `mcp_<server>_<tool>`; `{{secret.NAME}}`;
  health check ทุก 15 นาที; reconnect + backoff 1s → 60s สูงสุด 5 ครั้ง
- Per-agent permission matrix (`permissions` ใน `agent.md`), approval แบบ
  once/task/session/always, always grants แยกตาม agent, grant เก่าแบบ flat list
- Coding tools: `grep`, multi-file `apply_patch`, `git_status/diff/log/commit`,
  background `run_shell` + `shell_output/shell_stop`, rewind รองรับ `apply_patch`,
  project allowlist (core narrowing, PC agent intersect)
- Secret safety: redact ค่า vault จริงจาก run history/debug/error; `git_commit`
  ปฏิเสธไฟล์ secret เว้น `allow_secrets: true`
- Subagent (`send_to` cap, `send_agents` ≤ 8), plan/todo tools, `lazy_tools` + `tool_search`
- Custom node `custom:<name>` หลาย output; workflow nodes `assert`, `debug`,
  `json_schema`, `mcp`, `agent_call`, `notify`; `$secret.NAME` ในทุก expression
- Overseer ชั้น 1: machine/web tools, mail/notify, trigger control, vault, OAuth,
  workflow enable/disable, self-edit (สร้าง/เปลี่ยนชื่อไม่ได้)
- Layer 2: in-place PDF/image/media (temp + rename, backup), `install_app` ผ่าน
  winget/brew/choco/scoop/apt, `statement_read` (CSV/TSV/OFX/QFX/QIF), Stripe
  payment/refund พร้อม `confirmPhrase` + `alwaysAsk`, `browser_fill_secret`
- Realtime calendar sync Google/Microsoft: watch/subscription, sync token/delta link,
  `GET/POST /api/calendar/push/<token>`, gateway `/h/<id>`, trigger `calendar`,
  dedupe + lock, poll ทุก 15 นาทีเป็น safety net, ปิดด้วย `MIMI_CALENDAR_SYNC=0`
  - Google watch ปฏิทินที่เลือก (ค่าเริ่มต้น primary); Graph ใช้ `/me/events`
    หรือ `/me/calendars/<id>/events` ตามที่เลือก
- Integrations: Google Calendar update/delete, Drive upload/share/metadata,
  Contacts (Google/Outlook), OneDrive upload, PDF merge/split/delete/rotate,
  image crop/rotate, video merge, subtitle (soft/burn), extract audio
- Packaging: `pdf-lib` เป็น dependency ของ `@mimi/pc-agent`;
  `scripts/pack-pc-agent.mjs` คัดลอก zod/pdf-lib/pako/tslib/@pdf-lib;
  build-win/build-mac/test `pc-stdin` ใช้ตัวเดียวกัน

## ไฟล์สำคัญ

- แอป native — สเปก: `docs/native/*`; โปรโตคอล/เวอร์ชัน: `packages/shared/src/{protocol,mimiamp}.ts`;
  push native: `packages/core/src/notify/{native-push,notifications}.ts`; เทสต์: `packages/core/src/test/native-clients.test.ts`;
  แอป Android: `android/` (อ่าน `android/README.md`)
- Setup wizard: `packages/core/src/server/web/feature-setup.js`,
  `packages/core/src/agents/presets.ts`
- Packs: `packages/core/src/packs/{packs,catalog}.ts`,
  `packages/core/src/server/web/feature-packs.js`, `docs/packs.md`
- OpenAPI import: `packages/core/src/connectors/{openapi,imported}.ts`,
  `packages/core/src/server/web/feature-tools.js`, `docs/connectors/openapi-import.md`
- Tunnel: `packages/core/src/app/tunnel.ts`, `packages/shared/src/protocol.ts`,
  `packages/core/src/core.ts` (calendar follow), `packages/core/src/server/web/app.js`
- Signing/update: `scripts/signing.mjs`, `scripts/fuses.mjs`, `scripts/build-{mac,win}.mjs`,
  `packages/desktop/updater.cjs`, `.github/workflows/release.yml`, `docs/admin.md`
- Gateway/2FA: `packages/core/src/gateway/{accounts,totp,main,gateway}.ts`,
  `packages/core/src/cli/accounts.ts`, `packages/core/src/server/web/app.js`
- Calendar sync: `packages/core/src/calendar/{sync,api,push}.ts`,
  `packages/core/src/server/server.ts` (push route/listeners),
  `packages/core/src/gateway/gateway.ts` (`/h` route),
  `packages/core/src/workflows/runner.ts` (calendar trigger items),
  `packages/shared/src/calendar.ts`
- MCP: `packages/pc-agent/src/mcp/client.ts`, `packages/core/src/mcp/hub.ts`
- Permissions: `packages/core/src/permissions/gate.ts`,
  `packages/core/src/loop/agent-loop.ts`, `packages/core/src/tasks/runner.ts`,
  `packages/core/src/workflows/runner.ts`
- Agent flags: `packages/core/src/agents/loader.ts`
- Coding tools: `packages/pc-agent/src/tools/{search,patch,git,background,run-shell}.ts`
- In-place output: `packages/pc-agent/src/tools/output-target.ts`
- Apps: `packages/pc-agent/src/tools/apps.ts`
- Statements: `packages/pc-agent/src/tools/statement.ts`
- Vault fills: `packages/pc-agent/src/tools/secret-fill.ts`,
  `packages/core/src/tools/browser-secret-tools.ts`,
  `packages/pc-agent/src/tools/browser/session.ts`
- Payment guard: `packages/core/src/connectors/{runtime,tool-adapter,registry}.ts`,
  `packages/core/src/connectors/services/stripe.ts`
- PDF/media editing: `packages/pc-agent/src/tools/{pdf,media}.ts`
- Drive/contacts: `packages/core/src/google/{tools,sheets}.ts`,
  `packages/core/src/microsoft/tools.ts`
- Lazy tools: `packages/core/src/tools/tool-search.ts`
- Plan/todo: `packages/core/src/chat/plan-tools.ts`
- Workflow runner: `packages/core/src/workflows/runner.ts`
- Run history/redaction: `packages/core/src/workflows/{run-history,redact}.ts`
- Workflow authoring: `packages/core/src/workflows/author-tools.ts`
- Custom nodes: `packages/core/src/workflows/custom-nodes.ts`
- Overseer: `packages/core/src/overseer/{tools,diagnostics,versions}.ts`
- Tool log: `packages/core/src/usage/logger.ts`, `packages/core/src/db/023-tool-calls.sql`
- Google/Microsoft APIs: `packages/core/src/google/{auth,tools,sheets}.ts`,
  `packages/core/src/microsoft/{auth,tools,drive}.ts`
- UI: `packages/core/src/server/web/app.js`, `feature-tools.js`, `feature-agent-tools.js`

## งานที่เหลือ

### ฟีเจอร์/ขอบเขตที่ยังขาด (ตรวจจากโค้ด 2026-11-01)

- **Packs**: remote catalog ผ่าน `MIMI_PACK_CATALOG_URL` มีแล้ว (working tree) แต่ยังไม่มี
  ลายเซ็น/central marketplace — ต้องเลือก URL ที่ไว้ใจ; catalog ในเครื่องยังเป็น 3 แพ็ก
- **TOTP**: recovery codes, หน้าเปลี่ยนรหัสผ่าน และแจ้งเตือนอุปกรณ์อื่นเมื่อมีล็อกอินใหม่มีแล้ว
  (working tree); ยังไม่มีประวัติ/อีเมลแจ้งเตือนสำหรับอุปกรณ์ที่ปิดอยู่
- **Tunnel**: quick tunnel ยังเป็นค่าเริ่มต้น (URL เปลี่ยนทุกครั้ง); named tunnel
  ใช้ได้ผ่าน `MIMI_CLOUDFLARED_TUNNEL` + `_URL`/`_CONFIG` และเริ่มเองได้
  (working tree) — แต่ยังไม่มี UI สร้าง/ล็อกอิน Cloudflare และต้องติดตั้ง cloudflared เอง
- **Signing**: โค้ด/runtime พร้อม (`scripts/signing.mjs`, `release.yml`, `SHA256SUMS.txt`,
  publisher check) และ Electron fuses ตั้งแล้ว (`scripts/fuses.mjs`) แต่ยังไม่ได้ตั้ง
  certificate/secrets จริง; build ที่ปล่อยจึงยัง unsigned/ad hoc
- **OpenAPI import**: JSON only (แอป), 2 MB, 50 connectors / 200 operations;
  pagination (page/cursor/nextPageToken) และ `x-mimi-rate-limit` ทำแล้ว (working tree);
  ยังไม่ derive triggers และ `itemsPath` นอก `x-mimi-items-path`; operation ที่ import
  เป็น untrusted และใช้ร่วมกับ shell ไม่ได้
- **Calendar**: ทั้ง Google และ Microsoft เลือกปฏิทินได้แล้ว (working tree: list/พิมพ์ id,
  Microsoft มีตัวเลือก "ทุกปฏิทิน"; เปลี่ยนแล้วหยุด subscription/channel เก่าและเริ่ม baseline ใหม่)
  — Graph lifecycle notifications ทำแล้ว (`subscriptionRemoved` สร้างใหม่, `missed` ทำให้ sync,
  `reauthorizationRequired` แจ้งให้ reconnect)
- **Strategic (ตั้งใจยังไม่ทำ)**: RBAC/SSO/audit retention, voice realtime,
  IDE extension/repo index, local model runtime (iOS native อยู่ในแผนแอป native แล้ว: Phase 4)

### การตรวจที่ยังไม่ได้ทำ

- UI smoke: setup wizard, packs install/remove, OpenAPI import, tunnel start/stop,
  2FA enable/disable, recovery codes, เปลี่ยนรหัสผ่าน และแจ้งเตือนล็อกอินใหม่
- Tunnel จริงกับ Cloudflare (quick + named) + calendar push จริง (end-to-end กับ Google/Graph)
- เลือกปฏิทิน Google/Microsoft และ Graph lifecycle notifications กับบัญชีจริง
- TOTP กับ authenticator app จริง (Google Authenticator/1Password/Authy)
- Signed + notarized desktop build, ตรวจ fuses ในไฟล์ที่ build แล้ว และ Android release signing
- OpenAPI import กับ spec จริง และ packs ที่ต้องใช้ credential จริง
- Manual OS matrix (macOS/Windows), real Gmail/Outlook/YouTube
- Backup/restore และ multi-user gateway บน deploy จริง (Railway headers, IPv6)

### สิ่งที่ต้องตัดสินใจก่อนเริ่มงานใหม่

- branch `main` มี 7 commits ที่ยังไม่ push + งาน Workspace terminal ใน working tree —
  commit/push เมื่อผู้ใช้สั่งเท่านั้น
- DB schema เป็น 24; เทสต์บางตัวผูก version นี้ (`db.test.ts`, `chat-media.test.ts`) ถ้าจะเพิ่ม migration ต้องอัปเดตเทสต์ด้วย
- calendar sync ใช้ไฟล์ `calendar-sync.json` ไม่มี migration; การแก้ schema ไฟล์ต้องรองรับของเก่า
- push ต้องมี public HTTPS จริง (tunnel/gateway) ถึงจะทดสอบ end-to-end กับ Graph/Google ได้;
  เทสต์ใน repo ใช้ fake fetch
- UI smoke ของฟีเจอร์ 0.7.9 (setup wizard / packs / OpenAPI import / tunnel / 2FA /
  recovery codes / เปลี่ยนรหัสผ่าน / security alert) ยังไม่ได้รัน; ไม่มีในชุดเทสต์อัตโนมัติ
  จึงไม่ถูกตรวจซ้ำโดย `npm test`
- ก่อน tag `v0.7.9-prototype` ต้อง commit งาน Workspace terminal และตัดสินใจเรื่อง
  CHANGELOG (ปัจจุบัน 0.7.9 มีหัวข้อของตัวเองแล้ว)

## ตรวจสอบ

เซิร์ฟเวอร์ (root ของโปรเจกต์):

```bash
npm install
npm run typecheck
npm test
```

บน PowerShell ที่ติด execution policy ใช้ node ตรง:

```powershell
node node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/pc-agent/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/core/tsconfig.json
node --test --test-timeout=60000 "packages/*/src/**/*.test.ts"
```

Android (ต้องมี JDK 17 + Android SDK; `android/local.properties` เป็นของเครื่อง ต้องสร้างใหม่):

```bash
cd android && ./gradlew :core:model:test testDebugUnitTest assembleDebug
```

```bash
cd android && ./gradlew connectedDebugAndroidTest
```

แอป Windows native (ต้องมี .NET 10 SDK; บนเครื่องนี้ใช้ `P:\tools\dotnet\dotnet.exe` และตั้ง `NUGET_PACKAGES=P:\tools\nuget-packages`):

```powershell
dotnet test apps/windows/tests/Mimi.Core.Tests
dotnet build apps/windows/src/Mimi.App/Mimi.App.csproj -p:Platform=x64
$env:MIMI_UI_TEST_CORE="http://localhost:8787"; $env:MIMI_UI_TEST_TOKEN="<token>"; dotnet test apps/windows/tests/Mimi.App.UiTests
$env:DOTNET="P:\tools\dotnet\dotnet.exe"; $env:MAKENSIS="<makensis.exe>"; node scripts/build-win-native.mjs
```

ผลล่าสุด (2026-11-03, Windows): typecheck ผ่าน, `npm test` 768/768, Android unit test 21/21, Windows unit test 75/75 + UI test 3/3 (รอบที่ 4)

ผลก่อนหน้า (2026-11-02, เครื่องเดิม): typecheck ผ่าน, `npm test` 759/768 (2 fail เรื่องเวลาเพราะเครื่องโหลด ดู "สถานะ"), Android unit test 21/21

## ย้ายเครื่อง (checklist)

1. คัดลอก **ทั้งโฟลเดอร์โปรเจกต์** ไม่ต้องเอา `node_modules/` (ต้อง `npm install` ใหม่บนเครื่องปลายทางเสมอ — link ของ workspace ไม่รอดการคัดลอก),
   `android/.gradle/`, `android/**/build/`, `android/local.properties`, `apps/windows/**/bin/`, `apps/windows/**/obj/`, `dist/`
   (สร้างใหม่ได้) — แต่ **ต้องเอา** `_old/` (สำเนาก่อนแก้) และ `user/` / `.env` ถ้ามีบนเครื่องเดิม (ข้อมูลจริง เก็บให้ดี)
2. ไม่มี `.git` ในโฟลเดอร์นี้: ถ้าเครื่องใหม่มี clone ของ repo ให้คัดลอกไฟล์ทับแล้วตรวจ `git status` ก่อน commit
   (งาน 2026-11-02 แตะ `packages/`, `android/`, `docs/`, `Dockerfile`, `.dockerignore`, `.gitignore`, `.github/workflows/release.yml`,
   `CHANGELOG.md`, `HANDOFF.md`, `mimiamp/README.md`)
3. เครื่องใหม่: Node ≥24 (ใช้ 26), `npm install`; Android: JDK 17, Android SDK (platform 35 — Gradle ติดตั้งเองได้ถ้ายอมรับ license แล้ว),
   `android/local.properties` = `sdk.dir=<ที่อยู่ SDK>`; emulator API 30+ (เครื่องเดิมใช้ AVD `ampblue` API 36)
4. รัน `npm test` บนเครื่องใหม่ให้ผ่านครบ (คาดว่า 2 ตัวที่ fail เรื่องเวลาจะผ่านเมื่อเครื่องว่าง)
5. ไม่ต้องย้ายข้อมูลทดสอบชั่วคราวของ session เดิม (core/gateway ทดสอบ, บัญชี `tester`, mock LLM) — อยู่ในโฟลเดอร์ชั่วคราวของเครื่องเดิม

## จุดเริ่มของ session ถัดไป

0. (2026-11-03) รับผลทดสอบ APK บนมือถือจริงจากเจ้าของโปรเจกต์ แล้วแก้ตามนั้น; Phase 5 ที่เหลือ: WNS, ทดสอบมือ (ถาด, toast, SMTC, ไมค์,
   PC agent, ติดตั้งทับ Electron), arm64, ตัดสินใจเรื่อง release.yml (แจก Electron หรือแอป native) — รายการเต็มใน `apps/windows/README.md`
1. อ่าน `HANDOFF.md` นี้ แล้ว `docs/native/README.md`
2. ทำ Phase 2 ให้จบ: บนเครื่องที่ไม่โหลดหนัก รัน core ในเครื่อง (`npm run serve` หรือ gateway) + emulator แล้วทดสอบ
   ล็อกอิน → แชต streaming → เล่น Mimiamp ในพื้นหลัง (emulator ใช้ `http://10.0.2.2:<port>`; ⚠️ ช่องเซิร์ฟเวอร์ใส่โดเมน Railway
   production ไว้เป็นค่าเริ่มต้น — **เปลี่ยนเป็นเซิร์ฟเวอร์ในเครื่องก่อนกด "ถัดไป"** หรือ build ด้วย `-PmimiHost=...`) และ `connectedDebugAndroidTest`
3. ขอคำตอบ Q1–Q12 (`docs/native/README.md`) ก่อนทำ push จริง (Q3/Q4) และก่อน Phase 3 (Mac)
4. ห้ามเรียกเซิร์ฟเวอร์ production ด้วยข้อมูลจริง ห้าม deploy/push/commit/tag จนกว่าผู้ใช้จะสั่ง
5. DB schema เป็น 24; ถ้าเพิ่ม migration ต้องอัปเดต `db.test.ts` และ `chat-media.test.ts`
6. ถ้าเปลี่ยน JSON/frame ที่แอป native ใช้ อ่าน `docs/native/api-versioning.md` ก่อน (เพิ่มได้ ลบ/เปลี่ยนต้องขึ้น `API_VERSION`)
7. ข้อควรรู้เดิม: ทดสอบ `browser_fill_secret` ต้องอัปเดต PC agent ด้วย; Stripe payment ต้องส่ง `confirm` ให้ตรง;
   quick tunnel URL เปลี่ยนทุกครั้ง อย่าใช้แทน `MIMI_PUBLIC_URL`
