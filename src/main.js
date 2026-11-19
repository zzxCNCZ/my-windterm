import { Channel, invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { formatSize, makeFiler } from './filer.js';
import { installSplitters } from './layout.js';
import { directoryHooks } from './terminal-directory.js';
import { connectionTabs, filterSessions, restoreTabs, savedTabs, withoutGroup } from './model.js';
import { makeTerminal, newId } from './terminal.js';
import { terminalAppearance } from './appearance.js';
import { editPreferences } from './preferences.js';
import { changeLanguage, localize, t } from './i18n.js';
import './style.css';

const find = selector => document.querySelector(selector);
const each = selector => document.querySelectorAll(selector);
const editor = find('#editor');
const form = find('#editor-form');
const fields = find('#editor-fields');
const popup = find('#popup');
const filter = find('#session-filter');
const tabs = new Map();
const collapsedGroups = new Set();
const stateLabels = { idle: '未连接', starting: '启动中', running: 'SSH 运行中', stopping: '断开中' };
const emptyProfile = { version: 1, connections: [], groups: [] };
let view = null, activeId = null;
let selectedConnectionId = null;
let dialogSubmit = null, dialogBusy = false, profileBusy = false, loadingProfile = false, dockPane = 'transfer';
let activeTransfer = null, syncLocalHint = '', popupAnchor, logLines = [], logFrame = 0;
let lineNumbers = loadLocal('my-windterm:numbers') !== false;
let semanticColors = loadLocal('my-windterm:semantic-colors') !== false;
let preferences = loadLocal('my-windterm:preferences') || {};
let appearance = terminalAppearance(preferences.appearance);
let searching = false, searchSession;
const searchbar = find('#terminal-search');
const searchInput = find('#terminal-query');
let platform = { remoteFiles: !/Windows/i.test(navigator.userAgent), version: '' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, handler) {
  const node = element('button', className, label);
  node.type = 'button';
  if (handler) node.addEventListener('click', handler);
  return node;
}

function status(message) {
  const node = find('#status');
  node.textContent = t(String(message));
  node.title = node.textContent;
}

function report(error) { status(error instanceof Error ? error.message : error); }
function run(handler) { Promise.resolve().then(handler).catch(report); }
function active() { return tabs.get(activeId); }
function profile() { return view?.profile || emptyProfile; }

function loadLocal(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}

function saveLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { return; }
}

function saveTabs() {
  if (view) saveLocal(`my-windterm:tabs:${view.profilePath}`, savedTabs(tabs.values(), activeId));
}

function applyView(next, restore = false) {
  view = next;
  const connections = new Map(next.profile.connections.map(connection => [connection.id, connection]));
  for (const [id, session] of tabs) {
    if (connections.has(session.connection.id)) session.connection = connections.get(session.connection.id);
    else if (session.state === 'idle') removeTab(id);
  }
  if (restore) {
    const saved = restoreTabs(next.profile, loadLocal(`my-windterm:tabs:${next.profilePath}`));
    for (const { id, connection } of saved.tabs) createTab(connection, id);
    activeId = saved.active;
  }
  selectedConnectionId = active()?.connection.id ?? null;
  render();
}

async function loadProfile({ quiet = false, restore = !view } = {}) {
  if (loadingProfile || profileBusy) return;
  loadingProfile = true;
  try {
    const next = await invoke('load_profile');
    const changed = next.etag !== view?.etag || next.profilePath !== view?.profilePath;
    if (changed) applyView(next, restore);
    if (!quiet || changed) status('配置已加载');
  } catch (error) {
    if (!quiet) report(error);
  } finally { loadingProfile = false; }
}

async function saveProfile(next) {
  if (!view) throw new Error('配置未加载，请检查配置文件夹。');
  if (profileBusy || loadingProfile) throw new Error('配置正在加载或保存，请稍后重试。');
  profileBusy = true;
  try { applyView(await invoke('save_profile', { profile: next, etag: view.etag })); }
  finally { profileBusy = false; }
}

function restoreForFolder(next) {
  for (const session of tabs.values()) session.dispose();
  tabs.clear();
  activeId = null;
  collapsedGroups.clear();
  applyView(next, true);
}

async function selectProfileFolder(folder, migrate = false) {
  if (migrate && !view) throw new Error('请先加载配置。');
  if (!migrate && (activeTransfer || [...tabs.values()].some(session => session.state !== 'idle'))) {
    throw new Error('切换配置文件夹前，请断开 SSH 并等待同步结束。');
  }
  if (profileBusy || loadingProfile) throw new Error('配置正在加载或保存，请稍后重试。');
  profileBusy = true;
  try {
    saveTabs();
    const next = await invoke('select_profile_folder', { folder, migrateEtag: migrate ? view.etag : null });
    if (migrate) { applyView(next); saveTabs(); }
    else restoreForFolder(next);
    status(migrate ? '配置已迁移，原文件已保留。' : '已切换配置文件夹');
  } finally { profileBusy = false; }
}

