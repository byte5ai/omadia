import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { WorkaroundBadge } from '../WorkaroundBadge';

describe('WorkaroundBadge', () => {
  it('renders nothing when status is "none"', () => {
    const { container } = render(<WorkaroundBadge status="none" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the active label with the issue number when provided', () => {
    render(<WorkaroundBadge status="active" issueNumber={42} />);
    expect(screen.getByText(/Workaround aktiv \(#42\)/)).toBeTruthy();
  });

  it('renders the update-available label', () => {
    render(<WorkaroundBadge status="update-available" issueNumber={7} />);
    expect(screen.getByText(/Update verfügbar \(#7\)/)).toBeTruthy();
  });

  it('wraps the badge in an anchor when issueUrl is provided', () => {
    render(
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
