import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
  // Every eval file, not the ones that happen to be present: flores.jsonl is gitignored
  // (regenerable, not committed), and filtering it out would leave the FLORES side of the
  // comparison silently unchecked while the test still passed on the handbuilt files.
  const evalFiles = ['flores.jsonl', 'handbuilt.jsonl', 'handbuilt-ext.jsonl']
    .map(n => path.join(DATASETS_DIR, 'v1', n));
  const missing = evalFiles.filter(f => !existsSync(f));
  assert.deepEqual(missing.map(f => path.basename(f)), [],
    'evaluation datasets missing; regenerate with `npm run sample-flores` before checking leakage');

  const evalStrings = strings(evalFiles.flatMap(read));
  const overlap = [...train].filter(s => evalStrings.has(s));
  assert.deepEqual(overlap, [], `${overlap.length} sentence(s) appear in both training and evaluation data`);
});

// The test above guards `train/raw.jsonl`, which only the FLORES sampler writes. The
// files mlx_lm.lora actually reads are built downstream, so anything hand-added straight
// to them - an idiom set pasted in to fix the training/eval distribution mismatch, say -
// never passes the check above. Guard the files the trainer opens.
test('the files the trainer reads do not overlap the evaluation sets', (t) => {
  // Every teacher directory, discovered rather than listed. Naming one directory here is how
  // this check went stale the first time: it named `train/raw.jsonl` while the trainer opened
  // something else. A second batch (teacher-idioms-ko) would have walked through the same gap.
  const trainDir = path.join(DATASETS_DIR, 'train');
  const present = existsSync(trainDir)
    ? readdirSync(trainDir)
        .filter(name => name.startsWith('teacher'))
        .flatMap(dir => ['train.jsonl', 'valid.jsonl'].map(n => path.join(trainDir, dir, n)))
        .filter(existsSync)
    : [];
  if (!present.length) return t.skip('no teacher training set built yet');

  const evalFiles = ['flores.jsonl', 'handbuilt.jsonl', 'handbuilt-ext.jsonl']
    .map(n => path.join(DATASETS_DIR, 'v1', n));
  const evalStrings = strings(evalFiles.flatMap(read));

  // Both directions. An eval source can leak in as a training input (user message), and
  // it can equally leak in as a training target: eval item hbx-idc-018 asks for
  // "눈치 좀 챙겨" -> "Read the room", so a training pair running the other way teaches
  // the answer just as effectively as one running the same way.
  // Exact match only, and that is a floor rather than a proof: a training sentence that
  // *contains* an eval string ("Read the room and play it by ear" against hbx-idc-018's
  // "Read the room.") is real leakage this does not see. Substring matching was the
  // obvious upgrade and was rejected - eval items are short enough ("Break a leg!") that
  // it fires on innocent text, and a check that cries wolf gets muted, which is strictly
  // worse than one with a known blind spot. Reviewing added data by hand stays required.
  const overlap = [];
  for (const file of present) {
    for (const { messages } of read(file)) {
      const user = messages.find(m => m.role === 'user')?.content?.trim();
      if (user && evalStrings.has(user)) overlap.push(`${path.basename(file)}: input ${JSON.stringify(user)}`);

      const assistant = messages.find(m => m.role === 'assistant')?.content;
      let natural;
      try { natural = JSON.parse(assistant)?.natural?.trim(); } catch { /* malformed rows are 4.3's problem, not this test's */ }
      if (natural && evalStrings.has(natural)) overlap.push(`${path.basename(file)}: target ${JSON.stringify(natural)}`);
    }
  }
  assert.deepEqual(overlap, [], `${overlap.length} training record(s) carry an evaluation sentence`);
});
