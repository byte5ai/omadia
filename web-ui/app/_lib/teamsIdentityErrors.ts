/**
 * #860 / W2a — turn the Teams provisioning `last_error` into something an
 * operator can ACT on.
 *
 * WHY A PARSER LIVES HERE. `agent_teams_identities.last_error` is a free-form
 * English sentence, not a structured field: the job runner
 * (`middleware/src/services/teamsProvisioningJob.ts`) writes
 *
 *   consent_missing: admin consent required for scopes [a, b] — grant them in
 *   the customer tenant, then re-run provisioning
 *
 *   arm_not_configured: bot creation needs the ARM setup fields [x, y] on the
 *   M365 connector — configure them, then re-run provisioning (the app
 *   registration is kept)
 *
 * and, for an exhausted throttle budget, the connector's own message plus
 * `(gave up after N attempts)`. `GET /api/v1/operator/agents/:slug/teams-identity`
 * (`middleware/src/routes/operatorAgents.ts`) exposes that sentence verbatim
 * under `identity.last_error` and nothing else. Rendering it would put English
 * on a German operator's screen, which the web-ui i18n rule forbids — so this
 * module classifies the sentence into a machine code plus its captured
 * arguments, and the UI renders THAT through i18n keys. The raw sentence may
 * only appear as a secondary technical detail.
 *
 * MATCHED ON SHAPE, NOT ON WORDING. The `consent_missing:` / `arm_not_configured:`
 * prefixes and the first bracketed list are the stable parts; the prose between
 * them is not, and is never required to match. Throttling has no prefix at all
 * and is recognised by its markers (429 / throttled / rate limit / Retry-After).
 * Same posture as `parseScanFailureCode` in `scanFailure.ts` and
 * `classifyProviderError` in `providerErrorMessage.ts` — no third pattern is
 * invented here.
 *
 * FOLLOW-UP (out of scope, worth doing): the runner should persist a structured
 * code from the start and the route project it as `last_error_detail`, at which
 * point this parser degrades to a fallback for rows written before that change.
 */

import type { LocalizedMessage } from './teamsIdentity';

/**
 * Failure classes the Teams provisioning surface can say something USEFUL
 * about. Everything else stays `unknown` and shows the technical detail —
 * still better than a shrug.
 *
 *  - `consent_missing`    — TERMINAL. A tenant admin has to grant application
 *                           permissions; re-running alone changes nothing.
 *  - `arm_not_configured` — NOT terminal and NOT a broken agent. The Entra app
 *                           registration exists and is kept; only the ARM leg
 *                           is unconfigured, so the runner parks the identity
 *                           on `app_registered`.
 *  - `throttled`          — Microsoft throttled us. Nothing to fix; retrying
 *                           later is the whole remedy.
 */
export const TEAMS_IDENTITY_ERROR_CODES = [
  'consent_missing',
  'arm_not_configured',
  'throttled',
  'unknown',
] as const;

export type TeamsIdentityErrorCode = (typeof TEAMS_IDENTITY_ERROR_CODES)[number];

export interface TeamsIdentityErrorDetail {
  readonly code: TeamsIdentityErrorCode;
  /** Application permissions the tenant admin still has to consent to. */
  readonly scopes?: readonly string[];
  /** M365-connector setup fields that are still empty. */
  readonly fields?: readonly string[];
  /** Wait hint from the throttle, when the sentence carried one. */
  readonly retryAfterSeconds?: number;
  /** Does re-running WITHOUT changing anything have a chance? Only a throttle
   *  clears itself; consent and setup fields need a human first. */
  readonly retryable: boolean;
  /** The persisted sentence, trimmed. Secondary technical detail only. */
  readonly raw: string;
}

/** The machine prefixes the job runner writes. Change one, change both sides —
 *  `__tests__/teamsIdentity.test.ts` pins the exact producer sentences. */
const CONSENT_MISSING_PREFIX = 'consent_missing:';
const ARM_NOT_CONFIGURED_PREFIX = 'arm_not_configured:';

/** First bracketed list in the sentence — `[a, b]` → `['a', 'b']`. An empty or
 *  absent list yields `[]`, which the copy handles by omitting the names. */
function bracketedList(raw: string): readonly string[] {
  const match = /\[([^\]]*)\]/.exec(raw);
  const inner = match?.[1];
  if (inner === undefined) return [];
  return inner
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Throttle markers. The persisted sentence is the CONNECTOR's message (this
 * repo never writes it), so only transport-level markers are safe to match:
 * the status code, the word, and the header name.
 */
const THROTTLE_MARKERS: readonly RegExp[] = [
  /\b429\b/,
  /throttl/i,
  /rate[ _-]?limit/i,
  /too many requests/i,
  /retry[ _-]?after/i,
];

