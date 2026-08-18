import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// minIntervalMs is opt-in (config.minIntervalMs), for providers whose free tier caps
// requests-per-minute low enough that the client's own retry/backoff can't recover
// within MAX_RETRIES - e.g. Google AI Studio's free tier (15 RPM) sends no Retry-After
// header, so apiClient's retry falls back to its short fixed delays and the request
// just fails instead of waiting out the real reset window. Pacing calls here keeps the
// benchmark honest without changing the shipped extension's retry policy.
export async function mapPool(items, concurrency, fn, minIntervalMs = 0) {
  // The sleep is per-worker and lands *after* an item finishes, so it is an inter-request
  // gap, not a rate limiter: effective RPM is concurrency / (latency + minIntervalMs).
  // With more than one worker that quietly exceeds the very cap it exists to respect, and
  // the run turns into a 429 storm instead of a measurement.
  // ponytail: pin the assumption instead of building a token bucket. Promote to a real
  // rate limiter if multi-worker pacing is ever actually needed.
  if (minIntervalMs && concurrency > 1) {
    throw new Error(`minIntervalMs pacing requires concurrency: 1 (got ${concurrency})`);
  }
  const results = new Array(items.length);
  let next = 0;
  // Set by a worker whose fn threw AllKeysExhausted. The others finish their current item
  // and stop rather than each burning a full retry cycle against a dead quota.
  let stop = null;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      if (stop) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (e.name !== 'AllKeysExhausted') throw e;
        stop = e;
        return;
      }
      // Not after the worker's last item: that delay paces nothing and just burns
      // minIntervalMs of wall clock per worker, per run.
      if (minIntervalMs && next < items.length) await sleep(minIntervalMs);
    }
  });
  await Promise.all(workers);
  return { results: results.filter(r => r !== undefined), stopped: stop };
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

  const limit = args.limit ?? config.limit ?? null;
  const { items, checksums } = loadDataset({ ...config, limit });

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
  // Resume: whatever is already on disk for this runId stays, and its (runIndex, id) pairs
  // are skipped. A run stopped by quota exhaustion is picked up with the same --out once
  // the quota refills, instead of paying for the completed items twice.
  const done = new Set();
  if (existsSync(predictionsFile)) {
    for (const line of readFileSync(predictionsFile, 'utf8').split('\n')) {
      if (!line) continue;
      const r = JSON.parse(line);
      done.add(`${r.runIndex}:${r.id}`);
    }
    if (done.size) console.log(`\n  resuming: ${done.size} record(s) already on disk`);
  } else {
    writeFileSync(predictionsFile, '');
  }

  // Three runs of the same config, because temperature 0 does not mean deterministic.
  // Batched serving stacks reorder floating-point accumulation depending on what else is
  // in the batch, so identical inputs can produce different outputs. score.py turns the
  // spread across these runs into runVariance - the noise floor that any model-to-model
  // gap has to clear before it means anything.
  const relOut = path.relative(process.cwd(), outDir);
  for (let runIndex = 0; runIndex < runs; runIndex++) {
    const todo = items.filter(it => !done.has(`${runIndex}:${it.id}`));
    if (!todo.length) {
      console.log(`  run ${runIndex + 1}/${runs}  already complete, skipping`);
      continue;
    }
    let finished = 0;
    const started = Date.now();
    const { results, stopped } = await mapPool(todo, config.concurrency ?? 4, async item => {
      const rec = await translate(item);
      // Appended per item, not per run: a run killed midway (quota, Ctrl-C, crash) used to
      // lose every completed item because the single write happened only at the end.
      appendFileSync(predictionsFile, JSON.stringify({ ...rec, runIndex }) + '\n');
      finished++;
      if (finished % 25 === 0 || finished === todo.length) {
        process.stdout.write(`\r\x1b[K  run ${runIndex + 1}/${runs}  ${finished}/${todo.length}`);
      }
      return { ...rec, runIndex };
    }, config.minIntervalMs ?? 0);

    const failures = results.filter(r => r.error).length;
    console.log(`\r\x1b[K  run ${runIndex + 1}/${runs}  ${results.length}/${todo.length}  ${Math.round((Date.now() - started) / 1000)}s  ${failures} failed`);

    if (stopped) {
      console.log(`\n  STOPPED: ${stopped.message}`);
      console.log(`  ${results.length + done.size} record(s) saved in ${relOut}`);
      console.log(`\n  Refill the quota (or add another key), then resume with the same runId:`);
      console.log(`    node src/run.js --config ${args.config} ${args.limit ? `--limit ${args.limit} ` : ''}--runs ${runs} --out ${runId}\n`);
      process.exitCode = 2;
      return;
    }
  }

  console.log(`\n  wrote ${outDir}`);
  console.log(`  next: python3 score/score.py --run-dir ${relOut}\n`);
}

// Only when invoked as the CLI: run.test.js imports mapPool from here, and an
// import must not kick off a benchmark.
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(e => { console.error(`\n${e.message}\n`); process.exit(1); });
}
