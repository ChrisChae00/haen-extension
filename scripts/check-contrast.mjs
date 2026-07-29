#!/usr/bin/env node
// Parses styles/tokens.css and verifies the contrast pairs required by
// docs/superpowers/specs/2026-07-28-design-overhaul-design.md section 4.2.
// No dependencies — Node built-ins only.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokensPath = path.join(__dirname, '..', 'styles', 'tokens.css');
const css = readFileSync(tokensPath, 'utf8');

// ---- color parsing -----------------------------------------------------

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]) {
  const [rl, gl, bl] = [r, g, b].map(srgbToLinear);
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255].map(v => v / 255);
}

// Minimal oklch(L% C H) -> sRGB conversion (no alpha support needed here).
function oklchToRgb(l, c, hDeg) {
  const hRad = (hDeg * Math.PI) / 180;
  const a = Math.cos(hRad) * c;
  const b = Math.sin(hRad) * c;

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3;

  let r = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  let bch = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  const toSrgb = (v) => {
    v = Math.max(0, Math.min(1, v));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  };
  return [toSrgb(r), toSrgb(g), toSrgb(bch)];
}

function parseColor(raw) {
  const v = raw.trim();
  if (v.startsWith('#')) return hexToRgb(v);
  const m = v.match(/oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (m) {
    const [, lStr, cStr, hStr] = m;
    return oklchToRgb(parseFloat(lStr) / 100, parseFloat(cStr), parseFloat(hStr));
  }
  if (v === '#ffffff' || v === 'white') return [1, 1, 1];
  throw new Error(`Unrecognized color value: ${raw}`);
}

function contrastRatio(rgbA, rgbB) {
  const lA = relativeLuminance(rgbA);
  const lB = relativeLuminance(rgbB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---- token extraction ---------------------------------------------------

function extractBlock(source, selector) {
  const idx = source.indexOf(selector);
  if (idx === -1) throw new Error(`Selector not found: ${selector}`);
  const start = source.indexOf('{', idx);
  const end = source.indexOf('}', start);
  return source.slice(start + 1, end);
}

function parseTokens(block) {
  const tokens = {};
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m;
  while ((m = re.exec(block))) {
    tokens[m[1]] = m[2].trim();
  }
  return tokens;
}

const rootBlock = extractBlock(css, ':root');
const darkBlock = extractBlock(css, '[data-theme="dark"]');
const light = parseTokens(rootBlock);
const dark = parseTokens(darkBlock);

// ---- contrast requirements (spec 4.2) -----------------------------------

const TEXT_TOKENS = ['--text-primary', '--text-secondary'];
const SURFACE_TOKENS = ['--surface', '--surface-base', '--surface-sunken'];
const SEMANTIC_PAIRS = [
  ['--on-accent', '--fill-accent'],
  ['--on-success', '--fill-success'],
  ['--on-danger', '--fill-danger'],
  ['--on-warning', '--fill-warning'],
];
const SEMANTIC_TEXT_ON_SURFACES = [
  ['--text-accent', [...SURFACE_TOKENS, '--surface-accent']],
  ['--text-success', ['--surface', '--surface-success']],
  ['--text-danger', ['--surface', '--surface-danger']],
  ['--text-warning', ['--surface', '--surface-warning']],
];

const MIN_RATIO = 4.5;

function checkTheme(themeName, tokens) {
  const violations = [];
  const checks = [];

  for (const textTok of TEXT_TOKENS) {
    for (const surfTok of SURFACE_TOKENS) {
      const textVal = tokens[textTok];
      const surfVal = tokens[surfTok];
      if (!textVal || !surfVal) {
        violations.push(`${themeName}: missing token ${textTok} or ${surfTok}`);
        continue;
      }
      const ratio = contrastRatio(parseColor(textVal), parseColor(surfVal));
      checks.push({ pair: `${textTok} on ${surfTok}`, ratio });
      if (ratio < MIN_RATIO) {
        violations.push(`${themeName}: ${textTok} (${textVal}) on ${surfTok} (${surfVal}) = ${ratio.toFixed(2)}:1 (needs ${MIN_RATIO}:1)`);
      }
    }
  }

  for (const [onTok, fillTok] of SEMANTIC_PAIRS) {
    const onVal = tokens[onTok];
    const fillVal = tokens[fillTok];
    if (!onVal || !fillVal) continue; // optional until semantic colors are filled in
    const ratio = contrastRatio(parseColor(onVal), parseColor(fillVal));
    checks.push({ pair: `${onTok} on ${fillTok}`, ratio });
    if (ratio < MIN_RATIO) {
      violations.push(`${themeName}: ${onTok} (${onVal}) on ${fillTok} (${fillVal}) = ${ratio.toFixed(2)}:1 (needs ${MIN_RATIO}:1)`);
    }
  }

  for (const [textTok, surfaces] of SEMANTIC_TEXT_ON_SURFACES) {
    const textVal = tokens[textTok];
    if (!textVal) continue;
    for (const surfTok of surfaces) {
      const surfVal = tokens[surfTok];
      if (!surfVal) continue;
      const ratio = contrastRatio(parseColor(textVal), parseColor(surfVal));
      checks.push({ pair: `${textTok} on ${surfTok}`, ratio });
      if (ratio < MIN_RATIO) {
        violations.push(`${themeName}: ${textTok} (${textVal}) on ${surfTok} (${surfVal}) = ${ratio.toFixed(2)}:1 (needs ${MIN_RATIO}:1)`);
      }
    }
  }

  return { violations, checks };
}

const lightResult = checkTheme('light', light);
const darkResult = checkTheme('dark', dark);

const allViolations = [...lightResult.violations, ...darkResult.violations];

console.log(`Checked ${lightResult.checks.length + darkResult.checks.length} pairs across light + dark themes.\n`);

if (allViolations.length > 0) {
  console.error('Contrast violations (minimum 4.5:1):\n');
  for (const v of allViolations) console.error(`  ✗ ${v}`);
  console.error(`\n${allViolations.length} violation(s) found.`);
  process.exit(1);
} else {
  console.log('All contrast pairs pass 4.5:1.');
}
