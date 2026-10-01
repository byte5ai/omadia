import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { VerifierSummary } from '../../../_lib/chatSessions';
import { renderWithIntl } from '../../../_lib/test-utils';
import { VerifierBadge } from '../VerifierBadge';

function summary(overrides: Partial<VerifierSummary> = {}): VerifierSummary {
  return {
    badge: 'verified',
    status: 'approved',
    claimCount: 3,
    contradictionCount: 0,
    unverifiedCount: 0,
    retryCount: 0,
    latencyMs: 40,
    mode: 'enforce',
    ...overrides,
  };
}

const GREEN = 'var(--success)';

describe('<VerifierBadge>', () => {
  it('renders a green chip only for an evidenced verified summary', () => {
    renderWithIntl(<VerifierBadge summary={summary()} />);
    const chip = screen.getByText('Answer verified');
    expect(chip.className).toContain(GREEN);
    expect(chip.getAttribute('data-verifier-state')).toBe('verified');
    expect(chip.getAttribute('title')).toMatch(/3 claims/);
  });

  it('renders a skipped turn as a neutral "not verified" chip with its reason', () => {
    renderWithIntl(
      <VerifierBadge
        summary={summary({ badge: 'unverified', status: 'skipped', reason: 'no_trigger', claimCount: 0 })}
      />,
    );
    const chip = screen.getByText('Not verified');
    expect(chip.className).not.toContain(GREEN);
    expect(chip.getAttribute('data-verifier-state')).toBe('unverified');
    expect(chip.getAttribute('title')).toMatch(/no figures, dates or references/);
  });

  it('renders an unavailable verifier as its own neutral chip, in German too', () => {
    renderWithIntl(
      <VerifierBadge
        summary={summary({ badge: 'unavailable', status: 'unavailable', reason: 'pipeline_error', claimCount: 0 })}
      />,
      { locale: 'de' },
    );
    const chip = screen.getByText('Prüfung nicht verfügbar');
    expect(chip.className).not.toContain(GREEN);
    expect(chip.getAttribute('data-verifier-state')).toBe('unavailable');
  });

  it('renders an answer checked only in part as amber, naming the unchecked claims', () => {
    renderWithIntl(
      <VerifierBadge
        summary={summary({
          badge: 'partial',
          status: 'approved_with_disclaimer',
          unverifiedCount: 1,
          uncheckedCount: 1,
        })}
      />,
    );
    const chip = screen.getByText('Partly verified');
    expect(chip.className).not.toContain(GREEN);
    expect(chip.getAttribute('title')).toMatch(/1 claim .*could not be checked/);
  });

  it('renders a corrected answer with the claims the retry confirmed', () => {
    renderWithIntl(<VerifierBadge summary={summary({ badge: 'corrected', retryCount: 1 })} />);
    const chip = screen.getByText('Answer corrected');
    expect(chip.getAttribute('title')).toMatch(/confirmed all 3 claims/);
  });

  it('renders a retry that left claims unchecked as partly verified, not as corrected', () => {
    renderWithIntl(
      <VerifierBadge
        summary={summary({
          badge: 'corrected',
          status: 'approved_with_disclaimer',
          claimCount: 4,
          unverifiedCount: 3,
          uncheckedCount: 3,
          retryCount: 1,
        })}
      />,
    );
    const chip = screen.getByText('Partly verified');
    expect(chip.getAttribute('data-verifier-state')).toBe('partial');
    expect(chip.getAttribute('title')).toMatch(/3 claims .*could not be checked/);
  });

  it('renders an answer the verifier did not read in full as amber, saying so', () => {
    renderWithIntl(
      <VerifierBadge
        summary={summary({
          badge: 'partial',
          status: 'approved_with_disclaimer',
          claimCount: 2,
          unverifiedCount: 1,
          uncheckedCount: 1,
          uncoveredCount: 1,
        })}
      />,
      { locale: 'de' },
    );
    const chip = screen.getByText('Teilweise geprüft');
    expect(chip.className).not.toContain(GREEN);
    expect(chip.getAttribute('title')).toMatch(/nicht die ganze Antwort geprüft/);
  });

  it('renders a retry that confirmed no claim as "not verified", not as corrected', () => {
    renderWithIntl(
      <VerifierBadge
        summary={summary({
          badge: 'unverified',
          status: 'approved_with_disclaimer',
          claimCount: 2,
          unverifiedCount: 2,
          retryCount: 1,
        })}
      />,
    );
    const chip = screen.getByText('Not verified');
    expect(chip.getAttribute('data-verifier-state')).toBe('unverified');
    expect(chip.getAttribute('title')).toMatch(/could not confirm any/);
  });

  it('does not turn a claim-less "verified" into a green chip', () => {
    renderWithIntl(<VerifierBadge summary={summary({ claimCount: 0 })} />);
    const chip = screen.getByText('Not verified');
    expect(chip.className).not.toContain(GREEN);
  });

  it('renders nothing without a summary', () => {
    const { container } = renderWithIntl(<VerifierBadge summary={undefined} />);
    expect(container.textContent).toBe('');
  });
});
