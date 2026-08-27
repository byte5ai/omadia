'use client';

import { useFormatter, useTranslations } from 'next-intl';

import {
  TEAMS_PROVISIONING_CHAIN,
  type TeamsIdentityLastErrorDetailDto,
  type TeamsProvisioningState,
} from '../../../../_lib/agents';

/**
 * Presentational parts of the Teams identity panel (epic #860, wave W2a).
 *
 * Split out of `AgentTeamsIdentity.tsx` purely for file size: that file owns
 * the data flow (fetch, poll, provision) and the sibling Teams units extend
 * it, so keeping the stateless render pieces here leaves the stateful file
 * short enough to read in one screen. Everything here is pure — props in,
 * markup out, no fetching. Private to the panel; the import path the sibling
 * units use (`./AgentTeamsIdentity`) is unchanged.
 */

export function StateBadge(props: {
  readonly state: TeamsProvisioningState;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const tone =
    props.state === 'failed'
      ? 'border-[color:var(--danger-edge)] text-[color:var(--danger)]'
      : props.state === 'installed'
        ? 'border-[color:var(--accent)] text-[color:var(--accent)]'
        : 'border-[color:var(--border)] text-[color:var(--fg-muted)]';
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-[0.08em] ${tone}`}
    >
      {t('teamsIdentity.stateSummary', {
        state: t(`teamsIdentity.states.${props.state}`),
      })}
    </span>
  );
}

/**
 * The provisioning chain as an ordered list. `failed` is a SINK, not a step:
 * it has no position in the chain, so every step renders as "not reached"
 * and the failure itself is carried by the badge and the error block.
 * Claiming a step for `failed` would tell the operator the run got further
 * than it did.
 */
export function StateChain(props: {
  readonly state: TeamsProvisioningState;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const currentIndex = TEAMS_PROVISIONING_CHAIN.findIndex(
    (s) => s === props.state,
  );
  return (
    <ol
      aria-label={t('teamsIdentity.progressLabel')}
      className="flex flex-wrap items-center gap-1 text-[11px]"
    >
      {TEAMS_PROVISIONING_CHAIN.map((step, index) => {
        const reached = currentIndex >= 0 && index <= currentIndex;
        const current = index === currentIndex;
        return (
          <li
            key={step}
            {...(current ? { 'aria-current': 'step' as const } : {})}
            className={[
              'rounded border px-1.5 py-0.5',
              current
                ? 'border-[color:var(--accent)] font-medium text-[color:var(--accent)]'
                : reached
                  ? 'border-[color:var(--border)] text-[color:var(--fg-strong)]'
                  : 'border-[color:var(--border)]/40 text-[color:var(--fg-muted)]',
            ].join(' ')}
          >
            {t(`teamsIdentity.states.${step}`)}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The provisioning error, rendered from the SERVER-side classification.
 *
 * The localized sentence built from `detail.code` plus its ICU arguments is
 * the primary copy; `detail.raw` — the English sentence the job runner
 * wrote — is a collapsed technical detail. When the code is `unknown` there
 * is nothing better to say than the raw text, so it becomes the fallback's
 * ICU argument and the disclosure would only repeat it.
 */
export function LastError(props: {
  readonly detail: TeamsIdentityLastErrorDetailDto;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const { detail } = props;
  return (
    <div
      role="alert"
      className="rounded border border-[color:var(--warning)] bg-[color:var(--warning)]/10 p-3 text-sm text-[color:var(--warning)]"
    >
      <p className="font-medium">{t('teamsIdentity.lastErrorHeading')}</p>
      <p className="mt-1">{lastErrorMessage(detail, t)}</p>
      {detail.code !== 'unknown' && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[11px]">
            {t('teamsIdentity.lastErrorTechnical')}
          </summary>
          <code className="mt-1 block break-words font-mono text-[11px]">
            {detail.raw}
          </code>
        </details>
      )}
    </div>
  );
}

type Translate = ReturnType<typeof useTranslations<'operatorAgents'>>;

/** Each code carries its own ICU arguments, so the mapping is an explicit
 *  switch rather than a computed key — a new code fails the type check here
 *  instead of rendering a missing-message placeholder. */
function lastErrorMessage(
  detail: TeamsIdentityLastErrorDetailDto,
  t: Translate,
): string {
  switch (detail.code) {
    case 'consent_missing':
      return t('teamsIdentity.lastError.consent_missing', {
        scopes: (detail.scopes ?? []).join(', '),
      });
    case 'arm_not_configured':
      return t('teamsIdentity.lastError.arm_not_configured', {
        fields: (detail.fields ?? []).join(', '),
      });
    case 'throttled':
      return t('teamsIdentity.lastError.throttled', {
        seconds: detail.retryAfterSeconds ?? 0,
      });
    default:
      return t('teamsIdentity.lastError.unknown', { detail: detail.raw });
  }
}

/** One identity field. A `null` value is "not assigned yet" — a real state of
 *  an in-flight provisioning run, not missing data, so it gets copy of its
 *  own instead of a dash. */
export function Fact(props: {
  readonly label: string;
  readonly value: string | null;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <dt className="text-[color:var(--fg-muted)]">{props.label}</dt>
      <dd
        className={
          props.value
            ? 'font-mono text-[color:var(--fg-strong)]'
            : 'text-[color:var(--fg-muted)]'
        }
      >
        {props.value ?? t('teamsIdentity.notYet')}
      </dd>
    </div>
  );
}

export function TextField(props: {
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly pattern?: string;
}): React.ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-[color:var(--fg-muted)]">
        {props.label}
      </span>
      <input
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        {...(props.pattern ? { pattern: props.pattern } : {})}
        className="w-full rounded border border-[color:var(--border)] px-2 py-1 text-sm"
      />
      <span className="text-[11px] text-[color:var(--fg-muted)]">
        {props.hint}
      </span>
    </label>
  );
}

/** `created_at` / `updated_at` are ISO strings from the JSON projection of a
 *  `Date`. Fall back to the raw value rather than rendering "Invalid Date". */
export function formatTimestamp(
  iso: string,
  format: ReturnType<typeof useFormatter>,
): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  try {
    return format.dateTime(parsed, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}
