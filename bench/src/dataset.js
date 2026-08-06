import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const DATASETS_DIR = new URL('../datasets/', import.meta.url).pathname;

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function readJsonl(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map((line, i) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`${file}:${i + 1} is not valid JSON`); }
    });
}

const VALID_DIRECTIONS = new Set(['ko_to_en', 'en_to_ko']);

function validate(item, file, index) {
  const where = `${path.basename(file)}[${index}]`;
  if (!item.id) throw new Error(`${where}: missing id`);
  if (!VALID_DIRECTIONS.has(item.direction)) throw new Error(`${where}: bad direction "${item.direction}"`);
  if (typeof item.source !== 'string' || !item.source.trim()) throw new Error(`${where}: missing source`);
  if (!Array.isArray(item.references) || item.references.length === 0) {
    throw new Error(`${where}: needs at least one reference`);
  }
  if (item.references.length > 3) throw new Error(`${where}: more than 3 references`);
  if (!item.slice) throw new Error(`${where}: missing slice tag`);
}

/**
 * Loads the datasets a config asks for and returns items plus the checksums that go
 * into config.json. The checksum is what makes a months-old result comparable: if the
 * dataset file changed, the numbers are not comparable and this is how you find out.
 */
export function loadDataset({ datasetVersion, datasets }) {
  const items = [];
  const checksums = {};
  const seen = new Set();

  for (const name of datasets) {
    const file = path.join(DATASETS_DIR, datasetVersion, name);
    if (!existsSync(file)) {
      throw new Error(`Dataset file not found: ${file}\nRun "node src/sampleFlores.js" first if this is flores.jsonl.`);
    }
    checksums[name] = sha256(readFileSync(file));
    readJsonl(file).forEach((item, i) => {
      validate(item, file, i);
      if (seen.has(item.id)) throw new Error(`Duplicate item id "${item.id}" in ${name}`);
      seen.add(item.id);
      items.push(item);
    });
  }

  // Stable order so that --limit takes the same subset every run, on every machine.
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { items, checksums };
}
