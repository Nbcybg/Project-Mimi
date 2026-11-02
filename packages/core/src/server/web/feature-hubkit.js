// Hub kit: the pieces every Hub tab is built from, so they all behave the same way.
// Editing happens in a popup (never inline under a list), every delete asks first, lists are
// cards with a search/filter bar, and anything that can be moved between machines has
// import / export buttons.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  // ---------- popups ----------
  /** Popups stack: a confirm opened from an edit popup sits on top of it, and Esc closes the top one. */
  const stack = [];

  /**
   * A popup window. `body` is a node or a list of nodes; `foot` buttons go at the bottom right,
   * `footLeft` (e.g. a delete button) at the bottom left. Typing in it marks it changed, and
   * closing a changed popup any way but its own buttons asks first.
   */
  function modal({ title, sub, body, foot = [], footLeft = [], size = '', onClose } = {}) {
    const scrim = el('div', 'scrim mk-scrim');
    const box = el('div', `dialog mk-modal form${size ? ` ${size}` : ''}`);
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    const head = el('div', 'mk-head');
    const titles = el('div', 'mk-titles');
    titles.append(el('h3', '', title || ''));
    if (sub) titles.append(el('p', 'hint', sub));
    const x = button('mk-x', '✕', () => api.close(), 'ปิด');
    x.setAttribute('aria-label', 'ปิด');
    head.append(titles, x);
    const content = el('div', 'mk-body');
    const footer = el('div', 'mk-foot');
    const left = el('div', 'mk-foot-l');
    const right = el('div', 'mk-foot-r');
    footer.append(left, right);
    box.append(head, content, footer);
    scrim.append(box);

    const api = {
      node: box,
      body: content,
      dirty: false,
      setBody(nodes) {
        content.replaceChildren(...[].concat(nodes).filter(Boolean));
      },
      setFoot(buttons, leftButtons = []) {
        right.replaceChildren(...buttons.filter(Boolean));
        left.replaceChildren(...leftButtons.filter(Boolean));
        footer.hidden = buttons.length === 0 && leftButtons.length === 0;
      },
      setTitle(text) {
        titles.querySelector('h3').textContent = text;
      },
      /** Closes without asking (after a save, or from Cancel once the user chose it). */
      done() {
        const at = stack.indexOf(api);
        if (at !== -1) stack.splice(at, 1);
        scrim.remove();
        onClose?.();
      },
      /** Closes, asking first when something was typed and not saved. */
      async close() {
        if (api.dirty && !(await ask({ title: 'ปิดโดยไม่บันทึก?', body: 'สิ่งที่แก้ไว้ในหน้าต่างนี้จะหายไป', ok: 'ปิดเลย', danger: true }))) return;
        api.done();
      },
    };
    content.addEventListener('input', () => {
      api.dirty = true;
    });
    content.addEventListener('change', () => {
      api.dirty = true;
    });
    scrim.addEventListener('pointerdown', (event) => {
      scrim._downOnScrim = event.target === scrim;
    });
    scrim.onclick = (event) => {
      if (event.target === scrim && scrim._downOnScrim) api.close();
    };
    api.setBody(body || []);
    api.setFoot(foot, footLeft);
    stack.push(api);
    $overlay().append(scrim);
    // Focus the first field, so typing can start at once.
    requestAnimationFrame(() => {
      const first = content.querySelector('input:not([type=checkbox]):not([type=file]):not([readonly]), textarea, select');
      if (first && window.matchMedia('(pointer: fine)').matches) first.focus();
    });
    return api;
  }
  const $overlay = () => document.getElementById('overlay');

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || stack.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    stack[stack.length - 1].close();
  }, true);

  /** A yes/no question in a popup; resolves true only on the confirm button. */
  function ask({ title, body, ok = 'ตกลง', cancel = 'ยกเลิก', danger = false } = {}) {
    return new Promise((resolve) => {
      let answered = false;
      const finish = (value) => {
        if (answered) return;
        answered = true;
        resolve(value);
      };
      const parts = [];
      if (body) for (const line of [].concat(body)) parts.push(typeof line === 'string' ? el('p', 'mk-ask', line) : line);
      const popup = modal({
        title,
        body: parts,
        size: 'sm',
        onClose: () => finish(false),
      });
      const yes = button(`btn ${danger ? 'dangerfill' : 'pri'}`, ok, () => {
        finish(true);
        popup.done();
      });
      popup.setFoot([button('btn ghost', cancel, () => popup.done()), yes]);
      requestAnimationFrame(() => yes.focus());
    });
  }

  /** Every delete in the Hub goes through here: it names what goes and what happens to things using it. */
  function confirmDelete(what, detail) {
    return ask({
      title: `ลบ ${what}?`,
      body: [detail, 'ลบแล้วกู้คืนไม่ได้'].filter(Boolean),
      ok: 'ลบ',
      danger: true,
    });
  }

  // ---------- cards ----------
  /**
   * One item of a Hub list. Clicking the card opens it; `actions` are small buttons on the
   * card itself (edit, delete…), so nothing needs a selected row first.
   */
  function card({ title, mono = false, sub, desc, badges = [], icon, onOpen, actions = [], state, cls = '' } = {}) {
    const node = el('div', `mk-card${onOpen ? ' open' : ''}${cls ? ` ${cls}` : ''}`);
    if (onOpen) {
      node.tabIndex = 0;
      node.onclick = (event) => {
        if (event.target.closest('button, a, input, select, label')) return;
        onOpen();
      };
      node.onkeydown = (event) => {
        if (event.target === node && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpen();
        }
      };
    }
    const top = el('div', 'mk-card-top');
    if (icon) top.append(typeof icon === 'string' ? el('span', 'mk-icon', icon) : icon);
    const names = el('div', 'mk-card-names');
    names.append(el('b', mono ? 'mono' : '', title));
    if (sub) names.append(el('small', '', sub));
    top.append(names);
    if (state) top.append(el('span', `pill ${state[0]}`, state[1]));
    node.append(top);
    if (desc) {
      const text = el('p', 'mk-card-desc', desc);
      text.title = desc;
      node.append(text);
    }
    const tags = badges.filter(Boolean);
    if (tags.length > 0) {
      const row = el('div', 'mk-card-tags');
      for (const tag of tags) row.append(typeof tag === 'string' ? el('span', 'chip', tag) : el('span', `chip ${tag[1] || ''}`, tag[0]));
      node.append(row);
    }
    const buttons = actions.filter(Boolean);
    if (buttons.length > 0) {
      const row = el('div', 'mk-card-acts');
      for (const action of buttons) {
        const control = button(`btn ${action.danger ? 'danger' : action.pri ? 'pri' : 'ghost'} sm`, action.label, (event) => {
          event.stopPropagation();
          action.onClick();
        }, action.title);
        if (action.disabled) control.disabled = true;
        row.append(control);
      }
      node.append(row);
    }
    return node;
  }

  function grid(nodes, empty, cls = '') {
    const box = el('div', `mk-grid${cls ? ` ${cls}` : ''}`);
    const list = nodes.filter(Boolean);
    if (list.length === 0) box.append(el('div', 'empty mk-empty', empty || 'ยังไม่มีรายการ'));
    else box.append(...list);
    return box;
  }

  /** A titled block of a tab: heading, one line of what it is, and its buttons on the right. */
  function section(title, lead, actions = []) {
    const head = el('div', 'mk-section');
    const text = el('div', 'mk-section-t');
    text.append(el('h3', '', title));
    if (lead) text.append(el('p', 'hint', lead));
    const right = el('div', 'mk-section-a');
    right.append(...actions.filter(Boolean));
    head.append(text, right);
    return head;
  }

  // ---------- search + filters ----------
  /**
   * The bar above a card list. `chips` are one-of filters ({ key, label, count }); `selects`
   * are extra dropdowns. It calls `onChange` and keeps focus in the search box while typing.
   */
  function filterBar({ query = '', placeholder = 'ค้นหา…', chips = [], active, selects = [], onQuery, onChip, count } = {}) {
    const bar = el('div', 'mk-filter');
    const search = el('input', 'mk-search');
    search.type = 'search';
    search.placeholder = placeholder;
    search.value = query;
    search.oninput = () => onQuery?.(search.value);
    bar.append(search);
    const row = el('div', 'mk-chips');
    for (const chip of chips) {
      const node = button(`chip${chip.key === active ? ' on' : ''}`, chip.count === undefined ? chip.label : `${chip.label} ${chip.count}`, () => onChip?.(chip.key), chip.title);
      row.append(node);
    }
    for (const select of selects) row.append(select);
    if (count) row.append(el('span', 'mk-count', count));
    bar.append(row);
    return { node: bar, search };
  }

  /** A <select> from [value, label] pairs. */
  function select(options, value, onChange) {
    const node = el('select', 'mk-select');
    for (const [key, label] of options) {
      const option = el('option', '', label);
      option.value = key;
      node.append(option);
    }
    node.value = value;
    if (onChange) node.onchange = () => onChange(node.value);
    return node;
  }

  // ---------- import / export ----------
  function download(filename, text, mime = 'application/json') {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = el('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const downloadJson = (filename, data) => download(filename, `${JSON.stringify(data, null, 2)}\n`);

  function pickFiles(accept, multiple = true) {
    return new Promise((resolve) => {
      const input = el('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
      input.hidden = true;
      input.onchange = () => {
        resolve([...(input.files || [])]);
        input.remove();
      };
      document.body.append(input);
      input.click();
    });
  }

  /** Reads JSON files; each file may hold one item or a list, or `{ kind, items }` from an export. */
  async function readJsonItems(files) {
    const items = [];
    for (const file of files) {
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`${file.name}: ไม่ใช่ไฟล์ JSON`);
      }
      if (Array.isArray(data)) items.push(...data);
      else if (data && Array.isArray(data.items)) items.push(...data.items);
      else items.push(data);
    }
    return items;
  }

  /** "นำเข้า" / "ส่งออก" buttons for a tab. `onImport(files)` gets the chosen files. */
  function ioButtons({ accept = '.json,application/json', onImport, onExport, importTitle, exportTitle, multiple = true } = {}) {
    const nodes = [];
    if (onImport) {
      nodes.push(button('btn ghost', '⤓ นำเข้า', async () => {
        const files = await pickFiles(accept, multiple);
        if (files.length === 0) return;
        try {
          await onImport(files);
        } catch (error) {
          M().toast('นำเข้าไม่ได้', error.message || String(error), true);
        }
      }, importTitle || 'นำเข้าจากไฟล์'));
    }
    if (onExport) nodes.push(button('btn ghost', '⤒ ส่งออก', onExport, exportTitle || 'ส่งออกเป็นไฟล์'));
    return nodes;
  }
  const stamp = () => new Date().toISOString().slice(0, 10);

  // ---------- fields ----------
  /**
   * A number box that says what the default is, with ↺ to go back to it. Empty = the default
   * (the provider's own value), so `read()` gives undefined then.
   */
  function numberField({ label, value, def, defText, min, max, step = 'any', hint, whole = false }) {
    const box = el('div', 'mk-num');
    const top = el('div', 'mk-num-top');
    top.append(el('label', '', label));
    const state = el('span', 'mk-num-state');
    top.append(state);
    const row = el('div', 'mk-num-row');
    const input = el('input', 'inp');
    input.type = 'number';
    input.inputMode = whole ? 'numeric' : 'decimal';
    if (min !== undefined) input.min = String(min);
    if (max !== undefined) input.max = String(max);
    input.step = String(whole ? 1 : step);
    input.value = value === undefined || value === null ? '' : String(value);
    const shownDefault = defText || (def === undefined ? 'ตามผู้ให้บริการ' : String(def));
    input.placeholder = `ค่าเริ่มต้น: ${shownDefault}`;
    const reset = button('btn ghost sm mk-reset', '↺', () => {
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, `กลับไปใช้ค่าเริ่มต้น (${shownDefault})`);
    row.append(input, reset);
    const range = [min !== undefined && max !== undefined ? `ช่วง ${min} ถึง ${max}` : '', whole ? 'จำนวนเต็ม' : ''].filter(Boolean).join(' · ');
    const note = el('p', 'hint mk-num-hint', [`ค่าเริ่มต้น ${shownDefault}`, range, hint].filter(Boolean).join(' · '));
    const paint = () => {
      const set = input.value !== '';
      state.textContent = set ? 'ตั้งเอง' : 'ค่าเริ่มต้น';
      state.className = `mk-num-state${set ? ' set' : ''}`;
      reset.disabled = !set;
      const number = Number(input.value);
      const bad = set && (!Number.isFinite(number) || (min !== undefined && number < min) || (max !== undefined && number > max) || (whole && !Number.isInteger(number)));
      input.classList.toggle('bad', bad);
    };
    input.addEventListener('input', paint);
    paint();
    box.append(top, row, note);
    return {
      node: box,
      input,
      /** The number, undefined when left at the default; throws on a value out of range. */
      read() {
        if (input.value === '') return undefined;
        const number = Number(input.value);
        if (!Number.isFinite(number) || (min !== undefined && number < min) || (max !== undefined && number > max) || (whole && !Number.isInteger(number))) {
          throw new Error(`${label}: ${range || 'ค่าไม่ถูกต้อง'}`);
        }
        return number;
      },
      reset() {
        input.value = '';
        paint();
      },
    };
  }

  /** Label + control in one block (the app's own `labelled`, with an optional hint under it). */
  function field(label, control, hint) {
    const box = M().labelled(label, control);
    if (hint) box.append(el('p', 'hint', hint));
    return box;
  }

  /**
   * Picks several items out of a big list (tools of a skill, members…): the chosen ones are
   * small cards with ✕, "+ เพิ่ม" opens a searchable picker. `items` are { value, label, desc, group }.
   */
  function pickerField({ items, chosen = [], addLabel = '+ เพิ่ม', empty = 'ยังไม่ได้เลือก', title = 'เลือก', groups = [] }) {
    let picked = [...chosen];
    const box = el('div', 'mk-picker');
    const list = el('div', 'mk-picked');
    const byValue = new Map(items.map((item) => [item.value, item]));
    const paint = () => {
      list.replaceChildren();
      for (const value of picked) {
        const item = byValue.get(value) || { value, label: value, desc: 'ไม่มีในกองแล้ว' };
        const tag = el('div', `mk-tag${byValue.has(value) ? '' : ' gone'}`);
        const text = el('div');
        text.append(el('b', 'mono', item.label), el('small', '', item.desc || ''));
        tag.title = item.desc || '';
        tag.append(text, button('mk-tag-x', '✕', () => {
          picked = picked.filter((entry) => entry !== value);
          paint();
          box.dispatchEvent(new Event('input', { bubbles: true }));
        }, 'เอาออก'));
        list.append(tag);
      }
      if (picked.length === 0) list.append(el('p', 'hint', empty));
    };
    const add = button('btn ghost', addLabel, () => {
      let query = '';
      let group = 'all';
      const popup = modal({ title, size: 'wide' });
      const draw = () => {
        const needle = query.trim().toLowerCase();
        const visible = items.filter((item) => (group === 'all' || item.group === group) && (!needle || `${item.label} ${item.desc || ''} ${item.group || ''}`.toLowerCase().includes(needle)));
        const cards = visible.slice(0, 300).map((item) => {
          const on = picked.includes(item.value);
          return card({
            title: item.label,
            mono: true,
            desc: item.desc,
            badges: [item.group, ...(item.tags || [])],
            cls: on ? 'chosen' : '',
            onOpen: () => {
              picked = on ? picked.filter((entry) => entry !== item.value) : [...picked, item.value];
              paint();
              box.dispatchEvent(new Event('input', { bubbles: true }));
              draw();
            },
            actions: [{ label: on ? '✓ เลือกแล้ว' : '+ เพิ่ม', pri: !on, onClick: () => {
              picked = on ? picked.filter((entry) => entry !== item.value) : [...picked, item.value];
              paint();
              box.dispatchEvent(new Event('input', { bubbles: true }));
              draw();
            } }],
          });
        });
        const bar = filterBar({
          query,
          placeholder: 'ค้นหาชื่อหรือคำอธิบาย…',
          chips: [{ key: 'all', label: 'ทั้งหมด', count: items.length }, ...groups.map((name) => ({ key: name, label: name, count: items.filter((item) => item.group === name).length }))],
          active: group,
          onQuery: (value) => {
            query = value;
            draw();
            const again = popup.body.querySelector('.mk-search');
            again.focus();
            again.setSelectionRange(again.value.length, again.value.length);
          },
          onChip: (key) => {
            group = key;
            draw();
          },
          count: `เลือกแล้ว ${picked.length} · แสดง ${Math.min(visible.length, 300)}/${visible.length}`,
        });
        popup.setBody([bar.node, grid(cards, 'ไม่พบรายการที่ตรงกับคำค้น', 'dense')]);
      };
      draw();
      popup.dirty = false;
      popup.setFoot([button('btn pri', 'เสร็จ', () => popup.done())]);
    });
    box.append(list, add);
    paint();
    return { node: box, read: () => [...picked] };
  }

  /**
   * A popup that follows a tab's own "selected item" state: each render of the tab calls this
   * again and the popup's content is rebuilt in place (scroll kept). Closing it calls `onClose`,
   * which clears the selection. Used by tabs whose editor is a whole workspace (knowledge base,
   * outfit, background) rather than one form.
   */
  const hosts = new Map();
  function hostPopup(key, { title, sub, size = 'wide', build, onClose }) {
    let host = hosts.get(key);
    if (!host || !document.body.contains(host.popup.node)) {
      const popup = modal({ title, sub, size, onClose: () => {
        hosts.delete(key);
        onClose?.();
      } });
      popup.setFoot([button('btn ghost', 'ปิด', () => popup.done())]);
      host = { popup };
      hosts.set(key, host);
    }
    const scroll = host.popup.body.scrollTop;
    host.popup.setTitle(title);
    host.popup.setBody(build());
    host.popup.body.scrollTop = scroll;
    host.popup.dirty = false;
    return host.popup;
  }
  function closeHost(key) {
    const host = hosts.get(key);
    if (!host) return;
    hosts.delete(key);
    const at = stack.indexOf(host.popup);
    if (at !== -1) stack.splice(at, 1);
    host.popup.node.parentElement?.remove();
  }

  window.MimiKit = { hostPopup, closeHost, modal, ask, confirmDelete, card, grid, section, filterBar, select, download, downloadJson, pickFiles, readJsonItems, ioButtons, stamp, numberField, field, pickerField };
})();
