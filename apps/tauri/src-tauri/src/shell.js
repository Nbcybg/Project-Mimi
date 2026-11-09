// Injected by the Tauri shell before any page script runs (initialization_script).
// It is the shell's own code, not part of packages/ui: it defines MimiShell, forgets an old
// sign-in when the person has just chosen a server, and, while the UI cannot connect, shows
// why (the UI itself stays silent) with a way to sign in again or to change the server.
(function () {
  var CONNECT = '__CONNECT__';
  // The few calls the UI makes to its shell (the same names as the Electron shell's preload).
  // They reach Rust commands that exist on the desktop build only; elsewhere (Android, the
  // connect page) the answer is "not supported", which hides the switch in the settings.
  var NOT_SUPPORTED = { supported: false, openAtLogin: false };
  function command(name, args) {
    var internals = window.__TAURI_INTERNALS__;
    if (!internals || !internals.invoke || location.href.indexOf(CONNECT) === 0) return Promise.resolve(NOT_SUPPORTED);
    return internals.invoke(name, args).then(
      function (value) {
        return value;
      },
      function () {
        return NOT_SUPPORTED;
      },
    );
  }
  window.MimiShell = Object.freeze({
    platform: 'tauri',
    openAtLogin: function () {
      return command('open_at_login');
    },
    setOpenAtLogin: function (open) {
      return command('set_open_at_login', { open: open === true });
    },
    // Settings → บัญชีและเซิร์ฟเวอร์ → เปลี่ยนเซิร์ฟเวอร์: back to the connect page.
    changeServer: function () {
      location.href = CONNECT + '?change=1';
    },
  });
  // Desktop: the web Notification API is refused in this window, so the UI's notifications
  // (new message, reminder, approval) go to a native toast instead. Same shape as the web API,
  // so packages/ui needs no change. Android has its own path (MimiAndroid.notify).
  if (location.href.indexOf(CONNECT) !== 0 && window.__TAURI_INTERNALS__ && !/Android/i.test(navigator.userAgent)) {
    var Toast = function (title, options) {
      this.onclick = null;
      window.__TAURI_INTERNALS__
        .invoke('notify', { title: String(title), body: String((options && options.body) || '') })
        .catch(function () {});
    };
    Toast.prototype.close = function () {};
    Toast.permission = 'granted';
    Toast.requestPermission = function () {
      return Promise.resolve('granted');
    };
    try {
      Object.defineProperty(window, 'Notification', { value: Toast, configurable: true, writable: true });
    } catch (e) {
      /* keep the web one */
    }
  }
  // Desktop: only text gets a context menu (cut / copy / paste), like the Electron window; the
  // rest of the app is not a web page (no Back / Reload / Save as / Print on right click).
  if (!/Android/i.test(navigator.userAgent)) {
    document.addEventListener(
      'contextmenu',
      function (event) {
        var target = event.target;
        var editable = target && (target.isContentEditable || (target.closest && target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')));
        var selected = window.getSelection && String(window.getSelection()).length > 0;
        if (!editable && !selected) event.preventDefault();
      },
      true,
    );
  }
  if (location.href.indexOf(CONNECT) === 0) return;

  // The connect page sends "#fresh=1" after the person chose a server: a password remembered for
  // another server must not be tried on this one (and would keep the sign-in page from showing).
  try {
    var hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get('fresh') === '1') {
      ['mimi-token', 'mimi-webhook-base'].forEach(function (key) {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      });
      hash.delete('fresh');
      history.replaceState(null, '', location.pathname + location.search + '#' + hash.toString());
    }
  } catch (e) {
    /* storage unavailable: nothing to forget */
  }

  var violation = '';
  document.addEventListener('securitypolicyviolation', function (event) {
    if (String(event.violatedDirective).indexOf('connect-src') === 0) violation = event.blockedURI;
  });

  function signedIn() {
    try {
      return !!(localStorage.getItem('mimi-token') || sessionStorage.getItem('mimi-token'));
    } catch (e) {
      return false;
    }
  }

  function why() {
    var core = '';
    try {
      core = localStorage.getItem('mimi-core') || '';
    } catch (e) {
      /* none */
    }
    if (!core) return Promise.resolve('ยังไม่ได้ตั้งเซิร์ฟเวอร์');
    var host = core.replace(/^https?:\/\//, '');
    if (violation) return Promise.resolve('แอปบล็อกการเชื่อมต่อไป ' + violation + ' (CSP)');
    // no-cors answers whenever the server can be reached at all, whatever its CORS headers say.
    return fetch(core + '/health', { mode: 'no-cors', cache: 'no-store' }).then(
      function () {
        return fetch(core + '/health', { cache: 'no-store' }).then(
          function (response) {
            return signedIn()
              ? 'ติดต่อ ' + host + ' ได้ (HTTP ' + response.status + ') แต่ยังเชื่อมต่อแบบ WebSocket ไม่ได้ — รหัสผ่านที่จำไว้อาจใช้ไม่ได้ (กด "ล้างการเข้าสู่ระบบ") หรือเซิร์ฟเวอร์/พร็อกซีไม่รับ WebSocket จาก ' + location.origin
              : 'ติดต่อ ' + host + ' ได้ (HTTP ' + response.status + ') รอหน้าใส่รหัสผ่าน หรือกด "ล้างการเข้าสู่ระบบ"';
          },
          function () {
            return 'เซิร์ฟเวอร์ ' + host + ' ตอบกลับ แต่ไม่อนุญาตหน้าแอป (' + location.origin + ') — CORS: server ต้องเป็นเวอร์ชันที่รับ origin นี้ หรือตั้ง MIMI_ALLOWED_ORIGINS=' + location.origin;
          },
        );
      },
      function () {
        return 'ติดต่อ ' + host + ' ไม่ได้ — ตรวจที่อยู่ อินเทอร์เน็ต และพอร์ต (ถ้าเป็นเครือข่ายบ้าน: Wi‑Fi เดียวกัน และ firewall ของเครื่อง core)';
      },
    );
  }

  function boot() {
    var box = document.createElement('div');
    box.setAttribute(
      'style',
      'position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:2147483647;display:none;flex-direction:column;gap:6px;max-width:460px;padding:8px 10px;border-radius:12px;border:1px solid rgba(255,255,255,.3);background:rgba(20,20,30,.92);color:#fff;font:12px/1.4 system-ui,sans-serif',
    );
    var text = document.createElement('div');
    var row = document.createElement('div');
    row.setAttribute('style', 'display:flex;gap:6px;flex-wrap:wrap');
    function action(label, onclick) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('style', 'padding:6px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.35);background:transparent;color:#fff;font:inherit');
      button.onclick = onclick;
      row.appendChild(button);
    }
    action('เปลี่ยนเซิร์ฟเวอร์', function () {
      location.href = CONNECT + '?change=1';
    });
    action('ล้างการเข้าสู่ระบบ', function () {
      try {
        ['mimi-token', 'mimi-webhook-base'].forEach(function (key) {
          localStorage.removeItem(key);
          sessionStorage.removeItem(key);
        });
      } catch (e) {
        /* nothing to clear */
      }
      location.reload();
    });
    box.appendChild(text);
    box.appendChild(row);
    document.body.appendChild(box);

    var offlineSince = 0;
    var lastCheck = 0;
    var message = '';
    var sentCore = '';
    var sentToken = '';
    function tellAndroid() {
      // Android shell: the background connection needs the core and the token (the UI only
      // reports a token at sign-in, not for one remembered from an earlier run).
      var bridge = window.MimiAndroid;
      if (!bridge) return;
      try {
        var core = localStorage.getItem('mimi-core') || '';
        if (core && core !== sentCore && bridge.setCore) {
          bridge.setCore(core);
          sentCore = core;
        }
        var token = localStorage.getItem('mimi-token') || '';
        if (token && token !== sentToken && bridge.signedIn) {
          bridge.signedIn(token);
          sentToken = token;
        }
      } catch (e) {
        /* storage unavailable */
      }
    }
    var desktopSession = null;
    function tellDesktop() {
      // Desktop shell: the PC agent runs for the signed-in session (pcagent.rs); signing out
      // (no token) stops it. Only when the page has said something new.
      if (window.MimiAndroid || /Android/i.test(navigator.userAgent)) return;
      try {
        var core = localStorage.getItem('mimi-core') || '';
        var token = localStorage.getItem('mimi-token') || '';
        var key = core + '\n' + token;
        if (key === desktopSession) return;
        desktopSession = key;
        command('pc_session', { core: core, token: token });
      } catch (e) {
        /* storage unavailable */
      }
    }
    function refresh() {
      tellAndroid();
      tellDesktop();
      var conn = document.getElementById('conn');
      var offline = !conn || conn.textContent !== 'online';
      var now = Date.now();
      if (!offline) {
        offlineSince = 0;
        message = '';
      } else {
        if (!offlineSince) offlineSince = now;
        // Give the first connection a few seconds before calling it a failure.
        if (now - offlineSince > 5000 && now - lastCheck > 6000) {
          lastCheck = now;
          why().then(function (answer) {
            message = answer;
          });
        }
      }
      // A reconnect of a second or two is normal; say something only once it has lasted.
      var lasting = offline && offlineSince && now - offlineSince > 4000;
      text.textContent = lasting ? message || 'กำลังเชื่อมต่อ…' : '';
      text.style.display = lasting ? 'block' : 'none';
      // Only while the connection is failing: choosing a server and signing out live in Settings now.
      box.style.display = lasting ? 'flex' : 'none';
    }
    setInterval(refresh, 700);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
