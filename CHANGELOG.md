# Changelog

## Unreleased

### 0.7.5-prototype

- Mail: besides Gmail / Outlook, any IMAP or POP3 mailbox can be watched, with optional SMTP
  sending; passwords are typed in Hub → Mail but kept only in the machine's vault.
- Workflows: custom nodes (defined from files) appear in the editor; trigger pool, sandbox
  and runner updates.
- Notifications remember which agent raised them, so Settings can mute chosen agents.
- The app's time zone is a setting that takes effect on the next message, no restart.
- Desktop: a built-in browser window with its own profile, driven by the PC agent.
- Android: notification icon and push-service / widget fixes.

### 0.7.4-prototype

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

### 0.7.3-prototype

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

### 0.7.2-prototype

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

### 0.7.1-prototype

- "Push mail": watches the connected Google and Microsoft accounts and any IMAP /
  POP3 mailbox for new unread mail and raises a notification for each.
- Subscription ("รายเดือน") logins for providers, as an alternative to an API key.
- Export tools: files such as PDF are made by the agent (a Thai font ships with the app).
- PC agent: a screen tool.
- Conversations remember when they were last read, so new ones are marked "ใหม่"
  (database schema 18).
- Android app: sync and widget fixes.

### 0.7.0-prototype

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
