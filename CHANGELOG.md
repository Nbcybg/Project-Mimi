# Changelog

## Unreleased

### 0.8.1-prototype

- PC agent: on the desktop app (Windows and macOS) it now starts by itself after sign-in, no longer waiting
  for the tray switch. Existing installs are switched on once; turning it off in the tray menu stays off.
  Commands and MCP (the "shell" switch) remain off until chosen.
- Release: the Mac build now ships for Intel as well (`Mimi-<version>-mac-x64.zip` beside `-mac-arm64.zip`);
  the updater picks the zip matching the computer.

### 0.8.0-prototype

- Hub: rebuilt for people who have never seen it. Every tab says in one line what it holds; lists are cards
  (or a table for the model pool) with search and filters; adding and editing happen in popups that ask before
  closing with unsaved changes; every delete asks for confirmation in the same popup; tabs that hold movable
  things have import / export. The Mail tab moved into บัญชี (as "กล่องเมล") and the MCP / CLI pointer tab is
  gone (MCP servers are a filter of Node & เครื่องมือ). Lists always follow the server, so a saved item shows
  up at once.
- Model pool: presets pick a provider first, then its model, and take numbers typed in (no sliders) for
  temperature, top_p, top_k, max tokens, min tokens, presence / frequency / repetition penalty. Each field says
  its default value and has a ↺ reset; "ทำสำเนา" copies a preset. Min tokens and repetition penalty go to the
  request body of OpenAI-compatible providers (`min_tokens`, `repetition_penalty`).
- Node & เครื่องมือ: one card grid for workflow nodes, tools, custom tools, MCP servers and connector services,
  with kind and group filters. Node presets are new: a node with its settings filled in, made here or with
  "★ preset" on a node in the workflow editor, listed under "Preset ของฉัน" in the canvas library and shared
  across the account's devices. Import / export covers node presets, custom tools and MCP servers (also the
  `mcpServers` file of Claude Desktop).
- Skill: cards with filters; SKILL.md files import (one opens in the editor, several save at once; Claude's
  `allowed-tools` is read as tools) and every skill exports as .md; the tools of a skill are picked as cards
  from a searchable picker instead of a long checkbox list.
- Trigger: one list for reminders, agent tasks and the trigger of every workflow (open / switch on-off from
  the card), with run, edit, copy and delete. Trigger types are cards too; custom ones can be edited. Google /
  Outlook calendar sync now lives inside the "ปฏิทินเปลี่ยน" type and the mailboxes inside "อีเมลใหม่".
- Group chat follows the design: ตัวต่อตัว / กลุ่ม tabs in the chat list with "+ สร้างกลุ่มใหม่", header
  pills, each reply labelled with who it answers, and a rail with members and their status (tap to @ them),
  who talked to whom in the latest question, and the group's rules. Groups can be renamed, members added,
  removed and reordered (the first answers when nobody is @-called).

- Chat: an agent's own emoji sprite now wins over an outfit's static picture, so uploaded sprites show while
  an outfit is worn; when nothing else is set, the small avatar is used instead of leaving the stage blank.
  An agent without an avatar also uses its first emoji sprite (else its portrait) as the chat-list picture.
- Chat: the character no longer vanishes when its picture cannot be shown. An agent set to 3D shows its 2D
  picture while the VRM loads and keeps it when the model fails to load (or there is no WebGL), instead of an
  empty canvas; a 2D picture that fails to load or decode is skipped for the next one (portrait → sprites →
  avatar) instead of leaving the stage blank.
- Chat (character on): message level 1 shows the two newest messages instead of one. The message box no
  longer sits on a plain band: the stage and its backdrop run on behind it (glass box on desktop), and only
  the log is cut above it.
- Android: the back button closes the topmost picture, popup, menu or side panel, or goes from a chat or
  page back to the list; with nothing left the app goes to the background instead of closing.
- Motion: new messages slide in (history renders do not replay it), screens fade in, popups and menus
  pop, toasts slide in, the mobile chat list slides in, and buttons give a small press. All off with the
  system's "reduce motion".
- Permissions: task and session approvals belong to the agent that asked. In a group chat or a handoff, another
  agent in the same turn/session asks on its own and no longer inherits the approval. Renaming an agent moves
  its forever approvals, and deleting one drops them so a later agent with the same name cannot inherit them.
  Removing an old "every agent" approval in Settings now clears only that list, not the same tool family from
  the individual agents.
- AI Overseer: the prompt now includes a workspace manual (Files, Browser and Terminal panes, the built-in
  Chromium browser, Mimiamp and the screens of the web client), and the mimiamp tool is available to it.
- Settings: a "start Mimi when the computer starts" switch in the desktop app (Windows/macOS), and the Windows
  build now writes Mimi's name, version and icon into the .exe instead of leaving Electron's identity, so Task
  Manager, Alt-Tab and the startup-app list say Mimi.
- Mimiamp: songs are read from `MIMI_MUSIC_DIR`, then `<user>/mimiamp`, then `<app>/mimiamp`, then the built-in
  demo folder (the first one with audio files); a folder at the project root is copied by the Docker build too.
- Workspace: a page that crashes or reloads no longer floods the log with "Render frame was disposed" while
  its shell keeps printing; the shell (and anything it runs) stops with the page, and a crashed page reloads
  itself once. Unsaved edits in the file preview are marked with ● and need a confirmation before another
  file, Close or another folder drops them. The file filter keeps a folder visible when something inside it
  matches. After the shell exits, Enter starts a new one.
