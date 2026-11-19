import { english } from './translations.js';

let language = 'zh-CN';
let chrome = [];
const attributes = ['aria-label', 'placeholder', 'title'];
const prefixes = [
  ['已保存连接：', 'Connection saved: '], ['已保存分组：', 'Group saved: '],
  ['已删除连接：', 'Connection deleted: '], ['已移除分组：', 'Group removed: '],
  ['读取配置失败', 'Could not read configuration '], ['迁移失败：', 'Migration failed: '],
  ['保存失败：', 'Save failed: '],
];

export function resolveLanguage(setting, system = 'zh-CN') {
  if (setting === 'system') return system.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  return setting === 'en' ? 'en' : 'zh-CN';
}

export function t(label) {
  if (language !== 'en' || typeof label !== 'string') return label;
  const direct = english[label.trim()];
  if (typeof direct === 'string') return label.replace(label.trim(), direct);
  const prefix = prefixes.find(([source]) => label.startsWith(source));
  return prefix ? prefix[1] + label.slice(prefix[0].length) : label;
}

function bindings(root) {
  const result = [];
  for (const element of root.querySelectorAll('*')) {
    if (element.matches('script, style') || element.closest('script, style')) continue;
    for (const key of attributes) {
      const value = element.getAttribute(key);
      if (value && Object.hasOwn(english, value.trim())) result.push(() => element.setAttribute(key, t(value)));
    }
    for (const node of element.childNodes) {
      if (node.nodeType === 3 && Object.hasOwn(english, node.textContent.trim())) {
        const value = node.textContent;
        result.push(() => { node.textContent = t(value); });
      }
    }
  }
  return result;
}

export function localize(root) { for (const translate of bindings(root)) translate(); }

export function changeLanguage(setting) {
  language = resolveLanguage(setting, navigator.language);
  document.documentElement.lang = language;
  if (!chrome.length) chrome = bindings(document.body);
  for (const translate of chrome) translate();
}
