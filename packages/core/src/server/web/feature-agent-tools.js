(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const RISK_LABEL = { read: 'อ่าน', write: 'เขียน', shell: 'shell', delete: 'ลบ', network: 'เน็ต' };
  const FILTERS = [
    ['all', 'ทั้งหมด'],
    ['on', 'ติดตั้งแล้ว'],
    ['off', 'ยังไม่ติดตั้ง'],
    ['setup', 'ต้องตั้งค่า'],
  ];
  const CONNECTOR_CATEGORIES = [
    ['ai', 'AI'],
    ['cms', 'CMS'],
    ['commerce', 'Commerce'],
    ['communication', 'Communication'],
    ['crm', 'CRM'],
    ['database', 'Database'],
    ['developer', 'Developer'],
    ['finance', 'Finance'],
    ['marketing', 'Marketing'],
    ['productivity', 'Productivity'],
    ['project-management', 'Project management'],
    ['storage', 'Storage'],
  ];

  // One card per service, with its operations inside. Individual tools are still what
  // agents list; this only keeps the picker from growing one card per operation.
  const FAMILIES = [
    { id: 'gmail', label: 'Gmail', prefix: 'gmail_', match: (name) => name.startsWith('gmail_') },
    { id: 'calendar', label: 'Google Calendar', prefix: 'calendar_', match: (name) => name.startsWith('calendar_') },
    { id: 'sheets', label: 'Google Sheets', prefix: 'sheets_', match: (name) => name.startsWith('sheets_') },
    { id: 'drive', label: 'Google Drive', prefix: 'drive_', match: (name) => name.startsWith('drive_') },
    { id: 'outlook', label: 'Outlook', prefix: 'outlook_', match: (name) => name.startsWith('outlook_') },
    { id: 'onedrive', label: 'OneDrive', prefix: 'onedrive_', match: (name) => name.startsWith('onedrive_') },
    { id: 'todo', label: 'To-do', prefix: 'todo_', match: (name) => name.startsWith('todo_') },
    { id: 'memory', label: 'Memory', match: (name) => ['read_memory', 'write_memory', 'delete_memory', 'search_history'].includes(name) },
    { id: 'media', label: 'Media', match: (name) => ['send_file', 'generate_image', 'generate_video', 'text_to_speech'].includes(name) },
    {
      id: 'files',
      label: 'Files',
      match: (name) =>
        ['read_file', 'write_file', 'edit_file', 'list_dir', 'find_files', 'file_info', 'make_dir', 'move_path', 'copy_path', 'delete_path', 'open_path'].includes(name),
    },
    { id: 'browser', label: 'Browser', prefix: 'browser_', match: (name) => name.startsWith('browser_') },
    {
      id: 'system',
      label: 'System',
      match: (name) => ['run_shell', 'system_info', 'list_processes', 'stop_process', 'power', 'wake_pc'].includes(name),
    },
    { id: 'web', label: 'Web', match: (name) => ['web_search', 'map_search', 'youtube_search', 'weather'].includes(name) },
    {
      id: 'triggers',
      label: 'Triggers',
      match: (name) => ['create_trigger', 'cancel_trigger', 'list_triggers', 'update_trigger'].includes(name),
    },
    { id: 'sessions', label: 'Sessions', match: (name) => ['list_sessions', 'read_session'].includes(name) },
    { id: 'memos', label: 'Memos', prefix: 'memo_', match: (name) => name.startsWith('memo_') },
    { id: 'gallery', label: 'Gallery', prefix: 'gallery_', match: (name) => name.startsWith('gallery_') },
    { id: 'status', label: 'Status', match: (name) => name === 'status_set' },
    { id: 'profile', label: 'Profile', match: (name) => name === 'profile_update' },
    { id: 'skills', label: 'Skills', match: (name) => name === 'load_skill' },
    { id: 'workflows', label: 'Workflow tools', prefix: 'workflow_', match: (name) => name.startsWith('workflow_') },
  ];

  function initials(name) {
    const parts = String(name || '').replace(/^mcp_/, '').split(/[_-]+/).filter(Boolean);
    return `${(parts[0] || '?')[0] || '?'}${(parts[1] || '')[0] || ''}`.toUpperCase();
  }

  function render(box, agentName, checked) {
    const selected = new Set(checked || []);
    const drafts = new Map();
    const draftSecrets = new Map();
    const dirty = new Set();
    let query = '';
    let filter = 'all';
    let category = 'all';

    const currentAgent = () => String((typeof agentName === 'function' ? agentName() : agentName) || 'agent');
    const tools = () => M().state.tools || [];
    const allPresets = () => {
      const map = new Map((M().state.toolPresets || []).map((preset) => [preset.name, preset]));
      for (const [name, preset] of drafts) map.set(name, preset);
      return [...map.values()];
    };
    const presetByName = (name) => allPresets().find((preset) => preset.name === name) || null;
    const selectedPresetOf = (toolName) => {
      for (const name of selected) {
        const preset = presetByName(name);
        if (preset && preset.tool === toolName) return preset;
      }
      return null;
    };
    const entryOf = (tool) => {
      if (selected.has(tool.name)) return { name: tool.name, preset: null };
      const preset = selectedPresetOf(tool.name);
      return preset ? { name: preset.name, preset } : null;
    };
    const hasSecret = (preset, key) => {
      if (!preset) return false;
      const stored = (M().state.toolSecretKeys || {})[preset.name] || [];
      return stored.includes(key) || Boolean((draftSecrets.get(preset.name) || {})[key]);
    };
    const missing = (tool, preset) =>
      tool.settings.filter(
        (field) =>
          field.required &&
          !field.default &&
          !(preset && preset.settings && preset.settings[field.key] !== undefined && preset.settings[field.key] !== '') &&
          !hasSecret(preset, field.key),
      );
    const configured = (tool, preset) => missing(tool, preset).length === 0;
    const markDirty = () => {
      M().ui.agentDirty = true;
    };
    const autoName = (toolName) => {
      const taken = new Set([...tools().map((tool) => tool.name), ...allPresets().map((preset) => preset.name)]);
      const who =
        currentAgent()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '_')
          .replace(/^[^a-z]+/, '') || 'agent';
      let name = `${toolName}__${who}`;
      let n = 2;
      while (taken.has(name)) name = `${toolName}__${who}_${n++}`;
      return name;
    };
    const pick = (toolName, name) => {
      for (const current of [...selected]) {
        if (current === toolName) {
          selected.delete(current);
          continue;
        }
        const preset = presetByName(current);
        if (preset && preset.tool === toolName) selected.delete(current);
      }
      selected.add(name);
    };

    function fieldControl(field, preset) {
      const value = preset && preset.settings ? preset.settings[field.key] : undefined;
      const initial = value !== undefined ? value : field.default;
      if (field.type === 'account' || field.type === 'connection') {
        const select = el('select');
        const empty = el('option', '', field.type === 'account' ? '— บัญชีเริ่มต้น —' : '— connection เริ่มต้น —');
        empty.value = '';
        select.append(empty);
        const entries =
          field.type === 'account'
            ? (M().state.settings && M().state.settings.accounts) || []
            : (M().state.connections || []).filter((entry) => entry.connector === field.connector);
        for (const entry of entries.filter((account) => field.type !== 'account' || !field.service || account.service === field.service)) {
          const option = el('option', '', `${entry.name}${entry.default ? ' ★' : ''}${entry.connected ? '' : ' (ยังไม่เชื่อมต่อ)'}`);
          option.value = entry.id;
          select.append(option);
        }
        if (initial && !entries.some((entry) => entry.id === initial)) {
          const option = el('option', '', `${initial} (ไม่พบ)`);
          option.value = initial;
          select.append(option);
        }
        select.value = String(initial || '');
        return { node: select, read: () => select.value || undefined };
      }
      if (field.type === 'boolean') {
        const input = el('input');
        input.type = 'checkbox';
        input.checked = Boolean(initial);
        const row = el('div', 'tcheck');
        row.append(input, el('span', '', field.label));
        return { node: row, read: () => input.checked };
      }
      if (field.type === 'text') {
        const area = el('textarea');
        area.value = initial === undefined ? '' : String(initial);
        area.placeholder = field.placeholder || '';
        return { node: area, read: () => area.value.trim() || undefined };
      }
      if (field.type === 'secret') {
        const existing = preset ? hasSecret(preset, field.key) : false;
        const input = el('input');
        input.type = 'password';
        input.autocomplete = 'new-password';
        input.placeholder = existing ? 'เก็บไว้แล้ว — เว้นว่างเพื่อใช้ค่าเดิม' : field.placeholder || '';
        return { node: input, read: () => input.value.trim() || undefined };
      }
      const input = el('input');
      input.type = field.type === 'number' ? 'number' : 'text';
      input.value = initial === undefined ? '' : String(initial);
      input.placeholder = field.placeholder || '';
      return {
        node: input,
        read: () => {
          if (!input.value.trim()) return undefined;
          if (field.type !== 'number') return input.value.trim();
          const number = Number(input.value);
          return Number.isFinite(number) ? number : NaN;
        },
      };
    }

    function openConfig(tool, preset) {
      const entry = entryOf(tool);
      const editing = Boolean(entry);
      const dialog = el('div', 'dialog form toolconfig');
      dialog.append(el('h3', '', preset || editing ? `ตั้งค่า ${tool.name}` : `ติดตั้ง ${tool.name}`));
      dialog.append(el('p', 'hint', tool.description));
      if (preset) {
        const users = (M().state.agents || []).filter((agent) => (agent.tools || []).includes(preset.name) && agent.name !== currentAgent());
        if (users.length > 0) dialog.append(el('p', 'warnbox', `preset นี้ใช้ร่วมกับ ${users.map((agent) => M().nameOf(agent.name)).join(', ')} — แก้แล้วมีผลกับ agent เหล่านั้นด้วย`));
      }
      const controls = [];
      for (const field of tool.settings) {
        const control = fieldControl(field, preset);
        if (field.type === 'boolean') {
          if (field.required) control.node.querySelector('span').textContent = `${field.label} *`;
          dialog.append(control.node);
        } else {
          dialog.append(M().labelled(`${field.label}${field.required ? ' *' : ''}`, control.node));
        }
        if (field.description) dialog.append(el('p', 'hint fieldhint', field.description));
        controls.push({ field, control });
      }
      const message = el('span', 'msg');
      const foot = el('div', 'foot');
      if (entry) {
        foot.append(
          button('btn danger', 'ถอด', () => {
            selected.delete(entry.name);
            markDirty();
            M().closeOverlay();
            paint();
          }),
        );
      }
      foot.append(
        button('btn ghost', 'ยกเลิก', () => M().closeOverlay()),
        button('btn pri', preset || editing ? 'บันทึกการตั้งค่า' : 'ติดตั้ง node นี้', () => {
          const settings = {};
          const secrets = {};
          for (const { field, control } of controls) {
            const value = control.read();
            if (field.type === 'number' && Number.isNaN(value)) {
              message.textContent = `"${field.label}" ต้องเป็นตัวเลข`;
              message.classList.add('bad');
              return;
            }
            const hasValue = value !== undefined && value !== '';
            const hasExistingSecret = field.type === 'secret' && preset && hasSecret(preset, field.key);
            if (field.required && !field.default && !hasValue && !hasExistingSecret) {
              message.textContent = `กรอก "${field.label}" ก่อน`;
              message.classList.add('bad');
              return;
            }
            if (hasValue) settings[field.key] = value;
            if (field.type === 'secret' && hasValue) secrets[field.key] = String(value);
          }
          const name = preset ? preset.name : autoName(tool.name);
          const next = {
            name,
            tool: tool.name,
            ...(preset && preset.label ? { label: preset.label } : {}),
            ...(preset && preset.description ? { description: preset.description } : {}),
            settings,
          };
          drafts.set(name, next);
          if (Object.keys(secrets).length > 0) {
            draftSecrets.set(name, { ...(draftSecrets.get(name) || {}), ...secrets });
          }
          dirty.add(name);
          pick(tool.name, name);
          markDirty();
          M().closeOverlay();
          paint();
          M().toast(preset || editing ? 'บันทึกการตั้งค่าแล้ว' : 'ติดตั้งแล้ว', 'กด "บันทึก" ด้านล่างของหน้าเพื่อยืนยัน');
        }),
      );
      foot.prepend(message);
      dialog.append(foot);
      M().overlay(dialog);
    }

    const familyOfTool = (tool) => {
      if (tool.connector) return `connector:${tool.connector}`;
      if (!tool.builtin || tool.mcp) return `tool:${tool.name}`;
      const family = FAMILIES.find((entry) => entry.match(tool.name));
      return family ? family.id : `tool:${tool.name}`;
    };
    const familyMeta = (id) => {
      const family = FAMILIES.find((entry) => entry.id === id);
      if (family) return family;
      if (id.startsWith('connector:')) {
        const connector = id.slice('connector:'.length);
        const tool = tools().find((entry) => entry.connector === connector);
        return {
          id,
          label: (tool && tool.familyLabel) || connector,
          prefix: `${connector}_`,
          category: (tool && tool.connectorCategory) || 'other',
        };
      }
      return { id, label: id.replace(/^tool:/, '') };
    };
    const families = () => {
      const map = new Map();
      for (const tool of tools()) {
        const id = familyOfTool(tool);
        if (!map.has(id)) map.set(id, { ...familyMeta(id), tools: [] });
        map.get(id).tools.push(tool);
      }
      return [...map.values()];
    };
    const opLabel = (tool) => {
      if (tool.operation) return String(tool.operation).replace(/_/g, ' ');
      const family = FAMILIES.find((entry) => entry.id === familyOfTool(tool));
      const rest = family && family.prefix && tool.name.startsWith(family.prefix) ? tool.name.slice(family.prefix.length) : tool.name;
      return rest.replace(/_/g, ' ') || tool.name;
    };
    const needsConfig = (tool) => tool.settings.some((field) => field.required !== false && field.default === undefined);
    const familyInstalled = (family) => family.tools.filter((tool) => entryOf(tool)).length;
    const familyNeedsSetup = (family) =>
      family.tools.some((tool) => {
        const entry = entryOf(tool);
        return Boolean(entry && !configured(tool, entry.preset));
      });
    const riskOrder = { read: 0, network: 1, write: 2, shell: 3, delete: 4 };

    function familyCard(family) {
      const installed = familyInstalled(family);
      const needsSetup = familyNeedsSetup(family);
      const node = button(`tcard qwcard${installed ? ' on' : ''}${needsSetup ? ' need' : ''}`, null, () => openFamily(family));
      node.title = `${family.label}: ${family.tools.map((tool) => opLabel(tool)).join(', ')}`;
      const risk = family.tools.map((tool) => tool.risk).sort((a, b) => (riskOrder[b] || 0) - (riskOrder[a] || 0))[0] || 'read';
      const icon = el('span', 'tcard-ico', initials(family.label));
      icon.dataset.risk = risk;
      const body = el('div', 'tcard-body');
      body.append(el('b', 'tcard-name', family.label));
      const chips = el('div', 'opchips');
      for (const tool of family.tools.slice(0, 6)) {
        const entry = entryOf(tool);
        const chip = el('span', `opchip${entry ? ' on' : ''}${entry && !configured(tool, entry.preset) ? ' warn' : ''}`, opLabel(tool));
        chip.title = `${tool.name} · ${tool.description}`;
        chips.append(chip);
      }
      if (family.tools.length > 6) chips.append(el('span', 'opchip', `+${family.tools.length - 6}`));
      body.append(chips);
      body.append(el('small', `tcard-state${needsSetup ? ' warn' : ''}`, installed ? `ติดตั้ง ${installed}/${family.tools.length} operation` : 'ยังไม่ติดตั้ง'));
      node.append(icon, body);
      return node;
    }

    function pickerCard(family) {
      const installed = familyInstalled(family);
      const needsSetup = familyNeedsSetup(family);
      const node = button(`tcard qwpick${installed ? ' on' : ''}${needsSetup ? ' need' : ''}`, null, () => openFamily(family));
      node.title = `${family.label}: ${family.tools.map((tool) => opLabel(tool)).join(', ')}`;
      const icon = el('span', 'tcard-ico', initials(family.label));
      const risk = family.tools.map((tool) => tool.risk).sort((a, b) => (riskOrder[b] || 0) - (riskOrder[a] || 0))[0] || 'read';
      icon.dataset.risk = risk;
      const body = el('div', 'tcard-body');
      body.append(el('b', 'tcard-name', family.label));
      body.append(el('small', `tcard-state${needsSetup ? ' warn' : ''}`, `${family.tools.length} operation${installed ? ` · ติดตั้ง ${installed}` : ''}`));
      node.append(icon, body);
      return node;
    }

    function addCard() {
      const node = button('tcard qwadd', null, openPicker);
      node.append(el('span', 'qwplus', '+'), el('b', 'tcard-name', 'เพิ่ม Quick Work'), el('small', 'tcard-desc', 'เลือก node / operation จากคลัง'));
      return node;
    }

    function openFamily(family) {
      const dialog = el('div', 'dialog form toolconfig');
      dialog.append(el('h3', '', family.label));
      dialog.append(
        el('p', 'hint', family.tools.length > 1 ? 'หนึ่ง node มีหลาย operation — เพิ่มหรือถอดได้ทีละตัว' : 'ตั้งค่าหรือติดตั้ง node นี้'),
      );
      const list = el('div', 'oplist');
      for (const tool of family.tools) {
        const entry = entryOf(tool);
        const row = el('div', 'oprow');
        const info = el('div');
        info.append(el('b', 'mono', tool.name), el('small', '', `${opLabel(tool)} · ${tool.description}`));
        const meta = el('div', 'tcard-meta');
        meta.append(el('span', `risk${tool.risk === 'read' ? '' : ' w'}`, RISK_LABEL[tool.risk] || tool.risk));
        if (entry && entry.preset) meta.append(el('span', 'badge', entry.preset.name));
        if (tool.settings.length > 0) meta.append(el('span', 'badge', `${tool.settings.length} settings`));
        info.append(meta);
        const actions = el('div', 'hstack');
        if (entry) {
          if (tool.settings.length > 0) actions.append(button('btn ghost', 'ตั้งค่า', () => openConfig(tool, entry.preset)));
          actions.append(
            button('btn danger', 'ถอด', () => {
              selected.delete(entry.name);
              markDirty();
              M().closeOverlay();
              paint();
            }),
          );
        } else {
          const setup = needsConfig(tool);
          actions.append(
            button('btn', setup ? 'เพิ่ม + ตั้งค่า' : 'เพิ่ม', () => {
              if (setup) {
                openConfig(tool, null);
                return;
              }
              selected.add(tool.name);
              markDirty();
              M().closeOverlay();
              paint();
            }),
          );
        }
        row.append(info, actions);
        list.append(row);
      }
      dialog.append(list);
      const foot = el('div', 'foot');
      foot.append(button('btn ghost', 'ปิด', () => M().closeOverlay()));
      dialog.append(foot);
      M().overlay(dialog);
    }

    function openPicker() {
      const dialog = el('div', 'dialog form toolpicker');
      dialog.append(el('h3', '', 'เพิ่ม Quick Work'));
      dialog.append(el('p', 'hint', 'เลือก node แล้วเพิ่ม operation ที่ต้องการได้เรื่อย ๆ ใน node เดียว'));
      const bar = el('div', 'toolgrid-bar');
      const search = el('input', 'toolgrid-search');
      search.type = 'search';
      search.placeholder = 'ค้นหา node หรือ operation…';
      search.value = query;
      search.oninput = () => {
        query = search.value;
        paintPicker();
      };
      const filters = el('div', 'toolgrid-filters');
      const chips = FILTERS.map(([key, label]) => {
        const chip = button(key === filter ? 'on' : '', label, () => {
          filter = key;
          for (const entry of chips) entry.classList.toggle('on', entry.dataset.filter === filter);
          paintPicker();
        });
        chip.dataset.filter = key;
        filters.append(chip);
        return chip;
      });
      const categorySelect = el('select', 'toolgrid-category');
      const allOption = el('option', '', 'All categories');
      allOption.value = 'all';
      categorySelect.append(allOption);
      for (const [key, label] of CONNECTOR_CATEGORIES) {
        const option = el('option', '', label);
        option.value = key;
        categorySelect.append(option);
      }
      categorySelect.value = category;
      categorySelect.onchange = () => {
        category = categorySelect.value;
        paintPicker();
      };
      filters.append(categorySelect);
      const count = el('span', 'toolgrid-count');
      bar.append(search, filters, count);
      const grid = el('div', 'tgrid toolpickergrid');
      const paintPicker = () => {
        const needle = query.trim().toLowerCase();
        const visible = families()
          .filter((family) => {
            const installed = familyInstalled(family);
            if (category !== 'all' && family.category !== category) return false;
            if (filter === 'on' && installed === 0) return false;
            if (filter === 'off' && installed > 0) return false;
            if (filter === 'setup' && !familyNeedsSetup(family)) return false;
            if (!needle) return true;
            return `${family.label} ${family.tools.map((tool) => `${tool.name} ${tool.description}`).join(' ')}`.toLowerCase().includes(needle);
          })
          .sort((a, b) => familyInstalled(a) - familyInstalled(b) || a.label.localeCompare(b.label));
        count.textContent = `${visible.length}/${families().length} node`;
        grid.replaceChildren();
        if (visible.length === 0) grid.append(el('p', 'empty', 'ไม่พบ node ที่ตรงกับคำค้น'));
        for (const family of visible) grid.append(pickerCard(family));
      };
      const foot = el('div', 'foot');
      foot.append(button('btn ghost', 'ปิด', () => M().closeOverlay()));
      dialog.append(bar, grid, foot);
      M().overlay(dialog);
      paintPicker();
    }

    const wrap = el('div', 'toolgrid');
    const bar = el('div', 'toolgrid-bar qwbar');
    const count = el('span', 'toolgrid-count');
    bar.append(count, button('btn ghost', '+ เพิ่ม', openPicker));
    const grid = el('div', 'qw-grid');
    wrap.append(bar, grid);

    function paint() {
      const all = tools();
      const installed = all.filter((tool) => entryOf(tool)).length;
      const visible = families().filter((family) => familyInstalled(family) > 0);
      count.textContent = `ติดตั้ง ${installed}/${all.length} operation · ${visible.length} node`;
      grid.replaceChildren();
      if (visible.length === 0) grid.append(el('p', 'empty qwempty', 'ยังไม่มี Quick Work — กด + เพื่อเลือก node/operation'));
      for (const family of visible) grid.append(familyCard(family));
      grid.append(addCard());
    }

    function persist() {
      for (const name of dirty) {
        if (!selected.has(name)) continue;
        const preset = drafts.get(name);
        if (!preset) continue;
        const message = { type: 'tool-preset-save', preset };
        const secrets = draftSecrets.get(name);
        if (secrets && Object.keys(secrets).length > 0) message.secrets = secrets;
        M().send(message);
      }
    }

    box.append(wrap);
    paint();
    return { names: () => [...selected], persist };
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.agentTools = { render };
})();
