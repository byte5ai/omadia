import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithIntl } from '../../../_lib/test-utils';
import { WorkaroundBadge } from '../WorkaroundBadge';

describe('WorkaroundBadge', () => {
  it('renders nothing when status is "none"', () => {
    const { container } = renderWithIntl(<WorkaroundBadge status="none" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the active label with the issue number when provided', () => {
    renderWithIntl(<WorkaroundBadge status="active" issueNumber={42} />);
    expect(screen.getByText(/Workaround active \(#42\)/)).toBeTruthy();
  });

  it('renders the update-available label', () => {
    renderWithIntl(
      <WorkaroundBadge status="update-available" issueNumber={7} />,
    );
    expect(screen.getByText(/Update available \(#7\)/)).toBeTruthy();
  });

  it('wraps the badge in an anchor when issueUrl is provided', () => {
    renderWithIntl(
      <WorkaroundBadge
        status="active"
        issueNumber={3}
        issueUrl="https://github.com/byte5ai/omadia/issues/3"
      />,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe(
      'https://github.com/byte5ai/omadia/issues/3',
    );
    expect(link.getAttribute('target')).toBe('_blank');
  });
});
