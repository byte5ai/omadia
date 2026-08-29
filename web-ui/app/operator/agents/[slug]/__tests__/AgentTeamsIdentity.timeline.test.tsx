import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../_lib/test-utils';
import type { TeamsIdentityStatusDto } from '../../../../_lib/agents';
import { AgentTeamsIdentity } from '../_components/AgentTeamsIdentity';

/**
 * #915 — the provisioning timeline.
 *
 * WHAT THESE PIN, and why each one is the actual bug rather than a render
 * detail:
 *
 *   - THE PANEL MOVES BETWEEN TWO IDENTICAL POLLS. That is the complaint: the
 *     server has nothing new to say for minutes at a time while an Entra
 *     replication poll or an ARM backoff runs, and a duration that only
 *     advanced on new data would freeze for exactly those minutes. The
 *     elapsed time is asserted to change with the clock alone, with the fetch
 *     mock returning byte-identical JSON throughout.
 *   - RETRIES CARRY THEIR NUMBERS. "Attempt 3 of 5" is the copy an operator
 *     needs during those gaps, and it comes from structured values on the
 *     event — not from parsing a sentence.
 *   - A RUN THAT DIED IN STEP 1 READS DIFFERENTLY FROM ONE THAT NEVER
 *     STARTED. Both leave a row that is not `installed`; only the timeline
 *     tells them apart.
 *   - AN UNKNOWN EVENT COSTS ONE ROW, NOT THE PANEL. A newer middleware
 *     emitting a step this build has never heard of must degrade gracefully.
 */

const { mockGet, mockProvision } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockProvision: vi.fn(),
}));

vi.mock('../../../../_lib/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../_lib/agents')>()),
  getAgentTeamsIdentity: mockGet,
  provisionAgentTeamsIdentity: mockProvision,
}));

const NOW = new Date('2026-08-28T10:05:00.000Z');

