import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapPool } from './run.js';
import { AllKeysExhausted } from './providers/haen.js';

// minIntervalMs paces requests for providers whose free tier caps RPM (Google AI Studio,
// 15 RPM). The sleep lands after an item finishes, which only approximates a rate limit
// when exactly one worker is running - so the two things worth pinning are that the guard
// rejects multi-worker pacing, and that the pacing does not sleep past the last item.

test('minIntervalMs pacing refuses to run with more than one worker', async () => {
  await assert.rejects(
    () => mapPool([1, 2], 2, async x => x, 50),
    /requires concurrency: 1/,
  );
});

test('pacing sleeps between items but not after the last one', async () => {
  const started = Date.now();
  const { results } = await mapPool([1, 2, 3], 1, async x => x * 2, 50);
  const elapsed = Date.now() - started;

  assert.deepEqual(results, [2, 4, 6]);
  assert.ok(elapsed >= 100, `expected >= 2 gaps (100ms), got ${elapsed}ms`);
  assert.ok(elapsed < 150, `expected < 3 gaps (150ms) - trailing sleep is back, got ${elapsed}ms`);
});

test('without minIntervalMs the pool still fans out and preserves order', async () => {
  const { results } = await mapPool([5, 1, 3], 3, async x => {
    await new Promise(r => setTimeout(r, x));
    return x;
  });
  assert.deepEqual(results, [5, 1, 3]);
});

// Quota exhaustion has to end the run, not become 200 "failed" records: every remaining
// item would otherwise spend its full retry budget against a dead daily quota, and the
// results directory would look measured while containing nothing but 429s.
test('AllKeysExhausted stops the pool and keeps what already finished', async () => {
  const { results, stopped } = await mapPool([1, 2, 3, 4], 1, async x => {
    if (x === 3) throw new AllKeysExhausted(2, new Error('TPD'));
    return x * 10;
  });
  assert.deepEqual(results, [10, 20]);
  assert.equal(stopped?.name, 'AllKeysExhausted');
});

test('an ordinary error still propagates instead of silently truncating the run', async () => {
  await assert.rejects(
    () => mapPool([1, 2], 1, async x => { if (x === 2) throw new Error('boom'); return x; }),
    /boom/,
  );
});
