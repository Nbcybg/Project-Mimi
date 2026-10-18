// Triggers screen: reminders and agent tasks on a clock or a webhook (n8n-style),
// created and edited here instead of by asking an agent in chat.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  /** null = creating, number = editing that trigger. */
  let editingId = null;

  const STATUS = { active: ['ok', 'รออยู่'], fired: ['todo', 'ทำแล้ว'], cancelled: ['todo', 'ยกเลิก'] };

  function whenOf(trigger) {
    if (trigger.webhook) return `webhook ${trigger.webhook}`;
    if (trigger.cron) return `cron ${trigger.cron}${trigger.repeat ? '' : ' (ครั้งเดียว)'}`;
    return M().fmtDate(trigger.fireAt);
  }

  function localInput(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** The trigger pool: types a workflow's trigger can be picked from. */
  const POOL_FIELDS = {
    poll: [
      { key: 'url', label: 'URL', type: 'string', required: true },
      { key: 'method', label: 'method', type: 'string', placeholder: 'GET' },
      { key: 'headers', label: 'headers (JSON)', type: 'json' },
      { key: 'everyMinutes', label: 'เช็คทุก (นาที)', type: 'number', placeholder: '15' },
    ],
    webhook: [],
  };

  function poolPanel() {
    const panel = el('div', 'panel');
    const entries = M().state.workflowPool || [];
    panel.append(el('h3', '', `Trigger pool (${entries.length})`));
    panel.append(
      el('p', 'hint', 'ชนิดของ trigger ที่ workflow หยิบไปใช้ · แก้/เพิ่มชนิดเองได้ที่นี่ (poll = เรียก HTTP เป็นรอบ, webhook = ให้บริการอื่นยิงเข้า) · trigger แต่ละตัวมี sample JSON ให้ดูว่าใช้ {{ $json.x }} อะไรได้'),
    );
    const rows = el('div');
    for (const entry of entries) {
      const row = el('div', 'prov');
      const info = el('div');
      info.append(
        el('b', '', `${entry.label} (${entry.name})`),
        el('small', '', `${entry.kind}${entry.builtin ? ' · built-in' : ''} · ${entry.description || ''}`),
        el('small', 'mono faint', `sample: ${JSON.stringify(entry.sample).slice(0, 160)}`),
      );
      row.append(info);
      if (!entry.builtin) {
        row.append(button('btn danger', 'ลบ', () => confirm(`ลบ trigger type "${entry.name}" ?`) && M().send({ type: 'trigger-pool-delete', name: entry.name })));
      }
      rows.append(row);
    }
    panel.append(rows);

    const form = el('div');
    form.append(el('h4', '', 'เพิ่ม trigger type ของตัวเอง'));
    const name = M().textInput('', 'ชื่อ เช่น my-feed');
    const label = M().textInput('', 'ชื่อที่แสดง เช่น ฟีดของฉัน');
    const kind = el('select');
    for (const value of ['poll', 'webhook']) {
      const option = el('option', '', value);
      option.value = value;
      kind.append(option);
    }
    const description = M().textInput('', 'คำอธิบายสั้น ๆ');
    const top = el('div', 'grid2');
    top.append(M().labelled('ชื่อ', name), M().labelled('ชื่อที่แสดง', label));
    const second = el('div', 'grid2');
    second.append(M().labelled('ชนิด', kind), M().labelled('คำอธิบาย', description));
    const foot = el('div', 'foot');
    foot.append(
      el('span', 'msg'),
      button('btn pri', '+ เพิ่ม', () => {
        if (!name.value.trim() || !label.value.trim()) return M().toast('กรอกไม่ครบ', null, true);
        M().send({
          type: 'trigger-pool-save',
          entry: {
            name: name.value.trim(),
            label: label.value.trim(),
            description: description.value.trim(),
            kind: kind.value,
            builtin: false,
            fields: POOL_FIELDS[kind.value],
            sample: kind.value === 'poll' ? { value: 1 } : { event: 'example' },
          },
        });
      }),
    );
    form.append(top, second, foot);
    panel.append(form);
    return panel;
  }

  function listPanel() {
    const panel = el('div', 'panel');
    const triggers = M().state.triggers || [];
    panel.append(el('h3', '', `Trigger (${triggers.length})`));
    panel.append(el('p', 'hint', 'ตั้งเวลาเตือน หรือให้ agent ทำงานเอง · webhook = เปิด URL ไว้ให้บริการอื่นเรียกเข้ามาแล้ว agent ทำงานทันที'));
    const add = button('btn', '+ Trigger ใหม่', () => {
      editingId = null;
      M().ui.triggerDirty = false;
      M().renderHub();
    });
    add.style.margin = '0 0 10px';
    panel.append(add);

    const rows = el('div', 'tbl trigrows');
    const head = el('div', 'hd');
    for (const label of ['เรื่อง', 'ชนิด', 'เวลา', 'สถานะ', '']) head.append(el('span', '', label));
    rows.append(head);
    for (const trigger of triggers) {
      const row = el('div');
      const title = el('span', 'nm2');
      title.append(el('b', '', trigger.title), el('small', 'muted', ` · ${trigger.agent ? M().nameOf(trigger.agent) : 'ค่าเริ่มต้น'}`));
      if (trigger.lastResult) title.title = `ผลล่าสุด: ${trigger.lastResult}`;
      const [pillClass, pillText] = STATUS[trigger.status] || ['todo', trigger.status];
      const status = el('span');
      status.append(el('span', `pill ${pillClass}`, pillText));
      const actions = el('span', 'hstack');
      if (trigger.workflow) {
        // Workflow schedules are managed from the Workflow screen.
        actions.append(el('span', 'chip', `⚙ ${trigger.workflow}`));
      } else {
        if (trigger.status === 'active') {
          actions.append(
            button('btn ghost', 'รัน', () => M().send({ type: 'trigger-run', id: trigger.id }), 'ทำทันที'),
            button('btn ghost', 'แก้ไข', () => {
              editingId = trigger.id;
              M().ui.triggerDirty = false;
              M().renderHub();
            }),
            button('btn ghost', 'ยกเลิก', () => confirm(`ยกเลิก "${trigger.title}" ?`) && M().send({ type: 'trigger-cancel', id: trigger.id })),
          );
        }
        actions.append(button('btn ghost', 'ลบ', () => confirm(`ลบ "${trigger.title}" ?`) && M().send({ type: 'trigger-delete', id: trigger.id })));
      }
      row.append(title, el('span', 'muted', trigger.kind === 'reminder' ? 'เตือน' : 'งาน agent'), el('span', 'mono', whenOf(trigger)), status, actions);
      rows.append(row);
    }
    panel.append(rows);
    if (triggers.length === 0) panel.append(el('div', 'empty', 'ยังไม่มี trigger'));
    return panel;
  }

  function editor() {
    const form = el('div', 'panel form');
    form.oninput = () => {
      M().ui.triggerDirty = true;
    };
    const trigger = editingId === null ? null : (M().state.triggers || []).find((entry) => entry.id === editingId);
    if (editingId !== null && !trigger) {
      editingId = null;
      return editor();
    }
    form.append(el('h3', '', trigger ? `แก้ไข #${trigger.id}` : 'Trigger ใหม่'));
    if (trigger && trigger.status !== 'active') {
      form.append(el('p', 'hint', `trigger นี้สถานะ "${trigger.status}" แก้ไขไม่ได้ — สร้างใหม่หรือลบ`));
    }

    const kind = el('select');
    for (const [value, label] of [['reminder', 'เตือนความจำ'], ['agent_task', 'งานของ agent']]) {
      const option = el('option', '', label);
      option.value = value;
      kind.append(option);
    }
    kind.value = trigger ? trigger.kind : 'reminder';
    const title = M().textInput(trigger ? trigger.title : '', 'เช่น โทรหาแม่, สรุปเมลเช้า');
    const top = el('div', 'grid2');
    top.append(M().labelled('ชนิด', kind), M().labelled('เรื่อง', title));

    const agent = el('select');
    const auto = el('option', '', '— ใช้ agent เริ่มต้น —');
    auto.value = '';
    agent.append(auto);
    for (const entry of M().state.agents) {
      const option = el('option', '', `${M().nameOf(entry.name)} (${entry.name})`);
      option.value = entry.name;
      agent.append(option);
    }
    agent.value = trigger && trigger.agent ? trigger.agent : '';
    form.append(top, M().labelled('agent ที่ทำงานนี้ (สำหรับงานของ agent)', agent));

    const text = el('textarea');
    text.value = trigger ? trigger.text : '';
    text.placeholder = 'สำหรับเตือน: ข้อความที่จะส่ง · สำหรับงาน agent: คำสั่งงานเต็ม ๆ';
    form.append(M().labelled('ข้อความ / คำสั่ง', text));

    const schedule = trigger?.webhook ? 'webhook' : trigger?.cron ? 'cron' : 'once';
    const seg = el('div', 'seg');
    const segButtons = {};
    for (const [key, label] of [['once', 'ครั้งเดียว'], ['cron', 'ทำซ้ำ (cron)'], ['webhook', 'Webhook']]) {
      const node = button('', label, () => {
        for (const [other, btn] of Object.entries(segButtons)) btn.classList.toggle('on', other === key);
        for (const [other, box] of Object.entries(boxes)) box.hidden = other !== key;
        M().ui.triggerDirty = true;
      });
      node.dataset.schedule = key;
      node.classList.toggle('on', key === schedule);
      segButtons[key] = node;
      seg.append(node);
    }
    form.append(el('h4', '', 'เวลาทำงาน'), seg);

    const boxes = {};
    const onceBox = el('div');
    const fireAt = M().textInput(trigger && trigger.fireAt ? localInput(trigger.fireAt) : '', '', 'datetime-local');
    onceBox.append(M().labelled('วันเวลา', fireAt), el('p', 'hint', 'ใช้เวลาของเครื่องนี้ · ต้องเป็นเวลาในอนาคต'));
    boxes.once = onceBox;

    const cronBox = el('div');
    const cron = M().textInput(trigger && trigger.cron ? trigger.cron : '0 8 * * *', 'นาที ชั่วโมง วัน เดือน วันในสัปดาห์');
    const repeat = el('input');
    repeat.type = 'checkbox';
    repeat.checked = trigger ? trigger.repeat : true;
    const quick = el('div', 'hstack');
    quick.style.marginTop = '6px';
    for (const [label, pattern] of [['ทุกวัน 08:00', '0 8 * * *'], ['ทุกชั่วโมง', '0 * * * *'], ['ทุก 15 นาที', '*/15 * * * *'], ['วันจันทร์ 09:00', '0 9 * * 1']]) {
      quick.append(button('chip', label, () => {
        cron.value = pattern;
        M().ui.triggerDirty = true;
      }));
    }
    cronBox.append(M().labelled('cron', cron), M().labelled('ทำซ้ำทุกรอบ', repeat), quick);
    boxes.cron = cronBox;

    const webhookBox = el('div');
    if (trigger && trigger.webhook) {
      const url = `${location.origin}${trigger.webhook}`;
      const row = el('div', 'hstack');
      row.append(el('span', 'mono', url), button('chip', 'คัดลอก', async () => {
        try {
          await navigator.clipboard.writeText(url);
          M().toast('คัดลอกแล้ว', url);
        } catch {
          M().toast('คัดลอกไม่ได้', 'เลือกข้อความแล้วคัดลอกเอง', true);
        }
      }));
      webhookBox.append(el('p', 'hint', 'ให้บริการอื่น POST มาที่ URL นี้ได้เลย (ไม่ต้องมี token) · ข้อความ body จะถูกส่งต่อให้ agent'), row);
    } else {
      webhookBox.append(el('p', 'hint', 'บันทึกแล้วระบบจะสร้าง URL เฉพาะของ trigger นี้ให้ — URL จะโผล่ในรายการด้านซ้าย'));
    }
    boxes.webhook = webhookBox;

    for (const [key, box] of Object.entries(boxes)) {
      box.hidden = key !== schedule;
      form.append(box);
    }

    const foot = el('div', 'foot');
    foot.append(el('span', 'msg'));
    if (trigger) {
      foot.append(
        button('btn ghost', 'ยกเลิกการแก้ไข', () => {
          editingId = null;
          M().ui.triggerDirty = false;
          M().renderHub();
        }),
      );
    }
    foot.append(
      button('btn pri', 'บันทึก', () => {
        if (!title.value.trim() || !text.value.trim()) return M().toast('กรอกไม่ครบ', 'ต้องมีเรื่องและข้อความ', true);
        const active = Object.entries(segButtons).find(([, node]) => node.classList.contains('on'))?.[0] || schedule;
        M().ui.triggerDirty = false;
        if (trigger) {
          const patch = { title: title.value.trim(), text: text.value.trim(), agent: agent.value || null };
          if (!trigger.webhook) {
            if (active === 'cron') {
              patch.cron = cron.value.trim();
              patch.repeat = repeat.checked;
            } else if (active === 'once') {
              patch.fireAt = fireAt.value;
            }
          }
          M().send({ type: 'trigger-update', id: trigger.id, patch });
        } else {
          M().send({
            type: 'trigger-create',
            trigger: {
              kind: kind.value,
              title: title.value.trim(),
              text: text.value.trim(),
              agent: agent.value || null,
              ...(active === 'webhook'
                ? { webhook: true }
                : active === 'cron'
                  ? { cron: cron.value.trim(), repeat: repeat.checked }
                  : { fireAt: fireAt.value }),
            },
          });
        }
      }),
    );
    form.append(foot);
    return form;
  }

  function render() {
    const stack = el('div', 'stackv');
    stack.append(poolPanel(), listPanel(), editor());
    return stack;
  }

  function onMessage(message) {
    if (editingId !== null && !(message.triggers || []).some((entry) => entry.id === editingId)) editingId = null;
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.triggers = { render, onMessage };
})();
