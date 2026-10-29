// Hub → ฉากหลัง: backdrops for the chat stage, like the scenes of a visual novel. One is
// chosen for the whole app and, optionally, one per agent; "auto" picks by the agent's
// location (the first backdrop with a keyword its location contains). A change dissolves.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  let selected = null; // backdrop id, '' for the "new" form, null for the intro

  const data = () => M().state.backgrounds || { items: [], settings: { default: '', agents: {} } };
  const items = () => data().items;

  // ---------- the stage layer ----------
  let shownPath = '';
  let pendingPath = '';

  /** The backdrop for a chat's agent (null in a group), or null for none. */
  function resolve(agent) {
    const { settings } = data();
    const own = agent && settings.agents[agent.name];
    let choice = own || settings.default || '';
    if (choice === 'auto') {
      const location = String((agent && agent.status && agent.status.location) || '').toLowerCase();
      const hit = location && items().find((item) => item.keywords.some((word) => word && location.includes(word.toLowerCase())));
      if (hit) return hit;
      choice = settings.default && settings.default !== 'auto' ? settings.default : '';
    }
    if (!choice || choice === 'none') return null;
    return items().find((item) => item.id === choice && item.image) || null;
  }

  // The stage backdrop is switched off for now: with a character portrait on the stage the
  // chosen backdrop did not change reliably. The Hub editor and the saved files stay, so
  // turning this back on later only needs `true` here (and the selector in Chat setting).
  const STAGE_BACKDROPS = false;

  /** Called by the stage whenever the chat, the agent or the choices change. */
  function apply() {
    const stage = document.getElementById('stage');
    const wrap = document.getElementById('bg');
    if (!stage || !wrap) return;
    if (!STAGE_BACKDROPS) {
      stage.classList.remove('has-bg');
      wrap.hidden = true;
      wrap.replaceChildren();
      shownPath = '';
      pendingPath = '';
      return;
    }
    if (!M().state.backgroundsLoaded) {
      M().state.backgroundsLoaded = true;
      M().send({ type: 'backgrounds-list' });
    }
    const chat = M().state.chat;
    const agent = chat && chat.kind === 'direct' ? M().agentOf(chat.agents[0]) : null;
    const target = chat ? resolve(agent) : null;
    stage.classList.toggle('has-bg', Boolean(target));
    wrap.hidden = !target;
    if (!target) {
      wrap.replaceChildren();
      shownPath = '';
      pendingPath = '';
      return;
    }
    const path = `/api/background-image/${encodeURIComponent(target.id)}?v=${target.image}`;
    if (path === shownPath || path === pendingPath) return;
    pendingPath = path;
    M()
      .blobUrl(path)
      .then((url) => {
        if (pendingPath !== path) return;
        pendingPath = '';
        const image = el('img', `bgimg ${shownPath ? 'bg-in' : 'bg-first'}`);
        image.alt = '';
        image.src = url;
        for (const old of wrap.querySelectorAll('img.bgimg:not(.bg-out)')) {
          old.classList.add('bg-out');
          setTimeout(() => old.remove(), 900);
        }
        wrap.append(image);
        shownPath = path;
      })
      .catch(() => {
        if (pendingPath === path) pendingPath = '';
      });
  }

  // ---------- the Hub tab ----------
  function rerender() {
    if (M().state.view === 'hub' && M().ui.hubTab === 'backgrounds') M().renderHub();
  }

  function select(id) {
    selected = id;
    rerender();
  }

  function render() {
    const wrap = el('div', 'split kbsplit');
    wrap.append(listPanel(), selected === null ? introPanel() : editorPanel());
    return wrap;
  }

  function thumb(item, cls) {
    const frame = el('div', `wthumb bgthumb ${cls || ''}`, item.image ? '' : '🌄');
    if (item.image) {
      M()
        .blobUrl(`/api/background-image/${encodeURIComponent(item.id)}?v=${item.image}`)
        .then((url) => {
          const image = el('img');
          image.src = url;
          frame.replaceChildren(image);
        })
        .catch(() => {});
    }
    return frame;
  }

  /** A select of the choices a place can take; `inherit` adds "follow the app-wide choice". */
  function choiceSelect(value, inherit, onChange) {
    const select = el('select');
    const add = (key, label) => {
      const option = el('option', '', label);
      option.value = key;
      select.append(option);
    };
    if (inherit) add('', 'ตามค่าทั้งแอป');
    add('none', 'ไม่มีฉากหลัง');
    add('auto', 'อัตโนมัติ (ตามสถานที่ของ agent)');
    for (const item of items()) add(item.id, item.name);
    select.value = value && [...select.options].some((option) => option.value === value) ? value : inherit ? '' : 'none';
    select.onchange = () => onChange(select.value);
    return select;
  }

  function listPanel() {
    const panel = el('div', 'panel');
    panel.append(el('h3', '', 'ฉากหลัง'));
    const list = el('div', 'list');
    for (const item of items()) {
      const row = button(`item witem${item.id === selected ? ' on' : ''}`, '', () => select(item.id));
      const text = el('div');
      text.append(el('b', '', item.name), el('small', 'muted', item.keywords.length ? ` · ${item.keywords.join(', ')}` : ''));
      row.append(thumb(item, 's'), text);
      list.append(row);
    }
    if (items().length === 0) list.append(el('p', 'hint', 'ยังไม่มีฉากหลัง'));
    panel.append(list, button('btn', '+ เพิ่มฉากหลัง', () => select('')));

    panel.append(el('h4', '', 'ใช้ฉากไหน'));
    const grid = el('div', 'grid2');
    const settings = data().settings;
    grid.append(M().labelled('ทั้งแอป', choiceSelect(settings.default, false, (choice) => M().send({ type: 'background-select', choice }))));
    for (const agent of M().state.agents) {
      grid.append(
        M().labelled(
          M().nameOf(agent.name),
          choiceSelect(settings.agents[agent.name] || '', true, (choice) => M().send({ type: 'background-select', agent: agent.name, choice })),
        ),
      );
    }
    panel.append(grid);
    return panel;
  }

  function introPanel() {
    const panel = el('div', 'panel');
    panel.append(
      el('h3', '', 'ฉากหลังทำอะไร'),
      el('p', 'hint', 'เพิ่มภาพฉาก (ห้องทำงาน คาเฟ่ ห้องนอน ฯลฯ) แล้วเลือกให้ทั้งแอปหรือแยกตาม agent · หน้าแชตจะแสดงเป็นฉากหลัง และค่อยๆ เปลี่ยนภาพเมื่อสลับฉาก'),
      el('p', 'hint', 'โหมด "อัตโนมัติ": ใส่คำสำคัญให้แต่ละฉาก (เช่น คาเฟ่, ร้านกาแฟ) เมื่อ agent ตั้งสถานที่ (location) ที่มีคำนั้น ฉากจะเปลี่ยนตามเอง แบบ visual novel'),
    );
    return panel;
  }

  function editorPanel() {
    const isNew = selected === '';
    const item = items().find((entry) => entry.id === selected) || { id: '', name: '', keywords: [], image: null };
    const panel = el('div', 'panel form');
    panel.append(el('h3', '', isNew ? 'ฉากใหม่' : item.name));

    const id = M().textInput(item.id, 'เช่น cafe, office');
    const name = M().textInput(item.name, 'เช่น คาเฟ่');
    const keywords = M().textInput(item.keywords.join(', '), 'เช่น คาเฟ่, ร้านกาแฟ (คั่นด้วย ,)');
    const grid = el('div', 'grid2');
    grid.append(M().labelled('รหัสฉาก (a-z 0-9 - _)', id), M().labelled('ชื่อฉาก', name));
    panel.append(grid, M().labelled('คำสำคัญสำหรับโหมดอัตโนมัติ', keywords));

    const actions = el('div', 'row');
    actions.append(
      button('btn primary', 'บันทึก', () => {
        M().send({
          type: 'background-save',
          background: { id: id.value.trim(), name: name.value.trim(), keywords: keywords.value.split(/[,،、]/).map((word) => word.trim()).filter(Boolean) },
          ...(!isNew && id.value.trim() !== item.id ? { renameFrom: item.id } : {}),
        });
        selected = id.value.trim();
      }),
    );
    if (!isNew) {
      actions.append(
        button('btn ghost', 'ลบฉาก', () => {
          if (confirm(`ลบฉาก "${item.name}" (${item.id})?`)) {
            M().send({ type: 'background-delete', id: item.id });
            selected = null;
          }
        }),
      );
    }
    panel.append(actions);

    if (!isNew) {
      panel.append(el('h4', '', 'ภาพฉาก'));
      const picture = el('div', 'pic');
      const choose = el('input');
      choose.type = 'file';
      choose.accept = 'image/png,image/jpeg,image/webp,image/gif';
      choose.hidden = true;
      choose.onchange = async () => {
        const file = choose.files[0];
        if (!file) return;
        const response = await M().api(`/api/background-image/${encodeURIComponent(item.id)}`, { method: 'POST', headers: { 'content-type': file.type }, body: file });
        if (!response.ok) M().toast('อัปโหลดรูปไม่สำเร็จ', (await response.json()).error, true);
      };
      const row = el('div', 'row');
      row.append(button('btn', 'เลือกรูป', () => choose.click()));
      if (item.image) {
        row.append(button('btn ghost', 'ลบรูป', () => M().api(`/api/background-image/${encodeURIComponent(item.id)}`, { method: 'DELETE' })));
      }
      picture.append(thumb(item, 'wide'), row, choose);
      panel.append(picture, el('p', 'hint', 'แนะนำภาพแนวนอน (เช่น 1920×1080) ไม่เกิน 12 MB'));
    } else {
      panel.append(el('p', 'hint', 'บันทึกฉากก่อน แล้วจึงใส่รูปได้'));
    }
    return panel;
  }

  function onMessage(message) {
    if (message.type !== 'backgrounds') return;
    M().state.backgrounds = { items: message.items || [], settings: message.settings || { default: '', agents: {} } };
    if (message.saved) M().toast('บันทึกแล้ว ✓');
    if (selected && !items().some((entry) => entry.id === selected)) selected = null;
    apply();
    rerender();
    if (M().state.view === 'chat') M().renderRail();
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.backgrounds = { render, onMessage, apply, resolve, choiceSelect, stageEnabled: () => STAGE_BACKDROPS };
})();
