// AI Overseer: connect a provider, choose the model that runs the setup helper, then
// describe what to change. The real work happens in its authoring tools (agents, tools,
// presets, skills); this screen only starts the conversation.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const SUGGESTIONS = [
    'สร้าง agent นักวิจัยที่อ่าน PDF และสรุปภาษาไทยให้ฉัน',
    'ให้ agent ทุกตัวอ่านไฟล์ PDF ได้',
    'สร้างเครื่องมือ JavaScript สำหรับคำนวณ VAT 7%',
    'ทำ Quick Work ดึงข้อมูลจาก Google Sheets แล้วสรุป',
    'ช่วยตรวจว่าตอนนี้แต่ละ agent มีเครื่องมืออะไรบ้าง',
  ];

  let pendingPrompt = '';

  function head() {
    const node = el('div');
    const row = el('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center';
    row.append(
      button('back', '‹', () => document.getElementById('app').classList.add('show-side')),
      el('h2', '', 'AI Overseer'),
    );
    node.append(
      row,
      el(
        'p',
        'lead',
        'ผู้ช่วยตั้งค่า: บอกเป็นภาษาธรรมดาว่าอยากให้ agent ทำอะไร แล้ว Overseer จะสร้างหรือแก้ agent, tools, Quick Work, skill และ workflow ให้',
      ),
    );
    return node;
  }

  function statusChip(ok, text) {
    return el('span', ok ? 'chip on' : 'chip', text);
  }

  function providerPanel() {
    const panel = el('div', 'panel form');
    panel.append(
      el('h3', '', '1 · ผู้ให้บริการโมเดล'),
      el('p', 'hint', 'Overseer ต้องมีโมเดลสำหรับคิดและเรียกเครื่องมือก่อน ถ้ามีผู้ให้บริการอยู่แล้วข้ามขั้นนี้ได้'),
    );
    const hook = window.MimiHooks && window.MimiHooks.providers;
    if (hook) hook.render(panel);
    else panel.append(el('p', 'hint', 'โหลดหน้าจอผู้ให้บริการไม่สำเร็จ — รีเฟรชหน้าใหม่'));
    return panel;
  }

  function modelPanel() {
    const state = M().state;
    const view = state.overseer;
    const settings = state.settings;
    const panel = el('div', 'panel form');
    panel.append(
      el('h3', '', '2 · โมเดลของ Overseer'),
      el(
        'p',
        'hint',
        view.configured
          ? `ใช้อยู่: ${view.model}${view.providerConnected ? '' : ' · ผู้ให้บริการยังไม่เชื่อมต่อ'}`
          : 'เลือกโมเดลที่ต้องการให้ Overseer ใช้ (เลือกได้จากทุกผู้ให้บริการที่เชื่อมต่อแล้ว)',
      ),
    );
    const connected = (settings.providers || []).filter((provider) => provider.connected);
    if (connected.length === 0) {
      panel.append(el('p', 'warnbox', 'ยังไม่มีผู้ให้บริการที่เชื่อมต่อ — เพิ่มและเชื่อมต่อในขั้นที่ 1 ก่อน'));
    }
    const select = M().modelSelect(view.model || '', null, 'chat');
    select.disabled = connected.length === 0;
    // With no saved model yet, start on the first real option so Save is usable.
    if (!select.value && select.options.length > 0) select.selectedIndex = 0;
    const save = button('btn pri', 'บันทึกโมเดล', () => {
      if (!select.value) return M().toast('เลือกโมเดลก่อน', null, true);
      M().ui.overseerDirty = false;
      M().send({ type: 'overseer-save', model: select.value });
      M().toast('กำลังบันทึกโมเดล…', select.value);
    });
    save.disabled = connected.length === 0 || !select.value;
    select.onchange = () => {
      M().ui.overseerDirty = true;
      save.disabled = !select.value;
    };
    const row = el('div', 'grid2');
    row.append(M().labelled('โมเดลคุยของ Overseer', select));
    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'), save);
    panel.append(row, foot);
    if (!view.configured && connected.length > 0) {
      panel.append(el('p', 'hint', 'เลือกโมเดลแล้วกดบันทึก จากนั้นขั้นที่ 3 จะใช้งานได้'));
    }
    return panel;
  }

  function chatPanel() {
    const view = M().state.overseer;
    const panel = el('div', 'panel form');
    panel.append(el('h3', '', '3 · สั่งงาน'));
    if (!view.configured) {
      panel.append(el('p', 'hint', 'เลือกโมเดลของ Overseer ในขั้นที่ 2 ก่อน แล้วกลับมาที่นี่'));
      return panel;
    }
    if (!view.providerConnected) {
      panel.append(el('p', 'warnbox', 'ผู้ให้บริการของโมเดลนี้ยังไม่เชื่อมต่อ — กลับไปเชื่อมต่อในขั้นที่ 1'));
    }
    panel.append(
      el(
        'p',
        'hint',
        'พิมพ์สิ่งที่อยากให้เปลี่ยน เช่น "ให้ agent a อ่าน PDF ได้" หรือ "สร้าง agent ใหม่ชื่อนักข่าวที่ค้นเว็บและสรุปไทย" · การแก้ไฟล์/เครื่องมืออาจขออนุมัติก่อนทุกครั้ง',
      ),
    );
    const prompt = el('textarea', 'tall');
    prompt.placeholder = 'เช่น ให้ agent a อ่าน PDF แล้วสรุปเป็นภาษาไทย…';
    prompt.style.minHeight = '90px';
    panel.append(prompt);

    const chips = el('div');
    chips.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px';
    for (const text of SUGGESTIONS) {
      chips.append(
        button('chip', text, () => {
          prompt.value = text;
          prompt.focus();
        }),
      );
    }
    panel.append(chips);

    const open = button('btn ghost', 'เปิดแชต Overseer', () => openOverseerChat(''));
    const ask = button('btn pri', 'ส่งให้ Overseer', () => openOverseerChat(prompt.value.trim()));
    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'), open, ask);
    panel.append(foot);
    return panel;
  }

  function render() {
    const page = document.getElementById('view-overseer');
    if (!page) return;
    const state = M().state;
    if (!state.settings || !state.overseer) {
      page.replaceChildren(head(), el('p', 'hint', 'กำลังโหลด…'));
      return;
    }
    const view = state.overseer;
    const connected = (state.settings.providers || []).filter((provider) => provider.connected).length;
    const badges = el('div');
    badges.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:0 0 14px';
    badges.append(
      statusChip(view.configured && view.providerConnected, view.configured && view.providerConnected ? `พร้อมใช้งาน · ${view.model}` : 'ยังตั้งค่า Overseer ไม่ครบ'),
      statusChip(connected > 0, connected > 0 ? `ผู้ให้บริการที่เชื่อมต่อ: ${connected}` : 'ยังไม่มีผู้ให้บริการ'),
    );
    const stack = el('div', 'stackv');
    stack.append(providerPanel(), modelPanel(), chatPanel());
    page.replaceChildren(head(), badges, stack);
  }

  function openOverseerChat(text) {
    const state = M().state;
    if (text) pendingPrompt = text;
    const existing = state.chats.find(
      (chat) => chat.kind === 'direct' && chat.agents.length === 1 && chat.agents[0] === 'overseer',
    );
    M().setView('chat');
    document.getElementById('app').classList.remove('show-side');
    if (existing) M().openChat(existing.id);
    else M().send({ type: 'chat-create', kind: 'direct', agents: ['overseer'] });
  }

  /** The chat is open: send the prompt the user typed on the Overseer screen (once). */
  function onHistory(chat) {
    if (!pendingPrompt) return;
    if (!chat || chat.kind !== 'direct' || chat.agents[0] !== 'overseer') return;
    const text = pendingPrompt;
    pendingPrompt = '';
    M().send({ type: 'chat-send', chatId: chat.id, text });
    M().state.lastSent = text;
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.overseer = { render, onHistory };
})();
