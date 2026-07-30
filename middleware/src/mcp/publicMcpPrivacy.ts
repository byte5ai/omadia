/**
 * W2-3 (issue #542) — the public MCP endpoint's privacy posture.
 *
 * ─── The decision this module exists to make ─────────────────────────────────
 *
 * The dispatch privacy seam is CLOSED: `ToolDispatchService` now replicates the
 * chat path's data-plane boundary (raw capture → intern-exemption → operator
 * bypass + receipt → intern). But it closed it at PARITY with the chat path, and
 * its own comment hands one consequence to this issue:
 *
 *     // Fail-OPEN, matching `Orchestrator.dispatchToolDeadlined` exactly. This
 *     // is parity, not an endorsement: for a PUBLIC endpoint a masking failure
 *     // that emits raw rows is a leak, and a fail-CLOSED policy for untrusted
 *     // callers is worth its own decision (#542) …
 *
 * DECISION: the public endpoint fails CLOSED. Three separate fail-open paths
 * exist between a tool's raw result and an internet caller, and this module
 * closes all three — WITHOUT changing `toolDispatchService.ts`, so the chat
 * path's behaviour is untouched and the sibling unit's parity argument stands.
 *
 *  1. **Masking throws.** The dispatcher catches and returns the raw result.
 *     Closed by wrapping `internToolResultV4` so it never throws: on failure it
 *     records the failure and returns a placeholder digest. The dispatcher's
 *     fail-open branch is therefore never reached, and the endpoint discards the
 *     result entirely. Not a nicety — the failure mode being defended against is
 *     "the privacy provider is having a bad minute and every Odoo row goes out
 *     over HTTP to a third party".
 *
 *  2. **Operator per-plugin bypass.** `checkBypass` returning a pluginId means
 *     raw passthrough. That setting was made for internal/chat use by an
 *     operator who was not being asked "…and also to anonymous API callers?".
 *     Closed by pinning `checkBypass` to `undefined`: a bypass does not extend
 *     to this endpoint, ever, and cannot be configured to.
 *
 *  3. **Intern-exempt tools.** `isInternExemptTool` hands `memory`,
 *     `read_attachment`, `query_processes`, `ask_user_choice` and friends over
 *     IN CLEAR, by design — masking them blinds the agent to its own state. That
 *     reasoning is about the AGENT reading its own scaffolding; it does not
 *     survive contact with a third party reading it over HTTP. This one cannot
 *     be closed from the handle (the dispatcher checks it BEFORE consulting the
 *     handle), so it is closed at the allowlist instead: see
 *     `isPubliclyServableTool` and its use in `PublicMcpServer`.
 *
 * A fourth path — no privacy provider installed at all, so results flow through
 * unchanged — is closed in `PublicMcpServer` by refusing the call.
 */

import type { PrivacyTurnHandle } from '@omadia/orchestrator';
import { isInternExemptTool } from '@omadia/orchestrator';

/**
 * Never reaches a caller: the endpoint checks `maskingFailed()` and replaces the
 * whole result. It exists only so the wrapper can satisfy the handle's return
 * type without throwing (a throw would hit the dispatcher's fail-OPEN branch and
 * emit the raw rows — the exact leak this module prevents).
 */
export const MASKING_FAILED_PLACEHOLDER = '[omadia:public-mcp:masking-failed]';

export interface PublicMcpPrivacyGate {
  /** Hand this to `ToolDispatchService`'s `privacy` dependency. */
  readonly handle: PrivacyTurnHandle;
  /** True when masking failed during this dispatch — DISCARD the result. */
  maskingFailed(): boolean;
  /**
   * True when masking RAN and produced a digest for this dispatch.
   *
   * The positive signal, and the one `PublicMcpServer` actually gates on:
   * `maskingFailed()` is false both when masking succeeded and when it never
   * ran, and "never ran" is the shape every leak in this family has taken. A
   * dispatch branch that skips the boundary, a handler returning a non-string
   * the masker declines to walk, an intern-exempt name that slipped the
   * allowlist — all of them leave `maskingFailed()` false with raw bytes in
   * hand.
   *
   * Enforced, not advisory: a result the gate did not mask is discarded. See
   * the assertion in `PublicMcpServer.callToolFor`, and
   * `publicMcpMaskingAssertion.test.ts` for what it catches.
   */
  masked(): boolean;
}

/**
 * Wraps a real handle so masking cannot fail open, and an operator bypass cannot
 * reach a public caller.
 *
 * One gate per DISPATCH, not per process — `maskingFailed()` is per-call state,
 * and a shared gate would make one caller's masking failure discard another
 * caller's perfectly good result (or, far worse, let a stale `false` clear a
 * failure that did happen).
 */
export function createFailClosedPrivacyGate(base: PrivacyTurnHandle): PublicMcpPrivacyGate {
  let failed = false;
  let didMask = false;

  const handle: PrivacyTurnHandle = {
    ...base,

    async internToolResultV4(input) {
      try {
        const result = await base.internToolResultV4(input);
        didMask = true;
        return result;
      } catch (err) {
        failed = true;
        // Logged, not rethrown. Rethrowing would reach the dispatcher's
        // fail-open catch, which returns `rawResult` — i.e. the leak.
        console.warn(
          `[public-mcp] privacy masking FAILED for tool \`${input.toolName}\` — refusing the call (fail-closed):`,
          err,
        );
        return { digestText: MASKING_FAILED_PLACEHOLDER, datasetId: '' };
      }
    },

    /**
     * Pinned off. An operator's per-plugin `_privacy_mode: bypass` is a decision
     * about their own agent's chat behaviour; nobody consented to extending it
     * to an unauthenticated-origin HTTP caller. Returning `undefined`
     * unconditionally means the dispatcher always takes the intern branch, so
     * `recordBypassedTool` is never reached from this path either.
     */
    checkBypass(): undefined {
      return undefined;
    },
  };

  return {
    handle,
    maskingFailed: () => failed,
    masked: () => didMask,
  };
}

/**
 * Whether a tool may EVER be served over the public endpoint, independent of any
 * operator allowlist.
 *
 * The only rule today is the intern exemption (see this module's header, point
 * 3): a tool whose result the Privacy Shield deliberately hands over in clear
 * must not be reachable by a third party, no matter what an operator typed into
 * a binding row. `memory` alone would expose the agent's working memory —
 * arbitrary accumulated business context — to whoever holds the key.
 *
 * Enforced as a hard filter rather than a warning, because the alternative is a
 * log line nobody reads guarding a data leak. An operator who lists one gets the
 * warning AND the tool stays unreachable.
 */
export function isPubliclyServableTool(name: string): boolean {
  return !isInternExemptTool(name);
}
