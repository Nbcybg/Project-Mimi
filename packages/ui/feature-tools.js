// Hub → Node & เครื่องมือ: one card grid for everything a workflow can place or an agent can
// call — workflow node types, the user's node presets, tools (built-in, custom, MCP) and
// connector services. A filter bar picks the kind; details and editors open in popups.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const Kit = () => window.MimiKit;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  let query = '';
  let kind = 'all';
  let group = 'all';
  let shownLimit = 60;

  function select(options, value) {
    const node = el('select');
    for (const option of options) {
      const entry = el('option', '', option);
      entry.value = option;
      node.append(entry);
    }
    node.value = value;
    return node;
  }
  function textarea(value, placeholder, cls) {
    const node = el('textarea', cls || '');
    node.value = value || '';
    node.placeholder = placeholder || '';
    return node;
  }
  const usersOf = (name) =>
    M().state.agents.filter((agent) => agent.tools.includes(name)).map((agent) => M().nameOf(agent.name));
  const NODE_GROUPS = [
    { label: 'AI', icon: '✦', types: ['agent', 'llm', 'classify', 'extract', 'knowledge'] },
    { label: 'ทางแยก', icon: '⑂', types: ['if', 'switch', 'filter', 'merge'] },
    { label: 'ข้อมูล', icon: '{}', types: ['set', 'datetime', 'split_out', 'sort', 'limit', 'aggregate', 'remove_duplicates', 'code'] },
    { label: 'ไฟล์', icon: '▤', types: ['file', 'extract_file', 'sheets'] },
    { label: 'วน / รอ', icon: '↻', types: ['loop', 'workflow', 'wait', 'stop', 'approval'] },
    { label: 'เชื่อมต่อ', icon: '⇄', types: ['http', 'tool', 'chat', 'telegram', 'respond', 'connector', 'mcp', 'notify', 'agent_call'] },
  ];
  const groupOf = (type) => {
    if (String(type).startsWith('trigger')) return 'ทริกเกอร์';
    return NODE_GROUPS.find((entry) => entry.types.includes(type))?.label || 'อื่น ๆ';
  };
  const iconOf = (type) => (String(type).startsWith('trigger') ? '⚡' : NODE_GROUPS.find((entry) => entry.types.includes(type))?.icon || '•');
  const specOf = (type) => (M().state.nodeTypes || []).find((entry) => entry.type === type);

  // ---------- node presets ----------
  // A node preset is a workflow node with its settings filled in (e.g. "อ่านเมลงาน" = the mail
  // trigger + the work mailbox + a search). They live in the shared screen settings, so every
  // device of the account sees them, and the workflow canvas lists them in its node library.
  const PRESET_PREFIX = 'mimi.nodePreset.';
  const PRESET_LIMIT = 3900;
  const nodePresets = {
    list() {
      const out = [];
      try {
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (!key || !key.startsWith(PRESET_PREFIX)) continue;
          try {
            const value = JSON.parse(localStorage.getItem(key));
            if (value && typeof value.type === 'string') out.push({ ...value, id: key.slice(PRESET_PREFIX.length), config: value.config || {} });
          } catch {
            // a broken entry is skipped, not fatal
          }
        }
      } catch {
        // storage blocked: no presets on this device
      }
      return out.sort((a, b) => String(a.title).localeCompare(String(b.title)));
    },
    save(preset) {
      const id = preset.id || `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const value = JSON.stringify({ title: preset.title, description: preset.description || '', type: preset.type, config: preset.config || {}, updatedAt: new Date().toISOString() });
      if (value.length > PRESET_LIMIT) throw new Error(`preset ใหญ่เกินไป (${value.length} ตัวอักษร, สูงสุด ${PRESET_LIMIT})`);
      localStorage.setItem(PRESET_PREFIX + id, value);
      M().syncUi({ [PRESET_PREFIX + id]: value });
      return id;
    },
    remove(id) {
      localStorage.removeItem(PRESET_PREFIX + id);
      M().syncUi({ [PRESET_PREFIX + id]: null });
    },
  };
  window.MimiNodePresets = nodePresets;

  /** Account choices for an `account` field (OAuth accounts and mailboxes). */
  function accountOptions(service) {
    const settings = M().state.settings || {};
    const mail = (settings.mailAccounts || []).map((account) => ({ ...account, service: 'mail' }));
    return [...(settings.accounts || []), ...mail]
      .filter((account) => !service || account.service === service)
      .map((account) => [account.id, `${account.name || account.id}${account.default ? ' ★' : ''}${account.connected === false ? ' (ยังไม่เชื่อมต่อ)' : ''}`]);
  }

  /** A form for a node type's fields; keys it does not show (set in the canvas) are kept. */
  function configForm(spec, config) {
    const box = el('div');
    const readers = {};
    for (const field of spec.fields || []) {
      const value = config[field.key];
      let control;
      if (field.type === 'boolean') {
        const wrap = el('label', 'wcheck');
        const check = el('input');
        check.type = 'checkbox';
        check.checked = value === true || value === 'true';
        wrap.append(check, el('span', '', field.label));
        box.append(wrap);
        readers[field.key] = () => (check.checked ? true : undefined);
        continue;
      }
      if (field.type === 'account') {
        control = Kit().select([['', '— บัญชีเริ่มต้น —'], ...accountOptions(field.service)], String(value ?? ''));
        readers[field.key] = () => control.value || undefined;
      } else if (Array.isArray(field.options)) {
        const options = field.options.map((option) => (Array.isArray(option) ? [option[0], option[1] ?? option[0]] : option && typeof option === 'object' ? [option.value, option.label || option.value] : [option, option]));
        control = Kit().select([['', '— ไม่ระบุ —'], ...options], String(value ?? ''));
        readers[field.key] = () => control.value || undefined;
      } else if (field.type === 'text' || field.type === 'json' || field.type === 'expression') {
        control = textarea(field.type === 'json' && value !== undefined && typeof value !== 'string' ? JSON.stringify(value, null, 2) : String(value ?? ''), field.placeholder || '');
        control.style.minHeight = '64px';
        readers[field.key] = () => {
          if (!control.value.trim()) return undefined;
          if (field.type !== 'json') return control.value;
          try {
            return JSON.parse(control.value);
          } catch {
            throw new Error(`${field.label}: ไม่ใช่ JSON ที่ถูกต้อง`);
          }
        };
      } else {
        control = M().textInput(value ?? '', field.placeholder || '', field.type === 'number' ? 'number' : 'text');
        readers[field.key] = () => (control.value === '' ? undefined : field.type === 'number' ? Number(control.value) : control.value);
      }
      box.append(Kit().field(`${field.label}${field.required ? ' *' : ''}`, control, field.description));
    }
    if ((spec.fields || []).length === 0) box.append(el('p', 'hint', 'node นี้ไม่มีช่องตั้งค่าในฟอร์ม — ตั้งค่าในหน้าผังแล้วกด "บันทึกเป็น preset" หรือแก้ JSON ด้านล่าง'));
    const advanced = el('details');
    advanced.append(el('summary', 'hint', 'ขั้นสูง: แก้ค่าทั้งหมดเป็น JSON'));
    const raw = textarea(JSON.stringify(config, null, 2), '{}');
    raw.style.minHeight = '120px';
    let rawTouched = false;
    raw.oninput = () => {
      rawTouched = true;
    };
    advanced.append(raw, el('p', 'hint', 'ถ้าแก้ช่องนี้ ค่าที่นี่จะถูกใช้แทนฟอร์มด้านบน'));
    box.append(advanced);
    return {
      node: box,
      read() {
        if (rawTouched) {
          try {
            const parsed = JSON.parse(raw.value || '{}');
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            return parsed;
          } catch {
            throw new Error('JSON ขั้นสูงไม่ถูกต้อง (ต้องเป็น object)');
          }
        }
        const out = { ...config };
        for (const [key, read] of Object.entries(readers)) {
          const value = read();
          if (value === undefined) delete out[key];
          else out[key] = value;
        }
        return out;
      },
    };
  }

  /** Create or edit a node preset. `start` = { type } for a new one, or an existing preset. */
  function presetEditor(start) {
    const editing = start && start.id ? start : null;
    let type = start?.type || '';
    const types = (M().state.nodeTypes || []).filter((spec) => spec.type !== 'trigger_custom');
    const title = M().textInput(editing ? editing.title : '', 'เช่น อ่านเมลงาน, ถาม AI แบบสั้น');
    const description = M().textInput(editing ? editing.description : '', 'ไว้ทำอะไร (ไม่บังคับ)');
    const typeSelect = Kit().select(
      [['', '— เลือกชนิด node —'], ...types.map((spec) => [spec.type, `${groupOf(spec.type)} · ${spec.label}`])],
      type,
    );
    typeSelect.disabled = Boolean(editing);
    const formBox = el('div');
    let form = null;
    const paintForm = () => {
      const spec = specOf(type);
      form = spec ? configForm(spec, editing && editing.type === type ? editing.config : start?.config || {}) : null;
      formBox.replaceChildren(spec ? Kit().section('ค่าที่ตั้งไว้ล่วงหน้า', spec.description, []) : el('p', 'hint', 'เลือกชนิด node ก่อน'), ...(form ? [form.node] : []));
      if (spec && !title.value) title.placeholder = `เช่น ${spec.label} ของฉัน`;
    };
    typeSelect.onchange = () => {
      type = typeSelect.value;
      paintForm();
    };
    paintForm();
    const top = el('div', 'mk-grid2');
    top.append(Kit().field('ชนิด node', typeSelect), Kit().field('ชื่อ preset', title));
    const popup = Kit().modal({
      title: editing ? `แก้ไข node preset: ${editing.title}` : 'สร้าง node preset',
      sub: 'preset = node ที่ตั้งค่าไว้แล้ว · ลากจากกลุ่ม "Preset ของฉัน" ในหน้าผัง workflow มาวางได้เลย',
      size: 'wide',
      body: [top, Kit().field('คำอธิบาย', description), formBox],
    });
    popup.setFoot(
      [
        button('btn ghost', 'ยกเลิก', () => popup.close()),
        button('btn pri', 'บันทึก', () => {
          if (!type) return M().toast('ยังไม่ได้เลือกชนิด node', null, true);
          if (!title.value.trim()) return M().toast('ยังไม่ได้ตั้งชื่อ', null, true);
          try {
            nodePresets.save({ id: editing?.id, title: title.value.trim(), description: description.value.trim(), type, config: form ? form.read() : {} });
          } catch (error) {
            return M().toast('บันทึกไม่ได้', error.message, true);
          }
          popup.done();
          M().toast(`บันทึก preset "${title.value.trim()}" แล้ว ✓`);
          rerender();
        }),
      ],
      editing ? [button('btn danger', 'ลบ', () => deletePreset(editing, popup)), button('btn ghost', 'ส่งออก', () => exportPresets([editing]))] : [],
    );
  }

  async function deletePreset(preset, popup) {
    if (!(await Kit().confirmDelete(`node preset "${preset.title}"`, 'workflow ที่วาง node จาก preset นี้ไปแล้วไม่ได้รับผลกระทบ'))) return;
    nodePresets.remove(preset.id);
    popup?.done();
    M().toast(`ลบ preset "${preset.title}" แล้ว`);
    rerender();
  }

  const exportPresets = (list) =>
    Kit().downloadJson(`mimi-node-presets-${Kit().stamp()}.json`, { kind: 'mimi-node-presets', version: 1, items: list.map(({ id, ...rest }) => rest) });

  // ---------- connectors ----------
  const RISK_LABEL = { read: 'อ่าน', write: 'เขียน', delete: 'ลบ', shell: 'shell', network: 'เน็ต' };
  const connectors = () => M().state.connectors || [];
  const connections = () => M().state.connections || [];
  const sourceOf = (spec) => (spec.category === 'imported' ? 'openapi' : 'native');
  const sourceLabel = (spec) => (sourceOf(spec) === 'openapi' ? 'นำเข้า OpenAPI' : 'ในตัว');
  const isGoogleConnector = (spec) =>
    spec.auth.kind === 'oauth2' && String(spec.auth.authorizeUrl || '').includes('accounts.google.com');
  const googleConnected = () =>
    ((M().state.settings || {}).accounts || []).some((account) => account.service === 'google' && account.connected);
  const authLabelOf = (spec) => (spec.auth.kind === 'none' ? 'ไม่ต้องใช้ credential' : spec.auth.kind);
  const initialsOf = (label) =>
    String(label || '?')
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0] || '')
      .join('')
      .toUpperCase() || '?';
  const openAccounts = () => {
    for (const scrim of document.querySelectorAll('#overlay .mk-scrim')) scrim.remove();
    M().ui.hubTab = 'accounts';
    M().setView('hub');
    M().renderHub();
  };
  /** Google services sign in with a Google account; the rest get a connection popup right here. */
  function setupConnector(spec) {
    const accounts = window.MimiHooks && window.MimiHooks.accounts;
    if (isGoogleConnector(spec) || !accounts || !accounts.openConnection) return openAccounts();
    accounts.openConnection(null, spec.key);
  }
  /** Whether the connector can run now: no credential, a Google account, or a stored connection. */
  const connectionState = (spec) => {
    if (spec.auth.kind === 'none') return { text: 'พร้อมใช้', ok: true };
    if (isGoogleConnector(spec)) {
      return googleConnected() ? { text: 'ใช้บัญชี Google', ok: true } : { text: 'ต้องเชื่อมบัญชี Google', ok: false };
    }
    const entries = connections().filter((entry) => entry.connector === spec.key);
    if (entries.length === 0) return { text: 'ต้องตั้งค่า', ok: false };
    const ready = entries.filter((entry) => entry.connected).length;
    if (ready === 0) return { text: 'ยังไม่เชื่อมต่อ', ok: false };
    return { text: `เชื่อมแล้ว ${ready}`, ok: true };
  };

  function connectorDetail(spec) {
    const state = connectionState(spec);
    const body = [];
    body.push(el('p', '', spec.description));
    const kv = el('div', 'mk-kv');
    kv.append(
      el('span', '', 'key'), el('code', 'mono', spec.key),
      el('span', '', 'Base URL'), el('code', 'mono', spec.baseUrl || '—'),
      el('span', '', 'Auth'), el('span', '', authLabelOf(spec)),
      el('span', '', 'สถานะ'), el('span', `pill ${state.ok ? 'ok' : 'todo'}`, state.text),
    );
    body.push(kv);
    if (spec.auth.kind !== 'none') {
      body.push(Kit().section('Credential ที่ต้องมี', 'ค่าจริงเก็บในเครื่อง ไม่แสดงที่นี่ · ดูทั้งหมดได้ที่ Hub → บัญชี', [button('btn', isGoogleConnector(spec) ? 'ไปที่บัญชี Google' : '+ เพิ่ม connection', () => setupConnector(spec))]));
      const fields = el('div', 'mk-kv');
      for (const field of spec.auth.fields) fields.append(el('span', '', field.label), el('span', 'mono faint', `${field.key} · ${field.type}`));
      if (spec.auth.fields.length === 0) fields.append(el('span', '', '—'), el('span', 'hint', isGoogleConnector(spec) ? 'ใช้บัญชี Google ที่เชื่อมไว้' : 'รับ token ตอนเชื่อมต่อ'));
      body.push(fields);
    }
    body.push(Kit().section(`Operations (${spec.operations.length})`, 'agent เห็นแต่ละอันเป็นเครื่องมือหนึ่งตัว', []));
    body.push(Kit().grid(spec.operations.map((operation) => Kit().card({
      title: operation.label,
      sub: `${operation.method} ${operation.path}`,
      badges: [[RISK_LABEL[operation.risk] || operation.risk, operation.risk === 'read' ? 'ok' : 'warn'], `${operation.fields.length} ช่อง`, operation.untrustedInput ? ['untrusted', 'warn'] : null],
    })), 'ไม่มี operation', 'dense'));
    const triggers = spec.triggers || [];
    if (triggers.length > 0) {
      body.push(Kit().section(`Triggers (${triggers.length})`, 'ใช้เป็นจุดเริ่ม workflow ได้', []));
      const chips = el('div', 'hstack');
      for (const trigger of triggers) chips.append(el('span', 'chip', `${trigger.label} · ${trigger.kind}`));
      body.push(chips);
    }
    const popup = Kit().modal({ title: spec.label, sub: `${spec.category} · ${sourceLabel(spec)}`, size: 'wide', body });
    popup.setFoot([button('btn', 'ปิด', () => popup.done())], sourceOf(spec) === 'openapi' ? [button('btn danger', 'ลบ connector', () => deleteConnector(spec, popup))] : []);
  }

  async function deleteConnector(spec, popup) {
    if (!(await Kit().confirmDelete(`connector "${spec.label}"`, `เครื่องมือ ${spec.operations.length} ตัวของมันจะหายไป · agent ที่ใช้อยู่ต้องเอาออกจากรายการเครื่องมือเอง · connection ใน Hub → บัญชี ยังอยู่`))) return;
    M().send({ type: 'connector-import-delete', key: spec.key });
    popup?.done();
  }

  // ---------- OpenAPI import ----------
  /** { source, key, label, preview, busy, reqId } while the import dialog is open. */
  let importing = null;
  let importSeq = 0;
  let importPopup = null;

  function openImport() {
    importing = { source: '', key: '', label: '', preview: null, busy: false, reqId: 0 };
    importPopup = Kit().modal({ title: 'นำเข้า connector จาก OpenAPI', size: 'wide', onClose: () => {
      importing = null;
      importPopup = null;
    } });
    showImport();
  }

  /** Preview asks with `replace` so it only reports real problems; save replaces only what the preview said it would. */
  function sendImport(save) {
    if (!importing || importing.busy || !importing.source.trim()) return;
    importing.busy = true;
    importing.reqId = ++importSeq;
    const replaces = Boolean(importing.preview && importing.preview.report && importing.preview.report.replaces);
    M().send({
      type: save ? 'connector-import-save' : 'connector-import-preview',
      reqId: importing.reqId,
      source: importing.source,
      ...(importing.key.trim() ? { key: importing.key.trim() } : {}),
      ...(importing.label.trim() ? { label: importing.label.trim() } : {}),
      replace: save ? replaces : true,
    });
    showImport();
  }

  function importReport(preview) {
    const box = el('div', 'wresult');
    const report = preview.report;
    if (report) {
      box.append(el('h4', '', preview.saved ? `นำเข้าแล้ว: ${report.label}` : `ตัวอย่าง: ${report.label} (${report.operations.length} operations)`));
      const meta = el('div', 'mk-kv');
      meta.append(
        el('span', '', 'Key'), el('code', 'mono', report.key),
        el('span', '', 'Server'), el('code', 'mono', report.server || '—'),
        el('span', '', 'API'), el('span', '', `${report.title} ${report.version}`),
        el('span', '', 'Auth'), el('span', '', report.security.join(', ') || 'none'),
      );
      box.append(meta);
      if (report.replaces) box.append(el('p', 'hint badtxt', `มี connector "${report.key}" ที่นำเข้าไว้แล้ว — ยืนยันแล้วจะแทนที่ของเดิม`));
      const counts = {};
      for (const operation of report.operations) counts[operation.risk] = (counts[operation.risk] || 0) + 1;
      const chips = el('div', 'hstack');
      for (const [risk, count] of Object.entries(counts)) chips.append(el('span', `risk${risk === 'read' ? '' : ' w'}`, `${RISK_LABEL[risk] || risk} ${count}`));
      chips.append(el('span', 'chip', 'untrusted ทุกตัว'));
      box.append(chips);
      const ops = el('div', 'tbl');
      for (const operation of report.operations) {
        const row = el('div');
        row.style.gridTemplateColumns = 'minmax(0, 1.2fr) 56px minmax(0, 1.4fr) 56px';
        const risk = el('span');
        risk.append(el('span', `risk${operation.risk === 'read' ? '' : ' w'}`, RISK_LABEL[operation.risk] || operation.risk));
        row.append(el('span', '', `${operation.label} (${operation.key})`), el('span', 'mono muted', operation.method), el('span', 'mono faint', operation.path), risk);
        ops.append(row);
      }
      box.append(ops);
      const section = (title, items, render, open) => {
        if (!items || items.length === 0) return;
        const details = el('details');
        if (open) details.open = true;
        details.append(el('summary', '', `${title} (${items.length})`));
        for (const item of items) details.append(render(item));
        box.append(details);
      };
      section('ส่วนที่นำเข้าไม่ได้ (ข้ามไป)', report.unsupported, (item) => el('p', 'hint badtxt', `${item.where}: ${item.reason}`), true);
      section('คำเตือน', report.warnings, (item) => el('p', 'hint', item), true);
      section('ชื่อเครื่องมือที่ agent จะเห็น', report.tools, (item) => el('p', 'hint mono', item), false);
    }
    if ((preview.errors || []).length > 0) {
      box.append(el('h4', 'badtxt', preview.action === 'save' ? 'นำเข้าไม่สำเร็จ — ไม่มีอะไรถูกบันทึก' : 'นำเข้าไม่ได้'));
      for (const error of preview.errors) box.append(el('p', 'hint badtxt', error));
    }
    return box;
  }

  function showImport() {
    if (!importing || !importPopup) return;
    const body = [
      el('p', 'hint', 'รับ OpenAPI 3.x แบบ JSON (YAML ให้แปลงเป็น JSON ก่อน) · server ต้องเป็น https และไม่ใช่เครื่องในวง LAN · ไม่มีการเรียก API ตอนนำเข้า และไม่นำเข้า credential — ตั้งค่าใน Hub → บัญชี หลังนำเข้า'),
    ];
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.onchange = async () => {
      const chosen = file.files && file.files[0];
      if (!chosen) return;
      importing.source = await chosen.text();
      importing.preview = null;
      sendImport(false);
    };
    body.push(Kit().field('ไฟล์ OpenAPI (.json)', file));
    const paste = textarea(importing.source && importing.source.length < 20000 ? importing.source : '', 'หรือวาง OpenAPI JSON ที่นี่');
    const names = el('div', 'mk-grid2');
    const key = M().textInput(importing.key, 'ได้จาก info.title');
    key.oninput = () => {
      importing.key = key.value;
    };
    const label = M().textInput(importing.label, 'ได้จาก info.title');
    label.oninput = () => {
      importing.label = label.value;
    };
    names.append(Kit().field('Key (ไม่บังคับ, snake_case)', key), Kit().field('ชื่อที่แสดง (ไม่บังคับ)', label));
    body.push(paste, names, button('btn', 'ดูตัวอย่าง', () => {
      if (paste.value.trim()) importing.source = paste.value;
      importing.preview = null;
      sendImport(false);
    }));
    if (importing.busy) body.push(el('p', 'hint', 'กำลังตรวจ…'));
    const preview = importing.preview;
    if (preview) body.push(importReport(preview));
    importPopup.setBody(body);
    const foot = [button('btn ghost', preview && preview.saved ? 'เสร็จ' : 'ปิด', () => importPopup.done())];
    if (preview && !preview.saved && preview.report && (preview.errors || []).length === 0 && !importing.busy) {
      const count = preview.report.operations.length;
      foot.push(button('btn pri', preview.report.replaces ? `แทนที่ด้วย ${count} operations` : `ยืนยันนำเข้า ${count} operations`, () => sendImport(true)));
    }
    importPopup.setFoot(foot);
    importPopup.dirty = false;
  }

  function onImport(message) {
    if (message.action === 'delete') {
      if ((message.errors || []).length > 0) M().toast('ลบ connector ไม่ได้', message.errors.join('\n'), true);
      else M().toast(`ลบ connector ${message.key} แล้ว`);
      return;
    }
    if (!importing || message.reqId !== importing.reqId) return;
    importing.busy = false;
    importing.preview = message;
    if (message.saved) M().toast(`นำเข้า ${message.report ? message.report.label : message.key} แล้ว`, 'ตั้ง credential ใน Hub → บัญชี แล้วเพิ่มเครื่องมือให้ agent');
    showImport();
  }

  // ---------- node type detail ----------
  function nodeDetail(spec) {
    const body = [el('p', '', spec.description)];
    const kv = el('div', 'mk-kv');
    kv.append(el('span', '', 'ชนิด (type)'), el('code', 'mono', spec.type), el('span', '', 'กลุ่ม'), el('span', '', groupOf(spec.type)));
    kv.append(el('span', '', 'ทางออก'), el('span', '', (spec.outputs || []).map((output) => output.label).join(', ') || '—'));
    body.push(kv);
    if ((spec.fields || []).length > 0) {
      body.push(Kit().section(`ช่องตั้งค่า (${spec.fields.length})`, '* = จำเป็น', []));
      const fields = el('div', 'mk-kv');
      for (const field of spec.fields) fields.append(el('span', '', `${field.label}${field.required ? ' *' : ''}`), el('span', 'hint', [field.type, field.description].filter(Boolean).join(' · ')));
      body.push(fields);
    }
    if (spec.triggerPool) {
      const pool = (M().state.workflowPool || []).find((entry) => entry.name === spec.triggerPool);
      if (pool) body.push(Kit().section('ข้อมูลตัวอย่างที่ node นี้ส่งต่อ', 'ใช้ใน node ถัดไปด้วย {{ $json.ชื่อ }}', []), el('pre', 'mk-pre', JSON.stringify(pool.sample, null, 2)));
    }
    const mine = nodePresets.list().filter((preset) => preset.type === spec.type);
    if (mine.length > 0) {
      body.push(Kit().section(`Preset ของ node นี้ (${mine.length})`, '', []));
      body.push(Kit().grid(mine.map((preset) => presetCard(preset)), '', 'dense'));
    }
    body.push(el('p', 'hint', 'วาง node นี้ได้จากแถบ Node ด้านซ้ายของหน้าผัง workflow — คลิกหรือลากมาวาง'));
    const popup = Kit().modal({ title: spec.label, sub: `node ของ workflow · ${groupOf(spec.type)}`, size: 'wide', body });
    popup.setFoot([button('btn', 'ปิด', () => popup.done()), button('btn pri', '+ สร้าง preset จาก node นี้', () => {
      popup.done();
      presetEditor({ type: spec.type });
    })]);
  }

  // ---------- MCP servers ----------
  const linesOf = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
  function pairsOf(text, sep) {
    const out = {};
    for (const line of linesOf(text)) {
      const at = line.indexOf(sep);
      if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return out;
  }
  const pairsText = (pairs, sep) => Object.entries(pairs || {}).map(([key, value]) => `${key}${sep}${value}`).join('\n');
  /** Waiting for the server: the popup closes once the saved item shows up in the tools list. */
  let pending = null;

  function mcpEditor(spec) {
    const isNew = !spec;
    spec = spec || { name: '', enabled: true, transport: 'stdio', tools: [] };
    const body = [];
    const name = M().textInput(spec.name, 'เช่น github');
    const title = M().textInput(spec.title || '', 'ชื่อที่โชว์ (ไม่บังคับ)');
    const top = el('div', 'mk-grid2');
    top.append(Kit().field('ชื่อ (a-z 0-9 -)', name), Kit().field('ชื่อที่โชว์', title));
    const transport = select(['stdio', 'http', 'sse'], spec.transport || 'stdio');
    const risk = select(['write', 'read', 'network', 'shell', 'delete'], spec.risk || 'write');
    const mid = el('div', 'mk-grid2');
    mid.append(Kit().field('ต่อแบบ', transport, 'stdio = รันคำสั่งในเครื่อง · http/sse = ต่อ URL'), Kit().field('ระดับความเสี่ยงของเครื่องมือ', risk, 'ใช้กับเครื่องมือที่ server ไม่ได้บอกว่าอ่านอย่างเดียว'));
    const runsOn = select(['core', 'pc'], spec.runsOn || 'core');
    body.push(top, mid, Kit().field('รันที่', runsOn, 'core = เครื่องที่รัน Mimi · pc = คอมของคุณผ่าน PC agent'));

    const command = M().textInput(spec.command || '', 'เช่น npx');
    const args = textarea((spec.args || []).join('\n'), '-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\Documents');
    const cwd = M().textInput(spec.cwd || '', 'เว้นว่างได้');
    const env = textarea(pairsText(spec.env, '='), 'GITHUB_TOKEN={{secret.GITHUB_TOKEN}}');
    const stdioBox = el('div');
    stdioBox.append(Kit().field('คำสั่ง', command), Kit().field('อาร์กิวเมนต์ (บรรทัดละตัว)', args), Kit().field('โฟลเดอร์ทำงาน', cwd), Kit().field('ตัวแปร env (KEY=ค่า บรรทัดละตัว)', env));
    const url = M().textInput(spec.url || '', 'https://example.com/mcp');
    const headers = textarea(pairsText(spec.headers, ': '), 'Authorization: Bearer {{secret.MY_KEY}}');
    const httpBox = el('div');
    httpBox.append(Kit().field('URL', url), Kit().field('Headers (ชื่อ: ค่า บรรทัดละตัว)', headers));
    const showTransport = () => {
      stdioBox.hidden = transport.value !== 'stdio';
      httpBox.hidden = transport.value === 'stdio';
    };
    transport.onchange = showTransport;
    showTransport();
    body.push(stdioBox, httpBox);

    const check = (label, checked, hint) => {
      const wrap = el('label', 'wcheck');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = checked;
      wrap.append(box, el('span', '', label));
      if (hint) wrap.title = hint;
      body.push(wrap);
      return box;
    };
    const enabled = check('เปิดใช้', spec.enabled !== false);
    const untrusted = check('ผลลัพธ์อาจมีข้อความจากคนอื่น (เว็บ / อีเมล)', spec.untrusted !== false, 'ติ๊กไว้ = agent ที่ใช้ตัวนี้จะมีเครื่องมือ shell ไม่ได้');
    body.push(el('p', 'hint', 'ค่าลับ (token) ใส่ในแท็บคีย์ลับ แล้วอ้างด้วย {{secret.ชื่อ}} · server แบบคำสั่งจะได้ env แค่ที่ระบุ'));

    if (!isNew) {
      if (spec.error) body.push(el('p', 'hint badtxt', `ต่อไม่ได้: ${spec.error}`));
      if (spec.checkedAt) body.push(el('p', 'hint', `อ่านรายการล่าสุด ${M().fmtDate(spec.checkedAt)}${spec.latencyMs !== undefined ? ` · health ${spec.latencyMs} ms` : ''}`));
      if (spec.tools.length > 0) {
        body.push(Kit().section(`เครื่องมือของ server นี้ (${spec.tools.length})`, '', []));
        body.push(Kit().grid(spec.tools.map((tool) => Kit().card({ title: tool.name, mono: true, desc: tool.description, badges: [[RISK_LABEL[tool.risk] || tool.risk, tool.risk === 'read' ? 'ok' : 'warn']] })), '', 'dense'));
      }
    }
    const popup = Kit().modal({ title: isNew ? 'เพิ่ม MCP server' : `MCP: ${spec.title || spec.name}`, sub: 'เครื่องมือจะชื่อ mcp_<server>_<tool> · ใส่ mcp_<server> ใน agent = ได้ทุกตัวของ server นั้น', size: 'wide', body });
    const save = () => {
      if (!name.value.trim()) return M().toast('กรอกไม่ครบ', 'ต้องมีชื่อ', true);
      const server = { name: name.value.trim(), enabled: enabled.checked, transport: transport.value, risk: risk.value, untrusted: untrusted.checked, ...(runsOn.value === 'pc' ? { runsOn: 'pc' } : {}) };
      if (title.value.trim()) server.title = title.value.trim();
      if (transport.value === 'stdio') {
        server.command = command.value.trim();
        server.args = linesOf(args.value);
        if (cwd.value.trim()) server.cwd = cwd.value.trim();
        server.env = pairsOf(env.value, '=');
      } else {
        server.url = url.value.trim();
        server.headers = pairsOf(headers.value, ':');
      }
      pending = { kind: 'mcp', name: server.name, popup };
      M().send({ type: 'mcp-save', server, renameFrom: isNew ? undefined : spec.name });
    };
    const left = [];
    if (!isNew) {
      left.push(
        button('btn danger', 'ลบ', () => deleteMcp(spec, popup)),
        button('btn ghost', 'ต่อใหม่ / อ่านรายการ', () => {
          M().send({ type: 'mcp-refresh', name: spec.name });
          M().toast('MCP', 'กำลังต่อ server…');
        }),
      );
    }
    popup.setFoot([button('btn ghost', 'ยกเลิก', () => popup.close()), button('btn pri', 'บันทึก', save)], left);
  }

  async function deleteMcp(spec, popup) {
    if (!(await Kit().confirmDelete(`MCP server "${spec.title || spec.name}"`, `เครื่องมือ ${spec.tools.length} ตัวของมันจะหายจาก agent ที่ใช้อยู่`))) return;
    M().send({ type: 'mcp-delete', name: spec.name });
    popup?.done();
  }

  // ---------- custom tool editor ----------
  function paramsEditor(list) {
    const wrap = el('div');
    const add = (param) => {
      const entry = { key: '', type: 'string', description: '', required: true, ...(param || {}) };
      const row = el('div', 'editor-row param');
      const key = M().textInput(entry.key, 'name');
      key.className = 'k';
      const type = select(['string', 'number', 'boolean'], entry.type);
      type.className = 'ty';
      const desc = M().textInput(entry.description, 'คำอธิบายให้โมเดลรู้ว่าต้องใส่อะไร');
      desc.className = 'dx';
      const optional = el('input');
      optional.type = 'checkbox';
      optional.checked = entry.required === false;
      optional.className = 'rq';
      optional.title = 'ติ๊ก = โมเดลไม่ใส่ก็ได้';
      row.append(key, type, desc, optional, button('btn ghost', '✕', () => row.remove()));
      wrap.append(row);
    };
    for (const param of list) add(param);
    const box = el('div');
    box.append(wrap, button('btn ghost', '+ เพิ่มพารามิเตอร์', () => add()));
    return box;
  }
  const readParams = (box) =>
    [...box.querySelectorAll('.editor-row')]
      .map((row) => {
        const param = { key: row.querySelector('.k').value.trim(), type: row.querySelector('.ty').value };
        const desc = row.querySelector('.dx').value.trim();
        if (desc) param.description = desc;
        if (row.querySelector('.rq').checked) param.required = false;
        return param;
      })
      .filter((param) => param.key);

  function settingsEditor(list) {
    const wrap = el('div');
    const add = (field) => {
      const entry = { key: '', label: '', type: 'string', required: true, ...(field || {}) };
      const row = el('div', 'editor-row setting');
      const key = M().textInput(entry.key, 'key');
      key.className = 'k';
      const label = M().textInput(entry.label, 'ชื่อที่โชว์ในฟอร์ม');
      label.className = 'lb';
      const type = select(['string', 'number', 'boolean', 'secret', 'text'], entry.type);
      type.className = 'ty';
      const optional = el('input');
      optional.type = 'checkbox';
      optional.checked = entry.required === false;
      optional.className = 'rq';
      optional.title = 'ติ๊ก = เว้นว่างได้';
      row.append(key, label, type, optional, button('btn ghost', '✕', () => row.remove()));
      wrap.append(row);
    };
    for (const field of list) add(field);
    const box = el('div');
    box.append(wrap, button('btn ghost', '+ เพิ่มค่าตั้งต้น', () => add()));
    return box;
  }
  const readSettings = (box) =>
    [...box.querySelectorAll('.editor-row')]
      .map((row) => ({
        key: row.querySelector('.k').value.trim(),
        label: row.querySelector('.lb').value.trim() || row.querySelector('.k').value.trim(),
        type: row.querySelector('.ty').value,
        required: !row.querySelector('.rq').checked,
      }))
      .filter((field) => field.key);

  function kvEditor(entries) {
    const wrap = el('div');
    const add = (key, value) => {
      const row = el('div', 'editor-row kv');
      const k = M().textInput(key || '', 'ชื่อ');
      k.className = 'k';
      const v = M().textInput(value || '', 'ค่า (ใช้ {{input.x}} ได้)');
      v.className = 'v';
      row.append(k, v, button('btn ghost', '✕', () => row.remove()));
      wrap.append(row);
    };
    for (const [key, value] of Object.entries(entries || {})) add(key, value);
    const box = el('div');
    const addBtn = button('btn ghost', '+ เพิ่ม', () => add());
    addBtn.style.marginTop = '6px';
    box.append(wrap, addBtn);
    return box;
  }
  const readKvs = (box) => {
    const out = {};
    for (const row of box.querySelectorAll('.editor-row')) {
      const key = row.querySelector('.k').value.trim();
      if (key) out[key] = row.querySelector('.v').value;
    }
    return out;
  };

  function customEditor(spec, startKind) {
    const isNew = !spec;
    spec = spec || {
      name: '',
      description: '',
      kind: startKind || 'http',
      params: [],
      settings: [],
      config: startKind === 'code' ? { code: '// input.x = ค่าที่โมเดลส่งมา, settings.x = ค่าตั้งต้น\nreturn "ผลลัพธ์";' } : {},
    };
    const body = [];
    const name = M().textInput(spec.name, 'เช่น fetch_rates');
    const kindSelect = select(['http', 'code', 'shell'], spec.kind);
    const top = el('div', 'mk-grid2');
    top.append(Kit().field('ชื่อ (a-z 0-9 - _)', name), Kit().field('ชนิด', kindSelect, 'http = เรียก API · code = JavaScript · shell = รันคำสั่ง'));
    const description = M().textInput(spec.description, 'ทำอะไร — โมเดลอ่านบรรทัดนี้');
    body.push(top, Kit().field('คำอธิบาย', description));
    body.push(Kit().section('พารามิเตอร์', 'โมเดลส่งค่ามาตอนเรียก · ติ๊กช่องท้ายแถว = ไม่บังคับ', []));
    const params = paramsEditor(spec.params || []);
    body.push(params);
    body.push(Kit().section('ค่าตั้งต้น', 'ในเทมเพลตใช้ {{input.ชื่อ}} {{settings.ชื่อ}} {{secret.ชื่อ}}', []));
    const settings = settingsEditor(spec.settings || []);
    body.push(settings);
    body.push(Kit().section('การทำงาน', '', []));
    const config = spec.config || {};
    const configBox = el('div');
    body.push(configBox);
    let readConfig = () => ({});
    const paintConfig = () => {
      configBox.replaceChildren();
      if (kindSelect.value === 'http') {
        const method = select(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], String(config.method || 'GET').toUpperCase());
        const bodyType = select(['json', 'text', 'form'], config.bodyType || 'json');
        const methodRow = el('div', 'mk-grid2');
        methodRow.append(Kit().field('Method', method), Kit().field('รูปแบบ body', bodyType));
        const url = M().textInput(config.url || '', 'https://api.example.com/items/{{input.id}}');
        const headers = kvEditor(config.headers);
        const queryBox = kvEditor(config.query);
        const bodyText = textarea(config.body || '', '{"date":"{{input.date}}"}');
        const allowLocal = el('input');
        allowLocal.type = 'checkbox';
        allowLocal.checked = config.allowLocal === true;
        const allowLocalRow = el('label', 'wcheck');
        allowLocalRow.append(allowLocal, el('span', '', 'อนุญาตเรียกเครือข่ายภายใน (localhost / LAN)'));
        configBox.append(methodRow, Kit().field('URL', url), el('h4', '', 'Headers'), headers, el('h4', '', 'Query'), queryBox, el('h4', '', 'Body'), bodyText, allowLocalRow);
        readConfig = () => ({
          method: method.value,
          url: url.value.trim(),
          headers: readKvs(headers),
          query: readKvs(queryBox),
          bodyType: bodyType.value,
          ...(bodyText.value.trim() ? { body: bodyText.value } : {}),
          ...(allowLocal.checked ? { allowLocal: true } : {}),
        });
      } else if (kindSelect.value === 'code') {
        const code = textarea(config.code || '', '// input.x = ค่าที่โมเดลส่งมา, settings.x = ค่าตั้งต้น\nreturn "ผลลัพธ์"', 'tall');
        const timeout = M().textInput(config.timeoutMs || '', '10000', 'number');
        configBox.append(Kit().field('โค้ด JavaScript (ต้อง return ค่า)', code), Kit().field('timeout (ms)', timeout, 'ค่าเริ่มต้น 10000'));
        readConfig = () => ({ code: code.value, ...(timeout.value ? { timeoutMs: Number(timeout.value) } : {}) });
      } else {
        const command = M().textInput(config.command || '', 'เช่น ping -n 1 {{input.host}}');
        const cwd = M().textInput(config.cwd || '', 'เว้นว่าง = โฟลเดอร์แรกที่อนุญาต');
        const timeout = M().textInput(config.timeoutMs || '', '60000', 'number');
        const runsOn = select(['core', 'pc'], config.runsOn || 'core');
        configBox.append(Kit().field('คำสั่ง', command), Kit().field('โฟลเดอร์ทำงาน', cwd), Kit().field('timeout (ms)', timeout, 'ค่าเริ่มต้น 60000'), Kit().field('รันที่', runsOn, 'core = เครื่องที่รัน Mimi · pc = คอมของคุณผ่าน PC agent'));
        readConfig = () => ({
          command: command.value,
          ...(runsOn.value === 'pc' ? { runsOn: 'pc' } : {}),
          ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}),
          ...(timeout.value ? { timeoutMs: Number(timeout.value) } : {}),
        });
      }
    };
    kindSelect.onchange = paintConfig;
    paintConfig();
    const popup = Kit().modal({ title: isNew ? 'สร้างเครื่องมือ' : `แก้ไขเครื่องมือ: ${spec.name}`, sub: 'HTTP = ข้อมูลภายนอก (untrusted) · code/shell = ต้องขออนุญาตทุกครั้ง', size: 'wide', body });
    const read = () => ({
      name: name.value.trim(),
      description: description.value.trim(),
      kind: kindSelect.value,
      params: readParams(params),
      settings: readSettings(settings),
      config: readConfig(),
    });
    const save = () => {
      if (!name.value.trim() || !description.value.trim()) return M().toast('กรอกไม่ครบ', 'ต้องมีชื่อและคำอธิบาย', true);
      pending = { kind: 'custom', name: name.value.trim(), popup };
      M().send({ type: 'tool-save', renameFrom: isNew ? undefined : spec.name, tool: read() });
    };
    const left = [];
    if (!isNew) left.push(button('btn danger', 'ลบ', () => deleteCustom(spec, popup)), button('btn ghost', 'ส่งออก', () => exportBundle({ tools: [spec] })));
    popup.setFoot([button('btn ghost', 'ยกเลิก', () => popup.close()), button('btn pri', 'บันทึก', save)], left);
  }

  async function deleteCustom(spec, popup) {
    const users = usersOf(spec.name);
    if (!(await Kit().confirmDelete(`เครื่องมือ "${spec.name}"`, users.length ? `จะหายจาก agent ที่ใช้อยู่: ${users.join(', ')}` : 'ยังไม่มี agent ใช้เครื่องมือนี้'))) return;
    M().send({ type: 'tool-delete', name: spec.name });
    popup?.done();
  }

  function toolDetail(tool) {
    const users = usersOf(tool.name);
    const kv = el('div', 'mk-kv');
    kv.append(
      el('span', '', 'ระดับ'), el('span', '', `${RISK_LABEL[tool.risk] || tool.risk}${tool.risk === 'read' ? ' — ใช้ได้เลย' : ' — ถามก่อนใช้'}`),
      el('span', '', 'รันที่'), el('span', '', tool.target === 'pc' ? 'คอมของคุณ (PC agent)' : 'core'),
      el('span', '', 'ใช้โดย'), el('span', '', users.join(', ') || 'ยังไม่มี agent ใช้'),
    );
    const body = [el('p', '', tool.description), kv];
    if ((tool.settings || []).length > 0) body.push(el('p', 'hint', `มีค่าตั้งต้น ${tool.settings.length} ช่อง — ตั้งเป็น preset ของเครื่องมือได้ในหน้า Agent → เครื่องมือ`));
    body.push(el('p', 'hint', 'ให้ agent ใช้: หน้า Agent → เครื่องมือ · ใช้ใน workflow: node "เครื่องมือ (tool)" หรือลากจากกลุ่ม "เครื่องมือ" ในหน้าผัง'));
    const popup = Kit().modal({ title: tool.name, sub: tool.mcp ? `MCP · ${tool.mcp}` : 'เครื่องมือในตัว', body });
    popup.setFoot([button('btn', 'ปิด', () => popup.done())]);
  }

  async function deleteToolPreset(preset) {
    if (!(await Kit().confirmDelete(`preset เครื่องมือ "${preset.label || preset.name}"`, `ตั้งจาก ${preset.tool} · agent ที่ใช้อยู่จะเสีย preset นี้`))) return;
    M().send({ type: 'tool-preset-delete', name: preset.name });
  }

  // ---------- import / export ----------
  /** One JSON bundle for what the user made here: node presets, custom tools and MCP servers. */
  function exportBundle(parts) {
    const data = { kind: 'mimi-nodes', version: 1 };
    if (parts.presets) data.nodePresets = parts.presets.map(({ id, ...rest }) => rest);
    if (parts.tools) data.tools = parts.tools;
    if (parts.mcp) data.mcp = parts.mcp.map(({ tools, error, checkedAt, latencyMs, ...rest }) => rest);
    Kit().downloadJson(`mimi-nodes-${Kit().stamp()}.json`, data);
  }

  async function importBundle(files) {
    let presets = 0;
    let tools = 0;
    let servers = 0;
    for (const file of files) {
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name}: ไม่ใช่ไฟล์ JSON`);
      }
      const nodeList = data.nodePresets || (data.kind === 'mimi-node-presets' ? data.items : null) || [];
      for (const preset of nodeList) {
        if (preset && preset.type && preset.title) {
          nodePresets.save({ title: preset.title, description: preset.description, type: preset.type, config: preset.config });
          presets++;
        }
      }
      for (const tool of data.tools || []) {
        if (tool && tool.name && tool.kind) {
          M().send({ type: 'tool-save', tool });
          tools++;
        }
      }
      // Also takes Claude Desktop / Cursor style { "mcpServers": { name: { command, args, env } } }.
      const mcpList = [...(data.mcp || []), ...Object.entries(data.mcpServers || {}).map(([name, entry]) => ({ name, enabled: true, transport: entry.url ? 'http' : 'stdio', ...entry }))];
      for (const server of mcpList) {
        if (server && server.name) {
          M().send({ type: 'mcp-save', server });
          servers++;
        }
      }
    }
    if (presets + tools + servers === 0) throw new Error('ไม่พบ node preset, เครื่องมือ หรือ MCP server ในไฟล์');
    M().toast('นำเข้าแล้ว', [presets && `node preset ${presets}`, tools && `เครื่องมือ ${tools}`, servers && `MCP ${servers}`].filter(Boolean).join(' · '));
    rerender();
  }

  // ---------- the grid ----------
  function presetCard(preset) {
    const spec = specOf(preset.type);
    return Kit().card({
      title: preset.title,
      sub: `preset ของ ${spec ? spec.label : preset.type}`,
      icon: iconOf(preset.type),
      desc: preset.description || Object.keys(preset.config || {}).map((key) => `${key}: ${JSON.stringify(preset.config[key])}`).join(' · ').slice(0, 140),
      badges: [['Preset ของฉัน', 'violet'], groupOf(preset.type), spec ? null : ['ไม่มี node นี้แล้ว', 'warn']],
      onOpen: () => presetEditor(preset),
      actions: [
        { label: 'แก้ไข', onClick: () => presetEditor(preset) },
        { label: 'ส่งออก', onClick: () => exportPresets([preset]) },
        { label: 'ลบ', danger: true, onClick: () => deletePreset(preset) },
      ],
    });
  }

  /** Everything the tab shows, as { kind, group, text, card() } so filtering never builds DOM. */
  function entries() {
    const out = [];
    for (const preset of nodePresets.list()) {
      out.push({ kind: 'preset', group: groupOf(preset.type), text: `${preset.title} ${preset.description} ${preset.type}`, card: () => presetCard(preset) });
    }
    for (const preset of M().state.toolPresets || []) {
      out.push({
        kind: 'preset',
        group: 'เครื่องมือ',
        text: `${preset.name} ${preset.label || ''} ${preset.tool} ${preset.description || ''}`,
        card: () => Kit().card({
          title: preset.label || preset.name,
          sub: `preset ของเครื่องมือ ${preset.tool}`,
          icon: '⚙',
          desc: preset.description,
          badges: [['Preset ของฉัน', 'violet'], 'เครื่องมือ'],
          actions: [{ label: 'ลบ', danger: true, onClick: () => deleteToolPreset(preset) }],
        }),
      });
    }
    for (const spec of M().state.nodeTypes || []) {
      if (spec.type === 'trigger_custom') continue;
      out.push({
        kind: 'node',
        group: groupOf(spec.type),
        text: `${spec.label} ${spec.type} ${spec.description}`,
        card: () => Kit().card({
          title: spec.label,
          sub: spec.type,
          icon: iconOf(spec.type),
          desc: spec.description,
          badges: [groupOf(spec.type), (spec.fields || []).length ? `${spec.fields.length} ช่อง` : null, (spec.outputs || []).length > 1 ? `${spec.outputs.length} ทางออก` : null],
          onOpen: () => nodeDetail(spec),
          actions: [{ label: 'ดูรายละเอียด', onClick: () => nodeDetail(spec) }, { label: '+ preset', onClick: () => presetEditor({ type: spec.type }), title: 'บันทึก node นี้พร้อมค่าที่ตั้งไว้ เพื่อใช้ซ้ำ' }],
        }),
      });
    }
    for (const name of M().state.customNodes || []) {
      out.push({ kind: 'node', group: 'อื่น ๆ', text: `custom node ${name}`, card: () => Kit().card({ title: name, sub: 'custom node (user/nodes)', icon: '◇', badges: ['plugin'] }) });
    }
    const custom = new Map((M().state.toolCustom || []).map((spec) => [spec.name, spec]));
    for (const tool of M().state.tools || []) {
      const spec = custom.get(tool.name);
      const users = usersOf(tool.name);
      const riskBadge = [RISK_LABEL[tool.risk] || tool.risk, tool.risk === 'read' ? 'ok' : 'warn'];
      if (tool.mcp) continue;
      out.push({
        kind: spec ? 'custom' : 'tool',
        group: RISK_LABEL[tool.risk] || tool.risk,
        text: `${tool.name} ${tool.description}`,
        card: () => Kit().card({
          title: tool.name,
          mono: true,
          desc: tool.description,
          badges: [riskBadge, spec ? [`สร้างเอง · ${spec.kind}`, 'info'] : null, tool.target === 'pc' ? 'PC' : null, users.length ? [`ใช้โดย ${users.join(', ')}`, 'ok'] : null],
          onOpen: () => (spec ? customEditor(spec) : toolDetail(tool)),
          actions: spec
            ? [{ label: 'แก้ไข', onClick: () => customEditor(spec) }, { label: 'ลบ', danger: true, onClick: () => deleteCustom(spec) }]
            : [{ label: 'ดูรายละเอียด', onClick: () => toolDetail(tool) }],
        }),
      });
    }
    for (const server of M().state.toolMcp || []) {
      const status = !server.enabled ? ['ปิดอยู่', 'todo'] : server.error ? ['ต่อไม่ได้', 'bad'] : server.checkedAt ? ['ต่อแล้ว', 'ok'] : ['ยังไม่ได้ต่อ', 'todo'];
      out.push({
        kind: 'mcp',
        group: server.transport,
        text: `${server.name} ${server.title || ''} ${server.tools.map((tool) => tool.name).join(' ')}`,
        card: () => Kit().card({
          title: server.title || server.name,
          sub: `MCP · ${server.transport}${server.runsOn === 'pc' ? ' · PC' : ''}`,
          icon: 'M',
          state: status,
          desc: server.error || `${server.tools.length} เครื่องมือ: ${server.tools.slice(0, 6).map((tool) => tool.name.replace(`mcp_${server.name}_`, '')).join(', ')}${server.tools.length > 6 ? '…' : ''}`,
          badges: [server.untrusted !== false ? ['untrusted', 'warn'] : null],
          onOpen: () => mcpEditor(server),
          actions: [{ label: 'แก้ไข', onClick: () => mcpEditor(server) }, { label: 'ลบ', danger: true, onClick: () => deleteMcp(server) }],
        }),
      });
    }
    for (const spec of connectors()) {
      const state = connectionState(spec);
      out.push({
        kind: 'connector',
        group: spec.category,
        text: `${spec.label} ${spec.key} ${spec.category} ${spec.description} ${spec.operations.map((operation) => `${operation.key} ${operation.label}`).join(' ')}`,
        card: () => Kit().card({
          title: spec.label,
          sub: `${spec.operations.length} operations · ${sourceLabel(spec)}`,
          icon: initialsOf(spec.label),
          state: [state.ok ? 'ok' : 'todo', state.text],
          desc: spec.description,
          badges: [spec.category],
          onOpen: () => connectorDetail(spec),
          actions: [
            { label: 'ดูรายละเอียด', onClick: () => connectorDetail(spec) },
            !state.ok && spec.auth.kind !== 'none' ? { label: 'ตั้งค่า', pri: true, onClick: () => setupConnector(spec) } : null,
            sourceOf(spec) === 'openapi' ? { label: 'ลบ', danger: true, onClick: () => deleteConnector(spec) } : null,
          ],
        }),
      });
    }
    return out;
  }

  const KINDS = [
    ['all', 'ทั้งหมด'],
    ['preset', 'Preset ของฉัน'],
    ['node', 'Node workflow'],
    ['tool', 'เครื่องมือในตัว'],
    ['custom', 'เครื่องมือที่สร้างเอง'],
    ['mcp', 'MCP'],
    ['connector', 'บริการ (Connector)'],
  ];
  const KIND_TITLE = { preset: 'Preset ของฉัน', node: 'Node ของ workflow', tool: 'เครื่องมือในตัว', custom: 'เครื่องมือที่สร้างเอง', mcp: 'MCP server', connector: 'บริการ (Connector)' };

  function render() {
    if (!M().state.connections) M().send({ type: 'connector-connections' });
    const wrap = el('div');
    const all = entries();
    const addMenu = [
      button('btn pri', '+ Node preset', () => presetEditor(null), 'node ที่ตั้งค่าไว้แล้ว ใช้ซ้ำในหลาย workflow'),
      button('btn', '+ เครื่องมือ', () => customEditor(null), 'เครื่องมือแบบ HTTP / JavaScript / shell'),
      button('btn', '+ MCP server', () => mcpEditor(null)),
      button('btn', '+ นำเข้า OpenAPI', openImport, 'สร้าง connector จากเอกสาร OpenAPI 3.x (JSON)'),
      ...Kit().ioButtons({
        onImport: importBundle,
        importTitle: 'นำเข้า node preset / เครื่องมือ / MCP (รับไฟล์ mcpServers ของ Claude Desktop ได้)',
        onExport: () => exportBundle({ presets: nodePresets.list(), tools: M().state.toolCustom || [], mcp: M().state.toolMcp || [] }),
        exportTitle: 'ส่งออก node preset, เครื่องมือที่สร้างเอง และ MCP server ทั้งหมด',
      }),
    ];
    wrap.append(Kit().section(`Node & เครื่องมือ (${all.length})`, 'คลิกการ์ดเพื่อดูหรือแก้ไข · ใช้ตัวกรองเพื่อหาเร็วขึ้น', addMenu));
    if (!KINDS.some(([key]) => key === kind)) kind = 'all';
    const inKind = all.filter((entry) => kind === 'all' || entry.kind === kind);
    const groups = [...new Set(inKind.map((entry) => entry.group))].filter(Boolean).sort();
    if (group !== 'all' && !groups.includes(group)) group = 'all';
    const groupSelect = Kit().select([['all', kind === 'connector' ? 'ทุกหมวด' : kind === 'tool' || kind === 'custom' ? 'ทุกระดับ' : 'ทุกกลุ่ม'], ...groups.map((name) => [name, name])], group, (value) => {
      group = value;
      shownLimit = 60;
      paint();
    });
    const listBox = el('div');
    const countText = el('span', 'mk-count');
    const paint = () => {
      const needle = query.trim().toLowerCase();
      const visible = inKind.filter((entry) => (group === 'all' || entry.group === group) && (!needle || entry.text.toLowerCase().includes(needle)));
      countText.textContent = `${Math.min(visible.length, shownLimit)}/${visible.length}`;
      listBox.replaceChildren();
      if (kind === 'all' && !needle && group === 'all') {
        countText.textContent = `${visible.length} รายการ`;
        // Unfiltered: one short block per kind, so nothing drowns in 400 tools.
        for (const [key] of KINDS.slice(1)) {
          const part = visible.filter((entry) => entry.kind === key);
          if (part.length === 0 && key !== 'preset') continue;
          const block = el('div', 'mk-block');
          const more = part.length > 8 ? button('btn ghost sm', `ดูทั้งหมด ${part.length} →`, () => {
            kind = key;
            M().renderHub();
          }) : null;
          block.append(Kit().section(`${KIND_TITLE[key]} (${part.length})`, key === 'preset' ? 'node และเครื่องมือที่ตั้งค่าไว้แล้ว — วางใน workflow ได้ทันที' : '', [more]));
          block.append(Kit().grid(part.slice(0, 8).map((entry) => entry.card()), key === 'preset' ? 'ยังไม่มี preset — กด "+ Node preset" หรือ "+ preset" บนการ์ด node · ในหน้าผัง workflow กด "บันทึกเป็น preset" ที่ node ก็ได้' : ''));
          listBox.append(block);
        }
        return;
      }
      listBox.append(Kit().grid(visible.slice(0, shownLimit).map((entry) => entry.card()), 'ไม่พบรายการที่ตรงกับตัวกรอง'));
      if (visible.length > shownLimit) {
        const more = el('div', 'mk-more');
        more.append(button('btn', `แสดงเพิ่ม (${visible.length - shownLimit})`, () => {
          shownLimit += 120;
          paint();
        }));
        listBox.append(more);
      }
    };
    const bar = Kit().filterBar({
      query,
      placeholder: 'ค้นหา node, เครื่องมือ, บริการ, operation…',
      chips: KINDS.map(([key, label]) => ({ key, label, count: key === 'all' ? all.length : all.filter((entry) => entry.kind === key).length })),
      active: kind,
      selects: kind === 'all' ? [] : [groupSelect],
      onQuery: (value) => {
        query = value;
        shownLimit = 60;
        paint();
      },
      onChip: (key) => {
        kind = key;
        group = 'all';
        shownLimit = 60;
        M().renderHub();
      },
    });
    bar.node.querySelector('.mk-chips').append(countText);
    wrap.append(bar.node, listBox);
    paint();
    return wrap;
  }

  function rerender() {
    if (M().state.view === 'hub' && M().ui.hubTab === 'nodes') M().renderHub();
  }

  function onMessage(message) {
    M().ui.toolDirty = false;
    if (!pending) return;
    if (pending.kind === 'custom' && message.saved === pending.name) {
      pending.popup.done();
      pending = null;
    } else if (pending.kind === 'mcp' && (message.mcp || []).some((entry) => entry.name === pending.name)) {
      pending.popup.done();
      M().toast(`บันทึก MCP ${pending.name} แล้ว ✓`, 'กำลังต่อ server เพื่ออ่านรายการเครื่องมือ');
      pending = null;
    }
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.tools = { render, onMessage, onImport, presetEditor, rerender };
})();
