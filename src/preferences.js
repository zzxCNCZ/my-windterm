import { ansiKeys, coreColors, fonts, presets, terminalAppearance } from './appearance.js';
import { t } from './i18n.js';

const labels = { background: '背景', foreground: '文字', cursor: '光标', selectionBackground: '选区' };

export function editPreferences({ editor, form, fields, openEditor, open, view, selectProfileFolder, preferences, save, version, checkUpdates, openRelease }) {
  function paintPath() {
    fields.querySelector('.config-path').textContent = view()?.profilePath || t('未读取到配置');
    form.querySelector('[value="migrate"]').disabled = !view();
    form.querySelector('[value="reset"]').disabled = Boolean(view() && !view().customFolder);
  }
  const close = () => { editor.classList.remove('preferences-dialog'); };
  if (!openEditor('偏好设置', `
    <nav class="preferences-nav" aria-label="偏好设置"><button type="button" class="secondary" data-prefs-tab="general" aria-pressed="true">通用</button><button type="button" class="secondary" data-prefs-tab="appearance" aria-pressed="false">终端外观</button></nav>
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
      <div class="preferences-actions"><span id="current-version"></span><button id="check-updates" type="button" class="secondary">检查更新</button><button id="open-release" type="button" class="secondary" hidden>查看 GitHub Release</button></div>
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
    <p class="hint">应用到当前及新建终端；语言和外观保存在本机，不随连接配置同步。</p>`,
  [['取消'], ['保存', 'save', true]], async intent => {
    if (intent === 'save') {
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
  const check = fields.querySelector('#check-updates');
  const result = fields.querySelector('#update-result');
  const release = fields.querySelector('#open-release');
  let url;
  fields.querySelector('#current-version').textContent = `My WindTerm ${version}`;
  check.addEventListener('click', async () => {
    check.disabled = true;
    release.hidden = true;
    result.textContent = t('正在检查更新…');
    try {
      const update = await checkUpdates();
      url = update.url;
      release.hidden = false;
      result.textContent = update.available ? `${t('发现新版本：')}${update.latest}` : t(update.latest ? '当前已是最新版本。' : 'GitHub 暂无正式版本。');
    } catch (error) {
      result.textContent = `${t('检查更新失败：')}${String(error)}`;
    } finally { check.disabled = false; }
  });
  release.addEventListener('click', async () => {
    try { await openRelease(url); }
    catch (error) { result.textContent = String(error); }
  });
  editor.addEventListener('close', () => { listener.abort(); close(); }, { once: true });
  form.addEventListener('my-windterm:done', () => { if (editor.open) paintPath(); }, { signal: listener.signal });
  for (const button of fields.querySelectorAll('[data-prefs-tab]')) {
    button.addEventListener('click', () => {
      for (const tab of fields.querySelectorAll('[data-prefs-tab]')) tab.setAttribute('aria-pressed', String(tab === button));
      for (const page of fields.querySelectorAll('[data-prefs-page]')) page.hidden = page.dataset.prefsPage !== button.dataset.prefsTab;
    });
  }
  const names = [...coreColors, ...ansiKeys];
  const value = key => form.elements.namedItem(key);
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
