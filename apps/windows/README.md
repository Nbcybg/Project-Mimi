# แอป Mimi สำหรับ Windows (native, Phase 5)

แอป Windows ของ Mimi ที่เขียนใหม่เป็น **WinUI 3 (Windows App SDK) + C# / .NET 10 — ไม่มี Electron** · ใช้ **WebView2 เฉพาะที่ native ทำไม่ได้**
(กติกาโปรเจกต์เปลี่ยน 2026-11-03: "ใช้ WebView ได้ถ้าจำเป็น"): เบราว์เซอร์ของ Workspace, ตัวละคร 3D (VRM) และจอเทอร์มินัล (xterm.js) — ที่เหลือเป็น WinUI ทั้งหมด
แทนหน้าต่าง Electron (`packages/desktop/remote.cjs`) คุยกับ core / gateway ผ่าน HTTP + WebSocket ตามสเปกใน [`docs/native/`](../../docs/native/README.md)
stack ตามที่เสนอใน [`windows-stack.md`](../../docs/native/windows-stack.md) (Q8 = WinUI 3)

## มีอะไรบ้าง (MVP)

| ส่วน | ทำอะไร | สเปก |
|---|---|---|
| เชื่อมต่อ / ล็อกอิน | ใส่ที่อยู่ → `/health` แยก core คนเดียว (ใส่ token) กับ gateway (username + password + รหัส 2FA) · เช็ก `minClientApi` · "เครื่องนี้ไม่ใช่ของฉัน" = token อยู่ในหน่วยความจำเท่านั้น และออกจากระบบตอนปิดแอป | `auth-and-session.md`, `api-versioning.md` |
| เก็บ token | Windows **DPAPI** (CurrentUser + entropy ของแอป) ที่ `%APPDATA%\Mimi\session.dpapi` ลบเมื่อออกจากระบบ · ไม่ลง log ไม่ลง config | auth 8 |
| รายการแชต | แท็บ ตัวต่อตัว / กลุ่ม, ยังไม่อ่าน, กำลังพิมพ์, รูป agent (โหลดพร้อม token), แชตใหม่กับ agent | realtime 4 |
| แชต | streaming ทีละ delta, แถวเครื่องมือ (✓/✗), บรรทัด sub-agent, handoff, การ์ดขออนุญาต (ครั้งนี้/งานนี้/session/ตลอด, `noGrant`), อนุมัติ workflow, ข้อความแบบเว็บ (code block, `code`, **ตัวหนา**, *การกระทำ*, ลิงก์เปิดเบราว์เซอร์, @mention), รูปในแชต, เปิดไฟล์ด้วยแอปของ Windows, แนบไฟล์ (ปุ่ม + ลากวาง, ≤25 MB), ข้อความเสียง (WAV 16 kHz mono ด้วย NAudio), หยุด, โหลดข้อความเก่า, presence, ตามข้อความที่พลาดหลังต่อใหม่ (`chat-open {afterId}`), เสียงแจ้ง 3 แบบ | realtime 4–7, media 2 |
| เมนูข้อความ (Phase 6) | คลิกขวาหรือปุ่ม ⋯ ที่ข้อความ: ถูกใจ, รีแอ็กชัน 6 แบบ, ตอบกลับ (แถบเหนือช่องพิมพ์ + `replyTo`), ส่งต่อไปแชตอื่น (`forward`), คัดลอก, ปักหมุด/เลิก, "ย้อนกลับมาแก้ไข" (rewind + ยืนยัน, ข้อความกลับมาในช่องพิมพ์, แจ้งไฟล์ที่ย้อน) · รีแอ็กชันเป็นชิปใต้ bubble (คลิก = เอาออก), quote และ "ส่งต่อจาก" เหนือข้อความ | `feature-chat.js`, `app.js` rewind |
| ปักหมุด (Phase 6) | แถบใต้ header: คลิก = ไปที่ข้อความแล้วแสดงหมุดถัดไป, หลายหมุด = รายการพร้อมปุ่มเลิกปักหมุด, หมุดของ session เก่าเปิด session นั้นที่ข้อความ | `message-marks`, `chat-history.pins` |
| ค้นหา (Phase 6) | ปุ่มแว่นขยายหรือ Ctrl+K: ค้นทุกแชตทุก session (หน่วง 220 ms เหมือนเว็บ), ไฮไลต์คำ, คลิก = เปิด session นั้นแล้วเลื่อนไปที่ข้อความ (โหลดหน้าก่อนหน้าให้เองสูงสุด 10 หน้า) · ดู session เก่าอยู่จะมีแถบบอก ส่งข้อความใหม่ = กลับไป session ล่าสุดก่อน | `search` |
| กล่องแจ้งเตือน (Phase 6) | กระดิ่งพร้อมจำนวนที่ยังไม่อ่าน: รายการจาก core ทุกครั้งที่ต่อ, ของใหม่เข้ามาสด, คลิก = อ่านแล้ว + เปิดแชต, อ่านทั้งหมด · แจ้งเตือนของแชตที่กำลังดูอยู่ถูกทำเป็นอ่านแล้วทันที | `feature-notify.js` |
| การ์ดงาน, session, อ่านออกเสียง, กลุ่ม (Phase 6) | การ์ด task (ขั้นตอน, แผน, ผล, หยุด/ทำต่อ/ยกเลิก/ย้อนไฟล์) · แถบ session ใต้ header: ชื่อ session + มาตรวัด context/cache/ค่าใช้จ่าย, เมนู session (เปิด session เก่า, เริ่มใหม่) · เมนูแชต: อ่านออกเสียงอัตโนมัติ (`ui-set mimi.autoSpeak` ใช้ร่วมทุกเครื่อง, เสียง Windows ภาษาไทยถ้ามี), แก้ชื่อ/สมาชิกกลุ่ม, ดาวน์โหลดแชตเป็น CSV, ลบแชต · 🔊 ในเมนูข้อความ · ปุ่มอีโมจิชุดเดียวกับเว็บ · สร้างแชตกลุ่มจากเมนู "แชตใหม่" | `app.js`, `feature-chat.js` |
| หน้าจัดการ (Phase 6) | เมนู ☰: **Agent** (แก้ทุกช่อง, รูป avatar/portrait, โมเดล VRM, ท่า Mixamo, แกลเลอรี, แบบ agent สำเร็จรูป), **Hub** 10 แท็บเหมือนเว็บ (กองโมเดล, Skill, Node & เครื่องมือ: preset/เครื่องมือเอง/MCP/connector+นำเข้า OpenAPI/รายการเครื่องมือ, Trigger + ชนิด trigger, บัญชี: Google/Microsoft/กล่องเมล/connection/ปฏิทิน/คีย์ค้นหา, คีย์ลับ, คลังความรู้ (เอกสาร, เพิ่มข้อความ/URL/ไฟล์, ค้นหา, embed), ตู้เสื้อผ้า, ฉากหลัง, แพ็ก (ดูก่อน/ติดตั้ง/ถอน)), **Workflow** (แก้ด้วยฟอร์ม + JSON ของ node, ดูผังแบบ zoom ได้, รัน, เปิด/ปิด, ประวัติ, รันจาก node, นำเข้า n8n/Make/Zapier), **AI Overseer** (เลือกโมเดล + คุย), **ตั้งค่า Mimi** (โปรไฟล์, งบ/แจ้งเตือน, เครื่องที่รับ push, สำรองข้อมูล + ดาวน์โหลด, 2FA/เปลี่ยนรหัสผ่านของ gateway, ความจำ, ผู้ให้บริการโมเดล + ChatGPT/Claude แบบรายเดือน, โมเดลเริ่มต้น/เขตเวลา/session/โควตา/โฟลเดอร์, สิทธิ์ "อนุญาตตลอด", Cloudflare tunnel) | `Mimi.Core/Hub/Catalog.cs` |
| ถาดระบบ | ไอคอน + เมนูชุดเดียวกับ Electron (เปิด Mimi, ตั้งค่า, PC agent, shell, ออกจากระบบอัตโนมัติ, ซ่อนเมื่อคลิกที่อื่น, อยู่บนสุด, เปลี่ยนเซิร์ฟเวอร์, ออกจากระบบ, ออก) · คลิก = แสดง/ซ่อนหน้าต่าง | `remote.cjs` buildMenu |
| หน้าต่าง | หน้าต่างลอย 410 × 820 มุมขวาล่าง จำตำแหน่ง/ขนาด, ปิด = ซ่อนไปถาด, เปิดได้ทีละตัวต่อผู้ใช้ Windows (เปิดซ้ำ = แสดงตัวเดิม) | `remote.cjs` |
| แจ้งเตือน | Windows toast จาก frame `notification` ขณะแอปอยู่ในถาด + ตามของที่พลาดด้วย `/api/notifications?afterId=` หลังต่อใหม่ · คลิก = เปิดแชตนั้น · ไม่แจ้งแชตที่กำลังดูอยู่ · `security-alert` ของ gateway | push-and-background 1, 2 |
| เปิดตอนเข้าสู่ระบบ | HKCU `Run` ชื่อ `app.mimi` (ชื่อเดียวกับที่ Electron ใช้ จึงแทนกัน ไม่ซ้อน) เริ่มแบบซ่อนในถาด (`--background`) | – |
| ล็อกอัตโนมัติ | ไม่ได้ใช้เครื่องครบเวลาที่เลือก (5/15/30/60 นาที) หรือล็อกหน้าจอ → ออกจากระบบ (ปิดไว้เป็นค่าเริ่มต้น) | `remote.cjs` auto-lock |
| PC agent | ยังเป็นโปรแกรม Node แยก (Q7): แอปเริ่ม/หยุด/เริ่มใหม่ (backoff 2 s → 60 s), ส่ง token ทาง stdin, ถามคำขออนุญาต (`@@mimi-consent@@`) ด้วยกล่องของ Windows, เลือกโฟลเดอร์ / shell · ใช้ Edge/Chrome ที่มีในเครื่องแทนเบราว์เซอร์ของ Electron | `remote.cjs` startPcAgent |
| อัปเดตแอป | ถาม GitHub release ทุก 6 ชม. (เมื่อ build ใส่ `UpdateRepo`) → ดาวน์โหลด zip → ตรวจ `SHA256SUMS.txt` + ผู้ลงนาม Authenticode เดียวกัน → สคริปต์ robocopy สลับไฟล์แล้วเปิดใหม่ (วิธีเดียวกับ `updater.cjs`) | – |

