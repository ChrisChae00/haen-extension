import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripThinking, parsePartial, parseForTest } from '../../src/apiClient.js';

test('stripThinking removes a closed reasoning block', () => {
  assert.equal(stripThinking('<think>plan: {"natural": "..."}</think>{"natural":"안녕"}'), '{"natural":"안녕"}');
});

test('stripThinking drops an unclosed block (answer never arrived)', () => {
  assert.equal(stripThinking('<think>still planning {"natural": "..."'), '');
});

test('parsePartial does not salvage fields out of the reasoning block', () => {
  const raw = '<think>schema is {"natural": "...", "nuance": "..."} so I will</think>';
  assert.deepEqual(parsePartial(raw), {});
});

test('parsePartial still reads a real streaming prefix after thinking', () => {
  const raw = '<think>ok</think>{"natural": "안녕하세요", "nuance": "격식';
  assert.equal(parsePartial(raw).natural, '안녕하세요');
});

test('untagged reasoning prose before the answer does not break extraction', () => {
  const raw = `Here's a thinking process:
1. Schema is { "natural": "...", "alternatives": [ ... ] }
2. Now the answer.
{"natural":"안녕하세요","nuance":"격식체","alternatives":[{"label":"a","register":"formal","expressions":["x"]}]}`;
  const parsed = parseForTest(raw);
  assert.equal(parsed.natural, '안녕하세요');
  assert.equal(parsed.alternatives.length, 1);
});

test('parsePartial prefers the answer over a schema sketch written earlier', () => {
  const raw = 'plan: "natural": "..." then the real one: {"natural": "안녕하세요"';
  assert.equal(parsePartial(raw).natural, '안녕하세요');
});
