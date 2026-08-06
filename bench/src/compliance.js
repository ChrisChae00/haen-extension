// Instruction-compliance scoring for Haen's structured output.
//
// Haen doesn't emit a translation string, it emits a JSON object with five fields
// (see src/prompts.js). Reference-based metrics can only look at `natural`. Everything
// else the prompt demands - valid JSON, exactly two alternative categories, 1-3
// expressions each, no Hanja in Korean-language fields, no markdown fences - is
// unmeasured by BLEU and is exactly what small models get wrong. These checks need no
// references, cost nothing, and predict user-visible breakage better than any n-gram score.
//
// Every check returns a boolean so it aggregates as a rate. Rates are meaningful at
// n=50, which is why compliance is the one thing reported per content slice.

// CJK Unified Ideographs + Extension A. The prompt's ko template forbids Hanja and
// Chinese characters in Korean-written fields; Qwen-family models leak them regularly.
const HANJA = /[一-鿿㐀-䶿]/;

const REQUIRED_STRING_FIELDS = ['detected_lang', 'target_lang', 'natural', 'nuance'];

/**
 * Which fields the model was told to write in Korean.
 *
 * Only the `ko` prompt template carries the no-Hanja rule, and only for fields written
 * in Korean. `natural`/`literal` hold the *translation*, so their language follows the
 * direction, not the UI language - with uiLanguage=ko and direction=ko_to_en, `natural`
 * is English and Hanja there is a different (non-)issue. Getting this wrong would flag
 * every ko_to_en row.
 */
function koreanWrittenFields(uiLanguage, direction) {
  if (uiLanguage !== 'ko') return [];
  const fields = ['nuance', 'tip'];
  if (direction === 'en_to_ko') fields.push('natural', 'literal');
  return fields;
}

function hasHanja(parsed, uiLanguage, direction) {
  for (const field of koreanWrittenFields(uiLanguage, direction)) {
    if (typeof parsed?.[field] === 'string' && HANJA.test(parsed[field])) return true;
  }
  if (uiLanguage === 'ko' && Array.isArray(parsed?.alternatives)) {
    for (const alt of parsed.alternatives) {
      if (typeof alt?.label === 'string' && HANJA.test(alt.label)) return true;
    }
  }
  return false;
}

const VALID_REGISTERS = new Set(['neutral', 'casual', 'formal', 'contextual']);

/**
 * @param {string} raw     Raw model output, captured even when parsing failed.
 * @param {object|null} parsed  Result of TranslatorAPI parsing, or null if it threw.
 * @param {object} item    Dataset item ({direction, ...}).
 * @param {object} opts    {uiLanguage, salvaged, retries}
 */
export function checkCompliance(raw, parsed, item, { uiLanguage = 'ko', salvaged = false, retries = 0 } = {}) {
  const text = (raw ?? '').trim();
  const alts = Array.isArray(parsed?.alternatives) ? parsed.alternatives : null;

  return {
    // --- output shape ---
    jsonValid: parsed != null,
    empty: text.length === 0,
    // The prompt says "no markdown, no code fences". apiClient strips them anyway
    // (apiClient.js:99), so this never reaches the user - but it's a clean signal of
    // how well a model follows a negative instruction.
    fenced: text.startsWith('```'),
    // Prose before the JSON object. Same story: salvageable, but diagnostic.
    prosePreamble: text.length > 0 && !text.startsWith('{') && !text.startsWith('```'),

    // --- required fields ---
    hasAllRequired: REQUIRED_STRING_FIELDS.every(f => typeof parsed?.[f] === 'string' && parsed[f].length > 0),
    naturalNonEmpty: typeof parsed?.natural === 'string' && parsed.natural.trim().length > 0,
    nuanceNonEmpty: typeof parsed?.nuance === 'string' && parsed.nuance.trim().length > 0,

    // --- alternatives structure ---
    // Prompt demands exactly 2 categories, 1-3 expressions each, register from a fixed set.
    altsPresent: alts != null && alts.length > 0,
    altsExactlyTwo: alts?.length === 2,
    altsSizesValid: alts != null && alts.every(a =>
      Array.isArray(a?.expressions) && a.expressions.length >= 1 && a.expressions.length <= 3),
    altsRegistersValid: alts != null && alts.every(a => VALID_REGISTERS.has(a?.register)),

    // --- language hygiene ---
    hanjaLeak: hasHanja(parsed, uiLanguage, item.direction),

    // --- did the client have to rescue this? ---
    // True when apiClient fell back to parsePartial (apiClient.js:122) - the user saw a
    // translation but lost the alternatives tab. Invisible in quality scores, visible to users.
    salvaged,
    retried: retries > 0,
  };
}

// Booleans where true means "the model did the right thing". Everything else is a
// failure flag and gets inverted when reporting a "compliance rate".
export const POSITIVE_CHECKS = new Set([
  'jsonValid', 'hasAllRequired', 'naturalNonEmpty', 'nuanceNonEmpty',
  'altsPresent', 'altsExactlyTwo', 'altsSizesValid', 'altsRegistersValid',
]);

export const ALL_CHECKS = [
  'jsonValid', 'empty', 'fenced', 'prosePreamble',
  'hasAllRequired', 'naturalNonEmpty', 'nuanceNonEmpty',
  'altsPresent', 'altsExactlyTwo', 'altsSizesValid', 'altsRegistersValid',
  'hanjaLeak', 'salvaged', 'retried',
];
