import { describe, expect, it } from 'vitest';

import { ApiError } from '../api';
import { describeConductorRunStartError } from '../conductorRunStartError';

function apiError(status: number, code: string, message: string): ApiError {
  return new ApiError(status, `POST /v1/operator/conductors/onb-probe/runs failed: ${String(status)}`, JSON.stringify({ code, message }));
}

// #1711 — "Starten" rendered the engine's refusal verbatim, so the operator of a
// template instance saw `… failed: 409` instead of being told the workflow is
// inactive and where the switch is.
describe('describeConductorRunStartError (#1711)', () => {
  it('maps the disabled 409 to the inactive sentence, with no technical detail', () => {
    const described = describeConductorRunStartError(
      apiError(409, 'conductor.disabled', "workflow 'onb-probe' is disabled"),
    );
    expect(described).toEqual({ key: 'runDisabledError', detail: null });
  });

  it('maps the other two refusals of the run-start route', () => {
    expect(describeConductorRunStartError(apiError(409, 'conductor.not_published', 'no version')).key).toBe(
      'runNotPublishedError',
    );
    expect(describeConductorRunStartError(apiError(404, 'conductor.not_found', 'gone')).key).toBe('runNotFoundError');
  });

  it('keeps the generic sentence for an unmapped failure and carries the server text behind it', () => {
    const described = describeConductorRunStartError(apiError(500, 'conductor.run_failed', 'pool is dead'));
    expect(described.key).toBe('runError');
    // The detail is the server's own explanation, not the `… failed: 500` line.
    expect(described.detail).toBe('pool is dead');
  });

  it('falls back to the thrown message for a non-ApiError, and to null for an empty one', () => {
    expect(describeConductorRunStartError(new Error('fetch failed'))).toEqual({
      key: 'runError',
      detail: 'fetch failed',
    });
    expect(describeConductorRunStartError(new Error('   ')).detail).toBeNull();
  });

  it('does not mistake a 409 of another route for a known refusal', () => {
    // conductor.has_active_runs is the DELETE guard; it must not borrow a
    // run-start sentence just because it shares the status code.
    const described = describeConductorRunStartError(apiError(409, 'conductor.has_active_runs', 'runs active'));
    expect(described.key).toBe('runError');
  });
});
