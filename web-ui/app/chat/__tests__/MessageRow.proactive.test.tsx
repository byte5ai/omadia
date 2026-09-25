import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import type { Message } from '../../_lib/chatSessions';
import { MessageRow } from '../page';

/**
 * #1071 — a scheduled routine created from the web chat delivers its output
 * into that chat as an assistant message the server wrote. It must not read
 * as the answer to the user's last question, so it carries a badge, and it
 * has no turn duration to show.
 */

const NOOP = (): void => {};

function row(message: Message, locale: 'en' | 'de' = 'en'): void {
  renderWithIntl(
    <MessageRow
      message={message}
      disabled={false}
      onChoose={NOOP}
      onDiscardAutoPromoted={NOOP}
    />,
    { locale },
  );
}

function delivery(proactive: Message['proactive']): Message {
  return {
    id: 'proactive-r1-1',
    role: 'assistant',
    content: 'Tagesreport',
    startedAt: 1_800_000_000_000,
    finishedAt: 1_800_000_000_000,
    ...(proactive ? { proactive } : {}),
  };
}

describe('MessageRow proactive routine delivery (#1071)', () => {
  it('badges the delivery with the routine name (en)', () => {
    row(delivery({ deliveredAt: 1, routineId: 'r1', routineName: 'Daily report' }));
    expect(screen.getByText('Scheduled routine · Daily report')).toBeTruthy();
  });

  it('badges the delivery with the routine name (de)', () => {
    row(delivery({ deliveredAt: 1, routineId: 'r1', routineName: 'Daily report' }), 'de');
    expect(screen.getByText('Geplante Routine · Daily report')).toBeTruthy();
  });

  it('falls back to a generic badge without a routine name', () => {
    row(delivery({ deliveredAt: 1 }));
    expect(screen.getByText('Scheduled message')).toBeTruthy();
  });

  it('hides the elapsed readout on a delivery', () => {
    row(delivery({ deliveredAt: 1, routineName: 'Daily report' }));
    expect(screen.queryByText(/⏱/)).toBeNull();
  });

  it('shows no badge on an ordinary answer', () => {
    row(delivery(undefined));
    expect(screen.queryByText(/Scheduled/)).toBeNull();
    expect(screen.getByText(/⏱/)).toBeTruthy();
  });
});
