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
  let connectAfterSave = null; // connection ids before "บันทึกและเชื่อมต่อ", to find the new one
  // Token fields an OAuth2 sign-in fills by itself; the form tucks them away.
  const OAUTH_TOKEN_FIELDS = new Set(['refreshToken', 'accessToken', 'expiresAt']);

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

  /**
   * Where the provider sends the browser back. A core on a server has one fixed address
   * (to register with the provider); on a computer it is a temporary local port.
   */
  function redirectUri(local) {
    return (M().state.settings && M().state.settings.oauthRedirectUri) || local;
  }

  /** A read-only value with a copy button, like the redirect URL of n8n's credential form. */
  function copyField(label, value, hint) {
    const box = el('div');
    const row = el('div', 'btns');
    const input = M().textInput(value);
    input.readOnly = true;
    input.style.flex = '1';
    input.onfocus = () => input.select();
    row.append(
      input,
      button('btn ghost', 'คัดลอก', () => {
        navigator.clipboard?.writeText(value).then(
          () => M().toast('คัดลอกแล้ว'),
          () => {},
        );
      }),
    );
    box.append(M().labelled(label, row));
    if (hint) box.append(el('p', 'hint', hint));
    return box;
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
      // The settings carry the server's OAuth redirect URL.
      if (!M().state.settings) M().send({ type: 'settings-get' });
    }
    if (!connectionsRequested && !M().state.connections) {
      connectionsRequested = true;
      M().send({ type: 'connector-connections' });
    }
    const wrap = el('div');
    const split = el('div', 'split');
    split.append(listPanel(), adding || selected ? editorPanel() : introPanel());
    wrap.append(split, toolKeysPanel(), connectionsPanel());
    return wrap;
  }

  // Keys of the lookup tools. One dropdown of services, like the accounts above and the
  // connections below; a key is kept on this machine only and is never sent back to the screen.
  const TOOL_KEYS = {
    SERPER_API_KEY: {
      label: 'Serper (serper.dev)',
      tools: 'web_search, map_search, youtube_search',
      hint: 'ค้นเว็บและแผนที่ได้แบบพื้นฐานอยู่แล้วโดยไม่ต้องมีคีย์ · ใส่คีย์เพื่อผลที่นิ่งกว่า มีคะแนนร้าน และ youtube_search (ต้องมีคีย์)',
      isSet: (settings) => Boolean(settings.toolKeys && settings.toolKeys.serper),
    },
    OPENWEATHER_API_KEY: {
      label: 'OpenWeatherMap (openweathermap.org)',
      tools: 'weather',
      hint: 'ต้องมีคีย์ weather จึงจะทำงาน',
      isSet: (settings) => Boolean(settings.toolKeys && settings.toolKeys.openweather),
    },
  };
  let toolKeyName = 'SERPER_API_KEY';

  function toolKeysPanel() {
    const panel = el('div', 'panel');
    panel.append(
      el('h3', '', 'คีย์เครื่องมือค้นหาและข้อมูล'),
      el('p', 'hint', 'เลือกบริการแล้ววางคีย์ · เก็บในเครื่องนี้เท่านั้น · คีย์ลับส่วนตัว (vault) อยู่ที่แท็บ คีย์ลับ'),
    );
    const settings = M().state.settings;
    if (!settings) return panel;
    const choose = selectOf(
      Object.entries(TOOL_KEYS).map(([key, spec]) => [key, `${spec.label} — ${spec.isSet(settings) ? '● ตั้งแล้ว' : '○ ยังไม่ตั้ง'}`]),
      toolKeyName,
    );
    choose.onchange = () => {
      toolKeyName = choose.value;
      rerender();
    };
    const spec = TOOL_KEYS[toolKeyName];
    const field = M().textInput('', spec.isSet(settings) ? 'ตั้งไว้แล้ว ◆ (วางคีย์ใหม่เพื่อเปลี่ยน)' : 'วาง API key ที่นี่', 'password');
    const actions = el('div', 'btns');
    actions.style.marginTop = '8px';
    actions.append(
      button('btn', 'บันทึก', () => {
        if (!field.value.trim()) return M().toast('ยังไม่ได้วางคีย์', 'วางคีย์ก่อนกดบันทึก', true);
        M().send({ type: 'settings-save', keys: { [toolKeyName]: field.value.trim() } });
        field.value = '';
      }),
    );
    if (spec.isSet(settings)) {
      actions.append(
        button('btn ghost', 'ลบคีย์', () => {
          if (confirm(`ลบคีย์ของ ${spec.label}?`)) M().send({ type: 'settings-save', keys: { [toolKeyName]: '' } });
        }),
      );
    }
    panel.append(M().labelled('บริการ', choose), el('p', 'hint', `ใช้กับเครื่องมือ: ${spec.tools} — ${spec.hint}`), M().labelled('API key', field), actions);
    return panel;
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
    const isOAuth2 = spec?.auth.kind === 'oauth2';
    let oauthInputs = null;
    if (isOAuth2) {
      box.append(
        copyField(
          'OAuth Redirect URL',
          redirectUri('http://127.0.0.1:<พอร์ตชั่วคราว>/callback'),
          'ใส่ URL นี้เป็น redirect / callback URL ในแอปที่สร้างไว้กับผู้ให้บริการ (เช่น Azure → Authentication → Web) ต้องตรงทุกตัวอักษร',
        ),
      );
      const own = entry?.oauth || {};
      oauthInputs = {
        authorizeUrl: M().textInput(own.authorizeUrl || spec.auth.authorizeUrl || '', 'https://…/authorize'),
        tokenUrl: M().textInput(own.tokenUrl || spec.auth.tokenUrl || '', 'https://…/token'),
        scopes: M().textInput((own.scopes || spec.auth.scopes || []).join(' '), 'scope คั่นด้วยช่องว่าง'),
      };
      for (const input of Object.values(oauthInputs)) input.style.width = '100%';
      box.append(
        M().labelled('Authorization URL', oauthInputs.authorizeUrl),
        M().labelled('Access Token URL', oauthInputs.tokenUrl),
        M().labelled('Scopes', oauthInputs.scopes),
        el('p', 'hint', 'ค่าเริ่มต้นมาจาก connector · แก้ได้ เช่น เปลี่ยน /common/ เป็น tenant ขององค์กร หรือเพิ่ม scope'),
      );
    }
    if (spec) {
      const tokens = el('details');
      tokens.append(el('summary', 'hint', 'Token (ได้เองหลังเชื่อมต่อ OAuth2 · ใส่เองได้ถ้ามีอยู่แล้ว)'));
      for (const field of spec.auth.fields) {
        const input = M().textInput('', field.placeholder || (entry ? 'ตั้งไว้แล้ว ◆ (เว้นว่าง = คงเดิม)' : ''), field.type === 'secret' ? 'password' : undefined);
        inputs[field.key] = input;
        const tucked = isOAuth2 && OAUTH_TOKEN_FIELDS.has(field.key);
        const target = tucked ? tokens : box;
        target.append(M().labelled(`${field.label}${field.required !== false && !tucked ? ' *' : ''}`, input));
        if (field.description) target.append(el('p', 'hint', field.description));
      }
      if (tokens.childElementCount > 1) box.append(tokens);
    }
    const makeDefault = el('input');
    makeDefault.type = 'checkbox';
    makeDefault.checked = Boolean(entry && entry.default);
    makeDefault.disabled = Boolean(entry && entry.default);
    const defaultLabel = M().labelled('ใช้เป็นค่าเริ่มต้นของ service นี้', makeDefault);
    box.append(defaultLabel);
    const actions = el('div');
    actions.style.marginTop = '10px';
    const save = (thenConnect) => {
      if (!name.value.trim()) return M().toast('กรอกไม่ครบ', 'ต้องมีชื่อ connection', true);
      const fields = {};
      for (const [key, input] of Object.entries(inputs)) {
        if (input.value) fields[key] = input.value;
      }
      // A value equal to the connector's own is not stored, so a fixed connector reaches it too.
      let oauth;
      if (oauthInputs) {
        const authorizeUrl = oauthInputs.authorizeUrl.value.trim();
        const tokenUrl = oauthInputs.tokenUrl.value.trim();
        const scopes = oauthInputs.scopes.value.trim().split(/\s+/).filter(Boolean);
        oauth = {
          authorizeUrl: authorizeUrl === (spec.auth.authorizeUrl || '') ? '' : authorizeUrl,
          tokenUrl: tokenUrl === (spec.auth.tokenUrl || '') ? '' : tokenUrl,
          scopes: scopes.join(' ') === (spec.auth.scopes || []).join(' ') ? [] : scopes,
        };
      }
      if (thenConnect) {
        if (entry) connectionWaiting = entry.id;
        else connectAfterSave = new Set(connections().map((item) => item.id));
      }
      M().send({
        type: 'connector-connection-save',
        ...(entry ? { id: entry.id } : {}),
        connection: {
          connector: entry ? entry.connector : connectionConnector,
          name: name.value.trim(),
          fields,
          default: makeDefault.checked,
          ...(oauth ? { oauth } : {}),
        },
      });
      if (thenConnect && entry) {
        connectionLink = null;
        M().send({ type: 'connector-connection-connect', id: entry.id });
      }
    };
    actions.append(button('btn', entry ? 'บันทึก' : 'เพิ่ม connection', () => save(false)));
    if (isOAuth2) {
      const busy = Boolean(entry) && connectionWaiting === entry.id;
      actions.append(button('btn', busy ? 'รอการเชื่อมต่อ…' : 'บันทึกและเชื่อมต่อ OAuth2', () => save(true)));
    }
    if (entry && isOAuth2) {
      const oauth = el('div');
      oauth.style.marginTop = '10px';
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
    const secretHint = el('p', 'hint');
    panel.append(M().labelled('Client secret', secret), secretHint);

    const tenant = M().textInput(entry ? entry.tenant || '' : '', 'common (ใช้ได้ทั้งบัญชีส่วนตัวและองค์กร)');
    const tenantLabel = M().labelled('Tenant', tenant);
    panel.append(tenantLabel);

    // What the provider needs to know, shown the way n8n's credential form does.
    const hosted = Boolean(M().state.settings && M().state.settings.oauthRedirectUri);
    const endpoints = el('div');
    panel.append(endpoints);

    const info = el('p', 'hint');
    const detected = el('p', 'hint');
    const applyProvider = () => {
      const service = provider.value;
      tenantLabel.hidden = service !== 'microsoft';
      secretHint.textContent =
        service === 'microsoft'
          ? 'ใส่เฉพาะแอปที่ redirect URI อยู่ใต้ platform “Web” (เช่นแอปที่ทำไว้ให้ n8n) · แอปแบบ “Mobile and desktop applications” เว้นว่าง'
          : '';
      endpoints.replaceChildren();
      if (service === 'microsoft') {
        const authority = `https://login.microsoftonline.com/${encodeURIComponent(tenant.value.trim() || 'common')}/oauth2/v2.0`;
        endpoints.append(
          copyField(
            'OAuth Redirect URL',
            redirectUri('http://localhost'),
            hosted
              ? 'Azure → App registrations → แอปนี้ → Authentication → เพิ่ม URI นี้ (มี secret: ใต้ “Web” · ไม่มี secret: ใต้ “Mobile and desktop applications”)'
              : 'Azure → Authentication → “Mobile and desktop applications” → เพิ่ม http://localhost',
          ),
          copyField('Authorization URL', `${authority}/authorize`),
          copyField('Access Token URL', `${authority}/token`),
        );
      } else {
        endpoints.append(
          copyField(
            'OAuth Redirect URL',
            redirectUri('http://127.0.0.1 (พอร์ตชั่วคราว ไม่ต้องลงทะเบียน)'),
            hosted ? 'Google Cloud Console → OAuth client ชนิด “Web application” → Authorized redirect URIs → เพิ่ม URI นี้' : '',
          ),
        );
      }
      info.textContent =
        service === 'google'
          ? hosted
            ? 'สร้าง OAuth client ชนิด “Web application” ใน Google Cloud Console แล้วเปิด API ที่ต้องใช้ (Gmail, Calendar, Sheets, Drive)'
            : 'สร้าง OAuth client ชนิด “Desktop app” ใน Google Cloud Console แล้วเปิด API ที่ต้องใช้ (Gmail, Calendar, Sheets, Drive) · redirect URI ไม่ต้องใส่ (ใช้ 127.0.0.1 ชั่วคราว)'
          : 'สร้าง app registration ใน Azure (Entra) ใส่ redirect URL ด้านบน แล้วให้สิทธิ์ Microsoft Graph: Mail, Calendars, Tasks, Files, User.Read, offline_access';
    };
    tenant.addEventListener('change', applyProvider);
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
    // "บันทึกและเชื่อมต่อ" on a new connection: open it and start its sign-in.
    if (message.saved && connectAfterSave) {
      const fresh = connections().find((entry) => !connectAfterSave.has(entry.id));
      connectAfterSave = null;
      if (fresh) {
        connectionAdding = false;
        connectionEditing = fresh.id;
        connectionWaiting = fresh.id;
        connectionLink = null;
        M().send({ type: 'connector-connection-connect', id: fresh.id });
        rerender();
        return;
      }
    }
    if (message.saved && !connectionWaiting) {
      connectionAdding = false;
      connectionEditing = null;
      connectionLink = null;
    }
    // The server sends the list again when a sign-in finishes.
    if (message.saved && connectionWaiting && connectionLink && findConnection(connectionWaiting)?.connected) {
      connectionWaiting = null;
      connectionLink = null;
      M().toast('เชื่อมต่อ OAuth2 แล้ว ✓');
    }
    rerender();
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.accounts = { render, onMessage, onConnections };
})();