**หน้าจัดการทั้งหมดใช้โครงเดียว** (`Mimi.Core/Hub/`): แต่ละรายการคือ `EntityDef` (frame ที่ขอ, frame ที่ตอบ, วิธีอ่านแถว, ฟอร์ม, frame บันทึก/ลบ, การกระทำ)
แล้ว `Views/ManagePage.cs` + `Controls/JsonForm.cs` วาดให้: แท็บแบบเว็บ → การ์ดรายการ → คลิกแถว = ฟอร์ม (ช่องข้อความ/ตัวเลข/สวิตช์/เลือกจากรายการ/รายการบรรทัดละค่า/JSON/รหัสลับ)
+ ปุ่มการกระทำ (ส่ง frame แล้วแสดงผล, เปิดลิงก์ล็อกอินในเบราว์เซอร์, อัปโหลด/ดาวน์โหลด/ลบไฟล์ผ่าน HTTP) — เพิ่มหน้าใหม่ = เพิ่มนิยามใน `Catalog.cs`

**รอบที่ 4 (2026-11-03) — หน้าตาแบบต้นแบบ Electron + ส่วนที่ขาด:**

| ส่วน | ทำอะไร | โค้ด |
|---|---|---|
| ธีม | มืด/สว่างตาม palette ของเว็บ (`app.css`), เปลี่ยนแล้วเห็นทันที (เปลี่ยนสีของ brush ที่ใช้ร่วมกัน), เก็บเป็น `mimi.theme` ของบัญชี, แชตตั้งธีมของตัวเองได้ | `Services/Theme.cs` |
| โครงหน้าต่าง | หน้ารายการแชต = แผงข้างของเว็บ (ค้นหา, + ใหม่, แท็บ ตัวต่อตัว/กลุ่ม, nav 8 หน้า, สถานะ PC agent), หน้าอื่นมีหัวแบบเว็บหน้าแคบ (‹ + ชื่อ) | `Views/ChatListView.*`, `MainWindow.*` |
| ตั้งค่า | 4 แท็บแบบเว็บ: โปรไฟล์ของฉัน (การ์ดบัญชี + ออกจากระบบ), หน้าตา (ธีม, ขนาดข้อความ, ตัวละคร, เสียง), ความจำ, แอปและระบบ (เครื่องนี้ + ของเซิร์ฟเวอร์) | `Views/SettingsSections.cs` |
| แชต | หัวแบบเว็บ (+ session, ตัวละคร, ข้อมูล, มาตรวัด context) + กล่องพิมพ์แบบเว็บ · **เวที**: ฉากหลัง (ของแชต หรือฉากใน Hub ของ agent) + ตัวละคร 2D ตามอีโมจิล่าสุด หรือ **VRM 3D** · แผง "ข้อมูล": สถานะ agent (แก้ได้) + **หน้าตาต่อแชต** (ธีม, ขนาดข้อความ, ตัวละคร, ข้อความบนตัวละคร, ขนาด/ตำแหน่ง, ฉากหลัง: สีเดียว/ไล่สี/ฉาก/อัปโหลด) | `Controls/StageView.cs`, `Controls/VrmView.cs`, `Assets/web/vrm.html`, `Services/StageData.cs`, `Views/ChatView.Stage.cs` |
| ~~Mimiamp~~ | สกิน "blue edition", visualizer, pan, เพลงในเครื่อง — **เอาออกแล้วในรอบที่ 6** (Q5) | – |
| ฟอร์ม | ฟอร์มย่อยแทน JSON (`FieldKind.Group` + `ShowWhen`): กล่องเมลขาเข้า/ขาออกเป็นช่อง ๆ แสดงตามชนิดบัญชี · ผลการกระทำแสดงแบบอ่านได้ (รายงานแพ็ก, ผลรัน workflow ทีละ node, ประวัติการรัน) มี "ดู JSON" พับไว้ | `Controls/JsonForm.cs`, `Controls/ResultView.cs` |
| Workflow editor | ผังลากวาง: ลาก node, ลากจากจุดทางออกไปวางบน node = เชื่อม, คลิกเส้น = ลบ, เพิ่ม node ตามชนิดที่เซิร์ฟเวอร์ส่งมา, ฟอร์มของ node จาก field spec (เงื่อนไขเป็นแถว), เมื่อผิดพลาด/ลองใหม่, ปิด/ทำสำเนา/ลบ node, **ทดสอบ node ทีละตัว**, บันทึก, รัน, รันใหม่จาก node, ประวัติ, ลบ | `Views/WorkflowEditor.cs`, `Controls/SpecForm.cs`, `Mimi.Core/Hub/WorkflowDraft.cs` |
| ตัวช่วยตั้งค่า | 5 ขั้นแบบเว็บ: ผู้ให้บริการ + โมเดลหลัก → agent สำเร็จรูป → โฟลเดอร์ → PC agent → แชตทดสอบ · เปิดเองครั้งแรกเมื่อยังแชตไม่ได้ (`mimi.setupDone`) | `Views/SetupWizard.cs` |
| Workspace | หน้าต่างแยก: ไฟล์ (tree, กรอง, แก้ข้อความ + บันทึก), เบราว์เซอร์ (WebView2, วาดบนภาพหน้าเว็บ แล้วคัดลอก/บันทึก PNG), เทอร์มินัล (PowerShell/pwsh ใต้ ConPTY + xterm.js) | `Views/Workspace.cs`, `Native/ConPty.cs`, `Assets/web/terminal.html` |

