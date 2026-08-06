import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildSystemPrompt } from '../../src/prompts.js';
import { makeProvider } from './providers/index.js';
import { loadDataset } from './dataset.js';
import { priceFor, costUSD } from './pricing.js';

const HARNESS_VERSION = '1.0.0';
const RESULTS_DIR = new URL('../results/', import.meta.url).pathname;
const REPO_ROOT = new URL('../../', import.meta.url).pathname;

function parseArgs(argv) {
  const args = { runs: null, limit: null, dryRun: false, config: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--runs') args.runs = Number(argv[++i]);
    else if (a === '--limit') args.limit = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.config) throw new Error('Usage: node src/run.js --config configs/<name>.json [--dry-run] [--runs N] [--limit N]');
  return args;
}

function gitState() {
  try {
    const sha = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    const dirty = execSync('git status --porcelain', { cwd: REPO_ROOT, encoding: 'utf8' }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: null };
  }
}

/**
 * Hash of the exact system prompts this run used.
 *
 * This is the single most useful field in config.json. Model ids and dataset versions
 * are easy to remember; a quietly edited sentence in src/prompts.js is not, and it moves
 * scores as much as a model swap does. If two runs disagree and their prompt hashes
 * differ, the comparison was never valid.
 */
function promptHash(uiLanguage) {
  const h = createHash('sha256');
  for (const direction of ['auto', 'ko_to_en', 'en_to_ko']) {
    h.update(buildSystemPrompt(uiLanguage, direction));
  }
  return h.digest('hex');
}

// Rough token estimate for --dry-run only. Korean runs ~2-3 chars/token and English ~4
// on modern BPE vocabularies; 3.5 splits the difference for this mixed-language prompt.
// Never used for billing - actual `usage` from the API is what the cost report uses.
const CHARS_PER_TOKEN = 3.5;
const ASSUMED_OUTPUT_TOKENS = 400;

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function dryRun(config, items, runs) {
  const sysChars = Math.max(
    ...['ko_to_en', 'en_to_ko'].map(d => buildSystemPrompt(config.uiLanguage ?? 'ko', d).length)
  );
  const srcChars = items.reduce((sum, it) => sum + it.source.length, 0);
  const promptTokens = Math.round((sysChars * items.length + srcChars) / CHARS_PER_TOKEN);
  const outputTokens = items.length * ASSUMED_OUTPUT_TOKENS;

  const calls = items.length * runs;
  const price = priceFor(config.modelId, config.provider);
  const perRunCost = costUSD(config.modelId, config.provider, promptTokens, outputTokens);

  console.log(`\n  DRY RUN - no API calls made\n`);
  console.log(`  config          ${config.name}`);
  console.log(`  provider/model  ${config.provider} / ${config.modelId}`);
  console.log(`  items           ${items.length}`);
  console.log(`  runs            ${runs}`);
  console.log(`  total calls     ${calls}`);
  console.log(`  est. tokens     ${promptTokens.toLocaleString()} in / ${outputTokens.toLocaleString()} out per run  (rough, ~${CHARS_PER_TOKEN} chars/token)`);
  if (perRunCost === null) {
    console.log(`  est. cost       UNKNOWN - "${config.modelId}" has no row in src/pricing.js`);
  } else {
    console.log(`  est. cost       $${perRunCost.toFixed(4)} per run, $${(perRunCost * runs).toFixed(4)} total  (prices as of ${price.fetchedAt})`);
    console.log(`  per 1k items    $${(perRunCost / items.length * 1000).toFixed(4)}`);
  }
  const concurrency = config.concurrency ?? 4;
  const assumedLatencySec = 2;
  console.log(`  est. wall time  ~${Math.ceil(calls * assumedLatencySec / concurrency / 60)} min at concurrency ${concurrency}, assuming ${assumedLatencySec}s/call\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(args.config, 'utf8'));
  const runs = args.runs ?? config.runs ?? 3;

  const { items: allItems, checksums } = loadDataset(config);
  const limit = args.limit ?? config.limit ?? null;
  const items = limit ? allItems.slice(0, limit) : allItems;

  if (args.dryRun) return dryRun(config, items, runs);

  const runId = args.out ?? `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${config.name}`;
  const outDir = path.join(RESULTS_DIR, runId);
  mkdirSync(outDir, { recursive: true });

  writeFileSync(path.join(outDir, 'config.json'), JSON.stringify({
    ...config,
    runId,
    resolvedModelId: config.modelId,
    runs,
    limit,
    itemCount: items.length,
    datasetChecksums: checksums,
    promptHash: promptHash(config.uiLanguage ?? 'ko'),
    // Bumped whenever a compliance check or judge rubric changes meaning. Two runs with
    // different scoringVersion values are not comparable even at identical promptHash.
    scoringVersion: 1,
    judgeModelId: config.judgeModelId ?? null,
    harnessVersion: HARNESS_VERSION,
    nodeVersion: process.version,
    git: gitState(),
    startedAt: new Date().toISOString(),
  }, null, 2));

  const translate = makeProvider(config);
  const predictionsFile = path.join(outDir, 'predictions.jsonl');
  writeFileSync(predictionsFile, '');

  // Three runs of the same config, because temperature 0 does not mean deterministic.
  // Batched serving stacks reorder floating-point accumulation depending on what else is
  // in the batch, so identical inputs can produce different outputs. score.py turns the
  // spread across these runs into runVariance - the noise floor that any model-to-model
  // gap has to clear before it means anything.
  for (let runIndex = 0; runIndex < runs; runIndex++) {
    let done = 0;
    const started = Date.now();
    const records = await mapPool(items, config.concurrency ?? 4, async item => {
      const rec = await translate(item);
      done++;
      if (done % 25 === 0 || done === items.length) {
        process.stdout.write(`\r\x1b[K  run ${runIndex + 1}/${runs}  ${done}/${items.length}`);
      }
      return { ...rec, runIndex };
    });
    appendFileSync(predictionsFile, records.map(r => JSON.stringify(r)).join('\n') + '\n');

    const failures = records.filter(r => r.error).length;
    console.log(`\r\x1b[K  run ${runIndex + 1}/${runs}  ${items.length}/${items.length}  ${Math.round((Date.now() - started) / 1000)}s  ${failures} failed`);
  }

  console.log(`\n  wrote ${outDir}`);
  console.log(`  next: python3 score/score.py --run-dir ${path.relative(process.cwd(), outDir)}\n`);
}

main().catch(e => { console.error(`\n${e.message}\n`); process.exit(1); });
