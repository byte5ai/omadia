import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import { StateBadge } from '../StateBadge';

describe('StateBadge awaiting_llm', () => {
  it('renders the awaiting-llm copy for installed plugins', () => {
    renderWithIntl(
      <StateBadge
        state="installed"
        readiness={{
          state: 'awaiting_llm',
          missing_fields: [],
          verified_at: null,
        }}
      />,
    );

    expect(screen.getByText(en.store.stateBadge.awaitingLlm)).toBeTruthy();
    expect(screen.queryByText(en.store.stateBadge.installed)).toBeNull();
    expect(screen.queryByText(en.store.stateBadge.configRequired)).toBeNull();
  });

  it('keeps the plain available badge when the plugin is not present', () => {
    renderWithIntl(
      <StateBadge
        state="available"
        readiness={{
          state: 'awaiting_llm',
          missing_fields: [],
          verified_at: null,
        }}
      />,
    );

    expect(screen.getByText(en.store.stateBadge.available)).toBeTruthy();
    expect(screen.queryByText(en.store.stateBadge.awaitingLlm)).toBeNull();
  });

  it('still renders config_required with its own label', () => {
    renderWithIntl(
      <StateBadge
        state="installed"
        readiness={{
          state: 'config_required',
          missing_fields: ['api_key'],
          verified_at: null,
        }}
      />,
    );

    expect(screen.getByText(en.store.stateBadge.configRequired)).toBeTruthy();
    expect(screen.queryByText(en.store.stateBadge.awaitingLlm)).toBeNull();
  });
});
