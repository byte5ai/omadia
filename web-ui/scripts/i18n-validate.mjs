#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = resolve(HERE, '..', 'messages');
const REFERENCE_LOCALE = 'en';
const TARGET_LOCALES = ['de'];

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

  for (const locale of TARGET_LOCALES) {
    const target = await loadMessages(locale);
    const targetFlat = flattenKeys(target);
    const targetKeys = new Set(targetFlat.keys());

    errors.push(...diffKeySets(refKeys, targetKeys, locale));
    errors.push(...validateValues(locale, targetFlat));

    // Soft check: identical values likely indicate a missed translation,
    // unless the value is a proper noun, brand name, or pure ICU placeholder.
    for (const [key, refVal] of refFlat) {
      const targetVal = targetFlat.get(key);
      if (typeof targetVal !== 'string' || typeof refVal !== 'string') continue;
      if (targetVal !== refVal) continue;
      // Allow short strings (likely brand/proper noun) and ICU-only payloads.
      const stripped = refVal.replace(/\{[^}]+\}/g, '').trim();
      if (stripped.length <= 3) continue;
      if (/^[A-Z][\w. ·-]*$/.test(stripped) && stripped.length <= 20) continue;
      warnings.push(`${locale}: ${key} → identical to ${REFERENCE_LOCALE} ('${refVal}') — likely untranslated`);
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
