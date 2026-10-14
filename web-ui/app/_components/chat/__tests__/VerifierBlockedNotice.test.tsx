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

  it('names a missing citation as such — never a contradiction', () => {
    renderWithIntl(<VerifierBlockedNotice hasAnswerText={false} cause="citation_missing" />, { locale: 'de' });
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('keine Quellen');
    expect(text).not.toMatch(/Widerspruch/);
  });

  it('names a technical fault and an uncalled tool by what they are', () => {
    const { unmount } = renderWithIntl(<VerifierBlockedNotice hasAnswerText={false} cause="check_failed" />);
    expect(screen.getByRole('status').textContent).toContain('technical fault');
    unmount();
    renderWithIntl(<VerifierBlockedNotice hasAnswerText={false} cause="tool_not_called" />);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain('without the data having been retrieved');
    expect(text).not.toMatch(/contradiction|no access/i);
  });

  it('keeps a real contradiction a contradiction, and falls back for an unknown cause', () => {
    const { unmount } = renderWithIntl(<VerifierBlockedNotice hasAnswerText={false} cause="contradicted" />);
    expect(screen.getByRole('status').textContent).toContain('a contradiction with the source data');
    unmount();
    const several = renderWithIntl(
      <VerifierBlockedNotice hasAnswerText={false} cause="contradicted" contradictionCount={3} />,
      { locale: 'de' },
    );
    expect(screen.getByRole('status').textContent).toContain('3 Widersprüche');
    several.unmount();
    renderWithIntl(<VerifierBlockedNotice hasAnswerText={false} cause="something_new" />);
    expect(screen.getByRole('status').textContent).toContain('could not confirm this answer');
  });
});
