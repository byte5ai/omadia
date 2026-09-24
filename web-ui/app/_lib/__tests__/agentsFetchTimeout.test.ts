import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OM-96 — the dashboard's own reads must carry the deadline too.
 *
 * `app/page.tsx` awaits `listOperatorAgents()` and `getMcpServerSummary()`
 * alongside the `api.ts` calls, but those two go through `agents.ts`'s OWN
 * `callJson`, which was a separate copy of the helper and passed no `signal`.
 * The root `loading.tsx` and the `api.ts` timeout together were therefore not
 * enough: either of these two could still hang forever and park the RSC
 * payload, which is exactly the symptom OM-96 was filed for.
 *
 * These tests assert on the `RequestInit` the module hands to `fetch`, because
 * that is the contract that broke — a passing `page.tsx` render would not
 * notice a missing signal until an endpoint actually hangs.
 */

const ORIGINAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, 'window');

/** The RSC path is the one WITHOUT a `window`; jsdom supplies one. */
function asServer(): void {
  Object.defineProperty(globalThis, 'window', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Captures the init of every fetch the module under test performs. */
function stubFetch(body: unknown): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => jsonResponse(body));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function initOf(spy: ReturnType<typeof vi.fn>): RequestInit {
  const call = spy.mock.calls[0] as [string, RequestInit];
  return call[1];
}

beforeEach(() => {
  asServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  if (ORIGINAL_WINDOW) {
    Object.defineProperty(globalThis, 'window', ORIGINAL_WINDOW);
  }
});

describe('agents.ts server-side reads (OM-96)', () => {
  it('gives listOperatorAgents a deadline', async () => {
    const spy = stubFetch({ agents: [], fallback_agent_id: null });
    const { listOperatorAgents } = await import('../agents');

    await listOperatorAgents();

    const signal = initOf(spy).signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it('gives getMcpServerSummary a deadline', async () => {
    const spy = stubFetch({ total: 0, connected: 0 });
    const { getMcpServerSummary } = await import('../agents');

    await getMcpServerSummary();

    expect(initOf(spy).signal).toBeInstanceOf(AbortSignal);
  });

  it('leaves mutations unbounded', async () => {
    // Deliberate asymmetry: only the caller knows whether abandoning a
    // half-applied write is safe, so a DELETE keeps its own lifetime. If this
    // ever flips to a signal, it needs to be a decision, not a side effect of
    // touching the shared helper.
    const spy = stubFetch({});
    const { deleteOperatorAgent } = await import('../agents');

    await deleteOperatorAgent('some-slug');

    expect(initOf(spy).signal).toBeUndefined();
  });

  it('leaves browser-side reads unbounded', async () => {
    // They do not gate a navigation, and the timeout exists to protect the RSC
    // render specifically.
    if (ORIGINAL_WINDOW) {
      Object.defineProperty(globalThis, 'window', ORIGINAL_WINDOW);
    }
    const spy = stubFetch({ agents: [], fallback_agent_id: null });
    const { listOperatorAgents } = await import('../agents');

    await listOperatorAgents();

    expect(initOf(spy).signal).toBeUndefined();
  });
});
