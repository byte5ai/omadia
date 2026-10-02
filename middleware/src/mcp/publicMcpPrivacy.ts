/**
 * W2-3 (issue #542) — the public MCP endpoint's privacy posture.
 *
 * ─── The decision this module exists to make ─────────────────────────────────
 *
 * The dispatch privacy seam is CLOSED: `ToolDispatchService` replicates the chat
 * path's data-plane boundary (raw capture → intern-exemption → operator bypass +
 * receipt → intern), at PARITY with the chat path. Parity is not the right bar
 * for a third party calling over HTTP, so this module decides the rest.
 *
 * DECISION: the public endpoint fails CLOSED. Three separate paths exist between
 * a tool's raw result and an internet caller, and this module closes all three —
 * WITHOUT changing `toolDispatchService.ts`, so the chat path's behaviour is
 * untouched.
 *
 *  1. **Masking throws.** The dispatcher fails closed on its own: it catches
 *     the throw and returns `internFailedNotice`, an error saying the result
 *     was withheld. The endpoint goes one step further and refuses the call
 *     instead of serving that notice as the tool's answer: `internToolResultV4`
 *     is wrapped so it never throws, records the failure and returns a
 *     placeholder digest, so the dispatcher's catch is never reached, and the
 *     endpoint discards the result entirely. The failure mode being defended
 *     against is "the privacy provider is having a bad minute": the caller
 *     learns the call failed, nothing of the result.
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
 *     be closed from the handle (the dispatcher hands an exempt tool's result
 *     over BEFORE consulting the handle; only its `Error:` text goes through
 *     it), so it is closed at the allowlist instead: see
 *     `isPubliclyServableTool` and its use in `PublicMcpServer`.
 *
 * A fourth path — no privacy provider installed at all, so results flow through
 * unchanged — is closed in `PublicMcpServer` by refusing the call. Without the
 * gate no tool runs at all: `PublicMcpServer` refuses a dispatcher that cannot
 * receive it, and the wired dispatcher runs no handler without a handle
 * (`requirePrivacyHandle`).
 *
 * Tool errors: a handler that THROWS gets the dispatcher's withheld notice
 * (class name, sanitised code, the request id as log ref — `origin:
 * 'dispatcher'`, so it is served as the error it is). A returned `Error:` text
 * is never served: the gate answers tool-error redaction with `withheld`, and
 * the result is refused like any other unmasked one.
 *
 * Model calls INSIDE a tool: a domain tool wraps a sub-agent with its own model
 * loop. `ToolDispatchService` runs the handler with `handle.forNestedCalls()` as
 * the ambient turn handle, so that loop runs under this gate too: inner tool
 * results are interned before the sub-agent's model sees them, an inner throw
 * and an inner `Error:` text reach it only as the withheld notice, and the
 * operator bypass stays off. That masking guards the sub-agent's provider wire
 * only — it does not set `masked()`, which stays the signal that the call's
 * OWN result crossed the boundary — while a failure there fails the whole call.
 */

import type { PrivacyTurnHandle } from '@omadia/orchestrator';
import { isInternExemptTool } from '@omadia/orchestrator';
import { describeThrownError } from '@omadia/plugin-api';

/**
 * Never reaches a caller: the endpoint checks `maskingFailed()` and replaces the
 * whole result. It exists only so the wrapper can satisfy the handle's return
 * type without throwing (a throw would hit the dispatcher's catch, which answers
 * with `internFailedNotice` — a withheld-result error the endpoint would serve
 * instead of refusing the call).
 */
export const MASKING_FAILED_PLACEHOLDER = '[omadia:public-mcp:masking-failed]';