function createTab(connection, id = newId()) {
  if (tabs.size >= 24) throw new Error('最多打开 24 个标签，请先关闭一个。');
  const session = makeTerminal({ parent: find('#terminal-area'), id, connection, invoke, changed: render,
    directoryChanged: filer.directoryChanged, outlineChanged: scheduleOutline,
    searchChanged: source => { if (searchSession === source) renderSearch(); },
    report, numbers: () => lineNumbers, semanticColors: () => semanticColors, appearance, remoteFiles: platform.remoteFiles });
  tabs.set(session.id, session);
  return session;
}

function activateTab(id, focus = true) {
  activeId = id;
  selectedConnectionId = active()?.connection.id ?? null;
  render(focus);
  saveTabs();
}

function openConnection(connection) {
  const session = createTab(connection);
  activateTab(session.id);
  return session.connect();
}

function removeTab(id) {
  const session = tabs.get(id);
  if (!session) return;
  const keys = [...tabs.keys()];
  const index = keys.indexOf(id);
  session.dispose();
  tabs.delete(id);
  if (id === activeId) {
    activeId = keys[index - 1] ?? keys[index + 1] ?? null;
    selectedConnectionId = active()?.connection.id ?? null;
  }
}

async function closeTab(id) {
  const session = tabs.get(id);
  if (!session) return;
  if (!session.closing) {
    session.closing = Promise.resolve().then(async () => {
      await session.disconnect();
      if (tabs.get(id) !== session) return;
      removeTab(id);
      render(true);
      saveTabs();
    }).catch(error => {
      session.closing = null;
      render();
      throw error;
    });
    render();
  }
  return session.closing;
}

function render(focus = false) {
  const selected = active();
  filer.setSession(selected);
  find('#welcome').hidden = Boolean(selected);
  const tabNodes = [];
  const counts = new Map();
  const order = new Map();
  for (const session of tabs.values()) {
    const key = session.connection.id;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [id, session] of tabs) {
    const key = session.connection.id;
    const number = (order.get(key) ?? 0) + 1;
    order.set(key, number);
    const label = counts.get(key) > 1 ? `${session.connection.name} #${number}` : session.connection.name;
    const selectedTab = id === activeId;
    const wrapper = element('div', selectedTab ? 'tab active' : 'tab');
    const select = button(null, 'tab-label', () => activateTab(id));
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(selectedTab));
    select.setAttribute('aria-controls', session.pane.id);
    select.title = label;
    select.append(element('span', session.state === 'idle' ? 'dot inactive' : 'dot', '●'), label);
    const close = button('×', 'tab-close', () => run(() => closeTab(id)));
    close.disabled = Boolean(session.closing);
    close.setAttribute('aria-label', `${t('关闭')} ${label}`);
    wrapper.append(select, close);
    tabNodes.push(wrapper);
    session.show(selectedTab, selectedTab && focus && !searching);
  }
  find('#tabs').replaceChildren(...tabNodes);
  find('#tabs .active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const breadcrumb = find('#breadcrumb');
  const group = profile().groups.find(item => item.id === selected?.connection.groupId);
  const path = selected ? ['ssh', group?.name, selected.connection.name].filter(Boolean) : ['workspace', 'local profile'];
  breadcrumb.replaceChildren(...path.flatMap(item => [element('b', null, '▸'), document.createTextNode(item)]));
  find('#status-connection').textContent = t(selected ? stateLabels[selected.state] : '本地工作区');
  for (const item of each('[data-action="reconnect"]')) item.disabled = !selected || selected.state !== 'idle';
  for (const item of each('[data-action="disconnect"]')) item.disabled = selected?.state !== 'running';
  for (const item of each('[data-action="sync"]')) item.disabled = !platform.remoteFiles || (!profile().connections.length && !selected);
  find('#sender button[type="submit"]').disabled = selected?.state !== 'running';
  for (const item of each('[data-action="new-connection"], [data-action="new-group"]')) item.disabled = !view;
  renderTree();
  renderOutline(selected);
  attachSearch(selected);
}

function renderSearch() {
  const result = searchSession?.search.state;
  const count = find('#terminal-search-count');
  count.textContent = !result?.query ? '' : !result.found ? t('无匹配')
    : result.index < 0 ? `${result.count}+` : `${result.index + 1} / ${result.count}`;
  searchbar.classList.toggle('no-match', Boolean(result?.query && !result.found));
  find('[data-action="terminal-match-case"]').setAttribute('aria-pressed', String(result?.caseSensitive ?? false));
  for (const item of each('[data-action="terminal-find-prev"], [data-action="terminal-find-next"]')) {
    item.disabled = !result?.found;
  }
}

function attachSearch(session) {
  const target = searching ? session : undefined;
  searchbar.hidden = !target;
  searchbar.parentElement.classList.toggle('search-open', Boolean(target));
  if (!session) searching = false;
  if (target === searchSession) return;
  searchSession?.search.stop();
  searchSession = target;
  if (target) {
    searchInput.value = target.search.state.query;
    target.search.start();
  }
  renderSearch();
}

