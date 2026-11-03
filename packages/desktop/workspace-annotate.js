// Annotating the page in the Workspace browser: ✎ freezes the page as a snapshot, a canvas
// goes over it, and a floating bar offers select / pen / shape / text. The finished picture
// is copied, saved, or sent to the chat. Marks live in the snapshot's own pixels, so they
// stay put when the window is resized and export at full resolution.
(() => {
  'use strict';
  const api = window.mimiWorkspace;
  const $ = (id) => document.getElementById(id);
  const view = $('view');
  const panel = $('annot');
  const shot = $('annot-shot');
  const canvas = $('annot-canvas');
  const bar = $('annot-bar');
  const toggle = $('annotate');
  const ctx = canvas.getContext('2d');

  const svg = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const ICON = {
    select: svg('<path d="M5 3l14 7-6 2-2 6z"/>'),
    pen: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>'),
    text: svg('<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>'),
    close: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
    undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 010 12h-3"/>'),
    copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1"/>'),
    save: svg('<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 21h16"/>'),
    send: svg('<path d="M4 12l16-8-6 16-3-6.5z"/>'),
    chevron: svg('<path d="M6 9l6 6 6-6"/>'),
    rect: svg('<rect x="4" y="5" width="16" height="14" rx="2"/>'),
    ellipse: svg('<ellipse cx="12" cy="12" rx="9" ry="7"/>'),
    arrow: svg('<path d="M5 19L19 5"/><path d="M9 5h10v10"/>'),
    line: svg('<path d="M5 19L19 5"/>'),
  };
  const SHAPES = [
    { key: 'rect', label: 'สี่เหลี่ยม' },
    { key: 'ellipse', label: 'วงกลม / วงรี' },
    { key: 'arrow', label: 'ลูกศร' },
    { key: 'line', label: 'เส้นตรง' },
  ];

  let on = false;
  let tool = 'pen'; // select | pen | shape | text
  let shape = 'rect';
  let color = '#ff3b30';
  let items = [];
  let selected = null;
  let image = null; // the snapshot as an Image
  let native = { w: 0, h: 0 }; // its size in pixels
  let k = 1; // screen px per snapshot px
  let drawing = null;
  let editor = null;
  let menu = null;
  const buttons = {};

  // ---------- drawing ----------
  function strokeItem(c, item) {
    c.strokeStyle = item.color;
    c.fillStyle = item.color;
    c.lineWidth = item.lw;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    if (item.type === 'pen') {
      c.beginPath();
      item.pts.forEach(([x, y], index) => (index ? c.lineTo(x, y) : c.moveTo(x, y)));
      if (item.pts.length === 1) c.lineTo(item.pts[0][0] + 0.01, item.pts[0][1]);
      c.stroke();
    } else if (item.type === 'rect') {
      c.strokeRect(Math.min(item.x1, item.x2), Math.min(item.y1, item.y2), Math.abs(item.x2 - item.x1), Math.abs(item.y2 - item.y1));
    } else if (item.type === 'ellipse') {
      c.beginPath();
      c.ellipse((item.x1 + item.x2) / 2, (item.y1 + item.y2) / 2, Math.abs(item.x2 - item.x1) / 2, Math.abs(item.y2 - item.y1) / 2, 0, 0, Math.PI * 2);
      c.stroke();
    } else if (item.type === 'line' || item.type === 'arrow') {
      c.beginPath();
      c.moveTo(item.x1, item.y1);
      c.lineTo(item.x2, item.y2);
      c.stroke();
      if (item.type === 'arrow') {
        const angle = Math.atan2(item.y2 - item.y1, item.x2 - item.x1);
        const head = item.lw * 4.5;
        c.beginPath();
        c.moveTo(item.x2, item.y2);
        c.lineTo(item.x2 - head * Math.cos(angle - 0.45), item.y2 - head * Math.sin(angle - 0.45));
        c.moveTo(item.x2, item.y2);
        c.lineTo(item.x2 - head * Math.cos(angle + 0.45), item.y2 - head * Math.sin(angle + 0.45));
        c.stroke();
      }
    } else if (item.type === 'text') {
      c.font = `600 ${item.size}px "Segoe UI", "Leelawadee UI", "Noto Sans Thai", system-ui, sans-serif`;
      c.textBaseline = 'top';
      c.lineJoin = 'round';
      item.text.split('\n').forEach((line, index) => {
        const y = item.y + index * item.size * 1.25;
        c.strokeStyle = 'rgba(255,255,255,.9)';
        c.lineWidth = item.size / 7;
        c.strokeText(line, item.x, y);
        c.fillText(line, item.x, y);
      });
    }
  }
  function bounds(item) {
    if (item.type === 'pen') {
      const xs = item.pts.map((p) => p[0]);
      const ys = item.pts.map((p) => p[1]);
      return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    }
    if (item.type === 'text') {
      ctx.font = `600 ${item.size}px system-ui, sans-serif`;
      const lines = item.text.split('\n');
      const width = Math.max(...lines.map((line) => ctx.measureText(line).width));
      return { x1: item.x, y1: item.y, x2: item.x + width, y2: item.y + lines.length * item.size * 1.25 };
    }
    return { x1: Math.min(item.x1, item.x2), y1: Math.min(item.y1, item.y2), x2: Math.max(item.x1, item.x2), y2: Math.max(item.y1, item.y2) };
  }
  function paint() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr * k, 0, 0, dpr * k, 0, 0);
    ctx.clearRect(0, 0, native.w, native.h);
    for (const item of items) strokeItem(ctx, item);
    if (drawing) strokeItem(ctx, drawing);
    if (selected && items.includes(selected)) {
      const box = bounds(selected);
      const pad = 6 / k;
      ctx.save();
      ctx.setLineDash([6 / k, 4 / k]);
      ctx.strokeStyle = '#4da3ff';
      ctx.lineWidth = 1.5 / k;
      ctx.strokeRect(box.x1 - pad, box.y1 - pad, box.x2 - box.x1 + pad * 2, box.y2 - box.y1 + pad * 2);
      ctx.restore();
    }
  }
  /** Fits the snapshot inside the pane and lays the canvas exactly over it. */
  function layout() {
    if (!image) return;
    const room = panel.getBoundingClientRect();
    k = Math.min(room.width / native.w, room.height / native.h);
    const width = Math.round(native.w * k);
    const height = Math.round(native.h * k);
    const dpr = window.devicePixelRatio || 1;
    for (const node of [shot, canvas]) {
      node.style.width = `${width}px`;
      node.style.height = `${height}px`;
    }
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    paint();
  }
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) / k, (event.clientY - rect.top) / k];
  };

  // ---------- picking marks ----------
  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function hit(item, x, y) {
    const slop = Math.max(8 / k, item.lw || 0);
    if (item.type === 'pen') {
      for (let i = 1; i < item.pts.length; i++) if (distToSegment(x, y, item.pts[i - 1][0], item.pts[i - 1][1], item.pts[i][0], item.pts[i][1]) <= slop) return true;
      return item.pts.length === 1 && Math.hypot(x - item.pts[0][0], y - item.pts[0][1]) <= slop;
    }
    if (item.type === 'line' || item.type === 'arrow') return distToSegment(x, y, item.x1, item.y1, item.x2, item.y2) <= slop;
    const box = bounds(item);
    const inside = x >= box.x1 - slop && x <= box.x2 + slop && y >= box.y1 - slop && y <= box.y2 + slop;
    if (item.type === 'text') return inside;
    // A frame is picked by its edge, so a mark inside it can still be reached.
    const deep = x > box.x1 + slop && x < box.x2 - slop && y > box.y1 + slop && y < box.y2 - slop;
    return inside && !deep;
  }
  function move(item, dx, dy) {
    if (item.type === 'pen') item.pts = item.pts.map(([x, y]) => [x + dx, y + dy]);
    else if (item.type === 'text') {
      item.x += dx;
      item.y += dy;
    } else {
      item.x1 += dx;
      item.x2 += dx;
      item.y1 += dy;
      item.y2 += dy;
    }
  }

  // ---------- text ----------
  function commitText() {
    if (!editor) return;
    const { node, x, y, size, ink } = editor;
    editor = null;
    const text = node.value.replace(/\s+$/g, '');
    node.remove();
    if (text.trim()) items.push({ type: 'text', x, y, size, color: ink, text });
    paint();
  }
  function startText(x, y) {
    commitText();
    const size = Math.round(20 / k);
    const node = document.createElement('textarea');
    node.className = 'annot-text';
    node.rows = 1;
    node.style.color = color;
    node.style.fontSize = `${20}px`;
    const rect = canvas.getBoundingClientRect();
    const host = panel.getBoundingClientRect();
    node.style.left = `${rect.left - host.left + x * k}px`;
    node.style.top = `${rect.top - host.top + y * k}px`;
    node.placeholder = 'พิมพ์ข้อความ';
    node.addEventListener('input', () => {
      node.rows = node.value.split('\n').length;
      node.style.width = `${Math.max(80, Math.max(...node.value.split('\n').map((line) => line.length)) * 12 + 16)}px`;
    });
    node.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
        event.preventDefault();
        commitText();
      }
    });
    node.addEventListener('blur', () => setTimeout(commitText, 0));
    panel.append(node);
    editor = { node, x, y, size, ink: color };
    node.focus();
  }

  // ---------- pointer ----------
  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    closeMenu();
    const [x, y] = point(event);
    if (editor) {
      commitText();
      if (tool === 'text') return;
    }
    if (tool === 'text') return startText(x, y);
    canvas.setPointerCapture(event.pointerId);
    const lw = 4 / k;
    if (tool === 'select') {
      selected = [...items].reverse().find((item) => hit(item, x, y)) || null;
      drawing = selected ? { drag: true, x, y } : null;
      paint();
      syncButtons();
      return;
    }
    selected = null;
    drawing = tool === 'pen' ? { type: 'pen', pts: [[x, y]], color, lw } : { type: shape, x1: x, y1: y, x2: x, y2: y, color, lw };
    paint();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    const [x, y] = point(event);
    if (drawing.drag) {
      move(selected, x - drawing.x, y - drawing.y);
      drawing.x = x;
      drawing.y = y;
    } else if (drawing.type === 'pen') drawing.pts.push([x, y]);
    else {
      drawing.x2 = x;
      drawing.y2 = y;
    }
    paint();
  });
  const release = (cancel) => {
    if (!drawing) return;
    const done = drawing;
    drawing = null;
    if (!done.drag && !cancel) {
      const tiny = done.type !== 'pen' && Math.hypot(done.x2 - done.x1, done.y2 - done.y1) < 4 / k;
      if (!tiny) items.push(done);
    }
    paint();
    syncButtons();
  };
  canvas.addEventListener('pointerup', () => release(false));
  canvas.addEventListener('pointercancel', () => release(true));

  // ---------- toolbar ----------
  function closeMenu() {
    if (menu) menu.remove();
    menu = null;
  }
  function openMenu() {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'annot-menu';
    const anchor = buttons.shape.getBoundingClientRect();
    const host = panel.getBoundingClientRect();
    menu.style.left = `${anchor.left - host.left}px`;
    for (const entry of SHAPES) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = entry.key === shape ? 'on' : '';
      item.innerHTML = `${ICON[entry.key]}<span>${entry.label}</span>`;
      item.onclick = (event) => {
        event.stopPropagation();
        shape = entry.key;
        closeMenu();
        setTool('shape');
      };
      menu.append(item);
    }
    panel.append(menu);
  }
  function setTool(next) {
    commitText();
    tool = next;
    if (tool !== 'select') selected = null;
    panel.className = `annot tool-${tool}`;
    syncButtons();
    paint();
  }
  function syncButtons() {
    for (const key of ['select', 'pen', 'shape', 'text']) buttons[key].classList.toggle('on', tool === key);
    buttons.shape.firstChild.innerHTML = ICON[shape];
    buttons.undo.disabled = items.length === 0;
  }
  function tb(key, html, title, onClick, className = '') {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.innerHTML = html;
    node.title = title;
    node.onclick = onClick;
    buttons[key] = node;
    bar.append(node);
    return node;
  }
  function buildBar() {
    bar.replaceChildren();
    tb('select', ICON.select, 'เลือก / ย้ายเครื่องหมาย (Delete = ลบ)', () => setTool('select'));
    tb('pen', ICON.pen, 'ปากกา', () => setTool('pen'));
    const shapeButton = tb('shape', `<span>${ICON.rect}</span>${ICON.chevron}`, 'รูปทรง', (event) => {
      event.stopPropagation();
      if (tool === 'shape' && !menu) openMenu();
      else if (menu) closeMenu();
      else {
        setTool('shape');
        openMenu();
      }
    }, 'wide');
    shapeButton.style.gap = '1px';
    shapeButton.style.gridAutoFlow = 'column';
    shapeButton.querySelector(':scope > svg').style.width = '12px';
    tb('text', ICON.text, 'ข้อความ', () => setTool('text'));
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.title = 'สี';
    swatch.style.setProperty('--c', color);
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = color;
    picker.oninput = () => {
      color = picker.value;
      swatch.style.setProperty('--c', color);
    };
    swatch.append(picker);
    bar.append(swatch);
    tb('undo', ICON.undo, 'ย้อนกลับ (Ctrl+Z)', undo);
    const sep = document.createElement('span');
    sep.className = 'sep';
    bar.append(sep);
    tb('copy', `${ICON.copy}<span>คัดลอก</span>`, 'คัดลอกภาพไปที่ clipboard', () => output('copy'), 'act');
    tb('save', `${ICON.save}<span>บันทึก</span>`, 'บันทึกเป็นไฟล์ PNG', () => output('save'), 'act');
    tb('send', `${ICON.send}<span>ส่งเข้าแชต</span>`, 'ส่งภาพนี้เข้าแชต Mimi', () => output('send'), 'act pri');
    const sep2 = document.createElement('span');
    sep2.className = 'sep';
    bar.append(sep2);
    tb('close', ICON.close, 'ปิด (Esc)', () => leave());
  }
  function undo() {
    commitText();
    items.pop();
    selected = null;
    paint();
    syncButtons();
  }

  // ---------- output ----------
  /** The snapshot with the marks on it, as base64 PNG, at the snapshot's own resolution. */
  function render() {
    commitText();
    const out = document.createElement('canvas');
    out.width = native.w;
    out.height = native.h;
    const c = out.getContext('2d');
    c.drawImage(image, 0, 0);
    for (const item of items) strokeItem(c, item);
    return out.toDataURL('image/png').split(',')[1];
  }
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  function flash(node, text) {
    const label = node.querySelector('span');
    const before = label.textContent;
    label.textContent = text;
    setTimeout(() => (label.textContent = before), 1600);
  }
  async function output(kind) {
    if (!image) return;
    const node = buttons[kind];
    const png = render();
    const name = `page-${stamp()}.png`;
    node.disabled = true;
    try {
      if (kind === 'copy') flash(node, (await api.annotCopy(png)) ? '✓ คัดลอกแล้ว' : 'ไม่สำเร็จ');
      else if (kind === 'save') {
        const file = await api.annotSave(png, name);
        if (file) flash(node, '✓ บันทึกแล้ว');
      } else if (await api.annotSend(png, name)) leave();
      else flash(node, 'ส่งไม่ได้');
    } finally {
      node.disabled = false;
    }
  }

  // ---------- on / off ----------
  async function enter() {
    if (on) return;
    let current = '';
    try {
      current = view.getURL();
    } catch {
      // not ready
    }
    if (!current || current === 'about:blank') return;
    let snap = null;
    try {
      snap = await api.capture(view.getWebContentsId());
    } catch {
      // the page is not ready
    }
    if (!snap) return;
    image = new Image();
    await new Promise((resolve) => {
      image.onload = resolve;
      image.onerror = resolve;
      image.src = `data:image/png;base64,${snap.png}`;
    });
    native = { w: image.naturalWidth || snap.width, h: image.naturalHeight || snap.height };
    shot.src = image.src;
    items = [];
    selected = null;
    on = true;
    toggle.classList.add('on');
    panel.hidden = false;
    buildBar();
    setTool('pen');
    layout();
  }
  function leave() {
    if (!on) return;
    commitText();
    closeMenu();
    on = false;
    panel.hidden = true;
    toggle.classList.remove('on');
    items = [];
    image = null;
    shot.removeAttribute('src');
  }
  toggle.addEventListener('click', () => (on ? leave() : void enter()));
  window.addEventListener('resize', () => on && layout());
  if (window.ResizeObserver) new ResizeObserver(() => on && layout()).observe(panel);
  document.addEventListener('click', (event) => {
    if (menu && !event.target.closest('.annot-menu')) closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (!on || editor) return;
    if (event.target instanceof Element && event.target.closest('input, textarea')) return;
    if (event.key === 'Escape') {
      if (menu) closeMenu();
      else leave();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
      items = items.filter((item) => item !== selected);
      selected = null;
      paint();
      syncButtons();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undo();
    }
  });
})();
