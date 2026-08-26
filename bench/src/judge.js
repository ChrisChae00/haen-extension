import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TranslatorAPI, stripThinking } from '../../src/apiClient.js';
import { loadDataset } from './dataset.js';

// LLM-as-judge for the three fields no reference metric can see.
//
// Compliance only asks "does `nuance` exist". A model can emit a present, well-formed,
// completely vacuous nuance string and score 100%. Small models do exactly that, and
// those fields are a large part of why Haen exists rather than a plain translator.
//
// Binary criteria only. Five-point rubrics make LLM judges unstable - the same output
// drifts between 3 and 4 across calls - while a yes/no question about a specific,
// checkable property is comparatively steady.
//
// Results are cached to judge.jsonl and never re-requested, because scoring must be
// deterministic: running score.py twice has to produce identical numbers.

const RUBRIC = `You are evaluating one output of a Korean-English translation assistant.

You will receive: the source sentence, its translation direction, and the assistant's
structured output (natural, literal, nuance, alternatives, tip).

Judge each criterion independently and answer strictly true or false. When genuinely
uncertain, answer false - a criterion should only pass on clear evidence.

- naturalFluent: would a native speaker of the TARGET language find "natural" fluent and
  idiomatic? False if it reads as translationese, is ungrammatical, or is a word-for-word
  rendering that does not work in the target language.
- nuanceGrounded: does "nuance" say something specific about THIS sentence - its register,
  the relationship between speakers, when it would actually be used? False if it is
  generic filler that would apply to almost any sentence, or if it restates the
  translation without adding cultural information.
- altsDistinct: are the alternative categories genuinely different in register or
  situation? False if the categories are near-synonyms, if the same expression appears in
  both, or if the labels differ but the expressions do not.
- tipFactual: is "tip" factually correct about the grammar or cultural point it claims?
  If "tip" is an empty string, answer true (an omitted optional field is not an error).
  False if it states something untrue or contradicts the rest of the output.

Respond with ONLY this JSON object, no prose and no code fences:
{"naturalFluent": true|false, "nuanceGrounded": true|false, "altsDistinct": true|false, "tipFactual": true|false, "note": "one short sentence on the weakest criterion"}`;

const CRITERIA = ['naturalFluent', 'nuanceGrounded', 'altsDistinct', 'tipFactual'];
const DEFAULT_SUBSET = 50;
const PAIRWISE_CRITERIA = ['natural', 'nuance'];
const PAIRWISE_CACHE_VERSION = 2;

const PAIRWISE_RUBRIC = `You are comparing two Korean-English translation assistant outputs for one source sentence.

Judge the two criteria independently. For each, choose exactly one of "A", "B", or "tie".
Choose "tie" when neither output is clearly better or the difference is too small to call.

- natural: which output's "natural" translation is more fluent, idiomatic, and faithful in the target language?
- nuance: which output's "nuance" is more specific and accurate for this sentence's register, speaker relationship, or real use? Generic filler loses to a grounded explanation.

Respond with ONLY this JSON object, no prose and no code fences:
{"natural":"A|B|tie","nuance":"A|B|tie","note":"one short sentence"}`;

// Cache invalidation key. score.py's scoring must be deterministic (run it twice, get
// identical numbers), which is why judge.jsonl is never re-requested for an id already
// present - but that only holds if the rubric that produced the cached row is the same
// rubric being scored against. Editing RUBRIC and re-running judge.js used to silently
// keep serving verdicts from the old wording. Rows are tagged with this hash; a mismatch
// means the row is stale, not a cache hit.
const RUBRIC_HASH = createHash('sha256').update(RUBRIC).digest('hex');

function parseArgs(argv) {
  const args = { runDir: null, baselineRunDir: null, limit: DEFAULT_SUBSET };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run-dir') args.runDir = argv[++i];
    else if (argv[i] === '--baseline-run-dir') args.baselineRunDir = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.runDir) throw new Error('Usage: node src/judge.js --run-dir results/<run-id> [--baseline-run-dir results/<run-id>] [--limit 50]');
  return args;
}

