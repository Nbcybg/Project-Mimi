// Workflows belong to an agent: trigger from the pool -> nodes (agent / llm / classify /
// extract / if / switch / filter / sort / limit / aggregate / remove_duplicates /
// split_out / loop / set / code / http / tool / chat) -> each node passes JSON items on,
// referenced with {{ $json.Field }} (also
// {{ $vars.x }}, {{ $node["ชื่อ node"].json }}, {{ $execution.mode }}, $today, $if…).
// The editor is a stack of cards (a diagram that works on a phone); every run shows
// each node's input and output.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const NODE_GROUPS = [
    { label: 'AI', types: ['agent', 'llm', 'classify', 'extract', 'knowledge'] },
    { label: 'ทางแยก', types: ['if', 'switch', 'filter', 'merge'] },
    { label: 'ข้อมูล', types: ['set', 'datetime', 'split_out', 'sort', 'limit', 'aggregate', 'remove_duplicates', 'code'] },
    { label: 'ไฟล์', types: ['file', 'extract_file'] },
    { label: 'วน / รอ', types: ['loop', 'workflow', 'wait', 'approval'] },
    { label: 'เชื่อมต่อ', types: ['http', 'tool', 'chat', 'telegram', 'respond'] },
  ];
  const OPERATORS = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with', 'regex', 'gt', 'lt', 'gte', 'lte', 'is_empty', 'is_not_empty', 'is_true', 'is_false'];

  let draft = null; // the workflow being edited (deep copy) or null
  let isNew = false;
  let runResult = null;
  let running = false;
  /** "canvas" (diagram) or "list" (cards); a phone starts in the list. */
  let mode = (() => {
    try {
      const stored = localStorage.getItem('mimi.workflowMode');
      if (stored === 'canvas' || stored === 'list') return stored;
    } catch {
      // storage blocked: fall back to the screen size
    }
    return window.innerWidth >= 900 ? 'canvas' : 'list';
  })();
  /** Canvas mode: the selected node, the side panel tab, and the mounted canvas. */
  let selectedNode = null;
  let sideTab = 'node';
  let canvasApi = null;
  /** Stored runs of the workflow being edited (newest first), from `workflow-runs`. */
  let runs = [];
  /** { nodeId, result } while a single-node test dialog is open. */
  let nodeTest = null;
  /** How many stored runs the history list shows. */
  let historyShown = 12;

  // ---------- undo / redo: whole-draft snapshots, taken after each change ----------
  let past = [];
  let future = [];
  let snapshot = null;
  function resetHistory() {
    past = [];
    future = [];
    snapshot = draft ? JSON.stringify(draft) : null;
  }
  function checkpoint() {
    if (!draft) return;
    const now = JSON.stringify(draft);
    if (now === snapshot) return;
    if (snapshot) past.push(snapshot);
    if (past.length > 80) past.shift();
    future = [];
    snapshot = now;
  }
  function restoreSnapshot() {
    const name = draft.name;
    draft = JSON.parse(snapshot);
    if (!isNew) draft.name = name;
    if (selectedNode && !draft.nodes.some((node) => node.id === selectedNode)) selectedNode = null;
    showEditor();
  }
  function undo() {
    sync();
    checkpoint();
    if (past.length === 0) return M().toast('ย้อนไม่ได้แล้ว', null);
    future.push(snapshot);
    snapshot = past.pop();
    restoreSnapshot();
  }
  function redo() {
    if (future.length === 0) return M().toast('ไม่มีอะไรให้ทำซ้ำ', null);
    past.push(snapshot);
    snapshot = future.pop();
    restoreSnapshot();
  }

  /** Ctrl+Z / Ctrl+Y / Ctrl+C / Ctrl+V / Ctrl+D in the canvas editor; text fields keep their own. */
  function editorShortcuts(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) undo();
    else if (key === 'y' || (key === 'z' && event.shiftKey)) redo();
    else if (key === 'c' && selectedNode) copyNode(selectedNode);
    else if (key === 'v') pasteNode(canvasApi?.center?.() ?? null);
    else if (key === 'd' && selectedNode) duplicateNode(selectedNode);
    else return;
    event.preventDefault();
  }

  // After a re-render the focus is on the page body, so listen on the document.
  document.addEventListener('keydown', (event) => {
    if (draft && document.querySelector('#wfEditor.wfcanvas')) editorShortcuts(event);
  });

  // ---------- copy / paste nodes (kept in localStorage, so it works across workflows) ----------
  const CLIP_KEY = 'mimi.workflowClipboard';
  let clipboard = null;
  function copyNode(id) {
    sync();
    const node = draft.nodes.find((entry) => entry.id === id);
    if (!node) return;
    clipboard = JSON.parse(JSON.stringify(node));
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify(clipboard));
    } catch {
      // storage blocked: this window only
    }
    M().toast('คัดลอก node แล้ว', 'กด Ctrl+V เพื่อวาง');
  }
  function pasteNode(position) {
    let copy = clipboard;
    try {
      copy = JSON.parse(localStorage.getItem(CLIP_KEY) || 'null') || copy;
    } catch {
      // keep the in-memory copy
    }
    if (!copy || !specOf(copy.type)) return;
    sync();
    const node = { ...JSON.parse(JSON.stringify(copy)), id: nextId(), links: { main: [] } };
    node.title = `${copy.title || specOf(copy.type).label} (สำเนา)`;
    if (position) node.position = position;
    else if (Array.isArray(copy.position)) node.position = [copy.position[0] + 40, copy.position[1] + 40];
    else delete node.position;
    draft.nodes.push(node);
    selectedNode = node.id;
    sideTab = 'node';
    showEditor();
  }
  function duplicateNode(id) {
    copyNode(id);
    pasteNode(null);
  }

  const nodeTypes = () => M().state.nodeTypes || [];
  const pool = () => M().state.workflowPool || [];
  const specOf = (type) => nodeTypes().find((entry) => entry.type === type);
  const poolOf = (name) => pool().find((entry) => entry.name === name);
  const agentOptions = () => M().state.agents.map((agent) => [agent.name, `${M().nameOf(agent.name)} (${agent.name})`]);

  function selectOf(options, value, emptyLabel) {
    const select = el('select');
    if (emptyLabel !== undefined) {
      const option = el('option', '', emptyLabel);
      option.value = '';
      select.append(option);
    }
    for (const [key, label] of options) {
      const option = el('option', '', label);
      option.value = key;
      select.append(option);
    }
    select.value = value ?? '';
    return select;
  }

  // ---------- list (inside the agent editor) ----------
  function render(container, agent) {
    const list = (M().state.workflows || []).filter((workflow) => workflow.agent === agent);
    container.append(el('p', 'hint', 'ต่อ flow ของ agent นี้: trigger (จาก pool) → node ต่าง ๆ → chat · ใช้ {{ $json.Field }} อ้างข้อมูลจาก trigger/node ก่อนหน้า · รันแล้วเห็น input/output ทุก node'));
    const rows = el('div', 'tbl wfrows');
    for (const workflow of list) {
      const row = el('div');
      const title = el('span', 'nm2');
      title.append(el('b', '', workflow.title || workflow.name), el('small', 'muted', ` · ${workflow.name}`));
      const trigger = el('span');
      trigger.append(el('span', 'chip', poolOf(workflow.trigger.pool)?.label || workflow.trigger.pool));
      const status = el('span');
      status.append(el('span', `pill ${workflow.enabled ? 'ok' : 'todo'}`, workflow.enabled ? 'เปิด' : 'ปิด'));
      const actions = el('span', 'hstack');
      actions.append(
        button('btn ghost', 'แก้ไข', () => openEditor(agent, workflow)),
        button('btn ghost', 'รัน', () => promptRun(workflow)),
        button('btn ghost', workflow.enabled ? 'ปิด' : 'เปิด', () =>
          M().send({ type: 'workflow-save', workflow: { ...workflow, enabled: !workflow.enabled } }),
        ),
        button('btn ghost', 'ลบ', () => {
          if (confirm(`ลบ workflow "${workflow.name}" ?`)) M().send({ type: 'workflow-delete', agent, name: workflow.name });
        }),
      );
      row.append(title, trigger, el('span', 'muted', `${workflow.nodes.length} node`), status, actions);
      rows.append(row);
    }
    if (list.length === 0) rows.append(el('div', 'empty', 'ยังไม่มี workflow ของ agent นี้'));
    container.append(rows);
    const add = button('btn', '+ Workflow ใหม่', () => openEditor(agent, null));
    const importButton = button('btn ghost', 'นำเข้าจาก n8n', () => openImport(agent), 'แปลงไฟล์ JSON ที่ export จาก n8n เป็น workflow ของ agent นี้');
    const row = el('div', 'hstack');
    row.style.marginTop = '8px';
    row.append(add, importButton);
    container.append(row);
  }

  // ---------- editor ----------
  function newDraft(agent) {
    const firstAgent = agent;
    return {
      name: '',
      agent,
      title: '',
      description: '',
      enabled: true,
      trigger: { pool: 'manual', config: {} },
      webhook: null,
      vars: {},
      nodes: [
        { id: 'n1', type: 'agent', title: 'AI agent', config: { agent: firstAgent, instruction: '' }, links: { main: ['n2'] } },
        { id: 'n2', type: 'chat', title: 'ส่งเข้าแชต', config: { text: '{{ $json.text }}' }, links: { main: [] } },
      ],
    };
  }

  function openEditor(agent, workflow) {
    draft = workflow ? JSON.parse(JSON.stringify(workflow)) : newDraft(agent);
    isNew = !workflow;
    runResult = null;
    runs = [];
    selectedNode = null;
    sideTab = 'node';
    historyShown = 12;
    resetHistory();
    showEditor();
    if (workflow) M().send({ type: 'workflow-runs', agent: workflow.agent, name: workflow.name });
    M().send({ type: 'secrets-list' });
    M().send({ type: 'knowledge-list' });
  }

  /** Pushes what is typed in the overlay into the draft before any re-render. */
  function sync() {
    if (!draft) return;
    const root = document.getElementById('wfEditor');
    if (!root) return;
    const name = root.querySelector('#wfnName');
    if (name) draft.name = name.value.trim();
    const title = root.querySelector('#wfnTitle');
    if (title) draft.title = title.value.trim();
    const enabled = root.querySelector('#wfnEnabled');
    if (enabled) draft.enabled = enabled.checked;
    const vars = root.querySelector('#wfnVars');
    if (vars) {
      try {
        draft.vars = JSON.parse(vars.value || '{}');
      } catch {
        // invalid JSON: keep what was there before
      }
    }
    const errorWorkflow = root.querySelector('#wfnErrorWorkflow');
    if (errorWorkflow) {
      if (errorWorkflow.value) draft.errorWorkflow = errorWorkflow.value;
      else delete draft.errorWorkflow;
    }
    // trigger config
    for (const node of root.querySelectorAll('[data-trigger-field]')) draft.trigger.config[node.dataset.triggerField] = fieldValue(node);
    // nodes
    for (const card of root.querySelectorAll('.wcard')) {
      const node = draft.nodes.find((entry) => entry.id === card.dataset.id);
      if (!node) continue;
      const titleInput = card.querySelector('.wtitle');
      if (titleInput) node.title = titleInput.value;
      for (const field of card.querySelectorAll('[data-field]')) node.config[field.dataset.field] = fieldValue(field);
      for (const field of card.querySelectorAll('[data-nodefield]')) node[field.dataset.nodefield] = fieldValue(field);
      // Links are edited on the draft directly (see linkGridFor), so there is nothing to read here.
    }
  }

  function fieldValue(field) {
    if (field.dataset.kind === 'json') {
      try {
        return JSON.parse(field.value || '{}');
      } catch {
        return field.value;
      }
    }
    if (field.dataset.kind === 'number') return field.value === '' ? undefined : Number(field.value);
    if (field.dataset.kind === 'boolean') return field.checked;
    return field.value;
  }

  function fieldInput(field, value, node) {
    if (field.key === 'conditions') return conditionsField(field, value, node);
    if (field.key === 'categories' && node) {
      return rowsField(field, value, {
        columns: [
          { key: 'name', placeholder: 'ชื่อหมวด เช่น ใบแจ้งหนี้' },
          { key: 'description', placeholder: 'อธิบายว่าอะไรนับเป็นหมวดนี้ (ช่วยให้ model เลือกถูก)' },
        ],
        blank: { name: '', description: '' },
        addLabel: '+ เพิ่มหมวด',
        emptyHint: 'ยังไม่มีหมวด — กด "เพิ่มหมวด"',
        cls: 'wrow2',
        // Each named category is an output; a name typed or a row removed redraws the links.
        onChange: () => refreshLinks(node),
      });
    }
    if (field.key === 'attributes' && node) {
      return rowsField(field, value, {
        columns: [
          { key: 'name', placeholder: 'ชื่อ field เช่น amount' },
          { key: 'type', options: ['string', 'number', 'boolean', 'array', 'object'] },
          { key: 'description', placeholder: 'อธิบาย เช่น ยอดรวมที่ต้องจ่าย (บาท)' },
          { key: 'required', checkbox: 'ต้องมี' },
        ],
        blank: { name: '', type: 'string', description: '', required: false },
        addLabel: '+ เพิ่ม field',
        emptyHint: 'ยังไม่มี field — กด "เพิ่ม field"',
        cls: 'wrow4',
      });
    }
    if (field.key === 'model' && node) return modelField(field, value);
    let node_;
    if (field.type === 'text' || field.type === 'json') {
      node_ = el('textarea');
      node_.value = field.type === 'json' ? (typeof value === 'string' ? value : JSON.stringify(value ?? {}, null, 2)) : String(value ?? '');
    } else if (field.type === 'boolean') {
      node_ = el('input');
      node_.type = 'checkbox';
      node_.checked = value === true || value === 'true';
    } else if (Array.isArray(field.options)) {
      node_ = selectOf(field.options.map((option) => [option, option]), String(value ?? field.options[0] ?? ''));
    } else if (field.key === 'workflow') {
      const options = (M().state.workflows || [])
        .filter((entry) => entry.agent === draft.agent && entry.name !== draft.name)
        .map((entry) => [entry.name, `${entry.title || entry.name} (${entry.name})`]);
      node_ = selectOf(options, String(value ?? ''), '— เลือก workflow —');
    } else if (field.key === 'collection') {
      node_ = selectOf(
        (M().state.knowledge || []).map((entry) => [entry.name, `${entry.title} (${entry.name})`]),
        String(value ?? ''),
        '— ทุกคลัง —',
      );
    } else if (field.key === 'agent') {
      node_ = selectOf(agentOptions(), String(value ?? ''), field.required ? undefined : '— agent เริ่มต้น —');
    } else if (field.key === 'tool') {
      node_ = selectOf(
        (M().state.tools || []).map((tool) => [tool.name, `${tool.name} (${tool.risk})`]),
        String(value ?? ''),
        '— เลือกเครื่องมือ —',
      );
    } else if (field.key === 'operator') {
      node_ = selectOf(OPERATORS.map((op) => [op, op]), String(value ?? 'contains'));
    } else {
      node_ = M().textInput(value === undefined || value === null ? '' : String(value), field.placeholder || '');
    }
    node_.dataset.field = field.key;
    node_.dataset.kind = field.type;
    if (field.type === 'json') node_.dataset.kind = 'json';
    return node_;
  }

  /**
   * The conditions editor: one row per condition (left / operator / right) plus a
   * hidden JSON field that sync() reads. Old single-condition configs are shown too.
   */
  function conditionsField(field, value, node) {
    const list = [];
    const initial =
      Array.isArray(value) && value.length > 0
        ? value
        : node && (node.config.left !== undefined || node.config.right !== undefined || node.config.operator !== undefined)
          ? [{ left: node.config.left, operator: node.config.operator || 'contains', right: node.config.right }]
          : [];
    for (const entry of initial) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      list.push({ left: String(entry.left ?? ''), operator: String(entry.operator || 'contains'), right: String(entry.right ?? '') });
    }
    const wrap = el('div', 'wcond');
    const rows = el('div');
    const hidden = el('textarea');
    hidden.style.display = 'none';
    hidden.dataset.field = field.key;
    hidden.dataset.kind = 'json';
    const write = () => {
      const kept = list.filter((condition) => !(condition.left === '' && condition.right === '' && condition.operator === 'contains'));
      hidden.value = JSON.stringify(kept);
    };
    const build = () => {
      rows.textContent = '';
      list.forEach((condition, index) => {
        const row = el('div', 'hstack wcondrow');
        const left = M().textInput(condition.left, '{{ $json.field }}');
        left.oninput = () => {
          condition.left = left.value;
          write();
        };
        const operator = selectOf(OPERATORS.map((op) => [op, op]), condition.operator);
        operator.onchange = () => {
          condition.operator = operator.value;
          write();
        };
        const right = M().textInput(condition.right, 'ค่าเทียบ');
        right.oninput = () => {
          condition.right = right.value;
          write();
        };
        const remove = button('btn ghost', '✕', () => {
          list.splice(index, 1);
          write();
          build();
        });
        row.append(left, operator, right, remove);
        rows.append(row);
      });
      if (list.length === 0) rows.append(el('p', 'hint', 'ยังไม่มีเงื่อนไข — กด "เพิ่มเงื่อนไข"'));
    };
    const add = button('btn ghost', '+ เพิ่มเงื่อนไข', () => {
      list.push({ left: '', operator: 'contains', right: '' });
      write();
      build();
    });
    build();
    write();
    wrap.append(rows, add, hidden);
    return wrap;
  }

  /** Model of the llm / classify / extract nodes: the agent's own models first, then the pool. */
  function modelField(field, value) {
    const current = String(value ?? '');
    const select = M().modelSelect(current === '@small' ? '' : current, 'model หลักของ agent');
    const small = el('option', '', '— small model ของ agent (ถูกและเร็ว) —');
    small.value = '@small';
    select.insertBefore(small, select.options[1] || null);
    select.value = current;
    select.dataset.field = field.key;
    select.dataset.kind = 'string';
    return select;
  }

  /**
   * A list of small records (categories, extract fields) edited as rows, plus the
   * hidden JSON field sync() reads. Rows whose first column is empty are not saved.
   */
  function rowsField(field, value, spec) {
    const list = (Array.isArray(value) ? value : [])
      .map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : { [spec.columns[0].key]: String(entry ?? '') }))
      .map((entry) => ({ ...spec.blank, ...entry }));
    const wrap = el('div', 'wcond');
    const rows = el('div');
    const hidden = el('textarea');
    hidden.style.display = 'none';
    hidden.dataset.field = field.key;
    hidden.dataset.kind = 'json';
    const first = spec.columns[0].key;
    const write = () => {
      hidden.value = JSON.stringify(list.filter((entry) => String(entry[first] ?? '').trim() !== ''));
    };
    const build = () => {
      rows.textContent = '';
      list.forEach((entry, index) => {
        const row = el('div', `wcondrow ${spec.cls}`);
        for (const column of spec.columns) {
          let input;
          if (column.options) {
            input = selectOf(column.options.map((option) => [option, option]), String(entry[column.key] ?? column.options[0]));
            input.onchange = () => {
              entry[column.key] = input.value;
              write();
            };
          } else if (column.checkbox) {
            input = el('label', 'wcheck');
            const box = el('input');
            box.type = 'checkbox';
            box.checked = entry[column.key] === true;
            box.onchange = () => {
              entry[column.key] = box.checked;
              write();
            };
            input.append(box, el('span', '', column.checkbox));
          } else {
            input = M().textInput(String(entry[column.key] ?? ''), column.placeholder || '');
            input.oninput = () => {
              entry[column.key] = input.value;
              write();
            };
            if (column === spec.columns[0]) input.onchange = () => spec.onChange?.();
          }
          row.append(input);
        }
        row.append(
          button('btn ghost', '✕', () => {
            list.splice(index, 1);
            write();
            build();
            spec.onChange?.();
          }),
        );
        rows.append(row);
      });
      if (list.length === 0) rows.append(el('p', 'hint', spec.emptyHint));
    };
    const add = button('btn ghost', spec.addLabel, () => {
      list.push({ ...spec.blank });
      write();
      build();
    });
    build();
    write();
    wrap.append(rows, add, hidden);
    return wrap;
  }

  // ---------- field picker: insert {{ … }} from data seen in the last run ----------

  /** Text-like inputs take expressions; selects (agent, model, tool…) and row editors do not. */
  const pickable = (field, input) =>
    (input.tagName === 'INPUT' && input.type === 'text') || input.tagName === 'TEXTAREA'
      ? !Array.isArray(field.options) && field.type !== 'number' && field.type !== 'boolean'
      : false;

  /** A path segment in expression syntax: `.name` when it is a plain identifier, else `["name"]`. */
  const segment = (key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);

  const preview = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text === undefined ? '' : text.length > 48 ? `${text.slice(0, 48)}…` : text;
  };

  /** Every path in a sample object (three levels; arrays show their first entry). */
  function pathsOf(value, base, depth = 0, out = []) {
    if (!value || typeof value !== 'object' || depth > 2) return out;
    const entries = Array.isArray(value) ? (value.length > 0 ? [['0', value[0]]] : []) : Object.entries(value);
    for (const [key, child] of entries) {
      const path = Array.isArray(value) ? `${base}[0]` : `${base}${segment(key)}`;
      out.push({ path, value: child });
      pathsOf(child, path, depth + 1, out);
    }
    return out;
  }

  /** Nodes that run before this one (every predecessor, all the way back). */
  function ancestorsOf(nodeId) {
    const seen = new Set();
    const walk = (id) => {
      for (const other of draft.nodes) {
        if (seen.has(other.id)) continue;
        if (Object.values(other.links || {}).some((targets) => targets.includes(id))) {
          seen.add(other.id);
          walk(other.id);
        }
      }
    };
    walk(nodeId);
    return draft.nodes.filter((node) => seen.has(node.id));
  }

  /** What the picker offers for a node: its input, earlier nodes' outputs, vars and built-ins. */
  function pickerGroups(node) {
    const groups = [];
    const ran = (id) => runResult?.nodes?.find((entry) => entry.id === id);
    const own = ran(node.id);
    const ancestors = ancestorsOf(node.id);
    let sample = own?.input?.[0]?.json;
    let note = 'จากการรันล่าสุด';
    if (!sample) {
      const parent = ancestors.map((other) => ran(other.id)).find((entry) => entry && entry.output.length > 0);
      sample = parent?.output?.[0]?.json;
    }
    if (!sample) {
      sample = draft.trigger.pool === 'manual' && draft.trigger.config.input ? draft.trigger.config.input : poolOf(draft.trigger.pool)?.sample;
      note = 'ตัวอย่างจาก trigger — รันก่อนเพื่อเห็นข้อมูลจริง';
    }
    groups.push({ label: `ข้อมูลที่ไหลเข้ามา ($json) · ${note}`, items: pathsOf(sample || {}, '$json') });
    for (const other of ancestors) {
      const output = ran(other.id)?.output?.[0]?.json;
      if (!output) continue;
      const name = other.title?.trim() || other.id;
      groups.push({ label: `ผลของ node "${name}"`, items: pathsOf(output, `$node[${JSON.stringify(name)}].json`) });
    }
    const vars = pathsOf(draft.vars || {}, '$vars');
    if (vars.length > 0) groups.push({ label: 'ตัวแปรของ workflow', items: vars });
    groups.push({
      label: 'ค่าพื้นฐาน',
      items: [
        { path: '$today', value: 'วันนี้ YYYY-MM-DD' },
        { path: '$now', value: 'เวลาตอนนี้ (ISO)' },
        { path: '$index', value: 'ลำดับของ item' },
        { path: '$execution.mode', value: 'manual / schedule / webhook…' },
        { path: '$workflow.title', value: draft.title || draft.name || '' },
      ],
    });
    return groups;
  }

  /** Puts `{{ path }}` where the cursor is (or over the selection) and tells sync about it. */
  function insertAt(input, path) {
    const text = `{{ ${path} }}`;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    input.focus();
    input.selectionStart = input.selectionEnd = start + text.length;
    input.dispatchEvent(new Event('input'));
  }

  /** Sample data for a node's expressions: what it got in the last run, else its parents' output, else the trigger sample. */
  function sampleFor(node) {
    const ran = (id) => runResult?.nodes?.find((entry) => entry.id === id);
    let json = ran(node.id)?.input?.[0]?.json;
    if (!json) json = ancestorsOf(node.id).map((other) => ran(other.id)).find((entry) => entry && entry.output.length > 0)?.output?.[0]?.json;
    if (!json) json = (draft.trigger.pool === 'manual' && draft.trigger.config.input) || poolOf(draft.trigger.pool)?.sample || {};
    const nodes = {};
    for (const view of runResult?.nodes || []) {
      if (view.output.length === 0) continue;
      const record = { json: view.output[0].json, items: view.output.map((item) => item.json) };
      nodes[view.title] = record;
      nodes[view.id] = record;
    }
    return { json: json && typeof json === 'object' ? json : {}, nodes };
  }

  let previewSeq = 0;
  const previewWaiters = new Map();
  function onExprPreview(message) {
    const waiter = previewWaiters.get(message.reqId);
    previewWaiters.delete(message.reqId);
    waiter?.(message);
  }

  /**
   * Live help while typing an expression: a preview line ("= value" for the sample
   * data) and suggestions after "$json." / "$node[…]" inside {{ }}.
   */
  function exprAssist(input, node) {
    const line = el('div', 'wprev');
    line.hidden = true;
    input.after(line);
    let timer = null;
    const update = () => {
      clearTimeout(timer);
      if (!input.value.includes('{{')) {
        line.hidden = true;
        return;
      }
      timer = setTimeout(() => {
        const reqId = ++previewSeq;
        previewWaiters.set(reqId, (reply) => {
          line.hidden = false;
          line.className = reply.ok ? 'wprev' : 'wprev bad';
          line.textContent = reply.ok ? `= ${reply.value === '' ? '(ว่าง)' : reply.value}` : `⚠ ${reply.error}`;
        });
        const sample = sampleFor(node);
        M().send({ type: 'workflow-expr-preview', reqId, text: input.value, json: sample.json, nodes: sample.nodes, vars: draft.vars || {} });
      }, 350);
    };
    let box = null;
    let items = [];
    let active = 0;
    const close = () => {
      box?.remove();
      box = null;
    };
    const tokenAt = () => {
      const before = input.value.slice(0, input.selectionStart ?? input.value.length);
      const open = before.lastIndexOf('{{');
      if (open < 0 || before.lastIndexOf('}}') > open) return null;
      const match = /\$[\w$.[\]"]*$/.exec(before);
      return match ? { start: before.length - match[0].length, text: match[0] } : null;
    };
    const pick = (item) => {
      const token = tokenAt();
      if (!token || !item) return close();
      const end = input.selectionStart ?? input.value.length;
      const after = input.value.slice(end);
      const closing = /^\s*\}\}/.test(after) ? '' : ' }}';
      input.value = input.value.slice(0, token.start) + item.path + closing + after;
      const caret = token.start + item.path.length + closing.length;
      input.selectionStart = input.selectionEnd = caret;
      close();
      input.dispatchEvent(new Event('input'));
    };
    const draw = () => {
      box.textContent = '';
      items.forEach((item, index) => {
        const row = el('div', `wsugrow${index === active ? ' on' : ''}`);
        row.append(el('code', '', item.path), el('span', 'faint', preview(item.value)));
        row.onpointerdown = (event) => {
          event.preventDefault();
          pick(item);
        };
        box.append(row);
      });
    };
    const suggest = () => {
      const token = tokenAt();
      if (!token) return close();
      items = pickerGroups(node)
        .flatMap((group) => group.items)
        .filter((item) => item.path.startsWith(token.text) && item.path !== token.text)
        .slice(0, 8);
      if (items.length === 0) return close();
      active = 0;
      if (!box) {
        box = el('div', 'wsuggest');
        line.before(box);
      }
      draw();
    };
    input.addEventListener('input', () => {
      update();
      suggest();
    });
    input.addEventListener('focus', update);
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (event) => {
      if (!box) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        active = (active + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
        draw();
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(items[active]);
      } else if (event.key === 'Escape') {
        close();
      }
    });
    if (input.value.includes('{{')) update();
  }

  /** The "{ } เลือกข้อมูล" button under a field and its searchable list. */
  function addPicker(label, input, node) {
    const toggle = button('wpick', '{ } เลือกข้อมูล', () => {
      const open = label.querySelector('.wpicker');
      if (open) {
        open.remove();
        return;
      }
      sync();
      const panel = el('div', 'wpicker');
      const search = M().textInput('', 'ค้นหา field…');
      const list = el('div', 'wpicklist');
      const draw = () => {
        list.textContent = '';
        const query = search.value.trim().toLowerCase();
        for (const group of pickerGroups(node)) {
          const items = group.items.filter((item) => !query || item.path.toLowerCase().includes(query) || preview(item.value).toLowerCase().includes(query));
          if (items.length === 0) continue;
          list.append(el('div', 'wpickgroup', group.label));
          for (const item of items) {
            const row = button('wpickrow', '', () => {
              insertAt(input, item.path);
              panel.remove();
            });
            row.append(el('code', '', item.path), el('span', 'faint', preview(item.value)));
            list.append(row);
          }
        }
        if (!list.firstChild) list.append(el('p', 'hint', 'ไม่พบ field'));
      };
      search.oninput = draw;
      draw();
      panel.append(search, list);
      toggle.after(panel);
      search.focus();
    }, 'แทรก {{ … }} จากข้อมูลที่ node นี้ได้รับ');
    input.after(toggle);
  }

  /** Output keys of a node; switch and classify grow one per case / category. */
  function outputsOf(node) {
    const spec = specOf(node.type);
    if (node.type === 'switch') {
      const cases = Array.isArray(node.config.cases) ? node.config.cases : [];
      return [...cases.map((_, index) => ({ key: `case${index}`, label: `กรณี ${index + 1}` })), { key: 'fallback', label: 'อื่น ๆ' }];
    }
    if (node.type === 'classify') {
      const names = [];
      for (const category of Array.isArray(node.config.categories) ? node.config.categories : []) {
        const name = String((category && typeof category === 'object' ? category.name : category) ?? '').trim();
        if (name && !names.includes(name)) names.push(name);
      }
      return [
        ...names.map((name, index) => ({ key: `cat${index}`, label: `หมวด "${name}"` })),
        { key: 'fallback', label: 'ไม่เข้าหมวดไหน' },
      ];
    }
    return spec ? spec.outputs : [{ key: 'main', label: 'main' }];
  }

  function nodeCard(node, index) {
    const card = el('div', 'wcard');
    card.dataset.id = node.id;
    const head = el('div', 'whead');
    const title = M().textInput(node.title || '', 'ชื่อขั้นนี้');
    title.className = 'wtitle';
    title.onchange = () => {
      sync();
      canvasApi?.redraw();
    };
    title.style.maxWidth = '280px';
    const type = selectOf(
      nodeTypes().map((spec) => [spec.type, spec.label]),
      node.type,
    );
    type.onchange = () => {
      sync();
      node.type = type.value;
      node.links = {};
      showEditor();
    };
    head.append(el('span', 'wn', String(index + 1)), title, type);
    const actions = el('span', 'hstack');
    const ran = runResult?.nodes?.find((entry) => entry.id === node.id);
    const runId = runResult?.id ?? runResult?.runId;
    actions.append(
      button('btn ghost', 'ทดสอบ', () => openNodeTest(node), 'รัน node นี้อย่างเดียวด้วย input ตัวอย่าง'),
      ...(!isNew && runId && ran && ran.input.length > 0
        ? [button('btn ghost', '▶ จากตรงนี้', () => runFrom(node, runId), 'บันทึก แล้วรันใหม่ตั้งแต่ node นี้ ด้วย input เดิมของ run ที่เปิดอยู่ (node ก่อนหน้าไม่รันซ้ำ)')]
        : []),
      ...(mode === 'list' ? [button('btn ghost', '↑', () => move(node.id, -1)), button('btn ghost', '↓', () => move(node.id, 1))] : []),
      button('btn danger', 'ลบ', () => removeNode(node.id)),
    );
    head.append(actions);
    card.append(head);

    const spec = specOf(node.type);
    for (const field of spec ? spec.fields : []) {
      const input = fieldInput(field, node.config[field.key], node);
      const label = M().labelled(`${field.label}${field.required ? ' *' : ''}`, input);
      if (pickable(field, input)) {
        exprAssist(input, node);
        addPicker(label, input, node);
      }
      if (field.description) label.append(el('p', 'hint', field.description));
      card.append(label);
    }
    // switch grows one output per case, however many the user types.
    if (node.type === 'switch') {
      const cases = card.querySelector('[data-field="cases"]');
      if (cases) {
        cases.onchange = () => {
          sync();
          showEditor();
        };
      }
    }
    // What a failing node does; "branch" adds an error output.
    const errorGrid = el('div', 'grid2');
    const onError = selectOf(
      [
        ['stop', 'หยุดทั้ง run (ค่าเริ่มต้น)'],
        ['continue', 'ไปต่อ (ส่ง item เดิม)'],
        ['branch', 'แยกไป output "error"'],
      ],
      node.onError || 'stop',
    );
    onError.dataset.nodefield = 'onError';
    onError.dataset.kind = 'string';
    onError.onchange = () => {
      sync();
      showEditor();
    };
    const retries = el('input');
    retries.type = 'number';
    retries.min = '0';
    retries.value = node.retries ?? 0;
    retries.dataset.nodefield = 'retries';
    retries.dataset.kind = 'number';
    const retryWait = el('input');
    retryWait.type = 'number';
    retryWait.min = '0';
    retryWait.step = '100';
    retryWait.value = node.retryWaitMs ?? 0;
    retryWait.dataset.nodefield = 'retryWaitMs';
    retryWait.dataset.kind = 'number';
    errorGrid.append(
      M().labelled('ถ้า error', onError),
      M().labelled('ลองซ้ำ (ครั้ง)', retries),
      M().labelled('รอระหว่างลอง (ms)', retryWait),
    );
    card.append(errorGrid);

    // Switch off (passes items on) and pinned output (stands in for the node in editor runs).
    const extra = el('div', 'hstack wextra');
    const off = el('input');
    off.type = 'checkbox';
    off.checked = node.disabled === true;
    off.dataset.nodefield = 'disabled';
    off.dataset.kind = 'boolean';
    off.onchange = () => {
      sync();
      if (!node.disabled) delete node.disabled;
      canvasApi?.redraw();
      checkpoint();
    };
    const offLabel = el('label', 'hstack');
    offLabel.title = 'node นี้จะไม่รัน แต่ส่ง input ต่อไปตามเดิม';
    offLabel.append(off, el('span', '', 'ปิด node นี้'));
    extra.append(offLabel);
    if (Array.isArray(node.pinned)) {
      extra.append(
        el('span', 'pill warn', `📌 pin ${node.pinned.length} item`),
        button('btn ghost', 'แก้ pin', () => editPin(node)),
        button('btn ghost', 'เลิก pin', () => {
          sync();
          delete node.pinned;
          showEditor();
        }),
      );
    } else {
      extra.append(
        button('btn ghost', '📌 pin output', () => {
          sync();
          if (ran && ran.output.length > 0) {
            node.pinned = ran.output.map((item) => item.json);
            showEditor();
          } else editPin(node);
        }, 'ใช้ output นี้แทนการรันจริง เวลารันจาก editor (ประหยัดเวลา/ค่า API) — trigger จริงไม่ใช้ pin'),
      );
    }
    card.append(extra);
    card.append(linkGridFor(node));
    return card;
  }

  /** Edit a node's pinned items as JSON. */
  function editPin(node) {
    sync();
    const dialog = el('div', 'dialog form');
    dialog.append(el('h3', '', `pin output: ${node.title || node.id}`), el('p', 'hint', 'array ของ object — ใช้แทนการรัน node นี้ เวลารันจาก editor เท่านั้น'));
    const area = el('textarea', 'tall');
    area.value = JSON.stringify(node.pinned || [{}], null, 2);
    dialog.append(area);
    const foot = el('div', 'foot');
    foot.append(
      button('btn ghost', 'ยกเลิก', () => showEditor()),
      button('btn pri', 'บันทึก pin', () => {
        let parsed;
        try {
          parsed = JSON.parse(area.value || '[]');
        } catch {
          return M().toast('JSON ไม่ถูกต้อง', null, true);
        }
        const list = (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : { value: entry }));
        node.pinned = list;
        showEditor();
      }),
    );
    dialog.append(foot);
    M().overlay(dialog);
  }

  /** Saves, then runs again from this node with what it got in the run on screen. */
  function runFrom(node, runId) {
    sync();
    if (!draft.title) draft.title = draft.name;
    M().send({ type: 'workflow-save', workflow: draft, renameFrom: draft.name });
    M().send({ type: 'workflow-run-from', agent: draft.agent, name: draft.name, nodeId: node.id, runId });
    running = true;
    M().toast('กำลังรันจาก node นี้…', null);
  }

  const titleOf = (id) => {
    const node = draft.nodes.find((entry) => entry.id === id);
    return node ? node.title?.trim() || specOf(node.type)?.label || id : id;
  };

  /**
   * Where each output goes: any number of targets (chips with ✕) plus a picker to add
   * one more, so one output can feed several nodes at once. "branch" adds an error output.
   */
  function linkGridFor(node) {
    let outputs = outputsOf(node);
    if (node.onError === 'branch') outputs = [...outputs, { key: 'error', label: 'error' }];
    const linkGrid = el('div', 'grid2 wlinks');
    for (const output of outputs) {
      const targets = (node.links[output.key] || []).filter((id) => draft.nodes.some((entry) => entry.id === id));
      const box = el('div', 'wtargets');
      for (const id of targets) {
        const chip = el('span', 'chip on');
        chip.append(
          el('span', '', `${titleOf(id)} (${id})`),
          button('wx', '✕', () => {
            node.links[output.key] = targets.filter((target) => target !== id);
            refreshLinks(node);
          }, 'เลิกต่อสายนี้'),
        );
        box.append(chip);
      }
      const free = draft.nodes.filter((other) => other.id !== node.id && !targets.includes(other.id));
      if (free.length > 0) {
        const add = selectOf(
          free.map((other) => [other.id, `${titleOf(other.id)} (${other.id})`]),
          '',
          targets.length === 0 ? '— จบ (เลือกเพื่อต่อ) —' : '+ ต่อเพิ่มอีกทาง',
        );
        add.onchange = () => {
          if (!add.value) return;
          node.links[output.key] = [...targets, add.value];
          refreshLinks(node);
        };
        box.append(add);
      } else if (targets.length === 0) {
        box.append(el('span', 'faint', 'จบ'));
      }
      linkGrid.append(M().labelled(`→ ${output.label}`, box));
    }
    return linkGrid;
  }

  /** Redraws only a node's link selects (its outputs changed) so focus stays where the user is typing. */
  function refreshLinks(node) {
    sync();
    const grid = document.querySelector(`#wfEditor .wcard[data-id="${node.id}"] .wlinks`);
    if (grid) grid.replaceWith(linkGridFor(node));
    document.querySelector('#wfEditor .wdiagram')?.replaceWith(diagram());
    canvasApi?.redraw();
  }

  function move(id, delta) {
    sync();
    const at = draft.nodes.findIndex((node) => node.id === id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= draft.nodes.length) return;
    [draft.nodes[at], draft.nodes[to]] = [draft.nodes[to], draft.nodes[at]];
    showEditor();
  }

  function nextId() {
    let n = 1;
    while (draft.nodes.some((node) => node.id === `n${n}`)) n++;
    return `n${n}`;
  }

  function diagram() {
    const strip = el('div', 'wdiagram');
    draft.nodes.forEach((node, index) => {
      if (index > 0) strip.append(el('span', 'warrow', '→'));
      const chip = el('span', `wchip ${node.type}`);
      chip.append(el('b', '', node.title?.trim() || specOf(node.type)?.label || node.type), el('small', '', specOf(node.type)?.label || node.type));
      const routes = Object.entries(node.links || {})
        .filter(([, targets]) => targets.length > 0)
        .map(([key, targets]) => `${key} → ${targets.map(titleOf).join(', ')}`)
        .join(' · ');
      if (routes) chip.append(el('small', 'faint', routes));
      strip.append(chip);
    });
    return strip;
  }

  function jsonBlock(label, value) {
    const details = el('details');
    details.append(el('summary', '', label));
    const pre = el('pre', 'wjson');
    pre.textContent = JSON.stringify(value, null, 1);
    details.append(pre);
    return details;
  }

  function resultPanel() {
    if (!runResult) return el('div');
    const box = el('div', 'wresult');
    const when = runResult.startedAt ? ` #${runResult.id} · ${runResult.mode} · ${M().fmtDate(runResult.startedAt)}` : runResult.runId ? ` #${runResult.runId}` : '';
    box.append(el('h4', '', `ผลการรัน${when}${running ? ' (กำลังรัน…)' : ''}`));
    if (runResult.startedAt) box.append(el('p', runResult.ok ? 'hint' : 'hint badtxt', runResult.result));
    if (runResult.suspended) {
      box.append(el('p', 'hint', runResult.suspended.kind === 'approval' ? '⏸ run นี้พักรอคำตอบในแชต — ตอบแล้วจะทำต่อเอง (ปิดแอประหว่างนั้นได้)' : `⏸ run นี้พักไว้ จะทำต่อเองตอน ${M().fmtDate(runResult.suspended.resumeAt)}`));
    }
    for (const node of runResult.nodes) {
      const row = el('div', `wrun ${node.status}`);
      const head = el('div', 'whead');
      const label = node.status === 'ok' ? 'ok' : node.status === 'waiting' ? '⏸ รอ' : 'error';
      head.append(el('span', `pill ${node.status === 'ok' ? 'ok' : node.status === 'waiting' ? 'warn' : 'todo'}`, label), el('b', '', node.title), el('span', 'faint', node.type));
      if (node.note) head.append(el('span', 'pill', node.note === 'pinned' ? '📌 ใช้ pin' : 'ปิดอยู่ (ส่งผ่าน)'));
      row.append(head);
      if (node.error) row.append(el('p', 'hint badtxt', node.error));
      row.append(jsonBlock(`input (${node.input.length})`, node.input.map((item) => item.json)), jsonBlock(`output (${node.output.length})`, node.output.map((item) => item.json)));
      box.append(row);
    }
    return box;
  }

