(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);

  const VOLUME_KEY = 'mimi.mimiamp.volume';
  const TRACK_KEY = 'mimi.mimiamp.track';
  const REPEAT_KEY = 'mimi.mimiamp.repeat';
  const SHUFFLE_KEY = 'mimi.mimiamp.shuffle';
  const PIP_POS_KEY = 'mimi.mimiamp.pip';
  const ACTIVE_LIST_KEY = 'mimi.mimiamp.list';
  const EQ_KEY = 'mimi.mimiamp.eq';
  const PAN_KEY = 'mimi.mimiamp.pan';
  const LOCAL_DB = 'mimi-mimiamp';
  const LOCAL_STORE = 'files';

  const EQ_BANDS = [
    { label: '60', frequency: 60 },
    { label: '170', frequency: 170 },
    { label: '310', frequency: 310 },
    { label: '600', frequency: 600 },
    { label: '1K', frequency: 1000 },
    { label: '3K', frequency: 3000 },
    { label: '6K', frequency: 6000 },
    { label: '12K', frequency: 12000 },
    { label: '14K', frequency: 14000 },
    { label: '16K', frequency: 16000 },
  ];

  const EQ_PRESETS = {
    Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    Classical: [0, 0, 0, 0, 0, 0, -4.8, -4.8, -4.8, -6],
    Club: [0, 0, 4.8, 3.6, 3.6, 3.6, 2.4, 0, 0, 0],
    Dance: [5.8, 4.8, 3, 0, 0, -3, -4.8, -4.8, 0, 0],
    'Full Bass': [7.2, 7.2, 7.2, 5.4, 3.6, 0, -3.6, -5.4, -6, -6.6],
    'Full Bass & Treble': [5.4, 4.8, 4.2, 2.4, 0, -3.6, -4.8, -4.8, 2.4, 5.4],
    'Full Treble': [-6, -6, -6, -4.2, -1.2, 3.6, 7.2, 8.4, 8.4, 8.4],
    Headphones: [3.6, 4.8, 2.4, 0, -1.8, 0, 2.4, 5.4, 6.6, 7.2],
    'Large Hall': [6, 6, 3.6, 3.6, 0, -3.6, -3.6, -3.6, 0, 0],
    Live: [-3.6, 0, 2.4, 3.6, 4.2, 4.2, 3, 2.4, 2.4, 2.4],
    Party: [4.8, 4.8, 0, 0, 0, 0, 0, 0, 4.8, 4.8],
    Pop: [-1.2, 3, 4.8, 4.8, 3.6, 0, -1.8, -1.8, -1.2, -1.2],
    Reggae: [0, 0, 0, -3, 0, 4.2, 4.2, 0, 0, 0],
    Rock: [5.4, 3.6, -2.4, -3.6, -1.8, 2.4, 5.4, 6.6, 6.6, 6.6],
    Ska: [-1.8, -3.6, -2.4, 0, 2.4, 3.6, 5.4, 5.4, 6.6, 6],
    Soft: [3, 0, -1.2, -2.4, -1.8, 0, 2.4, 4.8, 5.4, 5.4],
    'Soft Rock': [2.4, 2.4, 1.2, 0, -2.4, -3, -1.8, 0, 2.4, 4.2],
    Techno: [4.8, 3.6, 0, -3.6, -3, 0, 4.8, 5.4, 5.4, 4.8],
    Vocal: [-1.8, -3, -3, 0, 3.6, 4.8, 4.8, 3.6, 0, -1.8],
    'Bass Boost': [9, 7.2, 4.8, 2.4, 0, 0, 0, 0, 0, 0],
    'Treble Boost': [0, 0, 0, 0, 0, 2.4, 5.4, 7.2, 7.8, 8.4],
  };

  const readNumber = (key, fallback, min, max) => {
    const raw = M().store.get(key);
    if (raw === null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const readRepeat = () => {
    const value = M().store.get(REPEAT_KEY);
    return value === 'all' || value === 'one' ? value : 'off';
  };
  const readEq = () => {
    const fallback = { on: false, preset: 'Flat', preamp: 0, gains: [...EQ_PRESETS.Flat] };
    try {
      const saved = JSON.parse(M().store.get(EQ_KEY) || 'null');
      if (!saved || typeof saved !== 'object') return fallback;
      const gains = Array.isArray(saved.gains)
        ? saved.gains.slice(0, EQ_BANDS.length).map((gain) => Math.min(12, Math.max(-12, Number(gain) || 0)))
        : [...EQ_PRESETS.Flat];
      while (gains.length < EQ_BANDS.length) gains.push(0);
      return {
        on: saved.on === true,
        preset: typeof saved.preset === 'string' && (saved.preset === 'Custom' || EQ_PRESETS[saved.preset]) ? saved.preset : 'Flat',
        preamp: Math.min(12, Math.max(-12, Number(saved.preamp) || 0)),
        gains,
      };
    } catch {
      return fallback;
    }
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
      // private window
    }
  };
  const saveEq = () => {
    try {
      M().store.set(EQ_KEY, JSON.stringify(eq));
    } catch {
      // private window
    }
  };
  const fmt = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
    const whole = Math.floor(seconds);
    const mins = Math.floor(whole / 60);
    const secs = whole % 60;
    if (mins >= 60) return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${mins}:${String(secs).padStart(2, '0')}`;
  };
  const randomId = () => {
    try {
      return crypto.randomUUID();
    } catch {
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
    }
  };
  const titleFromName = (name) => {
    const base = String(name || '').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/^\s*\d{1,3}[.)\s-]+/, '').trim();
    return base || String(name || 'ไฟล์เสียง');
  };
  const trackTitle = (track) => (track ? `${track.title}${track.artist ? ` — ${track.artist}` : ''}` : 'MIMIAMP — ยังไม่มีเพลง');
  const sourceLabel = (track) => (track?.source === 'youtube' ? 'YouTube' : track?.source === 'local' ? 'เครื่องนี้' : '');
  const isPlaying = () => Boolean(audio && !audio.paused && audio.dataset.src);

  let tracks = [];
  let playlists = [];
  let localTracks = [];
  let activeList = M().store.get(ACTIVE_LIST_KEY) || 'library';
  let current = null;
  let queueIndex = -1;
  let libraryState = 'idle';
  let loadError = '';
  let loading = null;
  let repeat = readRepeat();
  let shuffle = M().store.get(SHUFFLE_KEY) === '1';
  let volume = readNumber(VOLUME_KEY, 70, 0, 100);
  let pan = readNumber(PAN_KEY, 0, -100, 100) / 100;
  let eq = readEq();
  let openView = Boolean(M().state && M().state.view === 'mimiamp');
  let built = false;
  let draggingSeek = false;
  let statusText = 'STOPPED';
  let playingStatus = '';
  let channels = '—';
  let preparingVideo = '';
  const youtubeAudioUrls = new Map();
  let youtubeError = '';
  let googleReady = false;
  let pipRequested = false;
  let pip = null;
  let pipUi = null;
  let pipDraggingSeek = false;
  let pipDrag = null;
  let ui = null;
  let eqOpen = true;
  let playToken = 0;
  let renderedKey = '';
  let visLevels = new Float32Array(32);
  let localDbPromise = null;
  let localLoaded = false;

  let audio = null;
  let audioCtx = null;
  let sourceNode = null;
  let volumeNode = null;
  let preampNode = null;
  let filters = [];
  let pannerNode = null;
  let analyser = null;
  let leftAnalyser = null;
  let rightAnalyser = null;
  let visData = null;
  let leftData = null;
  let rightData = null;
  let visRaf = 0;
  let lastVis = 0;
  let pseudo = 0;

  function setStatus(text) {
    statusText = text;
    if (ui) ui.state.textContent = text;
  }

  function ensureAudio() {
    if (audio) return audio;
    audio = document.createElement('audio');
    audio.preload = 'auto';
    audio.playsInline = true;
    audio.setAttribute('playsinline', '');
    audio.style.display = 'none';
    audio.volume = volume / 100;
    document.body.append(audio);
    audio.addEventListener('playing', () => {
      setStatus('PLAYING');
      paintState();
      paintPip();
      startVis();
    });
    audio.addEventListener('play', () => {
      setStatus('PLAYING');
      paintState();
      paintPip();
      startVis();
    });
    audio.addEventListener('pause', () => {
      if (audio.ended) return;
      if (audioCtx && audioCtx.state === 'running') {
        // Keep the graph warm; rebuilding it is what makes the first second stutter.
      }
      setStatus('PAUSED');
      paintState();
      paintPip();
      drawVisOnce();
    });
    audio.addEventListener('waiting', () => {
      if (audio.paused) return;
      setStatus('BUFFERING');
      paintState();
      paintPip();
    });
    audio.addEventListener('stalled', () => {
      if (audio.paused) return;
      setStatus('BUFFERING');
      paintState();
    });
    audio.addEventListener('canplay', () => {
      if (!audio.paused) {
        setStatus('PLAYING');
        paintState();
        paintPip();
      }
    });
    audio.addEventListener('timeupdate', () => {
      if (!draggingSeek) paintTime();
      updatePositionState();
    });
    audio.addEventListener('durationchange', () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration) : 0;
      if (current && duration > 0 && current.duration !== duration) {
        current.duration = duration;
        const libraryTrack = tracks.find((track) => track.id === current.id);
        if (libraryTrack) libraryTrack.duration = duration;
        const local = localTracks.find((track) => track.id === current.id);
        if (local) local.duration = duration;
        updateDurationLabel(current.id, duration);
      }
      paintTime();
    });
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', () => {
      if (!audio || !audio.dataset.src) return;
      setStatus('ERROR');
      paintState();
      paintPip();
      const message = current?.source === 'youtube'
        ? 'เล่นเสียงจาก YouTube ไม่ได้ — ลองอีกครั้งหรือลบเพลงออกแล้วเพิ่มใหม่'
        : 'เล่นไฟล์นี้ไม่ได้ — ตรวจว่าไฟล์ยังอยู่บนเครื่องหรือในโฟลเดอร์เพลง';
      M().toast('Mimiamp', message, true);
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
      set('play', () => (audio ? audio.play().catch(() => {}) : undefined));
      set('pause', () => (audio ? audio.pause() : undefined));
      set('nexttrack', () => next());
      set('previoustrack', () => previous());
      set('seekto', (details) => {
        if (details && details.seekTime !== null && details.seekTime !== undefined) seek(details.seekTime);
      });
    }
    return audio;
  }

  function ensureGraph() {
    if (audioCtx || !audio) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    try {
      audioCtx = new Ctor({ latencyHint: 'playback' });
      sourceNode = audioCtx.createMediaElementSource(audio);
      volumeNode = audioCtx.createGain();
      volumeNode.gain.value = volume / 100;
      preampNode = audioCtx.createGain();
      filters = EQ_BANDS.map((band) => {
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'peaking';
        filter.frequency.value = band.frequency;
        filter.Q.value = 1;
        filter.gain.value = 0;
        return filter;
      });
      pannerNode = typeof audioCtx.createStereoPanner === 'function' ? audioCtx.createStereoPanner() : null;
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.74;
      const splitter = audioCtx.createChannelSplitter(2);
      leftAnalyser = audioCtx.createAnalyser();
      rightAnalyser = audioCtx.createAnalyser();
      leftAnalyser.fftSize = 1024;
      rightAnalyser.fftSize = 1024;
      leftData = new Float32Array(leftAnalyser.fftSize);
      rightData = new Float32Array(rightAnalyser.fftSize);
      sourceNode.connect(volumeNode);
      volumeNode.connect(preampNode);
      let node = preampNode;
      for (const filter of filters) {
        node.connect(filter);
        node = filter;
      }
      if (pannerNode) {
        node.connect(pannerNode);
        pannerNode.connect(analyser);
        pannerNode.connect(splitter);
        node = pannerNode;
      } else {
        node.connect(analyser);
        node.connect(splitter);
      }
      splitter.connect(leftAnalyser, 0);
      splitter.connect(rightAnalyser, 1);
      analyser.connect(audioCtx.destination);
      visData = new Uint8Array(analyser.frequencyBinCount);
      audio.volume = 1;
      applyEq();
      applyPan();
      resumeGraph();
    } catch {
      audioCtx = null;
      volumeNode = null;
      analyser = null;
      leftAnalyser = null;
      rightAnalyser = null;
      pannerNode = null;
    }
  }

  function resumeGraph() {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  }
  document.addEventListener('pointerdown', resumeGraph, { passive: true });
  document.addEventListener('keydown', resumeGraph);

  function applyEq() {
    const gains = eq.on ? eq.gains : EQ_PRESETS.Flat;
    if (audioCtx) {
      if (preampNode) preampNode.gain.value = eq.on ? Math.pow(10, eq.preamp / 20) : 1;
      filters.forEach((filter, index) => {
        filter.gain.setTargetAtTime(gains[index] ?? 0, audioCtx.currentTime, 0.02);
      });
    }
    if (ui) {
      ui.eqOn.textContent = eq.on ? 'ON' : 'OFF';
      ui.eqOn.classList.toggle('on', eq.on);
      if (ui.eqPreset.value !== eq.preset) ui.eqPreset.value = eq.preset;
      if (ui.eqPreamp.value !== String(Math.round(eq.preamp))) ui.eqPreamp.value = String(Math.round(eq.preamp));
      ui.eqPreampValue.textContent = `${eq.preamp > 0 ? '+' : ''}${eq.preamp.toFixed(1)} dB`;
      ui.eqBands.forEach((band, index) => {
        const gain = Math.round((eq.gains[index] ?? 0) * 10) / 10;
        if (band.input.value !== String(gain)) band.input.value = String(gain);
        band.value.textContent = `${gain > 0 ? '+' : ''}${gain.toFixed(1)}`;
      });
    }
  }

  function applyPan() {
    if (pannerNode && audioCtx) pannerNode.pan.setTargetAtTime(pan, audioCtx.currentTime, 0.02);
    if (ui) {
      const amount = Math.round(Math.abs(pan) * 100);
      ui.pan.value = String(Math.round(pan * 100));
      ui.panValue.textContent = amount === 0 ? 'C' : pan < 0 ? `L${amount}` : `R${amount}`;
    }
  }

  function updateMediaSession(track) {
    if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function' || !track) return;
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: track.title,
        artist: track.artist || sourceLabel(track) || 'Mimiamp',
        album: track.album || 'Mimi',
        ...(track.thumbnail ? { artwork: [{ src: track.thumbnail, sizes: '320x180', type: 'image/jpeg' }] } : {}),
      });
    } catch {
      // metadata is a nicety
    }
  }

  function updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    try {
      if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.duration, Math.max(0, audio.currentTime || 0)),
      });
    } catch {
      // a browser without position state
    }
  }

  function trackFromItem(item) {
    if (!item || typeof item !== 'object') return null;
    if (item.source === 'local') {
      const local = localTracks.find((track) => track.localId === item.localId);
      if (local) return { ...local, itemId: item.id };
      return {
        id: `item:${item.id}`,
        source: 'local',
        localId: item.localId,
        file: item.file,
        title: item.title,
        artist: item.artist || 'ไฟล์บนเครื่องอื่น',
        duration: item.duration,
        url: '',
        unavailable: true,
        itemId: item.id,
      };
    }
    const match = tracks.find((track) =>
      item.trackId ? track.id === item.trackId : item.source === 'youtube' ? track.videoId === item.videoId : track.file === item.file,
    );
    if (match) return { ...match, itemId: item.id };
    return {
      id: `item:${item.id}`,
      source: item.source,
      file: item.file,
      videoId: item.videoId,
      title: item.title,
      artist: item.artist,
      duration: item.duration,
      thumbnail: item.thumbnail,
      url: item.source === 'youtube' && item.videoId ? `/mimiamp/youtube/${item.videoId}.audio` : item.file ? `/mimiamp/${encodeURIComponent(item.file)}` : '',
      unavailable: true,
      itemId: item.id,
    };
  }

  function activePlaylist() {
    if (activeList === 'library') return null;
    return playlists.find((playlist) => playlist.id === activeList) || playlists.find((playlist) => playlist.name === activeList) || null;
  }

  function queueEntries() {
    const playlist = activePlaylist();
    if (!playlist) return [...tracks, ...localTracks];
    return playlist.items.map((item) => trackFromItem(item)).filter(Boolean);
  }

  function listLabel() {
    const playlist = activePlaylist();
    return playlist ? playlist.name : 'คลังเพลง';
  }

  function findQueueIndex(id) {
    return queueEntries().findIndex((entry) => entry.id === id);
  }

  async function apiJson(path, init = {}) {
    const response = await M().api(path, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
    return body;
  }

  function loadState(force) {
    if (loading) return loading;
    libraryState = 'loading';
    loadError = '';
    renderLibrary();
    loading = apiJson('/api/mimiamp/state')
      .then((data) => {
        tracks = Array.isArray(data && data.tracks) ? data.tracks.filter((track) => track && track.id && track.title) : [];
        playlists = Array.isArray(data && data.playlists) ? data.playlists : [];
        googleReady = Boolean(data && data.youtube && data.youtube.google);
        youtubeError = (data && data.youtube && data.youtube.error) || '';
        libraryState = 'ready';
        if (activeList !== 'library' && !playlists.some((playlist) => playlist.id === activeList)) activeList = 'library';
        M().store.set(ACTIVE_LIST_KEY, activeList);
        const playing = current ? findQueueIndex(current.id) : -1;
        if (playing >= 0) queueIndex = playing;
        if (current) {
          const fresh = tracks.find((track) => track.id === current.id);
          if (fresh) current = { ...fresh, ...(current.itemId ? { itemId: current.itemId } : {}) };
        }
        if (!current && tracks.length + localTracks.length > 0) {
          const saved = M().store.get(TRACK_KEY);
          const at = saved ? findQueueIndex(saved) : -1;
          if (at >= 0) current = queueEntries()[at] || null;
        }
        renderLibrary();
        paintState();
        paintTime();
        paintPip();
      })
      .catch((error) => {
        libraryState = 'error';
        loadError = error && error.message ? error.message : 'โหลดรายการเพลงไม่ได้';
        renderLibrary();
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  function ensureLocalTracks() {
    if (localLoaded) return Promise.resolve();
    localLoaded = true;
    return openLocalDb()
      .then((db) => idbAll(db))
      .then((records) => {
        localTracks = records
          .filter((record) => record && record.id && record.handle && typeof record.handle.getFile === 'function')
          .map((record) => ({
            id: `local:${record.id}`,
            source: 'local',
            localId: record.id,
            file: record.name,
            title: record.title || titleFromName(record.name),
            artist: 'เครื่องนี้',
            duration: record.duration,
            url: '',
            handle: record.handle,
            local: true,
          }));
        renderLibrary();
        paintState();
      })
      .catch(() => {
        localTracks = [];
      });
  }

  function openLocalDb() {
    if (localDbPromise) return localDbPromise;
    const promise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB is not available'));
        return;
      }
      const request = indexedDB.open(LOCAL_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(LOCAL_STORE)) request.result.createObjectStore(LOCAL_STORE, { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error || new Error('IndexedDB failed'));
      request.onsuccess = () => resolve(request.result);
    }).catch((error) => {
      localDbPromise = null;
      throw error;
    });
    localDbPromise = promise;
    return promise;
  }

  function idbAll(db) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(LOCAL_STORE, 'readonly').objectStore(LOCAL_STORE).getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || []);
    });
  }

  function idbPut(db, record) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(LOCAL_STORE, 'readwrite').objectStore(LOCAL_STORE).put(record);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  function idbDelete(db, id) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(LOCAL_STORE, 'readwrite').objectStore(LOCAL_STORE).delete(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  function durationOf(url) {
    return new Promise((resolve) => {
      const probe = new Audio();
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        probe.removeAttribute('src');
        resolve(value);
      };
      probe.preload = 'metadata';
      probe.onloadedmetadata = () => finish(Number.isFinite(probe.duration) && probe.duration > 0 ? Math.round(probe.duration) : undefined);
      probe.onerror = () => finish(undefined);
      probe.src = url;
      setTimeout(() => finish(undefined), 6000);
    });
  }

  async function addLocalFiles() {
    try {
      if (typeof window.showOpenFilePicker === 'function') {
        const handles = await window.showOpenFilePicker({
          multiple: true,
          types: [{ description: 'ไฟล์เสียง', accept: { 'audio/*': ['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac', '.webm'] } }],
        });
        const db = await openLocalDb();
        let added = 0;
        for (const handle of handles) {
          const file = await handle.getFile();
          if (!/^audio\//.test(file.type || '') && !/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|webm)$/i.test(file.name)) continue;
          const localId = randomId();
          const url = URL.createObjectURL(file);
          const duration = await durationOf(url);
          const record = { id: localId, name: file.name, title: titleFromName(file.name), duration, handle, addedAt: new Date().toISOString() };
          await idbPut(db, record);
          localTracks.push({
            id: `local:${localId}`,
            source: 'local',
            localId,
            file: file.name,
            title: record.title,
            artist: 'เครื่องนี้',
            duration,
            url,
            handle,
            local: true,
          });
          added++;
        }
        if (added === 0) M().toast('Mimiamp', 'ไม่พบไฟล์เสียงในรายการที่เลือก', true);
        else M().toast('Mimiamp', `เพิ่ม ${added} เพลงจากเครื่องแล้ว (ไม่มีการอัปโหลด)`);
        renderLibrary();
        paintState();
        return;
      }
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.multiple = true;
      input.onchange = async () => {
        const files = [...(input.files || [])];
        let added = 0;
        for (const file of files) {
          const url = URL.createObjectURL(file);
          const localId = randomId();
          const duration = await durationOf(url);
          localTracks.push({
            id: `local:${localId}`,
            source: 'local',
            localId,
            file: file.name,
            title: titleFromName(file.name),
            artist: 'เครื่องนี้',
            duration,
            url,
            fileObject: file,
            local: true,
          });
          added++;
        }
        if (added > 0) M().toast('Mimiamp', `เพิ่ม ${added} เพลงจากเครื่องแล้ว (ไม่มีการอัปโหลด)`);
        renderLibrary();
        paintState();
      };
      input.click();
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      M().toast('Mimiamp', `เปิดไฟล์จากเครื่องไม่ได้: ${error.message || error}`, true);
    }
  }

  async function localUrl(track) {
    if (!track) return '';
    if (track.url) return track.url;
    if (!track.localId) return '';
    let handle = track.handle;
    if (!handle) {
      try {
        const db = await openLocalDb();
        const records = await idbAll(db);
        const record = records.find((entry) => entry.id === track.localId);
        handle = record && record.handle;
      } catch {
        handle = null;
      }
    }
    if (!handle) throw new Error('ไฟล์นี้ไม่ได้อยู่ในเครื่องนี้อีกแล้ว');
    if (handle.queryPermission) {
      let state = await handle.queryPermission({ mode: 'read' });
      if (state !== 'granted' && handle.requestPermission) state = await handle.requestPermission({ mode: 'read' });
      if (state !== 'granted') throw new Error('ไม่ได้รับอนุญาตให้อ่านไฟล์นี้');
    }
    const file = await handle.getFile();
    track.url = URL.createObjectURL(file);
    track.file = file.name;
    if (!track.duration) {
      track.duration = await durationOf(track.url);
      updateDurationLabel(track.id, track.duration);
    }
    return track.url;
  }

  async function removeLocalTrack(track) {
    try {
      const db = await openLocalDb();
      await idbDelete(db, track.localId);
    } catch {
      // the list still forgets it
    }
    localTracks = localTracks.filter((entry) => entry.localId !== track.localId);
    if (current && current.id === track.id) stop();
    renderLibrary();
    paintState();
    M().toast('Mimiamp', 'นำเพลงออกจากเครื่องนี้แล้ว');
  }

  async function prepareYoutube(track, token) {
    if (!track || !track.videoId) throw new Error('ไม่มีรหัสวิดีโอ YouTube');
    const cached = youtubeAudioUrls.get(track.videoId);
    if (cached) return cached;
    preparingVideo = track.videoId;
    setStatus('PREPARING');
    paintState();
    paintPip();
    try {
      const data = await apiJson(`/api/mimiamp/youtube/${encodeURIComponent(track.videoId)}/prepare`, { method: 'POST' });
      if (token !== playToken) return '';
      const ready = youtubeAudioUrls.get(track.videoId);
      if (ready) return ready;
      try {
        const response = await M().api(`/api/mimiamp/youtube/${encodeURIComponent(track.videoId)}/audio`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        youtubeAudioUrls.set(track.videoId, url);
        return url;
      } catch {
        return (data && data.url) || `/mimiamp/youtube/${track.videoId}.audio`;
      }
    } finally {
      if (preparingVideo === track.videoId) preparingVideo = '';
      if (current && current.id === track.id && statusText === 'PREPARING') setStatus('READY');
      paintState();
    }
  }

  async function playEntry(entry, options = {}) {
    if (!entry) return;
    if (entry.unavailable) {
      M().toast('Mimiamp', 'เพลงนี้ไม่มีอยู่ในเครื่องนี้แล้ว', true);
      return;
    }
    const token = ++playToken;
    current = entry;
    M().store.set(TRACK_KEY, entry.id);
    const queue = queueEntries();
    const at = queue.findIndex((item) => item.id === entry.id);
    if (at >= 0) queueIndex = at;
    ensureAudio();
    ensureGraph();
    resumeGraph();
    let source = entry.url;
    try {
      if (entry.source === 'youtube') source = await prepareYoutube(entry, token);
      else if (entry.source === 'local') source = await localUrl(entry);
    } catch (error) {
      if (token !== playToken) return;
      setStatus('ERROR');
      paintState();
      paintPip();
      M().toast('Mimiamp', `เล่นเพลงนี้ไม่ได้: ${error.message || error}`, true);
      return;
    }
    if (token !== playToken) return;
    if (!source) {
      setStatus('ERROR');
      paintState();
      return;
    }
    const same = audio.dataset.src === source && audio.getAttribute('src');
    if (!same || options.restart) {
      audio.dataset.src = source;
      audio.src = source;
      audio.load();
    }
    updateMediaSession(entry);
    paintState();
    paintTime();
    paintPip();
    try {
      await audio.play();
      if (token !== playToken) return;
      setStatus('PLAYING');
    } catch (error) {
      if (token !== playToken) return;
      if (error && error.name === 'AbortError') return;
      setStatus(error && error.name === 'NotAllowedError' ? 'READY' : 'ERROR');
      if (error && error.name === 'NotAllowedError') {
        M().toast('Mimiamp', 'เบราว์เซอร์บล็อกเสียงอัตโนมัติ — กด ▶ เพื่อเริ่มเพลง', false, () => playEntry(entry));
      } else if (error && error.name !== 'AbortError') {
        M().toast('Mimiamp', `เล่นเพลงไม่ได้: ${error.message || error}`, true);
      }
    }
    paintState();
    paintTime();
    paintPip();
  }

  async function playById(id) {
    if (!id) return;
    let queue = queueEntries();
    let at = queue.findIndex((entry) => entry.id === id);
    if (at < 0) {
      activeList = 'library';
      M().store.set(ACTIVE_LIST_KEY, activeList);
      queue = queueEntries();
      at = queue.findIndex((entry) => entry.id === id);
    }
    if (at < 0) return;
    await playEntry(queue[at]);
  }

  async function playAt(index, options) {
    const queue = queueEntries();
    if (!queue.length) {
      await loadState();
      const nextQueue = queueEntries();
      if (!nextQueue.length) {
        M().toast('Mimiamp', 'ยังไม่มีเพลง — เพิ่มจาก YouTube หรือเปิดไฟล์จากเครื่องก่อน', true);
        return;
      }
      return playEntry(nextQueue[0], options);
    }
    const wanted = Number(index);
    const chosen = queue[Number.isInteger(wanted) ? Math.min(queue.length - 1, Math.max(0, wanted)) : 0];
    if (chosen) await playEntry(chosen, options);
  }

  function pause() {
    if (!audio || !audio.dataset.src) return;
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
      delete audio.dataset.src;
      audio.removeAttribute('src');
      audio.load();
    }
    setStatus('STOPPED');
    paintState();
    paintTime();
    paintPip();
    drawVisOnce();
  }

  function togglePlay() {
    if (!audio || !audio.dataset.src || audio.ended) {
      const queue = queueEntries();
      const entry = current || queue[0];
      if (entry) playEntry(entry, { restart: Boolean(audio && audio.ended) });
      else playAt(0);
      return;
    }
    if (audio.paused) playEntry(current || queueEntries()[0]);
    else pause();
  }

  function next(manual) {
    const queue = queueEntries();
    if (!queue.length) return playAt(0);
    const at = current ? queue.findIndex((entry) => entry.id === current.id) : queueIndex;
    if (shuffle && queue.length > 1) {
      let pick = at;
      for (let tries = 0; pick === at && tries < 20; tries++) pick = Math.floor(Math.random() * queue.length);
      return playEntry(queue[pick], { restart: true });
    }
    const following = at + 1;
    if (following < queue.length) return playEntry(queue[following], { restart: true });
    if (manual || repeat === 'all') return playEntry(queue[0], { restart: true });
    setStatus('END');
    paintState();
    paintPip();
  }

  function previous() {
    const queue = queueEntries();
    if (!queue.length) return playAt(0);
    if (audio && audio.currentTime > 3) {
      seek(0);
      return;
    }
    const at = current ? queue.findIndex((entry) => entry.id === current.id) : queueIndex;
    if (shuffle && queue.length > 1) return next(true);
    return playEntry(queue[at > 0 ? at - 1 : queue.length - 1], { restart: true });
  }

  function onEnded() {
    if (repeat === 'one') {
      if (!audio) return;
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    const queue = queueEntries();
    const at = current ? queue.findIndex((entry) => entry.id === current.id) : queueIndex;
    if (shuffle || at + 1 < queue.length || repeat === 'all') next(false);
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
    if (audio) audio.volume = audioCtx ? 1 : volume / 100;
    if (audioCtx && volumeNode) volumeNode.gain.setTargetAtTime(volume / 100, audioCtx.currentTime, 0.02);
    if (ui && ui.volume) ui.volume.value = String(volume);
    if (remember !== false) M().store.set(VOLUME_KEY, String(volume));
  }

  function setPan(value) {
    pan = Math.min(1, Math.max(-1, Number(value) / 100));
    applyPan();
    M().store.set(PAN_KEY, String(Math.round(pan * 100)));
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

  function choosePreset(name) {
    if (name === 'Custom') {
      eq.preset = 'Custom';
    } else if (EQ_PRESETS[name]) {
      eq.preset = name;
      eq.gains = [...EQ_PRESETS[name]];
    }
    saveEq();
    applyEq();
    paintEqOpen();
  }

  function paintEqOpen() {
    if (!ui) return;
    ui.eqBody.hidden = !eqOpen;
    ui.eqToggle.textContent = eqOpen ? '▾' : '▸';
    ui.eqToggle.classList.toggle('on', eqOpen);
    ui.eqPanel.classList.toggle('collapsed', !eqOpen);
  }

  function setBand(index, value) {
    const gain = Math.min(12, Math.max(-12, Number(value) || 0));
    eq.gains[index] = gain;
    eq.preset = 'Custom';
    if (!eq.on) eq.on = true;
    saveEq();
    applyEq();
  }

  function setPreamp(value) {
    eq.preamp = Math.min(12, Math.max(-12, Number(value) || 0));
    saveEq();
    applyEq();
  }

  function toggleEq() {
    eq.on = !eq.on;
    saveEq();
    applyEq();
  }

  function ampButton(label, title, action, extraClass) {
    const node = el('button', `amp-btn${extraClass ? ` ${extraClass}` : ''}`, label);
    node.type = 'button';
    node.title = title;
    node.setAttribute('aria-label', title);
    node.onclick = () => {
      if (action === 'toggle') togglePlay();
      else if (action === 'previous') previous();
      else if (action === 'play') playAt(current ? findQueueIndex(current.id) : 0);
      else if (action === 'pause') pause();
      else if (action === 'stop') stop();
      else if (action === 'next') next(true);
      else if (action === 'shuffle') toggleShuffle();
      else if (action === 'repeat') cycleRepeat();
      else if (action === 'eq') {
        eqOpen = !eqOpen;
        paintEqOpen();
      } else if (action === 'minimise') {
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

  function makeSelect(options, value, onChange, className) {
    const select = el('select', className || 'amp-plselect');
    for (const [optionValue, label] of options) {
      const option = el('option', '', label);
      option.value = optionValue;
      select.append(option);
    }
    select.value = value;
    select.onchange = () => onChange(select.value);
    return select;
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
      el('span', 'amp-title-sub', 'BLUE EDITION · BACKGROUND MUSIC'),
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
    canvas.width = 340;
    canvas.height = 42;
    const meta = el('div', 'amp-meta');
    const metaChannels = el('span', 'amp-meta-channel', '—');
    meta.append(el('span', '', 'MIMI'), el('br'), metaChannels, el('br'), el('span', '', 'MIMIAMP 2.0'));
    lcdrow.append(bigTime, canvas, meta);

    const statusRow = el('div', 'amp-status');
    const state = el('span', 'amp-state', 'STOPPED');
    const channelBadge = el('span', 'amp-channels', '—');
    const listInfo = el('span', '', '0 TRACKS');
    statusRow.append(state, channelBadge, listInfo);
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
    const playButton = ampButton('▶', 'เล่น / หยุดชั่วคราว', 'toggle');
    transport.append(
      ampButton('|◀', 'เพลงก่อนหน้า', 'previous'),
      playButton,
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
    volumeBox.append(el('span', 'amp-ctl-label', 'VOL'), volumeBar);
    const panBox = el('div', 'amp-pan');
    const panRange = el('input', 'amp-panrange');
    panRange.type = 'range';
    panRange.min = '-100';
    panRange.max = '100';
    panRange.step = '1';
    panRange.value = String(Math.round(pan * 100));
    panRange.title = 'แพนซ้าย-ขวา';
    panRange.oninput = () => setPan(panRange.value);
    const panValue = el('span', 'amp-panvalue', 'C');
    panValue.title = 'คลิกเพื่อกลับกลาง';
    panValue.onclick = () => setPan(0);
    panBox.append(el('span', 'amp-ctl-label', 'PAN'), panRange, panValue);
    const toggles = el('div', 'amp-toggles');
    const shuffleButton = ampButton('SHUF', 'สุ่มเพลง', 'shuffle', 'wide');
    const repeatButton = ampButton('REP OFF', 'วนซ้ำ: ปิด', 'repeat', 'wide');
    toggles.append(shuffleButton, repeatButton);
    controls.append(transport, volumeBox, panBox, toggles);

    const playerZone = el('section', 'amp-zone amp-player-zone');
    const playerHead = el('div', 'amp-zone-head');
    playerHead.append(el('span', 'amp-zone-title', 'PLAYER'), el('span', 'amp-zone-sub', 'AUDIO ONLY'));
    playerZone.append(playerHead, lcd, seekRow, controls);

    const eqPanel = el('section', 'amp-zone amp-eq-zone');
    const eqHead = el('div', 'amp-zone-head');
    const eqPreset = makeSelect(
      [['Flat', 'Flat'], ['Custom', 'กำหนดเอง'], ...Object.keys(EQ_PRESETS).filter((name) => name !== 'Flat').map((name) => [name, name])],
      eq.preset,
      (value) => choosePreset(value),
      'amp-eqpreset',
    );
    const eqOn = el('button', 'amp-eqon', eq.on ? 'ON' : 'OFF');
    eqOn.type = 'button';
    eqOn.onclick = () => toggleEq();
    const eqToggle = el('button', 'amp-plbtn amp-eqcollapse', '▾');
    eqToggle.type = 'button';
    eqToggle.title = 'ย่อ/ขยายอีควอไลเซอร์';
    eqToggle.onclick = () => {
      eqOpen = !eqOpen;
      paintEqOpen();
    };
    eqHead.append(el('span', 'amp-zone-title', 'EQUALIZER'), eqPreset, eqOn, eqToggle);
    const eqBody = el('div', 'amp-eqbody');
    const preampRow = el('div', 'amp-preamp');
    const eqPreamp = el('input', 'amp-eqslider');
    eqPreamp.type = 'range';
    eqPreamp.min = '-12';
    eqPreamp.max = '12';
    eqPreamp.step = '0.5';
    eqPreamp.value = String(eq.preamp);
    eqPreamp.oninput = () => setPreamp(eqPreamp.value);
    const eqPreampValue = el('span', 'amp-eqvalue', '0.0 dB');
    preampRow.append(el('span', 'amp-eqlabel', 'PREAMP'), eqPreamp, eqPreampValue);
    const eqBands = el('div', 'amp-eqbands');
    const bandNodes = EQ_BANDS.map((band, index) => {
      const wrap = el('div', 'amp-eqband');
      const input = el('input', 'amp-eqslider amp-eqv');
      input.type = 'range';
      input.min = '-12';
      input.max = '12';
      input.step = '0.5';
      input.value = String(eq.gains[index] ?? 0);
      input.title = `${band.label} Hz`;
      const value = el('span', 'amp-eqvalue', '0.0');
      input.oninput = () => setBand(index, input.value);
      wrap.append(value, input, el('span', 'amp-eqfreq', band.label));
      eqBands.append(wrap);
      return { input, value };
    });
    eqBody.append(preampRow, eqBands);
    eqPanel.append(eqHead, eqBody);

    const listZone = el('section', 'amp-zone amp-list-zone');
    const listHead = el('div', 'amp-zone-head');
    const count = el('span', 'amp-zone-count', '0 TRACKS');
    const youtubeButton = el('button', 'amp-plbtn', 'YT');
    youtubeButton.type = 'button';
    youtubeButton.title = 'เพิ่มเพลงจากลิงก์ YouTube (เสียงเท่านั้น)';
    youtubeButton.onclick = () => openYoutubeDialog();
    const localButton = el('button', 'amp-plbtn', 'เปิดไฟล์');
    localButton.type = 'button';
    localButton.title = 'เปิดไฟล์เสียงจากเครื่องนี้ (ไม่อัปโหลด)';
    localButton.onclick = () => addLocalFiles();
    const refresh = el('button', 'amp-plbtn', '↻');
    refresh.type = 'button';
    refresh.title = 'โหลดรายการเพลงและ playlist ใหม่';
    refresh.onclick = () => {
      loadState(true).then(() => M().toast('Mimiamp', 'รีเฟรชรายการเพลงแล้ว'));
    };
    listHead.append(el('span', 'amp-zone-title', 'PLAYLIST'), count, youtubeButton, localButton, refresh);

    const listTools = el('div', 'amp-plbar');
    const playlistSelect = makeSelect(
      [['library', 'คลังเพลง']],
      'library',
      (value) => {
        activeList = value;
        M().store.set(ACTIVE_LIST_KEY, activeList);
        queueIndex = current && activeList === 'library' ? findQueueIndex(current.id) : -1;
        renderLibrary();
        paintState();
      },
      'amp-plselect',
    );
    const newListButton = el('button', 'amp-plbtn', '+');
    newListButton.type = 'button';
    newListButton.title = 'สร้าง playlist';
    newListButton.onclick = () => createPlaylistDialog();
    const renameListButton = el('button', 'amp-plbtn', '✎');
    renameListButton.type = 'button';
    renameListButton.title = 'เปลี่ยนชื่อ playlist';
    renameListButton.onclick = () => renamePlaylistDialog();
    const deleteListButton = el('button', 'amp-plbtn', '🗑');
    deleteListButton.type = 'button';
    deleteListButton.title = 'ลบ playlist';
    deleteListButton.onclick = () => deletePlaylistDialog();
    const importButton = el('button', 'amp-plbtn', 'นำเข้า');
    importButton.type = 'button';
    importButton.title = 'นำเข้า playlist จากไฟล์ JSON';
    importButton.onclick = () => importPlaylist();
    const exportButton = el('button', 'amp-plbtn', 'ส่งออก');
    exportButton.type = 'button';
    exportButton.title = 'ส่งออก playlist เป็นไฟล์ JSON';
    exportButton.onclick = () => exportPlaylist();
    listTools.append(playlistSelect, newListButton, renameListButton, deleteListButton, importButton, exportButton);

    const list = el('div', 'amp-tracks');
    const localInfo = el('span', 'amp-localinfo', '');
    const foot = el('div', 'amp-foot');
    foot.append(localInfo, el('span', '', 'MIMIAMP'));
    const playlist = el('div', 'amp-playlist');
    playlist.append(listTools, list, foot);
    listZone.append(listHead, playlist);

    body.append(playerZone, eqPanel, listZone);
    win.append(titlebar, body);
    shell.append(win);
    const back = M().button('back', '‹', () => document.getElementById('app').classList.add('show-side'), 'กลับ');
    back.type = 'button';
    back.setAttribute('aria-label', 'กลับ');
    page.replaceChildren(back, shell);

    ui = {
      mtext,
      bigTime,
      canvas,
      state,
      channelBadge,
      metaChannels,
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
      eqPanel,
      eqBody,
      eqToggle,
      eqPreset,
      eqOn,
      eqPreamp,
      eqPreampValue,
      eqBands: bandNodes,
      pan: panRange,
      panValue,
      playlistSelect,
      renameListButton,
      deleteListButton,
      localInfo,
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
    applyEq();
    applyPan();
    paintEqOpen();
    loadState();
    ensureLocalTracks();
    paintState();
    paintTime();
    paintPip();
  }

  function updatePlaylistSelect() {
    if (!ui) return;
    const options = [['library', 'คลังเพลง'], ...playlists.map((playlist) => [playlist.id, `${playlist.name} (${playlist.items.length})`])];
    ui.playlistSelect.replaceChildren(
      ...options.map(([value, label]) => {
        const option = el('option', '', label);
        option.value = value;
        return option;
      }),
    );
    ui.playlistSelect.value = activeList;
    if (ui.playlistSelect.value !== activeList) {
      activeList = 'library';
      ui.playlistSelect.value = 'library';
      M().store.set(ACTIVE_LIST_KEY, activeList);
    }
    const editable = activeList !== 'library';
    ui.renameListButton.disabled = !editable;
    ui.deleteListButton.disabled = !editable;
  }

  function rowAction(track) {
    if (activeList !== 'library') {
      const remove = el('button', 'amp-rowbtn', '×');
      remove.type = 'button';
      remove.title = 'เอาออกจาก playlist';
      remove.onclick = (event) => {
        event.stopPropagation();
        removeFromActivePlaylist(track);
      };
      return remove;
    }
    const more = el('button', 'amp-rowbtn', '⋯');
    more.type = 'button';
    more.title = 'ตัวเลือกเพลง';
    more.onclick = (event) => {
      event.stopPropagation();
      trackActions(track);
    };
    return more;
  }

  function renderLibrary() {
    if (!built || !ui) return;
    const queue = queueEntries();
    const totalTracks = queue.length;
    const active = activePlaylist();
    ui.count.textContent = `${totalTracks} TRACK${totalTracks === 1 ? '' : 'S'}`;
    ui.listInfo.textContent =
      libraryState === 'loading'
        ? 'LOADING…'
        : libraryState === 'error'
          ? 'LIBRARY ERROR'
          : `${totalTracks} TRACK${totalTracks === 1 ? '' : 'S'}${shuffle ? ' · SHUFFLE' : ''}`;
    ui.localInfo.textContent = localTracks.length > 0 ? `${localTracks.length} จากเครื่อง` : '';
    updatePlaylistSelect();
    ui.list.replaceChildren();
    if (libraryState === 'loading' && totalTracks === 0) {
      ui.list.append(el('div', 'amp-empty', 'กำลังโหลดรายการเพลง…'));
      return;
    }
    if (libraryState === 'error') {
      const empty = el('div', 'amp-empty', `โหลดรายการเพลงไม่ได้ (${loadError})`);
      const retry = el('button', 'amp-btn', 'ลองใหม่');
      retry.type = 'button';
      retry.onclick = () => loadState(true);
      empty.append(el('br'), retry);
      ui.list.append(empty);
      return;
    }
    if (totalTracks === 0) {
      const empty = el('div', 'amp-empty');
      empty.append(
        el('div', '', active ? `“${active.name}” ยังไม่มีเพลง` : 'ยังไม่มีเพลงใน Mimiamp'),
        el('div', '', 'เพิ่มลิงก์ YouTube หรือเปิดไฟล์เสียงจากเครื่องนี้ (ไฟล์ไม่ถูกอัปโหลด)'),
        el('div', '', 'เพลงที่วางในโฟลเดอร์ mimiamp ก็ปรากฏที่นี่'),
      );
      const actions = el('div', 'amp-empty-actions');
      const youtube = el('button', 'amp-btn wide', 'เพิ่มจาก YouTube');
      youtube.type = 'button';
      youtube.onclick = () => openYoutubeDialog();
      const local = el('button', 'amp-btn wide', 'เปิดไฟล์จากเครื่อง');
      local.type = 'button';
      local.onclick = () => addLocalFiles();
      actions.append(youtube, local);
      empty.append(actions);
      ui.list.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    queue.forEach((track, position) => {
      const row = el('div', `amp-track${current && current.id === track.id ? ' on' : ''}${track.unavailable ? ' unavailable' : ''}`);
      row.tabIndex = 0;
      row.dataset.id = track.id;
      row.title = track.unavailable ? `${trackTitle(track)} — ไม่มีในเครื่องนี้` : `เล่น ${trackTitle(track)}`;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-current', current && current.id === track.id ? 'true' : 'false');
      const source = sourceLabel(track);
      const name = el('span', 'amp-tname');
      name.append(el('span', '', track.title));
      if (source) name.append(el('span', 'amp-srcbadge', source));
      row.append(
        el('span', 'amp-num', String(position + 1).padStart(2, '0')),
        name,
        el('span', 'amp-artist', track.artist || (track.unavailable ? 'ไม่มีไฟล์นี้' : '—')),
        el('span', 'amp-dur', track.duration ? fmt(track.duration) : '--:--'),
        rowAction(track),
      );
      const play = () => {
        if (track.unavailable) {
          M().toast('Mimiamp', 'เพลงนี้ไม่มีอยู่ในเครื่องนี้แล้ว', true);
          return;
        }
        playEntry(track, { restart: current ? current.id !== track.id : false });
      };
      row.onclick = play;
      row.onkeydown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          play();
        }
      };
      fragment.append(row);
    });
    ui.list.append(fragment);
  }

  function updateDurationLabel(id, duration) {
    if (!ui) return;
    for (const row of ui.list.children) {
      if (row.dataset && row.dataset.id === id) {
        const label = row.querySelector('.amp-dur');
        if (label) label.textContent = fmt(duration);
      }
    }
    paintTime();
  }

  function paintState() {
    if (!built || !ui) return;
    ui.mtext.textContent = current ? trackTitle(current) : 'MIMIAMP — ยังไม่มีเพลง';
    ui.playButton.classList.toggle('on', isPlaying());
    ui.playButton.textContent = isPlaying() ? '❚❚' : '▶';
    ui.shuffleButton.classList.toggle('on', shuffle);
    const repeatLabel = repeat === 'off' ? 'REP OFF' : repeat === 'one' ? 'REP 1' : 'REP ALL';
    ui.repeatButton.textContent = repeatLabel;
    ui.repeatButton.classList.toggle('on', repeat !== 'off');
    ui.repeatButton.title = repeat === 'off' ? 'วนซ้ำ: ปิด' : repeat === 'one' ? 'วนซ้ำ: เพลงนี้' : 'วนซ้ำ: ทั้งหมด';
    if (!audio || !audio.dataset.src) {
      if (statusText === 'PLAYING' || statusText === 'BUFFERING') statusText = 'STOPPED';
    }
    ui.state.textContent = statusText;
    const channelText = preparingVideo ? 'PREP' : channels;
    ui.channelBadge.textContent = channelText;
    ui.metaChannels.textContent = channelText;
    paintEqOpen();
    const playingKey = `${current ? current.id : ''}:${activeList}`;
    if (playingKey !== renderedKey) {
      renderedKey = playingKey;
      renderLibrary();
    }
  }

  function paintTime() {
    if (built && ui) {
      const duration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const position = audio ? audio.currentTime || 0 : 0;
      ui.bigTime.textContent = fmt(position);
      ui.elapsed.textContent = fmt(position);
      ui.total.textContent = duration ? fmt(duration) : current && current.duration ? fmt(current.duration) : '--:--';
      if (!draggingSeek) ui.seekBar.value = duration ? String(Math.round((position / duration) * 1000)) : '0';
    }
    paintPipTime();
  }

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
    const eqBars = el('span', 'amp-pip-eq');
    eqBars.setAttribute('aria-hidden', 'true');
    for (let barIndex = 0; barIndex < 5; barIndex++) eqBars.append(el('i'));
    controls.append(previousButton, play, nextButton, eqBars);
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
      const width = pip.offsetWidth || Math.min(300, window.innerWidth - 20);
      const height = pip.offsetHeight || 118;
      pip.style.left = `${Math.min(Math.max(4, saved.x), Math.max(4, window.innerWidth - width - 4))}px`;
      pip.style.top = `${Math.min(Math.max(4, saved.y), Math.max(4, window.innerHeight - height - 4))}px`;
      pip.style.right = 'auto';
      pip.style.bottom = 'auto';
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
        // no capture
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
    pipUi.duration.textContent = duration ? fmt(duration) : current && current.duration ? fmt(current.duration) : '--:--';
    if (!pipDraggingSeek) pipUi.seek.value = duration ? String(Math.round((position / duration) * 1000)) : '0';
  }

  function paintPip() {
    buildPip();
    if (!pip) return;
    const hasSource = Boolean(audio && audio.dataset.src);
    pip.hidden = !(!openView && (hasSource || pipRequested));
    if (pip.hidden) return;
    if (pip._place) pip._place();
    pip.classList.toggle('playing', isPlaying());
    pipUi.title.textContent = current ? trackTitle(current) : 'MIMIAMP — ยังไม่มีเพลง';
    pipUi.play.textContent = isPlaying() ? '❚❚' : '▶';
    paintPipTime();
  }

  function drawBar(context, x, width, height, level, playing) {
    const max = Math.max(0, Math.min(1, level));
    const block = 3;
    const top = height - Math.round((height - 2) * max);
    context.fillStyle = playing ? '#07182b' : '#06111d';
    context.fillRect(x, 0, width, height);
    for (let y = height - block; y >= top; y -= block) {
      context.fillStyle = playing
        ? y < height * 0.35
          ? '#9ee8ff'
          : y < height * 0.7
            ? '#47d7ff'
            : '#2179b8'
        : '#123249';
      context.fillRect(x, y, width, block - 1);
    }
  }

  function drawVisOnce() {
    if (!ui) return;
    pseudo += 0.08;
    drawVis(performance.now());
  }

  function drawVis(time) {
    if (!ui) return;
    const canvas = ui.canvas;
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    const bars = visLevels.length;
    const gap = 2;
    const barWidth = Math.max(2, Math.floor((width - gap * (bars - 1)) / bars));
    if (analyser && visData) analyser.getByteFrequencyData(visData);
    const playing = isPlaying();
    for (let bar = 0; bar < bars; bar++) {
      let target = 0.04;
      if (analyser && visData) {
        const from = Math.floor(Math.pow(bar / bars, 1.35) * visData.length * 0.86);
        const to = Math.max(from + 1, Math.floor(Math.pow((bar + 1) / bars, 1.35) * visData.length * 0.86));
        let sum = 0;
        for (let at = from; at < Math.min(to, visData.length); at++) sum += visData[at];
        target = sum / Math.max(1, Math.min(to, visData.length) - from) / 255;
      } else if (playing) {
        const wave = Math.sin(pseudo + bar * 0.55) * 0.5 + 0.5;
        target = 0.16 + wave * 0.62;
      }
      visLevels[bar] = Math.max(target, visLevels[bar] * 0.82);
      drawBar(context, bar * (barWidth + gap), barWidth, height, visLevels[bar], playing);
    }
    void time;
  }

  function visLoop(time) {
    visRaf = 0;
    if (!openView || document.hidden) return;
    if (time - lastVis >= 45) {
      lastVis = time;
      pseudo += 0.12;
      drawVis(time);
    }
    if (isPlaying()) visRaf = requestAnimationFrame(visLoop);
  }

  function startVis() {
    if (!ui || !openView) return;
    if (!visRaf) visRaf = requestAnimationFrame(visLoop);
  }

  function detectChannels() {
    if (!leftAnalyser || !rightAnalyser || !leftData || !rightData) return;
    leftAnalyser.getFloatTimeDomainData(leftData);
    rightAnalyser.getFloatTimeDomainData(rightData);
    let total = 0;
    let difference = 0;
    for (let at = 0; at < leftData.length; at++) {
      const left = leftData[at] || 0;
      const right = rightData[at] || 0;
      total += left * left + right * right;
      const delta = left - right;
      difference += delta * delta;
    }
    if (total < 1e-8) return;
    channels = difference / total < 0.0015 ? 'MONO' : 'STEREO';
    if (ui) {
      ui.channelBadge.textContent = preparingVideo ? 'PREP' : channels;
      ui.metaChannels.textContent = preparingVideo ? 'PREP' : channels;
    }
  }
  const channelTimer = setInterval(() => {
    if (isPlaying()) detectChannels();
  }, 700);

  async function openYoutubeDialog() {
    ensureAudio();
    ensureGraph();
    const dialog = el('div', 'dialog form amp-yt');
    dialog.append(el('h3', '', 'เพิ่มเพลงจาก YouTube'));
    dialog.append(el('p', 'hint', 'วางลิงก์วิดีโอ หรือค้นหา แล้ว Mimiamp จะเล่นเฉพาะเสียง ไม่มีวิดีโอ · บทบาท Google API ใช้ค้นหาเมื่อเชื่อมบัญชีไว้'));
    const link = M().textInput('', 'https://www.youtube.com/watch?v=…', 'url');
    link.autocapitalize = 'none';
    link.spellcheck = false;
    const actions = el('div', 'amp-yt-actions');
    const addLink = el('button', 'btn pri', 'เพิ่มจากลิงก์');
    addLink.type = 'button';
    const searchButton = el('button', 'btn', 'ค้นหา');
    searchButton.type = 'button';
    actions.append(addLink, searchButton);
    const status = el('div', 'hint amp-yt-status', youtubeError ? `ครั้งก่อน: ${youtubeError}` : '');
    const results = el('div', 'amp-yt-results');
    dialog.append(link, actions, status, results);
    const close = el('button', 'btn ghost', 'ปิด');
    close.type = 'button';
    close.onclick = () => M().closeOverlay();
    dialog.append(close);
    M().overlay(dialog);
    link.focus();

    const add = async (url) => {
      if (!url.trim()) {
        status.textContent = 'วางลิงก์ YouTube ก่อน';
        return;
      }
      addLink.disabled = true;
      searchButton.disabled = true;
      status.textContent = 'กำลังอ่านข้อมูลจาก YouTube…';
      try {
        const body = { url: url.trim(), ...(activeList !== 'library' ? { playlist: activeList } : {}) };
        const data = await apiJson('/api/mimiamp/youtube', { method: 'POST', body: JSON.stringify(body) });
        await loadState(true);
        status.textContent = `เพิ่ม “${data.track.title}” แล้ว`;
        M().toast('Mimiamp', `เพิ่มเพลง YouTube: ${data.track.title}`);
        link.value = '';
      } catch (error) {
        status.textContent = `เพิ่มไม่ได้: ${error.message || error}`;
      } finally {
        addLink.disabled = false;
        searchButton.disabled = false;
      }
    };
    addLink.onclick = () => add(link.value);
    link.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        add(link.value);
      }
    });
    searchButton.onclick = async () => {
      const query = link.value.trim();
      if (!query) {
        status.textContent = 'พิมพ์ชื่อเพลงหรือลิงก์ก่อน';
        return;
      }
      searchButton.disabled = true;
      status.textContent = googleReady ? 'กำลังค้นหาด้วย Google + YouTube…' : 'กำลังค้นหาบน YouTube…';
      results.replaceChildren();
      try {
        const data = await apiJson(`/api/mimiamp/youtube/search?q=${encodeURIComponent(query)}`);
        if (data.error && (!data.results || data.results.length === 0)) status.textContent = `ค้นหาไม่ได้: ${data.error}`;
        else status.textContent = data.results && data.results.length ? `พบ ${data.results.length} รายการ` : 'ไม่พบเพลงที่ตรงกัน';
        for (const result of data.results || []) {
          const row = el('div', 'amp-yt-row');
          const thumb = el('img', 'amp-yt-thumb');
          thumb.src = result.thumbnail || `https://i.ytimg.com/vi/${result.videoId}/mqdefault.jpg`;
          thumb.alt = '';
          thumb.loading = 'lazy';
          const text = el('div', 'amp-yt-meta');
          text.append(el('b', '', result.title), el('small', '', `${result.artist || 'YouTube'}${result.duration ? ` · ${fmt(result.duration)}` : ''}`));
          const addButton = el('button', 'btn', 'เพิ่ม');
          addButton.type = 'button';
          addButton.onclick = () => add(`https://www.youtube.com/watch?v=${result.videoId}`);
          row.append(thumb, text, addButton);
          results.append(row);
        }
      } catch (error) {
        status.textContent = `ค้นหาไม่ได้: ${error.message || error}`;
      } finally {
        searchButton.disabled = false;
      }
    };
  }

  async function createPlaylistDialog(track) {
    const dialog = el('div', 'dialog form');
    dialog.append(el('h3', '', track ? 'เพิ่มใน playlist' : 'สร้าง playlist'));
    const name = M().textInput('', 'ชื่อ playlist');
    name.maxLength = 80;
    dialog.append(M().labelled('ชื่อ', name));
    const foot = el('div', 'amp-dialog-actions');
    const cancel = el('button', 'btn ghost', 'ยกเลิก');
    cancel.type = 'button';
    cancel.onclick = () => M().closeOverlay();
    const save = el('button', 'btn pri', track ? 'สร้างและเพิ่ม' : 'สร้าง');
    save.type = 'button';
    foot.append(cancel, save);
    dialog.append(foot);
    M().overlay(dialog);
    name.focus();
    const submit = async () => {
      const value = name.value.trim();
      if (!value) {
        name.focus();
        return;
      }
      save.disabled = true;
      try {
        const data = await apiJson('/api/mimiamp/playlists', { method: 'POST', body: JSON.stringify({ name: value }) });
        await loadState(true);
        if (track) await addTrackToPlaylist(data.playlist.id, track);
        activeList = data.playlist.id;
        M().store.set(ACTIVE_LIST_KEY, activeList);
        renderLibrary();
        paintState();
        M().closeOverlay();
        M().toast('Mimiamp', `สร้าง playlist “${data.playlist.name}” แล้ว`);
      } catch (error) {
        M().toast('Mimiamp', `สร้าง playlist ไม่ได้: ${error.message || error}`, true);
      } finally {
        save.disabled = false;
      }
    };
    save.onclick = submit;
    name.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    });
  }

  async function addTrackToPlaylist(playlistId, track) {
    const body =
      track.source === 'local'
        ? {
            source: 'local',
            localId: track.localId,
            file: track.file,
            title: track.title,
            artist: track.artist,
            ...(track.duration ? { duration: track.duration } : {}),
          }
        : { trackId: track.id };
    const data = await apiJson(`/api/mimiamp/playlists/${encodeURIComponent(playlistId)}/items`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const at = playlists.findIndex((playlist) => playlist.id === data.playlist.id);
    if (at >= 0) playlists[at] = data.playlist;
    renderLibrary();
    paintState();
    M().toast('Mimiamp', `เพิ่ม “${track.title}” ใน “${data.playlist.name}” แล้ว`);
  }

  function trackActions(track) {
    const dialog = el('div', 'dialog form');
    dialog.append(el('h3', '', track.title));
    dialog.append(el('p', 'hint', `${track.artist || sourceLabel(track) || 'Mimiamp'}${track.duration ? ` · ${fmt(track.duration)}` : ''}`));
    const actions = el('div', 'amp-trackmenu');
    const addTo = el('button', 'btn', 'เพิ่มใน playlist');
    addTo.type = 'button';
    addTo.onclick = () => {
      M().closeOverlay();
      choosePlaylistFor(track);
    };
    actions.append(addTo);
    if (track.source === 'youtube') {
      const remove = el('button', 'btn danger', 'ลบออกจากคลัง YouTube');
      remove.type = 'button';
      remove.onclick = async () => {
        if (!(await confirmDialog('ลบเพลง YouTube?', `“${track.title}” จะถูกเอาออกจากคลัง (ไฟล์แคชจะถูกลบ)`))) return;
        try {
          await apiJson(`/api/mimiamp/youtube/${encodeURIComponent(track.videoId)}`, { method: 'DELETE' });
          const cached = youtubeAudioUrls.get(track.videoId);
          if (cached) {
            URL.revokeObjectURL(cached);
            youtubeAudioUrls.delete(track.videoId);
          }
          if (current && current.id === track.id) stop();
          M().closeOverlay();
          await loadState(true);
          M().toast('Mimiamp', 'ลบเพลง YouTube แล้ว');
        } catch (error) {
          M().toast('Mimiamp', `ลบไม่ได้: ${error.message || error}`, true);
        }
      };
      actions.append(remove);
    }
    if (track.source === 'local') {
      const remove = el('button', 'btn danger', 'นำออกจากเครื่องนี้');
      remove.type = 'button';
      remove.onclick = async () => {
        if (!(await confirmDialog('นำเพลงออกจากเครื่องนี้?', `“${track.title}” จะหายจากรายการบนเครื่องนี้ (ไฟล์ต้นฉบับไม่ถูกลบ)`))) return;
        M().closeOverlay();
        await removeLocalTrack(track);
      };
      actions.append(remove);
    }
    dialog.append(actions);
    const close = el('button', 'btn ghost', 'ปิด');
    close.type = 'button';
    close.onclick = () => M().closeOverlay();
    dialog.append(close);
    M().overlay(dialog);
  }

  function choosePlaylistFor(track) {
    const dialog = el('div', 'dialog form');
    dialog.append(el('h3', '', `เพิ่ม “${track.title}” ใน playlist`));
    if (playlists.length === 0) {
      dialog.append(el('p', 'hint', 'ยังไม่มี playlist — สร้างใหม่ก่อน'));
      const create = el('button', 'btn pri', 'สร้าง playlist ใหม่');
      create.type = 'button';
      create.onclick = () => {
        M().closeOverlay();
        createPlaylistDialog(track);
      };
      dialog.append(create);
    } else {
      const list = el('div', 'amp-plchoose');
      for (const playlist of playlists) {
        const choose = el('button', 'btn', `${playlist.name} (${playlist.items.length})`);
        choose.type = 'button';
        choose.onclick = async () => {
          try {
            await addTrackToPlaylist(playlist.id, track);
            M().closeOverlay();
          } catch (error) {
            M().toast('Mimiamp', `เพิ่มไม่ได้: ${error.message || error}`, true);
          }
        };
        list.append(choose);
      }
      dialog.append(list);
      const create = el('button', 'btn ghost', '+ สร้าง playlist ใหม่');
      create.type = 'button';
      create.onclick = () => {
        M().closeOverlay();
        createPlaylistDialog(track);
      };
      dialog.append(create);
    }
    const close = el('button', 'btn ghost', 'ปิด');
    close.type = 'button';
    close.onclick = () => M().closeOverlay();
    dialog.append(close);
    M().overlay(dialog);
  }

  async function removeFromActivePlaylist(track) {
    const playlist = activePlaylist();
    if (!playlist) return;
    const itemId = track.itemId || playlist.items.find((item) => item.id === track.itemId)?.id;
    if (!itemId) {
      M().toast('Mimiamp', 'ไม่พบเพลงนี้ใน playlist', true);
      return;
    }
    try {
      const data = await apiJson(`/api/mimiamp/playlists/${encodeURIComponent(playlist.id)}/items/${encodeURIComponent(itemId)}`, {
        method: 'DELETE',
      });
      const at = playlists.findIndex((entry) => entry.id === data.playlist.id);
      if (at >= 0) playlists[at] = data.playlist;
      renderLibrary();
      paintState();
      M().toast('Mimiamp', `เอา “${track.title}” ออกจาก playlist แล้ว`);
    } catch (error) {
      M().toast('Mimiamp', `เอาออกไม่ได้: ${error.message || error}`, true);
    }
  }

  function renamePlaylistDialog() {
    const playlist = activePlaylist();
    if (!playlist) return;
    const dialog = el('div', 'dialog form');
    dialog.append(el('h3', '', 'เปลี่ยนชื่อ playlist'));
    const name = M().textInput(playlist.name, 'ชื่อ playlist');
    name.maxLength = 80;
    dialog.append(M().labelled('ชื่อ', name));
    const foot = el('div', 'amp-dialog-actions');
    const cancel = el('button', 'btn ghost', 'ยกเลิก');
    cancel.type = 'button';
    cancel.onclick = () => M().closeOverlay();
    const save = el('button', 'btn pri', 'บันทึก');
    save.type = 'button';
    foot.append(cancel, save);
    dialog.append(foot);
    M().overlay(dialog);
    name.focus();
    name.select();
    save.onclick = async () => {
      const value = name.value.trim();
      if (!value) return;
      try {
        const data = await apiJson(`/api/mimiamp/playlists/${encodeURIComponent(playlist.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: value }),
        });
        const at = playlists.findIndex((entry) => entry.id === data.playlist.id);
        if (at >= 0) playlists[at] = data.playlist;
        M().closeOverlay();
        renderLibrary();
        paintState();
      } catch (error) {
        M().toast('Mimiamp', `เปลี่ยนชื่อไม่ได้: ${error.message || error}`, true);
      }
    };
  }

  async function deletePlaylistDialog() {
    const playlist = activePlaylist();
    if (!playlist) return;
    if (!(await confirmDialog('ลบ playlist?', `“${playlist.name}” และรายการเพลงใน playlist จะหายไป (ไฟล์เพลงยังอยู่)`))) return;
    try {
      await apiJson(`/api/mimiamp/playlists/${encodeURIComponent(playlist.id)}`, { method: 'DELETE' });
      activeList = 'library';
      M().store.set(ACTIVE_LIST_KEY, activeList);
      await loadState(true);
      M().toast('Mimiamp', 'ลบ playlist แล้ว');
    } catch (error) {
      M().toast('Mimiamp', `ลบไม่ได้: ${error.message || error}`, true);
    }
  }

  function confirmDialog(title, body) {
    return new Promise((resolve) => {
      const dialog = el('div', 'dialog form');
      dialog.append(el('h3', '', title), el('p', 'hint', body));
      const foot = el('div', 'amp-dialog-actions');
      const cancel = el('button', 'btn ghost', 'ยกเลิก');
      cancel.type = 'button';
      let answered = false;
      const finish = (value) => {
        if (answered) return;
        answered = true;
        resolve(value);
        M().closeOverlay();
      };
      cancel.onclick = () => finish(false);
      const ok = el('button', 'btn danger', 'ยืนยัน');
      ok.type = 'button';
      ok.onclick = () => finish(true);
      foot.append(cancel, ok);
      dialog.append(foot);
      const scrim = M().overlay(dialog);
      scrim.onclick = (event) => {
        if (event.target === scrim) finish(false);
      };
    });
  }

  function safeFileName(name) {
    return String(name || 'playlist')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'playlist';
  }

  async function saveJsonFile(name, data) {
    const text = JSON.stringify(data, null, 2);
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'Mimiamp playlist', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(text);
        await writable.close();
        return true;
      } catch (error) {
        if (error && error.name === 'AbortError') return false;
        throw error;
      }
    }
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  }

  async function exportPlaylist() {
    try {
      const playlist = activePlaylist();
      const data = playlist
        ? await apiJson(`/api/mimiamp/playlists/${encodeURIComponent(playlist.id)}/export`)
        : {
            format: 'mimiamp-playlist',
            version: 1,
            exportedAt: new Date().toISOString(),
            playlist: {
              name: 'Mimiamp Library',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              items: tracks.map((track) => ({
                id: randomId(),
                trackId: track.id,
                source: track.source,
                file: track.file,
                videoId: track.videoId,
                title: track.title,
                artist: track.artist,
                duration: track.duration,
                thumbnail: track.thumbnail,
              })),
            },
          };
      const name = safeFileName((data.playlist && data.playlist.name) || 'mimiamp');
      if (await saveJsonFile(`${name}.mimiamp.json`, data)) M().toast('Mimiamp', 'บันทึก playlist แล้ว');
    } catch (error) {
      M().toast('Mimiamp', `ส่งออกไม่ได้: ${error.message || error}`, true);
    }
  }

  async function importPlaylist() {
    let text = '';
    try {
      if (typeof window.showOpenFilePicker === 'function') {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: 'Mimiamp playlist', accept: { 'application/json': ['.json'] } }],
        });
        const file = await handle.getFile();
        text = await file.text();
      } else {
        text = await new Promise((resolve, reject) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'application/json,.json';
          input.onchange = async () => {
            const file = input.files && input.files[0];
            if (!file) return reject(new Error('ไม่ได้เลือกไฟล์'));
            resolve(await file.text());
          };
          input.click();
        });
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('ไฟล์ไม่ใช่ JSON ที่ถูกต้อง');
      }
      const data = await apiJson('/api/mimiamp/import', { method: 'POST', body: JSON.stringify({ playlist: parsed }) });
      await loadState(true);
      activeList = data.playlist.id;
      M().store.set(ACTIVE_LIST_KEY, activeList);
      renderLibrary();
      paintState();
      M().toast('Mimiamp', `นำเข้า playlist “${data.playlist.name}” แล้ว`);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      M().toast('Mimiamp', `นำเข้าไม่ได้: ${error.message || error}`, true);
    }
  }

  async function applyCommand(command) {
    if (!command || !command.action) return;
    if (libraryState === 'idle' || libraryState === 'error') await loadState();
    if (command.action === 'refresh') {
      await loadState(true);
      return;
    }
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
    if (command.action === 'playlist-play') {
      const playlist = playlists.find((entry) => entry.id === command.query) || playlists.find((entry) => entry.name === command.query);
      if (!playlist) return;
      activeList = playlist.id;
      M().store.set(ACTIVE_LIST_KEY, activeList);
      renderLibrary();
      if (playlist.items.length === 0) {
        M().toast('Mimiamp', `“${playlist.name}” ยังไม่มีเพลง`, true);
        return;
      }
      await playAt(0);
      return;
    }
    if (command.action === 'play') {
      if (command.query) {
        const wanted = String(command.query).toLowerCase();
        const queue = queueEntries();
        let found = queue.find(
          (entry) =>
            entry.id === command.query ||
            [entry.title, entry.artist, entry.album, entry.file, entry.videoId, entry.id]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase() === wanted),
        );
        if (!found) {
          found = queue.find((entry) =>
            [entry.title, entry.artist, entry.album, entry.file, entry.videoId, entry.id]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase().includes(wanted)),
          );
        }
        if (!found) {
          await loadState(true);
          const refreshed = queueEntries();
          found = refreshed.find((entry) =>
            [entry.id, entry.title, entry.artist, entry.album, entry.file, entry.videoId]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase() === wanted),
          );
        }
        if (!found) {
          found = tracks.find((entry) =>
            [entry.id, entry.title, entry.artist, entry.album, entry.file, entry.videoId]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase() === wanted),
          ) || localTracks.find((entry) =>
            [entry.id, entry.title, entry.artist, entry.file]
              .filter(Boolean)
              .some((value) => String(value).toLowerCase() === wanted),
          );
          if (found) {
            activeList = 'library';
            M().store.set(ACTIVE_LIST_KEY, activeList);
            renderLibrary();
          }
        }
        if (found) {
          const at = queueEntries().findIndex((entry) => entry.id === found.id);
          await playEntry(found);
          if (at >= 0) queueIndex = at;
        }
        return;
      }
      await playEntry(current || queueEntries()[0]);
    }
  }

  function onMessage(message) {
    if (!message || message.type !== 'mimiamp') return;
    void applyCommand(message.command);
  }

  function render() {
    build();
    if (libraryState === 'idle') loadState();
    ensureLocalTracks();
    paintState();
    paintTime();
    paintPip();
    drawVisOnce();
    if (isPlaying()) startVis();
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

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (visRaf) cancelAnimationFrame(visRaf);
      visRaf = 0;
    } else if (openView && isPlaying()) {
      startVis();
    }
  });

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.mimiamp = { render, onView, onMessage };
  void channelTimer;
})();
