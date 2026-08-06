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
