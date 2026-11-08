// Hub → ฉากหลัง: backdrops for the chat stage, like the scenes of a visual novel. One is
// chosen for the whole app and, optionally, one per agent; "auto" picks by the agent's
// location (the first backdrop with a keyword its location contains). A change dissolves.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  let selected = null; // backdrop id, '' for the "new" form, null for the intro

  const data = () => M().state.backgrounds || { items: [], settings: { default: '', agents: {} } };
  const items = () => data().items;
  /** A chat's own upload lives in the Hub's background store under this prefix. */
  const chatImagePrefix = (chatId) => `chatbg-${chatId}-`;
  const isChatImage = (item) => /^chatbg-\d+-/.test(item.id);
  const sceneItems = () => items().filter((item) => !isChatImage(item));

  // ---------- the built-in backgrounds ----------
  const PRESETS = [
    { id: 'floral', name: 'ลายดอกไม้', file: 'floral.webp' },
    { id: 'mint', name: 'มินต์', file: 'mint.webp' },
    { id: 'blush', name: 'ชมพู', file: 'blush.webp' },
    { id: 'sky', name: 'ฟ้า', file: 'sky.webp' },
    { id: 'grid', name: 'ตาราง', file: 'grid.webp' },
    { id: 'starlight', name: 'แสงดาว', file: 'starlight.webp' },
    { id: 'dawn', name: 'รุ่งอรุณ', file: 'dawn.webp' },
    { id: 'ember', name: 'เมฆแดงเข้ม', file: 'ember.webp' },
    { id: 'crimson', name: 'เมฆชาด', file: 'crimson.webp' },
    { id: 'waves', name: 'คลื่นทะเล', file: 'waves.webp' },
    { id: 'confetti', name: 'คอนเฟตติ', file: 'confetti.webp' },
  ];
  const presetById = (id) => PRESETS.find((preset) => preset.id === id);
  const LEGACY_PRESETS = { night: 'starlight', cafe: 'crimson', forest: 'mint', room: 'blush', ocean: 'waves', sunset: 'dawn' };
  const presetId = (id) => LEGACY_PRESETS[id] || id;
  function presetUrl(id) {
    const preset = presetById(presetId(id)) || PRESETS[0];
    return `/backgrounds/${preset.file}?v=1`;
  }

  // ---------- a chat's own background ----------
  const BG_KEY = (chatId) => `mimi.chat.${chatId}.background`;
  const BG_RULES_KEY = (chatId) => `mimi.chat.${chatId}.backgroundRules`;
  const DEFAULT_BG = { type: 'none', color: '#1b1d22', from: '#1b1d22', to: '#3a2d28', angle: 135, preset: 'floral', upload: '' };
  const BG_TYPES = new Set(['none', 'solid', 'gradient', 'preset', 'upload']);
  const RULE_TYPES = new Set(['default', 'solid', 'gradient', 'preset', 'upload']);
  const COLOR = /^#[0-9a-f]{6}$/i;

  function storedJson(key) {
    try {
      const raw = M().store.get(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function writeStored(key, value) {
    M().store.set(key, JSON.stringify(value));
  }
  function cleanClock(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!match) return '';
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }
  const clockMinutes = (value) => {
    const clock = cleanClock(value);
    return clock ? Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)) : null;
  };
  function normalizeBg(raw) {
    const bg = raw && typeof raw === 'object' ? raw : {};
    const type = BG_TYPES.has(bg.type) ? bg.type : 'none';
    const preset = presetId(String(bg.preset || ''));
    return {
      type,
      color: COLOR.test(String(bg.color || '')) ? String(bg.color) : DEFAULT_BG.color,
      from: COLOR.test(String(bg.from || '')) ? String(bg.from) : DEFAULT_BG.from,
      to: COLOR.test(String(bg.to || '')) ? String(bg.to) : DEFAULT_BG.to,
      angle: Number.isFinite(Number(bg.angle)) ? Math.min(360, Math.max(0, Number(bg.angle))) : DEFAULT_BG.angle,
      preset: presetById(preset) ? preset : DEFAULT_BG.preset,
      upload: typeof bg.upload === 'string' ? bg.upload : '',
    };
  }
  function readChatBg(chatId) {
    const raw = storedJson(BG_KEY(chatId));
    return raw && typeof raw === 'object' ? normalizeBg(raw) : null;
  }
  function writeChatBg(chatId, bg) {
    writeStored(BG_KEY(chatId), normalizeBg(bg));
  }
  function normalizeRule(raw, index) {
    const rule = raw && typeof raw === 'object' ? raw : {};
    const preset = presetId(String(rule.preset || ''));
    return {
      id: typeof rule.id === 'string' && rule.id ? rule.id : `rule-${index}-${Date.now()}`,
      from: cleanClock(rule.from) || '18:00',
      to: cleanClock(rule.to) || '06:00',
      type: RULE_TYPES.has(rule.type) ? rule.type : 'default',
      preset: presetById(preset) ? preset : DEFAULT_BG.preset,
      upload: typeof rule.upload === 'string' ? rule.upload : '',
    };
  }
  function readChatRules(chatId) {
    const raw = storedJson(BG_RULES_KEY(chatId));
    return Array.isArray(raw) ? raw.map(normalizeRule) : [];
  }
  function writeChatRules(chatId, rules) {
    writeStored(BG_RULES_KEY(chatId), rules.map(normalizeRule));
  }
  function nowMinutes() {
    const zone = M().state.settings && M().state.settings.timezone;
    if (zone) {
      try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
        return Number(parts.find((part) => part.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
      } catch {
        // an unknown zone: use this device's clock
      }
    }
    return new Date().getHours() * 60 + new Date().getMinutes();
  }
  function ruleActive(rule, now) {
    const from = clockMinutes(rule.from);
    const to = clockMinutes(rule.to);
    if (from === null || to === null) return false;
    if (from === to) return true;
    return from < to ? now >= from && now < to : now >= from || now < to;
  }
  /** The chat's own choice for this moment, or null when the chat follows the app-wide scene. */
  function chatBackground(chat) {
    const config = readChatBg(chat.id);
    if (!config) return null;
    const now = nowMinutes();
    const rule = readChatRules(chat.id).find((entry) => ruleActive(entry, now));
    if (!rule || rule.type === 'default') return config;
    if (rule.type === 'solid') return { ...config, type: 'solid' };
    if (rule.type === 'gradient') return { ...config, type: 'gradient' };
    if (rule.type === 'preset') return normalizeBg({ type: 'preset', preset: rule.preset });
    if (rule.type === 'upload') {
      if (!items().some((item) => item.id === rule.upload && item.image)) return config;
      return normalizeBg({ type: 'upload', upload: rule.upload });
    }
    return config;
  }
  function targetOf(bg) {
    if (!bg || bg.type === 'none') return null;
    if (bg.type === 'solid') return { key: `solid:${bg.color}`, css: bg.color };
    if (bg.type === 'gradient') return { key: `gradient:${bg.from}:${bg.to}:${bg.angle}`, css: `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})` };
    if (bg.type === 'preset') {
      const preset = presetById(presetId(bg.preset));
      return preset ? { key: `preset:${preset.id}`, src: presetUrl(preset.id) } : null;
    }
    if (bg.type === 'upload') {
      const item = items().find((entry) => entry.id === bg.upload && entry.image);
      return item ? { key: `upload:${item.id}:${item.image}`, path: `/api/background-image/${encodeURIComponent(item.id)}?v=${item.image}` } : null;
    }
    return null;
  }

  // ---------- the stage layer ----------
  let shownKey = '';
  let pendingKey = '';

  /** The backdrop for a chat's agent from the Hub's scenes (null in a group), or null for none. */
  function resolve(agent) {
    const { settings } = data();
    const own = agent && settings.agents[agent.name];
    let choice = own || settings.default || '';
    if (choice === 'auto') {
      const location = String((agent && agent.status && agent.status.location) || '').toLowerCase();
      const hit = location && sceneItems().find((item) => item.keywords.some((word) => word && location.includes(word.toLowerCase())));
      if (hit) return hit;
      choice = settings.default && settings.default !== 'auto' ? settings.default : '';
    }
    if (!choice || choice === 'none') return null;
    return sceneItems().find((item) => item.id === choice && item.image) || null;
  }

  const STAGE_BACKDROPS = true;

  /** Draws one background layer, dissolving from the one before it. */
  function showLayer(target) {
    const wrap = document.getElementById('bg');
    if (!wrap) return;
    if (!target) {
      wrap.replaceChildren();
      shownKey = '';
      pendingKey = '';
      return;
    }
    if (target.key === shownKey || target.key === pendingKey) return;
    pendingKey = target.key;
    const place = (node) => {
      if (pendingKey !== target.key) return;
      pendingKey = '';
      node.classList.add('bgimg', shownKey ? 'bg-in' : 'bg-first');
      for (const old of wrap.querySelectorAll('.bgimg:not(.bg-out)')) {
        old.classList.add('bg-out');
        setTimeout(() => old.remove(), 900);
      }
      wrap.append(node);
      shownKey = target.key;
    };
    if (target.css) {
      const fill = el('div', 'bgfill');
      fill.style.background = target.css;
      place(fill);
      return;
    }
    if (target.src) {
      const image = el('img');
      image.alt = '';
      image.src = target.src;
      place(image);
      return;
    }
    if (target.path) {
      M()
        .blobUrl(target.path)
        .then((url) => {
          const image = el('img');
          image.alt = '';
          image.src = url;
          place(image);
        })
        .catch(() => {
          if (pendingKey === target.key) pendingKey = '';
        });
    }
  }

  /** Called by the stage whenever the chat, the agent or the choices change. */
  function apply() {
    const stage = document.getElementById('stage');
    const wrap = document.getElementById('bg');
    if (!stage || !wrap) return;
    if (!STAGE_BACKDROPS) {
      stage.classList.remove('has-bg');
      wrap.hidden = true;
      wrap.replaceChildren();
      shownKey = '';
      pendingKey = '';
      return;
    }
    if (!M().state.backgroundsLoaded) {
      M().state.backgroundsLoaded = true;
      M().send({ type: 'backgrounds-list' });
    }
    const chat = M().state.chat;
    const agent = chat && chat.kind === 'direct' ? M().agentOf(chat.agents[0]) : null;
    const own = chat ? chatBackground(chat) : null;
    const scene = own ? null : resolve(agent);
    const target = own
      ? targetOf(own)
      : scene
        ? { key: `scene:${scene.id}:${scene.image}`, path: `/api/background-image/${encodeURIComponent(scene.id)}?v=${scene.image}` }
        : null;
    stage.classList.toggle('has-bg', Boolean(target));
    wrap.hidden = !target;
    showLayer(target);
  }

  // ---------- the Hub tab ----------
  function rerender() {
    if (M().state.view === 'hub' && M().ui.hubTab === 'backgrounds') M().renderHub();
  }

  function select(id) {
    selected = id;
    rerender();
  }

  function render() {
    const Kit = window.MimiKit;
    const wrap = el('div');
    wrap.append(Kit.section(`ฉากหลัง (${sceneItems().length})`, 'ภาพฉาก (ห้องทำงาน คาเฟ่ ห้องนอน ฯลฯ) ที่หน้าแชตแสดงเป็นฉากหลัง · ใส่คำสำคัญแล้วโหมด "อัตโนมัติ" จะเปลี่ยนฉากตามสถานที่ของ agent', [
      button('btn pri', '+ เพิ่มฉากหลัง', () => select('')),
    ]));
    wrap.append(Kit.grid(sceneItems().map((item) => Kit.card({
      title: item.name,
      sub: item.id,
      icon: thumb(item, 's'),
      desc: item.keywords.length ? `คำสำคัญ: ${item.keywords.join(', ')}` : 'ยังไม่มีคำสำคัญ (โหมดอัตโนมัติจะไม่เลือกฉากนี้)',
      onOpen: () => select(item.id),
      actions: [
        { label: 'แก้ไข', onClick: () => select(item.id) },
        { label: 'ลบ', danger: true, onClick: async () => {
          if (!(await Kit.confirmDelete(`ฉาก "${item.name}" (${item.id})`, 'แชตที่ใช้ฉากนี้จะกลับไปใช้ฉากเริ่มต้น'))) return;
          M().send({ type: 'background-delete', id: item.id });
          if (selected === item.id) select(null);
        } },
      ],
    })), 'ยังไม่มีฉากหลัง — กด "+ เพิ่มฉากหลัง"'));
    const use = el('div', 'mk-block');
    use.append(Kit.section('ใช้ฉากไหน', 'เลือกให้ทั้งแอป หรือแยกตาม agent · แต่ละแชตเลือกเองได้อีกที่ ตั้งค่าแชต → หน้าตา', []));
    const grid = el('div', 'mk-grid2 form');
    const settings = data().settings;
    grid.append(M().labelled('ทั้งแอป', choiceSelect(settings.default, false, (choice) => M().send({ type: 'background-select', choice }))));
    for (const agent of M().state.agents) {
      grid.append(M().labelled(M().nameOf(agent.name), choiceSelect(settings.agents[agent.name] || '', true, (choice) => M().send({ type: 'background-select', agent: agent.name, choice }))));
    }
    use.append(grid);
    wrap.append(use);
    if (selected === null) Kit.closeHost('backgrounds');
    else Kit.hostPopup('backgrounds', { title: selected === '' ? 'เพิ่มฉากหลัง' : `ฉาก: ${(sceneItems().find((entry) => entry.id === selected) || {}).name || selected}`, build: () => [editorPanel()], onClose: () => select(null) });
    return wrap;
  }

  function thumb(item, cls) {
    const frame = el('div', `wthumb bgthumb ${cls || ''}`, item.image ? '' : '🌄');
    if (item.image) {
      M()
        .blobUrl(`/api/background-image/${encodeURIComponent(item.id)}?v=${item.image}`)
        .then((url) => {
          const image = el('img');
          image.src = url;
          frame.replaceChildren(image);
        })
        .catch(() => {});
    }
    return frame;
  }

  /** A select of the choices a place can take; `inherit` adds "follow the app-wide choice". */
  function choiceSelect(value, inherit, onChange) {
    const select = el('select');
    const add = (key, label) => {
      const option = el('option', '', label);
      option.value = key;
      select.append(option);
    };
    if (inherit) add('', 'ตามค่าทั้งแอป');
    add('none', 'ไม่มีฉากหลัง');
    add('auto', 'อัตโนมัติ (ตามสถานที่ของ agent)');
    for (const item of sceneItems()) add(item.id, item.name);
    select.value = value && [...select.options].some((option) => option.value === value) ? value : inherit ? '' : 'none';
    select.onchange = () => onChange(select.value);
    return select;
  }

  function editorPanel() {
    const isNew = selected === '';
    const item = sceneItems().find((entry) => entry.id === selected) || { id: '', name: '', keywords: [], image: null };
    const panel = el('div', 'panel form');
    panel.append(el('h3', '', isNew ? 'ฉากใหม่' : item.name));

    const id = M().textInput(item.id, 'เช่น cafe, office');
    const name = M().textInput(item.name, 'เช่น คาเฟ่');
    const keywords = M().textInput(item.keywords.join(', '), 'เช่น คาเฟ่, ร้านกาแฟ (คั่นด้วย ,)');
    const grid = el('div', 'grid2');
    grid.append(M().labelled('รหัสฉาก (a-z 0-9 - _)', id), M().labelled('ชื่อฉาก', name));
    panel.append(grid, M().labelled('คำสำคัญสำหรับโหมดอัตโนมัติ', keywords));

    const actions = el('div', 'row');
    actions.append(
      button('btn primary', 'บันทึก', () => {
        M().send({
          type: 'background-save',
          background: { id: id.value.trim(), name: name.value.trim(), keywords: keywords.value.split(/[,،、]/).map((word) => word.trim()).filter(Boolean) },
          ...(!isNew && id.value.trim() !== item.id ? { renameFrom: item.id } : {}),
        });
        selected = id.value.trim();
      }),
    );
    if (!isNew) {
      actions.append(
        button('btn danger', 'ลบฉาก', async () => {
          if (await window.MimiKit.confirmDelete(`ฉาก "${item.name}" (${item.id})`, 'แชตที่ใช้ฉากนี้จะกลับไปใช้ฉากเริ่มต้น')) {
            M().send({ type: 'background-delete', id: item.id });
            selected = null;
          }
        }),
      );
    }
    panel.append(actions);

    if (!isNew) {
      panel.append(el('h4', '', 'ภาพฉาก'));
      const picture = el('div', 'pic');
      const choose = el('input');
      choose.type = 'file';
      choose.accept = 'image/png,image/jpeg,image/webp,image/gif';
      choose.hidden = true;
      choose.onchange = async () => {
        const file = choose.files[0];
        if (!file) return;
        const response = await M().api(`/api/background-image/${encodeURIComponent(item.id)}`, { method: 'POST', headers: { 'content-type': file.type }, body: file });
        if (!response.ok) M().toast('อัปโหลดรูปไม่สำเร็จ', (await response.json()).error, true);
      };
      const row = el('div', 'row');
      row.append(button('btn', 'เลือกรูป', () => choose.click()));
      if (item.image) {
        row.append(button('btn ghost', 'ลบรูป', () => M().api(`/api/background-image/${encodeURIComponent(item.id)}`, { method: 'DELETE' })));
      }
      picture.append(thumb(item, 'wide'), row, choose);
      panel.append(picture, el('p', 'hint', 'แนะนำภาพแนวนอน (เช่น 1920×1080) ไม่เกิน 12 MB'));
    } else {
      panel.append(el('p', 'hint', 'บันทึกฉากก่อน แล้วจึงใส่รูปได้'));
    }
    return panel;
  }

  // ---------- Chat setting → หน้าตา: this chat's own background ----------
  const chatUploads = (chatId) => items().filter((item) => item.id.startsWith(chatImagePrefix(chatId)) && item.image);

  function chatPanel(chat) {
    if (!M().state.backgroundsLoaded) {
      M().state.backgroundsLoaded = true;
      M().send({ type: 'backgrounds-list' });
    }
    const panel = el('div', 'bgpanel');
    panel.append(
      el('h3', '', 'ฉากหลัง'),
      el('p', 'hint', 'ใช้เฉพาะแชตนี้ · เลือกสีเดียว สีไล่เฉด รูปตัวอย่าง หรืออัปโหลดรูปเอง แล้วตั้งช่วงเวลาให้สลับฉากได้'),
    );

    let config = readChatBg(chat.id) || { ...DEFAULT_BG };
    const preview = el('div', 'bgpreview');
    const previewFill = el('div', 'bgpreview-fill');
    const previewImage = el('img');
    previewImage.alt = '';
    preview.append(previewFill, previewImage);
    panel.append(preview);

    const paintPreview = () => {
      const target = targetOf(config);
      previewImage.hidden = true;
      previewFill.hidden = false;
      previewFill.style.background = '#141618';
      if (!target) return;
      if (target.css) {
        previewFill.style.background = target.css;
        return;
      }
      previewFill.hidden = true;
      previewImage.hidden = false;
      if (target.src) previewImage.src = target.src;
      else if (target.path) {
        M()
          .blobUrl(target.path)
          .then((url) => {
            if (!previewImage.hidden) previewImage.src = url;
          })
          .catch(() => {});
      }
    };

    const modes = el('div', 'seg bgtabs');
    for (const [key, label] of [['solid', 'สีเดียว'], ['gradient', 'ไล่เฉด'], ['preset', 'รูปในแอป'], ['upload', 'อัปโหลด'], ['none', 'ไม่ใช้']]) {
      const node = button(config.type === key ? 'on' : '', label, () => {
        config.type = key;
        save();
      });
      node.dataset.bgmode = key;
      modes.append(node);
    }
    panel.append(modes);

    const solidBox = el('div', 'bgedit');
    const solidColor = el('input');
    solidColor.type = 'color';
    solidColor.value = config.color;
    solidColor.onchange = () => {
      config.color = solidColor.value;
      config.type = 'solid';
      save();
    };
    solidBox.append(M().labelled('สีพื้นหลัง', solidColor));

    const gradientBox = el('div', 'bgedit grid3');
    const fromColor = el('input');
    const toColor = el('input');
    fromColor.type = toColor.type = 'color';
    fromColor.value = config.from;
    toColor.value = config.to;
    const angle = M().textInput(String(config.angle), '135', 'number');
    angle.min = '0';
    angle.max = '360';
    angle.step = '5';
    const gradientChange = () => {
      config.from = fromColor.value;
      config.to = toColor.value;
      config.angle = Math.min(360, Math.max(0, Number(angle.value) || 135));
      config.type = 'gradient';
      save();
    };
    fromColor.onchange = toColor.onchange = angle.onchange = gradientChange;
    gradientBox.append(M().labelled('สีเริ่ม', fromColor), M().labelled('สีจบ', toColor), M().labelled('องศา', angle));

    const presetBox = el('div', 'bgpresets');
    for (const preset of PRESETS) {
      const card = button(config.type === 'preset' && config.preset === preset.id ? 'bgpreset on' : 'bgpreset', null, () => {
        config.type = 'preset';
        config.preset = preset.id;
        save();
      });
      const image = el('img');
      image.src = presetUrl(preset.id);
      image.alt = '';
      image.loading = 'lazy';
      card.append(image, el('span', '', preset.name));
      presetBox.append(card);
    }

    const uploadBox = el('div', 'bguploads');
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
    fileInput.hidden = true;
    const uploadList = el('div', 'bguploadlist');
    const uploadButton = button('btn', 'อัปโหลดรูปจากเครื่อง', () => fileInput.click());
    fileInput.onchange = async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > 12 * 1024 * 1024) return M().toast('รูปใหญ่เกินไป', 'ไม่เกิน 12 MB', true);
      try {
        const response = await M().api(`/api/chat-background?chat=${chat.id}&name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'content-type': file.type || 'image/png' },
          body: file,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        config.type = 'upload';
        config.upload = result.id;
        writeChatBg(chat.id, config);
        apply();
        paintPreview();
        M().send({ type: 'backgrounds-list' });
        // The backgrounds broadcast may have arrived before this response: draw the panel
        // again so the new upload shows as the selected picture.
        if (M().state.view === 'chat') M().renderRail();
        M().toast('อัปโหลดแล้ว ✓');
      } catch (error) {
        M().toast('อัปโหลดไม่สำเร็จ', error.message || String(error), true);
      }
    };
    uploadBox.append(uploadButton, fileInput, el('p', 'hint', 'PNG, JPEG, WebP หรือ GIF ไม่เกิน 12 MB'), uploadList);

    const renderUploads = () => {
      uploadList.replaceChildren();
      const found = chatUploads(chat.id);
      if (found.length === 0) {
        uploadList.append(el('p', 'hint', 'ยังไม่มีรูปที่อัปโหลดในแชตนี้'));
        return;
      }
      for (const item of found) {
        const row = el('div', 'bgupload');
        const pick = button(config.type === 'upload' && config.upload === item.id ? 'bgupload-pick on' : 'bgupload-pick', null, () => {
          config.type = 'upload';
          config.upload = item.id;
          save();
        });
        pick.append(thumb(item, 's'), el('span', '', item.name));
        const del = button('bgupload-del', '✕', async () => {
          if (!(await window.MimiKit.confirmDelete(`รูป "${item.name}"`))) return;
          const rules = readChatRules(chat.id).filter((rule) => rule.upload !== item.id);
          writeChatRules(chat.id, rules);
          if (config.type === 'upload' && config.upload === item.id) {
            config.type = 'none';
            writeChatBg(chat.id, config);
          }
          M().send({ type: 'background-delete', id: item.id });
          apply();
          paintPreview();
          renderUploads();
          renderRules();
          syncModes();
        }, 'ลบรูปนี้');
        row.append(pick, del);
        uploadList.append(row);
      }
    };

    const scheduleBox = el('div', 'bgschedule');
    const ruleList = el('div', 'bgrules');
    scheduleBox.append(
      el('h4', '', 'ตั้งเวลาสลับฉากหลัง'),
      el('p', 'hint', 'เช่น 06:00–18:00 ใช้ห้องทำงาน, 18:00–06:00 ใช้กลางคืน · ถ้าซ้อนกัน รายการแรกที่ตรงเวลาจะถูกใช้'),
      ruleList,
    );

    function save() {
      writeChatBg(chat.id, config);
      apply();
      paintPreview();
      syncModes();
    }
    function syncModes() {
      for (const node of modes.querySelectorAll('[data-bgmode]')) node.classList.toggle('on', node.dataset.bgmode === config.type);
      solidBox.hidden = config.type !== 'solid';
      gradientBox.hidden = config.type !== 'gradient';
      presetBox.hidden = config.type !== 'preset';
      uploadBox.hidden = config.type !== 'upload';
      solidColor.value = config.color;
      fromColor.value = config.from;
      toColor.value = config.to;
      angle.value = String(config.angle);
    }
    function writeRules(rules) {
      writeChatRules(chat.id, rules);
      apply();
    }
    function ruleValue(rule) {
      if (rule.type === 'preset') return `preset:${rule.preset}`;
      if (rule.type === 'upload') return `upload:${rule.upload}`;
      return rule.type;
    }
    function renderRules() {
      ruleList.replaceChildren();
      const rules = readChatRules(chat.id);
      if (rules.length === 0) {
        ruleList.append(el('p', 'hint', 'ยังไม่มีช่วงเวลา — ใช้พื้นหลังหลักตลอด'));
        return;
      }
      const uploads = chatUploads(chat.id);
      for (const rule of rules) {
        const row = el('div', 'bgrule');
        const from = el('input');
        const to = el('input');
        from.type = to.type = 'time';
        from.value = rule.from;
        to.value = rule.to;
        from.onchange = () => {
          rule.from = cleanClock(from.value) || rule.from;
          from.value = rule.from;
          writeRules(rules);
        };
        to.onchange = () => {
          rule.to = cleanClock(to.value) || rule.to;
          to.value = rule.to;
          writeRules(rules);
        };
        const select = el('select');
        const add = (value, label) => {
          const option = el('option', '', label);
          option.value = value;
          select.append(option);
        };
        add('default', 'ตามพื้นหลังหลัก');
        add('solid', 'สีเดียว (ค่าหลัก)');
        add('gradient', 'ไล่เฉด (ค่าหลัก)');
        for (const preset of PRESETS) add(`preset:${preset.id}`, `รูป: ${preset.name}`);
        for (const item of uploads) add(`upload:${item.id}`, `อัปโหลด: ${item.name}`);
        select.value = ruleValue(rule);
        if (!select.value) select.value = 'default';
        select.onchange = () => {
          const [kind, id] = select.value.split(':');
          rule.type = kind;
          if (kind === 'preset') rule.preset = id;
          if (kind === 'upload') rule.upload = id;
          writeRules(rules);
        };
        row.append(from, el('span', 'bgdash', '–'), to, select, button('bgupload-del', '✕', () => {
          writeChatRules(chat.id, readChatRules(chat.id).filter((entry) => entry.id !== rule.id));
          renderRules();
          apply();
        }, 'ลบช่วงเวลานี้'));
        ruleList.append(row);
      }
    }

    scheduleBox.append(button('btn', '+ เพิ่มช่วงเวลา', () => {
      const rules = readChatRules(chat.id);
      rules.push({ id: `rule-${Date.now()}`, from: '18:00', to: '06:00', type: 'default' });
      writeChatRules(chat.id, rules);
      renderRules();
      apply();
    }));

    panel.append(solidBox, gradientBox, presetBox, uploadBox, scheduleBox);
    renderUploads();
    renderRules();
    syncModes();
    paintPreview();
    return panel;
  }

  function onMessage(message) {
    if (message.type !== 'backgrounds') return;
    M().state.backgrounds = { items: message.items || [], settings: message.settings || { default: '', agents: {} } };
    if (message.saved) M().toast('บันทึกแล้ว ✓');
    if (selected && !items().some((entry) => entry.id === selected)) selected = null;
    apply();
    rerender();
    if (M().state.view === 'chat') M().renderRail();
  }

  window.MimiHooks = window.MimiHooks || {};
  // A schedule can start or end while the chat stays open; redraw once in a while.
  setInterval(() => {
    if (M().state.view === 'chat' && M().state.chat) apply();
  }, 30_000);

  window.MimiHooks.backgrounds = { render, onMessage, apply, resolve, choiceSelect, chatPanel, stageEnabled: () => STAGE_BACKDROPS };
})();