function buildUserMessage(item, record) {
  return JSON.stringify({
    source: item.source,
    direction: item.direction,
    output: {
      natural: record.parsed?.natural ?? '',
      literal: record.parsed?.literal ?? '',
      nuance: record.parsed?.nuance ?? '',
      alternatives: record.parsed?.alternatives ?? [],
      tip: record.parsed?.tip ?? '',
    },
  }, null, 2);
}

function extractVerdict(raw) {
  // Same failure the translation path hit: a reasoning block containing braces makes the
  // greedy match span from the scratchpad's first `{` to the answer's last `}`.
  const match = stripThinking(raw).match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`judge returned no JSON object: ${raw.slice(0, 120)}`);
  const parsed = JSON.parse(match[0]);
  const scores = {};
  for (const c of CRITERIA) {
    if (typeof parsed[c] !== 'boolean') throw new Error(`judge omitted boolean "${c}"`);
    scores[c] = parsed[c];
  }
  return { scores, note: typeof parsed.note === 'string' ? parsed.note : '' };
}

export function extractPairwiseVerdict(raw) {
  const match = stripThinking(raw).match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`judge returned no JSON object: ${raw.slice(0, 120)}`);
  const parsed = JSON.parse(match[0]);
  const choices = {};
  for (const criterion of PAIRWISE_CRITERIA) {
    if (!['A', 'B', 'tie'].includes(parsed[criterion])) {
      throw new Error(`judge omitted ${criterion} choice A, B, or tie`);
    }
    choices[criterion] = parsed[criterion];
  }
  return { ...choices, note: typeof parsed.note === 'string' ? parsed.note : '' };
}

export function normalizeOrderVerdict(verdict, candidatePosition) {
  if (!['A', 'B'].includes(candidatePosition)) throw new Error('candidate position must be A or B');
  const baselinePosition = candidatePosition === 'A' ? 'B' : 'A';
  return Object.fromEntries(PAIRWISE_CRITERIA.map(criterion => {
    const choice = verdict[criterion];
    if (!['A', 'B', 'tie'].includes(choice)) throw new Error(`invalid ${criterion} choice`);
    return [criterion, choice === 'tie' ? 'tie' : choice === candidatePosition ? 'candidate' : baselinePosition === choice ? 'baseline' : 'tie'];
  }));
}

export function finalizePairwiseVerdicts(first, second) {
  return Object.fromEntries(PAIRWISE_CRITERIA.map(criterion => {
    const winner = first[criterion] === second[criterion] && ['candidate', 'baseline'].includes(first[criterion])
      ? first[criterion]
      : 'tie';
    return [criterion, winner];
  }));
}