function statusDto(
  overrides: Partial<TeamsIdentityStatusDto> = {},
): TeamsIdentityStatusDto {
  return {
    ok: true,
    agent: 'sales-bot',
    state: 'bot_created',
    running: true,
    provisioner_installed: true,
    identity: {
      bot_slug: 'sales-bot',
      display_name: 'Sales Bot',
      app_id: '11111111-2222-3333-4444-555555555555',
      tenant_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      teams_app_id: null,
      teams_app_external_id: null,
      team_id: '19:team-a',
      last_error: null,
      created_at: '2026-08-28T10:00:00.000Z',
      updated_at: '2026-08-28T10:04:00.000Z',
    },
    teams_bot: null,
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1',
    at: '2026-08-28T10:04:00.000Z',
    step: 'app_registered',
    status: 'succeeded',
    attempt: null,
    detail: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockProvision.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentTeamsIdentity — provisioning timeline (#915)', () => {
  it('renders the run log, newest first, with readable step names', async () => {
    mockGet.mockResolvedValue(
      statusDto({
        provisioning_events: [
          event({ id: '3', step: 'bot_created', status: 'started' }),
          event({ id: '2', step: 'app_registered', status: 'succeeded' }),
          event({ id: '1', step: 'run', status: 'started' }),
        ],
      }),
    );

    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const list = await screen.findByTestId('teams-timeline-events');
    const entries = within(list).getAllByRole('listitem');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toHaveTextContent(/bot created started/i);
    expect(entries[1]).toHaveTextContent(/app registered done/i);
    expect(entries[2]).toHaveTextContent(/Run started/i);
  });

  it('marks the open step as active and keeps its duration ticking between polls', async () => {
    // The fetch mock returns the SAME payload every time — exactly the
    // situation the old panel froze in.
    mockGet.mockResolvedValue(
      statusDto({
        provisioning_events: [
          event({
            id: '2',
            step: 'app_registered',
            status: 'started',
            detail: 'awaiting_entra_replication',
          }),
          event({ id: '1', step: 'run', status: 'started' }),
        ],
      }),
    );

    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const activity = await screen.findByTestId('teams-timeline-activity');
    await waitFor(() => {
      expect(activity).toHaveTextContent(/Current step: app registered/i);
    });
    await waitFor(() => {
      expect(activity).toHaveTextContent(/running for/i);
    });
    const firstReading = activity.textContent ?? '';

    // Nothing new from the server — only time passes.
    await vi.advanceTimersByTimeAsync(120_000);

    await waitFor(() => {
      expect(activity.textContent).not.toEqual(firstReading);
    });
  });

  it('names the attempt and the wait while a step is being retried', async () => {
    mockGet.mockResolvedValue(
      statusDto({
        provisioning_events: [
          event({
            id: '3',
            step: 'bot_created',
            status: 'retrying',
            attempt: 3,
            detail: 'retry_in_ms=8000;max_attempts=5',
          }),
          event({ id: '2', step: 'bot_created', status: 'started' }),
          event({ id: '1', step: 'run', status: 'started' }),
        ],
      }),
    );

    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const retry = await screen.findByTestId('teams-timeline-retry');
    expect(retry).toHaveTextContent(/Attempt 3 of 5 failed/i);
    // The countdown needs the ticking clock, which is seeded by an effect —
    // so it lands one commit after the line itself. Asserting it
    // synchronously raced that commit under a loaded full-suite run.
    await waitFor(() => {
      expect(retry).toHaveTextContent(/Next attempt/i);
    });
  });

  it('tells a run that died in its first step apart from one that never started', async () => {
    mockGet.mockResolvedValue(
      statusDto({
        state: 'failed',
        running: false,
        provisioning_events: [
          event({ id: '3', step: 'run', status: 'failed', detail: 'consent_missing' }),
          event({
            id: '2',
            step: 'app_registered',
            status: 'failed',
            detail: 'consent_missing',
          }),
          event({ id: '1', step: 'run', status: 'started' }),
        ],
      }),
    );

    const { unmount } = renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const failed = await screen.findByTestId('teams-timeline-activity');
    expect(failed).toHaveTextContent(/The run has finished/i);
    // The step that died is named, so the operator knows where to look.
    const list = screen.getByTestId('teams-timeline-events');
    expect(list).toHaveTextContent(/app registered stopped/i);
    expect(list).toHaveTextContent(/admin consent is missing/i);
    unmount();

    // A row that never ran carries no events at all — a different sentence,
    // not the same panel with an empty list.
    mockGet.mockResolvedValue(
      statusDto({ state: 'failed', running: false, provisioning_events: [] }),
    );
    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);
    const neverStarted = await screen.findByTestId('teams-timeline-activity');
    expect(neverStarted).toHaveTextContent(/No provisioning run has been started/i);
  });

  it('drops an event this build does not understand instead of the whole timeline', async () => {
    mockGet.mockResolvedValue(
      statusDto({
        provisioning_events: [
          // A step from a newer middleware, and a structurally broken entry.
          event({ id: '3', step: 'quantum_entangled', status: 'started' }),
          { id: '2', at: 'not-a-date', step: 'run', status: 'started' },
          event({ id: '1', step: 'app_registered', status: 'succeeded' }),
        ],
      }),
    );

    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />);

    const list = await screen.findByTestId('teams-timeline-events');
    const entries = within(list).getAllByRole('listitem');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toHaveTextContent(/app registered done/i);
  });

  it('renders the German copy without leaking a raw detail token', async () => {
    mockGet.mockResolvedValue(
      statusDto({
        provisioning_events: [
          event({
            id: '2',
            step: 'app_registered',
            status: 'succeeded',
            detail: 'skipped',
          }),
          event({ id: '1', step: 'run', status: 'started' }),
        ],
      }),
    );

    renderWithIntl(<AgentTeamsIdentity slug="sales-bot" />, { locale: 'de' });

    const list = await screen.findByTestId('teams-timeline-events');
    expect(list).toHaveTextContent(/App registriert erledigt/i);
    expect(list).toHaveTextContent(/war bereits erledigt/i);
    // The machine code itself must never reach the screen as copy.
    expect(list).not.toHaveTextContent(/\bskipped\b/);
  });
});
