import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import { VerifierBlockedNotice } from '../VerifierBlockedNotice';

describe('<VerifierBlockedNotice>', () => {
  it('heads the server notice with a UI-localized status line', () => {
    renderWithIntl(<VerifierBlockedNotice hasAnswerText />);
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Answer withheld by the fact-check');
    // The server's notice is the bubble text; the card does not repeat it.
    expect(screen.queryByText(/Ask the question again/)).toBeNull();
  });

  it('explains on its own when no notice text is on screen, in German too', () => {
    renderWithIntl(<VerifierBlockedNotice hasAnswerText={false} />, { locale: 'de' });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('Antwort von der Faktenprüfung zurückgehalten');
    expect(status.textContent).toContain('Stelle die Frage erneut');
  });
});
