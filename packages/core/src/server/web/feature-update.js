// A newer Android app: the app opens this page with ?app=android&appv=<version>; when the
// latest GitHub release of Mimi is newer and carries an APK, a toast offers the download.
// (The desktop apps check releases themselves: packages/desktop/updater.cjs.)
(() => {
  'use strict';
  const M = () => window.Mimi;
  const REPO = 'Nbcybg/Project-Mimi';
  const KEY = 'mimi.androidApp';

  const params = new URLSearchParams(location.search);
  if (params.get('app') === 'android' && params.get('appv')) {
    try {
      localStorage.setItem(KEY, params.get('appv'));
    } catch {
      // storage blocked: checked for this visit only
    }
    params.delete('app');
    params.delete('appv');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  }
  let installed = params.get('appv');
  try {
    installed = localStorage.getItem(KEY) || installed;
  } catch {
    // keep what the URL said
  }
  if (!installed) return;

  /** 1.2.10 > 1.2.9; anything after "-" is ignored. */
  const newer = (a, b) => {
    const parts = (text) => String(text).replace(/^v/, '').split('-')[0].split('.').map((part) => Number(part) || 0);
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    }
    return false;
  };

  async function check() {
    try {
      const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
      if (!response.ok) return;
      const release = await response.json();
      const apk = (release.assets || []).find((asset) => /android\.apk$/i.test(asset.name));
      if (!apk || !newer(release.tag_name, installed)) return;
      const text = `มีแอป Mimi สำหรับ Android เวอร์ชันใหม่ ${release.tag_name} (ตอนนี้ ${installed})`;
      if (M() && M().toast) M().toast(text, 'แตะเพื่อดาวน์โหลด แล้วติดตั้งทับของเดิม');
      const bar = document.createElement('a');
      bar.className = 'updatebar';
      bar.href = apk.browser_download_url;
      bar.target = '_blank';
      bar.rel = 'noopener';
      bar.textContent = `⬇ ${text} — แตะเพื่อดาวน์โหลด`;
      document.body.append(bar);
    } catch {
      // offline or GitHub unreachable: try again next start
    }
  }
  setTimeout(() => void check(), 4000);
})();
