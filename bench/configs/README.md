# Configs

One file per model under test. Copy `_template.json` and fill it in.

The model lineup is deliberately not committed here — it is being selected separately.
Nothing in the harness knows model names: `modelId` is a string that goes straight into
the request body, and `src/pricing.js` is a lookup table. Adding a model is a config file
plus a pricing row.

## Fields

| Field | Notes |
|---|---|
| `name` | Short slug. Becomes part of the run id (`20260806-1432-<name>`). |
| `harness` | Which provider factory drives it. Only `haen` exists — it covers every OpenAI-compatible backend. |
| `provider` | `groq` \| `openrouter` \| `google` \| `ollama`. Selects the endpoint in `src/apiClient.js`. Passed explicitly so it never falls back to API-key-prefix sniffing. |
| `modelId` | **Exact** model id. Never an evergreen alias. |
| `apiKeyEnv` | Env var holding the key. Omit or `null` for `ollama` — local models have no key. |
| `temperature` | `0` for benchmark runs. Does not guarantee determinism; that is what `runs: 3` measures. |
| `jsonMode` | `true` unless the model can't do OpenAI's `response_format: json_object` (check the provider's docs). Compliance's `jsonValid` is only a fact about the model's own instruction-following when this is set correctly - a server-enforced JSON mode measures the serving stack, not the model. |
| `maxTokens` | Per-request `max_tokens`. Leave `null` to keep the extension's 2048. Groq reserves TPD/TPM against this number rather than actual usage, so lowering it to ~768 (observed completion p99 is ~400) roughly doubles how many calls a free-tier key affords. Set it too low and responses get truncated, which compliance then scores as the model's fault. |
| `reasoningEffort` | Thinking budget, passed through as `reasoning_effort`. Leave `null` to keep the model default. `"none"` disables reasoning where the backend honours it — Ollama does; `/no_think` in the system prompt and the native `think: false` field are both ignored on its OpenAI-compatible endpoint. Measured on qwen3:14b: thinking was 24s of a 43s median, so turning it off cut latency p50 40s → 16s and TTFB 25s → 0.5s with no COMET regression. It changes what the model does, not how the request is routed, so a run that sets it is a **different measurement**, not a faster one — give it its own config and its own row in the report. |
| `promptSuffix` | Text appended to the **user message** of every request. Empty/unset for every run recorded so far, and an empty suffix is hashed as an empty string, so existing `promptHash` values are unchanged. Its one intended use is Qwen3's `/no_think`: the Ollama **experimental** runner ignores `reasoning_effort` entirely and this tag is the only way to turn thinking off there. It is in `promptHash` on purpose — without that, a thinking run and a no-think run on the experimental runner produce the same hash and pass the pairwise comparability gate as equivalent. Put it in the user message, not the system prompt: the standard Ollama runner demonstrably ignores it in the system position (see `reasoningEffort` above). |
| `limit` | `null` for the full set. Used for the ceiling-anchor model, which only runs a subset to keep cost down. Takes the first N in stable id order, so it is the same subset every time. |
| `runs` | `3`. Feeds `runVariance` in `score.py`. |
| `judgeModelId` | Only on the config used for LLM-as-judge scoring. Must not be a model under test. |

## Two rules worth not breaking

**Never use an evergreen alias as `modelId`.** `gemini-flash-latest` (used by the
extension at `src/apiClient.js:32`) silently changes what it points at. That is right for
the extension and fatal for a baseline — the number you compare against in three months
would have come from a different model.

**Pin `provider` explicitly.** `detectProvider()` infers from the API key prefix, which
cannot work for local models (no key). The explicit field always wins; inference stays as
the extension's fallback.
