// Notifications through the app only: an inbox the server keeps (so nothing is lost
// when a device is off or gone) behind the 🔔 button, and push messages to every
// browser that turned them on, delivered by the service worker (sw.js) even while
// the app is closed.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const ICONS = { reminder: '⏰', approval: '✋', 'task-result': '📋', message: '💬', info: '·' };
  let items = [];
  let unread = 0;
  let devices = [];
  let open = false;
  /** Waiting for the server's VAPID key (push-key reply). */
  let keyWaiter = null;
  let pushState = { supported: false, subscribed: false, endpoint: null, busy: false, error: '' };

  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;

  // ---------- chime ----------
  // A short two-note chime, made in code (no sound file), when a notification arrives while
  // the app is open. Per device; on unless turned off. Pushes to a closed app use the
  // system's own notification sound.
  const SOUND_KEY = 'mimi.notifySound';
  let audio = null;
  const soundOn = () => {
    try {
      return localStorage.getItem(SOUND_KEY) !== '0';
    } catch {
      return true;
    }
  };
  /** Browsers start audio only after a tap or key press: the context is made on the first one. */
  const unlockAudio = () => {
    if (audio || !(window.AudioContext || window.webkitAudioContext)) return;
    audio = new (window.AudioContext || window.webkitAudioContext)();
  };
  document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });
  document.addEventListener('keydown', unlockAudio, { once: true, capture: true });
  /** Inside the do-not-disturb hours of the settings (e.g. 22:00-07:00, across midnight too). */
  function quietNow() {
    const prefs = (M().state.settings && M().state.settings.preferences) || {};
    if (!prefs.quietFrom || !prefs.quietTo) return false;
    const minutes = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
    const now = new Date();
    const at = now.getHours() * 60 + now.getMinutes();
    const from = minutes(prefs.quietFrom);
    const to = minutes(prefs.quietTo);
    return from <= to ? at >= from && at < to : at >= from || at < to;
  }
  function chime(force = false) {
    if (!force && (!soundOn() || quietNow())) return;
    // The Android app posts a native notification which already uses the system
    // notification stream. Only the explicit test button plays through the bridge.
    if (window.MimiAndroid?.playSound) {
      if (force) window.MimiAndroid.playSound('chime');
      return;
    }
    unlockAudio();
    if (!audio) return;
    if (audio.state === 'suspended') void audio.resume();
    const start = audio.currentTime + 0.02;
    for (const [frequency, offset] of [[880, 0], [1318.5, 0.14]]) {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.type = 'sine';
      tone.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, start + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.45);
      tone.connect(gain).connect(audio.destination);
      tone.start(start + offset);
      tone.stop(start + offset + 0.5);
    }
  }
  // Chat sounds: a soft rising "pop" when a message goes out, two falling notes when the
  // agent finishes its reply. On unless turned off (shared by the user's devices); quiet hours mute them too.
  const CHAT_SOUND_KEY = 'mimi.chatSound';
  const chatSoundOn = () => {
    try {
      return localStorage.getItem(CHAT_SOUND_KEY) !== '0';
    } catch {
      return true;
    }
  };
  const CHAT_TONES = {
    // [type, from Hz, to Hz, start s, length s, volume]
    sent: [['triangle', 520, 880, 0, 0.12, 0.14]],
    done: [['sine', 1046.5, 1046.5, 0, 0.28, 0.13], ['sine', 784, 784, 0.12, 0.42, 0.13]],
    ask: [['sine', 784, 784, 0, 0.2, 0.13], ['sine', 988, 988, 0.16, 0.3, 0.13]],
  };
  // The real sounds: chat_1 when the user sends, chat_2 when an agent finishes answering,
  // chat_3 when an agent asks for permission. Decoded once; the tones above stand in until then.
  const CHAT_FILES = { sent: '/sounds/chat_1.mp3', done: '/sounds/chat_2.mp3', ask: '/sounds/chat_3.mp3' };
  const buffers = new Map();
  const loading = new Set();
  function loadSounds() {
    if (!audio) return;
    for (const [kind, url] of Object.entries(CHAT_FILES)) {
      if (buffers.has(kind) || loading.has(kind)) continue;
      loading.add(kind);
      fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
        .then((data) => audio.decodeAudioData(data))
        .then((decoded) => buffers.set(kind, decoded))
        .catch(() => {})
        .finally(() => loading.delete(kind));
    }
  }
  document.addEventListener('pointerdown', () => setTimeout(loadSounds, 0), { once: true, capture: true });
  document.addEventListener('keydown', () => setTimeout(loadSounds, 0), { once: true, capture: true });
  function chatSound(kind, force = false) {
    if (!force && (!chatSoundOn() || quietNow())) return;
    // Android routes these through AudioAttributes.USAGE_NOTIFICATION, so the phone's
    // notification volume (not media volume) controls them.
    if (window.MimiAndroid?.playSound) {
      window.MimiAndroid.playSound(kind);
      return;
    }
    unlockAudio();
    if (!audio || !CHAT_TONES[kind]) return;
    if (audio.state === 'suspended') void audio.resume();
    loadSounds();
    const sample = buffers.get(kind);
    if (sample) {
      const source = audio.createBufferSource();
      source.buffer = sample;
      source.connect(audio.destination);
      source.start();
      return;
    }
    const start = audio.currentTime + 0.02;
    for (const [type, from, to, offset, length, volume] of CHAT_TONES[kind]) {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      tone.type = type;
      tone.frequency.setValueAtTime(from, start + offset);
      if (to !== from) tone.frequency.exponentialRampToValueAtTime(to, start + offset + length * 0.8);
      gain.gain.setValueAtTime(0.0001, start + offset);
      gain.gain.exponentialRampToValueAtTime(volume, start + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + length);
      tone.connect(gain).connect(audio.destination);
      tone.start(start + offset);
      tone.stop(start + offset + length + 0.05);
    }
  }
  function chatSoundToggle() {
    const wrap = el('div', 'hstack');
    const label = el('label', 'wcheck');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = chatSoundOn();
    box.onchange = () => {
      M().store.set(CHAT_SOUND_KEY, box.checked ? '1' : '0');
      if (box.checked) chatSound('sent', true);
    };
    label.append(box, el('span', '', 'เสียงตอนส่งข้อความ ตอนตอบเสร็จ และตอนขออนุญาต'));
    wrap.append(
      label,
      button('btn ghost', '🔊 ส่ง', () => chatSound('sent', true)),
      button('btn ghost', '🔊 ตอบเสร็จ', () => chatSound('done', true)),
      button('btn ghost', '🔊 ขออนุญาต', () => chatSound('ask', true)),
    );
    return wrap;
  }

  /** The on/off switch for the settings page, with a button to hear it. */
  function soundToggle() {
    const wrap = el('div', 'hstack');
    const label = el('label', 'wcheck');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = soundOn();
    box.onchange = () => {
      M().store.set(SOUND_KEY, box.checked ? '1' : '0');
      if (box.checked) chime(true);
    };
    label.append(box, el('span', '', 'เสียงแจ้งเตือนเมื่อมีการแจ้งเตือนเข้า'));
    wrap.append(label, button('btn ghost', '🔊 ลองฟัง', () => chime(true)));
    return wrap;
  }

  // ---------- bell ----------
  function bell() {
    let node = document.getElementById('nbell');
    if (!node) {
      node = el('button', 'nbell');
      node.id = 'nbell';
      node.type = 'button';
      node.title = 'การแจ้งเตือน';
      node.onclick = () => (open ? close() : show());
      const conn = document.getElementById('conn');
      conn?.after(node);
    }
    node.textContent = '🔔';
    if (unread > 0) node.append(el('span', 'nbadge', unread > 99 ? '99+' : String(unread)));
    return node;
  }

  function close() {
    open = false;
    M().closeOverlay();
  }

  function openItem(item) {
    if (!item.read) M().send({ type: 'notifications-read', ids: [item.id] });
    close();
    if (item.chatId) {
      M().setView?.('chat');
      M().openChat?.(item.chatId);
    }
  }

  function show() {
    open = true;
    M().send({ type: 'push-devices' });
    render(true);
  }

  /** Redraws the panel while it is on screen (it may have been closed by a click outside). */
  function render(force = false) {
    if (!force && !document.querySelector('.npanel')) open = false;
    if (!open) return;
    const dialog = el('div', 'dialog form npanel');
    const head = el('div', 'hstack');
    head.append(el('h3', '', `การแจ้งเตือน${unread ? ` (${unread} ใหม่)` : ''}`));
    if (unread > 0) head.append(button('btn ghost', 'อ่านทั้งหมด', () => M().send({ type: 'notifications-read' })));
    dialog.append(head);
    const list = el('div', 'nlist');
    for (const item of items) {
      const row = button(`nitem${item.read ? '' : ' unread'}`, '', () => openItem(item));
      const text = el('div', 'ntext');
      text.append(el('b', '', item.title), el('span', 'nbody', item.body));
      row.append(el('span', 'nicon', ICONS[item.kind] || '·'), text, el('span', 'faint ntime', M().fmtDate(item.createdAt)));
      list.append(row);
    }
    if (items.length === 0) list.append(el('div', 'empty', 'ยังไม่มีการแจ้งเตือน'));
    dialog.append(list, pushSection());
    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'), button('btn ghost', 'ปิด', close));
    dialog.append(foot);
    M().overlay(dialog);
  }

  // ---------- push to this device ----------
  function pushSection() {
    const box = el('div', 'npush');
    box.append(el('h4', '', 'แจ้งเตือนเข้าเครื่องนี้ (แม้ปิดแอปอยู่)'));
    if (!pushState.supported) {
      box.append(
        el(
          'p',
          'hint',
          !window.isSecureContext
            ? 'ต้องเปิดแอปผ่าน https (หรือบนเครื่องนี้ที่ localhost) ถึงจะรับแจ้งเตือนได้'
            : 'เบราว์เซอร์นี้ไม่รองรับ · บน iPhone: กด แชร์ → "เพิ่มลงหน้าจอโฮม" แล้วเปิดแอปจากไอคอนนั้น (iOS 16.4 ขึ้นไป)',
        ),
      );
    } else if (pushState.subscribed) {
      const row = el('div', 'hstack');
      row.append(
        el('span', 'pill ok', 'เปิดอยู่ ✓'),
        button('btn ghost', 'ส่งทดสอบ', () => M().send({ type: 'push-test' })),
        button('btn ghost', 'ปิดที่เครื่องนี้', () => disablePush()),
      );
      box.append(row);
    } else {
      box.append(button('btn pri', pushState.busy ? 'กำลังเปิด…' : 'เปิดแจ้งเตือนเครื่องนี้', () => enablePush()));
      if (Notification.permission === 'denied') box.append(el('p', 'hint badtxt', 'เบราว์เซอร์บล็อกการแจ้งเตือนของเว็บนี้ไว้ — เปิดอนุญาตในการตั้งค่าเว็บไซต์ของเบราว์เซอร์ก่อน'));
    }
    if (pushState.error) box.append(el('p', 'hint badtxt', pushState.error));
    if (devices.length > 0) {
      box.append(el('p', 'hint', `เครื่องที่รับแจ้งเตือน (${devices.length})`));
      for (const device of devices) {
        const row = el('div', 'hstack ndevice');
        const mine = device.endpoint === pushState.endpoint;
        row.append(
          el('b', '', device.label || 'อุปกรณ์'),
          el('span', 'faint', `${device.service}${mine ? ' · เครื่องนี้' : ''}${device.lastOkAt ? ` · ส่งถึงล่าสุด ${M().fmtDate(device.lastOkAt)}` : ''}`),
          button('btn ghost', 'ลบ', () => M().send({ type: 'push-unsubscribe', endpoint: device.endpoint }), 'เลิกส่งแจ้งเตือนไปเครื่องนี้'),
        );
        box.append(row);
      }
    }
    return box;
  }

  function deviceLabel() {
    const agent = navigator.userAgent;
    const os = /Android/i.test(agent) ? 'Android' : /iPhone|iPad/i.test(agent) ? 'iPhone/iPad' : /Windows/i.test(agent) ? 'Windows' : /Mac/i.test(agent) ? 'Mac' : 'Linux';
    const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Firefox\//.test(agent) ? 'Firefox' : /Safari\//.test(agent) ? 'Safari' : 'Browser';
    return `${os} · ${browser}`;
  }

  const keyBytes = (base64url) => {
    const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  };

  function serverKey() {
    return new Promise((resolve, reject) => {
      keyWaiter = resolve;
      M().send({ type: 'push-key' });
      setTimeout(() => reject(new Error('เซิร์ฟเวอร์ไม่ตอบ')), 10_000);
    });
  }

  async function registration() {
    return navigator.serviceWorker.register('/sw.js');
  }

  async function enablePush() {
    if (pushState.busy) return;
    pushState = { ...pushState, busy: true, error: '' };
    render();
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('ไม่ได้รับอนุญาตให้แจ้งเตือน');
      const reg = await registration();
      await navigator.serviceWorker.ready;
      const key = await serverKey();
      let subscription = await reg.pushManager.getSubscription();
      if (!subscription) subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      M().send({ type: 'push-subscribe', subscription: subscription.toJSON(), label: deviceLabel() });
      pushState = { supported: true, subscribed: true, endpoint: subscription.endpoint, busy: false, error: '' };
    } catch (error) {
      pushState = { ...pushState, busy: false, error: `เปิดไม่สำเร็จ: ${error.message || error}` };
    }
    render();
  }

  async function disablePush() {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      const subscription = await reg?.pushManager.getSubscription();
      if (subscription) {
        M().send({ type: 'push-unsubscribe', endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
    } catch {
      // nothing to undo
    }
    pushState = { ...pushState, subscribed: false, endpoint: null };
    render();
  }

  async function checkPush() {
    pushState.supported = pushSupported();
    if (!pushState.supported) return;
    try {
      const reg = await registration();
      const subscription = await reg.pushManager.getSubscription();
      pushState.subscribed = Boolean(subscription);
      pushState.endpoint = subscription?.endpoint ?? null;
      // A subscription the server lost (or another key) is sent again.
      if (subscription) M().send({ type: 'push-subscribe', subscription: subscription.toJSON(), label: deviceLabel() });
    } catch (error) {
      // The APIs exist but this browser refused (embedded view, blocked site data…): say why.
      pushState.error = `ลงทะเบียนตัวรับแจ้งเตือนไม่ได้: ${error.message || error}`;
    }
  }

  // ---------- wiring ----------
  function onConnect() {
    bell();
    M().send({ type: 'notifications-list' });
    void checkPush();
  }

  function onMessage(message) {
    switch (message.type) {
      case 'notifications':
        items = message.items || [];
        unread = message.unread || 0;
        bell();
        render();
        break;
      case 'notification':
        if (message.notification.id) {
          items = [{ ...message.notification, createdAt: new Date().toISOString(), read: false }, ...items].slice(0, 50);
          unread++;
          bell();
          render();
          chime();
        }
        break;
      case 'push-key':
        keyWaiter?.(message.publicKey);
        keyWaiter = null;
        break;
      case 'push-devices':
        devices = message.devices || [];
        if (typeof message.tested === 'number') M().toast(message.tested > 0 ? `ส่งทดสอบแล้ว (${message.tested} เครื่อง)` : 'ส่งไม่ถึงเครื่องไหน', message.tested > 0 ? 'ดูที่การแจ้งเตือนของระบบ' : 'ลองปิดแล้วเปิดแจ้งเตือนใหม่', message.tested === 0);
        render();
        break;
    }
  }

  // Tapping a push opens its chat: from the service worker, or from the start URL.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'open-notification') openItem({ id: event.data.id, chatId: event.data.chatId, read: !event.data.id });
    });
  }
  const params = new URLSearchParams(location.search);
  if (params.get('n') || params.get('chat')) {
    const pending = { id: Number(params.get('n')) || 0, chatId: Number(params.get('chat')) || 0 };
    history.replaceState(null, '', location.pathname + location.hash);
    setTimeout(() => openItem({ id: pending.id, chatId: pending.chatId || undefined, read: !pending.id }), 1500);
  }

  window.MimiHooks = window.MimiHooks || {};
  /** Signing out: this device stops getting this account's push notifications. */
  async function forgetDevice() {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration('/');
    const subscription = await reg?.pushManager.getSubscription();
    if (!subscription) return;
    M().send({ type: 'push-unsubscribe', endpoint: subscription.endpoint });
    await subscription.unsubscribe();
  }
  window.MimiHooks.notify = { onConnect, onMessage, bell, forgetDevice, chime, soundToggle, chatSound, chatSoundToggle };
})();