/** The last runs of this workflow; a click shows that run's nodes in the result panel. */
  function historyPanel() {
    const box = el('div', 'whistory');
    if (isNew) return box;
    const head = el('div', 'hstack');
    head.append(
      el('h4', '', `ประวัติการรัน (${runs.length})`),
      button('btn ghost', 'โหลดใหม่', () => M().send({ type: 'workflow-runs', agent: draft.agent, name: draft.name })),
    );
    box.append(head);
    if (runs.length === 0) {
      box.append(el('p', 'hint', 'ยังไม่มีการรัน — กด "รันทดสอบ" หรือรอ trigger'));
      return box;
    }
    const list = el('div', 'wrunlist');
    const current = runResult?.id ?? runResult?.runId;
    for (const run of runs.slice(0, historyShown)) {
      const row = button(`wrunrow${run.id === current ? ' on' : ''}`, '', () => M().send({ type: 'workflow-run-get', id: run.id }));
      row.append(
        el('span', `pill ${run.ok ? 'ok' : 'todo'}`, run.ok ? 'ok' : 'error'),
        el('span', '', M().fmtDate(run.startedAt)),
        el('span', 'chip', run.mode),
        el('span', 'faint', `${(run.durationMs / 1000).toFixed(1)} วิ · ${run.nodeCount} node`),
        el('span', 'faint wrunres', run.result),
      );
      list.append(row);
    }
    box.append(list);
    if (runs.length > historyShown) {
      box.append(button('btn ghost', `ดูเพิ่ม (${runs.length - historyShown})`, () => {
        historyShown += 30;
        document.querySelector('#wfEditor .whistory')?.replaceWith(historyPanel());
      }));
    }
    return box;
  }

  function triggerSection() {
    const box = el('div');
    const entry = poolOf(draft.trigger.pool);
    const select = selectOf(pool().map((item) => [item.name, `${item.label} (${item.kind})`]), draft.trigger.pool);
    select.onchange = () => {
      sync();
      draft.trigger.pool = select.value;
      draft.trigger.config = {};
      showEditor();
    };
    box.append(M().labelled('trigger (จาก pool)', select));
    if (entry) {
      box.append(el('p', 'hint', entry.description));
      for (const field of entry.fields) {
        const input = fieldInput(field, draft.trigger.config[field.key], null);
        input.dataset.triggerField = field.key;
        box.append(M().labelled(`${field.label}${field.required ? ' *' : ''}`, input));
      }
      if (entry.kind === 'chat') {
        box.append(el('p', 'hint', `พิมพ์ในแชตตรงกับ ${M().nameOf(draft.agent)} แล้วข้อความที่ตรงเงื่อนไขจะเข้า workflow นี้ · {{ $json.rest }} = ข้อความหลังคำขึ้นต้น · "workflow_only" = agent ไม่ตอบข้อความนั้น`));
        box.append(el('p', 'hint', 'ไฟล์ที่แนบมาอยู่ใน {{ $json.files }} — แต่ละไฟล์มี id, kind (image / audio / video / file), name, mime, size และ text (คำบรรยายรูป/วิดีโอ, คำถอดเสียง หรือข้อความในไฟล์ ถ้าเลือกให้อ่านก่อน) · อ่านไฟล์ใหม่ด้วยคำสั่งของคุณเอง: node "ดึงข้อมูลจากไฟล์" ช่อง "ไฟล์จากแชต" = {{ $json.files[0].id }} · "ไฟล์แนบ" = image แปลว่ารันเฉพาะข้อความที่มีรูป'));
      }
      if (entry.kind === 'tool') {
        const toolName = `workflow_${String(draft.name || '<ชื่อ>').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const callers = [draft.agent, ...String(draft.trigger.config.agents || '').split(/[\s,]+/).filter(Boolean)];
        box.append(el('p', 'hint', `agent ที่เรียกได้: ${[...new Set(callers)].map((name) => M().nameOf(name)).join(', ')} · จะเห็นเครื่องมือชื่อ ${toolName} พร้อมคำอธิบายจากช่อง "ใช้เมื่อไหร่" — เขียนให้ชัดว่าทำอะไร และควรใช้ตอนไหน agent จะเลือกถูกขึ้น`));
        box.append(el('p', 'hint', 'ค่าที่ agent ส่งมา: {{ $json.<ชื่อช่อง> }} และ {{ $json.agent }} = agent ที่เรียก · ผลที่ agent ได้กลับ = body ของ node "ตอบกลับ" ถ้ามี ไม่งั้นเป็น output ของ node สุดท้ายที่รัน · "ask" = ถามคุณก่อนรันทุกครั้ง'));
      }
      if (entry.kind === 'telegram') {
        const secret = String(draft.trigger.config.tokenSecret || '').trim() || 'TELEGRAM_BOT_TOKEN';
        const has = (M().state.secrets || []).includes(secret);
        box.append(el('p', has ? 'hint' : 'hint badtxt', has ? `มี secret "${secret}" แล้ว ✓` : `ยังไม่มี secret "${secret}" — ใส่ bot token ที่ ตั้งค่า → secret ก่อน`));
        box.append(el('p', 'hint', 'ตอบกลับด้วย node "ส่ง Telegram" (chat id = {{ $json.chatId }}) · หา chat id ของตัวเอง: ทักบอทแล้วดู input ในประวัติการรัน'));
      }
      if (entry.kind === 'webhook') {
        if (draft.webhook) box.append(el('p', 'hint', `POST มาที่: ${location.origin}${draft.webhook} (ไม่ต้องใช้ token)`));
        else box.append(el('p', 'hint', 'บันทึกแล้วระบบจะสร้าง URL ให้'));
      }
      box.append(el('p', 'hint', `trigger นี้ให้ข้อมูลแบบนี้ (ใช้ {{ $json.x }}): ${JSON.stringify(entry.sample).slice(0, 220)}`));
      if (entry.kind === 'manual') {
        box.append(el('p', 'hint', 'กด "รัน" แล้วจะให้ใส่ input JSON เองได้'));
      }
    }
    return box;
  }

  /** Starting settings of a new node, so it does something sensible right away. */
  function defaultConfig(type) {
    const config = {};
    if (type === 'agent') config.agent = draft.agent;
    if (type === 'llm') Object.assign(config, { format: 'text', name: 'text', prompt: '{{ $json.text }}' });
    if (type === 'classify') Object.assign(config, { input: '{{ $json.text }}', categories: [] });
    if (type === 'extract') Object.assign(config, { input: '{{ $json.text }}', attributes: [] });
    if (type === 'split_out') config.include = 'none';
    if (type === 'approval') config.timeoutMinutes = 60;
    if (type === 'knowledge') Object.assign(config, { operation: 'search', output: 'context', query: '{{ $json.text }}', limit: 5 });
    if (type === 'datetime') Object.assign(config, { operation: 'format', unit: 'days', format: 'th', name: 'date' });
    if (type === 'file') Object.assign(config, { operation: 'read', format: 'text', source: 'content' });
    if (type === 'extract_file') Object.assign(config, { path: '{{ $json.path }}', type: 'auto', header: 'header' });
    if (type === 'telegram') Object.assign(config, { tokenSecret: 'TELEGRAM_BOT_TOKEN', chatId: '{{ $json.chatId }}', parseMode: 'plain' });
    if (type === 'loop') Object.assign(config, { batchSize: 1, parallel: 1, onItemError: 'stop' });
    if (type === 'if' || type === 'filter') Object.assign(config, { combinator: 'and', conditions: [{ left: '', operator: 'contains', right: '' }] });
    if (type === 'switch') Object.assign(config, { mode: 'value', cases: [''] });
    if (type === 'sort') Object.assign(config, { direction: 'asc', type: 'auto' });
    if (type === 'limit') Object.assign(config, { max: 10, keep: 'first' });
    if (type === 'aggregate') config.mode = 'collect';
    if (type === 'remove_duplicates') config.keep = 'first';
    if (type === 'merge') config.mode = 'append';
    if (type === 'wait') Object.assign(config, { amount: 1, unit: 'seconds' });
    if (type === 'respond') config.status = 200;
    return config;
  }

  /**
   * Adds a node. `from` links it after that node's output; without one (the list's
   * add buttons) it hangs off the last node's first free output.
   */
  function createNode(type, position, from) {
    sync();
    const spec = specOf(type);
    const id = nextId();
    const node = { id, type, title: spec?.label || type, config: defaultConfig(type), links: { main: [] } };
    if (position) node.position = position;
    if (from) {
      const source = draft.nodes.find((entry) => entry.id === from.id);
      if (source) source.links[from.key] = [...(source.links[from.key] || []), id];
    } else if (!position) {
      const last = draft.nodes[draft.nodes.length - 1];
      if (last) {
        const free = outputsOf(last).find((output) => !(last.links[output.key] || []).length);
        if (free) last.links[free.key] = [id];
      }
    }
    draft.nodes.push(node);
    return node;
  }

  function removeNode(id) {
    sync();
    draft.nodes = draft.nodes.filter((entry) => entry.id !== id);
    for (const other of draft.nodes) {
      for (const key of Object.keys(other.links)) other.links[key] = other.links[key].filter((target) => target !== id);
    }
    if (selectedNode === id) selectedNode = null;
    showEditor();
  }

  /** Node types in their groups; `onPick(type)` gets the choice. */
  function paletteGroups(onPick, filter = '') {
    const box = el('div', 'waddgroups');
    const query = filter.trim().toLowerCase();
    const groupOf = (type) => NODE_GROUPS.find((group) => group.types.includes(type))?.label || 'อื่น ๆ';
    const groups = new Map();
    for (const spec of nodeTypes()) {
      if (query && !`${spec.label} ${spec.type} ${spec.description}`.toLowerCase().includes(query)) continue;
      const label = groupOf(spec.type);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(spec);
    }
    for (const label of [...NODE_GROUPS.map((group) => group.label), 'อื่น ๆ'].filter((name) => groups.has(name))) {
      const line = el('div', 'hstack');
      line.append(el('span', 'waddlabel', label));
      for (const spec of groups.get(label)) line.append(button('chip', `+ ${spec.label}`, () => onPick(spec.type), spec.description));
      box.append(line);
    }
    if (groups.size === 0) box.append(el('p', 'hint', 'ไม่พบ node'));
    return box;
  }

  /** A popover with a search box and the node palette, at `anchor` inside the canvas. */
  function paletteMenu(anchor, onPick) {
    anchor.host.querySelector('.wcv-menu')?.remove();
    const menu = el('div', 'wcv-menu');
    menu.style.left = `${Math.max(8, Math.min(anchor.left, anchor.host.clientWidth - 380))}px`;
    menu.style.top = `${Math.max(8, Math.min(anchor.top, anchor.host.clientHeight - 260))}px`;
    const search = M().textInput('', 'ค้นหา node…');
    const list = el('div');
    const close = () => {
      menu.remove();
      document.removeEventListener('pointerdown', outside, true);
    };
    const outside = (event) => {
      if (!menu.contains(event.target)) close();
    };
    const draw = () => list.replaceChildren(paletteGroups((type) => {
      close();
      onPick(type);
    }, search.value));
    search.oninput = draw;
    search.onkeydown = (event) => {
      if (event.key === 'Escape') close();
    };
    draw();
    menu.append(search, list);
    anchor.host.append(menu);
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
    search.focus();
  }

  /** Name, title, enabled, variables and error workflow. */
  function settingsSection() {
    const box = el('div');
    const name = M().textInput(draft.name, 'เช่น mail-triage');
    name.id = 'wfnName';
    name.readOnly = !isNew;
    const title = M().textInput(draft.title, 'ชื่อที่แสดง');
    title.id = 'wfnTitle';
    const enabled = el('input');
    enabled.type = 'checkbox';
    enabled.id = 'wfnEnabled';
    enabled.checked = draft.enabled;
    const grid = el('div', 'grid2');
    grid.append(M().labelled('ชื่อ (a-z 0-9 - _)', name), M().labelled('ชื่อที่แสดง', title));
    box.append(grid, M().labelled('เปิดใช้งาน', enabled));
    const vars = el('textarea');
    vars.id = 'wfnVars';
    vars.value = JSON.stringify(draft.vars ?? {}, null, 2);
    box.append(M().labelled('ตัวแปรของ workflow (JSON) — ใช้เป็น {{ $vars.x }}', vars));
    const errorOptions = (M().state.workflows || [])
      .filter((entry) => entry.agent === draft.agent && entry.name !== draft.name)
      .map((entry) => [entry.name, `${entry.title || entry.name} (${entry.name})`]);
    const errorWorkflow = selectOf(errorOptions, draft.errorWorkflow ?? '', '— ไม่มี —');
    errorWorkflow.id = 'wfnErrorWorkflow';
    box.append(M().labelled('workflow ที่รันเมื่อล้มเหลว (error workflow)', errorWorkflow));
    return box;
  }

  function editorButtons() {
    const save = () => {
      sync();
      if (!draft.name) return M().toast('ต้องมีชื่อ workflow (แท็บ ตั้งค่า)', null, true);
      if (!draft.title) draft.title = draft.name;
      M().send({ type: 'workflow-save', workflow: draft, renameFrom: isNew ? undefined : draft.name });
    };
    return [
      button('btn ghost', 'ปิด', () => {
        draft = null;
        canvasApi = null;
        M().closeOverlay();
      }),
      !isNew && draft.name ? button('btn', 'รันทดสอบ', () => {
        sync();
        promptRun(draft);
      }) : el('span'),
      button('btn pri', 'บันทึก', save),
    ];
  }

  function modeToggle() {
    const box = el('div', 'tabs wmode');
    for (const [key, label] of [['canvas', 'แผนภาพ'], ['list', 'รายการ']]) {
      box.append(button(mode === key ? 'on' : '', label, () => {
        if (mode === key) return;
        sync();
        mode = key;
        try {
          localStorage.setItem('mimi.workflowMode', key);
        } catch {
          // private window: the choice lasts this session only
        }
        showEditor();
      }));
    }
    return box;
  }

  function showEditor() {
    if (!draft) return;
    if (mode === 'canvas') return showCanvasEditor();
    canvasApi = null;
    const dialog = el('div', 'dialog wfedit form');
    dialog.id = 'wfEditor';
    const head = el('div', 'hstack');
    head.append(el('h3', '', isNew ? 'Workflow ใหม่' : `แก้ไข ${draft.name || ''}`), el('span', 'pill ok', `agent: ${draft.agent}`), modeToggle());
    dialog.append(head, settingsSection());
    dialog.append(el('h4', '', 'ทริกเกอร์'), triggerSection());
    dialog.append(el('h4', '', 'ลำดับการทำงาน'), diagram());
    for (const [index, node] of draft.nodes.entries()) dialog.append(nodeCard(node, index));
    const palette = paletteGroups((type) => {
      createNode(type, null, null);
      showEditor();
    });
    palette.style.marginTop = '10px';
    dialog.append(palette, historyPanel(), resultPanel());
    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'), ...editorButtons());
    dialog.append(foot);
    M().overlay(dialog);
    dialog.addEventListener('change', () => {
      sync();
      checkpoint();
    });
    checkpoint();
  }

  const SIDE_TABS = [
    ['node', 'Node'],
    ['trigger', 'ทริกเกอร์'],
    ['settings', 'ตั้งค่า'],
    ['runs', 'ผลการรัน'],
  ];

  /** Full-screen editor: the canvas, and a side panel for whatever is selected. */
  function showCanvasEditor() {
    const dialog = el('div', 'dialog wfcanvas form');
    dialog.id = 'wfEditor';
    const head = el('div', 'wfc-head');
    const label = el('div', 'wfc-title');
    label.append(el('b', '', isNew ? 'Workflow ใหม่' : draft.title || draft.name), el('span', 'pill ok', `agent: ${draft.agent}`), el('span', `pill ${draft.enabled ? 'ok' : 'todo'}`, draft.enabled ? 'เปิด' : 'ปิด'));
    const actions = el('div', 'hstack');
    actions.append(el('span', 'msg'), ...editorButtons());
    head.append(label, modeToggle(), actions);
    const body = el('div', 'wfc-body');
    const host = el('div');
    const side = el('div', 'wfc-side');
    body.append(host, side);
    dialog.append(head, body);
    M().overlay(dialog).classList.add('scrim-full');
    dialog.addEventListener('change', () => {
      sync();
      checkpoint();
    });

    const renderSide = () => {
      const tabs = el('div', 'tabs');
      for (const [key, text] of SIDE_TABS) {
        tabs.append(button(sideTab === key ? 'on' : '', text, () => {
          sync();
          sideTab = key;
          renderSide();
        }));
      }
      const content = el('div', 'wfc-pane');
      if (sideTab === 'node') {
        const index = draft.nodes.findIndex((entry) => entry.id === selectedNode);
        if (index >= 0) content.append(nodeCard(draft.nodes[index], index));
        else {
          content.append(
            el('p', 'hint', 'คลิก node เพื่อแก้ไขที่นี่'),
            el('p', 'hint', 'ต่อสาย: ลากจากจุดด้านขวาของ node ไปวางบน node อื่น · ลากไปที่ว่าง = เพิ่ม node ใหม่ต่อจากตรงนั้น'),
            el('p', 'hint', 'ลบสาย: คลิกที่สายแล้วกด ✕ หรือปุ่ม Delete · เลื่อนจอ: ลากพื้นที่ว่าง · ซูม: ล้อเมาส์ หรือหนีบสองนิ้ว'),
            el('p', 'hint', 'Ctrl+Z ย้อน · Ctrl+Y ทำซ้ำ · Ctrl+C / Ctrl+V คัดลอก-วาง node · Ctrl+D ทำสำเนา · 📝 เพิ่มโน้ต'),
          );
        }
      } else if (sideTab === 'trigger') {
        content.append(triggerSection());
      } else if (sideTab === 'settings') {
        content.append(settingsSection());
      } else {
        content.append(historyPanel(), resultPanel());
      }
      side.replaceChildren(tabs, content);
    };

    canvasApi = window.MimiCanvas.mount(host, {
      key: `${draft.agent}/${draft.name || '(new)'}`,
      nodes: () => draft.nodes,
      outputsOf: (node) => [...outputsOf(node), ...(node.onError === 'branch' ? [{ key: 'error', label: 'error' }] : [])],
      titleOf,
      typeLabel: (type) => specOf(type)?.label || type,
      groupOf: (type) => String(NODE_GROUPS.findIndex((group) => group.types.includes(type))),
      triggerLabel: () => poolOf(draft.trigger.pool)?.label || draft.trigger.pool,
      run: runResult,
      selected: selectedNode,
      onSelect: (id) => {
        sync();
        if (id === '__trigger') {
          selectedNode = null;
          sideTab = 'trigger';
        } else {
          selectedNode = id;
          if (id) sideTab = 'node';
        }
        renderSide();
      },
      onChange: () => {
        // Links or positions changed on the canvas: the open card's link list follows.
        const grid = document.querySelector(`#wfEditor .wcard[data-id="${selectedNode}"] .wlinks`);
        const node = draft.nodes.find((entry) => entry.id === selectedNode);
        if (grid && node) grid.replaceWith(linkGridFor(node));
        checkpoint();
      },
      notes: () => (draft.notes ??= []),
      undo,
      redo,
      addNodeAt: (type, position, from) => {
        const node = createNode(type, position, from);
        selectedNode = node.id;
        sideTab = 'node';
        showEditor();
      },
      removeNode: (id) => {
        if (confirm(`ลบ node "${titleOf(id)}" ?`)) removeNode(id);
      },
      palette: paletteMenu,
    });
    renderSide();
    checkpoint();
  }

  /** Manual run: show the trigger's sample as editable input JSON. */
  function promptRun(workflow) {
    const entry = poolOf(workflow.trigger.pool);
    running = true;
    runResult = null;
    const dialog = el('div', 'dialog form');
    dialog.append(el('h3', '', `รัน ${workflow.title || workflow.name}`), el('p', 'hint', `trigger: ${entry?.label || workflow.trigger.pool} · ให้ input แบบ JSON (ใช้เป็น {{ $json.x }} ของ node แรก)`));
    const area = el('textarea');
    area.value = JSON.stringify(entry?.sample || {}, null, 2);
    dialog.append(M().labelled('input JSON', area));
    const foot = el('div', 'foot');
    foot.append(
      button('btn ghost', 'ยกเลิก', () => (draft ? showEditor() : M().closeOverlay())),
      button('btn pri', 'รัน', () => {
        let input;
        try {
          input = JSON.parse(area.value || '{}');
        } catch {
          return M().toast('JSON ไม่ถูกต้อง', null, true);
        }
        M().send({ type: 'workflow-run', agent: workflow.agent, name: workflow.name, input, pins: true });
        M().closeOverlay();
        if (!draft || draft.name !== workflow.name) openEditor(workflow.agent, workflow);
        else showEditor();
      }),
    );
    dialog.append(foot);
    M().overlay(dialog);
  }

  /** Test one node alone: editable sample input, then its output per branch. */
  function openNodeTest(node) {
    sync();
    const current = runResult?.nodes?.find((entry) => entry.id === node.id);
    const sample =
      current && current.input.length > 0 ? current.input.map((item) => item.json) : (poolOf(draft.trigger.pool)?.sample ?? {});
    nodeTest = { nodeId: node.id, input: JSON.stringify(sample, null, 2), result: null };
    showNodeTest();
  }

  function showNodeTest() {
    if (!nodeTest || !draft) return;
    const node = draft.nodes.find((entry) => entry.id === nodeTest.nodeId);
    if (!node) {
      nodeTest = null;
      return;
    }
    const dialog = el('div', 'dialog form');
    dialog.append(
      el('h3', '', `ทดสอบ node: ${node.title || node.id}`),
      el('p', 'hint', 'รันเฉพาะ node นี้ด้วย input ที่ให้ · object เดียวหรือ array ของ object ก็ได้'),
    );
    const area = el('textarea');
    area.value = nodeTest.input;
    area.oninput = () => {
      nodeTest.input = area.value;
    };
    dialog.append(M().labelled('input JSON', area));

    if (nodeTest.result) {
      const result = nodeTest.result;
      const box = el('div', 'wresult');
      if (!result.ok) box.append(el('p', 'hint badtxt', `error: ${result.error}`));
      box.append(jsonBlock(`input (${(result.input || []).length})`, (result.input || []).map((item) => item.json)));
      const outputs = Object.entries(result.outputs || {});
      if (result.ok && outputs.length === 0) box.append(el('p', 'hint', '(node นี้ไม่มี output — ตรวจการตั้งค่า)'));
      for (const [key, items] of outputs) {
        box.append(jsonBlock(`output "${key}" (${items.length})`, items.map((item) => item.json)));
      }
      dialog.append(box);
    } else {
      dialog.append(el('p', 'hint', 'กำลังรัน… หรือกด "รัน node นี้"'));
    }

    const foot = el('div', 'foot');
    foot.append(
      el('span', 'msg'),
      button('btn ghost', 'ปิด', () => {
        nodeTest = null;
        if (draft) showEditor();
        else M().closeOverlay();
      }),
      button('btn pri', nodeTest.result ? 'รันอีกครั้ง' : 'รัน node นี้', () => {
        let parsed;
        try {
          parsed = JSON.parse(area.value || '{}');
        } catch {
          return M().toast('JSON ไม่ถูกต้อง', null, true);
        }
        const items = Array.isArray(parsed)
          ? parsed.map((entry) => (entry && typeof entry === 'object' ? { json: entry } : { json: { value: entry } }))
          : [{ json: parsed && typeof parsed === 'object' ? parsed : { value: parsed } }];
        nodeTest.input = area.value;
        nodeTest.result = null;
        showNodeTest();
        M().send({ type: 'workflow-test-node', workflow: draft, node, input: items });
      }),
    );
    dialog.append(foot);
    M().overlay(dialog);
  }

  function onNodeResult(result) {
    if (!nodeTest) return;
    nodeTest.result = result;
    showNodeTest();
  }

  function onMessage(message) {
    if (message.saved && draft) {
      const saved = (message.workflows || []).find((workflow) => `${workflow.agent}/${workflow.name}` === message.saved);
      if (saved && draft.name === saved.name && draft.agent === saved.agent) {
        draft = JSON.parse(JSON.stringify(saved));
        isNew = false;
        if (document.getElementById('wfEditor')) showEditor();
      }
    }
  }

  function onResult(result) {
    runResult = result;
    running = false;
    if (draft && document.getElementById('wfEditor')) showEditor();
  }

  window.MimiHooks = window.MimiHooks || {};
  function onRuns(message) {
    if (!draft || message.workflow !== `${draft.agent}/${draft.name}`) return;
    runs = message.runs || [];
    const panel = document.querySelector('#wfEditor .whistory');
    if (panel) panel.replaceWith(historyPanel());
  }

  function onRunRecord(run) {
    if (!draft || run.workflow !== `${draft.agent}/${draft.name}`) return;
    runResult = run;
    running = false;
    if (document.getElementById('wfEditor')) {
      showEditor();
      document.querySelector('#wfEditor .wresult')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  // ---------- n8n import ----------
  /** { agent, json, preview } while the import dialog is open. */
  let importing = null;

  function openImport(agent) {
    importing = { agent, json: '', preview: null, busy: false };
    showImport();
  }

  function showImport() {
    if (!importing) return;
    const dialog = el('div', 'dialog wfedit form');
    dialog.append(
      el('h3', '', 'นำเข้า workflow จาก n8n'),
      el('p', 'hint', 'ใน n8n: เปิด workflow → เมนู ⋯ → Download แล้วเลือกไฟล์ .json ที่นี่ · ค่าลับ (API key, token, credential) จะไม่ถูกนำเข้า · workflow ที่นำเข้าจะ "ปิด" ไว้ก่อน ตรวจแล้วค่อยเปิด'),
    );
    const file = el('input');
    file.type = 'file';
    file.accept = '.json,application/json';
    file.onchange = async () => {
      const picked = file.files && file.files[0];
      if (!picked) return;
      importing.json = await picked.text();
      importing.preview = null;
      importing.busy = true;
      showImport();
      M().send({ type: 'workflow-import-n8n', agent: importing.agent, json: importing.json, save: false });
    };
    dialog.append(M().labelled('ไฟล์ n8n (.json)', file));
    const paste = el('textarea');
    paste.placeholder = '…หรือวาง JSON ที่นี่';
    paste.value = importing.json && importing.json.length < 20000 ? importing.json : '';
    dialog.append(paste, button('btn ghost', 'แปลงข้อความที่วาง', () => {
      importing.json = paste.value;
      importing.preview = null;
      importing.busy = true;
      showImport();
      M().send({ type: 'workflow-import-n8n', agent: importing.agent, json: importing.json, save: false });
    }));
    if (importing.busy) dialog.append(el('p', 'hint', 'กำลังแปลง…'));
    const preview = importing.preview;
    if (preview) dialog.append(importReport(preview));
    const foot = el('div', 'foot');
    foot.append(
      el('span', 'msg'),
      button('btn ghost', 'ปิด', () => {
        importing = null;
        M().closeOverlay();
      }),
    );
    if (preview && !preview.saved) {
      foot.append(button('btn pri', `นำเข้า ${preview.workflows.length} workflow`, () => {
        importing.busy = true;
        showImport();
        M().send({ type: 'workflow-import-n8n', agent: importing.agent, json: importing.json, save: true });
      }));
    }
    dialog.append(foot);
    M().overlay(dialog);
  }

  function importReport(preview) {
    const { report } = preview;
    const box = el('div', 'wresult');
    box.append(el('h4', '', preview.saved ? 'นำเข้าแล้ว' : `จะได้ ${preview.workflows.length} workflow (จาก "${report.source.join(', ')}")`));
    const rows = el('div', 'tbl');
    for (const entry of report.workflows) {
      const row = el('div', 'hstack');
      row.append(el('b', '', entry.title), el('span', 'chip', entry.trigger), el('span', 'faint', `${entry.nodes} node · ${entry.name}`));
      rows.append(row);
    }
    box.append(rows);
    for (const error of preview.errors || []) box.append(el('p', 'hint badtxt', error));
    const section = (title, items, render, open) => {
      if (items.length === 0) return;
      const details = el('details');
      if (open) details.open = true;
      details.append(el('summary', '', `${title} (${items.length})`));
      for (const item of items) details.append(render(item));
      box.append(details);
    };
    section('node ที่ต้องทำเอง (จะหยุดพร้อมบอกเหตุผลถ้ารันถึง)', report.unsupported, (item) => el('p', 'hint badtxt', `${item.node} — ${item.type}: ${item.reason}`), true);
    section('ข้อควรตรวจ', report.warnings, (item) => el('p', 'hint', item), true);
    section('ค่าลับที่ไม่ได้นำเข้า (ใส่เองในตู้ secret)', report.redacted, (item) => el('p', 'hint', `${item.node} · ${item.field}`), false);
    section('model ที่ n8n ใช้ (เลือก model ที่ตรงกันให้ agent)', report.models, (item) => el('p', 'hint', `${item.node}: ${item.model}`), false);
    section('system prompt ของ AI agent ใน n8n (คัดลอกไปใส่ agent ได้)', report.prompts, (item) => {
      const wrap = el('div');
      const pre = el('pre', 'wjson');
      pre.textContent = item.text;
      wrap.append(el('b', '', item.node), pre, button('btn ghost', 'คัดลอก', () => navigator.clipboard?.writeText(item.text).then(() => M().toast('คัดลอกแล้ว ✓'))));
      return wrap;
    }, false);
    return box;
  }

  function onImport(message) {
    if (!importing || message.agent !== importing.agent) return;
    importing.busy = false;
    importing.preview = message;
    if (message.saved) M().toast(`นำเข้าแล้ว ${message.workflows.length - (message.errors || []).length} workflow`, 'ปิดไว้ก่อน: เปิดเมื่อตรวจแล้ว');
    showImport();
  }

  window.MimiHooks.agentWorkflows = { render, onMessage, onResult, onNodeResult, onRuns, onRunRecord, onImport, onExprPreview };
  window.MimiHooks.workflows = window.MimiHooks.agentWorkflows;
})();
