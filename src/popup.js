import { parsePartial } from './apiClient.js';

// Direction value maps between panel.html (data-dir) and background/storage formats
const DIR_TO_API    = { 'ko-en': 'ko_to_en', 'en-ko': 'en_to_ko', 'auto': 'auto' };
const DIR_FROM_STOR = { 'ko_to_en': 'ko-en', 'en_to_ko': 'en-ko', 'auto': 'auto' };

const stor    = key => new Promise(r => chrome.storage.local.get(key, res => r(res[key])));
const storSet = obj => new Promise(r => chrome.storage.local.set(obj, r));

function el(tag, { cls, text, attrs } = {}) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  if (attrs) Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}

let currentDir = 'auto';
let currentTheme = 'system'; // stored preference: 'system' | 'light' | 'dark'
let lastResult = null;
let activeTab = 'translation';
let settingsOpen = false;
let isTranslating = false;
let currentAbortController = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const mainContent     = $('main-content');
const settingsPanel   = $('settings-panel');
const settingsWm      = $('settings-wordmark');
const btnSettings     = $('btn-settings'); // gear icon → quick theme toggle
const btnSettingsIcon = $('btn-settings-icon');
const btnMore         = $('btn-more');     // ··· icon → settings panel
const uiLangSeg       = $('ui-lang-seg');
const dirSeg          = $('direction-seg');
const textarea        = $('main-textarea');
const charCounter     = $('char-counter');
const btnTranslate    = $('btn-translate');
const resultContent   = $('result-content');
const resultTabs      = $('result-tabs');
const autoBadge       = $('auto-badge');
const apiKeyInput     = $('api-key-input');
const btnToggleKey    = $('btn-toggle-api-key');
const modelSelect     = $('model-select');
const defaultDirSel   = $('default-dir-select');
const themeSeg        = $('theme-seg');
const autoCopyTog     = $('auto-copy-toggle');
const btnSave         = $('btn-save');
const settingsLangSeg = $('settings-lang-seg');
const appWordmark     = $('app-wordmark');

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await initI18n();
  applyTranslations(document.body);

  const [theme, storedDir, lang] = await Promise.all([
    stor('theme'), stor('direction'), stor('uiLanguage'),
  ]);

  // 'auto' was the old stored value for "follow the system" — migrate it in place.
  let pref = theme;
  if (pref == null || pref === 'auto') {
    pref = 'system';
    await storSet({ theme: pref });
  }
  currentTheme = pref;
  applyTheme(currentTheme);
  syncThemeUI();
  document.documentElement.classList.remove('no-transition');

  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (currentTheme === 'system') applyTheme('system');
    });

  currentDir = DIR_FROM_STOR[storedDir] ?? 'auto';
  setDirActive(currentDir);

  const activeLang = lang ?? getCurrentLanguage();
  uiLangSeg.querySelectorAll('span').forEach(s =>
    s.classList.toggle('active', s.dataset.lang === activeLang));
});

// ── Theme ─────────────────────────────────────────────────────────────────────
// currentTheme holds the stored PREFERENCE ('system' | 'light' | 'dark');
// resolveDark() turns that into the actual light/dark state to render.
function resolveDark(pref) {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function applyTheme(pref) {
  const dark = resolveDark(pref);
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  // Mirrored so panel.html's inline <head> script can apply the theme
  // synchronously on next open, before chrome.storage resolves.
  localStorage.setItem('haen-theme', pref);
}

// ── Header: UI language segment ───────────────────────────────────────────────
uiLangSeg.addEventListener('click', async e => {
  const span = e.target.closest('span[data-lang]');
  if (!span) return;
  const lang = span.dataset.lang;
  uiLangSeg.querySelectorAll('span').forEach(s =>
    s.classList.toggle('active', s.dataset.lang === lang));
  await setLanguage(lang);
});

// ── Quick theme toggle (gear icon) ────────────────────────────────────────────
// A one-click override that always lands on an explicit light/dark — even if
// the stored preference was "system". The 3-way choice lives in settings.
btnSettings.addEventListener('click', async () => {
  currentTheme = resolveDark(currentTheme) ? 'light' : 'dark';
  applyTheme(currentTheme);
  await storSet({ theme: currentTheme });
  syncThemeUI();
});

const ICON_SUN = '<circle cx="7" cy="7" r="3" stroke="currentColor" stroke-width="1.4"/>' +
  '<path d="M7 0.5v1.5M7 12v1.5M13.5 7H12M2 7H0.5M11.4 2.6l-1.1 1.1M3.7 10.3l-1.1 1.1M11.4 11.4l-1.1-1.1M3.7 3.7l-1.1-1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';
const ICON_MOON = '<path d="M12.5 8.7A5.5 5.5 0 1 1 5.3 1.5a5 5 0 0 0 7.2 7.2Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>';

function syncThemeUI() {
  const dark = resolveDark(currentTheme);
  btnSettings.style.color = dark ? 'var(--text-accent)' : '';
  btnSettingsIcon.innerHTML = dark ? ICON_MOON : ICON_SUN;
  themeSeg.querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.theme === currentTheme));
}

