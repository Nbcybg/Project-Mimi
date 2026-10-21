// Hub → บัญชี: Google / Microsoft OAuth accounts. Every account keeps its own OAuth
// client (client id / secret, and for Microsoft the tenant) and its own refresh token,
// so several Gmail / Outlook accounts can be used side by side. Tools, tool presets and
// workflow nodes pick an account; an empty choice means the account marked "ค่าเริ่มต้น".
(() => {
  'use strict';
  const M = () => window.Mimi;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const SERVICE = { google: 'Google', microsoft: 'Microsoft' };
  let selected = null; // account id being edited
  let adding = false; // true while adding a new account
  let addingProvider = 'google';
  let link = null; // { accountId, url } from the last oauth-auth-url
  let waiting = null; // account id with a sign-in in progress
  let pending = null; // account ids before a save, to find and select the new one
  let requested = false; // the list is fetched once; afterward the server broadcasts changes
  let connectionsRequested = false;
  let connectionEditing = null; // connection id being edited
  let connectionAdding = false;
  let connectionConnector = 'slack';
  let connectionLink = null; // { connectionId, url } from the last connector-auth-url
  let connectionWaiting = null; // connection id with a generic OAuth2 sign-in in progress

  const accounts = () => (M().state.settings && M().state.settings.accounts) || [];
  const find = (id) => accounts().find((entry) => entry.id === id) || null;
  const connectors = () =>
    (M().state.connectors || []).filter((entry) => entry.auth.kind !== 'none' && !entry.key.startsWith('google_'));
  const connections = () => M().state.connections || [];
  const findConnection = (id) => connections().find((entry) => entry.id === id) || null;
  function selectOf(options, value) {
    const node = el('select');
    for (const [key, label] of options) {
      const option = el('option', '', label);
      option.value = key;
      node.append(option);
    }
    node.value = value;
    return node;
  }

  function rerender() {
    if (M().state.view === 'hub' && M().ui.hubTab === 'accounts') M().renderHub();
  }

  function select(id) {
    selected = id;
    adding = false;
    rerender();
  }

  function render() {
    if (!requested && !M().state.settings?.accounts) {
      requested = true;
      M().send({ type: 'oauth-accounts' });
    }
    if (!connectionsRequested && !M().state.connections) {
      connectionsRequested = true;
      M().send({ type: 'connector-connections' });
    }
    const wrap = el('div');
    const split = el('div', 'split');
    split.append(listPanel(), adding || selected ? editorPanel() : introPanel());
    wrap.append(split, connectionsPanel());
    return wrap;
  }

  function connectionsPanel() {
    const panel = el('div', 'panel');
    panel.append(el('h3', '', 'Connector connections (API key / bot / PAT / OAuth2)'));
    panel.append(
      el(
        'p',
        'hint',
        'Service ที่ไม่ใช่ Google เก็บ credential แยกเป็น connection ได้หลายชุด · ชุดแรกเป็นค่าเริ่มต้น · Google ใช้บัญชีด้านบน',
      ),
    );
    if (connectionAdding || connectionEditing) {
      panel.append(connectionEditor());
      return panel;
    }
    const list = el('div', 'list');
    const nonGoogle = connections().filter((entry) => !entry.connector.startsWith('google_'));
    if (nonGoogle.length === 0) list.append(el('p', 'hint', '— ยังไม่มี connection —'));
    for (const entry of nonGoogle) {
      const spec = (M().state.connectors || []).find((item) => item.key === entry.connector);
      const item = el('div', 'item');
      const text = el('div');
      text.append(
        el('b', '', `${spec?.label || entry.connector} · ${entry.name}${entry.default ? ' ★' : ''}`),
        el('small', 'muted', ` · ${entry.connected ? '● พร้อมใช้' : '○ ยังไม่ครบ credential'} · ${entry.authKind}`),
      );
      item.append(text);
      const actions = el('div');
      actions.append(button('btn ghost', 'แก้ไข', () => {
        connectionEditing = entry.id;
        connectionAdding = false;
        rerender();
      }));
      if (!entry.default) {
        actions.append(button('btn ghost', 'ตั้งเป็นค่าเริ่มต้น', () => M().send({ type: 'connector-connection-default', id: entry.id })));
      }
      actions.append(button('btn ghost', 'ลบ', () => {
        if (confirm(`ลบ connection “${entry.name}” ของ ${spec?.label || entry.connector}?`)) {
          M().send({ type: 'connector-connection-remove', id: entry.id });
          if (connectionEditing === entry.id) connectionEditing = null;
        }
      }));
      item.append(actions);
      list.append(item);
    }
    panel.append(list);
    const add = el('div');
    add.style.marginTop = '10px';
    add.append(button('btn', '+ เพิ่ม connection', () => {
      connectionAdding = true;
      connectionEditing = null;
      connectionConnector = (connectors()[0] && connectors()[0].key) || 'slack';
      rerender();
    }));
    panel.append(add);
    return panel;
  }

  function connectionEditor() {
    const entry = connectionEditing ? findConnection(connectionEditing) : null;
    const box = el('div');
    const connector = selectOf(
      connectors().map((spec) => [spec.key, `${spec.label} (${spec.auth.kind})`]),
      entry ? entry.connector : connectionConnector,
    );
    connector.disabled = Boolean(entry);
    connector.onchange = () => {
      connectionConnector = connector.value;
      rerender();
    };
    box.append(M().labelled('Service', connector));
    const spec = (M().state.connectors || []).find((item) => item.key === (entry ? entry.connector : connectionConnector));
    const name = M().textInput(entry ? entry.name : '', spec ? `ชื่อเล่น เช่น งาน (${spec.label})` : 'ชื่อ connection');
    box.append(M().labelled('ชื่อ connection', name));
    const inputs = {};
    if (spec) {
      for (const field of spec.auth.fields) {
        const input = M().textInput('', field.placeholder || (entry ? 'ตั้งไว้แล้ว ◆ (เว้นว่าง = คงเดิม)' : ''), field.type === 'secret' ? 'password' : undefined);
        inputs[field.key] = input;
        box.append(M().labelled(`${field.label}${field.required !== false ? ' *' : ''}`, input));
        if (field.description) box.append(el('p', 'hint', field.description));
      }
    }
    const makeDefault = el('input');
    makeDefault.type = 'checkbox';
    makeDefault.checked = Boolean(entry && entry.default);
    makeDefault.disabled = Boolean(entry && entry.default);
    const defaultLabel = M().labelled('ใช้เป็นค่าเริ่มต้นของ service นี้', makeDefault);
    box.append(defaultLabel);
    const actions = el('div');
    actions.style.marginTop = '10px';
    actions.append(button('btn', entry ? 'บันทึก' : 'เพิ่ม connection', () => {
      if (!name.value.trim()) return M().toast('กรอกไม่ครบ', 'ต้องมีชื่อ connection', true);
      const fields = {};
      for (const [key, input] of Object.entries(inputs)) {
        if (input.value) fields[key] = input.value;
      }
      M().send({
        type: 'connector-connection-save',
        ...(entry ? { id: entry.id } : {}),
        connection: {
          connector: entry ? entry.connector : connectionConnector,
          name: name.value.trim(),
          fields,
          default: makeDefault.checked,
        },
      });
    }));
    if (entry && spec?.auth.kind === 'oauth2' && spec.auth.authorizeUrl && spec.auth.tokenUrl) {
      const oauth = el('div');
      oauth.style.marginTop = '10px';
      oauth.append(button('btn', connectionWaiting === entry.id ? 'รอการเชื่อมต่อ…' : 'เชื่อมต่อ OAuth2', () => {
        connectionWaiting = entry.id;
        connectionLink = null;
        rerender();
        M().send({ type: 'connector-connection-connect', id: entry.id });
      }));
      if (connectionWaiting === entry.id) {
        oauth.append(el('p', 'hint', 'เปิดลิงก์ด้านล่างแล้วทำตามขั้นตอนในเบราว์เซอร์'));
      }
      if (connectionLink && connectionLink.connectionId === entry.id) {
        const open = el('a', 'btn ghost', 'เปิดหน้าเชื่อมต่อ');
        open.href = connectionLink.url;
        open.target = '_blank';
        open.rel = 'noopener';
        open.style.textDecoration = 'none';
        open.style.marginLeft = '6px';
        oauth.append(open);
      }
      box.append(oauth);
    }
    actions.append(button('btn ghost', 'ยกเลิก', () => {
      connectionAdding = false;
      connectionEditing = null;
      rerender();
    }));
    box.append(actions);
    return box;
  }

  function listPanel() {
    const panel = el('div', 'panel');
    panel.append(el('h3', '', 'บัญชี Google / Microsoft'));
    panel.append(
      el(
        'p',
        'hint',
        'แต่ละบัญชีเก็บ client ของตัวเอง แยกจากกันได้ เช่น Gmail งาน + Gmail ส่วนตัว เครื่องมือจะเลือกบัญชีได้',
      ),
    );
    const list = el('div', 'list');
    for (const service of ['google', 'microsoft']) {
      const ofService = accounts().filter((entry) => entry.service === service);
      list.append(el('p', 'hint', SERVICE[service]));
      if (ofService.length === 0) list.append(el('p', 'hint', '— ยังไม่มีบัญชี —'));
      for (const entry of ofService) {
        const item = button(`item${entry.id === selected ? ' on' : ''}`, '', () => select(entry.id));
        const text = el('div');
        const state = entry.connected ? '● เชื่อมต่อแล้ว' : entry.hasSecret || service === 'microsoft' ? '○ ยังไม่เชื่อมต่อ' : '○ ยังไม่มี secret';
        text.append(
          el('b', '', `${entry.name}${entry.default ? ' ★' : ''}`),
          el(
            'small',
            'muted',
            ` · ${state}${entry.tenant && entry.tenant !== 'common' ? ` · tenant ${entry.tenant}` : ''}`,
          ),
        );
        item.append(text);
        list.append(item);
      }
    }
    panel.append(list);
    const add = el('div');
    add.style.marginTop = '10px';
    add.append(
      button('btn', '+ เพิ่มบัญชี', () => {
        adding = true;
        addingProvider = 'google';
        selected = null;
        rerender();
      }),
    );
    panel.append(add);
    return panel;
  }

  function introPanel() {
    const panel = el('div', 'panel');
    panel.append(
      el('h3', '', 'เลือกบัญชี'),
      el('p', 'hint', 'เลือกบัญชีจากรายการด้านซ้าย หรือกด “+ เพิ่มบัญชี” — ฟอร์มเดียวใช้ได้ทั้ง Google และ Microsoft'),
    );
    return panel;
  }

  function editorPanel() {
    const entry = selected ? find(selected) : null;
    const panel = el('div', 'panel');
    panel.append(el('h3', '', entry ? `แก้ไขบัญชี ${SERVICE[entry.service]}` : 'เพิ่มบัญชีใหม่'));

    const provider = selectOf(
      [
        ['google', 'Google (Gmail, Calendar, Sheets, Drive)'],
        ['microsoft', 'Microsoft (Outlook, OneDrive)'],
      ],
      entry ? entry.service : addingProvider,
    );
    provider.disabled = Boolean(entry);
    panel.append(M().labelled('บริการ', provider));

    const name = M().textInput(entry ? entry.name : '', 'ชื่อเล่น เช่น งาน, ส่วนตัว');
    panel.append(M().labelled('ชื่อบัญชี', name));

    const clientId = M().textInput(entry ? entry.clientId : '', 'วาง Client ID ที่นี่ — ระบบจะเลือกบริการให้เอง');
    panel.append(M().labelled('Client ID', clientId));

    const secret = M().textInput('', entry && entry.hasSecret ? 'ตั้งไว้แล้ว ◆ (เว้นว่าง = คงเดิม)' : 'Client secret (ถ้ามี)', 'password');
    panel.append(M().labelled('Client secret', secret));

    const tenant = M().textInput(entry ? entry.tenant || '' : '', 'common (ใช้ได้ทั้งบัญชีส่วนตัวและองค์กร)');
    const tenantLabel = M().labelled('Tenant', tenant);
    panel.append(tenantLabel);

    const info = el('p', 'hint');
    const detected = el('p', 'hint');
    const applyProvider = () => {
      const service = provider.value;
      tenantLabel.hidden = service !== 'microsoft';
      info.textContent =
        service === 'google'
          ? 'สร้าง OAuth client ชนิด “Desktop app” ใน Google Cloud Console แล้วเปิด API ที่ต้องใช้ (Gmail, Calendar, Sheets, Drive) · redirect URI ไม่ต้องใส่ (ใช้ 127.0.0.1 ชั่วคราว)'
          : 'สร้าง app registration ใน Azure (Entra) และเพิ่ม redirect URI แบบ “Mobile and desktop applications”: http://localhost';
    };
    const detectProvider = () => {
      const value = clientId.value.trim();
      let service = null;
      if (value.endsWith('.apps.googleusercontent.com')) service = 'google';
      else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) service = 'microsoft';
      detected.textContent = service ? `ตรวจพบ ${SERVICE[service]} จาก Client ID ✓` : '';
      if (service && !entry && provider.value !== service) {
        provider.value = service;
        addingProvider = service;
        applyProvider();
      }
    };
    if (!entry) {
      provider.onchange = () => {
        addingProvider = provider.value;
        detected.textContent = '';
        applyProvider();
      };
      clientId.oninput = detectProvider;
    }
    applyProvider();
    panel.append(detected, info);

    const row = el('div');
    row.style.marginTop = '10px';
    row.append(
      button('btn', entry ? 'บันทึก' : 'เพิ่มบัญชี', () => {
        if (!name.value.trim() || !clientId.value.trim()) return M().toast('กรอกไม่ครบ', 'ต้องมีชื่อบัญชีและ Client ID', true);
        pending = new Set(accounts().map((account) => account.id));
        M().send({
          type: 'oauth-account-save',
          ...(entry ? { id: entry.id } : {}),
          account: {
            service: provider.value,
            name: name.value.trim(),
            clientId: clientId.value.trim(),
            clientSecret: secret.value.trim() || undefined,
            tenant: provider.value === 'microsoft' ? tenant.value.trim() || undefined : undefined,
          },
        });
      }),
    );
    panel.append(row);

    if (entry) {
      const actions = el('div');
      actions.style.marginTop = '12px';
      if (!entry.default) {
        actions.append(
          button('btn ghost', 'ตั้งเป็นค่าเริ่มต้น', () => {
            M().send({ type: 'oauth-account-default', id: entry.id });
          }),
        );
      }
      const connect = button(entry.connected ? 'btn ghost' : 'btn', entry.connected ? 'เชื่อมต่อใหม่' : 'เชื่อมต่อ', () => {
        waiting = entry.id;
        M().send({ type: 'oauth-account-connect', id: entry.id });
      });
      connect.style.marginLeft = '6px';
      actions.append(connect);
      const remove = button('btn ghost', 'ลบ', () => {
        if (confirm(`ลบบัญชี “${entry.name}”? เครื่องมือที่อ้างบัญชีนี้จะใช้บัญชีเริ่มต้นแทน`)) {
          M().send({ type: 'oauth-account-remove', id: entry.id });
          selected = null;
        }
      });
      remove.style.marginLeft = '6px';
      actions.append(remove);
      panel.append(actions);

      if (waiting === entry.id) {
        panel.append(el('p', 'hint', 'กำลังรอการเชื่อมต่อ — เปิดลิงก์ด้านล่างแล้วทำตามขั้นตอนในเบราว์เซอร์'));
      }
      if (link && link.accountId === entry.id) {
        const open = el('a', 'btn', 'เปิดหน้าเชื่อมต่อ');
        open.href = link.url;
        open.target = '_blank';
        open.rel = 'noopener';
        open.style.textDecoration = 'none';
        panel.append(open);
        const copy = button('btn ghost', 'คัดลอกลิงก์', () => {
          navigator.clipboard?.writeText(link.url).then(
            () => M().toast('คัดลอกลิงก์แล้ว'),
            () => {},
          );
        });
        copy.style.marginLeft = '6px';
        panel.append(copy);
      }
    }
    return panel;
  }

  function onMessage(message) {
    if (message.type === 'oauth-accounts') {
      if (M().state.settings) M().state.settings.accounts = message.accounts;
      if (message.saved) {
        adding = false;
        waiting = null;
        link = null;
        if (pending) {
          const fresh = message.accounts.find((account) => !pending.has(account.id));
          if (fresh) selected = fresh.id;
          pending = null;
        }
        if (selected && !find(selected)) selected = null;
      }
      if (waiting && !find(waiting)) waiting = null;
      rerender();
      return;
    }
    if (message.type === 'oauth-auth-url') {
      link = message;
      rerender();
      return;
    }
    if (message.type === 'connector-auth-url') {
      connectionLink = message;
      connectionWaiting = message.connectionId;
      rerender();
    }
  }

  function onConnections(message) {
    if (message.saved) {
      connectionAdding = false;
      connectionEditing = null;
      connectionLink = null;
      connectionWaiting = null;
    }
    rerender();
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.accounts = { render, onMessage, onConnections };
})();
