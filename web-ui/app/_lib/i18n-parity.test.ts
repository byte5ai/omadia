import { describe, expect, it } from 'vitest';

import deMessages from '../../messages/de.json';
import enMessages from '../../messages/en.json';

type MessageNode = string | { [key: string]: MessageNode };

function flattenKeys(obj: Record<string, MessageNode>, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      for (const [k, v] of flattenKeys(value, full)) out.set(k, v);
    } else if (typeof value === 'string') {
      out.set(full, value);
    } else {
      throw new Error(`Unexpected value type for key ${full}: ${typeof value}`);
    }
  }
  return out;
}

const FORBIDDEN_HTML = /<\s*(script|iframe|object|embed|link)[\s>]/i;

describe('i18n message parity (en ↔ de)', () => {
  const en = flattenKeys(enMessages as Record<string, MessageNode>);
  const de = flattenKeys(deMessages as Record<string, MessageNode>);

  it('en has the same key set as de', () => {
    const enKeys = [...en.keys()].sort();
    const deKeys = [...de.keys()].sort();
    expect(enKeys).toEqual(deKeys);
  });

  it('every key has a non-empty string value in both locales', () => {
    for (const [key, value] of en) {
      expect(value, `en.${key} is empty`).not.toBe('');
    }
    for (const [key, value] of de) {
      expect(value, `de.${key} is empty`).not.toBe('');
    }
  });

  it('no value contains forbidden HTML (script/iframe/object/embed/link)', () => {
    for (const [key, value] of en) {
      expect(FORBIDDEN_HTML.test(value), `en.${key} contains forbidden HTML`).toBe(false);
    }
    for (const [key, value] of de) {
      expect(FORBIDDEN_HTML.test(value), `de.${key} contains forbidden HTML`).toBe(false);
    }
  });

  it('ICU placeholders ({name}) match across locales for the same key', () => {
    for (const [key, enValue] of en) {
      const deValue = de.get(key);
      if (typeof deValue !== 'string') continue;
      const enPlaceholders = [...enValue.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const dePlaceholders = [...deValue.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(enPlaceholders, `placeholder mismatch on key '${key}'`).toEqual(dePlaceholders);
    }
  });
});
