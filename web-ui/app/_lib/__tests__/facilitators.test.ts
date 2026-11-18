import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #2066 — the client-side mirror of the facilitator contract.
 *
 * Pinned here: the bounds match what the kernel validates (a drift would let
 * the editor offer a value the save refuses), both refusals are narrowed from
 * their real wire shape, and the engine status is derived the way the kernel
 * resolves the engine — an errored provider is not an engine, two live ones
 * are ambiguous, and a missing SQL grant is its own state.
 */

const { mockList, mockGrants } = vi.hoisted(() => ({
  mockList: vi.fn(),
  mockGrants: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listStorePlugins: mockList,
  getPluginGrants: mockGrants,
}));

const { ApiError } = await import('../api');
const {
  clampFacilitatorAxes,
  clampFacilitatorAxis,
  facilitatorAxisBound,
  facilitatorAxisDisplayValue,
  issueAxis,
  loadFacilitationEngineStatus,
  parseFacilitatorRefusal,
} = await import('../facilitators');

function plugin(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `Plugin ${id}`,
    install_state: 'installed',
    provides: ['facilitationEngine@1'],
    ...over,
  };
}

function grants(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: 'active', missing: [], ...over };
}

afterEach(() => {
  vi.clearAllMocks();
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

describe('loadFacilitationEngineStatus', () => {
  it('is none when no installed plugin provides the capability', async () => {
    mockList.mockResolvedValue({
      items: [
        plugin('a', { provides: ['memoryStore@1'] }),
        plugin('b', { install_state: 'available' }),
      ],
    });
    await expect(loadFacilitationEngineStatus()).resolves.toEqual({ state: 'none' });
    expect(mockGrants).not.toHaveBeenCalled();
  });

  it('is ready for one live provider with nothing missing', async () => {
    mockList.mockResolvedValue({ items: [plugin('engine')] });
    mockGrants.mockResolvedValue(grants());
    await expect(loadFacilitationEngineStatus()).resolves.toEqual({
      state: 'ready',
      plugin: { id: 'engine', name: 'Plugin engine' },
    });
  });

  it('reports a missing SQL grant as its own state', async () => {
    mockList.mockResolvedValue({ items: [plugin('engine')] });
    mockGrants.mockResolvedValue(
      grants({ state: 'errored', missing: [{ kind: 'sql', ledger: 'facilitation' }] }),
    );
    await expect(loadFacilitationEngineStatus()).resolves.toMatchObject({
      state: 'sql_grant_missing',
    });
  });

  it('reports an errored provider without a grant gap as errored', async () => {
    mockList.mockResolvedValue({ items: [plugin('engine')] });
    mockGrants.mockResolvedValue(grants({ state: 'errored' }));
    await expect(loadFacilitationEngineStatus()).resolves.toMatchObject({
      state: 'errored',
    });
  });

  it('is ambiguous for two live providers and ignores an errored one', async () => {
    mockList.mockResolvedValue({ items: [plugin('a'), plugin('b'), plugin('c')] });
    mockGrants.mockImplementation(async (id: string) =>
      id === 'c' ? grants({ state: 'errored' }) : grants(),
    );
    await expect(loadFacilitationEngineStatus()).resolves.toEqual({
      state: 'ambiguous',
      plugins: [
        { id: 'a', name: 'Plugin a' },
        { id: 'b', name: 'Plugin b' },
      ],
    });
  });
});
