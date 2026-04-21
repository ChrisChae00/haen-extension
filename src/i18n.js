// src/i18n.js — locale loader + t() helper for Haen popup UI

let currentLang = 'ko';
let messages = {};

async function initI18n() {
  let stored = {};
  try {
    stored = await chrome.storage.local.get('ui_language');
  } catch (_) {
    stored = {};
  }
  currentLang = stored.ui_language
    || (navigator.language && navigator.language.startsWith('ko') ? 'ko' : 'en');
  await loadLocale(currentLang);
}

async function loadLocale(lang) {
  const url = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
    ? chrome.runtime.getURL(`locales/${lang}.json`)
    : `locales/${lang}.json`;
  const res = await fetch(url);
  messages = await res.json();
}

function t(key, params = {}) {
  let s = messages[key];
  if (s === undefined) return key;
  for (const [k, v] of Object.entries(params)) {
    s = s.replace(new RegExp(`{{\\s*${k}\\s*}}`, 'g'), v);
  }
  return s;
}

async function setLanguage(lang) {
  try {
    await chrome.storage.local.set({ ui_language: lang });
  } catch (_) { /* non-extension context */ }
  currentLang = lang;
  await loadLocale(lang);
  applyTranslations(document.body);
}

function getCurrentLanguage() {
  return currentLang;
}

function applyTranslations(rootEl) {
  rootEl.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  rootEl.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  rootEl.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  rootEl.querySelectorAll('[data-i18n-aria]').forEach(el => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  });
}

window.initI18n = initI18n;
window.t = t;
window.setLanguage = setLanguage;
window.getCurrentLanguage = getCurrentLanguage;
window.applyTranslations = applyTranslations;
