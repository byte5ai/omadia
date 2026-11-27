import { renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import {
  AGENT_SLUG_PATTERN,
  TEAMS_BOT_SLUG_PATTERN,
  matchesHtmlPattern,
} from '../../../../_lib/agentSlug';
import { renderWithIntl } from '../../../../_lib/test-utils';
import en from '../../../../../messages/en.json';
import { AgentsDashboard, humanizeApiError } from '../AgentsDashboard';
import { useAgentApiErrorText } from '../useAgentApiErrorText';

/**
 * #1885 — the create form emptied itself before the server answered, the
 * page printed machine codes with the server's English, a 400 lost its field
 * list, and the slug `pattern` never compiled under the browser's `v` flag.
 */

const { mockCreate, mockRefresh } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockRefresh: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }): React.ReactElement => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  listAgentPluginCatalog: vi.fn().mockResolvedValue({ items: [] }),
  listDeletedAgents: vi.fn().mockResolvedValue({ retention_days: 30, agents: [] }),
  createOperatorAgent: mockCreate,
}));

const refusal = (status: number, body: unknown): ApiError =>
  new ApiError(status, `POST /v1/operator/agents failed: ${String(status)}`, JSON.stringify(body));

afterEach(() => {
  vi.clearAllMocks();
});

describe('slug patterns (#1885)', () => {
  it('compile under the v flag and follow the server rules', () => {
    for (const ok of ['a', 'p07-x', 'sales-team-2', 'a'.repeat(64)]) {
      expect(matchesHtmlPattern(AGENT_SLUG_PATTERN, ok), ok).toBe(true);
    }
    for (const bad of ['p07-x-', '-p07', 'Test X', 'a'.repeat(65), '']) {
      expect(matchesHtmlPattern(AGENT_SLUG_PATTERN, bad), bad).toBe(false);
    }
    expect(matchesHtmlPattern(TEAMS_BOT_SLUG_PATTERN, 'bot-')).toBe(true);
    expect(matchesHtmlPattern(TEAMS_BOT_SLUG_PATTERN, 'a'.repeat(64))).toBe(false);
  });
});

describe('error text (#1885)', () => {
  const wrapper = ({ children }: { children: React.ReactNode }): React.ReactElement => (
    <NextIntlClientProvider locale="en" messages={en}>
      {children}
    </NextIntlClientProvider>
  );

  it('names the rejected field instead of "invalid_body (HTTP 400)"', () => {
    const { result } = renderHook(() => useAgentApiErrorText(), { wrapper });
    const text = result.current(
      refusal(400, { error: 'invalid_body', issues: [{ path: 'slug', message: 'String must contain at most 64 character(s)' }] }),
    );
    expect(text).toContain('Slug: lowercase letters, digits and hyphens');
    expect(text).not.toContain('invalid_body');
    expect(text).not.toContain('HTTP');
  });

  it('humanizeApiError keeps the reason and the fields, without code or status', () => {
    const text = humanizeApiError(
      refusal(400, { error: 'invalid_body', issues: [{ path: 'accent_color', message: 'expected a #RRGGBB colour' }] }),
    );
    expect(text).toBe('accent_color: expected a #RRGGBB colour');
    expect(humanizeApiError(refusal(409, { error: 'config_validation', message: 'nope' }))).toBe('nope');
  });
});

describe('create form (#1885)', () => {
  async function submit(slug: string): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup();
    renderWithIntl(<AgentsDashboard initial={{ agents: [], default_agent_id: null }} />);
    const form = screen.getByRole('heading', { name: 'Create agent' }).parentElement!;
    const [slugInput, nameInput] = [...form.querySelectorAll('input')];
    await user.type(slugInput!, slug);
    await user.type(nameInput!, 'Dritter');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    return user;
  }

  it('keeps the input and says the slug is taken', async () => {
    mockCreate.mockRejectedValue(refusal(409, { error: 'slug_taken', slug: 'dritter', message: 'agent slug "dritter" already exists' }));
    await submit('dritter');
    expect(await screen.findByText('An agent with the slug "dritter" already exists. Choose another slug.')).toBeTruthy();
    expect(screen.getByDisplayValue('dritter')).toBeTruthy();
    expect(screen.getByDisplayValue('Dritter')).toBeTruthy();
  });

  it('empties the form once the agent exists', async () => {
    mockCreate.mockResolvedValue({ id: 'x', slug: 'dritter' });
    await submit('dritter');
    await waitFor(() => expect(screen.queryByDisplayValue('Dritter')).toBeNull());
  });
});
