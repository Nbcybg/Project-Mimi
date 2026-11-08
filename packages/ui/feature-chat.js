// Telegram-like touches for the chat screen: emoji picker, and on every message reply,
// forward, copy, love / react and pin. A small bar of buttons shows when the pointer is on
// a message (on touch: tap it); the same actions are in the context menu (right-click, or
// long-press on touch). Pinned messages are listed in a bar under the chat header.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const EMOJIS = [
    '😀', '😄', '😁', '😅', '😂', '🙂', '😉', '😊', '😍', '😘', '😜', '🤪', '🤔', '🤨', '😐', '😴',
    '😢', '😭', '😤', '😡', '🥺', '😱', '🤯', '😎', '🥳', '🤗', '🤭', '🙄', '😬', '🤫', '🫡', '🤝',
    '👍', '👎', '👏', '🙏', '💪', '✌️', '🤞', '👌', '👋', '🫶', '❤️', '🧡', '💛', '💚', '💙', '💜',
    '💔', '✨', '🎉', '🎊', '🔥', '⭐', '🌟', '💯', '✅', '❌', '⚠️', '❓', '❗', '⏰', '📌', '📎',
    '💡', '📝', '📚', '💰', '🛒', '🍜', '🍕', '🍰', '☕', '🍺', '🎮', '🎵', '🎬', '⚽', '🚗', '✈️',
    '🏠', '🌧️', '☀️', '🌙', '🐶', '🐱', '🌸', '🌈', '🎁', '🫠', '🤖', '👻',
  ];

  const whoOf = (message) => (message.role === 'user' ? t('you') : M().nameOf(message.agent));

  // ---------- reply bar ----------
  function renderReplyBar() {
    const bar = document.getElementById('reply-bar');
    const reply = M().compose.replyTo;
    if (!reply) {
      bar.hidden = true;
      bar.replaceChildren();
      return;
    }
    const info = el('div');
    info.style.minWidth = '0';
    info.style.flex = '1';
    info.append(el('b', '', t('reply.to', { who: reply.who })), el('div', 'txt', reply.text || t('msg.empty')));
    bar.replaceChildren(info, button('btn ghost', '✕', () => {
      M().compose.replyTo = null;
      renderReplyBar();
    }));
    bar.hidden = false;
  }

  function replyTo(message) {
    M().compose.replyTo = { id: message.id, who: whoOf(message), text: message.text || '' };
    renderReplyBar();
    M().input.focus();
  }

  // ---------- forward ----------
  function forwardTo(chat, message) {
    M().send({
      type: 'chat-send',
      chatId: chat.id,
      text: message.text || '',
      ...(message.attachments && message.attachments.length > 0 ? { attachments: message.attachments.map((file) => file.id) } : {}),
      forward: { from: whoOf(message), chat: M().state.chat ? M().chatTitle(M().state.chat) : '' },
    });
    M().closeOverlay();
    M().toast(t('forward.done'), t('forward.to', { chat: chat.title || t('chat.default') }));
  }

  function forwardDialog(message) {
    const dialog = el('div', 'dialog form');
    dialog.append(el('h3', '', t('forward.title')), el('p', 'hint', `${whoOf(message)}: ${(message.text || t('msg.file')).slice(0, 120)}`));
    const list = el('div', 'list');
    for (const chat of M().state.chats) {
      if (M().state.chat && chat.id === M().state.chat.id) continue;
      const row = button('item', null, () => forwardTo(chat, message));
      const info = el('div', 'one');
      info.append(el('b', '', chat.title || t('chat.default')), el('small', '', chat.kind === 'group' ? t('chat.group', { members: chat.agents.map((name) => M().nameOf(name)).join(', ') }) : t('chat.direct')));
      row.append(M().avatar(chat.agents[0] || ''), info);
      list.append(row);
    }
    if (list.children.length === 0) list.append(el('div', 'empty', t('forward.none')));
    dialog.append(list);
    M().overlay(dialog);
  }

  // ---------- love, react, pin, copy ----------
  const LOVE = '❤️';
  const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];
  const live = (message) => M().messageStore.get(message.id) || message;
  const loved = (message) => (live(message).reactions || []).includes(LOVE);

  const react = (message, emoji) => M().send({ type: 'message-react', messageId: message.id, emoji });
  const pin = (message) => M().send({ type: 'message-pin', messageId: message.id, pinned: !live(message).pinned });

  async function copyText(message) {
    try {
      await navigator.clipboard.writeText(message.text);
      M().toast(t('copy.done'));
    } catch {
      M().toast(t('copy.fail'), t('copy.failHint'), true);
    }
  }

  /** The chips under a bubble: the reactions (click to take one back) and the pin. */
  function marks(message) {
    const nodes = [];
    for (const emoji of message.reactions || []) {
      nodes.push(button('react', emoji, () => react(message, emoji), t('react.remove')));
    }
    if (message.pinned) nodes.push(el('span', 'pinmark', '📌'));
    return nodes;
  }

  let picker = null;
  function closePicker() {
    picker?.remove();
    picker = null;
  }

  /** The button bar on a message. `node` is the bubble (or the column of a user message). */
  function decorate(node, message) {
    if (!message.id || typeof message.id !== 'number') return;
    node.classList.add('hasbar');
    node.tabIndex = 0;
    node.dataset.bar = message.id;
    const bar = el('div', 'msgbar');
    const love = button(`b${loved(message) ? ' on' : ''}`, loved(message) ? '❤️' : '🤍', () => react(message, LOVE), t('like'));
    love.dataset.act = 'love';
    const more = button('b', '😊', (event) => {
      event.stopPropagation();
      const open = picker && picker.parentElement === bar;
      closePicker();
      if (open) return;
      picker = el('div', 'reactpick');
      for (const emoji of REACTIONS) {
        picker.append(button('', emoji, (inner) => {
          inner.stopPropagation();
          closePicker();
          react(message, emoji);
        }));
      }
      bar.append(picker);
    }, t('react'));
    const pinButton = button(`b${message.pinned ? ' on' : ''}`, '📌', () => pin(message), message.pinned ? t('unpin') : t('pin'));
    pinButton.dataset.act = 'pin';
    bar.append(
      love,
      more,
      button('b', '↩', () => replyTo(live(message)), t('reply.action')),
      button('b', '↪', () => forwardDialog(live(message)), t('forward.action')),
    );
    if (message.text) bar.append(button('b', '⧉', () => copyText(message), t('copy.action')));
    bar.append(pinButton);
    node.append(bar);
  }

  /** The reactions or pin of a message changed: its buttons show the new state. */
  function refresh(message) {
    for (const node of document.querySelectorAll(`[data-bar="${message.id}"]`)) {
      const love = node.querySelector('[data-act="love"]');
      if (love) {
        love.classList.toggle('on', loved(message));
        love.textContent = loved(message) ? '❤️' : '🤍';
      }
      const pinButton = node.querySelector('[data-act="pin"]');
      if (pinButton) {
        pinButton.classList.toggle('on', Boolean(message.pinned));
        pinButton.title = message.pinned ? t('unpin') : t('pin');
      }
    }
  }

  // ---------- pinned messages ----------
  let pinIndex = 0;
  const pinPreview = (entry) => `${entry.role === 'user' ? t('you') : M().nameOf(entry.agent)}: ${entry.text || t('msg.file')}`;

  function jumpTo(entry) {
    const target = M().logInner.querySelector(`[data-id="${entry.id}"]`);
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.animate([{ outline: '2px solid #e08aa7' }, { outline: '2px solid transparent' }], { duration: 1800 });
      return;
    }
    // Pinned in another session: open it at that message.
    const chat = M().state.chat;
    if (chat) M().openChat(chat.id, entry.sessionId, entry.id);
  }

  function pinsDialog() {
    const dialog = el('div', 'dialog form');
    dialog.append(el('h3', '', `📌 ${t('pins.title')}`));
    const list = el('div', 'list');
    for (const entry of M().state.pins) {
      const row = el('div', 'item');
      const open = button('one', null, () => {
        M().closeOverlay();
        jumpTo(entry);
      });
      open.append(el('b', '', pinPreview(entry).slice(0, 120)), el('small', '', M().fmtDate(entry.createdAt)));
      row.append(open, button('btn ghost', t('pins.unpin'), () => M().send({ type: 'message-pin', messageId: entry.id, pinned: false })));
      list.append(row);
    }
    if (list.children.length === 0) list.append(el('div', 'empty', t('pins.none')));
    dialog.append(list);
    M().overlay(dialog);
  }

  function renderPins() {
    const bar = document.getElementById('pinbar');
    if (!bar) return;
    const pins = (M().state.pins || []).filter(() => M().state.chat);
    bar.hidden = pins.length === 0;
    if (pins.length === 0) return;
    pinIndex = Math.min(pinIndex, pins.length - 1);
    const entry = pins[pinIndex];
    const body = button('pinbody', null, () => {
      jumpTo(entry);
      pinIndex = (pinIndex + 1) % pins.length;
      renderPins();
    });
    body.append(
      el('b', '', pins.length > 1 ? `📌 ${t('pin')} ${pinIndex + 1}/${pins.length}` : `📌 ${t('pin')}`),
      el('span', 'txt', pinPreview(entry)),
    );
    bar.replaceChildren(body, button('btn ghost', pins.length > 1 ? t('pins.all') : '✕', () => (pins.length > 1 ? pinsDialog() : M().send({ type: 'message-pin', messageId: entry.id, pinned: false })), pins.length > 1 ? t('pins.viewAll') : t('unpin')));
  }

  // ---------- context menu ----------
  let menu = null;
  function closeMenu() {
    menu?.remove();
    menu = null;
  }
  function openMenu(x, y, message) {
    closeMenu();
    menu = el('div', 'ctxmenu');
    const item = (label, onClick) => {
      menu.append(button('', label, () => {
        closeMenu();
        onClick();
      }));
    };
    const current = live(message);
    item(loved(current) ? `❤️ ${t('unlike')}` : `🤍 ${t('like')}`, () => react(current, LOVE));
    item(`↩ ${t('reply.action')}`, () => replyTo(current));
    item(`↪ ${t('forward.action')}`, () => forwardDialog(current));
    if (current.text) item(`⧉ ${t('copy.text')}`, () => copyText(current));
    item(`📌 ${current.pinned ? t('unpin') : t('pin')}`, () => pin(current));
    menu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 250)}px`;
    document.body.append(menu);
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
  }

  // ---------- emoji ----------
  function insertEmoji(emoji, panel) {
    const input = M().input;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = `${input.value.slice(0, start)}${emoji}${input.value.slice(end)}`;
    input.selectionStart = input.selectionEnd = start + emoji.length;
    input.focus();
    M().autosize();
  }

  function mount() {
    const box = document.getElementById('box');
    const line = box.querySelector('.line');

    const bar = el('div', 'reply-bar');
    bar.id = 'reply-bar';
    bar.hidden = true;
    box.insertBefore(bar, line);

    const emojiButton = el('button', 'ic', '🙂');
    emojiButton.id = 'emoji';
    emojiButton.type = 'button';
    emojiButton.title = t('emoji');
    line.insertBefore(emojiButton, document.getElementById('send'));
    const panel = el('div', 'emoji-panel');
    panel.hidden = true;
    for (const emoji of EMOJIS) panel.append(button('', emoji, () => insertEmoji(emoji, panel)));
    box.append(panel);
    emojiButton.onclick = () => {
      panel.hidden = !panel.hidden;
    };
    document.addEventListener('click', (event) => {
      if (!panel.hidden && !panel.contains(event.target) && event.target !== emojiButton) panel.hidden = true;
    });
    M().input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) panel.hidden = true;
    });

    // Pinned messages sit between the header and the stage.
    const pins = el('div', 'pinbar');
    pins.id = 'pinbar';
    pins.hidden = true;
    document.getElementById('stage').before(pins);

    const log = M().logInner;
    document.addEventListener('click', closePicker);
    // Touch screens have no hover: a tap on a message shows its buttons.
    if (window.matchMedia('(hover: none)').matches) {
      log.addEventListener('click', (event) => {
        if (event.target.closest('a, button, img, audio, video, input, .msgbar')) return;
        const node = event.target.closest('.hasbar');
        const was = node && node.classList.contains('sel');
        for (const other of log.querySelectorAll('.hasbar.sel')) other.classList.remove('sel');
        if (node && !was) node.classList.add('sel');
      });
    }
    log.addEventListener('contextmenu', (event) => {
      const target = event.target.closest('[data-id]');
      if (!target) return;
      const message = M().messageStore.get(Number(target.dataset.id));
      if (!message) return;
      event.preventDefault();
      openMenu(event.clientX, event.clientY, message);
    });

    // Long-press on touch screens opens the same menu.
    let press = null;
    log.addEventListener(
      'touchstart',
      (event) => {
        const target = event.target.closest('[data-id]');
        if (!target) return;
        press = setTimeout(() => {
          const message = M().messageStore.get(Number(target.dataset.id));
          if (message) {
            const touch = event.touches[0];
            openMenu(touch.clientX, touch.clientY, message);
          }
          press = null;
        }, 480);
      },
      { passive: true },
    );
    const cancelPress = () => {
      if (press) clearTimeout(press);
      press = null;
    };
    log.addEventListener('touchmove', cancelPress, { passive: true });
    log.addEventListener('touchend', cancelPress);
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.chat = {
    onSent: renderReplyBar,
    decorate,
    marks,
    refresh,
    renderPins,
  };
  mount();
})();