- Packs: an installed pack can be removed. Hub > แพ็ก shows a preview of the agents, OpenAPI connectors and
  workflows the pack created and deletes only those; items another workflow or agent still uses are kept and
  listed. Reused agents and connectors are never removed. Packs installed before ownership tracking only lose
  their record, and their items stay.
- Accounts: two-step sign-in now issues 10 one-time recovery codes when it is enabled (80 random bits, stored
  hashed, shown once), accepts one in the code field, and can replace the unused set from Settings with the
  password. Settings also has a password change that signs out the other devices but keeps the current session.
  The other open devices of an account get a "new sign-in" alert when a session is created.
- Calendar: Microsoft Graph subscriptions now ask for lifecycle notifications. A removed subscription is
  recreated on the next pass, a missed notification triggers a delta pass, and an expired authorization shows
  in the Calendar sync panel until the Microsoft account is reconnected. Google and Microsoft accounts can
  also pick which calendar to watch (Hub > Trigger > Calendar sync > เลือกปฏิทิน; the list comes from the
  provider, or an id can be typed; Microsoft also offers "all calendars"). Switching stops the old push
  channel/subscription and starts a fresh baseline.
- Tunnel: a named Cloudflare tunnel can be configured beside the quick one (`MIMI_CLOUDFLARED_TUNNEL` with
  `MIMI_CLOUDFLARED_URL` or a hostname in `MIMI_CLOUDFLARED_CONFIG`). Its address stays the same across
  restarts and the core starts it by itself unless `MIMI_CLOUDFLARED_AUTOSTART=0`; the settings screen shows
  the mode and name.
- Connectors: OpenAPI import now infers pagination for common list endpoints (page + size parameter, or a
  cursor/page token with `nextPageToken`/`nextCursor`/`paging.next`/`links.next`) and reads an
  `x-mimi-rate-limit` extension as `{ requests, perMs, burst? }`. Triggers are still never derived.
- Desktop: the packaged apps flip Electron fuses before signing (`scripts/fuses.mjs`): RunAsNode stays on for
  the PC agent and Workspace terminal, while NODE_OPTIONS and CLI inspect arguments are disabled.
- Packs: `MIMI_PACK_CATALOG_URL` can add a remote catalog (an https JSON array or `{ "packs": [...] }`) to
  Hub > แพ็ก. Entries are validated like pack files, shown with a "remote" badge, and the fetch is capped at
  4 MB / 5 seconds. There is no signature; only use a source you trust.

## 0.7.9-prototype - 2026-11-01

- Packs: Hub > แพ็ก installs ready-made sets of agents, OpenAPI connectors and workflows in one go, with a
  credential checklist (model provider, connector connections, Google / Microsoft accounts and vault secrets the
  workflows use) that is checked live and kept for installed packs (`user/packs/<id>.json`). Three packs ship with
  the app: morning weather brief (Open-Meteo), USD/THB rates (Frankfurter), both without keys, and an evening Gmail
  digest. Pack files (`format: 1`, JSON) can be installed too. Preview changes nothing; install never overwrites
  (existing agents and connectors are reused, taken workflow names get a suffix), saves every workflow switched off,
  imports connectors through the OpenAPI import rules, and refuses unknown tools, unknown triggers, a built-in pack
  id and agents that would mix outside content with the shell. See `docs/packs.md`.
- First run: a setup wizard opens over the app when nothing can chat yet: provider (Claude plan, ChatGPT plan or an
  API key, plus the default chat model), a starter agent (secretary, researcher, PC helper or coder, from the new
  `agent-presets` message), allowed folders, the PC agent and a test chat. Finishing or skipping is remembered across
  devices; Settings has "ตัวช่วยตั้งค่า" to open it again. Presets that read the web or mail have no shell tool.
- Desktop releases: every release carries `SHA256SUMS.txt`, and the desktop updater refuses a zip whose size or
  SHA-256 differs (or a release without the file). When the installed app is publisher-signed, the update must carry
  a valid signature from the same publisher (Authenticode subject on Windows, Team ID on macOS), and a notarized Mac
  app keeps its quarantine flag. The builds sign when certificates are configured (`scripts/signing.mjs`:
  `WIN_CSC_*` for Authenticode with signtool, `APPLE_SIGN_IDENTITY` for Developer ID with the hardened runtime,
  `APPLE_ID` / `APPLE_APP_PASSWORD` / `APPLE_TEAM_ID` for notarization), and release.yml passes them from secrets;
  without them the builds stay unsigned / ad hoc as before.
- Tunnel: Settings > แอปและระบบ can open a Cloudflare quick tunnel (`cloudflared tunnel --url`, found on PATH, the
  usual install folders or `MIMI_CLOUDFLARED`) and shows its https://….trycloudflare.com address. Webhook URLs in the
  app switch to it and calendar push subscribes to it when no calendar address is configured. It is refused on a
  core that already has a public address or a `MIMI_TOKEN` shorter than 16 characters, ChatGPT plan sign-in is
  refused while it runs, the sign-in limiter counts tunnel callers by `cf-connecting-ip`, and cloudflared gets no
  secrets in its environment.
- Accounts gateway: sessions now also end `MIMI_SESSION_MAX_DAYS` (default 90) after sign-in, however often they are
  used. Each account can turn on two-step sign-in (TOTP, any authenticator app) in Settings with its password and a
  first code; sign-in then asks for a code, each code works once, wrong codes count toward the sign-in limits, and
  `accounts 2fa-reset <user>` removes it (and signs out every device) when a phone is lost.
