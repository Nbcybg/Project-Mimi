// Providers screen: add, edit (name / URL / key / model list) and remove model providers.
// Definitions live in syncable files under providers/; keys stay in data/auth.json.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  let editingId = null;

  /** The same form is embedded in Settings and in the Overseer setup screen. */
  function rerender() {
    if (M().state.view === 'overseer' && window.MimiHooks?.overseer?.render) window.MimiHooks.overseer.render();
    else M().renderSettings();
  }

  function row(provider, panel) {
    const line = el('div', 'prov');
    const info = el('div');
    info.append(
      el('b', '', `${provider.name} (${provider.id})`),
      el(
        'small',
        '',
        `${provider.connected ? 'เชื่อมต่อแล้ว ✓' : 'ยังไม่มี credential เก็บในเครื่องนี้'} · ${provider.models} โมเดล${provider.baseURL ? ` · ${provider.baseURL}` : ''}`,
      ),
    );
    line.append(
      info,
      button('btn', 'แก้ไข', () => {
        editingId = provider.id;
        M().ui.providerDirty = false;
        rerender();
      }),
      button('btn', 'ดึงโมเดลใหม่', () => {
        M().toast('กำลังดึงรายชื่อโมเดล…', provider.id);
        M().send({ type: 'provider-connect', id: provider.id });
      }),
      button(
        'btn danger',
        'ลบ',
        () => confirm(`ลบ "${provider.id}" พร้อม credential ในเครื่องนี้?`) && M().send({ type: 'provider-remove', id: provider.id }),
      ),
    );
    return line;
  }

  function form(panel, view, editing) {
    const form = el('div');
    form.oninput = () => {
      M().ui.providerDirty = true;
    };
    form.append(
      el('h4', '', editing ? `แก้ไข ${editing.id}` : 'เพิ่มผู้ให้บริการ'),
      el(
        'p',
        'hint',
        editing
          ? 'เว้น API key ว่าง = ใช้คีย์เดิมในเครื่องนี้ · เปลี่ยน URL หรือคีย์แล้วระบบจะดึงรายชื่อโมเดลใหม่ให้เอง'
          : 'เลือกจากรายชื่อ (เช่น deepseek, opencode, google) หรือพิมพ์ชื่อของคุณเองแล้วใส่ URL กับคีย์ ระบบจะดึงรายชื่อโมเดลและเก็บ credential ให้เอง · คีย์เก็บในเครื่องนี้เท่านั้น ไม่ถูก sync',
      ),
    );
    const id = M().textInput(editing ? editing.id : '', 'ชื่อผู้ให้บริการ เช่น deepseek');
    id.readOnly = Boolean(editing);
    id.setAttribute('list', 'provider-catalog');
    const datalist = el('datalist');
    datalist.id = 'provider-catalog';
    for (const entry of view.catalog || []) {
      const option = el('option');
      option.value = entry.id;
      option.label = entry.name;
      datalist.append(option);
    }
    const url = M().textInput(editing ? editing.baseURL || '' : '', 'URL ของ API เช่น https://example.com/v1');
    const key = M().textInput('', editing ? 'เว้นว่าง = ใช้คีย์เดิม' : 'API key', 'password');
    id.oninput = () => {
      if (editing) return;
      const hit = (view.catalog || []).find((entry) => entry.id === id.value.trim().toLowerCase());
      if (hit) url.value = hit.baseURL || '';
      url.placeholder = hit && !hit.baseURL ? `ใช้ที่อยู่มาตรฐานของ ${hit.name} (ไม่ต้องกรอก)` : 'URL ของ API เช่น https://example.com/v1';
    };
    const name = M().textInput(editing ? editing.name : '', 'ชื่อที่แสดง (เว้นว่าง = ใช้ชื่อผู้ให้บริการ)');
    const grid = el('div', 'grid2');
    grid.append(M().labelled('ชื่อ', id), M().labelled('ชื่อที่แสดง', name), M().labelled('URL', url), M().labelled('API key', key));
    form.append(grid, datalist);
    // The models come from the provider itself; here they are only shown.
    if (editing) {
      const ids = editing.modelIds || [];
      const list = el('div', 'hstack models');
      for (const model of ids.slice(0, 60)) list.append(el('span', 'chip', model));
      if (ids.length > 60) list.append(el('span', 'chip', `+${ids.length - 60}`));
      if (ids.length === 0) list.append(el('span', 'hint', 'ยังไม่มีรายชื่อโมเดล — กด "ดึงโมเดลใหม่"'));
      form.append(M().labelled(`โมเดลที่ดึงมา (${ids.length})`, list));
    }

    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'));
    if (editing) {
      foot.append(
        button('btn ghost', 'ยกเลิก', () => {
          editingId = null;
          M().ui.providerDirty = false;
          rerender();
        }),
      );
    }
    foot.append(
      button('btn pri', editing ? 'บันทึก' : 'เชื่อมต่อและดึงโมเดล', () => {
        const providerId = id.value.trim().toLowerCase();
        if (!providerId) return M().toast('ต้องมีชื่อผู้ให้บริการ', null, true);
        if (editing) {
          M().ui.providerDirty = false;
          const urlChanged = url.value.trim().replace(/\/+$/, '') !== (editing.baseURL || '').replace(/\/+$/, '');
          if (key.value.trim() || urlChanged) {
            // A new key or address: ask the provider for its models again.
            M().toast('กำลังบันทึกและดึงรายชื่อโมเดล…', providerId);
            M().send({
              type: 'provider-connect',
              id: providerId,
              name: name.value.trim() || undefined,
              baseURL: url.value.trim() || undefined,
              apiKey: key.value.trim() || undefined,
            });
          } else {
            M().send({ type: 'provider-update', id: providerId, name: name.value.trim() });
          }
        } else {
          M().ui.providerDirty = false;
          if (!key.value.trim() && !(view.catalog || []).some((entry) => entry.id === providerId)) {
            return M().toast('ต้องมี API key', 'ผู้ให้บริการใหม่ต้องมีคีย์', true);
          }
          M().toast('กำลังเชื่อมต่อและดึงรายชื่อโมเดล…', providerId);
          M().send({
            type: 'provider-connect',
            id: providerId,
            name: name.value.trim() || undefined,
            baseURL: url.value.trim() || undefined,
            apiKey: key.value.trim() || undefined,
          });
        }
      }),
    );
    form.append(foot);
    return form;
  }

  function render(panel) {
    const view = M().state.settings;
    if (!view) {
      panel.append(el('p', 'hint', 'กำลังโหลด…'));
      return;
    }
    const entries = view.providers || [];
    if (entries.length === 0) panel.append(el('p', 'hint', 'ยังไม่มีผู้ให้บริการ'));
    for (const provider of entries) panel.append(row(provider, panel));
    const editing = editingId ? entries.find((entry) => entry.id === editingId) || null : null;
    panel.append(form(panel, view, editing));
  }

  function onMessage(message) {
    if (!message.saved) return;
    M().ui.providerDirty = false;
    if (editingId && !(message.settings.providers || []).some((entry) => entry.id === editingId)) editingId = null;
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.providers = { render, onMessage };
})();
