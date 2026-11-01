// Hub > แพ็ก: ready-made sets of agents, OpenAPI connectors and workflows, installed in one
// go, with a checklist of the credentials each still needs. Packs are data only; the core
// checks and installs them (packages/core/src/packs). Workflows arrive switched off.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const RISK = { shell: 'รันคำสั่ง', delete: 'ลบ' };
  const KIND = { provider: 'โมเดล', connector: 'Connection', google: 'Google', microsoft: 'Microsoft', secret: 'คีย์ลับ' };
  /** { catalog, installed } from the last `packs` message. */
  let packs = null;
  /** { id?, source?, label, reqId, busy, report? } while the review dialog is open. */
  let review = null;
  let reqSeq = 0;

  function checklist(items) {
    const box = el('div', 'tbl');
    for (const item of items || []) {
      const row = el('div');
      row.style.gridTemplateColumns = '22px 90px minmax(0, 1.2fr) minmax(0, 1.4fr)';
      const why = el('span', 'muted', item.why || '');
      if (item.url) {
        const link = el('a', '', ' วิธีขอ');
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        why.append(link);
      }
      row.append(el('span', item.ok ? 'pill ok' : 'pill todo', item.ok ? '✓' : '!'), el('span', 'chip', KIND[item.kind] || item.kind), el('span', '', item.label), why);
      box.append(row);
    }
    return box;
  }

  function openAccounts() {
    M().closeOverlay();
    review = null;
    M().ui.hubTab = 'accounts';
    M().setView('hub');
    M().renderHub();
  }

  function send(install) {
    if (!review || review.busy) return;
    review.busy = true;
    review.reqId = ++reqSeq;
    M().send({ type: install ? 'pack-install' : 'pack-preview', reqId: review.reqId, ...(review.id ? { id: review.id } : { source: review.source }) });
    showReview();
  }

  function openReview(target) {
    review = { ...target, reqId: 0, busy: false, report: null, errors: [], installed: false };
    send(false);
  }

  function showReview() {
    if (!review) return;
    const dialog = el('div', 'dialog wfedit form');
    dialog.append(el('h3', '', review.installed ? `ติดตั้ง ${review.label} แล้ว` : `ติดตั้งแพ็ก: ${review.label}`));
    if (review.busy) dialog.append(el('p', 'hint', 'กำลังตรวจ…'));
    const report = review.report;
    if (report) {
      if (report.agents.length > 0) {
        dialog.append(el('h4', '', 'Agent'));
        for (const agent of report.agents) {
          const details = el('details');
          const summary = el('summary', '', `${agent.displayName} (${agent.name}) · ${agent.action === 'create' ? 'สร้างใหม่' : 'ใช้ตัวที่มีอยู่'} · เครื่องมือ ${agent.tools.length}`);
          details.append(summary);
          if (agent.risky.length > 0) details.append(el('p', 'hint badtxt', `เครื่องมือเสี่ยง: ${agent.risky.map((name) => `${name} (${RISK[name] || 'เสี่ยง'})`).join(', ')}`));
          details.append(el('p', 'hint mono', agent.tools.join(', ') || '—'));
          const prompt = el('pre', 'wjson');
          prompt.textContent = agent.systemPrompt || '(ไม่มี system prompt)';
          details.append(prompt);
          if (agent.risky.length > 0) details.open = true;
          dialog.append(details);
        }
      }
      if (report.connectors.length > 0) {
        dialog.append(el('h4', '', 'Connector (OpenAPI)'));
        for (const connector of report.connectors) {
          dialog.append(el('p', 'hint', `${connector.label} (${connector.key}) · ${connector.operations} operations · ${connector.action === 'import' ? 'นำเข้าใหม่' : 'ใช้ตัวที่มีอยู่'}`));
        }
      }
      if (report.workflows.length > 0) {
        dialog.append(el('h4', '', 'Workflow (บันทึกแบบปิดไว้)'));
        for (const workflow of report.workflows) dialog.append(el('p', 'hint', `${workflow.title} · ${workflow.name} · agent ${workflow.agent} · trigger ${workflow.trigger}`));
      }
      dialog.append(el('h4', '', 'สิ่งที่ต้องตั้งค่าให้ครบ'));
      dialog.append(checklist(report.credentials));
      if (report.credentials.some((item) => !item.ok)) {
        dialog.append(button('btn ghost', 'ไปตั้งค่าบัญชีและ connection', openAccounts));
      }
      for (const warning of report.warnings) dialog.append(el('p', 'hint', warning));
    }
    for (const error of review.errors) dialog.append(el('p', 'hint badtxt', error));
    const foot = el('div', 'foot');
    foot.append(
      el('span', 'msg'),
      button('btn ghost', review.installed ? 'เสร็จ' : 'ปิด', () => {
        review = null;
        M().closeOverlay();
      }),
    );
    if (report && !review.installed && !review.busy && review.errors.length === 0) {
      foot.append(button('btn pri', 'ยืนยันติดตั้ง', () => send(true)));
    }
    if (review.installed) {
      foot.append(
        button('btn pri', 'ไปที่ Workflow', () => {
          review = null;
          M().closeOverlay();
          M().setView('agents');
        }),
      );
    }
    dialog.append(foot);
    M().overlay(dialog);
  }

  function packCard(pack, installed) {
    const card = el('div', 'item');
    const info = el('div');
    const top = el('div', 'hstack');
    top.append(el('b', '', pack.name), el('span', 'badge', pack.builtin ? 'มากับแอป' : 'ไฟล์'), ...(pack.tags || []).map((tag) => el('span', 'chip', tag)));
    info.append(top, el('p', 'hint', pack.description));
    const parts = [
      pack.agents.length ? `agent: ${pack.agents.join(', ')}` : '',
      pack.connectors.length ? `connector: ${pack.connectors.join(', ')}` : '',
      pack.workflows.length ? `workflow: ${pack.workflows.join(', ')}` : '',
    ].filter(Boolean);
    info.append(el('small', 'muted', parts.join(' · ')));
    if (installed) {
      const missing = (pack.credentials || []).filter((item) => !item.ok);
      info.append(el('p', `pill ${missing.length ? 'todo' : 'ok'}`, missing.length ? `ยังขาด ${missing.length} อย่าง` : 'ตั้งค่าครบแล้ว'));
      if (missing.length) info.append(checklist(pack.credentials));
    } else {
      info.append(button('btn', 'ดูและติดตั้ง', () => openReview({ id: pack.id, label: pack.name })));
    }
    card.append(info);
    return card;
  }

  function render() {
    const wrap = el('div', 'stackv');
    if (!packs) {
      M().send({ type: 'packs-list' });
      wrap.append(el('p', 'hint', 'กำลังโหลด…'));
      return wrap;
    }
    const catalog = el('div', 'panel');
    catalog.append(
      el('h3', '', 'แพ็กสำเร็จรูป'),
      el('p', 'hint', 'ชุด agent + connector + workflow ที่ใช้คู่กัน ติดตั้งทีเดียว · ไม่ทับของเดิม (agent/connector ที่มีอยู่จะใช้ตัวเดิม, workflow ชื่อซ้ำได้ชื่อใหม่) · workflow ถูกบันทึกแบบปิดไว้ให้ตรวจก่อนเปิด · แพ็กไม่มี credential ติดมา'),
    );
    for (const pack of packs.catalog) catalog.append(packCard(pack, false));
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.onchange = async () => {
      const picked = file.files && file.files[0];
      if (!picked) return;
      openReview({ source: await picked.text(), label: picked.name });
    };
    catalog.append(M().labelled('ติดตั้งจากไฟล์แพ็ก (.json) — อ่าน system prompt และเครื่องมือในหน้าตรวจก่อนยืนยันทุกครั้ง', file));
    wrap.append(catalog);

    const installed = el('div', 'panel');
    installed.append(el('h3', '', `ติดตั้งแล้ว (${packs.installed.length})`));
    if (packs.installed.length === 0) installed.append(el('p', 'empty', 'ยังไม่ได้ติดตั้งแพ็ก'));
    for (const pack of packs.installed) installed.append(packCard(pack, true));
    installed.append(button('btn ghost', 'ตรวจ checklist อีกครั้ง', () => M().send({ type: 'packs-list' })));
    wrap.append(installed);
    return wrap;
  }

  function onPacks(message) {
    packs = { catalog: message.catalog || [], installed: message.installed || [] };
    if (M().state.view === 'hub' && M().ui.hubTab === 'packs') M().renderHub();
  }

  function onReport(message) {
    if (!review || message.reqId !== review.reqId) return;
    review.busy = false;
    review.report = message.report || null;
    review.errors = message.errors || [];
    if (message.action === 'install' && message.report) {
      review.installed = true;
      M().toast(`ติดตั้ง ${review.label} แล้ว`, review.errors.length ? 'บางส่วนไม่สำเร็จ ดูรายละเอียดในหน้าต่าง' : 'workflow ยังปิดอยู่ ตรวจแล้วเปิดที่หน้า Workflow', review.errors.length > 0);
    }
    showReview();
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.packs = { render, onPacks, onReport };
})();
