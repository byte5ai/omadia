import { describe, expect, it } from 'vitest';

import { ApiError } from '../../../_lib/api';
import { broadReachRefusalOf } from '../useBroadReachConfirm';

/** #2054 — the 409 of a broad-reach change, as the confirmation dialog reads it. */
describe('broadReachRefusalOf', () => {
  const refusal = (body: Record<string, unknown>) =>
    new ApiError(409, 'PUT failed: 409', JSON.stringify({ error: 'broad_reach_confirmation_required', ...body }));

  it('tells a default-agent designation from a grant', () => {
    expect(broadReachRefusalOf(refusal({ change: 'default_agent', slug: 'mira' }))?.change).toBe('default_agent');
    expect(broadReachRefusalOf(refusal({ change: 'grant', slug: 'mira' }))?.change).toBe('grant');
    expect(broadReachRefusalOf(refusal({ slug: 'mira' }))?.change).toBe('grant');
  });

  it('reads the reach and ignores every other error', () => {
    const r = broadReachRefusalOf(
      refusal({ slug: 'mira', reach: { connected_systems: 2, systems: [{ name: 'Odoo' }, { name: 'Jira' }] } }),
    );
    expect(r).toEqual({ slug: 'mira', change: 'grant', connectedSystems: 2, systems: ['Odoo', 'Jira'] });
    expect(broadReachRefusalOf(new ApiError(409, 'x', JSON.stringify({ error: 'config_validation' })))).toBeNull();
  });
});
