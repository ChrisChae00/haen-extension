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

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * How many items to take from each of `sizes` so the total is exactly `limit`, kept as
 * proportional to each file's size as integers allow (largest-remainder rounding).
 */
export function allocateLimit(sizes, limit) {
  const total = sizes.reduce((a, b) => a + b, 0);
  const shares = sizes.map(n => (limit * n) / total);
  const counts = shares.map(Math.floor);
  let remainder = limit - counts.reduce((a, b) => a + b, 0);
  const order = shares.map((s, i) => [s - Math.floor(s), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (remainder <= 0) break;
    if (counts[i] < sizes[i]) { counts[i]++; remainder--; }
  }
  return counts;
}

/**
 * Loads the datasets a config asks for and returns items plus the checksums that go
 * into config.json. The checksum is what makes a months-old result comparable: if the
 * dataset file changed, the numbers are not comparable and this is how you find out.
 *
 * `limit`, if given, is applied per source file (proportionally, largest-remainder
 * rounding) rather than after concatenating everything and sorting by id. Ids sort
 * "flores-*" before "hb-*", so a global slice(0, limit) silently drops handbuilt.jsonl
 * whenever limit is smaller than flores alone - exactly wrong for the ceiling-anchor
 * model, whose entire job is flagging suspect handbuilt references.
 */
export function loadDataset({ datasetVersion, datasets, limit }) {
  const perFile = [];
  const checksums = {};
  const seen = new Set();

  for (const name of datasets) {
    const file = path.join(DATASETS_DIR, datasetVersion, name);
    if (!existsSync(file)) {
      throw new Error(`Dataset file not found: ${file}\nRun "node src/sampleFlores.js" first if this is flores.jsonl.`);
    }
    checksums[name] = sha256(readFileSync(file));
    const fileItems = readJsonl(file);
    fileItems.forEach((item, i) => {
      validate(item, file, i);
      if (seen.has(item.id)) throw new Error(`Duplicate item id "${item.id}" in ${name}`);
      seen.add(item.id);
    });
    fileItems.sort(byId);
    perFile.push(fileItems);
  }

  let items;
  if (limit == null) {
    items = perFile.flat();
  } else {
    const counts = allocateLimit(perFile.map(f => f.length), limit);
    items = perFile.flatMap((f, i) => f.slice(0, counts[i]));
  }

  // Stable order for output, independent of how the limit was distributed.
  items.sort(byId);
  return { items, checksums };
}