function openSearch() {
  if (!active()) { status('请先打开一个终端标签。'); return; }
  searching = true;
  attachSearch(active());
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searching = false;
  attachSearch();
  active()?.show(true, true);
}

function treeConnection(connection, nested) {
  const row = element('div', `tree-row${nested ? ' nested' : ''}${selectedConnectionId === connection.id ? ' selected' : ''}`);
  const item = button(null, 'tree-label', event => {
    selectedConnectionId = connection.id;
    for (const sibling of find('#tree').querySelectorAll('.selected')) sibling.classList.remove('selected');
    row.classList.add('selected');
    if (event.detail === 0) run(() => openConnection(connection));
  });
  item.addEventListener('dblclick', () => run(() => openConnection(connection)));
  item.title = `${connection.username ? `${connection.username}@` : ''}${connection.host} · ${t('双击打开新终端')}`;
  item.append(element('span', 'dot', '●'), connection.name);
  const menu = button('⋯', 'tree-menu', () => showPopup(menu, connectionMenu(connection)));
  menu.setAttribute('aria-label', `${connection.name} 操作`);
  menu.setAttribute('aria-haspopup', 'menu');
  row.addEventListener('contextmenu', event => { event.preventDefault(); showPopup(menu, connectionMenu(connection), event); });
  row.append(item, menu);
  return row;
}

function connectionMenu(connection) {
  return [
    ['打开新终端', () => openConnection(connection)], ['编辑连接', () => editConnection(connection)],
    ['复制为新连接', () => editConnection({ ...connection, id: null, name: `${connection.name} (副本)` })],
    ['目录同步', () => editSync(connection)], ['删除连接', () => confirmDeleteConnection(connection)],
  ];
}

function renderTree() {
  const tree = find('#tree');
  const query = filter.value.trim();
  const { groups, loose } = filterSessions(profile(), query);
  const nodes = [];
  for (const group of groups) {
    const expanded = query || !collapsedGroups.has(group.id);
    const row = element('div', 'tree-row');
    const label = button(null, 'tree-label', () => {
      if (query) return;
      if (expanded) collapsedGroups.add(group.id); else collapsedGroups.delete(group.id);
      renderTree();
    });
    label.setAttribute('aria-expanded', String(Boolean(expanded)));
    label.append(element('span', 'tree-arrow', expanded ? '▾' : '▸'), element('span', 'folder-icon'), group.name);
    const menu = button('⋯', 'tree-menu', () => showPopup(menu, groupMenu));
    const groupMenu = [
      ['新建组内连接', () => editConnection(null, group.id)], ['重命名分组', () => editGroup(group)],
      ['移除分组', () => confirmDeleteGroup(group)],
    ];
    menu.setAttribute('aria-label', `${group.name} 分组操作`);
    menu.setAttribute('aria-haspopup', 'menu');
    row.addEventListener('contextmenu', event => { event.preventDefault(); showPopup(menu, groupMenu, event); });
    row.append(label, menu);
    nodes.push(row);
    if (expanded) nodes.push(...group.connections.map(connection => treeConnection(connection, true)));
  }
  nodes.push(...loose.map(connection => treeConnection(connection, false)));
  if (!nodes.length) nodes.push(element('p', 'empty', t(query ? '无匹配会话' : view ? '暂无已保存的会话' : '配置未加载')));
  tree.replaceChildren(...nodes);
}

const outlineSelection = new WeakMap();
let outlineFrame = 0;
let outlineTab;
let copyNoticeTimer;

async function copyOutlineCommand(text) {
  await invoke('copy_outline_command', { text });
  const notice = find('#copy-notice');
  clearTimeout(copyNoticeTimer);
  notice.textContent = t('已复制到剪贴板');
  copyNoticeTimer = setTimeout(() => { notice.textContent = ''; }, 2200);
}

function scheduleOutline(session) {
  if (active() !== session || outlineFrame) return;
  outlineFrame = requestAnimationFrame(() => {
    outlineFrame = 0;
    renderOutline(active());
  });
}

function renderOutline(session) {
  const panel = find('#outline');
  const filter = find('#outline-filter');
  filter.disabled = !session;
  if (session !== outlineTab) {
    outlineTab = session;
    panel.scrollTop = 0;
  }
  const previousScroll = panel.scrollTop;
  const atEnd = panel.scrollHeight - panel.clientHeight - previousScroll < 6;
  const query = filter.value.trim().toLowerCase();
  const commands = session?.outline.entries.filter(entry => entry.text.toLowerCase().includes(query)) || [];
  const rows = commands.map(entry => {
    const row = button(entry.text, 'outline-row', () => {
      if (!session.outline.jump(entry)) {
        status('该命令行当前无法定位。');
        return;
      }
      outlineSelection.set(session, entry);
      panel.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
      row.setAttribute('aria-pressed', 'true');
    });
    row.addEventListener('dblclick', () => run(() => copyOutlineCommand(entry.text)));
    row.addEventListener('contextmenu', event => {
      event.preventDefault();
      showPopup(row, [['复制命令', () => copyOutlineCommand(entry.text)]], event);
    });
    row.title = `${entry.text}\n${t('单击定位 · 双击复制')}`;
    row.setAttribute('aria-pressed', String(outlineSelection.get(session) === entry));
    return row;
  });
  panel.replaceChildren(...(rows.length ? rows : [element('p', 'empty',
    t(!session ? '尚未选中 SSH 会话' : query ? '无匹配命令' : '暂无命令'))]));
  panel.scrollTop = atEnd && !query ? panel.scrollHeight : previousScroll;
}

