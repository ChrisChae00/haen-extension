import { buildSystemPrompt } from './prompts.js';

const ENDPOINTS = {
  groq:       'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  // Google AI Studio's OpenAI-compatible endpoint — lets Gemini be called with
  // a free-tier Google AI Studio key ("AIza...") instead of routing through
  // OpenRouter (which only offers Gemini as a paid or rate-limited model).
  google:     'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
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
    gemini:   'google/gemini-2.5-flash',
  },
  google: {
    // "-latest" is Google's evergreen alias — always resolves to their current
    // recommended Flash model, so this doesn't need updating every time Google
    // deprecates a dated snapshot (e.g. gemini-2.5-flash was retired for new users).
    gemini: 'gemini-flash-latest',
  },
};

export const DEFAULT_MODEL_KEY = 'llama4';

// Each provider's model to fall back to when the user's selected modelKey
// isn't offered by their detected provider (e.g. a Google AI Studio key with
// "Llama 4 Scout" selected — Google doesn't serve Llama, so use its own default).
const PROVIDER_DEFAULT_MODEL_KEY = { groq: 'llama4', openrouter: 'llama4', google: 'gemini' };

// Kimi K2 doesn't support response_format: json_object — prompt-only is sufficient
const NO_JSON_MODE = new Set(['kimi']);

// Google AI Studio key formats have changed over time (classic keys start with
// "AIza", but newer ones don't follow that pattern), so prefix-sniffing alone
// isn't reliable. The Gemini model is never served by Groq, so if the user has
// selected it and the key isn't an OpenRouter key, it must be a Google AI
// Studio key — route there regardless of what the key looks like.
function detectProvider(apiKey, modelKey) {
  if (apiKey?.startsWith('sk-or-')) return 'openrouter';
  if (apiKey?.startsWith('AIza') || modelKey === 'gemini') return 'google';
  return 'groq';
}

export class RateLimitError extends Error {
  constructor(retryAfterMs) {
    super('Rate limit exceeded');
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}
export class NetworkError extends Error {
  constructor(msg = 'Network failure', status) {
    super(msg);
    this.name = 'NetworkError';
    this.status = status; // undefined for fetch-level failures (no HTTP response)
  }
}
export class InvalidKeyError extends Error {
  constructor() { super('Invalid or missing API key'); this.name = 'InvalidKeyError'; }
}
export class InvalidResponseError extends Error {
  constructor(msg = 'Unexpected response format') { super(msg); this.name = 'InvalidResponseError'; }
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_DELAYS_MS = [500, 1500];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseRetryAfterMs(response) {
  const header = response.headers?.get?.('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function parseSSELine(line) {
  if (!line.startsWith('data: ') || line === 'data: [DONE]') return null;
  try { return JSON.parse(line.slice(6)); } catch { return null; }
}

function extractResultFromJson(raw) {
  let text = raw.trim();

  // Strip markdown code fences some models add (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Extract first JSON object if model adds prose before/after
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) text = objMatch[0];

  console.log('[Haen] raw response:', text.slice(0, 300));

  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.natural !== 'string' || typeof parsed.nuance !== 'string' || !Array.isArray(parsed.alternatives)) {
      console.error('[Haen] missing fields:', { natural: parsed.natural, nuance: parsed.nuance, alternatives: parsed.alternatives });
      throw new InvalidResponseError('Missing required fields in response');
    }
    return parsed;
  } catch (e) {
    if (e instanceof InvalidResponseError) throw e;

    // Last-resort salvage: the response was truncated or otherwise malformed, but if
    // at least the (short, early) "natural" field made it through, surface that instead
    // of a bare error — the user gets a usable translation with an empty alternatives tab
    // rather than nothing at all.
    const salvaged = parsePartial(raw);
    if (salvaged.natural) {
      console.error('[Haen] JSON parse failed, salvaging partial result:', text.slice(0, 200));
      return { alternatives: [], ...salvaged };
    }

    console.error('[Haen] JSON parse failed on:', text.slice(0, 200));
    throw new InvalidResponseError('Failed to parse JSON response');
  }
}

// Best-effort extraction of a single completed top-level string field from a
// still-in-progress (possibly truncated) JSON string, for progressive rendering
// while a stream is in flight. Only string fields are supported — "alternatives"
// is a nested array and isn't safe to partially parse, so it's rendered only
// once the full response has arrived.
function extractPartialField(text, field) {
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = text.match(re);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

export function parsePartial(raw) {
  if (!raw) return {};
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*)/);
  if (fenceMatch) text = fenceMatch[1];

  const result = {};
  for (const field of ['detected_lang', 'target_lang', 'natural', 'literal', 'nuance', 'tip']) {
    const value = extractPartialField(text, field);
    if (value !== undefined) result[field] = value;
  }
  return result;
}

export class TranslatorAPI {
  async translate(text, { apiKey, uiLanguage = 'ko', direction = 'auto', modelKey = DEFAULT_MODEL_KEY, onChunk, signal } = {}) {
    const provider = detectProvider(apiKey, modelKey);
    const model = MODEL_IDS[provider]?.[modelKey] ?? MODEL_IDS[provider]?.[PROVIDER_DEFAULT_MODEL_KEY[provider]];
    const params = { apiKey, uiLanguage, direction, model, modelKey, provider, onChunk, signal };

    try {
      return await this._translateWithRetry(text, params);
    } catch (e) {
      // A malformed/truncated JSON response is often a one-off model hiccup.
      // Retry once, non-streaming, to get a clean full body instead of surfacing
      // an error immediately. Only makes sense to retry once per request.
      if (e instanceof InvalidResponseError && typeof onChunk === 'function' && !signal?.aborted) {
        return await this._translateWithRetry(text, { ...params, onChunk: undefined });
      }
      throw e;
    }
  }

  async _translateWithRetry(text, params) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this._translate(text, params);
      } catch (e) {
        lastError = e;
        if (params.signal?.aborted) throw e; // real user cancellation — never retry
        const retryable =
          e instanceof RateLimitError ||
          (e instanceof NetworkError && (e.status === undefined || e.status >= 500));
        if (!retryable || attempt === MAX_RETRIES) throw e;
        await sleep(e.retryAfterMs ?? RETRY_DELAYS_MS[attempt]);
      }
    }
    throw lastError;
  }

  async _translate(text, { apiKey, uiLanguage, direction, model, modelKey, provider, onChunk, signal }) {
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
          ...(!NO_JSON_MODE.has(modelKey) && { response_format: { type: 'json_object' } }),
          // Gemini is a "thinking" model — on Google's OpenAI-compatible endpoint its
          // reasoning tokens eat into the completion budget unless disabled, which was
          // causing responses to truncate before the JSON closed. Translation doesn't
          // benefit from extended reasoning, so turn it off entirely for this provider.
          ...(provider === 'google' && { reasoning_effort: 'none' }),
          stream: useStream,
          temperature: 0.3,
          max_tokens: 2048,
        }),
      });
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') throw new NetworkError('Request aborted');
      throw new NetworkError();
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      // Log the provider's actual error body — 401/403 gets collapsed into a generic
      // "invalid key" message for the user, but the real cause (bad key, API not
      // enabled, referrer restriction, etc.) is only visible in this response body.
      const errorBody = await response.clone().text().catch(() => '');
      console.error(`[Haen] ${provider} HTTP ${response.status}:`, errorBody.slice(0, 500));
    }

    if (response.status === 401 || response.status === 403) throw new InvalidKeyError();
    if (response.status === 429) throw new RateLimitError(parseRetryAfterMs(response));
    if (!response.ok) throw new NetworkError(`HTTP ${response.status}`, response.status);

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
