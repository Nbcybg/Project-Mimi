// Settings → โปรไฟล์ของฉัน: key/value facts about the user. Each field is shared with
// every agent or only with the agents ticked; an agent's prompt gets exactly the
// fields it may see. Stored in user/profile.json by the core.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  /** Common fields offered as one-click rows. */
  const TEMPLATES = [
    ['full_name', 'ชื่อ-นามสกุล'],
    ['nickname', 'ชื่อเล่น'],
    ['call_me', 'ให้เรียกฉันว่า'],
    ['birthday', 'วันเกิด'],
    ['occupation', 'อาชีพ'],
    ['workplace', 'ที่ทำงาน'],
    ['home_address', 'ที่อยู่บ้าน'],
    ['city', 'จังหวัด / เมือง'],
    ['phone', 'เบอร์โทร'],
    ['email', 'อีเมล'],
    ['family', 'ครอบครัว'],
    ['language', 'ภาษาที่ใช้คุย'],
  ];

  /** Working copy of the fields; null until the core sent the profile. */
  let rows = null;
  let dirty = false;
  let previewAgent = '';
  let requested = false;

  const agents = () => (M().state.agents || []).map((agent) => agent.name);
  const nameOf = (name) => M().nameOf(name);

  function rerender() {
    if (M().state.view === 'settings') M().renderSettings();
  }

  /** An ASCII key from the label, or field_N for Thai labels. */
  function keyFor(label) {
    const slug = String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    let key = /^[a-z]/.test(slug) ? slug : '';
    if (!key) {
      let n = 1;
      while (rows.some((row) => row.key === `field_${n}`)) n++;
      key = `field_${n}`;
    }
    let unique = key;
    for (let n = 2; rows.some((row) => row.key === unique); n++) unique = `${key}_${n}`;
    return unique;
  }

  function visibilityControl(row) {
    const box = el('div', 'pfvis');
    const mode = el('select');
    for (const [value, text] of [['*', 'agent ทุกตัวเห็น'], ['some', 'เฉพาะ agent ที่เลือก']]) {
      const option = el('option', '', text);
      option.value = value;
      mode.append(option);
    }
    mode.value = row.visibleTo === '*' ? '*' : 'some';
    mode.onchange = () => {
      row.visibleTo = mode.value === '*' ? '*' : [];
      dirty = true;
      rerender();
    };
    box.append(mode);
    if (row.visibleTo !== '*') {
      const list = el('div', 'hstack pfagents');
      for (const name of agents()) {
        const label = el('label', 'wcheck');
        const check = el('input');
        check.type = 'checkbox';
        check.checked = row.visibleTo.includes(name);
        check.onchange = () => {
          row.visibleTo = check.checked ? [...row.visibleTo, name] : row.visibleTo.filter((entry) => entry !== name);
          dirty = true;
          renderPreviewOnly();
        };
        label.append(check, el('span', '', nameOf(name)));
        list.append(label);
      }
      if (agents().length === 0) list.append(el('span', 'faint', 'ยังไม่มี agent'));
      if (row.visibleTo.length === 0) list.append(el('span', 'faint', '(ยังไม่มีใครเห็น)'));
      box.append(list);
    }
    return box;
  }

  /** A value box as tall as its text (up to a limit). */
  function grow(area) {
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight + 2, 160)}px`;
  }

  function fieldRow(row, index) {
    const wrap = el('div', 'pfrow');
    const label = M().textInput(row.label, 'ชื่อช่อง เช่น ที่อยู่บ้าน');
    label.oninput = () => {
      row.label = label.value;
      dirty = true;
      renderPreviewOnly();
    };
    const key = M().textInput(row.key, 'key (a-z 0-9 _)');
    key.className = 'pfkey';
    key.oninput = () => {
      row.key = key.value.trim().toLowerCase();
      dirty = true;
    };
    const value = el('textarea', 'pfvalue');
    value.rows = 1;
    value.value = row.value;
    value.placeholder = 'ค่า';
    value.oninput = () => {
      row.value = value.value;
      dirty = true;
      grow(value);
      renderPreviewOnly();
    };
    const remove = button('btn ghost', '✕', () => {
      rows.splice(index, 1);
      dirty = true;
      rerender();
    }, 'ลบช่องนี้');
    const top = el('div', 'pftop');
    top.append(label, key, remove);
    wrap.append(top, value, visibilityControl(row));
    requestAnimationFrame(() => grow(value));
    return wrap;
  }

  /** What one agent's prompt would get, as the core renders it. */
  function previewText(agent) {
    const lines = rows
      .filter((row) => String(row.value).trim() && (row.visibleTo === '*' || row.visibleTo.includes(agent)))
      .map((row) => `- ${row.label || row.key} (${row.key}): ${String(row.value).trim().replace(/\s*\n\s*/g, ' / ')}`);
    return lines.length ? lines.join('\n') : '(agent ตัวนี้ไม่เห็นข้อมูลโปรไฟล์เลย)';
  }

  function renderPreviewOnly() {
    const pre = document.getElementById('pfPreview');
    if (pre && previewAgent) pre.textContent = previewText(previewAgent);
  }

  function render(panel) {
    if (!requested) {
      requested = true;
      M().send({ type: 'profile-get' });
    }
    panel.append(el('p', 'hint', 'ข้อมูลที่ agent ใช้รู้จักคุณ เลือกได้ว่า agent ตัวไหนเห็นช่องไหน (เช่น เลขบัญชีให้เห็นเฉพาะฝ่ายการเงิน) · agent จะได้เฉพาะช่องที่เห็น ใส่ไว้ในทุกข้อความ · เก็บในไฟล์ user/profile.json'));
    if (!rows) {
      panel.append(el('p', 'hint', 'กำลังโหลด…'));
      return;
    }
    const missing = TEMPLATES.filter(([key]) => !rows.some((row) => row.key === key));
    if (missing.length > 0) {
      const quick = el('div', 'hstack');
      quick.append(el('span', 'waddlabel', 'เพิ่มเร็ว'));
      for (const [key, label] of missing) {
        quick.append(button('chip', `+ ${label}`, () => {
          rows.push({ key, label, value: '', visibleTo: '*' });
          dirty = true;
          rerender();
        }));
      }
      panel.append(quick);
    }
    const list = el('div', 'pflist');
    rows.forEach((row, index) => list.append(fieldRow(row, index)));
    if (rows.length === 0) list.append(el('div', 'empty', 'ยังไม่มีข้อมูล — กด "เพิ่มเร็ว" หรือ "+ เพิ่มช่อง"'));
    panel.append(list);

    const foot = el('div', 'hstack');
    foot.style.marginTop = '8px';
    foot.append(
      button('btn ghost', '+ เพิ่มช่อง', () => {
        rows.push({ key: keyFor(''), label: '', value: '', visibleTo: '*' });
        dirty = true;
        rerender();
      }),
      button('btn pri', dirty ? 'บันทึกโปรไฟล์ •' : 'บันทึกโปรไฟล์', () => {
        for (const row of rows) if (!row.key && (row.label || row.value)) row.key = keyFor(row.label);
        M().send({ type: 'profile-save', profile: { fields: rows } });
      }),
    );
    panel.append(foot);

    // Preview: exactly what one agent gets.
    if (agents().length > 0) {
      if (!agents().includes(previewAgent)) previewAgent = agents()[0];
      const select = el('select');
      for (const name of agents()) {
        const option = el('option', '', nameOf(name));
        option.value = name;
        select.append(option);
      }
      select.value = previewAgent;
      select.onchange = () => {
        previewAgent = select.value;
        renderPreviewOnly();
      };
      const pre = el('pre', 'wjson');
      pre.id = 'pfPreview';
      pre.textContent = previewText(previewAgent);
      const details = el('details');
      details.append(el('summary', '', 'ดูว่า agent แต่ละตัวเห็นอะไร'), M().labelled('agent', select), pre);
      panel.append(details);
    }
  }

  function onMessage(message) {
    if (message.type !== 'profile') return;
    // A save from this or another window replaces the working copy.
    if (!dirty || message.saved) {
      rows = (message.profile.fields || []).map((field) => ({ ...field, visibleTo: field.visibleTo === '*' ? '*' : [...field.visibleTo] }));
      dirty = false;
    }
    if (message.saved) M().toast('บันทึกโปรไฟล์แล้ว ✓');
    rerender();
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.profile = { render, onMessage };
})();
