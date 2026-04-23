import { TranslatorAPI, MODELS, RateLimitError, NetworkError, InvalidKeyError, InvalidResponseError } from './src/apiClient.js';
import { getApiKey, getModel, getUILanguage } from './src/storage.js';

function mapErrorToI18nKey(e) {
  if (e instanceof InvalidKeyError) return 'error_api_key_title';
  if (e instanceof RateLimitError) return 'error_rate_limit';
  if (e instanceof NetworkError) return 'error_network';
  if (e instanceof InvalidResponseError) return 'error_server';
  return 'error_server';
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'translate') return;

  port.onMessage.addListener(async msg => {
    if (msg.action !== 'translate') return;

    const { text, direction = 'auto' } = msg;

    const apiKey = await getApiKey();
    if (!apiKey) {
      port.postMessage({ type: 'error', errorKey: 'error_api_key_title' });
      port.disconnect();
      return;
    }

    const modelKey = await getModel();
    const model = MODELS[modelKey] ?? MODELS.llama4;
    const uiLanguage = await getUILanguage();

    const api = new TranslatorAPI('groq');
    try {
      const result = await api.translate(text, {
        apiKey,
        uiLanguage,
        direction,
        model,
        onChunk: chunk => port.postMessage({ type: 'chunk', text: chunk }),
      });
      port.postMessage({ type: 'done', result });
    } catch (e) {
      console.error('[Haen] translate failed:', e.name);
      port.postMessage({ type: 'error', errorKey: mapErrorToI18nKey(e) });
    } finally {
      port.disconnect();
    }
  });
});

// One-shot fallback (non-streaming)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'translate') return false;

  const { text, direction = 'auto' } = msg;

  (async () => {
    const apiKey = await getApiKey();
    if (!apiKey) {
      sendResponse({ type: 'error', errorKey: 'error_api_key_title' });
      return;
    }

    const modelKey = await getModel();
    const model = MODELS[modelKey] ?? MODELS.llama4;
    const uiLanguage = await getUILanguage();

    const api = new TranslatorAPI('groq');
    try {
      const result = await api.translate(text, { apiKey, uiLanguage, direction, model });
      sendResponse({ type: 'done', result });
    } catch (e) {
      console.error('[Haen] translate failed:', e.name);
      sendResponse({ type: 'error', errorKey: mapErrorToI18nKey(e) });
    }
  })();

  return true; // keep channel open for async sendResponse
});
