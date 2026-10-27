# Import feasibility — n8n / Make / Zapier

สถานะ: **Phase 3 (importer ทั้ง 3 ตัวใช้งานได้แล้ว)** · เจ้าของ: `P0-IMPORT` (feasibility), `P3-N8N` / `P3-MAKE` / `P3-ZAPIER` (importer)

importer อยู่ที่ `packages/core/src/workflows/n8n-import.ts`, `make-import.ts` และ `zapier-import.ts`.
รายละเอียด mapping ต่อแพลตฟอร์ม: `n8n-mapping.md`, `make-import.md`, `zapier-import.md`;
UI/flow: `migration-ui.md`; test matrix: `packages/core/src/test/connector-migration.test.ts`.

## 1. แหล่งข้อมูลและข้อจำกัดของเอกสาร

| แพลตฟอร์ม | เอกสารที่ใช้อ้างอิง |
|---|---|
| n8n | <https://docs.n8n.io/workflows/export-import/> · source: `packages/core/src/workflows/n8n-import.ts` |
| Make | <https://help.make.com/blueprints> · <https://developers.make.com/api-documentation/api-reference/scenarios/blueprints> |
| Zapier (account export) | <https://help.zapier.com/hc/en-us/articles/8496289406349-Export-or-delete-your-Zapier-account-data> |
| Zapier (Zap import/export) | <https://help.zapier.com/hc/en-us/articles/8496308481933-Import-and-export-Zap-workflows-in-your-Team-or-Enterprise-account> |
| Zapier (workflow API shape) | <https://docs.zapier.com/powered-by-zapier/zap-creation/how-to-build-a-workflow> |

ข้อจำกัดสำคัญ:

- n8n เผยแพร่รูป export และ importer ของ Mimi อ่านได้โดยตรง.
- Make เผยแพร่โครง blueprint (`name`, `flow`, `metadata`) และ module fields.
  แต่ module catalog/version เปลี่ยนตาม app จึงต้องมี catalog ของ Mimi เอง.
- Zapier **ไม่ได้ประกาศ schema ของ `Zapfile.json` อย่างเป็นทางการ**. เอกสารช่วย Center
  อธิบายเฉพาะเนื้อหา (workflow, inputs/outputs, references) ไม่ได้ให้ JSON schema.
  fixture ของเราอิงรูปที่พบใน export จริง/ตัวอย่างชุมชน:
  `{ "metadata": { "version": 2 }, "zaps": [ { "nodes": { "<id>": { ... } } } ] }`
  และ must treat it as an unstable, versioned format.
- per-Zap JSON export (Team/Enterprise) เป็นอีก format หนึ่ง และมีรายงานว่าอาจ
  renumber step ids; ตัวอ่านในอนาคตต้องรองรับทั้ง `zapfile.json` และ per-Zap file.

## 2. Fixtures

ไฟล์ทดสอบอยู่ที่ `packages/core/src/test/fixtures/import/`:

| ไฟล์ | เนื้อหา | ใช้ทดสอบ |
|---|---|---|
| `n8n-lead-intake.json` | Webhook → HTTP → Gmail → Google Sheets → Slack → NoOp | importer จริง, redaction, unsupported report |
| `n8n/top-services.json` | mapping ของ service ทั้ง 50 | `n8n-import-connectors.test.ts` |
| `make-lead-intake.blueprint.json` | Webhook → HTTP → Filter → Sheets → Slack → Router → Code | blueprint walker, `__IMTCONN__`, refs, unsupported modules |
| `make/branch-and-error.blueprint.json` | router หลาย route + error branch + module ที่ยังไม่รองรับ | branch/error mapping, placeholder |
| `zapier-lead-intake.zapfile.json` | Webhook → Sheets → Filter → Slack → Code → Airtable | `parent_id` graph, `{{step__field}}`, auth refs, unsupported apps |
| `zapier/secure-webhook.zapfile.json` | 2 Zaps, HTTP header ที่เป็นความลับ, schedule | redaction, multi-Zap, schedule→manual |

fixture ทั้งหมดเป็นข้อมูลสมมติ: ไม่มี credential จริง, ไม่มี token จริง และไม่มี private key.
test `connector-import-fixtures.test.ts` ตรวจว่า JSON parse ได้และไม่มี prefix ของ token จริง.

## 3. Format ที่อ่านได้

### n8n

- Top-level เป็น workflow object หรือ array/`{ workflows: [...] }`.
- `nodes[]` มี `name`, `type`, `typeVersion`, `parameters`, `position`, `disabled`,
  `onError`, `retryOnFail`, `maxTries`, `waitBetweenTries`.
- `connections` เป็น `{ "<node>": { main: [[{ node, index }]] } }`.
- trigger ที่รองรับ: manual, schedule/cron/interval, webhook, Gmail, Outlook, Telegram,
  chat, form, RSS, error, executeWorkflow.
