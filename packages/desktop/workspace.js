(() => {
  'use strict';
  const api = window.mimiWorkspace;
  const $ = (id) => document.getElementById(id);

  const tree = $('tree');
  const filter = $('filter');
  const rootLabel = $('root');
  const fileText = $('file-text');
  const fileName = $('file-name');
  const previewEmpty = $('preview-empty');
  const saveButton = $('save-file');
  const closeButton = $('close-file');
  const saved = $('saved');
  const view = $('view');
  const url = $('url');
  const browseEmpty = $('browse-empty');
  const termOut = $('term-out');
  const termIn = $('term-in');
  const termStatus = $('term-status');
  const termPrompt = $('term-prompt');

  let root = '';
  let currentFile = '';
  let savedTimer = 0;
  const history = [];
  let historyAt = -1;
  let filterText = '';

  const join = (rel, name) => (rel ? `${rel}/${name}` : name);
  const note = (text, bad = false) => {
    saved.textContent = text;
    saved.style.color = bad ? 'var(--bad)' : 'var(--ok)';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      saved.textContent = '';
    }, 2500);
  };
  const sizeText = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  function applyFilter() {
    filterText = filter.value.trim().toLowerCase();
    const walk = (container) => {
      let visible = false;
      for (const child of container.children) {
        if (child.classList.contains('node')) {
          const name = (child.dataset.name || '').toLowerCase();
          const match = !filterText || name.includes(filterText);
          child.classList.toggle('hidden', !match);
          if (match) visible = true;
        } else if (child.classList.contains('children')) {
          // Filtered on the next pass, when its rows are in place.
        }
      }
      return visible;
    };
    walk(tree);
    for (const group of tree.querySelectorAll('.children')) walk(group);
  }

  async function loadDir(rel, container) {
    const data = await api.list(rel);
    container.replaceChildren();
    if (data.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'node';
      empty.style.color = 'var(--faint)';
      empty.textContent = '(empty)';
      container.append(empty);
      return;
    }
    for (const entry of data.entries) {
      const row = document.createElement('div');
      row.className = `node${entry.dir ? ' dir' : ''}`;
      row.dataset.name = entry.name;
      const twisty = document.createElement('span');
      twisty.className = 'tw';
      twisty.textContent = entry.dir ? '›' : '';
      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = entry.name;
      const size = document.createElement('span');
      size.className = 'sz';
      size.textContent = entry.dir ? '' : sizeText(entry.size);
      row.append(twisty, name, size);
      container.append(row);
      if (!entry.dir) {
        row.addEventListener('click', () => openFile(join(rel, entry.name), entry.name));
        continue;
      }
      const children = document.createElement('div');
      children.className = 'children';
      children.hidden = true;
      container.append(children);
      let loaded = false;
      let open = false;
      row.addEventListener('click', async () => {
        open = !open;
        twisty.textContent = open ? '⌄' : '›';
        children.hidden = !open;
        if (!open) return;
        if (!loaded) {
          loaded = true;
          twisty.textContent = '…';
          try {
            await loadDir(join(rel, entry.name), children);
          } catch (error) {
            children.classList.remove('children');
            children.textContent = `โหลดไม่ได้: ${error.message}`;
          }
          twisty.textContent = '⌄';
          applyFilter();
        }
      });
    }
    applyFilter();
  }

  async function refreshTree() {
    try {
      const info = await api.root();
      root = info.root;
      rootLabel.textContent = root;
      rootLabel.title = root;
      await loadDir('', tree);
    } catch (error) {
      tree.replaceChildren(Object.assign(document.createElement('div'), { className: 'node', textContent: error.message }));
    }
  }

  async function chooseRoot() {
    const picked = await api.chooseRoot();
    if (!picked) return;
    closeFile();
    await refreshTree();
    await restartTerminal();
  }

  async function openFile(rel, name) {
    try {
      const file = await api.read(rel);
      currentFile = rel;
      fileName.textContent = name;
      fileText.value = file.text;
      fileText.hidden = false;
      previewEmpty.hidden = true;
      saveButton.hidden = false;
      closeButton.hidden = false;
      note('');
    } catch (error) {
      fileName.textContent = name;
      fileText.hidden = true;
      previewEmpty.hidden = false;
      previewEmpty.textContent = error.message;
      saveButton.hidden = true;
      closeButton.hidden = true;
      currentFile = '';
    }
  }

  function closeFile() {
    currentFile = '';
    fileText.value = '';
    fileText.hidden = true;
    saveButton.hidden = true;
    closeButton.hidden = true;
    previewEmpty.hidden = false;
    previewEmpty.textContent = 'Pick a file in the tree.';
    fileName.textContent = 'Open files appear here';
    saved.textContent = '';
  }

  async function saveFile() {
    if (!currentFile) return;
    try {
      await api.write(currentFile, fileText.value);
      note('บันทึกแล้ว');
    } catch (error) {
      note(error.message, true);
    }
  }

  function normalizeAddress(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (/^(https?:|about:)/i.test(text)) return text;
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(text)) return `https://${text}`;
    return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
  }

  function showBrowseEmpty(show) {
    browseEmpty.hidden = !show;
  }

  function syncNav() {
    try {
      $('back').disabled = !view.canGoBack();
      $('forward').disabled = !view.canGoForward();
    } catch {
      // webview not ready
    }
  }

  function navigate(raw) {
    const target = normalizeAddress(raw);
    if (!target) return;
    if (target === 'about:blank') {
      showBrowseEmpty(true);
      url.value = '';
      return;
    }
    showBrowseEmpty(false);
    url.value = target;
    try {
      const loading = view.loadURL(target);
      if (loading && typeof loading.catch === 'function') loading.catch(() => {});
    } catch (error) {
      showBrowseEmpty(true);
      browseEmpty.querySelector('b').textContent = 'เปิดเว็บไม่ได้';
      browseEmpty.querySelector('span').textContent = error.message;
    }
  }

  function browserEvents() {
    view.addEventListener('did-start-loading', () => {
      if ($('url').value) showBrowseEmpty(false);
    });
    const update = (event) => {
      const address = event.url || (typeof view.getURL === 'function' ? view.getURL() : '');
      if (address && address !== 'about:blank') {
        url.value = address;
        showBrowseEmpty(false);
      } else {
        showBrowseEmpty(true);
      }
      syncNav();
    };
    view.addEventListener('did-navigate', update);
    view.addEventListener('did-navigate-in-page', update);
    view.addEventListener('dom-ready', () => {
      syncNav();
      update({ url: view.getURL() });
    });
    view.addEventListener('did-fail-load', (event) => {
      if (event.errorCode === -3) return;
      showBrowseEmpty(true);
      browseEmpty.querySelector('b').textContent = 'เปิดเว็บไม่ได้';
      browseEmpty.querySelector('span').textContent = event.errorDescription || 'ลองใหม่อีกครั้ง';
      syncNav();
    });
  }

  function appendTerminal(text) {
    if (!text) return;
    termOut.textContent = (termOut.textContent + String(text)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (termOut.textContent.length > 400_000) termOut.textContent = termOut.textContent.slice(-400_000);
    termOut.scrollTop = termOut.scrollHeight;
  }

  async function startTerminal() {
    termStatus.textContent = 'starting…';
    try {
      const result = await api.terminalStart('');
      termPrompt.textContent = processLabel(result.cwd);
      termStatus.textContent = 'running';
    } catch (error) {
      termStatus.textContent = 'stopped';
      appendTerminal(`\n${error.message}\n`);
    }
    termIn.focus();
  }

  const processLabel = (cwd) => {
    const base = String(cwd || '').split(/[\\/]/).filter(Boolean).pop();
    return base ? `${base} PS>` : 'PS>';
  };

  async function restartTerminal() {
    termStatus.textContent = 'restarting…';
    await api.terminalStop();
    termOut.textContent = '';
    await startTerminal();
  }

  function terminalEvents() {
    api.onTerminalData((text) => appendTerminal(text));
    api.onTerminalExit((code) => {
      termStatus.textContent = `exited ${code}`;
      appendTerminal(`\n[process exited ${code}]\n`);
    });
    termIn.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const command = termIn.value;
        termIn.value = '';
        if (!command.trim()) return;
        if (history[history.length - 1] !== command) history.push(command);
        historyAt = history.length;
        if (command.trim() === 'clear' || command.trim() === 'cls') {
          termOut.textContent = '';
          api.terminalInput(command + '\n');
          return;
        }
        appendTerminal(`${termPrompt.textContent} ${command}\n`);
        api.terminalInput(command + '\n');
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (historyAt > 0) historyAt--;
        termIn.value = history[historyAt] || '';
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (historyAt < history.length) historyAt++;
        termIn.value = history[historyAt] || '';
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        api.terminalInput('\x03');
        appendTerminal('^C\n');
      }
    });
  }

  $('choose-root').addEventListener('click', () => void chooseRoot());
  $('refresh-files').addEventListener('click', () => void refreshTree());
  filter.addEventListener('input', () => applyFilter());
  saveButton.addEventListener('click', () => void saveFile());
  closeButton.addEventListener('click', closeFile);
  fileText.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveFile();
    }
  });
  fileName.addEventListener('dblclick', () => fileText.focus());

  $('back').addEventListener('click', () => view.canGoBack() && view.goBack());
  $('forward').addEventListener('click', () => view.canGoForward() && view.goForward());
  $('reload').addEventListener('click', () => view.reload());
  $('go').addEventListener('click', () => navigate(url.value));
  url.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') navigate(url.value);
    if (event.key === 'Escape') url.blur();
  });
  $('term-clear').addEventListener('click', () => {
    termOut.textContent = '';
  });
  $('term-restart').addEventListener('click', () => void restartTerminal());
  document.addEventListener('click', (event) => {
    if (event.target.closest('.terminal')) termIn.focus();
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
      event.preventDefault();
      url.focus();
      url.select();
    }
  });

  browserEvents();
  terminalEvents();
  api.onOpenUrl((target) => navigate(target));
  void refreshTree().then(() => startTerminal());
})();
