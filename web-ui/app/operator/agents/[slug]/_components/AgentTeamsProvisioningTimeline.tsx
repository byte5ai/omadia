'use client';

import { useEffect, useMemo, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';

import {
  isKnownEventDetail,
  summarizeProvisioningRun,
  type TeamsProvisioningEventView,
  type TeamsProvisioningRetryView,
  type TeamsProvisioningRunSummary,
} from '../../../../_lib/teamsIdentity';

/**
 * The provisioning run's timeline (byte5ai/omadia#915).
 *
 * THE PROBLEM THIS SOLVES. Provisioning takes minutes and the middleware used
 * to persist exactly five facts about it — the five chain states. The panel
 * polls every three seconds, so between two of those transitions it fetched
 * byte-identical JSON dozens of times and rendered an unmoving badge. From an
 * operator's chair that is indistinguishable from a hung system, and the wait
 * is real: an Entra replication poll, up to five ARM retries with exponential
 * backoff, a catalog upload. Migration 0053 gives the runner somewhere to
 * write that down; this component is where it becomes visible.
 *
 * WHY IT TICKS CLIENT-SIDE. A duration that only advanced when the server had
 * something new to say would freeze for the exact minutes this feature exists
 * to explain. The elapsed time is computed against a locally ticking clock, so
 * the panel keeps moving between two identical polls — which is the whole
 * point. The tick runs only while a step is actually open, and stops with it.
 *
 * MOVEMENT, NOT JUST COLOUR. The active step carries an animated marker, so it
 * reads as "working" rather than "highlighted" — and `motion-reduce` turns the
 * animation off for anyone who asked their system for that.
 *
 * SCREEN READERS GET THE MEANING, NOT THE TICK. Announcing a new duration
 * every second would be unusable. The live region holds only the parts that
 * change when something actually happens (which step, which attempt); the
 * ticking number sits next to it, hidden from the accessibility tree.
 *
 * i18n: every string is a key (web-ui hard rule), every relative time comes
 * from `useFormatter`, and a detail code this build does not know renders
 * through a generic technical line rather than being printed as if it were
 * copy — see `isKnownEventDetail`.
 */

const TICK_INTERVAL_MS = 1000;

export function AgentTeamsProvisioningTimeline(props: {
  readonly events: readonly TeamsProvisioningEventView[];
  /** The runner's own answer, straight from the status route. Independent of
   *  the log: a run can be in flight before its first event lands. */
  readonly running: boolean;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const summary = useMemo(
    () => summarizeProvisioningRun(props.events),
    [props.events],
  );

  return (
    <section className="space-y-2" data-testid="teams-provisioning-timeline">
      <h3 className="text-sm font-medium">{t('teamsIdentity.timeline.heading')}</h3>
      <ActivityLine summary={summary} running={props.running} />
      <EventList events={props.events} />
    </section>
  );
}

/**
 * The one line an operator actually watches.
 *
 * Four distinct situations, deliberately worded apart because conflating them
 * is what made the old panel unreadable:
 *   - a step is open → what it is, and how long it has been open;
 *   - a step is waiting out a retry → which attempt, and when the next one is;
 *   - the run finished → say so, and stop pretending to work;
 *   - no run was ever started → say THAT, which is not the same as a run that
 *     died in its first step.
 */
function ActivityLine(props: {
  readonly summary: TeamsProvisioningRunSummary;
  readonly running: boolean;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const format = useFormatter();
  const { summary } = props;

  const active = summary.activeStep !== null || summary.retry !== null;
  const now = useTickingClock(active && props.running);

  if (!summary.runStarted && !props.running) {
    return (
      <p
        className="text-xs text-[color:var(--fg-muted)]"
        data-testid="teams-timeline-activity"
      >
        {t('teamsIdentity.timeline.neverStarted')}
      </p>
    );
  }

  if (summary.runFinished && !props.running) {
    return (
      <p
        className="text-xs text-[color:var(--fg-muted)]"
        data-testid="teams-timeline-activity"
      >
        {t('teamsIdentity.timeline.finished')}
      </p>
    );
  }

  return (
    <div
      className="rounded border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/5 px-3 py-2"
      data-testid="teams-timeline-activity"
    >
      <p className="flex flex-wrap items-center gap-2 text-xs">
        <ActiveMarker />
        {/* Live region: only the parts that change when something HAPPENS.
            The duration below is excluded on purpose — a screen reader
            announcing a new number every second is worse than silence. */}
        <span aria-live="polite" className="font-medium">
          {summary.activeStep !== null
            ? t('teamsIdentity.timeline.activeStep', {
                step: t(`teamsIdentity.states.${summary.activeStep}`),
              })
            : t('teamsIdentity.timeline.working')}
        </span>
        {summary.startedAt !== null && now !== null && (
          <span aria-hidden="true" className="text-[color:var(--fg-muted)]">
            {t('teamsIdentity.timeline.elapsed', {
              elapsed: format.relativeTime(summary.startedAt, now),
            })}
          </span>
        )}
      </p>
      {summary.retry !== null && (
        <RetryLine retry={summary.retry} now={now} />
      )}
    </div>
  );
}

/** Movement, so "active" is legible without relying on colour alone. */
function ActiveMarker(): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-[color:var(--accent)] motion-reduce:animate-none"
    />
  );
}

/**
 * "Attempt 3 of 5, next one in about 8 seconds."
 *
 * These are the gaps the operator experiences as a dead panel, so they get
 * their own line rather than a footnote. The next-attempt time is derived
 * (retry timestamp + the delay the runner recorded) and rendered against the
 * ticking clock, so it counts down instead of standing still; when the runner
 * recorded no delay the line simply omits it rather than guessing one.
 */
function RetryLine(props: {
  readonly retry: TeamsProvisioningRetryView;
  readonly now: number | null;
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const format = useFormatter();
  const { retry, now } = props;

  const nextAttemptAt =
    retry.retryInMs !== null
      ? new Date(retry.since.getTime() + retry.retryInMs)
      : null;

  const attemptText =
    retry.maxAttempts !== null
      ? t('teamsIdentity.timeline.attemptOf', {
          attempt: retry.attempt,
          max: retry.maxAttempts,
        })
      : t('teamsIdentity.timeline.attempt', { attempt: retry.attempt });

  return (
    <p
      className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[color:var(--warning)]"
      data-testid="teams-timeline-retry"
    >
      <span aria-live="polite">{attemptText}</span>
      {nextAttemptAt !== null && now !== null && (
        <span aria-hidden="true">
          {t('teamsIdentity.timeline.nextAttempt', {
            when: format.relativeTime(nextAttemptAt, now),
          })}
        </span>
      )}
    </p>
  );
}

/** The log itself, newest first — exactly the order the route sends. */
function EventList(props: {
  readonly events: readonly TeamsProvisioningEventView[];
}): React.ReactElement {
  const t = useTranslations('operatorAgents');
  const format = useFormatter();

  if (props.events.length === 0) {
    return (
      <p className="text-xs text-[color:var(--fg-muted)]">
        {t('teamsIdentity.timeline.empty')}
      </p>
    );
  }

  return (
    <ol
      aria-label={t('teamsIdentity.timeline.listLabel')}
      className="space-y-1 text-[11px]"
      data-testid="teams-timeline-events"
    >
      {props.events.map((event) => (
        <li key={event.id} className="flex flex-wrap items-baseline gap-2">
          <time
            dateTime={event.at.toISOString()}
            className="font-mono text-[color:var(--fg-muted)]"
          >
            {format.dateTime(event.at, {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
            })}
          </time>
          <span className="text-[color:var(--fg-strong)]">
            {t(`teamsIdentity.timeline.entry.${event.status}`, {
              step:
                event.step === 'run'
                  ? t('teamsIdentity.timeline.steps.run')
                  : event.step === 'config_sync'
                    ? t('teamsIdentity.timeline.steps.config_sync')
                    : t(`teamsIdentity.states.${event.step}`),
            })}
          </span>
          <EventDetail event={event} />
        </li>
      ))}
    </ol>
  );
}

/**
 * The event's note.
 *
 * A retry's detail is the structured token list the line above already reads
 * ("attempt 3 of 5, next in 8s"), so repeating it as raw text would be noise.
 * A code this build knows gets its localized sentence. Anything else — a
 * newer middleware, an older one — goes through the generic technical line
 * with the token as an argument, never printed as if it were copy.
 */
function EventDetail(props: {
  readonly event: TeamsProvisioningEventView;
}): React.ReactElement | null {
  const t = useTranslations('operatorAgents');
  const { detail, tokens } = props.event;
  if (detail === null || Object.keys(tokens).length > 0) return null;
  return (
    <span className="text-[color:var(--fg-muted)]">
      {isKnownEventDetail(detail)
        ? t(`teamsIdentity.timeline.details.${detail}`)
        : t('teamsIdentity.timeline.detailUnknown', { detail })}
    </span>
  );
}

/**
 * A clock that advances once a second while something is running.
 *
 * `null` until the first tick lands, so the first render carries no
 * client-only value — a duration rendered during hydration would differ
 * between server and client for no benefit. Stops when nothing is active,
 * because a timer running behind a finished panel is a leak nobody sees.
 */
function useTickingClock(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return undefined;
    // Seeded here rather than at declaration: the clock has to start when the
    // step becomes active, not when the panel mounted, or the first reading
    // would be the age of the page instead of the age of the step.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);

  // A stale reading from a previous step is never returned — the caller gets
  // `null` and renders no duration at all, which is the honest answer while
  // nothing is running.
  return active ? now : null;
}
