import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ToolSpec } from '../../../../../_lib/builderTypes';
import { ToolList } from '../ToolList';

describe('<ToolList />', () => {
  it('shows the empty state when there are no tools', () => {
    render(<ToolList tools={[]} onPatch={vi.fn()} />);
    expect(
      screen.getByText(/Noch keine Tools definiert/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Erstes Tool hinzufügen/ }),
    ).toBeInTheDocument();
  });

  it('renders one row per tool', () => {
    const tools: ToolSpec[] = [
      { id: 'first_tool', description: 'first description' },
      { id: 'second_tool', description: 'second description' },
    ];
    render(<ToolList tools={tools} onPatch={vi.fn()} />);
    expect(screen.getByText('first_tool')).toBeInTheDocument();
    expect(screen.getByText('second_tool')).toBeInTheDocument();
  });

  it('emits an /tools/- add patch when the add button is clicked', () => {
    const onPatch = vi.fn();
    const tools: ToolSpec[] = [{ id: 'existing', description: 'desc' }];
    render(<ToolList tools={tools} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('button', { name: /Tool hinzufügen/ }));
    expect(onPatch).toHaveBeenCalledTimes(1);
    const firstCall = onPatch.mock.calls[0]?.[0] as Array<{
      op: string;
      path: string;
    }>;
    expect(firstCall[0]?.op).toBe('add');
    expect(firstCall[0]?.path).toBe('/tools/-');
  });

  it('emits a remove patch when the X button is clicked', () => {
    const onPatch = vi.fn();
    const tools: ToolSpec[] = [{ id: 'doomed', description: 'will go away' }];
    render(<ToolList tools={tools} onPatch={onPatch} />);
    fireEvent.click(
      screen.getByRole('button', { name: /Tool doomed entfernen/ }),
    );
    const firstCall = onPatch.mock.calls[0]?.[0] as Array<{
      op: string;
      path: string;
    }>;
    expect(firstCall[0]?.op).toBe('remove');
    expect(firstCall[0]?.path).toBe('/tools/0');
  });

  it('marks rows whose id matches the agent_stuck slotKey', () => {
    const tools: ToolSpec[] = [
      { id: 'foo', description: 'fine' },
      { id: 'broken_tool', description: 'a tool' },
    ];
    render(
      <ToolList
        tools={tools}
        agentStuck={{
          slotKey: 'tool-broken_tool-handler',
          attempts: 3,
          lastReason: 'tsc',
          lastSummary: 'X',
          lastErrorCount: 3,
        }}
        onPatch={vi.fn()}
      />,
    );
    // The badge surfaces a title attribute starting with the German
    // marker phrase. Find any element whose title attribute matches.
    const stuckEl = document.querySelector('[title^="Builder-Agent ist auf"]');
    expect(stuckEl).not.toBeNull();
  });
});