export interface PublicMcpPrivacyGate {
  /** Hand this to `ToolDispatchService`'s `privacy` dependency. */
  readonly handle: PrivacyTurnHandle;
  /** True when masking failed during this dispatch — DISCARD the result. */
  maskingFailed(): boolean;
  /**
   * True when masking RAN and produced a digest for this dispatch's own result
   * (masking nested inside the call, through `forNestedCalls()`, does not count).
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
 * Wraps a real handle so a masking failure refuses the call, and an operator
 * bypass cannot reach a public caller.
 *
 * One gate per DISPATCH, not per process — `maskingFailed()` is per-call state,
 * and a shared gate would make one caller's masking failure discard another
 * caller's perfectly good result (or, far worse, let a stale `false` clear a
 * failure that did happen).
 */
export function createFailClosedPrivacyGate(base: PrivacyTurnHandle): PublicMcpPrivacyGate {
  let failed = false;
  let didMask = false;

  /**
   * Masking that never throws. `ownResult` is false for code nested inside
   * the call (a sub-agent's inner tool results): that masking guards the
   * sub-agent's provider wire and says nothing about the text the call hands
   * back, so it must not satisfy `masked()`. A failure anywhere fails the call.
   */
  const intern = async (
    input: Parameters<PrivacyTurnHandle['internToolResultV4']>[0],
    ownResult: boolean,
  ): ReturnType<PrivacyTurnHandle['internToolResultV4']> => {
    try {
      const result = await base.internToolResultV4(input);
      if (ownResult) didMask = true;
      return result;
    } catch (err) {
      failed = true;
      // Logged, not rethrown. Rethrowing would reach the dispatcher's catch,
      // which fails closed with `internFailedNotice`; the endpoint would serve
      // that notice as an error. `maskingFailed()` makes it refuse the call.
      // The provider's error can quote the result it was handed: the log line
      // carries its class and code only.
      const { name, code } = describeThrownError(err);
      console.warn(
        `[public-mcp] privacy masking FAILED for tool \`${input.toolName}\` with ${name}` +
          `${code === undefined ? '' : ` (code ${code})`} — refusing the call (fail-closed)`,
      );
      return { digestText: MASKING_FAILED_PLACEHOLDER, datasetId: '' };
    }
  };

  /** The same for the call and for code nested inside it. */
  const pinned: Pick<PrivacyTurnHandle, 'checkBypass' | 'redactToolErrorText' | 'recordToolError'> = {
    /**
     * Pinned off. An operator's per-plugin `_privacy_mode: bypass` is a decision
     * about their own agent's chat behaviour; nobody consented to extending it
     * to an unauthenticated-origin HTTP caller. Returning `undefined`
     * unconditionally means the dispatcher always takes the intern branch, so
     * `recordBypassedTool` is never reached from this path either.
     */
    checkBypass: () => undefined,

    /**
     * Pinned to `withheld`. For the call's own result: a redacted text still
     * would not set `didMask`, so `assertMaskingCrossed` would discard it
     * anyway; answering `withheld` makes that fail-closed outcome explicit and
     * spends no detector — or C1 sidecar call — on text that is never served.
     * For a sub-agent's inner tool error: the sub-agent model gets the
     * withheld notice instead of a redacted hint, and no per-turn detector
     * state builds up for a request that is never finalized. Serving redacted
     * error hints here would be a separate decision.
     */
    async redactToolErrorText() {
      return {
        outcome: 'withheld' as const,
        reason: 'the public MCP endpoint does not serve tool-error text',
      };
    },

    /**
     * Not forwarded. A public request is never finalized into a turn receipt, so
     * an entry handed to the provider would sit in its per-turn state with
     * nothing to drain it. This path's record of a failed call is its
     * `mcp_call_log` row; the line below is PII-free (names and a byte count).
     */
    async recordToolError(input) {
      console.log(
        `[public-mcp] tool error ${input.outcome} tool=${input.toolName} ` +
          `carrier=${input.carrier} bytes=${String(input.bytes)}`,
      );
    },
  };

  /**
   * For code nested inside the call — a domain tool's sub-agent loop, which
   * `ToolDispatchService` runs under this handle (`forNestedCalls`). Same
   * guard, but its masking leaves `masked()` alone.
   */
  const nested: PrivacyTurnHandle = {
    ...base,
    ...pinned,
    internToolResultV4: (input) => intern(input, false),
    forNestedCalls: () => nested,
  };

  const handle: PrivacyTurnHandle = {
    ...base,
    ...pinned,
    internToolResultV4: (input) => intern(input, true),
    forNestedCalls: () => nested,
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