/** `Retry-After: 7`, `retry after 7`, `retryAfterSeconds=7`. Seconds only —
 *  the connector's hint is in seconds (`ProvisioningThrottledErrorLike`). */
const RETRY_AFTER_SECONDS = /retry[ _-]?after(?:[ _-]?seconds)?\s*[:=]?\s*(\d{1,6})\b/i;

function retryAfterSecondsOf(raw: string): number | undefined {
  const digits = RETRY_AFTER_SECONDS.exec(raw)?.[1];
  if (digits === undefined) return undefined;
  const seconds = Number.parseInt(digits, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Classify a persisted `last_error`, or `null` when there is no error at all
 * (the normal, successful case — the runner clears the column on every step).
 */
export function classifyTeamsIdentityError(
  lastError: string | null | undefined,
): TeamsIdentityErrorDetail | null {
  const raw = lastError?.trim() ?? '';
  if (raw.length === 0) return null;

  if (raw.startsWith(CONSENT_MISSING_PREFIX)) {
    return { code: 'consent_missing', scopes: bracketedList(raw), retryable: false, raw };
  }

  if (raw.startsWith(ARM_NOT_CONFIGURED_PREFIX)) {
    return {
      code: 'arm_not_configured',
      fields: bracketedList(raw),
      retryable: false,
      raw,
    };
  }

  if (THROTTLE_MARKERS.some((marker) => marker.test(raw))) {
    const retryAfterSeconds = retryAfterSecondsOf(raw);
    return retryAfterSeconds === undefined
      ? { code: 'throttled', retryable: true, raw }
      : { code: 'throttled', retryAfterSeconds, retryable: true, raw };
  }

  return { code: 'unknown', retryable: false, raw };
}

/**
 * Microsoft's own instructions for the step a consent failure blocks on. The
 * copy names the step; this is the link behind it, so the operator does not
 * have to hunt for the Entra blade.
 */
export const ENTRA_ADMIN_CONSENT_DOCS_URL =
  'https://learn.microsoft.com/entra/identity/enterprise-apps/grant-admin-consent';

export interface TeamsIdentityErrorLink {
  readonly href: string;
  /** i18n key of the link label, relative to `operatorAgents.teamsIdentity`. */
  readonly labelKey: string;
}

/** The one external step a failure sends the operator to, when there is one. */
export function teamsIdentityErrorLink(
  detail: TeamsIdentityErrorDetail,
): TeamsIdentityErrorLink | null {
  return detail.code === 'consent_missing'
    ? {
        href: ENTRA_ADMIN_CONSENT_DOCS_URL,
        labelKey: 'errors.consent_missing.consentLink',
      }
    : null;
}

/**
 * The localized sentences for a failure, in reading order: what happened, the
 * captured specifics (named scopes / fields / wait hint), what to do next.
 *
 * Keys are relative to the `operatorAgents.teamsIdentity` namespace. The
 * captured lists are passed as ICU arguments, never concatenated into copy.
 */
export function teamsIdentityErrorMessages(
  detail: TeamsIdentityErrorDetail,
): readonly LocalizedMessage[] {
  const base = `errors.${detail.code}`;
  const messages: LocalizedMessage[] = [{ key: `${base}.what` }];

  if (detail.code === 'consent_missing' && (detail.scopes?.length ?? 0) > 0) {
    const scopes = detail.scopes as readonly string[];
    messages.push({
      key: `${base}.scopes`,
      values: { scopes: scopes.join(', '), count: scopes.length },
    });
  }

  if (detail.code === 'arm_not_configured' && (detail.fields?.length ?? 0) > 0) {
    const fields = detail.fields as readonly string[];
    messages.push({
      key: `${base}.fields`,
      values: { fields: fields.join(', '), count: fields.length },
    });
  }

  if (detail.code === 'throttled' && detail.retryAfterSeconds !== undefined) {
    messages.push({
      key: `${base}.retryAfter`,
      values: { seconds: detail.retryAfterSeconds },
    });
  }

  messages.push({ key: `${base}.next` });

  // Registration-only is a legitimate END STATE, not a broken agent — say so
  // last, where a worried operator stops reading.
  if (detail.code === 'arm_not_configured') {
    messages.push({ key: `${base}.keepsRegistration` });
  }

  return messages;
}

/** The raw sentence, demoted to a secondary technical line. */
export function teamsIdentityErrorTechnicalDetail(
  detail: TeamsIdentityErrorDetail,
): LocalizedMessage {
  return { key: 'errors.technicalDetail', values: { raw: detail.raw } };
}
