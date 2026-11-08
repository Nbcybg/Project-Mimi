// Hub → บัญชี → กล่องเมล: the mailboxes the core reads (Gmail / Outlook of the connected
// OAuth accounts, plus any IMAP / POP3 mailbox with optional SMTP sending). Mail tools and the
// mail trigger pick a mailbox from here; every new message also raises a notification.
// Passwords are typed here but stored only in the machine's vault: the account list sent back
// never contains them.
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

  function field(label, input, hint) {
    const box = M().labelled(label, input);
    if (hint) box.append(el('p', 'hint', hint));
    return box;
  }

  /** The mailbox popup; `entry` null adds one. */
  function openEditor(entry) {
    editing = entry ? entry.id : null;
    addingKind = entry ? entry.kind : 'imap';
    testResult = null;
    const popup = window.MimiKit.modal({ title: '', size: 'wide', onClose: () => {
      if (editorPopup === popup) editorPopup = null;
    } });
    editorPopup = popup;
    paintEditor();
  }
  let editorPopup = null;

  function paintEditor() {
    if (!editorPopup) return;
    const popup = editorPopup;
    const entry = editing ? find(editing) : null;
    const incoming = entry && (entry.kind === 'imap' || entry.kind === 'pop3') ? entry.incoming : {};
    const outgoing = entry && (entry.kind === 'imap' || entry.kind === 'pop3') ? entry.outgoing || {} : {};
    const panel = el('div');
    popup.setTitle(entry ? `กล่องเมล: ${entry.name || entry.id}` : 'เพิ่มกล่องเมล');

    const kind = select([['google', KIND_LABELS.google], ['microsoft', KIND_LABELS.microsoft], ['imap', KIND_LABELS.imap], ['pop3', KIND_LABELS.pop3]], entry ? entry.kind : addingKind);
    kind.disabled = Boolean(entry);
    kind.addEventListener('change', () => {
      addingKind = kind.value;
    });
    panel.append(field('บริการ', kind, 'Gmail / Outlook ใช้บัญชี Google / Microsoft ด้านบน · IMAP / POP3 ใส่ข้อมูลเซิร์ฟเวอร์เอง (ใช้ได้กับทุกผู้ให้บริการ)'));

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
    // How the notifier reads the box; a workflow's mail trigger sets its own search per node.
    const fetching = el('details');
    const fetchGrid = el('div', 'grid2');
    fetchGrid.append(
      field('โฟลเดอร์ (IMAP)', folder),
      field('คำค้นในเมล', query2),
      field('ย้อนหลัง (วัน, 0 = ไม่จำกัด)', since),
      field('จำนวนสูงสุดต่อครั้ง', maxMessages),
      field('ตรวจทุก (นาที, 0 = รอบรวม)', poll),
      field('timeout (ms)', timeout),
    );
    fetching.append(el('summary', 'hint', 'ตัวเลือกการดึงเมล (ขั้นสูง — ปกติไม่ต้องแก้)'), fetchGrid, reject.wrap, unseen.wrap, markRead.wrap, deleteAfter.wrap);
    incomingBox.append(el('h4', '', 'รับเมล (incoming)'), grid, fetching);
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
    const sending = el('details');
    if (outgoing.host) sending.open = true;
    sending.append(
      el('summary', 'hint', 'ส่งเมล (SMTP) — เปิดเมื่อต้องการให้ Mimi ส่งเมลจากกล่องนี้'),
      el('p', 'hint', 'เว้น host ว่างถ้าไม่ต้องส่ง · รหัสผ่านเก็บใน vault แยกจากไฟล์ตั้งค่า'),
      smtpGrid,
      smtpReject.wrap,
      samePassword.wrap,
    );
    smtp.append(sending);

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

    const save = () => {
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
        pendingSave = { id: id.value.trim(), popup };
      };
    popup.setBody([panel]);
    const left = [];
    if (entry) left.push(button('btn danger', 'ลบ', () => removeAccount(entry, popup)));
    if (entry && isLocal) {
      left.push(button('btn ghost', testResult && testResult.pending ? 'กำลังทดสอบ…' : 'ทดสอบการเชื่อมต่อ', () => {
        testResult = { id: entry.id, pending: true };
        M().send({ type: 'mail-account-test', id: entry.id });
        paintEditor();
      }));
      if (testResult && testResult.id === entry.id && !testResult.pending) {
        panel.append(el('p', `hint${testResult.ok === false ? ' badtxt' : ''}`, testResult.ok === false ? `ทดสอบไม่ผ่าน: ${testResult.error || ''}` : testResult.message || 'เชื่อมต่อได้ ✓'));
      }
    }
    popup.setFoot([button('btn ghost', 'ยกเลิก', () => popup.close()), button('btn pri', entry ? 'บันทึก' : 'เพิ่ม', save)], left);
    popup.dirty = false;
  }

  async function removeAccount(account, popup) {
    if (!(await window.MimiKit.confirmDelete(`กล่องเมล "${account.name || account.id}"`, 'รหัสผ่านของกล่องนี้จะถูกลบด้วย · workflow ที่อ่านกล่องนี้จะใช้กล่องเริ่มต้นแทน'))) return;
    M().send({ type: 'mail-watch-delete', id: account.id });
    popup?.done();
  }

  /** The mailbox cards of Hub → บัญชี. */
  function section() {
    const Kit = window.MimiKit;
    if (!M().state.mailAccountsRequested) {
      M().state.mailAccountsRequested = true;
      M().send({ type: 'mail-watch' });
    }
    const block = el('div', 'mk-block');
    block.append(Kit.section('กล่องเมล', `IMAP / POP3 ใช้ได้กับทุกผู้ให้บริการ (ส่งผ่าน SMTP ได้) · Gmail / Outlook ใช้บัญชีด้านบน · ใช้กับเครื่องมือเมลและ trigger "อีเมลใหม่"${lastCheckedAt ? ` · ตรวจล่าสุด ${M().fmtDate(lastCheckedAt)}` : ''}`, [
      button('btn', '+ เพิ่มกล่องเมล', () => openEditor(null)),
      accounts.length ? button('btn ghost', 'ตรวจเมลเดี๋ยวนี้', () => M().send({ type: 'mail-watch-check' }), 'ค้นหาเมลใหม่ทันที (ปกติรอรอบอัตโนมัติ)') : null,
    ]));
    block.append(Kit.grid(accounts.map((account) => {
      const local = account.kind === 'imap' || account.kind === 'pop3';
      return Kit.card({
        title: `${account.name || account.id}${account.default ? ' ★' : ''}`,
        sub: `${KIND_LABELS[account.kind] || account.kind}${account.outgoing ? ' · ส่งได้ (SMTP)' : ''}`,
        icon: '✉',
        state: account.connected === false ? ['todo', 'ยังไม่ครบ'] : ['ok', 'พร้อมใช้'],
        desc: local ? `${account.email || account.incoming.user} · ${account.incoming.host}` : account.email || account.query || 'ทุกข้อความที่ยังไม่เปิดอ่าน',
        onOpen: () => openEditor(account),
        actions: [{ label: 'แก้ไข', onClick: () => openEditor(account) }, { label: 'ลบ', danger: true, onClick: () => removeAccount(account) }],
      });
    }), 'ยังไม่มีกล่องเมล — กด "+ เพิ่มกล่องเมล"'));
    return block;
  }

  function rerender() {
    if (M().state.view === 'hub' && M().ui.hubTab === 'accounts') M().renderHub();
  }

  function onMessage(message) {
    if (message.type !== 'mail-watch') return;
    accounts = message.accounts || [];
    lastCheckedAt = message.lastCheckedAt;
    if (M().state.settings) M().state.settings.mailAccounts = accounts;
    if (message.checked) M().toast('ตรวจเมลแล้ว ✓', `พบใหม่ ${message.checked.found} ฉบับ`);
    if (message.test) {
      testResult = message.test;
      paintEditor();
    } else if (pendingSave && accounts.some((account) => account.id === pendingSave.id)) {
      pendingSave.popup.done();
      M().toast('บันทึกกล่องเมลแล้ว ✓');
      pendingSave = null;
    }
    rerender();
  }
  let pendingSave = null;

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.mail = { section, onMessage, openEditor };
})();