- importer สร้าง workflow **disabled** หนึ่งรายการต่อ trigger, แปลง expression,
  ตัด credential/secret และใส่ placeholder พร้อมเหตุผลเมื่อ map ไม่ได้.

### Make

- Blueprint เป็น `{ name, flow: Module[], metadata }`.
- Module มี `id`, `module` (`namespace:ModuleName`), `version`, `parameters`,
  `mapper`, `filter`, `metadata.designer`; router มี `routes[].flow`; error handler
  อยู่ที่ `onerror.flow`.
- ค่าที่ผู้ใช้เลือกบ่อยอยู่ใน `parameters` (เช่น `__IMTCONN__`, `hook`), ค่าที่ map
  จาก step ก่อนหน้าอยู่ใน `mapper` และอ้างด้วย `{{<moduleId>.<field>}}`.
- ต้องเดิน flow แบบ recursive ผ่าน `routes` และ `onerror`; module ใน branch
  ไม่ได้เรียงตาม `id` เสมอ.

### Zapier

- `Zapfile.json` เป็นชุด Zap; Zap แต่ละตัวมี step เป็น object keyed by id.
- step มี `id`, `action`, `selected_api`, `authentication_id`, `parent_id`,
  `root_id`, `type_of`, `params`, `meta`.
- ลำดับจริงต้องเดินจาก `parent_id` (root = `null`) ไม่ใช่เรียงตาม key.
- filter/paths ทำให้ graph แตกแขนง; ต้องเก็บ branch ไม่ใช่บังคับเป็นเส้นตรง.
- mapping แบบเก่า: `{{<stepId>__<field>}}`; แบบใหม่: `{{=gives["<stepId>"]["<field>"]}}`.
- `authentication_id` เป็น opaque id; `null`/`"-"` = ไม่ใช้ connection.
- connection ไม่ถูก export; ค่าที่พิมพ์ลง field ตรง ๆ อาจเป็นความลับและติดมาในไฟล์.

## 4. Field mapping ที่ตรง / ไม่ตรง

| ต้นทาง | Mimi ที่ใกล้ที่สุด | ระดับ |
|---|---|---|
| n8n Webhook / Schedule / Gmail / Telegram trigger | trigger pool เดิม | ตรง |
| n8n HTTP Request | `http` | ตรง (query/header/body/retry) |
| n8n IF / Filter / Switch | `if` | ตรงบางเงื่อนไข; operator ที่ซับซ้อนต้องแปลง |
| n8n Code / Set / Merge / Wait / Sort / Limit | `code`, `set`, `merge`, `wait`, `sort`, `limit` | ตรงบางส่วน; JS runtime ต่างกัน |
| n8n Gmail / Outlook / Calendar / Sheets | tool เดิม (`gmail_send`, `sheets_append`, …) | ตรงเมื่อ tool มีใน pool |
| n8n Slack / Notion / HTTP auth | connector node | map แล้วเมื่อ service อยู่ใน 50 catalog (`n8n-mapping.md`) |
| Make `gateway:CustomWebHook` | webhook trigger | ตรง |
| Make `http:ActionSendData` | `http` | ตรงบาง field; ต้องแปลง mapper |
| Make `google-sheets:addRow` | `sheets_append` / connector | ตรงเมื่อมี tool |
| Make `builtin:BasicFilter` | `if` | ตรงบางเงื่อนไข |
| Make `builtin:BasicRouter` | `if` / branch | ต้องสร้าง branch หลายทาง |
| Make `slack:sendMessage` | connector `slack/send_message` | map แล้ว (high confidence) |
| Make `code:ExecuteCode` | `code` | syntax/limit ต่างกัน |
| Make iterator/aggregator | `loop`/aggregate | ไม่ตรงโดยตรง |
| Zapier `WebHookAPI` / `ScheduleAPI` | webhook / schedule trigger | ตรง |
| Zapier `FilterAPI` / Paths | `if` / branch | ตรงบางเงื่อนไข |
| Zapier `FormatterAPI` | `set` / `code` | ต้องแปลง operation |
| Zapier `GoogleSheetsV2API` | `sheets_append` / connector | ตรงเมื่อมี tool |
| Zapier `SlackAPI` | connector `slack/send_message` | map แล้ว (high confidence) |
| Zapier `CodeAPI` | `code` | Python/JS runtime ต่างกัน |
| Zapier `AirtableAPI` | connector `airtable/create_record` | map แล้ว (medium confidence; ต้องเติม field) |
| Zapier app อื่น ๆ | connector ถ้าอยู่ใน 50 catalog | นอกนั้นเป็น code placeholder |

Expression ที่ต้องแปลง:

- n8n: `={{ $json.x }}` → `{{ $json.x }}`; `$('Node')` → `$node["Node"]`;
  `$input`, `$now`, Luxon function ต้องมี warning/handling.
