import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHaenProvider, AllKeysExhausted, NetworkGone } from './providers/haen.js';
import { NetworkError, RateLimitError } from '../../src/apiClient.js';

// These decide whether a run keeps recording measurements or stops. Getting them wrong
// is not a wrong number - it is a predictions.jsonl full of fabricated failures that
// resume then refuses to retry, which is how 145 of 424 items were lost once already.

const CONFIG = { name: 'test', provider: 'groq', modelId: 'x', uiLanguage: 'ko' };
const item = { id: 'i1', direction: 'ko2en', slice: 'flores', source: '안녕', reference: 'hi' };

// A stand-in for TranslatorAPI that throws whatever the script says, in order.
const fakeApi = errors => ({
  calls: 0,
  async translate() {
    const e = errors[this.calls++];
    if (e) throw e;
    return { natural: 'hi', nuance: '', alternatives: [] };
  },
});

const netDown = () => new NetworkError();           // fetch-level: no HTTP response
const serverErr = () => new NetworkError('HTTP 503', 503);

test('ten consecutive fetch-level failures stop the run', async () => {
  const translate = makeHaenProvider(CONFIG, fakeApi(Array.from({ length: 10 }, netDown)));
  for (let i = 0; i < 9; i++) await translate(item);
  await assert.rejects(() => translate(item), NetworkGone);
});

test('a non-network failure breaks the streak instead of accumulating into a false NetworkGone', async () => {
  // Nine dead-link failures, one server error proving the connection is alive, nine more.
  // Eighteen network failures total, never ten in a row - the run must survive.
  const script = [
    ...Array.from({ length: 9 }, netDown),
    serverErr(),
    ...Array.from({ length: 9 }, netDown),
  ];
  const translate = makeHaenProvider(CONFIG, fakeApi(script));
  for (let i = 0; i < script.length; i++) {
    const rec = await translate(item);
    assert.ok(rec.error, 'each scripted failure is still recorded as a per-item error');
  }
});

test('an HTTP 5xx is a measurement, not a dead connection', async () => {
  const translate = makeHaenProvider(CONFIG, fakeApi(Array.from({ length: 20 }, serverErr)));
  for (let i = 0; i < 20; i++) {
    const rec = await translate(item);
    assert.equal(rec.error.status, 503);
  }
});

test('a success resets the streak', async () => {
  const script = [...Array.from({ length: 9 }, netDown), null, ...Array.from({ length: 9 }, netDown)];
  const translate = makeHaenProvider(CONFIG, fakeApi(script));
  for (let i = 0; i < script.length; i++) await translate(item);
});

test('a TypeError is a harness bug and crashes instead of becoming a recorded failure', async () => {
  const translate = makeHaenProvider(CONFIG, fakeApi([new TypeError('x.y is not a function')]));
  await assert.rejects(() => translate(item), TypeError);
});

test('a rate limit rotates to the next key before giving up', async () => {
  process.env.KEY_A = 'a';
  process.env.KEY_B = 'b';
  const seen = [];
  const api = {
    calls: 0,
    async translate(_text, opts) {
      seen.push(opts.apiKey);
      if (this.calls++ === 0) throw new RateLimitError();
      return { natural: 'hi', nuance: '', alternatives: [] };
    },
  };
  const translate = makeHaenProvider({ ...CONFIG, apiKeyEnv: ['KEY_A', 'KEY_B'] }, api);
  const rec = await translate(item);
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(rec.error, null);
});

test('a rate limit on the last key ends the run rather than failing every remaining item', async () => {
  process.env.KEY_A = 'a';
  const translate = makeHaenProvider(
    { ...CONFIG, apiKeyEnv: 'KEY_A' },
    fakeApi([new RateLimitError()]),
  );
  await assert.rejects(() => translate(item), AllKeysExhausted);
});

// Usage arrives through onRaw, the same callback the harness uses to capture the raw
// body. A stand-in that reports one response with the usage the provider sent.
const apiReporting = usage => ({
  async translate(text, opts) {
    seenOpts = opts;
    const raw = JSON.stringify({ natural: 'hi', nuance: 'n', alternatives: [] });
    opts.onRaw?.(raw, usage, { ttfbMs: 10 });
    return JSON.parse(raw);
  },
});
let seenOpts = null;

test('hidden thinking tokens are derived from the reported total', async () => {
  // The gemini-3.7-flash response that started this: total exceeds prompt + completion,
  // and the gap is thinking, which bills as output.
  const translate = makeHaenProvider(CONFIG, apiReporting({ prompt_tokens: 23, completion_tokens: 592, total_tokens: 1522 }));
  const record = await translate(item);
  assert.deepEqual(record.usage, { prompt_tokens: 23, completion_tokens: 592, reasoning_tokens: 907 });
});

test('models that hide nothing report zero reasoning tokens', async () => {
  const translate = makeHaenProvider(CONFIG, apiReporting({ prompt_tokens: 23, completion_tokens: 451, total_tokens: 474 }));
  const record = await translate(item);
  assert.equal(record.usage.reasoning_tokens, 0);
});

test('an explicit reasoning_tokens field wins over the derived gap', async () => {
  const translate = makeHaenProvider(CONFIG, apiReporting({
    prompt_tokens: 23, completion_tokens: 592, total_tokens: 1522,
    completion_tokens_details: { reasoning_tokens: 900 },
  }));
  const record = await translate(item);
  assert.equal(record.usage.reasoning_tokens, 900);
});

test('a response with no total_tokens records null, not zero', async () => {
  // 0 would claim the model thought nothing. Clamping 0 - prompt - completion to zero is
  // exactly how ten gemini-3.7-flash items were recorded as thoughtless; unmeasured is
  // null so score.py can mark the cost a lower bound instead of publishing it as final.
  const translate = makeHaenProvider(CONFIG, apiReporting({ prompt_tokens: 744, completion_tokens: 325 }));
  const record = await translate(item);
  assert.equal(record.usage.reasoning_tokens, null);
});

test('reasoningEffort reaches the request only when the config sets it', async () => {
  // Four hand-written destructuring sites carry this from config to the request body.
  // Drop it at any of them and the run completes, scores, and publishes a row labelled
  // "-nothink" that thought the whole time.
  seenOpts = null;
  await makeHaenProvider({ ...CONFIG, reasoningEffort: 'none' }, apiReporting({}))(item);
  assert.equal(seenOpts.reasoningEffort, 'none');

  seenOpts = null;
  await makeHaenProvider(CONFIG, apiReporting({}))(item);
  assert.equal('reasoningEffort' in seenOpts, false);
});
