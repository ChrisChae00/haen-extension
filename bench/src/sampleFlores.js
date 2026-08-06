import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATASETS_DIR, sha256 } from './dataset.js';

// FLORES-200 is the comparability tripwire, not the thing being optimised. It is
// professional Wikipedia prose - no UI strings, no casual speech, no idioms - so it
// says nothing about what Haen is for. It is here for one job: if hand-built scores
// climb while FLORES scores don't, the references have drifted toward personal taste.
//
// It is also fully public, so it sits in every model's training data. A FLORES score
// well above the hand-built score is a contamination signal, not a skill signal.

const VERSION = 'v1';
const SEED = 20260805;
const PER_DIRECTION = 100;
const SPLIT = 'devtest';

// Direct download, no HuggingFace account needed (the HF mirror of FLORES is gated
// behind a login; this tarball is not).
const FLORES_URL = 'https://tinyurl.com/flores200dataset';
const CACHE_DIR = new URL('../.cache/', import.meta.url).pathname;

// mulberry32: 32-bit PRNG, ~10 lines, identical output on every platform and Node
// version. Math.random() cannot be seeded, and a real PRNG dependency for one sampling
// step is not worth it. Reproducibility is verified by re-running and comparing SHA-256.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample indices without replacement, deterministically.
function sampleIndices(n, k, rand) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, k).sort((a, b) => a - b);
}

function findDevtest(lang) {
  const candidates = [
    path.join(CACHE_DIR, `flores200_dataset/${SPLIT}/${lang}.${SPLIT}`),
    path.join(CACHE_DIR, `${SPLIT}/${lang}.${SPLIT}`),
  ];
  return candidates.find(existsSync);
}

function instructions() {
  return `
FLORES-200 not found in ${CACHE_DIR}

Download and extract it there:

  mkdir -p ${CACHE_DIR}
  curl -L "${FLORES_URL}" -o ${CACHE_DIR}flores200.tar.gz
  tar -xzf ${CACHE_DIR}flores200.tar.gz -C ${CACHE_DIR}

Expected afterwards:
  ${CACHE_DIR}flores200_dataset/${SPLIT}/kor_Hang.${SPLIT}
  ${CACHE_DIR}flores200_dataset/${SPLIT}/eng_Latn.${SPLIT}
`;
}

function main() {
  const koFile = findDevtest('kor_Hang');
  const enFile = findDevtest('eng_Latn');
  if (!koFile || !enFile) {
    console.error(instructions());
    process.exit(1);
  }

  const ko = readFileSync(koFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  const en = readFileSync(enFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  if (ko.length !== en.length) {
    throw new Error(`FLORES line counts differ: ko=${ko.length} en=${en.length}. The files are not aligned.`);
  }

  const rand = mulberry32(SEED);
  // Two disjoint samples so the same sentence is never scored in both directions -
  // a model that memorised one direction would otherwise get credit twice.
  const picked = sampleIndices(ko.length, PER_DIRECTION * 2, rand);
  const koToEn = picked.slice(0, PER_DIRECTION);
  const enToKo = picked.slice(PER_DIRECTION);

  const items = [
    ...koToEn.map(i => ({
      id: `flores-ke-${String(i).padStart(4, '0')}`,
      direction: 'ko_to_en',
      slice: 'flores-wiki',
      source: ko[i],
      references: [en[i]],
    })),
    ...enToKo.map(i => ({
      id: `flores-ek-${String(i).padStart(4, '0')}`,
      direction: 'en_to_ko',
      slice: 'flores-wiki',
      source: en[i],
      references: [ko[i]],
    })),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));

  const outDir = path.join(DATASETS_DIR, VERSION);
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'flores.jsonl');
  const body = items.map(it => JSON.stringify(it)).join('\n') + '\n';
  writeFileSync(outFile, body);

  console.log(`  wrote ${items.length} items to ${outFile}`);
  console.log(`  seed ${SEED}, split ${SPLIT}, source lines ${ko.length}`);
  console.log(`  sha256 ${sha256(body)}`);
  console.log(`\n  Re-run this command; the sha256 must be identical.\n`);
}

main();