- Make: `{{1.field}}` → `{{ $node["<ชื่อ module>"].json.field }}`;
  ต้องแก้ `{{now}}`, `formatDate`, `if`, `map` และตัวเลข module ที่ชี้ผิดหลัง renumber.
- Zapier: `{{1__email}}` → `{{ $node["<ชื่อ step>"].json.email }}`;
  new-style `gives[...]` ต้อง resolve จาก step id; filter keys ต้องแปลงเป็นเงื่อนไข Mimi.

## 5. Auth / credential

| แพลตฟอร์ม | สิ่งที่ export มา | สิ่งที่ต้องทำใน Mimi |
|---|---|---|
| n8n | ชื่อ credential และ id; ค่า secret ไม่ควรอยู่ใน export | importer ตัดค่าที่ดูเป็น secret; ผู้ใช้ใส่ค่าใหม่ใน vault |
| Make | `__IMTCONN__` / connection id; ไม่มี token | สร้าง connection ใหม่และ map เข้า connector auth |
| Zapier | `authentication_id` (opaque), `"-"` = ไม่มี | reconnect ด้วย OAuth/API key; ห้ามคาดเดา id |

Phase 3 ใช้ connection store ของ Mimi (`ConnectorConnections` + Google accounts,
ดู `auth-matrix.md`); legacy vault key `connector.<connector>.<field>` / environment
`<CONNECTOR>_<FIELD>` ยังเป็น fallback. import รายงานเฉพาะ "ต้อง reconnect"
ไม่พยายามถอดหรือเดา credential.

## 6. ข้อจำกัดทางกฎและแพลตฟอร์ม

- **Zapier:** import ได้เฉพาะ export ที่ผู้ใช้มีสิทธิ์เท่านั้น. การ export/import
  ทั้ง workspace ต้องเป็นเจ้าของบัญชีหรือ admin ตาม plan/role; ห้ามใช้ไฟล์ของผู้อื่น
  หรือหลบข้อจำกัดของ plan. การ import สร้าง Zap ใหม่ ไม่ได้ overwrite ของเดิม.
  ไฟล์ account export อาจมีค่าที่พิมพ์ใน field และประวัติการรัน; ต้องถือเป็นข้อมูลลับ.
- **Make:** blueprint ต้องมาจาก scenario ที่ผู้ใช้มีสิทธิ์; connection/credential
  ไม่ติดมา และต้อง re-authorize. การสร้าง scenario ผ่าน API ต้องมีสิทธิ์ใน team/
  organization และเป็นไปตามข้อจำกัดของ plan.
- **n8n:** ใช้ export ของตนเองหรือที่มีสิทธิ์; ระวัง credential reference และ
  ข้อมูลใน Code node. importer ของ Mimi ไม่รัน workflow ที่ import จนกว่าผู้ใช้จะเปิด.
- ทุกแพลตฟอร์ม: อย่าเก็บ export ลับไว้ใน repo, log, fixture หรือ error message.
  ถ้าจำเป็นต้องเก็บตัวอย่าง ให้ scrub ค่าและใช้ placeholder.

## 7. ผลลัพธ์ Phase 3

ทั้ง 3 importer merge แล้ว (3A n8n, 3B Make, 3C Zapier) พร้อม migration UI (3F)
และ test matrix (3H):

1. **n8n:** baseline เดิม + mapping service 50 ตัว (`n8n-mapping.md`) และ golden fixture
   `top-services.json`; รายงาน mapped/unsupported/redacted/connections ครบ.
2. **Make:** module catalog, walker ที่รองรับ `routes`/`onerror`, expression translator
   และ connection report (`make-import.md`); blueprint fixture 2 แบบ (linear + branch/error).
3. **Zapier:** อ่าน `Zapfile.json` และ per-Zap, เดิน graph ตาม `parent_id`, secret scan
   และ redaction (`zapier-import.md`); fixture 2 แบบ (lead intake + secure webhook 2 Zaps).

ข้อจำกัดที่ยังอยู่ (Phase 4+): trigger semantics ที่ต้อง polling/webhook subscription
เฉพาะแพลตฟอร์ม, loop/aggregator/digest/storage/paths ที่ซับซ้อน, dynamic field/choices
ที่ต้องเรียก API ระหว่าง import, auto-migrate credential หรือ auto-run หลัง import —
importer สร้าง workflow disabled และไม่เขียน credential เสมอ.

## 8. Acceptance ของ 0D

- fixture ทั้ง 3 ไฟล์ parse ด้วย `JSON.parse` ได้
- test ตรวจ n8n importer, Make blueprint walker, Zapier step graph และ unsupported ครบ
- เอกสารระบุชัดว่า Zapier import ทำได้เฉพาะ export ที่ผู้ใช้มีสิทธิ์
- ไม่มี secret/token จริงใน fixture, เอกสาร หรือ test output
