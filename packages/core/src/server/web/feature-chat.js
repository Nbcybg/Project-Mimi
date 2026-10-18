// Telegram-like touches for the chat screen: emoji picker, reply, forward and copy,
// reached from a context menu on any message (right-click, or long-press on touch).
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

  const whoOf = (message) => (message.role === 'user' ? 'คุณ' : M().nameOf(message.agent));

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
    info.append(el('b', '', `ตอบกลับ ${reply.who}`), el('div', 'txt', reply.text || '(ข้อความ)'));
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
    M().toast('ส่งต่อแล้ว', `ไปที่ ${chat.title || 'แชต'}`);
  }

  function forwardDialog(message) {
    const dialog = el('div', 'dialog form');
    dialog.append(el('h3', '', 'ส่งต่อข้อความ'), el('p', 'hint', `${whoOf(message)}: ${(message.text || '(ไฟล์)').slice(0, 120)}`));
    const list = el('div', 'list');
    for (const chat of M().state.chats) {
      if (M().state.chat && chat.id === M().state.chat.id) continue;
      const row = button('item', null, () => forwardTo(chat, message));
      const info = el('div', 'one');
      info.append(el('b', '', chat.title || 'แชต'), el('small', '', chat.kind === 'group' ? `กลุ่ม · ${chat.agents.map((name) => M().nameOf(name)).join(', ')}` : 'ตัวต่อตัว'));
      row.append(M().avatar(chat.agents[0] || ''), info);
      list.append(row);
    }
    if (list.children.length === 0) list.append(el('div', 'empty', 'ไม่มีแชตอื่นให้ส่งต่อ'));
    dialog.append(list);
    M().overlay(dialog);
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
    item('↩ ตอบกลับ', () => replyTo(message));
    item('↪ ส่งต่อ', () => forwardDialog(message));
    if (message.text) {
      item('⧉ คัดลอกข้อความ', async () => {
        try {
          await navigator.clipboard.writeText(message.text);
          M().toast('คัดลอกแล้ว');
        } catch {
          M().toast('คัดลอกไม่ได้', 'เลือกข้อความแล้วคัดลอกเอง', true);
        }
      });
    }
    menu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - 170)}px`;
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
    emojiButton.title = 'อิโมจิ';
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

    const log = M().logInner;
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
  };
  mount();
})();
