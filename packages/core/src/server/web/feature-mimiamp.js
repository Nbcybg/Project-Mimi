// Mimiamp — a Winamp-looking background player. The songs are the developer's, in
// server/web/mimiamp/ (or MIMI_MUSIC_DIR); this screen lists them and keeps one <audio>
// element alive outside the page, so music keeps playing while the user visits other screens.
// An agent can drive it through the `mimiamp` tool: the core broadcasts a `mimiamp` message.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);

  const VOLUME_KEY = 'mimi.mimiamp.volume';
  const TRACK_KEY = 'mimi.mimiamp.track';
  const REPEAT_KEY = 'mimi.mimiamp.repeat';
  const SHUFFLE_KEY = 'mimi.mimiamp.shuffle';
  const PIP_POS_KEY = 'mimi.mimiamp.pip';

  const readNumber = (key, fallback, min, max) => {
    const value = Number(M().store.get(key));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const readRepeat = () => {
    const value = M().store.get(REPEAT_KEY);
    return value === 'all' || value === 'one' ? value : 'off';
  };
  const readPipPosition = () => {
    try {
      const saved = JSON.parse(M().store.get(PIP_POS_KEY) || 'null');
      return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
    } catch {
      return null;
    }
  };
  const savePipPosition = (x, y) => {
    try {
      M().store.set(PIP_POS_KEY, JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
    } catch {
      // private window: the spot lasts until reload
    }
  };

  let tracks = [];
  let index = -1;
  let loadState = 'idle'; // idle | loading | ready | error
  let loadError = '';
  let loading = null;
  let repeat = readRepeat();
  let shuffle = M().store.get(SHUFFLE_KEY) === '1';
  let volume = readNumber(VOLUME_KEY, 70, 0, 100);
  let openView = Boolean(M().state && M().state.view === 'mimiamp');
  let built = false;
  let draggingSeek = false;
  let statusText = 'STOPPED';

  let audio = null;
  let audioCtx = null;
  let analyser = null;
  let visData = null;
  let visRaf = 0;
  let lastVis = 0;
  let pseudo = 0;
  let pip = null;
  let pipUi = null;
  let pipRequested = false;
  let pipDraggingSeek = false;
  let pipDrag = null;
  let ui = null;

  const fmt = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const whole = Math.floor(seconds);
    const mins = Math.floor(whole / 60);
    const secs = whole % 60;
    if (mins >= 60) return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };
  const currentTrack = () => tracks[index] || null;
  const trackLabel = (track) => (track ? `${track.title}${track.artist ? ` — ${track.artist}` : ''}` : 'MIMIAMP — ยังไม่มีเพลง');

  function setStatus(text) {
    statusText = text;
    if (ui && ui.state) ui.state.textContent = text;
  }

  // ---------- the audio element (lives outside every screen) ----------
  function ensureAudio() {
    if (audio) return audio;
    audio = new Audio();
    audio.preload = 'metadata';
    audio.volume = volume / 100;
    audio.addEventListener('play', () => {
      setStatus('PLAYING');
      paintState();
      paintPip();
      startVis();
    });
    audio.addEventListener('pause', () => {
      if (audio.ended) return;
      setStatus('PAUSED');
      paintState();
      paintPip();
      drawVisualizer();
    });
    audio.addEventListener('timeupdate', () => {
      if (!draggingSeek) paintTime();
    });
    audio.addEventListener('durationchange', () => {
      const track = currentTrack();
      if (track && Number.isFinite(audio.duration) && audio.duration > 0) {
        const rounded = Math.round(audio.duration);
        if (track.duration !== rounded) {
          track.duration = rounded;
          renderLibrary();
        }
      }
      paintTime();
    });
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', () => {
      if (!audio || !audio.getAttribute('src')) return;
      setStatus('ERROR');
      paintState();
      paintPip();
      M().toast('Mimiamp', 'เล่นไฟล์นี้ไม่ได้ — ตรวจว่าไฟล์ยังอยู่ในโฟลเดอร์เพลง', true);
    });
    if ('mediaSession' in navigator) {
      const session = navigator.mediaSession;
      const set = (action, handler) => {
        try {
          session.setActionHandler(action, handler);
        } catch {
          // older browsers know fewer actions
        }
      };
      set('play', () => audio && audio.play().catch(() => {}));
      set('pause', () => audio && audio.pause());
      set('nexttrack', () => next());
      set('previoustrack', () => previous());
      set('seekto', (details) => {
        if (details && details.seekTime !== null && details.seekTime !== undefined) seek(details.seekTime);
      });
    }
    return audio;
  }

  // The spectrum needs an AudioContext, which browsers only allow after a gesture.
  function ensureGraph() {
    if (audioCtx || !audio) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try {
      audioCtx = new Ctor();
      const source = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.76;
      source.connect(analyser);
      analyser.connect(audioCtx.destination);
      visData = new Uint8Array(analyser.frequencyBinCount);
    } catch {
      audioCtx = null;
      analyser = null;
      visData = null;
    }
  }
  const resumeGraph = () => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  };
  document.addEventListener('pointerdown', resumeGraph, { passive: true });
  document.addEventListener('keydown', resumeGraph);

  function updateMediaSession(track) {
    if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function' || !track) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: track.title,
        artist: track.artist || 'Mimiamp',
        album: track.album || 'Mimi',
      });
    } catch {
      // metadata is a nicety
    }
  }

  // ---------- the library ----------
  function loadLibrary(force) {
    if (loading) return loading;
    loadState = 'loading';
    loadError = '';
    renderLibrary();
    loading = fetch('/mimiamp/tracks.json', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        tracks = Array.isArray(data && data.tracks)
          ? data.tracks.filter((track) => track && typeof track.url === 'string' && typeof track.file === 'string' && track.title)
          : [];
        loadState = 'ready';
        const playingFile = audio && audio.dataset.file;
        if (playingFile) {
          const current = tracks.findIndex((track) => track.file === playingFile);
          index = current;
        }
        if (index < 0) {
          const saved = M().store.get(TRACK_KEY);
          index = saved ? tracks.findIndex((track) => track.file === saved) : -1;
        }
        if (index < 0 && tracks.length) index = 0;
        renderLibrary();
        paintState();
        paintTime();
        paintPip();
      })
      .catch((error) => {
        loadState = 'error';
        loadError = error && error.message ? error.message : 'โหลดรายการเพลงไม่ได้';
        renderLibrary();
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  function matchIndex(query) {
    const wanted = String(query || '').trim().toLowerCase();
    if (!wanted) return -1;
    const exact = tracks.findIndex((track) => String(track.file).toLowerCase() === wanted);
    if (exact >= 0) return exact;
    return tracks.findIndex((track) => {
      const fields = [track.title, track.artist, track.album, track.file].filter(Boolean).map((value) => String(value).toLowerCase());
      return fields.some((value) => value.includes(wanted));
    });
  }

  // ---------- playback ----------
  let playToken = 0;
  async function playAt(nextIndex, options) {
    if (!tracks.length) {
      await loadLibrary();
      if (!tracks.length) {
        M().toast('Mimiamp', 'ยังไม่มีเพลง — ให้นักพัฒนาวางไฟล์เสียงใน server/web/mimiamp/', true);
        return;
      }
    }
    const wanted = Number(nextIndex);
    const track = tracks[Number.isInteger(wanted) ? Math.min(tracks.length - 1, Math.max(0, wanted)) : index < 0 ? 0 : index];
    if (!track) return;
    index = tracks.indexOf(track);
    M().store.set(TRACK_KEY, track.file);
    const element = ensureAudio();
    ensureGraph();
    resumeGraph();
    const same = element.dataset.file === track.file && element.getAttribute('src');
    if (!same || (options && options.restart)) {
      element.dataset.file = track.file;
      element.src = track.url;
      element.load();
    }
    updateMediaSession(track);
    paintState();
    const token = ++playToken;
    try {
      await element.play();
      if (token !== playToken) return;
      setStatus('PLAYING');
    } catch (error) {
      if (token !== playToken) return;
      if (error && error.name === 'AbortError') return;
      setStatus(error && error.name === 'NotAllowedError' ? 'READY' : 'ERROR');
      if (error && error.name === 'NotAllowedError') {
        M().toast('Mimiamp', 'เบราว์เซอร์บล็อกเสียงอัตโนมัติ — กด ▶ เพื่อเริ่มเพลง', false, () => playAt(index));
      } else if (error && error.name !== 'AbortError') {
        M().toast('Mimiamp', `เล่นเพลงไม่ได้: ${error.message || error}`, true);
      }
    }
    renderLibrary();
    paintState();
    paintTime();
    paintPip();
  }

  function pause() {
    if (!audio || !audio.dataset.file) return;
    audio.pause();
    setStatus('PAUSED');
    paintState();
    paintPip();
  }

  function stop() {
    playToken++;
    pipRequested = false;
    if (audio) {
      audio.pause();
      delete audio.dataset.file;
      audio.removeAttribute('src');
      audio.load();
    }
    setStatus('STOPPED');
    paintState();
    paintTime();
    paintPip();
    drawVisualizer();
  }

  function togglePlay() {
    if (!audio || !audio.dataset.file || audio.ended) {
      playAt(index >= 0 ? index : 0, audio && audio.ended ? { restart: true } : undefined);
      return;
    }
    if (audio.paused) playAt(index);
    else pause();
  }

  function next(manual) {
    if (!tracks.length) return playAt(0);
    if (shuffle && tracks.length > 1) {
      let pick = index;
      for (let tries = 0; pick === index && tries < 20; tries++) pick = Math.floor(Math.random() * tracks.length);
      return playAt(pick, { restart: true });
    }
    const following = index + 1;
    if (following < tracks.length) return playAt(following, { restart: true });
    if (manual || repeat === 'all') return playAt(0, { restart: true });
    setStatus('END');
    paintState();
    paintPip();
  }

  function previous() {
    if (!tracks.length) return playAt(0);
    if (audio && audio.currentTime > 3) {
      seek(0);
      return;
    }
    if (shuffle && tracks.length > 1) return next(true);
    const before = index - 1;
    return playAt(before >= 0 ? before : tracks.length - 1, { restart: true });
  }

  function onEnded() {
    if (repeat === 'one') {
      if (!audio) return;
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    if (shuffle || index + 1 < tracks.length || repeat === 'all') next(false);
    else {
      setStatus('END');
      paintState();
      paintTime();
      paintPip();
    }
  }

  function setVolume(level, remember) {
    volume = Math.min(100, Math.max(0, Math.round(Number(level))));
    if (!Number.isFinite(volume)) volume = 70;
    if (audio) audio.volume = volume / 100;
    if (ui && ui.volume) ui.volume.value = String(volume);
    if (remember !== false) M().store.set(VOLUME_KEY, String(volume));
  }

  function seek(seconds) {
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.min(audio.duration, Math.max(0, Number(seconds) || 0));
    paintTime();
  }

  function cycleRepeat() {
    repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
    M().store.set(REPEAT_KEY, repeat);
    paintState();
  }

  function toggleShuffle() {
    shuffle = !shuffle;
    M().store.set(SHUFFLE_KEY, shuffle ? '1' : '0');
    paintState();
  }

  // ---------- the screen ----------
  function ampButton(label, title, action, extraClass) {
    const node = el('button', `amp-btn${extraClass ? ` ${extraClass}` : ''}`, label);
    node.type = 'button';
    node.title = title;
    node.setAttribute('aria-label', title);
    node.onclick = () => {
      if (action === 'toggle') togglePlay();
      else if (action === 'previous') previous();
      else if (action === 'play') playAt(index >= 0 ? index : 0);
      else if (action === 'pause') pause();
      else if (action === 'stop') stop();
      else if (action === 'next') next(true);
      else if (action === 'shuffle') toggleShuffle();
      else if (action === 'repeat') cycleRepeat();
      else if (action === 'minimise') {
        pipRequested = true;
        M().setView('chat');
        paintPip();
      } else if (action === 'close') {
        stop();
        M().setView('chat');
      } else if (action === 'open') M().setView('mimiamp');
    };
    return node;
  }

  function build() {
    if (built) return;
    const page = document.getElementById('view-mimiamp');
    if (!page) return;
    built = true;

    const shell = el('div', 'amp-shell');
    const win = el('div', 'amp-win');

    const titlebar = el('div', 'amp-titlebar');
    titlebar.append(
      el('span', 'amp-logo', 'M'),
      el('span', 'amp-title', 'MIMIAMP'),
      el('span', 'amp-title-sub', 'BACKGROUND MUSIC'),
      (() => {
        const buttons = el('span', 'amp-winbtns');
        buttons.append(
          ampButton('–', 'ย่อเป็นหน้าต่างลอย (Picture in Picture)', 'minimise', 'amp-winbtn'),
          ampButton('×', 'หยุดเพลงและปิด', 'close', 'amp-winbtn'),
        );
        return buttons;
      })(),
    );

    const body = el('div', 'amp-body');

    const lcd = el('div', 'amp-lcd');
    const marquee = el('div', 'amp-marquee');
    const mtext = el('span', 'amp-mtext', 'MIMIAMP — กำลังโหลดรายการเพลง…');
    marquee.append(el('span', 'amp-tag', 'PLAY'), mtext);

    const lcdrow = el('div', 'amp-lcdrow');
    const bigTime = el('div', 'amp-time', '00:00');
    const canvas = el('canvas', 'amp-vis');
    canvas.width = 320;
    canvas.height = 42;
    const meta = el('div', 'amp-meta');
    meta.append(el('span', '', 'MIMI'), el('br'), el('span', '', 'MIMIAMP 1.0'));
    lcdrow.append(bigTime, canvas, meta);

    const statusRow = el('div', 'amp-status');
    const state = el('span', 'amp-state', 'STOPPED');
    const listInfo = el('span', '', '0 TRACKS');
    statusRow.append(state, listInfo);
    lcd.append(marquee, lcdrow, statusRow);

    const seekRow = el('div', 'amp-seekrow');
    const elapsed = el('span', '', '0:00');
    const seekBar = el('input', 'amp-seek');
    seekBar.type = 'range';
    seekBar.min = '0';
    seekBar.max = '1000';
    seekBar.step = '1';
    seekBar.value = '0';
    seekBar.title = 'ตำแหน่งในเพลง';
    const total = el('span', '', '--:--');
    seekRow.append(elapsed, seekBar, total);

    const controls = el('div', 'amp-controls');
    const transport = el('div', 'amp-transport');
    const playButton = ampButton('▶', 'เล่น', 'play');
    transport.append(
      ampButton('|◀', 'เพลงก่อนหน้า', 'previous'),
      playButton,
      ampButton('❚❚', 'หยุดชั่วคราว', 'pause'),
      ampButton('■', 'หยุด', 'stop'),
      ampButton('▶|', 'เพลงถัดไป', 'next'),
    );
    const volumeBox = el('div', 'amp-volume');
    const volumeBar = el('input', 'amp-vol');
    volumeBar.type = 'range';
    volumeBar.min = '0';
    volumeBar.max = '100';
    volumeBar.step = '1';
    volumeBar.value = String(volume);
    volumeBar.title = 'ระดับเสียง';
    volumeBox.append(el('span', '', 'VOL'), volumeBar);
    const toggles = el('div', 'amp-toggles');
    const shuffleButton = ampButton('SHUF', 'สุ่มเพลง', 'shuffle', 'wide');
    const repeatButton = ampButton('REP OFF', 'วนซ้ำ: ปิด', 'repeat', 'wide');
    toggles.append(shuffleButton, repeatButton);
    controls.append(transport, volumeBox, toggles);

    const playlist = el('div', 'amp-playlist');
    const plhead = el('div', 'amp-plhead');
    const count = el('span', '', '0 TRACKS');
    plhead.append(el('span', '', 'PLAYLIST'), count);
    const list = el('div', 'amp-tracks');
    playlist.append(plhead, list);

    const foot = el('div', 'amp-foot');
    const refresh = el('button', 'amp-foot-refresh', 'รีเฟรชเพลง');
    refresh.type = 'button';
    refresh.title = 'โหลดรายการเพลงใหม่จากโฟลเดอร์';
    refresh.onclick = () => {
      loadLibrary(true).then(() => M().toast('Mimiamp', 'รีเฟรชรายการเพลงแล้ว'));
    };
    foot.append(refresh, el('span', '', 'SERVER/WEB/MIMIAMP'));

    body.append(lcd, seekRow, controls, playlist, foot);
    win.append(titlebar, body);
    shell.append(win);
    page.replaceChildren(shell);

    ui = {
      mtext,
      bigTime,
      canvas,
      state,
      listInfo,
      elapsed,
      seekBar,
      total,
      playButton,
      volume: volumeBar,
      shuffleButton,
      repeatButton,
      count,
      list,
      refresh,
    };

    seekBar.addEventListener('pointerdown', () => {
      draggingSeek = true;
    });
    const applySeek = () => {
      draggingSeek = false;
      if (audio && Number.isFinite(audio.duration)) seek((Number(seekBar.value) / 1000) * audio.duration);
      else paintTime();
    };
    seekBar.addEventListener('pointerup', applySeek);
    seekBar.addEventListener('pointercancel', applySeek);
    seekBar.addEventListener('change', applySeek);
    seekBar.addEventListener('input', () => {
      if (!audio || !Number.isFinite(audio.duration)) return;
      elapsed.textContent = fmt((Number(seekBar.value) / 1000) * audio.duration);
    });
    volumeBar.addEventListener('input', () => setVolume(volumeBar.value));

    setVolume(volume, false);
    loadLibrary();
    paintState();
    paintTime();
    paintPip();
  }

  function renderLibrary() {
    if (!built || !ui) return;
    const totalTracks = tracks.length;
    ui.count.textContent = `${totalTracks} TRACK${totalTracks === 1 ? '' : 'S'}`;
    ui.listInfo.textContent = loadState === 'loading'
      ? 'LOADING…'
      : loadState === 'error'
        ? 'LIBRARY ERROR'
        : `${totalTracks} TRACK${totalTracks === 1 ? '' : 'S'}${shuffle ? ' · SHUFFLE' : ''}`;
    ui.list.replaceChildren();
    if (loadState === 'loading' && totalTracks === 0) {
      ui.list.append(el('div', 'amp-empty', 'กำลังโหลดรายการเพลง…'));
      return;
    }
    if (loadState === 'error') {
      const empty = el('div', 'amp-empty', `โหลดรายการเพลงไม่ได้ (${loadError})`);
      const retry = el('button', 'amp-btn', 'ลองใหม่');
      retry.type = 'button';
      retry.onclick = () => loadLibrary(true);
      empty.append(el('br'), retry);
      ui.list.append(empty);
      return;
    }
    if (totalTracks === 0) {
      const empty = el('div', 'amp-empty');
      empty.append(
        el('div', '', 'ยังไม่มีเพลงใน Mimiamp'),
        el('div', '', 'นักพัฒนาวางไฟล์เสียง (mp3, ogg, wav, m4a, flac) ไว้ที่'),
        el('code', '', 'packages/core/src/server/web/mimiamp/'),
        el('div', '', 'แล้วกด “รีเฟรชเพลง” หรือวาง URL ไปยังโฟลเดอร์ผ่าน MIMI_MUSIC_DIR'),
      );
      ui.list.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    tracks.forEach((track, position) => {
      const row = el('button', `amp-track${position === index ? ' on' : ''}`);
      row.type = 'button';
      row.title = `เล่น ${trackLabel(track)}`;
      row.append(
        el('span', 'amp-num', String(position + 1).padStart(2, '0')),
        el('span', 'amp-tname', track.title),
        el('span', 'amp-artist', track.artist || '—'),
        el('span', 'amp-dur', track.duration ? fmt(track.duration) : '--:--'),
      );
      row.onclick = () => playAt(position, { restart: position === index ? false : true });
      row.ondblclick = () => playAt(position, { restart: true });
      fragment.append(row);
    });
    ui.list.append(fragment);
  }

  function paintState() {
    if (!built || !ui) return;
    const track = currentTrack();
    const hasSource = Boolean(audio && audio.dataset.file);
    ui.mtext.textContent = track ? trackLabel(track) : 'MIMIAMP — ยังไม่มีเพลง';
    ui.playButton.classList.toggle('on', Boolean(audio && !audio.paused));
    ui.shuffleButton.classList.toggle('on', shuffle);
    const repeatLabel = repeat === 'off' ? 'REP OFF' : repeat === 'one' ? 'REP 1' : 'REP ALL';
    ui.repeatButton.textContent = repeatLabel;
    ui.repeatButton.classList.toggle('on', repeat !== 'off');
    ui.repeatButton.title = repeat === 'off' ? 'วนซ้ำ: ปิด' : repeat === 'one' ? 'วนซ้ำ: เพลงนี้' : 'วนซ้ำ: ทั้งหมด';
    if (!hasSource && statusText === 'PLAYING') statusText = 'STOPPED';
    ui.state.textContent = statusText;
    if (loadState === 'ready') renderLibraryIfNeeded();
  }

  let renderedIndex = -2;
  let renderedShuffle = null;
  function renderLibraryIfNeeded() {
    if (renderedIndex === index && renderedShuffle === shuffle) return;
    renderedIndex = index;
    renderedShuffle = shuffle;
    renderLibrary();
  }

  function paintTime() {
    if (built && ui) {
      const duration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const position = audio ? audio.currentTime || 0 : 0;
      ui.bigTime.textContent = fmt(position);
      ui.elapsed.textContent = fmt(position);
      ui.total.textContent = duration ? fmt(duration) : currentTrack() && currentTrack().duration ? fmt(currentTrack().duration) : '--:--';
      if (!draggingSeek) ui.seekBar.value = duration ? String(Math.round((position / duration) * 1000)) : '0';
    }
    paintPipTime();
  }

  // ---------- the picture-in-picture player on other screens ----------
  function buildPip() {
    if (pip) return;
    pip = el('div', 'amp-pip');
    pip.hidden = true;
    pip.setAttribute('role', 'region');
    pip.setAttribute('aria-label', 'Mimiamp picture-in-picture player');

    const bar = el('div', 'amp-pip-bar');
    const tag = el('span', 'amp-mini-tag', 'AMP');
    const name = el('span', 'amp-pip-name', 'MIMIAMP');
    const expand = el('button', 'amp-pip-btn', '⛶');
    expand.type = 'button';
    expand.title = 'ขยายเต็มหน้าจอ';
    expand.setAttribute('aria-label', 'ขยาย Mimiamp เต็มหน้าจอ');
    expand.onclick = () => M().setView('mimiamp');
    const close = el('button', 'amp-pip-btn', '×');
    close.type = 'button';
    close.title = 'หยุดเพลงและปิด';
    close.setAttribute('aria-label', 'ปิด Mimiamp');
    close.onclick = () => stop();
    bar.append(tag, name, expand, close);

    const body = el('div', 'amp-pip-body');
    const title = el('div', 'amp-pip-title', '');
    title.title = 'ขยาย Mimiamp';
    title.onclick = () => M().setView('mimiamp');

    const seekRow = el('div', 'amp-pip-row');
    const time = el('span', 'amp-pip-time', '0:00');
    const seek = el('input', 'amp-pip-seek');
    seek.type = 'range';
    seek.min = '0';
    seek.max = '1000';
    seek.step = '1';
    seek.value = '0';
    seek.title = 'ตำแหน่งในเพลง';
    const duration = el('span', 'amp-pip-time', '--:--');
    seekRow.append(time, seek, duration);

    const controls = el('div', 'amp-pip-controls');
    const previousButton = el('button', 'amp-pip-btn', '|◀');
    previousButton.type = 'button';
    previousButton.title = 'เพลงก่อนหน้า';
    previousButton.onclick = () => previous();
    const play = el('button', 'amp-pip-btn play', '▶');
    play.type = 'button';
    play.title = 'เล่น / หยุดชั่วคราว';
    play.onclick = () => togglePlay();
    const nextButton = el('button', 'amp-pip-btn', '▶|');
    nextButton.type = 'button';
    nextButton.title = 'เพลงถัดไป';
    nextButton.onclick = () => next(true);
    const eq = el('span', 'amp-pip-eq');
    eq.setAttribute('aria-hidden', 'true');
    for (let barIndex = 0; barIndex < 5; barIndex++) eq.append(el('i'));
    controls.append(previousButton, play, nextButton, eq);
    body.append(title, seekRow, controls);

    pip.append(bar, body);
    document.body.append(pip);
    pipUi = { title, time, seek, duration, play, bar };

    seek.addEventListener('pointerdown', () => {
      pipDraggingSeek = true;
    });
    const applySeek = () => {
      pipDraggingSeek = false;
      if (audio && Number.isFinite(audio.duration)) seek((Number(seek.value) / 1000) * audio.duration);
      else paintPipTime();
    };
    seek.addEventListener('pointerup', applySeek);
    seek.addEventListener('pointercancel', applySeek);
    seek.addEventListener('change', applySeek);
    seek.addEventListener('input', () => {
      if (!audio || !Number.isFinite(audio.duration)) return;
      time.textContent = fmt((Number(seek.value) / 1000) * audio.duration);
    });

    const clamp = () => {
      if (!pip || pip.hidden) return;
      const rect = pip.getBoundingClientRect();
      const maxX = Math.max(4, window.innerWidth - rect.width - 4);
      const maxY = Math.max(4, window.innerHeight - rect.height - 4);
      if (pip.style.left || pip.style.top) {
        pip.style.left = `${Math.min(maxX, Math.max(4, rect.left))}px`;
        pip.style.top = `${Math.min(maxY, Math.max(4, rect.top))}px`;
        pip.style.right = 'auto';
        pip.style.bottom = 'auto';
      }
    };
    const place = () => {
      const saved = readPipPosition();
      if (!saved) return;
      clamp();
      pip.style.left = '';
      pip.style.top = '';
      pip.style.right = 'auto';
      pip.style.bottom = 'auto';
      const width = pip.offsetWidth || Math.min(300, window.innerWidth - 20);
      const height = pip.offsetHeight || 118;
      pip.style.left = `${Math.min(Math.max(4, saved.x), Math.max(4, window.innerWidth - width - 4))}px`;
      pip.style.top = `${Math.min(Math.max(4, saved.y), Math.max(4, window.innerHeight - height - 4))}px`;
    };
    pip._place = place;

    bar.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button')) return;
      const rect = pip.getBoundingClientRect();
      pipDrag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top };
      pip.style.left = `${rect.left}px`;
      pip.style.top = `${rect.top}px`;
      pip.style.right = 'auto';
      pip.style.bottom = 'auto';
      pip.classList.add('dragging');
      try {
        bar.setPointerCapture(event.pointerId);
      } catch {
        // no capture on this browser; pointermove on the bar still works
      }
    });
    bar.addEventListener('pointermove', (event) => {
      if (!pipDrag) return;
      const maxX = Math.max(4, window.innerWidth - pip.offsetWidth - 4);
      const maxY = Math.max(4, window.innerHeight - pip.offsetHeight - 4);
      pip.style.left = `${Math.min(maxX, Math.max(4, event.clientX - pipDrag.dx))}px`;
      pip.style.top = `${Math.min(maxY, Math.max(4, event.clientY - pipDrag.dy))}px`;
    });
    const endDrag = () => {
      if (!pipDrag) return;
      pipDrag = null;
      pip.classList.remove('dragging');
      const rect = pip.getBoundingClientRect();
      savePipPosition(rect.left, rect.top);
    };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', clamp);
  }

  function paintPipTime() {
    if (!pipUi) return;
    const duration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const position = audio ? audio.currentTime || 0 : 0;
    pipUi.time.textContent = fmt(position);
    pipUi.duration.textContent = duration ? fmt(duration) : currentTrack() && currentTrack().duration ? fmt(currentTrack().duration) : '--:--';
    if (!pipDraggingSeek) pipUi.seek.value = duration ? String(Math.round((position / duration) * 1000)) : '0';
  }

  function paintPip() {
    buildPip();
    if (!pip) return;
    const track = currentTrack();
    const hasSource = Boolean(audio && audio.dataset.file);
    pip.hidden = !(!openView && (hasSource || pipRequested));
    if (pip.hidden) return;
    if (pip._place) pip._place();
    pip.classList.toggle('playing', playingNow());
    pipUi.title.textContent = track ? trackLabel(track) : 'MIMIAMP — ยังไม่มีเพลง';
    pipUi.play.textContent = playingNow() ? '❚❚' : '▶';
    paintPipTime();
  }

  // ---------- the spectrum ----------
  function drawVisVisualizerFallback(time) {
    if (!ui) return;
    const canvas = ui.canvas;
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    const bars = 32;
    const gap = 2;
    const barWidth = Math.max(2, Math.floor((width - gap * (bars - 1)) / bars));
    for (let bar = 0; bar < bars; bar++) {
      const wave = Math.sin(time / 260 + bar * 0.55) * 0.5 + 0.5;
      const level = playingNow() ? 0.18 + wave * 0.6 : 0.06;
      drawBar(context, bar * (barWidth + gap), barWidth, height, level);
    }
  }

  const playingNow = () => Boolean(audio && !audio.paused && audio.dataset.file);

  function drawBar(context, x, width, height, level) {
    const max = Math.max(0, Math.min(1, level));
    const block = 3;
    const top = height - Math.round((height - 2) * max);
    context.fillStyle = '#0d3a16';
    context.fillRect(x, 0, width, height);
    for (let y = height - block; y >= top; y -= block) {
      context.fillStyle = y < height * 0.35 ? '#8dff9d' : y < height * 0.7 ? '#45ff62' : '#23963a';
      context.fillRect(x, y, width, block - 1);
    }
  }

  function drawVis() {
    if (!ui) return;
    const canvas = ui.canvas;
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    const bars = 32;
    const gap = 2;
    const barWidth = Math.max(2, Math.floor((width - gap * (bars - 1)) / bars));
    for (let bar = 0; bar < bars; bar++) {
      let level = 0.04;
      if (analyser && visData) {
        analyser.getByteFrequencyData(visData);
        const source = Math.min(visData.length - 1, Math.floor((bar / bars) * visData.length * 0.72));
        level = visData[source] / 255;
      } else if (playingNow()) {
        const wave = Math.sin(pseudo + bar * 0.55) * 0.5 + 0.5;
        level = 0.16 + wave * 0.62;
      }
      drawBar(context, bar * (barWidth + gap), barWidth, height, level);
    }
  }

  function visLoop(time) {
    visRaf = 0;
    if (!openView) return;
    if (time - lastVis >= 33) {
      lastVis = time;
      pseudo += 0.16;
      drawVis();
    }
    if (playingNow()) visRaf = requestAnimationFrame(visLoop);
  }

  function startVis() {
    if (!ui || !openView) return;
    if (!visRaf) visRaf = requestAnimationFrame(visLoop);
  }

  function drawVisualizer() {
    if (!ui) return;
    pseudo += 0.08;
    if (analyser) drawVis();
    else drawVisVisualizerFallback(performance.now());
  }

  // ---------- commands from the agent ----------
  async function applyCommand(command) {
    if (!command || !command.action) return;
    if (loadState === 'idle' || loadState === 'error' || !tracks.length) await loadLibrary();
    if (command.action === 'open') {
      build();
      pipRequested = true;
      paintPip();
      if (!openView) M().toast('Mimiamp', 'เปิดเครื่องเล่นลอยแล้ว — กดที่หน้าต่างเพื่อขยายเต็มหน้าจอ');
      return;
    }
    if (command.action === 'volume') {
      setVolume(command.level);
      return;
    }
    if (command.action === 'seek') {
      ensureAudio();
      seek(command.seconds);
      return;
    }
    if (command.action === 'pause') {
      pause();
      return;
    }
    if (command.action === 'stop') {
      stop();
      return;
    }
    if (command.action === 'next') {
      next(true);
      return;
    }
    if (command.action === 'previous') {
      previous();
      return;
    }
    if (command.action === 'play') {
      let wanted = command.query ? matchIndex(command.query) : -1;
      if (command.query && wanted < 0) {
        await loadLibrary(true);
        wanted = matchIndex(command.query);
      }
      await playAt(wanted >= 0 ? wanted : index >= 0 ? index : 0);
    }
  }

  function onMessage(message) {
    if (!message || message.type !== 'mimiamp') return;
    void applyCommand(message.command);
  }

  function render() {
    build();
    if (loadState === 'idle') loadLibrary();
    paintState();
    paintTime();
    paintPip();
    drawVis();
    if (playingNow()) startVis();
  }

  function onView(view) {
    openView = view === 'mimiamp';
    if (openView) {
      render();
      startVis();
    } else {
      if (visRaf) cancelAnimationFrame(visRaf);
      visRaf = 0;
      paintPip();
    }
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.mimiamp = { render, onView, onMessage };
})();
