import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateLimit } from './dataset.js';

// Regression test for the bug where a global id sort put every "flores-*" item before
// "hb-*" and slice(0, limit) silently dropped handbuilt.jsonl whenever limit was smaller
// than the flores set alone - exactly the case the ceiling-anchor model hits, since its
// entire job is flagging suspect handbuilt references.
test('limit is distributed proportionally across files, not zeroed out for the smaller one', () => {
  const counts = allocateLimit([200, 12], 50);
  assert.equal(counts[0] + counts[1], 50);
  assert.ok(counts[1] >= 1, 'the small file must not be starved to zero');
});

test('allocateLimit sums exactly to the requested limit even with rounding', () => {
  for (const limit of [1, 3, 7, 50, 211]) {
    const counts = allocateLimit([100, 100, 12], limit);
    assert.equal(counts.reduce((a, b) => a + b, 0), Math.min(limit, 212));
  }
});

test('allocateLimit never exceeds a file\'s own size', () => {
  const counts = allocateLimit([3, 200], 190);
  assert.ok(counts[0] <= 3);
  assert.equal(counts[0] + counts[1], 190);
});
