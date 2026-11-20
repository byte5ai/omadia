/**
 * #2051 (epic #2042, INV-3) — a working mode changes how an agent works, never
 * who answers. The web UI once labelled a selected persona skill "Answering as
 * X"; no user-facing string may say that again, in any locale, and the mode is
 * labelled as a mode ("mode: X" / "Modus: X").
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type MessageNode = string | { [key: string]: MessageNode };

const MESSAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'messages');

/** Phrases that present a working mode as a different speaker. */
const FORBIDDEN = [/answering as/i, /antwortet als/i];

function flatten(obj: Record<string, MessageNode>, prefix = ''): Array<[string, string]> {
  return Object.entries(obj).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [[full, value] as [string, string]] : flatten(value, full);
  });
}

function catalog(file: string): Array<[string, string]> {
  const raw = fs.readFileSync(path.join(MESSAGES_DIR, file), 'utf8');
  return flatten(JSON.parse(raw) as Record<string, MessageNode>);
}

const LOCALE_FILES = fs.readdirSync(MESSAGES_DIR).filter((f) => f.endsWith('.json'));

describe('working-mode copy (#2051)', () => {
  it('finds the locale catalogs', () => {
    expect(LOCALE_FILES).toEqual(expect.arrayContaining(['en.json', 'de.json']));
  });

  for (const file of LOCALE_FILES) {
    it(`${file}: no string presents a mode as a different speaker`, () => {
      const hits = catalog(file).filter(([, text]) => FORBIDDEN.some((re) => re.test(text)));
      expect(hits).toEqual([]);
    });
  }

  it('labels the selected mode as a mode', () => {
    const en = new Map(catalog('en.json'));
    const de = new Map(catalog('de.json'));
    expect(en.get('chat.workingMode.label')).toBe('mode: {name}');
    expect(de.get('chat.workingMode.label')).toBe('Modus: {name}');
  });
});
