import { ansiKeys, coreColors, fonts, presets, terminalAppearance } from './appearance.js';
import { formatSize } from './filer.js';
import { t } from './i18n.js';
import { defaultContextLines } from './terminal-context.js';

const labels = { background: '背景', foreground: '文字', cursor: '光标', selectionBackground: '选区' };

export function editPreferences({ editor, form, fields, openEditor, open, view, selectProfileFolder, preferences, save, version, checkUpdates, installUpdate, openRelease, initialTab, aiConfig, saveAi, testAiSearch }) {
  function paintPath() {
    fields.querySelector('.config-path').textContent = view()?.profilePath || t('未读取到配置');
    form.querySelector('[value="migrate"]').disabled = !view();
    form.querySelector('[value="reset"]').disabled = Boolean(view() && !view().customFolder);
  }
  const close = () => { editor.classList.remove('preferences-dialog'); };
  if (!openEditor('偏好设置', `
    <nav class="preferences-nav" aria-label="偏好设置"><button type="button" class="secondary" data-prefs-tab="general" aria-pressed="true">通用</button><button type="button" class="secondary" data-prefs-tab="appearance" aria-pressed="false">终端外观</button><button type="button" class="secondary" data-prefs-tab="ai" aria-pressed="false">AI</button><button type="button" class="secondary" data-prefs-tab="tools" aria-pressed="false">AI 工具</button></nav>
    <section class="preferences-section" data-prefs-page="general">
      <label>界面语言<select name="language"><option value="zh-CN">简体中文</option><option value="en">English</option><option value="system">跟随系统</option></select></label>
      <div class="preferences-rule"></div>
      <strong>当前配置文件</strong><p class="config-path"></p>
      <div class="preferences-actions">
        <button type="submit" value="open" class="secondary">打开已有配置…</button>
        <button type="submit" value="migrate" class="secondary">迁移当前配置…</button>
        <button type="submit" value="reset" class="secondary">使用默认目录</button>
      </div>
      <p class="hint">打开已有配置只切换目录。迁移会复制当前配置并保留原文件，不会覆盖目标配置。</p>
      <p class="hint">配置可能包含明文 SSH 密码。放入 OneDrive 等同步目录后，密码也会一起同步。</p>
      <div class="preferences-rule"></div>
      <strong>版本更新</strong>
      <div class="preferences-actions">
        <span id="current-version"></span>
        <button type="submit" value="check-update" class="secondary">检查更新</button>
        <button id="install-update" type="submit" value="install-update" class="primary" hidden>下载并安装</button>
        <button id="open-release" type="button" class="secondary" hidden>查看 GitHub Release</button>
      </div>
      <progress id="update-progress" aria-label="更新下载进度" hidden></progress>
      <p id="update-result" class="hint" role="status"></p>
    </section>
    <section class="preferences-section" data-prefs-page="appearance" hidden>
      <div class="appearance-top">
        <label>终端预设<select name="preset"><option value="wind">经典深色</option><option value="ocean">海洋</option><option value="paper">暖白</option></select></label>
        <label>字体<select name="font"><option value="system">System monospace</option><option value="menlo">Menlo</option><option value="monaco">Monaco</option><option value="courier">Courier New</option></select></label>
        <label>字号<input type="number" name="size" min="10" max="30" required></label>
        <label>光标形状<select name="cursor"><option value="block">方块</option><option value="underline">下划线</option><option value="bar">竖线</option></select></label>
      </div>
      <div class="preferences-actions">
        <label class="check"><input type="checkbox" name="blink"> 闪烁光标</label>
        <label class="check"><input type="checkbox" name="semanticColors"> 自动着色</label>
        <button type="button" class="secondary" id="reset-palette">恢复预设颜色</button>
      </div>
      <div class="appearance-colors">${coreColors.map(key => `<label>${labels[key]}<input type="color" name="${key}" aria-label="${labels[key]}"></label>`).join('')}</div>
      <strong>ANSI 调色板</strong>
      <div class="ansi-palette">${ansiKeys.map((key, index) => `<label title="${key}"><input type="color" name="${key}" aria-label="ANSI ${index}: ${key}"><small>${index}</small></label>`).join('')}</div>
      <div class="appearance-preview" aria-label="实时预览">
        <div><span data-preview-tone="green">dev@server</span>:<span data-preview-tone="brightBlue">~/project</span>$ <span data-preview-tone="cyan">cargo</span> build --release</div>
        <div><span data-preview-tone="yellow">warning</span>: unused import <span data-preview-tone="magenta">src/main.rs:42</span></div>
        <div><span class="preview-selection">selected text</span> · <span data-preview-tone="brightGreen">192.168.1.20</span></div>
        <div>$ <span class="preview-cursor" aria-hidden="true"></span></div>
      </div>
    </section>
    <section class="preferences-section" data-prefs-page="ai" hidden>
      <label>模型 API 地址<input name="aiBaseUrl" spellcheck="false" maxlength="2048" placeholder="https://api.openai.com/v1"></label>
      <div class="form-row">
        <label>模型名称<input name="aiModel" spellcheck="false" maxlength="200" autocomplete="off"></label>
        <label>最近终端行数<input name="aiContextLines" type="number" min="10" max="500" required></label>
      </div>
      <p class="hint">使用支持 Chat Completions 的模型。选区优先，较长的片段会按大小截取。</p>
      <label>模型 API Key<input name="aiApiKey" type="password" autocomplete="off" maxlength="4096"></label>
      <label class="check"><input type="checkbox" name="clearAiKey"> 清除模型密钥</label>
      <p class="hint">发送问题时，附带的终端片段会发给配置的模型。密钥保存在本机，问答会话随终端标签关闭而清除。</p>
      <p id="ai-settings-error" class="hint" hidden>无法读取 AI 设置。</p>
    </section>
    <section class="preferences-section" data-prefs-page="tools" hidden>
      <strong>联网搜索 · Brave Search</strong>
      <label class="check"><input type="checkbox" name="aiSearchEnabled"> 启用联网搜索工具</label>
      <label>Brave Search API Key<input name="aiBraveKey" type="password" autocomplete="off" maxlength="4096"></label>
      <label class="check"><input type="checkbox" name="clearBraveKey"> 清除 Brave 密钥</label>
      <div class="preferences-rule"></div>
      <label class="check"><input type="checkbox" name="aiSearchProxyEnabled"> 启用联网搜索代理</label>
      <label id="ai-search-proxy">代理地址<input name="aiSearchProxy" spellcheck="false" maxlength="4096" autocomplete="off" placeholder="http://127.0.0.1:7890"></label>
      <p class="hint">代理仅用于联网搜索，支持 HTTP、HTTPS、SOCKS5 和 SOCKS5H。</p>
      <div class="preferences-actions"><button type="submit" value="test-search" class="secondary">测试联网搜索</button></div>
      <p id="ai-search-result" class="hint" role="status"></p>
    </section>
    <p class="hint">应用到当前及新建终端；语言和外观保存在本机，不随连接配置同步。</p>`,
  [['取消'], ['保存', 'save', true]], async intent => {
    if (intent === 'test-search') {
      await testSearch();
      return false;
    }
    if (intent === 'check-update') {
      await checkForUpdates();
      return false;
    }
    if (intent === 'install-update') {
      await installCheckedUpdate();
      return false;
    }
    if (intent === 'save') {
      await saveAiFields();
      save({ language: form.elements.language.value, appearance: readAppearance(),
        semanticColors: form.elements.semanticColors.checked });
      return;
    }
    const folder = intent === 'reset' ? null : await open({ directory: true, multiple: false, title: t('选择配置文件夹') });
    if (intent !== 'reset' && !folder) return false;
    await selectProfileFolder(folder, intent === 'migrate');
    return false;
  })) return;
  editor.classList.add('preferences-dialog');
  const listener = new AbortController();
  const install = fields.querySelector('#install-update');
  const progress = fields.querySelector('#update-progress');
  const result = fields.querySelector('#update-result');
  const release = fields.querySelector('#open-release');
  let update;
  fields.querySelector('#current-version').textContent = `My WindTerm ${version}`;
  async function checkForUpdates() {
    update = null;
    install.hidden = true;
    release.hidden = true;
    progress.hidden = true;
    result.textContent = t('正在检查更新…');
    try {
      update = await checkUpdates();
      if (update.available) {
        install.hidden = !update.installable;
        release.hidden = update.installable;
        const message = t(update.installable ? '安装后应用将重新启动。' : '此版本未提供可用的应用内更新包。');
        result.textContent = `${t('发现新版本：')}${update.latest} · ${message}`;
      } else {
        result.textContent = t(update.latest ? '当前已是最新版本。' : 'GitHub 暂无正式版本。');
      }
    } catch (error) {
      result.textContent = `${t('检查更新失败：')}${String(error)}`;
    }
  }
  async function installCheckedUpdate() {
    if (!update?.installable) return;
    release.hidden = true;
    progress.hidden = false;
    progress.removeAttribute('value');
    result.textContent = t('正在准备更新…');
    let downloading = true;
    try {
      await installUpdate(update.latest, event => {
        if (!downloading) return;
        if (event.kind === 'installing') {
          progress.removeAttribute('value');
          result.textContent = t('正在校验并安装更新…');
          return;
        }
        if (event.total > 0) {
          progress.max = event.total;
          progress.value = event.received;
        }
        const received = formatSize(event.received);
        const total = event.total > 0 ? ` / ${formatSize(event.total)}` : '';
        result.textContent = `${t('正在下载更新：')}${received}${total}`;
      });
      update = null;
      install.hidden = true;
      result.textContent = t('更新已安装，正在重启…');
    } catch (error) {
      const detail = t(error instanceof Error ? error.message : String(error));
      result.textContent = `${t('安装更新失败：')}${detail}`;
      release.hidden = false;
    } finally {
      downloading = false;
      progress.hidden = true;
    }
  }
  release.addEventListener('click', async () => {
    try { await openRelease(update.url); }
    catch (error) { result.textContent = String(error); }
  });
  editor.addEventListener('close', () => { listener.abort(); close(); }, { once: true });
  form.addEventListener('my-windterm:done', () => { if (editor.open) paintPath(); }, { signal: listener.signal });
  const preferenceTabs = fields.querySelectorAll('[data-prefs-tab]');
  function selectTab(name) {
    for (const tab of preferenceTabs) tab.setAttribute('aria-pressed', String(tab.dataset.prefsTab === name));
    for (const page of fields.querySelectorAll('[data-prefs-page]')) page.hidden = page.dataset.prefsPage !== name;
  }
  for (const button of preferenceTabs) {
    button.addEventListener('click', () => selectTab(button.dataset.prefsTab));
  }
  selectTab(initialTab || 'general');
  const names = [...coreColors, ...ansiKeys];
  const value = key => form.elements.namedItem(key);
  value('aiBaseUrl').value = aiConfig?.baseUrl ?? '';
  value('aiModel').value = aiConfig?.model ?? '';
  value('aiContextLines').value = aiConfig?.contextLines ?? defaultContextLines;
  value('aiApiKey').placeholder = aiConfig?.hasApiKey ? t('已保存，留空保留') : '';
  value('aiBraveKey').placeholder = aiConfig?.hasBraveKey ? t('已保存，留空保留') : '';
  value('aiSearchEnabled').checked = aiConfig?.searchEnabled ?? true;
  value('aiSearchProxyEnabled').checked = aiConfig?.searchProxyEnabled ?? false;
  value('aiSearchProxy').value = aiConfig?.searchProxy ?? '';
  const paintProxy = () => { fields.querySelector('#ai-search-proxy').hidden = !value('aiSearchProxyEnabled').checked; };
  value('aiSearchProxyEnabled').addEventListener('change', paintProxy);
  paintProxy();
  const searchResult = fields.querySelector('#ai-search-result');
  if (!aiConfig) {
    for (const field of fields.querySelectorAll('[data-prefs-page="ai"] input, [data-prefs-page="tools"] input, [value="test-search"]')) field.disabled = true;
    fields.querySelector('#ai-settings-error').hidden = false;
    searchResult.textContent = t('无法读取 AI 设置。');
  }
  function readSearchFields() {
    return {
      braveKey: value('clearBraveKey').checked ? '' : value('aiBraveKey').value.trim() || null,
      searchEnabled: value('aiSearchEnabled').checked,
      searchProxyEnabled: value('aiSearchProxyEnabled').checked,
      searchProxy: value('aiSearchProxy').value.trim(),
    };
  }
  async function testSearch() {
    searchResult.textContent = t('正在测试联网搜索…');
    try {
      await testAiSearch(readSearchFields());
      searchResult.textContent = t('联网搜索连接成功。');
    } catch (error) {
      const detail = t(error instanceof Error ? error.message : String(error));
      searchResult.textContent = `${t('联网搜索测试失败：')}${detail}`;
    }
  }
  async function saveAiFields() {
    if (!aiConfig) return;
    const baseUrl = value('aiBaseUrl').value.trim();
    const model = value('aiModel').value.trim();
    const contextLines = value('aiContextLines').valueAsNumber;
    const apiKey = value('clearAiKey').checked ? '' : value('aiApiKey').value.trim() || null;
    const search = readSearchFields();
    if (baseUrl !== aiConfig.baseUrl || model !== aiConfig.model || contextLines !== aiConfig.contextLines
      || apiKey !== null || search.braveKey !== null || search.searchEnabled !== aiConfig.searchEnabled
      || search.searchProxyEnabled !== aiConfig.searchProxyEnabled || search.searchProxy !== aiConfig.searchProxy) {
      await saveAi({ baseUrl, model, contextLines, apiKey, ...search });
    }
  }
  const initial = preferences.appearance;
  value('language').value = preferences.language || 'zh-CN';
  for (const key of ['preset', 'font', 'size', 'cursor']) value(key).value = initial[key];
  value('blink').checked = initial.blink;
  value('semanticColors').checked = preferences.semanticColors;
  const paintPalette = colors => { for (const key of names) value(key).value = colors[key]; };
  paintPalette(initial.colors);
  function readAppearance() {
    return terminalAppearance({ preset: value('preset').value, colors: Object.fromEntries(names.map(key => [key, value(key).value])),
      font: value('font').value, size: value('size').valueAsNumber, cursor: value('cursor').value, blink: value('blink').checked });
  }
  function preview() {
    const next = readAppearance();
    const sample = fields.querySelector('.appearance-preview');
    sample.style.background = next.colors.background;
    sample.style.color = next.colors.foreground;
    sample.style.fontFamily = fonts[next.font];
    sample.style.fontSize = `${next.size}px`;
    sample.style.setProperty('--preview-selection', next.colors.selectionBackground);
    sample.style.setProperty('--preview-cursor', next.colors.cursor);
    sample.dataset.cursor = next.cursor;
    sample.classList.toggle('blink-preview', next.blink);
    for (const text of sample.querySelectorAll('[data-preview-tone]')) {
      text.style.color = next.colors[text.dataset.previewTone];
    }
  }
  function resetPalette() { paintPalette(presets[value('preset').value]); preview(); }
  value('preset').addEventListener('change', resetPalette);
  fields.querySelector('#reset-palette').addEventListener('click', resetPalette);
  fields.querySelector('[data-prefs-page="appearance"]').addEventListener('input', preview);
  paintPath();
  preview();
}
