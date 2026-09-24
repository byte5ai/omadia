import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '../../../../../_lib/test-utils';
import type { QualityConfig } from '../../../../../_lib/builderTypes';
import { AgentBoundariesEditor } from '../AgentBoundariesEditor';

/**
 * #1104 — the "Grenzen" tab must state that its boundaries stack on top of
 * the Quality Guard plugin's install-wide defaults, so an operator does not
 * read this tab as the single source of truth.
 */
describe('<AgentBoundariesEditor />', () => {
  const empty: QualityConfig = { boundaries: { presets: [], custom: [] } };

  it('renders the plugin-stacking note (German copy)', () => {
    renderWithIntl(
      <AgentBoundariesEditor value={empty} onChange={vi.fn()} />,
      { locale: 'de' },
    );
    const note = screen.getByTestId('agent-boundaries-plugin-stack-note');
    expect(note).toBeInTheDocument();
    expect(note.textContent).toContain('Quality-Guard-Plugin');
  });
});