- Connectors: OpenAPI import is usable from the app. Hub > Node & Tools > "+ นำเข้า OpenAPI" previews an OpenAPI
  3.x JSON document (operations with risk, tool names, unsupported parts, warnings) and on confirm stores it in
  `user/connectors/imported/<key>.json` and adds its tools without a restart; imports load again at start-up and can
  be replaced or removed. Imports are JSON only (2 MB), https and non-local servers only, may not reuse a native key
  or an existing tool name, and are capped at 50 connectors / 200 operations. Every imported operation is
  `untrustedInput` (so it cannot share an agent with the shell), risk follows the method (GET read, DELETE delete,
  others write), and a hand-edited file cannot relax that, add triggers, use absolute URLs or borrow Google tokens.
  A broken file is skipped with a log line; the 50 native connectors are unchanged. New messages
  `connector-import-preview` / `connector-import-save` / `connector-import-delete` → `connector-import-report`.
- Providers: `claude-subscription` lets a Claude Pro/Max user chat through their own plan by driving the installed
  Claude Code CLI (or `CLAUDE_CODE_OAUTH_TOKEN` on a server). Its built-in tools, claude.ai connectors and settings
  files are off, so the prompt is Mimi's alone; Mimi's tools reach the CLI over an in-process MCP bridge and still go
  through the permission gate.
- Providers: `chatgpt-plan` lets a ChatGPT Plus/Pro user sign in with ChatGPT (OAuth with PKCE on a loopback port)
  instead of pasting an API key; requests go to the Responses API with the access token. Tokens are kept in
  `chatgpt-plan.json` beside `auth.json` and revoked when the provider is removed. A core served from a public
  address refuses to connect, since the sign-in program covers local apps only. Settings show a connect box that
  updates itself when sign-in completes.
- Notifications: opening a chat marks its notifications read, and a notification for the chat on screen is not
  counted as new, so the bell no longer counts replies already seen.
- Desktop: the Workspace browser keeps its sign-ins across restarts (until sign-out) and flushes cookies after each
  page load. The Workspace terminal shows UTF-8 output (Thai file names), sends Thai commands intact, Ctrl+C stops
  only the running command, and Restart kills the whole process tree.
- Web UI: the empty chat view explains what to do, Mimiamp has a back button on narrow screens, the floating chat
  settings panel has a close button, and the Settings header counts its real tabs.
- Dependencies: `undici` updated to 7.30.1 (`npm audit` clean).

## 0.7.8-prototype - 2026-10-31

- MCP: the legacy HTTP+SSE transport is supported next to stdio and Streamable HTTP; a refresh also records the
  server's health latency. A dropped transport reconnects at once, then backs off (1 s doubling to 60 s, five
  tries), and an SSE stream that ends closes the session so the next call starts a fresh one. Agents still see
  tools as `mcp_<server>_<tool>` with risk and `{{secret.NAME}}`.
- Permissions: each agent can carry its own `permissions` map (allow / ask / deny per tool or preset), enforced in
  chat, task gates and workflow tool nodes; the agent editor shows a searchable allow/ask/deny matrix. Approval
  cards offer once / task / session / always; forever grants are stored per agent (old global grants still apply as
  `*`) and removable in Settings.
- Coding tools: `grep`, multi-file `apply_patch`, `git_status` / `git_diff` / `git_log` / `git_commit`, and background
  `run_shell` with `shell_output` / `shell_stop`; rewind now restores `apply_patch` changes too. A separate project
  allowlist narrows `run_shell` to approved folders inside the allowed folders; the PC agent intersects the list with
  its own folders, so the core can narrow but never widen what runs.
- Agents: `lazy_tools` plus `tool_search` keep large tool lists out of the prompt until the model asks for them;
  `send_to` can cap a sub-agent's rounds/tokens; `send_agents` runs up to 8 sub-agents in parallel; `plan_set` /
  `plan_read` and `todo_write` / `todo_read` track long work, with the checklist shown open in the chat.
- Custom workflow nodes are first-class node types (`custom:<name>`) as well as the older plugin node, and may declare
  several outputs; an item's `$output` chooses one.
- Workflow nodes: `assert`, `debug`, `json_schema`, `agent_call`, `mcp` and `notify`; `$secret.NAME` works in every
  expression (and in the code node) without writing the value into the workflow. The notify node posts to the agent's
  chat and raises one inbox notification, with vault values redacted.
- AI Overseer: `agent_test` (alias of `agent_message`), `secret_audit`, `config_diff` / `config_rollback` (agents,
  tools, presets, skills and workflows; writes are snapshotted first), and `run_log` (tool call counts, failures
  and duration, backed by migration 023; chat tools plus workflow `tool`, `mcp`, `connector` and `sheets` nodes are
  logged, and `tool_test` records the tool it tested).
- AI Overseer, layer 1: it can read files, run shell commands (`run_shell` / `shell_output` / `shell_stop`), use the
  built-in browser and take screenshots, notify the user, send mail, schedule reminders or recurring tasks for itself,
  write secrets through `secret_set` (the value is hidden from cards and history), start Google/Microsoft sign-in with
  `oauth_start`, enable or disable a reviewed workflow with `workflow_enable` / `workflow_disable`, and update its own
  agent (never rename or duplicate it).
