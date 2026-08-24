import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATASETS_DIR } from './dataset.js';

// The one check this track cannot recover from missing: if a training sentence is also
// an evaluation sentence, every post-tuning number is a leaked exam paper and nothing
// after it can detect that. Both sides are compared including references - the eval
// reference for a ko_to_en item is the English sentence a training item could use as
// its source.
const read = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const strings = (items) => new Set(items.flatMap(it => [it.source, ...(it.references || [])]));

test('training sentences do not overlap the evaluation sets', (t) => {
  const trainFile = path.join(DATASETS_DIR, 'train/raw.jsonl');
  if (!existsSync(trainFile)) return t.skip('no training set built yet (node src/sampleFloresTrain.js)');

  const train = strings(read(trainFile));
  const evalFiles = ['flores.jsonl', 'handbuilt.jsonl', 'handbuilt-ext.jsonl']
    .map(n => path.join(DATASETS_DIR, 'v1', n)).filter(existsSync);
  assert.ok(evalFiles.length, 'no evaluation datasets found to check against');

  const evalStrings = strings(evalFiles.flatMap(read));
  const overlap = [...train].filter(s => evalStrings.has(s));
  assert.deepEqual(overlap, [], `${overlap.length} sentence(s) appear in both training and evaluation data`);
});
