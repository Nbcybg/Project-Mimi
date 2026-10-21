// Node hub: every workflow node type (read-only reference) and every tool (editable when
// custom) plus MCP servers. Workflows pick nodes from the canvas library, not from here.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  /** { mode: 'node' | 'custom' | 'custom-new' | 'mcp' | 'mcp-new', name?, type? } */
  let sel = null;

  function go(next) {
    sel = next;
    M().ui.toolDirty = false;
    M().renderHub();
  }
  function markDirty() {
    M().ui.toolDirty = true;
  }
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
    { label: 'AI', types: ['agent', 'llm', 'classify', 'extract', 'knowledge'] },
    { label: 'ทางแยก', types: ['if', 'switch', 'filter', 'merge'] },
    { label: 'ข้อมูล', types: ['set', 'datetime', 'split_out', 'sort', 'limit', 'aggregate', 'remove_duplicates', 'code'] },
    { label: 'ไฟล์', types: ['file', 'extract_file', 'sheets'] },
    { label: 'วน / รอ', types: ['loop', 'workflow', 'wait', 'stop', 'approval'] },
    { label: 'เชื่อมต่อ', types: ['http', 'tool', 'chat', 'telegram', 'respond'] },
  ];
  const groupOf = (type) => {
    if (String(type).startsWith('trigger_')) return 'ทริกเกอร์';
    return NODE_GROUPS.find((group) => group.types.includes(type))?.label || 'อื่น ๆ';
  };

  // ---------- node reference ----------
  function nodePanel(type) {
    const spec = (M().state.nodeTypes || []).find((entry) => entry.type === type);
    const panel = el('div', 'panel');
    if (!spec) {
      panel.append(el('h3', '', 'ไม่พบ node'), el('p', 'hint', 'node นี้อาจถูกถอดออกแล้ว'));
      return panel;
    }
    panel.append(el('h3', '', spec.label), el('p', 'hint', `node กลางของ Workflow · ${groupOf(type)} · แก้ค่าต่อ workflow ได้ในหน้าผัง`));
    const meta = el('div', 'grid2');
    meta.append(M().labelled('ชนิด (type)', el('code', 'mono', spec.type)), M().labelled('กลุ่ม', el('span', '', groupOf(type))));
    panel.append(meta);
    panel.append(el('p', '', spec.description));
    panel.append(el('h4', '', 'เอาต์พุต'));
    const outputs = el('div', 'hstack');
    for (const output of spec.outputs || []) outputs.append(el('span', 'chip', `${output.key} · ${output.label}`));
    panel.append(outputs);
    if ((spec.fields || []).length > 0) {
      panel.append(el('h4', '', `ช่องตั้งค่า (${spec.fields.length})`));
      const rows = el('div', 'tbl');
      const head = el('div', 'hd');
      head.append(el('span', '', 'ช่อง'), el('span', '', 'key'), el('span', '', 'ชนิด'), el('span', '', ''));
      rows.append(head);
      for (const field of spec.fields) {
        const row = el('div');
        row.append(
          el('span', '', `${field.label}${field.required ? ' *' : ''}`),
          el('span', 'mono', field.key),
          el('span', 'muted', field.type),
          el('span', 'muted', field.required ? 'จำเป็น' : 'ไม่บังคับ'),
        );
        rows.append(row);
      }
      panel.append(rows);
    }
    if (spec.triggerPool) {
      const pool = (M().state.workflowPool || []).find((entry) => entry.name === spec.triggerPool);
      if (pool) {
        panel.append(el('h4', '', 'ทริกเกอร์'));
        panel.append(el('p', 'hint', `${pool.label} (${pool.kind}) · ${pool.description}`));
        panel.append(el('p', 'hint', `ข้อมูลตัวอย่าง: ${JSON.stringify(pool.sample)}`));
      }
    }
    panel.append(el('p', 'hint', 'เพิ่ม node นี้ได้จากแถบ Node ด้านซ้ายของหน้าผัง — คลิกหรือลากมาวาง แล้วต่อสายได้เลย'));
    return panel;
  }

  // ---------- list ----------
  function listPanel() {
    const panel = el('div', 'panel');
    const nodes = M().state.nodeTypes || [];
    const tools = M().state.tools || [];
    panel.append(el('h3', '', `Node (${nodes.length}) · เครื่องมือ (${tools.length})`));
    panel.append(
      el(
        'p',
        'hint',
        'Node = ทุกชนิดที่เอาไปวางใน workflow ได้ รวม node ทริกเกอร์ · เครื่องมือ = ของที่ agent เรียกใช้ได้ (builtin / custom / MCP) · JavaScript ที่อยากใช้ซ้ำทั้งในแชตและ workflow ให้สร้างเป็นเครื่องมือ kind code แล้วเรียกจาก node "tool"',
      ),
    );
    const addRow = el('div', 'hstack');
    addRow.style.margin = '0 0 10px';
    addRow.append(
      button('btn', '+ เครื่องมือใหม่', () => go({ mode: 'custom-new' })),
      button('btn', '+ Node (JS)', () => go({ mode: 'custom-new-js' })),
    );
    panel.append(addRow);

    const groups = new Map();
    for (const spec of nodes) {
      const label = groupOf(spec.type);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(spec);
    }
    if (nodes.length > 0) {
      panel.append(el('h4', '', 'Node'));
      for (const [label, specs] of groups) {
        panel.append(el('p', 'hint', label));
        const rows = el('div', 'tbl poolrows');
        for (const spec of specs) {
          const row = el('button');
          row.type = 'button';
          const name = el('span', 'nm2');
          name.append(el('b', '', spec.label), el('small', 'badge', spec.type));
          row.append(
            name,
            el('span', 'muted', String((spec.fields || []).length) + ' ช่อง'),
            el('span', 'muted', (spec.outputs || []).map((output) => output.key).join(', ')),
            el('span', 'muted', spec.description),
            el('span', 'faint', 'ดู'),
          );
          row.onclick = () => go({ mode: 'node', type: spec.type });
          if (sel && sel.mode === 'node' && sel.type === spec.type) row.classList.add('sel');
          rows.append(row);
        }
        panel.append(rows);
      }
    }

    panel.append(el('h4', '', 'เครื่องมือ'));
    const rows = el('div', 'tbl poolrows');
    const head = el('div', 'hd');
    for (const label of ['ชื่อ', 'ระดับ', 'ที่รัน', 'ใช้โดย', '']) head.append(el('span', '', label));
    rows.append(head);
    for (const tool of tools) {
      const row = el('div');
      const name = el('span', 'nm2');
      name.append(el('b', 'mono', tool.name));
      name.append(el('small', `badge${tool.builtin ? '' : ' custom'}`, tool.mcp ? `MCP · ${tool.mcp}` : tool.builtin ? 'builtin' : 'custom'));
      if (tool.settings && tool.settings.length > 0) name.append(el('small', 'badge', `${tool.settings.length} settings`));
      const risk = el('span');
      risk.append(el('span', `risk${tool.risk === 'read' ? '' : ' w'}`, tool.risk));
      const users = usersOf(tool.name);
      const actions = el('span', 'hstack');
      if (tool.mcp) actions.append(button('btn ghost', 'server', () => go({ mode: 'mcp', name: tool.mcp })));
      else if (!tool.builtin) actions.append(button('btn ghost', 'แก้ไข', () => go({ mode: 'custom', name: tool.name })));
      else actions.append(el('span', 'faint', 'builtin'));
      row.append(name, risk, el('span', 'muted', tool.target === 'pc' ? 'PC' : 'core'), el('span', 'muted', users.join(', ') || '—'), actions);
      rows.append(row);
    }
    panel.append(rows);
    panel.append(mcpList());
    return panel;
  }

  // ---------- MCP servers ----------
  function mcpList() {
    const box = el('div');
    const servers = M().state.toolMcp || [];
    box.append(el('h3', '', `MCP server (${servers.length})`));
    box.append(el('p', 'hint', 'ต่อเครื่องมือจาก MCP server ภายนอก (คำสั่งในเครื่อง หรือ URL) · เครื่องมือจะชื่อ mcp_<server>_<tool> · ใส่ mcp_<server> ใน agent = ได้ทุกตัวของ server นั้น'));
    const add = button('btn', '+ MCP server', () => go({ mode: 'mcp-new' }));
    add.style.margin = '0 0 10px';
    box.append(add);
    for (const server of servers) {
      const row = el('div', 'hstack');
      row.style.margin = '4px 0';
      const state = !server.enabled ? 'ปิดอยู่' : server.error ? 'ต่อไม่ได้' : server.checkedAt ? `${server.tools.length} เครื่องมือ` : 'ยังไม่ได้ต่อ';
      row.append(
        button('chip', `${server.title || server.name} · ${server.transport}${server.runsOn === 'pc' ? ' · PC' : ''}`, () => go({ mode: 'mcp', name: server.name })),
        el('span', server.error ? 'badtxt' : 'muted', state),
      );
      box.append(row);
    }
    return box;
  }

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

  function mcpEditor(spec, isNew) {
    const form = el('div', 'panel form');
    form.oninput = markDirty;
    form.append(el('h3', '', isNew ? 'MCP server ใหม่' : `MCP: ${spec.title || spec.name}`));
    const name = M().textInput(spec.name, 'เช่น github');
    const title = M().textInput(spec.title || '', 'ชื่อที่โชว์ (ไม่บังคับ)');
    const top = el('div', 'grid2');
    top.append(M().labelled('ชื่อ (a-z 0-9 -)', name), M().labelled('ชื่อที่โชว์', title));
    const transport = select(['stdio', 'http'], spec.transport || 'stdio');
    const risk = select(['write', 'read', 'network', 'shell', 'delete'], spec.risk || 'write');
    const mid = el('div', 'grid2');
    mid.append(M().labelled('ต่อแบบ', transport), M().labelled('ระดับของเครื่องมือที่ไม่ได้บอกว่าอ่านอย่างเดียว', risk));
    const runsOn = select(['core', 'pc'], spec.runsOn || 'core');
    form.append(top, mid, M().labelled('รันที่ (core = เครื่องที่รัน Mimi · pc = คอมของคุณผ่าน PC agent, ใช้ได้เมื่อ core อยู่บนเครื่องอื่น)', runsOn));

    const command = M().textInput(spec.command || '', 'เช่น npx');
    const args = textarea((spec.args || []).join('\n'), '-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\me\\Documents');
    const cwd = M().textInput(spec.cwd || '', 'เว้นว่างได้');
    const env = textarea(pairsText(spec.env, '='), 'GITHUB_TOKEN={{secret.GITHUB_TOKEN}}');
    const stdioBox = el('div');
    stdioBox.append(M().labelled('คำสั่ง', command), M().labelled('อาร์กิวเมนต์ (บรรทัดละตัว)', args), M().labelled('โฟลเดอร์ทำงาน', cwd), M().labelled('ตัวแปร env (KEY=ค่า บรรทัดละตัว)', env));
    const url = M().textInput(spec.url || '', 'https://example.com/mcp');
    const headers = textarea(pairsText(spec.headers, ': '), 'Authorization: Bearer {{secret.MY_KEY}}');
    const httpBox = el('div');
    httpBox.append(M().labelled('URL', url), M().labelled('Headers (ชื่อ: ค่า บรรทัดละตัว)', headers));
    const showTransport = () => {
      stdioBox.hidden = transport.value !== 'stdio';
      httpBox.hidden = transport.value !== 'http';
    };
    transport.onchange = showTransport;
    showTransport();
    form.append(stdioBox, httpBox);

    const check = (label, checked, hint) => {
      const wrap = el('label', 'hstack');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = checked;
      wrap.append(box, el('span', '', label));
      if (hint) wrap.title = hint;
      form.append(wrap);
      return box;
    };
    const enabled = check('เปิดใช้', spec.enabled !== false);
    const untrusted = check('ผลลัพธ์อาจมีข้อความจากคนอื่น (เว็บ / อีเมล)', spec.untrusted !== false, 'ติ๊กไว้ = agent ที่ใช้ตัวนี้จะมีเครื่องมือ shell ไม่ได้');
    form.append(el('p', 'hint', 'ค่าลับ (token) ใส่ในหน้าค่าลับ แล้วอ้างด้วย {{secret.ชื่อ}} · server แบบคำสั่งจะได้ env แค่ที่ระบุ ไม่เห็น API key ของ Mimi'));

    if (!isNew) {
      const status = el('div');
      if (spec.error) status.append(el('p', 'hint badtxt', `ต่อไม่ได้: ${spec.error}`));
      if (spec.checkedAt) status.append(el('p', 'hint', `อ่านรายการล่าสุด ${M().fmtDate(spec.checkedAt)}`));
      if (spec.tools.length > 0) {
        const list = el('div', 'tbl');
        for (const tool of spec.tools) {
          const row = el('div');
          const risk = el('span');
          risk.append(el('span', `risk${tool.risk === 'read' ? '' : ' w'}`, tool.risk));
          const description = el('span', 'muted', tool.description);
          description.title = tool.description;
          row.append(el('span', 'mono', tool.name), risk, description);
          list.append(row);
        }
        status.append(el('h4', '', `เครื่องมือ (${spec.tools.length})`), list);
      }
      form.append(status);
    }

    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'));
    if (!isNew) {
      foot.append(
        button('btn danger', 'ลบ', () => {
          if (confirm(`ลบ MCP server "${spec.name}" ?`)) {
            M().send({ type: 'mcp-delete', name: spec.name });
            sel = null;
          }
        }),
        button('btn', 'ต่อใหม่ / อ่านรายการ', () => {
          M().send({ type: 'mcp-refresh', name: spec.name });
          M().toast('MCP', 'กำลังต่อ server…');
        }),
      );
    }
    foot.append(
      button('btn pri', 'บันทึก', () => {
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
        sel = { mode: 'mcp', name: server.name };
        M().ui.toolDirty = false;
        M().send({ type: 'mcp-save', server, renameFrom: isNew ? undefined : spec.name });
      }),
    );
    form.append(foot);
    return form;
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

  function customEditor(spec, isNew) {
    const form = el('div', 'panel form');
    form.oninput = markDirty;
    form.append(el('h3', '', isNew ? 'เครื่องมือใหม่' : `แก้ไข ${spec.name}`));

    const name = M().textInput(spec.name, 'เช่น fetch_rates');
    const kind = select(['http', 'code', 'shell'], spec.kind);
    const top = el('div', 'grid2');
    top.append(M().labelled('ชื่อ (a-z 0-9 - _)', name), M().labelled('ชนิด', kind));
    const description = M().textInput(spec.description, 'ทำอะไร — โมเดลอ่านบรรทัดนี้');
    form.append(top, M().labelled('คำอธิบาย', description));

    form.append(el('h4', '', 'พารามิเตอร์ (โมเดลส่งค่ามาตอนเรียก)'));
    const params = paramsEditor(spec.params || []);
    form.append(params);

    form.append(el('h4', '', 'ค่าตั้งต้น'));
    const settings = settingsEditor(spec.settings || []);
    form.append(settings, el('p', 'hint', 'ในเทมเพลตใช้ {{input.ชื่อพารามิเตอร์}} {{settings.ชื่อค่าตั้งต้น}} {{secret.ชื่อ_ENV}}'));

    form.append(el('h4', '', 'การทำงาน'));
    const config = spec.config || {};
    const configBox = el('div');
    form.append(configBox);
    let readConfig = () => ({});
    const paintConfig = () => {
      configBox.replaceChildren();
      if (kind.value === 'http') {
        const method = select(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], String(config.method || 'GET').toUpperCase());
        const bodyType = select(['json', 'text', 'form'], config.bodyType || 'json');
        const methodRow = el('div', 'grid2');
        methodRow.append(M().labelled('Method', method), M().labelled('รูปแบบ body', bodyType));
        const url = M().textInput(config.url || '', 'https://api.example.com/items/{{input.id}}');
        const headers = kvEditor(config.headers);
        const query = kvEditor(config.query);
        const body = textarea(config.body || '', '{"date":"{{input.date}}"}');
        configBox.append(methodRow, M().labelled('URL', url));
        configBox.append(el('h4', '', 'Headers'), headers, el('h4', '', 'Query'), query, el('h4', '', 'Body'), body);
        readConfig = () => ({
          method: method.value,
          url: url.value.trim(),
          headers: readKvs(headers),
          query: readKvs(query),
          bodyType: bodyType.value,
          ...(body.value.trim() ? { body: body.value } : {}),
        });
      } else if (kind.value === 'code') {
        const code = textarea(config.code || '', '// input.x = ค่าที่โมเดลส่งมา, settings.x = ค่าตั้งต้น\nreturn "ผลลัพธ์"', 'tall');
        const timeout = M().textInput(config.timeoutMs || '', '10000', 'number');
        configBox.append(M().labelled('โค้ด JavaScript (ต้อง return ค่า)', code), M().labelled('timeout (ms)', timeout));
        readConfig = () => ({ code: code.value, ...(timeout.value ? { timeoutMs: Number(timeout.value) } : {}) });
      } else {
        const command = M().textInput(config.command || '', 'เช่น ping -n 1 {{input.host}}');
        const cwd = M().textInput(config.cwd || '', 'เว้นว่าง = โฟลเดอร์แรกที่อนุญาต');
        const timeout = M().textInput(config.timeoutMs || '', '60000', 'number');
        const runsOn = select(['core', 'pc'], config.runsOn || 'core');
        configBox.append(M().labelled('คำสั่ง', command), M().labelled('โฟลเดอร์ทำงาน', cwd), M().labelled('timeout (ms)', timeout), M().labelled('รันที่ (core = เครื่องที่รัน Mimi · pc = คอมของคุณผ่าน PC agent)', runsOn));
        readConfig = () => ({
          command: command.value,
          ...(runsOn.value === 'pc' ? { runsOn: 'pc' } : {}),
          ...(cwd.value.trim() ? { cwd: cwd.value.trim() } : {}),
          ...(timeout.value ? { timeoutMs: Number(timeout.value) } : {}),
        });
      }
    };
    kind.onchange = paintConfig;
    paintConfig();

    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'));
    if (!isNew) {
      foot.append(
        button('btn danger', 'ลบ', () => {
          if (confirm(`ลบเครื่องมือ "${spec.name}" ?`)) {
            M().send({ type: 'tool-delete', name: spec.name });
            sel = null;
          }
        }),
      );
    }
    foot.append(
      button('btn pri', 'บันทึก', () => {
        if (!name.value.trim() || !description.value.trim()) return M().toast('กรอกไม่ครบ', 'ต้องมีชื่อและคำอธิบาย', true);
        M().send({
          type: 'tool-save',
          renameFrom: isNew ? undefined : spec.name,
          tool: {
            name: name.value.trim(),
            description: description.value.trim(),
            kind: kind.value,
            params: readParams(params),
            settings: readSettings(settings),
            config: readConfig(),
          },
        });
      }),
    );
    form.append(foot);
    return form;
  }

  // ---------- render ----------
  function editor() {
    if (!sel) {
      const panel = el('div', 'panel');
      panel.append(el('h3', '', 'รายละเอียด'), el('p', 'hint', 'เลือก node หรือเครื่องมือทางซ้ายเพื่อดูรายละเอียด'));
      panel.append(
        el(
          'p',
          'hint',
          'HTTP tools = untrusted input (อย่าให้ agent เดียวกันมี shell) · code/shell = ระดับ shell ต้องขออนุญาตทุกครั้ง · ค่าลับเก็บในเครื่องเท่านั้น อ้างผ่าน {{secret.NAME}}',
        ),
      );
      return panel;
    }
    if (sel.mode === 'node') return nodePanel(sel.type);
    if (sel.mode === 'mcp-new') return mcpEditor({ name: '', enabled: true, transport: 'stdio', tools: [] }, true);
    if (sel.mode === 'mcp') {
      const server = (M().state.toolMcp || []).find((entry) => entry.name === sel.name);
      if (!server) {
        sel = null;
        return editor();
      }
      return mcpEditor(server, false);
    }
    if (sel.mode === 'custom-new') {
      return customEditor({ name: '', description: '', kind: 'http', params: [], settings: [], config: {} }, true);
    }
    if (sel.mode === 'custom-new-js') {
      return customEditor(
        {
          name: '',
          description: '',
          kind: 'code',
          params: [],
          settings: [],
          config: { code: '// input.x = ค่าที่โมเดลส่งมา, settings.x = ค่าตั้งต้น\nreturn "ผลลัพธ์";' },
        },
        true,
      );
    }
    const spec = (M().state.toolCustom || []).find((entry) => entry.name === sel.name);
    if (!spec) {
      sel = null;
      return editor();
    }
    return customEditor(spec, false);
  }

  function render() {
    const split = el('div', 'split');
    split.style.gridTemplateColumns = 'minmax(0, 1.15fr) minmax(0, 1fr)';
    split.append(listPanel(), editor());
    return split;
  }

  function onMessage(message) {
    if (message.saved) {
      M().ui.toolDirty = false;
      if ((message.custom || []).some((entry) => entry.name === message.saved)) sel = { mode: 'custom', name: message.saved };
      return;
    }
    if (sel && sel.mode === 'custom' && !(message.custom || []).some((entry) => entry.name === sel.name)) sel = null;
    if (sel && sel.mode === 'mcp' && !(message.mcp || []).some((entry) => entry.name === sel.name)) sel = null;
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.tools = { render, onMessage };
})();
