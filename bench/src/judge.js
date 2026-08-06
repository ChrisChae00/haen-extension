import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TranslatorAPI } from '../../src/apiClient.js';
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

// Cache invalidation key. score.py's scoring must be deterministic (run it twice, get
// identical numbers), which is why judge.jsonl is never re-requested for an id already
// present - but that only holds if the rubric that produced the cached row is the same
// rubric being scored against. Editing RUBRIC and re-running judge.js used to silently
// keep serving verdicts from the old wording. Rows are tagged with this hash; a mismatch
// means the row is stale, not a cache hit.
const RUBRIC_HASH = createHash('sha256').update(RUBRIC).digest('hex');

function parseArgs(argv) {
  const args = { runDir: null, limit: DEFAULT_SUBSET };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run-dir') args.runDir = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.runDir) throw new Error('Usage: node src/judge.js --run-dir results/<run-id> [--limit 50]');
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
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`judge returned no JSON object: ${raw.slice(0, 120)}`);
  const parsed = JSON.parse(match[0]);
  const scores = {};
  for (const c of CRITERIA) {
    if (typeof parsed[c] !== 'boolean') throw new Error(`judge omitted boolean "${c}"`);
    scores[c] = parsed[c];
  }
  return { scores, note: typeof parsed.note === 'string' ? parsed.note : '' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = path.resolve(args.runDir);
  const config = JSON.parse(readFileSync(path.join(runDir, 'config.json'), 'utf8'));

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
      const { scores, note } = extractVerdict(raw);
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

main().catch(e => { console.error(`\n${e.message}\n`); process.exit(1); });
