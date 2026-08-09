/**
 * W3-A / W4 — the tool-timeout knobs must stay COHERENT.
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
 * W4 closes the two ways that fix was defeated:
 *
 *  1. The invariant was asserted against a PER-ATTEMPT ceiling while `callTool`
 *     makes up to `MCP_CALL_MAX_ATTEMPTS` of them — real worst case 2 × 180 s =
 *     360 s, above the 240 s outer bound. `resolveMcpCallTimeouts` now reports
 *     `worstCaseTotalMs` (retries share one budget), and that is what the
 *     invariant is stated against.
 *  2. The invariant itself lived ONLY in this file, as a local helper nothing
 *     shipped ever called — so an env override re-created the inversion with
 *     fully green CI. It now lives in `assertTimeoutHierarchy()` and runs at
 *     boot; this file asserts the PRODUCTION function, not a copy of it.
 */
import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  MCP_CALL_MAX_ATTEMPTS,
  assertTimeoutHierarchy,
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

function clearEnv(): void {
  for (const name of [DISPATCH_ENV, MCP_TOTAL_ENV, MCP_REQUEST_ENV]) {
    delete process.env[name];
  }
}

describe('tool-timeout hierarchy (W3-A / W4)', () => {
  it('MUTATION CHECK: the shipped defaults order outer > mcp-worst-case > mcp-request', () => {
    clearEnv();
    assertTimeoutHierarchy();
    // Pin the actual shipped numbers too: the ordering assertion alone would
    // stay green if BOTH knobs were lowered together, which would silently
    // shrink the allowance every long-running Odoo/Confluence report depends on.
    assert.equal(resolveToolDispatchTimeoutMs(), 240_000);
    assert.equal(resolveMcpCallTimeouts().maxTotalTimeoutMs, 180_000);
    assert.equal(resolveMcpCallTimeouts().timeoutMs, 60_000);
  });

  it('MUTATION CHECK: the invariant counts the RETRY, not just one attempt', () => {
    clearEnv();
    // The defect: `callTool` retries once, so the honest worst case for one
    // dispatch was 2 × the absolute ceiling. Asserting the outer bound against
    // the per-attempt number let 240 s "pass" against a 360 s reality.
    assert.ok(MCP_CALL_MAX_ATTEMPTS >= 2, 'the retry this guards is still there');
    const { maxTotalTimeoutMs, worstCaseTotalMs } = resolveMcpCallTimeouts();
    // Retries SHARE the absolute budget, so the worst case is one ceiling — and
    // this is the assertion that fails loudly if someone gives attempt 2 a fresh
    // allowance again.
    assert.equal(
      worstCaseTotalMs,
      maxTotalTimeoutMs,
      'the retry must not get its own maxTotalTimeout — the attempts share one budget',
    );
    assert.ok(
      resolveToolDispatchTimeoutMs() > worstCaseTotalMs,
      `the outer dispatch deadline (${String(resolveToolDispatchTimeoutMs())}ms) must exceed the ` +
        `RETRY-INCLUSIVE MCP worst case (${String(worstCaseTotalMs)}ms)`,
    );
    // The number the old, per-attempt reading would have had to clear.
    assert.ok(
      maxTotalTimeoutMs * MCP_CALL_MAX_ATTEMPTS > resolveToolDispatchTimeoutMs(),
      'sanity: an unshared retry budget really would exceed the dispatch deadline',
    );
  });

  it('MUTATION CHECK: raising the MCP ceiling past the dispatch deadline is REFUSED at boot', () => {
    clearEnv();
    process.env[MCP_TOTAL_ENV] = '300000';
    assert.throws(
      () => assertTimeoutHierarchy(),
      /must be strictly looser than the MCP layer's worst-case call budget/,
      'raising the MCP ceiling above the dispatch deadline was not rejected',
    );
    // …and raising the outer bound with it restores coherence.
    process.env[DISPATCH_ENV] = '360000';
    assertTimeoutHierarchy();
  });

  it('MUTATION CHECK: LOWERING the dispatch deadline is refused too', () => {
    clearEnv();
    // The hole the reviewer found: the invariant only ever exercised RAISING the
    // inner ceiling, so lowering the OUTER bound — the far likelier operator
    // action, and the one that produced the original 120 s inversion — re-created
    // the inversion with green CI. `resolveToolDispatchTimeoutMs` happily accepts
    // any non-negative number; the refusal has to come from the invariant check.
    process.env[DISPATCH_ENV] = '90000';
    assert.equal(
      resolveToolDispatchTimeoutMs(),
      90_000,
      'the resolver is pure — it reports what was configured',
    );
    assert.throws(
      () => assertTimeoutHierarchy(),
      /OMADIA_TOOL_DISPATCH_TIMEOUT_MS=90000ms/,
      'a dispatch deadline INSIDE the MCP ceiling was not rejected',
    );
    // Coherent again once the inner ceiling is lowered to match — which is the
    // fix the error message tells the operator about.
    process.env[MCP_TOTAL_ENV] = '60000';
    process.env[MCP_REQUEST_ENV] = '30000';
    assertTimeoutHierarchy();
  });

  it('MUTATION CHECK: an MCP ceiling below its own per-request budget is refused', () => {
    clearEnv();
    process.env[MCP_REQUEST_ENV] = '90000';
    process.env[MCP_TOTAL_ENV] = '60000';
    assert.throws(
      () => assertTimeoutHierarchy(),
      /must be looser than the per-request idle budget/,
    );
  });

  it('a disabled dispatch deadline (0) is treated as looser than any ceiling', () => {
    clearEnv();
    process.env[DISPATCH_ENV] = '0';
    assert.equal(resolveToolDispatchTimeoutMs(), 0);
    assertTimeoutHierarchy();
  });
});
