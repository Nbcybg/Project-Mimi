# Mimiamp music (this project)

Put audio files here to use them as Mimiamp's library from the sources, Docker, or a
deployment built from this folder. The app reads this folder before the built-in demo in
`packages/core/src/server/web/mimiamp/`.

- Supported: `.mp3`, `.m4a`, `.aac`, `.ogg`, `.oga`, `.opus`, `.wav`, `.flac`, `.webm`
- `tracks.json` gives display titles, artists and durations; files it does not list still
  appear, titled from their file name.
- On a server, mount a folder and set `MIMI_MUSIC_DIR` (or put the songs in
  `<user>/mimiamp`, which is read automatically).
- Large audio files are not committed to Git by default; keep them on the machine or
  server volume where Mimi runs.