- Secrets: workflow run history, debug output, errors and the run result redact the actual vault values, not just
  credential-shaped text; a tool may hide its own input with `redactInput`. `git_commit` refuses `.env`, key and
  credential files unless `allow_secrets` is set.
- Calendar, contacts and files: Google Calendar events can be updated and deleted next to list/create; Google
  Contacts and Outlook Contacts can be searched, created and updated; Google Drive gains `drive_share` and
  `drive_update_metadata` next to `drive_upload` (multipart, up to 50 MB), and the `google_drive` connector gains
  `upload_file` (base64), `rename_file`, `share_file` and `share_anyone`; OneDrive gains `onedrive_upload`
  (Files.ReadWrite, up to 50 MB). `media_trim` cuts video/audio to a new file without touching the original.
  Google and Microsoft accounts must be reconnected once to grant the contacts / file-write scopes.
- Media editing: `pdf_merge`, `pdf_split`, `pdf_delete_pages` and `pdf_rotate` (pdf-lib), `image_crop` /
  `image_rotate`, `video_merge` and `media_subtitle` (soft SRT track) all write new files and never change the
  originals. MCP servers get a quiet 15-minute health check over the existing connection.
- Layer 2 editing: `pdf_delete_pages` / `pdf_rotate`, `image_crop` / `image_rotate`, `media_trim` and
  `media_subtitle` accept `in_place: true` and replace the source only after the write succeeded; the previous
  version is kept as `<name>.mimi-backup<ext>` unless `backup: false`. `media_subtitle` can burn the subtitles into
  the picture (`mode: "burn"`, MP4/MKV/MOV), and `media_extract_audio` writes MP3/M4A/WAV/OGG audio from any media.
  Without `in_place` the tools still write a new file and leave the source alone.
- Apps: `install_app` installs or updates a package through winget, Homebrew, Chocolatey, Scoop or apt. It accepts
  only a package id (no flags or command text) and runs the manager with fixed arguments and no shell; the PC's
  local consent and the agent permission gate both apply, and the Overseer can use it.
- Statements and payments: `statement_read` parses CSV/TSV, OFX/QFX and QIF bank or card statements (Thai and
  English headers) into normalized transactions with money-in, money-out and net totals; it is read-only, never
  contacts a bank and never changes the file. Stripe's `create_payment_link` and `refund_payment` now require the
  exact `confirm` phrase and always ask the user, even if a grant exists; every call is recorded in `tool_calls`
  for `run_log`. Direct bank transfers are not implemented.
- Browser secrets: `browser_fill_secret` fills a password or card field on the current page from a named vault
  secret. The model passes only the secret name and never sees the value; the PC-side tool only accepts password /
  payment fields, snapshots hide their contents, and every call needs a fresh "this once" approval (task, session and
  forever grants do not cover it). Unattended workflows and `tool_test` refuse it.
- Chat: room settings sync across devices, a go-to-bottom button, and permission notifications.
- Triggers: schedule times are shown in the local time zone, not UTC.
- Chat: the message action bar (love, react, reply, forward, copy, pin) sits under the bubble and is no longer
  clipped by the message's paint containment.
- Chat: the character stage keeps its last picture when an emoji has no picture yet, and falls back to another
  sprite when an agent has no portrait, instead of going blank.
- Chat: changing text size or the message level keeps the reader's place (and the chat settings panel no longer
  jumps to the top after every change).
- Errors in the chat and in toasts now carry a stable code such as `E-AUTH-401`, `E-RATE-429`, `E-NETWORK`,
  `E-CONTEXT`, `E-CONFIG` or `E-BUDGET`. The AI Overseer can explain any code with `error_codes`; the same
  catalog is in `docs/error-codes.md`.
- AI Overseer: `trigger_list` / `trigger_get`, `agent_message` (test a prompt, rate-limited), `workflow_runs`,
  `tool_test`, `config_validate`, and `agent_history` / `agent_restore` plus `tool_history` / `tool_restore`
  (the last 10 versions, snapshotted before every write).
- Tasks: a first-class task model and deterministic runner with steps, gates, verification, receipts and undo;
  SQLite migration 022; `task_run` / `task_undo` offered to every agent.
- File organizer: `organize_files` / `undo_organize` with a dry-run plan, journal, rename/skip/safe-overwrite
  conflict policy, no deletion, and path-guard enforcement.
- Permissions: session-scoped "allow for this task" grants by trace + tool family, 15-minute assist timeout,
  and a plain-language permission card with the raw input behind details.
- Local consent: the PC agent asks on the user's machine before non-read actions, through the desktop dialog
  or an OS dialog; a task approval is cached for that task and tool family.
- Workspace / developer task: `workspace_*` tools with a cross-platform command runner, sanitized env, command
  policy, git checkpoints (`refs/mimi/checkpoints/*`), diff and backup-safe undo; a developer recipe that
  reproduces a failing test, fixes it with an agent, reruns the tests and shows the diff without commit/push.
- Desktop: packaged builds now run the PC agent outside `node_modules`; Node 24 no longer refuses to strip
  TypeScript types, so the PC agent connects after the tray switch is enabled.
- Media: `photo_scan`, `photo_apply`, `photo_undo`, `photo_verify`, `media_contact_sheet` and `media_transform`
  with ffmpeg/ffprobe detection, exact and perceptual duplicate grouping, blur scores, EXIF, a sampled vision
  budget (`max_cost_usd`), read-only originals and backup-safe undo; `photo-cull` task recipe.