export function exactSignTestPValue(wins, losses) {
  if (!Number.isInteger(wins) || !Number.isInteger(losses) || wins < 0 || losses < 0) {
    throw new Error('wins and losses must be non-negative integers');
  }
  const total = wins + losses;
  if (total === 0) return 1;
  const smaller = Math.min(wins, losses);
  let probability = 2 ** -total;
  let tail = probability;
  for (let k = 0; k < smaller; k++) {
    probability *= (total - k) / (k + 1);
    tail += probability;
  }
  return Math.min(1, 2 * tail);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashComparison(input) {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

const datasetIdentity = config => ({
  datasetVersion: config.datasetVersion,
  datasets: config.datasets,
  datasetChecksums: config.datasetChecksums,
});

// MEASUREMENT-NOTES 6.1: two runs are comparable only when everything except the model
// under test matches. A differing promptHash or reasoningEffort makes the sign test
// attribute a harness change to the model. Git sha is deliberately not here - a tuned run
// is made later than its baseline and would never compare.
const harnessIdentity = config => ({
  promptHash: config.promptHash,
  scoringVersion: config.scoringVersion,
  harness: config.harness,
  uiLanguage: config.uiLanguage,
  temperature: config.temperature,
  jsonMode: config.jsonMode,
  stream: config.stream,
  reasoningEffort: config.reasoningEffort,
});

export function validateComparableConfigs(candidateConfig, baselineConfig, candidateDirName, baselineDirName) {
  if (candidateConfig.runId !== candidateDirName) {
    throw new Error(`candidate config runId ${JSON.stringify(candidateConfig.runId)} does not match directory ${JSON.stringify(candidateDirName)}`);
  }
  if (baselineConfig.runId !== baselineDirName) {
    throw new Error(`baseline config runId ${JSON.stringify(baselineConfig.runId)} does not match directory ${JSON.stringify(baselineDirName)}`);
  }
  if (candidateConfig.runId === baselineConfig.runId) throw new Error('candidate and baseline runId must differ');
  if (stableJson(datasetIdentity(candidateConfig)) !== stableJson(datasetIdentity(baselineConfig))) {
    throw new Error('candidate and baseline config dataset identity differs');
  }
  const candidateHarness = harnessIdentity(candidateConfig);
  const baselineHarness = harnessIdentity(baselineConfig);
  const differing = Object.keys(candidateHarness)
    .filter(key => stableJson(candidateHarness[key]) !== stableJson(baselineHarness[key]));
  if (differing.length) {
    throw new Error(`candidate and baseline harness settings differ (${differing.join(', ')}); only the model under test may differ`);
  }
}

function outputForJudge(record) {
  return record.parsed ?? { raw: record.raw ?? '' };
}

function buildPairwiseUserMessage(item, candidate, baseline, candidatePosition) {
  const a = candidatePosition === 'A' ? candidate : baseline;
  const b = candidatePosition === 'A' ? baseline : candidate;
  return JSON.stringify({
    source: item.source,
    direction: item.direction,
    outputA: outputForJudge(a),
    outputB: outputForJudge(b),
  }, null, 2);
}

function readPredictions(runDir) {
  return readFileSync(path.join(runDir, 'predictions.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function recordsForIds(records, idsOrItems, label) {
  const itemsById = new Map(idsOrItems.map(item => [typeof item === 'string' ? item : item.id, item]));
  const selected = records.filter(record => record.runIndex === 0 && record.id.startsWith('hb'));
  const byId = new Map();
  for (const record of selected) {
    if (byId.has(record.id)) throw new Error(`${label} has duplicate runIndex 0 prediction for ${record.id}`);
    const item = itemsById.get(record.id);
    if (!item) throw new Error(`${label} item set differs: unexpected ${record.id}`);
    if (typeof item !== 'string' && (record.direction !== item.direction || record.slice !== item.slice)) {
      throw new Error(`${label} metadata differs for ${record.id}`);
    }
    if (!record.parsed) throw new Error(`${label} has no parsed output for ${record.id}`);
    byId.set(record.id, record);
  }
  const missing = [...itemsById.keys()].filter(id => !byId.has(id));
  if (missing.length) throw new Error(`${label} item set differs: missing ${missing.join(', ')}`);
  return byId;
}

function judgeIdentity(config) {
  return { provider: config.judgeProvider ?? config.provider, modelId: config.judgeModelId };
}

function comparisonInput({ item, candidate, baseline, candidateConfig, baselineConfig }) {
  return {
    cacheVersion: PAIRWISE_CACHE_VERSION,
    id: item.id,
    candidateRunId: candidateConfig.runId,
    baselineRunId: baselineConfig.runId,
    dataset: datasetIdentity(candidateConfig),
    judge: judgeIdentity(candidateConfig),
    rubric: PAIRWISE_RUBRIC,
    candidateOutput: { raw: candidate.raw ?? null, parsed: candidate.parsed ?? null },
    baselineOutput: { raw: baseline.raw ?? null, parsed: baseline.parsed ?? null },
  };
}

export function selectPairwiseSubset(handbuilt, limit) {
  if (limit >= handbuilt.length) return handbuilt;
  const groups = new Map();
  for (const item of handbuilt) {
    const key = `${item.slice}\u0000${item.direction}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const perStratum = Math.floor(limit / groups.size);
  let remainder = limit % groups.size;
  const selected = [];
  for (const items of groups.values()) {
    selected.push(...items.slice(0, perStratum + (remainder-- > 0 ? 1 : 0)));
  }
  return selected.sort((a, b) => a.id.localeCompare(b.id));
}

export function isCompletePairwiseRow(row) {
  const orders = row?.orderVerdicts;
  if (!Array.isArray(orders) || orders.length !== 2) return false;
  const positions = new Set(orders.map(order => order.candidatePosition));
  if (positions.size !== 2 || !positions.has('A') || !positions.has('B')) return false;
  if (!orders.every(order => typeof order.raw === 'string' && order.verdict
    && PAIRWISE_CRITERIA.every(criterion => ['candidate', 'baseline', 'tie'].includes(order.normalized?.[criterion])))) return false;
  return PAIRWISE_CRITERIA.every(criterion => ['candidate', 'baseline', 'tie'].includes(row.winner?.[criterion]));
}

export function checkpointPairwiseOrder(row, candidatePosition, response) {
  if (row.orderVerdicts.some(order => order.candidatePosition === candidatePosition)) {
    throw new Error(`pairwise order ${candidatePosition} is already checkpointed`);
  }
  const normalized = normalizeOrderVerdict(response.verdict, candidatePosition);
  const next = {
    ...row,
    orderVerdicts: [...row.orderVerdicts, { candidatePosition, raw: response.raw, verdict: response.verdict, normalized }]
      .sort((a, b) => a.candidatePosition.localeCompare(b.candidatePosition)),
  };
  if (next.orderVerdicts.length === 2) {
    next.winner = finalizePairwiseVerdicts(next.orderVerdicts[0].normalized, next.orderVerdicts[1].normalized);
  }
  return next;
}

function writePairwiseRows(outFile, rows) {
  const tempFile = `${outFile}.${process.pid}.tmp`;
  writeFileSync(tempFile, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  renameSync(tempFile, outFile);
}

async function mainAbsolute(args, runDir, config) {

  if (!config.judgeModelId) {
    throw new Error('config.judgeModelId is not set. The judge must be a model that is NOT under test.');
  }
  if (config.judgeModelId === config.modelId) {
    throw new Error(`Judge and subject are the same model (${config.modelId}). Self-preference bias would make the scores meaningless.`);
  }

  const apiKey = config.judgeApiKeyEnv ? process.env[config.judgeApiKeyEnv] : process.env[config.apiKeyEnv];
  if (!apiKey) throw new Error(`No API key for the judge (set ${config.judgeApiKeyEnv ?? config.apiKeyEnv})`);

  const { items } = loadDataset(config);
  const byId = new Map(items.map(i => [i.id, i]));

  const records = readFileSync(path.join(runDir, 'predictions.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(r => r.runIndex === 0 && r.parsed && byId.get(r.id)?.slice !== 'flores-wiki');

  // Same stable id order as everything else, so the judged subset is identical between runs.
  const subset = records.sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, args.limit);

  const outFile = path.join(runDir, 'judge.jsonl');
  const existingRows = existsSync(outFile)
    ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    : [];
  const fresh = existingRows.filter(r => r.rubricHash === RUBRIC_HASH);
  const stale = existingRows.length - fresh.length;
  if (stale > 0) {
    console.log(`  rubric changed since last run - dropping ${stale} stale cached verdict(s)`);
    writeFileSync(outFile, fresh.map(r => JSON.stringify(r)).join('\n') + (fresh.length ? '\n' : ''));
  } else if (!existsSync(outFile)) {
    writeFileSync(outFile, '');
  }
  const alreadyJudged = new Set(fresh.map(r => r.id));

  const todo = subset.filter(r => !alreadyJudged.has(r.id));
  if (todo.length === 0) {
    console.log(`  all ${subset.length} items already judged (cache hit, 0 API calls)`);
    return;
  }
  console.log(`  judging ${todo.length} items (${alreadyJudged.size} cached) with ${config.judgeModelId}`);

  const api = new TranslatorAPI();
  let failures = 0;
  for (const [n, record] of todo.entries()) {
    const item = byId.get(record.id);
    let raw = '';
    try {
      // One retry: a judge call that comes back with a truncated body is not a verdict of
      // "unjudgeable", it is a transient. Without this, the item is dropped from the
      // subset silently and the model is scored on a smaller n than its peers - which is
      // exactly the comparison the subset exists to make.
      let verdict = null;
      for (let attempt = 0; attempt < 2 && !verdict; attempt++) {
        // Cleared per attempt. The call below swallows its own error, so without this the
        // retry would re-judge attempt 1's truncated body and fail identically - a retry
        // that only looks like one.
        raw = '';
        // Reusing TranslatorAPI for its retry and error handling. The rubric replaces the
        // translation prompt via promptOverride; the judge is not translating anything.
        await api.translate(buildUserMessage(item, record), {
          apiKey,
          provider: config.judgeProvider ?? config.provider,
          modelId: config.judgeModelId,
          temperature: 0,
          systemPromptOverride: RUBRIC,
          onRaw: body => { raw = body; },
        }).catch(() => {});
        try {
          verdict = extractVerdict(raw);
        } catch (e) {
          if (attempt === 1) throw e;
        }
      }
      const { scores, note } = verdict;
      appendFileSync(outFile, JSON.stringify({
        id: record.id, slice: record.slice, judgeModelId: config.judgeModelId, rubricHash: RUBRIC_HASH, scores, note,
      }) + '\n');
    } catch (e) {
      failures++;
      console.error(`    ${record.id}: ${e.message}`);
    }
    if ((n + 1) % 10 === 0) process.stdout.write(`\r  ${n + 1}/${todo.length}`);
  }
  console.log(`\r  done. ${todo.length - failures} judged, ${failures} failed -> ${outFile}`);
  console.log('  Judge scores are for relative comparison between models only.');
}

export function pairwiseSignTests(rows) {
  const completeRows = rows.filter(isCompletePairwiseRow);
  return Object.fromEntries(PAIRWISE_CRITERIA.map(criterion => {
    const candidateWins = completeRows.filter(row => row.winner[criterion] === 'candidate').length;
    const baselineWins = completeRows.filter(row => row.winner[criterion] === 'baseline').length;
    const ties = completeRows.length - candidateWins - baselineWins;
    return [criterion, {
      candidateWins,
      baselineWins,
      ties,
      pValue: exactSignTestPValue(candidateWins, baselineWins),
    }];
  }));
}

async function judgePairwiseOrder(api, item, candidate, baseline, candidatePosition, config, apiKey) {
  let raw = '';
  // Pairwise results are two fixed observations, not "retry until a judge agrees".
  // `_translate` performs one fetch; the public `translate` wrapper retries transport
  // failures, which would silently turn one order into several judge requests.
  await api._translate(buildPairwiseUserMessage(item, candidate, baseline, candidatePosition), {
    apiKey,
    uiLanguage: 'ko',
    direction: 'auto',
    model: config.judgeModelId,
    modelKey: 'llama4',
    provider: config.judgeProvider ?? config.provider,
    modelId: config.judgeModelId,
    temperature: 0,
    useJsonMode: true,
    systemPromptOverride: PAIRWISE_RUBRIC,
    onRaw: body => { raw = body; },
  }).catch(error => {
    // The catch is load-bearing: a judge verdict has no `alternatives`, so the response
    // parser always rejects a perfectly good verdict. But an empty `raw` means no response
    // body ever arrived - a 429, a bad key, a dropped connection - and that must not be
    // laundered into "unparseable verdict", which would silently shrink n.
    if (!raw) throw error;
  });
  return { raw, verdict: extractPairwiseVerdict(raw) };
}

async function mainPairwise(args, runDir, candidateConfig) {
  if (!Number.isInteger(args.limit) || args.limit < 1) throw new Error('--limit must be a positive integer');
  const baselineRunDir = path.resolve(args.baselineRunDir);
  const baselineConfig = JSON.parse(readFileSync(path.join(baselineRunDir, 'config.json'), 'utf8'));
  validateComparableConfigs(candidateConfig, baselineConfig, path.basename(runDir), path.basename(baselineRunDir));

  if (!candidateConfig.judgeModelId) {
    throw new Error('config.judgeModelId is not set. The judge must be a model that is NOT under test.');
  }
  if (candidateConfig.judgeModelId === candidateConfig.modelId || candidateConfig.judgeModelId === baselineConfig.modelId) {
    throw new Error('Judge must not be either model under comparison.');
  }
  const apiKey = candidateConfig.judgeApiKeyEnv ? process.env[candidateConfig.judgeApiKeyEnv] : process.env[candidateConfig.apiKeyEnv];
  if (!apiKey) throw new Error(`No API key for the judge (set ${candidateConfig.judgeApiKeyEnv ?? candidateConfig.apiKeyEnv})`);

  const { items, checksums } = loadDataset(candidateConfig);
  if (stableJson(checksums) !== stableJson(candidateConfig.datasetChecksums)) {
    throw new Error('candidate config dataset identity no longer matches the dataset files on disk');
  }
  const handbuilt = items.filter(item => item.id.startsWith('hb')).sort((a, b) => a.id.localeCompare(b.id));
  if (handbuilt.length !== 40) throw new Error(`Pairwise judging requires the 40 handbuilt items, found ${handbuilt.length}`);
  const candidateRecords = recordsForIds(readPredictions(runDir), handbuilt, 'candidate');
  const baselineRecords = recordsForIds(readPredictions(baselineRunDir), handbuilt, 'baseline');
  const subset = selectPairwiseSubset(handbuilt, args.limit);

  const hashById = new Map(handbuilt.map(item => [item.id, hashComparison(comparisonInput({
    item,
    candidate: candidateRecords.get(item.id),
    baseline: baselineRecords.get(item.id),
    candidateConfig,
    baselineConfig,
  }))]));
  const outFile = path.join(runDir, 'pairwise.jsonl');
  const existingRows = existsSync(outFile)
    ? readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  const fresh = existingRows.filter(row => hashById.get(row.id) === row.comparisonHash);
  const stale = existingRows.length - fresh.length;
  if (stale > 0 || !existsSync(outFile)) {
    writePairwiseRows(outFile, fresh);
  }
  const cached = new Map(fresh.map(row => [row.id, row]));
  const todo = subset.filter(item => !isCompletePairwiseRow(cached.get(item.id)));
  if (stale) console.log(`  comparison inputs changed - dropping ${stale} stale cached verdict(s)`);
  console.log(`  pairwise judging ${todo.length} items (${subset.length - todo.length} cached) with ${candidateConfig.judgeModelId}`);

  const api = new TranslatorAPI();
  let failures = 0;
  for (const [index, item] of todo.entries()) {
    try {
      const candidate = candidateRecords.get(item.id);
      const baseline = baselineRecords.get(item.id);
      let row = cached.get(item.id) ?? {
        id: item.id,
        slice: item.slice,
        candidateRunId: candidateConfig.runId,
        baselineRunId: baselineConfig.runId,
        judgeModelId: candidateConfig.judgeModelId,
        comparisonHash: hashById.get(item.id),
        orderVerdicts: [],
      };
      for (const candidatePosition of ['A', 'B']) {
        if (row.orderVerdicts.some(order => order.candidatePosition === candidatePosition)) continue;
        row = checkpointPairwiseOrder(
          row,
          candidatePosition,
          await judgePairwiseOrder(api, item, candidate, baseline, candidatePosition, candidateConfig, apiKey),
        );
        cached.set(item.id, row);
        writePairwiseRows(outFile, [...cached.values()]);
      }
    } catch (error) {
      failures++;
      console.error(`    ${item.id}: ${error.message}`);
    }
    if ((index + 1) % 10 === 0) process.stdout.write(`\r  ${index + 1}/${todo.length}`);
  }
  const rows = subset.map(item => cached.get(item.id));
  const incomplete = subset.filter((item, index) => !isCompletePairwiseRow(rows[index]));
  console.log(`\r  done. ${subset.length - incomplete.length}/${subset.length} items complete, ${failures} failed -> ${outFile}`);

  // MEASUREMENT-NOTES 6.2: a p-value computed on whatever survived is not a smaller
  // result, it is a different experiment. Partial rows stay on disk as resume points; the
  // command refuses to summarise until every requested item has both orders.
  if (incomplete.length) {
    throw new Error(`${incomplete.length} of ${subset.length} items lack both A/B orders (${incomplete.slice(0, 5).map(item => item.id).join(', ')}${incomplete.length > 5 ? ', ...' : ''}). No p-value is valid on a partial subset - re-run to resume.`);
  }

  for (const [criterion, result] of Object.entries(pairwiseSignTests(rows))) {
    console.log(`  ${criterion}: candidate ${result.candidateWins}, baseline ${result.baselineWins}, ties ${result.ties}, exact sign-test p=${result.pValue}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(args.runDir);
  const config = JSON.parse(readFileSync(path.join(runDir, 'config.json'), 'utf8'));
  if (args.baselineRunDir) return mainPairwise(args, runDir, config);
  return mainAbsolute(args, runDir, config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`\n${error.message}\n`); process.exit(1); });
}
