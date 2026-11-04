# Android: what is left, measured against the Windows app (2026-11-04)

Method: `feature-inventory.md` (rows 1–56) against `apps/windows/src` and `android/`; every WebSocket command the web sends (112) and every
`/api/*` path it calls was searched for in the C# code. Windows covers all of them except Web Push (`push-key`, `push-subscribe`), which native apps
replace with FCM / WNS on purpose.

## Windows: complete in code, but not verified

| Item | State |
|---|---|
| Rows 1–17, 20–21, 24–27, 28–31, 32–56 | Implemented (generic Hub / manage pages for 32–54, 55–56 canvas) |
| #18 push | WNS written (round 7), **never tried against real WNS** (needs an Entra ID app) |
| #19 widget | **Not possible** as shipped (needs package identity + signing, Q9) |
| XAML | Not compiled on this Mac: only the C# is type-checked (`mac-typecheck`). **Build and run on Windows before release** |
| UI parity with the web (round 8) | Bubbles, status text, solo fade/composer, voice-recording hint edited from CSS, unseen on Windows. Desktop mode (window wider than 820 px) is not modelled |
| VRM | Never tried with a real .vrm / .fbx |
| Voice recording | Written, never tried; no hold-to-record / slide-to-cancel / `#rec-bar` |
| Typing chip (`.typing-chip`) | Not done (status line only) |
| Tests | `Mimi.Core.Tests` 81/85 on Mac (4 tied to Windows paths / DPAPI fail as before) |

## Android today

Done and run against a real core on an emulator: 1 (token), 2, 3, 4 (streaming), 5, 29, deep link to a chat (27) and the direct-chat look of the web.
Code present but **never run**: 6 attach, 7 viewer, 8 voice, 9 permission card, 11 approval, 18 FCM / poll, 19 widget, gateway login + 2FA, group chat.
`android/core/data` was rewritten from scratch (it was lost); it has no Room cache / Retrofit as the old README described.

## Android to do, in the order the inventory proposes (phase A first)

Phase A (replace the old app):
- [x] 10 task cards (2026-11-04: model + reducer + card UI with pause/resume/cancel/undo). **Tried on an emulator with a real core, a real PC agent and the real `file-organizer` recipe**: card with steps, the confirmation (permission card), receipt, undo restored the files. Pause / resume / cancel not tried (the recipe finished in <1 s). `task-kill` not wired
- [x] 12 reply / copy / react / pin + pin bar (2026-11-04, tried on an emulator against a real core). **Forward not done**; pin bar does not scroll to the message yet
- [x] 13 rewind (2026-11-04: long press on your message → "ย้อนกลับมาตรงนี้" → confirm; the text returns to the composer, the chat reloads without the taken-back messages; tried on an emulator). Files a task moved are restored by the core; not tried here with a task after the rewound message
- [x] 14 sessions list, new session, context meter (2026-11-04, in the chat setting sheet; tried on an emulator against a real core). Not done: the meter in the header (web shows it beside the title)
- [x] 15 search (2026-11-04: search box on the list → results screen with highlight, open at the hit's session and scroll to the message; tried on an emulator). Scroll-to-message only if the message is within the pages loaded (it asks for older pages)
- [ ] 16 create / edit group chats + members rail · 17 notification inbox + toast
- [ ] 20 read aloud (TTS) · 21 sounds · 28 `security-alert` banner (frame already delivered by `MimiSocket`)
- [x] 24 character stage + 26 chat setting (2026-11-04): picture by the newest emoji (sprite → portrait → any sprite → avatar), background presets, text size, bubbles over the character, size / position sliders, fade-top; settings are **shared with the account's other devices** (`ui-set` / `welcome.ui` / `ui`, the web's own keys `mimi.chat.<id>.*` and `mimi.view.mobile.<agent>.2d`; tried both ways against a real core). Tried with a portrait only: **sprites per emoji, a real character, outfits and VRM never seen**. Missing: per-chat light/dark theme (key `.theme`), uploaded backgrounds (solid / gradient are shown, never written), the device defaults' own screen (`mimi.textSize`, `mimi.bubbles.mobile`...), time-based background rules, gallery overlay (#25)
- [ ] 30 setup wizard · 31 Overseer · 8 voice recording polish (hold / cancel)
- [ ] Run the never-run items above on a device, add tests for `FileRepository` and `directChat`

Phase B: 32–41 settings, profile, backup, CSV export, 2FA / password, push devices, always-allow grants, memory ·
42, 44–54 agent editor, presets, skills, nodes / tools, triggers, accounts, secrets, knowledge, wardrobe, backgrounds, packs.
Phase C: 43 VRM, 55–56 workflows + canvas, 47 tools editor.

Release blockers for Android: signing with the original keystore (otherwise it cannot install over the WebView app), Firebase ids for FCM,
`versionName` (the update checker skips `0.0.0`).
