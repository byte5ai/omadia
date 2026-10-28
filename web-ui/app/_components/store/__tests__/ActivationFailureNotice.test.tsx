import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import de from '../../../../messages/de.json';
import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { ActivationFailureNotice } from '../ActivationFailureNotice';

/**
 * #1456 — what an operator reads when a plugin did not start.
 *
 * The bug: the only reason shown was the plugin API's exception sentence,
 * English in both UI languages and addressed to a plugin author. These tests
 * pin the three properties that fix it: the headline is localized copy keyed on
 * the CODE, the copy says what the operator can do, and the raw sentence is
 * still reachable — as a technical detail, never as the headline.
 */

const RAW =
  "plugin '@omadia/integration-odoo' has no secret 'odoo_api_key' in vault";

void describe('ActivationFailureNotice', () => {
  void it('says what happened and what to do, in German, for a missing secret', () => {
    renderWithIntl(
      <ActivationFailureNotice
        reason={{ code: 'secret_missing', field: 'odoo_api_key' }}
        detail={RAW}
      />,
      { locale: 'de' },
    );

    const copy = de.store.activationError.secret_missing;
    expect(screen.getByText(copy.what)).toBeTruthy();
    expect(screen.getByText(copy.next)).toBeTruthy();
    // The field to fill is named, so the operator knows where to go. Exact
    // text, because the raw sentence below mentions the same key.
    expect(
      screen.getByText(copy.field.replace('{field}', 'odoo_api_key')),
    ).toBeTruthy();
  });

  void it('keeps the raw sentence as a technical detail, not as the message', () => {
    renderWithIntl(
      <ActivationFailureNotice
        reason={{ code: 'secret_missing', field: 'odoo_api_key' }}
        detail={RAW}
      />,
      { locale: 'de' },
    );

    const technical = screen.getByText(new RegExp(RAW.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    expect(technical.textContent).toContain(
      de.store.activationError.technicalDetail.replace(' {raw}', ''),
    );
  });

  void it('tells the operator a plugin defect is not theirs to fix', () => {
    renderWithIntl(
      <ActivationFailureNotice
        reason={{ code: 'capability_not_declared', capability: 'entityRefBus' }}
        detail="plugin called ctx.services.get('entityRefBus') but its manifest does not declare that capability"
      />,
      { locale: 'de' },
    );

    const copy = de.store.activationError.capability_not_declared;
    expect(screen.getByText(copy.what)).toBeTruthy();
    expect(screen.getByText(copy.next)).toBeTruthy();
  });

  void it('names the capabilities an unresolved dependency is waiting for', () => {
    renderWithIntl(
      <ActivationFailureNotice
        reason={{ code: 'dependency_unresolved', requires: ['entityRefBus@1'] }}
        detail="unresolved capability requires: entityRefBus@1"
      />,
      { locale: 'en' },
    );

    const copy = en.store.activationError.dependency_unresolved;
    expect(screen.getByText(copy.what)).toBeTruthy();
    expect(
      screen.getByText(copy.requires.replace('{requires}', 'entityRefBus@1')),
    ).toBeTruthy();
  });

  void it('falls back to localized copy when the middleware sent no reason', () => {
    // A failure recorded by a build without the classification. The operator
    // still gets a localized headline — losing the error was never an option.
    renderWithIntl(<ActivationFailureNotice reason={null} detail={RAW} />, {
      locale: 'de',
    });

    expect(screen.getByText(de.store.activationError.unknown.what)).toBeTruthy();
    expect(screen.getByText(new RegExp('odoo_api_key'))).toBeTruthy();
  });

  void it('renders nothing when there is neither a reason nor a sentence', () => {
    const { container } = renderWithIntl(
      <ActivationFailureNotice reason={null} detail={undefined} />,
      { locale: 'de' },
    );
    expect(container.textContent).toBe('');
  });
});
