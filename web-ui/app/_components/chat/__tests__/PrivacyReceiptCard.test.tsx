import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PrivacyReceipt } from '../../../_lib/chatSessions';
import { renderWithIntl } from '../../../_lib/test-utils';
import {
  formatMaskedPromptSpans,
  PrivacyReceiptCard,
  summarisePrivacyReceipt,
} from '../PrivacyReceiptCard';

const RANKED: PrivacyReceipt = {
  datasetsInterned: 1,
  fieldsMasked: 1,
  fieldsCleartext: 3,
  verbsExecuted: ['sort', 'top_n'],
  pseudonymProjectionUsed: false,
};

const PLAIN: PrivacyReceipt = {
  datasetsInterned: 1,
  fieldsMasked: 0,
  fieldsCleartext: 2,
  verbsExecuted: [],
  pseudonymProjectionUsed: false,
};

const PSEUDONYM: PrivacyReceipt = {
  datasetsInterned: 2,
  fieldsMasked: 2,
  fieldsCleartext: 5,
  verbsExecuted: ['filter', 'select'],
  pseudonymProjectionUsed: true,
};

/** The requester named an employee — that name reached the model. */
const NAMED: PrivacyReceipt = {
  datasetsInterned: 1,
  fieldsMasked: 1,
  fieldsCleartext: 3,
  verbsExecuted: ['filter'],
  pseudonymProjectionUsed: false,
  identityValuesOnWire: 1,
};

/** #361 — three prompt spans were pseudonymised before the LLM wire. */
const PROMPT_MASKED: PrivacyReceipt = {
  ...RANKED,
  maskedPromptSpans: [
    { type: 'person', detector: 'c1-gliner' },
    { type: 'person', detector: 'c1-gliner' },
    { type: 'email', detector: 'c0-regex' },
  ],
};

/** #547 / #569 — two external MCP tools returned structuredContent this turn.
 *  Accounting only: neutral, never changes the palette. */
const STRUCTURED: PrivacyReceipt = {
  ...RANKED,
  structuredPayloads: [
    { toolName: 'crm_lookup_customer', serverName: 'Kunden-CRM', bytes: 2048, hasOutputSchema: true },
    { toolName: 'weather_now', serverName: 'Wetterdienst', bytes: 512, hasOutputSchema: false },
  ],
};

