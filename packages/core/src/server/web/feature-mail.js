// Hub → Mail: the accounts the core watches for new mail (Gmail / Outlook of the connected
// OAuth accounts, plus any IMAP / POP3 mailbox with optional SMTP sending). Every new message
// raises a notification. Passwords are typed here but stored only in the machine's vault:
// the account list sent back never contains them.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  let accounts = [];
  let lastCheckedAt = null;
  let editing = null; // account id, or null for new
  let addingKind = 'imap';
  let testResult = null;

  const KIND_LABELS = { google: 'Gmail (บัญชี Google ที่เชื่อมต่อ)', microsoft: 'Outlook (บัญชี Microsoft ที่เชื่อมต่อ)', imap: 'IMAP', pop3: 'POP3' };
  const SECURITY = [['tls', 'SSL/TLS (แนะนำ)'], ['starttls', 'STARTTLS'], ['none', 'ไม่เข้ารหัส']];

  const find = (id) => accounts.find((entry) => entry.id === id) || null;
  const hasPassword = (account) => Boolean(account && (account.hasPassword || account.hasOutgoingPassword));

  function checkbox(label) {
    const wrap = el('label', 'wcheck');
    const box = el('input');
    box.type = 'checkbox';
    wrap.append(box, el('span', '', label));
    return { box, wrap };
  }

  function select(options, value) {
    const node = el('select');
    for (const [key, label] of options) {
      const option = el('option', '', label);
      option.value = key;
      node.append(option);
    }
    node.value = value;
    return node;
  }

  function row(account) {
    const line = el('div', 'hstack ndevice');
    const info = el('div', 'one');
    const where =
      account.kind === 'imap' || account.kind === 'pop3'
        ? `${account.email || account.incoming.user} · ${account.incoming.host}:${account.incoming.port || (account.incoming.security === 'tls' ? account.kind === 'pop3' ? 995 : 993 : 143)}`
        : account.email || account.query || '(ทุกข้อความยังไม่เปิดอ่าน)';
    const status = `${account.connected === false ? '○ ยังไม่ครบ' : '● พร้อมใช้'}${account.outgoing ? ' · SMTP' : ''}${account.default ? ' ★' : ''}`;
    info.append(el('b', '', `${account.name || account.id} · ${KIND_LABELS[account.kind] || account.kind}`), el('small', '', `${where} · ${status}`));
    const actions = el('div', 'hstack');
    actions.append(button('btn ghost', 'แก้ไข', () => {
      editing = account.id;
      addingKind = account.kind;
      testResult = null;
      rerender();
    }));
    actions.append(button('btn ghost', 'ลบ', () => {
      if (confirm(`ลบ “${account.name || account.id}”? รหัสผ่านของบัญชีนี้จะถูกลบด้วย`)) M().send({ type: 'mail-watch-delete', id: account.id });
    }, 'เลิกดู / เลิกใช้กล่องนี้'));
    line.append(info, actions);
    return line;
  }

  function field(label, input, hint) {
    const box = M().labelled(label, input);
    if (hint) box.append(el('p', 'hint', hint));
    return box;
  }

  function editor() {
    const entry = editing ? find(editing) : null;
    const incoming = entry && (entry.kind === 'imap' || entry.kind === 'pop3') ? entry.incoming : {};
    const outgoing = entry && (entry.kind === 'imap' || entry.kind === 'pop3') ? entry.outgoing || {} : {};
    const panel = el('div', 'panel form');
    panel.append(el('h3', '', entry ? `แก้ไข ${entry.name || entry.id}` : '+ เพิ่มกล่องเมล / mail provider'));

    const kind = select([['google', KIND_LABELS.google], ['microsoft', KIND_LABELS.microsoft], ['imap', KIND_LABELS.imap], ['pop3', KIND_LABELS.pop3]], entry ? entry.kind : addingKind);
    kind.disabled = Boolean(entry);
    panel.append(field('บริการ', kind, 'Gmail / Outlook ใช้บัญชี OAuth ที่ Hub → บัญชี · IMAP / POP3 ใส่ข้อมูลเซิร์ฟเวอร์เอง'));

    const id = M().textInput(entry ? entry.id : `mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, 'mail-work');
    id.disabled = Boolean(entry);
    const name = M().textInput(entry ? entry.name || '' : '', 'ชื่อเล่น เช่น เมลงาน');
    const email = M().textInput(entry ? entry.email || '' : '', 'you@example.com');
    const isLocal = kind.value === 'imap' || kind.value === 'pop3';
    panel.append(field('id (ใช้ใน workflow)', id), field('ชื่อบัญชี', name), field('อีเมล', email));

    const query = M().textInput(entry ? entry.query || '' : '', 'ไม่บังคับ · เช่น is:unread newer_than:2d (Gmail)');
    panel.append(field('คำค้น', query));

    const grid = el('div', 'grid2');
    const host = M().textInput(incoming.host || '', 'imap.example.com');
    const port = M().textInput(incoming.port ? String(incoming.port) : '0', '0 = ตามชนิด/การเข้ารหัส', 'number');
    const security = select(SECURITY, incoming.security || 'tls');
    const reject = checkbox('ตรวจใบรับรอง TLS (แนะนำ)');
    reject.box.checked = incoming.rejectUnauthorized !== false;
    const user = M().textInput(incoming.user || '', 'you@example.com');
    const password = M().textInput('', entry && entry.hasPassword ? 'ตั้งไว้แล้ว ◆ (เว้นว่าง = คงเดิม)' : 'รหัสผ่านหรือ app password', 'password');
    const folder = M().textInput(incoming.folder || 'INBOX', 'INBOX');
    const query2 = M().textInput(incoming.query || '', 'คำในหัวข้อ/ผู้ส่ง/เนื้อหา');
    const unseen = checkbox('เอาเฉพาะที่ยังไม่เปิดอ่าน');
    unseen.box.checked = incoming.unseenOnly === true;
    const since = M().textInput(incoming.sinceDays ? String(incoming.sinceDays) : '0', '7', 'number');
    const maxMessages = M().textInput(incoming.maxMessages ? String(incoming.maxMessages) : '10', '10', 'number');
    const markRead = checkbox('มาร์คอ่านแล้วเมื่อประมวลผล');
    markRead.box.checked = incoming.markRead === true;
    const deleteAfter = checkbox('ลบออกจากเซิร์ฟเวอร์หลังอ่าน (POP3)');
    deleteAfter.box.checked = incoming.deleteAfterFetch === true;
    const poll = M().textInput(incoming.pollMinutes ? String(incoming.pollMinutes) : '0', '0 = ใช้รอบรวม', 'number');
    const timeout = M().textInput(incoming.timeoutMs ? String(incoming.timeoutMs) : '30000', '30000', 'number');

    const incomingBox = el('div');
    incomingBox.append(
      el('h4', '', 'รับเมล (incoming)'),
      grid,
      field('โฟลเดอร์ (IMAP)', folder),
      field('คำค้นในเมล', query2),
      field('ย้อนหลัง (วัน, 0 = ไม่จำกัด)', since),
      field('จำนวนสูงสุดต่อครั้ง', maxMessages),
      field('ตรวจทุก (นาที, 0 = รอบรวม)', poll),
      field('timeout (ms)', timeout),
      reject.wrap,
      unseen.wrap,
      markRead.wrap,
      deleteAfter.wrap,
    );
    grid.append(
      field('โฮสต์', host),
      field('พอร์ต', port),
      field('การเข้ารหัส', security),
      field('ผู้ใช้', user),
      field('รหัสผ่าน', password),
    );

    const smtp = el('div');
    const smtpHost = M().textInput(outgoing.host || '', 'smtp.example.com');
    const smtpPort = M().textInput(outgoing.port ? String(outgoing.port) : '0', '0 = 465/587/25', 'number');
    const smtpSecurity = select(SECURITY, outgoing.security || 'tls');
    const smtpReject = checkbox('ตรวจใบรับรอง TLS');
    smtpReject.box.checked = outgoing.rejectUnauthorized !== false;
    const smtpUser = M().textInput(outgoing.user || '', 'เว้นว่าง = ใช้ผู้ใช้รับเมล');
    const smtpPassword = M().textInput('', entry && entry.hasOutgoingPassword ? 'ตั้งไว้แล้ว ◆ (เว้นว่าง = คงเดิม)' : 'รหัสผ่าน SMTP (ถ้าไม่เหมือนรับเมล)', 'password');
    const samePassword = checkbox('ใช้รหัสผ่านเดียวกับรับเมล');
    samePassword.box.checked = outgoing.useIncomingPassword !== false;
    const fromEmail = M().textInput(outgoing.fromEmail || (entry && entry.email) || '', 'ผู้ส่ง เช่น me@example.com');
    const fromName = M().textInput(outgoing.fromName || '', 'ชื่อที่แสดง');
    const replyTo = M().textInput(outgoing.replyTo || '', 'Reply-To (ไม่บังคับ)');
    const smtpTimeout = M().textInput(outgoing.timeoutMs ? String(outgoing.timeoutMs) : '30000', '30000', 'number');
    const smtpGrid = el('div', 'grid2');
    smtpGrid.append(
      field('SMTP host', smtpHost),
      field('พอร์ต', smtpPort),
      field('การเข้ารหัส', smtpSecurity),
      field('ผู้ใช้ SMTP', smtpUser),
      field('รหัสผ่าน SMTP', smtpPassword),
      field('อีเมลผู้ส่ง', fromEmail),
      field('ชื่อผู้ส่ง', fromName),
      field('Reply-To', replyTo),
      field('timeout (ms)', smtpTimeout),
    );
    smtp.append(
      el('h4', '', 'ส่งเมล (SMTP) — เว้น host ว่างถ้าไม่ต้องส่ง'),
      el('p', 'hint', 'ใช้รหัสผ่านของบัญชีนี้เก็บใน vault แยกจากไฟล์ตั้งค่า · ระบบจะไม่ส่งรหัสกลับมาที่หน้าจอ'),
      smtpGrid,
      smtpReject.wrap,
      samePassword.wrap,
    );

    const isDefault = checkbox('ใช้เป็นบัญชีเริ่มต้นของ Mail');
    isDefault.box.checked = entry ? entry.default === true : accounts.filter((a) => a.kind === 'imap' || a.kind === 'pop3').length === 0;

    const hideKinds = () => {
      const local = kind.value === 'imap' || kind.value === 'pop3';
      incomingBox.hidden = !local;
      smtp.hidden = !local;
      id.closest('div').hidden = false;
      name.closest('div').hidden = false;
      email.closest('div').hidden = false;
      isDefault.wrap.hidden = !local;
      query.closest('div').hidden = kind.value === 'pop3';
    };
    kind.onchange = hideKinds;
    hideKinds();
    panel.append(query.closest('div'), incomingBox, smtp, isDefault.wrap);
    if (!isLocal) {
      incomingBox.hidden = true;
      smtp.hidden = true;
    }

    const foot = el('div', 'foot');
    foot.append(
      button('btn pri', entry ? 'บันทึก' : '+ เพิ่ม', () => {
        if (!name.value.trim()) return M().toast('กรอกไม่ครบ', 'ต้องมีชื่อบัญชี', true);
        const local = kind.value === 'imap' || kind.value === 'pop3';
        if (local && (!host.value.trim() || !user.value.trim())) return M().toast('กรอกไม่ครบ', 'ต้องมีโฮสต์และผู้ใช้', true);
        const account =
          local
            ? {
                id: id.value.trim(),
                kind: kind.value,
                name: name.value.trim(),
                ...(email.value.trim() ? { email: email.value.trim() } : {}),
                default: isDefault.box.checked,
                incoming: {
                  protocol: kind.value,
                  host: host.value.trim(),
                  port: Number(port.value) || 0,
                  security: security.value,
                  rejectUnauthorized: reject.box.checked,
                  user: user.value.trim(),
                  ...(folder.value.trim() ? { folder: folder.value.trim() } : {}),
                  ...(query2.value.trim() ? { query: query2.value.trim() } : {}),
                  unseenOnly: unseen.box.checked,
                  sinceDays: Number(since.value) || 0,
                  maxMessages: Number(maxMessages.value) || 10,
                  markRead: markRead.box.checked,
                  deleteAfterFetch: deleteAfter.box.checked,
                  pollMinutes: Number(poll.value) || 0,
                  timeoutMs: Number(timeout.value) || 30000,
                },
                ...(smtpHost.value.trim()
                  ? {
                      outgoing: {
                        host: smtpHost.value.trim(),
                        port: Number(smtpPort.value) || 0,
                        security: smtpSecurity.value,
                        rejectUnauthorized: smtpReject.box.checked,
                        ...(smtpUser.value.trim() ? { user: smtpUser.value.trim() } : {}),
                        useIncomingPassword: samePassword.box.checked,
                        fromEmail: fromEmail.value.trim() || email.value.trim() || user.value.trim(),
                        ...(fromName.value.trim() ? { fromName: fromName.value.trim() } : {}),
                        ...(replyTo.value.trim() ? { replyTo: replyTo.value.trim() } : {}),
                        timeoutMs: Number(smtpTimeout.value) || 30000,
                      },
                    }
                  : {}),
              }
            : {
                id: id.value.trim(),
                kind: kind.value,
                name: name.value.trim(),
                ...(email.value.trim() ? { email: email.value.trim() } : {}),
                query: query.value.trim(),
              };
        M().send({
          type: 'mail-watch-save',
          account,
          ...(local && password.value ? { password: password.value } : {}),
          ...(local && smtpPassword.value ? { smtpPassword: smtpPassword.value } : {}),
        });
        editing = null;
      }),
      button('btn ghost', 'ยกเลิก', () => {
        editing = null;
        testResult = null;
        rerender();
      }),
    );
    panel.append(foot);
    if (entry && isLocal) {
      panel.append(button('btn', 'ทดสอบการเชื่อมต่อ', () => {
        testResult = { id: entry.id, pending: true };
        M().send({ type: 'mail-account-test', id: entry.id });
        rerender();
      }));
      if (testResult && testResult.id === entry.id) {
        panel.append(el('p', `hint${testResult.ok === false ? ' badtxt' : ''}`, testResult.pending ? 'กำลังทดสอบ…' : testResult.ok === false ? `ไม่ผ่าน: ${testResult.error || ''}` : testResult.message || 'เชื่อมต่อได้ ✓'));
      }
    }
    return panel;
  }

  function render() {
    if (!M().state.settings || !M().state.settings.mailAccounts) M().send({ type: 'settings-get' });
    if (!M().state.mailAccountsRequested) {
      M().state.mailAccountsRequested = true;
      M().send({ type: 'mail-watch' });
    }
    const wrap = el('div', 'stackv');
    const list = el('div', 'panel form');
    list.append(
      el('h3', '', 'กล่องเมล / Mail providers'),
      el('p', 'hint', 'IMAP / POP3 ใช้ได้กับทุกผู้ให้บริการ และส่งผ่าน SMTP ได้ · บัญชีเหล่านี้ใช้ได้ในเครื่องมือ imap_*, pop3_*, smtp_* และ trigger อีเมล · รหัสผ่านเก็บใน vault ของเครื่องนี้เท่านั้น'),
    );
    const rows = el('div');
    for (const account of accounts) rows.append(row(account));
    if (accounts.length === 0) rows.append(el('p', 'hint', 'ยังไม่มีกล่อง — เพิ่ม Gmail / Outlook / IMAP / POP3 ด้านล่าง'));
    list.append(rows);
    if (lastCheckedAt) list.append(el('p', 'hint', `ตรวจล่าสุด: ${M().fmtDate(lastCheckedAt)}`));
    list.append(button('btn', 'ตรวจเดี๋ยวนี้', () => M().send({ type: 'mail-watch-check' }), 'ค้นหาเมลใหม่ทันที (ปกติรอรอบอัตโนมัติ)'));
    wrap.append(list, editor());
    return wrap;
  }

  function rerender() {
    if (M().state.view === 'hub' && M().ui.hubTab === 'mail') M().renderHub();
  }

  function onMessage(message) {
    if (message.type !== 'mail-watch') return;
    accounts = message.accounts || [];
    lastCheckedAt = message.lastCheckedAt;
    if (M().state.settings) M().state.settings.mailAccounts = accounts;
    if (message.checked) M().toast('ตรวจเมลแล้ว ✓', `พบใหม่ ${message.checked.found} ฉบับ`);
    if (message.test) testResult = message.test;
    rerender();
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.mail = { render, onMessage };
})();