- Browser: `browser_upload` (CDP file inputs, allowed folders), `browser_wait`, `browser_focus` and
  `browser_check`; login/OTP/CAPTCHA become a handoff instead of being bypassed.
- YouTube: `youtube-upload` task recipe with optional audio+cover mux, metadata, a second confirmation for a
  public publish, URL verification and a receipt; passwords are never typed.
- Native desktop: `computer_observe` / `click` / `type` / `key` / `scroll` / `app` / `menu` / `wait` /
  `screenshot` / `highlight` with Windows UI Automation and macOS System Events, ref-based actions, an app
  allowlist, active-app checks and secure-field refusal.
- Mail: `mail-pop3` guided recipe for Apple Mail, Outlook and Thunderbird; it fills non-secret fields, hands the
  password to the user, tests the connection and sends one test mail after a separate confirmation.
- Autonomy: background tasks are opt-in (`MIMI_ALLOW_BACKGROUND_TASKS=1`), unfinished tasks pause after a
  restart, `task_resume` restarts resumable recipes, `task_list` / `task_audit` expose JSONL records, task results
  notify the inbox and `task_kill` stops every running task.
- Realtime calendar sync: Google `events.watch` channels and Microsoft Graph `/me/events` subscriptions push
  changes to `/api/calendar/push/<token>` (Graph `validationToken` handshake, Google channel token and Graph
  `clientState` checks, `syncToken` / `/me/events/delta` incremental reads, per-account state, three-day
  subscription renewal and dedupe). A 15-minute delta poll runs as the safety net, so a local install without a
  public HTTPS tunnel still works; the new calendar workflow trigger turns created/updated/deleted events into
  items on Google or Outlook accounts.

## 0.7.7-prototype - 2026-10-30

- Themes: a warm rose / plum palette with light and dark modes (Settings → หน้าตา), and
  each chat can keep its own theme. The status chip is centred, the composer's blurred
  glass is back on Android, and the message box no longer shows a scrollbar.
- Desktop: a separate Mimi Workspace window with the built-in browser, a project file
  tree and text editor, and a PowerShell terminal. Open it from the tray or Settings.
- Browser tools may share an agent with a shell tool (the user watches that window; shell
  calls still ask for permission), and the PC-offline message says how to connect the PC
  agent. chat_1 is 20 % quieter.
- Voice messages and `read_document` recordings get the app's language as a system
  instruction, not only in the question, so MiMo and other Chinese-biased models keep the
  transcript in Thai/English. The web client also remembers the language it guessed on the
  first load and hands it to the server, which is what was missing on existing installs.
- Typing Thai on a phone is smoother: the character stops drawing (and drops its shadow)
  while the message box has focus, the glass buttons stop blurring over it, the box stays at
  16px so Android no longer zooms on focus, the Thai line-break rule is set at load, and
  messages far off screen are only laid out when they scroll into view.

## 0.7.6-prototype - 2026-10-30

- Sounds: every app sound plays at 30 % volume. On Android the three chat sounds are bundled
  in the app and loaded once, so they start at once instead of being fetched per tap; on the
  web they are fetched at load and decoded on the first gesture.
- Reasoning effort / temperature / top_p belong to the model preset only; the per-agent
  `effort` field is gone (old agent files with it still load) and the presets' parameters now
  also reach summaries and attachment reading.
- Audio transcription: models that put the transcript in the reasoning channel (MiMo v2.6
  Flash via OpenAI-compatible gateways) no longer give an empty transcript.
- A sent message no longer disappears when its stored echo arrives (it was wrongly kept
  marked as pending).

## 0.7.5-prototype - 2026-10-30

- Mail: besides Gmail / Outlook, any IMAP or POP3 mailbox can be watched, with optional SMTP
  sending; passwords are typed in Hub → Mail but kept only in the machine's vault.
- Workflows: custom nodes (defined from files) appear in the editor; trigger pool, sandbox
  and runner updates.
- Notifications remember which agent raised them, so Settings can mute chosen agents.
- The app's time zone is a setting that takes effect on the next message, no restart.
- Desktop: a built-in browser window with its own profile, driven by the PC agent.
- Android: notification icon and push-service / widget fixes.

## 0.7.4-prototype - 2026-10-30

- The header and the chat list say "กำลังตอบ…" (was "กำลังพิมพ์…") while an agent answers.
- Voice messages: the transcript is written in the language of the app (Thai or
  English) instead of whatever the model guesses (it had answered in Chinese), and
  while a recording is being turned into text the header and chat list show
  "กำลังถอดเสียง…".
- The night scene (moon and stars) behind the one-to-one chat is gone: a plain
  background until backdrops come back.
- Typing Thai on a phone: the message box no longer lays its whole text out again
  on every key (it measures its height after a pause), breaks Thai lines without the
  browser's word dictionary, and the 3D character holds still for a moment after each key.
- Switching chats and coming back from the background is lighter: a chat opens with
  its newest 40 messages ("ดูข้อความก่อนหน้า" loads more), and the catch-up after the
  app wakes only adds what is new.
