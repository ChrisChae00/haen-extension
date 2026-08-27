import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCompliance } from './compliance.js';
import { loadDataset } from './dataset.js';

// Recompute the compliance block of a finished run from its stored raw output.
//
// Compliance is evaluated at request time and persisted per record, so adding a check
// (langTagsMatchDirection, scoringVersion 2) leaves every earlier run without it — and
// score.py then reports the new column as "not measured" rather than as a rate. The raw
// model output is on disk, the checks are pure functions of it, so the honest fix is to
// re-derive the block instead of re-paying for the responses.
//
// This never touches `raw`, `parsed`, `usage`, `latencyMs` or any other measurement: it
// only replaces `compliance`. A rescore that changed a measured value would not be a
// rescore.

function usage() {
  console.error('Usage: node src/rescore.js --run-dir results/<run-id> [--dry-run]');
  process.exit(1);
}

export function rescoreRecords(records, itemsById, uiLanguage) {
  let changed = 0;
  const rescored = records.map(record => {
    const item = itemsById.get(record.id);
    if (!item) throw new Error(`record ${record.id} is not in the run's dataset`);
    const compliance = checkCompliance(record.raw ?? '', record.parsed ?? null, item, {
      uiLanguage,
      // Both were decided at request time and cannot be re-derived from the record's
      // own fields without re-running the salvage inference; the stored values are the
      // measurement. Only the checks themselves are recomputed.
      salvaged: record.compliance?.salvaged ?? false,
      retries: record.retries ?? 0,
    });
    if (JSON.stringify(compliance) !== JSON.stringify(record.compliance)) changed++;
    return { ...record, compliance };
  });
  return { rescored, changed };
}

function main() {
  const argv = process.argv.slice(2);
  let runDir = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run-dir') runDir = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else usage();
  }
  if (!runDir) usage();

  const dir = path.resolve(runDir);
  const config = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const { items } = loadDataset(config);
  const itemsById = new Map(items.map(item => [item.id, item]));

  const file = path.join(dir, 'predictions.jsonl');
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const { rescored, changed } = rescoreRecords(records, itemsById, config.uiLanguage ?? 'ko');

  console.log(`  ${path.basename(dir)}: ${records.length} record(s), ${changed} compliance block(s) changed`);
  if (dryRun) return console.log('  --dry-run: nothing written');

  const temp = `${file}.tmp`;
  writeFileSync(temp, rescored.map(record => JSON.stringify(record)).join('\n') + '\n');
  renameSync(temp, file);
  console.log('  rewritten. Re-run score/score.py to refresh metrics.json.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
