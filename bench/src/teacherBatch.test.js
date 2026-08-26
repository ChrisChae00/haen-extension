import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildInlineRequests,
  collectTeacherSamples,
  prepareBatch,
  splitByStableId,
  submitBatch,
} from './teacherBatch.js';

test('batch requests retain item identity and the production direction prompt', () => {
  const [entry] = buildInlineRequests([{
    id: 'flores-dev-ke-0000',
    direction: 'ko_to_en',
    source: '안녕하세요',
  }]);

  assert.deepEqual(entry.metadata, {
    id: 'flores-dev-ke-0000',
    direction: 'ko_to_en',
  });
  assert.equal(entry.request.contents[0].parts[0].text, '안녕하세요');
  assert.match(entry.request.systemInstruction.parts[0].text, /Force direction: Korean → English/);
  assert.deepEqual(entry.request.generationConfig, {
    temperature: 0,
    responseMimeType: 'application/json',
  });
});

test('stable ID hashing assigns the same samples after input reordering', () => {
  const samples = Array.from({ length: 10 }, (_, index) => ({ id: `item-${index}` }));
  const first = splitByStableId(samples);
  const reversed = splitByStableId([...samples].reverse());

  assert.deepEqual(first.valid.map(x => x.id), ['item-6']);
  assert.deepEqual(reversed.valid.map(x => x.id), ['item-6']);
  assert.equal(first.train.length, 9);
});

test('preparation is resumable for identical input and refuses changed input', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'haen-teacher-prepare-'));
  const stateFile = path.join(dir, 'state.json');
  const payloadFile = path.join(dir, 'payload.json');
  const items = [{ id: 'one', direction: 'ko_to_en', source: '하나' }];

  try {
    const first = prepareBatch({ items, stateFile, payloadFile, model: 'gemini-3.7-flash' });
    const second = prepareBatch({ items, stateFile, payloadFile, model: 'gemini-3.7-flash' });
    assert.equal(first.status, 'prepared');
    assert.equal(second.inputHash, first.inputHash);
    assert.equal(JSON.parse(readFileSync(payloadFile, 'utf8')).batch.inputConfig.requests.requests.length, 1);
    assert.throws(
      () => prepareBatch({
        items: [{ ...items[0], source: '바뀜' }],
        stateFile,
        payloadFile,
        model: 'gemini-3.7-flash',
      }),
      /different input/,
    );
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).inputHash, first.inputHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('submission persists an uncertainty barrier before the network call and refuses duplicates', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'haen-teacher-batch-'));
  const stateFile = path.join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({
    status: 'prepared',
    model: 'gemini-3.7-flash',
    displayName: 'haen-teacher-deadbeef',
    inputHash: 'deadbeef',
  }));

  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const duringCall = JSON.parse(readFileSync(stateFile, 'utf8'));
    assert.equal(duringCall.status, 'submitting');
    return {
      ok: true,
      status: 200,
      json: async () => ({ name: 'batches/job-1', done: false }),
    };
  };

  try {
    const state = await submitBatch({
      stateFile,
      payload: { batch: {} },
      apiKey: 'test-key',
      fetchImpl,
    });
    assert.equal(state.status, 'submitted');
    assert.equal(state.jobName, 'batches/job-1');
    await assert.rejects(
      submitBatch({ stateFile, payload: { batch: {} }, apiKey: 'test-key', fetchImpl }),
      /refusing to resubmit/,
    );
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collection keeps only fully compliant JSON and builds MLX chat samples', () => {
  const good = {
    detected_lang: 'KO',
    target_lang: 'EN',
    natural: 'Hello.',
    literal: '',
    nuance: '일상에서 두루 쓰는 자연스러운 인사입니다.',
    alternatives: [
      { label: '가장 일반적', register: 'neutral', expressions: ['Hello.'] },
      { label: '친한 사이', register: 'casual', expressions: ['Hi.'] },
    ],
    tip: '',
  };
  const bad = { ...good, alternatives: good.alternatives.slice(0, 1) };
  const items = [
    { id: 'good', direction: 'ko_to_en', source: '안녕하세요' },
    { id: 'bad', direction: 'ko_to_en', source: '반갑습니다' },
  ];
  const operation = {
    response: {
      output: {
        inlinedResponses: {
          inlinedResponses: [
            responseFor('good', 'ko_to_en', JSON.stringify(good)),
            responseFor('bad', 'ko_to_en', JSON.stringify(bad)),
          ],
        },
      },
    },
  };

  const result = collectTeacherSamples(items, operation);

  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].id, 'good');
  assert.deepEqual(result.accepted[0].messages.map(message => message.role), ['system', 'user', 'assistant']);
  assert.deepEqual(JSON.parse(result.accepted[0].messages[2].content), good);
  assert.equal(result.rejected.length, 1);
  assert.deepEqual(result.rejected[0].failedChecks, ['altsExactlyTwo']);
});

test('collection rejects incomplete batches instead of silently shrinking training data', () => {
  const items = [
    { id: 'one', direction: 'ko_to_en', source: '하나' },
    { id: 'two', direction: 'en_to_ko', source: 'two' },
  ];
  const operation = {
    response: {
      output: {
        inlinedResponses: {
          inlinedResponses: [responseFor('one', 'ko_to_en', '{}')],
        },
      },
    },
  };

  assert.throws(() => collectTeacherSamples(items, operation), /expected 2 batch responses, got 1/);
});

test('collection reads the direct REST operation response shape', () => {
  const parsed = {
    detected_lang: 'KO', target_lang: 'EN', natural: 'One.', literal: '',
    nuance: '일상에서 쓰는 자연스러운 표현입니다.',
    alternatives: [
      { label: '일반적', register: 'neutral', expressions: ['One.'] },
      { label: '격식체', register: 'formal', expressions: ['Number one.'] },
    ],
    tip: '',
  };
  const operation = {
    response: {
      inlinedResponses: {
        inlinedResponses: [responseFor('one', 'ko_to_en', JSON.stringify(parsed))],
      },
    },
  };

  const result = collectTeacherSamples(
    [{ id: 'one', direction: 'ko_to_en', source: '하나' }],
    operation,
  );
  assert.equal(result.accepted.length, 1);
});

function responseFor(id, direction, text) {
  return {
    metadata: { id, direction },
    response: {
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text }] },
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 30,
        totalTokenCount: 60,
      },
    },
  };
}
