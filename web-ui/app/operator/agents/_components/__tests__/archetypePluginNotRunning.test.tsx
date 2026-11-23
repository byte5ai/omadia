import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../../_lib/api';
import { renderWithIntl } from '../../../../_lib/test-utils';
import { useFacilitatorRefusalMessage } from '../useFacilitatorCopy';

/**
 * #2088 — an agent is not created or enabled while its archetype plugin did
 * not start; the operator reads which plugin and where to look, not the
 * server's English.
 */
function Probe({ error }: { error: unknown }): React.ReactElement {
  const message = useFacilitatorRefusalMessage();
  return <p data-testid="message">{message(error) ?? 'none'}</p>;
}

const refusal = (body: unknown, status = 409): ApiError => new ApiError(status, 'conflict', JSON.stringify(body));

describe('useFacilitatorRefusalMessage: archetype plugin not running', () => {
  it('names the plugin and what to do', () => {
    renderWithIntl(
      <Probe
        error={refusal({
          error: 'archetype_plugin_not_running',
          archetype: 'facilitator',
          plugin_id: '@omadia/agent-facilitator',
          message: "the plugin '@omadia/agent-facilitator' that delivers the archetype 'facilitator' did not start",
        })}
      />,
    );
    const text = screen.getByTestId('message').textContent ?? '';
    expect(text).toContain('The plugin @omadia/agent-facilitator');
    expect(text).toContain('is installed but did not start');
    expect(text).not.toContain('delivers the archetype');
  });

  it('leaves every other error to the other mappings', () => {
    const view = renderWithIntl(<Probe error={refusal({ error: 'config_validation', message: 'x' })} />);
    expect(screen.getByTestId('message').textContent).toBe('none');
    view.unmount();
    renderWithIntl(<Probe error={refusal({ error: 'archetype_plugin_not_running' })} />);
    expect(screen.getByTestId('message').textContent).toBe('none');
  });
});
