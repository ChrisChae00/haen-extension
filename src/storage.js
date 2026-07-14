const _get = (key, defaultValue = null) =>
  new Promise(resolve =>
    chrome.storage.local.get(key, result =>
      resolve(result[key] !== undefined ? result[key] : defaultValue)
    )
  );

const _set = (key, value) =>
  new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));

export const getApiKey = () => _get('apiKey');
export const setApiKey = key => _set('apiKey', key);
export const clearApiKey = () =>
  new Promise(resolve => chrome.storage.local.remove('apiKey', resolve));

export const getModel = () => _get('model', 'llama4');
export const setModel = modelId => _set('model', modelId);

export const getUILanguage = () => _get('uiLanguage', 'ko');
export const setUILanguage = lang => _set('uiLanguage', lang);

export const getTheme = () => _get('theme', 'auto');
export const setTheme = theme => _set('theme', theme);

export const getDirection = () => _get('direction', 'auto');
export const setDirection = dir => _set('direction', dir);

const HISTORY_MAX = 50;

export const getHistory = () => _get('history', []);

export const addToHistory = async entry => {
  const history = await getHistory();
  history.unshift({ ...entry, timestamp: Date.now() });
  if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
  await _set('history', history);
};

export const clearHistory = () => _set('history', []);

export const getAutoCopy = () => _get('autoCopy', false);
export const setAutoCopy = val => _set('autoCopy', val);

// ── Response cache ───────────────────────────────────────────────────────────
// Keyed on the exact inputs that affect the model's output, so a repeat
// translation is served instantly instead of re-hitting the API.
const CACHE_MAX = 100;

const cacheKey = ({ text, direction, modelKey, uiLanguage }) =>
  `${uiLanguage}|${direction}|${modelKey}|${text}`;

export const getCached = async ({ text, direction, modelKey, uiLanguage }) => {
  const cache = await _get('cache', {});
  return cache[cacheKey({ text, direction, modelKey, uiLanguage })]?.result ?? null;
};

export const setCached = async ({ text, direction, modelKey, uiLanguage, result }) => {
  const cache = await _get('cache', {});
  cache[cacheKey({ text, direction, modelKey, uiLanguage })] = { result, ts: Date.now() };

  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX) {
    const oldestKey = keys.reduce((a, b) => (cache[a].ts <= cache[b].ts ? a : b));
    delete cache[oldestKey];
  }
  await _set('cache', cache);
};