function closePopup() {
  popup.hidden = true;
  popupAnchor?.classList.remove('menu-open');
  popupAnchor?.setAttribute('aria-expanded', 'false');
  popupAnchor = null;
}

function showPopup(anchor, items, pointer) {
  const wasOpen = !pointer && popupAnchor === anchor;
  closePopup();
  if (wasOpen) return;
  popupAnchor = anchor;
  anchor.classList.add('menu-open');
  anchor.setAttribute('aria-expanded', 'true');
  popup.replaceChildren(...items.map(([label, handler, shortcut]) => {
    const item = button(t(label), null, () => { closePopup(); run(handler); });
    item.setAttribute('role', 'menuitem');
    if (shortcut) item.append(element('small', null, shortcut));
    return item;
  }));
  popup.hidden = false;
  const bounds = anchor.getBoundingClientRect();
  popup.style.left = `${Math.max(2, Math.min(pointer?.clientX ?? bounds.left, innerWidth - popup.offsetWidth - 2))}px`;
  popup.style.top = `${Math.max(2, Math.min(pointer?.clientY ?? bounds.bottom, innerHeight - popup.offsetHeight - 2))}px`;
  popup.firstElementChild?.focus();
}

function openEditor(title, body, buttons, onSubmit = null) {
  if (editor.open) return false;
  form.reset();
  dialogSubmit = onSubmit;
  dialogBusy = false;
  find('#editor-title').textContent = t(title);
  fields.innerHTML = body;
  localize(fields);
  find('#editor-error').hidden = true;
  const footer = find('#editor-buttons');
  footer.replaceChildren(...buttons.map(([label, value, emphasized]) => {
    const item = button(t(label), emphasized ? 'primary' : 'secondary');
    if (value) { item.type = 'submit'; item.value = value; }
    else item.dataset.action = 'close-dialog';
    return item;
  }));
  editor.showModal();
  fields.querySelector('input, select')?.focus();
  return true;
}

function dialogError(error) {
  const node = find('#editor-error');
  node.textContent = t(error instanceof Error ? error.message : String(error));
  node.hidden = false;
}

function value(name) { return form.elements.namedItem(name).value.trim(); }
function setValue(name, text) { form.elements.namedItem(name).value = text ?? ''; }
function option(label, value) { return new Option(label, value); }

function editConnection(connection = null, groupId = null) {
  if (!view) { status('请先加载配置。'); return; }
  const editing = Boolean(connection?.id);
  if (!openEditor(editing ? '编辑 SSH 连接' : '新建 SSH 连接', `
    <label>名称<input name="name" maxlength="100" required placeholder="例如：开发服务器"></label>
    <div class="form-row"><label>主机 / SSH 别名<input name="host" maxlength="253" required placeholder="server.example.com" spellcheck="false"></label>
    <label>端口<input name="port" type="number" min="1" max="65535" placeholder="留空使用 SSH 设置"></label></div>
    <div class="form-row"><label>用户名<input name="username" maxlength="64" placeholder="留空使用 SSH 设置"></label><label>分组<select name="groupId"></select></label></div>
    <label>SSH 密码（可选）<input name="password" type="password" autocomplete="new-password" maxlength="512" placeholder="留空则连接时手动输入"></label>
    <p class="hint">密码以明文保存在配置文件；放在 OneDrive 会随配置同步。密钥口令与交互验证码不保存。</p>
    <label>私钥路径（可选）<span class="inline-field"><input name="identityFile" spellcheck="false" placeholder="~/.ssh/id_ed25519"><button type="button" data-action="pick-key" class="secondary">选择…</button></span></label>
    <div class="form-row"><label>保活间隔（秒，0 = 关闭）<input name="keepAlive" type="number" min="0" max="3600" required></label><label class="check"><input type="checkbox" name="tmux"> tmux 持久会话</label></div>
    <p class="hint">启用 tmux 前请确认远端已安装。</p>`,
  [['取消'], ['保存', 'save'], ['保存并连接', 'connect', true]], async intent => {
    const next = { id: connection?.id || newId(), name: value('name'), host: value('host'), port: value('port') ? Number(value('port')) : null,
      username: value('username'), password: form.elements.password.value || null, groupId: value('groupId') || null, identityFile: value('identityFile'), keepAlive: Number(value('keepAlive')), tmux: form.elements.tmux.checked };
    const old = profile();
    const connections = editing ? old.connections.map(item => item.id === next.id ? next : item) : [...old.connections, next];
    await saveProfile({ ...old, connections });
    status(`已保存连接：${next.name}`);
    if (intent === 'connect') {
      editor.close();
      run(() => openConnection(next));
    }
  })) return;
  form.elements.groupId.replaceChildren(option(t('未分组'), ''), ...profile().groups.map(group => option(group.name, group.id)));
  for (const name of ['name', 'host', 'port', 'username', 'identityFile']) setValue(name, connection?.[name]);
  if (editing) {
    setValue('password', connection.password);
    const password = form.elements.password;
    if (connection.password) {
      password.placeholder = t('清空并保存可移除密码');
    }
  }
  setValue('groupId', connection?.groupId ?? groupId);
  setValue('keepAlive', connection?.keepAlive ?? 30);
  form.elements.tmux.checked = Boolean(connection?.tmux);
}

