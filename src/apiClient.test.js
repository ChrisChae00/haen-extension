import test from 'node:test';
import assert from 'node:assert/strict';
import { TranslatorAPI } from './apiClient.js';

// The request body is the wire contract, and reasoning_effort is the only field in it
// whose absence produces a complete, valid, wrongly-labelled measurement rather than an
// error. Nothing else asserts the camelCase -> snake_case rename it goes through.
function stubFetch(bodies) {
  return async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ natural: 'hi', nuance: 'n', alternatives: [] }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    };
  };
}

test('reasoningEffort is sent as reasoning_effort, and omitted when unset', async () => {
  const bodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch(bodies);
  try {
    const api = new TranslatorAPI();
    await api.translate('hello', { apiKey: 'k', provider: 'ollama', modelId: 'm', reasoningEffort: 'none' });
    await api.translate('hello', { apiKey: 'k', provider: 'ollama', modelId: 'm' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(bodies[0].reasoning_effort, 'none');
  // Absent, not undefined: a provider that 400s on an unknown key would turn a whole
  // run into recorded per-item errors that resume then skips permanently.
  assert.equal('reasoning_effort' in bodies[1], false);
});
