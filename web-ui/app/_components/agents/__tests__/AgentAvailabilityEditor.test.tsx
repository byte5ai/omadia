import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { NEW_AGENT_AVAILABILITY, type AgentAvailability } from '../../../_lib/agentAvailability';
import { renderWithIntl } from '../../../_lib/test-utils';
import { AgentAvailabilityEditor } from '../AgentAvailabilityEditor';

/**
 * Spec 2042 — who may reach an agent: everyone, or listed users and roles;
 * every channel or some. A new agent reaches nobody and the editor says so.
 */

function Harness({ onChange }: { onChange: (a: AgentAvailability) => void }): React.ReactElement {
  const [value, setValue] = useState<AgentAvailability>(NEW_AGENT_AVAILABILITY);
  return (
    <AgentAvailabilityEditor
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

describe('AgentAvailabilityEditor', () => {
  it('warns that a new agent reaches nobody until someone is chosen', async () => {
    const onChange = vi.fn();
    renderWithIntl(<Harness onChange={onChange} />);
    expect(screen.getByTestId('availability-nobody')).toBeTruthy();
    await userEvent.click(screen.getByTestId('availability-everyone'));
    expect(onChange).toHaveBeenLastCalledWith({
      everyone: true,
      channels: null,
      principals: [],
    });
    expect(screen.queryByTestId('availability-nobody')).toBeNull();
  });

  it('adds users and roles, refuses anything else', async () => {
    const onChange = vi.fn();
    renderWithIntl(<Harness onChange={onChange} />);
    await userEvent.type(screen.getByTestId('availability-principal-input'), 'marketing');
    await userEvent.click(screen.getByTestId('availability-principal-add'));
    expect(screen.getByTestId('availability-principal-error')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByTestId('availability-principal-input'));
    await userEvent.type(
      screen.getByTestId('availability-principal-input'),
      'role:marketing{Enter}',
    );
    expect(onChange).toHaveBeenLastCalledWith({
      everyone: false,
      channels: null,
      principals: ['role:marketing'],
    });

    await userEvent.click(screen.getByRole('button', { name: 'Remove role:marketing' }));
    expect(onChange).toHaveBeenLastCalledWith({
      everyone: false,
      channels: null,
      principals: [],
    });
  });

  it('restricts to channels and back to every channel', async () => {
    const onChange = vi.fn();
    renderWithIntl(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByTestId('availability-restrict-channels'));
    expect(onChange).toHaveBeenLastCalledWith({
      everyone: false,
      channels: [],
      principals: [],
    });
    await userEvent.type(screen.getByTestId('availability-channels'), 'teams, web, teams');
    expect(onChange).toHaveBeenLastCalledWith({
      everyone: false,
      channels: ['teams', 'web'],
      principals: [],
    });
    await userEvent.click(screen.getByTestId('availability-restrict-channels'));
    expect(onChange).toHaveBeenLastCalledWith({
      everyone: false,
      channels: null,
      principals: [],
    });
  });
});
