// 极简 i18n：零依赖，~100 行
// 使用：
//   import { t, getCurrentLocale, setLocale, applyTranslations } from './i18n/i18n.js';
//   t('common.save')                        // → '保存' / 'Save'
//   t('input.charCount', 123, 2000)         // 函数型 key 自动调用
//   setLocale('en')                         // 切换语言 → 重渲染
//
// HTML 静态文案：加 data-i18n / data-i18n-placeholder / data-i18n-title / data-i18n-aria-label
//   <button data-i18n="actions.paste">粘贴</button>
//   <input data-i18n-placeholder="input.placeholder" />
//
// 切换语言策略：写 localStorage + location.reload()
// （最简单可靠，避免动态重渲染边界情况）

import zhCN from './zh-CN.js';
import en from './en.js';

export const LOCALES = {
  'zh-CN': { label: '简体中文', messages: zhCN, bcp47: 'zh-CN', intlLocale: 'zh-CN' },
  'en':    { label: 'English',  messages: en,    bcp47: 'en',    intlLocale: 'en-US' },
};

export const DEFAULT_LOCALE = 'zh-CN';
const STORAGE_KEY = 'voicebridge_locale';

// 按优先级确定 locale
function detectInitialLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LOCALES[saved]) return saved;
  } catch { /* SSR / 隐私模式 */ }
  // 浏览器语言自动检测
  const navLocale = (typeof navigator !== 'undefined' ? (navigator.language || '') : '').toLowerCase();
  if (navLocale.startsWith('zh')) return 'zh-CN';
  if (navLocale.startsWith('en')) return 'en';
  return DEFAULT_LOCALE;
}

let currentLocale = detectInitialLocale();

export function getCurrentLocale() {
  return currentLocale;
}

export function getIntlLocale() {
  return LOCALES[currentLocale]?.intlLocale || LOCALES[DEFAULT_LOCALE].intlLocale;
}

export function getAvailableLocales() {
  return Object.entries(LOCALES).map(([code, { label }]) => ({ code, label: label }));
}

// 主翻译函数
// key 形如 'common.save'；若解析到的值是 function，会传入 rest 参数
export function t(key, ...args) {
  const dict = LOCALES[currentLocale]?.messages;
  const value = resolvePath(dict, key);
  if (value != null) {
    return typeof value === 'function' ? value(...args) : value;
  }
  // fallback 到默认语言
  const fallback = resolvePath(LOCALES[DEFAULT_LOCALE].messages, key);
  if (fallback != null) {
    return typeof fallback === 'function' ? fallback(...args) : fallback;
  }
  // 仍未找到：返回 key（明显标识漏译）
  return key;
}

function resolvePath(obj, path) {
  if (!obj || typeof path !== 'string') return undefined;
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// 切换语言：持久化 + 重载页面（最简策略）
export function setLocale(code) {
  if (!LOCALES[code] || code === currentLocale) return;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
  location.reload();
}

// === DOM 自动应用 ===
// 启动时调用一次：扫描 data-i18n 属性，应用翻译
// 支持的属性：
//   data-i18n               → textContent
//   data-i18n-html          → innerHTML（谨慎使用，仅用于已知安全文案）
//   data-i18n-placeholder   → placeholder
//   data-i18n-title         → title
//   data-i18n-aria-label    → aria-label
export function applyTranslations(root = document) {
  const attrMap = [
    { attr: 'data-i18n',             prop: 'textContent' },
    { attr: 'data-i18n-html',        prop: 'innerHTML' },
    { attr: 'data-i18n-placeholder', prop: 'placeholder' },
    { attr: 'data-i18n-title',       prop: 'title' },
    { attr: 'data-i18n-aria-label',  prop: 'ariaLabel' },
  ];
  for (const { attr, prop } of attrMap) {
    const nodes = root.querySelectorAll(`[${attr}]`);
    for (const node of nodes) {
      const key = node.getAttribute(attr);
      if (!key) continue;
      const translated = t(key);
      if (translated && translated !== key) {
        node[prop] = translated;
      }
    }
  }
  // 同步 <html lang>，影响屏幕阅读器、字体回退、CSS :lang()
  document.documentElement.lang = LOCALES[currentLocale]?.bcp47 || DEFAULT_LOCALE;
}

// === 启动时立即应用一次 ===
// 所有脚本以 type="module" 加载，按 import 顺序执行，i18n.js 早于 app.js
// 所以 app.js 顶层执行时，DOM 已翻译好
// SSR / Node test 环境下 document 不存在，跳过自动应用
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyTranslations(), { once: true });
  } else {
    applyTranslations();
  }
}
