import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { RecalledContextCard } from '../RecalledContextCard';

/**
 * Issue #1839 — each recalled insight started with the raw kind ("reference:")
 * in both languages. A known kind now reads as its catalog label; an unknown
 * one stays raw instead of showing a key path.
 */

function card(kind: string): React.ReactElement {
  return (
    <RecalledContextCard
      recalled={{
        plans: [],
        processes: [],
        insights: [{ mkId: 'mk:1', kind, summary: 'Use the staging DB', score: 0.9 }],
      }}
    />
  );
}

describe('RecalledContextCard insight kind (#1839)', () => {
  it('translates a known kind', () => {
    renderWithIntl(card('reference'), { locale: 'de' });
    expect(screen.getByText('Referenz:')).toBeInTheDocument();
  });

  it('keeps an unknown kind raw', () => {
    renderWithIntl(card('future_kind'), { locale: 'de' });
    expect(screen.getByText('future_kind:')).toBeInTheDocument();
  });
});
