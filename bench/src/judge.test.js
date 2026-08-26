import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkpointPairwiseOrder,
  exactSignTestPValue,
  finalizePairwiseVerdicts,
  hashComparison,
  isCompletePairwiseRow,
  normalizeOrderVerdict,
  pairwiseSignTests,
  recordsForIds,
  selectPairwiseSubset,
  validateComparableConfigs,
} from './judge.js';

test('swapped positions normalize to the actual candidate and baseline', () => {
  assert.deepEqual(
    normalizeOrderVerdict({ natural: 'A', nuance: 'B' }, 'A'),
    { natural: 'candidate', nuance: 'baseline' },
  );
  assert.deepEqual(
    normalizeOrderVerdict({ natural: 'B', nuance: 'A' }, 'B'),
    { natural: 'candidate', nuance: 'baseline' },
  );
});

test('an order effect or ties resolve to a tie', () => {
  assert.deepEqual(
    finalizePairwiseVerdicts(
      { natural: 'candidate', nuance: 'tie' },
      { natural: 'baseline', nuance: 'tie' },
    ),
    { natural: 'tie', nuance: 'tie' },
  );
});

test('two-sided exact sign test ignores ties', () => {
  assert.equal(exactSignTestPValue(0, 0), 1);
  assert.equal(exactSignTestPValue(9, 1), 22 / 1024);
  assert.equal(exactSignTestPValue(5, 5), 1);
});

test('comparison hash changes when either full output or rubric changes', () => {
  const input = {
    id: 'hbx-001', candidateRunId: 'candidate', baselineRunId: 'baseline',
    judge: { provider: 'openrouter', modelId: 'judge' }, rubric: 'rubric v1',
    candidateOutput: { raw: 'candidate v1' }, baselineOutput: { raw: 'baseline v1' },
  };
  assert.notEqual(hashComparison(input), hashComparison({ ...input, rubric: 'rubric v2' }));
  assert.notEqual(hashComparison(input), hashComparison({ ...input, candidateOutput: { raw: 'candidate v2' } }));
  assert.notEqual(hashComparison(input), hashComparison({ ...input, candidateOutput: { raw: 'candidate v1', parsed: { natural: 'changed' } } }));
  assert.notEqual(hashComparison(input), hashComparison({ ...input, baselineOutput: { raw: 'baseline v2' } }));
  assert.notEqual(hashComparison(input), hashComparison({ ...input, baselineOutput: { raw: 'baseline v1', parsed: { natural: 'changed' } } }));
  assert.notEqual(hashComparison(input), hashComparison({ ...input, judge: { provider: 'openrouter', modelId: 'other-judge' } }));
});

test('pairwise comparison rejects run and dataset identity mismatches', () => {
  const config = {
    runId: 'candidate', datasetVersion: 'v1', datasets: ['handbuilt-ext.jsonl'],
    datasetChecksums: { 'handbuilt-ext.jsonl': 'same' },
  };
  assert.throws(
    () => validateComparableConfigs(config, { ...config, runId: 'baseline', datasetChecksums: { 'handbuilt-ext.jsonl': 'different' } }, 'candidate', 'baseline'),
    /dataset identity/,
  );
  assert.throws(
    () => validateComparableConfigs({ ...config, runId: 'wrong' }, { ...config, runId: 'baseline' }, 'candidate', 'baseline'),
    /runId/,
  );
});

test('pairwise comparison rejects mismatched handbuilt item sets', () => {
  assert.throws(
    () => recordsForIds([{ id: 'hbx-001', runIndex: 0, parsed: {} }], ['hbx-001', 'hbx-002'], 'candidate'),
    /item set differs/,
  );
});

test('pairwise comparison rejects same-id direction or slice metadata mismatches', () => {
  const item = { id: 'hbx-001', direction: 'en_to_ko', slice: 'idiom-casual' };
  const record = { id: item.id, runIndex: 0, direction: item.direction, slice: item.slice, parsed: {} };
  assert.throws(() => recordsForIds([{ ...record, direction: 'ko_to_en' }], [item], 'candidate'), /metadata differs/);
  assert.throws(() => recordsForIds([{ ...record, slice: 'idiom-business' }], [item], 'candidate'), /metadata differs/);
});

test('order checkpoints retain raw provider text and resume with only the missing order', () => {
  const row = { id: 'hbx-001', orderVerdicts: [] };
  const first = checkpointPairwiseOrder(row, 'A', {
    raw: '{"natural":"A","nuance":"tie"}',
    verdict: { natural: 'A', nuance: 'tie', note: 'first' },
  });
  assert.equal(isCompletePairwiseRow(first), false);
  assert.equal(first.orderVerdicts[0].raw, '{"natural":"A","nuance":"tie"}');
  assert.deepEqual(first.orderVerdicts[0].verdict, { natural: 'A', nuance: 'tie', note: 'first' });
  assert.throws(() => checkpointPairwiseOrder(first, 'A', { raw: '', verdict: { natural: 'A', nuance: 'A' } }), /already checkpointed/);

  const resumed = checkpointPairwiseOrder(first, 'B', {
    raw: '{"natural":"B","nuance":"tie"}',
    verdict: { natural: 'B', nuance: 'tie', note: 'second' },
  });
  assert.equal(isCompletePairwiseRow(resumed), true);
  assert.deepEqual(resumed.winner, { natural: 'candidate', nuance: 'tie' });
});

test('sign-test summaries ignore ties and incomplete checkpoint rows', () => {
  const first = checkpointPairwiseOrder({ id: 'partial', orderVerdicts: [] }, 'A', {
    raw: 'A', verdict: { natural: 'A', nuance: 'tie' },
  });
  const complete = checkpointPairwiseOrder(checkpointPairwiseOrder({ id: 'complete', orderVerdicts: [] }, 'A', {
    raw: 'A', verdict: { natural: 'A', nuance: 'tie' },
  }), 'B', {
    raw: 'B', verdict: { natural: 'B', nuance: 'tie' },
  });
  assert.deepEqual(pairwiseSignTests([first, complete]), {
    natural: { candidateWins: 1, baselineWins: 0, ties: 0, pValue: 1 },
    nuance: { candidateWins: 0, baselineWins: 0, ties: 1, pValue: 1 },
  });
});

test('the first-20 gate is balanced across handbuilt slice and direction strata', () => {
  const items = ['idiom-business', 'idiom-casual'].flatMap(slice => ['en_to_ko', 'ko_to_en'].flatMap(direction =>
    Array.from({ length: 10 }, (_, n) => ({ id: `${slice}-${direction}-${String(n).padStart(2, '0')}`, slice, direction })),
  ));
  const early = selectPairwiseSubset(items, 20);
  for (const slice of ['idiom-business', 'idiom-casual']) {
    for (const direction of ['en_to_ko', 'ko_to_en']) {
      assert.equal(early.filter(item => item.slice === slice && item.direction === direction).length, 5);
    }
  }
  assert.deepEqual(selectPairwiseSubset(items, 40), items);
});
