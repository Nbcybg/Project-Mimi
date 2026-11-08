// Injected by the Tauri shell before any page script runs (initialization_script).
// It is the shell's own code, not part of packages/ui: it defines MimiShell, forgets an old
// sign-in when the person has just chosen a server, and, while the UI cannot connect, shows
// why (the UI itself stays silent) with a way to sign in again or to change the server.
(function () {
  window.MimiShell = Object.freeze({ platform: 'tauri' });
  var CONNECT = '__CONNECT__';
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
    function refresh() {
      var conn = document.getElementById('conn');
      var settings = document.getElementById('view-settings');
      var offline = !conn || conn.textContent !== 'online';
      var inSettings = settings && !settings.hidden;
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
      text.textContent = offline ? message || 'กำลังเชื่อมต่อ…' : '';
      text.style.display = offline ? 'block' : 'none';
      box.style.display = offline || inSettings ? 'flex' : 'none';
    }
    setInterval(refresh, 700);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
