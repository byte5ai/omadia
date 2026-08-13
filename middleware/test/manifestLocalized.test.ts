// #602 (OM-17) — the shared normaliser/resolver both manifest projections use
// for the localized setup-text family (label, help, pattern_hint, setup_guide).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeLocalized,
  resolveLocalized,
} from '../src/plugins/manifestLocalized.js';

test('normalizeLocalized reads a bare string as English', () => {
  assert.deepEqual(normalizeLocalized('hello'), { en: 'hello' });
});

test('normalizeLocalized keeps a locale map and drops empty entries', () => {
  assert.deepEqual(normalizeLocalized({ en: 'hi', de: 'hallo', fr: '  ' }), {
    en: 'hi',
    de: 'hallo',
  });
});

test('normalizeLocalized returns undefined for empty / non-text input', () => {
  assert.equal(normalizeLocalized(''), undefined);
  assert.equal(normalizeLocalized('   '), undefined);
  assert.equal(normalizeLocalized({}), undefined);
  assert.equal(normalizeLocalized({ en: '' }), undefined);
  assert.equal(normalizeLocalized(['en', 'de']), undefined);
  assert.equal(normalizeLocalized(42), undefined);
  assert.equal(normalizeLocalized(undefined), undefined);
});

test('resolveLocalized honours the preferred locale first', () => {
  const map = { en: 'English', de: 'Deutsch' };
  assert.equal(resolveLocalized(map, 'de'), 'Deutsch');
  assert.equal(resolveLocalized(map, 'en'), 'English');
});

test('resolveLocalized falls back preferred → en → de → any', () => {
  // Preferred locale absent → English base.
  assert.equal(resolveLocalized({ en: 'E', de: 'D' }, 'fr'), 'E');
  // Preferred + en absent → German (the install validator's German templates
  // rely on this de fallback).
  assert.equal(resolveLocalized({ de: 'D', fr: 'F' }, 'es'), 'D');
  // Neither preferred/en/de → the one remaining locale.
  assert.equal(resolveLocalized({ fr: 'F' }, 'es'), 'F');
});

test('resolveLocalized returns undefined for an absent map', () => {
  assert.equal(resolveLocalized(undefined, 'de'), undefined);
  assert.equal(resolveLocalized({}, 'de'), undefined);
});
