import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithIntl } from '../../_lib/test-utils';
import type { ToolEvent } from '../../_lib/chatSessions';
import { ToolRow } from '../page';

/**
 * #1008 — a FOREIGN tool call is one the subscription-CLI agent made outside
 * omadia's loopback MCP server, i.e. one of the CLI's own built-ins that got
 * past the OM-81 spawn gate. In the trace it used to look exactly like an
 * omadia tool call. These tests pin that it no longer can, and that a normal
 * omadia call is not decorated with a warning it does not deserve.
 *
 * The warning must not be colour-only: both assertions below match on TEXT,
 * which is what a screen reader and a monochrome screenshot get.
 */

function tool(over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    id: 'call-1',
    name: 'mcp__omadia__manage_routine',
    input: {},
    output: 'done',
    durationMs: 12,
    ...over,
  };
}

describe('ToolRow — foreign tool calls (#1008)', () => {
  it('labels a foreign call and explains it in words, not just colour', () => {
    renderWithIntl(<ToolRow tool={tool({ name: 'Bash', foreign: true })} />);

    expect(screen.getByText('foreign tool')).toBeTruthy();
    // The explanation carries the actionable part: omadia's rules did not apply.
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('did not run through omadia');
  });

  it('shows the German label and explanation under the de locale', () => {
    renderWithIntl(<ToolRow tool={tool({ name: 'Bash', foreign: true })} />, {
      locale: 'de',
    });

    expect(screen.getByText('Fremdes Werkzeug')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('nicht über omadia');
  });

  it('leaves an omadia tool call free of any foreign warning', () => {
    renderWithIntl(<ToolRow tool={tool()} />);

    expect(screen.queryByText('foreign tool')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
