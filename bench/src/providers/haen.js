import { TranslatorAPI } from '../../../src/apiClient.js';
import { checkCompliance } from '../compliance.js';

// Drives the extension's real TranslatorAPI. Importing it rather than reimplementing
// the request is the whole point: the benchmark measures the code path users actually
// hit, including its retry policy, error mapping, and JSON salvage. A reimplementation
// would silently drift from the shipping client and the baseline would be a lie.
//
// This one provider covers every OpenAI-compatible backend the client knows about
// (Groq, OpenRouter, Google AI Studio, and local models via Ollama) because they differ
// only by endpoint and model id - both config data, not code. A backend that is NOT
// OpenAI-compatible (in-process transformers, a bespoke serving API) is what earns a
// second file here.

const api = new TranslatorAPI();

export function makeHaenProvider(config) {
  const apiKey = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (config.apiKeyEnv && !apiKey) {
    throw new Error(`${config.name}: environment variable ${config.apiKeyEnv} is not set`);
  }

  return async function translate(item) {
    // onRaw fires once per HTTP response that carried a body, so counting it gives the
    // number of attempts. Retries triggered by network failures or 429s never produce a
    // body and stay invisible from out here - latency captures their cost, which is the
    // number that matters to a user.
    let raw = '';
    let usage = null;
    let attempts = 0;
    const onRaw = (body, u) => { attempts++; raw = body; if (u) usage = u; };

    const started = performance.now();
    let parsed = null;
    let error = null;
    try {
      parsed = await api.translate(item.source, {
        apiKey,
        provider: config.provider,
        modelId: config.modelId,
        uiLanguage: config.uiLanguage ?? 'ko',
        direction: item.direction,
        temperature: config.temperature ?? 0,
        // apiClient's own NO_JSON_MODE table is keyed on the extension's model keys
        // (llama4, kimi, ...), not on an arbitrary benchmarked modelId, so it can't tell
        // whether a model under test supports response_format. Default true (most
        // OpenAI-compatible APIs do); configs for models that don't must set this false,
        // or every response gets forced into JSON server-side and compliance measures
        // the serving stack instead of the model's instruction-following.
        jsonMode: config.jsonMode ?? true,
        onRaw,
        // No onChunk: streaming off. Non-streaming is the deterministic path and the
        // only one that returns a usage block.
      });
    } catch (e) {
      error = { name: e.name, message: e.message, status: e.status ?? null };
    }
    const latencyMs = Math.round(performance.now() - started);

    return {
      id: item.id,
      direction: item.direction,
      slice: item.slice,
      // `natural` is the only field a reference translation can be compared against.
      hypothesis: typeof parsed?.natural === 'string' ? parsed.natural : '',
      raw,
      parsed,
      usage: usage ? {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
      } : null,
      latencyMs,
      retries: Math.max(0, attempts - 1),
      error,
      compliance: checkCompliance(raw, parsed, item, {
        uiLanguage: config.uiLanguage ?? 'ko',
        salvaged: wasSalvaged(raw, parsed),
        retries: Math.max(0, attempts - 1),
      }),
    };
  };
}

// apiClient falls back to parsePartial when the JSON is truncated, returning a result
// with an empty alternatives array (src/apiClient.js:122). It doesn't signal that from
// the outside, so infer it: a parsed result with no alternatives whose raw body isn't
// valid JSON can only have come from the salvage path.
// ponytail: inference, not a flag. If apiClient ever needs to report this exactly,
// have parsePartial's caller set a property on the returned object.
function wasSalvaged(raw, parsed) {
  if (!parsed || parsed.alternatives?.length !== 0) return false;
  try { JSON.parse(raw.trim()); return false; } catch { return true; }
}