- Android: the widget is dark and headed "ข้อความที่ยังไม่ได้อ่าน" with the total of
  unread replies. A small foreground service (silent status-bar entry "รอข้อความใหม่จาก
  agent") asks the server every 30 seconds, so a reply arrives as a notification with
  its text even while the app is folded away.
- The mail-watch screen script (feature-mail.js) is served again (it returned 404).
- Sounds: chat_1 when you send, chat_2 when an agent finishes answering, chat_3 when
  an agent asks for permission (same on/off switch and quiet hours as before).

## 0.7.3-prototype - 2026-10-30

- Auto-update works again: the apps look at GitHub's "latest release", which skips
  pre-releases, and v0.7.1 / v0.7.2 had been published as pre-releases. Tags like
  `v0.7.3-prototype` are now normal releases (only `-rc` / `-beta` are held back).
- Sessions roll over by length too: once a conversation passes `session.max_tokens`
  (default 200 000, 0 = off) the next message opens a new session with the old
  one summarized, besides the silence rule. Both numbers are editable in
  Settings → แอปและระบบ → Session อัตโนมัติ.
- Context meter from the first design: a percentage at the top of the chat and a
  "Context ของ session" panel in the chat settings (tokens used / window,
  cache hit, cost of the session, summary threshold, session-length limit).
- Storage is split: chat media (removed after 7 days) and the user's own media
  (agent pictures, backdrops, outfits, gallery, VRM; kept until deleted), each
  with its own quota.
- Google / Microsoft accounts and the search / weather keys live only in
  Hub → บัญชี; the duplicate forms in Settings are gone.
- A voice recording with no sound is read as "(no speech)" without a model call,
  and a model that answers a transcription with nothing is asked once more.
- Typing on a phone: no blur behind the message box, and the character redraws at
  ~15 fps while a text field has focus. The chat-settings card scrolls as a whole.

## 0.7.2-prototype - 2026-10-29

- Each picture in a batch can carry its own caption ("คำบรรยายรูปนี้"): it shows
  over the picture in the chat and reaches the model with the file, apart from
  the AI's description (database schema 19, upload header `X-Mimi-Caption`).
- Staged files are uploaded when the message is sent, so captions can be
  written first.
- Smoother typing: the chat box redraws once per frame instead of on every key.
- The language buttons are only in Settings, no longer repeated in each chat's
  settings.
- Android: a reply now posts a notification with its text even when the WebView
  still reports itself visible; the fallback body is "มีข้อความใหม่".
- The chat list marks unread replies with "ใหม่" (and so does the home-screen
  widget, from the same read state); opening a chat clears the mark everywhere.
- The header says which agent is typing, and names the agent taking over on a
  handoff or when one agent delegates part of a turn to another; on a phone with
  the character on, a floating chip shows the same.
- Staged pictures have a clear per-picture caption box, and videos can carry a
  caption too.
- Settings and the other pages scroll properly on phones (dynamic viewport,
  safe areas, and the keyboard resizing the page).

## 0.7.1-prototype - 2026-10-29

- "Push mail": watches the connected Google and Microsoft accounts and any IMAP /
  POP3 mailbox for new unread mail and raises a notification for each.
- Subscription ("รายเดือน") logins for providers, as an alternative to an API key.
- Export tools: files such as PDF are made by the agent (a Thai font ships with the app).
- PC agent: a screen tool.
- Conversations remember when they were last read, so new ones are marked "ใหม่"
  (database schema 18).
- Android app: sync and widget fixes.

## 0.7.0-prototype - 2026-10-29

- Chat sounds: a short "pop" when a message goes out and two notes when the
  agent finishes its reply (made in code, per device; Settings has a switch and
  buttons to hear them; quiet hours mute them).
- Screen settings follow the user to every device: character position (per
  mobile / desktop layout), chat over the character, the character on/off,
  chat and notification sounds, read-aloud and language are kept on the
  server (`ui` in app-settings.json) and sent to the other open devices at
  once; the first device to connect hands up what it had.
- Character position has no limit: the sliders reach further (zoom 0.1-10×,
  ±300 %) and a number box beside each takes any value.
- Android app: its own WebView instead of a Chrome Trusted Web Activity, so the
  microphone and camera are the app's permissions (asked at the first start and
  when the page needs them; the camera button opens the camera app). Files the
  page saves go to Download. Web Push does not reach a WebView: the app checks
  for new replies about every 15 minutes and notifies instead.
- Android home-screen widget "แชต Mimi": the newest chats with picture, name,
  time, last message and a badge of unseen replies; a row opens its chat. The
  server answers it at `GET /api/widget?since=<iso>` (Bearer token).

### Fixes

- OAuth like n8n's credential form. Microsoft accounts take a client secret
  (an Azure app under the "Web" platform, such as one made for n8n); it goes
  with the code exchange and every refresh, never into the browser link. The
  account form and OAuth2 connections show the OAuth Redirect URL to register
  (with a copy button), the Authorization and Access Token URLs, and, for
  connections, editable endpoints and scopes per connection (https only; the
  token URL still goes through the net guard). "บันทึกและเชื่อมต่อ OAuth2"
  saves and opens the sign-in in one step. Settings take
  `MICROSOFT_CLIENT_SECRET`.
- Windows desktop app: the sign-in is remembered until sign-out. Emptying
  Chromium's folder at start also removed "Local State", which holds the key
  that seals `session.bin` on Windows, so every start asked again.
- The sign-in page of a one-person core asks for a password (the core's
  `MIMI_TOKEN`) instead of a "token"; settings say "ออกจากระบบ".
- Windows: `npm run build:win` also makes `Mimi-<version>-win-x64-setup.exe`, a
  per-user NSIS installer (Start menu + Desktop shortcuts, uninstall entry).

