import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { DirectLineSessionState } from '../../../_lib/chatSessions';
import { renderWithIntl } from '../../../_lib/test-utils';
import { DirectLineStickyBanner } from '../DirectLineStickyBanner';

const ACTIVE: DirectLineSessionState = {
  active: true,
  agentId: 'de.byte5.agent.strategist',
  label: 'Strategist',
  transition: 'entered',
};

const INACTIVE: DirectLineSessionState = { active: false };

describe('#445 DirectLineStickyBanner', () => {
  it('names the bound specialist while a binding is live', () => {
    renderWithIntl(<DirectLineStickyBanner session={ACTIVE} onExit={() => {}} />);
    expect(screen.getByText(/Strategist/)).toBeInTheDocument();
  });

  it('renders nothing when the binding has ended', () => {
    const { container } = renderWithIntl(
      <DirectLineStickyBanner session={INACTIVE} onExit={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when active but unlabelled (never an anonymous banner)', () => {
    const { container } = renderWithIntl(
      <DirectLineStickyBanner session={{ active: true }} onExit={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('exits through the supplied callback', async () => {
    const onExit = vi.fn();
    renderWithIntl(<DirectLineStickyBanner session={ACTIVE} onExit={onExit} />);
    await userEvent.click(screen.getByRole('button'));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('disables the exit control while a turn is in flight', () => {
    renderWithIntl(
      <DirectLineStickyBanner session={ACTIVE} onExit={() => {}} disabled />,
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is announced politely rather than as an alert', () => {
    renderWithIntl(<DirectLineStickyBanner session={ACTIVE} onExit={() => {}} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });
});
