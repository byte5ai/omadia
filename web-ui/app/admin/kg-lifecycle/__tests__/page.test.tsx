import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import de from '../../../../messages/de.json';
import en from '../../../../messages/en.json';
import { renderWithIntl } from '../../../_lib/test-utils';
import KgLifecyclePage from '../page';

describe('/admin/kg-lifecycle copy (#1337)', () => {
  beforeEach(() => {
    // A failed load still renders the three action cards (with an error
    // banner), which is all this test needs.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('labels the run buttons from the catalogue in German', async () => {
    renderWithIntl(<KgLifecyclePage />, { locale: 'de' });

    expect(await screen.findAllByText(de.adminKgLifecycle.actions.runNow)).toHaveLength(3);
    expect(screen.queryByText('Run now')).toBeNull();
  });

  it('opens the intro without the internal project name', () => {
    for (const messages of [en, de]) {
      expect(messages.adminKgLifecycle.intro).not.toMatch(/palaia|phase 4/i);
    }
  });
});