function editGroup(group = null) {
  if (!view) { status('请先加载配置。'); return; }
  if (openEditor(group ? '重命名分组' : '新建分组', '<label>分组名称<input name="name" maxlength="100" required></label>',
    [['取消'], ['保存', 'save', true]], async () => {
      const old = profile();
      const next = { id: group?.id || newId(), name: value('name') };
      await saveProfile({ ...old, groups: group ? old.groups.map(item => item.id === group.id ? next : item) : [...old.groups, next] });
      status(`已保存分组：${next.name}`);
    })) setValue('name', group?.name);
}

function confirmDeleteConnection(connection) {
  if (openEditor('删除连接', '<p></p>', [['取消'], ['删除', 'delete', true]], async () => {
    await Promise.all(connectionTabs(tabs.values(), connection.id).map(session => closeTab(session.id)));
    const old = profile();
    await saveProfile({ ...old, connections: old.connections.filter(item => item.id !== connection.id) });
    saveTabs();
    status(`已删除连接：${connection.name}`);
  })) fields.querySelector('p').textContent = `删除「${connection.name}」并关闭其所有标签？远端 tmux 会话不会被删除。`;
}

function confirmDeleteGroup(group) {
  if (openEditor('移除分组', '<p></p>', [['取消'], ['移除分组', 'delete', true]], async () => {
    await saveProfile(withoutGroup(profile(), group.id));
    status(`已移除分组：${group.name}`);
  })) fields.querySelector('p').textContent = `移除「${group.name}」？组内连接会移到「未分组」，不会被删除。`;
}

function settings() {
  editPreferences({ editor, form, fields, openEditor, open, view: () => view, selectProfileFolder,
    version: platform.version, checkUpdates: () => invoke('check_updates'), openRelease: url => invoke('open_release_page', { url }),
    preferences: { ...preferences, appearance, semanticColors },
    save(next) {
      preferences = next;
      appearance = next.appearance;
      semanticColors = next.semanticColors;
      saveLocal('my-windterm:preferences', preferences);
      saveLocal('my-windterm:semantic-colors', semanticColors);
      changeLanguage(next.language);
      for (const session of tabs.values()) session.applyAppearance(appearance);
      renderMenubar();
      render();
      renderSearch();
      status('偏好设置已保存');
    },
  });
}

function editSync(connection = active()?.connection) {
  if (!platform.remoteFiles) { status('Windows 版暂不支持远端文件和目录同步。'); return; }
  if (activeTransfer) { showDock('transfer'); status('已有同步任务在运行。'); return; }
  const targets = new Map(profile().connections.map(item => [item.id, item]));
  if (connection) targets.set(connection.id, connection);
  if (!targets.size) { status('请先添加 SSH 连接。'); return; }
  let previewed = null;
  if (!openEditor('目录同步 · rsync over SSH', `
    <label>目标 SSH 会话<select name="target" required></select></label>
    <label>本地目录<span class="inline-field"><input name="localDir" required placeholder="/Users/…" spellcheck="false"><button type="button" data-action="pick-sync-dir" class="secondary">选择…</button></span></label>
    <label>远程目录<input name="remoteDir" required placeholder="/srv/data" spellcheck="false"></label>
    <label>方向<select name="direction"><option value="upload">上传 · 本地 → 远程</option><option value="download">下载 · 远程 → 本地</option></select></label>
    <p class="hint" id="sync-hint">先预览再执行。不删除目标独有文件，但可能覆盖同名文件。需已验证主机指纹且能用私钥 / SSH Agent 非交互登录。</p>
    <button type="button" class="secondary" id="cancel-preview" data-action="cancel-sync" hidden>停止预览</button>`,
  [['取消'], ['预览', 'preview'], ['执行同步', 'apply', true]], async intent => {
    const request = { connection: targets.get(value('target')), localDir: value('localDir'), remoteDir: value('remoteDir'), direction: value('direction'), preview: intent === 'preview' };
    const signature = JSON.stringify({ ...request, preview: true });
    syncLocalHint = request.localDir;
    if (intent === 'preview') {
      previewed = null;
      fields.querySelector('#sync-hint').textContent = t('正在预览…');
      fields.querySelector('.preview-output')?.remove();
      const cancel = fields.querySelector('#cancel-preview');
      cancel.hidden = false;
      cancel.disabled = false;
      const success = await transfer(request);
      cancel.hidden = true;
      previewed = success ? signature : null;
      fields.querySelector('#sync-hint').textContent = success ? t('预览完成。请核对下面的变更，再执行同步。') : find('#transfer-state').textContent;
      if (logLines.length) {
        const details = element('pre', 'preview-output scroll');
        details.textContent = logLines.join('\n');
        fields.append(details);
      }
      return false;
    }
    if (signature !== previewed) throw new Error('请先对当前参数运行一次成功的预览。');
    editor.close();
    run(() => transfer(request));
  })) return;
  form.elements.target.replaceChildren(...[...targets.values()].map(item => option(`${item.name} · ${item.host}`, item.id)));
  setValue('target', connection?.id ?? targets.keys().next().value);
  setValue('localDir', syncLocalHint || filer.localPath());
  const apply = form.querySelector('button[value="apply"]');
  const update = () => {
    previewed = null;
    apply.disabled = true;
    fields.querySelector('.preview-output')?.remove();
  };
  apply.disabled = true;
  fields.addEventListener('input', update, { signal: editorSignal() });
  form.addEventListener('my-windterm:done', () => { apply.disabled = !previewed; }, { signal: editorSignal() });
}

