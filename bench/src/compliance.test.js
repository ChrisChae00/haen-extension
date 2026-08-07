import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCompliance } from './compliance.js';

const KO_TO_EN = { direction: 'ko_to_en' };
const EN_TO_KO = { direction: 'en_to_ko' };

const goodParsed = {
  detected_lang: 'KO',
  target_lang: 'EN',
  natural: 'Have you been eating okay?',
  literal: '',
  nuance: '가까운 사이에서 안부를 묻는 표현입니다.',
  alternatives: [
    { label: '가장 일반적', register: 'neutral', expressions: ['How have you been?'] },
    { label: '친한 친구 사이', register: 'casual', expressions: ['You doing alright?', 'Been eating?'] },
  ],
  tip: '',
};
const goodRaw = JSON.stringify(goodParsed);

test('a fully compliant response passes every check', () => {
  const c = checkCompliance(goodRaw, goodParsed, KO_TO_EN);
  assert.equal(c.jsonValid, true);
  assert.equal(c.hasAllRequired, true);
  assert.equal(c.altsExactlyTwo, true);
  assert.equal(c.altsSizesValid, true);
  assert.equal(c.altsRegistersValid, true);
  assert.equal(c.hanjaLeak, false);
  assert.equal(c.fenced, false);
  assert.equal(c.prosePreamble, false);
  assert.equal(c.empty, false);
});

test('parse failure is recorded, not thrown', () => {
  const c = checkCompliance('{"natural": "oops', null, KO_TO_EN);
  assert.equal(c.jsonValid, false);
  assert.equal(c.hasAllRequired, false);
  assert.equal(c.altsPresent, false);
});

test('code fences and prose preamble are detected separately', () => {
  assert.equal(checkCompliance('```json\n{}\n```', {}, KO_TO_EN).fenced, true);
  assert.equal(checkCompliance('```json\n{}\n```', {}, KO_TO_EN).prosePreamble, false);
  assert.equal(checkCompliance('Here is the translation: {}', {}, KO_TO_EN).prosePreamble, true);
});

test('three alternative categories violates the exactly-two rule but sizes stay valid', () => {
  const parsed = { ...goodParsed, alternatives: [...goodParsed.alternatives, goodParsed.alternatives[0]] };
  const c = checkCompliance(JSON.stringify(parsed), parsed, KO_TO_EN);
  assert.equal(c.altsExactlyTwo, false);
  assert.equal(c.altsSizesValid, true);
});

test('an empty or oversized expressions list fails altsSizesValid', () => {
  const empty = { ...goodParsed, alternatives: [{ label: 'a', register: 'neutral', expressions: [] }, goodParsed.alternatives[1]] };
  assert.equal(checkCompliance('{}', empty, KO_TO_EN).altsSizesValid, false);

  const four = { ...goodParsed, alternatives: [{ label: 'a', register: 'neutral', expressions: ['1', '2', '3', '4'] }, goodParsed.alternatives[1]] };
  assert.equal(checkCompliance('{}', four, KO_TO_EN).altsSizesValid, false);
});

test('an invented register value is rejected', () => {
  const parsed = { ...goodParsed, alternatives: [{ label: 'a', register: 'polite', expressions: ['x'] }, goodParsed.alternatives[1]] };
  assert.equal(checkCompliance('{}', parsed, KO_TO_EN).altsRegistersValid, false);
});

// The direction-sensitivity of the Hanja check is the part most likely to be got wrong:
// a naive implementation scans `natural` unconditionally and flags every ko_to_en row.
test('Hanja in a Korean-written field is flagged', () => {
  const parsed = { ...goodParsed, nuance: '親한 사이에서 쓰는 표현' };
  assert.equal(checkCompliance('{}', parsed, KO_TO_EN, { uiLanguage: 'ko' }).hanjaLeak, true);
});

test('Hanja in an alternatives label is flagged', () => {
  const parsed = { ...goodParsed, alternatives: [{ label: '一般的', register: 'neutral', expressions: ['x'] }, goodParsed.alternatives[1]] };
  assert.equal(checkCompliance('{}', parsed, KO_TO_EN, { uiLanguage: 'ko' }).hanjaLeak, true);
});

test('natural is only Hanja-checked when the target language is Korean', () => {
  const parsed = { ...goodParsed, nuance: '정상', natural: '一日' };
  // ko_to_en: `natural` holds the English translation, so it is not a Korean-written field.
  assert.equal(checkCompliance('{}', parsed, KO_TO_EN, { uiLanguage: 'ko' }).hanjaLeak, false);
  // en_to_ko: `natural` holds Korean, so the no-Hanja rule applies.
  assert.equal(checkCompliance('{}', parsed, EN_TO_KO, { uiLanguage: 'ko' }).hanjaLeak, true);
});

test('the English UI template carries no Hanja rule', () => {
  const parsed = { ...goodParsed, nuance: '親한 사이' };
  assert.equal(checkCompliance('{}', parsed, EN_TO_KO, { uiLanguage: 'en' }).hanjaLeak, false);
});

test('salvage and retry flags pass through', () => {
  const c = checkCompliance(goodRaw, goodParsed, KO_TO_EN, { salvaged: true, retries: 2 });
  assert.equal(c.salvaged, true);
  assert.equal(c.retried, true);
});

test('a salvaged parse is not counted as jsonValid even though parsed is non-null', () => {
  const c = checkCompliance('{"natural": "truncated', goodParsed, KO_TO_EN, { salvaged: true });
  assert.equal(c.jsonValid, false);
});
