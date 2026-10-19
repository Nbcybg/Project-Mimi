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
    const wrap = el('div', 'split kbsplit');
    wrap.append(listPanel(), selected === null ? introPanel() : editorPanel());
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

  function listPanel() {
    const panel = el('div', 'panel');
    panel.append(el('h3', '', 'ตู้เสื้อผ้า'));
    const list = el('div', 'list');
    for (const outfit of outfits()) {
      const item = button(`item witem${outfit.id === selected ? ' on' : ''}`, '', () => select(outfit.id));
      const text = el('div');
      text.append(el('b', '', outfit.name), el('small', 'muted', ` · {{${outfit.id}}}`));
      item.append(thumb(outfit, 's'), text);
      list.append(item);
    }
    if (outfits().length === 0) list.append(el('p', 'hint', 'ยังไม่มีชุด'));
    panel.append(list, button('btn', '+ เพิ่มชุดใหม่', () => select('')));
    return panel;
  }

  function introPanel() {
    const panel = el('div', 'panel');
    panel.append(
      el('h3', '', 'ตู้เสื้อผ้าทำอะไร'),
      el('p', 'hint', 'เก็บชุดทั้งหมดไว้ที่เดียว: รหัส (เช่น wa01) รูป และคำอธิบาย · เขียน {{wa01}} ใน system prompt ของ agent แล้วจะถูกแทนด้วยชื่อ + คำอธิบายชุดนั้น เช่น "ชุดทำงานของ {{char}} คือ {{wa01}}"'),
      el('p', 'hint', 'agent ที่ติ๊กเครื่องมือ status_set จะเห็นรายการชุดและเปลี่ยนชุดเองได้ (ตั้ง outfit เป็นรหัสชุด) · ชุดที่ใส่อยู่จะแสดงในสถานะของ agent'),
    );
    return panel;
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
        button('btn ghost', 'ลบชุด', () => {
          if (confirm(`ลบชุด "${outfit.name}" (${outfit.id})?`)) {
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
        row.append(button('btn ghost', 'ลบรูป', () => M().api(`/api/wardrobe-image/${encodeURIComponent(outfit.id)}`, { method: 'DELETE' })));
      }
      picture.append(frame, row, choose);
      panel.append(picture, el('p', 'hint', `ใช้ใน prompt: {{${outfit.id}}}`));
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
