# Changelog

## 0.4.0 — 2026-10-20

- User data moved out of the app: everything the user owns now lives in `Documents/Mimi` (backups in `Documents/Mimi/backups`). The desktop app moves an old `<app>/user` folder there on its next start, while nothing runs. The browser profiles of the app windows go to `%LOCALAPPDATA%/Mimi` instead (machine-local caches). `MIMI_USER` still picks any folder; `MIMI_ROOT` (servers, tests) keeps `<root>/user`.
- Tray window looks like the approved mobile design (`design/screens/11-mobile-direct.png`): character stage with a default night scene, status chips, light/dark bubbles over the figure, older messages fading out above the face, a "แสดง prompt" switch that shows tool calls, camera button, round mic/send button, "ทัก<name>…" placeholder. It opens straight into the last chat or the main agent's chat.
- The tray window behaves like a tray panel: in the corner above the taskbar, above other windows, not on the taskbar, hides when it loses focus, the tray icon toggles it.
- No translate / sign-in prompts in the app windows.
- The figure on the stage retries when its picture failed to load.

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
