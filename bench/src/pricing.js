// Per-1M-token prices, in USD.
//
// `fetchedAt` is not decoration. Provider prices change silently, and six months
// from now a cost report built on stale numbers looks exactly like a correct one.
// Every entry carries the date it was verified, and report.md prints it.
//
// Adding a model = adding a row. Nothing else in the harness knows model names.
export const PRICING = {
  // --- Groq --- verified against console.groq.com/docs/models
  'openai/gpt-oss-120b':      { inputPer1M: 0.15,  outputPer1M: 0.60, fetchedAt: '2026-08-05' },
  'openai/gpt-oss-20b':       { inputPer1M: 0.075, outputPer1M: 0.30, fetchedAt: '2026-08-05' },
  'qwen/qwen3.6-27b':         { inputPer1M: 0.60,  outputPer1M: 3.00, fetchedAt: '2026-08-05' },
  'llama-3.1-8b-instant':     { inputPer1M: 0.05,  outputPer1M: 0.08, fetchedAt: '2026-08-05' },
  'llama-3.3-70b-versatile':  { inputPer1M: 0.59,  outputPer1M: 0.79, fetchedAt: '2026-08-05' },

  // --- Google AI Studio ---
  'gemini-3.6-flash':         { inputPer1M: 1.50,  outputPer1M: 7.50, fetchedAt: '2026-08-05' },
  'gemini-3.5-flash':         { inputPer1M: 1.50,  outputPer1M: 9.00, fetchedAt: '2026-08-05' },
  'gemini-3.5-flash-lite':    { inputPer1M: 0.30,  outputPer1M: 2.50, fetchedAt: '2026-08-05' },
};

// Local models cost nothing per token. Electricity and wall-clock time are real,
// but latency is already measured separately and dollars-per-token is what the
// cost column means.
export const LOCAL_PROVIDERS = new Set(['ollama']);

export function priceFor(modelId, provider) {
  if (LOCAL_PROVIDERS.has(provider)) {
    return { inputPer1M: 0, outputPer1M: 0, fetchedAt: 'n/a (local)' };
  }
  return PRICING[modelId] ?? null;
}

export function costUSD(modelId, provider, promptTokens, completionTokens) {
  const p = priceFor(modelId, provider);
  if (!p) return null;
  return (promptTokens / 1e6) * p.inputPer1M + (completionTokens / 1e6) * p.outputPer1M;
}