- A base URL (`api`) set for a provider in the settings file now replaces
  per-model endpoints the models.dev catalog pinned, so a gateway change takes
  effect everywhere; a per-model `provider.api` in the settings file still wins
  over the provider-level one.
- Read tools (`read_file`, `list_dir`, `file_info`, `find_files`) reword ENOENT/
  ENOTDIR errors to show the resolved path and the working folder, so agents
  (especially sub-agents) no longer retry with doubled relative paths.
- Startup now reports reminders/memory restored from the `triggers/` and
  `memory/` mirrors into a database that did not have them, instead of silently
  reviving state after a database loss or on a fresh install from a synced
  folder.

### Connector platform

- 50 native connectors (214 operations) with Quick Work families, connection
  and OAuth account resolution, poll/webhook triggers, pagination, rate limits,
  retries and version pinning.
- One generic `connector` workflow node; n8n, Make and Zapier imports become
  disabled workflows with native connector nodes, unsupported-step
  placeholders, redacted credentials and a report. OpenAPI import produces a
  draft and report only (no persistence/registration yet).
- Connector versioning: latest semver is used by default, workflow nodes can
  pin a version, and deprecated versions are reported in the run trace.

### Reliability and observability

- Workflow run queue with global/per-agent/per-workflow limits, cancellation,
  optional node/run timeouts, webhook deduplication and persisted idempotency.
- Run history keeps the newest 50 runs per workflow with capped node input/
  output, attempts, connector traces, error codes and redaction on write/read.

### Security

- Guarded outbound HTTP for connector runtime, workflow HTTP/poll, OAuth token
  endpoints and custom tools: private/link-local/metadata destinations are
  refused, redirects are re-checked, and credential headers are stripped on
  cross-origin redirects.
- Custom HTTP tools need an explicit local-network opt-in; concurrent OAuth
  refreshes share one request. Residual risks are documented in
  `docs/connectors/security-review.md`.

### Tests and docs

- E2E coverage for connector workflows, error workflows and imported workflows;
  performance/stress coverage for 50 connectors, 1,000 items and queue/rate
  limits. The runner caps executions at 1,000 nodes and now fails explicitly
  instead of silently truncating a long or cyclic workflow.
- Connector authoring, release checklist and performance docs added under
  `docs/connectors/`; full suite 528 tests passing.

## 0.5.0 — 2026-10-20

- **Native app.** The window is Electron (`packages/desktop`) instead of an Edge `--app` window: closing it hides it (nothing resets; the chat, scroll and recording state stay), it can be resized and maximized, remembers its size and place, has no browser menu, zoom or page context menu (right-click only on text), and lives in the tray (open chat / Agent / Hub / settings, hide when clicking elsewhere, always on top, quit). The core still runs as its own Node process (so better-sqlite3 needs no Electron rebuild, and Docker/VPS keeps working); the launcher and the window talk over node IPC. Without Electron installed the app opens in the default browser. `tray.ps1` and all the Edge code are gone.
- **Mobile first.** The app is designed for mobile mode - a window up to 820px wide, one pane at a time; the native window opens at 410x820. Agent, Hub and Settings now open inside the same window (before, they opened a second desktop-sized window); every Hub tab was checked at phone width and the screens that spilled out (model pool, tool list) were fixed. Wider windows are desktop mode (chat list beside the chat). `?ui=compact` and the `.compact` styles are gone: one rule, the width of the window.
- Text in more than one language: `i18n.js` with Thai and English (`t('key')`), the language is switched in Chat setting. The chat actions, the voice button, Chat setting and the character placement use it; the older screens are being moved over (see docs/tech-review.md).
- The mic code moved out of app.js into `feature-voice.js`; the app looks like an app (no text selection outside messages, thin scrollbars, default cursor, no image dragging).
- Review of the stack, the engine and what to split next: `docs/tech-review.md`.
- The window sizes: the native window defaults to mobile size (410x820) and is free to resize; crossing 820px switches to desktop mode by itself. The right-hand info panel stays closed until opened (it opens by itself only from 1480px) and the choice is remembered.
- The character stage (night scene, the figure in the middle, newest messages over the lower half) now works in desktop mode too; before, the desktop chat laid the bubbles over the figure. A button in the chat header (🧍 in mobile mode) switches the character off for the plain chat (names and times visible, no backdrop); each mode remembers its own choice.
- Mobile mode with the character on is a clean screen: the character and the newest messages, glass (blurred, see-through) buttons - ≡ (chat list) and "Chat setting" at the top; talk, attach and the message box with send / stop inside it at the bottom. "Chat setting" unfolds the settings as a card under the button and folds back with "ย่อ", by tapping the chat, or with Esc; the things the clean screen leaves out (character on/off, search, new session, "แสดง prompt") are in it. The same panel, when it floats over the chat in a narrow desktop window (up to 1180px), now has the "ย่อ" button too - before, it covered the button that opened it and could not be closed.
- Chat setting got three things. **Where the character stands**: with a 3D model the camera - turn (-180° to 180°), tilt, zoom, slide left/right and up/down; with a 2D picture only size and slide; "รีเซ็ตตำแหน่ง" puts it back. Remembered per agent, per kind and per mode, and the panel fades while a slider is held so the character shows behind it. **Message level** (direct chats with the character on): 0 no chat bubbles, 1 only the newest message, 2 all of them (the usual); a pending permission card always shows. **The button itself** is an icon (sliders) in the clean mobile screen and turns into a back arrow while the panel is open.
- The mic button in mobile mode: **press and hold** to talk (the button grows and glows, rings spread from it, the bar beside it shows the time and a waveform that follows your voice); **release** sends the voice message at once; **slide left or up** and the bar turns red ("ปล่อยเพื่อยกเลิก") - releasing there cancels. A **quick tap** talks hands-free: tap the mic again to stop (the clip waits in the box), ✕ or Esc cancels. A hold shorter than 0.7 s is treated as a slip and dropped.
- The attach button with a finger: a **tap opens the camera**, a **long press** opens the list (camera, picture, file, sound, video). With a mouse a click opens the list as before.
- Every message shows its time under the bubble (also in the character stage and for the reply that is still streaming in).
- Message buttons: love, other reactions, reply, forward, copy and pin appear when the pointer is on a message (tap on touch screens); the same actions are in the context menu. Pinned messages are listed in a bar under the chat header (click to jump, "ทั้งหมด" to see them all). Marks are stored in the message log (schema v15) and shared by every client.
- The stop button takes the place of mic / send while a reply is coming (and Esc stops it when the box is empty). A finished reply is reloaded from the log so its bubbles can be pinned, reacted to and replied to right away.
- Providers: the model list is only fetched, never typed. The form lost the model box; editing a provider shows what was fetched, and a new URL or key fetches again.
- Placeholder "ทัก<name>…" in every direct chat.
- The portable macOS app: `npm run build:mac` writes `dist/mac/Mimi.app` (Node runtime and production dependencies inside) and `dist/Mimi-<version>-mac-<arch>.zip`. On an Intel Mac this is an x64 build.
- Model pickers follow the input: the agent editor and Settings group models by what they read (text, image/PDF/video, audio), background work (summary/memory) and what they make (image, speech, video), and each list offers only models whose models.dev type and modalities fit (an embedding model is not offered as a chat or vision model). A model without metadata stays offered, and saving a model the catalog says cannot do the job is refused.

