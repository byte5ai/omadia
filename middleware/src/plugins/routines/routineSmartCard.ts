/**
 * Adaptive Card builder for proactive routine deliveries.
 *
 * The card frames every routine-triggered message with three signals so
 * the user can tell it apart from a regular agent reply:
 *   - **Header pill** ("🕒 Routine") makes the trigger origin obvious.
 *   - **Body** carries the agent's answer text (Markdown supported).
 *   - **Fact set** shows the routine name + cron expression so the user
 *     knows *which* routine fired and *how often* it will fire next.
 *   - **Action buttons** ("Pausieren" / "Löschen") submit a JSON payload
 *     back to the bot. The bot's inbound handler detects
 *     `value.kind === 'routine.action'` and dispatches via the kernel-
 *     wired action handler (mutates DB + scheduler).
 *
 * Pure JSON output — no botbuilder dependency. The Teams adapter wraps
 * it in `CardFactory.adaptiveCard(...)` at send time.
 */

export const ROUTINE_CARD_ACTION_KIND = 'routine.action';

export type RoutineCardAction =
  | 'pause'
  | 'resume'
  | 'trigger_now'
  | 'delete';

export interface RoutineCardActionPayload {
  kind: typeof ROUTINE_CARD_ACTION_KIND;
  action: RoutineCardAction;
  id: string;
}

export interface BuildRoutineSmartCardInput {
  routine: { id: string; name: string; cron: string };
  /** The agent's prose answer for this trigger. */
  body: string;
}

export const ADAPTIVE_CARD_CONTENT_TYPE =
  'application/vnd.microsoft.card.adaptive';

/**
 * Construct the Adaptive Card payload. Card schema 1.5 — supported by
 * Teams desktop, web, and mobile. Falls back gracefully on older clients
 * (the body text remains readable; only the action buttons may render
 * as a link list).
 */
