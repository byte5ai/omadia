import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSkillDto } from '../../../_lib/adminSkills';
import { renderWithIntl } from '../../../_lib/test-utils';
import AdminSkillsPage from '../page';

/**
 * #2320 — Admin → Skills lists `GET /v1/admin/skills` and promotes through
 * `POST /v1/admin/skills/:id/promote` with the body the route validates.
 * Only `promotable` rows get the form.
 */

const fetchMock = vi.fn();

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const published: AdminSkillDto = {
  id: 'skill-1',
  slug: 'weekly-report',
  name: 'Weekly report',
  owner_scope: 'personal:alice',
  lifecycle_status: 'published',
  manifest_signed_at: '2026-11-20T08:00:00.000Z',
  updated_at: '2026-11-20T08:00:00.000Z',
  required_capabilities: ['tool:send_email'],
  promotable: true,
};

const draft: AdminSkillDto = {
  ...published,
  id: 'skill-2',
  slug: 'draft-skill',
  name: 'Draft skill',
  owner_scope: null,
  lifecycle_status: 'draft',
  manifest_signed_at: null,
  required_capabilities: [],
  promotable: false,
};

beforeEach(() => {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? respond({ id: 'skill-1' }) : respond({ skills: [published, draft] }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('<AdminSkillsPage />', () => {
  it('lists skills with status and offers promotion only where allowed', async () => {
    renderWithIntl(<AdminSkillsPage />);
    expect(await screen.findByText('Weekly report')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Needs an owner first')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Promote' })).toHaveLength(1);
  });

  it('posts the org target the route expects', async () => {
    renderWithIntl(<AdminSkillsPage />);
    fireEvent.change(await screen.findByLabelText('Promote to'), { target: { value: 'org' } });
    fireEvent.change(screen.getByLabelText('Organisation id'), { target: { value: 'byte5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
      expect(post).toBeDefined();
      expect(new URL(post?.[0] as string, 'http://localhost').pathname).toBe('/bot-api/v1/admin/skills/skill-1/promote');
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
        targetScope: { kind: 'org', orgId: 'byte5' },
      });
    });
  });

  it('maps a not-eligible refusal to catalog copy', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? respond({ code: 'skill_promotion.not_eligible', message: 'raw' }, 409)
        : respond({ skills: [published] }),
    );
    renderWithIntl(<AdminSkillsPage />);
    fireEvent.change(await screen.findByLabelText('Team id'), { target: { value: 'sales' } });
    fireEvent.click(screen.getByRole('button', { name: 'Promote' }));
    expect(
      await screen.findByText('This skill is not published or has no owner, so it cannot be promoted.'),
    ).toBeInTheDocument();
  });
});
