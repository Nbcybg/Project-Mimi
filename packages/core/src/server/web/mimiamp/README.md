# Mimiamp music

Songs for the Mimiamp screen. The app scans this folder (and only this folder) and serves
anything it can play; an optional `tracks.json` supplies titles, artists and durations.

- Supported: `.mp3`, `.m4a`, `.aac`, `.ogg`, `.oga`, `.opus`, `.wav`, `.flac`, `.webm`
- Files not listed in `tracks.json` still appear, titled from their file name.
- Replace this README or add as many files as you like; no code change is needed.
- Set `MIMI_MUSIC_DIR=/some/folder` to keep the library outside the app instead.

`tracks.json` is either an array or `{ "tracks": [...] }`:

```json
{
  "tracks": [
    { "file": "night-drive-demo.wav", "title": "Night Drive", "artist": "Mimi", "duration": 24 }
  ]
}
```

`duration` is optional (seconds); the player learns it when the song first plays.
