import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PrivacyReceipt } from '../../../_lib/chatSessions';
import { renderWithIntl } from '../../../_lib/test-utils';
import {
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
});