describe('<PrivacyReceiptCard />', () => {
  it('renders the collapsed summary with dataset + masked-field counts', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={RANKED} />, { locale: 'de' });
    const summary = screen.getByText(/Privacy Shield/);
    expect(summary).toBeInTheDocument();
    expect(summary.textContent).toContain('1 Tool-Ergebnis');
    expect(summary.textContent).toContain('1 Feld maskiert');
  });

  it('lists the v4 facts in the expanded body', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={RANKED} />, { locale: 'de' });
    expect(screen.getByText('Felder maskiert')).toBeInTheDocument();
    expect(screen.getByText('Felder Klartext')).toBeInTheDocument();
    expect(screen.getByText('Verben ausgeführt')).toBeInTheDocument();
    // verbs are joined verbatim into the fact value
    expect(screen.getByText('sort, top_n')).toBeInTheDocument();
  });

  it('shows an em dash for the verb fact when no verb ran', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={PLAIN} />, { locale: 'de' });
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('reports when the gated pseudonym projection was released', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={PSEUDONYM} />, { locale: 'de' });
    expect(screen.getByText('Pseudonym-Projektion')).toBeInTheDocument();
    expect(screen.getByText('verwendet')).toBeInTheDocument();
  });

  it('reports the pseudonym projection as not used by default', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={RANKED} />, { locale: 'de' });
    expect(screen.getByText('nicht verwendet')).toBeInTheDocument();
  });

  it('flags identity values the requester named themselves', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={NAMED} />, { locale: 'de' });
    expect(
      screen.getByText('Namen ans Modell (selbst genannt)'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Privacy Shield/).textContent).toContain(
      'Name ans Modell',
    );
  });

  it('omits the identity-on-wire fact when the user named nobody', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={RANKED} />, { locale: 'de' });
    expect(
      screen.queryByText('Namen ans Modell (selbst genannt)'),
    ).not.toBeInTheDocument();
  });

  it('switches the whole card to red when the user named an identity', () => {
    const { container } = renderWithIntl(
      <PrivacyReceiptCard receipt={NAMED} />,
      { locale: 'de' },
    );
    const root = container.querySelector('details');
    expect(root?.className).toMatch(/danger/);
    expect(root?.className).not.toMatch(/success/);
  });

  it('stays emerald when the user named nobody', () => {
    const { container } = renderWithIntl(
      <PrivacyReceiptCard receipt={RANKED} />,
      { locale: 'de' },
    );
    const root = container.querySelector('details');
    expect(root?.className).toMatch(/success/);
    expect(root?.className).not.toMatch(/danger/);
  });

  it('shows the masked-prompt summary chunk and fact row when spans exist', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={PROMPT_MASKED} />, {
      locale: 'de',
    });
    expect(screen.getByText(/Privacy Shield/).textContent).toContain(
      'Prompt: 3 maskiert',
    );
    expect(
      screen.getByText('Maskierte PII in deiner Nachricht'),
    ).toBeInTheDocument();
    expect(screen.getByText('3 (2 × person, 1 × email)')).toBeInTheDocument();
  });

  it('shows the masked-prompt explainer only when the row is present', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={PROMPT_MASKED} />, {
      locale: 'de',
    });
    expect(screen.getByText(/durch Pseudonyme ersetzt/)).toBeInTheDocument();
  });

  it('renders an unknown open-set span type as plain text', () => {
    const receipt: PrivacyReceipt = {
      ...RANKED,
      maskedPromptSpans: [{ type: 'idnum', detector: 'c1-gliner' }],
    };
    renderWithIntl(<PrivacyReceiptCard receipt={receipt} />, { locale: 'de' });
    expect(screen.getByText('1 (1 × idnum)')).toBeInTheDocument();
  });

  it('renders byte-identically to today when maskedPromptSpans is absent', () => {
    const { container } = renderWithIntl(
      <PrivacyReceiptCard receipt={RANKED} />,
      { locale: 'de' },
    );
    expect(
      screen.queryByText('Maskierte PII in deiner Nachricht'),
    ).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('Prompt:');
    expect(container.textContent).not.toContain('Pseudonyme ersetzt');
  });

  it('treats an empty maskedPromptSpans array as absent', () => {
    const receipt: PrivacyReceipt = { ...RANKED, maskedPromptSpans: [] };
    renderWithIntl(<PrivacyReceiptCard receipt={receipt} />, { locale: 'de' });
    expect(
      screen.queryByText('Maskierte PII in deiner Nachricht'),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Privacy Shield/).textContent).not.toContain(
      'Prompt:',
    );
  });

  it('lists structured-output tools with server + schema token (#547/#569)', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={STRUCTURED} />, { locale: 'de' });
    expect(screen.getByText('Strukturierte Ausgabe empfangen')).toBeInTheDocument();
    expect(screen.getByText('crm_lookup_customer')).toBeInTheDocument();
    expect(screen.getByText('Kunden-CRM')).toBeInTheDocument();
    // Lume §8 — the schema state is a text token, not colour alone.
    expect(screen.getByText('Output-Schema')).toBeInTheDocument();
    expect(screen.getByText('kein Schema')).toBeInTheDocument();
    // 2048 B -> 2.0 KB.
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('shows the structured summary chunk when payloads exist', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={STRUCTURED} />, { locale: 'de' });
    expect(screen.getByText(/Privacy Shield/).textContent).toContain(
      '2 strukturierte Ergebnisse',
    );
  });

  it('stays emerald for structured output — accounting is neutral, not a warning', () => {
    const { container } = renderWithIntl(
      <PrivacyReceiptCard receipt={STRUCTURED} />,
      { locale: 'de' },
    );
    const root = container.querySelector('details');
    expect(root?.className).toMatch(/success/);
    expect(root?.className).not.toMatch(/danger/);
    expect(root?.className).not.toMatch(/warning/);
  });

  it('omits the structured section when no tool returned structured output', () => {
    renderWithIntl(<PrivacyReceiptCard receipt={RANKED} />, { locale: 'de' });
    expect(
      screen.queryByText('Strukturierte Ausgabe empfangen'),
    ).not.toBeInTheDocument();
  });

  it('treats an empty structuredPayloads array as absent', () => {
    const receipt: PrivacyReceipt = { ...RANKED, structuredPayloads: [] };
    renderWithIntl(<PrivacyReceiptCard receipt={receipt} />, { locale: 'de' });
    expect(
      screen.queryByText('Strukturierte Ausgabe empfangen'),
    ).not.toBeInTheDocument();
  });

  it('never leaks a PII-shaped value — the receipt carries only counts', () => {
    // The v4 receipt is PII-free by construction: counts and verb names
    // only. This pins the contract — if the schema ever regains a value
    // field, this test fails before it ships.
    const { container } = renderWithIntl(
      <PrivacyReceiptCard receipt={PSEUDONYM} />,
      { locale: 'de' },
    );
    expect(container.textContent).not.toMatch(/@/);
    expect(container.textContent).not.toMatch(/DE\d{20}/);
  });
});

