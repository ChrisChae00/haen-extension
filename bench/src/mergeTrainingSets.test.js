import test from 'node:test';
import assert from 'node:assert/strict';
import { interleave } from './mergeTrainingSets.js';

test('interleave round-robins and keeps every record', () => {
  assert.deepEqual(interleave([[1, 2, 3, 4], ['a', 'b']]), [1, 'a', 2, 'b', 3, 4]);
  assert.deepEqual(interleave([[], [1, 2]]), [1, 2]);
  const groups = [Array(896).fill('prose'), Array(450).fill('idiom')];
  const merged = interleave(groups);
  assert.equal(merged.length, 1346, 'no record is dropped');
  assert.equal(merged.slice(0, 100).filter(x => x === 'idiom').length, 50,
    'the head of the file is mixed, not one source');
});