export function buildRoutineSmartCard(
  input: BuildRoutineSmartCardInput,
): unknown {
  const { routine, body } = input;
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      {
        type: 'Container',
        style: 'emphasis',
        bleed: true,
        items: [
          {
            type: 'ColumnSet',
            columns: [
              {
                type: 'Column',
                width: 'auto',
                items: [
                  {
                    type: 'TextBlock',
                    text: '🕒',
                    size: 'Large',
                    spacing: 'None',
                  },
                ],
              },
              {
                type: 'Column',
                width: 'stretch',
                items: [
                  {
                    type: 'TextBlock',
                    text: 'Routine',
                    weight: 'Bolder',
                    size: 'Small',
                    color: 'Accent',
                    spacing: 'None',
                  },
                  {
                    type: 'TextBlock',
                    text: escapeMarkdown(routine.name),
                    weight: 'Bolder',
                    size: 'Medium',
                    spacing: 'None',
                    wrap: true,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'TextBlock',
        text: body,
        wrap: true,
        spacing: 'Medium',
      },
      {
        type: 'FactSet',
        facts: [
          { title: 'Cron', value: routine.cron },
          { title: 'ID', value: routine.id },
        ],
        spacing: 'Medium',
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: 'Pausieren',
        data: {
          kind: ROUTINE_CARD_ACTION_KIND,
          action: 'pause',
          id: routine.id,
        } satisfies RoutineCardActionPayload,
      },
      {
        type: 'Action.Submit',
        title: 'Löschen',
        style: 'destructive',
        data: {
          kind: ROUTINE_CARD_ACTION_KIND,
          action: 'delete',
          id: routine.id,
        } satisfies RoutineCardActionPayload,
      },
    ],
  };
}

/**
 * Type guard for the payload Teams sends back when one of the card
 * actions is clicked. The Teams runtime delivers the `data` object as
 * `activity.value`. We narrow to our shape to dispatch safely.
 */
export function parseRoutineCardAction(
  value: unknown,
): RoutineCardActionPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v['kind'] !== ROUTINE_CARD_ACTION_KIND) return null;
  const action = v['action'];
  const id = v['id'];
  if (
    action !== 'pause' &&
    action !== 'resume' &&
    action !== 'trigger_now' &&
    action !== 'delete'
  ) {
    return null;
  }
  if (typeof id !== 'string' || id.length === 0) return null;
  return { kind: ROUTINE_CARD_ACTION_KIND, action, id };
}

function escapeMarkdown(text: string): string {
  // Adaptive Cards support a Markdown subset; we escape the chars that
  // would break the routine name display (asterisks, underscores) but
  // leave everything else through.
  return text.replace(/([*_])/g, '\\$1');
}

// -----------------------------------------------------------------------------
// Routine LIST smart card
// -----------------------------------------------------------------------------

/**
 * Submit-value kind sent when the user clicks one of the filter pills
 * (Alle / Aktiv / Pausiert) on the list card. The bot intercepts and
 * re-invokes `manage_routine.list` with the new filter value so the card
 * re-renders in place.
 */
export const ROUTINE_LIST_FILTER_KIND = 'routine.list.filter';

export type RoutineListFilter = 'all' | 'active' | 'paused';

export interface RoutineListFilterPayload {
  kind: typeof ROUTINE_LIST_FILTER_KIND;
  filter: RoutineListFilter;
}

export interface RoutineRowSummary {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  status: 'active' | 'paused';
  lastRunAt: string | null;
  lastRunStatus: 'ok' | 'error' | 'timeout' | null;
}

export interface BuildRoutineListSmartCardInput {
  filter: RoutineListFilter;
  totals: { all: number; active: number; paused: number };
  routines: RoutineRowSummary[];
}

/**
 * Adaptive Card with a row per routine. Each row renders status badge,
 * cron, last-run snippet, and three Action.Submit buttons (Pause/Resume
 * is mutually exclusive based on current status; Löschen is always
 * present). A header pill carries the totals + three filter buttons.
 *
 * Rendered for the `manage_routine.list` sidecar — the natural-language
 * answer narrates around the card (e.g. "Hier sind deine 3 Routinen").
 */
export function buildRoutineListSmartCard(
  input: BuildRoutineListSmartCardInput,
): unknown {
  const { filter, totals, routines } = input;

  const filterButton = (label: string, value: RoutineListFilter): unknown => ({
    type: 'Action.Submit',
    title:
      filter === value
        ? `● ${label}` // dot indicates active filter
        : label,
    data: {
      kind: ROUTINE_LIST_FILTER_KIND,
      filter: value,
    } satisfies RoutineListFilterPayload,
  });

  const headerBlock = {
    type: 'Container',
    style: 'emphasis',
    bleed: true,
    items: [
      {
        type: 'TextBlock',
        text: '🕒 Routinen',
        weight: 'Bolder',
        size: 'Medium',
        color: 'Accent',
      },
      {
        type: 'TextBlock',
        text: `${totals.all} gesamt · ${totals.active} aktiv · ${totals.paused} pausiert`,
        size: 'Small',
        color: 'Default',
        spacing: 'None',
      },
    ],
  };

  const filterRow = {
    type: 'ActionSet',
    actions: [
      filterButton('Alle', 'all'),
      filterButton('Aktiv', 'active'),
      filterButton('Pausiert', 'paused'),
    ],
  };

  const rowBlocks = routines.map((r) => buildRoutineRow(r));

  const emptyState =
    routines.length === 0
      ? [
          {
            type: 'TextBlock',
            text:
              filter === 'all'
                ? 'Noch keine Routinen angelegt. Sag mir z.B. „erinnere mich jeden Montag um 9 Uhr an X" und ich lege eine an.'
                : `Keine Routinen mit Status „${filter}". Wechsle den Filter oben.`,
            wrap: true,
            color: 'Default',
            isSubtle: true,
            spacing: 'Medium',
          },
        ]
      : [];

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body: [headerBlock, filterRow, ...emptyState, ...rowBlocks],
  };
}

function buildRoutineRow(r: RoutineRowSummary): unknown {
  const statusColor = r.status === 'active' ? 'Good' : 'Warning';
  const statusLabel = r.status === 'active' ? 'aktiv' : 'pausiert';
  const lastRun = formatLastRun(r);

  const toggleAction =
    r.status === 'active'
      ? {
          type: 'Action.Submit',
          title: 'Pausieren',
          data: {
            kind: ROUTINE_CARD_ACTION_KIND,
            action: 'pause',
            id: r.id,
          } satisfies RoutineCardActionPayload,
        }
      : {
          type: 'Action.Submit',
          title: 'Aktivieren',
          style: 'positive',
          data: {
            kind: ROUTINE_CARD_ACTION_KIND,
            action: 'resume',
            id: r.id,
          } satisfies RoutineCardActionPayload,
        };

  return {
    type: 'Container',
    separator: true,
    spacing: 'Medium',
    items: [
      {
        type: 'ColumnSet',
        columns: [
          {
            type: 'Column',
            width: 'stretch',
            items: [
              {
                type: 'TextBlock',
                text: escapeMarkdown(r.name),
                weight: 'Bolder',
                size: 'Default',
                wrap: true,
              },
              {
                type: 'TextBlock',
                text: `\`${r.cron}\` · ${truncate(r.prompt, 80)}`,
                size: 'Small',
                color: 'Default',
                isSubtle: true,
                wrap: true,
                spacing: 'None',
              },
              {
                type: 'TextBlock',
                text: lastRun,
                size: 'Small',
                color: 'Default',
                isSubtle: true,
                spacing: 'None',
              },
            ],
          },
          {
            type: 'Column',
            width: 'auto',
            verticalContentAlignment: 'Center',
            items: [
              {
                type: 'TextBlock',
                text: statusLabel.toUpperCase(),
                weight: 'Bolder',
                size: 'Small',
                color: statusColor,
                horizontalAlignment: 'Right',
              },
            ],
          },
        ],
      },
      {
        type: 'ActionSet',
        actions: [
          {
            type: 'Action.Submit',
            title: 'Jetzt',
            data: {
              kind: ROUTINE_CARD_ACTION_KIND,
              action: 'trigger_now',
              id: r.id,
            } satisfies RoutineCardActionPayload,
          },
          toggleAction,
          {
            type: 'Action.Submit',
            title: 'Löschen',
            style: 'destructive',
            data: {
              kind: ROUTINE_CARD_ACTION_KIND,
              action: 'delete',
              id: r.id,
            } satisfies RoutineCardActionPayload,
          },
        ],
      },
    ],
  };
}

function formatLastRun(r: RoutineRowSummary): string {
  if (!r.lastRunAt) return 'Noch nie gelaufen';
  const date = new Date(r.lastRunAt);
  const formatted = isNaN(date.getTime())
    ? r.lastRunAt
    : date.toLocaleString('de-DE', {
        timeZone: 'Europe/Berlin',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
  const statusEmoji =
    r.lastRunStatus === 'ok'
      ? '✅'
      : r.lastRunStatus === 'error'
        ? '❌'
        : r.lastRunStatus === 'timeout'
          ? '⏱'
          : '·';
  return `Zuletzt: ${formatted} ${statusEmoji}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Type guard for the filter-pill click payload. Mirror of
 * `parseRoutineCardAction` for the list-filter variant.
 */
export function parseRoutineListFilter(
  value: unknown,
): RoutineListFilterPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v['kind'] !== ROUTINE_LIST_FILTER_KIND) return null;
  const filter = v['filter'];
  if (filter !== 'all' && filter !== 'active' && filter !== 'paused') {
    return null;
  }
  return { kind: ROUTINE_LIST_FILTER_KIND, filter };
}
