// Per-1M-token prices, in USD.
//
// `fetchedAt` is not decoration. Provider prices change silently, and six months
// from now a cost report built on stale numbers looks exactly like a correct one.
// Every entry carries the date it was verified, and report.md prints it.
//
// Adding a model = adding a row. Nothing else in the harness knows model names.
export const PRICING = {
  // --- Groq --- verified against console.groq.com/docs/models
  'openai/gpt-oss-120b':      { inputPer1M: 0.15,  outputPer1M: 0.60, fetchedAt: '2026-08-18' },
  'openai/gpt-oss-20b':       { inputPer1M: 0.075, outputPer1M: 0.30, fetchedAt: '2026-08-18' },
  'qwen/qwen3.6-27b':         { inputPer1M: 0.60,  outputPer1M: 3.00, fetchedAt: '2026-08-18' },
  // The two llama rows carry older dates on purpose. Groq's model docs stopped listing
  // either one on 2026-08-18, so there was nothing to verify them against - and a
  // fetchedAt bumped to match its neighbours would be a claim nobody checked. An old
  // date is information; a wrong one is contamination.
  'llama-3.1-8b-instant':     { inputPer1M: 0.05,  outputPer1M: 0.08, fetchedAt: '2026-08-05' },
  'llama-3.3-70b-versatile':  { inputPer1M: 0.59,  outputPer1M: 0.79, fetchedAt: '2026-08-09' },

  // --- Google AI Studio ---
  // gemini-2.5-flash is not in this table: it 404s for this key ("no longer available
  // to new users") despite still being listed by GET /v1beta/openai/models.
  // gemini-3.6-flash is on introductory pricing through 2026-12-31; it reverts to
  // 1.50 / 7.50 on 2027-01-01. Re-check this row then, or a cost report dated after
  // the new year silently halves it.
  'gemini-3.6-flash':         { inputPer1M: 0.75,  outputPer1M: 3.75, fetchedAt: '2026-08-18' },
  // gemini-3.7-flash shares 3.6's introductory pricing and the same 2027-01-01 cliff, so
  // re-check this row then too. Its thinking tokens bill at the output rate while sitting
  // outside completion_tokens, which is why the outputPer1M here is charged against more
  // tokens than the report's "mean tokens out": correcting for that moved this model's
  // cost/1k from $1.7 to $3.02 (docs/ENGINEERING-LOG.md 1.9).
  'gemini-3.7-flash':         { inputPer1M: 0.75,  outputPer1M: 3.75, fetchedAt: '2026-08-21' },
  'gemini-3.5-flash':         { inputPer1M: 1.50,  outputPer1M: 9.00, fetchedAt: '2026-08-18' },
  'gemini-3.5-flash-lite':    { inputPer1M: 0.30,  outputPer1M: 2.50, fetchedAt: '2026-08-18' },
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
