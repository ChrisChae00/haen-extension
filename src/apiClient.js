import { buildSystemPrompt } from './prompts.js';

export const MODELS = {
  llama4: 'meta-llama/llama-4-scout-17b-16e-instruct',
  qwen3: 'qwen/qwen3-32b',
  gemma2: 'gemma2-9b-it',
};

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

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

function parseSSEChunks(text) {
  return text
    .split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => {
      try { return JSON.parse(line.slice(6)); } catch { return null; }
    })
    .filter(Boolean);
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
  constructor(provider = 'groq') {
    this.provider = provider;
  }

  async translate(text, { apiKey, uiLanguage = 'ko', direction = 'auto', model = MODELS.llama4, onChunk } = {}) {
    if (this.provider === 'groq') {
      return this._groqTranslate(text, { apiKey, uiLanguage, direction, model, onChunk });
    }
    throw new Error(`Unknown provider: ${this.provider}`);
  }

  async _groqTranslate(text, { apiKey, uiLanguage, direction, model, onChunk }) {
    const systemPrompt = buildSystemPrompt(uiLanguage, direction);
    const useStream = typeof onChunk === 'function';

    let response;
    try {
      response = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text },
          ],
          response_format: { type: 'json_object' },
          stream: useStream,
          temperature: 0.3,
          max_tokens: 512,
        }),
      });
    } catch {
      throw new NetworkError();
    }

    if (response.status === 401 || response.status === 403) throw new InvalidKeyError();
    if (response.status === 429) throw new RateLimitError();
    if (!response.ok) throw new NetworkError(`HTTP ${response.status}`);

    if (useStream) {
      return this._handleStream(response, onChunk);
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

  async _handleStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let contentAccumulated = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      accumulated += decoder.decode(value, { stream: true });
      const chunks = parseSSEChunks(accumulated);
      accumulated = '';

      for (const chunk of chunks) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          contentAccumulated += delta;
          onChunk(contentAccumulated);
        }
      }
    }

    if (!contentAccumulated) throw new InvalidResponseError('Empty stream response');
    return extractResultFromJson(contentAccumulated);
  }
}