// ── Settings panel toggle (··· button) ────────────────────────────────────────
btnMore.addEventListener('click', () =>
  settingsOpen ? closeSettings() : openSettings());

async function openSettings() {
  settingsOpen = true;
  mainContent.style.display = 'none';
  settingsPanel.style.display = 'flex';
  appWordmark.style.display = 'none';
  settingsWm.style.display = 'inline';
  uiLangSeg.style.display = 'none';
  btnMore.style.opacity = '0.5';

  const [apiKey, model, storedDir, lang, autoCopy] = await Promise.all([
    stor('apiKey'), stor('model'), stor('direction'),
    stor('uiLanguage'), stor('autoCopy'),
  ]);

  apiKeyInput.value = apiKey ?? '';
  modelSelect.value = model ?? 'llama4';
  defaultDirSel.value = DIR_FROM_STOR[storedDir] ?? 'auto';

  const activeLang = lang ?? getCurrentLanguage();
  settingsLangSeg.querySelectorAll('span').forEach(s =>
    s.classList.toggle('active', s.dataset.lang === activeLang));

  syncThemeUI();
  autoCopyTog.classList.toggle('on', autoCopy === true);
}

function closeSettings() {
  settingsOpen = false;
  settingsPanel.style.display = 'none';
  mainContent.style.display = '';
  settingsWm.style.display = 'none';
  appWordmark.style.display = '';
  uiLangSeg.style.display = '';
  btnMore.style.opacity = '';
}

// ── Settings inputs ───────────────────────────────────────────────────────────
btnToggleKey.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

themeSeg.addEventListener('click', e => {
  const btn = e.target.closest('button[data-theme]');
  if (!btn) return;
  currentTheme = btn.dataset.theme;
  applyTheme(currentTheme);
  syncThemeUI();
});

autoCopyTog.addEventListener('click', () => autoCopyTog.classList.toggle('on'));

settingsLangSeg.addEventListener('click', e => {
  const span = e.target.closest('span[data-lang]');
  if (!span) return;
  settingsLangSeg.querySelectorAll('span').forEach(s =>
    s.classList.toggle('active', s.dataset.lang === span.dataset.lang));
});

btnSave.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  const activeLangSpan = settingsLangSeg.querySelector('span.active');
  const lang = activeLangSpan?.dataset.lang ?? 'ko';
  const theme = currentTheme;
  const autoCopy = autoCopyTog.classList.contains('on');
  const dir = DIR_TO_API[defaultDirSel.value] ?? 'auto';

  applyTheme(currentTheme);
  syncThemeUI();

  const saves = [
    storSet({ model: modelSelect.value, direction: dir, theme, autoCopy }),
    key
      ? storSet({ apiKey: key })
      : new Promise(r => chrome.storage.local.remove('apiKey', r)),
  ];
  await Promise.all(saves);
  await setLanguage(lang);

  uiLangSeg.querySelectorAll('span').forEach(s =>
    s.classList.toggle('active', s.dataset.lang === lang));

  const orig = btnSave.textContent;
  btnSave.textContent = t('save_done');
  setTimeout(() => {
    btnSave.textContent = orig;
    closeSettings();
  }, 600);
});

// ── Direction segment ─────────────────────────────────────────────────────────
function setDirActive(dir) {
  dirSeg.querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.dir === dir));
}

dirSeg.addEventListener('click', e => {
  const btn = e.target.closest('button[data-dir]');
  if (!btn) return;
  currentDir = btn.dataset.dir;
  setDirActive(currentDir);
});

