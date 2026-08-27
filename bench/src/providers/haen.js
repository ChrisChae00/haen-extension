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

// Raised when every configured key has hit its quota. It is not a per-item failure:
// recording it as one would mark the rest of the dataset "failed" at ~40 minutes each
// (two retries against an exhausted daily budget) and produce a results directory that
// looks measured but is entirely 429s. run.js stops the run on this instead, keeping
// whatever completed.
export class AllKeysExhausted extends Error {
  constructor(keyCount, cause) {
    super(`all ${keyCount} API key(s) hit their quota: ${cause.message}`);
    this.name = 'AllKeysExhausted';
    this.keyCount = keyCount;
    this.fatal = true;
  }
}

// Raised when the network goes away mid-run. A laptop that changes wifi, sleeps, or
// walks out of range fails every remaining item in milliseconds, and those rows are
// written to predictions.jsonl where resume skips them forever - 145 of 424 items were
// lost that way overnight. A model does not stop being reachable for 10 items in a row
// on its own, so the streak is treated as a run-level fault, not 145 measurements.
// Only fetch-level failures count (NetworkError with no HTTP status: DNS, refused
// connection, the 30s timeout). An HTTP 5xx also arrives as NetworkError but carries a
// status - the connection reached the provider, so it is the provider failing, which is
// a measurement, not a dead link.
export class NetworkGone extends Error {
  constructor(streak, cause) {
    super(`${streak} consecutive network failures - the connection is gone: ${cause.message}`);
    this.name = 'NetworkGone';
    this.fatal = true;
  }
}

const NETWORK_FAILURE_STREAK = 10;