function editorSignal() {
  const controller = new AbortController();
  editor.addEventListener('close', () => controller.abort(), { once: true });
  return controller.signal;
}

function showDock(pane = dockPane) {
  dockPane = pane;
  find('#dock').classList.toggle('collapsed', !pane);
  for (const name of ['sender', 'transfer']) {
    find(`#${name}`).hidden = pane !== name;
    find(`[data-action="${name}-pane"]`).setAttribute('aria-selected', String(pane === name));
  }
  find('[data-action="toggle-dock"]').textContent = pane ? '×' : '⌃';
}

function directoryHelp() {
  if (!openEditor('配置远端 Shell 目录上报', `
    <p class="hint">已上报 OSC 7 或 OSC 1337 CurrentDir 的 Shell 无需配置。否则选择远端 Shell，将下面的代码复制到远端的启动文件，再重新连接。</p>
    <label>远端 Shell<select name="cwdShell"><option value="bash">Bash · ~/.bashrc</option><option value="zsh">Zsh · ~/.zshrc</option><option value="fish">Fish · ~/.config/fish/config.fish</option></select></label>
    <textarea class="shell-hook" aria-label="远端 Shell 配置代码" readonly spellcheck="false"></textarea>
    <p class="hint">Bash 登录 Shell 需加载 ~/.bashrc。如使用 tmux，还需允许透传（allow-passthrough on）。应用不会自动修改远端文件。</p>`,
  [['关闭']])) return;
  const shell = form.elements.cwdShell;
  const snippet = fields.querySelector('textarea');
  const update = () => { snippet.value = directoryHooks[shell.value]; };
  shell.addEventListener('change', update);
  snippet.addEventListener('focus', () => snippet.select());
  update();
}

function cleanLog(line) { return line.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''); }

function renderLog() {
  if (!logFrame) logFrame = requestAnimationFrame(() => {
    logFrame = 0;
    const node = find('#transfer-log');
    node.textContent = logLines.join('\n');
    node.scrollTop = node.scrollHeight;
  });
}

function addLog(line) {
  logLines.push(cleanLog(line));
  if (logLines.length > 400) logLines.shift();
  renderLog();
}

async function transfer(request) {
  if (activeTransfer) throw new Error('已有传输任务在运行。');
  const task = { cancelled: false };
  activeTransfer = task;
  const phase = request.preview ? '预览' : '同步';
  const transferState = find('#transfer-state');
  const cancel = find('[data-action="cancel-sync"]');
  logLines = [];
  find('#transfer-log').textContent = '';
  find('#file-progress').hidden = true;
  showDock('transfer');
  transferState.textContent = `${t(phase + '中')} · ${request.connection.name}`;
  cancel.hidden = false;
  cancel.disabled = false;
  const events = new Channel();
  events.onmessage = line => { if (activeTransfer === task) addLog(line); };
  try {
    const result = await invoke('sync_folder', { request, events });
    logLines = result.lines.map(cleanLog);
    renderLog();
    transferState.textContent = result.success ? t(phase + '完成') : task.cancelled ? t(phase + '已取消') : `${t(phase + '失败')} · ${result.detail}`;
    return result.success && !task.cancelled;
  } catch (error) {
    transferState.textContent = t(phase + '失败');
    addLog(String(error));
    return false;
  } finally {
    status(transferState.textContent);
    cancel.hidden = true;
    activeTransfer = null;
  }
}

