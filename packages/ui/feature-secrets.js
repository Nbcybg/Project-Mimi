// The API-key vault: names only leave the machine; values are typed here and used by
// tool templates ({{secret.NAME}}) and by `secret` settings inside tool presets.
// Each key is a card; adding or changing one happens in a popup, and keys can be read in
// from a .env file. There is no export: values never come back to the screen.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const Kit = () => window.MimiKit;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

  function editor(existing) {
    const name = M().textInput(existing || '', 'ชื่อคีย์ เช่น WEATHER_API_KEY');
    name.readOnly = Boolean(existing);
    const value = M().textInput('', existing ? 'ค่าใหม่' : 'วางค่าที่นี่', 'password');
    const popup = Kit().modal({
      title: existing ? `เปลี่ยนค่า ${existing}` : 'เพิ่มคีย์ลับ',
      size: 'sm',
      body: [Kit().field('ชื่อ', name, 'อ้างในเครื่องมือด้วย {{secret.ชื่อ}}'), Kit().field('ค่า', value, 'เก็บในเครื่องนี้เท่านั้น ไม่แสดงกลับมาอีก')],
    });
    popup.setFoot([
      button('btn ghost', 'ยกเลิก', () => popup.close()),
      button('btn pri', 'บันทึก', () => {
        const key = name.value.trim();
        if (!NAME.test(key)) return M().toast('ชื่อคีย์ไม่ถูกต้อง', 'ใช้ A-Z a-z 0-9 _ . - และขึ้นต้นด้วยตัวอักษร', true);
        if (!value.value.trim()) return M().toast('ต้องมีค่า', null, true);
        M().send({ type: 'secrets-save', values: { [key]: value.value } });
        popup.done();
        M().toast(`บันทึก ${key} แล้ว ✓`);
      }),
    ]);
  }

  /** KEY=value lines of a .env file; quotes around the value are taken off. */
  async function importEnv(files) {
    const values = {};
    for (const file of files) {
      for (const raw of (await file.text()).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        let value = match[2].trim();
        if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
        if (value) values[match[1]] = value;
      }
    }
    const names = Object.keys(values);
    if (names.length === 0) throw new Error('ไม่พบบรรทัดแบบ KEY=ค่า ในไฟล์');
    const existing = names.filter((name) => (M().state.secrets || []).includes(name));
    const ok = await Kit().ask({
      title: `นำเข้า ${names.length} คีย์?`,
      body: [names.join(', '), existing.length ? `จะเขียนทับ: ${existing.join(', ')}` : ''].filter(Boolean),
      ok: 'นำเข้า',
      danger: existing.length > 0,
    });
    if (!ok) return;
    M().send({ type: 'secrets-save', values });
    M().toast(`นำเข้า ${names.length} คีย์แล้ว ✓`);
  }

  function render(panel) {
    const names = M().state.secrets || [];
    panel.append(Kit().section(`คีย์ลับ (${names.length})`, 'เก็บ API key ไว้ที่นี่ แล้วอ้างในเครื่องมือด้วย {{secret.ชื่อ}} · ค่าในช่อง secret ของ preset ก็เก็บที่นี่ · อยู่ในเครื่องนี้เท่านั้น ไม่ sync', [
      button('btn pri', '+ เพิ่มคีย์', () => editor(null)),
      ...Kit().ioButtons({ accept: '.env,.txt,text/plain', onImport: importEnv, importTitle: 'อ่านคีย์จากไฟล์ .env (บรรทัดละ KEY=ค่า)' }),
    ]));
    panel.append(Kit().grid(names.map((name) => Kit().card({
      title: name,
      mono: true,
      sub: `{{secret.${name}}}`,
      state: ['ok', 'ตั้งแล้ว'],
      onOpen: () => editor(name),
      actions: [
        { label: 'เปลี่ยนค่า', onClick: () => editor(name) },
        { label: 'คัดลอกชื่อ', onClick: () => navigator.clipboard?.writeText(`{{secret.${name}}}`).then(() => M().toast('คัดลอกแล้ว'), () => {}) },
        {
          label: 'ลบ',
          danger: true,
          onClick: async () => (await Kit().confirmDelete(`คีย์ลับ "${name}"`, `เครื่องมือที่อ้าง {{secret.${name}}} จะใช้ค่านี้ไม่ได้อีก`)) && M().send({ type: 'secrets-save', values: { [name]: '' } }),
        },
      ],
    })), 'ยังไม่มีคีย์ในเครื่องนี้ — กด "+ เพิ่มคีย์" หรือนำเข้าจากไฟล์ .env', 'dense'));
  }

  function onMessage() {}

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.secrets = { render, onMessage };
})();
