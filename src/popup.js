// Direction value maps between popup.html (data-dir) and background/storage formats
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
let currentTheme = 'auto';
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
const btnSettings     = $('btn-settings'); // gear icon → dark mode toggle
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
const darkToggle      = $('dark-toggle');
const autoCopyTog     = $('auto-copy-toggle');
const btnSave         = $('btn-save');
const settingsLangSeg = $('settings-lang-seg');

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await initI18n();
  applyTranslations(document.body);

  const [theme, storedDir, lang] = await Promise.all([
    stor('theme'), stor('direction'), stor('uiLanguage'),
  ]);

  const resolved = theme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  if (!theme) await storSet({ theme: resolved });
  currentTheme = resolved;
  applyTheme(currentTheme);
  syncDarkToggleUI();
  currentDir = DIR_FROM_STOR[storedDir] ?? 'auto';
  setDirActive(currentDir);

  const activeLang = lang ?? getCurrentLanguage();
  uiLangSeg.querySelectorAll('span').forEach(s =>
    s.classList.toggle('active', s.dataset.lang === activeLang));
});

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
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

// ── Dark mode toggle (gear icon) ──────────────────────────────────────────────
btnSettings.addEventListener('click', async () => {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(currentTheme);
  await storSet({ theme: currentTheme });
  syncDarkToggleUI();
});

function syncDarkToggleUI() {
  btnSettings.style.color = currentTheme === 'dark' ? 'var(--color-accent-lt)' : '';
}

// ── Settings panel toggle (··· button) ────────────────────────────────────────
btnMore.addEventListener('click', () =>
  settingsOpen ? closeSettings() : openSettings());

async function openSettings() {
  settingsOpen = true;
  mainContent.style.display = 'none';
  settingsPanel.style.display = 'flex';
  settingsWm.style.display = 'inline';
  uiLangSeg.style.display = 'none';
  btnMore.style.opacity = '0.5';

  const [apiKey, model, storedDir, lang, theme, autoCopy] = await Promise.all([
    stor('apiKey'), stor('model'), stor('direction'),
    stor('uiLanguage'), stor('theme'), stor('autoCopy'),
  ]);

  apiKeyInput.value = apiKey ?? '';
  modelSelect.value = model ?? 'llama4';
  defaultDirSel.value = DIR_FROM_STOR[storedDir] ?? 'auto';

  const activeLang = lang ?? getCurrentLanguage();
  settingsLangSeg.querySelectorAll('span').forEach(s =>
    s.classList.toggle('active', s.dataset.lang === activeLang));

  darkToggle.classList.toggle('on', currentTheme === 'dark');
  autoCopyTog.classList.toggle('on', autoCopy === true);
}

function closeSettings() {
  settingsOpen = false;
  settingsPanel.style.display = 'none';
  mainContent.style.display = '';
  settingsWm.style.display = 'none';
  uiLangSeg.style.display = '';
  btnMore.style.opacity = '';
}

// ── Settings inputs ───────────────────────────────────────────────────────────
btnToggleKey.addEventListener('click', () => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
});

darkToggle.addEventListener('click', () => {
  const on = darkToggle.classList.toggle('on');
  currentTheme = on ? 'dark' : 'light';
  applyTheme(currentTheme);
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
  const theme = darkToggle.classList.contains('on') ? 'dark' : 'light';
  const autoCopy = autoCopyTog.classList.contains('on');
  const dir = DIR_TO_API[defaultDirSel.value] ?? 'auto';

  currentTheme = theme;
  applyTheme(currentTheme);
  syncDarkToggleUI();

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
  setTimeout(() => { btnSave.textContent = orig; }, 1500);
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
  let firstChunk = true;

  const port = chrome.runtime.connect({ name: 'translate' });
  port.postMessage({ action: 'translate', text, direction: DIR_TO_API[currentDir] });

  signal.addEventListener('abort', () => port.disconnect(), { once: true });

  port.onMessage.addListener(async msg => {
    if (signal.aborted) return;
    if (msg.type === 'chunk' && firstChunk) {
      firstChunk = false;
      showShimmer(1);
    }
    if (msg.type === 'done') {
      setTranslating(false);
      renderResult(msg.result);
      stor('autoCopy').then(autoCopy => {
        if (autoCopy) navigator.clipboard.writeText(msg.result.literal).catch(() => {});
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

function showTab(tab) {
  if (!lastResult) return;
  const r = lastResult;
  resultContent.textContent = '';

  if (tab === 'translation') {
    const literalLabel = el('div', { cls: 'result-section-label', text: t('label_literal') });
    const literalText = el('p', { text: r.literal });
    literalText.style.cssText = 'font-size:15px;line-height:1.7;color:var(--color-ink-900);margin-bottom:8px;';
    const copyRow = el('div', { cls: 'copy-row' });
    copyRow.appendChild(makeCopyBtn(r.literal, 'btn-copy'));

    resultContent.append(literalLabel, literalText);

    if (r.literal_note) {
      const note = el('p', { cls: 'literal-note', text: r.literal_note });
      resultContent.appendChild(note);
    }

    resultContent.appendChild(copyRow);
    resultContent.appendChild(el('div', { cls: 'result-divider' }));

    const nuanceLabel = el('div', { cls: 'result-section-label' });
    const langBadge = el('span', { cls: 'badge badge-lang', text: `${r.detected_lang} → ${r.target_lang}` });
    nuanceLabel.append(el('span', { text: t('label_nuance') }), langBadge);
    const nuanceText = el('p', { text: r.nuance });
    nuanceText.style.cssText = 'font-size:13px;line-height:1.75;color:var(--color-ink-900);margin-top:8px;';
    resultContent.append(nuanceLabel, nuanceText);

    if (r.tip) {
      const tipBox = el('div', { cls: 'tip-card' });
      tipBox.appendChild(el('div', { cls: 'tip-label', text: `💡 ${t('label_tip')}` }));
      tipBox.appendChild(el('p', { text: r.tip }));
      resultContent.appendChild(tipBox);
    }

  } else if (tab === 'alternatives') {
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
