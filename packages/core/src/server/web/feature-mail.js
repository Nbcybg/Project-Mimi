// Hub → Mail push: the accounts the core watches for new mail (Gmail / Outlook of the
// connected OAuth accounts, plus any IMAP / POP3 mailbox). Every new message raises a
// notification — on the phone through the app's own polling, in the browser through push.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  let accounts = [];
  let lastCheckedAt = null;

  const KIND_LABELS = { google: 'Gmail (บัญชี Google ที่เชื่อมต่อ)', microsoft: 'Outlook (บัญชี Microsoft ที่เชื่อมต่อ)', imap: 'IMAP', pop3: 'POP3' };

  function row(account) {
    const line = el('div', 'hstack ndevice');
    const info = el('div', 'one');
    info.append(
      el('b', '', KIND_LABELS[account.kind] ?? account.kind),
      el('small', '', account.kind === 'imap' || account.kind === 'pop3' ? `${account.user} · ${account.host}:${account.port}` : account.query || '(ทุกข้อความยังไม่เปิดอ่าน)'),
    );
    line.append(
      info,
      button('btn ghost', 'ลบ', () => M().send({ type: 'mail-watch-delete', id: account.id }), 'เลิกดูกล่องนี้'),
    );
    return line;
  }

  function addForm() {
    const panel = el('div', 'panel form');
    panel.append(el('h3', '', '+ เพิ่มกล่องเมล'));
    const kind = el('select');
    for (const [value, label] of [['google', KIND_LABELS.google], ['microsoft', KIND_LABELS.microsoft], ['imap', KIND_LABELS.imap], ['pop3', KIND_LABELS.pop3]]) {
      const option = el('option', '', label);
      option.value = value;
      kind.append(option);
    }
    const host = M().textInput('', 'imap.example.com');
    const tls = el('select');
    for (const [value, label] of [['true', 'SSL/TLS (แนะนำ)'], ['false', 'ไม่เข้ารหัส']]) {
      const option = el('option', '', label);
      option.value = value;
      tls.append(option);
    }
    const user = M().textInput('', 'you@example.com');
    const password = M().textInput('', 'รหัสผ่าน (เก็บในเครื่องนี้เท่านั้น)', 'password');
    const query = M().textInput('', 'ไม่บังคับ · เช่น is:unread newer_than:2d (Gmail search)');
    const grid = el('div', 'grid2');
    grid.append(M().labelled('ชนิด', kind), M().labelled('โฮสต์', host), M().labelled('การเข้ารหัส', tls), M().labelled('ผู้ใช้', user), M().labelled('รหัสผ่าน', password), M().labelled('คำค้น', query));
    const hide = () => {
      const isMail = kind.value === 'imap' || kind.value === 'pop3';
      for (const field of [host, tls, user, password]) field.closest('div').hidden = !isMail;
      query.closest('div').hidden = kind.value === 'pop3';
    };
    kind.onchange = hide;
    hide();
    const foot = el('div', 'foot');
    foot.append(
      button('btn pri', '+ เพิ่ม', () => {
        const id = `mail-${Date.now().toString(36)}`;
        const account =
          kind.value === 'google' ? { id, kind: 'google', query: query.value.trim() }
          : kind.value === 'microsoft' ? { id, kind: 'microsoft', query: query.value.trim() }
          : { id, kind: kind.value, host: host.value.trim(), port: 0, tls: tls.value !== 'false', user: user.value.trim(), ...(query.value.trim() ? { query: query.value.trim() } : {}) };
        if ((account.kind === 'imap' || account.kind === 'pop3') && (!account.host || !account.user)) return M().toast('กรอกไม่ครบ', 'ต้องมีโฮสต์และผู้ใช้', true);
        M().send({ type: 'mail-watch-save', account, ...(password.value ? { password: password.value } : {}) });
      }),
    );
    panel.append(grid, foot);
    return panel;
  }

  function render() {
    const wrap = el('div', 'stackv');
    const list = el('div', 'panel form');
    list.append(
      el('h3', '', 'กล่องเมลที่กำลังดู'),
      el('p', 'hint', 'ระบบตรวจทุก 10 นาที (ตั้ง MIMI_MAIL_WATCH_MINUTES ได้) เมื่อมีเมลใหม่จะแจ้งเตือนเข้าเครื่อง — Gmail/Outlook ใช้บัญชีที่เชื่อมต่อไว้แล้ว ส่วน IMAP/POP3 ใส่โฮสต์กับรหัสผ่านเอง'),
    );
    const rows = el('div');
    for (const account of accounts) rows.append(row(account));
    if (accounts.length === 0) rows.append(el('p', 'hint', 'ยังไม่มีกล่อง — เพิ่ม Gmail / Outlook / IMAP / POP3 ด้านล่าง'));
    list.append(rows);
    if (lastCheckedAt) list.append(el('p', 'hint', `ตรวจล่าสุด: ${M().fmtDate(lastCheckedAt)}`));
    list.append(button('btn', 'ตรวจเดี๋ยวนี้', () => M().send({ type: 'mail-watch-check' }), 'ค้นหาเมลใหม่ทันที (ปกติรอรอบอัตโนมัติ)'));
    wrap.append(list, addForm());
    return wrap;
  }

  function onMessage(message) {
    if (message.type !== 'mail-watch') return;
    accounts = message.accounts || [];
    lastCheckedAt = message.lastCheckedAt;
    if (message.checked) {
      M().toast(`ตรวจเมลแล้ว ✓`, `พบใหม่ ${message.checked.found} ฉบับ`);
    }
    if (M().state.view === 'hub' && M().ui.hubTab === 'mail') M().renderHub();
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.mail = { render, onMessage };
})();
