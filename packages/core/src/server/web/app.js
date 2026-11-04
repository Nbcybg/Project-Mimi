(() => {
  'use strict';

  // ---------- basics ----------
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'mimi-token';
  const CHAT_KEY = 'mimi-chat';
  // Behind the accounts gateway: the path its webhooks start with (`/h/<id>`) for this account.
  const WEBHOOK_KEY = 'mimi-webhook-base';
  // True when the server is the accounts gateway: sign in with username + password.
  let accountsMode = false;

  // The token may arrive in the URL fragment; keep it out of the address bar and history.
  // Only the desktop app (which puts it there itself) or a one-person core may hand one over
  // this way: on the accounts gateway, a link carrying someone else's session would sign this
  // person into that account and send their chats to it. Which kind of server it is, /health says.
  let linkToken = new URLSearchParams(location.hash.slice(1)).get('token');
  if (linkToken) {
    history.replaceState(null, '', location.pathname + location.search);
    if (window.MimiDesktop) {
      localStorage.setItem(TOKEN_KEY, linkToken);
      linkToken = null;
    }
  }
  // The app is designed for mobile mode: a window up to 820px wide, one pane at a time (the
  // native window opens at phone size). Wider windows are desktop mode: the chat list sits beside the chat.
  const MOBILE_MAX = 820;
  const modeNow = () => (window.innerWidth <= MOBILE_MAX ? 'mobile' : 'desktop');
  document.documentElement.dataset.mode = modeNow();
  // Screen settings the user's devices share through the server (character position, chat
  // over the character, sounds, read-aloud, language); the rest stays on this device.
  const SYNCED_KEYS = new Set(['mimi.setupDone', 'mimi.chatSound', 'mimi.notifySound', 'mimi.autoSpeak', 'mimi.lang', 'mimi.theme', 'mimi.textSize']);
  // Per-chat screen settings (chat setting → หน้าตา) travel with the account, so a phone and a
  // PC opening the same chat look the same. The pattern also covers pictures/backgrounds.
  const CHAT_PREF_KEY = /^mimi\.chat\.-?\d+\.(textSize|bubbles|character|theme|background|backgroundRules)$/;
  // Node presets (Hub → Node) are shared too, one key each (feature-tools.js).
  const synced = (key) => SYNCED_KEYS.has(key) || CHAT_PREF_KEY.test(key) || /^mimi\.(view|bubbles|character|nodePreset)\./.test(key);
  const store = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // private window: not remembered
      }
      if (synced(key)) syncUi({ [key]: value });
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {
        // private window: nothing to remove
      }
      if (synced(key)) syncUi({ [key]: null });
    },
  };
  /** A per-chat override of a screen setting, with a global fallback. Chats remember their own look. */
  function chatPref(key, fallback) {
    if (state.chat) {
      const value = store.get(`mimi.chat.${state.chat.id}.${key}`);
      if (value !== null) return value;
    }
    return fallback();
  }
  /** Whether this chat has its own override of `key` (so it can be cleared). */
  const chatHasPref = (key) => Boolean(state.chat && store.get(`mimi.chat.${state.chat.id}.${key}`) !== null);
  const clearChatPref = (key) => {
    if (!state.chat) return;
    store.remove(`mimi.chat.${state.chat.id}.${key}`);
    renderHeader();
    renderRail();
  };
  /** How much of the chat shows over the character: 0 none, 1 the two newest messages, 2 all (the usual). Per mode, with a per-chat override. */
  const bubbleLevel = () => {
    const saved = chatPref('bubbles', () => store.get(`mimi.bubbles.${modeNow()}`));
    if (saved === null) return 2;
    const level = Number(saved);
    return level === 0 || level === 1 ? level : 2;
  };
  /** The character on the chat stage can be switched off (to read more of the chat); remembered per chat, else per mode. */
  const characterOn = () => chatPref('character', () => store.get(`mimi.character.${modeNow()}`)) !== '0';
  /** Text size of the chat, per chat with a per-device default: 0 small, 1 normal, 2 large. */
  const textSize = () => {
    const saved = chatPref('textSize', () => store.get('mimi.textSize'));
    if (saved === null) return 1;
    const level = Number(saved);
    return level === 0 || level === 2 ? level : 1;
  };
  const applyTextSize = () => {
    const next = String(textSize());
    if (document.documentElement.dataset.text === next) return;
    // Re-layout changes the height of every message. Keep the reader where they were:
    // the same distance from the newest message, or at the bottom when they followed it.
    const key = `text:${state.chat ? state.chat.id : 'app'}:${next}`;
    const keep = captureLogScroll();
    document.documentElement.dataset.text = next;
    restoreLogScroll(LOG_SCROLL_MEMO.get(key) ?? keep);
  };
  const APP_THEME_KEY = 'mimi.theme';
  const appTheme = () => (store.get(APP_THEME_KEY) === 'light' ? 'light' : 'dark');
  const chatTheme = () => {
    if (!state.chat) return null;
    const value = store.get(`mimi.chat.${state.chat.id}.theme`);
    return value === 'light' || value === 'dark' ? value : null;
  };
  function applyTheme() {
    const theme = (state.view === 'chat' && chatTheme()) || appTheme();
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'light' ? '#f8ebf0' : '#171215';
    const scheme = document.querySelector('meta[name="color-scheme"]');
    if (scheme) scheme.content = theme;
  }
  function setAppTheme(theme) {
    store.set(APP_THEME_KEY, theme === 'light' ? 'light' : 'dark');
    applyTheme();
    renderSettings();
    renderRail();
  }
  function setChatTheme(theme) {
    if (!state.chat) return;
    const key = `mimi.chat.${state.chat.id}.theme`;
    if (theme === 'light' || theme === 'dark') store.set(key, theme);
    else store.remove(key);
    applyTheme();
    renderRail();
  }
  /** Tray window: tool calls and other details are hidden unless "แสดง prompt" is on. */
  let showPrompt = false;
  try {
    showPrompt = localStorage.getItem('mimi.showPrompt') === '1';
  } catch {
    // private window: the default
  }
  if (showPrompt) document.documentElement.classList.add('show-prompt');
  // "Not my device" keeps the sign-in for this tab only (sessionStorage); otherwise it is remembered.
  const token = () => sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '';
  function keepSignIn(value, webhook = '', username = '') {
    const store = $('gate-shared').checked ? sessionStorage : localStorage;
    store.setItem(TOKEN_KEY, value);
    store.setItem(WEBHOOK_KEY, webhook);
    // Inside the desktop app: it keeps the token in the OS keychain (or nowhere, on a shared device).
    window.MimiDesktop?.signedIn({ token: value, username, remember: !$('gate-shared').checked });
    // Inside the Android app: its home-screen widget reads the newest chats with the same token.
    window.MimiAndroid?.signedIn(value);
  }
  const webhookBase = () => sessionStorage.getItem(WEBHOOK_KEY) ?? localStorage.getItem(WEBHOOK_KEY) ?? '';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    if (tag === 'button') node.type = 'button';
    return node;
  }
  function button(className, text, onClick, title) {
    const node = el('button', className, text);
    node.onclick = onClick;
    if (title) node.title = title;
    return node;
  }
  function svg(path) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }
  const ICONS = {
    clip: svg('<path d="M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l8.9-8.9a3.7 3.7 0 015.2 5.2l-8.9 8.9a1.8 1.8 0 01-2.6-2.6l8.2-8.2"/>'),
    mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>'),
    send: svg('<path d="M4 12l16-8-6 16-3-6.5z"/>'),
    stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>'),
    settings: svg('<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>'),
    back: svg('<path d="M15 5l-7 7 7 7"/>'),
  };
  $('attach').innerHTML = ICONS.clip;
  $('mic').innerHTML = ICONS.mic;
  $('send').innerHTML = ICONS.send;
  $('stop').innerHTML = ICONS.stop;

  const localeNow = () => (window.MimiI18n?.current() === 'th' ? 'th-TH' : 'en-GB');
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString(localeNow(), { hour: '2-digit', minute: '2-digit' });
  function fmtDay(iso) {
    const date = new Date(iso);
    return date.toDateString() === new Date().toDateString()
      ? fmtTime(iso)
      : date.toLocaleDateString(localeNow(), { day: 'numeric', month: 'short' });
  }
  const fmtDate = (iso) => new Date(iso).toLocaleString(localeNow(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtSize = (bytes) =>
    bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

  // A reply may start with one line of voice direction, e.g.
  // [emotion: เศร้า][tone: กระซิบ]. It is hidden from the text and shown as a badge;
  // the same fields drive the speech provider.
  const SPEECH_KEYS = new Set(['emotion', 'tone', 'voice', 'speed']);
  const SPEECH_TAG = /\[([a-z]+)\s*:\s*([^\]\n]*)\]/gi;
  function parseSpeech(text, live = false) {
    const source = String(text || '');
    const end = source.indexOf('\n');
    const line = end === -1 ? source : source.slice(0, end);
    const tags = [...line.matchAll(SPEECH_TAG)];
    if (live && end === -1 && /^\s*\[(?:emotion|tone|voice|speed)\b/i.test(line)) {
      const speech = speechOf(tags);
      return { text: '', speech };
    }
    if (tags.length === 0 || tags.some((tag) => !SPEECH_KEYS.has(tag[1].toLowerCase()))) return { text: source };
    if (line.replace(/\[([a-z]+)\s*:\s*([^\]\n]*)\]/gi, '').trim()) return { text: source };
    const speech = speechOf(tags);
    if (!speech) return { text: source };
    return { text: source.slice(end === -1 ? source.length : end + 1), speech };
  }
  function speechOf(tags) {
    const speech = {};
    for (const tag of tags) {
      const key = tag[1].toLowerCase();
      const value = tag[2].trim();
      if (!SPEECH_KEYS.has(key) || !value) continue;
      if (key === 'speed') {
        const speed = Number(value);
        if (Number.isFinite(speed)) speech.speed = Math.min(2, Math.max(0.5, speed));
      } else if (speech[key] === undefined) {
        speech[key] = value.slice(0, 80);
      }
    }
    return Object.keys(speech).length > 0 ? speech : null;
  }
  function speechBadge(speech) {
    if (!speech) return null;
    const row = el('div', 'speechmeta');
    for (const [key, label] of [['emotion', t('speech.emotion')], ['tone', t('speech.tone')], ['voice', t('speech.voice')], ['speed', t('speech.speed')]]) {
      if (speech[key] === undefined) continue;
      row.append(el('span', '', `${label}: ${key === 'speed' ? `${speech[key]}×` : speech[key]}`));
    }
    if (row.children.length === 0) return null;
    row.title = t('speech.title');
    return row;
  }

  function preview(value, limit = 160) {
    const text = (typeof value === 'string' ? value : JSON.stringify(value) || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }
  function toast(title, body, bad, onClick) {
    const node = el('div', `toast${bad ? ' bad' : ''}${onClick ? ' link' : ''}`);
    node.append(el('b', '', title));
    if (body) node.append(document.createTextNode(body));
    if (onClick) {
      node.onclick = () => {
        node.remove();
        onClick();
      };
    }
    $('toasts').append(node);
    setTimeout(() => node.remove(), bad ? 14000 : 9000);
  }

  // Files and pictures need the token, which an <img src> cannot send: fetch, then use an object URL.
  const api = (path, init = {}) =>
    fetch(path, { ...init, headers: { authorization: `Bearer ${token()}`, ...(init.headers || {}) } });
  const blobs = new Map();
  function blobUrl(path) {
    if (!blobs.has(path)) {
      const loading = api(path)
        .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((blob) => URL.createObjectURL(blob));
      loading.catch(() => blobs.delete(path));
      blobs.set(path, loading);
    }
    return blobs.get(path);
  }

  // ---------- state ----------
  const state = {
    view: 'chat',
    chats: [],
    agents: [],
    overseer: null,
    gotOverseer: false,
    tools: [],
    toolPresets: [],
    toolCustom: [],
    toolSecretKeys: {},
    connectors: [],
    connections: null,
    workflows: [],
    workflowPool: [],
    nodeTypes: [],
    secrets: [],
    defaultAgent: null,
    settings: null,
    skills: [],
    triggers: [],
    memory: [],
    chat: null,
    session: null,
    sessions: [],
    latest: true,
    railOpen: window.innerWidth <= 1180 ? false : store.get('mimi.rail') === null ? window.innerWidth >= 1480 : store.get('mimi.rail') === '1',
    pins: [],
    /** Chats with a turn running right now (they run in parallel). */
    busyChats: new Set(),
    /** Per chat: the agent that is answering there. */
    typingByChat: new Map(),
    /** Chats whose recordings are being turned into text before the agent answers. */
    transcribing: new Set(),
    /** Chats where the agent is looking at pictures before it answers. */
    viewing: new Set(),
    /** Per chat: a handoff that just happened, so the header can name the agent taking over. */
    handoffByChat: new Map(),
    /** Per chat: the agent or skill a working agent delegated a part of the turn to. */
    subByChat: new Map(),
    /** Your own messages shown right after sending, until the server echoes them. */
    pendingEchoes: [],
    /** The conversation currently on screen, to merge updates instead of re-rendering (no flash). */
    historyKey: null,
    historyIds: [],
    /** The session on screen has older pages the top of the log fetches as it is reached. */
    hasOlder: false,
    loadingOlder: false,
    staged: [],
    /** True while staged files are being uploaded on send. */
    sending: false,
    pendingPerms: new Map(),
    highlight: null,
    booted: false,
  };
  const ui = { agent: null, agentDirty: false, hubTab: 'models', railTab: 'status', settingsTab: 'profile', preset: null, presetDirty: false, skill: null, skillDirty: false, toolDirty: false, providerDirty: false, triggerDirty: false, workflowDirty: false, memory: null, overseerDirty: false };

  let socket = null;
  let retryMs = 1000;
  /** The Android app tells the page when it goes to the background; a WebView can keep reporting "visible". */
  let appVisible = true;
  const pageVisible = () => appVisible && document.visibilityState === 'visible';
  window.__mimiSetVisible = (visible) => {
    appVisible = visible !== false;
    reportPresence();
  };
  /** Hands changed shared settings to the server, which passes them on to the other devices. */
  function syncUi(values) {
    if (socket && socket.readyState === WebSocket.OPEN) send({ type: 'ui-set', values });
  }
  /**
   * Shared settings from the server: they replace this device's. On connecting (`hello`), what
   * this device has and the server does not yet goes up, so the first device seeds the rest.
   */
  function takeUi(values, hello) {
    const changed = [];
    for (const [key, value] of Object.entries(values)) {
      if (!synced(key)) continue;
      try {
        if (localStorage.getItem(key) === value) continue;
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
        changed.push(key);
      } catch {
        // storage blocked: this device keeps its defaults
      }
    }
    if (hello) {
      const missing = {};
      try {
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (synced(key) && !(key in values)) missing[key] = localStorage.getItem(key);
        }
      } catch {
        // storage blocked: nothing to hand up
      }
      if (Object.keys(missing).length > 0) syncUi(missing);
    }
    if (changed.length === 0) return;
    if (changed.some((key) => key.startsWith('mimi.nodePreset.'))) window.MimiHooks?.tools?.rerender?.();
    renderHeader();
    renderRail();
    window.MimiHooks?.stage?.refresh();
  }
  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    else toast('ยังไม่ได้เชื่อมต่อ', 'กำลังเชื่อมต่อใหม่ ลองอีกครั้งในอีกสักครู่', true);
  }

  // Full views of the messages on screen, so reply/forward can reuse them (feature-chat.js).
  const messageStore = new Map();
  /** What the next send answers: { id, text, agent } or null (feature-chat.js sets it). */
  const compose = { replyTo: null };
  /** The last day divider written into the log, to keep date changes readable. */
  let lastDay = null;

  // ---------- agents ----------
  const COLORS = ['#e08aa7', '#7db3e8', '#74c991', '#b49cf0', '#dfb25a', '#e88fb4', '#6fc7c2'];
  const agentOf = (name) => state.agents.find((agent) => agent.name === name);
  const nameOf = (name) => (agentOf(name) && agentOf(name).displayName) || name;
  function colorOf(name) {
    const index = state.agents.findIndex((agent) => agent.name === name);
    return COLORS[(index < 0 ? name.length : index) % COLORS.length];
  }
  function avatar(name, size) {
    const node = el('span', `av${size ? ` ${size}` : ''}`, (nameOf(name)[0] || '?').toUpperCase());
    node.style.setProperty('--c', colorOf(name));
    const agent = agentOf(name);
    // An agent without an avatar still shows a face: its first emoji sprite, else its portrait.
    // Uploaded sprites then appear at once in the chat list and headers, not only on the stage.
    const sprite = agent && Object.entries(agent.sprites || {})[0];
    const picture = agent && agent.avatar
      ? `/api/agent-image/${encodeURIComponent(name)}/avatar?v=${agent.avatar}`
      : sprite
        ? `/api/sprite/agent/${encodeURIComponent(name)}/${sprite[0]}?v=${sprite[1]}`
        : agent && agent.portrait
          ? `/api/agent-image/${encodeURIComponent(name)}/portrait?v=${agent.portrait}`
          : null;
    if (picture) {
      blobUrl(picture)
        .then((url) => {
          const image = el('img');
          image.alt = '';
          image.src = url;
          node.replaceChildren(image);
        })
        .catch(() => {});
    }
    return node;
  }
  function avatarStack(names, size) {
    const stack = el('span', 'stack');
    stack.append(...names.map((name) => avatar(name, size)));
    return stack;
  }
  const chatTitle = (chat) =>
    chat.kind === 'direct' ? nameOf(chat.agents[0]) : chat.title || chat.agents.map(nameOf).join(', ');

  // ---------- text ----------
  const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(https?:\/\/[^\s<>"')\]]+)|(@[\p{L}\p{M}\p{N}_-]+)/gu;
  /** The longest agent label `word` starts with (so "@มีมี่ว่าไง" still highlights "@มีมี่"). */
  function mentionLength(word) {
    const lower = word.toLowerCase();
    let best = 0;
    for (const agent of state.agents) {
      for (const label of [agent.name, agent.displayName]) {
        if (label && lower.startsWith(label.toLowerCase()) && label.length > best) best = label.length;
      }
    }
    for (const label of ['all', 'everyone', 'ทุกคน']) if (lower.startsWith(label) && label.length > best) best = label.length;
    return best;
  }
  function inline(node, text) {
    let last = 0;
    for (const match of text.matchAll(INLINE)) {
      if (match.index > last) node.append(text.slice(last, match.index));
      const part = match[0];
      if (match[1]) node.append(el('code', '', part.slice(1, -1)));
      else if (match[2]) node.append(el('b', '', part.slice(2, -2)));
      else if (match[3]) node.append(el('span', 'act', part.slice(1, -1)));
      else if (match[4]) {
        const link = el('a', '', part);
        link.href = part;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        node.append(link);
      } else {
        const length = mentionLength(part.slice(1));
        if (length > 0) node.append(el('span', 'at', part.slice(0, length + 1)), part.slice(length + 1));
        else node.append(part);
      }
      last = match.index + part.length;
    }
    if (last < text.length) node.append(text.slice(last));
  }
  /** Renders message text as DOM nodes (never as HTML): code blocks, inline code, bold, *actions*, links, @mentions. */
  // ---------- read aloud (the browser's own voices; Edge has natural Thai ones) ----------
  const SPEAK_KEY = 'mimi.autoSpeak';
  const autoSpeak = () => {
    try {
      return localStorage.getItem(SPEAK_KEY) === '1';
    } catch {
      return false;
    }
  };
  /** Markdown and links out, so the voice reads words, not symbols. */
  const speakable = (text) =>
    String(text || '')
      .replace(/```[\s\S]*?```/g, ' (โค้ด) ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\[(?:emotion|tone|voice|speed)\s*:[^\]]*\]/gi, ' ')
      .replace(/https?:\/\/\S+/g, ' (ลิงก์) ')
      .replace(/[*_#>`|~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  function speak(text, speech) {
    if (!('speechSynthesis' in window)) return toast('อ่านออกเสียงไม่ได้', 'เบราว์เซอร์นี้ไม่มีเสียงอ่าน', true);
    const words = speakable(text);
    if (!words) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(words.slice(0, 4000));
    utterance.lang = /[\u0E00-\u0E7F]/.test(words) ? 'th-TH' : 'en-US';
    if (speech && Number.isFinite(speech.speed)) utterance.rate = speech.speed;
    const voices = window.speechSynthesis.getVoices().filter((voice) => voice.lang.replace('_', '-').toLowerCase().startsWith(utterance.lang.slice(0, 2).toLowerCase()));
    const wanted = speech && speech.voice ? speech.voice.toLowerCase() : '';
    const voice = (wanted && voices.find((entry) => entry.name.toLowerCase().includes(wanted))) || voices.find((entry) => /natural|online|neural/i.test(entry.name)) || voices[0];
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }
  /**
   * The small speaker on a bubble only exists once read-aloud is enabled in Settings:
   * without that switch there is no configured voice, so the button would go nowhere.
   */
  function speakButton(text, speech) {
    if (!autoSpeak() || !('speechSynthesis' in window)) return null;
    return button('speak', '🔊', () => speak(text, speech), 'อ่านออกเสียง');
  }

  function renderText(node, text, speech) {
    node.replaceChildren();
    const badge = speechBadge(speech);
    if (badge) node.append(badge);
    text.split(/```(?:[\w-]*\n)?([\s\S]*?)```/g).forEach((part, index) => {
      // Blank lines next to a code block would only add empty space around it.
      if (index % 2) node.append(el('pre', '', part.replace(/\n$/, '')));
      else inline(node, (index === 0 ? part : part.replace(/^\n+/, '')).replace(/\n+$/, ''));
    });
  }

  // ---------- chat list ----------
  /** The chat list shows one-to-one chats or groups, like the two tabs of a messenger. */
  let chatListKind = store.get('mimi.chatListKind') === 'group' ? 'group' : 'direct';
  function renderChatList() {
    const groups = state.chats.filter((chat) => chat.kind === 'group');
    // A group that is open (or has news) brings its tab forward the first time it shows up.
    if (state.chat && state.chat.kind !== chatListKind && !renderChatList.userPicked) chatListKind = state.chat.kind;
    const seg = el('div', 'seg chatkind');
    for (const [kind, label] of [['direct', 'ตัวต่อตัว'], ['group', 'กลุ่ม']]) {
      const unread = state.chats.filter((chat) => chat.kind === kind && chat.unread && !(state.chat && state.chat.id === chat.id)).length;
      const tab = button(chatListKind === kind ? 'on' : '', label, () => {
        chatListKind = kind;
        renderChatList.userPicked = true;
        store.set('mimi.chatListKind', kind);
        renderChatList();
      });
      if (kind === 'group' && groups.length > 0) tab.append(el('small', '', ` ${groups.length}`));
      if (unread > 0) tab.append(el('span', 'unread', String(unread)));
      seg.append(tab);
    }
    const nodes = state.chats.filter((chat) => chat.kind === chatListKind).map((chat) => {
      const busy = state.busyChats.has(chat.id);
      const typing = state.typingByChat.get(chat.id);
      const viewing = state.viewing.has(chat.id);
      const handoff = state.handoffByChat.get(chat.id);
      const sub = state.subByChat.get(chat.id);
      const row = button(`chat${state.chat && state.chat.id === chat.id ? ' on' : ''}`, null, () => openChat(chat.id));
      const middle = el('div');
      middle.style.minWidth = '0';
      const fallback = chat.kind === 'group' ? `กลุ่ม ${chat.agents.length} คน` : 'ยังไม่มีข้อความ';
      const active = state.transcribing.has(chat.id)
        ? 'กำลังถอดเสียง…'
        : viewing
          ? 'กำลังดูรูป…'
          : handoff
        ? `${nameOf(handoff.from)} → ${nameOf(handoff.to)}`
        : sub
          ? `${nameOf(sub.main)} → ${nameOf(sub.sub)}`
          : typing
            ? `${nameOf(typing)} กำลังตอบ…`
            : 'กำลังตอบ…';
      const titleLine = el('div', 't', chatTitle(chat));
      if (chat.kind === 'group') titleLine.append(el('small', 'count', ` ${chat.agents.length} คน`));
      middle.append(titleLine, el('div', `p${busy ? ' busy' : ''}`, busy ? active : chat.preview.replace(/[*`]/g, '') || fallback));
      const right = el('div', 'r');
      if (chat.unread && !(state.chat && state.chat.id === chat.id)) right.append(el('span', 'unread', 'ใหม่'));
      if (chat.lastMessageAt) right.append(el('span', '', fmtDay(chat.lastMessageAt)));
      row.append(
        chat.kind === 'direct' ? avatar(chat.agents[0]) : avatarStack(chat.agents.slice(0, 3), 'sm'),
        middle,
        right,
      );
      return row;
    });
    const fresh = state.agents.filter(
      (agent) => !state.chats.some((chat) => chat.kind === 'direct' && chat.agents[0] === agent.name),
    );
    if (chatListKind === 'group') {
      if (groups.length === 0) {
        nodes.push(el('div', 'empty', 'ยังไม่มีกลุ่ม — รวม agent หลายตัวไว้ในแชตเดียว ให้ถาม-ตอบ-แย้งกันเองได้'));
      }
      nodes.push(button('newgroup', '+ สร้างกลุ่มใหม่', () => newChatDialog('group')));
    } else if (fresh.length > 0) {
      nodes.push(el('div', 'side-head', 'เริ่มคุยกับ'));
      for (const agent of fresh) {
        const row = button('chat', null, () => startChat({ type: 'chat-create', kind: 'direct', agents: [agent.name] }));
        const middle = el('div');
        middle.style.minWidth = '0';
        middle.append(el('div', 't', nameOf(agent.name)), el('div', 'p', agent.description || 'แตะเพื่อเริ่มคุย'));
        row.append(avatar(agent.name), middle, el('div', 'r'));
        nodes.push(row);
      }
    }
    if (nodes.length === 0) nodes.push(el('div', 'empty', state.agents.length ? 'ยังไม่มีแชตตัวต่อตัว' : 'ยังไม่มี agent — ไปที่แท็บ Agent เพื่อสร้างตัวแรก'));
    $('chat-list').replaceChildren(seg, ...nodes);
    updateUnreadBadge();
  }
  /** A count on the chat-list buttons, so replies in another chat are visible while this one is open. */
  function updateUnreadBadge() {
    const count = state.chats.filter((chat) => chat.unread && !(state.chat && state.chat.id === chat.id)).length;
    const label = count > 9 ? '9+' : String(count);
    for (const node of [$('back'), $('nav')?.querySelector('[data-view="chat"]')]) {
      if (!node) continue;
      if (count > 0) node.dataset.unread = label;
      else delete node.dataset.unread;
    }
  }

  /** Shows the chat pane and asks the core for a chat (an existing one, or one to create). */
  function startChat(request) {
    setView('chat');
    $('app').classList.remove('show-side');
    send(request);
  }
  function openChat(chatId, sessionId, highlight) {
    state.highlight = highlight || null;
    state.loadingOlder = false;
    state.hasOlder = false;
    startChat({ type: 'chat-open', chatId, sessionId });
    localStorage.setItem(CHAT_KEY, String(chatId));
  }
  // ---------- swiping between direct chats ----------
  // A horizontal swipe over the chat goes to the previous / next direct chat in the
  // order of the chat list; a vertical drag still scrolls and controls still click.
  let swipeStart = null;
  const SWIPE_IGNORE = 'a, button, input, textarea, select, audio, video, .msgbar, .reactpick, .menu, .mention, .staged, .perm, .approval, .tool, .filechip, .speak, .quote';
  function swipeToChat(step) {
    if (!state.chat) return;
    const direct = state.chats.filter((chat) => chat.kind === 'direct');
    const at = direct.findIndex((chat) => chat.id === state.chat.id);
    if (at < 0 || direct.length < 2) return;
    const target = direct[(at + step + direct.length) % direct.length];
    if (!target || target.id === state.chat.id) return;
    openChat(target.id);
  }
  $('stage').addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) {
      swipeStart = null;
      return;
    }
    const touch = event.touches[0];
    swipeStart = event.target.closest(SWIPE_IGNORE) ? null : { x: touch.clientX, y: touch.clientY, at: Date.now() };
  }, { passive: true });
  $('stage').addEventListener('touchend', (event) => {
    if (!swipeStart) return;
    const touch = event.changedTouches[0];
    const start = swipeStart;
    swipeStart = null;
    if (!touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Date.now() - start.at > 800) return;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
    swipeToChat(dx < 0 ? 1 : -1);
  }, { passive: true });
  $('stage').addEventListener('touchcancel', () => {
    swipeStart = null;
  }, { passive: true });

  function emptyState() {
    const empty = el('div', 'welcome');
    empty.append(el('b', '', 'Mimi'), state.agents.some((agent) => agent.name !== 'overseer') ? 'เลือกแชตทางซ้าย หรือกด "+ ใหม่" เพื่อเริ่มคุย' : 'เริ่มจากเชื่อมต่อผู้ให้บริการโมเดลที่ "ตั้งค่า" แล้วสร้าง agent ตัวแรกที่แท็บ "Agent"');
    logInner.replaceChildren(empty);
    updateJump();
  }

  // ---------- log ----------
  const logBox = $('log');
  const logInner = $('log-inner');
  const jumpBottom = $('jump-bottom');
  const jumpCount = $('jump-count');
  /** Messages that arrived while the view was scrolled up (the badge on the go-to-bottom button). */
  let unseen = 0;
  /** The assistant block being streamed into right now. */
  let live = null;
  /** The streaming block's DOM node; it stays on screen after `live` ends, until the stored messages replace it. */
  let liveNode = null;
  /** A chat that changed while its turn was still streaming: reloaded once the turn ends. */
  let refreshAfterTurn = null;
  /** Pending coalesced re-render of the streaming text (one per frame, keeps typing smooth). */
  let liveFrame = null;
  const cards = new Map();
  const taskCards = new Map();
  /** Where the reader was for each display setting, so changing it back finds the same place. */
  const LOG_SCROLL_MEMO = new Map();
  /** The reader's place, measured from the newest message (and whether they were following it). */
  function captureLogScroll() {
    return {
      atBottom: pinned(),
      fromBottom: logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight,
    };
  }
  function restoreLogScroll(saved) {
    if (!saved) return;
    requestAnimationFrame(() => {
      if (saved.atBottom || followLog) {
        scrollDown();
        return;
      }
      const max = Math.max(0, logBox.scrollHeight - logBox.clientHeight);
      logBox.scrollTop = Math.max(0, Math.min(max, max - saved.fromBottom));
      updateLogFade();
      updateJump();
    });
  }

  const pinned = () => logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 140;
  /** Telegram-like: the arrow appears while the view is away from the newest message, with how many came in. */
  function updateJump() {
    const away = !pinned();
    jumpBottom.hidden = !away;
    jumpCount.hidden = unseen <= 0;
    jumpCount.textContent = unseen > 99 ? '99+' : String(unseen);
    jumpBottom.classList.toggle('has-new', unseen > 0);
  }
  function scrollDown() {
    logBox.scrollTop = logBox.scrollHeight;
    unseen = 0;
    updateLogFade();
    updateJump();
  }
  jumpBottom.onclick = () => {
    followLog = true;
    unseen = 0;
    logBox.scrollTo({ top: logBox.scrollHeight, behavior: 'smooth' });
    updateLogFade();
    updateJump();
  };
  /** In character mode the top edge fades only after the view scrolled away from the first message. */
  function updateLogFade() {
    logBox.classList.toggle('fade-top', logBox.scrollTop > 8 && logBox.scrollHeight > logBox.clientHeight + 24);
  }
  let followLog = true;
  logBox.addEventListener('scroll', () => {
    followLog = pinned();
    if (followLog) unseen = 0;
    updateLogFade();
    updateJump();
    // Lazy history: reaching the top asks for the next older page by itself.
    if (logBox.scrollTop < 80) loadOlder();
  }, { passive: true });
  function add(node) {
    const stick = pinned();
    // Only a message arriving now slides in; a history render or merge never replays it.
    if (node.matches?.('.gmsg, .row-user, .perm, .approval')) node.classList.add('arrive');
    logInner.append(node);
    if (stick) scrollDown();
    else if (node.matches?.('.gmsg, .row-user, .perm, .approval')) {
      unseen++;
      updateJump();
    }
    return node;
  }

  // The composer floats over the stage in mobile character mode; its measured height keeps the
  // log and the character cropped above it instead of running underneath the message box.
  const composer = document.querySelector('.composer');
  function measureComposer() {
    document.documentElement.style.setProperty('--composer-h', `${composer.offsetHeight}px`);
    // A taller box (more lines, a staged file) must not leave the newest bubble under it.
    if (followLog) requestAnimationFrame(scrollDown);
  }
  if (window.ResizeObserver) new ResizeObserver(measureComposer).observe(composer);
  else window.addEventListener('resize', measureComposer);
  measureComposer();

  function sessionDivider(session, automatic) {
    const node = el('div', 'divider');
    const label = el('span');
    label.append(el('b', '', automatic ? t('session.auto') : 'session'), ` · ${fmtDate(session.createdAt)}`);
    node.append(label);
    return node;
  }

  /** "วันนี้", "เมื่อวาน" or the date, for the day separators between messages. */
  function dayLabel(iso) {
    const date = new Date(iso);
    const startOf = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
    if (days === 0) return t('day.today');
    if (days === 1) return t('day.yesterday');
    return date.toLocaleDateString(localeNow(), { weekday: 'short', day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  }

  /** Puts a day divider into the log whenever the calendar day changes. */
  function ensureDay(container, iso) {
    const day = new Date(iso).toDateString();
    if (day === lastDay) return;
    lastDay = day;
    const node = el('div', 'day');
    node.dataset.day = day;
    node.append(el('span', '', dayLabel(iso)));
    container.append(node);
  }

  /** The small quoted header of a reply; clicking it scrolls to the original message. */
  function quoteNode(reply) {
    const quote = el('button', 'quote');
    const who = reply.role === 'user' ? 'คุณ' : nameOf(reply.agent);
    quote.append(el('b', '', who), el('span', '', reply.text || '(ข้อความ)'));
    quote.onclick = () => {
      const target = logInner.querySelector(`[data-id="${reply.id}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.animate([{ outline: '2px solid #e08aa7' }, { outline: '2px solid transparent' }], { duration: 1600 });
      }
    };
    return quote;
  }

  /**
   * In a group, who an agent answers: the agent who spoke just before it in the same turn (the
   * one who @-called it). After the user's own message there is no label: it answers the user.
   */
  function previousSpeaker() {
    const rows = logInner.children;
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index];
      if (row.classList.contains('row-user')) return null;
      if (row.classList.contains('gmsg')) return row.dataset.agent || null;
    }
    return null;
  }
  function assistantBlock(agent, iso, answers) {
    const node = el('div', 'gmsg');
    node.dataset.agent = agent;
    node.style.setProperty('--c', colorOf(agent));
    const right = el('div');
    right.style.minWidth = '0';
    const name = el('div', 'nm', nameOf(agent));
    if (state.chat && state.chat.kind === 'group') {
      if (iso) name.append(el('small', '', fmtTime(iso)));
      if (answers && answers !== agent) {
        const label = el('span', 'answers', `↩ ตอบ ${nameOf(answers)}`);
        label.style.setProperty('--c2', colorOf(answers));
        name.append(label);
      }
    }
    const body = el('div', 'body');
    right.append(name, body);
    node.append(avatar(agent), right);
    return { node, body, agent, bubble: null, raw: '', dots: null, nest: null, tools: new Map() };
  }
  /** Under a bubble: the reactions and pin of a stored message, and when it was sent. */
  function metaRow(message) {
    const row = el('div', 'mrow');
    if (message.id !== undefined) row.dataset.mrow = message.id;
    fillMeta(row, message);
    return row;
  }
  function fillMeta(row, message) {
    row.replaceChildren();
    const marks = window.MimiHooks?.chat?.marks;
    if (marks && message.id !== undefined) row.append(...marks(message));
    row.append(el('span', 'time', fmtTime(message.createdAt)));
  }
  /** A stored message's reactions or pin changed: its row under the bubble and its buttons follow. */
  function refreshMarks(message) {
    for (const row of logInner.querySelectorAll(`[data-mrow="${message.id}"]`)) fillMeta(row, message);
    window.MimiHooks?.chat?.refresh?.(message);
  }
  function dots() {
    const node = el('span', 'dots');
    node.append(el('i'), el('i'), el('i'));
    return node;
  }
  function toolRow(name, arg, running, risk) {
    const node = el('div', 'tool');
    const head = el('button', 'h');
    const status = el('span', `s${running ? ' run' : ''}`, running ? 'กำลังทำ…' : '');
    head.append(el('span', 'faint', '⚙'), el('span', 'n', name));
    if (risk && risk !== 'read') head.append(el('span', 'risk w', risk));
    head.append(el('span', 'arg', arg), status);
    node.append(head);
    let body = null;
    head.onclick = () => {
      if (body) body.hidden = !body.hidden;
    };
    return {
      node,
      finish(ok, output) {
        status.className = `s ${ok ? 'ok' : 'bad'}`;
        status.textContent = ok ? '�o" �1?�,��,��1؅,^' : '�o- �1,�,��1^�,��,3�1?�,��1؅,^';
        // Plans and checklists are meant to stay visible while the work runs.
        const visible = ['todo_write', 'todo_read', 'plan_set', 'plan_read'].includes(name);
        body = el('div', `b${visible ? ' checklist' : ''}`, String(output).slice(0, 4000));
        body.hidden = ok && !visible;
        node.append(body);
      },
    };
  }

  function fileIcon(name, kind) {
    const extension = (name.split('.').pop() || '').toLowerCase().slice(0, 4);
    const group = kind === 'audio' ? 'aud' : { xlsx: 'xls', docx: 'doc', markdown: 'md' }[extension] || extension;
    return el('span', `ficon ${group}`, (extension || 'file').toUpperCase());
  }
  async function download(file) {
    try {
      const link = el('a');
      link.href = await blobUrl(`/api/files/${file.id}`);
      link.download = file.name;
      link.click();
    } catch {
      toast('ดาวน์โหลดไม่สำเร็จ', file.name, true);
    }
  }
  /** Saves a file from an authenticated API route (CSV exports). */
  async function downloadFromApi(path, name) {
    try {
      const response = await api(path);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = el('a');
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      toast('ดาวน์โหลดไม่สำเร็จ', error.message, true);
    }
  }
  function lightbox(url) {
    if (!url) return;
    const box = el('div', 'lightbox');
    const image = el('img');
    image.src = url;
    image.alt = '';
    const close = () => {
      document.removeEventListener('keydown', onKey);
      box.remove();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    box.append(button('btn ghost lightbox-close', '✕', close, 'ปิด'), image);
    box.onclick = close;
    image.onerror = close;
    document.addEventListener('keydown', onKey);
    document.body.append(box);
  }
  function attachmentNodes(files) {
    const nodes = [];
    const images = files.filter((file) => file.kind === 'image' && !file.deletedAt);
    if (images.length > 0) {
      const album = el('div', `album${images.length === 1 ? ' one' : ''}`);
      // Telegram-style albums show one caption for the whole set when every picture has it.
      const shared = images.length > 1 && images[0].caption && images.every((file) => file.caption === images[0].caption)
        ? images[0].caption
        : '';
      for (const file of images) {
        const shot = el('div', 'shot');
        const image = el('img');
        image.alt = file.name;
        image.title = file.text ? `AI อธิบายรูป: ${file.text.slice(0, 500)}` : file.name;
        if (file.url) image.src = file.url;
        else blobUrl(`/api/files/${file.id}`)
          .then((url) => {
            image.src = url;
          })
          .catch(() => {});
        image.onclick = () => lightbox(image.src);
        // Keep the newest message in view when the picture arrives and takes its real height.
        image.onload = () => {
          if (logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < image.height + 220) scrollDown();
        };
        shot.append(image);
        if (file.caption && !shared) shot.append(el('div', 'cap', file.caption));
        album.append(shot);
      }
      if (shared) album.append(el('div', 'album-cap', shared));
      nodes.push(album);
    }
    for (const file of files.filter((entry) => entry.kind === 'audio' && !entry.deletedAt)) {
      const box = el('div', 'voice');
      const play = el('button', 'play');
      play.append(el('i', '', '▶'), el('span', '', `ข้อความเสียง · ${fmtSize(file.size)}`));
      play.onclick = async () => {
        try {
          const audio = el('audio');
          audio.controls = true;
          audio.src = file.url || await blobUrl(`/api/files/${file.id}`);
          play.replaceWith(audio);
          audio.play().catch(() => {});
        } catch {
          toast('เปิดไฟล์เสียงไม่ได้', file.name, true);
        }
      };
      box.append(play);
      if (file.text) {
        const transcript = el('div', 'tr');
        transcript.append(el('b', '', 'ถอดเสียง'), file.text);
        box.append(transcript);
      }
      nodes.push(box);
    }
    for (const file of files.filter((entry) => entry.kind === 'video' && !entry.deletedAt)) {
      const box = el('div', 'voice vid');
      const play = el('button', 'play');
      play.append(el('i', '', '▶'), el('span', '', `วิดีโอ · ${file.name} · ${fmtSize(file.size)}`));
      // Loaded on demand: a video can be 25 MB.
      play.onclick = async () => {
        try {
          const video = el('video');
          video.controls = true;
          video.playsInline = true;
          video.src = file.url || await blobUrl(`/api/files/${file.id}`);
          play.replaceWith(video);
          video.play().catch(() => {});
        } catch {
          toast('เปิดวิดีโอไม่ได้', file.name, true);
        }
      };
      box.append(play);
      if (file.text) {
        const seen = el('div', 'tr');
        seen.append(el('b', '', 'AI เห็นว่า'), file.text);
        box.append(seen);
      }
      nodes.push(box);
    }
    for (const file of files.filter((entry) => entry.kind === 'file' && !entry.deletedAt)) {
      const chip = button('filechip', null, () => download(file), file.text ? file.text.slice(0, 500) : file.name);
      const info = el('div');
      info.style.minWidth = '0';
      info.append(el('div', 'fname', file.name), el('div', 'fmeta', fmtSize(file.size)));
      chip.append(fileIcon(file.name, file.kind), info);
      nodes.push(chip);
    }
    // The bytes are gone after the retention period, but the row and caption stay.
    for (const file of files.filter((entry) => entry.deletedAt)) {
      const chip = el('div', 'filechip expired');
      const info = el('div');
      info.style.minWidth = '0';
      info.append(el('div', 'fname', file.name), el('div', 'fmeta', `ไฟล์หมดอายุ — ${file.caption || 'เก็บไว้ 7 วัน'}`));
      chip.append(fileIcon(file.name, file.kind), info);
      nodes.push(chip);
    }
    return nodes;
  }

  function userRow(message) {
    const row = el('div', 'row-user');
    row.dataset.id = message.id;
    // Only the local placeholder is pending: a stored echo carries the same clientId,
    // and marking it pending made renderPendingEchoes remove the real message.
    if (message.pendingStatus) row.dataset.pending = '1';
    row.dataset.role = 'user';
    const actions = el('div', 'acts');
    if (typeof message.id === 'number') {
      actions.append(
        button('', '↩ ย้อนกลับ', () => rewind(message), 'ย้อนบทสนทนากลับไปก่อนข้อความนี้ แล้วแก้ไขส่งใหม่ได้'),
      );
    }
    const column = el('div', 'col');
    if (state.chat && state.chat.kind === 'group') column.append(el('div', 'nm mine', 'คุณ'));
    if (message.forwardedFrom) {
      column.append(el('div', 'fwd', `↪ ส่งต่อจาก ${message.forwardedFrom.from}${message.forwardedFrom.chat ? ` · ${message.forwardedFrom.chat}` : ''}`));
    }
    if (message.replyTo) column.append(quoteNode(message.replyTo));
    column.append(...attachmentNodes(message.attachments || []));
    if (message.text) {
      const bubble = el('div', 'user');
      renderText(bubble, message.text);
      column.append(bubble);
    }
    if (message.pendingStatus) column.append(el('div', 'note pending-status', message.pendingStatus));
    column.append(metaRow(message));
    window.MimiHooks?.chat?.decorate?.(column, message);
    row.append(actions, column);
    return row;
  }

  /** Adds one stored message to `container`; consecutive steps of one agent share a block. */
  function appendStored(container, message, block) {
    ensureDay(container, message.createdAt);
    messageStore.set(message.id, message);
    if (message.role === 'user') {
      container.append(userRow(message));
      return null;
    }
    let target = block;
    if (!target || target.agent !== message.agent) {
      target = assistantBlock(message.agent, message.createdAt, block ? block.agent : null);
      container.append(target.node);
    }
    if (message.text) {
      const bubble = el('div', 'tx');
      bubble.dataset.id = message.id;
      bubble.dataset.role = 'assistant';
      bubble.dataset.agent = message.agent;
      renderText(bubble, message.text, message.speech);
      const speakControl = speakButton(message.text, message.speech);
      if (speakControl) bubble.append(speakControl);
      window.MimiHooks?.chat?.decorate?.(bubble, message);
      target.body.append(bubble, metaRow(message));
    }
    if (message.approval) target.body.append(approvalNode(message.approval));
    for (const tool of message.tools || []) target.body.append(toolRow(tool.name, tool.summary, false).node);
    // Files the agent sent (send_file, generate_image, ...) sit under the step that sent them.
    const files = message.attachments || [];
    if (files.length > 0) {
      const box = el('div', 'agentfiles');
      box.append(...attachmentNodes(files));
      target.body.append(box);
      if (!message.text) target.body.append(metaRow(message));
    }
    return target;
  }

  const APPROVAL_STATUS = {
    approved: '✓ อนุมัติแล้ว',
    rejected: '✕ ไม่อนุมัติ',
    timeout: '⏱ หมดเวลา — workflow ไปทาง "หมดเวลา"',
    expired: 'ยกเลิกแล้ว (แอปปิดหรือ run ถูกหยุดระหว่างรอ)',
  };

  /** The buttons under a workflow's approval question, or how it was answered. */
  function approvalNode(approval) {
    const box = el('div', `approval ${approval.status}`);
    box.append(el('div', 'faint', `workflow ${approval.workflow}`));
    if (approval.status !== 'pending') {
      box.append(el('b', '', APPROVAL_STATUS[approval.status] || approval.status));
      if (approval.note) box.append(el('div', 'faint', `หมายเหตุ: ${approval.note}`));
      return box;
    }
    const note = textInput('', 'หมายเหตุ (ไม่ใส่ก็ได้)');
    const decide = (approved) => {
      for (const control of box.querySelectorAll('button, input')) control.disabled = true;
      send({ type: 'approval-decide', id: approval.id, approved, note: note.value });
    };
    const actions = el('div', 'hstack');
    actions.append(button('btn pri', '✓ อนุมัติ', () => decide(true)), button('btn danger', '✕ ไม่อนุมัติ', () => decide(false)));
    box.append(note, actions, el('div', 'faint', `รอได้ถึง ${fmtDate(approval.expiresAt)}`));
    return box;
  }

  function renderLog(history) {
    live = null;
    liveNode = null;
    cards.clear();
    messageStore.clear();
    lastDay = null;
    unseen = 0;
    logInner.replaceChildren();
    if (!state.chat) return emptyState();
    state.historyKey = state.session ? `${state.chat.id}:${state.session.id}` : `${state.chat.id}:`;
    state.historyIds = history.messages.map((message) => message.id);
    state.hasOlder = Boolean(history.hasMore);
    state.loadingOlder = false;
    if (history.hasMore) logInner.append(olderLoader());
    else if (state.session) logInner.append(sessionDivider(state.session));
    if (history.messages.length === 0 && !history.hasMore) {
      const empty = el('div', 'welcome');
      empty.append(el('b', '', `คุยกับ ${chatTitle(state.chat)}`), 'พิมพ์ข้อความด้านล่างได้เลย ส่งรูป เสียง หรือไฟล์ก็ได้');
      logInner.append(empty);
    }
    let block = null;
    for (const message of history.messages) block = appendStored(logInner, message, block);
    pruneConfirmed(history.messages);
    for (const request of state.pendingPerms.values()) permissionCard(request);
    const target = state.highlight && logInner.querySelector(`[data-id="${state.highlight}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.animate([{ outline: '2px solid #e08aa7' }, { outline: '2px solid transparent' }], { duration: 2200 });
      updateJump();
    } else {
      scrollDown();
    }
    state.highlight = null;
    window.MimiHooks?.stage?.reset(history.messages);
  }
  /** The top of the log: a hint at first, then the "loading" line while the page is on its way. */
  function olderLoader() {
    const node = el('div', 'divider older-load');
    node.append(el('span', '', state.loadingOlder ? 'กำลังโหลดข้อความก่อนหน้า…' : 'เลื่อนขึ้นเพื่อดูข้อความก่อนหน้า'));
    return node;
  }
  /** Asks for the page before the oldest message on screen; the scroll handler calls this at the top. */
  function loadOlder() {
    if (!state.chat || !state.session || !state.hasOlder || state.loadingOlder) return;
    const first = state.historyIds[0];
    if (!first) return;
    state.loadingOlder = true;
    const loader = logInner.firstElementChild;
    if (loader && loader.classList.contains('older-load')) loader.replaceWith(olderLoader());
    send({ type: 'chat-open', chatId: state.chat.id, sessionId: state.session.id, beforeId: first });
    // A dropped answer must not leave the log stuck on "loading" forever.
    setTimeout(() => {
      if (!state.loadingOlder) return;
      state.loadingOlder = false;
      const stuck = logInner.firstElementChild;
      if (stuck && stuck.classList.contains('older-load')) stuck.replaceWith(olderLoader());
    }, 12_000);
  }
  function prependOlder(history) {
    state.loadingOlder = false;
    state.hasOlder = Boolean(history.hasMore);
    // The next page starts before the oldest message now on screen.
    state.historyIds = [...history.messages.map((message) => message.id), ...state.historyIds];
    const fragment = document.createDocumentFragment();
    if (history.hasMore) fragment.append(olderLoader());
    else if (state.session) fragment.append(sessionDivider(state.session));
    let block = null;
    // The older page starts a new stretch: reuse the day the current first divider shows,
    // so a divider is only added when the older stretch really begins on another day.
    const firstDay = logInner.querySelector('.day');
    lastDay = firstDay && firstDay.dataset.day ? firstDay.dataset.day : null;
    for (const message of history.messages) block = appendStored(fragment, message, block);
    const scrollBefore = logBox.scrollHeight;
    logInner.firstElementChild.remove();
    logInner.prepend(fragment);
    logBox.scrollTop += logBox.scrollHeight - scrollBefore;
  }

  /**
   * The same conversation is already on screen: only the messages that arrived since join it,
   * instead of rebuilding the whole log (which made the screen flash when a turn finished).
   */
  function mergeHistory(message, key, ids, from) {
    const fresh = message.messages.slice(from);
    if (liveFrame) {
      cancelAnimationFrame(liveFrame);
      liveFrame = null;
    }
    if (liveNode) {
      // The stored version of the streamed answer replaces the provisional bubble.
      liveNode.remove();
      liveNode = null;
      live = null;
    }
    // The usage / stop notes of the finished turn sit at the tail; they belong to it.
    for (const note of [...logInner.children].reverse()) {
      if (!note.classList || !note.classList.contains('note')) break;
      note.remove();
    }
    state.historyKey = key;
    state.historyIds = [...state.historyIds, ...ids.slice(from)];
    let block = null;
    for (const entry of fresh) block = appendStored(logInner, entry, block);
    pruneConfirmed(message.messages);
    renderLiveSnapshot(message.live, message.chat.id);
    renderPendingEchoes();
    if (followLog) scrollDown();
  }

  /** A turn still streaming: rebuilds its bubble, tool rows and permission cards so nothing is lost. */
  function renderLiveSnapshot(liveView, chatId) {
    if (!liveView) return;
    live = assistantBlock(liveView.agent, new Date().toISOString(), previousSpeaker());
    liveNode = live.node;
    add(live.node);
    if (liveView.text) {
      live.bubble = el('div', 'tx');
      live.raw = liveView.text;
      const parsed = parseSpeech(liveView.text, true);
      live.speech = parsed.speech || liveView.speech;
      renderText(live.bubble, parsed.text, live.speech);
      live.body.append(live.bubble, metaRow({ createdAt: new Date().toISOString() }));
    } else {
      think(true);
    }
    for (const tool of liveView.tools) {
      const row = toolRow(tool.name, tool.arg, tool.ok === null, tool.risk);
      live.tools.set(tool.id, row);
      if (tool.ok !== null) row.finish(tool.ok, tool.output);
      live.body.append(row.node);
    }
    for (const attachment of liveView.attachments) {
      const box = el('div', 'agentfiles');
      box.append(...attachmentNodes([attachment]));
      live.body.append(box);
    }
    for (const request of liveView.pendingPermissions) {
      state.pendingPerms.set(request.id, request);
      permissionCard(request);
    }
    state.typingByChat.set(chatId, liveView.agent);
  }

  function permissionCard(request) {
    if (cards.has(request.id)) return;
    const card = el('div', 'perm');
    card.append(
      el('div', 'ttl', `${nameOf(request.agent)} ขออนุญาตทำสิ่งนี้`),
      el('div', 'perm-summary', request.summary || `ใช้เครื่องมือ ${request.tool}`),
      el(
        'div',
        'faint',
        `${request.tool} · ${request.risk} · ขอเมื่อ ${request.createdAt ? fmtTime(request.createdAt) : 'ตอนนี้'} · รอได้ ${Math.max(1, Math.round((request.timeoutMs || 900000) / 60000))} นาที · session: ${state.session ? state.session.title || `#${state.session.id}` : '—'}`,
      ),
    );
    const details = el('details', 'perm-details');
    details.append(el('summary', '', 'รายละเอียด'), el('div', 'kv', JSON.stringify(request.input, null, 2)));
    card.append(details);
    const answer = (allow, scope) => send({ type: 'permission-response', requestId: request.id, allow, ...(scope ? { scope } : {}) });
    const allowTask = button('btn pri', 'อนุญาตทั้งงานนี้', () => answer(true, 'task'));
    const allowOnce = button('btn', 'ครั้งนี้', () => answer(true, 'once'));
    const allowSession = button('btn', 'ทั้ง session', () => answer(true, 'session'));
    const allowAlways = button('btn', 'ตลอดไป', () => answer(true, 'always'));
    const deny = button('btn', 'ปฏิเสธ', () => answer(false));
    const verdict = el('span', 'muted');
    const row = el('div', 'btns');
    if (request.noGrant) {
      card.append(el('div', 'faint', 'เครื่องมือนี้ต้องขออนุญาตทุกครั้ง: อนุญาตได้เฉพาะครั้งนี้เท่านั้น'));
      row.append(allowOnce, deny, verdict);
    } else {
      row.append(allowTask, allowOnce, allowSession, allowAlways, deny, verdict);
    }
    card.append(row);
    cards.set(request.id, { allowTask, allowOnce, allowSession, allowAlways, deny, verdict });
    if (live) {
      const stick = pinned();
      live.body.append(card);
      if (stick) scrollDown();
    } else {
      add(card);
    }
  }
  function resolveCard(requestId, decision) {
    state.pendingPerms.delete(requestId);
    const card = cards.get(requestId);
    if (!card) return;
    for (const control of [card.allowTask, card.allowOnce, card.allowSession, card.allowAlways, card.deny]) {
      if (control) control.disabled = true;
    }
    card.verdict.textContent = decision.allow ? 'อนุญาตแล้ว' : `ไม่อนุญาต (${decision.reason})`;
  }

  const TASK_STATUS = {
    queued: 'รอเริ่ม',
    running: 'กำลังทำ',
    awaiting_confirmation: 'รอยืนยัน',
    paused: 'พักอยู่',
    cancelled: 'ยกเลิกแล้ว',
    completed: 'เสร็จแล้ว',
    failed: 'ไม่สำเร็จ',
    undone: 'คืนไฟล์แล้ว',
  };
  const STEP_MARK = { pending: '•', running: '…', done: '✓', skipped: '–', failed: '✗', cancelled: '✗' };
  function taskCard(task) {
    let card = taskCards.get(task.id);
    if (!card) {
      const node = el('div', 'task');
      const head = el('div', 'task-head');
      const title = el('div', 'task-title');
      const status = el('span', 'task-status');
      const body = el('div', 'task-body');
      head.append(title, status);
      node.append(head, body);
      card = { node, title, status, body, task };
      taskCards.set(task.id, card);
      if (live) {
        const stick = pinned();
        live.body.append(node);
        if (stick) scrollDown();
      } else {
        add(node);
      }
    }
    card.task = { ...card.task, ...task };
    renderTask(card);
    return card;
  }
  function renderTask(card) {
    const task = card.task;
    card.title.replaceChildren(el('b', '', task.goal || task.recipe), el('span', 'faint', ` · ${task.recipe} · ${task.level}`));
    card.status.className = `task-status ${task.status}`;
    card.status.textContent = TASK_STATUS[task.status] || task.status;
    const parts = [];
    const steps = el('div', 'task-steps');
    for (const step of task.steps || []) {
      const row = el('div', `task-step ${step.status}`);
      row.append(el('span', 'mark', STEP_MARK[step.status] || '•'), el('span', 't', step.title));
      if (step.detail) row.append(el('div', 'd', step.detail));
      steps.append(row);
    }
    if (steps.childElementCount > 0) parts.push(steps);
    if (task.plan) {
      const box = el('div', 'task-plan');
      box.append(el('div', 'task-sub', `แผน · ${task.plan.total} ไฟล์ (ยังไม่มีการเปลี่ยนแปลง)`));
      for (const group of task.plan.groups) {
        const line = `${group.key} · ${group.count}`;
        box.append(el('div', 'task-group', group.examples.length > 0 ? `${line} — ${group.examples.join(', ')}` : line));
      }
      if (task.plan.skipped?.length > 0) {
        box.append(el('div', 'faint', `ข้าม ${task.plan.skipped.length} ไฟล์: ${task.plan.skipped.slice(0, 3).map((entry) => entry.name).join(', ')}${task.plan.skipped.length > 3 ? '…' : ''}`));
      }
      if (task.plan.deferred) box.append(el('div', 'faint', `เหลือ ${task.plan.deferred} ไฟล์สำหรับรอบถัดไป`));
      parts.push(box);
    }
    const receiptBlock = (receipt, label, withUndo) => {
      const box = el('div', 'task-receipt');
      box.append(el('div', 'task-sub', label), el('div', 'task-receipt-summary', receipt.summary));
      if (receipt.examples?.length > 0) box.append(el('div', 'faint', `ตัวอย่าง: ${receipt.examples.join(', ')}`));
      const actions = el('div', 'btns');
      if (withUndo && receipt.undoable) {
        const undo = button('btn', 'คืนไฟล์ทั้งหมด', () => {
          undo.disabled = true;
          send({ type: 'task-undo', taskId: task.id });
        });
        actions.append(undo);
      }
      if (task.verification) actions.append(el('span', 'faint', task.verification.ok ? '✓ ตรวจสอบแล้ว' : '✗ ตรวจสอบไม่ผ่าน'));
      if (actions.childElementCount > 0) box.append(actions);
      return box;
    };
    if (task.receipt) parts.push(receiptBlock(task.receipt, 'ใบเสร็จ', task.status === 'completed' || task.status === 'failed'));
    if (task.undoReceipt) parts.push(receiptBlock(task.undoReceipt, 'ผลการคืนไฟล์', false));
    const controls = el('div', 'btns');
    if (task.status === 'running' || task.status === 'awaiting_confirmation') {
      controls.append(button('btn', 'พัก', () => send({ type: 'task-control', taskId: task.id, action: 'pause' })));
      controls.append(button('btn', 'หยุดงาน', () => send({ type: 'task-control', taskId: task.id, action: 'cancel' })));
    } else if (task.status === 'paused') {
      controls.append(button('btn pri', 'ทำต่อ', () => send({ type: 'task-control', taskId: task.id, action: 'resume' })));
      controls.append(button('btn', 'ยกเลิก', () => send({ type: 'task-control', taskId: task.id, action: 'cancel' })));
    }
    if (controls.childElementCount > 0) parts.push(controls);
    card.body.replaceChildren(...parts);
  }

  const REASONS = {
    max_rounds: 'ครบจำนวนรอบสูงสุด',
    max_tokens: 'ใช้ token ครบงบ',
    trace_budget: 'ใช้งบของรอบนี้หมด',
    aborted: 'ถูกสั่งหยุด',
  };
  function subLine(agent, text) {
    if (!live) return;
    if (!live.nest || live.body.lastElementChild !== live.nest) {
      live.nest = el('div', 'nest');
      live.body.append(live.nest);
    }
    const line = el('div');
    line.append(el('b', '', `↳ ${agent} `), text);
    const stick = pinned();
    live.nest.append(line);
    if (stick) scrollDown();
  }
  function think(on) {
    if (!live) return;
    if (on && !live.dots) {
      live.dots = dots();
      live.body.append(live.dots);
    } else if (!on && live.dots) {
      live.dots.remove();
      live.dots = null;
    }
  }
  /** Re-renders the streaming text at most once per frame, so rapid chunks don't jank the phone. */
  function scheduleLiveRender() {
    if (liveFrame) return;
    liveFrame = requestAnimationFrame(() => {
      liveFrame = null;
      if (!live || !live.bubble) return;
      const parsed = parseSpeech(live.raw, true);
      if (parsed.speech) live.speech = parsed.speech;
      renderText(live.bubble, parsed.text, live.speech);
      window.MimiHooks?.stage?.onText(parsed.text);
      if (pinned()) scrollDown();
    });
  }
  /** `sub` is set when the event comes from an agent (or skill) working for the one that is answering. */
  function handleEvent(event, sub, chatId) {
    switch (event.type) {
      case 'agent-activity': {
        const known = state.subByChat.get(chatId);
        if (!known || known.sub !== event.agent) {
          state.subByChat.set(chatId, { main: state.typingByChat.get(chatId) || event.agent, sub: event.agent });
          renderHeader();
          renderChatList();
        }
        handleEvent(event.event, event.agent, chatId);
        break;
      }
      case 'run-start':
        if (sub) {
          subLine(sub, `เริ่มทำงาน (${event.model})`);
          break;
        }
        live = assistantBlock(event.agent, new Date().toISOString(), previousSpeaker());
        liveNode = live.node;
        add(live.node);
        think(true);
        state.handoffByChat.delete(chatId);
        state.subByChat.delete(chatId);
        state.typingByChat.set(chatId, event.agent);
        renderHeader();
        renderChatList();
        break;
      case 'text-delta': {
        if (sub || !live) break;
        think(false);
        if (!live.bubble) {
          live.bubble = el('div', 'tx');
          live.raw = '';
          live.speech = null;
          live.body.append(live.bubble, metaRow({ createdAt: new Date().toISOString() }));
        }
        live.raw += event.text;
        // Every chunk on its own frame would jank the phone; render once per frame.
        scheduleLiveRender();
        break;
      }
      case 'tool-call': {
        if (sub) {
          subLine(sub, `⚙ ${event.call.name} ${preview(event.call.input, 100)}`);
          break;
        }
        if (!live) break;
        think(false);
        live.bubble = null;
        const row = toolRow(event.call.name, preview(event.call.input, 220), true, event.risk);
        live.tools.set(event.call.id, row);
        const stick = pinned();
        live.body.append(row.node);
        if (stick) scrollDown();
        break;
      }
      case 'tool-result':
        if (sub) {
          subLine(sub, `${event.result.ok ? '✓' : '✗'} ${preview(event.result.output, 140)}`);
          break;
        }
        if (live && live.tools.has(event.result.callId)) live.tools.get(event.result.callId).finish(event.result.ok, event.result.output);
        think(true);
        break;
      case 'attachment': {
        if (sub) {
          subLine(sub, `📎 ${event.attachment.name}`);
          break;
        }
        if (!live) break;
        live.bubble = null;
        const box = el('div', 'agentfiles');
        box.append(...attachmentNodes([event.attachment]));
        const stick = pinned();
        live.body.append(box);
        if (stick) scrollDown();
        break;
      }
      case 'permission-request':
        // Remembered even while the user is in another chat, so the card is there when they return.
        state.pendingPerms.set(event.request.id, event.request);
        think(false);
        permissionCard(event.request);
        window.MimiHooks?.notify?.chatSound('ask');
        break;
      case 'permission-decision':
        resolveCard(event.requestId, event.decision);
        break;
      case 'task-start':
        if (sub) {
          subLine(sub, `งาน: ${event.task.goal || event.task.recipe}`);
          break;
        }
        taskCard(event.task);
        break;
      case 'task-update':
        if (sub) break;
        {
          const card = taskCards.get(event.task.id);
          if (card) {
            card.task = { ...card.task, ...event.task };
            renderTask(card);
          } else {
            taskCard(event.task);
          }
        }
        break;
      case 'task-step': {
        if (sub) {
          subLine(sub, `${STEP_MARK[event.step.status] || '•'} ${event.step.title}`);
          break;
        }
        const card = taskCards.get(event.taskId);
        if (card) {
          const steps = card.task.steps ? [...card.task.steps] : [];
          const at = steps.findIndex((step) => step.id === event.step.id);
          if (at >= 0) steps[at] = event.step;
          else steps.push(event.step);
          card.task = { ...card.task, steps };
          renderTask(card);
        }
        break;
      }
      case 'task-plan': {
        if (sub) break;
        const card = taskCards.get(event.taskId);
        if (card) {
          card.task = { ...card.task, plan: event.plan };
          renderTask(card);
        }
        break;
      }
      case 'task-receipt': {
        if (sub) break;
        const card = taskCards.get(event.taskId);
        if (card) {
          card.task = event.undo ? { ...card.task, undoReceipt: event.receipt } : { ...card.task, receipt: event.receipt };
          renderTask(card);
        }
        break;
      }
      case 'task-finish': {
        if (sub) {
          subLine(sub, `งานเสร็จ: ${TASK_STATUS[event.status] || event.status}`);
          break;
        }
        const card = taskCards.get(event.taskId);
        if (card) {
          card.task = { ...card.task, status: event.status, ...(event.receipt ? { receipt: event.receipt } : {}) };
          renderTask(card);
        }
        break;
      }
      case 'run-finish': {
        if (sub) {
          subLine(sub, `เสร็จ: ${preview(event.text || (event.error ? `[${event.errorCode || 'E-INTERNAL'}] ${event.error}` : event.reason), 160)}`);
          state.subByChat.delete(chatId);
          renderHeader();
          renderChatList();
          break;
        }
        think(false);
        if (liveFrame) {
          cancelAnimationFrame(liveFrame);
          liveFrame = null;
        }
        if (event.text && live && live.bubble) {
          const final = parseSpeech(event.text);
          renderText(live.bubble, final.text, event.speech || final.speech || live.speech);
          live.raw = final.text;
          window.MimiHooks?.stage?.onText(final.text);
        }
        if (event.reason === 'error') add(el('div', 'note bad', `ผิดพลาด [${event.errorCode || 'E-INTERNAL'}]: ${event.error}`));
        else if (!['stop', 'handoff'].includes(event.reason)) {
          add(el('div', 'note bad', `หยุด: ${REASONS[event.reason] || event.reason}${event.error ? ` — [${event.errorCode || 'E-INTERNAL'}] ${event.error}` : ''}`));
        }
        const usage = event.usage;
        const hit = usage.inputTokens ? Math.round((usage.cachedTokens / usage.inputTokens) * 100) : 0;
        add(el('div', 'note use', `${event.rounds} รอบ · in ${usage.inputTokens} (cache ${hit}%) · out ${usage.outputTokens} · $${usage.costUsd.toFixed(5)}`));
        if (event.reason === 'stop' && event.text && autoSpeak()) speak(event.text, event.speech);
        if (event.reason !== 'handoff') window.MimiHooks?.notify?.chatSound('done');
        if (event.reason === 'handoff' && event.handoff?.to) {
          // The next agent answers the user; say who took over until its first event arrives.
          const from = event.agent || state.typingByChat.get(chatId) || 'agent';
          state.handoffByChat.set(chatId, { from, to: event.handoff.to });
          state.typingByChat.set(chatId, event.handoff.to);
          if (!sub) add(el('div', 'note', `↪ ${nameOf(from)} ส่งต่อให้ ${nameOf(event.handoff.to)}`));
        } else {
          state.handoffByChat.delete(chatId);
          state.subByChat.delete(chatId);
          state.typingByChat.delete(chatId);
        }
        live = null;
        window.MimiAndroid?.refreshWidget?.();
        if (state.chat && state.chat.id === chatId) requestContext();
        renderHeader();
        renderChatList();
        break;
      }
    }
  }
  const showing = (chatId, sessionId) =>
    state.chat && state.chat.id === chatId && state.session && state.session.id === sessionId;

  function rewind(message) {
    if (!state.latest) return toast('ย้อนกลับได้เฉพาะใน session ล่าสุด');
    if (state.busyChats.has(state.chat.id)) return toast('รอให้ตอบเสร็จก่อน หรือกดหยุด แล้วค่อยย้อนกลับ');
    if (!confirm('ย้อนบทสนทนากลับไปก่อนข้อความนี้?\nข้อความนี้และทุกอย่างหลังจากนี้จะถูกซ่อน แล้วข้อความจะกลับมาอยู่ในช่องพิมพ์ให้แก้ไขส่งใหม่\n(ไฟล์ที่ agent แก้ไปแล้ว และสิ่งที่จำไว้แล้ว จะไม่ถูกย้อน)')) return;
    send({ type: 'rewind', sessionId: state.session.id, messageId: message.id });
  }

  // ---------- header, status, rail ----------
  const STATUS = [
    ['location', 'ที่อยู่'],
    ['outfit', 'ชุด'],
    ['current_task', 'กำลังทำ'],
    ['mood', 'อารมณ์'],
  ];
  /** A status line just above the composer: answering, transcribing, looking at pictures. */
  function typingChip() {
    let node = $('typing-chip');
    if (!node) {
      node = el('div', 'typing-chip bottom');
      node.id = 'typing-chip';
      node.setAttribute('role', 'status');
      node.hidden = true;
      const wrap = document.querySelector('.composer .wrap');
      wrap.insertBefore(node, $('box'));
    }
    return node;
  }
  /** The size of the open session: the percentage at the top and the panel in the chat settings. */
  const fmtTokens = (value) => (value >= 100000 ? `${Math.round(value / 1000)}k` : value.toLocaleString('en-US'));
  function currentContext() {
    const known = state.sessionContext;
    return known && state.chat && state.session && known.chatId === state.chat.id && known.sessionId === state.session.id ? known.context : null;
  }
  function requestContext() {
    if (state.chat && state.session) send({ type: 'session-context', chatId: state.chat.id, sessionId: state.session.id });
  }
  function renderContextMeter() {
    const box = $('ctx-box');
    const context = currentContext();
    box.hidden = !context || context.windowTokens <= 0;
    if (box.hidden) return;
    const pct = Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100));
    const compactAt = Math.round(((state.settings && state.settings.compactAt) || 0.65) * 100);
    $('ctx-meter').firstElementChild.style.width = `${pct}%`;
    $('ctx-meter').classList.toggle('warn', pct >= compactAt);
    $('ctx-pct').textContent = `${pct}%`;
    box.title = `context ${context.usedTokens.toLocaleString('en-US')} / ${context.windowTokens.toLocaleString('en-US')} token`;
  }
  /** "Context ของ session": how full it is, what it cost, and when it is summarized or replaced. */
  function contextPanel() {
    const context = currentContext();
    if (!context || context.windowTokens <= 0) return null;
    const pct = Math.min(100, (context.usedTokens / context.windowTokens) * 100);
    const compactAt = Math.round(((state.settings && state.settings.compactAt) || 0.65) * 100);
    const section = el('div', `ctxpanel${pct >= compactAt ? ' warn' : ''}`);
    section.append(el('h3', '', 'Context ของ session'));
    const bar = el('progress');
    bar.max = 100;
    bar.value = pct;
    const rows = [
      ['ใช้ไป', `${fmtTokens(context.usedTokens)} / ${fmtTokens(context.windowTokens)}`],
      ['cache hit', context.cacheHitPct === null ? '—' : `${context.cacheHitPct}%`],
      ['ค่าใช้จ่าย session นี้', `$${context.costUsd.toFixed(4)}`],
      ['สรุปอัตโนมัติเมื่อถึง', `${compactAt}%`],
      ['session ใหม่เมื่อคุยยาวถึง', context.maxTokens > 0 ? `${fmtTokens(context.conversationTokens)} / ${fmtTokens(context.maxTokens)}` : 'ไม่จำกัด'],
    ];
    const stat = el('div', 'stat');
    for (const [label, value] of rows) stat.append(el('span', '', label), el('span', '', value));
    section.append(bar, stat);
    return section;
  }

  function renderHeader() {
    const chat = state.chat;
    applyTheme();
    applyTextSize();
    const direct = chat && chat.kind === 'direct' ? agentOf(chat.agents[0]) : null;
    $('chat-avatars').replaceChildren(
      ...(chat ? chat.agents.slice(0, 4).map((name) => avatar(name, chat.kind === 'group' ? 'sm' : '')) : []),
    );
    $('chat-title').textContent = chat ? chatTitle(chat) : 'Mimi';
    // The tray window shows a one-to-one chat like a character-chat app (the stage is the screen).
    const showCharacter = characterOn();
    $('app').classList.toggle('solo', Boolean(direct && showCharacter));
    $('app').classList.toggle('char-off', Boolean(direct && !showCharacter));
    // A group shows the time beside each speaker's name, as in a group messenger.
    $('app').classList.toggle('grouped', Boolean(chat && chat.kind === 'group'));
    $('app').dataset.bubbles = direct && showCharacter ? bubbleLevel() : 2;
    $('toggle-char').hidden = !direct;
    $('toggle-char').classList.toggle('on', showCharacter);
    $('toggle-char').title = t(showCharacter ? 'setting.characterHide' : 'setting.characterShow');
    syncTopButtons();
    input.placeholder = direct
      ? t('composer.placeholderTo', { name: nameOf(direct.name) })
      : chat && chat.kind === 'group'
        ? 'พิมพ์ถึงทุกคน หรือ @ชื่อ เพื่อถามคนเดียว…'
        : t('composer.placeholder');
    const sub = $('chat-sub');
    const typingHere = chat ? state.typingByChat.get(chat.id) : null;
    const handoffHere = chat ? state.handoffByChat.get(chat.id) : null;
    const subHere = chat ? state.subByChat.get(chat.id) : null;
    const transcribingHere = chat ? state.transcribing.has(chat.id) : false;
    const viewingHere = chat ? state.viewing.has(chat.id) : false;
    const looks = [viewingHere ? 'กำลังดูรูป…' : '', transcribingHere ? 'กำลังถอดเสียง…' : ''].filter(Boolean);
    const active = looks.length > 0
      ? looks.join(' · ')
      : handoffHere
        ? `${nameOf(handoffHere.from)} กำลังส่งต่อให้ ${nameOf(handoffHere.to)}…`
        : subHere
          ? `${nameOf(subHere.main)} → ${nameOf(subHere.sub)} กำลังทำงาน…`
          : typingHere
            ? `${nameOf(typingHere)} กำลังตอบ…`
            : '';
    sub.className = 'sub';
    if (chat && chat.kind === 'group') {
      sub.className = 'sub pills';
      const members = el('span', 'tpill', `กลุ่ม · ${chat.agents.length} agent`);
      members.title = chat.agents.map(nameOf).join(', ');
      const shared = el('span', 'tpill soft', 'ทุกคนเห็นข้อความเดียวกัน');
      shared.title = 'ทุก agent ในกลุ่มอ่านทุกข้อความ · ความจำของแต่ละคนยังแยกกัน';
      sub.replaceChildren(members, shared);
    } else {
      sub.textContent = !chat ? '' : (direct && direct.description) || '';
    }
    const chip = typingChip();
    chip.hidden = !chat || !active;
    chip.textContent = active;

    const bar = $('statusbar');
    const chips = [];
    if (direct) {
      for (const [key, label] of STATUS) {
        const value = direct.status && direct.status[key];
        if (!value) continue;
        const chip = el('span', `st${key === 'mood' ? ' mood' : ''}`);
        // An outfit set by wardrobe id shows its name.
        const outfit = key === 'outfit' && (state.wardrobe || []).find((item) => item.id === value);
        chip.append(el('b', '', label), el('span', '', outfit ? `${outfit.name} (${value})` : value));
        chips.push(chip);
      }
    }
    bar.replaceChildren(...chips);
    bar.hidden = chips.length === 0;

    renderContextMeter();
    window.MimiHooks?.stage?.refresh();

    $('box').hidden = !chat || !state.latest;
    $('old-session').hidden = !chat || state.latest;
    $('new-session').hidden = !chat;
    $('toggle-rail').hidden = !chat;
    const busyHere = Boolean(chat && state.busyChats.has(chat.id));
    $('stop').hidden = !busyHere;
    $('box').classList.toggle('busy', busyHere);
    markEmpty();
    renderHints();
  }

  /** The two buttons at the top of the chat: with the character on in mobile mode they are the clean ones (≡ and "Chat setting"). */
  function syncTopButtons() {
    const clean = modeNow() === 'mobile' && $('app').classList.contains('solo');
    const open = !$('rail').hidden;
    $('back').textContent = clean ? '≡' : '‹';
    if (clean) {
      // An icon: settings while closed, back (to close it) while open.
      $('toggle-rail').innerHTML = open ? ICONS.back : ICONS.settings;
      $('toggle-rail').setAttribute('aria-label', t(open ? 'top.settingClose' : 'setting.title'));
      $('toggle-rail').title = t(open ? 'top.settingClose' : 'setting.title');
    } else {
      const mobile = modeNow() === 'mobile';
      $('toggle-rail').textContent = mobile ? '⋯' : t('top.info');
      if (mobile) $('toggle-rail').setAttribute('aria-label', t('top.info'));
      else $('toggle-rail').removeAttribute('aria-label');
      $('toggle-rail').title = mobile ? t('top.info') : '';
    }
    $('toggle-char').textContent = modeNow() === 'mobile' ? '🧍' : t('top.character');
  }

  /** "แสดง prompt": a switch (tray window only) for the tool calls and other details. */
  function promptSwitch() {
    const toggle = el('button', `tg${showPrompt ? ' on' : ''}`);
    toggle.type = 'button';
    toggle.setAttribute('aria-label', t('setting.showPrompt'));
    const label = el('label', 'tglabel');
    label.append(el('span', '', t('setting.showPrompt')), toggle);
    toggle.onclick = () => {
      showPrompt = !showPrompt;
      document.documentElement.classList.toggle('show-prompt', showPrompt);
      try {
        localStorage.setItem('mimi.showPrompt', showPrompt ? '1' : '0');
      } catch {
        // not remembered, still switched
      }
      renderHints();
      renderRail();
      scrollDown();
    };
    return label;
  }

  const RAIL_TABS = [
    ['status', 'สถานะ / Session', 'สถานะตอนนี้ของ agent และรายการ session ของแชตนี้'],
    ['appearance', 'หน้าตา', 'ตัวละคร ฟองข้อความ และฉากหลัง — จำเฉพาะแชตนี้'],
    ['info', 'ข้อมูล / ตั้งค่า', 'ข้อมูล agent หรือสมาชิก ภาษา และการตั้งค่าอื่น ๆ'],
  ];
  let railShownTab = null;
  function renderRail() {
    const rail = $('rail');
    rail.hidden = !(state.railOpen && state.view === 'chat' && state.chat);
    $('app').classList.toggle('with-rail', !rail.hidden);
    $('toggle-rail').classList.toggle('pri', !rail.hidden);
    syncTopButtons();
    if (rail.hidden) return;
    // A setting changes the panel under the finger; it must not jump back to the top.
    const keepRailScroll = railShownTab === ui.railTab ? rail.scrollTop : 0;
    const chat = state.chat;
    const nodes = [];

    // In mobile mode the way back is the top bar (the settings button turns into a back arrow).
    // A desktop window narrow enough to float the panel covers that button, so it gets a ✕ here.
    const railHead = el('div', 'rail-head');
    const railClose = button('btn ghost icon rail-close', '✕', () => setRail(false), t('top.settingClose'));
    railClose.setAttribute('aria-label', t('top.settingClose'));
    railHead.append(el('b', '', 'ตั้งค่าแชต'), railClose);

    // The chat settings are split into three pages, so each one stays short on a phone.
    const tabs = el('div', 'tabs');
    for (const [key, label, hint] of RAIL_TABS) {
      tabs.append(
        button(ui.railTab === key ? 'on' : '', label, () => {
          ui.railTab = key;
          renderRail();
        }, hint),
      );
    }
    const railTop = el('div', 'rail-top');
    railTop.append(railHead, tabs);
    nodes.push(railTop);

    if (ui.railTab === 'status' && chat.kind === 'group') nodes.push(...groupPanels(chat));
    if (ui.railTab === 'status') {
      const quick = el('div', 'rail-quick');
      quick.append(
        button('btn', t('setting.search'), () => {
          setRail(false);
          $('open-search').click();
        }),
        button('btn', t('setting.newSession'), () => {
          setRail(false);
          $('new-session').click();
        }),
      );
      nodes.push(quick);

      const sessions = el('div');
      const head = el('h3', '', 'Session');
      head.append(button('', '+ ใหม่', () => send({ type: 'session-new', chatId: chat.id })));
      sessions.append(head);
      for (const session of state.sessions) {
        const row = button(`sess${state.session && state.session.id === session.id ? ' on' : ''}`, null, () => openChat(chat.id, session.id));
        const label = el('div', 't');
        if (session.unread && (!state.session || state.session.id !== session.id)) label.append(el('span', 'unread', 'ใหม่ · '));
        label.append(session.title || 'ยังไม่มีชื่อ');
        row.append(label, el('div', 'm', `${fmtDate(session.lastMessageAt)}${session.summary ? ` · ${session.summary}` : ''}`));
        sessions.append(row);
      }
      if (state.sessions.length === 0) sessions.append(el('div', 'empty', 'ยังไม่มี session — เริ่มเองอัตโนมัติเมื่อส่งข้อความแรก'));
      const idleMinutes = state.settings && state.settings.sessionIdleMinutes;
      if (idleMinutes) {
        const hours = idleMinutes >= 60 ? `${Math.round((idleMinutes / 60) * 10) / 10} ชั่วโมง` : `${idleMinutes} นาที`;
        sessions.append(el('p', 'hint', `session ใหม่เริ่มเองเมื่อแชตเงียบเกิน ${hours} แล้วคุณส่งข้อความถัดไป (ไม่มีตัวจับเวลาเปิด session ว่าง) · Mimi สรุป session เดิมให้ตัวใหม่เอง · ปรับได้ที่ mimi.json → session.idle_minutes`));
      }
      nodes.push(sessions);
      const contextSection = contextPanel();
      if (contextSection) nodes.push(contextSection);

      if (chat.kind === 'direct') {
        const agent = agentOf(chat.agents[0]);
        const section = el('div');
        section.append(el('h3', '', 'สถานะตอนนี้'));
        const grid = el('div', 'kvs');
        for (const [key, label] of STATUS) {
          const value = (agent && agent.status && agent.status[key]) || '';
          grid.append(
            el('span', '', label),
            button(value ? '' : 'unset', value || 'ยังไม่ระบุ', () => {
              const next = prompt(`${label} ของ ${nameOf(chat.agents[0])} (เว้นว่างเพื่อล้าง)`, value);
              if (next !== null) send({ type: 'status-set', agent: chat.agents[0], key, value: next });
            }, 'แตะเพื่อแก้ไข (ปกติ agent อัปเดตเองระหว่างคุย)'),
          );
        }
        section.append(grid);
        nodes.push(section);
        if (agent && agent.status && agent.status.situation) {
          const cg = el('div');
          cg.append(el('h3', '', 'ภาพสถานการณ์'));
          cg.append(button('btn ghost', 'เอาภาพออกจากแชต', () => send({ type: 'status-set', agent: chat.agents[0], key: 'situation', value: '' })));
          nodes.push(cg);
        }
      }
    }

    if (ui.railTab === 'appearance') {
      nodes.push(el('p', 'hint', 'หน้าตาของแชตนี้ถูกจำแยกจากแชตอื่น (คนนี้เปิดตัวละคร อีกคนปิดได้) — ค่าที่ไม่ได้ตั้งเองจะใช้ค่าเดิมของแอป'));
      const sizes = el('div');
      sizes.append(el('h3', '', 'ขนาดข้อความ'));
      const sizeRow = el('div', 'seg');
      const SIZE_LABELS = ['เล็ก', 'ปกติ', 'ใหญ่'];
      for (const level of [0, 1, 2]) {
        sizeRow.append(
          button(textSize() === level ? 'on' : '', SIZE_LABELS[level], () => {
            if (state.chat) store.set(`mimi.chat.${chat.id}.textSize`, String(level));
            else store.set('mimi.textSize', String(level));
            applyTextSize();
            renderRail();
          }, level === 0 ? 'ตัวอักษรเล็กลง เห็นข้อความมากกว่า' : level === 1 ? 'ขนาดมาตรฐาน' : 'ตัวอักษรใหญ่ขึ้น อ่านง่ายกว่า'),
        );
      }
      sizes.append(sizeRow);
      nodes.push(sizes);
      const themeSection = el('div');
      themeSection.append(el('h3', '', 'ธีมของแชตนี้'));
      const themeRow = el('div', 'seg');
      const currentTheme = chatTheme();
      const THEME_CHOICES = [
        [null, 'ตามแอป', 'ใช้ธีมเดียวกับหน้าตั้งค่า'],
        ['light', 'สว่าง', 'พื้นชมพูอ่อน อ่านสบาย'],
        ['dark', 'มืด', 'พื้นพลัมเข้ม ตัดกับตัวละคร'],
      ];
      for (const [value, label, hint] of THEME_CHOICES) {
        themeRow.append(button(currentTheme === value ? 'on' : '', label, () => setChatTheme(value), hint));
      }
      themeSection.append(themeRow, el('p', 'hint', 'แชตนี้จำธีมของตัวเองแยกจากแชตอื่น — กลับไปใช้ธีมหลักของแอปได้ตลอด'));
      nodes.push(themeSection);
      if (chat.kind === 'direct') {
        const row = el('div', 'rail-quick');
        row.append(button(`btn${characterOn() ? ' on' : ''}`, t(characterOn() ? 'setting.characterOn' : 'setting.characterOff'), toggleCharacter, t('setting.characterHint')));
        nodes.push(row);
        if (characterOn()) {
          // How much chat shows over the character.
          const levels = el('div');
          levels.append(el('h3', '', t('bubbles.title')));
          const seg = el('div', 'seg');
          for (const level of [0, 1, 2]) {
            seg.append(
              button(bubbleLevel() === level ? 'on' : '', t(`bubbles.${level}`), () => {
                const before = bubbleLevel();
                if (before === level) return;
                const keep = captureLogScroll();
                LOG_SCROLL_MEMO.set(`bubbles:${chat.id}:${before}`, keep);
                store.set(`mimi.chat.${chat.id}.bubbles`, String(level));
                renderHeader();
                renderRail();
                restoreLogScroll(LOG_SCROLL_MEMO.get(`bubbles:${chat.id}:${level}`) ?? keep);
              }, t(`bubbles.${level}.hint`)),
            );
          }
          levels.append(seg);
          nodes.push(levels);
          const placing = window.MimiHooks?.stage?.viewControls?.();
          if (placing) nodes.push(placing);
        }
        const backgroundPanel = window.MimiHooks?.backgrounds?.chatPanel?.(chat);
        if (backgroundPanel) nodes.push(backgroundPanel);
      } else {
        nodes.push(el('p', 'hint', 'แชตกลุ่มไม่มีตัวละคร — ตั้งค่าหน้าตาของตัวละครได้ในแชตตัวต่อตัวของแต่ละคน'));
      }
      if (chatHasPref('character') || chatHasPref('bubbles') || chatHasPref('textSize') || chatHasPref('theme')) {
        nodes.push(
          button('btn ghost', 'ใช้ค่าเดิมของแอป (ล้างค่าของแชตนี้)', () => {
            const keep = captureLogScroll();
            clearChatPref('character');
            clearChatPref('bubbles');
            clearChatPref('textSize');
            clearChatPref('theme');
            restoreLogScroll(keep);
          }),
        );
      }
    }

    if (ui.railTab === 'info') {
      if (chat.kind === 'direct') {
        const agent = agentOf(chat.agents[0]);
        const card = el('div', 'who-card');
        card.append(avatar(chat.agents[0], 'xl'), el('b', '', nameOf(chat.agents[0])), el('small', '', (agent && agent.description) || ''));
        card.append(
          button('btn ghost', 'แก้ไข agent', () => {
            ui.agent = chat.agents[0];
            ui.agentDirty = false;
            setView('agents');
          }),
        );
        nodes.push(card);
      } else {
        const section = el('div');
        const head = el('h3', '', 'สมาชิก');
        head.append(button('', 'แก้ไขกลุ่ม', () => groupEditor(chat)));
        section.append(head);
        for (const name of chat.agents) {
          const agent = agentOf(name);
          const status = (agent && agent.status) || {};
          const row = el('div', 'member');
          const info = el('div');
          info.append(el('b', '', nameOf(name)), el('div', 's', [status.mood, status.current_task, status.location].filter(Boolean).join(' · ') || (agent && agent.description) || ''));
          row.append(avatar(name), info);
          section.append(row);
        }
        nodes.push(section);
      }

      nodes.push(promptSwitch());

      nodes.push(
        button('btn ghost', 'ดาวน์โหลดแชตนี้ (CSV)', () => downloadFromApi(`/api/export/chat/${chat.id}.csv`, `mimi-chat-${chat.id}.csv`), 'ข้อความและรายชื่อไฟล์ — ไม่มีตัวไฟล์มีเดีย'),
      );

      nodes.push(
        button('btn danger', chat.kind === 'group' ? 'ลบกลุ่มนี้' : 'ลบแชตนี้', async () => {
          if (await window.MimiKit.confirmDelete(`${chat.kind === 'group' ? 'กลุ่ม' : 'แชต'} "${chatTitle(chat)}"`, 'ประวัติจะไม่แสดงอีก (ความจำที่บันทึกไว้แล้วยังอยู่)')) deleteChat(chat);
        }),
      );
    }

    rail.replaceChildren(...nodes);
    railShownTab = ui.railTab;
    rail.scrollTop = keepRailScroll;
  }

  // ---------- group chat panels ----------
  /** Speakers of the latest question, in order: everyone who answered since the user's last message. */
  function latestSpeakers() {
    const ids = state.historyIds;
    let start = ids.length;
    for (let index = ids.length - 1; index >= 0; index--) {
      const message = messageStore.get(ids[index]);
      start = index;
      if (message && message.role === 'user') break;
    }
    const speakers = [];
    for (const id of ids.slice(start)) {
      const message = messageStore.get(id);
      if (message && message.role === 'assistant' && message.agent && message.text && speakers[speakers.length - 1] !== message.agent) speakers.push(message.agent);
    }
    const typing = state.chat && state.typingByChat.get(state.chat.id);
    if (typing && speakers[speakers.length - 1] !== typing) speakers.push(typing);
    return speakers;
  }

  function groupPanels(chat) {
    const nodes = [];
    const members = el('div', 'grp');
    members.append(el('h3', '', 'สมาชิกและสถานะ'));
    const typing = state.typingByChat.get(chat.id);
    chat.agents.forEach((name, index) => {
      const agent = agentOf(name);
      const status = (agent && agent.status) || {};
      const row = el('div', `member${typing === name ? ' talking' : ''}`);
      const info = el('div');
      const title = el('b', '', nameOf(name));
      title.style.color = colorOf(name);
      if (index === 0) title.append(el('small', 'lead', ' ตอบเมื่อไม่ได้ @ ใคร'));
      const line = typing === name ? 'กำลังพิมพ์…' : [status.location, status.mood || status.current_task].filter(Boolean).join(' · ') || (agent ? agent.description : 'agent นี้ถูกลบแล้ว');
      info.append(title, el('div', 's', line || ''));
      row.append(avatar(name), info);
      row.title = 'แตะเพื่อ @ ถามคนนี้';
      row.onclick = () => {
        const label = `@${nameOf(name)} `;
        if (!input.value.includes(label)) input.value = `${label}${input.value}`;
        input.focus();
        refreshComposer();
      };
      members.append(row);
    });
    if (!chat.agents.some((name) => agentOf(name))) members.append(el('p', 'hint badtxt', 'สมาชิกทุกคนถูกลบไปแล้ว — เพิ่มสมาชิกใหม่ที่ "แก้ไขกลุ่ม"'));
    members.append(button('btn ghost sm', 'แก้ไขกลุ่ม / สมาชิก', () => groupEditor(chat)));
    nodes.push(members);

    const talk = el('div', 'grp');
    talk.append(el('h3', '', 'ใครคุยกับใครในคำถามนี้'));
    const speakers = latestSpeakers();
    if (speakers.length === 0) {
      talk.append(el('p', 'hint', 'ยังไม่มีใครตอบ — ส่งข้อความแล้วจะเห็นว่าใครส่งต่อให้ใคร'));
    } else {
      const pairs = new Map();
      const add = (from, to, kind) => {
        const key = [from, to].sort().join('|');
        const entry = pairs.get(key) || { from, to, both: false, count: 0, kind };
        if (entry.from !== from) entry.both = true;
        entry.count++;
        pairs.set(key, entry);
      };
      add('', speakers[0], 'ถาม');
      for (let index = 1; index < speakers.length; index++) add(speakers[index - 1], speakers[index], 'ส่งต่อ');
      const rows = el('div', 'talk');
      const who = (name) => {
        const node = el('span', 'who');
        const dot = el('i');
        dot.style.background = name ? colorOf(name) : 'var(--faint)';
        node.append(dot, name ? nameOf(name) : 'คุณ');
        return node;
      };
      for (const pair of pairs.values()) {
        const row = el('div');
        const names = el('span', 'pair');
        names.append(who(pair.from), el('span', 'arrow', pair.both ? ' ⇄ ' : ' → '), who(pair.to));
        row.append(names, el('span', 'kind', pair.both ? `${pair.count} ข้อความ` : pair.kind));
        rows.append(row);
      }
      if (!state.busyChats.has(chat.id)) {
        const row = el('div');
        const names = el('span', 'pair');
        names.append(who(speakers[speakers.length - 1]), el('span', 'arrow', ' → '), who(''));
        row.append(names, el('span', 'kind', 'สรุปให้คุณ'));
        rows.append(row);
      }
      talk.append(rows);
    }
    const limit = state.settings && state.settings.groupMaxTurns;
    talk.append(el('p', 'hint', `สองทาง: agent ถามกลับ แย้ง และตอบกันเองได้จนได้ข้อสรุป${limit ? ` (สูงสุด ${limit} ทอด)` : ''} · คุณแทรกได้ทุกเมื่อ`));
    nodes.push(talk);

    const rules = el('div', 'grp');
    rules.append(el('h3', '', 'กติกาของกลุ่ม'));
    const list = el('ul', 'rules');
    for (const line of [
      'คนที่ถูก @ ตอบก่อน และถามกลับได้',
      'ไม่ได้ @ ใคร: คนแรกในรายชื่อเป็นคนตอบ',
      'agent เรียกกันเองด้วย @ชื่อ เพื่อถามหรือแย้ง',
      'ทุกคนอ่านข้อความในกลุ่มเห็นเหมือนกัน',
      'ความจำของแต่ละคนยังแยกกัน',
    ]) list.append(el('li', '', line));
    rules.append(list);
    nodes.push(rules);
    return nodes;
  }

  /** Rename a group and choose its members; the first member answers when nobody is @-called. */
  function groupEditor(chat) {
    const Kit = window.MimiKit;
    let order = [...chat.agents];
    const title = textInput(chat.title || '', 'ชื่อกลุ่ม เช่น บ้าน, งานเอกสาร');
    const list = el('div', 'grp-members');
    const candidates = state.agents.filter((agent) => agent.name !== 'overseer');
    const paint = () => {
      list.replaceChildren();
      order.forEach((name, index) => {
        const row = el('div', 'mk-tag');
        const text = el('div');
        text.append(el('b', '', `${index + 1}. ${nameOf(name)}`), el('small', '', index === 0 ? 'ตอบเมื่อไม่ได้ @ ใคร' : (agentOf(name) && agentOf(name).description) || ''));
        row.append(avatar(name, 'sm'), text);
        if (index > 0) {
          row.append(button('mk-tag-x', '↑', () => {
            order.splice(index - 1, 0, order.splice(index, 1)[0]);
            popup.dirty = true;
            paint();
          }, 'เลื่อนขึ้น'));
        }
        row.append(button('mk-tag-x', '✕', () => {
          order = order.filter((entry) => entry !== name);
          popup.dirty = true;
          paint();
        }, 'เอาออกจากกลุ่ม'));
        list.append(row);
      });
      const rest = candidates.filter((agent) => !order.includes(agent.name));
      if (rest.length > 0) {
        list.append(Kit.select([['', '+ เพิ่มสมาชิก…'], ...rest.map((agent) => [agent.name, nameOf(agent.name)])], '', (value) => {
          if (!value) return;
          order.push(value);
          popup.dirty = true;
          paint();
        }));
      }
    };
    const popup = Kit.modal({
      title: `แก้ไขกลุ่ม: ${chatTitle(chat)}`,
      body: [Kit.field('ชื่อกลุ่ม', title), Kit.section('สมาชิก', 'คนบนสุดตอบเมื่อไม่ได้ @ ใคร · กด ↑ เพื่อเลื่อนลำดับ', []), list],
    });
    paint();
    popup.setFoot(
      [
        button('btn ghost', 'ยกเลิก', () => popup.close()),
        button('btn pri', 'บันทึก', () => {
          if (order.length < 2) return toast('กลุ่มต้องมีอย่างน้อย 2 คน', null, true);
          send({ type: 'chat-update', chatId: chat.id, title: title.value.trim(), agents: order });
          popup.done();
          toast('บันทึกกลุ่มแล้ว ✓');
        }),
      ],
      [button('btn danger', 'ลบกลุ่ม', async () => {
        if (!(await Kit.confirmDelete(`กลุ่ม "${chatTitle(chat)}"`, 'ประวัติแชตจะไม่แสดงอีก (ความจำที่บันทึกไว้แล้วของแต่ละคนยังอยู่)'))) return;
        popup.done();
        deleteChat(chat);
      })],
    );
  }

  function deleteChat(chat) {
    send({ type: 'chat-delete', chatId: chat.id });
    if (state.chat && state.chat.id === chat.id) {
      state.chat = null;
      state.session = null;
      state.sessions = [];
      emptyState();
      renderHeader();
      renderRail();
      $('app').classList.add('show-side');
    }
  }

  // ---------- composer ----------
  const input = $('input');
  /**
   * The height is measured after a typing pause, never per key: Chrome's own growing box
   * (field-sizing) lays the whole text out again on every key, which Thai - where the browser
   * looks every word break up in a dictionary - cannot do fast on a phone.
   */
  const THAI = /[฀-๿]/;
  // A Thai app gets the fast line-break rule from the start, not in the middle of the first word.
  if (document.documentElement.lang === 'th') input.classList.add('th');
  function autosize() {
    // Measuring with height:auto briefly scrolls the box; keep the caret's place in a long draft.
    const scroll = input.scrollTop;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    input.scrollTop = scroll;
  }
  let composing = false;
  let composerTimer = 0;
  /**
   * Typing must not fight the IME. The empty/send button state is O(1); measuring the
   * box, choosing the Thai line-break rule and the @-list wait until a real pause. Thai
   * keyboards send several input events per syllable, so nothing here runs per event.
   */
  function refreshComposer() {
    markEmpty();
    if (composerTimer) clearTimeout(composerTimer);
    composerTimer = setTimeout(() => {
      composerTimer = 0;
      if (composing) return;
      input.classList.toggle('th', THAI.test(input.value));
      autosize();
      renderMention();
    }, 260);
  }
  function renderHints() {
    const hints = $('hints');
    const speaking = window.MimiHooks?.voice?.hint();
    if (speaking) {
      hints.replaceChildren(el('span', 'rec', speaking));
      return;
    }
    if (state.chat && state.chat.kind === 'group') {
      const limit = state.settings && state.settings.groupMaxTurns;
      const left = el('span', '', 'agent ถาม-ตอบ-แย้งกันเองได้สองทาง · ');
      left.append(el('kbd', '', 'Esc'), ' หยุดทุกคน');
      hints.replaceChildren(left, el('span', 'right', limit ? `จำกัด ${limit} ทอดต่อหนึ่งคำถาม` : '@ชื่อ เพื่อเรียกคนตอบ'));
      return;
    }
    const parts = ['Enter ส่ง · Shift+Enter ขึ้นบรรทัดใหม่'];
    hints.replaceChildren(...parts.map((part) => el('span', '', part)));
  }
  function renderStaged() {
    const box = $('staged');
    box.hidden = state.staged.length === 0;
    markEmpty();
    box.replaceChildren(
      ...state.staged.map((entry) => {
        const remove = el('u', '', '×');
        remove.onclick = (event) => {
          event.stopPropagation();
          if (entry.url) URL.revokeObjectURL(entry.url);
          state.staged = state.staged.filter((other) => other !== entry);
          renderStaged();
        };
        if (entry.url) {
          const item = el('div', 'staged-item');
          const thumb = el('div', `thumb${entry.uploading ? ' wait' : ''}`);
          if (entry.file.type.startsWith('video/')) {
            const video = el('video');
            video.src = entry.url;
            video.muted = true;
            video.playsInline = true;
            video.preload = 'metadata';
            thumb.append(video);
          } else {
            thumb.style.backgroundImage = `url("${entry.url}")`;
          }
          thumb.title = entry.file.name;
          thumb.append(remove);
          // Each picture has its own caption; the box below the chat stays the message as a whole.
          const caption = el('input', 'capin');
          caption.type = 'text';
          caption.maxLength = 500;
          caption.value = entry.caption || '';
          caption.placeholder = 'คำบรรยายของไฟล์นี้ (ไม่ใส่ก็ได้)';
          caption.setAttribute('aria-label', caption.placeholder);
          caption.enterKeyHint = 'next';
          caption.oninput = () => {
            entry.caption = caption.value;
          };
          item.onclick = (event) => {
            if (event.target !== remove) caption.focus();
          };
          item.append(thumb, caption);
          return item;
        }
        const chip = el('div', `filechip${entry.uploading ? ' wait' : ''}`);
        const info = el('div');
        info.append(el('div', 'fname', entry.file.name), el('div', 'fmeta', entry.uploading ? 'กำลังอัปโหลด…' : fmtSize(entry.file.size)));
        chip.append(fileIcon(entry.file.name, entry.file.type.startsWith('audio/') ? 'audio' : 'file'), info, remove);
        return chip;
      }),
    );
  }
  /** Stages a file on this device; the upload waits for Send, so a caption can be written first. */
  async function stageFile(file, options) {
    if (file.size > 25 * 1024 * 1024) return toast('ไฟล์ใหญ่เกินไป', `${file.name} เกิน 25 MB`, true);
    if (state.staged.length >= 20) return toast('แนบไฟล์ได้สูงสุด 20 ไฟล์', 'ส่งข้อความนี้ก่อน แล้วค่อยแนบชุดถัดไป', true);
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic|heif|avif)$/i.test(file.name);
    const isVideo = file.type.startsWith('video/');
    const images = state.staged.filter(
      (entry) => entry.file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic|heif|avif)$/i.test(entry.file.name),
    ).length;
    if (isImage && images >= 6) {
      toast('รูปเกิน 6 รูป', 'โมเดลจะเห็นรูปจริง 6 รูปสุดท้าย รูปที่เหลือจะถูกอธิบายด้วยข้อความ', true);
    }
    if (/^image\/(heic|heif|avif)$/i.test(file.type) || /\.(heic|heif|avif)$/i.test(file.name)) {
      toast('รูปชนิดนี้อาจไม่แสดงโดยตรง', 'โมเดลอาจเห็นได้เพียงคำอธิบายของรูป ไม่ใช่ตัวรูป', true);
    }
    const entry = {
      file,
      id: null,
      uploading: false,
      caption: '',
      captionSent: '',
      url: isImage || isVideo ? URL.createObjectURL(file) : null,
    };
    state.staged.push(entry);
    renderStaged();
    // Straight from the camera: the cursor is in this picture's caption, ready to type or skip.
    if (options && options.caption && entry.url) {
      requestAnimationFrame(() => {
        const box = $('staged');
        const fields = box.querySelectorAll('.capin');
        const last = fields[fields.length - 1];
        if (last) last.focus();
      });
    }
    return entry;
  }
  /** Uploads the staged files that have no id yet; returns one message per failure. */
  async function uploadStaged(entries) {
    const failures = [];
    await Promise.all(
      entries.map(async (entry) => {
        const caption = (entry.caption || '').trim();
        if (entry.id && entry.captionSent === caption) return;
        entry.uploading = true;
        renderStaged();
        try {
          const headers = { 'content-type': entry.file.type || 'application/octet-stream' };
          if (caption) headers['x-mimi-caption'] = encodeURIComponent(caption);
          const response = await api(`/api/upload?name=${encodeURIComponent(entry.file.name)}`, {
            method: 'POST',
            headers,
            body: entry.file,
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
          entry.id = result.id;
          entry.captionSent = caption;
        } catch (error) {
          failures.push(`${entry.file.name}: ${error.message}`);
        } finally {
          entry.uploading = false;
        }
      }),
    );
    renderStaged();
    return failures;
  }
  /** Your message as sent; shown right away so the input "confirms" itself on screen, even before the server echoes it. */
  let echoSeq = 0;
  const fileKind = (file) =>
    file.type.startsWith('image/') ? 'image' : file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('video/') ? 'video' : 'file';
  /** The picture/audio/video of a file on this device, before it has an attachment id. */
  const pendingAttachment = (entry) => ({
    id: entry.id || `local-${entry.file.name}-${entry.file.size}-${entry.file.lastModified || 0}`,
    kind: fileKind(entry.file),
    name: entry.file.name,
    mime: entry.file.type || 'application/octet-stream',
    size: entry.file.size,
    text: '',
    caption: (entry.caption || '').trim(),
    deletedAt: null,
    ...(entry.url ? { url: entry.url } : {}),
  });
  function pendingUrls(pending) {
    return [...new Set(pending.entries.map((entry) => entry.url).filter(Boolean))];
  }
  function releasePending(pending, revoke = true) {
    if (revoke) for (const url of pendingUrls(pending)) URL.revokeObjectURL(url);
    state.pendingEchoes = state.pendingEchoes.filter((entry) => entry !== pending);
    const row = logInner.querySelector(`[data-id="${pending.clientId}"]`);
    if (row) row.remove();
    messageStore.delete(pending.clientId);
  }
  function setPendingStatus(pending, text) {
    pending.message.pendingStatus = text;
    const row = logInner.querySelector(`[data-id="${pending.clientId}"] .pending-status`);
    if (row) row.textContent = text;
  }
  function createPending(chatId, text, entries, reply) {
    const clientId = `pending-${Date.now().toString(36)}-${++echoSeq}`;
    const message = {
      id: clientId,
      clientId,
      role: 'user',
      agent: '',
      text,
      createdAt: new Date().toISOString(),
      attachments: entries.map(pendingAttachment),
      tools: [],
      replyTo: reply ? { id: reply.id, role: 'user', agent: '', text: reply.text } : null,
      pendingStatus: 'กำลังอัปโหลด…',
    };
    const pending = { clientId, chatId, text, entries, reply, message };
    state.pendingEchoes.push(pending);
    if (state.chat && state.chat.id === chatId) {
      ensureDay(logInner, message.createdAt);
      messageStore.set(message.id, message);
      add(userRow(message));
      scrollDown();
    }
    return pending;
  }
  /** Re-draws the provisional bubbles of the chat on screen after a history render or merge. */
  function renderPendingEchoes() {
    if (!state.chat) return;
    for (const row of logInner.querySelectorAll('[data-pending="1"]')) row.remove();
    const mine = state.pendingEchoes.filter((entry) => entry.chatId === state.chat.id);
    if (mine.length > 0) logInner.querySelector('.welcome')?.remove();
    for (const pending of mine) {
      messageStore.set(pending.message.id, pending.message);
      logInner.append(userRow(pending.message));
    }
    if (mine.length > 0 && followLog) scrollDown();
  }
  /** A stored message carries the client id of its placeholder: that one has arrived. */
  function pruneConfirmed(messages) {
    const arrived = new Set(messages.map((entry) => entry.clientId).filter(Boolean));
    for (const pending of [...state.pendingEchoes]) {
      if (arrived.has(pending.clientId)) {
        releasePending(pending);
        continue;
      }
      // After a reconnect the client id is gone from history: the same words and files,
      // stored just after the placeholder was made, are that message.
      const at = new Date(pending.message.createdAt).getTime();
      const shape = (message) => message.attachments.map((file) => `${file.name}\n${file.caption || ''}`).join('|');
      const pendingShape = shape(pending.message);
      const same = messages.some(
        (entry) =>
          entry.role === 'user' &&
          entry.text === pending.text &&
          entry.attachments.length === pending.message.attachments.length &&
          shape(entry) === pendingShape &&
          new Date(entry.createdAt).getTime() >= at - 10_000,
      );
      if (same) releasePending(pending);
    }
  }
  /** The server stored (and echoed) your message: the provisional bubble makes way for the real one. */
  function confirmEcho(message, chatId) {
    const index = message.clientId
      ? state.pendingEchoes.findIndex((entry) => entry.clientId === message.clientId)
      : state.pendingEchoes.findIndex(
          (entry) =>
            entry.chatId === chatId &&
            entry.text === message.text &&
            entry.message.attachments.length === message.attachments.length,
        );
    if (index < 0) return false;
    const [pending] = state.pendingEchoes.splice(index, 1);
    const row = logInner.querySelector(`[data-id="${pending.clientId}"]`);
    if (row) {
      row.dataset.id = message.id;
      const stored = userRow(message);
      stored.removeAttribute('data-pending');
      row.replaceWith(stored);
    }
    for (const url of pendingUrls(pending)) URL.revokeObjectURL(url);
    messageStore.delete(pending.clientId);
    messageStore.set(message.id, message);
    // Now part of the stored conversation: the next merge skips it.
    if (state.historyKey && !state.historyIds.includes(message.id)) state.historyIds.push(message.id);
    return true;
  }
  /** Uploads the pictures/files, then asks the server to store the message. The bubble is already on screen. */
  async function sendPending(pending) {
    setPendingStatus(pending, 'กำลังอัปโหลด…');
    const failures = await uploadStaged(pending.entries);
    if (failures.length > 0) {
      releasePending(pending, false);
      return failures;
    }
    const attachments = pending.entries.filter((entry) => entry.id).map((entry) => entry.id);
    if (!pending.text && attachments.length === 0) {
      releasePending(pending, false);
      return ['ไม่มีไฟล์ที่อัปโหลดสำเร็จ'];
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      releasePending(pending, false);
      return ['ยังไม่ได้เชื่อมต่อ'];
    }
    setPendingStatus(pending, 'กำลังส่ง…');
    send({
      type: 'chat-send',
      chatId: pending.chatId,
      text: pending.text,
      attachments,
      clientId: pending.clientId,
      ...(pending.reply ? { replyTo: pending.reply.id } : {}),
    });
    return [];
  }
  function restoreEntries(entries, text) {
    if (text && !input.value) {
      input.value = text;
      autosize();
    }
    for (const entry of entries) {
      if (!state.staged.includes(entry)) state.staged.push(entry);
    }
    renderStaged();
  }
  async function sendMessage() {
    if (!state.chat || !state.latest || state.sending) return;
    const text = input.value.trim();
    const staged = [...state.staged];
    if (!text && staged.length === 0) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return toast('ยังไม่ได้เชื่อมต่อ', 'ข้อความยังอยู่ในช่องพิมพ์ ลองส่งอีกครั้ง', true);
    const reply = compose.replyTo;
    const pending = createPending(state.chat.id, text, staged, reply);
    state.sending = true;
    // The placeholder confirms the send at once; typing and the caption can carry on.
    input.value = '';
    compose.replyTo = null;
    if (window.MimiHooks && window.MimiHooks.chat) window.MimiHooks.chat.onSent();
    window.MimiHooks?.notify?.chatSound('sent');
    autosize();
    state.staged = [];
    renderStaged();
    markEmpty();
    $('mention').hidden = true;
    try {
      const failures = await sendPending(pending);
      if (failures.length > 0) {
        toast('อัปโหลดไม่สำเร็จ', failures[0], true);
        if (state.chat && state.chat.id === pending.chatId) restoreEntries(staged, text);
      }
    } finally {
      state.sending = false;
    }
    window.MimiAndroid?.refreshWidget?.();
    // In the Android app the permission is the app's own; the page cannot ask for it.
    if (window.MimiAndroid?.requestNotifications) window.MimiAndroid.requestNotifications();
    else if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
  }
  // ---------- picture caption sheet (Telegram-style) ----------
  const isImageFile = (file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|heic|heif|avif)$/i.test(file.name);
  let photoReview = null;
  function closePhotoReview(revoke = true) {
    if (!photoReview) return;
    if (revoke) for (const entry of photoReview.entries) if (entry.url) URL.revokeObjectURL(entry.url);
    document.removeEventListener('keydown', photoReview.onKey);
    photoReview.scrim.remove();
    photoReview = null;
  }
  function openPhotoReview(images, options = {}) {
    const entries = images.map((image) =>
      image.file
        ? { file: image.file, url: image.url || URL.createObjectURL(image.file), caption: image.caption || '', selected: image.selected !== false }
        : image,
    );
    if (photoReview) {
      // More pictures picked while the sheet is open join it, and the grid shows them.
      for (const entry of entries) if (!photoReview.entries.some((known) => known.file === entry.file)) photoReview.entries.push(entry);
      photoReview.view = 'grid';
      renderPhotoReview();
      return;
    }
    // One picture opens straight in the viewer (like a camera shot); several open as a grid to tick.
    photoReview = { chatId: state.chat && state.chat.id, entries, index: 0, view: entries.length > 1 ? 'grid' : 'viewer', separate: false, sharedCaption: '', scrim: null, refs: {}, focusCaption: Boolean(options.caption) };
    const scrim = el('div', 'photo-scrim');
    const dialog = el('div', 'photo-review');
    scrim.append(dialog);
    document.body.append(scrim);
    photoReview.scrim = scrim;
    photoReview.dialog = dialog;
    photoReview.onKey = (event) => {
      if (event.key !== 'Escape' || !photoReview) return;
      if (photoReview.view === 'viewer' && photoReview.entries.length > 1) {
        photoReview.view = 'grid';
        renderPhotoReview();
      } else closePhotoReview();
    };
    document.addEventListener('keydown', photoReview.onKey);
    renderPhotoReview();
  }
  /** Sends the ticked pictures: one message with a shared caption, or one each with their own. */
  function sendPhotoReview() {
    const review = photoReview;
    if (!review) return;
    const chosen = review.entries.filter((entry) => entry.selected);
    if (chosen.length === 0) return toast('ยังไม่ได้เลือกรูป', 'แตะวงกลมมุมขวาบนของรูปก่อน', true);
    if (!review.separate) {
      const text = review.sharedCaption.trim();
      for (const entry of chosen) entry.caption = text;
      const pending = createPending(review.chatId, '', chosen, null);
      pending.message.pendingStatus = 'กำลังอัปโหลด…';
      closePhotoReview(false);
      void sendPhotoPending([pending]);
    } else {
      const pendings = chosen.map((entry) => createPending(review.chatId, '', [entry], null));
      closePhotoReview(false);
      void sendPhotoPending(pendings);
    }
  }
  /** The caption line and the send button, pinned at the bottom of both views. */
  function photoReviewBar(review) {
    const bar = el('div', 'pr-bar');
    const caption = el('textarea', 'pr-caption');
    caption.rows = 1;
    caption.maxLength = 500;
    const sync = () => {
      const current = review.entries[review.index];
      caption.value = review.separate ? (current && current.caption) || '' : review.sharedCaption || '';
      caption.placeholder = review.separate ? 'คำบรรยายของรูปนี้…' : review.entries.length > 1 ? 'เพิ่มคำบรรยายให้ทุกรูป…' : 'เพิ่มคำบรรยาย…';
    };
    sync();
    const fit = () => {
      caption.style.height = 'auto';
      caption.style.height = `${Math.min(110, caption.scrollHeight)}px`;
    };
    caption.oninput = () => {
      const current = review.entries[review.index];
      if (review.separate && current) current.caption = caption.value;
      else review.sharedCaption = caption.value;
      fit();
    };
    review.refs.caption = caption;
    review.refs.syncCaption = sync;
    const count = el('span', 'pr-count');
    const send = el('button', 'pr-send');
    send.setAttribute('aria-label', 'ส่ง');
    send.innerHTML = ICONS.send || svg('<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>');
    send.append(count);
    send.onclick = sendPhotoReview;
    review.refs.count = count;
    review.refs.send = send;
    const left = el('div', 'pr-barleft');
    left.append(caption);
    if (review.entries.length > 1) {
      const mode = button(`pr-mode${review.separate ? ' on' : ''}`, review.separate ? 'แยกทีละรูป' : 'รวมเป็นข้อความเดียว', () => {
        review.separate = !review.separate;
        mode.textContent = review.separate ? 'แยกทีละรูป' : 'รวมเป็นข้อความเดียว';
        mode.classList.toggle('on', review.separate);
        sync();
      }, 'สลับระหว่างคำบรรยายเดียวกับทุกรูป และคำบรรยายแยกทีละรูป');
      left.append(mode);
    }
    bar.append(left, send);
    refreshPhotoCount(review);
    return bar;
  }
  function refreshPhotoCount(review) {
    const chosen = review.entries.filter((entry) => entry.selected).length;
    if (review.refs.count) {
      review.refs.count.textContent = chosen > 1 || review.entries.length > 1 ? String(chosen) : '';
      review.refs.count.hidden = review.entries.length < 2;
    }
    if (review.refs.send) review.refs.send.disabled = chosen === 0;
    if (review.refs.title) review.refs.title.textContent = review.view === 'grid' ? `เลือกแล้ว ${chosen} จาก ${review.entries.length}` : `${review.index + 1} / ${review.entries.length}`;
  }
  function renderPhotoReview() {
    const review = photoReview;
    if (!review) return;
    review.refs = {};
    review.dialog.replaceChildren();
    if (review.entries.length === 0) return closePhotoReview();
    review.index = Math.min(review.index, review.entries.length - 1);
    if (review.view === 'viewer') renderPhotoViewer(review);
    else renderPhotoGrid(review);
  }
  function renderPhotoGrid(review) {
    const head = el('div', 'pr-head');
    const title = el('b');
    review.refs.title = title;
    const more = el('input');
    more.type = 'file';
    more.accept = 'image/*';
    more.multiple = true;
    more.hidden = true;
    more.onchange = () => {
      const files = [...more.files];
      more.value = '';
      if (files.length > 0) stageFiles(files);
    };
    head.append(
      button('pr-round', '✕', () => closePhotoReview(), 'ยกเลิก'),
      title,
      button('pr-add', '＋ เพิ่มรูป', () => more.click(), 'เลือกรูปเพิ่ม'),
      more,
    );
    const grid = el('div', 'pr-grid');
    review.entries.forEach((entry, index) => {
      const tile = el('div', `pr-tile${entry.selected ? ' on' : ''}`);
      const open = el('button', 'pr-open');
      open.setAttribute('aria-label', `ดูรูป ${index + 1}`);
      const image = el('img');
      image.src = entry.url;
      image.alt = entry.file.name;
      image.loading = 'lazy';
      open.append(image);
      open.onclick = () => {
        review.index = index;
        review.view = 'viewer';
        renderPhotoReview();
      };
      const tick = el('button', 'pr-badge');
      tick.setAttribute('aria-label', 'เลือก / ไม่เลือกรูปนี้');
      const paint = () => {
        const order = review.entries.filter((other) => other.selected).indexOf(entry) + 1;
        tick.textContent = entry.selected ? String(order) : '';
        tile.classList.toggle('on', entry.selected);
      };
      tick.onclick = () => {
        entry.selected = !entry.selected;
        for (const repaint of review.refs.paints || []) repaint();
        refreshPhotoCount(review);
      };
      (review.refs.paints = review.refs.paints || []).push(paint);
      paint();
      tile.append(open, tick);
      grid.append(tile);
    });
    review.dialog.append(head, grid, photoReviewBar(review));
    refreshPhotoCount(review);
  }
  function renderPhotoViewer(review) {
    const many = review.entries.length > 1;
    const head = el('div', 'pr-vhead');
    const title = el('b');
    review.refs.title = title;
    const tick = el('button', 'pr-tickbtn');
    const paintTick = () => {
      const current = review.entries[review.index];
      tick.classList.toggle('on', current.selected);
      tick.textContent = current.selected ? '✓' : '';
      tick.setAttribute('aria-label', current.selected ? 'รูปนี้จะถูกส่ง — แตะเพื่อไม่ส่ง' : 'รูปนี้ไม่ถูกส่ง — แตะเพื่อเลือก');
    };
    tick.onclick = () => {
      const current = review.entries[review.index];
      current.selected = !current.selected;
      paintTick();
      refreshPhotoCount(review);
    };
    head.append(
      button('pr-round', many ? '‹' : '✕', () => {
        if (many) {
          review.view = 'grid';
          renderPhotoReview();
        } else closePhotoReview();
      }, many ? 'กลับไปหน้ารวมรูป' : 'ยกเลิก'),
      title,
      many ? tick : el('span'),
    );
    const stage = el('div', 'pr-vstage');
    const image = el('img', 'pr-vimg');
    image.draggable = false;
    stage.append(image);
    const zoom = { s: 1, x: 0, y: 0 };
    const apply = () => {
      image.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.s})`;
      stage.classList.toggle('zoomed', zoom.s > 1.02);
    };
    const bound = () => {
      if (zoom.s <= 1) {
        zoom.x = 0;
        zoom.y = 0;
        return;
      }
      const box = stage.getBoundingClientRect();
      const mx = (box.width * (zoom.s - 1)) / 2;
      const my = (box.height * (zoom.s - 1)) / 2;
      zoom.x = Math.max(-mx, Math.min(mx, zoom.x));
      zoom.y = Math.max(-my, Math.min(my, zoom.y));
    };
    const show = (index) => {
      review.index = (index + review.entries.length) % review.entries.length;
      const current = review.entries[review.index];
      image.src = current.url;
      image.alt = current.file.name;
      zoom.s = 1;
      zoom.x = 0;
      zoom.y = 0;
      apply();
      paintTick();
      refreshPhotoCount(review);
      if (review.refs.syncCaption) review.refs.syncCaption();
      for (const [at, thumb] of (review.refs.thumbs || []).entries()) thumb.classList.toggle('on', at === review.index);
      const active = review.refs.thumbs && review.refs.thumbs[review.index];
      if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'center' });
    };
    if (many) {
      stage.append(button('pr-nav pr-prev', '‹', () => show(review.index - 1), 'รูปก่อนหน้า'), button('pr-nav pr-next', '›', () => show(review.index + 1), 'รูปถัดไป'));
    }
    // Pinch or wheel to zoom, drag to look around, double-tap to jump in or out; at normal size a sideways swipe turns the page.
    const pointers = new Map();
    let pinch = null;
    let drag = null;
    let lastTap = 0;
    stage.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.pr-nav')) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      try {
        stage.setPointerCapture(event.pointerId);
      } catch {
        // synthetic pointer
      }
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: zoom.s };
        drag = null;
      } else if (pointers.size === 1) {
        drag = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, t: Date.now(), moved: 0 };
      }
    });
    stage.addEventListener('pointermove', (event) => {
      const known = pointers.get(event.pointerId);
      if (!known) return;
      known.x = event.clientX;
      known.y = event.clientY;
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        zoom.s = Math.max(1, Math.min(6, (pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / pinch.dist));
        bound();
        apply();
      } else if (drag) {
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (zoom.s > 1) {
          zoom.x += dx;
          zoom.y += dy;
          bound();
          apply();
        }
      }
    });
    const lift = (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.delete(event.pointerId);
      if (pinch) {
        if (pointers.size < 2) pinch = null;
        if (zoom.s < 1.05) {
          zoom.s = 1;
          bound();
          apply();
        }
        if (pointers.size === 1) {
          const [rest] = [...pointers.values()];
          drag = { x: rest.x, y: rest.y, startX: rest.x, startY: rest.y, t: Date.now(), moved: 99 };
        } else drag = null;
        return;
      }
      if (!drag || event.type === 'pointercancel') {
        drag = null;
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const finished = drag;
      drag = null;
      if (zoom.s <= 1.02 && many && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) return show(review.index + (dx < 0 ? 1 : -1));
      if (finished.moved < 10 && Date.now() - finished.t < 300) {
        const now = Date.now();
        if (now - lastTap < 320) {
          lastTap = 0;
          if (zoom.s > 1.02) {
            zoom.s = 1;
            zoom.x = 0;
            zoom.y = 0;
          } else {
            const box = stage.getBoundingClientRect();
            zoom.s = 2.5;
            zoom.x = (box.left + box.width / 2 - event.clientX) * 1.5;
            zoom.y = (box.top + box.height / 2 - event.clientY) * 1.5;
            bound();
          }
          apply();
        } else lastTap = now;
      }
    };
    stage.addEventListener('pointerup', lift);
    stage.addEventListener('pointercancel', lift);
    stage.addEventListener('wheel', (event) => {
      event.preventDefault();
      zoom.s = Math.max(1, Math.min(6, zoom.s * Math.exp(-event.deltaY * 0.0022)));
      bound();
      apply();
    }, { passive: false });
    review.dialog.append(head, stage);
    if (many) {
      const strip = el('div', 'pr-strip');
      review.refs.thumbs = review.entries.map((entry, index) => {
        const thumb = el('button', 'pr-thumb');
        const small = el('img');
        small.src = entry.url;
        small.alt = '';
        thumb.append(small);
        thumb.onclick = () => show(index);
        strip.append(thumb);
        return thumb;
      });
      review.dialog.append(strip);
    }
    review.dialog.append(photoReviewBar(review));
    show(review.index);
    if (review.focusCaption && review.refs.caption) {
      review.focusCaption = false;
      requestAnimationFrame(() => review.refs.caption && review.refs.caption.focus());
    }
  }
  async function sendPhotoPending(pendings) {
    window.MimiHooks?.notify?.chatSound('sent');
    for (const pending of pendings) {
      const failures = await sendPending(pending);
      if (failures.length > 0) {
        toast('อัปโหลดไม่สำเร็จ', failures[0], true);
        if (state.chat && state.chat.id === pending.chatId) restoreEntries(pending.entries, '');
      }
    }
  }
  /** Images picked together open the caption sheet; other files keep the compact staged chips. */
  function stageFiles(files, options = {}) {
    const list = [...files];
    const images = list.filter(isImageFile);
    const others = list.filter((file) => !isImageFile(file));
    for (const file of others) void stageFile(file, options);
    const known = photoReview ? photoReview.entries.length : 0;
    let room = Math.max(0, 20 - known);
    const accepted = [];
    for (const file of images) {
      if (room <= 0) {
        toast('แนบรูปได้สูงสุด 20 ไฟล์', 'ส่งชุดนี้ก่อน แล้วค่อยเลือกชุดถัดไป', true);
        break;
      }
      if (file.size > 25 * 1024 * 1024) {
        toast('ไฟล์ใหญ่เกินไป', `${file.name} เกิน 25 MB`, true);
        continue;
      }
      if (known + accepted.length === 6) {
        toast('รูปเกิน 6 รูป', 'โมเดลจะเห็นรูปจริง 6 รูปสุดท้าย รูปที่เหลือจะถูกอธิบายด้วยข้อความ', true);
      }
      if (/^image\/(heic|heif|avif)$/i.test(file.type) || /\.(heic|heif|avif)$/i.test(file.name)) {
        toast('รูปชนิดนี้อาจไม่แสดงโดยตรง', 'โมเดลอาจเห็นได้เพียงคำอธิบายของรูป ไม่ใช่ตัวรูป', true);
      }
      accepted.push({ file, url: URL.createObjectURL(file), caption: '', selected: true });
      room--;
    }
    if (accepted.length > 0) openPhotoReview(accepted, options);
  }

  /** In a group: offers the members while the user types "@na…". */
  function renderMention() {
    const box = $('mention');
    if (!state.chat || state.chat.kind !== 'group' || !input.value.includes('@')) {
      box.hidden = true;
      return;
    }
    const before = input.value.slice(0, input.selectionStart);
    const match = /(^|\s)@([\p{L}\p{M}\p{N}_-]*)$/u.exec(before);
    if (!match || !state.chat || state.chat.kind !== 'group') {
      box.hidden = true;
      return;
    }
    const typed = match[2].toLowerCase();
    const options = state.chat.agents.filter((name) => name.startsWith(typed) || nameOf(name).toLowerCase().startsWith(typed));
    box.hidden = options.length === 0;
    box.replaceChildren(
      ...options.map((name, index) => {
        const row = button(index === 0 ? 'on' : '', null, () => {
          const start = before.length - match[2].length;
          input.value = `${input.value.slice(0, start)}${name} ${input.value.slice(input.selectionStart)}`;
          input.focus();
          input.selectionStart = input.selectionEnd = start + name.length + 1;
          box.hidden = true;
        });
        row.append(avatar(name, 'sm'), el('span', '', nameOf(name)), el('small', 'faint', `@${name}`));
        return row;
      }),
    );
  }

  /** An empty composer offers the microphone; once there is something to send, the send button. */
  let lastEmpty = null;
  function markEmpty() {
    const empty = input.value.length === 0 && state.staged.length === 0;
    if (empty === lastEmpty) return;
    lastEmpty = empty;
    $('box').classList.toggle('empty', empty);
  }
  input.addEventListener('input', (event) => {
    // Thai has no spaces: break anywhere as soon as the first Thai letter appears, once,
    // so WebView never runs its word dictionary while the user types.
    if (!input.classList.contains('th') && THAI.test(event.data || input.value)) input.classList.add('th');
    // Thai (and other) IMEs fire input for every syllable while composing. Do nothing at
    // all then: no measuring, no re-render. compositionend catches up.
    if (composing || event.isComposing) return;
    refreshComposer();
  });
  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    refreshComposer();
  });
  // A keyboard that loses focus mid-composition may never send compositionend.
  input.addEventListener('blur', () => {
    if (!composing) return;
    composing = false;
    refreshComposer();
  });
  // Search is in the chat list's side pane on desktop; in mobile mode it is a button at the top.
  $('toggle-rail').before(button('btn ghost icon', '⌕', () => $('open-search').click(), t('top.search')));
  input.addEventListener('keydown', (event) => {
    const mention = $('mention');
    if (!mention.hidden && (event.key === 'Tab' || event.key === 'Enter')) {
      event.preventDefault();
      mention.firstElementChild.click();
      return;
    }
    if (event.key === 'Escape') {
      mention.hidden = true;
      if (!input.value && !$('stop').hidden) send({ type: 'abort', chatId: state.chat && state.chat.id });
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
      event.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData ? event.clipboardData.files : [])];
    if (files.length === 0) return;
    event.preventDefault();
    stageFiles(files);
  });
  $('send').onclick = sendMessage;
  $('stop').onclick = () => send({ type: 'abort', chatId: state.chat && state.chat.id });
  // The attach button. With a finger: press and hold, big buttons come up above it, slide to one and
  // let go (a short tap opens the same buttons to tap). With a mouse: a click opens a list, which also
  // has "add folder".
  const cameraInput = el('input');
  cameraInput.type = 'file';
  cameraInput.accept = 'image/*';
  cameraInput.setAttribute('capture', 'environment');
  cameraInput.hidden = true;
  $('file-input').after(cameraInput);
  cameraInput.onchange = (event) => {
    stageFiles(event.target.files, { caption: true });
    event.target.value = '';
  };
  const folderInput = el('input');
  folderInput.type = 'file';
  folderInput.multiple = true;
  folderInput.setAttribute('webkitdirectory', '');
  folderInput.hidden = true;
  $('file-input').after(folderInput);
  /** A folder's files: the visible ones, at most 20 (the most one message takes), subfolders included. */
  folderInput.onchange = (event) => {
    const all = [...event.target.files].filter((file) => !file.name.startsWith('.') && !/(^|\/)\.[^/]/.test(file.webkitRelativePath || ''));
    event.target.value = '';
    if (all.length === 0) return toast('โฟลเดอร์นี้ไม่มีไฟล์', 'ลองเลือกโฟลเดอร์อื่น', true);
    const room = Math.max(0, 20 - state.staged.length);
    const take = all.slice(0, Math.max(1, room));
    if (all.length > take.length) toast(`แนบได้ ${take.length} จาก ${all.length} ไฟล์`, 'ส่งชุดนี้ก่อน แล้วค่อยแนบไฟล์ที่เหลือ', true);
    stageFiles(take);
  };
  const quickItems = [
    { key: 'image', label: 'รูปภาพ', hint: 'เลือกได้หลายรูป', accept: 'image/*', icon: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>') },
    { key: 'camera', label: 'ถ่ายรูป', hint: 'เปิดกล้อง', camera: true, icon: svg('<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>') },
    { key: 'file', label: 'ไฟล์ / เอกสาร', hint: 'PDF, TXT, MD, …', accept: '', icon: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>') },
    { key: 'audio', label: 'ไฟล์เสียง', hint: '', accept: 'audio/*', icon: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>') },
    { key: 'video', label: 'วิดีโอ', hint: 'ไม่เกิน 25 MB', accept: 'video/*', icon: svg('<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>') },
  ];
  const pickItem = (item) => {
    if (item.camera) return cameraInput.click();
    $('file-input').accept = item.accept;
    $('file-input').click();
  };
  // Desktop list: the same choices plus the folder.
  const menu = $('attach-menu');
  menu.replaceChildren(
    ...quickItems.map((item) => {
      const row = button('', null, () => {
        menu.hidden = true;
        pickItem(item);
      });
      row.append(el('span', 'mi', ''), item.label);
      row.firstChild.innerHTML = item.icon;
      if (item.hint) row.append(el('small', '', item.hint));
      return row;
    }),
  );
  if (!window.matchMedia('(pointer: coarse)').matches) {
    const folder = button('', null, () => {
      menu.hidden = true;
      folderInput.click();
    });
    const icon = el('span', 'mi', '');
    icon.innerHTML = svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>');
    folder.append(icon, 'เพิ่มโฟลเดอร์', el('small', '', 'ทุกไฟล์ในโฟลเดอร์'));
    menu.append(folder);
  }

  // Touch: the big buttons.
  let quick = null; // { node, items: [{ item, node }], hover, hold }
  const closeQuick = () => {
    if (!quick) return;
    quick.node.remove();
    quick = null;
    $('attach').classList.remove('pressing');
  };
  const quickHit = (x, y) => {
    if (!quick) return null;
    // Within the pill, any height counts as the nearest row, so a slightly sideways finger still picks.
    const rect = quick.node.getBoundingClientRect();
    if (x < rect.left - 40 || x > rect.right + 40 || y < rect.top - 10 || y > rect.bottom + 10) return null;
    for (const entry of quick.items) {
      const box = entry.node.getBoundingClientRect();
      if (y >= box.top - 3 && y <= box.bottom + 3) return entry;
    }
    return null;
  };
  const quickHover = (entry) => {
    if (!quick || quick.hover === entry) return;
    if (quick.hover) quick.hover.node.classList.remove('hot');
    quick.hover = entry;
    if (entry) {
      entry.node.classList.add('hot');
      if (navigator.vibrate) navigator.vibrate(8);
    }
  };
  const openQuick = (hold) => {
    closeQuick();
    const node = el('div', 'attach-quick');
    node.setAttribute('role', 'menu');
    const items = quickItems.map((item) => {
      const row = el('button', 'aq-item');
      row.setAttribute('role', 'menuitem');
      const dot = el('span', 'aq-dot');
      dot.innerHTML = item.icon;
      row.append(dot, el('span', 'aq-label', item.label));
      row.onclick = (event) => {
        event.stopPropagation();
        closeQuick();
        pickItem(item);
      };
      return { item, node: row };
    });
    // The first choice sits nearest the finger: the stack is built upwards from the button.
    node.append(...items.map((entry) => entry.node).reverse());
    document.body.append(node);
    const anchor = $('attach').getBoundingClientRect();
    node.style.left = `${Math.max(10, Math.min(anchor.left, window.innerWidth - node.offsetWidth - 10))}px`;
    node.style.bottom = `${Math.max(10, window.innerHeight - anchor.top + 12)}px`;
    quick = { node, items, hover: null, hold };
    $('attach').classList.add('pressing');
  };
  let attachTouch = false;
  let attachLong = false;
  let attachTimer = null;
  const attach = $('attach');
  attach.addEventListener('pointerdown', (event) => {
    attachLong = false;
    attachTouch = event.pointerType !== 'mouse';
    if (!attachTouch) return;
    try {
      attach.setPointerCapture(event.pointerId);
    } catch {
      // synthetic pointer
    }
    clearTimeout(attachTimer);
    attachTimer = setTimeout(() => {
      attachLong = true;
      openQuick(true);
      if (navigator.vibrate) navigator.vibrate(15);
    }, 320);
  });
  attach.addEventListener('pointermove', (event) => {
    if (!quick || !quick.hold) return;
    quickHover(quickHit(event.clientX, event.clientY));
  });
  attach.addEventListener('pointerup', (event) => {
    clearTimeout(attachTimer);
    if (!quick || !quick.hold) return;
    // Let go over a button: that one; anywhere else: nothing, the list just closes.
    const entry = quickHit(event.clientX, event.clientY);
    closeQuick();
    if (entry) pickItem(entry.item);
  });
  attach.addEventListener('pointercancel', () => {
    clearTimeout(attachTimer);
    if (quick && quick.hold) closeQuick();
  });
  attach.addEventListener('contextmenu', (event) => event.preventDefault());
  attach.onclick = (event) => {
    event.stopPropagation();
    if (attachLong) {
      attachLong = false; // the hold already did its job
      return;
    }
    if (attachTouch && event.detail !== 0) {
      if (quick) closeQuick();
      else openQuick(false);
    } else menu.hidden = !menu.hidden;
  };
  $('file-input').onchange = (event) => {
    stageFiles(event.target.files);
    event.target.value = '';
  };
  document.addEventListener('click', () => {
    menu.hidden = true;
    closeQuick();
  });
  const box = $('box');
  for (const type of ['dragenter', 'dragover']) {
    box.addEventListener(type, (event) => {
      event.preventDefault();
      box.classList.add('drop');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    box.addEventListener(type, (event) => {
      event.preventDefault();
      box.classList.remove('drop');
    });
  }
  box.addEventListener('drop', (event) => stageFiles(event.dataTransfer.files));

  $('back').onclick = () => $('app').classList.add('show-side');
  /** Up to 1180px wide the chat settings panel floats over the chat (a card in mobile mode) instead of sitting beside it. */
  const railFloats = () => window.innerWidth <= 1180;
  function setRail(open) {
    state.railOpen = open;
    if (!railFloats()) store.set('mimi.rail', open ? '1' : '0');
    renderRail();
  }
  $('toggle-rail').onclick = () => setRail(!state.railOpen);
  // A floating panel folds back when the chat is tapped, or with Esc (capture: before a click re-renders its content).
  document.addEventListener(
    'click',
    (event) => {
      if (!railFloats() || !state.railOpen || $('rail').hidden) return;
      if ($('rail').contains(event.target) || $('toggle-rail').contains(event.target)) return;
      if (event.target.closest('#overlay, .dialog, .ctxmenu')) return;
      setRail(false);
    },
    true,
  );
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && railFloats() && state.railOpen && !$('rail').hidden && !document.querySelector('#overlay .dialog')) setRail(false);
  });
  function toggleCharacter() {
    if (!state.chat) return;
    store.set(`mimi.chat.${state.chat.id}.character`, characterOn() ? '0' : '1');
    renderHeader();
    renderRail();
  }
  $('toggle-char').onclick = toggleCharacter;
  // Crossing the width where the app changes mode re-lays the screen out.
  window.addEventListener('resize', () => {
    const mode = modeNow();
    if (document.documentElement.dataset.mode === mode) {
      if (followLog) requestAnimationFrame(scrollDown);
      else requestAnimationFrame(updateJump);
      return;
    }
    document.documentElement.dataset.mode = mode;
    if (mode === 'mobile') state.railOpen = false;
    renderHeader();
    renderRail();
    if (followLog) requestAnimationFrame(scrollDown);
  });
  $('new-session').onclick = () => {
    if (state.chat && confirm('เริ่ม session ใหม่? บทสนทนาเดิมยังเปิดดูได้จากรายการ session และ agent ยังจำเรื่องสำคัญได้')) {
      send({ type: 'session-new', chatId: state.chat.id });
    }
  };
  $('to-latest').onclick = () => state.chat && openChat(state.chat.id);

  // ---------- presence ----------
  // The server notifies about agent messages only for chats nobody is looking at.
  let lastPresence = '';
  function reportPresence(force) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      lastPresence = '';
      return;
    }
    const visible = pageVisible();
    const chatId = state.view === 'chat' && state.chat ? state.chat.id : null;
    const key = `${chatId}:${visible}`;
    if (!force && key === lastPresence) return;
    lastPresence = key;
    send({ type: 'presence', chatId, visible });
  }
  document.addEventListener('visibilitychange', () => reportPresence());
  window.addEventListener('focus', () => reportPresence());

  // ---------- views ----------
  function setView(view) {
    state.view = view;
    applyTheme();
    setTimeout(() => reportPresence(), 0);
    for (const name of ['chat', 'overseer', 'agents', 'hub', 'settings']) $(`view-${name}`).hidden = name !== view;
    for (const item of $('nav').children) item.classList.toggle('on', item.dataset.view === view);
    if (view === 'overseer') {
      window.MimiHooks?.overseer?.render?.();
      send({ type: 'overseer-get' });
    }
    if (view === 'agents') renderAgents();
    if (view === 'hub') renderHub();
    if (view === 'settings') renderSettings();
    if (view === 'chat' && !state.chat && !logInner.firstChild) emptyState();
    renderRail();
  }
  for (const item of $('nav').children) {
    item.onclick = () => {
      setView(item.dataset.view);
      if (item.dataset.view !== 'chat' || state.chat) $('app').classList.remove('show-side');
      if (item.dataset.view === 'hub') {
        send({ type: 'skills-list' });
        send({ type: 'triggers-list' });
        send({ type: 'tools-list' });
        send({ type: 'workflows-list' });
        send({ type: 'secrets-list' });
        send({ type: 'mail-watch' });
        send({ type: 'calendar-sync' });
      }
      if (item.dataset.view === 'agents') {
        send({ type: 'tools-list' });
        send({ type: 'workflows-list' });
      }
      if (item.dataset.view === 'settings') {
        send({ type: 'memory-list' });
      }
    };
  }
  function pageHead(title, lead) {
    const head = el('div');
    const row = el('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center';
    const back = button('back', '‹', () => $('app').classList.add('show-side'), 'กลับ');
    back.setAttribute('aria-label', 'กลับ');
    row.append(back, el('h2', '', title));
    head.append(row, el('p', 'lead', lead));
    return head;
  }
  function labelled(text, control) {
    const wrap = el('div');
    wrap.append(el('label', '', text), control);
    return wrap;
  }
  function textInput(value, placeholder, type) {
    const node = el('input');
    node.type = type || 'text';
    node.value = value === undefined || value === null ? '' : value;
    node.placeholder = placeholder || '';
    node.autocomplete = 'off';
    return node;
  }
  function checkList(items, checked, describe) {
    const box = el('div', 'checks');
    for (const item of items) {
      const label = el('label', 'check');
      const check = el('input');
      check.type = 'checkbox';
      check.value = item.name;
      check.checked = checked.includes(item.name);
      label.append(check, el('span', 'mono', item.name), el('small', '', describe(item)));
      box.append(label);
    }
    if (items.length === 0) box.append(el('span', 'faint', '—'));
    return box;
  }
  const picked = (box) => [...box.querySelectorAll('input:checked')].map((check) => check.value);
  /** Every tool an agent may list: the pool plus the presets (configured instances). */
  function toolItems() {
    const items = state.tools.map((tool) => ({ ...tool, preset: false }));
    for (const preset of state.toolPresets || []) {
      const base = state.tools.find((tool) => tool.name === preset.tool);
      items.push({
        name: preset.name,
        risk: base ? base.risk : '?',
        description: `${preset.label || preset.name} — preset ของ ${preset.tool}`,
        preset: true,
      });
    }
    return items;
  }
  const describeTool = (tool) => `${tool.preset ? '★ preset · ' : ''}${tool.risk} · ${tool.description.split('. ')[0]}`;
  const presetLabel = (preset) => {
    const knobs = [
      preset.temperature !== undefined && `temp ${preset.temperature}`,
      preset.topP !== undefined && `top_p ${preset.topP}`,
      preset.topK !== undefined && `top_k ${preset.topK}`,
      preset.reasoning && `effort ${preset.reasoning}`,
    ].filter(Boolean);
    return `★ ${preset.name} → ${preset.model}${knobs.length ? ` (${knobs.join(', ')})` : ''}`;
  };
  const REASONING_CHOICES = [
    ['', 'ค่าเริ่มต้นของผู้ให้บริการ'],
    ['none', 'none — ไม่คิด (เร็วสุด)'],
    ['minimal', 'minimal'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'max — คิดเต็มที่ (ช้าสุด)'],
  ];
  const MEDIA_KEYS = ['image_model', 'speech_model', 'video_model'];
  /** What a model must be, take or make to be offered for a key (models.dev type and modalities). */
  const CAPABILITY_NEEDS = {
    model: { type: ['chat'], output: ['text'] },
    vision_model: { type: ['chat'], input: ['image', 'pdf', 'video'], output: ['text'] },
    transcript_model: { type: ['chat', 'transcription'], input: ['audio'], output: ['text'] },
    small_model: { type: ['chat'], output: ['text'] },
    image_model: { type: ['image'], output: ['image'] },
    speech_model: { type: ['speech'], output: ['audio'] },
    video_model: { type: ['video'], output: ['video'] },
  };
  /** A model without metadata has unknown abilities: keep it in every picker. */
  function fitsCapability(model, capability) {
    const need = CAPABILITY_NEEDS[capability];
    if (!need) return true;
    if (need.type && model.type && !need.type.includes(model.type)) return false;
    if (need.input && model.input && !need.input.some((kind) => model.input.includes(kind))) return false;
    if (need.output && model.output && !need.output.every((kind) => model.output.includes(kind))) return false;
    return true;
  }
  /** Capabilities grouped by what they are for: reading the user's input, background work, making media. */
  const CAPABILITY_GROUPS = [
    [
      'โมเดลหลักและตัวช่วยอ่าน',
      [
        ['model', 'โมเดลหลัก (core) — ตอบทุกอย่าง'],
        ['vision_model', 'ตัวช่วยอ่านรูป / PDF / วิดีโอ → ข้อความ'],
        ['transcript_model', 'ตัวช่วยถอดเสียง → ข้อความ'],
      ],
    ],
    ['ข้อความสั้น / งานเบื้องหลัง', [['small_model', 'สรุป, ความจำ, งานเวิร์กโฟลว์ (@small)']]],
    [
      'เอาต์พุต — สร้างสื่อ',
      [
        ['image_model', 'สร้างรูปภาพ (generate_image)'],
        ['speech_model', 'สร้างเสียงพูด (text_to_speech)'],
        ['video_model', 'สร้างวิดีโอ (generate_video)'],
      ],
    ],
  ];
  const CAPABILITIES = CAPABILITY_GROUPS.flatMap(([, items]) => items);
  /** A model picker: presets from the model pool first, then the models that fit this input / output. */
  function modelSelect(current, emptyLabel, capability, withPresets = true) {
    const select = el('select');
    const view = state.settings || { models: [], presets: [] };
    const add = (value, text) => {
      const option = el('option', '', text);
      option.value = value;
      select.append(option);
    };
    if (emptyLabel !== null) add('', `— ${emptyLabel} —`);
    const byRef = new Map(view.models.map((model) => [model.ref, model]));
    const models = view.models.filter((model) => fitsCapability(model, capability));
    const presets = (withPresets ? view.presets : []).filter((preset) => {
      const model = byRef.get(preset.model);
      return !model || fitsCapability(model, capability);
    });
    const known = new Set([...presets.map((preset) => preset.name), ...models.map((model) => model.ref)]);
    if (current && !known.has(current)) {
      add(current, `${current} (ใช้ไม่ได้กับงานนี้ หรือยังไม่ได้เชื่อมต่อ)`);
    }
    for (const preset of presets) add(preset.name, presetLabel(preset));
    for (const model of models) add(model.ref, model.label);
    select.value = current || '';
    select.dataset.initial = current || '';
    return select;
  }
  /** Progress text next to the save buttons of the page that is open. */
  function flash(message) {
    for (const node of document.querySelectorAll(`#view-${state.view} .foot .msg`)) node.textContent = message;
  }
  const saved = () => toast('บันทึกแล้ว ✓');

  // ---------- agents page ----------
  function renderAgents() {
    const page = $('view-agents');
    const agent = agentOf(ui.agent) || null;
    // Stays in view while the long form scrolls (a strip across the top on a phone).
    const list = el('div', 'panel agentpick');
    list.append(el('h3', '', 'Agent ทั้งหมด'));
    const visible = state.agents.filter((entry) => entry.name !== 'overseer');
    const items = el('div', 'list');
    for (const entry of visible) {
      const row = button(`item${entry.name === ui.agent ? ' on' : ''}`, null, () => {
        ui.agent = entry.name;
        ui.agentDirty = false;
        renderAgents();
      });
      const info = el('div');
      info.style.minWidth = '0';
      info.append(el('b', '', nameOf(entry.name)), el('small', '', `${entry.name} · ${entry.models.model || 'โมเดลเริ่มต้น'}`));
      row.append(avatar(entry.name), info);
      items.append(row);
    }
    if (visible.length === 0) items.append(el('div', 'empty', 'ยังไม่มี agent — กรอกแบบฟอร์มแล้วกดบันทึก หรือให้ Overseer สร้างให้'));
    list.append(items);
    const create = button('btn', '+ สร้าง agent ใหม่', () => {
      ui.agent = null;
      ui.agentDirty = false;
      renderAgents();
    });
    create.style.marginTop = '10px';
    list.append(create);

    const form = el('div', 'panel form');
    form.oninput = () => {
      ui.agentDirty = true;
    };
    form.append(el('h3', '', agent ? `แก้ไข ${agent.name}` : 'Agent ใหม่'));
    const name = textInput(agent ? agent.name : '', 'เช่น mimi (a-z 0-9 - _)');
    const displayName = textInput(agent ? agent.displayName : '', 'ชื่อที่แสดงในแชต เช่น มีมี่');
    const description = textInput(agent ? agent.description : '', 'ทำหน้าที่อะไร (agent อื่นใช้ตัดสินใจว่าจะถามใคร)');
    const top = el('div', 'grid2');
    top.append(labelled('ชื่อ (id)', name), labelled('ชื่อที่แสดง', displayName));
    form.append(top, labelled('คำอธิบายสั้น ๆ', description));
    const intro = el('textarea');
    intro.value = agent && agent.intro ? agent.intro : '';
    intro.placeholder = 'เช่น ใจเย็น ละเอียดเรื่องตัวเลข ชอบถามกลับให้ชัดก่อนทำ · ส่งงานบัญชี รายรับรายจ่าย มาที่ตัวนี้';
    intro.style.minHeight = '60px';
    form.append(labelled('การ์ดแนะนำตัว (agent ตัวอื่นเห็น: นิสัย จุดเด่น วิธีทำงานด้วย)', intro));
    form.append(el('p', 'hint', 'effort / temperature / top_p ของโมเดล ตั้งที่ preset ใน Hub → Models แล้วเลือก preset นั้นในช่องโมเดล'));
    const systemPrompt = el('textarea', 'tall');
    systemPrompt.value = agent ? agent.systemPrompt : '';
    systemPrompt.placeholder = 'System prompt: บุคลิก กฎ และวิธีทำงานของ agent นี้';
    form.append(labelled('System prompt', systemPrompt));
    form.append(el('p', 'hint', 'ตัวแปรใน prompt: {{user}} = ผู้ใช้ · {{char}} = agent ตัวนี้ · {{id ของ agent}} เช่น {{tim}} = ชื่อ agent นั้น'));

    if (agent) {
      form.append(el('h4', '', 'รูปของ agent'));
      const pictures = el('div', 'pics');
      for (const [slot, label, frameClass] of [['avatar', 'รูปโปรไฟล์', 'a'], ['portrait', 'รูปเต็มตัว (พื้นหลังแชต)', 'p']]) {
        const picture = el('div', 'pic');
        const frame = el('div', `frame ${frameClass}`, 'ไม่มีรูป');
        if (agent[slot]) {
          blobUrl(`/api/agent-image/${encodeURIComponent(agent.name)}/${slot}?v=${agent[slot]}`)
            .then((url) => {
              const image = el('img');
              image.src = url;
              frame.replaceChildren(image);
            })
            .catch(() => {});
        }
        const choose = el('input');
        choose.type = 'file';
        choose.accept = 'image/png,image/jpeg,image/webp,image/gif';
        choose.hidden = true;
        choose.onchange = async () => {
          const file = choose.files[0];
          if (!file) return;
          const response = await api(`/api/agent-image/${encodeURIComponent(agent.name)}/${slot}`, {
            method: 'POST',
            headers: { 'content-type': file.type },
            body: file,
          });
          if (!response.ok) return toast('อัปโหลดรูปไม่สำเร็จ', (await response.json()).error, true);
          const image = el('img');
          image.src = URL.createObjectURL(file);
          frame.replaceChildren(image);
        };
        const row = el('div', 'row');
        row.append(button('btn', 'เลือกรูป', () => choose.click()));
        if (agent[slot]) {
          row.append(
            button('btn ghost', 'ลบ', async () => {
              await api(`/api/agent-image/${encodeURIComponent(agent.name)}/${slot}`, { method: 'DELETE' });
              frame.replaceChildren('ไม่มีรูป');
            }),
          );
        }
        picture.append(frame, el('span', '', label), row, choose);
        pictures.append(picture);
      }
      form.append(pictures);
      form.append(el('h4', '', 'รูปตามอีโมจิ (ของ agent เอง)'));
      form.append(el('p', 'hint', 'agent ส่งอีโมจิไหน ก็เปลี่ยนเป็นรูปนั้นในแชต (ถ้าชุดที่ใส่อยู่ไม่มีรูปสำหรับอีโมจินั้น) · รูปที่ผูกกับชุดตั้งที่ Hub → ตู้เสื้อผ้า'));
      form.append(window.MimiHooks.stage.spriteEditor('agent', agent.name, agent.sprites || {}));
      form.append(el('h4', '', 'คลังภาพสถานการณ์ (Gallery)'));
      form.append(el('p', 'hint', 'ภาพที่ agent เลือกวางทับแชตได้เหมือน CG ใน visual novel (ติ๊กเครื่องมือ gallery_search / gallery_show / gallery_hide / gallery_add ให้ agent) · ใส่ชื่อ แท็ก และคำอธิบายให้ตรงสถานการณ์ agent จะค้นเจอเอง'));
      form.append(window.MimiHooks.gallery.manager(agent.name));
    } else {
      form.append(el('p', 'hint', 'บันทึก agent ก่อน แล้วจึงใส่รูปโปรไฟล์และรูปเต็มตัวได้'));
    }

    form.append(el('h4', '', 'ตัวละคร (รูป / โมเดล 3D)'));
    const charBox = el('div');
    const charHook = window.MimiHooks && window.MimiHooks.character;
    if (agent && charHook) charHook.render(charBox, agent);
    else charBox.append(el('p', 'hint', agent ? 'โหลดระบบตัวละคร 3D ไม่สำเร็จ — รีเฟรชหน้าใหม่' : 'บันทึก agent ก่อน แล้วจึงเลือกตัวละครได้'));
    form.append(charBox);

    form.append(el('h4', '', 'โมเดล (ตามอินพุตที่รับ และสื่อที่สร้าง)'));
    form.append(el('p', 'hint', 'แต่ละช่องแสดงเฉพาะโมเดลที่รับหรือสร้างชนิดนั้นได้ · ช่องที่เว้นว่างใช้ค่าเริ่มต้นจาก Settings'));
    const models = el('div', 'grid2');
    const defaults = state.settings ? state.settings.defaults : {};
    for (const [group, items] of CAPABILITY_GROUPS) {
      const heading = el('div', 'hint', group);
      heading.style.gridColumn = '1 / -1';
      models.append(heading);
      for (const [key, label] of items) {
        // Making media has no fallback: a chat model cannot draw, speak or film.
        const fallback =
          defaults[key] ||
          (key === 'model' ? '' : MEDIA_KEYS.includes(key) ? 'ไม่มี' : key === 'small_model' ? 'โมเดลคุยของ agent นี้' : 'ให้ core อ่านเอง');
        const select = modelSelect(agent ? agent.models[key] : '', `ค่าเริ่มต้น${fallback ? `: ${fallback}` : ''}`, key);
        select.dataset.capability = key;
        models.append(labelled(label, select));
      }
    }
    form.append(models);

    form.append(el('h4', '', 'Skill (จาก Skill hub)'));
    const skills = checkList(state.skills, agent ? agent.skills || [] : [], (skill) => `${skill.model ? `ใช้โมเดล ${skill.model} · ` : ''}${skill.description}`);
    form.append(skills);
    form.append(el('h4', '', 'Node tool (Quick Work)'));
    form.append(el('p', 'hint', 'การ์ดละหนึ่งงาน — agent เลือกเรียกเองเมื่อเหมาะ · ตั้งค่าประจำ node ได้โดยไม่ต้องสร้าง workflow · ส่วน Skill ยังใช้รายการเดิม'));
    const toolBox = el('div');
    const toolHook = window.MimiHooks && window.MimiHooks.agentTools;
    const toolGrid = toolHook ? toolHook.render(toolBox, () => name.value.trim(), agent ? agent.tools : []) : null;
    const tools = toolGrid ? null : checkList(toolItems(), agent ? agent.tools : [], describeTool);
    form.append(toolGrid ? toolBox : tools);
    form.append(el('h4', '', 'Agent permissions'));
    form.append(el('p', 'hint', 'Per tool or preset: default follows the risk policy. "allow" never asks, "ask" always asks, "deny" always refuses.'));
    const permissionRows = new Map();
    const permissionCells = new Map();
    const toolsForPolicy = () => (toolGrid ? toolGrid.names() : picked(tools));
    const policyNames = new Set([...(agent ? Object.keys(agent.permissions || {}) : []), ...toolsForPolicy()]);
    const matrix = el('div', 'perm-matrix');
    if (policyNames.size > 0) {
      const filter = el('input', 'perm-filter');
      filter.placeholder = 'Filter tools';
      filter.oninput = () => {
        const query = filter.value.trim().toLowerCase();
        for (const [tool, row] of permissionCells) row.hidden = Boolean(query) && !tool.toLowerCase().includes(query);
      };
      matrix.append(filter);
    }
    for (const tool of [...policyNames].sort()) {
      const row = el('div', 'perm-row');
      row.append(el('span', 'perm-name mono', tool));
      const select = el('select');
      for (const [value, label] of [['', 'default'], ['allow', 'allow'], ['ask', 'ask'], ['deny', 'deny']]) {
        const option = el('option', '', label);
        option.value = value;
        select.append(option);
      }
      select.value = (agent && agent.permissions && agent.permissions[tool]) || '';
      row.append(select);
      matrix.append(row);
      permissionRows.set(tool, select);
      permissionCells.set(tool, row);
    }
    if (permissionRows.size === 0) matrix.append(el('p', 'hint', 'Pick tools above; their policy appears here.'));
    form.append(matrix);
    const lazyLabel = el('label', 'hstack');
    const lazyTools = el('input');
    lazyTools.type = 'checkbox';
    lazyTools.checked = Boolean(agent && agent.lazyTools);
    lazyLabel.append(lazyTools, el('span', '', 'Lazy tools: send only tool_search and load a tool when the model asks for it (for large tool lists)'));
    form.append(lazyLabel);
    form.append(el('h4', '', 'ส่งงานต่อให้ agent ไหนได้บ้าง (นอกแชตกลุ่ม)'));
    const peers = checkList(state.agents.filter((entry) => entry.name !== ui.agent), agent ? agent.canMessage : [], (entry) => entry.description);
    form.append(peers);

    // Workflows belong to this agent (feature-workflows.js).
    form.append(el('h4', '', 'Workflow (automation ของ agent นี้)'));
    const wfBox = el('div');
    const wfHook = window.MimiHooks && window.MimiHooks.agentWorkflows;
    if (agent && wfHook) wfHook.render(wfBox, agent.name);
    else wfBox.append(el('p', 'hint', agent ? 'โหลดหน้าจอ workflow ไม่สำเร็จ — รีเฟรชหน้าใหม่' : 'บันทึก agent ก่อน แล้วจึงสร้าง workflow ได้'));
    form.append(wfBox);

    form.append(el('h4', '', 'งบต่อหนึ่งรอบการทำงาน'));
    const rounds = textInput(agent ? agent.budgets.maxRounds : 12, '', 'number');
    const tokens = textInput(agent ? agent.budgets.maxTokens : 200000, '', 'number');
    const budgets = el('div', 'grid2');
    budgets.append(labelled('จำนวนรอบสูงสุด', rounds), labelled('token สูงสุด', tokens));
    form.append(budgets);

    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'));
    if (agent) {
      foot.append(
        button('btn ghost', 'เปิดแชต', () => {
          const chat = state.chats.find((entry) => entry.kind === 'direct' && entry.agents[0] === agent.name);
          if (chat) openChat(chat.id);
          else startChat({ type: 'chat-create', kind: 'direct', agents: [agent.name] });
        }),
        button('btn danger', 'ลบ', () => {
          if (confirm(`ลบ agent "${agent.name}" ?\nแชตตัวต่อตัว สถานะ และรูปของ agent นี้จะถูกลบด้วย`)) {
            send({ type: 'agent-delete', name: agent.name });
            ui.agent = null;
            ui.agentDirty = false;
          }
        }),
      );
    }
    foot.append(
      button('btn pri', 'บันทึก', () => {
        const chosen = {};
        for (const select of models.querySelectorAll('select')) if (select.value) chosen[select.dataset.capability] = select.value;
        flash('กำลังบันทึก…');
        const charHook = window.MimiHooks && window.MimiHooks.character;
        const character = (charHook && charHook.form && charHook.form()) || {};
        if (toolGrid) toolGrid.persist();
        const permissionPolicy = {};
        for (const [tool, select] of permissionRows) {
          if (select.value === 'allow' || select.value === 'ask' || select.value === 'deny') permissionPolicy[tool] = select.value;
        }
        send({
          type: 'agent-save',
          renameFrom: agent ? agent.name : undefined,
          agent: {
            name: name.value.trim(),
            displayName: displayName.value.trim(),
            description: description.value.trim(),
            intro: intro.value.trim(),
            systemPrompt: systemPrompt.value,
            models: chosen,
            tools: toolGrid ? toolGrid.names() : picked(tools),
            lazyTools: lazyTools.checked,
            permissions: permissionPolicy,
            skills: picked(skills),
            canMessage: picked(peers),
            budgets: { maxRounds: Number(rounds.value) || 12, maxTokens: Number(tokens.value) || 200000 },
            ...character,
          },
        });
      }),
    );
    form.append(foot);

    const split = el('div', 'split');
    split.append(list, form);
    page.replaceChildren(pageHead('Agent', 'แต่ละตัวมีบุคลิก โมเดล skill และเครื่องมือของตัวเอง คุยตัวต่อตัวหรือจับเข้ากลุ่มก็ได้'), split);
  }

  // ---------- hub page ----------
  // Every tab says in one line what it holds; lists are cards or a table, and everything is
  // added, edited and deleted in popups (feature-hubkit.js), so the list never jumps around.
  const HUB_TABS = [
    ['models', 'กองโมเดล', 'ชุด "โมเดล + ค่าการสุ่ม" ที่ตั้งชื่อไว้ แล้วเลือกใช้ได้ทุกที่ที่เลือกโมเดล (agent, skill, workflow)'],
    ['skills', 'Skill', 'คู่มือการทำงานเฉพาะเรื่อง (เช่น เขียนเพลง ตรวจสัญญา) ที่ agent หยิบไปใช้เมื่องานตรงเรื่อง · เขียนเองหรือนำเข้าไฟล์ .md'],
    ['nodes', 'Node & เครื่องมือ', 'ทุกอย่างที่วางใน workflow ได้ และที่ agent เรียกใช้ได้ · บันทึก node ที่ตั้งค่าแล้วเป็น preset เพื่อใช้ซ้ำ'],
    ['triggers', 'Trigger', 'สิ่งที่ทำให้งานเริ่มเอง: ถึงเวลา, มีคนยิง webhook, มีเมลใหม่, ปฏิทินเปลี่ยน…'],
    ['accounts', 'บัญชี', 'บัญชีที่ Mimi เข้าใช้แทนคุณ: Google, Microsoft, กล่องเมล IMAP/POP3 และ connection ของบริการอื่น'],
    ['secrets', 'คีย์ลับ', 'API key / token ที่เครื่องมืออ้างถึงด้วย {{secret.ชื่อ}} · เก็บในเครื่องนี้เท่านั้น'],
    ['knowledge', 'คลังความรู้', 'เอกสารที่ agent ค้นหาคำตอบได้'],
    ['wardrobe', 'ตู้เสื้อผ้า', 'ชุดของตัวละครที่ agent เปลี่ยนใส่ได้'],
    ['backgrounds', 'ฉากหลัง', 'ภาพฉากหลังของแชต'],
    ['packs', 'แพ็ก', 'ชุดสำเร็จรูป: agent + connector + workflow ติดตั้งทีเดียว'],
  ];
  /** Old tab keys still used by links elsewhere in the app. */
  const HUB_ALIAS = { mail: 'accounts', links: 'nodes' };
  function renderHub() {
    const page = $('view-hub');
    ui.hubTab = HUB_ALIAS[ui.hubTab] || ui.hubTab;
    if (!HUB_TABS.some(([key]) => key === ui.hubTab)) ui.hubTab = 'models';
    const counts = {
      models: state.settings ? state.settings.presets.length : undefined,
      skills: state.skills.length,
      triggers: (state.triggers || []).filter((trigger) => trigger.status === 'active').length,
    };
    const tabs = el('div', 'hub-tabs');
    for (const [key, label, lead] of HUB_TABS) {
      const tab = button(key === ui.hubTab ? 'on' : '', label, () => {
        ui.hubTab = key;
        renderHub();
        page.scrollTop = 0;
      }, lead);
      if (counts[key] !== undefined) tab.append(el('small', '', String(counts[key])));
      tabs.append(tab);
    }
    const hook = (name) => () => (window.MimiHooks && window.MimiHooks[name] ? window.MimiHooks[name].render() : el('div'));
    const secrets = () => {
      const panel = el('div');
      const vault = window.MimiHooks && window.MimiHooks.secrets;
      if (vault) vault.render(panel);
      else panel.append(el('p', 'hint', '—'));
      return panel;
    };
    const render = {
      models: hubModels,
      skills: hubSkills,
      nodes: hook('tools'),
      accounts: hook('accounts'),
      secrets,
      triggers: hook('triggers'),
      knowledge: hook('knowledge'),
      wardrobe: hook('wardrobe'),
      backgrounds: hook('backgrounds'),
      packs: hook('packs'),
    }[ui.hubTab];
    const lead = HUB_TABS.find(([key]) => key === ui.hubTab)[2];
    const intro = el('div', 'hub-intro');
    intro.append(el('b', '', `${HUB_TABS.find(([key]) => key === ui.hubTab)[1]}: `), lead);
    const keep = page.scrollTop;
    page.replaceChildren(pageHead('Hub', 'ของกลางที่ agent, skill และ workflow หยิบไปใช้: ตั้งค่าที่เดียว ใช้ได้ทุกตัว'), tabs, intro, render());
    page.scrollTop = keep;
  }
  const shown = (value) => (value === undefined || value === null ? '—' : String(value));

  // ----- กองโมเดล -----
  /** The sampling knobs of a preset: what each means, its range and the value used when left empty. */
  const PRESET_KNOBS = [
    { key: 'temperature', label: 'temperature', def: 1, min: 0, max: 2, step: 0.05, hint: 'ต่ำ = ตอบนิ่ง ตรงประเด็น · สูง = หลากหลาย สร้างสรรค์' },
    { key: 'topP', label: 'top_p', def: 1, min: 0, max: 1, step: 0.01, hint: 'เลือกคำจากกลุ่มที่รวมความน่าจะเป็นได้เท่านี้' },
    { key: 'topK', label: 'top_k', defText: 'ปิด (ไม่จำกัด)', min: 1, max: 1000, whole: true, hint: 'เลือกจาก K คำที่น่าจะเป็นที่สุด · บางผู้ให้บริการไม่รองรับ' },
    { key: 'maxOutputTokens', label: 'max tokens (ความยาวคำตอบสูงสุด)', defText: 'สูงสุดของโมเดล', min: 1, max: 1000000, whole: true },
    { key: 'minTokens', label: 'min tokens (ความยาวคำตอบต่ำสุด)', def: 0, min: 0, max: 1000000, whole: true, hint: 'เฉพาะผู้ให้บริการแบบ OpenAI-compatible (vLLM, OpenRouter …)' },
    { key: 'presencePenalty', label: 'presence penalty', def: 0, min: -2, max: 2, step: 0.05, hint: 'บวก = ชวนพูดเรื่องใหม่ ไม่วนคำเดิม' },
    { key: 'frequencyPenalty', label: 'frequency penalty', def: 0, min: -2, max: 2, step: 0.05, hint: 'บวก = ลดคำที่พูดซ้ำบ่อย' },
    { key: 'repetitionPenalty', label: 'repetition penalty', def: 1, defText: '1 (ไม่ลงโทษ)', min: 0, max: 10, step: 0.01, hint: 'มากกว่า 1 = ลดการพูดซ้ำ · เฉพาะผู้ให้บริการแบบ OpenAI-compatible' },
  ];
  const providerOf = (ref) => (String(ref).includes('/') ? String(ref).slice(0, String(ref).indexOf('/')) : '');
  const providerName = (id) => ((state.settings && state.settings.providers) || []).find((entry) => entry.id === id)?.name || id;
  /** Waiting for the server to confirm a popup's save; the popup closes when it does. */
  let hubPending = null;
  function settleHubPending(kind, ok) {
    if (!hubPending || hubPending.kind !== kind || !ok(hubPending)) return;
    hubPending.popup.done();
    toast(hubPending.done || 'บันทึกแล้ว ✓');
    hubPending = null;
  }

  function presetEditor(preset, copyOf) {
    const Kit = window.MimiKit;
    const view = state.settings || { presets: [], models: [], providers: [] };
    const source = preset || copyOf || null;
    const name = textInput(preset ? preset.name : copyOf ? `${copyOf.name}-copy` : '', 'เช่น creative, precise, pro');
    name.readOnly = Boolean(preset);
    const providerIds = [...new Set(view.models.map((entry) => providerOf(entry.ref)).filter(Boolean))];
    const provider = el('select');
    for (const id of providerIds) {
      const option = el('option', '', `${providerName(id)} (${view.models.filter((entry) => providerOf(entry.ref) === id).length} โมเดล)`);
      option.value = id;
      provider.append(option);
    }
    const startProvider = (source && providerOf(source.model)) || providerIds[0] || '';
    if (startProvider && !providerIds.includes(startProvider)) {
      const option = el('option', '', `${providerName(startProvider)} (ยังไม่ได้เชื่อมต่อ)`);
      option.value = startProvider;
      provider.append(option);
    }
    provider.value = startProvider;
    const model = el('select');
    const fillModels = () => {
      model.replaceChildren();
      const choices = view.models.filter((entry) => providerOf(entry.ref) === provider.value);
      if (source && providerOf(source.model) === provider.value && !choices.some((entry) => entry.ref === source.model)) {
        const option = el('option', '', `${source.model} (ไม่อยู่ในรายการแล้ว)`);
        option.value = source.model;
        model.append(option);
      }
      for (const entry of choices) {
        const option = el('option', '', entry.label.replace(`${providerName(provider.value)} · `, ''));
        option.value = entry.ref;
        model.append(option);
      }
      if (source && [...model.options].some((option) => option.value === source.model)) model.value = source.model;
    };
    fillModels();
    const knobs = {};
    const knobBox = el('div', 'mk-grid2');
    for (const spec of PRESET_KNOBS) {
      knobs[spec.key] = Kit.numberField({ ...spec, value: source ? source[spec.key] : undefined });
      knobBox.append(knobs[spec.key].node);
    }
    const maxDefault = () => {
      const limit = view.models.find((entry) => entry.ref === model.value)?.outputLimit;
      const text = limit ? `${limit.toLocaleString()} (สูงสุดของโมเดล)` : 'สูงสุดของโมเดล';
      knobs.maxOutputTokens.input.placeholder = `ค่าเริ่มต้น: ${text}`;
      knobs.maxOutputTokens.node.querySelector('.mk-num-hint').textContent = `ค่าเริ่มต้น ${text} · ช่วง 1 ถึง 1000000 · จำนวนเต็ม`;
    };
    maxDefault();
    provider.onchange = () => {
      fillModels();
      maxDefault();
    };
    model.onchange = maxDefault;
    const reasoning = el('select');
    for (const [value, text] of REASONING_CHOICES) {
      const option = el('option', '', text);
      option.value = value;
      reasoning.append(option);
    }
    reasoning.value = (source && source.reasoning) || '';
    const top = el('div', 'mk-grid2');
    top.append(Kit.field('ผู้ให้บริการ', provider), Kit.field('โมเดล', model));
    const body = [
      Kit.field('ชื่อ preset (ตัวพิมพ์เล็ก a-z 0-9 - _)', name, preset ? 'เปลี่ยนชื่อไม่ได้ — ใช้ "ทำสำเนา" แล้วลบอันเดิมแทน' : 'ชื่อนี้คือสิ่งที่เลือกในช่อง "โมเดล" ของ agent / skill'),
      top,
    ];
    if (providerIds.length === 0) body.push(el('p', 'hint badtxt', 'ยังไม่มีผู้ให้บริการที่เชื่อมต่อ — ไปที่ ตั้งค่า → ผู้ให้บริการ ก่อน'));
    const resetAll = button('btn ghost sm', '↺ ค่าเริ่มต้นทั้งหมด', () => {
      for (const knob of Object.values(knobs)) knob.reset();
      reasoning.value = '';
      popup.dirty = true;
    }, 'ล้างทุกช่องกลับไปใช้ค่าเริ่มต้นของผู้ให้บริการ');
    body.push(Kit.section('ค่าการสุ่ม', 'ช่องว่าง = ใช้ค่าเริ่มต้นที่เขียนไว้ใต้ช่อง · กด ↺ เพื่อกลับไปค่าเริ่มต้น', [resetAll]), knobBox);
    body.push(Kit.field('effort (คิดก่อนตอบมากแค่ไหน)', reasoning, 'ค่าเริ่มต้น: ตามผู้ให้บริการ · สูง = ฉลาดขึ้นแต่ช้าและเปลือง token · โมเดลที่ไม่มีโหมดคิดจะไม่สนค่านี้'));
    const popup = Kit.modal({ title: preset ? `แก้ไข preset: ${preset.name}` : copyOf ? `ทำสำเนา ${copyOf.name}` : 'เพิ่ม preset', size: 'wide', body });
    const save = () => {
      let values;
      try {
        values = Object.fromEntries(Object.entries(knobs).map(([key, knob]) => [key, knob.read()]));
      } catch (error) {
        return toast('ค่าไม่ถูกต้อง', error.message, true);
      }
      if (!name.value.trim()) return toast('ยังไม่ได้ตั้งชื่อ', 'ใส่ชื่อ preset ก่อน', true);
      if (!model.value) return toast('ยังไม่ได้เลือกโมเดล', null, true);
      const saving = name.value.trim().toLowerCase();
      if (!preset && view.presets.some((entry) => entry.name === saving)) return toast('ชื่อซ้ำ', `มี preset "${saving}" อยู่แล้ว`, true);
      hubPending = { kind: 'preset', name: saving, model: model.value, popup, done: `บันทึก preset ${saving} แล้ว ✓` };
      send({ type: 'preset-save', preset: { name: name.value.trim(), model: model.value, ...values, reasoning: reasoning.value || undefined } });
    };
    popup.setFoot(
      [button('btn ghost', 'ยกเลิก', () => popup.close()), button('btn pri', 'บันทึก', save)],
      preset ? [button('btn danger', 'ลบ', () => deletePreset(preset, popup)), button('btn ghost', 'ทำสำเนา', () => presetEditor(null, preset))] : [],
    );
  }

  async function deletePreset(preset, popup) {
    const users = [
      ...state.agents.filter((agent) => Object.values(agent.models || {}).includes(preset.name)).map((agent) => `agent ${nameOf(agent.name)}`),
      ...state.skills.filter((skill) => skill.model === preset.name).map((skill) => `skill ${skill.name}`),
    ];
    if (users.length > 0) {
      return window.MimiKit.ask({ title: `ลบ "${preset.name}" ไม่ได้`, body: [`ยังมีที่ใช้ preset นี้อยู่: ${users.join(', ')}`, 'เปลี่ยนโมเดลของที่ใช้อยู่ก่อน แล้วค่อยลบ'], ok: 'เข้าใจแล้ว' });
    }
    if (!(await window.MimiKit.confirmDelete(`preset "${preset.name}"`, `${preset.model}`))) return;
    send({ type: 'preset-delete', name: preset.name });
    popup?.done();
  }

  function hubModels() {
    const Kit = window.MimiKit;
    const view = state.settings || { presets: [], models: [], providers: [] };
    const wrap = el('div');
    const exportPresets = () => Kit.downloadJson(`mimi-model-presets-${Kit.stamp()}.json`, { kind: 'mimi-model-presets', version: 1, items: view.presets });
    const importPresets = async (files) => {
      const items = (await Kit.readJsonItems(files)).filter((item) => item && typeof item.name === 'string' && typeof item.model === 'string');
      if (items.length === 0) throw new Error('ไม่พบ preset ในไฟล์ (ต้องมี name และ model)');
      const existing = items.filter((item) => view.presets.some((entry) => entry.name === item.name.toLowerCase()));
      if (existing.length > 0 && !(await Kit.ask({ title: 'มี preset ชื่อซ้ำ', body: `จะเขียนทับ: ${existing.map((item) => item.name).join(', ')}`, ok: 'เขียนทับ', danger: true }))) return;
      for (const item of items) send({ type: 'preset-save', preset: item });
      toast(`นำเข้า ${items.length} preset`, 'preset ที่ใช้โมเดลซึ่งยังไม่ได้เชื่อมต่อจะไม่ถูกบันทึก (ดูข้อความแจ้งเตือน)');
    };
    wrap.append(Kit.section(`Preset (${view.presets.length})`, 'คลิกแถวเพื่อแก้ไข · ช่องที่ขึ้นว่า "ค่าเริ่มต้น" = ใช้ค่าของผู้ให้บริการ', [
      button('btn pri', '+ เพิ่ม preset', () => presetEditor(null)),
      ...Kit.ioButtons({ onImport: importPresets, onExport: view.presets.length ? exportPresets : null }),
    ]));
    const table = el('div', 'mtable');
    const head = el('div', 'hd');
    for (const label of ['ชื่อ', 'ผู้ให้บริการ', 'โมเดล', 'temp', 'top_p', 'top_k', 'max', 'effort', '']) head.append(el('span', label === 'ชื่อ' || label === 'ผู้ให้บริการ' || label === 'โมเดล' || !label ? '' : 'num', label));
    table.append(head);
    for (const entry of view.presets) {
      const row = el('div', 'row');
      row.onclick = (event) => {
        if (!event.target.closest('button')) presetEditor(entry);
      };
      const nameCell = el('span', 'nm', entry.name);
      const extras = ['minTokens', 'presencePenalty', 'frequencyPenalty', 'repetitionPenalty'].filter((key) => entry[key] !== undefined);
      if (extras.length > 0) nameCell.title = extras.map((key) => `${key}: ${entry[key]}`).join('\n');
      row.append(nameCell, el('span', 'prov', providerName(providerOf(entry.model))));
      const modelCell = el('span', 'mono', entry.model.slice(entry.model.indexOf('/') + 1));
      modelCell.title = entry.model;
      row.append(modelCell);
      for (const key of ['temperature', 'topP', 'topK', 'maxOutputTokens', 'reasoning']) {
        const value = entry[key];
        row.append(el('span', `num${value === undefined ? ' def' : ''}`, value === undefined ? 'ค่าเริ่มต้น' : String(value)));
      }
      const acts = el('span', 'acts');
      acts.append(button('btn ghost sm', 'แก้ไข', () => presetEditor(entry)), button('btn danger sm', 'ลบ', () => deletePreset(entry)));
      row.append(acts);
      table.append(row);
    }
    const panel = el('div', 'panel');
    panel.append(table);
    if (view.presets.length === 0) panel.append(el('div', 'empty mk-empty', 'ยังไม่มี preset — กด "+ เพิ่ม preset" เพื่อสร้างชุดแรก (เช่น "creative" = โมเดลเดิมแต่ temperature สูง)'));
    wrap.append(panel);
    if (view.models.length === 0) wrap.append(el('p', 'hint', 'ยังไม่มีโมเดลให้เลือก: เชื่อมต่อผู้ให้บริการที่หน้า "ตั้งค่า" ก่อน'));
    return wrap;
  }

  // ----- Skill -----
  let skillQuery = '';
  let skillFilter = 'all';
  /** A skill as a SKILL.md file: YAML frontmatter, then the instructions. */
  function skillMarkdown(skill) {
    const yaml = [`name: ${skill.name}`, `description: ${JSON.stringify(skill.description || '')}`];
    if (skill.model) yaml.push(`model: ${skill.model}`);
    if ((skill.tools || []).length > 0) yaml.push('tools:', ...skill.tools.map((tool) => `  - ${tool}`));
    return `---\n${yaml.join('\n')}\n---\n${(skill.body || '').trim()}\n`;
  }
  /** Reads a SKILL.md (Mimi's or Claude's format: `allowed-tools` is taken as tools). */
  function parseSkillMarkdown(text, fileName) {
    const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    const meta = {};
    let body = text;
    if (match) {
      body = match[2];
      let listKey = null;
      for (const raw of match[1].split(/\r?\n/)) {
        const item = /^\s+-\s+(.*)$/.exec(raw);
        if (item && listKey) {
          meta[listKey].push(unquote(item[1]));
          continue;
        }
        const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(raw);
        if (!pair) continue;
        const key = pair[1].toLowerCase();
        const value = pair[2].trim();
        if (value === '') {
          meta[key] = [];
          listKey = key;
        } else {
          listKey = null;
          meta[key] = value.startsWith('[') ? value.slice(1, -1).split(',').map((part) => unquote(part.trim())).filter(Boolean) : unquote(value);
        }
      }
    }
    const fromFile = String(fileName || '').replace(/\.(md|markdown)$/i, '').replace(/^SKILL$/i, '');
    const name = String(meta.name || fromFile || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    const toolsRaw = meta.tools || meta['allowed-tools'] || [];
    const tools = (Array.isArray(toolsRaw) ? toolsRaw : String(toolsRaw).split(/[,\s]+/)).map(String).filter(Boolean);
    const firstLine = body.trim().split('\n').find((line) => line.trim() && !line.startsWith('#')) || '';
    return { name, description: String(meta.description || firstLine).slice(0, 300), model: typeof meta.model === 'string' ? meta.model : '', tools, body: body.trim() };
  }
  function unquote(value) {
    const text = String(value).trim();
    if (/^".*"$/.test(text)) {
      try {
        return JSON.parse(text);
      } catch {
        return text.slice(1, -1);
      }
    }
    return /^'.*'$/.test(text) ? text.slice(1, -1).replace(/''/g, "'") : text;
  }
  const skillUsers = (name) => state.agents.filter((agent) => (agent.skills || []).includes(name)).map((agent) => nameOf(agent.name));

  function skillEditor(skill, draft) {
    const Kit = window.MimiKit;
    const source = skill || draft || null;
    const name = textInput(source ? source.name : '', 'เช่น song-writer (a-z 0-9 -)');
    const description = textInput(source ? source.description : '', 'ใช้เมื่อไร: agent อ่านบรรทัดนี้เพื่อตัดสินใจว่าจะเรียก skill');
    const model = modelSelect(source ? source.model : '', 'ไม่แยกโมเดล: agent อ่านคำสั่งแล้วทำเอง', 'model');
    const body = el('textarea', 'tall');
    body.value = source ? source.body : '';
    body.placeholder = 'คำสั่งของ skill: ขั้นตอน กฎ รูปแบบผลลัพธ์';
    const allTools = toolItems();
    const known = new Set(allTools.map((tool) => tool.name));
    const unknownTools = (source ? source.tools || [] : []).filter((tool) => !known.has(tool));
    const tools = Kit.pickerField({
      items: allTools.map((tool) => ({ value: tool.name, label: tool.name, desc: describeTool(tool), group: tool.preset ? 'preset' : tool.mcp ? 'MCP' : tool.builtin === false ? 'custom' : tool.risk || 'อื่น ๆ' })),
      chosen: (source ? source.tools || [] : []).filter((tool) => known.has(tool)),
      addLabel: '+ เพิ่มเครื่องมือ',
      empty: 'ยังไม่ได้เลือกเครื่องมือ — skill ที่รันแยกโมเดลจะไม่มีเครื่องมือใช้',
      title: 'เลือกเครื่องมือให้ skill',
      groups: [...new Set(allTools.map((tool) => (tool.preset ? 'preset' : tool.mcp ? 'MCP' : tool.builtin === false ? 'custom' : tool.risk || 'อื่น ๆ')))],
    });
    const top = el('div', 'mk-grid2');
    top.append(Kit.field('ชื่อ', name), Kit.field('โมเดลของ skill นี้', model));
    const toolsBox = el('div');
    const paintTools = () => {
      toolsBox.hidden = !model.value;
    };
    model.addEventListener('change', paintTools);
    toolsBox.append(Kit.section('เครื่องมือที่ skill ใช้ได้', 'ใช้เฉพาะเมื่อ skill รันแยกด้วยโมเดลของตัวเอง', []), tools.node);
    if (unknownTools.length > 0) toolsBox.append(el('p', 'hint badtxt', `เครื่องมือที่ไม่มีในเครื่องนี้ถูกตัดออก: ${unknownTools.join(', ')}`));
    paintTools();
    const popup = Kit.modal({
      title: skill ? `แก้ไข skill: ${skill.name}` : draft ? `นำเข้า skill: ${draft.name || '(ไม่มีชื่อ)'}` : 'สร้าง skill',
      sub: skill && skill.builtin ? 'skill ติดตัวแอป — บันทึกแล้วจะเป็นสำเนาของคุณ (ลบสำเนาเพื่อกลับไปใช้ของเดิม)' : undefined,
      size: 'wide',
      body: [
        top,
        Kit.field('คำอธิบาย (ใช้เมื่อไร)', description),
        el('p', 'hint', 'เลือกโมเดล (เช่น preset "pro") = skill รันแยกเป็นงานย่อยด้วยโมเดลนั้นแล้วส่งผลกลับให้ agent · ไม่เลือก = agent อ่านคำสั่งแล้วทำเอง'),
        Kit.field('คำสั่ง', body),
        toolsBox,
      ],
    });
    if (draft) popup.dirty = true;
    const save = async () => {
      if (!name.value.trim() || !body.value.trim()) return toast('กรอกไม่ครบ', 'ต้องมีชื่อและคำสั่ง', true);
      const saving = name.value.trim();
      if (!skill && state.skills.some((entry) => entry.name === saving) && !(await window.MimiKit.ask({ title: `มี skill "${saving}" อยู่แล้ว`, body: 'บันทึกแล้วจะเขียนทับของเดิม', ok: 'เขียนทับ', danger: true }))) return;
      hubPending = { kind: 'skill', name: saving, popup, done: `บันทึก skill ${saving} แล้ว ✓` };
      send({
        type: 'skill-save',
        renameFrom: skill && !skill.builtin ? skill.name : undefined,
        skill: { name: saving, description: description.value.trim(), model: model.value, tools: model.value ? tools.read() : [], body: body.value },
      });
    };
    const left = [];
    if (skill && !skill.builtin) left.push(button('btn danger', 'ลบ', () => deleteSkillAsk(skill, popup)));
    if (skill) left.push(button('btn ghost', 'ส่งออก .md', () => Kit.download(`${skill.name}.md`, skillMarkdown(skill), 'text/markdown')));
    popup.setFoot([button('btn ghost', 'ยกเลิก', () => popup.close()), button('btn pri', 'บันทึก', save)], left);
  }

  async function deleteSkillAsk(skill, popup) {
    const users = skillUsers(skill.name);
    if (!(await window.MimiKit.confirmDelete(`skill "${skill.name}"`, users.length ? `จะถูกเอาออกจาก agent ที่ใช้อยู่: ${users.join(', ')}` : 'ยังไม่มี agent ใช้ skill นี้'))) return;
    send({ type: 'skill-delete', name: skill.name });
    popup?.done();
    toast(`ลบ skill ${skill.name} แล้ว`);
  }

  function hubSkills() {
    const Kit = window.MimiKit;
    const wrap = el('div');
    const importSkills = async (files) => {
      const drafts = [];
      for (const file of files) {
        if (/\.json$/i.test(file.name)) {
          for (const item of await Kit.readJsonItems([file])) if (item && item.name && item.body) drafts.push(item);
        } else {
          drafts.push(parseSkillMarkdown(await file.text(), file.name));
        }
      }
      if (drafts.length === 0) throw new Error('ไม่พบ skill ในไฟล์');
      // One file: check it in the editor first. Several: save them all, keeping only known tools.
      if (drafts.length === 1) return skillEditor(null, drafts[0]);
      const known = new Set(toolItems().map((tool) => tool.name));
      const bad = drafts.filter((draft) => !draft.name || !draft.body);
      const good = drafts.filter((draft) => draft.name && draft.body);
      const clash = good.filter((draft) => state.skills.some((entry) => entry.name === draft.name));
      if (clash.length > 0 && !(await Kit.ask({ title: 'มี skill ชื่อซ้ำ', body: `จะเขียนทับ: ${clash.map((draft) => draft.name).join(', ')}`, ok: 'เขียนทับ', danger: true }))) return;
      for (const draft of good) send({ type: 'skill-save', skill: { ...draft, tools: draft.model ? (draft.tools || []).filter((tool) => known.has(tool)) : [] } });
      toast(`นำเข้า ${good.length} skill`, bad.length ? `ข้าม ${bad.length} ไฟล์ที่ไม่มีชื่อหรือคำสั่ง` : null, bad.length > 0);
    };
    const exportAll = () => Kit.downloadJson(`mimi-skills-${Kit.stamp()}.json`, { kind: 'mimi-skills', version: 1, items: state.skills.filter((skill) => !skill.builtin) });
    wrap.append(Kit.section(`Skill (${state.skills.length})`, 'คลิกการ์ดเพื่อแก้ไข · นำเข้าได้ทั้ง SKILL.md (หลายไฟล์พร้อมกันได้) และไฟล์ .json ที่ส่งออกจากที่นี่', [
      button('btn pri', '+ สร้าง skill', () => skillEditor(null)),
      ...Kit.ioButtons({ accept: '.md,.markdown,.json,text/markdown,application/json', onImport: importSkills, onExport: state.skills.some((skill) => !skill.builtin) ? exportAll : null, exportTitle: 'ส่งออก skill ของคุณทั้งหมดเป็น .json' }),
    ]));
    const filters = [
      { key: 'all', label: 'ทั้งหมด', test: () => true },
      { key: 'mine', label: 'ของฉัน', test: (skill) => !skill.builtin },
      { key: 'builtin', label: 'ติดตัวแอป', test: (skill) => skill.builtin },
      { key: 'model', label: 'รันแยกโมเดล', test: (skill) => Boolean(skill.model) },
      { key: 'unused', label: 'ยังไม่มีใครใช้', test: (skill) => skillUsers(skill.name).length === 0 },
    ];
    const listBox = el('div');
    const draw = () => {
      const needle = skillQuery.trim().toLowerCase();
      const test = filters.find((entry) => entry.key === skillFilter).test;
      const visible = state.skills.filter((skill) => test(skill) && (!needle || `${skill.name} ${skill.description} ${skill.body}`.toLowerCase().includes(needle)));
      listBox.replaceChildren(Kit.grid(visible.map((skill) => {
        const users = skillUsers(skill.name);
        return Kit.card({
          title: skill.name,
          mono: true,
          sub: skill.model ? `โมเดล: ${skill.model}` : 'agent ทำเอง (ไม่แยกโมเดล)',
          desc: skill.description || '(ไม่มีคำอธิบาย)',
          badges: [
            skill.builtin ? ['ติดตัวแอป', 'info'] : null,
            skill.model ? [`เครื่องมือ ${(skill.tools || []).length}`, ''] : null,
            users.length ? [`ใช้โดย ${users.join(', ')}`, 'ok'] : ['ยังไม่มีใครใช้', 'warn'],
          ],
          onOpen: () => skillEditor(skill),
          actions: [
            { label: 'แก้ไข', onClick: () => skillEditor(skill) },
            { label: 'ส่งออก', onClick: () => Kit.download(`${skill.name}.md`, skillMarkdown(skill), 'text/markdown'), title: 'ดาวน์โหลดเป็น SKILL .md' },
            skill.builtin
              ? { label: 'ลบ', disabled: true, onClick: () => {}, title: 'skill ติดตัวแอปลบไม่ได้ — เอาออกจาก agent ได้ที่หน้า Agent' }
              : { label: 'ลบ', danger: true, onClick: () => deleteSkillAsk(skill) },
          ],
        });
      }), state.skills.length === 0 ? 'ยังไม่มี skill — กด "+ สร้าง skill" หรือนำเข้าไฟล์ .md' : 'ไม่พบ skill ที่ตรงกับตัวกรอง'));
    };
    const bar = Kit.filterBar({
      query: skillQuery,
      placeholder: 'ค้นหาชื่อ คำอธิบาย หรือคำสั่ง…',
      chips: filters.map((entry) => ({ key: entry.key, label: entry.label, count: state.skills.filter(entry.test).length })),
      active: skillFilter,
      onQuery: (value) => {
        skillQuery = value;
        draw();
      },
      onChip: (key) => {
        skillFilter = key;
        renderHub();
      },
    });
    wrap.append(bar.node, listBox);
    draw();
    return wrap;
  }

  // ---------- settings page ----------
  /** Two-step sign-in of a gateway account: on with the password plus a first code, off with both. */
  function recoveryCodesBox(codes) {
    const box = el('div', 'panel');
    box.append(
      el('p', 'hint badtxt', 'เก็บรหัสสำรองเหล่านี้ไว้ในที่ปลอดภัย — แสดงครั้งนี้ครั้งเดียว และแต่ละรหัสใช้ได้ครั้งเดียวเมื่อไม่มีมือถือ'),
      el('pre', 'wjson', codes.join('\n')),
    );
    return box;
  }

  function twoFactorPanel() {
    const panel = el('div', 'panel form');
    panel.append(el('h3', '', 'ยืนยันตัวตนสองขั้น (2FA)'));
    const body = el('div', 'stackv');
    panel.append(body);
    const paint = (state, pending, codes) => {
      body.replaceChildren();
      if (state === undefined) {
        body.append(el('p', 'hint', 'กำลังตรวจสถานะ…'));
        return;
      }
      if (state.twoFactor) {
        body.append(
          el('p', 'pill ok', 'เปิดอยู่: เข้าสู่ระบบต้องใช้รหัสจากแอปยืนยันตัวตนทุกครั้ง'),
          el('p', 'hint', `รหัสสำรองที่ยังใช้ได้: ${state.recoveryCodes ?? 0} รหัส`),
        );
        if (codes && codes.length > 0) body.append(recoveryCodesBox(codes));
        const recoveryPassword = textInput('', 'รหัสผ่าน', 'password');
        body.append(
          labelled('สร้างรหัสสำรองชุดใหม่ (รหัสเก่าที่เหลือจะใช้ไม่ได้)', recoveryPassword),
          button('btn', 'สร้าง recovery codes ใหม่', async () => {
            const answer = await api('/auth/2fa/recovery', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: recoveryPassword.value }) });
            if (!answer.ok) return toast('สร้างไม่ได้', answer.status === 429 ? 'ลองผิดหลายครั้งเกินไป รอสักครู่' : 'รหัสผ่านไม่ถูกต้อง', true);
            const result = await answer.json();
            toast('สร้าง recovery codes ใหม่แล้ว', 'เก็บรหัสใหม่ไว้ให้ดี รหัสเก่าใช้ไม่ได้แล้ว');
            paint({ twoFactor: true, recoveryCodes: result.recoveryCodes?.length ?? 0 }, null, result.recoveryCodes);
          }),
        );
        const password = textInput('', 'รหัสผ่าน', 'password');
        const code = textInput('', 'รหัส 6 หลักตอนนี้');
        body.append(
          labelled('รหัสผ่าน', password),
          labelled('รหัสจากแอป', code),
          button('btn danger', 'ปิด 2FA', async () => {
            const answer = await api('/auth/2fa/disable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: password.value, code: code.value }) });
            if (!answer.ok) return toast('ปิด 2FA ไม่ได้', answer.status === 429 ? 'ลองผิดหลายครั้งเกินไป รอสักครู่' : 'รหัสผ่านหรือรหัสจากแอปไม่ถูกต้อง', true);
            toast('ปิด 2FA แล้ว');
            paint({ twoFactor: false }, null);
          }),
        );
        return;
      }
      if (pending) {
        body.append(
          el('p', 'hint', 'เพิ่มบัญชีในแอปยืนยันตัวตน (Google Authenticator, 1Password, Authy …) ด้วยคีย์นี้ แล้วใส่รหัส 6 หลักที่แอปแสดงเพื่อยืนยัน · คีย์นี้แสดงครั้งเดียว อย่าส่งให้ใคร'),
          labelled('คีย์ (ใส่ในแอปแบบ "ใส่คีย์เอง")', el('code', 'mono', pending.secret.replace(/(.{4})/g, '$1 ').trim())),
        );
        const link = el('a', 'btn ghost', 'เปิดในแอปยืนยันตัวตน (บนมือถือ)');
        link.href = pending.uri;
        const code = textInput('', 'รหัส 6 หลัก');
        body.append(
          link,
          labelled('รหัสจากแอป', code),
          el('p', 'hint', 'หลังยืนยันจะแสดงรหัสสำรอง 10 รหัส เก็บไว้ให้ดี'),
          button('btn pri', 'ยืนยันและเปิด 2FA', async () => {
            const answer = await api('/auth/2fa/enable', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.value }) });
            if (!answer.ok) return toast('รหัสไม่ถูกต้อง', 'ดูว่าเวลาในมือถือตรง แล้วใส่รหัสล่าสุดอีกครั้ง', true);
            const result = await answer.json();
            toast('เปิด 2FA แล้ว', 'เก็บรหัสสำรองไว้ให้ดี ครั้งหน้าที่เข้าสู่ระบบจะถามรหัสจากแอป');
            paint({ twoFactor: true, recoveryCodes: result.recoveryCodes?.length ?? 0 }, null, result.recoveryCodes);
          }),
        );
        return;
      }
      body.append(el('p', 'hint', 'ปิดอยู่ · เปิดแล้วการเข้าสู่ระบบบนเครื่องใหม่ต้องใช้รหัสจากแอปยืนยันตัวตนบนมือถือด้วย · ถ้ามือถือหาย ให้ใช้รหัสสำรองหรือให้ผู้ดูแลรัน "accounts 2fa-reset <ชื่อผู้ใช้>"'));
      const password = textInput('', 'รหัสผ่าน', 'password');
      body.append(
        labelled('รหัสผ่าน (เพื่อยืนยันว่าเป็นคุณ)', password),
        button('btn', 'เริ่มตั้งค่า 2FA', async () => {
          const answer = await api('/auth/2fa/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: password.value }) });
          if (!answer.ok) return toast('เริ่มไม่ได้', answer.status === 429 ? 'ลองผิดหลายครั้งเกินไป รอสักครู่' : 'รหัสผ่านไม่ถูกต้อง', true);
          paint({ twoFactor: false }, await answer.json());
        }),
      );
    };
    paint(undefined, null);
    api('/auth/session')
      .then((answer) => (answer.ok ? answer.json() : null))
      .then((session) => paint({ twoFactor: Boolean(session && session.twoFactor), recoveryCodes: Number(session?.recoveryCodes ?? 0) }, null))
      .catch(() => body.replaceChildren(el('p', 'hint', 'ตรวจสถานะไม่ได้ ลองใหม่ภายหลัง')));
    return panel;
  }

  function passwordPanel() {
    const panel = el('div', 'panel form');
    panel.append(el('h3', '', 'เปลี่ยนรหัสผ่าน'), el('p', 'hint', 'เปลี่ยนรหัสผ่านของบัญชีนี้ · อุปกรณ์อื่นจะถูกออกจากระบบ แต่เครื่องนี้ยังอยู่'));
    const current = textInput('', 'รหัสผ่านปัจจุบัน', 'password');
    const next = textInput('', 'รหัสผ่านใหม่ (อย่างน้อย 10 ตัวอักษร)', 'password');
    const again = textInput('', 'รหัสผ่านใหม่อีกครั้ง', 'password');
    panel.append(
      labelled('รหัสผ่านปัจจุบัน', current),
      labelled('รหัสผ่านใหม่', next),
      labelled('ยืนยันรหัสผ่านใหม่', again),
      button('btn pri', 'เปลี่ยนรหัสผ่าน', async () => {
        if (next.value !== again.value) return toast('รหัสใหม่ไม่ตรงกัน', 'พิมพ์รหัสผ่านใหม่ให้ตรงกันทั้งสองช่อง', true);
        const answer = await api('/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: current.value, next: next.value }) });
        if (!answer.ok) {
          const problem = await answer.json().catch(() => ({}));
          return toast('เปลี่ยนรหัสผ่านไม่ได้', problem.error || (answer.status === 429 ? 'ลองผิดหลายครั้งเกินไป รอสักครู่' : 'รหัสผ่านปัจจุบันไม่ถูกต้อง'), true);
        }
        current.value = '';
        next.value = '';
        again.value = '';
        toast('เปลี่ยนรหัสผ่านแล้ว', 'อุปกรณ์อื่นถูกออกจากระบบแล้ว');
      }),
    );
    return panel;
  }

  /** Cloudflare quick tunnel: a public https address for webhooks and calendar push on a computer. */
  function tunnelPanel() {
    const view = (state.settings && state.settings.tunnel) || { state: 'off' };
    const panel = el('div', 'panel form');
    const named = view.mode === 'named';
    panel.append(
      el('h3', '', 'เข้าจากอินเทอร์เน็ต (Cloudflare Tunnel)'),
      el(
        'p',
        'hint',
        named
          ? 'เปิดที่อยู่ https คงที่ผ่าน Cloudflare named tunnel ให้ webhook และ Google/Outlook Calendar ส่งเข้ามาที่ Mimi บนเครื่องนี้ได้ โดยไม่ต้องเปิดพอร์ตบนเราเตอร์ · URL ไม่เปลี่ยนเมื่อรีสตาร์ท · ใครรู้ที่อยู่จะเห็นหน้าเข้าสู่ระบบ (ยังต้องใช้รหัสผ่าน) · ระหว่างเปิด เชื่อม ChatGPT plan ไม่ได้'
          : 'เปิดที่อยู่ https ชั่วคราวผ่าน Cloudflare ให้ webhook และ Google/Outlook Calendar ส่งเข้ามาที่ Mimi บนเครื่องนี้ได้ โดยไม่ต้องเปิดพอร์ตบนเราเตอร์ · ที่อยู่เปลี่ยนทุกครั้งที่เปิดใหม่ · ใครรู้ที่อยู่จะเห็นหน้าเข้าสู่ระบบ (ยังต้องใช้รหัสผ่าน) · ระหว่างเปิด เชื่อม ChatGPT plan ไม่ได้',
      ),
    );
    if (named) panel.append(el('p', 'hint', `Named tunnel: ${view.name || '(ยังไม่ตั้งชื่อ)'} · ตั้งค่าที่ MIMI_CLOUDFLARED_TUNNEL / MIMI_CLOUDFLARED_URL หรือ config ของ cloudflared`));
    if (view.unavailable) {
      panel.append(el('p', 'hint', view.unavailable));
      return panel;
    }
    const pill = { off: ['todo', 'ปิดอยู่'], starting: ['todo', 'กำลังเปิด…'], on: ['ok', 'เปิดอยู่'], error: ['bad', 'เปิดไม่สำเร็จ'], missing: ['todo', 'ยังไม่ได้ติดตั้ง cloudflared'] }[view.state] || ['todo', view.state];
    panel.append(el('p', `pill ${pill[0]}`, pill[1]));
    if (view.state === 'on' && view.url) {
      const row = el('div', 'hstack');
      row.append(el('code', 'mono', view.url), button('btn ghost', 'คัดลอก', () => navigator.clipboard?.writeText(view.url).then(() => toast('คัดลอกแล้ว'))));
      panel.append(row, el('p', 'hint', 'URL ของ webhook ในหน้า Trigger/Workflow ใช้ที่อยู่นี้แล้ว · Calendar จะสมัครรับการแจ้งเตือนใหม่ให้เอง'));
    }
    if (view.state === 'error' && view.error) panel.append(el('p', 'hint badtxt', view.error));
    if (view.state === 'missing') {
      panel.append(el('p', 'hint', 'ติดตั้ง cloudflared ก่อน แล้วกดเปิดอีกครั้ง (หรือชี้ตำแหน่งด้วย MIMI_CLOUDFLARED):'), el('code', 'mono', view.hint || 'cloudflared'));
    }
    const actions = el('div', 'hstack');
    if (view.state === 'on' || view.state === 'starting') actions.append(button('btn', 'ปิด tunnel', () => send({ type: 'tunnel-stop' })));
    else actions.append(button('btn pri', 'เปิด tunnel', () => send({ type: 'tunnel-start' })));
    panel.append(actions);
    return panel;
  }

  const SETTINGS_TABS = [
    ['profile', 'โปรไฟล์ของฉัน', 'ข้อมูลของคุณ งบประมาณ การแจ้งเตือน และการสำรองข้อมูล'],
    ['appearance', 'หน้าตา', 'ธีมสว่าง/มืดของทั้งแอป'],
    ['memory', 'ความจำ', 'สิ่งที่ Mimi จำเกี่ยวกับคุณ — ใช้ร่วมกันทุก agent'],
    ['app', 'แอปและระบบ', 'ผู้ให้บริการโมเดล โมเดลเริ่มต้น พื้นที่เก็บข้อมูล session อัตโนมัติ และโฟลเดอร์'],
  ];

  function themePanel() {
    const panel = el('div', 'panel form');
    panel.append(
      el('h3', '', 'ธีมของแอป'),
      el('p', 'hint', 'สีของทั้งแอป: เมนู แชต หน้าตั้งค่า และปุ่มต่าง ๆ · แต่ละห้องแชตตั้งธีมแยกได้ที่ "ตั้งค่าแชต → หน้าตา"'),
    );
    const current = appTheme();
    const row = el('div', 'themepick');
    for (const [value, label, note] of [
      ['light', 'สว่าง', 'ชมพูอ่อน กระดาษอุ่น อ่านสบาย'],
      ['dark', 'มืด', 'พลัมเข้ม โรส ตัดกับตัวละคร'],
    ]) {
      const card = button(`themecard${current === value ? ' on' : ''}`, null, () => setAppTheme(value), note);
      card.append(el('span', `swatch ${value}`), el('b', '', label), el('small', '', note));
      row.append(card);
    }
    panel.append(row);
    panel.append(el('p', 'hint', 'ธีมนี้แชร์ให้ทุกเครื่องที่เข้าบัญชีเดียวกัน — ธีมเฉพาะห้องแชตยังอยู่ที่เครื่องนั้น'));
    return panel;
  }

  /** Disk use split the way the user pays for it: chat media (expires), the user's own media (kept) and chat text (kept). */
  function storagePanel() {
    const info = state.settings.storage || {
      media: { usedBytes: 0, quotaBytes: 0, files: 0 },
      userMedia: { usedBytes: 0, quotaBytes: 0 },
      chat: { usedBytes: 0, quotaBytes: 0, messages: 0 },
      retentionDays: 7,
    };
    const panel = el('div', 'panel form');
    panel.append(
      el('h3', '', 'พื้นที่เก็บข้อมูล'),
      el(
        'p',
        'hint',
        `มีเดียแชต (รูป เสียง วิดีโอ ไฟล์ที่ส่งในแชต) เก็บ ${info.retentionDays} วันแล้วลบอัตโนมัติ · มีเดียของฉัน (รูป agent / ฉากหลัง / ชุด / แกลเลอรี / โมเดล VRM) เก็บไว้จนกว่าจะลบเอง · แต่ละส่วนมีโควตาของตัวเอง เกินแล้วอัปโหลดเพิ่มไม่ได้ · ข้อความแชตไม่ถูกลบ ดาวน์โหลด CSV เก็บไว้ในเครื่องได้`,
      ),
    );
    const addMeter = (label, part, extra) => {
      const over = part.quotaBytes > 0 && part.usedBytes >= part.quotaBytes;
      const box = el('div', `quota${over ? ' over' : ''}`);
      const line = el('div', 'qline');
      line.append(
        el('b', '', `${label} ${fmtSize(part.usedBytes)} / ${part.quotaBytes > 0 ? fmtSize(part.quotaBytes) : 'ไม่จำกัด'}`),
        el('span', '', extra),
      );
      const bar = el('progress');
      bar.max = 100;
      bar.value = part.quotaBytes > 0 ? Math.min(100, (part.usedBytes / part.quotaBytes) * 100) : 0;
      box.append(line, bar);
      return box;
    };
    panel.append(
      addMeter('มีเดียแชต', info.media, `${info.media.files} ไฟล์ · ลบเองใน ${info.retentionDays} วัน`),
      addMeter('มีเดียของฉัน', info.userMedia, 'เก็บตลอด'),
      addMeter('แชต', info.chat, `${info.chat.messages} ข้อความ`),
    );
    if (info.chat.quotaBytes > 0 && info.chat.usedBytes >= info.chat.quotaBytes) {
      panel.append(el('p', 'warnbox', 'ข้อความแชตเกินโควตาแล้ว — ระบบจะไม่ลบให้ ดาวน์โหลด CSV ไปเก็บในเครื่องก่อน'));
    }
    const mediaMb = textInput(String(Math.round(info.media.quotaBytes / 1024 / 1024)), 'MB', 'number');
    mediaMb.min = '100';
    mediaMb.step = '100';
    const userMediaMb = textInput(String(Math.round(info.userMedia.quotaBytes / 1024 / 1024)), 'MB', 'number');
    userMediaMb.min = '100';
    userMediaMb.step = '100';
    const chatMb = textInput(String(Math.round(info.chat.quotaBytes / 1024 / 1024)), 'MB', 'number');
    chatMb.min = '100';
    chatMb.step = '100';
    const saveQuota = () => {
      flash('กำลังบันทึก…');
      send({ type: 'settings-save', storage: { mediaQuotaMb: Number(mediaMb.value) || 0, userMediaQuotaMb: Number(userMediaMb.value) || 0, chatQuotaMb: Number(chatMb.value) || 0 } });
    };
    mediaMb.onchange = saveQuota;
    userMediaMb.onchange = saveQuota;
    chatMb.onchange = saveQuota;
    const grid = el('div', 'grid2');
    grid.append(labelled('โควตามีเดียแชต (MB)', mediaMb), labelled('โควตามีเดียของฉัน (MB)', userMediaMb), labelled('โควตาข้อความแชต (MB)', chatMb));
    panel.append(grid);
    panel.append(
      button('btn', 'ดาวน์โหลดแชตทั้งหมด (CSV)', () => downloadFromApi('/api/export/chats.csv', 'mimi-chats.csv'), 'ข้อความและรายชื่อไฟล์ของทุกแชต — ไม่มีตัวไฟล์มีเดีย'),
    );
    return panel;
  }
  /** Everything that made Mimi: the models, the voices, the pictures, and the people behind them. */
  function creditsDialog() {
    const dialog = el('div', 'dialog credits');
    dialog.append(
      el('h3', '', 'Credits'),
      el('p', 'hint', 'Mimi เกิดขึ้นได้เพราะเครื่องมือและผู้คนเหล่านี้ — ขอบคุณจากใจ'),
    );
    const groups = [
      ['Coding', ['DeepSeek', 'Claude', 'MiMo']],
      ['Sound effects', ['ElevenLabs']],
      ['Image', ['Anima', 'Krea 2']],
      ['Built with', ['Node.js', 'TypeScript', 'Electron / Chromium', 'SQLite', 'Three.js + VRM', 'Vercel AI SDK', 'Zod']],
      ['Special thanks', ['ทุกคนที่ทดสอบและให้ฟีดแบ็ก', 'ชุมชนโอเพนซอร์ส']],
    ];
    for (const [title, names] of groups) {
      const group = el('div', 'credit-group');
      group.append(el('b', '', title), el('span', '', names.join(' · ')));
      dialog.append(group);
    }
    const links = el('div', 'credit-group');
    links.append(el('b', '', 'Project'), el('span', '', 'Mimi · github.com/Nbcybg/Project-Mimi'));
    dialog.append(links);
    const foot = el('div', 'credit-foot');
    foot.append(el('span', '', `© ${new Date().getFullYear()} Noobcyborg Studio`), button('btn pri', 'ปิด', () => closeOverlay()));
    dialog.append(foot);
    overlay(dialog);
  }

  /** Desktop only: start Mimi with the computer (Electron registers it with the OS). */
  function startupPanel() {
    const shell = window.MimiShell;
    if (!shell || typeof shell.openAtLogin !== 'function') return null;
    const panel = el('div', 'panel form');
    panel.hidden = true;
    panel.append(
      el('h3', '', 'เปิด Mimi ตอนเปิดเครื่อง'),
      el('p', 'hint', 'ให้ Mimi เริ่มเองเมื่อเข้าสู่ระบบ Windows/macOS · ยังอยู่ในถาดระบบเหมือนเดิม ปิดได้จากสวิตช์นี้'),
    );
    const label = el('label', 'check');
    const input = el('input');
    input.type = 'checkbox';
    input.disabled = true;
    const status = el('span', 'faint', '');
    label.append(input, el('span', '', 'เริ่ม Mimi อัตโนมัติเมื่อเปิดเครื่อง'));
    panel.append(label, status);
    const showState = (state) => {
      input.checked = Boolean(state && state.openAtLogin);
      status.textContent = input.checked ? 'เปิดอยู่' : 'ปิดอยู่';
      input.disabled = false;
    };
    shell
      .openAtLogin()
      .then((state) => {
        if (!state || state.supported === false) return;
        panel.hidden = false;
        showState(state);
      })
      .catch(() => {});
    input.onchange = async () => {
      input.disabled = true;
      status.textContent = 'กำลังบันทึก…';
      try {
        const state = await shell.setOpenAtLogin(input.checked);
        if (!state || state.supported === false) {
          panel.hidden = true;
          return;
        }
        showState(state);
        flash(input.checked ? 'จะเปิด Mimi เมื่อเปิดเครื่อง' : 'จะไม่เปิด Mimi เมื่อเปิดเครื่อง');
      } catch (error) {
        input.checked = !input.checked;
        status.textContent = 'บันทึกไม่ได้';
        toast('ตั้งค่าเปิดตอนเปิดเครื่องไม่ได้', (error && error.message) || String(error), true);
        input.disabled = false;
      }
    };
    return panel;
  }

  /** Desktop only: the browser window that comes with the app, its profile kept between launches. */
  function browserPanel() {
    const panel = el('div', 'panel form');
    panel.append(
      el('h3', '', 'เบราว์เซอร์ของ Mimi'),
      el(
        'p',
        'hint',
        'Chromium ที่มากับแอปเดสก์ท็อป มีโปรไฟล์ของตัวเองและเก็บคุกกี้ไว้หลังจากปิดแอป — เว็บที่ล็อกอินไว้จึงยังอยู่ · agent สั่งเปิดหน้า คลิก พิมพ์ เลื่อนหน้า และอ่านเนื้อหาได้ผ่านเครื่องมือ browser_* · เปิดจากไอคอน Mimi ในถาดระบบก็ได้',
      ),
    );
    const row = el('div', 'btns');
    row.append(
      button('btn', 'เปิดเบราว์เซอร์ของ Mimi', async () => {
        try {
          if (window.MimiDesktop?.openBrowser) {
            if (await window.MimiDesktop.openBrowser()) return;
          } else if (/Electron/i.test(navigator.userAgent)) {
            const response = await api('/app/browser', { method: 'POST' });
            if (response.ok) return;
          }
          throw new Error('not the desktop app');
        } catch {
          toast('เปิดเบราว์เซอร์ไม่ได้', 'ฟีเจอร์นี้มีในแอป Mimi สำหรับเดสก์ท็อป (Electron) เท่านั้น', true);
        }
      }),
    );
    panel.append(row);
    return panel;
  }

  /** Desktop only: a separate window with the browser, the project files and a terminal side by side. */
  function workspacePanel() {
    const panel = el('div', 'panel form');
    panel.append(
      el('h3', '', 'Mimi Workspace'),
      el('p', 'hint', 'หน้าต่างแยกสำหรับทำงาน: เบราว์เซอร์อยู่กลาง เปิดไฟล์จากโฟลเดอร์โปรเจกต์ได้ และมี terminal ด้านขวา · เปิดได้จากถาดระบบของ Mimi ด้วย'),
    );
    panel.append(
      button('btn', 'เปิด Workspace', async () => {
        try {
          if (window.MimiDesktop?.openWorkspace) {
            if (await window.MimiDesktop.openWorkspace()) return;
          } else if (/Electron/i.test(navigator.userAgent)) {
            const response = await api('/app/workspace', { method: 'POST' });
            if (response.ok) return;
          }
          throw new Error('not the desktop app');
        } catch {
          toast('เปิด Workspace ไม่ได้', 'ฟีเจอร์นี้มีในแอป Mimi สำหรับเดสก์ท็อป (Electron) เท่านั้น', true);
        }
      }),
    );
    return panel;
  }

  function renderSettings() {
    const page = $('view-settings');
    const view = state.settings;
    if (!view) return page.replaceChildren(pageHead('ตั้งค่า', 'กำลังโหลด…'));
    const head = pageHead('ตั้งค่า', `แบ่งเป็น ${SETTINGS_TABS.length} หน้า ตั้งค่าไว้ครั้งเดียวใช้ได้ทุกที่${state.version ? ` · Mimi v${state.version}` : ''}`);
    const creditsButton = button('btn ghost', 'Credits', creditsDialog, 'ดูเครดิตของ Mimi และทีมงาน');
    creditsButton.style.marginLeft = 'auto';
    const setupButton = button('btn ghost', 'ตัวช่วยตั้งค่า', () => window.MimiHooks?.setup?.open?.(), 'เปิดตัวช่วยตั้งค่าเริ่มต้นอีกครั้ง');
    head.firstElementChild.append(creditsButton, setupButton);
    const nodes = [head];
    if (!view.ready) {
      nodes.push(
        el(
          'p',
          'warnbox',
          !view.providers.some((provider) => provider.connected)
            ? 'ยังคุยไม่ได้: เชื่อมต่อผู้ให้บริการโมเดลก่อน (ชื่อ + URL + API key) — อยู่ที่หน้า "แอปและระบบ"'
            : view.agents === 0
              ? 'เชื่อมต่อผู้ให้บริการแล้ว ขั้นต่อไป: ไปที่แท็บ "Agent" เพื่อสร้าง agent ตัวแรก'
              : 'ยังคุยไม่ได้: โมเดลคุยของ agent เป็นของผู้ให้บริการที่ยังไม่ได้เชื่อมต่อ แก้ที่แท็บ "Agent" หรือเลือกโมเดลเริ่มต้นด้านล่าง',
        ),
      );
    }
    const tabs = el('div', 'tabs');
    for (const [key, label, hint] of SETTINGS_TABS) {
      tabs.append(
        button(ui.settingsTab === key ? 'on' : '', label, () => {
          ui.settingsTab = key;
          renderSettings();
        }, hint),
      );
    }
    nodes.push(tabs);

    const stack = el('div', 'stackv');

    if (ui.settingsTab === 'profile') {
      const account = el('div', 'panel form');
      account.append(
        el('h3', '', 'บัญชี'),
        el('p', 'hint', accountsMode
          ? 'ออกจากระบบบนเครื่องนี้: ยกเลิกเซสชันที่เซิร์ฟเวอร์ เลิกส่งแจ้งเตือนมาเครื่องนี้ และลบข้อมูลของ Mimi ในเบราว์เซอร์นี้'
          : 'ออกจากระบบบนเครื่องนี้: ต้องใส่รหัสผ่านใหม่ครั้งหน้า เลิกส่งแจ้งเตือนมาเครื่องนี้ และลบข้อมูลของ Mimi ในเบราว์เซอร์นี้'),
        button('btn', 'ออกจากระบบ', () => void signOut()),
      );
      stack.append(account);
      if (accountsMode) stack.append(twoFactorPanel(), passwordPanel());

      // This changes the app's own text, not the language the agents answer in: they read
      // the conversation and their system prompt for that.
      const language = el('div', 'panel form');
      language.append(
        el('h3', '', t('setting.language')),
        el('p', 'hint', 'ภาษาของหน้าจอและปุ่มในแอปเท่านั้น — agent ดูจากข้อความที่คุยและ system prompt เอง ไม่ได้ใช้ค่านี้เลือกภาษา'),
      );
      const languageRow = el('div', 'seg');
      for (const { code, name } of window.MimiI18n.languages()) {
        languageRow.append(button(window.MimiI18n.current() === code ? 'on' : '', name, () => window.MimiI18n.set(code)));
      }
      language.append(languageRow);
      stack.append(language);

      // The user's own profile, shared per agent (feature-profile.js).
      const profile = el('div', 'panel form');
      profile.append(el('h3', '', 'โปรไฟล์ของฉัน'));
      const profileHook = window.MimiHooks && window.MimiHooks.profile;
      if (profileHook) profileHook.render(profile);
      stack.append(profile);

      const prefs = el('div', 'panel form');
      prefs.append(el('h3', '', 'งบประมาณ & การแจ้งเตือน'));
      if (profileHook) profileHook.renderPreferences(prefs);
      stack.append(prefs);

      const backup = el('div', 'panel form');
      backup.append(el('h3', '', 'สำรอง / กู้คืนข้อมูล'));
      if (profileHook) profileHook.renderBackups(backup);
      stack.append(backup);
    } else if (ui.settingsTab === 'appearance') {
      stack.append(themePanel());
    } else if (ui.settingsTab === 'memory') {
      stack.append(memoryPanel());
    } else {
      const startup = startupPanel();
      if (startup) stack.append(startup);
      // Providers: add, edit, remove and manage the model list (feature-providers.js).
      const providers = el('div', 'panel form');
      providers.append(el('h3', '', 'ผู้ให้บริการโมเดล'));
      const providerHook = window.MimiHooks && window.MimiHooks.providers;
      if (providerHook) providerHook.render(providers);
      else providers.append(el('p', 'hint', 'โหลดหน้าจอผู้ให้บริการไม่สำเร็จ — รีเฟรชหน้าใหม่'));
      stack.append(providers);

      stack.append(storagePanel());
      stack.append(tunnelPanel());
      stack.append(browserPanel());
      stack.append(workspacePanel());

      const general = el('div', 'panel form');
      general.append(el('h3', '', 'โมเดลเริ่มต้น'), el('p', 'hint', view.models.length ? 'core เป็นตัวตอบเสมอ · รูปที่ core ดูได้จะถูกส่งให้ core ด้วย · vision / transcript ใช้แปลงไฟล์เป็นข้อความเก็บในประวัติ · แต่ละช่องแสดงเฉพาะโมเดลที่ทำได้' : 'เชื่อมต่อผู้ให้บริการก่อน แล้วรายชื่อโมเดลจะขึ้นให้เลือก'));
      const defaults = el('div', 'grid2');
      for (const [group, items] of CAPABILITY_GROUPS) {
        const heading = el('div', 'hint', group);
        heading.style.gridColumn = '1 / -1';
        defaults.append(heading);
        for (const [key, label] of items) {
          const select = modelSelect(
            view.defaults[key] || '',
            key === 'model' ? null : MEDIA_KEYS.includes(key) ? 'ไม่ใช้' : key === 'small_model' ? 'ใช้โมเดลคุย' : 'ให้ core อ่านเอง',
            key,
          );
          select.dataset.default = key;
          defaults.append(labelled(label, select));
        }
      }
      general.append(defaults);
      general.append(el('h4', '', 'Session อัตโนมัติ'), el('p', 'hint', 'ข้อความถัดไปจะเปิด session ใหม่ให้เอง (และสรุป session เดิมใส่ให้) เมื่อแชตเงียบนานเกินกำหนด หรือบทสนทนายาวเกินจำนวน token · ใส่ 0 ที่ token = ไม่จำกัด'));
      const sessionGrid = el('div', 'grid2');
      const idleField = textInput(String(view.sessionIdleMinutes), 'นาที', 'number');
      idleField.min = '1';
      idleField.step = '30';
      idleField.dataset.session = 'idleMinutes';
      const maxField = textInput(String(view.sessionMaxTokens), 'token', 'number');
      maxField.min = '0';
      maxField.step = '10000';
      maxField.dataset.session = 'maxTokens';
      sessionGrid.append(labelled('เงียบนานเกิน (นาที)', idleField), labelled('บทสนทนายาวเกิน (token)', maxField));
      general.append(sessionGrid);
      general.append(
        el('h4', '', 'เขตเวลา (Time zone)'),
        el('p', 'hint', 'เวลาที่ agent เห็นในการคุย ปลุกเตือน และตั้งเวลา ใช้เขตเวลานี้เสมอ ไม่ขึ้นกับเวลาของเครื่องที่รันเซิร์ฟเวอร์ · เว้นว่างเพื่อใช้ค่า MIMI_TIMEZONE'),
      );
      const zoneField = textInput(view.timezone, 'Asia/Bangkok');
      zoneField.dataset.timezone = '1';
      const zoneList = el('datalist');
      zoneList.id = 'mimi-timezones';
      const zoneNames = (() => {
        try {
          return Intl.supportedValuesOf('timeZone');
        } catch {
          return ['Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Jakarta', 'UTC', 'Europe/London', 'America/New_York', 'Australia/Sydney'];
        }
      })();
      for (const zone of zoneNames) {
        const option = el('option');
        option.value = zone;
        zoneList.append(option);
      }
      zoneField.setAttribute('list', zoneList.id);
      general.append(labelled('เขตเวลาที่ใช้', zoneField), zoneList);
      general.append(el('h4', '', 'โฟลเดอร์ที่อนุญาตให้อ่าน/เขียนไฟล์และรันคำสั่ง'), el('p', 'hint', 'บรรทัดละหนึ่งโฟลเดอร์ บรรทัดแรกคือโฟลเดอร์ทำงานหลัก'));
      const dirs = el('textarea');
      dirs.value = view.allowedDirs.join('\n');
      dirs.dataset.initial = dirs.value;
      general.append(dirs);
      general.append(
        el('h4', '', 'โฟลเดอร์โปรเจกต์ที่อนุญาตให้รันคำสั่ง'),
        el('p', 'hint', 'เว้นว่าง = รันคำสั่งได้ทุกโฟลเดอร์ที่อนุญาตด้านบน · แต่ละบรรทัดต้องอยู่ในโฟลเดอร์ที่อนุญาต และบนเครื่องที่ใช้ PC agent โฟลเดอร์นั้นต้องอยู่ในรายการที่อนุญาตของเครื่องด้วย'),
      );
      const projectRoots = el('textarea');
      projectRoots.value = (view.projectRoots || []).join('\n');
      projectRoots.dataset.initial = projectRoots.value;
      general.append(projectRoots);
      const grantsByAgent = view.permissionAgentGrants || ((view.permissionGrants || []).length > 0 ? { '*': view.permissionGrants } : {});
      if (Object.keys(grantsByAgent).length > 0) {
        general.append(el('h4', '', 'Always allowed tools'));
        general.append(el('p', 'hint', 'Tool families approved with the "Always" button on a permission card, per agent. Remove one to start asking again.'));
        for (const [agent, families] of Object.entries(grantsByAgent)) {
          general.append(el('p', 'hint', agent === '*' ? 'Every agent (older grants)' : `Agent: ${agent}`));
          const rows = el('div', 'btns');
          for (const tool of families) {
            // Send the agent even for "*": an old global grant is removed only from that list,
            // not from every agent that has the same tool family.
            rows.append(button('btn ghost', `${tool} ×`, () => send({ type: 'permission-revoke', tool, agent })));
          }
          general.append(rows);
        }
      }
      // Google and Microsoft sign-ins live in one place: Hub → บัญชี (several accounts, each with its own client).
      const googleKeys = [];
      const accountsRow = el('div', 'btns');
      accountsRow.style.marginTop = '8px';
      accountsRow.append(
        button('btn', 'ไปที่ Hub → บัญชี', () => {
          ui.hubTab = 'accounts';
          setView('hub');
        }),
      );
      general.append(
        el('h4', '', 'บัญชีและคีย์บริการภายนอก'),
        el('p', 'hint', `${view.google.connected ? 'Google เชื่อมต่อแล้ว ✓' : 'Google ยังไม่เชื่อมต่อ'} · ${view.microsoft.connected ? 'Microsoft เชื่อมต่อแล้ว ✓' : 'Microsoft ยังไม่เชื่อมต่อ'} · ค้นเว็บ/แผนที่ ${view.toolKeys.serper ? '✓' : '—'} · พยากรณ์อากาศ ${view.toolKeys.openweather ? '✓' : '—'} — Gmail, Outlook, ปฏิทิน, คีย์ค้นหา และคีย์พยากรณ์อากาศ ตั้งที่เดียวที่ Hub → บัญชี (ใช้ได้หลายบัญชีพร้อมกัน)`),
        accountsRow,
      );

      // Saved as soon as something changes: a choice right away, a typed field when it loses
      // focus (so the page is not rebuilt while typing). Only what changed is sent.
      const foot = el('div', 'foot');
      foot.append(el('span', 'msg', 'บันทึกอัตโนมัติเมื่อแก้ไข'));
      const autoSave = () => {
        const change = { type: 'settings-save' };
        const keys = {};
        for (const field of googleKeys) if (field.value.trim()) keys[field.dataset.key] = field.value.trim();
        if (Object.keys(keys).length) change.keys = keys;
        const chosen = {};
        for (const select of defaults.querySelectorAll('select')) if (select.value !== select.dataset.initial) chosen[select.dataset.default] = select.value;
        if (Object.keys(chosen).length) change.defaults = chosen;
        const session = {};
        if (idleField.value !== String(view.sessionIdleMinutes)) session.idleMinutes = Number(idleField.value) || 0;
        if (maxField.value !== String(view.sessionMaxTokens)) session.maxTokens = Number(maxField.value) || 0;
        if (Object.keys(session).length) change.session = session;
        if (zoneField.value.trim() !== view.timezone) change.timezone = zoneField.value.trim();
        if (dirs.value !== dirs.dataset.initial) change.allowedDirs = dirs.value.split('\n').map((line) => line.trim()).filter(Boolean);
        if (projectRoots.value !== projectRoots.dataset.initial) change.projectRoots = projectRoots.value.split('\n').map((line) => line.trim()).filter(Boolean);
        if (Object.keys(change).length === 1) return;
        flash('กำลังบันทึก…');
        send(change);
      };
      general.addEventListener('change', autoSave);
      general.append(foot);
      stack.append(general);
    }

    nodes.push(stack);
    page.replaceChildren(...nodes);
  }

  function memoryPanel() {
    const panel = el('div', 'panel form');
    panel.id = 'memory-panel';
    panel.append(el('h3', '', 'ความจำ'), el('p', 'hint', '★ = อยู่ใน prompt ตลอดเวลา (profile, preferences) · ที่เหลือ agent เปิดอ่านเมื่อจำเป็น · ความจำใช้ร่วมกันทุก agent และทุก session'));
    const entry = state.memory.find((item) => item.path === ui.memory) || null;
    const split = el('div', 'split');
    const list = el('div', 'list');
    for (const item of state.memory) {
      const row = button(`item${item.path === ui.memory ? ' on' : ''}`, null, () => {
        ui.memory = item.path;
        renderSettings();
      });
      const info = el('div', 'one');
      info.append(el('b', 'mono', `${item.layer === 1 ? '★ ' : ''}${item.path}`), el('small', '', `${item.content.length} ตัวอักษร · ${item.updatedAt.slice(0, 10)}`));
      row.append(info);
      list.append(row);
    }
    if (state.memory.length === 0) list.append(el('div', 'empty', 'ยังไม่มีความจำ'));
    const editor = el('div');
    const path = textInput(entry ? entry.path : '', 'ชื่อไฟล์ เช่น profile หรือ people/somchai');
    path.readOnly = Boolean(entry);
    const description = textInput(entry ? entry.description : '', 'คำอธิบายสั้น ๆ หนึ่งบรรทัด');
    const content = el('textarea');
    content.value = entry ? entry.content : '';
    content.placeholder = 'เนื้อหา';
    const foot = el('div', 'foot');
    foot.append(
      button('btn', '+ ใหม่', () => {
        ui.memory = null;
        renderSettings();
      }),
    );
    if (entry) {
      foot.append(
        button('btn danger', 'ลบ', () => {
          if (confirm(`ลบ "${entry.path}" ?`)) {
            send({ type: 'memory-delete', path: entry.path });
            ui.memory = null;
          }
        }),
      );
    }
    foot.append(
      button('btn pri', 'บันทึกความจำ', () => {
        if (!path.value.trim()) return path.focus();
        ui.memory = path.value.trim();
        send({ type: 'memory-save', path: ui.memory, description: description.value.trim() || undefined, content: content.value });
      }),
    );
    editor.append(labelled('ไฟล์', path), labelled('คำอธิบาย', description), labelled('เนื้อหา', content), foot);
    split.append(list, editor);
    panel.append(split);
    return panel;
  }

  // ---------- overlays ----------
  function overlay(content) {
    const scrim = el('div', 'scrim');
    scrim.append(content);
    scrim.onclick = (event) => {
      if (event.target === scrim) scrim.remove();
    };
    $('overlay').replaceChildren(scrim);
    return scrim;
  }
  const closeOverlay = () => $('overlay').replaceChildren();

  function newChatDialog(startKind) {
    if (state.agents.length === 0) {
      setView('agents');
      $('app').classList.remove('show-side');
      return toast('ยังไม่มี agent', 'สร้าง agent ตัวแรกก่อน');
    }
    const dialog = el('div', 'dialog form');
    let kind = startKind === 'group' ? 'group' : 'direct';
    const render = () => {
      const seg = el('div', 'seg');
      seg.append(
        button(kind === 'direct' ? 'on' : '', 'ตัวต่อตัว', () => {
          kind = 'direct';
          render();
        }),
        button(kind === 'group' ? 'on' : '', 'กลุ่ม', () => {
          kind = 'group';
          render();
        }),
      );
      const nodes = [el('h3', '', 'แชตใหม่'), seg];
      if (kind === 'direct') {
        const list = el('div', 'list');
        for (const agent of state.agents) {
          const row = button('item', null, () => {
            startChat({ type: 'chat-create', kind: 'direct', agents: [agent.name] });
            closeOverlay();
          });
          const info = el('div');
          info.style.minWidth = '0';
          info.append(el('b', '', nameOf(agent.name)), el('small', '', agent.description || agent.name));
          row.append(avatar(agent.name), info);
          list.append(row);
        }
        nodes.push(list);
      } else {
        const title = textInput('', 'ชื่อกลุ่ม (ไม่บังคับ)');
        const members = checkList(state.agents, [], (agent) => agent.description || nameOf(agent.name));
        const foot = el('div', 'foot');
        foot.append(
          el('span', 'msg'),
          button('btn pri', 'สร้างกลุ่ม', () => {
            const chosen = picked(members);
            if (chosen.length < 2) return toast('เลือกอย่างน้อย 2 คน');
            startChat({ type: 'chat-create', kind: 'group', agents: chosen, title: title.value.trim() });
            closeOverlay();
          }),
        );
        nodes.push(labelled('ชื่อกลุ่ม', title), el('label', '', 'สมาชิก (คนบนสุดที่ติ๊กจะเป็นคนตอบเมื่อไม่ได้เรียกใคร)'), members, foot);
        if (state.agents.length < 2) nodes.push(el('p', 'hint', 'ต้องมี agent อย่างน้อย 2 ตัวจึงจะสร้างกลุ่มได้'));
      }
      dialog.replaceChildren(...nodes);
    };
    render();
    overlay(dialog);
  }
  $('new-chat').onclick = () => newChatDialog(chatListKind);

  let searchTimer = null;
  let searchQuery = '';
  function searchDialog() {
    const palette = el('div', 'palette');
    const bar = el('div', 'pin');
    const field = el('input');
    field.placeholder = 'ค้นหาในทุกแชตและทุก session…';
    field.value = searchQuery;
    bar.append(field, el('kbd', '', 'Esc'));
    const results = el('div', 'res');
    results.id = 'search-results';
    results.append(el('div', 'empty', 'พิมพ์คำที่ต้องการหา (คำไทยไม่ต้องเว้นวรรค)'));
    palette.append(bar, results);
    overlay(palette);
    field.focus();
    field.oninput = () => {
      clearTimeout(searchTimer);
      searchQuery = field.value;
      searchTimer = setTimeout(() => field.value.trim() && send({ type: 'search', query: field.value.trim() }), 220);
    };
    if (searchQuery.trim()) send({ type: 'search', query: searchQuery.trim() });
  }
  function renderSearch(message) {
    const results = $('search-results');
    if (!results || message.query !== searchQuery.trim()) return;
    if (message.hits.length === 0) return results.replaceChildren(el('div', 'empty', `ไม่พบ "${message.query}"`));
    const terms = message.query.split(/\s+/).filter(Boolean).map((term) => term.toLowerCase());
    results.replaceChildren(
      ...message.hits.map((hit) => {
        const chat = state.chats.find((entry) => entry.id === hit.chatId);
        const row = button('ri', null, () => {
          closeOverlay();
          openChat(hit.chatId, hit.sessionId, hit.messageId);
        });
        const text = el('span', 'x');
        // Mark the matched terms without building HTML from message text.
        let rest = hit.snippet;
        while (rest) {
          const lower = rest.toLowerCase();
          let at = -1;
          let length = 0;
          for (const term of terms) {
            const found = lower.indexOf(term);
            if (found >= 0 && (at < 0 || found < at)) {
              at = found;
              length = term.length;
            }
          }
          if (at < 0) {
            text.append(rest);
            break;
          }
          text.append(rest.slice(0, at), el('mark', '', rest.slice(at, at + length)));
          rest = rest.slice(at + length);
        }
        const who = hit.role === 'user' ? t('you') : nameOf(hit.agent);
        const title = chat ? chatTitle(chat) : hit.chatTitle || t('chat.default');
        row.append(el('span', 'w', title === who ? title : `${title} · ${who}`), text, el('span', 'd', fmtDay(hit.createdAt)));
        return row;
      }),
    );
  }
  $('open-search').onclick = searchDialog;
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      searchDialog();
    } else if (event.key === 'Escape') {
      closeOverlay();
      const lightboxNode = document.querySelector('.lightbox');
      if (lightboxNode) lightboxNode.remove();
    }
  });

  // ---------- messages from the core ----------
  function setPc(online, name) {
    state.pcOnline = Boolean(online);
    $('pc-dot').classList.toggle('on', Boolean(online));
    $('pc').textContent = online ? `PC agent: ${name || 'online'}` : 'PC agent: ไม่ได้เชื่อมต่อ';
  }
  function setConn(online) {
    $('conn').className = `conn${online ? ' on' : ''}`;
    $('conn').textContent = online ? 'online' : 'offline';
  }
  /** After the first lists arrive: lead a new user through setup, else reopen the last chat. */
  // The onboarding jumps only happen once per page load; reconnecting (e.g. the phone woke up)
  // must never drag the user back out of the screen they were on.
  let onboarded = false;
  function bootstrap() {
    if (state.booted || !state.settings || !state.gotAgents || !state.gotChats || !state.gotOverseer) return;
    state.booted = true;
    const firstRun = !onboarded;
    onboarded = true;
    const normalAgents = state.agents.filter((agent) => agent.name !== 'overseer');
    // A first start that cannot chat yet gets the setup wizard on top of the screen below.
    if (firstRun) window.MimiHooks?.setup?.maybeOpen?.();
    // Fresh start with nothing to talk to: lead through the setup. With chats and agents on
    // hand, the app opens straight into the last chat instead of nagging about setup.
    if (firstRun && normalAgents.length === 0) {
      setView('overseer');
      $('app').classList.remove('show-side');
    } else if (firstRun && !state.settings.providers.some((provider) => provider.connected) && state.chats.length === 0) {
      setView('overseer');
      $('app').classList.remove('show-side');
    } else if (!state.chat) {
      const remembered = Number(localStorage.getItem(CHAT_KEY));
      // A widget row or a notification can point at a specific chat (`?chat=<id>`).
      const pointed = Number(new URLSearchParams(location.search).get('chat') || 0);
      // Mobile mode opens straight into a chat: the last one, else the main agent's. Desktop: the first in the list.
      const mobile = modeNow() === 'mobile';
      const main = state.defaultAgent || normalAgents[0].name;
      const chat =
        state.chats.find((entry) => entry.id === pointed) ||
        state.chats.find((entry) => entry.id === remembered) ||
        (mobile ? state.chats.find((entry) => entry.kind === 'direct' && entry.agents[0] === main) : state.chats[0]);
      if (chat) send({ type: 'chat-open', chatId: chat.id });
      else if (mobile) send({ type: 'chat-create', kind: 'direct', agents: [main] });
      if (chat || mobile) $('app').classList.remove('show-side');
    }
  }

  function onMessage(message) {
    switch (message.type) {
      case 'welcome':
        $('gate').style.display = 'none';
        takeUi(message.ui || {}, true);
        setPc(message.pcOnline);
        state.busyChats = new Set(message.busyChats || (message.busyChat ? [message.busyChat] : []));
        state.typingByChat.clear();
        state.handoffByChat.clear();
        state.subByChat.clear();
        state.pendingPerms = new Map(message.pendingPermissions.map((request) => [request.id, request]));
        state.booted = false;
        state.gotAgents = state.gotChats = state.gotOverseer = false;
        for (const type of ['overseer-get', 'agents-list', 'settings-get', 'chats-list', 'skills-list', 'tools-list', 'workflows-list', 'secrets-list', 'mail-watch', 'calendar-sync']) send({ type });
        reportPresence(true);
        if (state.chat) send({ type: 'chat-open', chatId: state.chat.id, sessionId: state.latest ? undefined : state.session && state.session.id });
        break;
      case 'ui':
        takeUi(message.values || {}, false);
        break;
      case 'chats':
        state.chats = message.chats;
        state.gotChats = true;
        if (state.chat) state.chat = message.chats.find((chat) => chat.id === state.chat.id) || state.chat;
        renderChatList();
        renderHeader();
        bootstrap();
        break;
      case 'chat-history': {
        if (message.beforeId !== undefined) {
          if (state.chat && state.chat.id === message.chat.id && message.messages.length > 0) prependOlder(message);
          else {
            state.loadingOlder = false;
            state.hasOlder = false;
          }
          break;
        }
        state.chat = message.chat;
        state.session = message.session;
        state.pins = message.pins || [];
        state.sessions = message.sessions;
        state.latest = !message.session || message.sessions[0].id === message.session.id;
        if (!state.chats.some((chat) => chat.id === message.chat.id)) state.chats.unshift(message.chat);
        else state.chats = state.chats.map((chat) => (chat.id === message.chat.id ? message.chat : chat));
        localStorage.setItem(CHAT_KEY, String(message.chat.id));
        renderChatList();
        renderHeader();
        renderRail();
        requestContext();
        const key = message.session ? `${message.chat.id}:${message.session.id}` : `${message.chat.id}:`;
        const ids = message.messages.map((entry) => entry.id);
        // The page holds only the newest messages, so as the chat grows its start moves on: what is
        // on screen only has to end where the page has it (the messages after that join).
        const shown = state.historyIds;
        const lastAt = shown.length > 0 ? ids.lastIndexOf(shown[shown.length - 1]) : -1;
        const overlap = Math.min(shown.length, lastAt + 1);
        const prefix =
          state.historyKey === key &&
          lastAt >= 0 &&
          shown.slice(shown.length - overlap).every((id, index) => ids[lastAt + 1 - overlap + index] === id);
        if (prefix) {
          // Same conversation as on screen: only the new messages join, so the screen does not flash.
          mergeHistory(message, key, ids, lastAt + 1);
        } else {
          renderLog(message);
          renderLiveSnapshot(message.live, message.chat.id);
          renderPendingEchoes();
        }
        if (message.live) {
          state.typingByChat.set(message.chat.id, message.live.agent);
          renderHeader();
        }
        window.MimiHooks?.chat?.renderPins?.();
        window.MimiHooks?.overseer?.onHistory?.(message.chat);
        reportPresence();
        break;
      }
      case 'message-marks': {
        if (!state.chat || state.chat.id !== message.chatId) break;
        state.pins = message.pins;
        const known = messageStore.get(message.messageId);
        if (known) {
          known.pinned = message.pinned;
          known.reactions = message.reactions;
          refreshMarks(known);
        }
        window.MimiHooks?.chat?.renderPins?.();
        break;
      }
      case 'chat-session': {
        if (!state.chat || state.chat.id !== message.chatId) break;
        const known = state.sessions.findIndex((session) => session.id === message.session.id);
        if (known >= 0) state.sessions[known] = message.session;
        else state.sessions.unshift(message.session);
        if (state.latest && (!state.session || state.session.id !== message.session.id)) {
          // The conversation moved on to a new session: the old one leaves the screen.
          const automatic = Boolean(state.session) && message.session.auto;
          state.session = message.session;
          live = null;
          liveNode = null;
          state.historyKey = null;
          state.historyIds = [];
          logInner.replaceChildren(sessionDivider(message.session, automatic));
        }
        renderRail();
        requestContext();
        break;
      }
      case 'session-context': {
        state.sessionContext = { chatId: message.chatId, sessionId: message.sessionId, context: message.context };
        renderContextMeter();
        if (!$('rail').hidden) renderRail();
        break;
      }
      case 'chat-message': {
        if (!showing(message.chatId, message.sessionId)) {
          confirmEcho(message.message, message.chatId);
          break;
        }
        // The server's echo takes the provisional bubble's place; no duplicate.
        if (confirmEcho(message.message, message.chatId)) {
          scrollDown();
          break;
        }
        if (logInner.querySelector('.welcome')) logInner.querySelector('.welcome').remove();
        ensureDay(logInner, message.message.createdAt);
        messageStore.set(message.message.id, message.message);
        add(userRow(message.message));
        scrollDown();
        if (state.historyKey === `${message.chatId}:${message.sessionId}` && !state.historyIds.includes(message.message.id)) {
          state.historyIds.push(message.message.id);
        }
        break;
      }
      case 'chat-event':
        if (showing(message.chatId, message.sessionId)) handleEvent(message.event, null, message.chatId);
        break;
      case 'chat-transcribing':
        if (message.on) state.transcribing.add(message.chatId);
        else state.transcribing.delete(message.chatId);
        for (const pending of state.pendingEchoes.filter((entry) => entry.chatId === message.chatId)) {
          if (pending.message.attachments.some((file) => file.kind === 'audio')) setPendingStatus(pending, message.on ? 'กำลังถอดเสียง…' : 'กำลังตอบ…');
        }
        renderHeader();
        renderChatList();
        break;
      case 'chat-viewing':
        if (message.on) state.viewing.add(message.chatId);
        else state.viewing.delete(message.chatId);
        for (const pending of state.pendingEchoes.filter((entry) => entry.chatId === message.chatId)) {
          if (pending.message.attachments.some((file) => file.kind === 'image')) setPendingStatus(pending, message.on ? 'AI กำลังดูรูป…' : 'กำลังตอบ…');
        }
        renderHeader();
        renderChatList();
        break;
      case 'busy': {
        if (message.chatId === null) {
          state.busyChats.clear();
        } else if (message.done) {
          state.busyChats.delete(message.chatId);
          state.transcribing.delete(message.chatId);
          state.viewing.delete(message.chatId);
          state.typingByChat.delete(message.chatId);
          state.handoffByChat.delete(message.chatId);
          state.subByChat.delete(message.chatId);
        } else {
          state.busyChats.add(message.chatId);
        }
        if (message.done || message.chatId === null) {
          // The reply that streamed in is refreshed from the log (its bubbles gain ids for pin / react / reply).
          // The merge keeps the same conversation on screen, so this does not flash.
          const endedChat = message.done ? message.chatId : refreshAfterTurn ? refreshAfterTurn.chatId : null;
          if (endedChat !== null && state.chat && state.chat.id === endedChat) {
            send({ type: 'chat-open', chatId: endedChat, sessionId: state.latest ? undefined : state.session && state.session.id });
          }
          refreshAfterTurn = null;
        } else if (state.chat && state.chat.id === message.chatId) {
          refreshAfterTurn = { chatId: message.chatId };
        }
        renderChatList();
        renderHeader();
        break;
      }
      case 'chat-changed':
        if (!showing(message.chatId, message.sessionId)) break;
        // Reloading now would wipe the reply that is still streaming in; reload when the turn ends.
        if (state.busyChats.has(message.chatId)) {
          refreshAfterTurn = { chatId: message.chatId, sessionId: message.sessionId };
          break;
        }
        send({ type: 'chat-open', chatId: message.chatId, sessionId: state.latest ? undefined : message.sessionId });
        break;
      case 'rewound':
        if (message.restored && message.restored.length) toast(`ย้อนไฟล์กลับ ${message.restored.length} ไฟล์`, message.restored.join('\n'));
        if (message.skipped && message.skipped.length) toast('บางไฟล์ย้อนไม่ได้', message.skipped.join('\n'), true);
        input.value = message.text;
        autosize();
        input.focus();
        break;
      case 'search-results':
        renderSearch(message);
        break;
      case 'permission-resolved':
        resolveCard(message.requestId, message.decision);
        break;
      case 'notification': {
        const notice = message.notification;
        if (notice.kind === 'info') {
          if (state.view === 'chat' && state.chat) add(el('div', 'note', `· ${notice.body}`));
          break;
        }
        const goTo = notice.chatId ? () => {
          setView('chat');
          openChat(notice.chatId);
          if (notice.id) send({ type: 'notifications-read', ids: [notice.id] });
        } : undefined;
        const icon = notice.kind === 'reminder' ? '⏰ ' : notice.kind === 'approval' ? '✋ ' : notice.kind === 'message' ? '💬 ' : '📋 ';
        toast(`${icon}${notice.title}`, notice.body.length > 220 ? `${notice.body.slice(0, 220)}…` : notice.body, false, goTo);
        if (window.MimiAndroid?.notify) {
          // The Android app posts native notifications itself (Web Push does not exist in a WebView).
          // Always hand it over, also while the page is on screen: the user wants the system card
          // in the app and outside it, and the same text+chat replaces itself instead of stacking.
          window.MimiAndroid.notify(`${icon}${notice.title}`, notice.body, notice.kind, notice.chatId || 0);
          window.MimiAndroid.refreshWidget?.();
        } else if (window.Notification && Notification.permission === 'granted' && (!pageVisible() || notice.kind !== 'message')) {
          const shown = new Notification(`${icon}${notice.title}`, { body: notice.body.slice(0, 300), tag: notice.id ? `mimi-${notice.id}` : undefined });
          shown.onclick = () => {
            window.focus();
            goTo?.();
            shown.close();
          };
        }
        send({ type: 'chats-list' });
        if (state.chat && notice.chatId === state.chat.id && state.latest && !state.busyChats.has(state.chat.id)) {
          send({ type: 'chat-open', chatId: state.chat.id });
        }
        break;
      }
      case 'pc-status':
        setPc(message.online, message.name);
        window.MimiHooks?.setup?.refresh?.();
        break;
      case 'agent-presets':
        window.MimiHooks?.setup?.onPresets?.(message);
        break;
      case 'packs':
        window.MimiHooks?.packs?.onPacks?.(message);
        break;
      case 'pack-report':
        window.MimiHooks?.packs?.onReport?.(message);
        break;
      case 'pack-remove-report':
        window.MimiHooks?.packs?.onRemoveReport?.(message);
        break;
      case 'status': {
        const agent = agentOf(message.agent);
        if (agent) agent.status = message.status;
        renderHeader();
        renderRail();
        break;
      }
      case 'provider-auth-url':
        window.MimiHooks?.providers?.onMessage(message);
        break;
      case 'settings':
        state.settings = message.settings;
        if (window.MimiHooks && window.MimiHooks.providers) window.MimiHooks.providers.onMessage(message);
        if (window.MimiHooks?.overseer) window.MimiHooks.overseer.onMessage?.(message);
        window.MimiHooks?.setup?.refresh?.();
        if (state.view === 'overseer' && ((!ui.providerDirty && !ui.overseerDirty) || message.saved)) {
          window.MimiHooks?.overseer?.render?.();
          if (message.saved) saved();
        }
        if (state.view === 'settings' && (!ui.providerDirty || message.saved)) {
          renderSettings();
          if (message.saved) saved();
        }
        settleHubPending('preset', (pending) => message.settings.presets.some((entry) => entry.name === pending.name && entry.model === pending.model));
        // Hub editors are popups, so the list behind them can always follow the server.
        if (state.view === 'hub' && ((!ui.toolDirty && !ui.triggerDirty && !ui.workflowDirty) || message.saved)) {
          renderHub();
          if (message.saved) saved();
        }
        if (state.view === 'agents' && !ui.agentDirty) renderAgents();
        bootstrap();
        break;
      case 'overseer':
        state.overseer = message.overseer;
        state.gotOverseer = true;
        window.MimiHooks?.overseer?.onMessage?.(message);
        if (message.saved) {
          ui.overseerDirty = false;
          if (state.view === 'overseer') saved();
        }
        if (state.view === 'overseer') window.MimiHooks?.overseer?.render?.();
        bootstrap();
        break;
      case 'agents':
        state.agents = message.agents;
        state.tools = message.tools;
        state.defaultAgent = message.defaultAgent;
        state.gotAgents = true;
        window.MimiHooks?.setup?.refresh?.();
        if (message.saved) {
          ui.agent = message.saved;
          ui.agentDirty = false;
        }
        if (ui.agent && !agentOf(ui.agent)) ui.agent = null;
        renderChatList();
        renderHeader();
        renderRail();
        if (state.view === 'agents' && (!ui.agentDirty || message.saved)) {
          renderAgents();
          if (message.saved) saved();
        }
        if (state.view === 'hub' && !ui.skillDirty && !ui.presetDirty && !ui.toolDirty && !ui.triggerDirty && !ui.workflowDirty) renderHub();
        bootstrap();
        break;
      case 'skills':
        state.skills = message.skills;
        settleHubPending('skill', (pending) => message.saved === pending.name);
        if (state.view === 'hub') renderHub();
        if (state.view === 'agents' && !ui.agentDirty) renderAgents();
        break;
      case 'tools':
        state.tools = message.tools;
        state.toolPresets = message.presets || [];
        state.toolCustom = message.custom || [];
        state.toolSecretKeys = message.secretKeys || {};
        state.toolMcp = message.mcp || [];
        if (message.connectors) state.connectors = message.connectors;
        if (message.connections) state.connections = message.connections;
        if (window.MimiHooks && window.MimiHooks.tools) window.MimiHooks.tools.onMessage(message);
        if (state.view === 'hub' && ui.hubTab === 'nodes') renderHub();
        if (state.view === 'agents' && !ui.agentDirty) renderAgents();
        break;
      case 'connector-connections':
        state.connections = message.connections || [];
        state.connectors = message.connectors || state.connectors;
        if (window.MimiHooks?.agentWorkflows?.onConnections) window.MimiHooks.agentWorkflows.onConnections(message);
        if (window.MimiHooks?.accounts?.onConnections) window.MimiHooks.accounts.onConnections(message);
        if (message.saved) saved();
        break;
      case 'secrets':
        state.secrets = message.names || [];
        if (window.MimiHooks && window.MimiHooks.secrets) window.MimiHooks.secrets.onMessage(message);
        if (state.view === 'hub' && ui.hubTab === 'secrets') renderHub();
        break;
      case 'mail-watch':
        window.MimiHooks?.mail?.onMessage(message);
        break;
      case 'calendar-sync':
        state.calendar = message.calendar;
        window.MimiHooks?.triggers?.onMessage?.(message);
        break;
      case 'calendar-calendars':
        window.MimiHooks?.triggers?.onMessage?.(message);
        break;
      case 'security-alert': {
        toast('มีการเข้าสู่ระบบใหม่', 'มีอุปกรณ์อื่นเพิ่งเข้าสู่ระบบบัญชีนี้ ถ้าไม่ใช่คุณ ให้เปลี่ยนรหัสผ่านทันที', true);
        if (window.Notification && Notification.permission === 'granted') {
          const shown = new Notification('Mimi: มีการเข้าสู่ระบบใหม่', { body: 'มีอุปกรณ์อื่นเพิ่งเข้าสู่ระบบบัญชีนี้', tag: 'mimi-security' });
          shown.onclick = () => {
            window.focus();
            shown.close();
          };
        }
        break;
      }
      case 'workflows':
        state.workflows = message.workflows || [];
        state.workflowPool = message.pool || [];
        state.nodeTypes = message.nodeTypes || [];
        state.customNodes = message.customNodes || [];
        if (window.MimiHooks && window.MimiHooks.agentWorkflows) window.MimiHooks.agentWorkflows.onMessage(message);
        if (state.view === 'agents' && !ui.agentDirty) renderAgents();
        window.MimiHooks?.triggers?.onPool?.(message);
        if (state.view === 'hub' && ui.hubTab === 'nodes') renderHub();
        break;
      case 'workflow-result': {
        const result = message.result;
        const steps = (result.steps || []).map((step) => `${step.title}: ${step.output.slice(0, 200)}`).join('\n');
        toast(result.ok ? 'Workflow เสร็จแล้ว' : 'Workflow ล้มเหลว', `${result.name}\n${result.result.slice(0, 300)}${steps ? `\n\n${steps}` : ''}`, !result.ok);
        if (window.MimiHooks && window.MimiHooks.workflows) window.MimiHooks.workflows.onResult?.(result);
        break;
      }
      case 'workflow-expr-preview':
        if (window.MimiHooks && window.MimiHooks.workflows) window.MimiHooks.workflows.onExprPreview?.(message);
        break;
      case 'workflow-node-result':
        if (window.MimiHooks && window.MimiHooks.workflows) window.MimiHooks.workflows.onNodeResult?.(message.result);
        break;
      case 'connector-import-report':
        if (window.MimiHooks && window.MimiHooks.tools) window.MimiHooks.tools.onImport?.(message);
        break;
      case 'workflow-import':
        if (window.MimiHooks && window.MimiHooks.workflows) window.MimiHooks.workflows.onImport?.(message);
        break;
      case 'workflow-runs':
        if (window.MimiHooks && window.MimiHooks.workflows) window.MimiHooks.workflows.onRuns?.(message);
        break;
      case 'workflow-run-record':
        if (window.MimiHooks && window.MimiHooks.workflows) window.MimiHooks.workflows.onRunRecord?.(message.run);
        break;
      case 'triggers':
        state.triggers = message.triggers;
        if (window.MimiHooks && window.MimiHooks.triggers) window.MimiHooks.triggers.onMessage(message);
        if (state.view === 'hub' && ui.hubTab === 'triggers') renderHub();
        break;
      case 'memory':
        state.memory = message.entries;
        if (ui.memory && !state.memory.some((entry) => entry.path === ui.memory)) ui.memory = null;
        if (state.view === 'settings') renderSettings();
        break;
      case 'google-auth-url':
      case 'microsoft-auth-url': {
        const service = message.type === 'google-auth-url' ? 'google' : 'microsoft';
        const link = el('a', '', `เปิดหน้าลงชื่อเข้าใช้ ${service === 'google' ? 'Google' : 'Microsoft'} ↗`);
        link.href = message.url;
        link.target = '_blank';
        link.rel = 'noopener';
        const slot = $(`${service}-link`);
        if (slot) slot.replaceChildren(link);
        window.open(message.url, '_blank', 'noopener');
        break;
      }
      case 'error': {
        flash('');
        const code = message.code || 'E-INTERNAL';
        toast(`ผิดพลาด [${code}]`, message.message, true);
        // Only the send that failed goes back into the composer; other chats keep their bubbles.
        const failed = message.clientId
          ? state.pendingEchoes.filter((pending) => pending.clientId === message.clientId)
          : [];
        for (const pending of failed) {
          const entries = pending.entries;
          const text = pending.text;
          releasePending(pending, false);
          if (state.view === 'chat' && state.chat && message.chatId === state.chat.id) restoreEntries(entries, text);
        }
        if (state.view === 'chat' && state.chat && (message.chatId === undefined || message.chatId === state.chat.id)) {
          add(el('div', 'note bad', `ผิดพลาด [${code}]: ${message.message}`));
        }
        break;
      }
    }
  }

  // Feature screens (tools, providers, triggers, chat extras) live in their own files so
  // this one stays readable; they reach back through this bridge.
  window.Mimi = {
    state,
    syncUi,
    /** Full URL of a core webhook path (`/api/...`); behind the accounts gateway it carries `/h/<id>`. */
    // While the quick tunnel is up, outside services must call its address, not this page's.
    webhookUrl: (path) => `${accountsMode ? location.origin + webhookBase() : state.settings?.tunnel?.url || location.origin}${path}`,
    /** True behind the accounts gateway: the person's files live on their own core, reached with the token. */
    accountsMode: () => accountsMode,
    ui,
    send,
    api,
    el,
    button,
    textInput,
    labelled,
    toast,
    saved,
    nameOf,
    toolItems,
    describeTool,
    avatar,
    blobUrl,
    renderHub,
    renderRail,
    renderAgents,
    renderSettings,
    fmtDate,
    fmtTime,
    agentOf,
    input,
    autosize,
    overlay,
    closeOverlay,
    logInner,
    scrollDown,
    chatTitle,
    messageStore,
    compose,
    modelSelect,
    speak,
    SPEAK_KEY,
    openChat,
    setView,
    characterOn,
    store,
    refreshMarks,
    stageFile,
    stageFiles,
    sendMessage,
    renderHints,
  };

  let reconnectTimer = null;
  let pingTimer = null;
  let lastTraffic = 0;
  let lastPong = 0;

  function connect() {
    if (!token()) {
      $('gate').style.display = 'flex';
      return;
    }
    // Never stack connections: one live socket, one reconnect timer.
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    lastTraffic = lastPong = Date.now();
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onopen = () => {
      retryMs = 1000;
      lastTraffic = lastPong = Date.now();
      setConn(true);
      socket.send(JSON.stringify({ type: 'hello', role: 'client', token: token(), name: 'web' }));
      window.MimiHooks?.notify?.onConnect();
    };
    socket.onmessage = (event) => {
      lastTraffic = Date.now();
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'pong') {
          lastPong = Date.now();
          return;
        }
        // Feature modules that keep their own state hear their messages first.
        if ((message.type.startsWith('knowledge') || message.type === 'error') && window.MimiHooks && window.MimiHooks.knowledge) {
          window.MimiHooks.knowledge.onMessage(message);
        }
        if ((message.type === 'oauth-accounts' || message.type === 'oauth-auth-url' || message.type === 'connector-auth-url') && window.MimiHooks && window.MimiHooks.accounts) {
          window.MimiHooks.accounts.onMessage(message);
        }
        if (message.type === 'oauth-accounts' || message.type === 'oauth-auth-url' || message.type === 'connector-auth-url') return;
        if (message.type.startsWith('knowledge')) return;
        if (message.type === 'gallery' || message.type === 'gallery-changed') {
          window.MimiHooks?.gallery?.onMessage(message);
          return;
        }
        if (message.type === 'backgrounds') {
          window.MimiHooks?.backgrounds?.onMessage(message);
          return;
        }
        if (message.type === 'wardrobe') {
          window.MimiHooks?.wardrobe?.onMessage(message);
          window.MimiHooks?.stage?.refresh();
          return;
        }
        if (['notifications', 'notification', 'push-key', 'push-devices'].includes(message.type)) {
          window.MimiHooks?.notify?.onMessage(message);
          // A live notification still gets its toast below.
          if (message.type !== 'notification') return;
        }
        if (message.type === 'backups') {
          window.MimiHooks?.profile?.onBackups(message);
          return;
        }
        if (message.type === 'error') window.MimiHooks?.profile?.onError?.();
        if (message.type === 'profile') {
          window.MimiHooks?.profile?.onMessage(message);
          return;
        }
        onMessage(message);
      } catch (error) {
        console.error(error);
      }
    };
    socket.onclose = (event) => {
      setConn(false);
      if (event.code === 4003) {
        for (const store of [localStorage, sessionStorage]) {
          store.removeItem(TOKEN_KEY);
          store.removeItem(WEBHOOK_KEY);
        }
        window.MimiDesktop?.signedOut('expired');
        window.MimiAndroid?.signedIn('');
        $('gate-error').textContent = accountsMode ? 'ออกจากระบบแล้ว หรือเซสชันหมดอายุ — เข้าสู่ระบบใหม่' : 'รหัสผ่านไม่ถูกต้อง';
        $('gate').style.display = 'flex';
        return;
      }
      reconnectTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
  }

  /**
   * After the screen was off or the app sat in the background, the socket can be dead
   * without the browser having noticed yet: ask, and reconnect right away if it does not answer.
   */
  function wake() {
    if (!token()) return;
    if (socket && socket.readyState === WebSocket.OPEN) {
      // A stale connection answers nothing: drop it so `connect` runs again immediately.
      if (Date.now() - lastTraffic > 12000) {
        try {
          socket.close();
        } catch {
          // already closing
        }
        retryMs = 1000;
        return;
      }
      reportPresence(true);
      if (Date.now() - lastTraffic > 5000 && state.chat) {
        // Catch up on what happened while the screen was off (the merge keeps it flicker-free).
        send({ type: 'chat-open', chatId: state.chat.id, sessionId: state.latest ? undefined : state.session && state.session.id });
      }
      return;
    }
    retryMs = 1000;
    connect();
  }
  // The Android app calls this when the activity comes back to the front.
  window.__mimiWake = wake;

  /**
   * The Android back button: closes the topmost thing (picture, popup, menu, side panel) or
   * goes from a screen back to the list. False when there is nothing left, so the app goes
   * to the background.
   */
  function goBack() {
    const lightboxNode = document.querySelector('.lightbox');
    if (lightboxNode) {
      lightboxNode.remove();
      return true;
    }
    if ($('overlay').firstChild) {
      // Hub popups listen for Esc themselves and ask before dropping unsaved edits.
      if ($('overlay').querySelector('.mk-scrim')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      else closeOverlay();
      return true;
    }
    const menu = document.querySelector('.ctxmenu');
    if (menu) {
      menu.remove();
      return true;
    }
    const popups = [$('attach-menu'), document.querySelector('.emoji-panel'), $('mention')].filter((node) => node && !node.hidden);
    if (popups.length > 0) {
      for (const node of popups) node.hidden = true;
      return true;
    }
    if (railFloats() && state.railOpen && !$('rail').hidden) {
      setRail(false);
      return true;
    }
    // Narrow screens show one pane at a time: a chat or a page goes back to the list.
    if (getComputedStyle($('back')).display !== 'none' && !$('app').classList.contains('show-side')) {
      $('app').classList.add('show-side');
      return true;
    }
    return false;
  }
  window.__mimiBack = goBack;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') wake();
  });
  window.addEventListener('focus', wake);
  window.addEventListener('pageshow', wake);
  window.addEventListener('online', () => {
    retryMs = 1000;
    wake();
  });
  window.addEventListener('offline', () => setConn(false));

  // Ask for an answer every so often: a phone that went to sleep can sit on a dead socket
  // for a long time otherwise (the server's own ping never comes back through a frozen tab).
  function startPing() {
    if (pingTimer) return;
    pingTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPong > 18000 && Date.now() - lastTraffic > 18000) {
        // Nothing heard in a while: drop the socket and reconnect instead of guessing.
        try {
          socket.close();
        } catch {
          // already closing
        }
        retryMs = 1000;
        return;
      }
      socket.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
  }
  startPing();
  function setGateMode(accounts) {
    accountsMode = accounts;
    $('gate-title').textContent = accounts ? 'เข้าสู่ระบบ Mimi' : 'เชื่อมต่อ Mimi';
    $('gate-hint').textContent = accounts ? 'ใช้ชื่อผู้ใช้และรหัสผ่านที่ผู้ดูแลสร้างให้' : 'ใส่รหัสผ่านของ Mimi (ใส่ครั้งเดียว จำไว้จนกว่าจะออกจากระบบ)';
    $('gate-user').hidden = !accounts;
    $('gate-pass').hidden = !accounts;
    $('gate-code').hidden = true;
    $('token').hidden = accounts;
    $('gate-form').querySelector('button[type="submit"]').textContent = 'เข้าสู่ระบบ';
  }

  async function signIn() {
    const username = $('gate-user').value.trim();
    const password = $('gate-pass').value;
    const code = $('gate-code').hidden ? '' : $('gate-code').value.trim();
    if (!username || !password) return;
    $('gate-error').textContent = '';
    let response;
    try {
      response = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, ...(code ? { code } : {}) }),
      });
    } catch {
      $('gate-error').textContent = 'ติดต่อเซิร์ฟเวอร์ไม่ได้';
      return;
    }
    if (!response.ok) {
      const answer = await response.json().catch(() => ({}));
      if (response.status === 401 && answer.twoFactor) {
        // The password was right: keep it for the second try and ask for the code.
        $('gate-code').hidden = false;
        $('gate-code').value = '';
        $('gate-code').focus();
        $('gate-error').textContent = 'ใส่รหัส 6 หลักจากแอปยืนยันตัวตน';
        return;
      }
      $('gate-pass').value = '';
      $('gate-code').value = '';
      $('gate-error').textContent =
        response.status === 429 ? 'ลองผิดหลายครั้งเกินไป รอสักครู่แล้วลองใหม่' : code ? 'ชื่อผู้ใช้ รหัสผ่าน หรือรหัสจากแอปไม่ถูกต้อง' : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
      return;
    }
    $('gate-pass').value = '';
    $('gate-code').value = '';
    $('gate-code').hidden = true;
    const session = await response.json();
    keepSignIn(session.token, session.webhookBase || '', session.username || username);
    connect();
  }

  /**
   * Ends this device's session on the server, then leaves nothing of Mimi in this browser:
   * this device stops getting push notifications, and every key this app stored is removed.
   */
  async function signOut() {
    try {
      await window.MimiHooks?.notify?.forgetDevice?.();
    } catch {
      // no push on this device
    }
    if (accountsMode) {
      try {
        await api('/auth/logout', { method: 'POST' });
      } catch {
        // Offline: the token is still forgotten here; it lapses on the server by itself.
      }
    }
    localStorage.clear();
    sessionStorage.clear();
    for (const url of blobs.values()) url.then((href) => URL.revokeObjectURL(href)).catch(() => {});
    // The desktop app wipes its own storage and reopens at the sign-in page.
    window.MimiAndroid?.signedIn('');
    if (window.MimiDesktop) window.MimiDesktop.signedOut('logout');
    else location.reload();
  }

  $('gate-form').onsubmit = (event) => {
    event.preventDefault();
    if (accountsMode) {
      void signIn();
      return;
    }
    const value = $('token').value.trim();
    if (!value) return;
    keepSignIn(value);
    $('gate-error').textContent = '';
    connect();
  };

  renderHeader();
  renderChatList();
  connect();
  // Installs as an app (Android home screen) and opens a "no connection" page offline, from
  // the sign-in page on; push notifications use the same worker once switched on.
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
  fetch('/health')
    .then((response) => response.json())
    .then((health) => {
      state.version = health.version;
      if (linkToken && !health.accounts) {
        localStorage.setItem(TOKEN_KEY, linkToken);
        connect();
      }
      linkToken = null;
      if (health.accounts) {
        setGateMode(true);
        // Refreshes where this account's webhooks live (it may predate this device's sign-in).
        if (token()) {
          api('/auth/session')
            .then((response) => (response.ok ? response.json() : null))
            .then((session) => session && (sessionStorage.getItem(TOKEN_KEY) ? sessionStorage : localStorage).setItem(WEBHOOK_KEY, session.webhookBase || ''))
            .catch(() => {});
        }
      }
      if (state.view === 'settings') renderSettings();
    })
    .catch(() => {});
})();