async function transferFile(request, name, host) {
  if (activeTransfer) throw new Error('已有传输任务在运行。');
  const task = { id: newId() };
  activeTransfer = task;
  const phase = request.direction === 'upload' ? '上传' : '下载';
  const state = find('#transfer-state');
  const progress = find('#file-progress');
  const cancel = find('.transfer [data-action="cancel-sync"]');
  logLines = [];
  find('#transfer-log').textContent = '';
  showDock('transfer');
  addLog(`SFTP · ${host} · ${t(phase)}`);
  addLog(request.direction === 'upload'
    ? `${request.localPath} → ${request.remotePath}` : `${request.remotePath} → ${request.localPath}`);
  state.textContent = `${t(phase + '中')} · ${name}`;
  progress.hidden = false;
  progress.removeAttribute('value');
  cancel.hidden = false;
  cancel.disabled = false;
  const events = new Channel();
  events.onmessage = ({ bytes, total }) => {
    if (activeTransfer !== task) return;
    state.textContent = `${t(phase + '中')} · ${name} · ${formatSize(bytes)}${total == null ? '' : ` / ${formatSize(total)}`}`;
    if (total != null) {
      progress.max = Math.max(bytes, total, 1);
      progress.value = bytes;
    }
  };
  try {
    const bytes = await invoke('transfer_file', { request: { ...request, id: task.id }, events });
    state.textContent = `${t(phase + '完成')} · ${name} · ${formatSize(bytes)}`;
    progress.value = progress.max;
    return true;
  } catch (error) {
    state.textContent = String(error).startsWith('SFTP 传输已取消') ? t('SFTP 传输已取消') : `${t(phase + '失败')} · ${name}`;
    addLog(String(error));
    progress.hidden = true;
    return false;
  } finally {
    status(state.textContent);
    cancel.hidden = true;
    activeTransfer = null;
  }
}

async function cancelSync() {
  if (!activeTransfer) return;
  const task = activeTransfer;
  if (task.id) {
    const cancel = find('.transfer [data-action="cancel-sync"]');
    cancel.disabled = true;
    try { await invoke('cancel_file_transfer', { id: task.id }); }
    catch (error) { cancel.disabled = false; throw error; }
    return;
  }
  task.cancelled = true;
  try { await invoke('stop_sync'); }
  catch (error) { task.cancelled = false; throw error; }
}

const actions = {
  'new-connection': () => editConnection(), 'new-group': () => editGroup(), settings, sync: () => editSync(),
  'reload-profile': () => loadProfile(), reconnect: () => active()?.connect(), disconnect: () => active()?.disconnect(),
  'close-tab': () => closeTab(activeId), 'clear-terminal': () => active()?.clear(),
  'filer-up': () => filer.up(), 'filer-refresh': () => filer.refresh(),
  'filer-pick': () => filer.pickLocal(), 'filer-local': () => filer.switchMode('local'), 'filer-remote': () => filer.switchMode('remote'),
  'filer-upload': () => filer.upload(), 'filer-download': () => filer.download(),
  'filer-follow': () => filer.toggleFollow(),
  'toggle-filer': () => find('#main-area').classList.toggle('no-filer'),
  'toggle-sessions': () => find('#main-area').classList.toggle('no-sessions'),
  'toggle-numbers': () => { lineNumbers = !lineNumbers; saveLocal('my-windterm:numbers', lineNumbers); active()?.refresh(); },
  'terminal-search': openSearch, 'terminal-close-search': closeSearch,
  'terminal-find-prev': () => searchSession?.search.next(true),
  'terminal-find-next': () => searchSession?.search.next(),
  'terminal-match-case': () => {
    const search = searchSession?.search;
    if (search) search.config(searchInput.value, !search.state.caseSensitive);
  },
  'focus-filter': () => { find('#main-area').classList.remove('no-sessions'); filter.focus(); filter.select(); },
  'close-dialog': () => { if (!dialogBusy) editor.close(); },
  'pick-key': async () => { const path = await open({ multiple: false }); if (path && editor.open) setValue('identityFile', path); },
  'pick-sync-dir': async () => {
    const path = await open({ directory: true, multiple: false });
    if (path && editor.open) { setValue('localDir', path); form.elements.localDir.dispatchEvent(new Event('input', { bubbles: true })); }
  },
  'sender-pane': () => showDock('sender'), 'transfer-pane': () => showDock('transfer'),
  'toggle-dock': () => showDock(dockPane ? null : 'transfer'), 'cancel-sync': cancelSync,
};

const menus = [
  ['会话', [['新建 SSH 连接', 'new-connection', '⌘ N'], ['新建分组', 'new-group'], ['连接 / 重连', 'reconnect'], ['断开 SSH', 'disconnect'], ['关闭标签', 'close-tab'], ['目录同步', 'sync'], ['重新加载配置', 'reload-profile']]],
  ['搜索', [['搜索终端', 'terminal-search', '⌘ F'], ['下一个匹配', 'terminal-find-next', '⌘ G'], ['上一个匹配', 'terminal-find-prev', '⌘ ⇧ G'], ['筛选会话', 'focus-filter']]],
  ['视图', [['切换 Filer', 'toggle-filer'], ['切换 Session', 'toggle-sessions'], ['切换终端行号', 'toggle-numbers'], ['切换底部面板', 'toggle-dock'], ['清除终端回滚', 'clear-terminal']]],
];

