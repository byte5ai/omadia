import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #2066 — the client-side mirror of the facilitator contract.
 *
 * Pinned here: the bounds match what the kernel validates (a drift would let
 * the editor offer a value the save refuses), both refusals are narrowed from
 * their real wire shape, and the engine status is read from the kernel route
 * without ever turning an unreadable answer into "no engine installed".
 */

const { ApiError } = await import('../api');
const {
  clampFacilitatorAxes,
  clampFacilitatorAxis,
  facilitatorAxisBound,
  facilitatorAxisDisplayValue,
  issueAxis,
  loadFacilitationEngineStatus,
  parseFacilitationEngineStatus,
  parseFacilitatorRefusal,
} = await import('../facilitators');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('facilitator persona bounds', () => {
  it('mirrors the kernel bounds', () => {
    expect(facilitatorAxisBound('sarcasm')).toEqual({ min: 0, max: 20 });
    expect(facilitatorAxisBound('drama')).toEqual({ min: 0, max: 30 });
    expect(facilitatorAxisBound('humor')).toEqual({ min: 0, max: 60 });
    expect(facilitatorAxisBound('risk_tolerance')).toEqual({ min: 0, max: 60 });
    expect(facilitatorAxisBound('warmth')).toEqual({ min: 30, max: 100 });
    expect(facilitatorAxisBound('directness')).toBeNull();
  });

  it('clamps set axes and leaves unset ones unset', () => {
    expect(clampFacilitatorAxis('sarcasm', 80)).toBe(20);
    expect(clampFacilitatorAxis('warmth', 5)).toBe(30);
    expect(clampFacilitatorAxis('directness', 95)).toBe(95);
    expect(clampFacilitatorAxes({ sarcasm: 90, warmth: 10, directness: 70 })).toEqual({
      sarcasm: 20,
      warmth: 30,
      directness: 70,
    });
  });

  it('shows an unset axis as neutral pulled into its bound', () => {
    expect(facilitatorAxisDisplayValue('sarcasm', undefined)).toBe(20);
    expect(facilitatorAxisDisplayValue('directness', undefined)).toBe(50);
  });
});

describe('parseFacilitatorRefusal', () => {
  it('narrows a 409 facilitator_omission', () => {
    const err = new ApiError(
      409,
      'PUT failed: 409',
      JSON.stringify({
        error: 'facilitator_omission',
        omission: 'plugin_grant',
        message: 'agent "mod" is a facilitator: …',
        refused_plugins: ['de.byte5.odoo'],
      }),
    );
    expect(parseFacilitatorRefusal(err)).toEqual({
      kind: 'omission',
      omission: 'plugin_grant',
      refusedPlugins: ['de.byte5.odoo'],
    });
  });

  it('keeps an omission this client does not know as null', () => {
    const err = new ApiError(
      409,
      'x',
      JSON.stringify({ error: 'facilitator_omission', omission: 'something_new' }),
    );
    expect(parseFacilitatorRefusal(err)).toEqual({
      kind: 'omission',
      omission: null,
      refusedPlugins: [],
    });
  });

  it('narrows a 422 facilitator_contract_violation with its issues', () => {
    const err = new ApiError(
      422,
      'PUT failed: 422',
      JSON.stringify({
        error: 'facilitator_contract_violation',
        message: 'facilitator identity rejected: …',
        issues: [
          { path: 'persona.axes.sarcasm', rule: 'persona_axis_above_bound', message: 'm' },
          { path: 'instructions', rule: 'partiality', message: 'm', excerpt: 'favour sales' },
          'garbage',
        ],
      }),
    );
    const refusal = parseFacilitatorRefusal(err);
    expect(refusal?.kind).toBe('contract');
    expect(refusal?.kind === 'contract' ? refusal.issues : []).toEqual([
      { path: 'persona.axes.sarcasm', rule: 'persona_axis_above_bound', message: 'm' },
      { path: 'instructions', rule: 'partiality', message: 'm', excerpt: 'favour sales' },
    ]);
  });

  it('is null for other errors and for a non-JSON body', () => {
    expect(parseFacilitatorRefusal(new Error('boom'))).toBeNull();
    expect(parseFacilitatorRefusal(new ApiError(502, 'x', '<html>'))).toBeNull();
    expect(
      parseFacilitatorRefusal(new ApiError(409, 'x', JSON.stringify({ error: 'not_found' }))),
    ).toBeNull();
  });

  it('maps an issue path to its axis', () => {
    expect(issueAxis('persona.axes.warmth')).toBe('warmth');
    expect(issueAxis('persona.axes.nope')).toBeNull();
    expect(issueAxis('instructions')).toBeNull();
  });
});

describe('facilitation engine status', () => {
  const base = { capability: 'facilitationEngine@1', version: null };

  it('narrows the three kernel states', () => {
    expect(
      parseFacilitationEngineStatus({ ...base, state: 'none', plugin_id: null, plugin_ids: [] }),
    ).toEqual({ state: 'none' });
    expect(
      parseFacilitationEngineStatus({
        ...base,
        state: 'ambiguous',
        plugin_id: null,
        plugin_ids: ['a', 'b'],
      }),
    ).toEqual({ state: 'ambiguous', pluginIds: ['a', 'b'] });
    expect(
      parseFacilitationEngineStatus({
        ...base,
        state: 'bound',
        plugin_id: 'engine',
        plugin_ids: ['engine'],
        available: true,
        unavailable_reason: null,
      }),
    ).toEqual({ state: 'ready', pluginId: 'engine' });
  });

  it('reads bound-but-unavailable with the engine reason as detail', () => {
    expect(
      parseFacilitationEngineStatus({
        ...base,
        state: 'bound',
        plugin_id: 'engine',
        plugin_ids: ['engine'],
        available: false,
        unavailable_reason: 'no SQL grant',
      }),
    ).toEqual({ state: 'unavailable', pluginId: 'engine', reason: 'no SQL grant' });
  });

  it('is null for a body that is not the documented shape', () => {
    expect(parseFacilitationEngineStatus(null)).toBeNull();
    expect(parseFacilitationEngineStatus({ state: 'bound' })).toBeNull();
    expect(parseFacilitationEngineStatus({ error: 'not_found' })).toBeNull();
  });

  it('loads through the same-origin proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...base, state: 'none', plugin_ids: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadFacilitationEngineStatus()).resolves.toEqual({ state: 'none' });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/bot-api/v1/operator/agents/facilitation-engine',
    );
  });

  it('rejects instead of guessing when the route fails or is unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"not_found"}', { status: 404 })),
    );
    await expect(loadFacilitationEngineStatus()).rejects.toBeInstanceOf(ApiError);
    // An older middleware routes the path to `/:slug` and answers 200 with
    // something else entirely.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"agent":"x"}', { status: 200 })),
    );
    await expect(loadFacilitationEngineStatus()).rejects.toBeInstanceOf(ApiError);
  });
});
