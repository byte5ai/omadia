import { describe, expect, it } from 'vitest';

import {
  axesForTemplate,
  getPersonaTemplate,
  type PersonaTemplate,
} from '../personaTemplates';

/**
 * Switching archetypes (#1897, #1791): a template supplies the axes; only the
 * sliders the operator moved away from the previous baseline survive the
 * switch. The baseline is the previous template's profile, or neutral (50)
 * when no template was set.
 */

function template(id: string): PersonaTemplate {
  const tpl = getPersonaTemplate(id);
  if (!tpl) throw new Error(`fixture template ${id} missing`);
  return tpl;
}

describe('axesForTemplate', () => {
  it('applies the full profile to a persona without axes', () => {
    expect(axesForTemplate(undefined, template('sales-dev'))).toEqual(
      template('sales-dev').axes,
    );
  });

  it('replaces every axis when switching from one untouched template to another', () => {
    const salesDev = template('sales-dev');
    const engineer = template('software-engineer');

    expect(
      axesForTemplate(
        { template: salesDev.id, axes: { ...salesDev.axes } },
        engineer,
      ),
    ).toEqual(engineer.axes);
  });

  it('keeps a slider the operator moved away from the previous template', () => {
    const salesDev = template('sales-dev');
    const engineer = template('software-engineer');

    const next = axesForTemplate(
      { template: salesDev.id, axes: { ...salesDev.axes, humor: 95 } },
      engineer,
    );

    expect(next).toEqual({ ...engineer.axes, humor: 95 });
  });

  it('keeps an axis tuned away from neutral when no template was set', () => {
    const service = template('customer-service');

    const next = axesForTemplate(
      { axes: { directness: 90, warmth: 50 } },
      service,
    );

    expect(next).toEqual({ ...service.axes, directness: 90 });
  });
});
