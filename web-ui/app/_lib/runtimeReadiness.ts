import { ApiError } from './api';

/**
 * The ONE classifier behind both runtime-readiness surfaces: onboarding step 1
 * on the dashboard (server-rendered, `app/page.tsx`) and the
 * `RuntimeReadinessBanner` (client probe). Exported from here precisely so the
 * two cannot drift apart again — the drift WAS the bug.
 *
 * #1088 — the dashboard ticked step 1 with „Die Agent-Runtime läuft." while
 * the middleware container was stopped. The old signal was a boolean derived
 * by EXCLUSION of one error shape:
 *
 *     const runtimeUp =
 *       agentP.status === 'fulfilled' ||
 *       !(agentP.reason instanceof ApiError && agentP.reason.status === 503);
 *
 * Every failure that was not a structured 503 therefore read as "up". That
 * covers the whole outage family: a stopped container (an RSC call goes
 * DIRECT to `${MIDDLEWARE_URL}/api/...` via `botApi()`, so undici rejects with
 * a plain `TypeError` — not an `ApiError` at all), a proxy 502/504, and the
 * 10s `rscTimeoutSignal` abort that a crash-looping or still-starting
 * middleware runs into.
 *
 * The replacement is a tri-state derived by SUCCESS. "Not `up`" is now the
 * default, and the two not-up states are kept apart because they need
 * different copy:
 *
 *   - `up`          — the operator route answered.
 *   - `down`        — the middleware answered its own structured 503: the
 *                     runtime is there, the orchestrator is not usable.
 *   - `unreachable` — no usable answer at all. Transport error, abort, proxy
 *                     5xx, bare 503, or a 4xx that is not about the runtime.
 *                     The runtime's state is UNKNOWN; the UI must say so
 *                     instead of guessing "healthy".
 *
 * `unreachable` therefore means "this route gave us nothing to go on", NOT
 * "the container is down" — a live middleware can also answer 500 from that
 * one handler. The copy on both surfaces is worded for the weaker claim, so
 * it cannot contradict the health tile beside it (`middlewareOk` in
 * `app/page.tsx`, which is true as soon as ANY call came back).
 *
 * OM-78 (#1001) biased the old boolean toward `true` on purpose, so a network
 * blip would not un-tick step 1. #1088 narrows that trade deliberately: a blip
 * and a dead backend are indistinguishable in a boolean, and of the two
 * possible mistakes, "reports a working system as unknown for one render" is
 * the recoverable one. Flap-resistance, if it is ever wanted back, belongs in
 * a bounded retry — not in calling an unknown state healthy.
 */
export type RuntimeReadiness = 'up' | 'down' | 'unreachable';

/** Mirrors `RuntimeReadinessCause` in middleware/src/platform/pluginLlmReadiness.ts. */
export type RuntimeReadinessCause = 'no_llm_access' | 'no_assignment' | 'unknown';

/**
 * What the readiness card can show: the middleware's own causes, plus the one
 * verdict the middleware can never report about itself — that it is not
 * answering.
 */
export type ReadinessCardCause = RuntimeReadinessCause | 'unreachable';

/** The middleware's structured "no orchestrator" marker on a 503. */
const UNAVAILABLE = 'multi_orchestrator_unavailable';

/** The 503 body shape: `{ error, message, cause? }` (see operatorAgents.ts). */
export interface ReadinessProbeBody {
  readonly error?: unknown;
  readonly cause?: unknown;
}

export function parseCause(value: unknown): RuntimeReadinessCause {
  return value === 'no_assignment' || value === 'unknown' ? value : 'no_llm_access';
}

/**
 * Does this 503 body carry the middleware's own structured verdict?
 *
 * Note this reads `error`, not `ApiError.code`: `parseErrorCode` (api.ts)
 * parses a `code` field, and the middleware sends this marker under `error`.
 */
function isStructuredUnavailable(body: ReadinessProbeBody | null): boolean {
  return body?.error === UNAVAILABLE;
}

function parseBody(raw: string): ReadinessProbeBody | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as ReadinessProbeBody)
      : null;
  } catch {
    return null;
  }
}

/**
 * Classify a REJECTED operator-route call (server side, `page.tsx`).
 *
 * Anything that is not the middleware's own structured 503 is `unreachable` —
 * including a non-`ApiError` rejection, which is exactly what a stopped
 * container produces.
 *
 * This deliberately does NOT exempt 401/403 the way `classifyProbeResponse`
 * does, and the asymmetry is the point: the two functions answer different
 * questions. The card asks "should I shout about the runtime?" — on a session
 * error the answer is no, the header's auth badge owns that. Step 1 asks "may
 * I tick this off?" — and a 403 is not a yes. `redirectIfUnauthorized` has
 * already bounced a 401 before this runs (`authRedirect.ts` leaves 403s in
 * place on purpose), so what reaches here is a permission answer that tells us
 * nothing about the runtime: unknown, which is what `unreachable` means.
 */
export function classifyRuntimeRejection(
  reason: unknown,
): Exclude<RuntimeReadiness, 'up'> {
  if (!(reason instanceof ApiError)) return 'unreachable';
  if (reason.status !== 503) return 'unreachable';
  return isStructuredUnavailable(parseBody(reason.body)) ? 'down' : 'unreachable';
}

/** The tri-state for one settled operator-route call. */
export function runtimeStateOf(result: PromiseSettledResult<unknown>): RuntimeReadiness {
  return result.status === 'fulfilled'
    ? 'up'
    : classifyRuntimeRejection(result.reason);
}

/**
 * Classify the banner's client-side probe of `/bot-api/v1/operator/agents`.
 *
 * `null` means "nothing for this card to say": the runtime answered, or the
 * failure is not about the runtime (401/403 are the session's business — the
 * header's auth badge reports those, and a fixed-position alert card on top of
 * a login-expiry banner helps nobody — and a 404 means a route is missing, not
 * a backend that is gone). See `classifyRuntimeRejection` for why step 1 is
 * stricter with the same statuses.
 *
 * A 5xx IS about the runtime. In the stock stack `/bot-api/*` is served by
 * web-ui's own proxy route (`middlewareProxy.ts`), which does not catch the
 * upstream fetch — so a dead middleware surfaces as a 500 here, and as a 502
 * when a reverse proxy sits in front. The old probe cleared the card for every
 * `status !== 503` and hid exactly the state it exists to report.
 */
export function classifyProbeResponse(
  status: number,
  body: ReadinessProbeBody | null,
): ReadinessCardCause | null {
  if (status === 503) {
    return isStructuredUnavailable(body) ? parseCause(body?.cause) : 'unreachable';
  }
  if (status >= 500) return 'unreachable';
  return null;
}
