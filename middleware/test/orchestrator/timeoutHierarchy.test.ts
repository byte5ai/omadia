/**
 * W3-A — the two tool-timeout knobs must stay COHERENT.
 *
 * There are three nested bounds around one MCP-backed tool dispatch:
 *
 *   inner   `OMADIA_MCP_CALL_TIMEOUT_MS`            60 s  idle budget / request
 *   middle  `OMADIA_MCP_CALL_MAX_TOTAL_TIMEOUT_MS` 180 s  absolute MCP ceiling
 *   outer   `OMADIA_TOOL_DISPATCH_TIMEOUT_MS`      240 s  per-tool dispatch
 *
 * The dispatch deadline defaulted to 120 s, i.e. INSIDE the 180 s MCP ceiling.
 * A server streaming progress notifications (`resetTimeoutOnProgress`) for its
 * full allowance was therefore aborted by the OUTER bound first — the outer
 * schranke was tighter than the inner one, which is backwards. The model then
 * saw a generic dispatch-deadline error rather than the MCP layer's own
 * diagnosis, and no `mcp_call_log` failure row named the slow server.
 *
 * These assertions read the REAL resolvers (not copies of the literals), so an
 * env override that re-creates the inversion is caught too.
 */
import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  resolveMcpCallTimeouts,
  resolveToolDispatchTimeoutMs,
} from '@omadia/orchestrator';

const DISPATCH_ENV = 'OMADIA_TOOL_DISPATCH_TIMEOUT_MS';
const MCP_TOTAL_ENV = 'OMADIA_MCP_CALL_MAX_TOTAL_TIMEOUT_MS';
const MCP_REQUEST_ENV = 'OMADIA_MCP_CALL_TIMEOUT_MS';

const originals = {
  [DISPATCH_ENV]: process.env[DISPATCH_ENV],
  [MCP_TOTAL_ENV]: process.env[MCP_TOTAL_ENV],
  [MCP_REQUEST_ENV]: process.env[MCP_REQUEST_ENV],
};

afterEach(() => {
  for (const [name, value] of Object.entries(originals)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

/** The invariant itself, so both the default case and the override case assert
 *  the SAME rule rather than two hand-mirrored copies of it. */
function assertOuterIsLooser(): void {
  const dispatchDeadlineMs = resolveToolDispatchTimeoutMs();
  const { timeoutMs, maxTotalTimeoutMs } = resolveMcpCallTimeouts();
  // `0` means "no dispatch deadline", which is looser than any finite ceiling.
  if (dispatchDeadlineMs !== 0) {
    assert.ok(
      dispatchDeadlineMs > maxTotalTimeoutMs,
      `the OUTER tool-dispatch deadline (${String(dispatchDeadlineMs)}ms) must be strictly ` +
        `looser than the absolute MCP ceiling (${String(maxTotalTimeoutMs)}ms) — otherwise an ` +
        `MCP call that legitimately uses its full allowance is killed by the outer bound first`,
    );
  }
  assert.ok(
    maxTotalTimeoutMs > timeoutMs,
    `the absolute MCP ceiling (${String(maxTotalTimeoutMs)}ms) must be looser than the ` +
      `per-request idle budget (${String(timeoutMs)}ms)`,
  );
}

describe('tool-timeout hierarchy (W3-A)', () => {
  it('MUTATION CHECK: the shipped defaults order outer > mcp-absolute > mcp-request', () => {
    for (const name of [DISPATCH_ENV, MCP_TOTAL_ENV, MCP_REQUEST_ENV]) {
      delete process.env[name];
    }
    assertOuterIsLooser();
    // Pin the actual shipped numbers too: the ordering assertion alone would
    // stay green if BOTH knobs were lowered together, which would silently
    // shrink the allowance every long-running Odoo/Confluence report depends on.
    assert.equal(resolveToolDispatchTimeoutMs(), 240_000);
    assert.equal(resolveMcpCallTimeouts().maxTotalTimeoutMs, 180_000);
    assert.equal(resolveMcpCallTimeouts().timeoutMs, 60_000);
  });

  it('MUTATION CHECK: an operator raising the MCP ceiling past the dispatch deadline is caught', () => {
    // The failure mode this guard exists for, reproduced through the env knobs:
    // raising only the inner ceiling re-creates the inversion.
    process.env[MCP_TOTAL_ENV] = '300000';
    assert.throws(
      () => assertOuterIsLooser(),
      /must be strictly looser than the absolute MCP ceiling/,
      'raising the MCP ceiling above the dispatch deadline was not rejected',
    );
    // …and raising the outer bound with it restores coherence.
    process.env[DISPATCH_ENV] = '360000';
    assertOuterIsLooser();
  });

  it('a disabled dispatch deadline (0) is treated as looser than any ceiling', () => {
    process.env[DISPATCH_ENV] = '0';
    assert.equal(resolveToolDispatchTimeoutMs(), 0);
    assertOuterIsLooser();
  });
});
