// The character card behind a direct chat, visual-novel style. The picture is picked from
// the last emoji the agent wrote:
//   1. the emoji picture of the outfit it wears (status "outfit" = a wardrobe id)
//   2. the agent's own picture for the emoji
//   3. that outfit's own (static) picture
//   4. the agent's full-body portrait
//   5. any outfit or agent emoji picture, so a set of sprites alone still shows
//   6. the small avatar, so even a profile picture alone is not a blank stage
// A picture that fails to load is skipped for the next one in that order, and an agent shown
// in 3D keeps its 2D picture while the model loads or when the model cannot be shown.
// When the picture changes it fades in with a small hop (a new outfit slides in); the figure
// breathes slowly while idle. Also exports the editor used for the emoji pictures of an
// outfit or an agent.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const PICTOGRAPH = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣)/u;
  const QUICK = ['😊', '😄', '😂', '🥰', '😍', '😉', '😳', '😮', '🤔', '😅', '😢', '😭', '😠', '😴', '🥺', '❤️'];

  /** Code points in hex without the emoji selector: the key the core files the picture under. */
  function emojiKey(grapheme) {
    return Array.from(grapheme)
      .map((char) => char.codePointAt(0).toString(16))
      .filter((hex) => hex !== 'fe0f')
      .join('-');
  }

  function keyToEmoji(key) {
    return key
      .split('-')
      .map((hex) => String.fromCodePoint(parseInt(hex, 16)))
      .join('');
  }

  function graphemes(text) {
    if (segmenter) return [...segmenter.segment(text)].map((part) => part.segment);
    return Array.from(text);
  }

  /** Key of the last emoji in `text`, or null. */
  function lastEmojiKey(text) {
    let last = null;
    for (const grapheme of graphemes(String(text || ''))) if (PICTOGRAPH.test(grapheme)) last = grapheme;
    return last ? emojiKey(last) : null;
  }

  // ---------- the figure ----------
  let moodKey = null; // last emoji of the newest reply in this chat
  let shown = { path: '', outfit: '' }; // what the figure shows now
  let shownAgent = ''; // whose picture is on the stage, so a chat switch never keeps the old one
  let pending = '';
  let retries = 0; // failed loads of the current picture
  const broken = new Set(); // pictures that failed to load: the next one in line is shown instead

  const directAgent = () => {
    const chat = M().state.chat;
    return chat && chat.kind === 'direct' ? M().agentOf(chat.agents[0]) : null;
  };
  const wardrobe = () => M().state.wardrobe || [];

  /** The VRM to show: the model of the outfit the agent wears, else the agent's own; null without one. */
  function modelPath(agent) {
    const outfit = wardrobe().find((item) => item.id === ((agent.status && agent.status.outfit) || ''));
    if (outfit && outfit.model) return `/api/wardrobe-model/${encodeURIComponent(outfit.id)}?v=${outfit.model}`;
    if (agent.model) return `/api/agent-model/${encodeURIComponent(agent.name)}?v=${agent.model}`;
    return null;
  }

  /** Every picture this agent could show, best first, as { path, outfit }. */
  function candidates(agent) {
    const outfitId = (agent.status && agent.status.outfit) || '';
    const outfit = wardrobe().find((item) => item.id === outfitId);
    const own = agent.sprites || {};
    const enc = encodeURIComponent;
    const worn = outfit ? outfit.id : '';
    const list = [];
    if (outfit && moodKey && outfit.sprites && outfit.sprites[moodKey]) {
      list.push({ path: `/api/sprite/outfit/${enc(outfit.id)}/${moodKey}?v=${outfit.sprites[moodKey]}`, outfit: outfit.id });
    }
    // The agent's own emoji picture wins over the outfit's static picture: a sprite the user
    // uploaded for this emoji should show even while an outfit with a picture is worn.
    if (moodKey && own[moodKey]) list.push({ path: `/api/sprite/agent/${enc(agent.name)}/${moodKey}?v=${own[moodKey]}`, outfit: worn });
    if (outfit && outfit.image) list.push({ path: `/api/wardrobe-image/${enc(outfit.id)}?v=${outfit.image}`, outfit: outfit.id });
    if (agent.portrait) list.push({ path: `/api/agent-image/${enc(agent.name)}/portrait?v=${agent.portrait}`, outfit: worn });
    // An agent with only expression pictures keeps a face even when the newest emoji has none.
    for (const key of outfit && outfit.sprites ? Object.keys(outfit.sprites) : []) {
      list.push({ path: `/api/sprite/outfit/${enc(outfit.id)}/${key}?v=${outfit.sprites[key]}`, outfit: outfit.id });
    }
    for (const key of Object.keys(own)) list.push({ path: `/api/sprite/agent/${enc(agent.name)}/${key}?v=${own[key]}`, outfit: worn });
    if (agent.avatar) list.push({ path: `/api/agent-image/${enc(agent.name)}/avatar?v=${agent.avatar}`, outfit: worn });
    return list;
  }

  /** Which picture to show for this agent, as { path, outfit } or null: the best one that loads. */
  function pick(agent) {
    return candidates(agent).find((item) => !broken.has(item.path)) || null;
  }

  // ---------- where the character stands ----------
  // 3D: the camera (turn, tilt, zoom, slide). 2D: size and slide of the picture. Remembered per
  // agent, per kind and per mode, because the mobile and the desktop stage are not the same shape.
  const DEFAULT_VIEW = { '3d': { yaw: 0, pitch: 0, zoom: 1, x: 0, y: 0 }, '2d': { zoom: 1, x: 0, y: 0 } };
  let kind = null; // '3d' | '2d' | null: what the stage shows now
  const viewKey = (agent) => `mimi.view.${document.documentElement.dataset.mode}.${agent.name}.${kind}`;
  function loadView(agent) {
    try {
      return { ...DEFAULT_VIEW[kind], ...JSON.parse(M().store.get(viewKey(agent)) || '{}') };
    } catch {
      return { ...DEFAULT_VIEW[kind] };
    }
  }
  function applyView(agent) {
    const wrap = document.getElementById('figure');
    if (!agent || !kind) return;
    const view = loadView(agent);
    if (kind === '3d') {
      window.MimiHooks.vrmStage?.setView(view);
      for (const name of ['--vx', '--vy', '--vs']) wrap.style.removeProperty(name);
    } else {
      wrap.style.setProperty('--vx', `${view.x}%`);
      wrap.style.setProperty('--vy', `${-view.y}%`);
      wrap.style.setProperty('--vs', String(view.zoom));
    }
  }

  /** The sliders for Chat setting; null when no character is on the stage. */
  function viewControls() {
    const agent = M().characterOn() ? directAgent() : null;
    if (!agent || !kind) return null;
    const box = el('div', 'viewctl');
    box.append(el('h3', '', t(kind === '3d' ? 'view.title3d' : 'view.title2d')));
    const rows =
      kind === '3d'
        ? [['view.yaw', 'yaw', -180, 180, 1, '°'], ['view.pitch', 'pitch', -89, 89, 1, '°'], ['view.zoom', 'zoom', 0.1, 10, 0.05, '×'], ['view.x', 'x', -300, 300, 1, '%'], ['view.y', 'y', -300, 300, 1, '%']]
        : [['view.size', 'zoom', 0.1, 10, 0.05, '×'], ['view.x', 'x', -300, 300, 1, '%'], ['view.y', 'y', -300, 300, 1, '%']];
    const view = loadView(agent);
    const peek = (on) => document.getElementById('rail')?.classList.toggle('peek', on);
    const inputs = [];
    // The slider covers a wide range; the number box beside it takes any value (no limit).
    for (const [label, key, min, max, step, unit] of rows) {
      const line = el('label', 'viewrow');
      const shown = el('span', 'v');
      const number = el('input');
      number.type = 'number';
      number.step = String(step);
      number.inputMode = 'decimal';
      shown.append(number, el('small', '', unit));
      const slider = el('input');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = String(step);
      slider.value = String(view[key]);
      const show = () => {
        number.value = key === 'zoom' ? Number(view[key]).toFixed(2) : String(Math.round(Number(view[key])));
      };
      show();
      const set = (value) => {
        view[key] = value;
        M().store.set(viewKey(agent), JSON.stringify(view));
        applyView(agent);
      };
      slider.oninput = () => {
        set(Number(slider.value));
        show();
      };
      number.oninput = () => {
        const value = Number(number.value);
        if (number.value === '' || !Number.isFinite(value) || (key === 'zoom' && value <= 0)) return;
        slider.value = String(value);
        set(value);
      };
      number.onblur = show;
      // While a slider is held the panel fades, so the character can be seen behind it.
      slider.addEventListener('pointerdown', () => peek(true));
      for (const type of ['pointerup', 'pointercancel', 'change', 'blur']) slider.addEventListener(type, () => peek(false));
      inputs.push([key, slider, show]);
      line.append(el('span', 'l', t(label)), slider, shown);
      box.append(line);
    }
    box.append(
      button('btn ghost', t('view.reset'), () => {
        const fresh = { ...DEFAULT_VIEW[kind] };
        M().store.set(viewKey(agent), JSON.stringify(fresh));
        for (const [key, slider] of inputs) {
          view[key] = fresh[key];
          slider.value = String(fresh[key]);
        }
        for (const [, , show] of inputs) show();
        applyView(agent);
      }),
    );
    return box;
  }

  function refresh() {
    const stage = document.getElementById('stage');
    const wrap = document.getElementById('figure');
    if (!stage || !wrap) return;
    if (!M().state.wardrobeLoaded) {
      M().state.wardrobeLoaded = true;
      M().send({ type: 'wardrobe-list' });
    }
    window.MimiHooks.backgrounds?.apply();
    window.MimiHooks.gallery?.apply();
    const agent = M().characterOn() ? directAgent() : null;
    // An agent shown as a 3D model: the VRM of the outfit it wears, else its own (feature-vrm.js).
    const live = window.MimiHooks.vrmStage;
    const model = agent && agent.character === 'vrm' && live ? modelPath(agent) : null;
    const modelState = model ? live.state(model) : 'none';
    if (modelState === 'ready') {
      stage.classList.add('has-figure');
      wrap.hidden = false;
      for (const old of wrap.querySelectorAll('img.fig')) old.remove();
      shown = { path: '', outfit: '' };
      shownAgent = agent.name;
      pending = '';
      live.show(wrap, model, moodKey);
      kind = '3d';
      applyView(agent);
      return;
    }
    // A model on its way: the 2D picture below stands in until it is on screen
    // (feature-vrm.js refreshes the stage then). A model that failed to load is left out.
    if (modelState === 'loading') live.show(wrap, model, moodKey);
    else live?.hide();
    const target = agent && pick(agent);
    // A missing picture for the newest emoji is not a reason to blank the stage: keep the
    // last picture of this same agent until a real one is available or the chat changes.
    const keepShown = !target && agent && shown.path && shownAgent === agent.name;
    stage.classList.toggle('has-figure', Boolean(target) || Boolean(keepShown));
    wrap.hidden = !target && !keepShown;
    if (!target) {
      pending = '';
      if (keepShown) {
        kind = '2d';
        applyView(agent);
        return;
      }
      kind = null;
      for (const old of wrap.querySelectorAll('img.fig')) old.remove();
      shown = { path: '', outfit: '' };
      shownAgent = '';
      return;
    }
    kind = '2d';
    applyView(agent);
    if (target.path === shown.path || target.path === pending) return;
    pending = target.path;
    const image = el('img');
    image.alt = '';
    M()
      .blobUrl(target.path)
      .then((url) => {
        image.src = url;
        // A file the browser cannot draw counts as a failed load, not as an empty stage.
        return image.decode();
      })
      .then(() => {
        if (pending !== target.path) return; // a newer picture was asked for meanwhile
        pending = '';
        const kind = shown.path && shown.outfit !== target.outfit ? 'outfit' : shown.path ? 'face' : 'first';
        image.className = `fig in-${kind}`;
        for (const old of wrap.querySelectorAll('img.fig:not(.leaving)')) {
          old.classList.add('leaving');
          setTimeout(() => old.remove(), 460);
        }
        wrap.append(image);
        shown = { path: target.path, outfit: target.outfit };
        shownAgent = agent.name;
        retries = 0;
      })
      .catch(() => {
        if (pending !== target.path) return;
        pending = '';
        // The next picture in line shows at once. The failed one (the app may still have been
        // starting) is tried again a few times before it is given up for this chat.
        broken.add(target.path);
        if (retries++ < 3) {
          setTimeout(() => {
            broken.delete(target.path);
            refresh();
          }, 2000);
        }
        refresh();
      });
  }

  /** The emoji of the newest reply in the chat that was just opened. */
  function reset(messages) {
    moodKey = null;
    const agent = directAgent();
    if (agent) {
      for (let index = messages.length - 1; index >= 0 && !moodKey; index--) {
        const message = messages[index];
        if (message.role === 'assistant' && message.agent === agent.name) moodKey = lastEmojiKey(message.text);
      }
    }
    shown = { path: '', outfit: '' };
    shownAgent = '';
    pending = '';
    retries = 0;
    broken.clear();
    const wrap = document.getElementById('figure');
    if (wrap) for (const old of wrap.querySelectorAll('img.fig')) old.remove();
    refresh();
  }

  /** The reply that is streaming in: its last emoji so far drives the picture. */
  function onText(text) {
    window.MimiHooks.vrmStage?.talk();
    const key = lastEmojiKey(text);
    if (key && key !== moodKey) {
      moodKey = key;
      refresh();
    }
  }

  // ---------- editor for a set of emoji pictures ----------
  /**
   * `scope` is "outfit" or "agent"; `id` the outfit id or agent name; `sprites` the
   * current key -> version map (kept up to date here after each change).
   */
  function spriteEditor(scope, id, sprites) {
    const box = el('div', 'sprites');
    const known = { ...sprites };
    const url = (key) => `/api/sprite/${scope}/${encodeURIComponent(id)}/${key}`;

    const grid = el('div', 'spgrid');
    function drawGrid() {
      const keys = Object.keys(known).sort();
      grid.replaceChildren();
      if (keys.length === 0) grid.append(el('p', 'hint', 'ยังไม่มีรูปตามอีโมจิ'));
      for (const key of keys) {
        const tile = el('div', 'sptile');
        const frame = el('div', 'spimg');
        M()
          .blobUrl(`${url(key)}?v=${known[key]}`)
          .then((src) => {
            const image = el('img');
            image.src = src;
            frame.replaceChildren(image);
          })
          .catch(() => {});
        tile.append(
          frame,
          el('span', 'spemoji', keyToEmoji(key)),
          button('btn ghost spdel', '×', async () => {
            await M().api(url(key), { method: 'DELETE' });
            delete known[key];
            drawGrid();
            window.MimiHooks.stage?.refresh();
          }, 'ลบรูปนี้'),
        );
        grid.append(tile);
      }
    }
    drawGrid();

    const emoji = M().textInput('', 'พิมพ์หรือวางอีโมจิ เช่น 😊');
    emoji.className = 'spinput';
    const choose = el('input');
    choose.type = 'file';
    choose.accept = 'image/png,image/jpeg,image/webp,image/gif';
    choose.multiple = false;
    choose.hidden = true;
    choose.onchange = async () => {
      const file = choose.files[0];
      choose.value = '';
      const key = lastEmojiKey(emoji.value);
      if (!file) return;
      if (!key) return M().toast('ใส่อีโมจิก่อน', 'พิมพ์หรือแตะอีโมจิที่ต้องการให้ใช้รูปนี้', true);
      const response = await M().api(url(key), { method: 'POST', headers: { 'content-type': file.type }, body: file });
      if (!response.ok) return M().toast('อัปโหลดรูปไม่สำเร็จ', (await response.json()).error, true);
      known[key] = String(Date.now());
      drawGrid();
      // The server also broadcasts the new agent list; refresh now so the stage updates at once.
      window.MimiHooks.stage?.refresh();
      M().toast('เพิ่มรูปแล้ว ✓', keyToEmoji(key));
    };

    const quick = el('div', 'spquick');
    for (const item of QUICK) {
      quick.append(
        button('btn ghost', item, () => {
          emoji.value = item;
        }),
      );
    }
    const row = el('div', 'hstack');
    row.append(emoji, button('btn', 'เลือกรูปให้อีโมจินี้', () => choose.click()), choose);
    box.append(grid, quick, row);
    return box;
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.stage = { refresh, reset, onText, spriteEditor, lastEmojiKey, emojiKey, keyToEmoji, viewControls };
})();
