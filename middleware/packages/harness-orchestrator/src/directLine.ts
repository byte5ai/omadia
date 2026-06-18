/**
 * #332 Layer 2 — Direct Line directive parsing & target resolution.
 *
 * Pure, channel-agnostic helpers. The orchestrator owns the turn as always;
 * when the USER names a specialist inside the payload (`@omadia #strategist
 * <question>`), these helpers let the HARNESS — not the LLM — bind the
 * sub-agent's input to the verbatim user payload and route it through the
 * deterministic choke point. No model, no orchestrator discretion.
 *
 * Channel survival: chat clients resolve their own `@`-mentions, so the bot is
 * addressed natively and the specialist is named *in the payload*. The Teams
 * adapter additionally strips the bot's recipient mention and collapses
 * whitespace (`extractUserMessage`), so the directive must be a single leading
 * token that survives `\s+`→space normalization. A leading `#<label>` token
 * meets that bar.
 */

/** A parsed direct-line directive. */
export interface DirectLineDirective {
  /** The bare token the user named, lower-cased, sans prefix (e.g. `strategist`). */
  token: string;
  /** The verbatim remainder = the faithful sub-agent input. */
  payload: string;
}

/** Default directive prefix. Configurable per deployment (see Open question 3). */
export const DEFAULT_DIRECTIVE_PREFIX = '#';

/**
 * Parse a leading `#<token> <payload>` directive out of a user message.
 *
 * Hard requirements honoured:
 * - The directive token must be the FIRST token (after trim) — this both
 *   survives Teams whitespace-collapse and gives a clean literal-collision
 *   rule: a `#` that is NOT the first token is treated as ordinary text.
 * - Returns `undefined` when there is no leading directive (ordinary turn).
 * - Returns a directive with an EMPTY payload when the user named a specialist
 *   but typed nothing after it — the caller surfaces a faithful prompt rather
 *   than dispatching an empty question.
 */
export function parseDirectLineDirective(
  text: string,
  prefix: string = DEFAULT_DIRECTIVE_PREFIX,
): DirectLineDirective | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(prefix)) return undefined;
  const afterPrefix = trimmed.slice(prefix.length);
  // Token = leading run of label characters (letters, digits, _ , -, .).
  const match = /^([A-Za-z0-9._-]+)(.*)$/s.exec(afterPrefix);
  if (!match) return undefined;
  const token = match[1]!.toLowerCase();
  const payload = match[2]!.trim();
  return { token, payload };
}

/** A candidate sub-agent the directive may resolve to. */
export interface DirectLineCandidate {
  /** Stable tool name (key in the orchestrator's whitelist map). */
  toolName: string;
  /** Stable agent id when known (e.g. `de.byte5.agent.strategist`). */
  agentId?: string;
  /** Human label for attribution (e.g. `Strategist`). */
  label: string;
}

/** Outcome of resolving a directive token against the whitelisted agents. */
export type DirectLineResolution =
  | { kind: 'resolved'; candidate: DirectLineCandidate }
  | { kind: 'unknown' }
  | { kind: 'ambiguous'; matches: DirectLineCandidate[] };

/**
 * Human label for a sub-agent, derived from its stable agent id (preferred)
 * or tool name. Mirrors the middleware `labelFromAgentId` (Title-Cased last
 * segment) and strips an `ask_`/`consult_` verb prefix from tool names.
 */
export function directLineLabel(agentIdOrToolName: string): string {
  const last = agentIdOrToolName.split(/[./]/).pop() ?? agentIdOrToolName;
  const deverbed = last.replace(/^(?:ask|consult|query|invoke|agent)[-_]/i, '');
  const titled = deverbed
    .split(/[-_]/)
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join(' ');
  return titled.length > 0 ? titled : agentIdOrToolName;
}

/** Reduce a label/id/tool-name to a comparable key (lowercase alphanumerics). */
function normalizeKey(value: string): string {
  const last = value.split(/[./]/).pop() ?? value;
  const deverbed = last.replace(/^(?:ask|consult|query|invoke|agent)[-_]/i, '');
  return deverbed.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve a directive token to exactly one whitelisted sub-agent — or report
 * `unknown` / `ambiguous` so the caller can surface a disambiguation prompt and
 * NEVER silently route to the wrong agent (Pitfall 7). Matching is scoped to
 * the candidates the caller passes, which MUST be this orchestrator's
 * whitelisted sub-agents (reuses the OB-29-1 access gating).
 */
export function resolveDirectLineTarget(
  token: string,
  candidates: readonly DirectLineCandidate[],
): DirectLineResolution {
  const want = normalizeKey(token);
  if (want.length === 0) return { kind: 'unknown' };
  const matches = candidates.filter((c) => {
    const keys = [normalizeKey(c.label), normalizeKey(c.toolName)];
    if (c.agentId) keys.push(normalizeKey(c.agentId));
    return keys.includes(want);
  });
  if (matches.length === 0) return { kind: 'unknown' };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  return { kind: 'resolved', candidate: matches[0]! };
}

/** Direct-line delivery policy — who, if anyone, may add to the verbatim block. */
export type DirectLineMode =
  /** Pure relay: the orchestrator's own generation is suppressed. Default. */
  | 'strict'
  /**
   * Guarded additive: the verbatim sub-agent answer is still delivered
   * byte-for-byte and independently (harness-owned), but the orchestrator MAY
   * append an attributed, visually separated note. It can never redact.
   */
  | 'guarded';
