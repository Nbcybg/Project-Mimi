// Hub → Trigger: everything that starts work on its own, in one place.
// "Trigger ที่ตั้งไว้" lists every armed trigger as a card — reminders, agent tasks and the
// trigger of each workflow — with run / edit / delete. "ชนิดของ trigger" is what a trigger can
// listen to; the mail and calendar types carry their own settings (mailboxes, which calendar),
// so Google / Outlook are no longer a separate box.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const Kit = () => window.MimiKit;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  let filter = 'all';
  let query = '';
  /** Waiting for the server to confirm a save; the popup closes when the list comes back. */
  let pending = null;

  const STATUS = { active: ['ok', 'รออยู่'], fired: ['todo', 'ทำแล้ว'], cancelled: ['todo', 'ยกเลิก'] };
  const POOL_ICON = { manual: '▶', schedule: '⏰', webhook: '⇥', form: '☰', mail: '✉', calendar: '📅', poll: '↻', chat: '💬', telegram: '✈', agent_tool: '⚙' };
  const pool = () => M().state.workflowPool || [];
  const poolOf = (name) => pool().find((entry) => entry.name === name);

  function whenOf(trigger) {
    if (trigger.webhook) return 'เมื่อมีคนเรียก webhook';
    if (trigger.cron) return `${cronText(trigger.cron)}${trigger.repeat ? '' : ' (ครั้งเดียว)'}`;
    return trigger.fireAt ? M().fmtDate(trigger.fireAt) : '—';
  }

  /** A few common cron patterns in words; anything else is shown as it is. */
  function cronText(cron) {
    const parts = String(cron).trim().split(/\s+/);
    if (parts.length !== 5) return `cron ${cron}`;
    const [minute, hour, day, month, weekday] = parts;
    const time = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}` : null;
    const days = { '*': 'ทุกวัน', '1-5': 'จันทร์–ศุกร์', '0,6': 'เสาร์–อาทิตย์', 0: 'วันอาทิตย์', 1: 'วันจันทร์', 2: 'วันอังคาร', 3: 'วันพุธ', 4: 'วันพฤหัส', 5: 'วันศุกร์', 6: 'วันเสาร์' };
    if (time && day === '*' && month === '*' && days[weekday]) return `${days[weekday]} ${time}`;
    if (time && /^\d+$/.test(day) && month === '*' && weekday === '*') return `ทุกวันที่ ${day} ${time}`;
    if (/^\*\/\d+$/.test(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*') return `ทุก ${minute.slice(2)} นาที`;
    if (minute === '0' && hour === '*' && day === '*' && month === '*' && weekday === '*') return 'ทุกชั่วโมง';
    return `cron ${cron}`;
  }

  function localInput(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      M().toast('คัดลอกแล้ว', text);
    } catch {
      M().toast('คัดลอกไม่ได้', 'เลือกข้อความแล้วคัดลอกเอง', true);
    }
  }

  // ---------- reminders / agent tasks ----------
  function triggerEditor(trigger, copyOf) {
    const source = trigger || copyOf || null;
    const kind = Kit().select([['reminder', 'เตือนความจำ — ส่งข้อความหาคุณ'], ['agent_task', 'งานของ agent — ให้ agent ทำตามคำสั่ง']], source ? source.kind : 'reminder');
    kind.disabled = Boolean(trigger);
    const title = M().textInput(source ? source.title : '', 'เช่น โทรหาแม่, สรุปเมลเช้า');
    const agent = Kit().select([['', '— agent เริ่มต้น —'], ...M().state.agents.filter((entry) => entry.name !== 'overseer').map((entry) => [entry.name, `${M().nameOf(entry.name)} (${entry.name})`])], source && source.agent ? source.agent : '');
    const text = el('textarea');
    text.value = source ? source.text : '';
    text.placeholder = 'เตือน: ข้อความที่จะส่ง · งาน agent: คำสั่งงานเต็ม ๆ เช่น "สรุปเมลที่ยังไม่อ่านแล้วส่งให้ฉัน"';
    text.style.minHeight = '90px';
    const top = el('div', 'mk-grid2');
    top.append(Kit().field('ชนิด', kind), Kit().field('เรื่อง', title));
    const agentBox = Kit().field('agent ที่ทำงานนี้', agent);
    const paintKind = () => {
      agentBox.hidden = kind.value !== 'agent_task';
    };
    kind.onchange = paintKind;
    paintKind();

    let schedule = source?.webhook ? 'webhook' : source?.cron ? 'cron' : 'once';
    const seg = el('div', 'seg');
    const boxes = {};
    const segButtons = {};
    for (const [key, label] of [['once', 'ครั้งเดียว'], ['cron', 'ทำซ้ำ'], ['webhook', 'Webhook']]) {
      const node = button(key === schedule ? 'on' : '', label, () => {
        if (trigger && (key === 'webhook') !== Boolean(trigger.webhook)) return M().toast('เปลี่ยนไม่ได้', 'trigger ที่สร้างแล้วสลับระหว่าง webhook กับเวลาไม่ได้ — ทำสำเนาแล้วลบอันเดิมแทน', true);
        schedule = key;
        for (const [other, btn] of Object.entries(segButtons)) btn.classList.toggle('on', other === key);
        for (const [other, box] of Object.entries(boxes)) box.hidden = other !== key;
      });
      segButtons[key] = node;
      seg.append(node);
    }
    const fireAt = M().textInput(source && source.fireAt ? localInput(source.fireAt) : '', '', 'datetime-local');
    boxes.once = el('div');
    boxes.once.append(Kit().field('วันเวลา', fireAt, 'เวลาของเครื่องนี้ · ต้องเป็นเวลาในอนาคต'));
    const cron = M().textInput(source && source.cron ? source.cron : '0 8 * * *', 'นาที ชั่วโมง วัน เดือน วันในสัปดาห์');
    const cronHint = el('p', 'hint');
    const paintCron = () => {
      cronHint.textContent = `= ${cronText(cron.value)}`;
    };
    cron.addEventListener('input', paintCron);
    paintCron();
    const repeat = el('label', 'wcheck');
    const repeatBox = el('input');
    repeatBox.type = 'checkbox';
    repeatBox.checked = source ? source.repeat !== false : true;
    repeat.append(repeatBox, el('span', '', 'ทำซ้ำทุกรอบ (ไม่ติ๊ก = ทำรอบถัดไปครั้งเดียว)'));
    const quick = el('div', 'hstack');
    for (const [label, pattern] of [['ทุกวัน 08:00', '0 8 * * *'], ['จันทร์–ศุกร์ 09:00', '0 9 * * 1-5'], ['ทุกชั่วโมง', '0 * * * *'], ['ทุก 15 นาที', '*/15 * * * *'], ['วันที่ 1 ทุกเดือน', '0 9 1 * *']]) {
      quick.append(button('chip', label, () => {
        cron.value = pattern;
        paintCron();
      }));
    }
    boxes.cron = el('div');
    boxes.cron.append(Kit().field('รอบเวลา (cron)', cron), cronHint, quick, repeat);
    boxes.webhook = el('div');
    if (trigger && trigger.webhook) {
      const url = M().webhookUrl(trigger.webhook);
      const row = el('div', 'hstack');
      row.append(el('code', 'mono', url), button('btn ghost sm', 'คัดลอก', () => copy(url)));
      boxes.webhook.append(el('p', 'hint', 'ให้บริการอื่น POST มาที่ URL นี้ · body จะถูกส่งต่อให้ agent'), row);
    } else {
      boxes.webhook.append(el('p', 'hint', 'บันทึกแล้วระบบจะสร้าง URL เฉพาะของ trigger นี้ให้ (ดูได้จากการ์ด)'));
    }
    for (const [key, box] of Object.entries(boxes)) box.hidden = key !== schedule;

    const body = [top, agentBox, Kit().field('ข้อความ / คำสั่ง', text), Kit().section('เมื่อไหร่', '', []), seg, boxes.once, boxes.cron, boxes.webhook];
    const popup = Kit().modal({ title: trigger ? `แก้ไข trigger: ${trigger.title}` : 'เพิ่ม trigger', sub: 'เตือนความจำ หรือสั่งให้ agent ทำงานตามเวลา / เมื่อมีคนเรียก webhook', body });
    const save = () => {
      if (!title.value.trim() || !text.value.trim()) return M().toast('กรอกไม่ครบ', 'ต้องมีเรื่องและข้อความ', true);
      if (schedule === 'once' && !fireAt.value) return M().toast('ยังไม่ได้เลือกวันเวลา', null, true);
      if (schedule === 'once' && new Date(fireAt.value) <= new Date()) return M().toast('เวลาผ่านไปแล้ว', 'เลือกเวลาในอนาคต', true);
      pending = { title: title.value.trim(), popup };
      if (trigger) {
        const patch = { title: title.value.trim(), text: text.value.trim(), agent: kind.value === 'agent_task' ? agent.value || null : null };
        if (!trigger.webhook) {
          if (schedule === 'cron') Object.assign(patch, { cron: cron.value.trim(), repeat: repeatBox.checked });
          else patch.fireAt = fireAt.value;
        }
        M().send({ type: 'trigger-update', id: trigger.id, patch });
      } else {
        M().send({
          type: 'trigger-create',
          trigger: {
            kind: kind.value,
            title: title.value.trim(),
            text: text.value.trim(),
            agent: kind.value === 'agent_task' ? agent.value || null : null,
            ...(schedule === 'webhook' ? { webhook: true } : schedule === 'cron' ? { cron: cron.value.trim(), repeat: repeatBox.checked } : { fireAt: fireAt.value }),
          },
        });
      }
    };
    popup.setFoot(
      [button('btn ghost', 'ยกเลิก', () => popup.close()), button('btn pri', trigger ? 'บันทึก' : 'สร้าง', save)],
      trigger ? [button('btn danger', 'ลบ', () => deleteTrigger(trigger, popup)), button('btn ghost', 'ทำสำเนา', () => triggerEditor(null, trigger))] : [],
    );
  }

  async function deleteTrigger(trigger, popup) {
    if (!(await Kit().confirmDelete(`trigger "${trigger.title}"`, trigger.webhook ? 'URL webhook ของมันจะใช้ไม่ได้อีก' : 'จะไม่ทำงานอีก'))) return;
    M().send({ type: 'trigger-delete', id: trigger.id });
    popup?.done();
  }

  async function cancelTrigger(trigger) {
    if (!(await Kit().ask({ title: `ยกเลิก "${trigger.title}"?`, body: 'trigger จะหยุดทำงานแต่ยังอยู่ในรายการ (ลบทีหลังได้)', ok: 'ยกเลิก trigger', cancel: 'ไม่', danger: true }))) return;
    M().send({ type: 'trigger-cancel', id: trigger.id });
  }

  function triggerCard(trigger) {
    const [pillClass, pillText] = STATUS[trigger.status] || ['todo', trigger.status];
    const active = trigger.status === 'active';
    return Kit().card({
      title: trigger.title,
      sub: `${trigger.kind === 'reminder' ? 'เตือนความจำ' : `งานของ ${trigger.agent ? M().nameOf(trigger.agent) : 'agent เริ่มต้น'}`} · ${whenOf(trigger)}`,
      icon: trigger.webhook ? '⇥' : trigger.cron ? '↻' : '⏰',
      state: [pillClass, pillText],
      desc: trigger.lastResult ? `ผลล่าสุด: ${trigger.lastResult}` : trigger.text,
      cls: active ? '' : 'off',
      onOpen: active ? () => triggerEditor(trigger) : undefined,
      actions: [
        active ? { label: '▶ รันตอนนี้', onClick: () => M().send({ type: 'trigger-run', id: trigger.id }) } : null,
        active ? { label: 'แก้ไข', onClick: () => triggerEditor(trigger) } : { label: 'ทำซ้ำ', onClick: () => triggerEditor(null, trigger), title: 'สร้างใหม่จากอันนี้' },
        trigger.webhook ? { label: 'คัดลอก URL', onClick: () => copy(M().webhookUrl(trigger.webhook)) } : null,
        active ? { label: 'ยกเลิก', onClick: () => cancelTrigger(trigger) } : null,
        { label: 'ลบ', danger: true, onClick: () => deleteTrigger(trigger) },
      ],
    });
  }

  // ---------- workflow triggers ----------
  function workflowSummary(workflow) {
    const trigger = workflow.trigger || {};
    const entry = poolOf(trigger.pool);
    const config = trigger.config || {};
    if (trigger.pool === 'schedule' && config.cron) return cronText(config.cron);
    if (trigger.pool === 'mail') return `อีเมลใหม่${config.account ? ` (${config.account})` : ''}${config.query ? ` · "${config.query}"` : ''}`;
    if (trigger.pool === 'chat' && config.prefix) return `ข้อความขึ้นต้น ${config.prefix}`;
    return entry ? entry.label : trigger.pool || 'ไม่มี trigger';
  }

  function openWorkflow(workflow) {
    const hook = window.MimiHooks && window.MimiHooks.workflows;
    if (hook && hook.openEditor) hook.openEditor(workflow.agent, workflow);
    else {
      M().ui.agent = workflow.agent;
      M().ui.agentScreen = 'edit';
      M().setView('agents');
    }
  }

  async function toggleWorkflow(workflow) {
    const on = !workflow.enabled;
    if (!on && !(await Kit().ask({ title: `ปิด workflow "${workflow.title || workflow.name}"?`, body: 'trigger ของมันจะหยุดทำงานจนกว่าจะเปิดใหม่', ok: 'ปิด' }))) return;
    M().send({ type: 'workflow-save', workflow: { ...workflow, enabled: on }, renameFrom: workflow.name });
  }

  function workflowCard(workflow) {
    const trigger = workflow.trigger || {};
    return Kit().card({
      title: workflow.title || workflow.name,
      sub: `workflow ของ ${M().nameOf(workflow.agent)} · ${workflowSummary(workflow)}`,
      icon: POOL_ICON[trigger.pool] || '⚡',
      state: workflow.enabled ? ['ok', 'เปิด'] : ['todo', 'ปิด'],
      desc: workflow.description,
      cls: workflow.enabled ? '' : 'off',
      badges: [['workflow', 'violet'], poolOf(trigger.pool)?.label],
      onOpen: () => openWorkflow(workflow),
      actions: [
        { label: 'เปิดผัง workflow', onClick: () => openWorkflow(workflow) },
        { label: workflow.enabled ? 'ปิด' : 'เปิด', onClick: () => toggleWorkflow(workflow) },
        trigger.pool === 'webhook' || trigger.pool === 'form' ? { label: 'คัดลอก URL', onClick: () => copy(M().webhookUrl(workflow.webhook)) } : null,
      ],
    });
  }

  // ---------- trigger types ----------
  /** Mailboxes the mail trigger can read: summary + where to manage them. */
  function mailSection() {
    const accounts = ((M().state.settings || {}).mailAccounts) || [];
    const box = el('div');
    box.append(Kit().section('กล่องเมลที่ trigger นี้อ่านได้', 'เพิ่ม / แก้ / ลบกล่องเมลได้ที่ Hub → บัญชี · ตัวกรอง (คำค้น โฟลเดอร์) ตั้งใน node ของ workflow แต่ละอัน', [button('btn', 'จัดการกล่องเมล', () => goAccounts())]));
    box.append(Kit().grid(accounts.map((account) => Kit().card({
      title: account.name || account.id,
      sub: `${account.kind.toUpperCase()} · ${account.email || (account.incoming && account.incoming.user) || ''}`,
      state: account.connected === false ? ['todo', 'ยังไม่ครบ'] : ['ok', 'พร้อม'],
    })), 'ยังไม่มีกล่องเมล — Gmail / Outlook ใช้บัญชีที่เชื่อมใน Hub → บัญชี', 'dense'));
    return box;
  }

  /** The calendar trigger's sources: one card per Google / Microsoft account, with its calendar choice. */
  function calendarSection() {
    const calendar = M().state.calendar || (M().state.settings || {}).calendar;
    const box = el('div');
    box.append(Kit().section('ปฏิทินที่ติดตาม', calendar && calendar.publicUrl
      ? 'รับแจ้งแบบทันที (push) ได้ · มีตรวจซ้ำทุก 15 นาทีกันพลาด'
      : 'ยังไม่มี public HTTPS endpoint — ตรวจทุก 15 นาทีแทน push · เปิด Cloudflare Tunnel ในตั้งค่าเพื่อรับแบบทันที', [
      button('btn ghost', 'Sync ตอนนี้', () => M().send({ type: 'calendar-sync-now' })),
      button('btn', 'เชื่อมบัญชี', () => goAccounts()),
    ]));
    const accounts = (calendar && calendar.accounts) || [];
    box.append(Kit().grid(accounts.map((account) => Kit().card({
      title: account.name || account.account,
      sub: `${account.service === 'google' ? 'Google' : 'Outlook'} · ${!account.calendarId || account.calendarId === 'all' ? (account.service === 'google' ? 'ปฏิทินหลัก' : 'ทุกปฏิทิน') : account.calendarId}`,
      state: !account.connected ? ['todo', 'ยังไม่เชื่อมต่อ'] : account.push ? ['ok', 'push'] : ['warn', 'poll'],
      desc: account.lastError ? `ผิดพลาด: ${account.lastError}` : `sync ล่าสุด ${account.lastSyncAt ? M().fmtDate(account.lastSyncAt) : '—'}${account.subscriptionExpiresAt ? ` · push หมดอายุ ${M().fmtDate(account.subscriptionExpiresAt)}` : ''}`,
      actions: [{ label: 'เลือกปฏิทิน', onClick: () => openCalendarPicker(account) }],
    })), 'ยังไม่มีบัญชี Google / Microsoft — กด "เชื่อมบัญชี"', 'dense'));
    return box;
  }

  function goAccounts() {
    for (const scrim of document.querySelectorAll('#overlay .mk-scrim')) scrim.remove();
    M().ui.hubTab = 'accounts';
    M().renderHub();
  }

  function poolDetail(entry) {
    const body = [el('p', '', entry.description || '')];
    const kv = el('div', 'mk-kv');
    kv.append(el('span', '', 'ชื่อในระบบ'), el('code', 'mono', entry.name), el('span', '', 'แบบ'), el('span', '', entry.builtin ? `${entry.kind} · ในตัว` : `${entry.kind} · สร้างเอง`));
    body.push(kv);
    if (entry.name === 'mail') body.push(mailSection());
    if (entry.name === 'calendar') body.push(calendarSection());
    const users = (M().state.workflows || []).filter((workflow) => workflow.trigger && workflow.trigger.pool === entry.name);
    body.push(Kit().section(`workflow ที่ใช้ชนิดนี้ (${users.length})`, '', []));
    body.push(Kit().grid(users.map(workflowCard), 'ยังไม่มี workflow ใช้ — สร้าง workflow ใหม่ในหน้า Agent → Workflow แล้วเลือก trigger นี้', 'dense'));
    body.push(Kit().section('ข้อมูลที่ส่งต่อให้ node ถัดไป', 'อ้างถึงได้ด้วย {{ $json.ชื่อ }}', []), el('pre', 'mk-pre', JSON.stringify(entry.sample, null, 2)));
    const popup = Kit().modal({ title: entry.label, sub: 'ชนิดของ trigger', size: 'wide', body });
    popup.setFoot(
      [button('btn', 'ปิด', () => popup.done())],
      entry.builtin ? [] : [button('btn danger', 'ลบ', () => deletePool(entry, popup)), button('btn ghost', 'แก้ไข', () => {
        popup.done();
        poolEditor(entry);
      })],
    );
  }

  /** The fields a custom type's node asks for: poll = an HTTP call on a timer, webhook = nothing. */
  const POOL_FIELDS = {
    poll: [
      { key: 'url', label: 'URL', type: 'string', required: true },
      { key: 'method', label: 'method', type: 'string', placeholder: 'GET' },
      { key: 'headers', label: 'headers (JSON)', type: 'json' },
      { key: 'everyMinutes', label: 'เช็คทุก (นาที)', type: 'number', placeholder: '15' },
    ],
    webhook: [],
  };

  function poolEditor(entry) {
    const name = M().textInput(entry ? entry.name : '', 'เช่น my-feed (a-z 0-9 -)');
    name.readOnly = Boolean(entry);
    const label = M().textInput(entry ? entry.label : '', 'ชื่อที่แสดง เช่น ฟีดของฉัน');
    const kindSelect = Kit().select([['poll', 'poll — เรียก URL เป็นรอบ'], ['webhook', 'webhook — ให้บริการอื่นยิงเข้ามา']], entry ? entry.kind : 'poll');
    const description = M().textInput(entry ? entry.description || '' : '', 'คำอธิบายสั้น ๆ');
    const sample = el('textarea');
    sample.value = JSON.stringify(entry ? entry.sample : { value: 1 }, null, 2);
    sample.style.minHeight = '90px';
    const top = el('div', 'mk-grid2');
    top.append(Kit().field('ชื่อในระบบ', name), Kit().field('ชื่อที่แสดง', label));
    const popup = Kit().modal({
      title: entry ? `แก้ไขชนิด trigger: ${entry.label}` : 'เพิ่มชนิด trigger',
      sub: 'ชนิดที่สร้างเองจะโผล่ในรายการ trigger ของหน้าผัง workflow · URL / รอบเวลา ตั้งใน node ของแต่ละ workflow',
      body: [top, Kit().field('แบบ', kindSelect), Kit().field('คำอธิบาย', description), Kit().field('ข้อมูลตัวอย่าง (JSON)', sample, 'ช่วยให้คนต่อ node ถัดไปรู้ว่ามี {{ $json.x }} อะไรบ้าง')],
    });
    popup.setFoot([
      button('btn ghost', 'ยกเลิก', () => popup.close()),
      button('btn pri', 'บันทึก', () => {
        if (!name.value.trim() || !label.value.trim()) return M().toast('กรอกไม่ครบ', 'ต้องมีชื่อและชื่อที่แสดง', true);
        let parsed;
        try {
          parsed = JSON.parse(sample.value || '{}');
        } catch {
          return M().toast('ข้อมูลตัวอย่างไม่ใช่ JSON', null, true);
        }
        pending = { pool: name.value.trim(), popup };
        M().send({
          type: 'trigger-pool-save',
          entry: { name: name.value.trim(), label: label.value.trim(), description: description.value.trim(), kind: kindSelect.value, builtin: false, fields: POOL_FIELDS[kindSelect.value], sample: parsed },
        });
      }),
    ], entry ? [button('btn danger', 'ลบ', () => deletePool(entry, popup))] : []);
  }

  async function deletePool(entry, popup) {
    const users = (M().state.workflows || []).filter((workflow) => workflow.trigger && workflow.trigger.pool === entry.name);
    if (!(await Kit().confirmDelete(`ชนิด trigger "${entry.label}"`, users.length ? `workflow ที่ใช้อยู่จะไม่มี trigger: ${users.map((workflow) => workflow.title || workflow.name).join(', ')}` : 'ยังไม่มี workflow ใช้ชนิดนี้'))) return;
    M().send({ type: 'trigger-pool-delete', name: entry.name });
    popup?.done();
  }

  function poolCard(entry) {
    const users = (M().state.workflows || []).filter((workflow) => workflow.trigger && workflow.trigger.pool === entry.name).length;
    const extra = entry.name === 'calendar'
      ? `${(((M().state.calendar || (M().state.settings || {}).calendar) || {}).accounts || []).length} บัญชี`
      : entry.name === 'mail'
        ? `${(((M().state.settings || {}).mailAccounts) || []).length} กล่องเมล`
        : null;
    return Kit().card({
      title: entry.label,
      sub: entry.builtin ? 'ในตัว' : 'สร้างเอง',
      icon: POOL_ICON[entry.name] || (entry.name.startsWith('connector:') ? '⇄' : '⚡'),
      desc: entry.description,
      badges: [entry.kind, extra, users ? [`ใช้ใน ${users} workflow`, 'ok'] : null],
      onOpen: () => poolDetail(entry),
      actions: [
        { label: entry.name === 'calendar' || entry.name === 'mail' ? 'ตั้งค่า' : 'ดูรายละเอียด', onClick: () => poolDetail(entry) },
        entry.builtin ? null : { label: 'แก้ไข', onClick: () => poolEditor(entry) },
        entry.builtin ? null : { label: 'ลบ', danger: true, onClick: () => deletePool(entry) },
      ],
    });
  }

  // ---------- calendar picker ----------
  /** { account, label, current, popup } while the calendar picker is open. */
  let calendarPicker = null;

  function openCalendarPicker(account) {
    const popup = Kit().modal({ title: `เลือกปฏิทิน: ${account.name || account.account}`, body: [el('p', 'hint', 'กำลังโหลดรายการปฏิทิน…')], size: 'sm', onClose: () => {
      calendarPicker = null;
    } });
    popup.setFoot([button('btn ghost', 'ปิด', () => popup.done())]);
    calendarPicker = {
      account: account.account,
      service: account.service,
      current: account.calendarId || (account.service === 'google' ? 'primary' : 'all'),
      popup,
    };
    M().send({ type: 'calendar-calendars', account: account.account });
  }

  function showCalendarPicker(message) {
    if (!calendarPicker || message.account !== calendarPicker.account) return;
    const picker = calendarPicker;
    const options = [];
    if (picker.service === 'microsoft') options.push(['all', 'ทุกปฏิทินของบัญชี']);
    for (const calendar of message.calendars || []) options.push([calendar.id, `${calendar.summary}${calendar.primary ? ' (หลัก)' : ''}`]);
    if (options.length > 0 && !options.some(([value]) => value === picker.current)) options.push([picker.current, `${picker.current} (ปัจจุบัน)`]);
    const chooser = options.length > 0 ? Kit().select(options, picker.current) : M().textInput(picker.current, 'Calendar ID');
    const body = [Kit().field(options.length > 0 ? 'ปฏิทิน' : 'Calendar ID', chooser, options.length > 0 ? null : 'โหลดรายการไม่ได้ — พิมพ์ Calendar ID เอง (ค่าเริ่มต้น primary)')];
    for (const error of message.errors || []) body.push(el('p', 'hint badtxt', error));
    picker.popup.setBody(body);
    picker.popup.setFoot([
      button('btn ghost', 'ยกเลิก', () => picker.popup.done()),
      button('btn pri', 'ใช้ปฏิทินนี้', () => {
        const calendarId = String(chooser.value || '').trim();
        if (!calendarId) return M().toast('ยังไม่ได้เลือกปฏิทิน', null, true);
        picker.popup.done();
        M().send({ type: 'calendar-set', account: picker.account, calendarId });
      }),
    ]);
  }

  // ---------- import / export ----------
  function exportAll() {
    const triggers = (M().state.triggers || []).filter((trigger) => !trigger.workflow && trigger.status === 'active')
      .map(({ kind, title, text, agent, cron, repeat, fireAt, webhook }) => ({ kind, title, text, agent, ...(cron ? { cron, repeat } : {}), ...(fireAt && !cron ? { fireAt } : {}), ...(webhook ? { webhook: true } : {}) }));
    const types = pool().filter((entry) => !entry.builtin);
    Kit().downloadJson(`mimi-triggers-${Kit().stamp()}.json`, { kind: 'mimi-triggers', version: 1, triggers, types });
  }

  async function importAll(files) {
    let triggers = 0;
    let types = 0;
    for (const file of files) {
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error(`${file.name}: ไม่ใช่ไฟล์ JSON`);
      }
      for (const trigger of data.triggers || (Array.isArray(data) ? data : [])) {
        if (!trigger || !trigger.title || !trigger.text) continue;
        // A one-off time already gone would only be refused; it comes back as a draft instead.
        if (!trigger.cron && !trigger.webhook && (!trigger.fireAt || new Date(trigger.fireAt) <= new Date())) continue;
        M().send({ type: 'trigger-create', trigger: { kind: trigger.kind === 'agent_task' ? 'agent_task' : 'reminder', title: trigger.title, text: trigger.text, agent: trigger.agent || null, ...(trigger.webhook ? { webhook: true } : trigger.cron ? { cron: trigger.cron, repeat: trigger.repeat !== false } : { fireAt: trigger.fireAt }) } });
        triggers++;
      }
      for (const entry of data.types || []) {
        if (!entry || !entry.name || !entry.label || (entry.kind !== 'poll' && entry.kind !== 'webhook')) continue;
        M().send({ type: 'trigger-pool-save', entry: { ...entry, builtin: false, fields: POOL_FIELDS[entry.kind] } });
        types++;
      }
    }
    if (triggers + types === 0) throw new Error('ไม่พบ trigger ในไฟล์ (เวลาครั้งเดียวที่ผ่านไปแล้วจะถูกข้าม)');
    M().toast('นำเข้าแล้ว', [triggers && `trigger ${triggers}`, types && `ชนิด ${types}`].filter(Boolean).join(' · '));
  }

  // ---------- render ----------
  function render() {
    if (!M().state.calendar && !(M().state.settings || {}).calendar) M().send({ type: 'settings-get' });
    if (!(M().state.settings || {}).mailAccounts && !M().state.mailAccountsRequested) {
      M().state.mailAccountsRequested = true;
      M().send({ type: 'mail-watch' });
    }
    const wrap = el('div');
    const own = (M().state.triggers || []).filter((trigger) => !trigger.workflow);
    const workflows = (M().state.workflows || []).filter((workflow) => workflow.trigger && workflow.trigger.pool && workflow.trigger.pool !== 'manual' && workflow.trigger.pool !== 'agent_tool');
    const items = [
      ...own.map((trigger) => ({ key: trigger.status === 'active' ? 'active' : 'done', text: `${trigger.title} ${trigger.text} ${trigger.agent || ''}`, card: () => triggerCard(trigger), sort: trigger.status === 'active' ? 0 : 2 })),
      ...workflows.map((workflow) => ({ key: 'workflow', text: `${workflow.title} ${workflow.name} ${workflow.description || ''} ${workflowSummary(workflow)}`, card: () => workflowCard(workflow), sort: workflow.enabled ? 1 : 2 })),
    ].sort((a, b) => a.sort - b.sort);
    const filters = [
      ['all', 'ทั้งหมด', () => true],
      ['active', 'รออยู่', (item) => item.key === 'active'],
      ['workflow', 'ของ workflow', (item) => item.key === 'workflow'],
      ['done', 'ทำแล้ว / ยกเลิก', (item) => item.key === 'done'],
    ];
    wrap.append(Kit().section(`Trigger ที่ตั้งไว้ (${items.length})`, 'เตือนความจำ งานของ agent และ trigger ของทุก workflow อยู่ที่เดียว', [
      button('btn pri', '+ เพิ่ม trigger', () => triggerEditor(null)),
      ...Kit().ioButtons({ onImport: importAll, onExport: exportAll, exportTitle: 'ส่งออก trigger ที่รออยู่ และชนิดที่สร้างเอง' }),
    ]));
    const listBox = el('div', 'mk-block');
    const draw = () => {
      const needle = query.trim().toLowerCase();
      const test = filters.find(([key]) => key === filter)[2];
      const visible = items.filter((item) => test(item) && (!needle || item.text.toLowerCase().includes(needle)));
      listBox.replaceChildren(Kit().grid(visible.map((item) => item.card()), items.length === 0 ? 'ยังไม่มี trigger — กด "+ เพิ่ม trigger" หรือบอก agent ในแชต เช่น "เตือนพรุ่งนี้ 9 โมงให้โทรหาแม่"' : 'ไม่พบรายการที่ตรงกับตัวกรอง', 'wide'));
    };
    const bar = Kit().filterBar({
      query,
      placeholder: 'ค้นหา trigger…',
      chips: filters.map(([key, label, test]) => ({ key, label, count: items.filter(test).length })),
      active: filter,
      onQuery: (value) => {
        query = value;
        draw();
      },
      onChip: (key) => {
        filter = key;
        M().renderHub();
      },
    });
    wrap.append(bar.node, listBox);
    draw();

    const types = pool();
    wrap.append(Kit().section(`ชนิดของ trigger (${types.length})`, 'สิ่งที่ trigger ฟังได้ · อีเมลและปฏิทินตั้งค่าแหล่งที่มาได้ในการ์ดของมัน · ชนิดที่สร้างเองใช้ได้ในหน้าผัง workflow', [
      button('btn', '+ เพิ่มชนิด', () => poolEditor(null), 'ชนิดแบบ poll (เรียก URL เป็นรอบ) หรือ webhook'),
    ]));
    wrap.append(Kit().grid([...types].sort((a, b) => Number(a.builtin === false) - Number(b.builtin === false) || 0).map(poolCard), 'ไม่มีชนิด trigger'));
    return wrap;
  }

  function onMessage(message) {
    M().ui.triggerDirty = false;
    if (message.type === 'calendar-calendars') {
      showCalendarPicker(message);
      return;
    }
    if (message.type === 'calendar-sync') {
      M().state.calendar = message.calendar;
      if (message.error) M().toast('เลือกปฏิทินไม่ได้', message.error, true);
      else if (message.saved) M().toast('เปลี่ยนปฏิทินแล้ว', 'กำลังเริ่ม sync ปฏิทินใหม่');
      if (M().state.view === 'hub' && M().ui.hubTab === 'triggers') M().renderHub();
      return;
    }
    if (pending && pending.title && (message.triggers || []).some((entry) => entry.title === pending.title)) {
      pending.popup.done();
      M().toast(`บันทึก "${pending.title}" แล้ว ✓`);
      pending = null;
    }
  }

  /** The workflows list came back (after a trigger type was saved). */
  function onPool(message) {
    if (pending && pending.pool && message.saved === pending.pool) {
      pending.popup.done();
      M().toast(`บันทึกชนิด "${pending.pool}" แล้ว ✓`);
      pending = null;
    }
    if (M().state.view === 'hub' && M().ui.hubTab === 'triggers') M().renderHub();
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.triggers = { render, onMessage, onPool };
})();
