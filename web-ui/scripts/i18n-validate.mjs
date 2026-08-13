#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = resolve(HERE, '..', 'messages');
const REFERENCE_LOCALE = 'en';
const TARGET_LOCALES = ['de'];
/**
 * Lives beside this script, NOT in `messages/` — `app/_lib/i18n-parity.test.ts`
 * DISCOVERS locales by reading every `messages/*.json`, so a non-locale JSON
 * dropped in there is loaded as a broken language and fails three unrelated
 * parity tests. Found the hard way.
 */
const ALLOWLIST_PATH = resolve(HERE, 'i18n-identical-allowlist.json');

/**
 * Issue #601 — reasons a translated value may legitimately equal the English
 * one. Anything else is an ERROR, which is the whole point: the previous soft
 * warning reported 87 items and exited 0, so nothing ever came of it and the
 * debt was free to grow.
 *
 * The set is closed on purpose. A new reason means a new class of exception,
 * which deserves the conversation a code review gives it.
 */
const ALLOWED_REASONS = new Set([
  'brand',
  'glossary',
  'loanword',
  'placeholder',
  'code',
  'diagnostic',
]);

async function loadIdenticalAllowlist() {
  const raw = await readFile(ALLOWLIST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const keys = parsed?.keys;
  if (keys === null || typeof keys !== 'object' || Array.isArray(keys)) {
    throw new Error(`${ALLOWLIST_PATH}: expected an object under "keys"`);
  }
  return new Map(Object.entries(keys));
}

async function loadMessages(locale) {
  const path = resolve(MESSAGES_DIR, `${locale}.json`);
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

function flattenKeys(obj, prefix = '') {
  const out = new Map();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nested, val] of flattenKeys(value, fullKey)) {
        out.set(nested, val);
      }
    } else {
      out.set(fullKey, value);
    }
  }
  return out;
}

const FORBIDDEN_HTML = /<\s*(script|iframe|object|embed|link)[\s>]/i;

function validateValues(locale, flat) {
  const errors = [];
  for (const [key, value] of flat) {
    if (typeof value !== 'string') {
      errors.push(`${locale}: ${key} → non-string value (${typeof value})`);
      continue;
    }
    if (value.trim() === '') {
      errors.push(`${locale}: ${key} → empty string`);
    }
    if (FORBIDDEN_HTML.test(value)) {
      errors.push(`${locale}: ${key} → contains forbidden HTML (script/iframe/object/embed/link)`);
    }
  }
  return errors;
}

function diffKeySets(refKeys, targetKeys, targetLocale) {
  const errors = [];
  for (const key of refKeys) {
    if (!targetKeys.has(key)) {
      errors.push(`${targetLocale}: missing key '${key}' (present in ${REFERENCE_LOCALE})`);
    }
  }
  for (const key of targetKeys) {
    if (!refKeys.has(key)) {
      errors.push(`${targetLocale}: extra key '${key}' (not in ${REFERENCE_LOCALE} reference)`);
    }
  }
  return errors;
}

async function main() {
  const errors = [];
  const warnings = [];

  const reference = await loadMessages(REFERENCE_LOCALE);
  const refFlat = flattenKeys(reference);
  const refKeys = new Set(refFlat.keys());
  errors.push(...validateValues(REFERENCE_LOCALE, refFlat));

  const identicalAllowlist = await loadIdenticalAllowlist();
  /** locale → flattened messages, kept so the stale-allowlist sweep can look
   *  across every target after the per-locale loop. */
  const allTargets = new Map();

  for (const locale of TARGET_LOCALES) {
    const target = await loadMessages(locale);
    const targetFlat = flattenKeys(target);
    const targetKeys = new Set(targetFlat.keys());
    allTargets.set(locale, targetFlat);

    errors.push(...diffKeySets(refKeys, targetKeys, locale));
    errors.push(...validateValues(locale, targetFlat));

    // #601 — a value identical to the reference is an ERROR unless the key is
    // allowlisted with a reason. This used to be a warning with a heuristic
    // ("short strings are probably brand names"), which had both failure modes
    // at once: it exempted real misses that happened to be short, and it flagged
    // placeholders and code fragments that must NEVER be translated. An explicit
    // list is exact, and it puts every exception in front of a reviewer.
    for (const [key, refVal] of refFlat) {
      const targetVal = targetFlat.get(key);
      if (typeof targetVal !== 'string' || typeof refVal !== 'string') continue;
      if (targetVal !== refVal) continue;
      const stripped = refVal.replace(/\{[^}]+\}/g, '').trim();
      // Two classes are exempt WITHOUT an allowlist entry, unchanged from the
      // original heuristic. Deliberately not tightened here: doing so surfaces
      // ~250 further strings at once (`Dashboard`, `Chat`, `Hub`, `Middleware`
      // — single capitalised nouns that are the same word in German), and
      // classifying those in bulk would mean stamping reason codes nobody read.
      // Narrowing this is the follow-up; making the ALREADY-flagged class fail
      // is what stops the debt growing today.
      if (stripped.length <= 3) continue;
      if (/^[A-Z][\w. ·-]*$/.test(stripped) && stripped.length <= 20) continue;
      const reason = identicalAllowlist.get(key);
      if (reason === undefined) {
        errors.push(
          `${locale}: ${key} → identical to ${REFERENCE_LOCALE} ('${refVal}') — ` +
            `translate it, or add it to scripts/i18n-identical-allowlist.json with a reason ` +
            `(${[...ALLOWED_REASONS].join(' | ')}); see messages/GLOSSARY.md`,
        );
        continue;
      }
      if (!ALLOWED_REASONS.has(reason)) {
        errors.push(
          `identical-allowlist.json: ${key} → unknown reason '${reason}' ` +
            `(expected one of ${[...ALLOWED_REASONS].join(' | ')})`,
        );
      }
    }
  }

  // A stale allowlist is a silent lie: the key was translated (or deleted) and
  // the exception outlived it, so the next identical value inherits a blessing
  // nobody granted. Checked after the locale loop, against the reference keys.
  for (const key of identicalAllowlist.keys()) {
    if (!refKeys.has(key)) {
      errors.push(`identical-allowlist.json: '${key}' is not a key in ${REFERENCE_LOCALE}.json`);
      continue;
    }
    const stillIdentical = TARGET_LOCALES.some((locale) => allTargets.get(locale)?.get(key) === refFlat.get(key));
    if (!stillIdentical) {
      errors.push(
        `identical-allowlist.json: '${key}' is translated now — remove the stale exception`,
      );
    }
  }

  if (warnings.length > 0) {
    console.warn(`i18n-validate: ${warnings.length} warning(s)`);
    for (const w of warnings) console.warn(`  ! ${w}`);
  }

  if (errors.length > 0) {
    console.error(`i18n-validate: ${errors.length} error(s)`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }

  const totalKeys = refKeys.size;
  console.log(`i18n-validate: OK — ${totalKeys} keys, locales: ${[REFERENCE_LOCALE, ...TARGET_LOCALES].join(', ')}`);
}

main().catch((err) => {
  console.error('i18n-validate: crashed:', err);
  process.exit(2);
});