const menuItems = entries => entries.map(([label, action, shortcut]) => [label, actions[action], shortcut]);
function renderMenubar() {
  const items = menus.map(([name, entries]) => {
    const menu = button(t(name), null, () => showPopup(menu, menuItems(entries)));
    menu.setAttribute('aria-haspopup', 'menu');
    return menu;
  });
  const preferencesButton = button(`⚙  ${t('偏好设置')}`, 'menu-preferences', () => run(settings));
  preferencesButton.title = `${t('偏好设置')} (⌘ ,)`;
  preferencesButton.setAttribute('aria-keyshortcuts', 'Meta+,');
  find('#menubar').replaceChildren(...items, preferencesButton);
}
find('#tab-menu').addEventListener('click', event => showPopup(event.currentTarget, menuItems(menus[0][1])));

document.addEventListener('click', event => {
  const item = event.target.closest('[data-action]');
  if (!popup.hidden && !popup.contains(event.target) && !popupAnchor?.contains(event.target)) closePopup();
  if (item) run(actions[item.dataset.action]);
});

document.addEventListener('keydown', event => {
  if (!editor.open && event.metaKey && !event.ctrlKey && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === ',' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      closePopup();
      settings();
      return;
    }
    if ((key === 'f' && !event.shiftKey) || (key === 'g' && active())) {
      event.preventDefault();
      event.stopPropagation();
      closePopup();
      if (key === 'f' || !searchSession) openSearch();
      else searchSession.search.next(event.shiftKey);
      return;
    }
  }
  if (!editor.open && popup.hidden && searchSession && event.key === 'Escape' && !event.isComposing) {
    event.preventDefault();
    event.stopPropagation();
    closeSearch();
    return;
  }
  if (!editor.open && event.key === 'F9' && !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
    && !find('[data-action="filer-follow"]').disabled) {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) filer.toggleFollow();
    return;
  }
  if (!popup.hidden && ['Escape', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    const items = [...popup.children];
    const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { popupAnchor?.focus(); closePopup(); }
    else items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
  if (editor.open || !event.metaKey || event.altKey || event.shiftKey) return;
  if (event.key.toLowerCase() === 'n') { event.preventDefault(); actions['new-connection'](); }
}, { capture: true });

searchInput.addEventListener('input', event => {
  if (!event.isComposing) searchSession?.search.config(searchInput.value);
});
searchInput.addEventListener('compositionend', () => searchSession?.search.config(searchInput.value));
searchInput.addEventListener('keydown', event => {
  if (event.isComposing || event.key !== 'Enter') return;
  event.preventDefault();
  searchSession?.search.next(event.shiftKey);
});
searchbar.addEventListener('submit', event => event.preventDefault());

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (dialogBusy || !dialogSubmit) return;
  dialogBusy = true;
  const disabled = [...form.querySelectorAll('button, input, select')].map(item => [item, item.disabled]);
  for (const [item] of disabled) item.disabled = true;
  find('#editor-error').hidden = true;
  try {
    if (await dialogSubmit(event.submitter?.value) !== false && editor.open) editor.close();
  } catch (error) { if (editor.open) dialogError(error); else report(error); }
  finally {
    dialogBusy = false;
    for (const [item, wasDisabled] of disabled) item.disabled = wasDisabled;
    form.dispatchEvent(new Event('my-windterm:done'));
  }
});
editor.addEventListener('cancel', event => { if (dialogBusy) event.preventDefault(); });
filter.addEventListener('input', renderTree);
find('#outline-filter').addEventListener('input', () => renderOutline(active()));
const outlineMenu = find('#outline-menu');
outlineMenu.addEventListener('click', () => {
  const session = active();
  if (!session) return;
  showPopup(outlineMenu, [['清空当前标签命令', () => session.outline.clear()]]);
});
editor.addEventListener('close', () => {
  if (!editor.open && form.elements.password) form.elements.password.value = '';
});
find('#sender').addEventListener('submit', event => {
  event.preventDefault();
  const target = active();
  if (target?.state !== 'running') return;
  target.send(find('#sender-input').value + (find('#sender-enter').checked ? '\r' : ''));
  find('#sender-input').value = '';
});
window.addEventListener('focus', () => { if (!editor.open && view) void loadProfile({ quiet: true }); });
const filer = makeFiler({ invoke, open, report, status, transfer: transferFile, showPopup, run, directoryHelp,
  follow: loadLocal('my-windterm:follow-directory') === true,
  saveFollow: value => saveLocal('my-windterm:follow-directory', value) });
installSplitters(loadLocal('my-windterm:layout'), value => saveLocal('my-windterm:layout', value));
changeLanguage(preferences.language);
renderMenubar();
render();
void invoke('platform_features').then(features => { platform = features; }).catch(report).finally(() => loadProfile());
