// The API-key vault: names only leave the machine; values are typed here and used by
// tool templates ({{secret.NAME}}) and by `secret` settings inside tool presets.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  let editing = null;

  function render(panel) {
    panel.append(
      el(
        'p',
        'hint',
        'เก็บ API key ไว้ที่นี่ แล้วอ้างใน tool ได้ด้วย {{secret.ชื่อ}} · ค่าที่กรอกในช่อง secret ของ preset จะถูกเก็บที่นี่ (ชื่อ preset.ชื่อ.field) · ไฟล์นี้อยู่ในเครื่องนี้เท่านั้น ไม่ sync',
      ),
    );
    const names = M().state.secrets || [];
    const list = el('div');
    for (const name of names) {
      const row = el('div', 'prov');
      const info = el('div');
      info.append(el('b', 'mono', name), el('small', '', 'ตั้งค่าไว้แล้ว ✓'));
      row.append(
        info,
        button('btn', 'เปลี่ยนค่า', () => {
          editing = name;
          M().renderSettings();
        }),
        button('btn danger', 'ลบ', () => confirm(`ลบคีย์ "${name}" ?`) && M().send({ type: 'secrets-save', values: { [name]: '' } })),
      );
      list.append(row);
    }
    if (names.length === 0) list.append(el('p', 'hint', 'ยังไม่มีคีย์ในเครื่องนี้'));
    panel.append(list);

    const name = M().textInput(editing || '', 'ชื่อคีย์ เช่น WEATHER_API_KEY');
    name.readOnly = Boolean(editing);
    const value = M().textInput('', editing ? 'ค่าใหม่ (เว้นว่าง = คงเดิม)' : 'ค่า', 'password');
    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'));
    if (editing) {
      foot.append(
        button('btn ghost', 'ยกเลิก', () => {
          editing = null;
          M().renderSettings();
        }),
      );
    }
    foot.append(
      button('btn pri', editing ? 'บันทึกค่าใหม่' : '+ เพิ่มคีย์', () => {
        const key = name.value.trim();
        if (!key) return M().toast('ต้องมีชื่อคีย์', null, true);
        if (!value.value.trim()) return M().toast('ต้องมีค่า', null, true);
        M().send({ type: 'secrets-save', values: { [key]: value.value } });
        editing = null;
      }),
    );
    const grid = el('div', 'grid2');
    grid.append(M().labelled('ชื่อ', name), M().labelled('ค่า', value));
    panel.append(grid, foot);
  }

  function onMessage(message) {
    if (message.names && editing && !message.names.includes(editing)) editing = null;
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.secrets = { render, onMessage };
})();
