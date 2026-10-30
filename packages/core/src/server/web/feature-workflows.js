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
    {
      label: 'ทริกเกอร์',
      types: [
        'trigger_manual',
        'trigger_schedule',
        'trigger_webhook',
        'trigger_form',
        'trigger_mail',
        'trigger_poll',
        'trigger_chat',
        'trigger_telegram',
        'trigger_tool',
        'trigger_connector',
        'trigger_custom',
      ],
    },
    { label: 'AI', types: ['agent', 'llm', 'classify', 'extract', 'knowledge'] },
    { label: 'ทางแยก', types: ['if', 'switch', 'filter', 'merge'] },
    { label: 'ข้อมูล', types: ['set', 'datetime', 'split_out', 'sort', 'limit', 'aggregate', 'remove_duplicates', 'code', 'plugin'] },
    { label: 'ไฟล์', types: ['file', 'extract_file', 'sheets'] },
    { label: 'วน / รอ', types: ['loop', 'workflow', 'wait', 'stop', 'approval'] },
    { label: 'เชื่อมต่อ', types: ['connector', 'http', 'tool', 'chat', 'telegram', 'respond'] },
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
  /** Search text of the persistent node library. */
  let libraryQuery = '';
  /** Stored runs of the workflow being edited (newest first), from `workflow-runs`. */
  let runs = [];
  /** { nodeId, result } while a single-node test dialog is open. */
  let nodeTest = null;
  /** How many stored runs the history list shows. */
  let historyShown = 12;
  /** Status filter of the history list: all / ok / error. */
  let historyFilter = 'all';
  /** Options loaded for connector select fields, keyed by service/operation/input. */
  const connectorOptionCache = new Map();
  const connectorOptionCallbacks = new Map();
  let connectorOptionSeq = 0;

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

  /** Trigger nodes map to trigger-pool entries; each type is its own node. */
  const TRIGGER_POOLS = {
    trigger_manual: 'manual',
    trigger_schedule: 'schedule',
    trigger_webhook: 'webhook',
    trigger_form: 'form',
    trigger_mail: 'mail',
    trigger_poll: 'poll',
    trigger_chat: 'chat',
    trigger_telegram: 'telegram',
    trigger_tool: 'agent_tool',
  };
  const CONNECTOR_TRIGGER_PREFIX = 'connector:';
  const connectorOf = (key) => (M().state.connectors || []).find((entry) => entry.key === key);
  const connectorTriggerOf = (connectorKey, triggerKey) =>
    connectorOf(connectorKey)?.triggers?.find((entry) => entry.key === triggerKey);
  const connectorRefOf = (config) => {
    const connector = String(config?.connector || '').trim();
    const trigger = String(config?.trigger || '').trim();
    return connector && trigger ? `${CONNECTOR_TRIGGER_PREFIX}${connector}:${trigger}` : undefined;
  };
  const connectorPartsOf = (poolName) => {
    if (!String(poolName || '').startsWith(CONNECTOR_TRIGGER_PREFIX)) return undefined;
    const [connector, trigger, ...extra] = String(poolName).slice(CONNECTOR_TRIGGER_PREFIX.length).split(':');
    return connector && trigger && extra.length === 0 ? { connector, trigger } : undefined;
  };
  const isTrigger = (type) =>
    type === 'trigger_custom' || type === 'trigger_connector' || Object.hasOwn(TRIGGER_POOLS, type);
  const triggerPoolOfNode = (node) => {
    if (!node) return undefined;
    if (node.type === 'trigger_custom') return String(node.config?.pool || '').trim() || undefined;
    if (node.type === 'trigger_connector') return connectorRefOf(node.config);
    return TRIGGER_POOLS[node.type];
  };
  const triggerNode = () => (draft ? draft.nodes.find((node) => isTrigger(node.type)) : null);
  const triggerEntryOf = (node) => poolOf(triggerPoolOfNode(node) || draft?.trigger?.pool || 'manual');
  const triggerSample = (node) => triggerEntryOf(node)?.sample || {};
  const triggerLabelOf = (type, config) => {
    if (type === 'trigger_connector') {
      const connector = connectorOf(config?.connector);
      const trigger = connectorTriggerOf(config?.connector, config?.trigger);
      if (connector && trigger) return `${'เริ่มเมื่อ'}: ${connector.label}: ${trigger.label}`;
      return specOf(type)?.label || type;
    }
    const poolName = type === 'trigger_custom' ? String(config?.pool || '').trim() : TRIGGER_POOLS[type];
    const entry = poolOf(poolName);
    return entry ? `${'เริ่มเมื่อ'}: ${entry.label}` : specOf(type)?.label || type;
  };
  const triggerTitleOf = (node) => triggerLabelOf(node.type, node.config);

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
    container.append(el('p', 'hint', 'ต่อ flow ของ agent นี้: node ทริกเกอร์ → node ต่าง ๆ → chat · ใช้ {{ $json.Field }} อ้างข้อมูลจาก trigger/node ก่อนหน้า · รันแล้วเห็น input/output ทุก node'));
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
    const importButton = button('btn ghost', 'Import workflow (n8n / Make / Zapier)', () => openImport(agent), 'Import a workflow from n8n, Make or Zapier JSON; credentials are redacted and workflows start disabled.');
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
        { id: 'n1', type: 'trigger_manual', title: 'ทริกเกอร์: กดรันเอง', config: {}, links: { main: ['n2'] } },
        { id: 'n2', type: 'agent', title: 'AI agent', config: { agent: firstAgent, instruction: '' }, links: { main: ['n3'] } },
        { id: 'n3', type: 'chat', title: 'ส่งเข้าแชต', config: { text: '{{ $json.text }}' }, links: { main: [] } },
      ],
    };
  }

  /** Old workflows kept the trigger outside the graph; put it on the canvas as a real node. */
  function migrateDraft(view) {
    const ref = view.trigger || { pool: 'manual', config: {} };
    const builtinType = Object.entries(TRIGGER_POOLS).find(([, poolName]) => poolName === ref.pool)?.[0];
    const type = ref.pool.startsWith(CONNECTOR_TRIGGER_PREFIX)
      ? 'trigger_connector'
      : builtinType || 'trigger_custom';
    const existing = view.nodes.some((node) => isTrigger(node.type));
    if (!existing) {
      const fed = new Set(view.nodes.flatMap((node) => Object.values(node.links || {}).flat()));
      const starts = view.nodes.filter((node) => !fed.has(node.id));
      const position =
        starts.length > 0
          ? [Math.min(...starts.map((node) => node.position?.[0] ?? 320)) - 250, starts.reduce((sum, node) => sum + (node.position?.[1] ?? 60), 0) / starts.length]
          : [60, 60];
      let id = 'trigger';
      let n = 1;
      while (view.nodes.some((node) => node.id === id)) id = `trigger${n++}`;
      const parts = type === 'trigger_connector' ? connectorPartsOf(ref.pool) : undefined;
      const config =
        type === 'trigger_custom'
          ? { ...(ref.config || {}), pool: ref.pool }
          : { ...(ref.config || {}), ...(parts || {}) };
      view.nodes.unshift({
        id,
        type,
        title: triggerLabelOf(type, config),
        config,
        links: { main: starts.map((node) => node.id) },
        position,
      });
    }
    const node = view.nodes.find((entry) => isTrigger(entry.type));
    if (node) {
      const config = { ...(node.config || {}) };
      if (node.type === 'trigger_custom') delete config.pool;
      view.trigger = { pool: triggerPoolOfNode(node) || 'manual', config };
    }
    return view;
  }

  function openEditor(agent, workflow) {
    draft = workflow ? migrateDraft(JSON.parse(JSON.stringify(workflow))) : newDraft(agent);
    isNew = !workflow;
    runResult = null;
    runs = [];
    selectedNode = null;
    sideTab = 'node';
    historyShown = 12;
    historyFilter = 'all';
    libraryQuery = '';
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
    // nodes
    for (const card of root.querySelectorAll('.wcard')) {
      const node = draft.nodes.find((entry) => entry.id === card.dataset.id);
      if (!node) continue;
      const titleInput = card.querySelector('.wtitle');
      if (titleInput) node.title = titleInput.value;
      for (const field of card.querySelectorAll('[data-field]')) node.config[field.dataset.field] = fieldValue(field);
      const connectorInputs = card.querySelectorAll('[data-connector-field]');
      if (connectorInputs.length > 0) {
        const input = {};
        for (const field of connectorInputs) {
          const value = fieldValue(field);
          if (value !== undefined && value !== '') input[field.dataset.connectorField] = value;
        }
        node.config.input = input;
      }
      for (const field of card.querySelectorAll('[data-nodefield]')) node[field.dataset.nodefield] = fieldValue(field);
      // Links are edited on the draft directly (see linkGridFor), so there is nothing to read here.
    }
    const trigger = draft.nodes.find((node) => isTrigger(node.type));
    if (trigger) {
      const config = { ...(trigger.config || {}) };
      if (trigger.type === 'trigger_custom') delete config.pool;
      draft.trigger = { pool: triggerPoolOfNode(trigger) || 'manual', config };
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

  function connectorOptionsField(field, value, node) {
    const input = el('input');
    input.value = value === undefined || value === null ? '' : String(value);
    input.placeholder = field.placeholder || 'พิมพ์ค่า หรือเลือกจากรายการ';
    const list = el('datalist');
    const listId = `connector-options-${++connectorOptionSeq}`;
    list.id = listId;
    input.setAttribute('list', listId);
    document.body.append(list);
    const fill = (options) => {
      list.replaceChildren();
      for (const option of options) {
        const item = el('option');
        item.value = option.value;
        item.label = option.label;
        list.append(item);
      }
    };
    const payload = { ...(node.config.input || {}) };
    const dependsOn = field.optionsFrom.dependsOn || [];
    const missing = dependsOn.filter((key) => payload[key] === undefined || payload[key] === '');
    if (missing.length > 0) {
      input.placeholder = `เลือก ${missing.join(', ')} ก่อน หรือพิมพ์ค่าเอง`;
      return input;
    }
    const cacheKey = [field.optionsFrom.connector, field.optionsFrom.operation, JSON.stringify(payload), node.config.account || ''].join('|');
    const cached = connectorOptionCache.get(cacheKey);
    if (cached) {
      fill(cached);
      return input;
    }
    input.placeholder = 'กำลังโหลดตัวเลือก… (พิมพ์ค่าเองได้)';
    const reqId = ++connectorOptionSeq;
    connectorOptionCallbacks.set(reqId, (message) => {
      if (!input.isConnected) return;
      if (!message.ok) {
        input.placeholder = 'โหลดตัวเลือกไม่ได้ — พิมพ์ค่าเอง';
        return;
      }
      connectorOptionCache.set(cacheKey, message.options);
      fill(message.options);
      input.placeholder = field.placeholder || 'พิมพ์ค่า หรือเลือกจากรายการ';
    });
    M().send({
      type: 'connector-operation-options',
      reqId,
      connector: field.optionsFrom.connector,
      operation: field.optionsFrom.operation,
      labelField: field.optionsFrom.labelField,
      valueField: field.optionsFrom.valueField,
      input: payload,
      ...(node.config.account ? { account: node.config.account } : {}),
    });
    return input;
  }

  function fieldInput(field, value, node) {
    if (field.connectorInput && field.optionsFrom) return connectorOptionsField(field, value, node);
    if (field.key === 'conditions') return conditionsField(field, value, node);
    if (field.key === 'cases' && node && node.type === 'switch') return switchCasesField(field, value, node);
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
    } else if (field.type === 'account') {
      const settings = M().state.settings || {};
      const mailAccounts = (settings.mailAccounts || []).map((account) => ({ ...account, service: 'mail' }));
      const accounts = [...(settings.accounts || []), ...mailAccounts].filter(
        (account) => !field.service || account.service === field.service,
      );
      node_ = selectOf(
        accounts.map((account) => [
          account.id,
          `${account.name || account.id}${account.default ? ' ★' : ''}${field.service ? '' : ` · ${account.service}`}${account.connected ? '' : ' (ยังไม่เชื่อมต่อ)'}`,
        ]),
        String(value ?? ''),
        '— บัญชีเริ่มต้น —',
      );
    } else if (Array.isArray(field.options)) {
      node_ = selectOf(
        field.options.map((option) => {
          if (Array.isArray(option)) return [option[0], option[1] ?? option[0]];
          if (option && typeof option === 'object') return [option.value, option.label || option.value];
          return [option, option];
        }),
        String(value ?? (Array.isArray(field.options[0]) ? field.options[0][0] : field.options[0]?.value ?? field.options[0]) ?? ''),
      );
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
      const items = M().toolItems ? M().toolItems() : (M().state.tools || []);
      const describe = M().describeTool || ((tool) => `${tool.name} (${tool.risk})`);
      node_ = selectOf(
        items.map((tool) => [tool.name, describe(tool)]),
        String(value ?? ''),
        '— เลือกเครื่องมือ —',
      );
    } else if (field.key === 'operator') {
      node_ = selectOf(OPERATORS.map((op) => [op, op]), String(value ?? 'contains'));
    } else if (field.type === 'secret') {
      node_ = el('input');
      node_.type = 'password';
      node_.autocomplete = 'new-password';
      node_.value = value === undefined || value === null ? '' : String(value);
      node_.placeholder = field.placeholder || '';
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
        const left = expressionField(node, condition.left, '{{ $json.field }}');
        left.input.oninput = () => {
          condition.left = left.input.value;
          write();
        };
        const operator = selectOf(OPERATORS.map((op) => [op, op]), condition.operator);
        operator.onchange = () => {
          condition.operator = operator.value;
          write();
        };
        const right = expressionField(node, condition.right, 'ค่าเทียบ');
        right.input.oninput = () => {
          condition.right = right.input.value;
          write();
        };
        const remove = button('btn ghost', '✕', () => {
          list.splice(index, 1);
          write();
          build();
        });
        row.append(left.box, operator, right.box, remove);
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

  /** Text input that understands {{ … }}: live preview plus the field picker. */
  function expressionField(node, value, placeholder) {
    const box = el('div', 'wexpr');
    const input = M().textInput(value, placeholder);
    box.append(input);
    if (node) {
      exprAssist(input, node);
      addPicker(box, input, node);
    }
    return { box, input };
  }

  /**
   * Switch cases. "value" mode: one value per case, compared with the node's
   * `value`. "rules" mode: a condition (left / operator / right) per case. The
   * config stays a JSON array, so imported n8n switches keep working.
   */
  function switchCasesField(field, value, node) {
    const rules = String(node.config.mode || 'value') === 'rules';
    const raw = Array.isArray(value) ? value : [];
    const list = rules
      ? raw
          .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .map((entry) => ({ left: String(entry.left ?? ''), operator: String(entry.operator || 'contains'), right: String(entry.right ?? '') }))
      : raw.map((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry) ? '' : String(entry ?? '')));
    const wrap = el('div', 'wcond wswitch');
    const rows = el('div');
    const hidden = el('textarea');
    hidden.style.display = 'none';
    hidden.dataset.field = field.key;
    hidden.dataset.kind = 'json';
    const write = (persist = true) => {
      const kept = rules ? list.filter((condition) => !(condition.left === '' && condition.right === '' && condition.operator === 'contains')) : list;
      // In rules mode an empty condition is dropped right away, so the output ports match the rows.
      if (persist || rules) node.config[field.key] = kept;
      hidden.value = JSON.stringify(kept);
    };
    const changed = () => {
      write();
      refreshLinks(node);
    };
    const remove = (index) => {
      list.splice(index, 1);
      changed();
      build();
    };
    const build = () => {
      rows.textContent = '';
      list.forEach((condition, index) => {
        if (rules) {
          const row = el('div', 'hstack wcondrow');
          const left = expressionField(node, condition.left, '{{ $json.field }}');
          left.input.oninput = () => {
            condition.left = left.input.value;
            write();
          };
          const operator = selectOf(OPERATORS.map((op) => [op, op]), condition.operator);
          operator.onchange = () => {
            condition.operator = operator.value;
            write();
          };
          const right = expressionField(node, condition.right, 'ค่าเทียบ');
          right.input.oninput = () => {
            condition.right = right.input.value;
            write();
          };
          row.append(left.box, operator, right.box, button('btn ghost', '✕', () => remove(index), 'ลบเงื่อนไขนี้'));
          rows.append(row);
        } else {
          const row = el('div', 'wcaserow');
          row.append(el('span', 'wn', String(index + 1)));
          const input = expressionField(node, condition, 'ค่า เช่น urgent (ใส่ {{ }} ได้)');
          input.input.oninput = () => {
            list[index] = input.input.value;
            write();
          };
          row.append(input.box, button('btn ghost', '✕', () => remove(index), 'ลบกรณีนี้'));
          rows.append(row);
        }
      });
      if (list.length === 0) rows.append(el('p', 'hint', rules ? 'ยังไม่มีเงื่อนไข — กด "เพิ่มเงื่อนไข"' : 'ยังไม่มีกรณี — กด "เพิ่มกรณี"'));
    };
    const add = button('btn ghost', rules ? '+ เพิ่มเงื่อนไข' : '+ เพิ่มกรณี', () => {
      list.push(rules ? { left: '', operator: 'contains', right: '' } : '');
      changed();
      build();
    });
    build();
    write(false);
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
      const trigger = triggerNode();
      sample = triggerPoolOfNode(trigger) === 'manual' && trigger?.config?.input ? trigger.config.input : triggerEntryOf(trigger)?.sample;
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
    if (!json) {
      const trigger = triggerNode();
      json = (triggerPoolOfNode(trigger) === 'manual' && trigger?.config?.input) || triggerEntryOf(trigger)?.sample || {};
    }
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

  /**
   * n8n-style parameter panel: only the fields that matter for the chosen
   * mode/operation are shown. Hidden values stay in the config, so switching
   * back and forth never loses what was typed.
   */
  function fieldVisible(node, field) {
    const config = node.config || {};
    const text = (key, fallback = '') => String(config[key] ?? fallback);
    const operation = text(
      'operation',
      node.type === 'file' ? 'read' : node.type === 'aggregate' ? 'collect' : node.type === 'knowledge' ? 'search' : node.type === 'datetime' ? 'format' : '',
    );
    const mode = text('mode', node.type === 'switch' ? 'value' : node.type === 'wait' ? 'duration' : node.type === 'stop' ? 'success' : '');
    switch (node.type) {
      case 'switch':
        return !(field.key === 'value' && mode === 'rules');
      case 'wait':
        if (field.key === 'amount' || field.key === 'unit') return mode === 'duration';
        if (field.key === 'until') return mode === 'until';
        return true;
      case 'aggregate':
        if (field.key === 'field') return ['sum', 'average', 'min', 'max', 'join'].includes(operation);
        if (field.key === 'name') return operation !== 'collect' && operation !== 'count';
        if (field.key === 'separator') return operation === 'join';
        if (field.key === 'fields') return operation === 'collect';
        return true;
      case 'knowledge':
        if (field.key === 'operation' || field.key === 'collection') return true;
        if (['query', 'limit', 'output'].includes(field.key)) return operation === 'search';
        if (['text', 'title', 'source'].includes(field.key)) return operation === 'add';
        return true;
      case 'datetime':
        if (field.key === 'value' || field.key === 'timezone' || field.key === 'name') return true;
        if (field.key === 'amount') return operation === 'add' || operation === 'subtract';
        if (field.key === 'unit') return operation !== 'format';
        if (field.key === 'other') return operation === 'diff';
        if (field.key === 'format') return operation !== 'diff';
        return true;
      case 'file':
        if (field.key === 'operation' || field.key === 'path') return true;
        if (field.key === 'destination' || field.key === 'overwrite') return operation === 'copy' || operation === 'move';
        if (field.key === 'recursive') return operation === 'delete';
        if (field.key === 'format' || field.key === 'name') return operation === 'read';
        if (field.key === 'source') return operation === 'write';
        if (field.key === 'content') return operation === 'append' || (operation === 'write' && text('source', 'content') === 'content');
        if (field.key === 'pattern') return operation === 'list';
        return true;
      case 'extract_file': {
        if (field.key === 'path' || field.key === 'attachment' || field.key === 'type') return true;
        const type = text('type', 'auto');
        if (field.key === 'sheet') return type === 'xlsx' || type === 'auto';
        if (field.key === 'header') return type === 'csv' || type === 'xlsx' || type === 'auto';
        if (field.key === 'instruction') return ['pdf', 'image', 'audio', 'video', 'auto'].includes(type);
        if (field.key === 'name') return ['text', 'html', 'pdf', 'image', 'audio', 'video', 'auto'].includes(type);
        return true;
      }
      default:
        return true;
    }
  }

  /** The node's input/output from the run on screen, right on its card. */
  function nodeIoSection(node) {
    const run = runResult?.nodes?.find((entry) => entry.id === node.id);
    if (!run && mode !== 'canvas') return null;
    const box = el('div', 'wnodeio');
    if (!run) {
      box.append(el('p', 'hint', 'ยังไม่มีข้อมูลของ node นี้ — กด "รันทดสอบ" แล้ว input/output จะแสดงที่นี่'));
      return box;
    }
    const details = el('details');
    details.open = run.status === 'error';
    const summary = el('summary');
    summary.append(
      el('span', `pill ${run.status === 'ok' ? 'ok' : run.status === 'waiting' ? 'warn' : 'todo'}`, run.status === 'ok' ? 'ok' : run.status === 'waiting' ? 'รอ' : 'error'),
      el('span', '', ` ข้อมูลเข้า / ออก · ${run.input.length} → ${run.output.length}`),
    );
    if (run.note) summary.append(el('span', 'pill', run.note === 'pinned' ? '📌 ใช้ pin' : 'ปิดอยู่ (ส่งผ่าน)'));
    details.append(summary);
    if (run.error) details.append(el('p', 'hint badtxt', run.error));
    details.append(
      jsonBlock(`input (${run.input.length})`, run.input.map((item) => item.json)),
      jsonBlock(`output (${run.output.length})`, run.output.map((item) => item.json)),
    );
    box.append(details);
    return box;
  }

  /** Service + operation + the fields of that operation; credentials stay in the connection. */
  function connectorFieldsOf(node) {
    const config = node.config || {};
    const connectors = M().state.connectors || [];
    const connector = connectors.find((entry) => entry.key === config.connector) || connectors[0];
    const fields = [
      {
        key: 'connector',
        label: 'Service',
        type: 'string',
        required: true,
        options: connectors.map((entry) => entry.key),
        description: connector ? connector.description : 'ยังไม่มี connector ที่ติดตั้ง',
      },
    ];
    if (!connector) return fields;
    const operationKey = config.operation || connector.operations[0]?.key || '';
    const versions = connector.versions || (connector.version ? [connector.version] : []);
    fields.push({
      key: 'version',
      label: 'Connector version',
      type: 'string',
      options: [['', `latest${connector.version ? ` (v${connector.version})` : ''}`], ...versions.map((entry) => [entry, entry === connector.version ? `${entry} (latest)` : entry])],
      description: 'เว้นว่าง = ใช้ version ล่าสุด · workflow ที่ pin version เก่าไว้จะยังรัน version เดิม',
    });
    fields.push({
      key: 'operation',
      label: 'Operation',
      type: 'string',
      required: true,
      options: connector.operations.map((entry) => entry.key),
      description: connector.operations.find((entry) => entry.key === operationKey)?.description,
    });
    if (connector.key.startsWith('google_')) {
      fields.push({
        key: 'account',
        label: 'บัญชี Google',
        type: 'account',
        service: 'google',
        description: 'เว้นว่าง = บัญชี Google เริ่มต้น',
      });
    } else {
      const connections = (M().state.connections || []).filter((entry) => entry.connector === connector.key);
      fields.push({
        key: 'account',
        label: 'Connection',
        type: 'string',
        options: [['', '— connection เริ่มต้น —'], ...connections.map((entry) => [entry.id, `${entry.name}${entry.default ? ' ★' : ''}${entry.connected ? '' : ' (ยังไม่เชื่อมต่อ)'}`])],
        description: connections.length === 0 ? 'ยังไม่มี connection — เพิ่มได้ที่ Hub → บัญชี' : undefined,
      });
    }
    const operation = connector.operations.find((entry) => entry.key === operationKey);
    for (const field of operation ? operation.fields : []) {
      fields.push({
        ...field,
        connectorInput: true,
        ...(field.type === 'select' && Array.isArray(field.options)
          ? { options: field.options.map((option) => ({ value: option.value, label: option.label })) }
          : {}),
      });
    }
    if (operation && operation.risk !== 'read') {
      fields.push({
        key: 'allow',
        label: 'อนุญาตให้ทำงานนี้ (write/delete)',
        type: 'boolean',
        description: 'ต้องเปิดเพื่อให้ workflow เรียก operation นี้ได้',
      });
    }
    return fields;
  }

  function connectorOperationOf(node) {
    const connector = (M().state.connectors || []).find((entry) => entry.key === node.config?.connector);
    return connector?.operations.find((entry) => entry.key === node.config?.operation);
  }

  /** Connector trigger nodes pick a service + trigger; the trigger's own fields sit on the card. */
  function connectorTriggerFieldsOf(node) {
    const config = node.config || {};
    const connectors = (M().state.connectors || []).filter((entry) => (entry.triggers || []).length > 0);
    const connector = connectors.find((entry) => entry.key === config.connector) || connectors[0];
    const triggers = connector?.triggers || [];
    const trigger = triggers.find((entry) => entry.key === config.trigger) || triggers[0];
    const fields = [
      {
        key: 'connector',
        label: 'Service',
        type: 'string',
        required: true,
        options: connectors.map((entry) => [entry.key, entry.label || entry.key]),
        description: connector ? connector.description : 'Add a connector with triggers first.',
      },
      {
        key: 'trigger',
        label: 'Trigger',
        type: 'string',
        required: true,
        options: triggers.map((entry) => [entry.key, entry.label || entry.key]),
        description: trigger ? trigger.description : undefined,
      },
    ];
    if (!connector || !trigger) return fields;
    if (connector.auth?.kind !== 'none') {
      const connections = (M().state.connections || []).filter((entry) => entry.connector === connector.key);
      fields.push({
        key: 'account',
        label: 'Connection',
        type: 'string',
        options: [['', 'Default connection'], ...connections.map((entry) => [entry.id, `${entry.name}${entry.default ? ' *' : ''}${entry.connected ? '' : ' (not connected)'}`])],
        description: connections.length === 0 ? 'Add a connection in Hub > Connections.' : undefined,
      });
    }
    const entry = triggerEntryOf(node);
    for (const field of entry ? entry.fields : []) {
      if (field.key !== 'input') fields.push({ ...field });
    }
    if (!fields.some((field) => field.key === 'input')) {
      fields.push({
        key: 'input',
        label: 'Input (JSON)',
        type: 'json',
        description: 'Extra operation input or fixed fields passed with every trigger event.',
      });
    }
    return fields;
  }

  /** A custom trigger node edits the chosen pool's fields, plus the pool name itself. */
  function fieldsOfNode(node) {
    if (node.type === 'connector') return connectorFieldsOf(node);
    if (node.type === 'trigger_connector') return connectorTriggerFieldsOf(node);
    const spec = specOf(node.type);
    if (node.type !== 'trigger_custom') return spec ? spec.fields : [];
    const custom = pool().filter((entry) => !entry.builtin);
    const entry = triggerEntryOf(node);
    return [
      {
        key: 'pool',
        label: 'trigger จาก pool',
        type: 'string',
        required: true,
        options: custom.map((item) => item.name),
        description: custom.length === 0 ? 'ยังไม่มี trigger ที่สร้างเอง — สร้างได้ที่ Hub → Trigger' : undefined,
      },
      ...(entry ? entry.fields.filter((field) => field.key !== 'pool') : []),
    ];
  }

  function nodeCard(node, index) {
    const card = el('div', `wcard${isTrigger(node.type) ? ' wtrigger' : ''}`);
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
      nodeTypes()
        .filter((spec) => (isTrigger(node.type) ? isTrigger(spec.type) : !isTrigger(spec.type)))
        .filter((spec) => spec.type !== 'trigger_custom' || node.type === 'trigger_custom' || pool().some((entry) => !entry.builtin))
        .map((spec) => [spec.type, spec.label]),
      node.type,
    );
    type.onchange = () => {
      sync();
      // A trigger stays a trigger (and every other node stays non-trigger).
      if (isTrigger(node.type) !== isTrigger(type.value)) {
        type.value = node.type;
        return;
      }
      const wasTrigger = isTrigger(node.type);
      node.type = type.value;
      node.config = defaultConfig(node.type);
      if (isTrigger(node.type)) node.title = triggerTitleOf(node);
      if (!wasTrigger) node.links = {};
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
      ...(isTrigger(node.type) ? [] : [button('btn danger', 'ลบ', () => removeNode(node.id))]),
    );
    head.append(actions);
    card.append(head);
    const io = nodeIoSection(node);
    if (io) card.append(io);

    for (const field of fieldsOfNode(node)) {
      if (!fieldVisible(node, field)) continue;
      const initial = field.connectorInput ? (node.config.input || {})[field.key] : node.config[field.key];
      const input = fieldInput(field, initial, node);
      if (field.connectorInput) {
        input.dataset.connectorField = field.key;
        delete input.dataset.field;
        input.addEventListener('change', () => {
          const operation = connectorOperationOf(node);
          const dependent = (operation?.fields || []).filter((entry) => entry.optionsFrom?.dependsOn?.includes(field.key));
          if (dependent.length > 0) {
            sync();
            for (const entry of dependent) delete node.config.input[entry.key];
            connectorOptionCache.clear();
            showEditor();
          }
        });
      }
      const label = M().labelled(`${field.label}${field.required ? ' *' : ''}`, input);
      if (pickable(field, input)) {
        exprAssist(input, node);
        addPicker(label, input, node);
      }
      if (field.description) label.append(el('p', 'hint', field.description));
      card.append(label);
    }
    if (isTrigger(node.type)) card.append(triggerSection(node));
    // Mode / operation selects change which fields apply: redraw the card around them.
    const controllingFields = {
      switch: ['mode'],
      wait: ['mode'],
      aggregate: ['mode'],
      knowledge: ['operation'],
      datetime: ['operation'],
      file: ['operation', 'source'],
      extract_file: ['type'],
      connector: ['connector', 'operation'],
      trigger_connector: ['connector', 'trigger'],
    };
    for (const key of controllingFields[node.type] || []) {
      const control = card.querySelector(`[data-field="${key}"]`);
      if (control) {
        control.onchange = () => {
          const previousTrigger = connectorTriggerOf(node.config?.connector, node.config?.trigger);
          sync();
          // Switch cases are plain values in "value" mode and conditions in "rules" mode.
          if (node.type === 'connector') {
            if (key === 'connector') {
              const selected = (M().state.connectors || []).find((entry) => entry.key === control.value);
              node.config.operation = selected?.operations[0]?.key || '';
              node.config.input = {};
            } else if (key === 'operation') {
              node.config.input = {};
            }
          }
          if (node.type === 'trigger_connector' && (key === 'connector' || key === 'trigger')) {
            // Fields belong to the selected trigger; never carry them to another service.
            for (const field of previousTrigger?.fields || []) delete node.config[field.key];
            delete node.config.everyMinutes;
            node.config.input = {};
            if (key === 'connector') {
              const selected = connectorOf(control.value);
              node.config.trigger = selected?.triggers?.[0]?.key || '';
              delete node.config.account;
            }
            if (connectorTriggerOf(node.config.connector, node.config.trigger)?.kind === 'poll') {
              node.config.everyMinutes = 15;
            }
            node.title = triggerTitleOf(node);
          }
          if (node.type === 'switch' && key === 'mode') {
            const cases = Array.isArray(node.config.cases) ? node.config.cases : [];
            const isObject = (entry) => entry && typeof entry === 'object' && !Array.isArray(entry);
            node.config.cases =
              control.value === 'rules'
                ? cases.filter(isObject).map((entry) => ({ left: entry.left ?? '', operator: entry.operator || 'contains', right: entry.right ?? '' }))
                : cases.map((entry) => (isObject(entry) ? String(entry.right ?? entry.left ?? '') : String(entry ?? '')));
          }
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
    // Less-used settings stay folded away, like n8n's node settings.
    const advanced = el('details', 'wadvanced');
    if (Array.isArray(node.pinned) || node.disabled) advanced.open = true;
    advanced.append(el('summary', '', 'ตัวเลือกเพิ่มเติม (error / retry / pin / ปิด node)'), errorGrid, extra);
    card.append(advanced);
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
    const meta = [
      runResult.workflow || (draft ? `${draft.agent}/${runResult.name}` : ''),
      runResult.trigger || runResult.mode ? `trigger: ${runResult.trigger || runResult.mode}` : '',
      runResult.durationMs !== undefined ? `${(runResult.durationMs / 1000).toFixed(1)} วิ` : '',
      runResult.agent ? `agent: ${runResult.agent}` : '',
    ].filter(Boolean);
    if (meta.length > 0) box.append(el('p', 'hint', meta.join(' · ')));
    if (runResult.startedAt) box.append(el('p', runResult.ok ? 'hint' : 'hint badtxt', runResult.result));
    if (runResult.suspended) {
      box.append(el('p', 'hint', runResult.suspended.kind === 'approval' ? '⏸ run นี้พักรอคำตอบในแชต — ตอบแล้วจะทำต่อเอง (ปิดแอประหว่างนั้นได้)' : `⏸ run นี้พักไว้ จะทำต่อเองตอน ${M().fmtDate(runResult.suspended.resumeAt)}`));
    }
    for (const node of runResult.nodes) {
      const row = el('div', `wrun ${node.status}`);
      const head = el('div', 'whead');
      const label = node.status === 'ok' ? 'ok' : node.status === 'waiting' ? '⏸ รอ' : 'error';
      head.append(el('span', `pill ${node.status === 'ok' ? 'ok' : node.status === 'waiting' ? 'warn' : 'todo'}`, label), el('b', '', node.title), el('span', 'faint', node.type));
      if (node.attempts > 1) head.append(el('span', 'pill', `${node.attempts} attempts`));
      if (node.note) head.append(el('span', 'pill', node.note === 'pinned' ? '📌 ใช้ pin' : 'ปิดอยู่ (ส่งผ่าน)'));
      row.append(head);
      if (node.error) {
        const errorLine = el('div', 'hstack');
        errorLine.append(
          el('p', 'hint badtxt', node.error),
          button('btn ghost', 'คัดลอก error', () => navigator.clipboard?.writeText(node.error).then(() => M().toast('คัดลอกแล้ว'), () => M().toast('คัดลอกไม่ได้', 'เบราว์เซอร์ไม่อนุญาต', true))),
        );
        row.append(errorLine);
      }
      const trace = node.trace || {};
      if (trace.connector || trace.operation || trace.errorCode) {
        const bits = [];
        if (trace.connector) bits.push(`${trace.connector}${trace.operation ? `.${trace.operation}` : ''}${trace.connectorVersion ? ` v${trace.connectorVersion}` : ''}`);
        if (trace.deprecated) bits.push(`⚠ version เก่า — latest v${trace.latestVersion}`);
        if (trace.errorCode) bits.push(`code: ${trace.errorCode}`);
        if (trace.requestId) bits.push(`request: ${trace.requestId}`);
        row.append(el('p', 'hint faint', bits.join(' · ')));
      }
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
    const filters = el('div', 'hstack');
    for (const [key, label] of [['all', 'ทั้งหมด'], ['ok', 'ok'], ['error', 'error']]) {
      filters.append(button(`btn ghost${historyFilter === key ? ' on' : ''}`, label, () => {
        historyFilter = key;
        historyShown = 12;
        document.querySelector('#wfEditor .whistory')?.replaceWith(historyPanel());
      }));
    }
    box.append(head, filters);
    const visible = runs.filter((run) => historyFilter === 'all' || (historyFilter === 'ok' ? run.ok : !run.ok));
    if (visible.length === 0) {
      box.append(el('p', 'hint', runs.length === 0 ? 'ยังไม่มีการรัน — กด "รันทดสอบ" หรือรอ trigger' : 'ไม่มี run ที่ตรงกับตัวกรองนี้'));
      return box;
    }
    const list = el('div', 'wrunlist');
    const current = runResult?.id ?? runResult?.runId;
    for (const run of visible.slice(0, historyShown)) {
      const row = button(`wrunrow${run.id === current ? ' on' : ''}`, '', () => M().send({ type: 'workflow-run-get', id: run.id }));
      row.append(
        el('span', `pill ${run.ok ? 'ok' : 'todo'}`, run.ok ? 'ok' : 'error'),
        el('span', '', M().fmtDate(run.startedAt)),
        el('span', 'chip', run.trigger || run.mode),
        el('span', 'faint', `${(run.durationMs / 1000).toFixed(1)} วิ · ${run.nodeCount} node`),
        el('span', 'faint wrunres', run.result),
      );
      list.append(row);
    }
    box.append(list);
    if (visible.length > historyShown) {
      box.append(button('btn ghost', `ดูเพิ่ม (${visible.length - historyShown})`, () => {
        historyShown += 30;
        document.querySelector('#wfEditor .whistory')?.replaceWith(historyPanel());
      }));
    }
    return box;
  }

  /** Hints for a trigger node. Its settings are ordinary node fields on the card. */
  function triggerSection(node = triggerNode()) {
    const box = el('div');
    const entry = triggerEntryOf(node);
    if (!entry) return box;
    box.append(el('p', 'hint', 'node นี้เป็นจุดเริ่มของ workflow — ข้อมูลจากช่องทางนี้จะไหลออกทาง main ไปยัง node ถัดไป'));
    if (entry.kind === 'chat') {
      box.append(el('p', 'hint', `พิมพ์ในแชตตรงกับ ${M().nameOf(draft.agent)} แล้วข้อความที่ตรงเงื่อนไขจะเข้า workflow นี้ · {{ $json.rest }} = ข้อความหลังคำขึ้นต้น · "workflow_only" = agent ไม่ตอบข้อความนั้น`));
      box.append(el('p', 'hint', 'ไฟล์ที่แนบมาอยู่ใน {{ $json.files }} — แต่ละไฟล์มี id, kind (image / audio / video / file), name, mime, size และ text (คำบรรยายรูป/วิดีโอ, คำถอดเสียง หรือข้อความในไฟล์ ถ้าเลือกให้อ่านก่อน) · อ่านไฟล์ใหม่ด้วยคำสั่งของคุณเอง: node "ดึงข้อมูลจากไฟล์" ช่อง "ไฟล์จากแชต" = {{ $json.files[0].id }} · "ไฟล์แนบ" = image แปลว่ารันเฉพาะข้อความที่มีรูป'));
    }
    if (entry.kind === 'tool') {
      const toolName = `workflow_${String(draft.name || '<ชื่อ>').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const callers = [draft.agent, ...String(node?.config?.agents || '').split(/[\s,]+/).filter(Boolean)];
      box.append(el('p', 'hint', `agent ที่เรียกได้: ${[...new Set(callers)].map((name) => M().nameOf(name)).join(', ')} · จะเห็นเครื่องมือชื่อ ${toolName} พร้อมคำอธิบายจากช่อง "ใช้เมื่อไหร่" — เขียนให้ชัดว่าทำอะไร และควรใช้ตอนไหน agent จะเลือกถูกขึ้น`));
      box.append(el('p', 'hint', 'ค่าที่ agent ส่งมา: {{ $json.<ชื่อช่อง> }} และ {{ $json.agent }} = agent ที่เรียก · ผลที่ agent ได้กลับ = body ของ node "ตอบกลับ" ถ้ามี ไม่งั้นเป็น output ของ node สุดท้ายที่รัน · "ask" = ถามคุณก่อนรันทุกครั้ง'));
    }
    if (entry.kind === 'telegram') {
      const secret = String(node?.config?.tokenSecret || '').trim() || 'TELEGRAM_BOT_TOKEN';
      const has = (M().state.secrets || []).includes(secret);
      box.append(el('p', has ? 'hint' : 'hint badtxt', has ? `มี secret "${secret}" แล้ว ✓` : `ยังไม่มี secret "${secret}" — ใส่ bot token ที่ ตั้งค่า → secret ก่อน`));
      box.append(el('p', 'hint', 'ตอบกลับด้วย node "ส่ง Telegram" (chat id = {{ $json.chatId }}) · หา chat id ของตัวเอง: ทักบอทแล้วดู input ในประวัติการรัน'));
    }
    if (entry.kind === 'webhook') {
      if (draft.webhook) box.append(el('p', 'hint', `POST มาที่: ${M().webhookUrl(draft.webhook)} (ไม่ต้องใช้ token)`));
      else box.append(el('p', 'hint', 'บันทึกแล้วระบบจะสร้าง URL ให้'));
    }
    if (node?.type === 'trigger_connector') {
      const connectorTrigger = connectorTriggerOf(node.config?.connector, node.config?.trigger);
      if (connectorTrigger?.kind === 'webhook' && connectorTrigger.signature) {
        const secretName = String(node.config?.[connectorTrigger.signature.secretField] || '').trim();
        const has = secretName && (M().state.secrets || []).includes(secretName);
        box.append(
          el(
            'p',
            has ? 'hint' : 'hint badtxt',
            has
              ? `Signature ${connectorTrigger.signature.header} reads secret "${secretName}" from the vault.`
              : `Add secret "${secretName || connectorTrigger.signature.secretField}" to the vault, then paste the webhook URL in ${connectorOf(node.config?.connector)?.label || 'the service'}.`,
          ),
        );
      }
      if (connectorTrigger?.kind === 'poll') {
        const minutes = Number(node.config?.everyMinutes) || 15;
        box.append(el('p', 'hint', `Polls ${connectorTrigger.operation} every ${minutes} minutes; new items are deduplicated by ${connectorTrigger.idField || 'id'}.`));
      }
    }
    box.append(el('p', 'hint', `trigger นี้ให้ข้อมูลแบบนี้ (ใช้ {{ $json.x }}): ${JSON.stringify(entry.sample).slice(0, 220)}`));
    if (entry.kind === 'manual') box.append(el('p', 'hint', 'กด "รัน" แล้วจะให้ใส่ input JSON เองได้'));
    return box;
  }

  /** Starting settings of a new node, so it does something sensible right away. */
  function defaultConfig(type) {
    const config = {};
    if (type === 'agent') config.agent = draft.agent;
    if (type === 'connector') {
      const first = (M().state.connectors || [])[0];
      Object.assign(config, { connector: first?.key || '', operation: first?.operations[0]?.key || '', input: {} });
    }
    if (type === 'trigger_custom') config.pool = pool().find((entry) => !entry.builtin)?.name || '';
    if (type === 'trigger_connector') {
      const connector = (M().state.connectors || []).find((entry) => (entry.triggers || []).length > 0);
      const trigger = connector?.triggers?.[0];
      if (connector && trigger) {
        Object.assign(config, {
          connector: connector.key,
          trigger: trigger.key,
          ...(trigger.kind === 'poll' ? { everyMinutes: 15 } : {}),
          input: {},
        });
      }
    }
    if (type === 'trigger_mail') Object.assign(config, { source: 'google', maxMessages: 5, markRead: true });
    if (type === 'plugin') Object.assign(config, { plugin: (M().state.nodeTypes || []).find((spec) => spec.type === 'plugin')?.fields?.find((field) => field.key === 'plugin')?.options?.[0] || '', config: {} });
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
  function createNode(type, position, from, poolName) {
    sync();
    if (isTrigger(type)) {
      const existing = triggerNode();
      if (existing) {
        const pool = type === 'trigger_custom' ? String(poolName ?? existing.config?.pool ?? '').trim() : undefined;
        if (existing.type !== type || (type === 'trigger_custom' && pool && String(existing.config?.pool || '') !== pool)) {
          existing.type = type;
          existing.config = defaultConfig(type);
          if (type === 'trigger_custom' && pool) existing.config.pool = pool;
          existing.title = triggerTitleOf(existing);
        }
        return existing;
      }
    }
    const spec = specOf(type);
    const id = nextId();
    const config = defaultConfig(type);
    if (type === 'trigger_custom' && poolName) config.pool = poolName;
    const node = {
      id,
      type,
      title: isTrigger(type) ? triggerLabelOf(type, config) : spec?.label || type,
      config,
      links: { main: [] },
    };
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
    if (isTrigger(draft.nodes.find((entry) => entry.id === id)?.type)) return;
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

  /** Link dropped on empty canvas: choose what to create there (searches the same palette). */
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

  /** Add a node from the side library: tools are ordinary `tool` nodes with the tool pre-filled. */
  function addFromLibrary(entry) {
    if (!draft || !document.querySelector('#wfEditor')) return;
    sync();
    let node;
    if (entry.startsWith('tool@')) {
      node = createNode('tool', canvasApi?.center() || null, null);
      node.config.tool = entry.slice('tool@'.length);
      node.title = entry.slice('tool@'.length);
    } else if (entry.startsWith('trigger_custom@')) {
      node = createNode('trigger_custom', canvasApi?.center() || null, null, entry.slice('trigger_custom@'.length));
    } else if (entry.startsWith('plugin@')) {
      node = createNode('plugin', canvasApi?.center() || null, null);
      node.config.plugin = entry.slice('plugin@'.length);
      node.title = `Node: ${node.config.plugin}`;
    } else {
      node = createNode(entry, canvasApi?.center() || null, null);
    }
    selectedNode = node.id;
    sideTab = 'node';
    showEditor();
  }

  function libraryEntry(type, label, description) {
    const item = button('wlib-item', label, () => {
      if (item._timer) return;
      item._timer = setTimeout(() => {
        item._timer = null;
        addFromLibrary(type);
      }, 180);
    }, description);
    item.draggable = true;
    item.ondblclick = () => {
      clearTimeout(item._timer);
      item._timer = null;
      addFromLibrary(type);
    };
    item.ondragstart = (event) => {
      event.dataTransfer.setData('application/x-mimi-node', type);
      event.dataTransfer.effectAllowed = 'copy';
    };
    return item;
  }

  /** Persistent left panel: every node type and every tool, searchable, click or drag onto the canvas. */
  function nodeLibrary() {
    const box = el('div', 'wfc-library');
    const head = el('div', 'wlib-head');
    head.append(el('b', '', 'Node'));
    const search = M().textInput(libraryQuery, 'ค้นหา node หรือ tool…');
    search.className = 'wlib-search';
    head.append(search);
    const list = el('div', 'wlib-list');
    const draw = () => {
      const query = libraryQuery.trim().toLowerCase();
      const match = (text) => !query || text.toLowerCase().includes(query);
      const groups = new Map();
      for (const spec of nodeTypes()) {
        if (spec.type === 'trigger_custom') continue;
        if (!match(`${spec.label} ${spec.type} ${spec.description}`)) continue;
        const label = NODE_GROUPS.find((group) => group.types.includes(spec.type))?.label || 'อื่น ๆ';
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(libraryEntry(spec.type, spec.label, spec.description));
      }
      const customTriggers = pool()
        .filter((entry) => !entry.builtin && match(`${entry.label} ${entry.name} ${entry.description}`))
        .map((entry) =>
          libraryEntry(`trigger_custom@${entry.name}`, `ทริกเกอร์: ${entry.label}`, entry.description || `trigger จาก pool: ${entry.name}`),
        );
      if (customTriggers.length > 0) {
        const label = NODE_GROUPS[0].label;
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(...customTriggers);
      }
      const customNodes = (M().state.customNodes || [])
        .filter((name) => match(`custom node ${name}`))
        .map((name) => libraryEntry(`plugin@${name}`, `Node: ${name}`, `Custom node จาก user/nodes (${name})`));
      if (customNodes.length > 0) {
        const label = 'ข้อมูล';
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(...customNodes);
      }
      const items = M().toolItems ? M().toolItems() : M().state.tools || [];
      const tools = items
        .filter((tool) => !tool.preset && match(`${tool.name} ${tool.desc || ''}`))
        .map((tool) => libraryEntry(`tool@${tool.name}`, `tool: ${tool.name}`, M().describeTool?.(tool) || tool.desc || tool.name));
      list.replaceChildren();
      for (const label of [...NODE_GROUPS.map((group) => group.label), 'อื่น ๆ'].filter((name) => groups.has(name))) {
        const group = el('div', 'wlib-group');
        group.append(el('span', 'wlib-label', label));
        group.append(...groups.get(label));
        list.append(group);
      }
      if (tools.length > 0) {
        const group = el('div', 'wlib-group');
        group.append(el('span', 'wlib-label', 'เครื่องมือ'));
        group.append(...tools);
        list.append(group);
      }
      if (list.childElementCount === 0) list.append(el('p', 'hint', 'ไม่พบ node'));
    };
    search.oninput = () => {
      libraryQuery = search.value;
      draw();
    };
    draw();
    box.append(head, list);
    return box;
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
    if (!M().state.connections) M().send({ type: 'connector-connections' });
    if (mode === 'canvas') return showCanvasEditor();
    canvasApi = null;
    const dialog = el('div', 'dialog wfedit form');
    dialog.id = 'wfEditor';
    const head = el('div', 'hstack');
    head.append(el('h3', '', isNew ? 'Workflow ใหม่' : `แก้ไข ${draft.name || ''}`), el('span', 'pill ok', `agent: ${draft.agent}`), modeToggle());
    dialog.append(head, settingsSection());
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
    const host = el('div', 'wfc-canvas');
    const side = el('div', 'wfc-side');
    body.append(nodeLibrary(), host, side);
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
      run: runResult,
      selected: selectedNode,
      onSelect: (id) => {
        sync();
        selectedNode = id;
        if (id) sideTab = 'node';
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
        let node;
        if (type.startsWith('tool@')) {
          node = createNode('tool', position, from);
          node.config.tool = type.slice('tool@'.length);
          node.title = type.slice('tool@'.length);
        } else if (type.startsWith('trigger_custom@')) {
          node = createNode('trigger_custom', position, from, type.slice('trigger_custom@'.length));
        } else {
          node = createNode(type, position, from);
        }
        selectedNode = node.id;
        sideTab = 'node';
        showEditor();
      },
      removeNode: (id) => {
        if (isTrigger(draft.nodes.find((entry) => entry.id === id)?.type)) return;
        if (confirm(`ลบ node "${titleOf(id)}" ?`)) removeNode(id);
      },
      palette: paletteMenu,
    });
    renderSide();
    checkpoint();
  }

  /** Manual run: show the trigger's sample as editable input JSON. */
  function promptRun(workflow) {
    const trigger = workflow.nodes?.find((node) => isTrigger(node.type));
    const poolName = trigger ? triggerPoolOfNode(trigger) : workflow.trigger.pool;
    const entry = poolOf(poolName);
    running = true;
    runResult = null;
    const dialog = el('div', 'dialog form');
    dialog.append(el('h3', '', `รัน ${workflow.title || workflow.name}`), el('p', 'hint', `trigger: ${entry?.label || poolName} · ให้ input แบบ JSON (ใช้เป็น {{ $json.x }} ของ node แรก)`));
    const area = el('textarea');
    const sample = trigger && triggerPoolOfNode(trigger) === 'manual' && trigger.config?.input ? trigger.config.input : entry?.sample;
    area.value = JSON.stringify(sample || {}, null, 2);
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
      current && current.input.length > 0 ? current.input.map((item) => item.json) : (triggerEntryOf(triggerNode())?.sample ?? {});
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
      button('btn ghost', 'แก้ node นี้', () => {
        const id = nodeTest?.nodeId;
        nodeTest = null;
        if (draft) {
          selectedNode = id || null;
          sideTab = 'node';
          showEditor();
        } else M().closeOverlay();
      }, 'ปิดหน้าทดสอบ แล้วกลับไปแก้การตั้งค่า (เงื่อนไข/กรณี) ของ node'),
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
    if (message.type === 'connector-options') {
      const callback = connectorOptionCallbacks.get(message.reqId);
      connectorOptionCallbacks.delete(message.reqId);
      if (callback) callback(message);
      return;
    }
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

  // ---------- workflow import (n8n / Make / Zapier) ----------
  /** { agent, source, json, preview, busy, reqId } while the import dialog is open. */
  let importing = null;

  const IMPORT_SOURCES = [
    { key: 'n8n', label: 'n8n', accept: '.json,application/json', hint: 'In n8n open the workflow, then use Download to save it as JSON.' },
    { key: 'make', label: 'Make', accept: '.json,application/json', hint: 'In Make open the scenario menu, then Export Blueprint to save it as JSON.' },
    { key: 'zapier', label: 'Zapier', accept: '.json,.zap,application/json', hint: 'Download the Zap export (.zap) or paste its JSON.' },
  ];

  function sourceOf(key) {
    return IMPORT_SOURCES.find((entry) => entry.key === key) || IMPORT_SOURCES[0];
  }

  function openImport(agent) {
    importing = { agent, source: 'n8n', json: '', preview: null, busy: false, reqId: 0 };
    showImport();
  }

  function sendImport(save) {
    if (!importing || importing.busy) return;
    if (!importing.json.trim()) return;
    importing.busy = true;
    importing.reqId += 1;
    showImport();
    M().send({ type: `workflow-import-${importing.source}`, agent: importing.agent, json: importing.json, save, reqId: importing.reqId });
  }

  function showImport() {
    if (!importing) return;
    const dialog = el('div', 'dialog wfedit form');
    dialog.append(
      el('h3', '', 'Import workflow'),
      el('p', 'hint', 'Upload an export from n8n, Make or Zapier. Credentials are redacted and never imported; every imported workflow starts disabled.'),
    );
    const source = el('select');
    for (const entry of IMPORT_SOURCES) {
      const option = el('option', '', entry.label);
      option.value = entry.key;
      if (entry.key === importing.source) option.selected = true;
      source.append(option);
    }
    source.onchange = () => {
      importing.source = source.value;
      importing.preview = null;
      importing.busy = false;
      showImport();
    };
    dialog.append(M().labelled('Source', source));
    const chosen = sourceOf(importing.source);
    dialog.append(el('p', 'hint', chosen.hint));
    const file = el('input');
    file.type = 'file';
    file.accept = chosen.accept;
    file.onchange = async () => {
      const picked = file.files && file.files[0];
      if (!picked) return;
      importing.json = await picked.text();
      importing.preview = null;
      sendImport(false);
    };
    dialog.append(M().labelled(`Export file (${chosen.accept})`, file));
    const paste = el('textarea');
    paste.placeholder = 'Paste the exported JSON here';
    paste.value = importing.json && importing.json.length < 20000 ? importing.json : '';
    dialog.append(paste, button('btn ghost', 'Preview pasted JSON', () => {
      importing.json = paste.value;
      importing.preview = null;
      sendImport(false);
    }));
    if (importing.busy) dialog.append(el('p', 'hint', 'Importing...'));
    const preview = importing.preview;
    if (preview) dialog.append(importReport(preview));
    const foot = el('div', 'foot');
    foot.append(
      el('span', 'msg'),
      button('btn ghost', 'Close', () => {
        importing = null;
        M().closeOverlay();
      }),
    );
    if (preview && !preview.saved && !importing.busy) {
      foot.append(button('btn pri', `Import ${preview.workflows.length} workflow(s)`, () => sendImport(true)));
    }
    dialog.append(foot);
    M().overlay(dialog);
  }

  function nodeSummary(workflow) {
    const details = el('details');
    details.append(el('summary', '', `${(workflow.nodes || []).length} nodes`));
    const pre = el('pre', 'wjson');
    pre.textContent = (workflow.nodes || []).map((node) => `${node.type} - ${node.title}`).join('\n');
    details.append(pre);
    return details;
  }

  function importSubject(item) {
    return item.node || item.module || item.step || item.title || 'workflow';
  }

  function importDetail(item) {
    const detail = item.type || item.api || item.action || '';
    return detail ? ` (${detail})` : '';
  }

  function importReport(preview) {
    const { report } = preview;
    const source = sourceOf(preview.source || 'n8n').label;
    const box = el('div', 'wresult');
    box.append(el('h4', '', preview.saved ? 'Import finished' : `Preview: ${preview.workflows.length} workflow(s) from ${source}`));
    const rows = el('div', 'tbl');
    for (const [index, entry] of report.workflows.entries()) {
      const row = el('div', 'hstack');
      row.append(el('b', '', entry.title), el('span', 'chip', entry.trigger), el('span', 'faint', `${entry.nodes} node - ${entry.name}`));
      const workflow = preview.workflows[index];
      if (workflow) row.append(nodeSummary(workflow));
      rows.append(row);
    }
    box.append(rows);
    const section = (title, items, render, open) => {
      if (!items || items.length === 0) return;
      const details = el('details');
      if (open) details.open = true;
      details.append(el('summary', '', `${title} (${items.length})`));
      for (const item of items) details.append(render(item));
      box.append(details);
    };
    section('Mapped to Mimi nodes', report.mapped || [], (item) => el('p', 'hint', `${importSubject(item)} -> ${item.connector}/${item.operation} (${item.confidence})`), false);
    section('Unsupported nodes (imported as placeholders)', report.unsupported, (item) => el('p', 'hint badtxt', `${importSubject(item)}${importDetail(item)}: ${item.reason}`), true);
    section('Warnings', report.warnings, (item) => el('p', 'hint', item), true);
    section('Redacted secrets (never imported)', report.redacted, (item) => el('p', 'hint', `${importSubject(item)} - ${item.field}`), false);
    const connections = report.connections || [];
    section('Connections to pick', connections, (item) => {
      const parts = [item.connector, item.credentialType, item.credentialName, item.connectionId, item.authenticationId].filter(Boolean);
      return el('p', 'hint', `${importSubject(item)}: ${parts.join(' - ')}. Pick a Mimi connection in the editor.`);
    }, connections.length > 0);
    if (connections.length > 0) {
      box.append(button('btn ghost', 'Open Hub > Connections', () => {
        importing = null;
        M().closeOverlay();
        M().ui.hubTab = 'accounts';
        M().setView('hub');
        M().renderHub();
      }));
    }
    section('Models referenced by n8n (pick a model in the editor)', report.models || [], (item) => el('p', 'hint', `${importSubject(item)}: ${item.model}`), false);
    section('System prompts from n8n (review before enabling)', report.prompts || [], (item) => {
      const wrap = el('div');
      const pre = el('pre', 'wjson');
      pre.textContent = item.text;
      wrap.append(el('b', '', importSubject(item)), pre, button('btn ghost', 'Copy', () => navigator.clipboard?.writeText(item.text).then(() => M().toast('Copied'))));
      return wrap;
    }, false);
    for (const error of preview.errors || []) box.append(el('p', 'hint badtxt', error));
    return box;
  }

  function onImport(message) {
    if (!importing || message.agent !== importing.agent) return;
    if (message.source !== importing.source) return;
    if (message.reqId !== undefined && message.reqId !== importing.reqId) return;
    importing.busy = false;
    importing.preview = message;
    if (message.saved) M().toast(`Imported ${message.workflows.length - (message.errors || []).length} workflow(s)`, 'Saved as disabled; review the report before enabling.');
    showImport();
  }

  window.MimiHooks.agentWorkflows = { render, onMessage, onConnections: () => {
    if (!draft) return;
    sync();
    showEditor();
  }, onResult, onNodeResult, onRuns, onRunRecord, onImport, onExprPreview };
  window.MimiHooks.workflows = window.MimiHooks.agentWorkflows;
})();
