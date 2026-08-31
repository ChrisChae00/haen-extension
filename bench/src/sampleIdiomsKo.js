// Build Korean idiom training sources from the NIKL basic dictionary.
//
// Run 1 failed because the 896 training sentences are FLORES wiki and news prose containing
// zero idioms while success is judged on 40 idiom items (ENGINEERING-LOG 7.10). The teacher
// clears 27 of the 29 idiom items this control fails, so the ceiling is not the problem - the
// training set simply never asked the question. This produces the sentences that ask it.
//
// Source: binjang/NIKL-korean-english-dictionary (MIT), the National Institute of Korean
// Language's basic dictionary, 53,172 headwords. Only the Korean side; the English direction
// still has no usable public source (MEASUREMENT-NOTES on the dataset survey).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASETS_DIR } from './dataset.js';

const OUT_FILE = path.join(DATASETS_DIR, 'train/raw-idioms-ko.jsonl');

// A headword with a space is a multi-word entry, but that alone catches compound nouns
// (성형 수술, 성인 영화) alongside real idioms. Requiring a verbal ending keeps 성을 갈다 and
// 세상 모르다 and drops the noun phrases.
const VERBAL_ENDING = /다[\])]?$/;

// Entries beginning with a hyphen are bound forms - endings and auxiliary constructions like
// -아 주다 or -으려고 들다. They pass every other filter (multi-word, verbal, short) and are
// grammar, not idiom; training on them teaches conjugation the model already has.
const BOUND_FORM = /^[-\u2010-\u2015]/;

// Proverbs (속담) are in here too - 소 잃고 외양간 고친다, 세 치 혀가 사람 잡는다. They are
// idiomatic but they are not what the eval measures: handbuilt-ext is conversational and
// business register (눈치 좀 챙겨, 총대 메겠습니다), and a model tuned on proverbs learns a
// different register than the one being scored. Proverbs are full clauses; the idioms this
// benchmark cares about are verb phrases, so word count separates most of them.
const MAX_WORDS = 3;

// Python list-literal columns, e.g. "['a', 'b']". Not JSON - single quotes, and Korean text
// carries apostrophes, so parse structurally rather than swapping quotes and calling JSON.parse.
function parsePyList(raw) {
  const text = (raw ?? '').trim();
  if (!text.startsWith('[')) return text ? [text] : [];
  const items = [];
  let current = '', quote = null, escaped = false;
  for (const char of text.slice(1, -1)) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (quote) {
      if (char === quote) { items.push(current); current = ''; quote = null; }
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
  }
  return items.map(item => item.trim()).filter(Boolean);
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows.filter(r => r.length === header.length)
    .map(r => Object.fromEntries(header.map((key, index) => [key, r[index]])));
}

const wordCount = form => form.replace(/[[\]()/]/g, ' ').split(/\s+/).filter(Boolean).length;

export function selectIdioms(rows) {
  const selected = [];
  for (const row of rows) {
    const form = (row.Form ?? '').trim();
    if (BOUND_FORM.test(form)) continue;
    if (!form.includes(' ') || !VERBAL_ENDING.test(form) || wordCount(form) > MAX_WORDS) continue;
    const usages = parsePyList(row.Usages);
    const english = parsePyList(row['English Definition']);
    if (!usages.length || !english.length) continue;
    // One sentence per headword. Several usages for the same idiom teach the same lexical
    // item repeatedly, which spends training budget without widening coverage; with 2,000+
    // headwords available, breadth is the cheaper axis.
    // The usage has to contain the idiom, which is not a given: NIKL stores some entries with
    // dialogue examples where only one turn uses the headword, so 줄(을) 놓다 can arrive
    // attached to "동생이 일 때문에 재판을 받게 됐어." A sentence without the idiom in it
    // teaches nothing about that idiom and is exactly the mistake run 1 made at scale.
    const stem = form.replace(/[[(][^\])]*[\])]/g, ' ').split(/\s+/).filter(Boolean)[0]
      ?.replace(/(을|를|이|가|은|는|에|의|도)$/, '');
    const usage = usages.find(text =>
      text.length >= 10 && /[.!?]$/.test(text.trim()) && stem && text.includes(stem));
    if (!usage) continue;
    selected.push({ form, source: usage.trim(), gloss: english[0].trim() });
  }
  return selected;
}

// Take an even stride rather than the first N. The list is sorted by headword, so the head of
// it is one corner of the Korean alphabet and one cluster of idiom families; a stride spreads
// the sample across all of them. Deterministic, no PRNG - the same CSV and limit always give
// the same file, so the dataset checksum is reproducible.
export function stride(items, limit) {
  if (!limit || items.length <= limit) return items;
  const step = items.length / limit;
  return Array.from({ length: limit }, (_, index) => items[Math.floor(index * step)]);
}

function main() {
  const csvFile = process.argv[2];
  if (!csvFile) throw new Error('Usage: node src/sampleIdiomsKo.js <NIKL 2024_01.csv> [--limit N]');
  const limitFlag = process.argv.indexOf('--limit');
  const limit = limitFlag === -1 ? 500 : Number(process.argv[limitFlag + 1]);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');

  const all = selectIdioms(parseCsv(readFileSync(csvFile, 'utf8')));
  all.sort((a, b) => a.form.localeCompare(b.form, 'ko'));

  // 896 prose records already exist. 500 idiom records makes the mix ~36% idiom, enough to
  // change behaviour without drowning the ordinary-sentence case the product also serves and
  // the 212-item COMET benchmark still measures.
  const selected = stride(all, limit);
  console.log(`  ${all.length} candidate(s), keeping ${selected.length}`);

  const lines = selected.map((item, index) => JSON.stringify({
    id: `nikl-idiom-${String(index).padStart(4, '0')}`,
    direction: 'ko_to_en',
    slice: 'idiom-nikl',
    source: item.source,
    references: [],
    idiom: item.form,
    gloss: item.gloss,
  }));
  writeFileSync(OUT_FILE, lines.join('\n') + '\n');
  const checksum = createHash('sha256').update(lines.join('\n')).digest('hex');
  console.log(`  ${selected.length} idiom sentence(s) -> ${OUT_FILE}`);
  console.log(`  sha256 ${checksum}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