describe('summarisePrivacyReceipt()', () => {
  // Fake translator: echoes the key, appending the count when one is passed.
  const t = (k: string, v?: Record<string, string | number>): string =>
    v && 'count' in v ? `${k}:${String(v.count)}` : k;

  it('always reports the interned dataset count', () => {
    expect(summarisePrivacyReceipt(PLAIN, t)).toBe('summaryDatasets:1');
  });

  it('adds masked fields, verbs, and pseudonyms when present', () => {
    expect(summarisePrivacyReceipt(PSEUDONYM, t)).toBe(
      'summaryDatasets:2 · summaryMasked:2 · summaryVerbs:2 · summaryPseudonyms',
    );
  });

  it('omits the masked-fields clause when nothing was masked', () => {
    expect(summarisePrivacyReceipt(PLAIN, t)).not.toContain('summaryMasked');
  });

  it('adds the identity-on-wire clause when the user named an identity', () => {
    expect(summarisePrivacyReceipt(NAMED, t)).toContain(
      'summaryIdentityOnWire:1',
    );
  });

  it('omits the identity-on-wire clause when the user named nobody', () => {
    expect(summarisePrivacyReceipt(RANKED, t)).not.toContain(
      'summaryIdentityOnWire',
    );
  });

  it('adds the masked-prompt clause when prompt spans exist', () => {
    expect(summarisePrivacyReceipt(PROMPT_MASKED, t)).toContain(
      'summaryPromptMasked:3',
    );
  });

  it('omits the masked-prompt clause when the field is absent or empty', () => {
    expect(summarisePrivacyReceipt(RANKED, t)).not.toContain(
      'summaryPromptMasked',
    );
    expect(
      summarisePrivacyReceipt({ ...RANKED, maskedPromptSpans: [] }, t),
    ).not.toContain('summaryPromptMasked');
  });

  it('adds the structured clause when payloads exist (#547/#569)', () => {
    expect(summarisePrivacyReceipt(STRUCTURED, t)).toContain(
      'summaryStructured:2',
    );
  });

  it('omits the structured clause when the field is absent or empty', () => {
    expect(summarisePrivacyReceipt(RANKED, t)).not.toContain(
      'summaryStructured',
    );
    expect(
      summarisePrivacyReceipt({ ...RANKED, structuredPayloads: [] }, t),
    ).not.toContain('summaryStructured');
  });
});

describe('formatMaskedPromptSpans()', () => {
  it('groups spans by type in first-seen order', () => {
    expect(formatMaskedPromptSpans(PROMPT_MASKED.maskedPromptSpans ?? [])).toBe(
      '3 (2 × person, 1 × email)',
    );
  });

  it('renders unknown open-set types verbatim', () => {
    expect(
      formatMaskedPromptSpans([{ type: 'idnum', detector: 'c1-gliner' }]),
    ).toBe('1 (1 × idnum)');
  });

  it('never includes detector ids in the rendered value', () => {
    const value = formatMaskedPromptSpans(
      PROMPT_MASKED.maskedPromptSpans ?? [],
    );
    expect(value).not.toContain('c1-gliner');
    expect(value).not.toContain('c0-regex');
  });
});
