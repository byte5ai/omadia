/**
 * Runtime limit signal (plugin self-extension, Layer A — additive plugin-api).
 *
 * A Tier-3 tool that hits a *structural* wall at runtime — a server-side row
 * cap, an unsupported query operation, a truncated page — emits a structured
 * {@link LimitSignal} alongside its result instead of silently degrading. The
 * orchestrator surfaces the signal so the agent can decide to PROPOSE a
 * self-extension (a new tool that lifts the wall) rather than returning partial
 * data and pretending it was complete.
 *
 * This is the deterministic counterpart to the Dynamics aggregate-query
 * analysis (the `$top`=50 cap, missing `$apply`): the tool that hit the cap is
 * the one place that knows the exact shape of the limit, so it is the place
 * that declares it — no guessing downstream.
 *
 * Ships the TYPES + a pure constructor. The field is attached additively to
 * {@link import('./localSubAgentTool.js').LocalSubAgentToolResult.limitSignal};
 * classic consumers that only read `output` ignore it, exactly like the
 * `structured` envelope.
 */

export type LimitSignalKind =
  /** A server-side result cap was hit (e.g. OData `$top`=50, page size). */
  | 'row_cap'
  /** The result set was truncated mid-stream (cursor/nextLink not followed). */
  | 'page_truncated'
  /** The backend cannot express the requested operation (e.g. no `$apply`
   *  aggregation, no server-side group-by). */
  | 'unsupported_operation'
  /** A rate/quota limit forced an incomplete read. */
  | 'rate_limited'
  /** The tool needs a capability it does not currently have. */
  | 'missing_capability';

/**
 * A structured description of a runtime limit a tool hit. Deliberately small
 * and free of remediation *code* — it points at WHAT was hit and (optionally)
 * a human-readable hint; turning that into a concrete extension proposal is the
 * agent's + operator's job, gated by the escalation guard.
 */
export interface LimitSignal {
  readonly kind: LimitSignalKind;
  /** One-line, human-facing description of the limit. */
  readonly detail: string;
  /** The hard cap that was hit, when numeric (e.g. `50`). */
  readonly cap?: number;
  /** What was actually observed/available, when known (e.g. `8300` rows
   *  matched the filter but only `50` were returned). */
  readonly observed?: number;
  /** Optional remediation hint, free-form (e.g. `"use $apply aggregation"`). */
  readonly hint?: string;
}

/** Pure constructor — keeps the optional fields off the object when absent so
 *  equality checks in tests stay tight. */
export function makeLimitSignal(
  kind: LimitSignalKind,
  detail: string,
  extra: { cap?: number; observed?: number; hint?: string } = {},
): LimitSignal {
  const signal: {
    kind: LimitSignalKind;
    detail: string;
    cap?: number;
    observed?: number;
    hint?: string;
  } = { kind, detail };
  if (extra.cap !== undefined) signal.cap = extra.cap;
  if (extra.observed !== undefined) signal.observed = extra.observed;
  if (extra.hint !== undefined) signal.hint = extra.hint;
  return signal;
}

/**
 * Render a {@link LimitSignal} as a compact, machine-parseable note the agent
 * can read in the tool result. Deterministic and PII-free, so it is safe to
 * fold into a string that flows through the privacy data-plane. Returns the
 * empty string for an absent signal so callers can unconditionally append.
 */
export function formatLimitSignalNote(signal: LimitSignal | undefined): string {
  if (!signal) return '';
  const bounds: string[] = [];
  if (signal.cap !== undefined) bounds.push(`cap=${signal.cap}`);
  if (signal.observed !== undefined) bounds.push(`observed=${signal.observed}`);
  const boundsStr = bounds.length > 0 ? ` (${bounds.join(', ')})` : '';
  const hintStr = signal.hint ? ` Hint: ${signal.hint}.` : '';
  return (
    `[tool-limit:${signal.kind}] ${signal.detail}${boundsStr}.` +
    `${hintStr} This result is INCOMPLETE because the plugin hit a structural` +
    ` limit — if the full data matters, propose an operator-approved` +
    ` self-extension that lifts it.`
  );
}

/**
 * Append the limit note to a tool-result string, separated by a blank line.
 * No-op when there is no signal. Pure.
 */
export function appendLimitSignalNote(
  output: string,
  signal: LimitSignal | undefined,
): string {
  const note = formatLimitSignalNote(signal);
  if (note.length === 0) return output;
  return output.length > 0 ? `${output}\n\n${note}` : note;
}
