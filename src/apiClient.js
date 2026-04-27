import { buildSystemPrompt } from './prompts.js';

const ENDPOINTS = {
  groq:       'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

const MODEL_IDS = {
  groq: {
    llama4:   'meta-llama/llama-4-scout-17b-16e-instruct',
    llama70b: 'llama-3.3-70b-versatile',
    kimi:     'moonshotai/kimi-k2-instruct',
    qwen3:    'qwen/qwen3-32b',
    gemma2:   'gemma2-9b-it',
  },
  openrouter: {
    llama4:   'meta-llama/llama-4-scout',
    llama70b: 'meta-llama/llama-3.3-70b-instruct',
    kimi:     'moonshotai/kimi-k2',
    qwen3:    'qwen/qwen3-32b',
    gemma2:   'google/gemma-2-9b-it',
  },
};

export const DEFAULT_MODEL_KEY = 'llama4';

function detectProvider(apiKey) {
  return apiKey?.startsWith('sk-or-') ? 'openrouter' : 'groq';
}

export class RateLimitError extends Error {
  constructor() { super('Rate limit exceeded'); this.name = 'RateLimitError'; }
}
export class NetworkError extends Error {
  constructor(msg = 'Network failure') { super(msg); this.name = 'NetworkError'; }
}
export class InvalidKeyError extends Error {
  constructor() { super('Invalid or missing API key'); this.name = 'InvalidKeyError'; }
}
export class InvalidResponseError extends Error {
  constructor(msg = 'Unexpected response format') { super(msg); this.name = 'InvalidResponseError'; }
}

const REQUEST_TIMEOUT_MS = 30_000;

function parseSSELine(line) {
  if (!line.startsWith('data: ') || line === 'data: [DONE]') return null;
  try { return JSON.parse(line.slice(6)); } catch { return null; }
}

function extractResultFromJson(raw) {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed.literal || !parsed.nuance || !Array.isArray(parsed.alternatives)) {
      throw new InvalidResponseError('Missing required fields in response');
    }
    return parsed;
  } catch (e) {
    if (e instanceof InvalidResponseError) throw e;
    throw new InvalidResponseError('Failed to parse JSON response');
  }
}

export class TranslatorAPI {
  async translate(text, { apiKey, uiLanguage = 'ko', direction = 'auto', modelKey = DEFAULT_MODEL_KEY, onChunk, signal } = {}) {
    const provider = detectProvider(apiKey);
    const model = MODEL_IDS[provider]?.[modelKey] ?? MODEL_IDS.groq[DEFAULT_MODEL_KEY];
    return this._translate(text, { apiKey, uiLanguage, direction, model, provider, onChunk, signal });
  }

  async _translate(text, { apiKey, uiLanguage, direction, model, provider, onChunk, signal }) {
    const systemPrompt = buildSystemPrompt(uiLanguage, direction);
    const useStream = typeof onChunk === 'function';

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

    const combined = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    };
    if (provider === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/ChrisChae00/haen-extension';
      headers['X-Title'] = 'Haen Translator';
    }

    let response;
    try {
      response = await fetch(ENDPOINTS[provider], {
        method: 'POST',
        signal: combined,
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text },
          ],
          response_format: { type: 'json_object' },
          stream: useStream,
          temperature: 0.3,
          max_tokens: 1024,
        }),
      });
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') throw new NetworkError('Request aborted');
      throw new NetworkError();
    }
    clearTimeout(timeoutId);

    if (response.status === 401 || response.status === 403) throw new InvalidKeyError();
    if (response.status === 429) throw new RateLimitError();
    if (!response.ok) throw new NetworkError(`HTTP ${response.status}`);

    if (useStream) {
      return this._handleStream(response, onChunk, combined);
    }

    let json;
    try {
      json = await response.json();
    } catch {
      throw new InvalidResponseError('Failed to parse response body');
    }

    const raw = json.choices?.[0]?.message?.content;
    if (!raw) throw new InvalidResponseError('Empty content in response');
    return extractResultFromJson(raw);
  }

  async _handleStream(response, onChunk, signal) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';
    let contentAccumulated = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });

        // Only consume complete lines; keep any trailing partial line in buffer
        const newlineIdx = lineBuffer.lastIndexOf('\n');
        if (newlineIdx === -1) continue;

        const completeLines = lineBuffer.slice(0, newlineIdx).split('\n');
        lineBuffer = lineBuffer.slice(newlineIdx + 1);

        for (const line of completeLines) {
          const chunk = parseSSELine(line.trim());
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (delta) {
            contentAccumulated += delta;
            onChunk(contentAccumulated);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!contentAccumulated) throw new InvalidResponseError('Empty stream response');
    return extractResultFromJson(contentAccumulated);
  }
}
