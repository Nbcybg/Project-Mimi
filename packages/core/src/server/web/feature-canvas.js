// The workflow canvas: nodes as boxes you drag, links as curves you draw by dragging
// from an output port to another node (or to empty space to add a node there), pan
// by dragging the background, zoom with the wheel or the buttons. No libraries: DOM
// boxes for nodes, one SVG layer for the links. The workflow draft is edited in place;
// the editor (feature-workflows.js) owns saving and the side panel.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const SVG = 'http://www.w3.org/2000/svg';

  const W = 210;
  const HEAD = 46;
  const ROW = 22;
  const COLUMN = 270;

  /** Pan / zoom per workflow, so a re-render keeps the view where it was. */
  const views = new Map();

  const heightOf = (outputs) => HEAD + Math.max(1, outputs.length) * ROW + 6;

  /** Columns by longest path from the starts; rows ordered by their parents (one barycenter pass). */
  function autoLayout(nodes, outputsOf, onlyMissing) {
    const parents = new Map(nodes.map((node) => [node.id, []]));
    for (const node of nodes) {
      for (const targets of Object.values(node.links || {})) for (const target of targets) parents.get(target)?.push(node.id);
    }
    const level = new Map();
    const visit = (id, seen = new Set()) => {
      if (level.has(id)) return level.get(id);
      if (seen.has(id)) return 0;
      seen.add(id);
      const value = Math.max(-1, ...(parents.get(id) || []).map((parent) => visit(parent, seen))) + 1;
      level.set(id, value);
      return value;
    };
    for (const node of nodes) visit(node.id);
    const columns = [];
    for (const node of nodes) (columns[level.get(node.id)] ??= []).push(node);
    const rowOf = new Map();
    columns.forEach((column, index) => {
      if (index > 0) {
        const score = (node) => {
          const rows = (parents.get(node.id) || []).map((parent) => rowOf.get(parent)).filter((row) => row !== undefined);
          return rows.length ? rows.reduce((sum, row) => sum + row, 0) / rows.length : 0;
        };
        column.sort((a, b) => score(a) - score(b));
      }
      let y = 60;
      column.forEach((node, row) => {
        rowOf.set(node.id, row);
        if (!onlyMissing || !Array.isArray(node.position)) node.position = [320 + index * COLUMN, y];
        y += heightOf(outputsOf(node)) + 46;
      });
    });
  }

  function curve(x1, y1, x2, y2) {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  /**
   * Mounts the canvas into `host`. `ctx` gives the draft and the editor's hooks:
   * nodes(), outputsOf(node), titleOf(id), typeLabel(type), groupOf(type),
   * run (last run result or null), selected, onSelect(id), onChange(), addNodeAt(type, pos, from),
   * removeNode(id), palette(anchor, onPick) for the link-to-empty popover, notes() (the
   * sticky notes array, edited in place), undo(), redo().
   */
  function mount(host, ctx) {
    host.classList.add('wcv');
    host.tabIndex = 0;
    host.textContent = '';
    const world = el('div', 'wcv-world');
    const svg = document.createElementNS(SVG, 'svg');
    svg.classList.add('wcv-edges');
    world.append(svg);
    host.append(world);
    const toolbar = el('div', 'wcv-tools');
    host.append(toolbar);

    const nodes = ctx.nodes();
    autoLayout(nodes, ctx.outputsOf, true);
    const view = views.get(ctx.key) || null;
    const state = { x: view?.x ?? 0, y: view?.y ?? 0, z: view?.z ?? 1, selected: ctx.selected || null, edge: null };
    const boxes = new Map();
    const noteBoxes = [];
    const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink'];

    const apply = () => {
      world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.z})`;
      views.set(ctx.key, { x: state.x, y: state.y, z: state.z });
    };
    const toWorld = (clientX, clientY) => {
      const rect = host.getBoundingClientRect();
      return [(clientX - rect.left - state.x) / state.z, (clientY - rect.top - state.y) / state.z];
    };

    const runOf = (id) => ctx.run?.nodes?.find((entry) => entry.id === id);

    /** Sticky notes: under the nodes, dragged by their strip, text edited in place. */
    function drawNotes() {
      for (const box of noteBoxes.splice(0)) box.remove();
      for (const note of ctx.notes?.() ?? []) {
        const box = el('div', `wcv-note c-${NOTE_COLORS.includes(note.color) ? note.color : 'yellow'}`);
        box.dataset.note = note.id;
        box.style.left = `${note.position[0]}px`;
        box.style.top = `${note.position[1]}px`;
        box.style.width = `${note.width || 220}px`;
        box.style.height = `${note.height || 130}px`;
        const strip = el('div', 'wcv-note-head');
        const color = el('button', 'wcv-note-btn', '●');
        color.type = 'button';
        color.title = 'เปลี่ยนสี';
        color.onclick = () => {
          note.color = NOTE_COLORS[(NOTE_COLORS.indexOf(note.color) + 1) % NOTE_COLORS.length];
          drawNotes();
          ctx.onChange();
        };
        const remove = el('button', 'wcv-note-btn', '✕');
        remove.type = 'button';
        remove.title = 'ลบโน้ต';
        remove.onclick = () => {
          const list = ctx.notes();
          list.splice(list.indexOf(note), 1);
          drawNotes();
          ctx.onChange();
        };
        strip.append(color, remove);
        const text = el('textarea');
        text.value = note.text;
        text.placeholder = 'โน้ต…';
        text.oninput = () => {
          note.text = text.value;
        };
        text.onchange = () => ctx.onChange();
        box.onpointerup = () => {
          // The corner handle resizes the box; keep the size.
          if (box.offsetWidth !== (note.width || 220) || box.offsetHeight !== (note.height || 130)) {
            note.width = box.offsetWidth;
            note.height = box.offsetHeight;
            ctx.onChange();
          }
        };
        box.append(strip, text);
        world.insertBefore(box, svg.nextSibling);
        noteBoxes.push(box);
      }
    }

    function drawNodes() {
      for (const box of boxes.values()) box.remove();
      boxes.clear();
      for (const node of nodes) {
        const outputs = ctx.outputsOf(node);
        const run = runOf(node.id);
        const trigger = String(node.type).startsWith('trigger_');
        const box = el('div', `wcv-node${trigger ? ' wcv-trigger' : ` g-${ctx.groupOf(node.type)}`}${state.selected === node.id ? ' sel' : ''}${node.disabled ? ' off' : ''}${run ? (run.status === 'ok' ? ' ok' : run.status === 'waiting' ? ' wait' : ' err') : ''}`);
        box.dataset.id = node.id;
        box.style.left = `${node.position[0]}px`;
        box.style.top = `${node.position[1]}px`;
        box.style.width = `${W}px`;
        box.style.height = `${heightOf(outputs)}px`;
        const head = el('div', 'wcv-head');
        head.append(el('b', '', `${Array.isArray(node.pinned) ? '📌 ' : ''}${ctx.titleOf(node.id)}`), el('small', '', `${ctx.typeLabel(node.type)}${node.disabled ? ' · ปิดอยู่' : ''}`));
        box.append(head);
        if (run) box.append(el('span', 'wcv-badge', run.status === 'ok' ? `${run.input.length} → ${run.output.length}` : run.status === 'waiting' ? '⏸ รอ' : 'error'));
        if (!trigger) {
          const input = el('span', 'wcv-port in');
          input.style.top = `${HEAD / 2}px`;
          box.append(input);
        }
        outputs.forEach((output, index) => {
          const y = HEAD + index * ROW + ROW / 2;
          if (outputs.length > 1 || output.key !== 'main') {
            const label = el('span', 'wcv-out', output.label);
            label.style.top = `${y - 8}px`;
            box.append(label);
          }
          const port = el('span', 'wcv-port out');
          port.dataset.key = output.key;
          port.style.top = `${y}px`;
          box.append(port);
        });
        world.append(box);
        boxes.set(node.id, box);
      }
    }

    /** Where a link leaves (output port) and arrives (input port), in world coordinates. */
    const outPoint = (id, key) => {
      const node = nodes.find((entry) => entry.id === id);
      const outputs = ctx.outputsOf(node);
      const index = Math.max(0, outputs.findIndex((output) => output.key === key));
      return [node.position[0] + W, node.position[1] + HEAD + index * ROW + ROW / 2];
    };
    const inPoint = (id) => {
      const node = nodes.find((entry) => entry.id === id);
      return [node.position[0], node.position[1] + HEAD / 2];
    };

    let edgeButton = null;
    function drawEdges() {
      svg.textContent = '';
      edgeButton?.remove();
      edgeButton = null;
      const add = (from, key, to, removable) => {
        const [x1, y1] = outPoint(from, key);
        const [x2, y2] = inPoint(to);
        const d = curve(x1, y1, x2, y2);
        const selected = state.edge && state.edge.from === from && state.edge.key === key && state.edge.to === to;
        const path = document.createElementNS(SVG, 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', `wcv-edge${selected ? ' sel' : ''}${key === 'error' ? ' errpath' : ''}`);
        svg.append(path);
        if (!removable) return;
        const hit = document.createElementNS(SVG, 'path');
        hit.setAttribute('d', d);
        hit.setAttribute('class', 'wcv-hit');
        hit.dataset.from = from;
        hit.dataset.key = key;
        hit.dataset.to = to;
        svg.append(hit);
        if (selected) {
          edgeButton = el('button', 'wcv-x', '✕');
          edgeButton.title = 'ลบสายนี้';
          edgeButton.style.left = `${(x1 + x2) / 2 - 11}px`;
          edgeButton.style.top = `${(y1 + y2) / 2 - 11}px`;
          edgeButton.onpointerdown = (event) => event.stopPropagation();
          edgeButton.onclick = () => removeEdge(state.edge);
          world.append(edgeButton);
        }
      };
      for (const node of nodes) {
        for (const [key, targets] of Object.entries(node.links || {})) {
          const known = ctx.outputsOf(node).some((output) => output.key === key) || key === 'error';
          if (!known) continue;
          for (const target of targets) if (nodes.some((entry) => entry.id === target)) add(node.id, key, target, true);
        }
      }
      // Bounds so the SVG layer covers every link (it does not clip, but needs a box).
      svg.setAttribute('width', '1');
      svg.setAttribute('height', '1');
    }

    function removeEdge(edge) {
      const node = nodes.find((entry) => entry.id === edge.from);
      if (!node) return;
      node.links[edge.key] = (node.links[edge.key] || []).filter((id) => id !== edge.to);
      state.edge = null;
      redraw();
      ctx.onChange();
    }

    /** True when linking from → to would make a loop. */
    function makesLoop(from, to) {
      const seen = new Set();
      const walk = (id) => {
        if (id === from) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        const node = nodes.find((entry) => entry.id === id);
        return Object.values(node?.links || {}).flat().some(walk);
      };
      return walk(to);
    }

    function link(from, key, to) {
      if (from === to) return;
      if (String(nodes.find((entry) => entry.id === to)?.type).startsWith('trigger_')) {
        return M().toast('ต่อไม่ได้', 'node ทริกเกอร์เป็นจุดเริ่ม ไม่รับสายเข้า', true);
      }
      if (makesLoop(from, to)) return M().toast('ต่อไม่ได้', 'สายนี้จะทำให้วนกลับ (Mimi รันจากหน้าไปหลังครั้งเดียว) — ถ้าจะวน ใช้ node Loop', true);
      const node = nodes.find((entry) => entry.id === from);
      const list = (node.links[key] ??= []);
      if (!list.includes(to)) list.push(to);
      redraw();
      ctx.onChange();
    }

    function redraw() {
      drawNotes();
      drawNodes();
      drawEdges();
    }

    function select(id) {
      state.selected = id;
      state.edge = null;
      for (const [boxId, box] of boxes) box.classList.toggle('sel', boxId === id);
      drawEdges();
      ctx.onSelect(id);
    }

    function fit() {
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || nodes.length === 0) return;
      const xs = nodes.flatMap((node) => [node.position[0], node.position[0] + W]);
      const ys = nodes.flatMap((node) => [node.position[1], node.position[1] + heightOf(ctx.outputsOf(node))]);
      const minX = Math.min(...xs) - 40;
      const maxX = Math.max(...xs) + 40;
      const minY = Math.min(...ys) - 40;
      const maxY = Math.max(...ys) + 40;
      state.z = Math.max(0.3, Math.min(1, rect.width / (maxX - minX), rect.height / (maxY - minY)));
      state.x = (rect.width - (maxX - minX) * state.z) / 2 - minX * state.z;
      state.y = (rect.height - (maxY - minY) * state.z) / 2 - minY * state.z;
      apply();
    }

    function zoomAt(factor, clientX, clientY) {
      const rect = host.getBoundingClientRect();
      const px = (clientX ?? rect.left + rect.width / 2) - rect.left;
      const py = (clientY ?? rect.top + rect.height / 2) - rect.top;
      const z = Math.max(0.3, Math.min(2, state.z * factor));
      state.x = px - ((px - state.x) * z) / state.z;
      state.y = py - ((py - state.y) * z) / state.z;
      state.z = z;
      apply();
    }

    // ---------- pointer handling: drag node, draw link, pan ----------
    let gesture = null;
    let temp = null;
    /** Touch points down right now; two of them pinch-zoom. */
    const pointers = new Map();
    const pinchOf = () => {
      const [a, b] = [...pointers.values()];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };
    host.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('.wcv-tools, .wcv-menu, textarea, .wcv-note-btn')) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        temp?.remove();
        temp = null;
        gesture = { kind: 'pinch', ...pinchOf() };
        return;
      }
      host.focus({ preventScroll: true });
      const noteBox = event.target.closest('.wcv-note');
      if (noteBox) {
        // The strip drags the note; elsewhere (the resize corner) the browser handles it.
        if (!event.target.closest('.wcv-note-head')) return;
        const note = (ctx.notes?.() ?? []).find((entry) => entry.id === noteBox.dataset.note);
        if (!note) return;
        gesture = { kind: 'note', note, box: noteBox, startX: event.clientX, startY: event.clientY, origin: [...note.position], moved: false };
        host.setPointerCapture(event.pointerId);
        return;
      }
      const port = event.target.closest('.wcv-port.out');
      const box = event.target.closest('.wcv-node');
      const hit = event.target.closest('.wcv-hit');
      if (port && box) {
        const from = box.dataset.id;
        gesture = { kind: 'link', from, key: port.dataset.key || 'main' };
        temp = document.createElementNS(SVG, 'path');
        temp.setAttribute('class', 'wcv-edge temp');
        svg.append(temp);
      } else if (hit) {
        state.edge = { from: hit.dataset.from, key: hit.dataset.key, to: hit.dataset.to };
        state.selected = null;
        for (const node of boxes.values()) node.classList.remove('sel');
        drawEdges();
        return;
      } else if (box) {
        const id = box.dataset.id;
        const node = nodes.find((entry) => entry.id === id);
        const origin = node ? [...node.position] : null;
        gesture = { kind: 'node', id, node, startX: event.clientX, startY: event.clientY, origin, moved: false };
      } else {
        gesture = { kind: 'pan', startX: event.clientX, startY: event.clientY, originX: state.x, originY: state.y, moved: false };
      }
      host.setPointerCapture(event.pointerId);
    });
    host.addEventListener('pointermove', (event) => {
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (!gesture) return;
      if (gesture.kind === 'pinch') {
        if (pointers.size < 2) return;
        const now = pinchOf();
        zoomAt(now.dist / gesture.dist, now.x, now.y);
        state.x += now.x - gesture.x;
        state.y += now.y - gesture.y;
        apply();
        Object.assign(gesture, now);
        return;
      }
      if (gesture.kind === 'note') {
        const dx = (event.clientX - gesture.startX) / state.z;
        const dy = (event.clientY - gesture.startY) / state.z;
        gesture.moved = gesture.moved || Math.hypot(dx, dy) >= 3;
        gesture.note.position = [Math.round(gesture.origin[0] + dx), Math.round(gesture.origin[1] + dy)];
        gesture.box.style.left = `${gesture.note.position[0]}px`;
        gesture.box.style.top = `${gesture.note.position[1]}px`;
        return;
      }
      if (gesture.kind === 'link') {
        const [x1, y1] = outPoint(gesture.from, gesture.key);
        const [x2, y2] = toWorld(event.clientX, event.clientY);
        temp.setAttribute('d', curve(x1, y1, x2, y2));
      } else if (gesture.kind === 'node' && gesture.origin) {
        const dx = (event.clientX - gesture.startX) / state.z;
        const dy = (event.clientY - gesture.startY) / state.z;
        if (!gesture.moved && Math.hypot(dx, dy) < 3) return;
        gesture.moved = true;
        const position = [Math.round(gesture.origin[0] + dx), Math.round(gesture.origin[1] + dy)];
        gesture.node.position = position;
        const box = boxes.get(gesture.id);
        box.style.left = `${position[0]}px`;
        box.style.top = `${position[1]}px`;
        drawEdges();
      } else if (gesture.kind === 'pan') {
        const dx = event.clientX - gesture.startX;
        const dy = event.clientY - gesture.startY;
        if (Math.hypot(dx, dy) > 3) gesture.moved = true;
        state.x = gesture.originX + dx;
        state.y = gesture.originY + dy;
        apply();
      }
    });
    const finish = (event) => {
      pointers.delete(event.pointerId);
      const current = gesture;
      gesture = null;
      if (!current) return;
      if (current.kind === 'pinch') return;
      if (current.kind === 'note') {
        if (current.moved) ctx.onChange();
        return;
      }
      if (current.kind === 'link') {
        temp?.remove();
        temp = null;
        const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.wcv-node');
        if (target) {
          link(current.from, current.key, target.dataset.id);
        } else {
          // Dropped on empty canvas: pick a node type to add right there, already linked.
          const position = toWorld(event.clientX, event.clientY);
          const rect = host.getBoundingClientRect();
          ctx.palette({ left: event.clientX - rect.left, top: event.clientY - rect.top, host }, (type) => {
            ctx.addNodeAt(type, [Math.round(position[0]), Math.round(position[1] - HEAD / 2)], { id: current.from, key: current.key });
          });
        }
      } else if (current.kind === 'node') {
        if (current.moved) ctx.onChange();
        else select(current.id);
      } else if (current.kind === 'pan' && !current.moved) {
        if (state.selected || state.edge) select(null);
      }
    };
    host.addEventListener('pointerup', finish);
    host.addEventListener('pointercancel', (event) => {
      pointers.delete(event.pointerId);
      gesture = null;
      temp?.remove();
      temp = null;
    });
    host.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX, event.clientY);
      },
      { passive: false },
    );
    host.addEventListener('keydown', (event) => {
      if (event.target !== host) return; // typing in a note
      // Ctrl shortcuts (undo, copy…) are the editor's: they work wherever its focus is.
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (state.edge) {
        event.preventDefault();
        removeEdge(state.edge);
      } else if (state.selected) {
        event.preventDefault();
        ctx.removeNode(state.selected);
      }
    });

    const tool = (text, title, onClick) => {
      const button = el('button', 'wcv-tool', text);
      button.type = 'button';
      button.title = title;
      button.onclick = onClick;
      toolbar.append(button);
      return button;
    };
    if (ctx.undo) {
      tool('↶', 'ย้อน (Ctrl+Z)', () => ctx.undo());
      tool('↷', 'ทำซ้ำ (Ctrl+Y)', () => ctx.redo());
    }
    if (ctx.notes) {
      tool('📝', 'เพิ่มโน้ต', () => {
        const rect = host.getBoundingClientRect();
        const [x, y] = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const list = ctx.notes();
        let n = 1;
        while (list.some((note) => note.id === `note${n}`)) n++;
        list.push({ id: `note${n}`, text: '', position: [Math.round(x - 110), Math.round(y - 65)], color: 'yellow' });
        drawNotes();
        ctx.onChange();
        noteBoxes.at(-1)?.querySelector('textarea')?.focus();
      });
    }
    tool('−', 'ซูมออก', () => zoomAt(1 / 1.2));
    tool('+', 'ซูมเข้า', () => zoomAt(1.2));
    tool('⤢', 'พอดีจอ', fit);
    tool('จัดเรียง', 'จัดตำแหน่ง node อัตโนมัติ', () => {
      autoLayout(nodes, ctx.outputsOf, false);
      redraw();
      fit();
      ctx.onChange();
    });

    host.addEventListener('dragover', (event) => {
      if (!event.dataTransfer.types.includes('application/x-mimi-node')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    host.addEventListener('drop', (event) => {
      const type = event.dataTransfer.getData('application/x-mimi-node');
      if (!type) return;
      event.preventDefault();
      const [x, y] = toWorld(event.clientX, event.clientY);
      ctx.addNodeAt(type, [Math.round(x - W / 2), Math.round(y - HEAD / 2)], null);
    });

    redraw();
    apply();
    if (!view) requestAnimationFrame(fit);
    /** Where a pasted node goes: the middle of what is on screen. */
    const center = () => {
      const rect = host.getBoundingClientRect();
      const [x, y] = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return [Math.round(x - W / 2), Math.round(y - HEAD)];
    };
    return { redraw, select, fit, center };
  }

  window.MimiCanvas = { mount, autoLayout };
})();
