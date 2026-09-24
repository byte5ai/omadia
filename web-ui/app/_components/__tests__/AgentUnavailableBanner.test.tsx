import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import { AgentUnavailableBanner } from '../AgentUnavailableBanner';

/**
 * OM-76 (#996) — the banner has two causes.
 *
 * `agent_unavailable`: this session's pinned orchestrator is gone → offer the
 * re-bind + delete actions (the original behaviour).
 *
 * `no_agents_active`: there is NO orchestrator at all. "Re-bind to default"
 * would rebind to the missing thing and 503 again, so the banner must instead
 * link to LLM access and hide the re-bind action.
 */
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

describe('<AgentUnavailableBanner />', () => {
  const noop = (): void => {};

  it('agent_unavailable → offers re-bind and delete', () => {
    renderWithIntl(
      <AgentUnavailableBanner
        sessionId="s1"
        unavailableSlug="myagent"
        reason="agent_unavailable"
        onRecovered={noop}
        onDeleted={noop}
      />,
    );
    expect(screen.getByRole('button', { name: /re-bind to standard/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /delete session/i })).toBeTruthy();
  });

  it('no_agents_active → no re-bind, links to LLM access', () => {
    renderWithIntl(
      <AgentUnavailableBanner
        sessionId="s1"
        unavailableSlug=""
        reason="no_agents_active"
        onRecovered={noop}
        onDeleted={noop}
      />,
    );
    // The dangerous "re-bind to the missing default" action is gone.
    expect(screen.queryByRole('button', { name: /re-bind to standard/i })).toBeNull();
    // The way out is a link to LLM access.
    const link = screen.getByRole('link', { name: /open llm access/i });
    expect(link.getAttribute('href')).toBe('/admin/providers');
    expect(screen.getByText(/no orchestrator is running/i)).toBeTruthy();
  });
});
