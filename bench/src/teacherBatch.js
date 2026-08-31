import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSystemPrompt } from '../../src/prompts.js';
import { parseForTest, stripThinking } from '../../src/apiClient.js';
import { ALL_CHECKS, POSITIVE_CHECKS, checkCompliance } from './compliance.js';
import { priceFor } from './pricing.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

export function buildInlineRequests(items) {
  return items.map(item => ({
    metadata: { id: item.id, direction: item.direction },
    request: {
      systemInstruction: {
        parts: [{ text: buildSystemPrompt('ko', item.direction) }],
      },
      contents: [{ role: 'user', parts: [{ text: item.source }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    },
  }));
}

export function splitByStableId(samples) {
  const validCount = samples.length ? Math.max(1, Math.round(samples.length * 0.1)) : 0;
  const validIds = new Set(samples
    .map(sample => ({ id: sample.id, hash: createHash('sha256').update(sample.id).digest('hex') }))
    .sort((a, b) => a.hash.localeCompare(b.hash) || a.id.localeCompare(b.id))
    .slice(0, validCount)
    .map(sample => sample.id));
  return {
    train: samples.filter(sample => !validIds.has(sample.id)),
    valid: samples.filter(sample => validIds.has(sample.id)),
  };
}

export function prepareBatch({ items, stateFile, payloadFile, model }) {
  const requests = buildInlineRequests(items);
  const inputHash = createHash('sha256').update(JSON.stringify({ model, requests })).digest('hex');
  const displayName = `haen-teacher-${inputHash.slice(0, 12)}`;
  const payload = {
    batch: {
      displayName,
      inputConfig: { requests: { requests } },
    },
  };
  const payloadText = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(payloadText);
  if (payloadBytes >= MAX_INLINE_BYTES) {
    throw new Error(`inline batch is ${payloadBytes} bytes; limit is below ${MAX_INLINE_BYTES}`);
  }

  mkdirSync(path.dirname(stateFile), { recursive: true });
  if (existsSync(stateFile)) {
    const existing = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (existing.inputHash !== inputHash || existing.model !== model) {
      throw new Error(`existing batch state has different input (${existing.inputHash}); refusing to overwrite`);
    }
    writeJsonAtomic(payloadFile, payload);
    return existing;
  }

  const state = {
    version: 1,
    status: 'prepared',
    model,
    displayName,
    inputHash,
    itemCount: items.length,
    payloadBytes,
    preparedAt: new Date().toISOString(),
  };
  writeJsonAtomic(payloadFile, payload);
  writeJsonAtomic(stateFile, state);
  return state;
}

export function collectTeacherSamples(items, operation) {
  const byId = new Map(items.map(item => [item.id, item]));
  const responses = operation.response?.inlinedResponses?.inlinedResponses
    ?? operation.response?.output?.inlinedResponses?.inlinedResponses
    ?? operation.metadata?.output?.inlinedResponses?.inlinedResponses;
  if (!Array.isArray(responses)) throw new Error('batch operation has no inline responses');
  if (responses.length !== items.length) {
    throw new Error(`expected ${items.length} batch responses, got ${responses.length}`);
  }

  const accepted = [];
  const rejected = [];
  const raw = [];
  const seen = new Set();
  for (const entry of responses) {
    const id = entry.metadata?.id;
    const item = byId.get(id);
    if (!item) throw new Error(`batch response has unknown item id: ${id ?? '<missing>'}`);
    if (seen.has(id)) throw new Error(`duplicate batch response item id: ${id}`);
    if (entry.metadata?.direction !== item.direction) {
      throw new Error(`batch response direction mismatch for ${id}`);
    }
    seen.add(id);
    const text = (entry.response?.candidates?.[0]?.content?.parts ?? [])
      .map(part => part.text ?? '')
      .join('');
    let parsed = null;
    let parseError = null;
    try { parsed = parseForTest(text); } catch (error) { parseError = error.message; }
    let salvaged = false;
    if (parsed?.alternatives?.length === 0) {
      try { JSON.parse(stripThinking(text).trim()); } catch { salvaged = true; }
    }
    const compliance = checkCompliance(text, parsed, item, { salvaged });
    const failedChecks = ALL_CHECKS.filter(check =>
      POSITIVE_CHECKS.has(check) ? !compliance[check] : compliance[check]);
    if (entry.error) failedChecks.push('responseError');
    const finishReason = entry.response?.candidates?.[0]?.finishReason ?? null;
    if (finishReason !== 'STOP') failedChecks.push('finishReason');

    raw.push({
      id,
      direction: item.direction,
      source: item.source,
      reference: item.references?.[0] ?? null,
      raw: text,
      parsed,
      parseError,
      finishReason,
      usageMetadata: entry.response?.usageMetadata ?? null,
      error: entry.error ?? null,
      compliance,
    });

    if (failedChecks.length) {
      rejected.push({ id, failedChecks, parseError });
      continue;
    }
    accepted.push({
      id,
      direction: item.direction,
      source: item.source,
      reference: item.references?.[0] ?? null,
      messages: [
        { role: 'system', content: buildSystemPrompt('ko', item.direction) },
        { role: 'user', content: item.source },
        { role: 'assistant', content: JSON.stringify(parsed) },
      ],
    });
  }
  return { accepted, rejected, raw };
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, file);
}

function writeJsonlAtomic(file, rows) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  renameSync(temp, file);
}

export async function submitBatch({ stateFile, payload, apiKey, fetchImpl = fetch }) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (state.status !== 'prepared') {
    throw new Error(`batch is ${state.status}; refusing to resubmit`);
  }

  // The state file attests to an inputHash; the payload is read from a separate file that
  // can be edited or left stale. Recompute from what is actually about to be POSTed -
  // after submission the mismatch is undetectable.
  const requests = payload?.batch?.inputConfig?.requests?.requests;
  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ model: state.model, requests }))
    .digest('hex');
  if (payloadHash !== state.inputHash) {
    throw new Error(`payload does not match prepared batch (payload ${payloadHash.slice(0, 12)}, state ${String(state.inputHash).slice(0, 12)}); re-run prepare`);
  }

  const submitting = { ...state, status: 'submitting', submitStartedAt: new Date().toISOString() };
  writeJsonAtomic(stateFile, submitting);

  let status = null;
  try {
    const response = await fetchImpl(
      `${API_ROOT}/models/${encodeURIComponent(state.model)}:batchGenerateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    status = response.status;
    const body = await response.json();
    if (!response.ok || !body.name) {
      throw new Error(`${response.status} ${body.error?.status ?? 'BATCH_SUBMIT_FAILED'}: ${body.error?.message ?? 'missing batch job name'}`);
    }
    const submitted = {
      ...submitting,
      status: 'submitted',
      jobName: body.name,
      submittedAt: new Date().toISOString(),
    };
    writeJsonAtomic(stateFile, submitted);
    return submitted;
  } catch (error) {
    // A 4xx with a parsed error body is a certain rejection - the server saw the request
    // and created nothing - so the batch goes back to `prepared` and can be fixed and
    // resubmitted. Only a request that may actually have landed (no response, 5xx, or an
    // unreadable 2xx) becomes `submission_uncertain`, which needs a human.
    const rejected = status !== null && status >= 400 && status < 500;
    writeJsonAtomic(stateFile, {
      ...submitting,
      status: rejected ? 'prepared' : 'submission_uncertain',
      error: error.message,
      failedAt: new Date().toISOString(),
    });
    throw error;
  }
}

const BENCH_DIR = fileURLToPath(new URL('../', import.meta.url));
const REPO_DIR = fileURLToPath(new URL('../../', import.meta.url));
const TRAIN_DIR = path.join(BENCH_DIR, 'datasets/train');
// A batch is keyed on the hash of its input, so adding items to an existing raw file makes a
// different batch and re-pays for every item already collected - the FLORES set cost $1.65.
// Naming a dataset switches the input file and the work directory together, so a second batch
// runs beside the first instead of on top of it.
const DATASETS = {
  flores:      { raw: 'raw.jsonl',            work: 'teacher' },
  'idioms-ko': { raw: 'raw-idioms-ko.jsonl',  work: 'teacher-idioms-ko' },
};

function paths(name = 'flores') {
  const dataset = DATASETS[name];
  if (!dataset) throw new Error(`unknown dataset ${name}; known: ${Object.keys(DATASETS).join(', ')}`);
  const work = path.join(TRAIN_DIR, dataset.work);
  return {
    workDir: work,
    rawFile: path.join(TRAIN_DIR, dataset.raw),
    stateFile: path.join(work, 'state.json'),
    payloadFile: path.join(work, 'payload.json'),
    operationFile: path.join(work, 'operation.json'),
  };
}
const MODEL = 'gemini-3.7-flash';

function readJsonl(file) {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function geminiApiKey() {
  const envFile = path.join(REPO_DIR, '.env');
  const line = readFileSync(envFile, 'utf8').split(/\r?\n/)
    .find(candidate => candidate.startsWith('GEMINI_API_KEY='));
  if (!line) throw new Error('GEMINI_API_KEY is missing from .env');
  let value = line.slice(line.indexOf('=') + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (!value) throw new Error('GEMINI_API_KEY is empty in .env');
  return value;
}

async function fetchOperation(state, apiKey, { stateFile, operationFile }) {
  if (!state.jobName) {
    throw new Error(`batch is ${state.status} without a job ID; refusing any new submission`);
  }
  const response = await fetch(`${API_ROOT}/${state.jobName}?key=${encodeURIComponent(apiKey)}`);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status} ${body.error?.status ?? 'BATCH_STATUS_FAILED'}: ${body.error?.message ?? 'unknown error'}`);
  }
  writeJsonAtomic(operationFile, body);
  const next = {
    ...state,
    status: body.done ? (body.error ? 'failed' : 'succeeded') : 'running',
    remoteState: body.metadata?.state ?? body.response?.state ?? null,
    lastCheckedAt: new Date().toISOString(),
    ...(body.error ? { remoteError: body.error } : {}),
  };
  writeJsonAtomic(stateFile, next);
  return { state: next, operation: body };
}

