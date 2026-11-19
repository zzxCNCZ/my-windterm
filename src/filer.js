import { t } from './i18n.js';

const join = (directory, name) => `${directory.replace(/\/$/, '')}/${name}`;

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const power = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(1)} ${units[power - 1]}`;
}

export function filerMode(session, preference) {
  return preference !== 'local' && (session?.runtimeId || session?.state === 'starting') ? 'remote' : 'local';
}

export function makeFiler({ invoke, open, report, status, transfer, showPopup, run, directoryHelp, follow, saveFollow }) {
  const find = selector => document.querySelector(selector);
  const entries = find('#filer-entries');
  const input = find('#filer-path');
  const local = { path: null };
  const remote = new WeakMap();
  let session, tab, current, runtimeId, request = 0, data, selected, hidden = false, pendingFollow = null, followTimer;

  function available() { return session?.sftpReady ? session.runtimeId : null; }
  function setSession(next) {
    session = next;
    if (session && !remote.has(session)) remote.set(session, { preference: 'remote', path: null });
    tab = session ? remote.get(session) : null;
    if (session?.liveConnection) {
      const { host, port, username, identityFile } = session.liveConnection;
      const endpoint = JSON.stringify([host, port, username, identityFile]);
      if (tab.endpoint !== endpoint) { tab.path = null; tab.endpoint = endpoint; }
    }
    const nextContext = filerMode(session, tab?.preference) === 'remote' && session.remoteFiles !== false ? tab : local;
    const nextRuntime = nextContext === local ? null : available();
    const host = find('#filer-host');
    host.textContent = nextContext === local ? 'Local' : session.liveConnection?.host || session.connection.host;
    host.title = host.textContent;
    find('[data-action="filer-remote"]').disabled = !session || session.remoteFiles === false || !['running', 'starting'].includes(session.state);
    find('[data-action="filer-remote"]').setAttribute('aria-pressed', String(nextContext !== local));
    find('[data-action="filer-local"]').setAttribute('aria-pressed', String(nextContext === local));
    if (nextContext === current && nextRuntime === runtimeId) {
      updateButtons();
      return;
    }
    current = nextContext;
    runtimeId = nextRuntime;
    const directory = nextRuntime && follow ? session.directory : null;
    data = null;
    pendingFollow = null;
    void browse(directory || current.path, Boolean(directory));
  }

  function switchMode(mode) {
    if (tab) tab.preference = mode;
    setSession(session);
  }

  function updateButtons() {
    find('[data-action="filer-up"]').disabled = !data?.parent;
    find('[data-action="filer-refresh"]').disabled = current !== local && !runtimeId;
    const uploadButton = find('[data-action="filer-upload"]');
    uploadButton.disabled = !available() || (current !== local ? !data : !selected?.regular || selected.symlink);
    const destination = session?.liveConnection && (current === local ? tab.path || '~' : data?.path);
    uploadButton.title = destination ? `${t('上传')} → ${session.liveConnection.host}:${destination}` : t('上传文件');
    find('[data-action="filer-download"]').disabled = current === local || !runtimeId || !selected?.regular;
    const followButton = find('[data-action="filer-follow"]');
    followButton.disabled = current === local || !runtimeId;
    followButton.setAttribute('aria-pressed', String(follow));
    followButton.title = t(follow && !session?.directory && runtimeId
      ? '正在等待远端 Shell 上报目录（F9）' : '自动跟随终端目录（F9）');
    input.disabled = current !== local && !runtimeId;
  }

  function directoryChanged(source) {
    if (source === session && current !== local && runtimeId && follow && source.directory) {
      updateButtons();
      clearTimeout(followTimer);
      followTimer = setTimeout(() => { void browse(source.directory, true); }, 120);
    }
  }

  function toggleFollow() {
    if (current === local || !runtimeId) return;
    follow = !follow;
    saveFollow(follow);
    updateButtons();
    if (follow) {
      if (session.directory) void browse(session.directory, true);
      else directoryHelp();
    } else {
      clearTimeout(followTimer);
      if (pendingFollow) void browse(current.path);
      status('已关闭终端目录跟随');
    }
  }

  function message(text) {
    const node = document.createElement('p');
    node.className = 'empty filer-message';
    node.textContent = t(text);
    entries.replaceChildren(node);
  }

  function updateSelection(entry, row) {
    selected = entry;
    entries.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
    row.setAttribute('aria-pressed', 'true');
    updateButtons();
    status(entry.directory ? entry.path : `${entry.name} · ${formatSize(entry.size)}`);
  }

  async function activate(entry) {
    if (entry.directory) return browse(entry.path);
    if (current !== local && entry.regular) return download(entry);
  }

  function listing(next) {
    const dates = new Intl.DateTimeFormat(document.documentElement?.lang || 'zh-CN', { month: '2-digit', day: '2-digit' });
    const nodes = next.entries.map(entry => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'file-row';
      row.title = entry.path;
      row.setAttribute('aria-pressed', 'false');
      const label = document.createElement('span');
      const icon = document.createElement('i');
      icon.className = entry.directory ? 'folder-icon' : 'file-icon sky';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = entry.directory ? '' : entry.symlink ? '↗' : '▤';
      label.append(icon, entry.name);
      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = entry.modified == null ? '—' : dates.format(new Date(entry.modified * 1000));
      row.append(label, date);
      row.addEventListener('click', () => updateSelection(entry, row));
      row.addEventListener('dblclick', () => run(() => activate(entry)));
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); run(() => activate(entry)); }
      });
      row.addEventListener('contextmenu', event => {
        event.preventDefault();
        updateSelection(entry, row);
        showPopup(row, menuItems(), event);
      });
      return row;
    });
    if (nodes.length) entries.replaceChildren(...nodes);
    else message('空目录');
  }

  async function browse(path = null, automatic = false) {
    clearTimeout(followTimer);
    if (automatic && (path === pendingFollow || (data && path === data.path))) return;
    const version = ++request;
    const context = current;
    const id = runtimeId;
    const previous = automatic ? data : null;
    pendingFollow = automatic ? path : null;
    data = null;
    selected = null;
    input.value = path ?? '';
    input.title = input.value;
    find('#filer-summary').textContent = '— items';
    updateButtons();
    if (context !== local && !id) {
      message('等待 SSH 认证。请在终端完成登录。');
      return;
    }
    message('正在读取目录…');
    try {
      const next = await (context === local
        ? invoke('list_directory', { path, showHidden: hidden })
        : invoke('list_remote_directory', { id, path, showHidden: hidden }));
      if (version !== request) return;
      data = next;
      context.path = next.path;
      showDirectory(next);
    } catch (error) {
      if (version !== request) return;
      if (previous) {
        data = previous;
        showDirectory(previous);
      } else message(String(error));
      report(error);
    } finally {
      if (version === request) pendingFollow = null;
    }
  }

  function showDirectory(directory) {
    input.value = directory.path;
    input.title = directory.path;
    listing(directory);
    find('#filer-summary').textContent = `${directory.entries.length}${directory.truncated ? '+' : ''} items`;
    updateButtons();
  }

  async function pickLocal() {
    const path = await open({ directory: true, multiple: false, defaultPath: local.path || undefined });
    if (path) {
      if (tab) tab.preference = 'local';
      local.path = path;
      if (current === local) await browse(path);
      else setSession(session);
    }
  }

  async function upload(entry = selected) {
    const id = available();
    const remoteState = tab;
    const host = session?.liveConnection?.host;
    if (!id || (current !== local && !data)) return;
    const fromLocal = current === local;
    const remoteDir = fromLocal ? remoteState.path : data.path;
    const localPath = fromLocal
      ? (entry?.regular && !entry.symlink ? entry.path : null)
      : await open({ multiple: false, defaultPath: local.path || undefined,
        title: `上传到 ${host}:${remoteDir}（不覆盖）` });
    if (!localPath || id !== available() || tab !== remoteState) return;
    const destination = remoteDir || (await invoke('list_remote_directory', { id, path: null, showHidden: false })).path;
    if (id !== available() || tab !== remoteState) return;
    const name = localPath.slice(localPath.lastIndexOf('/') + 1);
    const remotePath = join(destination, name);
    const success = await transfer({ sessionId: id, direction: 'upload', localPath, remotePath }, name, host);
    if (success && runtimeId === id && data?.path === destination) await browse(destination);
  }

  async function download(entry = selected) {
    const id = runtimeId;
    if (current === local || !id || !entry?.regular) return;
    const host = session?.liveConnection?.host;
    const destination = await open({ directory: true, multiple: false, defaultPath: local.path || undefined,
      title: `选择 ${entry.name} 的下载目录（不覆盖）` });
    if (!destination || id !== available()) return;
    const success = await transfer({
      sessionId: id, direction: 'download', localPath: join(destination, entry.name), remotePath: entry.path,
    }, entry.name, host);
    if (success && current === local && data?.path === destination) await browse(destination);
  }

  function menuItems() {
    const items = [];
    if (selected?.directory) items.push(['打开目录', () => browse(selected.path)]);
    if (current === local && available() && selected?.regular && !selected.symlink) {
      items.push([`上传至 ${session.liveConnection.host}:${tab.path || '~'}`, upload]);
    }
    if (current !== local && data) items.push(['上传文件到当前目录…', upload]);
    if (current !== local && selected?.regular) items.push(['下载所选文件…', download]);
    items.push(['主目录', () => browse()], ['刷新', () => browse(current.path)],
      [hidden ? '隐藏点文件' : '显示点文件', () => { hidden = !hidden; return browse(current.path); }],
      ['选择本地目录…', pickLocal]);
    if (current !== local && runtimeId) {
      items.push([follow ? '关闭终端目录跟随' : '开启终端目录跟随', toggleFollow, 'F9'],
        ['配置 Shell 目录上报…', directoryHelp]);
    }
    return items;
  }

  const menu = find('#filer-menu');
  menu.addEventListener('click', () => showPopup(menu, menuItems()));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') run(() => browse(!input.value || ['~', '~/'].includes(input.value) ? null : input.value));
  });
  return {
    setSession, switchMode, pickLocal, upload, download, directoryChanged, toggleFollow,
    localPath: () => local.path,
    up: () => data?.parent && browse(data.parent),
    refresh: () => browse(data?.path || input.value || current.path),
  };
}
