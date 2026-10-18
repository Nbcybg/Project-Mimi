// Hub → คลังความรู้: knowledge bases that agents search with knowledge_search and
// workflows with the knowledge node. Keyword search (SQLite FTS5 trigram, fine for
// Thai) always works; an embedding model adds meaning-based search.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const SUGGESTED_MODEL = 'google/gemini-embedding-001';
  let selected = null; // collection name, or '' for the "new" form
  let documents = [];
  let results = null;
  let adding = false;
  let embedding = false;

  const collections = () => M().state.knowledge || [];
  const hasGoogle = () => ((M().state.settings && M().state.settings.models) || []).some((model) => String(model.ref).startsWith('google/'));

  function rerender() {
    if (M().state.view === 'hub' && M().ui.hubTab === 'knowledge') M().renderHub();
  }

  function select(name) {
    selected = name;
    documents = [];
    results = null;
    if (name) M().send({ type: 'knowledge-documents', collection: name });
    rerender();
  }

  function render() {
    if (!M().state.knowledgeLoaded) {
      M().state.knowledgeLoaded = true;
      M().send({ type: 'knowledge-list' });
    }
    const wrap = el('div', 'split kbsplit');
    wrap.append(listPanel(), selected === null ? introPanel() : editorPanel());
    return wrap;
  }

  function listPanel() {
    const panel = el('div', 'panel');
    panel.append(el('h3', '', 'คลังความรู้'));
    const list = el('div', 'list');
    for (const entry of collections()) {
      const item = button(`item${entry.name === selected ? ' on' : ''}`, '', () => select(entry.name));
      const text = el('div');
      text.append(el('b', '', entry.title), el('small', 'muted', ` · ${entry.documents} เอกสาร · ${entry.embeddingModel ? 'ค้นแบบความหมาย + คำ' : 'ค้นด้วยคำ'}`));
      item.append(text);
      list.append(item);
    }
    if (collections().length === 0) list.append(el('p', 'hint', 'ยังไม่มีคลัง'));
    panel.append(list, button('btn', '+ สร้างคลังใหม่', () => select('')));
    return panel;
  }

  function introPanel() {
    const panel = el('div', 'panel');
    panel.append(
      el('h3', '', 'คลังความรู้ทำอะไร'),
      el('p', 'hint', 'ใส่เอกสาร โน้ต คู่มือ หรือหน้าเว็บไว้ที่นี่ แล้ว agent จะค้นเจอเองเมื่อมีเครื่องมือ knowledge_search (ติ๊กในหน้า Agent) · workflow ใช้ node "คลังความรู้" ค้นแล้วส่ง context ให้ LLM ได้'),
      el('p', 'hint', 'ค้นด้วยคำใช้ได้เสมอ (ภาษาไทยไม่ต้องเว้นวรรค) · ถ้าตั้ง embedding model เช่น google/gemini-embedding-001 จะค้นตามความหมายด้วย'),
    );
    return panel;
  }

  function editorPanel() {
    const isNew = selected === '';
    const entry = collections().find((item) => item.name === selected) || { name: '', title: '', description: '', embeddingModel: null, documents: 0, chunks: 0, embedded: 0 };
    const panel = el('div', 'panel form');
    panel.append(el('h3', '', isNew ? 'คลังใหม่' : entry.title));

    const name = M().textInput(entry.name, 'เช่น household, manuals');
    name.readOnly = !isNew;
    const title = M().textInput(entry.title === entry.name ? '' : entry.title, 'ชื่อที่แสดง');
    const description = M().textInput(entry.description, 'เก็บอะไร (ช่วย agent เลือกคลังถูก)');
    const model = M().textInput(entry.embeddingModel || '', 'ว่าง = ค้นด้วยคำอย่างเดียว');
    const grid = el('div', 'grid2');
    grid.append(M().labelled('ชื่อ (a-z 0-9 - _)', name), M().labelled('ชื่อที่แสดง', title));
    panel.append(grid, M().labelled('คำอธิบาย', description), M().labelled('embedding model (ไม่บังคับ)', model));
    const modelHint = el('p', 'hint');
    if (hasGoogle()) {
      modelHint.append(`เชื่อม Google ไว้แล้ว ใช้ ${SUGGESTED_MODEL} ได้ `, button('wpick', 'ใส่ให้', () => {
        model.value = SUGGESTED_MODEL;
      }));
    } else {
      modelHint.textContent = 'ยังไม่ได้เชื่อม Google: ค้นด้วยคำได้เลย ถ้าจะค้นตามความหมาย ให้เชื่อม Google (API key) ที่หน้าตั้งค่าก่อน';
    }
    panel.append(modelHint);
    const foot = el('div', 'hstack');
    foot.append(
      button('btn pri', isNew ? 'สร้างคลัง' : 'บันทึก', () => {
        M().send({ type: 'knowledge-save', collection: { name: name.value.trim(), title: title.value, description: description.value, embeddingModel: model.value.trim() || null } });
        if (isNew) selected = name.value.trim().toLowerCase();
      }),
    );
    if (!isNew) {
      if (entry.embeddingModel && entry.embedded < entry.chunks) {
        foot.append(
          button('btn', embedding ? 'กำลังทำ vector…' : `ทำ vector ที่ขาด (${entry.chunks - entry.embedded})`, () => {
            if (embedding) return;
            embedding = true;
            M().send({ type: 'knowledge-embed', collection: entry.name });
            rerender();
          }),
        );
      }
      foot.append(
        button('btn danger', 'ลบคลัง', () => {
          if (!confirm(`ลบคลัง "${entry.title}" และเอกสารทั้งหมดในนั้น?`)) return;
          M().send({ type: 'knowledge-delete', name: entry.name });
          select(null);
        }),
      );
      const stats = el('p', 'hint', `${entry.documents} เอกสาร · ${entry.chunks} ชิ้น${entry.embeddingModel ? ` · มี vector ${entry.embedded}/${entry.chunks}` : ''}`);
      panel.append(foot, stats, addSection(entry), documentsSection(entry), searchSection(entry));
    } else {
      panel.append(foot);
    }
    return panel;
  }

  function addSection(entry) {
    const box = el('div', 'kbadd');
    box.append(el('h4', '', 'เพิ่มเอกสาร'));
    const tabs = el('div', 'tabs');
    const body = el('div');
    const mode = { value: 'text' };
    const modes = [
      ['text', 'พิมพ์ / วาง'],
      ['file', 'อัปโหลดไฟล์'],
      ['path', 'ไฟล์ในเครื่อง'],
      ['url', 'ลิงก์เว็บ'],
    ];
    const draw = () => {
      tabs.textContent = '';
      for (const [key, label] of modes) {
        tabs.append(button(key === mode.value ? 'on' : '', label, () => {
          mode.value = key;
          draw();
        }));
      }
      body.textContent = '';
      const title = M().textInput('', 'ชื่อเอกสาร (เว้นว่างได้)');
      body.append(M().labelled('ชื่อเอกสาร', title));
      let read;
      if (mode.value === 'text') {
        const text = el('textarea');
        text.placeholder = 'วางเนื้อหาที่นี่';
        text.style.minHeight = '120px';
        body.append(M().labelled('เนื้อหา', text));
        read = async () => ({ text: text.value });
      } else if (mode.value === 'file') {
        const input = el('input');
        input.type = 'file';
        input.accept = '.txt,.md,.csv,.json,.html,.htm,.pdf,.png,.jpg,.jpeg,.webp,.mp3,.m4a,.wav,.ogg';
        body.append(M().labelled('ไฟล์ (ข้อความ / PDF / รูป / เสียง, ไม่เกิน 25 MB)', input), el('p', 'hint', 'PDF รูป และเสียง ให้ model ของ agent หลักอ่านก่อน (มีค่าใช้จ่ายตาม model)'));
        read = async () => {
          const file = input.files && input.files[0];
          if (!file) throw new Error('เลือกไฟล์ก่อน');
          const response = await M().api(`/api/upload?name=${encodeURIComponent(file.name)}`, {
            method: 'POST',
            headers: { 'content-type': file.type || 'application/octet-stream' },
            body: file,
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
          return { attachmentId: result.id };
        };
      } else if (mode.value === 'path') {
        const input = M().textInput('', 'เช่น docs/คู่มือแอร์.pdf (ในโฟลเดอร์ที่อนุญาต)');
        body.append(M().labelled('path', input));
        read = async () => ({ path: input.value });
      } else {
        const input = M().textInput('', 'https://…');
        body.append(M().labelled('ลิงก์', input));
        read = async () => ({ url: input.value });
      }
      body.append(
        button('btn pri', adding ? 'กำลังเพิ่ม…' : 'เพิ่มเข้าคลัง', async () => {
          if (adding) return;
          try {
            const source = await read();
            adding = true;
            rerender();
            M().send({ type: 'knowledge-add', collection: entry.name, title: title.value, ...source });
          } catch (error) {
            adding = false;
            M().toast('เพิ่มไม่ได้', error.message, true);
          }
        }),
      );
    };
    draw();
    box.append(tabs, body);
    return box;
  }

  function documentsSection(entry) {
    const box = el('div');
    box.append(el('h4', '', `เอกสาร (${documents.length})`));
    const rows = el('div', 'tbl kbdocs');
    for (const doc of documents) {
      const row = el('div');
      const name = el('span', 'nm2');
      name.append(el('b', '', doc.title), el('small', 'muted', doc.source ? ` · ${doc.source}` : ''));
      row.append(
        name,
        el('span', 'faint', `${doc.chunks} ชิ้น · ${doc.chars.toLocaleString()} ตัวอักษร`),
        el('span', 'faint', M().fmtDate(doc.createdAt)),
        button('btn ghost', 'ลบ', () => {
          if (confirm(`ลบ "${doc.title}" ออกจากคลัง?`)) M().send({ type: 'knowledge-remove-document', collection: entry.name, id: doc.id });
        }),
      );
      rows.append(row);
    }
    if (documents.length === 0) rows.append(el('div', 'empty', 'ยังไม่มีเอกสาร'));
    box.append(rows);
    return box;
  }

  function searchSection(entry) {
    const box = el('div');
    box.append(el('h4', '', 'ลองค้น'));
    const query = M().textInput(results ? results.query : '', 'พิมพ์คำถาม เช่น ค่าไฟเดือนนี้เท่าไหร่');
    const go = () => {
      if (query.value.trim()) M().send({ type: 'knowledge-search', collection: entry.name, query: query.value.trim() });
    };
    query.onkeydown = (event) => {
      if (event.key === 'Enter') go();
    };
    const row = el('div', 'hstack');
    query.style.flex = '1';
    row.append(query, button('btn', 'ค้น', go));
    box.append(row);
    if (results) {
      if (results.hits.length === 0) box.append(el('p', 'hint', 'ไม่พบ'));
      for (const hit of results.hits) {
        const card = el('div', 'kbhit');
        const head = el('div', 'hstack');
        head.append(el('b', '', hit.document), el('span', 'chip', hit.via === 'both' ? 'คำ + ความหมาย' : hit.via === 'vector' ? 'ความหมาย' : 'คำ'), el('span', 'faint', `score ${hit.score}`));
        const text = el('div', 'kbtext', hit.text.length > 600 ? `${hit.text.slice(0, 600)}…` : hit.text);
        card.append(head, text);
        box.append(card);
      }
    }
    return box;
  }

  function onMessage(message) {
    switch (message.type) {
      case 'knowledge':
        M().state.knowledge = message.collections || [];
        if (message.saved && selected === message.saved) M().send({ type: 'knowledge-documents', collection: message.saved });
        if (message.saved) M().toast('บันทึกแล้ว ✓');
        rerender();
        break;
      case 'knowledge-documents':
        if (message.collection === selected) {
          documents = message.documents || [];
          rerender();
        }
        break;
      case 'knowledge-added':
        adding = false;
        M().toast(message.warning ? 'เพิ่มแล้ว (ค้นด้วยคำอย่างเดียว)' : 'เพิ่มเข้าคลังแล้ว ✓', message.warning || `${message.chunks} ชิ้น`, Boolean(message.warning));
        rerender();
        break;
      case 'knowledge-results':
        results = { query: message.query, hits: message.hits || [] };
        rerender();
        break;
      case 'knowledge-embedded':
        embedding = false;
        M().toast('ทำ vector แล้ว ✓', `${message.count} ชิ้น`);
        rerender();
        break;
      case 'error':
        // A failed add / embed must not leave the buttons stuck.
        if (adding || embedding) {
          adding = false;
          embedding = false;
          rerender();
        }
        break;
    }
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.knowledge = { render, onMessage };
})();
