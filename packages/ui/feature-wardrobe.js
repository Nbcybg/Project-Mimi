// Hub → ตู้เสื้อผ้า: the pool of outfits. Each has an id (wa01), a name, a description
// and a picture. Writing {{wa01}} in a system prompt expands to the outfit's name and
// description; an agent wears one by setting its "outfit" status to the id.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  let selected = null; // outfit id, or '' for the "new" form, or null for the intro

  const outfits = () => M().state.wardrobe || [];

  function rerender() {
    if (M().state.view === 'hub' && M().ui.hubTab === 'wardrobe') M().renderHub();
  }

  function select(id) {
    selected = id;
    rerender();
  }

  function render() {
    if (!M().state.wardrobeLoaded) {
      M().state.wardrobeLoaded = true;
      M().send({ type: 'wardrobe-list' });
    }
    const Kit = window.MimiKit;
    const wrap = el('div');
    wrap.append(Kit.section(`ตู้เสื้อผ้า (${outfits().length})`, 'รหัสชุด (เช่น wa01) + รูป + คำอธิบาย · เขียน {{wa01}} ใน system prompt แล้วจะถูกแทนด้วยชื่อและคำอธิบายชุด · agent ที่มี status_set เปลี่ยนชุดเองได้', [
      button('btn pri', '+ เพิ่มชุดใหม่', () => select('')),
    ]));
    wrap.append(Kit.grid(outfits().map((outfit) => Kit.card({
      title: outfit.name,
      sub: `{{${outfit.id}}}`,
      icon: thumb(outfit, 's'),
      desc: outfit.description,
      badges: [outfit.model ? ['มีโมเดล 3D', 'info'] : null],
      onOpen: () => select(outfit.id),
      actions: [
        { label: 'แก้ไข', onClick: () => select(outfit.id) },
        { label: 'ลบ', danger: true, onClick: async () => {
          if (!(await Kit.confirmDelete(`ชุด "${outfit.name}" (${outfit.id})`, 'รูปและโมเดลของชุดนี้จะถูกลบด้วย'))) return;
          M().send({ type: 'wardrobe-delete', id: outfit.id });
          if (selected === outfit.id) select(null);
        } },
      ],
    })), 'ยังไม่มีชุด — กด "+ เพิ่มชุดใหม่"'));
    if (selected === null) Kit.closeHost('wardrobe');
    else Kit.hostPopup('wardrobe', { title: selected === '' ? 'เพิ่มชุดใหม่' : `ชุด: ${(outfits().find((item) => item.id === selected) || {}).name || selected}`, build: () => [editorPanel()], onClose: () => select(null) });
    return wrap;
  }

  function thumb(outfit, cls) {
    const frame = el('div', `wthumb ${cls || ''}`, outfit.image ? '' : '👕');
    if (outfit.image) {
      M()
        .blobUrl(`/api/wardrobe-image/${encodeURIComponent(outfit.id)}?v=${outfit.image}`)
        .then((url) => {
          const image = el('img');
          image.src = url;
          frame.replaceChildren(image);
        })
        .catch(() => {});
    }
    return frame;
  }

  function editorPanel() {
    const isNew = selected === '';
    const outfit = outfits().find((item) => item.id === selected) || { id: '', name: '', description: '', image: null };
    const panel = el('div', 'panel form');
    panel.append(el('h3', '', isNew ? 'ชุดใหม่' : outfit.name));

    const id = M().textInput(outfit.id, 'เช่น wa01, home02');
    const name = M().textInput(outfit.name, 'เช่น ชุดทำงาน');
    const description = el('textarea', 'tall');
    description.value = outfit.description;
    description.placeholder = 'อธิบายชุด: สี ทรง วัสดุ โอกาสที่ใส่ (agent ได้อ่านข้อความนี้)';
    const grid = el('div', 'grid2');
    grid.append(M().labelled('รหัสชุด (a-z 0-9 - _ ขึ้นต้นด้วยตัวอักษร)', id), M().labelled('ชื่อชุด', name));
    panel.append(grid, M().labelled('คำอธิบาย', description));

    const actions = el('div', 'row');
    actions.append(
      button('btn primary', 'บันทึก', () => {
        M().send({
          type: 'wardrobe-save',
          outfit: { id: id.value.trim(), name: name.value.trim(), description: description.value },
          ...(!isNew && id.value.trim() !== outfit.id ? { renameFrom: outfit.id } : {}),
        });
        selected = id.value.trim();
      }),
    );
    if (!isNew) {
      actions.append(
        button('btn danger', 'ลบชุด', async () => {
          if (await window.MimiKit.confirmDelete(`ชุด "${outfit.name}" (${outfit.id})`, 'รูปและโมเดลของชุดนี้จะถูกลบด้วย')) {
            M().send({ type: 'wardrobe-delete', id: outfit.id });
            selected = null;
          }
        }),
      );
    }
    panel.append(actions);

    if (!isNew) {
      panel.append(el('h4', '', 'รูปชุด'));
      const picture = el('div', 'pic');
      const frame = thumb(outfit, 'l');
      const choose = el('input');
      choose.type = 'file';
      choose.accept = 'image/png,image/jpeg,image/webp,image/gif';
      choose.hidden = true;
      choose.onchange = async () => {
        const file = choose.files[0];
        if (!file) return;
        const response = await M().api(`/api/wardrobe-image/${encodeURIComponent(outfit.id)}`, {
          method: 'POST',
          headers: { 'content-type': file.type },
          body: file,
        });
        if (!response.ok) M().toast('อัปโหลดรูปไม่สำเร็จ', (await response.json()).error, true);
      };
      const row = el('div', 'row');
      row.append(button('btn', 'เลือกรูป', () => choose.click()));
      if (outfit.image) {
        row.append(button('btn ghost', 'ลบรูป', async () => (await window.MimiKit.confirmDelete(`รูปของชุด "${outfit.name}"`)) && M().api(`/api/wardrobe-image/${encodeURIComponent(outfit.id)}`, { method: 'DELETE' })));
      }
      picture.append(frame, row, choose);
      panel.append(picture, el('p', 'hint', `ใช้ใน prompt: {{${outfit.id}}}`));
      // The same outfit as a 3D model: an agent shown as VRM wears it when its status says so.
      panel.append(el('h4', '', 'โมเดล 3D ของชุดนี้ (VRM)'));
      const modelRow = el('div', 'row');
      const chooseModel = el('input');
      chooseModel.type = 'file';
      chooseModel.accept = '.vrm';
      chooseModel.hidden = true;
      chooseModel.onchange = async () => {
        const file = chooseModel.files[0];
        chooseModel.value = '';
        if (!file) return;
        M().toast('กำลังอัปโหลดโมเดล…', `${file.name} (${(file.size / 1048576).toFixed(1)} MB)`);
        const response = await M().api(`/api/wardrobe-model/${encodeURIComponent(outfit.id)}`, { method: 'POST', headers: { 'content-type': 'model/vrm' }, body: file });
        if (!response.ok) M().toast('อัปโหลดโมเดลไม่สำเร็จ', (await response.json()).error, true);
        else M().toast('อัปโหลดโมเดลแล้ว', 'agent ที่ใส่ชุดนี้ (แบบ VRM) จะเปลี่ยนเป็นโมเดลนี้');
      };
      modelRow.append(
        el('span', 'faint', outfit.model ? `model.vrm (${new Date(Number(outfit.model)).toLocaleString('th-TH')})` : 'ยังไม่มีโมเดล'),
        button('btn', outfit.model ? 'เปลี่ยนไฟล์ .vrm' : 'อัปโหลด .vrm', () => chooseModel.click()),
      );
      if (outfit.model) modelRow.append(button('btn ghost', 'ลบโมเดล', async () => (await window.MimiKit.confirmDelete(`โมเดล 3D ของชุด "${outfit.name}"`)) && M().api(`/api/wardrobe-model/${encodeURIComponent(outfit.id)}`, { method: 'DELETE' })));
      panel.append(modelRow, chooseModel, el('p', 'hint', 'ใช้กับ agent ที่ตั้งตัวละครเป็น "โมเดล 3D (VRM)" · เมื่อสถานะ "ชุด" ของ agent เป็นรหัสชุดนี้ บนหน้าแชตจะแสดงโมเดลนี้แทนโมเดลหลักของ agent'));
      panel.append(el('h4', '', 'รูปตามอีโมจิของชุดนี้'));
      panel.append(el('p', 'hint', 'เมื่อ agent ใส่ชุดนี้และส่งอีโมจิ จะใช้รูปที่ตั้งไว้ที่นี่ · อีโมจิที่ไม่มีรูป จะใช้รูปชุดด้านบนแทน'));
      panel.append(window.MimiHooks.stage.spriteEditor('outfit', outfit.id, outfit.sprites || {}));
    } else {
      panel.append(el('p', 'hint', 'บันทึกชุดก่อน แล้วจึงใส่รูปได้'));
    }
    return panel;
  }

  function onMessage(message) {
    if (message.type !== 'wardrobe') return;
    M().state.wardrobe = message.outfits || [];
    if (message.saved) M().toast('บันทึกแล้ว ✓');
    if (selected && !outfits().some((outfit) => outfit.id === selected)) selected = null;
    rerender();
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.wardrobe = { render, onMessage };
})();
