import { buildSystemPrompt } from './prompts.js';

const ENDPOINTS = {
  groq:       'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  // Google AI Studio's OpenAI-compatible endpoint — lets Gemini be called with
  // a free-tier Google AI Studio key ("AIza...") instead of routing through
  // OpenRouter (which only offers Gemini as a paid or rate-limited model).
  google:     'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  // Local models via Ollama's OpenAI-compatible endpoint. Never reached by the
  // extension (detectProvider never returns 'ollama'); it exists so the benchmark
  // harness can drive local models through this exact code path — same retry,
  // error mapping, and parsing as the hosted providers.
  ollama:     'http://localhost:11434/v1/chat/completions',
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
// The shipping ceiling. Referenced from both translate() and _translate() so the
// benchmark's "unset maxTokens keeps the extension's default" contract has one number
// behind it, not two that can drift apart.
const DEFAULT_MAX_TOKENS = 2048;
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

// Reasoning models (qwen3, gpt-oss) emit a <think> block before the answer. Its prose
// contains braces and even a sketch of the schema being planned, so the greedy {...}
// extraction below would splice reasoning into the JSON — and when the answer itself was
// cut off by max_tokens, parsePartial happily salvaged `"natural": "..."` out of the
// model's own scratchpad and returned it as a translation. Strip the block first. An
// unclosed <think> means the answer never arrived; there is nothing to salvage.
export function stripThinking(raw) {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '');
}

// Exported for the benchmark's parser tests; the extension never calls it directly.
export const parseForTest = raw => extractResultFromJson(raw);