// `api` is injectable so the key-rotation and network-streak logic below can be tested
// without a network - it is the logic that decides whether a run keeps writing rows or
// stops, and it has already lost a run's worth of items once by getting that wrong.
export function makeHaenProvider(config, api = new TranslatorAPI()) {
  const apiKeys = resolveApiKeys(config);
  // Shared across items, not reset per item: once a key is quota-exhausted it stays
  // exhausted for the rest of the run, so remember where rotation left off instead of
  // re-discovering it (and eating a RateLimitError's retry backoff) on every item.
  let keyIndex = 0;
  // Same reasoning as keyIndex: the streak spans items, not attempts within one item.
  let networkFailures = 0;

  return async function translate(item) {
    // onRaw fires once per HTTP response that carried a body, so counting it gives the
    // number of attempts. Retries triggered by network failures or 429s never produce a
    // body and stay invisible from out here - latency captures their cost, which is the
    // number that matters to a user.
    let raw = '';
    let usage = null;
    let attempts = 0;
    let meta = { ttfbMs: null };
    // apiClient retries a broken stream once with onChunk removed (src/apiClient.js:204).
    // That second onRaw carries ttfbMs: null, and letting it overwrite the streaming meta
    // drops the item from the TTFB percentiles entirely - so exactly the items where
    // streaming misbehaved vanish from the "streaming TTFB" numbers. Keep the first
    // measurement and record that the fallback happened instead of hiding it.
    let streamFallback = false;
    const onRaw = (body, u, m) => {
      attempts++;
      raw = body;
      if (u) usage = u;
      if (m) {
        if (meta.ttfbMs !== null && m.ttfbMs === null) streamFallback = true;
        meta = { ...m, ttfbMs: m.ttfbMs ?? meta.ttfbMs };
      }
    };

    let started = performance.now();
    let parsed = null;
    let error = null;
    // apiClient exhausts its own internal retries before a RateLimitError surfaces here,
    // so rotation only kicks in once a key is genuinely out of quota - not on ordinary
    // transient 429s, which apiClient already absorbs.
    for (;;) {
      try {
        // Re-armed per attempt: latency means "what a user waits", and a user has one
        // key. Time spent on an exhausted key plus apiClient's internal backoff before
        // rotation is harness overhead, and leaving it in inflates p90/p99 as if the
        // model were slow. The discarded attempts still show up in `retries`.
        started = performance.now();
        // Transport-level prompt text, appended to the message the model sees. The only
        // current use is Qwen3's `/no_think`: the Ollama experimental runner ignores
        // `reasoning_effort` and this tag is the only way to turn thinking off there.
        // It is appended to the user message, not the system prompt - the standard Ollama
        // runner demonstrably ignores it in the system position (bench/configs/README.md).
        // Hashed into promptHash, so a no-think run is never mistaken for a thinking one.
        parsed = await api.translate(item.source + (config.promptSuffix ?? ''), {
          apiKey: apiKeys[keyIndex],
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
          // Groq bills TPD/TPM against the requested max_tokens, not actual usage, so a
          // 2048 default reserves ~6x what a Haen response really costs. Configs lower it
          // to stretch the free-tier budget; unset keeps apiClient's shipping default.
          ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
          // OpenRouter only. Pins which backend serves the model so latency/TTFB measure
          // one serving stack; unpinned, the cheapest route wins and it is often 10x slower.
          ...(config.providerRouting ? { providerRouting: config.providerRouting } : {}),
          // Thinking budget. Unset leaves the model's default; "none" disables reasoning
          // on backends that honour it. Changes what the model does, not just how it is
          // routed, so a run that sets it is a different measurement, not a faster one.
          ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
          onRaw,
          // If config.stream is true, pass a dummy onChunk to measure streaming TTFB
          ...(config.stream ? { onChunk: () => {} } : {}),
        });
        networkFailures = 0;
        break;
      } catch (e) {
        if (e.name === 'RateLimitError') {
          if (keyIndex < apiKeys.length - 1) {
            keyIndex++;
            console.log(`\n  key ${keyIndex} exhausted, rotating to key ${keyIndex + 1}/${apiKeys.length}`);
            continue;
          }
          throw new AllKeysExhausted(apiKeys.length, e);
        }
        // A dead key is not a per-item failure either. When the key hits a spend cap
        // (OpenRouter returns 401 "Key limit exceeded", which apiClient maps to
        // InvalidKeyError) every remaining item fails in milliseconds and gets written to
        // predictions.jsonl - and because resume skips any (runIndex, id) already on disk,
        // those rows poison the run permanently. Observed: 384 of 424 items burned in
        // seconds. Stop like an exhausted quota does and keep what actually measured.
        if (e.name === 'InvalidKeyError') throw new AllKeysExhausted(apiKeys.length, e);
        // A TypeError here is a harness bug, not a transient: apiClient converts every
        // fetch-level failure into NetworkError, so nothing legitimate reaches this line
        // under that name. Rethrowing crashes the run loudly (mapPool only swallows
        // e.fatal) instead of writing 424 fabricated failure rows that resume would skip.
        if (e instanceof TypeError) throw e;
        if (e.name === 'NetworkError' && e.status == null) {
          if (++networkFailures >= NETWORK_FAILURE_STREAK) throw new NetworkGone(networkFailures, e);
        } else {
          // The streak means *consecutive*. Any other outcome - a 5xx, a parse failure -
          // proves the connection is alive, so it breaks the run of dead-link failures.
          // Without this reset, ten network blips spread across a whole run accumulate
          // into a false "the connection is gone" and kill a healthy run.
          networkFailures = 0;
        }
        error = { name: e.name, message: e.message, status: e.status ?? null };
        break;
      }
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
      // reasoning_tokens is not in the base OpenAI usage schema, and providers that
      // serve thinking models disagree about where those tokens go. Google reports a
      // total_tokens that exceeds prompt + completion (23 + 592 but 1522 total on
      // gemini-3.7-flash, the gap visible as thoughtsTokenCount only on the native
      // endpoint - see docs/ENGINEERING-LOG.md 1.9), so billing off completion_tokens
      // alone understates a reasoning model by roughly half.
      //
      // Prefer the explicit field where the provider sends it. Fall back to the gap,
      // which is 0 for models that hide nothing - but only when total_tokens is
      // actually present. Without it the subtraction is 0 - prompt - completion, and
      // clamping that to 0 would record "this model thought nothing" for a response
      // that never reported a total. That is unmeasured, so it is null.
      usage: usage ? {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens
          ?? (usage.total_tokens == null
            ? null
            : Math.max(0, usage.total_tokens - (usage.prompt_tokens ?? 0) - (usage.completion_tokens ?? 0))),
      } : null,
      latencyMs,
      ttfbMs: meta.ttfbMs,
      streamFallback,
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

// config.apiKeyEnv is a single env var name or an array of them (multiple accounts to
// rotate through on quota exhaustion). Returns [undefined] when no key is configured
// (e.g. a local Ollama provider that needs none).
function resolveApiKeys(config) {
  if (!config.apiKeyEnv) return [undefined];
  const names = Array.isArray(config.apiKeyEnv) ? config.apiKeyEnv : [config.apiKeyEnv];
  const missing = names.filter(name => !process.env[name]);
  if (missing.length) {
    throw new Error(`${config.name}: environment variable(s) ${missing.join(', ')} not set`);
  }
  return names.map(name => process.env[name]);
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