## 0.4.0 — 2026-10-20

- User data moved out of the app: everything the user owns now lives in `Documents/Mimi` (backups in `Documents/Mimi/backups`). The desktop app moves an old `<app>/user` folder there on its next start, while nothing runs. The browser profiles of the app windows go to `%LOCALAPPDATA%/Mimi` instead (machine-local caches). `MIMI_USER` still picks any folder; `MIMI_ROOT` (servers, tests) keeps `<root>/user`.
- Tray window looks like the approved mobile design (`design/screens/11-mobile-direct.png`): character stage with a default night scene, status chips, light/dark bubbles over the figure, older messages fading out above the face, a "แสดง prompt" switch that shows tool calls, camera button, round mic/send button, "ทัก<name>…" placeholder. It opens straight into the last chat or the main agent's chat.
- The tray window behaves like a tray panel: in the corner above the taskbar, above other windows, not on the taskbar, hides when it loses focus, the tray icon toggles it.
- No translate / sign-in prompts in the app windows.
- The figure on the stage retries when its picture failed to load.
- VRoid on the chat stage: an agent set to "โมเดล 3D (VRM)" is drawn live in the chat (relaxed standing pose instead of the T-pose, breathing, blinking, eyes on the viewer, spring bones, the mood of the last emoji as an expression, the mouth moving while a reply streams in).
- Outfits can carry their own `.vrm` (Hub → ตู้เสื้อผ้า): when the agent's "ชุด" status is that outfit, the stage swaps to its model with a short fade. Agents with `status_set` change clothes themselves.
- The agent editor's 3D preview faces the camera (it showed the model's back) and shows the expression buttons once the model has loaded.

## 0.3.0 — 2026-10-19

- Tray app (Windows): `npm run app` / the Mimi shortcut puts an icon in the notification area. A click pops up a phone-sized chat window above the taskbar; Agent, Hub and Settings open in a normal desktop-sized window (also from the tray menu). `MIMI_TRAY=0` keeps the old single window. While no window is on screen, notifications show as Windows notifications from the tray icon.
- Notifications for other chats: each client tells the core which chat it shows; an agent reply or workflow message in a chat nobody is looking at becomes a "message" notification (inbox, toast that opens the chat, push).
- New agent tool `notify_user`: an agent posts in its own chat with the user and raises a notification, also from delegated or scheduled work.
- `web_search` and `map_search` work without a Serper key (DuckDuckGo and OpenStreetMap as fallbacks).
- Memory writer accepts the tool-call variations of small models instead of dropping the fact.
- A scheduled agent task that already notified the user does not raise a second notification.
- Group chats: agents are told to talk to members in the chat, not through send_to.
- Model ids typed into a provider's list by hand are known models even when the catalog has no entry for them.
- A model that ends its turn with an empty answer is asked once more instead of leaving a blank reply.

## 0.2.0 — 2026-10-19

- VRoid / VRM characters: upload a `.vrm` per agent, preview it in the agent editor, Mixamo `.fbx` motions retargeted to the VRM rig, expressions and a lip-sync test (three.js + @pixiv/three-vrm, served locally from `node_modules`).
- Version number shown in Settings and returned by `/health`.

## 0.1.0

- Core, web client, workflow engine, memory, scheduler, PC agent, media in/out, wardrobe, sprites, backgrounds, gallery, machine control, browser control, MCP.