// ── Textarea + char counter ───────────────────────────────────────────────────
textarea.addEventListener('input', () => {
  const len = textarea.value.length;
  const trimmedLen = textarea.value.trim().length;
  charCounter.textContent = t('char_counter', { current: len, max: 500 });
  charCounter.classList.toggle('over', len > 500);
  btnTranslate.disabled = trimmedLen === 0 || len > 500 || isTranslating;
});

textarea.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!btnTranslate.disabled) btnTranslate.click();
  }
});

// ── Translate ─────────────────────────────────────────────────────────────────
btnTranslate.addEventListener('click', () => {
  if (isTranslating) return;
  const text = textarea.value.trim();
  if (!text || text.length > 500) return;
  doTranslate(text);
});

function setTranslating(on) {
  isTranslating = on;
  if (on) {
    btnTranslate.classList.add('loading');
    btnTranslate.textContent = '';
    btnTranslate.appendChild(el('span', { cls: 'spinner' }));
    btnTranslate.disabled = true;
    showShimmer(3);
  } else {
    btnTranslate.classList.remove('loading');
    btnTranslate.textContent = t('btn_translate');
    btnTranslate.disabled = textarea.value.length === 0;
  }
}

function showShimmer(count) {
  resultContent.textContent = '';
  for (let i = 0; i < count; i++) {
    resultContent.appendChild(el('div', { cls: 'shimmer-line' }));
  }
}

function doTranslate(text) {
  if (currentAbortController) currentAbortController.abort();
  currentAbortController = new AbortController();
  const { signal } = currentAbortController;

  setTranslating(true);

  const port = chrome.runtime.connect({ name: 'translate' });
  port.postMessage({ action: 'translate', text, direction: DIR_TO_API[currentDir] });

  signal.addEventListener('abort', () => port.disconnect(), { once: true });

  port.onMessage.addListener(async msg => {
    if (signal.aborted) return;
    if (msg.type === 'chunk') {
      // Render whatever complete fields have arrived so far — natural usually
      // finishes long before nuance/alternatives, so the user sees a result
      // almost immediately instead of waiting for the full JSON to land.
      const partial = parsePartial(msg.text);
      if (partial.natural || partial.nuance || partial.tip) {
        renderTranslationTab(partial);
      }
    }
    if (msg.type === 'done') {
      setTranslating(false);
      renderResult(msg.result);
      stor('autoCopy').then(autoCopy => {
        if (autoCopy) navigator.clipboard.writeText(msg.result.natural).catch(() => {});
      });
      stor('history').then(history => {
        const h = history ?? [];
        h.unshift({ text, result: lastResult, dir: currentDir, ts: Date.now() });
        if (h.length > 50) h.length = 50;
        storSet({ history: h });
      });
    }
    if (msg.type === 'error') {
      setTranslating(false);
      renderError(msg.errorKey, text);
    }
  });

  port.onDisconnect.addListener(() => {
    if (isTranslating && !signal.aborted) {
      setTranslating(false);
      renderError('error_server', text);
    }
  });
}

// ── Normalize legacy flat-alternatives format ─────────────────────────────────
function normalizeResult(r) {
  if (!r || !Array.isArray(r.alternatives)) return r;
  if (r.alternatives.length === 0 || typeof r.alternatives[0] === 'string') {
    r.alternatives = r.alternatives.length
      ? [{ label: t('label_alternatives'), register: 'neutral', expressions: r.alternatives }]
      : [];
  }
  return r;
}

// ── Result rendering ──────────────────────────────────────────────────────────
function renderResult(result) {
  lastResult = normalizeResult(result);
  activeTab = 'translation';
  resultTabs.querySelectorAll('.result-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === 'translation'));
  showTab('translation');

  if (currentDir === 'auto') {
    autoBadge.textContent = t('auto_detected', {
      lang: result.detected_lang === 'KO' ? 'KO' : 'EN',
    });
    autoBadge.style.display = 'inline';
  } else {
    autoBadge.style.display = 'none';
  }
}

function makeCopyBtn(copyText, cls) {
  const btn = el('button', { cls, text: t('copy_btn') });
  btn.addEventListener('click', () => {
    navigator.clipboard.writeText(copyText).then(() => {
      btn.textContent = t('copy_done');
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = t('copy_btn'); btn.classList.remove('copied'); }, 1500);
    }).catch(() => {});
  });
  return btn;
}

