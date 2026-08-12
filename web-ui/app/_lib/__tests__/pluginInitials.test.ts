import { describe, expect, it } from 'vitest';

import {
  deriveInitials,
  deriveInitialsForSet,
  toneIndex,
} from '../pluginInitials';

describe('deriveInitials (OM-31)', () => {
  it('distinguishes MiniMax from Mistral despite the shared category noun', () => {
    // The old rule (word1[0] + word2[0]) produced "ML" for both.
    const a = deriveInitials('MiniMax LLM Provider');
    const b = deriveInitials('Mistral LLM Provider');
    expect(a).not.toBe(b);
  });

  it('distinguishes "GEO Analyst" from "GitHub Assistent"', () => {
    // Old rule: both "GA".
    expect(deriveInitials('GEO Analyst')).not.toBe(
      deriveInitials('GitHub Assistent'),
    );
  });

  it('uses the first two characters of a single significant word', () => {
    expect(deriveInitials('Mistral')).toBe('MI');
    expect(deriveInitials('Mistral Provider')).toBe('MI');
  });

  it('uses first letters of the first two significant words', () => {
    expect(deriveInitials('Google Workspace')).toBe('GW');
    expect(deriveInitials('Google Workspace Integration')).toBe('GW');
  });

  it('falls back to the raw words when the name is only stop words', () => {
    // "LLM Provider" has no identifying word — two letters still beat none.
    expect(deriveInitials('LLM Provider')).toBe('LP');
  });

  it('returns the fallback for a punctuation-only name', () => {
    expect(deriveInitials('—/…')).toBe('??');
    expect(deriveInitials('')).toBe('??');
  });

  it('is pure and deterministic — same input, same output', () => {
    const name = 'Confluence Integration';
    expect(deriveInitials(name)).toBe(deriveInitials(name));
  });
});

describe('deriveInitialsForSet (OM-31)', () => {
  const NAMES = [
    'MiniMax LLM Provider',
    'Mistral LLM Provider',
    'GEO Analyst',
    'GitHub Assistent',
    'Google Workspace',
    'Google Wave Connector',
    'Confluence Integration',
    'Confluence Agent',
    'Odoo HR Agent',
    'Odoo Accounting Agent',
    'Teams Channel',
    'Telegram Channel',
    'Web Search Plugin',
    'Web Scraper Plugin',
    'Plan Runner',
    'Plan Reviewer',
    'Quality Guard',
    'Quality Gate',
    'SEO Analyst',
    'Slack Connector',
  ];

  it('emits no duplicate across a 20-name list', () => {
    const map = deriveInitialsForSet(NAMES);
    expect(map.size).toBe(NAMES.length);
    const values = [...map.values()];
    expect(new Set(values).size).toBe(values.length);
  });

  it('is order-independent', () => {
    const a = deriveInitialsForSet(NAMES);
    const b = deriveInitialsForSet([...NAMES].reverse());
    for (const name of NAMES) {
      expect(b.get(name)).toBe(a.get(name));
    }
  });

  it('leaves a non-colliding name on its plain 2-char initials', () => {
    const map = deriveInitialsForSet(['Google Workspace', 'Teams Channel']);
    expect(map.get('Google Workspace')).toBe('GW');
    expect(map.get('Teams Channel')).toBe('TE');
  });

  it('tolerates duplicate names in the input', () => {
    const map = deriveInitialsForSet(['Same Name', 'Same Name']);
    expect(map.size).toBe(1);
  });
});

describe('toneIndex', () => {
  it('is deterministic and within range', () => {
    for (const id of ['@omadia/a', 'de.byte5.integration.odoo', '']) {
      const v = toneIndex(id, 4);
      expect(v).toBe(toneIndex(id, 4));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(4);
    }
  });

  it('spreads different ids across more than one bucket', () => {
    const ids = Array.from({ length: 24 }, (_, i) => `plugin-${i}`);
    const buckets = new Set(ids.map((id) => toneIndex(id, 4)));
    expect(buckets.size).toBeGreaterThan(1);
  });
});
