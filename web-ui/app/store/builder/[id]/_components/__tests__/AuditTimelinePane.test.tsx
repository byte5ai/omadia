import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../../../../_lib/api';
import { AuditTimelinePane } from '../AuditTimelinePane';

/**
 * Issue #57 — AuditTimelinePane component tests.
 *
 * Coverage:
 *   - Initial fetch on mount → events render with action label + icon
 *   - Mini-diff line surfaces meaningful detail (template, axes count, …)
 *   - Empty state ("Noch keine Änderungen verzeichnet")
 *   - "Mehr laden" pagination → second fetch with offset
 *   - API error renders an alert
 */

describe('<AuditTimelinePane />', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listAuditSpy: any;

  beforeEach(() => {
    listAuditSpy = vi.spyOn(api, 'listBuilderAudit');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeEvent(
    id: number,
    action: string,
    details: Record<string, unknown> = {},
    age = 1000,
  ): api.BuilderAuditEvent {
    return {
      id,
      draftId: 'draft-1',
      userEmail: 'alice@example.com',
      action,
      details,
      createdAt: Date.now() - age,
    };
  }

  it('renders empty-state when listBuilderAudit returns no events', async () => {
    listAuditSpy.mockResolvedValueOnce({
      draftId: 'draft-1',
      total: 0,
      limit: 30,
      offset: 0,
      events: [],
    });
    render(<AuditTimelinePane draftId="draft-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('audit-empty')).toBeInTheDocument();
    });
  });

  it('renders events with action label, icon, and detail summary', async () => {
    listAuditSpy.mockResolvedValueOnce({
      draftId: 'draft-1',
      total: 2,
      limit: 30,
      offset: 0,
      events: [
        makeEvent(1, 'persona_updated', {
          template: 'software-engineer',
          axes: ['directness', 'warmth'],
          hasCustomNotes: true,
        }),
        makeEvent(2, 'quality_updated', {
          sycophancy: 'medium',
          presets: ['no-pii'],
          customCount: 1,
        }),
      ],
    });
    render(<AuditTimelinePane draftId="draft-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('audit-event-1')).toBeInTheDocument();
    });
    const event1 = screen.getByTestId('audit-event-1');
    expect(event1).toHaveTextContent('Persona geändert');
    expect(event1).toHaveTextContent('Template: software-engineer');
    expect(event1).toHaveTextContent('2 Achsen');

    const event2 = screen.getByTestId('audit-event-2');
    expect(event2).toHaveTextContent('Quality');
    expect(event2).toHaveTextContent('medium');
  });

  it('Mehr laden fetches the next page with offset', async () => {
    listAuditSpy
      .mockResolvedValueOnce({
        draftId: 'draft-1',
        total: 4,
        limit: 30,
        offset: 0,
        events: [makeEvent(4, 'spec_patched'), makeEvent(3, 'persona_updated')],
      })
      .mockResolvedValueOnce({
        draftId: 'draft-1',
        total: 4,
        limit: 30,
        offset: 2,
        events: [makeEvent(2, 'slot_filled', { slotKey: 's', bytes: 10, typecheckMs: 1 }), makeEvent(1, 'quality_updated')],
      });
    render(<AuditTimelinePane draftId="draft-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('audit-event-3')).toBeInTheDocument();
    });
    expect(screen.getByTestId('audit-load-more')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('audit-load-more'));

    await waitFor(() => {
      expect(screen.getByTestId('audit-event-1')).toBeInTheDocument();
    });
    expect(listAuditSpy).toHaveBeenCalledTimes(2);
    expect(listAuditSpy.mock.calls[1]![1]).toMatchObject({ limit: 30, offset: 2 });
    // Load-more is hidden once all events are loaded
    expect(screen.queryByTestId('audit-load-more')).not.toBeInTheDocument();
  });

  it('renders an inline alert when the API call fails', async () => {
    listAuditSpy.mockRejectedValueOnce(new Error('boom'));
    render(<AuditTimelinePane draftId="draft-1" />);
    await waitFor(() => {
      expect(screen.getByTestId('audit-error')).toHaveTextContent('boom');
    });
  });
});
