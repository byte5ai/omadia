import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../../_lib/test-utils';
import type { SessionView } from '../graphTypes';
import ListView from '../ListView';

/**
 * Issue #1091 — a turn's `time` is a UTC ISO string. The card used to slice the
 * 'Z' off and print the rest as unmarked wall-clock time, so a Berlin operator
 * read the UTC hour as local. It now goes through next-intl in the operator's
 * zone, and only a value that does not parse is shown as-is.
 */

function viewWithTurnTime(time: unknown): SessionView {
  return {
    session: { id: 'session-1', type: 'Session', props: {} },
    turns: [
      {
        turn: { id: 'turn-1', type: 'Turn', props: { time, userMessage: 'hello' } },
        entities: [],
      },
    ],
  };
}

function renderTurnTime(time: unknown): string {
  renderWithIntl(
    <ListView
      view={viewWithTurnTime(time)}
      runCache={{}}
      onEntityClick={() => undefined}
      onLoadRun={() => undefined}
    />,
    { timeZone: 'Europe/Berlin' },
  );
  const hello = screen.getByText('hello');
  const card = hello.parentElement;
  return card?.querySelector('.font-mono')?.textContent ?? '';
}

describe('ListView — #1091 turn timestamp', () => {
  it("renders the turn time in the operator's zone, not as raw UTC", () => {
    const shown = renderTurnTime('2026-09-23T14:17:47.000Z');
    expect(shown).toContain('4:17:47');
    expect(shown).not.toContain('14:17:47');
  });

  it('shows an unparseable value unchanged rather than "Invalid Date"', () => {
    expect(renderTurnTime('not-a-date')).toBe('not-a-date');
  });
});
