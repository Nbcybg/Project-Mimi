# Changelog

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
