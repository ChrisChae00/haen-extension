import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATASETS_DIR, sha256 } from './dataset.js';

// Training sentences for the distillation track. The evaluation set is drawn from
// FLORES `devtest` (sampleFlores.js); this reads `dev`, which is a disjoint split, so
// overlap with the eval set is structurally zero rather than something the sampler has
// to avoid. The remaining 812 devtest sentences are deliberately unused - same split
// means the same documents and topics can carry over.
//
// No sampling and no PRNG: all 997 dev lines are used, so there is nothing to choose.
// Only the direction is assigned, by parity of the line index - deterministic, and it
// spreads both directions evenly across the corpus instead of clumping by document.

const SPLIT = 'dev';
const CACHE_DIR = new URL('../.cache/', import.meta.url).pathname;

function find(lang) {
  return [
    path.join(CACHE_DIR, `flores200_dataset/${SPLIT}/${lang}.${SPLIT}`),
    path.join(CACHE_DIR, `${SPLIT}/${lang}.${SPLIT}`),
  ].find(existsSync);
}

function main() {
  const koFile = find('kor_Hang');
  const enFile = find('eng_Latn');
  if (!koFile || !enFile) {
    console.error(`FLORES-200 ${SPLIT} split not found under ${CACHE_DIR}. See npm run sample-flores.`);
    process.exit(1);
  }

  const ko = readFileSync(koFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  const en = readFileSync(enFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  if (ko.length !== en.length) {
    throw new Error(`FLORES line counts differ: ko=${ko.length} en=${en.length}. The files are not aligned.`);
  }

  const items = ko.map((_, i) => (i % 2 === 0
    ? { id: `flores-dev-ke-${String(i).padStart(4, '0')}`, direction: 'ko_to_en', slice: 'flores-wiki', source: ko[i], references: [en[i]] }
    : { id: `flores-dev-ek-${String(i).padStart(4, '0')}`, direction: 'en_to_ko', slice: 'flores-wiki', source: en[i], references: [ko[i]] }
  ));

  const outDir = path.join(DATASETS_DIR, 'train');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'raw.jsonl');
  const body = items.map(it => JSON.stringify(it)).join('\n') + '\n';
  writeFileSync(outFile, body);

  const ke = items.filter(it => it.direction === 'ko_to_en').length;
  console.log(`  wrote ${items.length} items to ${outFile}`);
  console.log(`  split ${SPLIT}, ko_to_en ${ke}, en_to_ko ${items.length - ke}`);
  console.log(`  sha256 ${sha256(body)}`);
}

main();
