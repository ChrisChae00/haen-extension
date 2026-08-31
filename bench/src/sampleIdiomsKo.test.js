import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATASETS_DIR } from './dataset.js';
import { stride } from './sampleIdiomsKo.js';

const IDIOM_FILE = path.join(DATASETS_DIR, 'train/raw-idioms-ko.jsonl');
const read = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse);

// The frozen output. Run 1 failed on a training set whose contents nobody had characterised
// until after the result came in; these assertions are what "we checked the data" means for
// run 2, and they run on every `npm test` rather than once by hand.
const EXPECTED_CHECKSUM = 'd5f74c62b189ddbe45d65be4e5de2eea70f7255d6afeb8056c82d660c891acd2';

test('the idiom training set is the frozen one', (t) => {
  if (!existsSync(IDIOM_FILE)) return t.skip('idiom set not built (node src/sampleIdiomsKo.js <csv>)');
  const lines = readFileSync(IDIOM_FILE, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 500);
  assert.equal(createHash('sha256').update(lines.join('\n')).digest('hex'), EXPECTED_CHECKSUM,
    'idiom set changed; re-freeze the checksum deliberately, and re-run the teacher batch');
});

test('every idiom sentence actually contains its idiom', (t) => {
  if (!existsSync(IDIOM_FILE)) return t.skip('idiom set not built');
  // A source sentence without its idiom in it teaches nothing about that idiom, which is the
  // mistake run 1 made across the whole training set. NIKL stores some entries with dialogue
  // examples where only one turn carries the headword, so this is a real hazard, not a
  // hypothetical one.
  const missing = read(IDIOM_FILE).filter(({ idiom, source }) => {
    const stem = idiom.replace(/[[(][^\])]*[\])]/g, ' ').split(/\s+/).filter(Boolean)[0]
      .replace(/(을|를|이|가|은|는|에|의|도)$/, '');
    return !source.includes(stem);
  });
  assert.deepEqual(missing.map(item => item.idiom), []);
});

test('no bound forms, and every entry is a short verbal phrase', (t) => {
  if (!existsSync(IDIOM_FILE)) return t.skip('idiom set not built');
  const rows = read(IDIOM_FILE);
  // Endings and auxiliary constructions (-아 주다, -으려고 들다) pass every other filter and
  // are grammar rather than idiom. Long forms are proverbs, a register the eval does not test.
  assert.deepEqual(rows.filter(r => /^[-‐-―]/.test(r.idiom)).map(r => r.idiom), []);
  const tooLong = rows.filter(r => r.idiom.replace(/[[\]()/]/g, ' ').split(/\s+/).filter(Boolean).length > 3);
  assert.deepEqual(tooLong.map(r => r.idiom), []);
});

test('the idiom set does not overlap the evaluation sets', (t) => {
  if (!existsSync(IDIOM_FILE)) return t.skip('idiom set not built');
  const evalFiles = ['flores.jsonl', 'handbuilt.jsonl', 'handbuilt-ext.jsonl']
    .map(name => path.join(DATASETS_DIR, 'v1', name));
  const missing = evalFiles.filter(file => !existsSync(file));
  assert.deepEqual(missing.map(f => path.basename(f)), [],
    'evaluation datasets missing; regenerate with `npm run sample-flores`');

  const evalStrings = new Set(evalFiles.flatMap(read)
    .flatMap(item => [item.source, ...(item.references || [])]));
  const overlap = read(IDIOM_FILE).filter(r => evalStrings.has(r.source)).map(r => r.id);
  assert.deepEqual(overlap, []);

  // Beyond exact match: an eval item's own idiom appearing as a training headword would teach
  // the answer even though the sentences differ. Exact-match alone missed this class before.
  const evalKo = read(path.join(DATASETS_DIR, 'v1', 'handbuilt-ext.jsonl'))
    .filter(item => item.direction === 'ko_to_en')
    .map(item => item.source.trim().replace(/[.!?]$/, ''));
  const taught = read(IDIOM_FILE).filter(r =>
    evalKo.some(source => source.includes(r.idiom) || r.source.includes(source)));
  assert.deepEqual(taught.map(r => `${r.id}:${r.idiom}`), []);
});

test('stride spreads the sample instead of taking a prefix', () => {
  const items = Array.from({ length: 100 }, (_, index) => index);
  assert.deepEqual(stride(items, 4), [0, 25, 50, 75]);
  assert.equal(stride(items, 250).length, 100, 'a limit above the pool returns the pool');
  assert.equal(stride(items, 100).length, 100);
});
