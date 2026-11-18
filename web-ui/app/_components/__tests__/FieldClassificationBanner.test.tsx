import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PrivacyPosture } from '../../_lib/api';
import { renderWithIntl } from '../../_lib/test-utils';
import {
  FieldClassificationBanner,
  fieldClassificationBadgeCount,
  fieldClassificationHref,
  fieldsNeedingClarification,
} from '../FieldClassificationBanner';

/**
 * #1556 follow-up — the dashboard / admin notice for masked fields waiting
 * for an admin decision. Informational: no count, no banner.
 */

function posture(over: Partial<PrivacyPosture> = {}): PrivacyPosture {
  return { shield_active: true, force_guarded: false, provider_ids: ['privacy-guard'], ...over };
}

describe('<FieldClassificationBanner />', () => {
  it('renders nothing for an unknown posture, an older backend, or a zero count', () => {
    for (const p of [null, posture(), posture({ fields_needing_clarification: 0 })]) {
      const { container, unmount } = renderWithIntl(<FieldClassificationBanner posture={p} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('shows the pluralized count and links to the needs-clarification tab', () => {
    renderWithIntl(
      <FieldClassificationBanner posture={posture({ fields_needing_clarification: 3 })} />,
    );
    const banner = screen.getByTestId('field-classification-banner');
    expect(banner).toHaveTextContent('3 fields waiting for a decision');
    expect(banner.getAttribute('role')).toBe('status');
    expect(screen.getByRole('link', { name: /review fields/i }).getAttribute('href')).toBe(
      '/admin/privacy-fields?status=needs_clarification',
    );
  });

  it('uses the singular form and German copy', () => {
    renderWithIntl(
      <FieldClassificationBanner posture={posture({ fields_needing_clarification: 1 })} />,
      { locale: 'de' },
    );
    expect(screen.getByTestId('field-classification-banner')).toHaveTextContent(
      '1 Feld wartet auf eine Entscheidung',
    );
  });

  it('counts only finite positive numbers', () => {
    expect(fieldsNeedingClarification(posture({ fields_needing_clarification: -2 }))).toBe(0);
    expect(fieldsNeedingClarification(posture({ fields_needing_clarification: Number.NaN }))).toBe(0);
    expect(fieldsNeedingClarification(posture({ fields_needing_clarification: 4 }))).toBe(4);
  });
});

describe('open suggestions only', () => {
  it('counts them and links to the suggested tab', () => {
    const p = posture({ fields_needing_clarification: 0, fields_suggested_open: 2 });
    expect(fieldsNeedingClarification(p)).toBe(2);
    renderWithIntl(<FieldClassificationBanner posture={p} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/admin/privacy-fields?status=suggested');
  });
});

describe('confirmed fields in conflict', () => {
  it('count toward the banner and link to their tab when nothing else is open', () => {
    const p = posture({ fields_needing_clarification: 2, fields_confirmed_conflict: 2 });
    expect(fieldsNeedingClarification(p)).toBe(2);
    expect(fieldClassificationHref(p)).toBe('/admin/privacy-fields?status=confirmed_conflict');
    renderWithIntl(<FieldClassificationBanner posture={p} />);
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      '/admin/privacy-fields?status=confirmed_conflict',
    );
  });

  it('open clarifications still come first', () => {
    const p = posture({ fields_needing_clarification: 3, fields_confirmed_conflict: 1 });
    expect(fieldClassificationHref(p)).toBe('/admin/privacy-fields?status=needs_clarification');
  });

  it('conflicts come before open suggestions', () => {
    const p = posture({
      fields_needing_clarification: 1,
      fields_confirmed_conflict: 1,
      fields_suggested_open: 4,
    });
    expect(fieldClassificationHref(p)).toBe('/admin/privacy-fields?status=confirmed_conflict');
  });
});

describe('auto-approvals', () => {
  it('shows revoked and new auto-approvals with their own links, without double-counting', () => {
    const p = posture({
      fields_needing_clarification: 3,
      fields_auto_revoked: 2,
      fields_auto_approved_new: 4,
    });
    renderWithIntl(<FieldClassificationBanner posture={p} />);
    const banner = screen.getByTestId('field-classification-banner');
    expect(banner).toHaveTextContent('1 field waiting for a decision');
    expect(screen.getByTestId('field-banner-revoked')).toHaveTextContent(
      '2 auto-approvals revoked — need review',
    );
    expect(screen.getByTestId('field-banner-auto-approved')).toHaveTextContent(
      '4 fields auto-approved since your last visit',
    );
    expect(screen.getByRole('link', { name: /review fields/i })).toHaveAttribute(
      'href',
      '/admin/privacy-fields?status=needs_clarification',
    );
    expect(screen.getByRole('link', { name: /review revoked/i })).toHaveAttribute(
      'href',
      '/admin/privacy-fields?status=auto_revoked',
    );
    expect(screen.getByRole('link', { name: /see auto-approvals/i })).toHaveAttribute(
      'href',
      '/admin/privacy-fields?status=auto_approved',
    );
    // The nav badge: everything to review plus the new auto-approvals.
    expect(fieldClassificationBadgeCount(p)).toBe(7);
  });

  it('shows only the auto-approval line when nothing else is open (German, singular)', () => {
    const p = posture({ fields_needing_clarification: 0, fields_auto_approved_new: 1 });
    renderWithIntl(<FieldClassificationBanner posture={p} />, { locale: 'de' });
    const banner = screen.getByTestId('field-classification-banner');
    expect(banner).toHaveTextContent('1 Feld seit deinem letzten Besuch automatisch freigegeben');
    expect(banner).not.toHaveTextContent('wartet auf eine Entscheidung');
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('a revoked-only posture links the revoked tab, not needs_clarification', () => {
    const p = posture({ fields_needing_clarification: 1, fields_auto_revoked: 1 });
    renderWithIntl(<FieldClassificationBanner posture={p} />, { locale: 'de' });
    expect(screen.getByTestId('field-banner-revoked')).toHaveTextContent(
      '1 automatische Freigabe zurückgenommen — bitte prüfen',
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('link')).toHaveAttribute('href', '/admin/privacy-fields?status=auto_revoked');
    expect(fieldClassificationBadgeCount(p)).toBe(1);
  });
});
