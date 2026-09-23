import { describe, expect, it } from 'vitest';

import { ApiError } from '../api';
import {
  classifyProbeResponse,
  classifyRuntimeRejection,
  runtimeStateOf,
} from '../runtimeReadiness';

/**
 * #1088 — the dashboard reported "Die Agent-Runtime läuft." while the
 * middleware container was stopped.
 *
 * The old signal was a boolean derived by EXCLUSION of one error shape
 * (`ApiError(503)`), so every other failure — a transport error, a proxy 5xx,
 * an abort — read as "runtime up". These tests pin the replacement: a state is
 * `'up'` only when the operator route actually ANSWERED.
 */

const UNAVAILABLE_BODY = JSON.stringify({
  error: 'multi_orchestrator_unavailable',
  message: 'orchestratorRegistry@1 is not published',
});

describe('classifyRuntimeRejection', () => {
  it('reads the structured 503 as `down` — the runtime is there, the orchestrator is not', () => {
    const err = new ApiError(503, 'GET /v1/operator/agents failed: 503', UNAVAILABLE_BODY);
    expect(classifyRuntimeRejection(err)).toBe('down');
  });

  it('keeps `down` for a structured 503 that also carries a cause', () => {
    const body = JSON.stringify({
      error: 'multi_orchestrator_unavailable',
      cause: 'no_assignment',
    });
    expect(classifyRuntimeRejection(new ApiError(503, 'x', body))).toBe('down');
  });

  /**
   * The bug itself: with the container stopped, an RSC call goes DIRECT to
   * `${MIDDLEWARE_URL}/api/...` (`botApi()`), so undici rejects with a plain
   * `TypeError` — never an `ApiError`, so the old `instanceof` narrowing never
   * even reached the status comparison.
   */
  it('reads a transport error as `unreachable`', () => {
    expect(classifyRuntimeRejection(new TypeError('fetch failed'))).toBe('unreachable');
  });

  it('reads an aborted call as `unreachable` — a hung middleware is not a healthy one', () => {
    const abort = new DOMException('The operation was aborted', 'TimeoutError');
    expect(classifyRuntimeRejection(abort)).toBe('unreachable');
  });

  it('reads a proxy 502/504 as `unreachable`', () => {
    expect(classifyRuntimeRejection(new ApiError(502, 'x', '<html>bad gateway'))).toBe(
      'unreachable',
    );
    expect(classifyRuntimeRejection(new ApiError(504, 'x'))).toBe('unreachable');
  });

  /**
   * A bare 503 is a gateway sentence ("service unavailable"), not the
   * middleware's own structured verdict — in the stock stack it is what sits
   * in front of a dead container. It must not be read as "runtime present".
   */
  it('reads a 503 WITHOUT the structured body as `unreachable`, not `down`', () => {
    expect(classifyRuntimeRejection(new ApiError(503, 'x', '<html>503'))).toBe('unreachable');
    expect(
      classifyRuntimeRejection(new ApiError(503, 'x', JSON.stringify({ error: 'other' }))),
    ).toBe('unreachable');
  });

  /**
   * OM-78 (#1001) deliberately biased the old boolean toward `true` so a blip
   * would not un-tick step 1. #1088 narrows that: an unknown state is reported
   * as unknown. Flap-resistance, if wanted, belongs in a retry — not in
   * calling a failure healthy.
   */
  it('reads a transient 500 as `unreachable` — an unknown state is not a healthy one', () => {
    expect(classifyRuntimeRejection(new ApiError(500, 'x'))).toBe('unreachable');
  });

  /**
   * The asymmetry with `classifyProbeResponse` is deliberate and is documented
   * on both functions: the readiness CARD stays out of session errors (the
   * header's auth badge owns those), while step 1 cannot tick itself off on a
   * permission answer that says nothing about the runtime. A 401 is normally
   * bounced by `redirectIfUnauthorized` before this runs; a 403 is not
   * (`authRedirect.ts` leaves those in place on purpose).
   */
  it('reads a 403 as `unreachable` — a permission answer is not a runtime verdict', () => {
    expect(classifyRuntimeRejection(new ApiError(403, 'x', '{"code":"auth.not_whitelisted"}'))).toBe(
      'unreachable',
    );
    expect(classifyRuntimeRejection(new ApiError(401, 'x'))).toBe('unreachable');
    // …while the card deliberately stays silent for the same statuses.
    expect(classifyProbeResponse(403, null)).toBeNull();
    expect(classifyProbeResponse(401, null)).toBeNull();
  });

  it('reads a non-Error rejection as `unreachable`', () => {
    expect(classifyRuntimeRejection('boom')).toBe('unreachable');
    expect(classifyRuntimeRejection(null)).toBe('unreachable');
  });
});

describe('runtimeStateOf', () => {
  it('is `up` only when the call fulfilled', () => {
    expect(runtimeStateOf({ status: 'fulfilled', value: { agents: [] } })).toBe('up');
  });

  it('is `up` for an ANSWER with no agents — an empty runtime still answers', () => {
    expect(runtimeStateOf({ status: 'fulfilled', value: null })).toBe('up');
  });

  it('follows the rejection classifier otherwise', () => {
    expect(
      runtimeStateOf({
        status: 'rejected',
        reason: new ApiError(503, 'x', UNAVAILABLE_BODY),
      }),
    ).toBe('down');
    expect(
      runtimeStateOf({ status: 'rejected', reason: new TypeError('fetch failed') }),
    ).toBe('unreachable');
  });
});

describe('classifyProbeResponse', () => {
  it('is silent (null) when the runtime answers', () => {
    expect(classifyProbeResponse(200, null)).toBeNull();
  });

  it('names the middleware cause on the structured 503', () => {
    expect(
      classifyProbeResponse(503, { error: 'multi_orchestrator_unavailable' }),
    ).toBe('no_llm_access');
    expect(
      classifyProbeResponse(503, {
        error: 'multi_orchestrator_unavailable',
        cause: 'no_assignment',
      }),
    ).toBe('no_assignment');
    expect(
      classifyProbeResponse(503, {
        error: 'multi_orchestrator_unavailable',
        cause: 'unknown',
      }),
    ).toBe('unknown');
  });

  it('stays silent on 401/403 — the session, not this card', () => {
    expect(classifyProbeResponse(401, null)).toBeNull();
    expect(classifyProbeResponse(403, null)).toBeNull();
  });

  /**
   * #1088 — the old probe cleared the card for EVERY `status !== 503`, so a
   * dead middleware behind the `/bot-api` proxy (which answers 500 when the
   * upstream fetch throws, or 502 behind a reverse proxy) hid the one card
   * whose job is to say the runtime cannot serve agents.
   */
  it('reports `unreachable` for a proxy 5xx', () => {
    expect(classifyProbeResponse(500, null)).toBe('unreachable');
    expect(classifyProbeResponse(502, null)).toBe('unreachable');
    expect(classifyProbeResponse(504, null)).toBe('unreachable');
  });

  it('reports `unreachable` for a 503 without the structured body', () => {
    expect(classifyProbeResponse(503, null)).toBe('unreachable');
    expect(classifyProbeResponse(503, { error: 'something_else' })).toBe('unreachable');
  });

  it('stays silent on a 404 — a missing route is not an unreachable backend', () => {
    expect(classifyProbeResponse(404, null)).toBeNull();
  });
});
