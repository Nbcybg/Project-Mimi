// Hub → บัญชี: every account Mimi signs in with, as cards in four groups — Google / Microsoft
// (each keeps its own OAuth client and refresh token, so several can sit side by side),
// mailboxes (IMAP / POP3 / Gmail / Outlook, feature-mail.js), connections of other services,
// and the keys of the lookup tools. Adding and editing happen in popups; deleting asks first.
(() => {
  'use strict';
  const M = () => window.Mimi;
  const Kit = () => window.MimiKit;
  const el = (tag, cls, text) => M().el(tag, cls, text);
  const button = (cls, text, onClick, title) => M().button(cls, text, onClick, title);

  const SERVICE = { google: 'Google', microsoft: 'Microsoft' };
  let link = null; // { accountId, url } from the last oauth-auth-url
  let waiting = null; // account id with a sign-in in progress
  let pending = null; // account ids before a save, to find the new one
  let requested = false; // the list is fetched once; afterward the server broadcasts changes
  let connectionsRequested = false;
  let connectionLink = null; // { connectionId, url } from the last connector-auth-url
  let connectionWaiting = null; // connection id with a generic OAuth2 sign-in in progress
  let connectAfterSave = null; // connection ids before "บันทึกและเชื่อมต่อ", to find the new one
  /** The account popup that is open: { id, popup } — it follows sign-in progress. */
  let accountPopup = null;
  let connectionPopup = null;
  // Token fields an OAuth2 sign-in fills by itself; the form tucks them away.
  const OAUTH_TOKEN_FIELDS = new Set(['refreshToken', 'accessToken', 'expiresAt']);

  const accounts = () => (M().state.settings && M().state.settings.accounts) || [];
  const find = (id) => accounts().find((entry) => entry.id === id) || null;
  const connectors = () =>
    (M().state.connectors || []).filter((entry) => entry.auth.kind !== 'none' && !entry.key.startsWith('google_'));
  const connections = () => M().state.connections || [];
  const findConnection = (id) => connections().find((entry) => entry.id === id) || null;

  /**
   * Where the provider sends the browser back. A core on a server has one fixed address
   * (to register with the provider); on a computer it is a temporary local port.
   */
  function redirectUri(local) {
    return (M().state.settings && M().state.settings.oauthRedirectUri) || local;
  }

  /** A read-only value with a copy button, like the redirect URL of n8n's credential form. */
  function copyField(label, value, hint) {
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
    return Kit().field(label, row, hint);
  }

  function rerender() {
    if (M().state.view === 'hub' && M().ui.hubTab === 'accounts') M().renderHub();
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
    wrap.append(accountsBlock());
    const mail = window.MimiHooks && window.MimiHooks.mail;
    if (mail && mail.section) wrap.append(mail.section());
    wrap.append(connectionsBlock(), toolKeysBlock());
    return wrap;
  }

  // ---------- Google / Microsoft ----------
  function accountState(entry) {
    if (entry.connected) return ['ok', 'เชื่อมต่อแล้ว'];
    if (waiting === entry.id) return ['warn', 'รอเชื่อมต่อ…'];
    return ['todo', entry.hasSecret || entry.service === 'microsoft' ? 'ยังไม่เชื่อมต่อ' : 'ยังไม่มี secret'];
  }

  function connect(entry) {
    waiting = entry.id;
    link = null;
    M().send({ type: 'oauth-account-connect', id: entry.id });
    openAccount(entry);
  }

  async function removeAccount(entry, popup) {
    if (!(await Kit().confirmDelete(`บัญชี "${entry.name}"`, 'เครื่องมือและ workflow ที่อ้างบัญชีนี้จะใช้บัญชีเริ่มต้นแทน · token ที่เก็บไว้จะถูกลบ'))) return;
    M().send({ type: 'oauth-account-remove', id: entry.id });
    popup?.done();
  }

  function accountsBlock() {
    const block = el('div', 'mk-block');
    block.append(Kit().section('Google / Microsoft', 'Gmail, Calendar, Sheets, Drive, Outlook, OneDrive, To Do · มีหลายบัญชีได้ เช่น งาน + ส่วนตัว · ★ = บัญชีเริ่มต้นของบริการนั้น', [
      button('btn pri', '+ เพิ่มบัญชี', () => openAccount(null)),
    ]));
    block.append(Kit().grid(accounts().map((entry) => Kit().card({
      title: `${entry.name}${entry.default ? ' ★' : ''}`,
      sub: `${SERVICE[entry.service]}${entry.tenant && entry.tenant !== 'common' ? ` · tenant ${entry.tenant}` : ''}`,
      icon: entry.service === 'google' ? 'G' : 'M',
      state: accountState(entry),
      onOpen: () => openAccount(entry),
      actions: [
        { label: entry.connected ? 'เชื่อมต่อใหม่' : 'เชื่อมต่อ', pri: !entry.connected, onClick: () => connect(entry) },
        { label: 'แก้ไข', onClick: () => openAccount(entry) },
        entry.default ? null : { label: 'ตั้งเป็นค่าเริ่มต้น', onClick: () => M().send({ type: 'oauth-account-default', id: entry.id }) },
        { label: 'ลบ', danger: true, onClick: () => removeAccount(entry) },
      ],
    })), 'ยังไม่มีบัญชี — กด "+ เพิ่มบัญชี" แล้ววาง Client ID จาก Google Cloud หรือ Azure'));
    return block;
  }

  /** The account popup: the OAuth client form, then (once saved) connecting it. */
  function openAccount(entry) {
    if (accountPopup) accountPopup.popup.done();
    const popup = Kit().modal({ title: entry ? `บัญชี ${SERVICE[entry.service]}: ${entry.name}` : 'เพิ่มบัญชี Google / Microsoft', size: 'wide', onClose: () => {
      if (accountPopup && accountPopup.popup === popup) accountPopup = null;
    } });
    accountPopup = { id: entry ? entry.id : null, popup };
    paintAccount();
  }

  function paintAccount() {
    if (!accountPopup) return;
    const { popup } = accountPopup;
    const entry = accountPopup.id ? find(accountPopup.id) : null;
    const body = [];
    const provider = Kit().select([['google', 'Google (Gmail, Calendar, Sheets, Drive)'], ['microsoft', 'Microsoft (Outlook, OneDrive, To Do)']], entry ? entry.service : 'google');
    provider.disabled = Boolean(entry);
    const name = M().textInput(entry ? entry.name : '', 'ชื่อเล่น เช่น งาน, ส่วนตัว');
    const top = el('div', 'mk-grid2');
    top.append(Kit().field('บริการ', provider), Kit().field('ชื่อบัญชี', name));
    body.push(top);
    if (entry) {
      const [cls, text] = accountState(entry);
      const status = el('div', 'hstack');
      status.append(el('span', `pill ${cls}`, text));
      if (waiting === entry.id) status.append(el('span', 'hint', 'เปิดหน้าเชื่อมต่อแล้วทำตามขั้นตอนในเบราว์เซอร์'));
      if (link && link.accountId === entry.id) {
        const open = el('a', 'btn pri', 'เปิดหน้าเชื่อมต่อ ↗');
        open.href = link.url;
        open.target = '_blank';
        open.rel = 'noopener';
        open.style.textDecoration = 'none';
        status.append(open, button('btn ghost sm', 'คัดลอกลิงก์', () => navigator.clipboard?.writeText(link.url).then(() => M().toast('คัดลอกลิงก์แล้ว'), () => {})));
      }
      body.push(status);
    }
    const clientId = M().textInput(entry ? entry.clientId : '', 'วาง Client ID ที่นี่ — ระบบเลือกบริการให้เอง');
    const secret = M().textInput('', entry && entry.hasSecret ? 'ตั้งไว้แล้ว ◆ (เว้นว่าง = คงเดิม)' : 'Client secret (ถ้ามี)', 'password');
    const secretHint = el('p', 'hint');
    const tenant = M().textInput(entry ? entry.tenant || '' : '', 'common (ใช้ได้ทั้งบัญชีส่วนตัวและองค์กร)');
    const tenantBox = Kit().field('Tenant', tenant);
    const detected = el('p', 'hint');
    const info = el('p', 'hint');
    const endpoints = el('div');
    const hosted = Boolean(M().state.settings && M().state.settings.oauthRedirectUri);
    const applyProvider = () => {
      const service = provider.value;
      tenantBox.hidden = service !== 'microsoft';
      secretHint.textContent = service === 'microsoft'
        ? 'ใส่เฉพาะแอปที่ redirect URI อยู่ใต้ platform “Web” · แอปแบบ “Mobile and desktop applications” เว้นว่าง'
        : '';
      endpoints.replaceChildren();
      if (service === 'microsoft') {
        const authority = `https://login.microsoftonline.com/${encodeURIComponent(tenant.value.trim() || 'common')}/oauth2/v2.0`;
        endpoints.append(
          copyField('OAuth Redirect URL', redirectUri('http://localhost'), hosted
            ? 'Azure → App registrations → แอปนี้ → Authentication → เพิ่ม URI นี้'
            : 'Azure → Authentication → “Mobile and desktop applications” → เพิ่ม http://localhost'),
          copyField('Authorization URL', `${authority}/authorize`),
          copyField('Access Token URL', `${authority}/token`),
        );
      } else {
        endpoints.append(copyField('OAuth Redirect URL', redirectUri('http://127.0.0.1 (พอร์ตชั่วคราว ไม่ต้องลงทะเบียน)'), hosted ? 'Google Cloud Console → OAuth client ชนิด “Web application” → Authorized redirect URIs → เพิ่ม URI นี้' : ''));
      }
      info.textContent = service === 'google'
        ? `สร้าง OAuth client ชนิด “${hosted ? 'Web application' : 'Desktop app'}” ใน Google Cloud Console แล้วเปิด API ที่ต้องใช้ (Gmail, Calendar, Sheets, Drive)`
        : 'สร้าง app registration ใน Azure (Entra) ใส่ redirect URL ด้านบน แล้วให้สิทธิ์ Microsoft Graph: Mail, Calendars, Tasks, Files, User.Read, offline_access';
    };
    tenant.addEventListener('change', applyProvider);
    if (!entry) {
      provider.onchange = applyProvider;
      clientId.oninput = () => {
        const value = clientId.value.trim();
        let service = null;
        if (value.endsWith('.apps.googleusercontent.com')) service = 'google';
        else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) service = 'microsoft';
        detected.textContent = service ? `ตรวจพบ ${SERVICE[service]} จาก Client ID ✓` : '';
        if (service && provider.value !== service) {
          provider.value = service;
          applyProvider();
        }
      };
    }
    applyProvider();
    const how = el('details');
    if (!entry) how.open = true;
    how.append(el('summary', 'hint', 'ตั้งค่า OAuth client (Client ID / secret / redirect URL)'), info, Kit().field('Client ID', clientId), detected, Kit().field('Client secret', secret), secretHint, tenantBox, endpoints);
    body.push(how);
    popup.setBody(body);
    popup.setTitle(entry ? `บัญชี ${SERVICE[entry.service]}: ${entry.name}` : 'เพิ่มบัญชี Google / Microsoft');
    const save = () => {
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
    };
    const left = entry
      ? [button('btn danger', 'ลบ', () => removeAccount(entry, popup)), entry.default ? null : button('btn ghost', 'ตั้งเป็นค่าเริ่มต้น', () => M().send({ type: 'oauth-account-default', id: entry.id }))]
      : [];
    const right = [button('btn ghost', 'ปิด', () => popup.close()), button(entry ? 'btn' : 'btn pri', entry ? 'บันทึก' : 'บันทึก แล้วเชื่อมต่อต่อ', save)];
    if (entry) right.push(button(entry.connected ? 'btn' : 'btn pri', entry.connected ? 'เชื่อมต่อใหม่' : 'เชื่อมต่อ', () => connect(entry)));
    popup.setFoot(right.filter(Boolean), left.filter(Boolean));
    popup.dirty = false;
  }

  // ---------- connections of other services ----------
  async function removeConnection(entry, popup) {
    const spec = (M().state.connectors || []).find((item) => item.key === entry.connector);
    if (!(await Kit().confirmDelete(`connection "${entry.name}"`, `ของ ${spec?.label || entry.connector} · workflow และเครื่องมือที่ใช้อยู่จะใช้ connection เริ่มต้นแทน`))) return;
    M().send({ type: 'connector-connection-remove', id: entry.id });
    popup?.done();
  }

  function connectionsBlock() {
    const block = el('div', 'mk-block');
    block.append(Kit().section('Connection ของบริการอื่น', 'API key / bot token / OAuth2 ของ Slack, Notion, GitHub ฯลฯ · บริการเดียวมีได้หลายชุด · ★ = ชุดเริ่มต้น', [
      button('btn', '+ เพิ่ม connection', () => openConnection(null)),
    ]));
    const list = connections().filter((entry) => !entry.connector.startsWith('google_'));
    block.append(Kit().grid(list.map((entry) => {
      const spec = (M().state.connectors || []).find((item) => item.key === entry.connector);
      return Kit().card({
        title: `${entry.name}${entry.default ? ' ★' : ''}`,
        sub: `${spec?.label || entry.connector} · ${entry.authKind}`,
        icon: (spec?.label || entry.connector).slice(0, 2).toUpperCase(),
        state: entry.connected ? ['ok', 'พร้อมใช้'] : ['todo', 'ยังไม่ครบ'],
        onOpen: () => openConnection(entry),
        actions: [
          { label: 'แก้ไข', onClick: () => openConnection(entry) },
          entry.default ? null : { label: 'ตั้งเป็นค่าเริ่มต้น', onClick: () => M().send({ type: 'connector-connection-default', id: entry.id }) },
          { label: 'ลบ', danger: true, onClick: () => removeConnection(entry) },
        ],
      });
    }), 'ยังไม่มี connection — บริการที่ต้องใช้ credential จะขึ้นว่า "ต้องตั้งค่า" ในแท็บ Node & เครื่องมือ'));
    return block;
  }

  function openConnection(entry, connectorKey) {
    if (connectionPopup) connectionPopup.popup.done();
    const popup = Kit().modal({ title: '', size: 'wide', onClose: () => {
      if (connectionPopup && connectionPopup.popup === popup) connectionPopup = null;
    } });
    connectionPopup = { id: entry ? entry.id : null, connector: connectorKey || (entry ? entry.connector : (connectors()[0] && connectors()[0].key) || 'slack'), popup };
    paintConnection();
  }

  function paintConnection() {
    if (!connectionPopup) return;
    const { popup } = connectionPopup;
    const entry = connectionPopup.id ? findConnection(connectionPopup.id) : null;
    const body = [];
    const connector = Kit().select(connectors().map((spec) => [spec.key, `${spec.label} (${spec.auth.kind})`]), entry ? entry.connector : connectionPopup.connector);
    connector.disabled = Boolean(entry);
    connector.onchange = () => {
      connectionPopup.connector = connector.value;
      paintConnection();
    };
    const spec = (M().state.connectors || []).find((item) => item.key === (entry ? entry.connector : connectionPopup.connector));
    const name = M().textInput(entry ? entry.name : '', spec ? `ชื่อเล่น เช่น งาน (${spec.label})` : 'ชื่อ connection');
    const top = el('div', 'mk-grid2');
    top.append(Kit().field('บริการ', connector), Kit().field('ชื่อ connection', name));
    body.push(top);
    const inputs = {};
    const isOAuth2 = spec?.auth.kind === 'oauth2';
    let oauthInputs = null;
    if (isOAuth2) {
      body.push(copyField('OAuth Redirect URL', redirectUri('http://127.0.0.1:<พอร์ตชั่วคราว>/callback'), 'ใส่ URL นี้เป็น redirect / callback URL ในแอปที่สร้างไว้กับผู้ให้บริการ ต้องตรงทุกตัวอักษร'));
      const own = entry?.oauth || {};
      oauthInputs = {
        authorizeUrl: M().textInput(own.authorizeUrl || spec.auth.authorizeUrl || '', 'https://…/authorize'),
        tokenUrl: M().textInput(own.tokenUrl || spec.auth.tokenUrl || '', 'https://…/token'),
        scopes: M().textInput((own.scopes || spec.auth.scopes || []).join(' '), 'scope คั่นด้วยช่องว่าง'),
      };
      body.push(Kit().field('Authorization URL', oauthInputs.authorizeUrl), Kit().field('Access Token URL', oauthInputs.tokenUrl), Kit().field('Scopes', oauthInputs.scopes, 'ค่าเริ่มต้นมาจาก connector · แก้ได้ เช่น เปลี่ยน /common/ เป็น tenant ขององค์กร'));
    }
    if (spec) {
      const tokens = el('details');
      tokens.append(el('summary', 'hint', 'Token (ได้เองหลังเชื่อมต่อ OAuth2 · ใส่เองได้ถ้ามีอยู่แล้ว)'));
      for (const field of spec.auth.fields) {
        const input = M().textInput('', field.placeholder || (entry ? 'ตั้งไว้แล้ว ◆ (เว้นว่าง = คงเดิม)' : ''), field.type === 'secret' ? 'password' : undefined);
        inputs[field.key] = input;
        const tucked = isOAuth2 && OAUTH_TOKEN_FIELDS.has(field.key);
        const node = Kit().field(`${field.label}${field.required !== false && !tucked ? ' *' : ''}`, input, field.description);
        if (tucked) tokens.append(node);
        else body.push(node);
      }
      if (tokens.childElementCount > 1) body.push(tokens);
    }
    const makeDefault = el('label', 'wcheck');
    const defaultBox = el('input');
    defaultBox.type = 'checkbox';
    defaultBox.checked = Boolean(entry && entry.default);
    defaultBox.disabled = Boolean(entry && entry.default);
    makeDefault.append(defaultBox, el('span', '', 'ใช้เป็นค่าเริ่มต้นของบริการนี้'));
    body.push(makeDefault);
    if (entry && isOAuth2 && (connectionWaiting === entry.id || (connectionLink && connectionLink.connectionId === entry.id))) {
      const row = el('div', 'hstack');
      row.append(el('span', 'hint', 'เปิดหน้าเชื่อมต่อแล้วทำตามขั้นตอนในเบราว์เซอร์'));
      if (connectionLink && connectionLink.connectionId === entry.id) {
        const open = el('a', 'btn pri', 'เปิดหน้าเชื่อมต่อ ↗');
        open.href = connectionLink.url;
        open.target = '_blank';
        open.rel = 'noopener';
        open.style.textDecoration = 'none';
        row.append(open);
      }
      body.push(row);
    }
    popup.setTitle(entry ? `แก้ไข connection: ${entry.name}` : 'เพิ่ม connection');
    popup.setBody(body);
    const save = (thenConnect) => {
      if (!name.value.trim()) return M().toast('กรอกไม่ครบ', 'ต้องมีชื่อ connection', true);
      const fields = {};
      for (const [key, input] of Object.entries(inputs)) if (input.value) fields[key] = input.value;
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
      connectionPopup.saving = !thenConnect;
      M().send({
        type: 'connector-connection-save',
        ...(entry ? { id: entry.id } : {}),
        connection: { connector: entry ? entry.connector : connectionPopup.connector, name: name.value.trim(), fields, default: defaultBox.checked, ...(oauth ? { oauth } : {}) },
      });
      if (thenConnect && entry) {
        connectionLink = null;
        M().send({ type: 'connector-connection-connect', id: entry.id });
      }
    };
    const right = [button('btn ghost', 'ปิด', () => popup.close()), button(isOAuth2 ? 'btn' : 'btn pri', 'บันทึก', () => save(false))];
    if (isOAuth2) right.push(button('btn pri', entry && connectionWaiting === entry.id ? 'รอการเชื่อมต่อ…' : 'บันทึกและเชื่อมต่อ OAuth2', () => save(true)));
    popup.setFoot(right, entry ? [button('btn danger', 'ลบ', () => removeConnection(entry, popup))] : []);
    popup.dirty = false;
  }

  // ---------- keys of the lookup tools ----------
  // A key is kept on this machine only and is never sent back to the screen.
  const TOOL_KEYS = {
    SERPER_API_KEY: {
      label: 'Serper (serper.dev)',
      tools: 'web_search, map_search, youtube_search',
      hint: 'ค้นเว็บและแผนที่ได้แบบพื้นฐานอยู่แล้วโดยไม่ต้องมีคีย์ · ใส่คีย์เพื่อผลที่นิ่งกว่า มีคะแนนร้าน และ youtube_search',
      isSet: (settings) => Boolean(settings.toolKeys && settings.toolKeys.serper),
    },
    OPENWEATHER_API_KEY: {
      label: 'OpenWeatherMap (openweathermap.org)',
      tools: 'weather',
      hint: 'ต้องมีคีย์ weather จึงจะทำงาน',
      isSet: (settings) => Boolean(settings.toolKeys && settings.toolKeys.openweather),
    },
  };

  function editToolKey(key) {
    const spec = TOOL_KEYS[key];
    const settings = M().state.settings || {};
    const field = M().textInput('', spec.isSet(settings) ? 'ตั้งไว้แล้ว ◆ (วางคีย์ใหม่เพื่อเปลี่ยน)' : 'วาง API key ที่นี่', 'password');
    const popup = Kit().modal({ title: `คีย์ ${spec.label}`, size: 'sm', body: [el('p', 'hint', `ใช้กับเครื่องมือ: ${spec.tools} — ${spec.hint}`), Kit().field('API key', field)] });
    popup.setFoot([
      button('btn ghost', 'ยกเลิก', () => popup.close()),
      button('btn pri', 'บันทึก', () => {
        if (!field.value.trim()) return M().toast('ยังไม่ได้วางคีย์', null, true);
        M().send({ type: 'settings-save', keys: { [key]: field.value.trim() } });
        popup.done();
      }),
    ]);
  }

  async function removeToolKey(key) {
    if (!(await Kit().confirmDelete(`คีย์ของ ${TOOL_KEYS[key].label}`, `เครื่องมือ ${TOOL_KEYS[key].tools} จะกลับไปใช้แบบไม่มีคีย์ (ถ้าทำได้)`))) return;
    M().send({ type: 'settings-save', keys: { [key]: '' } });
  }

  function toolKeysBlock() {
    const block = el('div', 'mk-block');
    block.append(Kit().section('คีย์ของเครื่องมือค้นหาและข้อมูล', 'เก็บในเครื่องนี้เท่านั้น · API key อื่น ๆ ที่เครื่องมือของคุณอ้างถึงอยู่ที่แท็บ คีย์ลับ', []));
    const settings = M().state.settings;
    if (!settings) return block;
    block.append(Kit().grid(Object.entries(TOOL_KEYS).map(([key, spec]) => {
      const set = spec.isSet(settings);
      return Kit().card({
        title: spec.label,
        sub: spec.tools,
        state: set ? ['ok', 'ตั้งแล้ว'] : ['todo', 'ยังไม่ตั้ง'],
        desc: spec.hint,
        actions: [{ label: set ? 'เปลี่ยนคีย์' : 'ใส่คีย์', pri: !set, onClick: () => editToolKey(key) }, set ? { label: 'ลบ', danger: true, onClick: () => removeToolKey(key) } : null],
      });
    })));
    return block;
  }

  function onMessage(message) {
    if (message.type === 'oauth-accounts') {
      if (M().state.settings) M().state.settings.accounts = message.accounts;
      if (message.saved) {
        // A new account: keep its popup open on the next step, connecting it.
        if (pending && accountPopup && !accountPopup.id) {
          const fresh = message.accounts.find((account) => !pending.has(account.id));
          if (fresh) {
            accountPopup.id = fresh.id;
            M().toast('บันทึกบัญชีแล้ว ✓', 'กด "เชื่อมต่อ" เพื่อลงชื่อเข้าใช้');
          }
        } else if (pending && accountPopup) {
          M().toast('บันทึกแล้ว ✓');
        }
        pending = null;
        if (link && !find(link.accountId)) link = null;
      }
      if (waiting && find(waiting)?.connected) {
        M().toast('เชื่อมต่อบัญชีแล้ว ✓');
        waiting = null;
        link = null;
      }
      if (waiting && !find(waiting)) waiting = null;
      if (accountPopup && accountPopup.id && !find(accountPopup.id)) accountPopup.popup.done();
      else paintAccount();
      rerender();
      return;
    }
    if (message.type === 'oauth-auth-url') {
      link = message;
      paintAccount();
      return;
    }
    if (message.type === 'connector-auth-url') {
      connectionLink = message;
      connectionWaiting = message.connectionId;
      paintConnection();
    }
  }

  function onConnections(message) {
    // "บันทึกและเชื่อมต่อ" on a new connection: open it and start its sign-in.
    if (message.saved && connectAfterSave) {
      const fresh = connections().find((entry) => !connectAfterSave.has(entry.id));
      connectAfterSave = null;
      if (fresh) {
        connectionWaiting = fresh.id;
        connectionLink = null;
        if (connectionPopup) connectionPopup.id = fresh.id;
        M().send({ type: 'connector-connection-connect', id: fresh.id });
        paintConnection();
        rerender();
        return;
      }
    }
    if (message.saved && connectionPopup && connectionPopup.saving) {
      connectionPopup.popup.done();
      M().toast('บันทึก connection แล้ว ✓');
    }
    // The server sends the list again when a sign-in finishes.
    if (message.saved && connectionWaiting && findConnection(connectionWaiting)?.connected) {
      connectionWaiting = null;
      connectionLink = null;
      M().toast('เชื่อมต่อ OAuth2 แล้ว ✓');
      if (connectionPopup) connectionPopup.popup.done();
    }
    rerender();
  }

  window.MimiHooks = window.MimiHooks || {};
  window.MimiHooks.accounts = { render, onMessage, onConnections, openConnection };
})();
