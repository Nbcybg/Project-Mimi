// Notifications through the app only: an inbox the server keeps (so nothing is lost
// when a device is off or gone) behind the 🔔 button, and push messages to every
// browser that turned them on, delivered by the service worker (sw.js) even while
// the app is closed.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const ICONS = { reminder: '⏰', approval: '✋', 'task-result': '📋', info: '·' };
  let items = [];
  let unread = 0;
  let devices = [];
  let open = false;
  /** Waiting for the server's VAPID key (push-key reply). */
  let keyWaiter = null;
  let pushState = { supported: false, subscribed: false, endpoint: null, busy: false, error: '' };

  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;

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
  window.MimiHooks.notify = { onConnect, onMessage, bell };
})();
