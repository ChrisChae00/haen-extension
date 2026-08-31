// Combine teacher batches into one training set.
//
// Run 1 trained on 896 FLORES prose records and failed on an idiom benchmark, because the
// training data contained none of the phenomenon being judged (ENGINEERING-LOG 7.10). Run 2
// adds idioms without dropping the prose: the product also translates ordinary sentences and
// the 212-item COMET benchmark still measures them, so replacing rather than adding would
// trade one blind spot for another.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATASETS_DIR } from './dataset.js';

const TRAIN_DIR = path.join(DATASETS_DIR, 'train');
const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);

export function interleave(groups) {
  // Round-robin rather than concatenate. mlx_lm shuffles each epoch, so order does not decide
  // what the model sees - but a concatenated file makes any prefix-based inspection (head, a
  // truncated read, a partial run) look like a single-source set, and this project has already
  // been bitten once by a sample that was one corner of a sorted list.
  const merged = [];
  for (let index = 0; index < Math.max(...groups.map(g => g.length)); index++) {
    for (const group of groups) if (index < group.length) merged.push(group[index]);
  }
  return merged;
}

function main() {
  const outName = process.argv[2] ?? 'teacher-run2';
  const sources = process.argv.slice(3);
  const dirs = sources.length ? sources : ['teacher', 'teacher-idioms-ko'];

  const outDir = path.join(TRAIN_DIR, outName);
  mkdirSync(outDir, { recursive: true });

  const summary = { sources: {}, out: outName };
  for (const split of ['train', 'valid']) {
    const groups = dirs.map(dir => {
      const file = path.join(TRAIN_DIR, dir, `${split}.jsonl`);
      if (!existsSync(file)) throw new Error(`missing ${file} - collect that batch first`);
      const rows = readJsonl(file);
      summary.sources[dir] = { ...(summary.sources[dir] ?? {}), [split]: rows.length };
      return rows;
    });
    const merged = interleave(groups);
    const lines = merged.map(row => JSON.stringify({ messages: row.messages }));
    writeFileSync(path.join(outDir, `${split}.jsonl`), lines.join('\n') + '\n');
    summary[split] = merged.length;
    summary[`${split}Sha256`] = createHash('sha256').update(lines.join('\n')).digest('hex');
  }

  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
