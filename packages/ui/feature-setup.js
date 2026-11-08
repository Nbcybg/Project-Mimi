// First-run wizard: provider → starter agent → allowed folders → PC agent → test chat.
// Every step uses the ordinary messages (provider-connect, settings-save, agent-save,
// chat-create), so what it sets up is exactly what the Settings and Agent screens show.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const DONE_KEY = 'mimi.setupDone';
  const STEPS = ['ผู้ให้บริการ', 'Agent', 'โฟลเดอร์', 'PC agent', 'ทดสอบแชต'];
  const TEST_TEXT = 'สวัสดี ช่วยแนะนำตัวสั้น ๆ ว่าช่วยอะไรฉันได้บ้าง';

  /** { step, presets, presetId, agentName, created, dirsDraft } while the wizard is open. */
  let wizard = null;

  const settings = () => M().state.settings;
  const connected = () => (settings()?.providers || []).filter((provider) => provider.connected);
  const normalAgents = () => (M().state.agents || []).filter((agent) => agent.name !== 'overseer');
  const isOpen = () => Boolean(wizard) && Boolean(document.getElementById('setupWizard'));

  function open(step = 0) {
    wizard = { step, presets: null, presetId: 'secretary', agentName: '', created: '', dirsDraft: null };
    M().send({ type: 'agent-presets' });
    render();
  }

  function finish() {
    M().store.set(DONE_KEY, '1');
    wizard = null;
    M().closeOverlay();
  }

  /** The step can be left: the provider step needs a connected provider and a default chat model. */
  function stepReady(step) {
    if (step === 0) return connected().length > 0 && Boolean(settings()?.defaults?.model);
    if (step === 1) return normalAgents().length > 0;
    return true;
  }

  function providerStep(body) {
    body.append(
      el(
        'p',
        'hint',
        'เลือกวิธีที่ Mimi ใช้คุยกับโมเดล: แผนรายเดือนของ Claude หรือ ChatGPT (ไม่ต้องใช้ API key) หรือใส่ API key ของผู้ให้บริการใดก็ได้ เช่น anthropic, openai, deepseek, google · คีย์เก็บในเครื่องนี้เท่านั้น',
      ),
    );
    const list = connected();
    if (list.length > 0) {
      body.append(el('p', 'pill ok', `เชื่อมต่อแล้ว: ${list.map((provider) => provider.name).join(', ')}`));
      const select = M().modelSelect(settings().defaults.model || '', 'เลือกโมเดลหลักสำหรับแชต', 'model', false);
      select.onchange = () => {
        if (select.value) M().send({ type: 'settings-save', defaults: { model: select.value } });
      };
      body.append(M().labelled('โมเดลหลัก (ใช้กับ agent ที่ไม่ได้เลือกโมเดลเอง)', select));
      if (!settings().defaults.model) body.append(el('p', 'hint badtxt', 'เลือกโมเดลหลักก่อนไปขั้นต่อไป'));
    }
    const hook = window.MimiHooks && window.MimiHooks.providers;
    const panel = el('div');
    if (hook) hook.render(panel);
    body.append(panel);
  }

  function agentStep(body) {
    const existing = normalAgents();
    if (existing.length > 0 && !wizard.created) {
      body.append(el('p', 'pill ok', `มี agent แล้ว: ${existing.map((agent) => agent.displayName || agent.name).join(', ')} · ข้ามขั้นนี้ได้ หรือสร้างเพิ่มจากแบบด้านล่าง`));
    }
    if (wizard.created) body.append(el('p', 'pill ok', `สร้าง ${wizard.created} แล้ว ✓`));
    body.append(el('p', 'hint', 'เลือกแบบตั้งต้น แล้วแก้ชื่อ คำสั่ง และเครื่องมือได้ภายหลังที่หน้า Agent · agent ที่อ่านเว็บ/อีเมลจะไม่มีสิทธิ์รันคำสั่งบนเครื่อง (กันข้อความแปลกปลอมสั่งเครื่อง)'));
    if (!wizard.presets) {
      body.append(el('p', 'hint', 'กำลังโหลดแบบตั้งต้น…'));
      return;
    }
    const cards = el('div', 'setup-presets');
    for (const preset of wizard.presets) {
      const card = el('button', `setup-preset${preset.id === wizard.presetId ? ' on' : ''}`);
      card.type = 'button';
      card.append(el('b', '', preset.label), el('small', '', preset.summary), el('small', 'faint', `${preset.tools.length} เครื่องมือ`));
      card.onclick = () => {
        wizard.presetId = preset.id;
        wizard.agentName = '';
        render();
      };
      cards.append(card);
    }
    body.append(cards);
    const preset = wizard.presets.find((entry) => entry.id === wizard.presetId) || wizard.presets[0];
    const taken = new Set((M().state.agents || []).map((agent) => agent.name));
    let suggested = preset.name;
    for (let index = 2; taken.has(suggested); index += 1) suggested = `${preset.name}${index}`;
    const name = M().textInput(wizard.agentName || suggested, 'ชื่อ agent (a-z, 0-9)');
    name.oninput = () => {
      wizard.agentName = name.value;
    };
    const row = el('div', 'hstack');
    row.append(
      M().labelled('ชื่อ agent', name),
      button('btn pri', `สร้าง ${preset.label}`, () => {
        const id = name.value.trim().toLowerCase();
        if (!/^[a-z][a-z0-9_-]*$/.test(id)) return M().toast('ชื่อ agent ใช้ได้แค่ a-z, 0-9, - และ _', null, true);
        if (taken.has(id)) return M().toast(`มี agent ชื่อ "${id}" แล้ว`, 'เปลี่ยนชื่อ', true);
        wizard.created = id;
        M().send({
          type: 'agent-save',
          agent: {
            name: id,
            displayName: preset.displayName,
            description: preset.description,
            systemPrompt: preset.systemPrompt,
            models: {},
            tools: preset.tools,
            canMessage: [],
            budgets: { maxRounds: 12, maxTokens: 200000 },
          },
        });
      }),
    );
    body.append(row);
  }

  function folderStep(body) {
    const view = settings();
    body.append(
      el(
        'p',
        'hint',
        'agent อ่าน/เขียนไฟล์และรันคำสั่งได้เฉพาะในโฟลเดอร์เหล่านี้ (และโฟลเดอร์ย่อย) · หนึ่งโฟลเดอร์ต่อบรรทัด · ใส่เท่าที่จำเป็น',
      ),
    );
    const area = el('textarea');
    area.rows = 4;
    area.value = wizard.dirsDraft ?? (view.allowedDirs || []).join('\n');
    area.oninput = () => {
      wizard.dirsDraft = area.value;
    };
    body.append(
      area,
      button('btn', 'บันทึกโฟลเดอร์', () => {
        const dirs = area.value
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        if (dirs.length === 0) return M().toast('ต้องมีอย่างน้อยหนึ่งโฟลเดอร์', null, true);
        wizard.dirsDraft = null;
        M().send({ type: 'settings-save', allowedDirs: dirs });
      }),
    );
  }

  function pcStep(body) {
    const online = Boolean(M().state.pcOnline);
    body.append(el('p', `pill ${online ? 'ok' : 'todo'}`, online ? 'PC agent เชื่อมต่ออยู่ ✓' : 'PC agent ยังไม่ได้เชื่อมต่อ'));
    body.append(
      el(
        'p',
        'hint',
        'PC agent ให้ Mimi ใช้ไฟล์ หน้าจอ และเบราว์เซอร์บนคอมพิวเตอร์ของคุณ · แอปเดสก์ท็อป Mimi: คลิกไอคอน Mimi ที่ถาดระบบ (tray) แล้วเลือก "ให้ Mimi ใช้เครื่องนี้ (PC agent)" ·ถ้ารันจากโค้ด ใช้คำสั่ง "npm run pc-agent" บนเครื่องที่ต้องการ · ไม่ใช้ก็ข้ามได้ แชต งานอัตโนมัติ และ connector ยังทำงานได้',
      ),
    );
  }

  function testStep(body) {
    const agents = normalAgents();
    if (agents.length === 0) {
      body.append(el('p', 'hint badtxt', 'ยังไม่มี agent — ย้อนกลับไปสร้างในขั้น Agent'));
      return;
    }
    const pick = el('select');
    for (const agent of agents) {
      const option = el('option', '', agent.displayName || agent.name);
      option.value = agent.name;
      pick.append(option);
    }
    pick.value = wizard.created && agents.some((agent) => agent.name === wizard.created) ? wizard.created : agents[0].name;
    const text = M().textInput(TEST_TEXT, 'ข้อความทดสอบ');
    body.append(
      el('p', 'hint', settings().ready ? 'พร้อมแล้ว ลองทักดู — ถ้าโมเดลตอบกลับ แปลว่าตั้งค่าครบ' : 'ยังไม่พร้อม: ต้องมี agent และผู้ให้บริการของโมเดลแชตที่เชื่อมต่อแล้ว'),
      M().labelled('คุยกับ', pick),
      M().labelled('ข้อความ', text),
      button('btn pri', 'เปิดแชตและส่งข้อความ', () => startTest(pick.value, text.value.trim() || TEST_TEXT)),
    );
  }

  /** Opens (or creates) the direct chat and sends the test message once it is on screen. */
  function startTest(agent, text) {
    finish();
    M().setView('chat');
    M().send({ type: 'chat-create', kind: 'direct', agents: [agent] });
    const deadline = Date.now() + 8000;
    const tick = () => {
      const chat = M().state.chat;
      if (chat && chat.kind === 'direct' && chat.agents.includes(agent) && M().state.latest) {
        M().input.value = text;
        M().sendMessage();
        return;
      }
      if (Date.now() < deadline) setTimeout(tick, 150);
    };
    tick();
  }

  function render() {
    if (!wizard) return;
    const dialog = el('div', 'dialog form setup');
    dialog.id = 'setupWizard';
    dialog.append(el('h3', '', 'ตั้งค่าเริ่มต้น Mimi'));
    const steps = el('div', 'setup-steps');
    STEPS.forEach((label, index) => {
      // The first two steps are done when their result exists; the optional ones once passed.
      const done = index < 2 ? stepReady(index) : index < wizard.step;
      const chip = button(`chip${index === wizard.step ? ' on' : ''}${done ? ' done' : ''}`, `${index + 1}. ${label}`, () => {
        wizard.step = index;
        render();
      });
      steps.append(chip);
    });
    dialog.append(steps);
    const body = el('div', 'setup-body');
    [providerStep, agentStep, folderStep, pcStep, testStep][wizard.step](body);
    dialog.append(body);
    const foot = el('div', 'foot');
    foot.append(
      el('span', 'msg'),
      button('btn ghost', 'ข้ามไปก่อน', () => {
        if (confirm('ปิดตัวช่วยตั้งค่า? เปิดใหม่ได้ที่ ตั้งค่า → ตัวช่วยตั้งค่า')) finish();
      }),
    );
    if (wizard.step > 0) {
      foot.append(
        button('btn', 'ย้อนกลับ', () => {
          wizard.step -= 1;
          render();
        }),
      );
    }
    if (wizard.step < STEPS.length - 1) {
      const next = button('btn pri', 'ถัดไป', () => {
        wizard.step += 1;
        render();
      });
      if (!stepReady(wizard.step)) {
        next.disabled = true;
        next.title = wizard.step === 0 ? 'เชื่อมต่อผู้ให้บริการและเลือกโมเดลหลักก่อน' : 'สร้าง agent อย่างน้อยหนึ่งตัวก่อน';
      }
      foot.append(next);
    }
    dialog.append(foot);
    const scrim = M().overlay(dialog);
    // Clicking outside must not throw away the setup.
    scrim.onclick = null;
  }

  /** Called by the app after settings / agents / pc-status change. */
  function refresh() {
    if (isOpen()) render();
  }

  function onPresets(message) {
    if (!wizard) return;
    wizard.presets = message.presets || [];
    if (!wizard.presets.some((preset) => preset.id === wizard.presetId) && wizard.presets[0]) wizard.presetId = wizard.presets[0].id;
    refresh();
  }

  /** First start with nothing usable: open once, unless the user finished or skipped it before. */
  function maybeOpen() {
    const view = settings();
    if (!view || view.ready || M().store.get(DONE_KEY) === '1' || wizard) return false;
    open(connected().length > 0 && view.defaults?.model ? 1 : 0);
    return true;
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.setup = { open, maybeOpen, refresh, onPresets, isOpen, render };
})();