function usageSummary(records) {
  const tokens = records.reduce((sum, record) => {
    const usage = record.usageMetadata ?? {};
    sum.prompt += usage.promptTokenCount ?? 0;
    sum.visibleOutput += usage.candidatesTokenCount ?? 0;
    sum.thinking += usage.thoughtsTokenCount ?? 0;
    sum.total += usage.totalTokenCount ?? 0;
    return sum;
  }, { prompt: 0, visibleOutput: 0, thinking: 0, total: 0 });
  const price = priceFor(MODEL, 'google');
  const costUSD = price
    ? 0.5 * ((tokens.prompt / 1e6) * price.inputPer1M
      + ((tokens.visibleOutput + tokens.thinking) / 1e6) * price.outputPer1M)
    : null;
  return { tokens, batchCostUSD: costUSD, price };
}

async function main() {
  const command = process.argv[2];
  const flag = process.argv.indexOf('--dataset');
  const { workDir: WORK_DIR, rawFile: RAW_FILE, stateFile: STATE_FILE,
          payloadFile: PAYLOAD_FILE, operationFile: OPERATION_FILE } =
    paths(flag === -1 ? 'flores' : process.argv[flag + 1]);
  mkdirSync(WORK_DIR, { recursive: true });
  const items = readJsonl(RAW_FILE);

  if (command === 'prepare') {
    const state = prepareBatch({ items, stateFile: STATE_FILE, payloadFile: PAYLOAD_FILE, model: MODEL });
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  if (command === 'submit') {
    const payload = JSON.parse(readFileSync(PAYLOAD_FILE, 'utf8'));
    const state = await submitBatch({ stateFile: STATE_FILE, payload, apiKey: geminiApiKey() });
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  if (command === 'status') {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const refreshed = await fetchOperation(state, geminiApiKey(),
      { stateFile: STATE_FILE, operationFile: OPERATION_FILE });
    console.log(JSON.stringify(refreshed.state, null, 2));
    return;
  }

  if (command === 'collect') {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const operation = JSON.parse(readFileSync(OPERATION_FILE, 'utf8'));
    if (state.status !== 'succeeded' || !operation.done || operation.error) {
      throw new Error(`batch is not collectable: ${state.status}`);
    }
    const result = collectTeacherSamples(items, operation);
    const split = splitByStableId(result.accepted);
    const summary = {
      model: MODEL,
      requested: items.length,
      accepted: result.accepted.length,
      rejected: result.rejected.length,
      train: split.train.length,
      valid: split.valid.length,
      ...usageSummary(result.raw),
      collectedAt: new Date().toISOString(),
    };
    writeJsonlAtomic(path.join(WORK_DIR, 'raw-responses.jsonl'), result.raw);
    writeJsonlAtomic(path.join(WORK_DIR, 'accepted.jsonl'), result.accepted);
    writeJsonlAtomic(path.join(WORK_DIR, 'rejected.jsonl'), result.rejected);
    writeJsonlAtomic(path.join(WORK_DIR, 'train.jsonl'), split.train.map(({ messages }) => ({ messages })));
    writeJsonlAtomic(path.join(WORK_DIR, 'valid.jsonl'), split.valid.map(({ messages }) => ({ messages })));
    writeJsonAtomic(path.join(WORK_DIR, 'summary.json'), summary);
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  throw new Error('Usage: node src/teacherBatch.js prepare|submit|status|collect [--dataset flores|idioms-ko]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