function extractResultFromJson(raw) {
  let text = stripThinking(raw).trim();

  // Strip markdown code fences some models add (```json ... ``` or ``` ... ```)
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Extract the JSON object if the model adds prose before/after. Not the greedy
  // first-brace-to-last-brace slice this used to be: some backends stream reasoning as
  // plain prose with no <think> tags at all (Alibaba's qwen3.6 opens with "Here's a
  // thinking process:" and sketches the schema, braces and all), so the first `{` is
  // inside the scratchpad and the slice is unparseable. Every candidate start is tried in
  // order and the first one that parses into a real result wins, which skips the prose.
  // ponytail: O(braces × body length) - every `{` costs a slice and a JSON.parse to the
  // last `}`. Fine at Haen's response size (a few KB, single-digit braces in prose).
  // If a model ever streams pages of reasoning, bound it: stop after N candidates, or
  // scan backwards from the last `{` since the answer is always last.
  const lastBrace = text.lastIndexOf('}');
  if (lastBrace !== -1) {
    for (let i = text.indexOf('{'); i !== -1 && i < lastBrace; i = text.indexOf('{', i + 1)) {
      const candidate = text.slice(i, lastBrace + 1);
      try {
        const obj = JSON.parse(candidate);
        if (typeof obj?.natural === 'string') { text = candidate; break; }
      } catch { /* prose brace, or a nested object - try the next one */ }
    }
  }

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
  // Global + last match: a reasoning model that plans its answer in prose writes the
  // field name once in the sketch ("natural": "...") before writing it for real. The
  // first match is the plan; the last one is the answer.
  const re = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  const matches = [...text.matchAll(re)];
  const match = matches.at(-1);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

export function parsePartial(raw) {
  if (!raw) return {};
  let text = stripThinking(raw).trim();
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
  // provider / modelId / temperature / jsonMode / maxTokens / providerRouting / onRaw are benchmark-facing escape
  // hatches. The extension never passes them: provider falls back to key-prefix
  // detection, modelId to the MODEL_IDS lookup, temperature to the shipping default,
  // jsonMode to the NO_JSON_MODE lookup (which only knows the extension's own model
  // keys). They exist so the harness can pin an exact model and a deterministic
  // temperature, tell the client whether an arbitrary benchmarked model supports
  // response_format (NO_JSON_MODE can't, since it's keyed on modelKey, not modelId),
  // and capture the raw response body even when parsing fails (parse failures are a
  // measured result, not just an error). maxTokens exists because some providers (Groq)
  // bill their free-tier token budget against the requested ceiling rather than actual
  // usage, so the harness needs to lower it without changing what the extension sends.
  async translate(text, { apiKey, uiLanguage = 'ko', direction = 'auto', modelKey = DEFAULT_MODEL_KEY, provider: providerOverride, modelId, temperature = 0.3, jsonMode, maxTokens = DEFAULT_MAX_TOKENS, providerRouting, reasoningEffort, systemPromptOverride, onRaw, onChunk, signal } = {}) {
    const provider = providerOverride ?? detectProvider(apiKey, modelKey);
    const model = modelId
      ?? MODEL_IDS[provider]?.[modelKey]
      ?? MODEL_IDS[provider]?.[PROVIDER_DEFAULT_MODEL_KEY[provider]];
    const useJsonMode = jsonMode ?? !NO_JSON_MODE.has(modelKey);

    const params = { apiKey, uiLanguage, direction, model, modelKey, provider, temperature, maxTokens, providerRouting, reasoningEffort, useJsonMode, systemPromptOverride, onRaw, onChunk, signal };

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

  async _translate(text, { apiKey, uiLanguage, direction, model, modelKey, provider, temperature, maxTokens = DEFAULT_MAX_TOKENS, providerRouting, reasoningEffort, useJsonMode, systemPromptOverride, onRaw, onChunk, signal }) {
    const systemPrompt = systemPromptOverride ?? buildSystemPrompt(uiLanguage, direction);
    const useStream = typeof onChunk === 'function';
    const startedAt = performance.now();

    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);

    const combined = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    const headers = { 'Content-Type': 'application/json' };
    // Local providers have no key — sending "Bearer undefined" is worse than sending nothing.
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
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
          ...(useJsonMode && { response_format: { type: 'json_object' } }),
          // Benchmark-only. OpenRouter routes to the cheapest provider by default, and
          // "cheapest" is routinely the slowest: gpt-oss-120b came back at 34s/21s TTFB
          // there versus a few seconds on Groq. That number would land in the report's
          // latency column as if it were a property of the model. Pinning the backend
          // makes the serving stack a recorded constant instead of a hidden variable.
          ...(provider === 'openrouter' && providerRouting ? { provider: providerRouting } : {}),
          // Benchmark-only. Reasoning models spend most of their wall clock thinking:
          // decomposing qwen3:14b's 43s per item gave thinking 23.9s (59%), decode 17.1s
          // and prefill only 3.2s (docs/ENGINEERING-LOG.md 2.4). "none" turns it off where
          // the backend honours it (Ollama does), and it is the only lever that moves
          // latency - but not a free one: it costs tipFactual 91.7% -> 66.7% (n=12, 3).
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          stream: useStream,
          // OpenAI-compatible streaming omits `usage` unless asked; without it every
          // streamed call would report zero tokens and a $0 cost.
          ...(useStream && { stream_options: { include_usage: true } }),
          temperature,
          max_tokens: maxTokens,
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
      return this._handleStream(response, onChunk, onRaw, combined, startedAt);
    }

    let json;
    try {
      json = await response.json();
    } catch {
      throw new InvalidResponseError('Failed to parse response body');
    }

    const raw = json.choices?.[0]?.message?.content;
    // TTFB is a streaming-only concept: without a stream, "first byte" and "full body"
    // arrive in the same event, so this field would just restate latencyMs under a
    // misleading name. Leave it null here; only _handleStream measures a real TTFB.
    onRaw?.(raw ?? '', json.usage, { ttfbMs: null });
    if (!raw) throw new InvalidResponseError('Empty content in response');
    return extractResultFromJson(raw);
  }

  async _handleStream(response, onChunk, onRaw, signal, startedAt = performance.now()) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';
    let contentAccumulated = '';
    let ttfbMs = null;
    let usage = null;

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
          // With stream_options.include_usage, the final chunk carries usage and an
          // empty choices array instead of a delta.
          if (chunk?.usage) usage = chunk.usage;
          const delta = chunk?.choices?.[0]?.delta?.content;
          if (delta) {
            if (ttfbMs === null) {
              ttfbMs = Math.round(performance.now() - startedAt);
            }
            contentAccumulated += delta;
            onChunk(contentAccumulated);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    onRaw?.(contentAccumulated, usage, { ttfbMs: ttfbMs ?? Math.round(performance.now() - startedAt) });
    if (!contentAccumulated) throw new InvalidResponseError('Empty stream response');
    return extractResultFromJson(contentAccumulated);
  }
}