ไฟล์ของเว็บที่ใช้ (`three`, `@pixiv/three-vrm`, `@xterm/*` จาก `node_modules` และฉากสำเร็จรูป `backgrounds/*.webp`) ถูกคัดลอกเข้า `Assets/` ตอน build
(`Mimi.App.csproj`) — ต้อง `npm install` ที่ root ก่อน build · ข้อมูลของ WebView2 อยู่ใน `%LOCALAPPDATA%\Mimi\WebView2` และถูกลบตอนออกจากระบบ

**รอบที่ 5 (2026-11-03, ทำบน Mac Intel) — ฟีเจอร์ที่ยังขาดเทียบกับ Electron:**

| ส่วน | ทำอะไร | โค้ด |
|---|---|---|
| Workflow editor | **preview expression** ("= ค่า" ใต้ช่อง หน่วง 350 ms, `workflow-expr-preview` กับข้อมูลของการรันล่าสุด หรือตัวอย่างของ trigger) · **คำแนะนำ path** หลัง `$json.` / `$node[…]` ใน `{{ }}` (↑ ↓ Enter/Tab, Esc) · ปุ่ม **"{ } เลือกข้อมูล"** (ค้นหา field ของข้อมูลเข้า, ผลของ node ก่อนหน้า, `$vars`, ค่าพื้นฐาน) · **โน้ตบนผัง** (📝 เพิ่ม, ลากแถบบนย้าย, มุมขวาล่างขยาย, แก้ข้อความในที่, เปลี่ยนสี 4 สี, ลบ) · **node Connector**: บริการ → version → operation → connection แล้วช่องของ operation นั้น (เก็บใน `config.input`), ตัวเลือกที่อ่านจากบริการ (`connector-operation-options`, รอช่องที่ต้องกรอกก่อน, จำผลไว้), ช่อง "อนุญาต write/delete" · trigger ของ connector / pool แสดงช่องของตัวที่เลือก · **ย้อน / ทำซ้ำ** (↶ ↷, Ctrl+Z / Ctrl+Y) · Ctrl+C / Ctrl+V / Ctrl+D / Delete บนผัง · **จัดเรียงอัตโนมัติ** · **node preset** ("บันทึกเป็น preset…" → "+ node" → Preset ของฉัน, ใช้ร่วมทุกเครื่องผ่าน `mimi.nodePreset.*` เหมือนเว็บ) · ตัวแปร `$vars` เป็นแถว ชื่อ → ค่า | `Views/WorkflowEditor.cs`, `Controls/SpecForm.cs`, `Mimi.Core/Hub/WorkflowAssist.cs`, `WorkflowDraft.cs` |
| VRM | **ท่า Mixamo** (.fbx → retarget เข้ากระดูก VRM แบบ `feature-vrm.js`) · ท่ายืนเฉย (`idleMotion`) เล่นวนบนหน้าแชต แทนท่าหายใจ · หน้า "ตัวละคร 3D" ใน Agent: ดูโมเดล, เล่นท่า (วน/ครั้งเดียว), หยุด, ลบท่า, เลือก + บันทึกท่ายืนเฉย · ท่าที่ใช้ไม่ได้ (FBX ที่ไม่ใช่ rig ของ Mixamo) บอกเหตุผล | `Assets/web/vrm.html`, `Controls/VrmView.cs`, `Views/ManagePage.Character.cs`, `Services/StageData.cs` |
| ภาพสถานการณ์ (#25) | ภาพจากแกลเลอรีที่ agent (`gallery_show`) หรือผู้ใช้ตั้ง (`status.situation`) **ทับแชต** แบบ event CG: เปิด / ย่อเป็นรูปเล็กมุมขวาบน / ปิดเหลือปุ่ม 🖼 · จำต่อ agent จนกว่าจะเป็นภาพใหม่ (เหมือน `mimi.cg` ของเว็บ, เก็บใน `config.json` → `scenes`) | `Controls/SceneOverlay.cs`, `Views/ChatView.Stage.cs` |
| แกลเลอรี (#44) | หน้าจัดการแทนผล JSON: ค้นหา (ชื่อ/แท็ก/คำอธิบาย), หน้าละ 48, รูปย่อ, **เพิ่มหลายรูปพร้อมกัน** (ทำรูปย่อ 256 px JPEG ให้), แก้ชื่อ/แท็ก/คำอธิบาย, แสดงในแชต / เอาออก, ลบ | `Views/ManagePage.Gallery.cs` |
| ฟอร์มย่อยแทน JSON | `FieldKind.KeyValue` (แถว ชื่อ → ค่า), `Rows` (การ์ดต่อรายการ + เพิ่ม/ลบ), `Audience` (agent ทุกตัว / เฉพาะที่เลือก), `Dynamic` (ช่องตามที่เซิร์ฟเวอร์บอก) — **preset เครื่องมือ** ใช้ช่อง `settings` ของเครื่องมือที่เลือก (secret = `{{secret.ชื่อ}}`), **connection** ใช้ช่อง `auth.fields` ของ connector (เว้นว่าง = คงเดิม) + OAuth2 endpoint/scopes, **โปรไฟล์** เป็นการ์ดต่อข้อมูล (ชื่อ, ค่า, ใครเห็น, เก็บในเครื่องนี้, key), **vars ของ workflow** เป็นแถว | `Controls/JsonForm.cs`, `Mimi.Core/Hub/Entities.cs` (`ServerFields`), `Catalog.cs`, `Lookups.cs` |
| Workspace | ปุ่ม **"ส่งเข้าแชต"** ในโหมดวาด: แนบภาพในแชตที่เปิดอยู่ แล้วโฟกัสช่องพิมพ์ให้พิมพ์ข้อความประกอบ (`sendImageToChat` ของ Electron) | `Views/Workspace.cs`, `App.xaml.cs` |
| **เซิร์ฟเวอร์ในเครื่องนี้** | ปุ่ม "ใช้เซิร์ฟเวอร์ในเครื่องนี้" ในหน้าเชื่อมต่อ: แอปเปิด core บนเครื่องเอง (`packages/core/src/app/native-host.ts` ด้วย node.exe ในชุด, 127.0.0.1, token ใน `app-settings.json` แบบ launcher.ts), อ่านที่อยู่ + token จากบรรทัด `@@mimi-host@@{…}`, เข้าสู่ระบบให้เอง และเปิดทุกครั้งที่เปิดแอป · ปิดแอป = ปิด core (ปิด stdin) · ออกจากระบบ = หยุด core และเลิกเปิดเอง · มี Mimi รันอยู่แล้ว (แอป Electron) = ใช้ตัวนั้นและไม่ปิดมัน · PC tools ไม่รันใน core (`localPcTools: false`) — ใช้ PC agent ของแอปพร้อมกล่องขออนุญาต · ชุดติดตั้งมี `core/` (`scripts/pack-core.mjs`) | `Mimi.Core/Desktop/LocalCore.cs`, `Views/ConnectView.xaml.cs`, `App.xaml.cs`, `packages/core/src/app/native-host.ts` |

**รอบที่ 6 (2026-11-03, บน Mac Intel) — เอา Mimiamp ออก + ที่ Electron/เว็บยังมีเกิน:**

| ส่วน | ทำอะไร | โค้ด |
|---|---|---|
| เอา Mimiamp ออก (Q5) | หน้าเพลง, mini player, เมนูถาด, ปุ่มมีเดีย/SMTC, EQ/spectrum, ค่าเพลงใน `config.json` ถูกลบ · frame `mimiamp` จาก core เก่าถูกข้าม | – |
| ฉากหลังของแชต | **อัปโหลดรูปจากเครื่อง** สำหรับแชตนี้ (`POST /api/chat-background`, ≤12 MB) · **ตั้งเวลาสลับฉากหลัง** (ช่วงเวลา → ตามพื้นหลังหลัก / สี / ไล่สี / ฉาก / รูปที่อัปโหลด, ข้ามเที่ยงคืนได้, ดูใหม่ทุก 30 วินาที) · แก้: "ไม่มี" = ไม่มีฉากหลังจริง (เดิมไปใช้ฉากของ agent) | `Views/ChatView.Background.cs`, `Mimi.Core/Desktop/BackgroundRules.cs` |
| เบราว์เซอร์ของ Mimi | เมนูถาด + ตั้งค่า → "เปิดเบราว์เซอร์ของ Mimi": Edge/Chrome ด้วยโปรไฟล์ของ agent และ flag ชุดเดียวกับ PC agent (DevTools port) ให้ล็อกอินเว็บเองแล้ว agent ใช้หน้าต่างนั้นต่อ | `Mimi.Core/Desktop/AgentBrowser.cs`, `App.OpenAgentBrowser` |
| กล่องพิมพ์ | `@ชื่อ` ในแชตกลุ่ม (Tab/Enter/คลิก) · Esc ตอนช่องว่าง = หยุดคำตอบ · Ctrl+V รูป/ไฟล์ = แนบ · **ตรวจรูปก่อนส่ง**: พรีวิว, เลือกรูป, คำบรรยายต่อรูป (`X-Mimi-Caption`) — ใช้กับเลือกไฟล์ ลากวาง วาง และ "ส่งเข้าแชต" ของ Workspace | `Views/ChatView.{Composer,Pictures}.cs`, `Mimi.Core/Chat/Mentions.cs` |

| WNS (push ตอนแอปปิด/หลับ) | `Services/WindowsPush.cs` (Windows App SDK `PushNotificationManager`): ถ้า `GET /api/push/info` บอกว่ามี `wns` + `wnsRemoteId` → สร้าง channel → `POST /api/push/register {platform:"wns"}` ทุกครั้งที่ล็อกอิน · raw push ตอน socket ไม่อยู่ = ดึง `/api/notifications?afterId=` แล้วแสดง toast · แอปไม่ได้เปิดอยู่ → Windows เปิดแอปเข้าถาด (เหมือนเริ่มพร้อมเครื่อง) · ออกจากระบบ = ยกเลิก channel · **ไม่รองรับ (`IsSupported()` = false) = ใช้ socket แบบเดิม** — build แบบ self-contained อาจต้องมี Singleton package ของ Windows App Runtime ในเครื่อง; ยังไม่ได้ทดสอบกับ WNS จริง (ต้องลงทะเบียน Entra ID app) | `App.RegisterPush`, `NotificationsFromPush` |
| Widget (#19) | **ยังทำไม่ได้**: widget ของ Windows 11 ต้องเป็นแอปที่มี package identity (MSIX หรือ sparse package) ซึ่งต้อง**ลงนามด้วยใบรับรอง** — แอปนี้แจกเป็น zip/setup.exe ที่ยังไม่ลงนาม (Q9) จึงติดตั้ง widget provider ไม่ได้ | – |

วิธีเทียบรอบนี้: ทุกชนิด frame ที่เว็บส่ง/รับ และทุก path `/api/*` ที่เว็บเรียก เทียบกับสตริงในโค้ด C# — ที่เหลือมีแค่ Web Push (`push-key`/`push-subscribe`, แอป native ใช้ WNS แทน)
และ `google-auth-url`/`microsoft-auth-url` (ทางเก่า แอปใช้ `oauth-account-connect`) · แล้วไล่ฟีเจอร์ของ `packages/desktop/` (ถาด, IPC) และกล่องพิมพ์ของ `app.js` ด้วยตา

ยังไม่มี / ยังไม่ได้ลอง (ตามจริง):
- **รอบที่ 5 ทั้งหมด compile ผ่านแต่ยังไม่ได้รันบน Windows** (ทำบน Mac): ตรวจด้วย `tests/tools/mac-typecheck/check.sh` (C# จริงทุกไฟล์, แต่ XAML ไม่ได้ถูก compile — รอบนี้ไม่ได้แก้ไฟล์ .xaml) ·
  UI test (FlaUI) ยังไม่มีขั้นของฟีเจอร์รอบที่ 5 · ส่วนที่ทดสอบได้บน Mac: unit test ของ Core 82/87 บน Mac (+12 ตัว: `WorkflowAssistTests`, `LocalCoreTests` ที่เปิด core จริง, `ManageTests` ช่องจากเซิร์ฟเวอร์) และ `native-host.test.ts` ของเซิร์ฟเวอร์
- VRM: **ยังไม่ได้ลองกับไฟล์ .vrm / .fbx จริง** (ตรวจแค่ syntax ของหน้า) · ท่า Mixamo เล่นทั้งบนหน้าแชต (ท่ายืนเฉย) และหน้าตัวละคร — เว็บเล่นเฉพาะใน editor ของ agent
- ชุดติดตั้งใหญ่ขึ้นมาก: `core/node_modules` ~240 MB (ส่วนใหญ่คือ binary ของ `@anthropic-ai/claude-agent-sdk` สำหรับ Claude plan) · build arm64 บนเครื่อง x64 ได้ SDK ของ x64 (เหมือน node.exe)
- WNS (รอ Q3) และ Windows widget (ต้องมี package identity) ยังไม่มี

## โครงสร้าง

```
apps/windows/
  src/Mimi.Core/        ไม่มี WinUI: โปรโตคอล (Protocol/), HTTP + WebSocket (Net/), reducer ของแชต (Chat/),
                        Mimiamp (คิว, EQ), เรื่องของเครื่อง (Desktop/: config.json, DPAPI, updater, PC agent),
                        ViewModels (CommunityToolkit.Mvvm) — ทดสอบได้โดยไม่ต้องเปิดหน้าต่าง
  src/Mimi.App/         WinUI 3: Views/, Controls/, Audio/ (NAudio + SMTC), Native/ (ถาด, Run key, idle), Services/
  tests/Mimi.Core.Tests/   unit test (xUnit)
  tests/Mimi.App.UiTests/  UI Automation (FlaUI) ขับ Mimi.exe จริงกับ core ในเครื่อง
```

ตรรกะของแชต (`ChatTimeline`) และ frame parser แปลงมาจากแอป Android (`android/core/model`) กติกาเดียวกันทุกข้อ

## Build และทดสอบ

ต้องมี **.NET 10 SDK** (Windows 10 1809+ / Windows 11, x64 หรือ arm64) — ไม่ต้องมี Visual Studio

```bash
dotnet build apps/windows/src/Mimi.App/Mimi.App.csproj -p:Platform=x64
```

```bash
dotnet test apps/windows/tests/Mimi.Core.Tests
```

**บน macOS / Linux** (ไม่มี XAML compiler ของ Windows): unit test ของ Core รันได้ (5 ตัวที่ผูก path `C:\` / DPAPI ของ Windows จะตก — ปกติ)
และตรวจ C# ของแอปได้ด้วย stub แทนโค้ดที่ XAML compiler สร้าง — XAML เองไม่ถูกตรวจ ต้อง build บน Windows ก่อนปล่อย:

```bash
dotnet test apps/windows/tests/Mimi.Core.Tests -p:EnableWindowsTargeting=true
```

```bash
apps/windows/tests/tools/mac-typecheck/check.sh
```

(.NET 10 SDK บน Mac ติดตั้งแบบไม่ต้องใช้ sudo ด้วย `dotnet-install.sh --channel 10.0 --install-dir ~/.dotnet`)

build แบบ Debug เป็น framework-dependent: ถ้า .NET 10 ไม่ได้อยู่ใน `C:\Program Files\dotnet` ให้ตั้ง `DOTNET_ROOT` ก่อนเปิด `Mimi.exe`
(build ที่แจกจ่ายเป็น self-contained ไม่ต้องติดตั้งอะไร)

**ลองกับ core ในเครื่อง** — แอปเก็บข้อมูลที่ `%APPDATA%\Mimi` (ไฟล์เดียวกับแอป Electron!) ตอนทดสอบให้ตั้ง `MIMI_WINDOWS_HOME`
เป็นโฟลเดอร์ว่าง จะได้ไม่แตะการเข้าสู่ระบบของแอปที่ใช้งานจริง (และเป็น instance แยกด้วย):

```powershell
$env:MIMI_WINDOWS_HOME = "$env:TEMP\mimi-win-test"; .\apps\windows\src\Mimi.App\bin\x64\Debug\net10.0-windows10.0.19041.0\Mimi.exe
```

แล้วใส่ `http://localhost:8787` (http ใช้ได้เฉพาะเซิร์ฟเวอร์บนเครื่องนี้ นอกนั้นต้อง https) และ `MIMI_TOKEN` ของ core

**UI test** — ต้องมี core ในเครื่องที่มี agent อย่างน้อยหนึ่งตัว และ LLM ที่ตอบคำว่า "streaming" พร้อมทวนข้อความผู้ใช้
ใช้ LLM จำลอง [`tests/tools/mock-llm.cjs`](tests/tools/mock-llm.cjs) (OpenAI-compatible, ไม่ออกเน็ต, port 9911) ได้แบบนี้ — โฟลเดอร์ทดสอบแยกจาก `user/` จริง:

1. `node apps/windows/tests/tools/mock-llm.cjs`
2. โฟลเดอร์ทดสอบ (เช่น `%TEMP%\mimi-core-test`) มี `mimi.json` ที่ `model` = `mock/mock-chat` และ provider `mock`
   (`npm: @ai-sdk/openai-compatible`, `api: http://127.0.0.1:9911/v1`, `env: ["MOCK_API_KEY"]`) และ `user/agents/mimi/agent.md`
   (frontmatter `name: mimi`, `tools: []`, `can_message: []`)
3. core: `MIMI_ROOT=<โฟลเดอร์ทดสอบ> MIMI_USER=user MIMI_TOKEN=<token ยาว> MOCK_API_KEY=x MIMI_MODELS_OFFLINE=1 MIMI_CALENDAR_SYNC=0 npm run serve`

ไม่ตั้งตัวแปรด้านล่าง = ข้ามเทสต์นี้:

```powershell
$env:MIMI_UI_TEST_CORE = "http://localhost:8787"; $env:MIMI_UI_TEST_TOKEN = "<MIMI_TOKEN>"; dotnet test apps/windows/tests/Mimi.App.UiTests
```

(`MIMI_UI_TEST_SHOTS=<โฟลเดอร์>` = เก็บภาพหน้าแชต และภาพ + โครง UIA ตอนเทสต์ล้ม)

## แจกจ่าย

```bash
node scripts/build-win-native.mjs
```

ได้ `dist/win-native/Mimi/` (self-contained: .NET + Windows App SDK + PC agent + `node\node.exe`), `Mimi-<version>-win-x64.zip`
และ `Mimi-<version>-win-x64-setup.exe` (NSIS, ติดตั้งต่อผู้ใช้ที่ `%LOCALAPPDATA%\Programs\Mimi` ไม่ต้องใช้สิทธิ์ admin) — `--arch arm64` ได้
(แต่ node.exe ที่ใส่คือของเครื่องที่ build; build arm64 บนเครื่อง x64 จะใช้ node จาก PATH)

ทำไม **unpackaged + zip/installer** ไม่ใช่ MSIX:
- เข้ากับ release และตัวอัปเดตเดิม (zip + `SHA256SUMS.txt` + ผู้ลงนามเดียวกัน) และติดตั้งทับแอป Electron ที่โฟลเดอร์เดิมได้ (ชื่อ zip/โฟลเดอร์/ตัว uninstall ตรงกัน)
- MSIX แบบ sideload ต้องมีใบรับรองที่เครื่องผู้ใช้เชื่อถือ (ยังไม่มีใบรับรองจริง) ส่วน Microsoft Store ยังไม่ได้ตัดสินใจ (Q9)
- ข้อเสีย: WNS ต้องมี package identity → ต้องเพิ่ม sparse package ตอนทำ WNS

ชื่อ / ไอคอน / เวอร์ชันของ exe มาจาก csproj (`AssemblyName`, `ApplicationIcon`, `Version`) แทน `scripts/patch-exe.mjs`
ลายเซ็นใช้ `scripts/signing.mjs` เดิม (`WIN_CSC_*`) — ยังไม่มีใบรับรองจริง build จึง unsigned

`release.yml` **ยังไม่ได้เปลี่ยน**: release ยังแจก Electron (`npm run build:win`) — ชื่อ zip ของสองตัวเหมือนกัน
ถ้าจะสลับเป็นแอปนี้ ให้แทนขั้น `build:win` ด้วย `setup-dotnet` (10.x) + `node scripts/build-win-native.mjs` (ตัวอัปเดตของ Electron จะอัปเดตเป็นแอปนี้ได้เลย
เพราะโครง zip `Mimi/Mimi.exe` เหมือนกัน — ต้องทดสอบก่อนจริง)

## สถานะ (2026-11-03)

ทำแล้วและตรวจแล้วบนเครื่อง Windows 11 x64 (core ในเครื่อง + LLM จำลอง):
- build ผ่าน (Debug x64), unit test 52 ตัวผ่าน (รัน 10 รอบไม่ล้ม), UI test ผ่าน: ล็อกอินด้วย token → แชตใหม่ → ส่งข้อความ → คำตอบ stream มาครบ →
  Mimiamp → เล่นเพลง (นาฬิกาเดินจริง = Range + ถอดรหัส + WASAPI ทำงาน) → ออกจากระบบ (ไฟล์ token หาย)
- ภาพหน้าจอ: หน้าเชื่อมต่อ, แชต, Mimiamp แสดงภาษาไทยและธีมมืดถูกต้อง
- Phase 6 ชุดแชต (2026-11-03): unit test 59 ตัวผ่าน (รัน 5 รอบไม่ล้ม), UI test เพิ่มขั้น ปักหมุด → แถบหมุดขึ้น → ตอบกลับ → แถบตอบกลับ → ค้นหา →
  คลิกผลลัพธ์กลับเข้าแชต → เลิกปักหมุด → แถบหมุดหาย → กล่องแจ้งเตือน ผ่านกับ core จริงในเครื่อง
- build **arm64** ผ่าน (Release + self-contained + zip/setup.exe, exe เป็น ARM64 จริง) — ไม่มี node.exe ของ arm64 ในชุด (ใช้ node ใน PATH)
- Phase 6 หน้าจัดการ + แชตที่เหลือ (2026-11-03 รอบ 3): unit test **66** ตัวผ่าน, UI test **2** ตัวผ่าน 3 รอบติด — ตัวที่สองเปิดทุกหน้า/ทุกแท็บ
  (Agent, Hub 10 แท็บ, Workflow, Overseer, ตั้งค่า Mimi 3 แท็บ) ไม่มีรายการไหนอ่านข้อมูลไม่ได้, เพิ่ม → แก้ → ลบ skill ผ่านฟอร์ม,
  ติดตั้งแพ็ก "สรุปเช้า" (ยืนยัน + รายงาน) → เปิด workflow ที่ได้ → ดูผัง → ถอนแพ็ก (รายงาน)
- รอบที่ 4 (หน้าตาแบบ Electron, editor, Workspace): unit test **75** ตัวผ่าน, UI test **3/3** ผ่าน — ตัวใหม่ (`FeatureTourTests.cs`) สลับธีมสว่าง/มืด,
  ตั้งหน้าตาของแชต + ฉากหลัง, เปิด Mimiamp, สร้าง workflow ใหม่ → บันทึก → เพิ่ม node "set" → ทดสอบ node นั้น (ผ่าน) → บันทึก, เดินตัวช่วยตั้งค่า, เปิด Workspace
  จนเทอร์มินัลขึ้น prompt · ภาพของ UI test ตอนนี้ถ่ายเฉพาะหน้าต่างของแอป (PrintWindow) ไม่ถ่ายจอส่วนอื่น
- **รอบ 5–7 รันบน Windows แล้ว (2026-11-03 คืน)**: build Debug + Release ผ่าน (XAML ด้วย), unit test **84/84**, UI test **3/3** ทั้งกับ Debug และ
  `dist/win-native/Mimi/Mimi.exe` (Release) · core ในชุด (`core/` + `node\node.exe`) เปิดแล้วตอบ `/health` ได้ · เพิ่มค่าเริ่มต้นของ node ใหม่ใน workflow
  ให้ตรงกับเว็บ (llm, file, extract_file, loop, wait, switch, …) + กลุ่ม "ไฟล์" ในเมนูเพิ่ม node · ⚠️ `node_modules` ที่คัดลอกมาจาก Mac ใช้ไม่ได้
  (ลิงก์ workspace กลายเป็นโฟลเดอร์จริง → core ล่มด้วย `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) ต้อง `npm ci` ใหม่บน Windows
- บน VM เครื่องนี้ ภาพหน้าจอของ UI test ตอนอยู่หน้าจัดการบางครั้งออกมาดำทั้งบาน (ข้อมูลใน UI Automation ครบและเทสต์ผ่าน) — ยังไม่รู้สาเหตุ ควรเปิดดูด้วยตาบนเครื่องจริง

ยังไม่ได้ทำ / ยังไม่ได้ทดสอบ (ตามจริง):
- **WNS** (push ตอนแอปปิด) — ทั้งฝั่งแอปและเซิร์ฟเวอร์ยังไม่มี; แจ้งเตือนมาเฉพาะตอนแอปเปิดอยู่ในถาด
- build arm64 ยังไม่ได้ **รัน** บนเครื่อง arm64 จริง; Windows 10 ยังไม่ได้ลอง (ทดสอบบน Windows 11 เท่านั้น)
- Phase 6 ชุดแชต ยังไม่ได้ทดสอบมือ: ส่งต่อ (มีแต่ unit test), รีแอ็กชัน/ถูกใจบนแอปจริง, rewind กับเครื่องมือที่แก้ไฟล์จริง,
  หลายหมุดพร้อมรายการ, ค้นหาข้อความที่อยู่หน้าเก่ามาก, ปุ่มกระดิ่งกับแจ้งเตือนจริง (reminder/approval)
- snippet ของ `search` ที่เซิร์ฟเวอร์ตัดมาอาจเริ่มกลางพยางค์ไทย (เช่น "…ั") — ตัดที่ฝั่ง core (เว็บเป็นเหมือนกัน) ยังไม่แก้
- ยังไม่ได้ทดสอบมือ: ถาด/เมนู, toast + คลิกเปิดแชต, ปุ่มมีเดีย/SMTC, EQ ฟังด้วยหูจริง, อัดเสียง (ไม่มีไมค์ทดสอบ), แนบไฟล์/ลากวาง,
  การ์ดขออนุญาต + approval กับเครื่องมือจริง, PC agent + กล่อง consent, ล็อกอัตโนมัติ, เปิดตอนเข้าสู่ระบบ, ตัวอัปเดต (ยังไม่มี release ของแอปนี้),
  ติดตั้งด้วย setup.exe ทับแอป Electron, ล็อกอินผ่าน gateway + 2FA กับ gateway จริง (มีแค่ unit test), YouTube จริง
- เปิดแอปครั้งแรกหลังย้ายจาก Electron ต้องล็อกอินใหม่ (session.bin ของ Electron เข้ารหัสด้วยกุญแจของ Chromium ไม่ได้อ่าน)
- ไม่มี Workspace / เบราว์เซอร์ในตัว (Phase 6) — PC agent ใช้ Edge/Chrome ของเครื่อง
- ยังไม่ได้ทดสอบมือหรือกับบริการจริง: หน้าจัดการทุกปุ่มนอกจากที่ UI test กด (OAuth Google/Microsoft, กล่องเมลจริง, MCP server, นำเข้า OpenAPI/n8n,
  อัปโหลดรูป/VRM/ไฟล์คลังความรู้, สำรองข้อมูล + ดาวน์โหลด, 2FA กับ gateway จริง, tunnel), การ์ด task กับงานจริงของ PC agent, อ่านออกเสียงภาษาไทย
  (ต้องมีเสียงภาษาไทยของ Windows), แชตกลุ่มกับหลาย agent
