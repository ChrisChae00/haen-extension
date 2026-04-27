import { TranslatorAPI, DEFAULT_MODEL_KEY, RateLimitError, NetworkError, InvalidKeyError, InvalidResponseError } from './src/apiClient.js';
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

  const abortController = new AbortController();
  port.onDisconnect.addListener(() => abortController.abort());

  port.onMessage.addListener(async msg => {
    if (msg.action !== 'translate') return;

    const { text, direction = 'auto' } = msg;

    const apiKey = await getApiKey();
    if (!apiKey) {
      port.postMessage({ type: 'error', errorKey: 'error_api_key_title' });
      port.disconnect();
      return;
    }

    const modelKey = await getModel() ?? DEFAULT_MODEL_KEY;
    const uiLanguage = await getUILanguage();

    const api = new TranslatorAPI();
    try {
      const result = await api.translate(text, {
        apiKey,
        uiLanguage,
        direction,
        modelKey,
        signal: abortController.signal,
        onChunk: chunk => {
          if (!abortController.signal.aborted) port.postMessage({ type: 'chunk', text: chunk });
        },
      });
      if (!abortController.signal.aborted) port.postMessage({ type: 'done', result });
    } catch (e) {
      if (abortController.signal.aborted) return;
      console.error('[Haen] translate failed:', e.name);
      port.postMessage({ type: 'error', errorKey: mapErrorToI18nKey(e) });
    } finally {
      if (!abortController.signal.aborted) port.disconnect();
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

    const modelKey = await getModel() ?? DEFAULT_MODEL_KEY;
    const uiLanguage = await getUILanguage();

    const api = new TranslatorAPI();
    try {
      const result = await api.translate(text, { apiKey, uiLanguage, direction, modelKey });
      sendResponse({ type: 'done', result });
    } catch (e) {
      console.error('[Haen] translate failed:', e.name);
      sendResponse({ type: 'error', errorKey: mapErrorToI18nKey(e) });
    }
  })();

  return true; // keep channel open for async sendResponse
});
