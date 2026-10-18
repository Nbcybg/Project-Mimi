(() => {
  'use strict';

  // ---------- basics ----------
  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = 'mimi-token';
  const CHAT_KEY = 'mimi-chat';

  // The token may arrive in the URL fragment; keep it out of the address bar and history.
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromHash) {
    localStorage.setItem(TOKEN_KEY, fromHash);
    history.replaceState(null, '', location.pathname);
  }
  const token = () => localStorage.getItem(TOKEN_KEY) || '';

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
  };
  $('attach').innerHTML = ICONS.clip;
  $('mic').innerHTML = ICONS.mic;
  $('send').innerHTML = ICONS.send;
  $('stop').innerHTML = ICONS.stop;

  const fmtTime = (iso) => new Date(iso).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  function fmtDay(iso) {
    const date = new Date(iso);
    return date.toDateString() === new Date().toDateString()
      ? fmtTime(iso)
      : date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
  }
  const fmtDate = (iso) => new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const fmtSize = (bytes) =>
    bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  function preview(value, limit = 160) {
    const text = (typeof value === 'string' ? value : JSON.stringify(value) || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }
  function toast(title, body, bad) {
    const node = el('div', `toast${bad ? ' bad' : ''}`);
    node.append(el('b', '', title));
    if (body) node.append(document.createTextNode(body));
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
    tools: [],
    toolPresets: [],
    toolCustom: [],
    toolSecretKeys: {},
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
    railOpen: window.innerWidth > 1180,
    busyChat: null,
    typing: null,
    staged: [],
    pendingPerms: new Map(),
    highlight: null,
    lastSent: null,
    booted: false,
  };
  const ui = { agent: null, agentDirty: false, hubTab: 'models', preset: null, presetDirty: false, skill: null, skillDirty: false, toolDirty: false, providerDirty: false, triggerDirty: false, workflowDirty: false, memory: null };

  let socket = null;
  let retryMs = 1000;
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
  const COLORS = ['#e08a5b', '#7db3e8', '#74c991', '#b49cf0', '#dfb25a', '#e88fb4', '#6fc7c2'];
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
    if (agent && agent.avatar) {
      blobUrl(`/api/agent-image/${encodeURIComponent(name)}/avatar?v=${agent.avatar}`)
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
  function renderText(node, text) {
    node.replaceChildren();
    text.split(/```(?:[\w-]*\n)?([\s\S]*?)```/g).forEach((part, index) => {
      // Blank lines next to a code block would only add empty space around it.
      if (index % 2) node.append(el('pre', '', part.replace(/\n$/, '')));
      else inline(node, (index === 0 ? part : part.replace(/^\n+/, '')).replace(/\n+$/, ''));
    });
  }

  // ---------- chat list ----------
  function renderChatList() {
    const nodes = state.chats.map((chat) => {
      const busy = state.busyChat === chat.id;
      const row = button(`chat${state.chat && state.chat.id === chat.id ? ' on' : ''}`, null, () => openChat(chat.id));
      const middle = el('div');
      middle.style.minWidth = '0';
      const fallback = chat.kind === 'group' ? `กลุ่ม ${chat.agents.length} คน` : 'ยังไม่มีข้อความ';
      middle.append(el('div', 't', chatTitle(chat)), el('div', `p${busy ? ' busy' : ''}`, busy ? 'กำลังตอบ…' : chat.preview.replace(/[*`]/g, '') || fallback));
      row.append(
        chat.kind === 'direct' ? avatar(chat.agents[0]) : avatarStack(chat.agents.slice(0, 3), 'sm'),
        middle,
        el('div', 'r', chat.lastMessageAt ? fmtDay(chat.lastMessageAt) : ''),
      );
      return row;
    });
    const fresh = state.agents.filter(
      (agent) => !state.chats.some((chat) => chat.kind === 'direct' && chat.agents[0] === agent.name),
    );
    if (fresh.length > 0) {
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
    if (nodes.length === 0) nodes.push(el('div', 'empty', 'ยังไม่มี agent — ไปที่แท็บ Agent เพื่อสร้างตัวแรก'));
    $('chat-list').replaceChildren(...nodes);
  }

  /** Shows the chat pane and asks the core for a chat (an existing one, or one to create). */
  function startChat(request) {
    setView('chat');
    $('app').classList.remove('show-side');
    send(request);
  }
  function openChat(chatId, sessionId, highlight) {
    state.highlight = highlight || null;
    startChat({ type: 'chat-open', chatId, sessionId });
    localStorage.setItem(CHAT_KEY, String(chatId));
  }
  function emptyState() {
    const empty = el('div', 'welcome');
    empty.append(el('b', '', 'Mimi'), state.agents.length ? 'เลือกแชตทางซ้าย หรือกด "+ ใหม่" เพื่อเริ่มคุย' : 'เริ่มจากเชื่อมต่อผู้ให้บริการโมเดลที่ "ตั้งค่า" แล้วสร้าง agent ตัวแรกที่แท็บ "Agent"');
    logInner.replaceChildren(empty);
  }

  // ---------- log ----------
  const logBox = $('log');
  const logInner = $('log-inner');
  /** The assistant block being streamed into right now. */
  let live = null;
  const cards = new Map();

  const pinned = () => logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 140;
  const scrollDown = () => {
    logBox.scrollTop = logBox.scrollHeight;
  };
  function add(node) {
    const stick = pinned();
    logInner.append(node);
    if (stick) scrollDown();
    return node;
  }

  function sessionDivider(session, automatic) {
    const node = el('div', 'divider');
    const label = el('span');
    label.append(el('b', '', automatic ? 'เริ่ม session ใหม่อัตโนมัติ' : 'session'), ` · ${fmtDate(session.createdAt)}`);
    node.append(label);
    return node;
  }

  /** "วันนี้", "เมื่อวาน" or the date, for the day separators between messages. */
  function dayLabel(iso) {
    const date = new Date(iso);
    const startOf = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
    if (days === 0) return 'วันนี้';
    if (days === 1) return 'เมื่อวาน';
    return date.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
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
        target.animate([{ outline: '2px solid #e08a5b' }, { outline: '2px solid transparent' }], { duration: 1600 });
      }
    };
    return quote;
  }

  function assistantBlock(agent, iso) {
    const node = el('div', 'gmsg');
    node.style.setProperty('--c', colorOf(agent));
    const right = el('div');
    right.style.minWidth = '0';
    const name = el('div', 'nm', nameOf(agent));
    name.append(el('small', '', iso ? fmtTime(iso) : ''));
    const body = el('div', 'body');
    right.append(name, body);
    node.append(avatar(agent), right);
    return { node, body, agent, bubble: null, raw: '', dots: null, nest: null, tools: new Map() };
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
        status.textContent = ok ? '✓ เสร็จ' : '✗ ไม่สำเร็จ';
        body = el('div', 'b', String(output).slice(0, 4000));
        body.hidden = ok;
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
      toast('เปิดไฟล์ไม่ได้', file.name, true);
    }
  }
  function lightbox(url) {
    if (!url) return;
    const box = el('div', 'lightbox');
    const image = el('img');
    image.src = url;
    box.append(image);
    box.onclick = () => box.remove();
    document.body.append(box);
  }
  function attachmentNodes(files) {
    const nodes = [];
    const images = files.filter((file) => file.kind === 'image');
    if (images.length > 0) {
      const album = el('div', `album${images.length === 1 ? ' one' : ''}`);
      for (const file of images) {
        const image = el('img');
        image.alt = file.name;
        image.title = file.text ? `AI เห็นว่า: ${file.text.slice(0, 500)}` : file.name;
        blobUrl(`/api/files/${file.id}`)
          .then((url) => {
            image.src = url;
          })
          .catch(() => {});
        image.onclick = () => lightbox(image.src);
        // Keep the newest message in view when the picture arrives and takes its real height.
        image.onload = () => {
          if (logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < image.height + 220) scrollDown();
        };
        album.append(image);
      }
      nodes.push(album);
    }
    for (const file of files.filter((entry) => entry.kind === 'audio')) {
      const box = el('div', 'voice');
      const play = el('button', 'play');
      play.append(el('i', '', '▶'), el('span', '', `ข้อความเสียง · ${fmtSize(file.size)}`));
      play.onclick = async () => {
        try {
          const audio = el('audio');
          audio.controls = true;
          audio.src = await blobUrl(`/api/files/${file.id}`);
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
    for (const file of files.filter((entry) => entry.kind === 'file')) {
      const chip = button('filechip', null, () => download(file), file.text ? file.text.slice(0, 500) : file.name);
      const info = el('div');
      info.style.minWidth = '0';
      info.append(el('div', 'fname', file.name), el('div', 'fmeta', fmtSize(file.size)));
      chip.append(fileIcon(file.name, file.kind), info);
      nodes.push(chip);
    }
    return nodes;
  }

  function userRow(message) {
    const row = el('div', 'row-user');
    row.dataset.id = message.id;
    row.dataset.role = 'user';
    const actions = el('div', 'acts');
    actions.append(
      button('', '↩ ย้อนกลับ', () => rewind(message), 'ย้อนบทสนทนากลับไปก่อนข้อความนี้ แล้วแก้ไขส่งใหม่ได้'),
    );
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
    column.append(el('div', 'time', fmtTime(message.createdAt)));
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
      target = assistantBlock(message.agent, message.createdAt);
      container.append(target.node);
    }
    if (message.text) {
      const bubble = el('div', 'tx');
      bubble.dataset.id = message.id;
      bubble.dataset.role = 'assistant';
      bubble.dataset.agent = message.agent;
      renderText(bubble, message.text);
      target.body.append(bubble);
    }
    if (message.approval) target.body.append(approvalNode(message.approval));
    for (const tool of message.tools || []) target.body.append(toolRow(tool.name, tool.summary, false).node);
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
    cards.clear();
    messageStore.clear();
    lastDay = null;
    logInner.replaceChildren();
    if (!state.chat) return emptyState();
    if (history.hasMore) logInner.append(olderButton(history.messages[0]));
    else if (state.session) logInner.append(sessionDivider(state.session));
    if (history.messages.length === 0 && !history.hasMore) {
      const empty = el('div', 'welcome');
      empty.append(el('b', '', `คุยกับ ${chatTitle(state.chat)}`), 'พิมพ์ข้อความด้านล่างได้เลย ส่งรูป เสียง หรือไฟล์ก็ได้');
      logInner.append(empty);
    }
    let block = null;
    for (const message of history.messages) block = appendStored(logInner, message, block);
    for (const request of state.pendingPerms.values()) permissionCard(request);
    const target = state.highlight && logInner.querySelector(`[data-id="${state.highlight}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.animate([{ outline: '2px solid #e08a5b' }, { outline: '2px solid transparent' }], { duration: 2200 });
    } else {
      scrollDown();
    }
    state.highlight = null;
  }
  function olderButton(first) {
    const node = el('div', 'divider');
    node.append(
      button('', 'ดูข้อความก่อนหน้า', () => {
        send({ type: 'chat-open', chatId: state.chat.id, sessionId: state.session.id, beforeId: first.id });
      }),
    );
    return node;
  }
  function prependOlder(history) {
    const fragment = document.createDocumentFragment();
    if (history.hasMore) fragment.append(olderButton(history.messages[0]));
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

  function permissionCard(request) {
    if (cards.has(request.id)) return;
    const card = el('div', 'perm');
    card.append(
      el('div', 'ttl', `${nameOf(request.agent)} ขออนุญาตใช้ ${request.tool} (${request.risk})`),
      el('div', '', request.summary),
      el('div', 'kv', JSON.stringify(request.input, null, 2)),
    );
    const answer = (allow) => send({ type: 'permission-response', requestId: request.id, allow });
    const allow = button('btn pri', 'อนุญาต', () => answer(true));
    const deny = button('btn', 'ปฏิเสธ', () => answer(false));
    const verdict = el('span', 'muted');
    const row = el('div', 'btns');
    row.append(allow, deny, verdict);
    card.append(row);
    cards.set(request.id, { allow, deny, verdict });
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
    card.allow.disabled = card.deny.disabled = true;
    card.verdict.textContent = decision.allow ? 'อนุญาตแล้ว' : `ไม่อนุญาต (${decision.reason})`;
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
  /** `sub` is set when the event comes from an agent (or skill) working for the one that is answering. */
  function handleEvent(event, sub) {
    switch (event.type) {
      case 'agent-activity':
        handleEvent(event.event, event.agent);
        break;
      case 'run-start':
        if (sub) {
          subLine(sub, `เริ่มทำงาน (${event.model})`);
          break;
        }
        live = assistantBlock(event.agent, new Date().toISOString());
        add(live.node);
        think(true);
        state.typing = event.agent;
        renderHeader();
        break;
      case 'text-delta': {
        if (sub || !live) break;
        think(false);
        if (!live.bubble) {
          live.bubble = el('div', 'tx');
          live.raw = '';
          live.body.append(live.bubble);
        }
        live.raw += event.text;
        const stick = pinned();
        renderText(live.bubble, live.raw);
        if (stick) scrollDown();
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
      case 'permission-request':
        state.pendingPerms.set(event.request.id, event.request);
        think(false);
        permissionCard(event.request);
        break;
      case 'permission-decision':
        resolveCard(event.requestId, event.decision);
        break;
      case 'run-finish': {
        if (sub) {
          subLine(sub, `เสร็จ: ${preview(event.text || event.error || event.reason, 160)}`);
          break;
        }
        think(false);
        if (event.reason === 'error') add(el('div', 'note bad', `ผิดพลาด: ${event.error}`));
        else if (!['stop', 'handoff'].includes(event.reason)) {
          add(el('div', 'note bad', `หยุด: ${REASONS[event.reason] || event.reason}${event.error ? ` — ${event.error}` : ''}`));
        }
        const usage = event.usage;
        const hit = usage.inputTokens ? Math.round((usage.cachedTokens / usage.inputTokens) * 100) : 0;
        add(el('div', 'note use', `${event.rounds} รอบ · in ${usage.inputTokens} (cache ${hit}%) · out ${usage.outputTokens} · $${usage.costUsd.toFixed(5)}`));
        live = null;
        state.typing = null;
        renderHeader();
        break;
      }
    }
  }
  const showing = (chatId, sessionId) =>
    state.chat && state.chat.id === chatId && state.session && state.session.id === sessionId;

  function rewind(message) {
    if (!state.latest) return toast('ย้อนกลับได้เฉพาะใน session ล่าสุด');
    if (state.busyChat !== null) return toast('รอให้ตอบเสร็จก่อน หรือกดหยุด แล้วค่อยย้อนกลับ');
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
  function renderHeader() {
    const chat = state.chat;
    const direct = chat && chat.kind === 'direct' ? agentOf(chat.agents[0]) : null;
    $('chat-avatars').replaceChildren(
      ...(chat ? chat.agents.slice(0, 4).map((name) => avatar(name, chat.kind === 'group' ? 'sm' : '')) : []),
    );
    $('chat-title').textContent = chat ? chatTitle(chat) : 'Mimi';
    const sub = $('chat-sub');
    sub.className = `sub${state.typing ? ' typing' : ''}`;
    sub.textContent = !chat
      ? ''
      : state.typing
        ? `${nameOf(state.typing)} กำลังพิมพ์…`
        : chat.kind === 'group'
          ? `กลุ่ม · ${chat.agents.map(nameOf).join(', ')}`
          : (direct && direct.description) || '';

    const bar = $('statusbar');
    const chips = [];
    if (direct) {
      for (const [key, label] of STATUS) {
        const value = direct.status && direct.status[key];
        if (!value) continue;
        const chip = el('span', `st${key === 'mood' ? ' mood' : ''}`);
        chip.append(el('b', '', label), el('span', '', value));
        chips.push(chip);
      }
    }
    bar.replaceChildren(...chips);
    bar.hidden = chips.length === 0;

    const figure = $('figure');
    const portrait = direct && direct.portrait;
    $('stage').classList.toggle('has-figure', Boolean(portrait));
    figure.hidden = !portrait;
    if (portrait) {
      const path = `/api/agent-image/${encodeURIComponent(direct.name)}/portrait?v=${portrait}`;
      if (figure.dataset.path !== path) {
        figure.dataset.path = path;
        figure.removeAttribute('src');
        blobUrl(path)
          .then((url) => {
            if (figure.dataset.path === path) figure.src = url;
          })
          .catch(() => {});
      }
    } else {
      delete figure.dataset.path;
    }

    $('box').hidden = !chat || !state.latest;
    $('old-session').hidden = !chat || state.latest;
    $('new-session').hidden = !chat;
    $('stop').hidden = !(chat && state.busyChat === chat.id);
    renderHints();
  }

  function renderRail() {
    const rail = $('rail');
    rail.hidden = !(state.railOpen && state.view === 'chat' && state.chat);
    $('app').classList.toggle('with-rail', !rail.hidden);
    $('toggle-rail').classList.toggle('pri', !rail.hidden);
    if (rail.hidden) return;
    const chat = state.chat;
    const nodes = [];

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
    } else {
      const section = el('div');
      const head = el('h3', '', 'สมาชิก');
      head.append(
        button('', 'เปลี่ยนชื่อกลุ่ม', () => {
          const title = prompt('ชื่อกลุ่ม', chat.title);
          if (title !== null) send({ type: 'chat-update', chatId: chat.id, title });
        }),
      );
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
      section.append(el('p', 'hint', 'พิมพ์ @ชื่อ เพื่อเรียกคนตอบ ถ้าไม่ระบุ คนแรกในรายชื่อจะตอบ agent เรียกกันเองด้วย @ชื่อ ได้เช่นกัน'));
      nodes.push(section);
    }

    const sessions = el('div');
    const head = el('h3', '', 'Session');
    head.append(button('', '+ ใหม่', () => send({ type: 'session-new', chatId: chat.id })));
    sessions.append(head);
    for (const session of state.sessions) {
      const row = button(`sess${state.session && state.session.id === session.id ? ' on' : ''}`, null, () => openChat(chat.id, session.id));
      row.append(el('div', 't', session.title || 'ยังไม่มีชื่อ'), el('div', 'm', `${fmtDate(session.lastMessageAt)}${session.summary ? ` · ${session.summary}` : ''}`));
      sessions.append(row);
    }
    if (state.sessions.length === 0) sessions.append(el('div', 'empty', 'ยังไม่มี session — เริ่มเองอัตโนมัติเมื่อส่งข้อความแรก'));
    nodes.push(sessions);

    nodes.push(
      button('btn danger', 'ลบแชตนี้', () => {
        if (confirm(`ลบแชต "${chatTitle(chat)}" ?\nประวัติจะไม่แสดงอีก (ความจำที่บันทึกไว้แล้วยังอยู่)`)) {
          send({ type: 'chat-delete', chatId: chat.id });
          state.chat = null;
          state.session = null;
          state.sessions = [];
          emptyState();
          renderHeader();
          renderRail();
          $('app').classList.add('show-side');
        }
      }),
    );
    rail.replaceChildren(...nodes);
  }

  // ---------- composer ----------
  const input = $('input');
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }
  let recorder = null;
  let recordStarted = 0;
  let recordTimer = null;
  function renderHints() {
    const hints = $('hints');
    if (recorder) {
      const seconds = Math.floor((Date.now() - recordStarted) / 1000);
      hints.replaceChildren(el('span', 'rec', `● กำลังอัดเสียง ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} — กดไมค์อีกครั้งเพื่อหยุด`));
      return;
    }
    const parts = ['Enter ส่ง · Shift+Enter ขึ้นบรรทัดใหม่'];
    if (state.chat && state.chat.kind === 'group') parts.push('@ชื่อ เพื่อเรียกคนตอบ');
    if (state.busyChat !== null && state.chat && state.busyChat !== state.chat.id) parts.push('มีแชตอื่นกำลังตอบอยู่ ข้อความนี้จะเข้าคิว');
    hints.replaceChildren(...parts.map((part) => el('span', '', part)));
  }
  function renderStaged() {
    const box = $('staged');
    box.hidden = state.staged.length === 0;
    box.replaceChildren(
      ...state.staged.map((entry) => {
        const remove = el('u', '', '×');
        remove.onclick = (event) => {
          event.stopPropagation();
          state.staged = state.staged.filter((other) => other !== entry);
          renderStaged();
        };
        if (entry.url) {
          const thumb = el('div', `thumb${entry.uploading ? ' wait' : ''}`);
          thumb.style.backgroundImage = `url("${entry.url}")`;
          thumb.title = entry.file.name;
          thumb.append(remove);
          return thumb;
        }
        const chip = el('div', `filechip${entry.uploading ? ' wait' : ''}`);
        const info = el('div');
        info.append(el('div', 'fname', entry.file.name), el('div', 'fmeta', entry.uploading ? 'กำลังอัปโหลด…' : fmtSize(entry.file.size)));
        chip.append(fileIcon(entry.file.name, entry.file.type.startsWith('audio/') ? 'audio' : 'file'), info, remove);
        return chip;
      }),
    );
  }
  async function stageFile(file) {
    if (file.size > 25 * 1024 * 1024) return toast('ไฟล์ใหญ่เกินไป', `${file.name} เกิน 25 MB`, true);
    const entry = { file, id: null, uploading: true, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
    state.staged.push(entry);
    renderStaged();
    try {
      const response = await api(`/api/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      entry.id = result.id;
      entry.uploading = false;
    } catch (error) {
      state.staged = state.staged.filter((other) => other !== entry);
      toast('อัปโหลดไม่สำเร็จ', `${file.name}: ${error.message}`, true);
    }
    renderStaged();
  }
  function sendMessage() {
    if (!state.chat || !state.latest) return;
    if (state.staged.some((entry) => entry.uploading)) return toast('รอสักครู่', 'กำลังอัปโหลดไฟล์อยู่');
    const text = input.value.trim();
    const attachments = state.staged.filter((entry) => entry.id).map((entry) => entry.id);
    if (!text && attachments.length === 0) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) return toast('ยังไม่ได้เชื่อมต่อ', 'ข้อความยังอยู่ในช่องพิมพ์ ลองส่งอีกครั้ง', true);
    send({ type: 'chat-send', chatId: state.chat.id, text, attachments, ...(compose.replyTo ? { replyTo: compose.replyTo.id } : {}) });
    state.lastSent = text;
    input.value = '';
    compose.replyTo = null;
    if (window.MimiHooks && window.MimiHooks.chat) window.MimiHooks.chat.onSent();
    autosize();
    state.staged = [];
    renderStaged();
    $('mention').hidden = true;
    if (window.Notification && Notification.permission === 'default') Notification.requestPermission();
  }
  async function toggleRecord() {
    if (recorder) return recorder.stop();
    if (!navigator.mediaDevices || !window.MediaRecorder) return toast('อัดเสียงไม่ได้', 'เบราว์เซอร์นี้ไม่รองรับ แนบไฟล์เสียงแทนได้', true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
      const chunks = [];
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const type = (recorder.mimeType || 'audio/webm').split(';')[0];
        stream.getTracks().forEach((track) => track.stop());
        recorder = null;
        clearInterval(recordTimer);
        $('mic').classList.remove('rec');
        renderHints();
        const blob = new Blob(chunks, { type });
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        if (blob.size > 0) stageFile(new File([blob], `voice-${stamp}.${type.includes('mp4') ? 'm4a' : 'webm'}`, { type }));
      };
      recorder.start();
      recordStarted = Date.now();
      $('mic').classList.add('rec');
      recordTimer = setInterval(renderHints, 500);
      renderHints();
    } catch (error) {
      recorder = null;
      toast('ใช้ไมโครโฟนไม่ได้', error.message, true);
    }
  }
  /** In a group: offers the members while the user types "@na…". */
  function renderMention() {
    const box = $('mention');
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

  input.addEventListener('input', () => {
    autosize();
    renderMention();
  });
  input.addEventListener('keydown', (event) => {
    const mention = $('mention');
    if (!mention.hidden && (event.key === 'Tab' || event.key === 'Enter')) {
      event.preventDefault();
      mention.firstElementChild.click();
      return;
    }
    if (event.key === 'Escape') mention.hidden = true;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData ? event.clipboardData.files : [])];
    if (files.length === 0) return;
    event.preventDefault();
    files.forEach(stageFile);
  });
  $('send').onclick = sendMessage;
  $('stop').onclick = () => send({ type: 'abort' });
  $('mic').onclick = toggleRecord;
  $('attach').onclick = (event) => {
    event.stopPropagation();
    $('attach-menu').hidden = !$('attach-menu').hidden;
  };
  for (const item of $('attach-menu').querySelectorAll('button')) {
    item.onclick = () => {
      $('attach-menu').hidden = true;
      $('file-input').accept = item.dataset.pick;
      $('file-input').click();
    };
  }
  $('file-input').onchange = (event) => {
    [...event.target.files].forEach(stageFile);
    event.target.value = '';
  };
  document.addEventListener('click', () => {
    $('attach-menu').hidden = true;
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
  box.addEventListener('drop', (event) => [...event.dataTransfer.files].forEach(stageFile));

  $('back').onclick = () => $('app').classList.add('show-side');
  $('toggle-rail').onclick = () => {
    state.railOpen = !state.railOpen;
    renderRail();
  };
  $('new-session').onclick = () => {
    if (state.chat && confirm('เริ่ม session ใหม่? บทสนทนาเดิมยังเปิดดูได้จากรายการ session และ agent ยังจำเรื่องสำคัญได้')) {
      send({ type: 'session-new', chatId: state.chat.id });
    }
  };
  $('to-latest').onclick = () => state.chat && openChat(state.chat.id);

  // ---------- views ----------
  function setView(view) {
    state.view = view;
    for (const name of ['chat', 'agents', 'hub', 'settings']) $(`view-${name}`).hidden = name !== view;
    for (const item of $('nav').children) item.classList.toggle('on', item.dataset.view === view);
    if (view === 'agents') renderAgents();
    if (view === 'hub') renderHub();
    if (view === 'settings') renderSettings();
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
      }
      if (item.dataset.view === 'agents') {
        send({ type: 'tools-list' });
        send({ type: 'workflows-list' });
      }
      if (item.dataset.view === 'settings') {
        send({ type: 'memory-list' });
        send({ type: 'secrets-list' });
      }
    };
  }
  function pageHead(title, lead) {
    const head = el('div');
    const row = el('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center';
    row.append(button('back', '‹', () => $('app').classList.add('show-side')), el('h2', '', title));
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
  /** A model picker: presets from the model pool first, then the models of the connected providers. */
  function modelSelect(current, emptyLabel, withPresets = true) {
    const select = el('select');
    const view = state.settings || { models: [], presets: [] };
    const add = (value, text) => {
      const option = el('option', '', text);
      option.value = value;
      select.append(option);
    };
    if (emptyLabel !== null) add('', `— ${emptyLabel} —`);
    const presets = withPresets ? view.presets : [];
    if (current && !presets.some((preset) => preset.name === current) && !view.models.some((model) => model.ref === current)) {
      add(current, `${current} (ใช้ไม่ได้ตอนนี้: ยังไม่ได้เชื่อมต่อ หรือ preset ถูกลบ)`);
    }
    for (const preset of presets) add(preset.name, presetLabel(preset));
    for (const model of view.models) add(model.ref, model.label);
    select.value = current || '';
    select.dataset.initial = current || '';
    return select;
  }
  const CAPABILITIES = [
    ['model', 'คุย (chat)'],
    ['vision_model', 'ดูรูป / อ่าน PDF'],
    ['transcript_model', 'ถอดเสียง'],
    ['small_model', 'สรุป / ความจำ'],
  ];
  /** Progress text next to the save buttons of the page that is open. */
  function flash(message) {
    for (const node of document.querySelectorAll(`#view-${state.view} .foot .msg`)) node.textContent = message;
  }
  const saved = () => toast('บันทึกแล้ว ✓');

  // ---------- agents page ----------
  function renderAgents() {
    const page = $('view-agents');
    const agent = agentOf(ui.agent) || null;
    const list = el('div', 'panel');
    list.append(el('h3', '', 'Agent ทั้งหมด'));
    const items = el('div', 'list');
    for (const entry of state.agents) {
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
    if (state.agents.length === 0) items.append(el('div', 'empty', 'ยังไม่มี agent — กรอกแบบฟอร์มแล้วกดบันทึก'));
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
    const systemPrompt = el('textarea', 'tall');
    systemPrompt.value = agent ? agent.systemPrompt : '';
    systemPrompt.placeholder = 'System prompt: บุคลิก กฎ และวิธีทำงานของ agent นี้';
    form.append(labelled('System prompt', systemPrompt));

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
    } else {
      form.append(el('p', 'hint', 'บันทึก agent ก่อน แล้วจึงใส่รูปโปรไฟล์และรูปเต็มตัวได้'));
    }

    form.append(el('h4', '', 'โมเดล (เลือกแยกตามงาน)'));
    const models = el('div', 'grid2');
    const defaults = state.settings ? state.settings.defaults : {};
    for (const [key, label] of CAPABILITIES) {
      const fallback = defaults[key] || (key === 'model' ? '' : 'โมเดลคุยของ agent นี้');
      const select = modelSelect(agent ? agent.models[key] : '', `ค่าเริ่มต้น${fallback ? `: ${fallback}` : ''}`);
      select.dataset.capability = key;
      models.append(labelled(label, select));
    }
    form.append(models);

    form.append(el('h4', '', 'Skill (จาก Skill hub)'));
    const skills = checkList(state.skills, agent ? agent.skills || [] : [], (skill) => `${skill.model ? `ใช้โมเดล ${skill.model} · ` : ''}${skill.description}`);
    form.append(skills);
    form.append(el('h4', '', 'เครื่องมือ (จาก Tool hub)'));
    const tools = checkList(toolItems(), agent ? agent.tools : [], describeTool);
    form.append(tools);
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
        send({
          type: 'agent-save',
          renameFrom: agent ? agent.name : undefined,
          agent: {
            name: name.value.trim(),
            displayName: displayName.value.trim(),
            description: description.value.trim(),
            systemPrompt: systemPrompt.value,
            models: chosen,
            tools: picked(tools),
            skills: picked(skills),
            canMessage: picked(peers),
            budgets: { maxRounds: Number(rounds.value) || 12, maxTokens: Number(tokens.value) || 200000 },
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
  const HUB_TABS = [
    ['models', 'กองโมเดล'],
    ['skills', 'Skill'],
    ['tools', 'เครื่องมือ'],
    ['triggers', 'Trigger'],
    ['knowledge', 'คลังความรู้'],
    ['links', 'MCP / CLI'],
  ];
  function renderHub() {
    const page = $('view-hub');
    const tabs = el('div', 'tabs');
    for (const [key, label] of HUB_TABS) {
      tabs.append(
        button(key === ui.hubTab ? 'on' : '', label, () => {
          ui.hubTab = key;
          renderHub();
        }),
      );
    }
    const knowledge = () => (window.MimiHooks && window.MimiHooks.knowledge ? window.MimiHooks.knowledge.render() : el('div'));
    const body = { models: hubModels, skills: hubSkills, tools: hubTools, triggers: hubTriggers, knowledge, links: hubLinks }[ui.hubTab]();
    page.replaceChildren(pageHead('Hub', 'ของกลางที่ agent และ skill หยิบไปใช้: ตั้งค่าที่เดียว ใช้ได้ทุกตัว'), tabs, body);
  }
  const shown = (value) => (value === undefined || value === null ? '—' : String(value));

  function hubModels() {
    const view = state.settings || { presets: [], models: [] };
    const preset = view.presets.find((entry) => entry.name === ui.preset) || null;
    const table = el('div', 'panel');
    table.append(el('h3', '', 'Preset'), el('p', 'hint', 'preset = โมเดล + ค่าการสุ่ม ตั้งชื่อแล้วเลือกใช้ได้ทุกที่ที่เลือกโมเดล (agent, skill, ค่าเริ่มต้น)'));
    const rows = el('div', 'tbl presets');
    const head = el('div', 'hd');
    for (const label of ['ชื่อ', 'โมเดล', 'temp', 'top_p', 'top_k', 'max', 'effort']) head.append(el('span', '', label));
    rows.append(head);
    for (const entry of view.presets) {
      const row = button(entry.name === ui.preset ? 'sel' : '', null, () => {
        ui.preset = entry.name;
        ui.presetDirty = false;
        renderHub();
      });
      row.append(el('span', 'nm2', entry.name), el('span', 'mono', entry.model));
      for (const value of [entry.temperature, entry.topP, entry.topK, entry.maxOutputTokens, entry.reasoning]) row.append(el('span', 'num', shown(value)));
      rows.append(row);
    }
    table.append(rows);
    if (view.presets.length === 0) table.append(el('div', 'empty', 'ยังไม่มี preset'));
    const create = button('btn', '+ preset ใหม่', () => {
      ui.preset = null;
      ui.presetDirty = false;
      renderHub();
    });
    create.style.marginTop = '10px';
    table.append(create);

    const form = el('div', 'panel form');
    form.oninput = () => {
      ui.presetDirty = true;
    };
    form.append(el('h3', '', preset ? `แก้ไข ${preset.name}` : 'Preset ใหม่'));
    const name = textInput(preset ? preset.name : '', 'เช่น creative, precise, pro');
    name.readOnly = Boolean(preset);
    const model = modelSelect(preset ? preset.model : '', 'เลือกโมเดล', false);
    form.append(labelled('ชื่อ (ตัวพิมพ์เล็ก ไม่มีเว้นวรรค)', name), labelled('โมเดล', model));
    if (view.models.length === 0) form.append(el('p', 'hint', 'ยังไม่มีโมเดลให้เลือก: เชื่อมต่อผู้ให้บริการที่หน้า "ตั้งค่า" ก่อน'));
    const knobs = {};
    for (const [key, label, min, max, step] of [
      ['temperature', 'temperature', 0, 2, 0.05],
      ['topP', 'top_p', 0, 1, 0.01],
      ['topK', 'top_k', 1, 200, 1],
    ]) {
      const row = el('div', 'knob');
      const range = el('input');
      range.type = 'range';
      range.min = min;
      range.max = max;
      range.step = step;
      const number = textInput(preset && preset[key] !== undefined ? preset[key] : '', 'ค่าเริ่มต้น', 'number');
      number.min = min;
      number.max = key === 'topK' ? 1000 : max;
      number.step = step;
      range.value = number.value === '' ? (key === 'temperature' ? 1 : key === 'topP' ? 1 : 40) : number.value;
      range.oninput = () => {
        number.value = range.value;
      };
      number.oninput = () => {
        if (number.value !== '') range.value = number.value;
      };
      row.append(el('span', '', label), range, number);
      knobs[key] = number;
      form.append(row);
    }
    const maxTokens = textInput(preset && preset.maxOutputTokens !== undefined ? preset.maxOutputTokens : '', 'ค่าเริ่มต้น', 'number');
    form.append(labelled('ความยาวคำตอบสูงสุด (token)', maxTokens));
    const reasoning = el('select');
    for (const [value, text] of REASONING_CHOICES) {
      const option = el('option', '', text);
      option.value = value;
      reasoning.append(option);
    }
    reasoning.value = (preset && preset.reasoning) || '';
    form.append(labelled('effort (คิดก่อนตอบมากแค่ไหน)', reasoning));
    form.append(el('p', 'hint', 'สูง = ตอบฉลาดขึ้นแต่ช้าและเปลือง token มากขึ้น · โมเดลที่ไม่มีโหมดคิดจะไม่สนค่านี้ · บางผู้ให้บริการรองรับแค่บางระดับ จะปัดไประดับที่ใกล้ที่สุด'));
    form.append(el('p', 'hint', 'ช่องที่เว้นว่างจะใช้ค่าเริ่มต้นของผู้ให้บริการ โมเดลบางตัวไม่รองรับ top_k'));
    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'));
    if (preset) {
      foot.append(
        button('btn danger', 'ลบ', () => {
          if (confirm(`ลบ preset "${preset.name}" ?`)) {
            send({ type: 'preset-delete', name: preset.name });
            ui.preset = null;
            ui.presetDirty = false;
          }
        }),
      );
    }
    foot.append(
      button('btn pri', 'บันทึก', () => {
        const value = (node) => (node.value === '' ? undefined : Number(node.value));
        ui.preset = name.value.trim().toLowerCase();
        ui.presetDirty = false;
        flash('กำลังบันทึก…');
        send({
          type: 'preset-save',
          preset: {
            name: name.value.trim(),
            model: model.value,
            temperature: value(knobs.temperature),
            topP: value(knobs.topP),
            topK: value(knobs.topK),
            maxOutputTokens: value(maxTokens),
            reasoning: reasoning.value || undefined,
          },
        });
      }),
    );
    form.append(foot);
    const split = el('div', 'split');
    split.style.gridTemplateColumns = 'minmax(0, 1.2fr) minmax(0, 1fr)';
    split.append(table, form);
    return split;
  }

  function hubSkills() {
    const skill = state.skills.find((entry) => entry.name === ui.skill) || null;
    const list = el('div', 'panel');
    list.append(el('h3', '', 'Skill ทั้งหมด'));
    const items = el('div', 'list');
    for (const entry of state.skills) {
      const users = state.agents.filter((agent) => (agent.skills || []).includes(entry.name)).map((agent) => nameOf(agent.name));
      const row = button(`item${entry.name === ui.skill ? ' on' : ''}`, null, () => {
        ui.skill = entry.name;
        ui.skillDirty = false;
        renderHub();
      });
      const info = el('div', 'one');
      info.append(el('b', 'mono', entry.name), el('small', '', `${entry.model ? `โมเดล ${entry.model}` : 'agent ทำเอง'} · ${users.length ? `ใช้โดย ${users.join(', ')}` : 'ยังไม่มีใครใช้'}`));
      row.append(info);
      items.append(row);
    }
    if (state.skills.length === 0) items.append(el('div', 'empty', 'ยังไม่มี skill'));
    list.append(items);
    const create = button('btn', '+ skill ใหม่', () => {
      ui.skill = null;
      ui.skillDirty = false;
      renderHub();
    });
    create.style.marginTop = '10px';
    list.append(create);

    const form = el('div', 'panel form');
    form.oninput = () => {
      ui.skillDirty = true;
    };
    form.append(el('h3', '', skill ? `แก้ไข ${skill.name}` : 'Skill ใหม่'));
    const name = textInput(skill ? skill.name : '', 'เช่น song-writer (a-z 0-9 -)');
    const description = textInput(skill ? skill.description : '', 'ใช้เมื่อไร: agent อ่านบรรทัดนี้เพื่อตัดสินใจว่าจะเรียก skill');
    const model = modelSelect(skill ? skill.model : '', 'ไม่แยกโมเดล: agent อ่านคำสั่งแล้วทำเอง');
    const top = el('div', 'grid2');
    top.append(labelled('ชื่อ', name), labelled('โมเดลของ skill นี้', model));
    form.append(top, labelled('คำอธิบาย', description));
    form.append(el('p', 'hint', 'ถ้าเลือกโมเดล (เช่น preset "pro") skill จะรันแยกเป็นงานย่อยด้วยโมเดลนั้น แล้วส่งผลลัพธ์กลับมาให้ agent'));
    const body = el('textarea', 'tall');
    body.value = skill ? skill.body : '';
    body.placeholder = 'คำสั่งของ skill: ขั้นตอน กฎ รูปแบบผลลัพธ์';
    form.append(labelled('คำสั่ง', body));
    form.append(el('h4', '', 'เครื่องมือที่ skill ใช้ได้ (เฉพาะเมื่อรันแยกโมเดล)'));
    const tools = checkList(toolItems(), skill ? skill.tools : [], describeTool);
    form.append(tools);
    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'));
    if (skill) {
      foot.append(
        button('btn danger', 'ลบ', () => {
          if (confirm(`ลบ skill "${skill.name}" ? (จะถูกเอาออกจาก agent ทุกตัวที่ใช้อยู่)`)) {
            send({ type: 'skill-delete', name: skill.name });
            ui.skill = null;
            ui.skillDirty = false;
          }
        }),
      );
    }
    foot.append(
      button('btn pri', 'บันทึก', () => {
        flash('กำลังบันทึก…');
        send({
          type: 'skill-save',
          renameFrom: skill ? skill.name : undefined,
          skill: { name: name.value.trim(), description: description.value.trim(), model: model.value, tools: picked(tools), body: body.value },
        });
      }),
    );
    form.append(foot);
    const split = el('div', 'split');
    split.append(list, form);
    return split;
  }

  function hubTools() {
    const hook = window.MimiHooks && window.MimiHooks.tools;
    if (hook) return hook.render();
    const panel = el('div', 'panel');
    panel.append(el('h3', '', `เครื่องมือในกอง (${state.tools.length})`), el('p', 'hint', 'agent และ skill เลือกเครื่องมือจากกองนี้ · read ทำได้เลย · write / shell / delete / network ต้องขออนุญาตก่อนทุกครั้ง'));
    const rows = el('div', 'tbl toolrows');
    const head = el('div', 'hd');
    for (const label of ['ชื่อ', 'ระดับ', 'ทำอะไร', 'ใช้โดย']) head.append(el('span', '', label));
    rows.append(head);
    for (const tool of state.tools) {
      const users = state.agents.filter((agent) => agent.tools.includes(tool.name)).map((agent) => nameOf(agent.name));
      const row = el('div');
      const risk = el('span');
      risk.append(el('span', `risk${tool.risk === 'read' ? '' : ' w'}`, tool.risk));
      const description = el('span', '', tool.description);
      description.title = tool.description;
      row.append(el('span', 'nm2', tool.name), risk, description, el('span', 'muted', users.join(', ') || '—'));
      rows.append(row);
    }
    panel.append(rows);
    return panel;
  }

  function hubTriggers() {
    const hook = window.MimiHooks && window.MimiHooks.triggers;
    if (hook) return hook.render();
    const panel = el('div', 'panel');
    panel.append(el('h3', '', 'Trigger'), el('p', 'hint', 'สร้างได้โดยสั่ง agent ในแชต เช่น "เตือนพรุ่งนี้ 9 โมงให้โทรหาแม่" หรือ "ทุกเช้า 8 โมงสรุปเมลให้หน่อย" (agent ต้องมีเครื่องมือ create_trigger)'));
    const rows = el('div', 'tbl trigrows');
    const head = el('div', 'hd');
    for (const label of ['เรื่อง', 'ชนิด', 'เวลา', 'สถานะ', '']) head.append(el('span', '', label));
    rows.append(head);
    for (const trigger of state.triggers) {
      const row = el('div');
      const when = trigger.cron ? `cron ${trigger.cron}` : trigger.fireAt ? fmtDate(trigger.fireAt) : '—';
      const status = el('span');
      status.append(el('span', `pill ${trigger.status === 'active' ? 'ok' : 'todo'}`, { active: 'รออยู่', fired: 'ทำแล้ว', cancelled: 'ยกเลิก' }[trigger.status]));
      const cancel = trigger.status === 'active'
        ? button('btn ghost', 'ยกเลิก', () => confirm(`ยกเลิก "${trigger.title}" ?`) && send({ type: 'trigger-cancel', id: trigger.id }))
        : el('span');
      row.append(el('span', '', `${trigger.title}${trigger.agent ? ` · ${nameOf(trigger.agent)}` : ''}`), el('span', 'muted', trigger.kind === 'reminder' ? 'เตือน' : 'งานของ agent'), el('span', 'mono', when), status, cancel);
      rows.append(row);
    }
    panel.append(rows);
    if (state.triggers.length === 0) panel.append(el('div', 'empty', 'ยังไม่มี trigger'));
    return panel;
  }

  function hubLinks() {
    const panel = el('div', 'panel');
    panel.append(
      el('h3', '', 'MCP และ CLI'),
      el('p', 'hint', 'ยังไม่ได้สร้างในรุ่นนี้'),
      el('p', '', 'แผน: เชื่อม MCP server (เครื่องมือของมันจะเข้ามาอยู่ในกองเครื่องมือเหมือนตัวอื่น) และห่อคำสั่ง CLI บนเครื่อง PC ให้เป็นเครื่องมือผ่าน PC agent ตอนนี้ agent รันคำสั่งได้ผ่านเครื่องมือ run_shell ซึ่งขออนุญาตก่อนทุกครั้ง'),
    );
    return panel;
  }

  // ---------- settings page ----------
  function renderSettings() {
    const page = $('view-settings');
    const view = state.settings;
    if (!view) return page.replaceChildren(pageHead('ตั้งค่า', 'กำลังโหลด…'));
    const nodes = [pageHead('ตั้งค่า', 'ผู้ให้บริการโมเดล โมเดลเริ่มต้น โฟลเดอร์ที่อนุญาต บัญชี Google และความจำ')];
    if (!view.ready) {
      nodes.push(
        el(
          'p',
          'warnbox',
          !view.providers.some((provider) => provider.connected)
            ? 'ยังคุยไม่ได้: เชื่อมต่อผู้ให้บริการโมเดลก่อน (ชื่อ + URL + API key)'
            : view.agents === 0
              ? 'เชื่อมต่อผู้ให้บริการแล้ว ขั้นต่อไป: ไปที่แท็บ "Agent" เพื่อสร้าง agent ตัวแรก'
              : 'ยังคุยไม่ได้: โมเดลคุยของ agent เป็นของผู้ให้บริการที่ยังไม่ได้เชื่อมต่อ แก้ที่แท็บ "Agent" หรือเลือกโมเดลเริ่มต้นด้านล่าง',
        ),
      );
    }
    const stack = el('div', 'stackv');

    // The user's own profile, shared per agent (feature-profile.js).
    const profile = el('div', 'panel form');
    profile.append(el('h3', '', 'โปรไฟล์ของฉัน'));
    const profileHook = window.MimiHooks && window.MimiHooks.profile;
    if (profileHook) profileHook.render(profile);
    stack.append(profile);

    // Providers: add, edit, remove and manage the model list (feature-providers.js).
    const providers = el('div', 'panel form');
    providers.append(el('h3', '', 'ผู้ให้บริการโมเดล'));
    const providerHook = window.MimiHooks && window.MimiHooks.providers;
    if (providerHook) providerHook.render(providers);
    else providers.append(el('p', 'hint', 'โหลดหน้าจอผู้ให้บริการไม่สำเร็จ — รีเฟรชหน้าใหม่'));
    stack.append(providers);

    // The API-key vault (machine-local), used by tool templates and preset settings.
    const secrets = el('div', 'panel form');
    secrets.append(el('h3', '', 'คีย์ / ความลับ (เก็บในเครื่องนี้เท่านั้น)'));
    const secretsHook = window.MimiHooks && window.MimiHooks.secrets;
    if (secretsHook) secretsHook.render(secrets);
    else secrets.append(el('p', 'hint', '—'));
    stack.append(secrets);

    const general = el('div', 'panel form');
    general.append(el('h3', '', 'โมเดลเริ่มต้น'), el('p', 'hint', view.models.length ? 'ใช้กับ agent ที่ไม่ได้เลือกโมเดลของตัวเองในงานนั้น' : 'เชื่อมต่อผู้ให้บริการก่อน แล้วรายชื่อโมเดลจะขึ้นให้เลือก'));
    const defaults = el('div', 'grid2');
    for (const [key, label] of CAPABILITIES) {
      const select = modelSelect(view.defaults[key] || '', key === 'model' ? null : 'ใช้โมเดลคุย');
      select.dataset.default = key;
      defaults.append(labelled(label, select));
    }
    general.append(defaults);
    general.append(el('h4', '', 'โฟลเดอร์ที่อนุญาตให้อ่าน/เขียนไฟล์และรันคำสั่ง'), el('p', 'hint', 'บรรทัดละหนึ่งโฟลเดอร์ บรรทัดแรกคือโฟลเดอร์ทำงานหลัก'));
    const dirs = el('textarea');
    dirs.value = view.allowedDirs.join('\n');
    dirs.dataset.initial = dirs.value;
    general.append(dirs);
    general.append(el('h4', '', 'Gmail และ Google Calendar'), el('p', 'hint', view.google.connected ? 'เชื่อมต่อแล้ว ✓' : 'สร้าง OAuth client ชนิด "Desktop app" ใน Google Cloud Console แล้ววางสองค่านี้ บันทึก จากนั้นกดเชื่อมต่อ'));
    const google = el('div', 'grid2');
    const googleKeys = [];
    for (const [key, label] of [['GOOGLE_OAUTH_CLIENT_ID', 'Client ID'], ['GOOGLE_OAUTH_CLIENT_SECRET', 'Client secret']]) {
      const field = textInput('', view.google.hasClient ? 'ใส่แล้ว ✓' : 'วางค่าที่นี่', 'password');
      field.dataset.key = key;
      googleKeys.push(field);
      google.append(labelled(label, field));
    }
    general.append(google);
    const connectGoogle = button('btn', view.google.connected ? 'เชื่อมต่อ Google ใหม่' : 'เชื่อมต่อ Google', () => send({ type: 'google-connect' }));
    connectGoogle.disabled = !view.google.hasClient;
    const googleLink = el('span');
    googleLink.id = 'google-link';
    const googleRow = el('div', 'btns');
    googleRow.style.marginTop = '8px';
    googleRow.append(connectGoogle, googleLink);
    general.append(googleRow);

    general.append(
      el('h4', '', 'Outlook, ปฏิทิน Outlook และ Microsoft To Do'),
      el(
        'p',
        'hint',
        view.microsoft.connected
          ? 'เชื่อมต่อแล้ว ✓'
          : 'ลงทะเบียนแอปของคุณเองที่ Azure Portal → App registrations แล้วเพิ่ม platform "Mobile and desktop applications" โดยใส่ redirect URI เป็น http://localhost จากนั้นวาง Application (client) ID ที่นี่ บันทึก แล้วกดเชื่อมต่อ (ไม่ต้องใช้ client secret)',
      ),
    );
    const microsoft = el('div', 'grid2');
    for (const [key, label, placeholder] of [
      ['MICROSOFT_CLIENT_ID', 'Application (client) ID', view.microsoft.hasClient ? 'ใส่แล้ว ✓' : 'วางค่าที่นี่'],
      ['MICROSOFT_TENANT', 'Tenant (ไม่บังคับ)', 'common — ใช้ได้ทั้งบัญชีส่วนตัวและบัญชีองค์กร'],
    ]) {
      const field = textInput('', placeholder);
      field.dataset.key = key;
      googleKeys.push(field);
      microsoft.append(labelled(label, field));
    }
    general.append(microsoft);
    const connectMicrosoft = button('btn', view.microsoft.connected ? 'เชื่อมต่อ Microsoft ใหม่' : 'เชื่อมต่อ Microsoft', () => send({ type: 'microsoft-connect' }));
    connectMicrosoft.disabled = !view.microsoft.hasClient;
    const microsoftLink = el('span');
    microsoftLink.id = 'microsoft-link';
    const microsoftRow = el('div', 'btns');
    microsoftRow.style.marginTop = '8px';
    microsoftRow.append(connectMicrosoft, microsoftLink);
    general.append(microsoftRow);

    general.append(el('h4', '', 'คีย์ของเครื่องมือค้นหา'), el('p', 'hint', 'ใช้กับเครื่องมือ web_search, map_search และ weather คีย์เก็บในเครื่องนี้เท่านั้น'));
    const toolKeys = el('div', 'grid2');
    for (const [key, label, isSet] of [
      ['SERPER_API_KEY', 'ค้นเว็บ + แผนที่ (serper.dev)', view.toolKeys.serper],
      ['OPENWEATHER_API_KEY', 'พยากรณ์อากาศ (openweathermap.org)', view.toolKeys.openweather],
    ]) {
      const field = textInput('', isSet ? 'ใส่แล้ว ✓' : 'วาง API key ที่นี่', 'password');
      field.dataset.key = key;
      googleKeys.push(field);
      toolKeys.append(labelled(label, field));
    }
    general.append(toolKeys);

    const foot = el('div', 'foot');
    foot.append(
      el('span', 'msg'),
      button('btn pri', 'บันทึก', () => {
        const change = { type: 'settings-save' };
        const keys = {};
        for (const field of googleKeys) if (field.value.trim()) keys[field.dataset.key] = field.value.trim();
        if (Object.keys(keys).length) change.keys = keys;
        const chosen = {};
        for (const select of defaults.querySelectorAll('select')) if (select.value !== select.dataset.initial) chosen[select.dataset.default] = select.value;
        if (Object.keys(chosen).length) change.defaults = chosen;
        if (dirs.value !== dirs.dataset.initial) change.allowedDirs = dirs.value.split('\n').map((line) => line.trim()).filter(Boolean);
        flash('กำลังบันทึก…');
        send(change);
      }),
    );
    general.append(foot);
    stack.append(general);

    stack.append(memoryPanel());
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

  function newChatDialog() {
    if (state.agents.length === 0) {
      setView('agents');
      $('app').classList.remove('show-side');
      return toast('ยังไม่มี agent', 'สร้าง agent ตัวแรกก่อน');
    }
    const dialog = el('div', 'dialog form');
    let kind = 'direct';
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
  $('new-chat').onclick = newChatDialog;

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
        const who = hit.role === 'user' ? 'คุณ' : nameOf(hit.agent);
        row.append(el('span', 'w', `${chat ? chatTitle(chat) : hit.chatTitle || 'แชต'} · ${who}`), text, el('span', 'd', fmtDay(hit.createdAt)));
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
    $('pc-dot').classList.toggle('on', Boolean(online));
    $('pc').textContent = online ? `PC agent: ${name || 'online'}` : 'PC agent: ไม่ได้เชื่อมต่อ';
  }
  function setConn(online) {
    $('conn').className = `conn${online ? ' on' : ''}`;
    $('conn').textContent = online ? 'online' : 'offline';
  }
  /** After the first lists arrive: lead a new user through setup, else reopen the last chat. */
  function bootstrap() {
    if (state.booted || !state.settings || !state.gotAgents || !state.gotChats) return;
    state.booted = true;
    if (!state.settings.providers.some((provider) => provider.connected)) {
      setView('settings');
      $('app').classList.remove('show-side');
    } else if (state.agents.length === 0) {
      setView('agents');
      $('app').classList.remove('show-side');
    } else if (!state.chat) {
      const remembered = Number(localStorage.getItem(CHAT_KEY));
      const chat = state.chats.find((entry) => entry.id === remembered) || state.chats[0];
      if (chat) {
        const narrow = window.innerWidth <= 820;
        send({ type: 'chat-open', chatId: chat.id });
        if (narrow) $('app').classList.add('show-side');
      }
    }
  }

  function onMessage(message) {
    switch (message.type) {
      case 'welcome':
        $('gate').style.display = 'none';
        setPc(message.pcOnline);
        state.busyChat = message.busyChat === undefined ? null : message.busyChat;
        state.pendingPerms = new Map(message.pendingPermissions.map((request) => [request.id, request]));
        state.booted = false;
        state.gotAgents = state.gotChats = false;
        for (const type of ['agents-list', 'settings-get', 'chats-list', 'skills-list', 'tools-list', 'workflows-list']) send({ type });
        if (state.chat) send({ type: 'chat-open', chatId: state.chat.id, sessionId: state.latest ? undefined : state.session && state.session.id });
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
          break;
        }
        state.chat = message.chat;
        state.session = message.session;
        state.sessions = message.sessions;
        state.latest = !message.session || message.sessions[0].id === message.session.id;
        state.typing = null;
        if (!state.chats.some((chat) => chat.id === message.chat.id)) state.chats.unshift(message.chat);
        localStorage.setItem(CHAT_KEY, String(message.chat.id));
        renderChatList();
        renderHeader();
        renderRail();
        renderLog(message);
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
          logInner.replaceChildren(sessionDivider(message.session, automatic));
        }
        renderRail();
        break;
      }
      case 'chat-message':
        if (state.lastSent !== null && message.message.text === state.lastSent) state.lastSent = null;
        if (!showing(message.chatId, message.sessionId)) break;
        if (logInner.querySelector('.welcome')) logInner.querySelector('.welcome').remove();
        ensureDay(logInner, message.message.createdAt);
        messageStore.set(message.message.id, message.message);
        add(userRow(message.message));
        scrollDown();
        break;
      case 'chat-event':
        if (showing(message.chatId, message.sessionId)) handleEvent(message.event, null);
        break;
      case 'busy':
        state.busyChat = message.chatId;
        if (message.chatId === null) {
          state.typing = null;
          live = null;
        }
        renderChatList();
        renderHeader();
        break;
      case 'chat-changed':
        if (showing(message.chatId, message.sessionId)) send({ type: 'chat-open', chatId: message.chatId, sessionId: state.latest ? undefined : message.sessionId });
        break;
      case 'rewound':
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
        toast(`${notice.kind === 'reminder' ? '⏰ ' : notice.kind === 'approval' ? '✋ ' : '📋 '}${notice.title}`, notice.body);
        if (window.Notification && Notification.permission === 'granted') new Notification(notice.title, { body: notice.body });
        send({ type: 'chats-list' });
        if (state.chat && notice.chatId === state.chat.id && state.latest && state.busyChat !== state.chat.id) {
          send({ type: 'chat-open', chatId: state.chat.id });
        }
        break;
      }
      case 'pc-status':
        setPc(message.online, message.name);
        break;
      case 'status': {
        const agent = agentOf(message.agent);
        if (agent) agent.status = message.status;
        renderHeader();
        renderRail();
        break;
      }
      case 'settings':
        state.settings = message.settings;
        if (window.MimiHooks && window.MimiHooks.providers) window.MimiHooks.providers.onMessage(message);
        if (state.view === 'settings' && (!ui.providerDirty || message.saved)) {
          renderSettings();
          if (message.saved) saved();
        }
        if (state.view === 'hub' && ((!ui.presetDirty && !ui.skillDirty && !ui.toolDirty && !ui.triggerDirty && !ui.workflowDirty) || message.saved)) {
          renderHub();
          if (message.saved) saved();
        }
        if (state.view === 'agents' && !ui.agentDirty) renderAgents();
        bootstrap();
        break;
      case 'agents':
        state.agents = message.agents;
        state.tools = message.tools;
        state.defaultAgent = message.defaultAgent;
        state.gotAgents = true;
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
        if (message.saved) {
          ui.skill = message.saved;
          ui.skillDirty = false;
        }
        if (ui.skill && !state.skills.some((skill) => skill.name === ui.skill)) ui.skill = null;
        if (state.view === 'hub' && (!ui.skillDirty || message.saved)) {
          renderHub();
          if (message.saved) saved();
        }
        if (state.view === 'agents' && !ui.agentDirty) renderAgents();
        break;
      case 'tools':
        state.tools = message.tools;
        state.toolPresets = message.presets || [];
        state.toolCustom = message.custom || [];
        state.toolSecretKeys = message.secretKeys || {};
        if (window.MimiHooks && window.MimiHooks.tools) window.MimiHooks.tools.onMessage(message);
        if (state.view === 'hub' && ui.hubTab === 'tools' && (!ui.toolDirty || message.saved)) {
          renderHub();
          if (message.saved) saved();
        }
        if (state.view === 'agents' && !ui.agentDirty) renderAgents();
        break;
      case 'secrets':
        state.secrets = message.names || [];
        if (window.MimiHooks && window.MimiHooks.secrets) window.MimiHooks.secrets.onMessage(message);
        if (state.view === 'settings' && !ui.providerDirty) renderSettings();
        break;
      case 'workflows':
        state.workflows = message.workflows || [];
        state.workflowPool = message.pool || [];
        state.nodeTypes = message.nodeTypes || [];
        if (window.MimiHooks && window.MimiHooks.agentWorkflows) window.MimiHooks.agentWorkflows.onMessage(message);
        if (state.view === 'agents' && !ui.agentDirty) renderAgents();
        if (state.view === 'hub' && ui.hubTab === 'triggers') renderHub();
        break;
      case 'workflow-result': {
        const result = message.result;
        const steps = (result.steps || []).map((step) => `${step.title}: ${step.output.slice(0, 200)}`).join('\n');
        toast(result.ok ? 'Workflow เสร็จแล้ว' : 'Workflow ล้มเหลว', `${result.name}\n${result.result.slice(0, 300)}${steps ? `\n\n${steps}` : ''}`, !result.ok);
        if (window.MimiHooks && window.MimiHooks.workflows) window.MimiHooks.workflows.onResult?.(result);
        break;
      }
      case 'workflow-node-result':
        if (window.MimiHooks && window.MimiHooks.workflows) window.MimiHooks.workflows.onNodeResult?.(message.result);
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
        if (state.view === 'hub' && ui.hubTab === 'triggers' && !ui.triggerDirty) renderHub();
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
      case 'error':
        flash('');
        toast('ผิดพลาด', message.message, true);
        if (state.view === 'chat' && state.chat && (message.chatId === undefined || message.chatId === state.chat.id)) {
          add(el('div', 'note bad', `ผิดพลาด: ${message.message}`));
          // A message that never reached the conversation goes back into the input box.
          if (state.lastSent && !input.value) {
            input.value = state.lastSent;
            autosize();
          }
          state.lastSent = null;
        }
        break;
    }
  }

  // Feature screens (tools, providers, triggers, chat extras) live in their own files so
  // this one stays readable; they reach back through this bridge.
  window.Mimi = {
    state,
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
    avatar,
    blobUrl,
    renderHub,
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
    openChat,
    setView,
  };

  function connect() {
    if (!token()) {
      $('gate').style.display = 'flex';
      return;
    }
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onopen = () => {
      retryMs = 1000;
      setConn(true);
      socket.send(JSON.stringify({ type: 'hello', role: 'client', token: token(), name: 'web' }));
      window.MimiHooks?.notify?.onConnect();
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        // Feature modules that keep their own state hear their messages first.
        if ((message.type.startsWith('knowledge') || message.type === 'error') && window.MimiHooks && window.MimiHooks.knowledge) {
          window.MimiHooks.knowledge.onMessage(message);
        }
        if (message.type.startsWith('knowledge')) return;
        if (['notifications', 'notification', 'push-key', 'push-devices'].includes(message.type)) {
          window.MimiHooks?.notify?.onMessage(message);
          // A live notification still gets its toast below.
          if (message.type !== 'notification') return;
        }
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
        localStorage.removeItem(TOKEN_KEY);
        $('gate-error').textContent = 'token ไม่ถูกต้อง';
        $('gate').style.display = 'flex';
        return;
      }
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };
  }
  $('gate-form').onsubmit = (event) => {
    event.preventDefault();
    const value = $('token').value.trim();
    if (!value) return;
    localStorage.setItem(TOKEN_KEY, value);
    $('gate-error').textContent = '';
    connect();
  };

  renderHeader();
  renderChatList();
  connect();
})();