// Renders the "translation" tab body (natural / literal note / nuance / tip) from
// either a complete result or a partial one still streaming in — fields that haven't
// arrived yet are simply omitted rather than shown as empty/undefined.
function renderTranslationTab(r) {
  resultContent.textContent = '';

  if (r.natural) {
    const naturalLabel = el('div', { cls: 'result-section-label', text: t('label_translation') });
    const naturalText = el('p', { text: r.natural });
    naturalText.style.cssText = 'font-size:15px;line-height:1.7;color:var(--text-primary);margin-bottom:8px;';
    resultContent.append(naturalLabel, naturalText);

    // "literal" is only present when the source was an idiom/figurative expression —
    // shown as a small secondary note, never as the headline translation.
    if (r.literal) {
      resultContent.appendChild(el('p', { cls: 'literal-note', text: `${t('label_literal')}: ${r.literal}` }));
    }

    const copyRow = el('div', { cls: 'copy-row' });
    copyRow.appendChild(makeCopyBtn(r.natural, 'btn-copy'));
    resultContent.appendChild(copyRow);
    resultContent.appendChild(el('div', { cls: 'result-divider' }));
  }

  if (r.nuance) {
    const nuanceLabel = el('div', { cls: 'result-section-label' });
    const langBadge = el('span', { cls: 'badge badge-lang', text: `${r.detected_lang ?? '?'} → ${r.target_lang ?? '?'}` });
    nuanceLabel.append(el('span', { text: t('label_nuance') }), langBadge);
    const nuanceText = el('p', { text: r.nuance });
    nuanceText.style.cssText = 'font-size:13px;line-height:1.75;color:var(--text-primary);margin-top:8px;';
    resultContent.append(nuanceLabel, nuanceText);
  }

  if (r.tip) {
    const tipBox = el('div', { cls: 'tip-card' });
    tipBox.appendChild(el('div', { cls: 'tip-label', text: `💡 ${t('label_tip')}` }));
    tipBox.appendChild(el('p', { text: r.tip }));
    resultContent.appendChild(tipBox);
  }
}

function showTab(tab) {
  if (!lastResult) return;
  const r = lastResult;

  if (tab === 'translation') {
    renderTranslationTab(r);
  } else if (tab === 'alternatives') {
    resultContent.textContent = '';
    r.alternatives.forEach(group => {
      const groupEl = el('div', { cls: 'alt-group' });
      groupEl.appendChild(el('div', { cls: `alt-group-label register-${group.register ?? 'neutral'}`, text: group.label }));
      group.expressions.forEach(expr => {
        const item = el('div', { cls: 'alt-item' });
        item.appendChild(el('span', { cls: 'alt-text', text: expr }));
        item.appendChild(makeCopyBtn(expr, 'btn-copy-mini'));
        groupEl.appendChild(item);
      });
      resultContent.appendChild(groupEl);
    });
  }
}

resultTabs.addEventListener('click', e => {
  const btn = e.target.closest('.result-tab');
  if (!btn || !lastResult) return;
  activeTab = btn.dataset.tab;
  resultTabs.querySelectorAll('.result-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === activeTab));
  showTab(activeTab);
});

// ── Error rendering ───────────────────────────────────────────────────────────
function renderError(errorKey, retryText) {
  resultContent.textContent = '';

  const box = el('div', { cls: 'error-box' });
  const title = el('div', { cls: 'error-title', text: `⚠ ${t(errorKey)}` });
  box.appendChild(title);
  if (errorKey === 'error_api_key_title') {
    box.appendChild(el('p', { cls: 'error-sub', text: t('error_api_key_sub') }));
  }
  resultContent.appendChild(box);

  const actions = el('div', { cls: 'error-actions' });
  const retryBtn = el('button', { cls: 'btn-retry', text: t('btn_retry') });
  const settingsBtn = el('button', { cls: 'btn-go-settings', text: t('btn_open_settings') });
  retryBtn.addEventListener('click', () => { if (retryText) doTranslate(retryText); });
  settingsBtn.addEventListener('click', openSettings);
  actions.append(retryBtn, settingsBtn);
  resultContent.appendChild(actions);
}
