// Situation gallery. Each agent has its own pictures (hundreds to thousands); one of them
// can lie over the chat like an event picture of a visual novel. The agent puts it there
// with gallery_show (or the user with "แสดงในแชต"); the user can minimise or close it.
// Also the manager used in the agent editor: search, paging, bulk upload, edit, delete.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);
  const enc = encodeURIComponent;

  // ---------- the overlay ----------
  // Per agent: which picture the user last dealt with and how ('open' | 'min' | 'closed'),
  // so a minimised picture stays minimised until the agent shows a different one.
  const KEY = 'mimi.cg';
  const modes = (() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    } catch {
      return {};
    }
  })();
  const saveModes = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(modes));
    } catch {
      // private window: the choice lasts until reload
    }
  };

  let shown = ''; // path of the picture on screen
  let shownMode = '';

  function apply() {
    const stage = document.getElementById('stage');
    const wrap = document.getElementById('cg');
    if (!stage || !wrap) return;
    const chat = M().state.chat;
    const agent = chat && chat.kind === 'direct' ? M().agentOf(chat.agents[0]) : null;
    const id = agent && agent.status && agent.status.situation;
    if (!id) {
      wrap.hidden = true;
      wrap.replaceChildren();
      shown = '';
      shownMode = '';
      return;
    }
    const entry = modes[agent.name];
    // A different picture than the one the user dealt with starts open again.
    const mode = entry && entry.id === id ? entry.mode : 'open';
    const path = `/api/gallery/${enc(agent.name)}/${enc(id)}`;
    const thumbPath = `${path}/thumb`;
    if (shown === path && shownMode === mode) return;
    const fresh = shown !== path;
    shown = path;
    shownMode = mode;
    wrap.hidden = false;
    wrap.dataset.mode = mode;

    const setMode = (next) => {
      modes[agent.name] = { id, mode: next };
      saveModes();
      shownMode = '';
      apply();
    };
    const controls = el('div', 'cgctl');
    if (mode === 'open') {
      controls.append(button('btn ghost', '–', () => setMode('min'), 'ย่อภาพ'), button('btn ghost', '×', () => setMode('closed'), 'ปิดภาพ'));
    } else if (mode === 'min') {
      controls.append(button('btn ghost', '▢', () => setMode('open'), 'ขยายภาพ'), button('btn ghost', '×', () => setMode('closed'), 'ปิดภาพ'));
    } else {
      controls.append(button('btn ghost cgreopen', '🖼', () => setMode('open'), 'แสดงภาพสถานการณ์อีกครั้ง'));
    }

    const children = [];
    if (mode !== 'closed') {
      const image = el('img', `cgimg${fresh ? ' cg-in' : ''}`);
      image.alt = '';
      children.push(image);
      M()
        .blobUrl(mode === 'min' ? thumbPath : path)
        .then((url) => {
          if (shown === path) image.src = url;
        })
        .catch(() => {});
      if (mode === 'min') image.onclick = () => setMode('open');
    }
    wrap.replaceChildren(...children, controls);
  }

  // ---------- the manager ----------
  const PAGE = 48;
  const managers = new Map(); // agent name -> { query, offset, total, items, selected, uploading, node, redraw }

  function thumbBlob(agentName, item) {
    return M().blobUrl(`/api/gallery/${enc(agentName)}/${enc(item.id)}/thumb?t=${item.thumb ? 1 : 0}`);
  }

  /** A JPEG preview of an image file, at most 256 px on the long side. */
  async function makeThumb(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  }

  function manager(agentName) {
    const state = { query: '', offset: 0, total: 0, items: [], selected: null, uploading: '' };
    managers.set(agentName, state);
    const box = el('div', 'gallery');
    state.node = box;

    const request = () => M().send({ type: 'gallery-list', agent: agentName, query: state.query, offset: state.offset, limit: PAGE });

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          const item = state.items.find((candidate) => candidate.id === entry.target.dataset.id);
          if (!item) continue;
          thumbBlob(agentName, item)
            .then((url) => {
              const image = el('img');
              image.src = url;
              entry.target.replaceChildren(image);
            })
            .catch(() => {});
        }
      },
      { rootMargin: '200px' },
    );

    async function upload(files) {
      const images = [...files].filter((file) => /^image\/(png|jpeg|webp|gif)$/.test(file.type));
      if (images.length === 0) return M().toast('ไม่พบรูป', 'ใช้ PNG, JPEG, WebP หรือ GIF', true);
      let done = 0;
      let failed = 0;
      for (const file of images) {
        state.uploading = `กำลังอัปโหลด ${done + 1}/${images.length}`;
        draw();
        try {
          const title = file.name.replace(/\.[^.]+$/, '');
          const response = await M().api(`/api/gallery/${enc(agentName)}?title=${enc(title)}`, { method: 'POST', headers: { 'content-type': file.type }, body: file });
          if (!response.ok) throw new Error((await response.json()).error);
          const item = await response.json();
          try {
            const thumb = await makeThumb(file);
            if (thumb) await M().api(`/api/gallery/${enc(agentName)}/${enc(item.id)}/thumb`, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: thumb });
          } catch {
            // no preview: the grid shows the picture itself
          }
        } catch (error) {
          failed++;
          M().toast(`อัปโหลด ${file.name} ไม่สำเร็จ`, String(error.message || error), true);
        }
        done++;
      }
      state.uploading = '';
      state.offset = 0;
      request();
      M().toast(`เพิ่มรูปแล้ว ${images.length - failed} รูป`, failed ? `ไม่สำเร็จ ${failed}` : '', failed > 0);
    }

    function draw() {
      const children = [];
      const head = el('div', 'hstack');
      const search = M().textInput(state.query, 'ค้นหาจากชื่อ แท็ก คำอธิบาย');
      search.style.flex = '1';
      let timer = null;
      search.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          state.query = search.value.trim();
          state.offset = 0;
          request();
        }, 300);
      };
      const choose = el('input');
      choose.type = 'file';
      choose.accept = 'image/png,image/jpeg,image/webp,image/gif';
      choose.multiple = true;
      choose.hidden = true;
      choose.onchange = () => {
        const files = [...choose.files];
        choose.value = '';
        upload(files);
      };
      head.append(search, button('btn', 'เพิ่มรูป (เลือกได้หลายไฟล์)', () => choose.click()), choose);
      children.push(head);

      const info = el('div', 'faint', state.uploading || `${state.total.toLocaleString()} รูป${state.query ? ` ที่ตรงกับ "${state.query}"` : ''}`);
      children.push(info);

      const grid = el('div', 'gagrid');
      for (const item of state.items) {
        const tile = button(`gatile${item.id === state.selected ? ' on' : ''}`, '', () => {
          state.selected = item.id === state.selected ? null : item.id;
          draw();
        }, item.title);
        const frame = el('div', 'gaimg');
        frame.dataset.id = item.id;
        tile.append(frame, el('span', 'gatitle', item.title));
        grid.append(tile);
        observer.observe(frame);
      }
      if (state.items.length === 0) grid.append(el('p', 'hint', state.query ? 'ไม่พบรูปที่ตรงกัน' : 'ยังไม่มีรูป เพิ่มรูปเพื่อให้ agent เลือกใช้ตามสถานการณ์'));
      children.push(grid);

      const pages = el('div', 'hstack');
      pages.append(
        button('btn ghost', '‹ ก่อนหน้า', () => {
          state.offset = Math.max(0, state.offset - PAGE);
          request();
        }),
        el('span', 'faint', `${state.total === 0 ? 0 : state.offset + 1}–${Math.min(state.total, state.offset + PAGE)} จาก ${state.total}`),
        button('btn ghost', 'ถัดไป ›', () => {
          if (state.offset + PAGE < state.total) {
            state.offset += PAGE;
            request();
          }
        }),
      );
      if (state.total > PAGE) children.push(pages);

      const selected = state.items.find((item) => item.id === state.selected);
      if (selected) children.push(detail(selected));
      box.replaceChildren(...children);
    }

    function detail(item) {
      const panel = el('div', 'gadetail');
      const preview = el('div', 'gapreview');
      M()
        .blobUrl(`/api/gallery/${enc(agentName)}/${enc(item.id)}`)
        .then((url) => {
          const image = el('img');
          image.src = url;
          preview.replaceChildren(image);
        })
        .catch(() => {});
      const title = M().textInput(item.title, 'ชื่อภาพ');
      const tags = M().textInput(item.tags.join(', '), 'แท็ก คั่นด้วย , เช่น ฝน, คาเฟ่');
      const description = el('textarea');
      description.value = item.description;
      description.placeholder = 'อธิบายว่าภาพนี้เหมาะกับสถานการณ์ไหน (agent อ่านข้อความนี้เพื่อเลือกภาพ)';
      const form = el('div', 'form');
      form.append(
        el('b', '', `${item.id} · ${item.source === 'agent' ? 'agent เพิ่มเอง' : 'ผู้ใช้เพิ่ม'}`),
        M().labelled('ชื่อ', title),
        M().labelled('แท็ก', tags),
        M().labelled('คำอธิบาย', description),
      );
      const row = el('div', 'row');
      const onShow = M().agentOf(agentName) && M().agentOf(agentName).status && M().agentOf(agentName).status.situation === item.id;
      row.append(
        button('btn primary', 'บันทึก', () =>
          M().send({ type: 'gallery-update', agent: agentName, id: item.id, title: title.value, tags: tags.value.split(/[,،、]/).map((tag) => tag.trim()).filter(Boolean), description: description.value }),
        ),
        button('btn', onShow ? 'เอาออกจากแชต' : 'แสดงในแชต', () => M().send({ type: 'status-set', agent: agentName, key: 'situation', value: onShow ? '' : item.id })),
        button('btn ghost', 'ลบภาพ', () => {
          if (confirm(`ลบภาพ "${item.title}" (${item.id})?`)) {
            state.selected = null;
            M().send({ type: 'gallery-delete', agent: agentName, id: item.id });
          }
        }),
      );
      form.append(row);
      panel.append(preview, form);
      return panel;
    }

    state.redraw = draw;
    state.request = request;
    draw();
    request();
    return box;
  }

  function onMessage(message) {
    const state = managers.get(message.agent);
    if (message.type === 'gallery') {
      if (!state || !state.node.isConnected) return;
      if (message.query !== state.query || message.offset !== state.offset) return; // an older answer
      state.items = message.items;
      state.total = message.total;
      state.redraw();
    } else if (message.type === 'gallery-changed') {
      if (state && state.node.isConnected) state.request();
      apply();
    }
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.gallery = { apply, manager, onMessage };
})();
