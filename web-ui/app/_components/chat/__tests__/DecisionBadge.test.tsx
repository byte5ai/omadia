import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { decisionBadgeView } from '../../../_lib/decisionBadge';
import { renderWithIntl } from '../../../_lib/test-utils';
import { DecisionBadge } from '../DecisionBadge';

const ANSWERED = {
  provider: 'jev',
  model: 'jev-1.13.0',
  verdict: 'data',
  tool: 'odoo_query',
  confidence: 0.912,
  ms: 14.4,
  direct: true,
  answered: true,
};

describe('decisionBadgeView', () => {
  it('maps a data verdict answered without the agent', () => {
    expect(decisionBadgeView(ANSWERED)).toEqual({
      provider: 'Jev',
      model: 'jev-1.13.0',
      state: 'answered',
      tool: 'odoo_query',
      direct: true,
      confidencePct: 91,
      ms: 14,
    });
  });

  it('a data verdict that fell back to the agent is "data", a model verdict keeps its route', () => {
    expect(decisionBadgeView({ ...ANSWERED, answered: undefined })?.state).toBe('data');
    expect(decisionBadgeView({ provider: 'jev', verdict: 'model', route: 'complex', confidence: 0.8, ms: 9 })).toMatchObject({
      state: 'model',
      route: 'complex',
    });
  });

  it('refuses a malformed value', () => {
    for (const bad of [null, 'jev', {}, { ...ANSWERED, verdict: 'maybe' }, { ...ANSWERED, confidence: 'high' }, { ...ANSWERED, provider: ' ' }]) {
      expect(decisionBadgeView(bad)).toBeNull();
    }
  });
});

describe('<DecisionBadge>', () => {
  it('shows that Jev answered without an LLM, in German', () => {
    renderWithIntl(<DecisionBadge decision={ANSWERED} />, { locale: 'de' });
    expect(screen.getByText('Jev')).toBeTruthy();
    expect(screen.getByText('ohne LLM beantwortet')).toBeTruthy();
    expect(screen.getByText('odoo_query')).toBeTruthy();
    expect(screen.getByText('gelernte Abfrage')).toBeTruthy();
    const root = screen.getByText('Jev').parentElement;
    expect(root?.getAttribute('data-decision-state')).toBe('answered');
    expect(root?.getAttribute('title')).toMatch(/Jev \(jev-1\.13\.0\).*Konfidenz 91 %, 14 ms/);
  });

  it('shows a model verdict with its route', () => {
    renderWithIntl(<DecisionBadge decision={{ provider: 'jev', verdict: 'model', route: 'complex', confidence: 0.8, ms: 9 }} />);
    expect(screen.getByText('model needed')).toBeTruthy();
    expect(screen.getByText('complex')).toBeTruthy();
  });

  it('lists the decision steps on hover, in German, with tools as is', () => {
    renderWithIntl(
      <DecisionBadge
        decision={{
          ...ANSWERED,
          steps: [
            { task: 'fast-path.turn-gate.data', choice: 'yes', confidence: 0.93, ms: 180 },
            { task: 'fast-path.turn-gate.source', choice: 'tool:odoo_query', confidence: 0.9, ms: 180 },
            { task: 'canvas.layout', choice: 'chart_bar', confidence: 0.81, ms: 150 },
            { task: 'x', choice: 'y', confidence: 'bad', ms: 1 },
          ],
        }}
      />,
      { locale: 'de' },
    );
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(tip.textContent).toContain('Was Jev entschieden hat');
    expect(tip.textContent).toContain('Nur Daten');
    expect(tip.textContent).toContain('ja');
    expect(tip.textContent).toContain('Balkendiagramm');
    expect(tip.querySelectorAll('li').length).toBe(3);
  });

  it('renders nothing for a malformed value', () => {
    const { container } = renderWithIntl(<DecisionBadge decision={{ provider: 'jev' }} />);
    expect(container.textContent).toBe('');
  });
});
