import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { PrivacyPosture } from '../../_lib/api';
import { renderWithIntl } from '../../_lib/test-utils';
import {
  FieldClassificationBanner,
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
    expect(banner).toHaveTextContent('3 new fields need clarification');
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
      '1 neues Feld muss geklärt werden',
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
