import { z } from 'zod';
import {
  isConsentRequiredError,
  isSsoUnavailableError,
  type GraphOboClient,
  type GraphCalendarClient,
  type MeetingSlotSuggestion,
  type ScheduleEntry,
  type CachedSlot,
  type SlotCacheAccessor,
} from '../microsoft365-shim.js';

export const FIND_FREE_SLOTS_TOOL_NAME = 'find_free_slots';

const ATTENDEE_MAX = 20;
const DURATION_MIN = 15;
const DURATION_MAX = 480;
const WINDOW_DAYS_MAX = 14;
const MAX_SUGGESTIONS = 8;

const FindFreeSlotsInputSchema = z.object({
  /**
   * Whose calendar serves as the slot source (host / meeting organizer).
   *
   * - **Unset / empty** → caller themself (default; "I offer X suggestions").
   * - **Other email** → that person's calendar ("Teresita, find a meeting
   *   with John" → hostEmail=info@omadia.ai). Caller needs
   *   `Calendars.Read.Shared` visibility on the host; otherwise 403 is returned.
   */
  hostEmail: z.string().email().optional(),
  /**
   * Optional attendee emails. The slot search does *not* run against their
   * calendars — they are only invited as meeting-invitees on `book_meeting`.
   * The host is added automatically.
   */
  attendees: z.array(z.string().email()).max(ATTENDEE_MAX).default([]),
  durationMinutes: z.number().int().min(DURATION_MIN).max(DURATION_MAX),
  /** ISO-8601. If empty: from now. */
  windowStart: z.string().datetime({ offset: true }).optional(),
  /** Days after windowStart. Default 5. */
  windowDays: z.number().int().min(1).max(WINDOW_DAYS_MAX).default(5),
  /** Default true — uses the working hours from mailboxSettings. */
  preferWorkingHours: z.boolean().default(true),
  maxSuggestions: z.number().int().min(1).max(MAX_SUGGESTIONS).default(5),
  /** 0–100. Default 100 (only slots in which *all* required attendees are free). */
  minimumAttendeePercentage: z.number().int().min(0).max(100).default(100),
});

export type FindFreeSlotsInput = z.infer<typeof FindFreeSlotsInputSchema>;

export interface PendingSlotCard {
  question: string;
  subjectHint?: string;
  slots: Array<{
    slotId: string;
    start: string;
    end: string;
    timeZone: string;
    label: string;
    confidence: number;
  }>;
}

export interface TurnAuthContext {
  /** Teams SSO assertion (JWT) for the current user. */
  ssoAssertion: string;
  /** IANA TZ. Pre-fetched by the bot handler to keep the tool fast. */
  userTimeZone?: string;
}

export const findFreeSlotsToolSpec = {
  name: FIND_FREE_SLOTS_TOOL_NAME,
  description:
    'Findet freie Terminslots im Kalender des Users und der genannten Teilnehmer via Microsoft Graph `findMeetingTimes`. Liefert bis zu N Top-Vorschläge mit Start/End/Confidence. Rendert anschließend eine Adaptive Card mit klickbaren Slot-Buttons — der User wählt per Klick, was einen `book_meeting`-Call im nächsten Turn auslöst.\n' +
    '\n' +
    '**Wann nutzen:**\n' +
    '- User möchte Termin/Meeting buchen und nennt Teilnehmer (Email/UPN).\n' +
    '- User fragt nach Verfügbarkeit (z.B. "wann hat Max Zeit für 30 min diese Woche?").\n' +
    '\n' +
    '**Wann NICHT nutzen:**\n' +
    '- User nennt keine konkreten Teilnehmer oder Dauer → zuerst klären (normale Rückfrage oder `ask_user_choice`).\n' +
    '- User will einen *existierenden* Termin ansehen — das ist eine andere Operation (nicht implementiert).\n' +
    '\n' +
    '**Regeln:**\n' +
    '- Slot-Suche läuft gegen den Kalender des **Hosts** (Meeting-Organizers). Standard = Caller selbst. Nur wenn der Caller explizit im Auftrag einer anderen Person sucht ("such Termin bei John", "bei der Geschäftsführung"), setz `hostEmail` auf dessen Email.\n' +
    '- `attendees` sind die einzuladenden Personen (ohne Host). Email-Adressen oder UPNs — keine Namen. Wenn der User Namen nennt, erst auflösen. Leer erlaubt ("nur mein Kalender anzeigen").\n' +
    '- `durationMinutes` 15–480. Typisch 30/45/60.\n' +
    '- `windowDays` 1–14. Default 5.\n' +
    '- Ein `find_free_slots`-Call pro Turn. Die Card ist sidecar — du kannst normal weiterantworten.',
  input_schema: {
    type: 'object' as const,
    properties: {
      hostEmail: {
        type: 'string',
        description:
          'Email/UPN des Meeting-Hosts (wessen Kalender die Slots liefert). Leer lassen wenn der Caller selbst der Host ist ("ich biete an"); setzen wenn der Caller im Auftrag einer anderen Person Slots sucht ("such bei John Termin" → hostEmail=info@omadia.ai).',
      },
      attendees: {
        type: 'array',
        minItems: 0,
        maxItems: ATTENDEE_MAX,
        items: { type: 'string', description: 'Email oder UPN der einzuladenden Teilnehmer (ohne Host).' },
      },
      durationMinutes: {
        type: 'integer',
        minimum: DURATION_MIN,
        maximum: DURATION_MAX,
      },
      windowStart: { type: 'string', description: 'ISO-8601 mit Offset. Default: jetzt.' },
      windowDays: {
        type: 'integer',
        minimum: 1,
        maximum: WINDOW_DAYS_MAX,
        description: 'Tage nach windowStart. Default 5.',
      },
      preferWorkingHours: { type: 'boolean' },
      maxSuggestions: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_SUGGESTIONS,
      },
      minimumAttendeePercentage: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description: 'Default 100 (alle Required frei). 50 = "most of the room".',
      },
    },
    required: ['durationMinutes'],
  },
};

export class FindFreeSlotsTool {
  private turnCtx: TurnAuthContext | undefined;
  private pendingCard: PendingSlotCard | undefined;
  private consentRequired = false;

  constructor(
    private readonly oboClient: GraphOboClient,
    private readonly calendar: GraphCalendarClient,
    private readonly slotCache: SlotCacheAccessor,
  ) {}

  /** Called by the orchestrator at the start of each turn. */
  setTurnContext(ctx: TurnAuthContext): void {
    this.turnCtx = ctx;
  }

  clearTurnContext(): void {
    this.turnCtx = undefined;
    this.pendingCard = undefined;
    this.consentRequired = false;
  }

  /**
   * Return whether the last handle() invocation hit a `consent_required`
   * AAD error. Idempotent — second call in the same turn returns false.
   * Orchestrator drains this after the tool loop; the Teams adapter then
   * renders an OAuthCard sidecar so the user can consent in one click.
   */
  takeConsentRequired(): boolean {
    const c = this.consentRequired;
    this.consentRequired = false;
    return c;
  }

  async handle(input: unknown): Promise<string> {
    const parsed = FindFreeSlotsInputSchema.safeParse(input);
    if (!parsed.success) {
      return errorJson('invalid_input', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }
    console.error(
      `[calendar] find_free_slots called attendees=${parsed.data.attendees.join(',')} duration=${parsed.data.durationMinutes}min windowDays=${parsed.data.windowDays} sso=${this.turnCtx ? 'yes' : 'no'}`,
    );
    if (!this.turnCtx) {
      // No SSO assertion in scope. Treat as "consent needed" so the Teams
      // adapter can render an OAuthCard — otherwise a first-time user would
      // just see prose without any clickable path to sign in.
      this.consentRequired = true;
      return errorJson('sso_unavailable', 'Kein SSO-Token verfügbar. OAuthCard wird angezeigt.');
    }

    const { attendees, hostEmail, durationMinutes, windowDays, maxSuggestions } = parsed.data;
    const windowStart = parsed.data.windowStart ?? new Date().toISOString();
    const windowEnd = new Date(Date.parse(windowStart) + windowDays * 24 * 3600 * 1000).toISOString();
    const tz = this.turnCtx.userTimeZone;

    let accessToken: string;
    try {
      accessToken = await this.oboClient.acquireTokenForUser(this.turnCtx.ssoAssertion);
    } catch (err) {
      if (isConsentRequiredError(err)) {
        console.error('[calendar] find_free_slots consent_required');
        this.consentRequired = true;
        return errorJson('consent_required', 'Der User muss erst den Kalender-Zugriff autorisieren. Ein OAuth-Sign-In-Button wird angezeigt.');
      }
      if (isSsoUnavailableError(err)) {
        this.consentRequired = true;
        return errorJson('sso_unavailable', 'Kein SSO-Token verfügbar. OAuthCard wird angezeigt.');
      }
      console.error('[calendar] find_free_slots auth_failed:', toErrMsg(err));
      return errorJson('auth_failed', toErrMsg(err));
    }

    let suggestions: MeetingSlotSuggestion[];
    let host: string;
    try {
      host = hostEmail ?? (await this.calendar.getSelfAddress(accessToken));
      console.error(`[calendar] find_free_slots host=${host} calling Graph getSchedule`);
      const schedule = await this.calendar.getSchedule({
        accessToken,
        users: [host],
        windowStart,
        windowEnd,
        availabilityViewInterval: 30,
        ...(tz ? { timeZone: tz } : {}),
      });
      suggestions = deriveSlotsFromSchedule({
        schedule,
        windowStart,
        durationMinutes,
        maxSuggestions,
        // Single-host query → 100 % means "the host must be free".
        minimumAttendeePercentage: 100,
        timeZone: tz ?? 'UTC',
      });
    } catch (err) {
      console.error('[calendar] find_free_slots graph_error:', describeGraphErr(err));
      return errorJson('graph_error', describeGraphErr(err));
    }
    console.error(`[calendar] find_free_slots returned ${String(suggestions.length)} suggestions`);

    if (suggestions.length === 0) {
      this.pendingCard = undefined;
      return JSON.stringify({
        status: 'no_slots_found',
        attendees,
        window: { start: windowStart, end: windowEnd },
        hint: 'Keine gemeinsamen Slots gefunden. Vorschlag: weiter gefasstes Fenster oder minimumAttendeePercentage senken.',
      });
    }

    // Store the host + attendees together — `book_meeting` pulls this
    // unchanged as the invite list, so the host is always in the meeting.
    const inviteList = dedupEmails([host, ...attendees]);
    const cached: CachedSlot[] = suggestions.map((s) =>
      this.slotCache.put({
        start: s.start,
        end: s.end,
        attendees: inviteList,
        ...(s.timeZone ? { timeZone: s.timeZone } : {}),
        confidence: s.confidence,
      }),
    );

    this.pendingCard = {
      question: `${suggestions.length} freie Termine gefunden — bitte wählen:`,
      slots: cached.map((c, idx) => {
        const sug = suggestions[idx];
        return {
          slotId: c.slotId,
          start: c.start,
          end: c.end,
          timeZone: c.timeZone ?? 'UTC',
          label: formatSlotLabel(c.start, c.end, c.timeZone ?? 'UTC'),
          confidence: sug?.confidence ?? 0,
        };
      }),
    };

    return JSON.stringify({
      status: 'slots_found',
      count: cached.length,
      slots: cached.map((c, idx) => {
        const sug = suggestions[idx];
        return {
          slotId: c.slotId,
          start: c.start,
          end: c.end,
          timeZone: c.timeZone,
          confidence: sug?.confidence ?? 0,
          attendees: sug?.attendees ?? [],
          ...(sug?.reason ? { reason: sug.reason } : {}),
        };
      }),
      note:
        'Eine Slot-Picker-Card wird unter deiner Antwort gerendert. Du kannst die Slots in natürlicher Sprache zusammenfassen; der User wählt per Klick.',
    });
  }

  takePendingCard(): PendingSlotCard | undefined {
    const p = this.pendingCard;
    this.pendingCard = undefined;
    return p;
  }
}

function dedupEmails(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const key = raw.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function errorJson(code: string, message: string): string {
  return JSON.stringify({ status: 'error', code, message });
}

function toErrMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Graph Client errors are plain objects with `statusCode`, `code`, `message`,
 * `body`, `requestId` fields. `err.message` alone is often empty, so we dump
 * the diagnostic fields that actually identify the failure.
 */
function describeGraphErr(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err);
  const e = err as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof e['statusCode'] === 'number') parts.push(`status=${String(e['statusCode'])}`);
  if (typeof e['code'] === 'string' && e['code']) parts.push(`code=${e['code']}`);
  if (typeof e['message'] === 'string' && e['message']) parts.push(`msg=${e['message']}`);
  if (typeof e['requestId'] === 'string' && e['requestId']) parts.push(`reqId=${e['requestId']}`);
  if (e['body']) {
    try {
      const bodyStr = typeof e['body'] === 'string' ? e['body'] : JSON.stringify(e['body']);
      parts.push(`body=${bodyStr.slice(0, 500)}`);
    } catch {
      /* ignore */
    }
  }
  if (parts.length === 0) return String(err);
  return parts.join(' ');
}

/**
 * Render a slot as a compact human-readable label for Adaptive Card buttons.
 * Uses the browser/runtime's Intl support; falls back to raw ISO if the
 * slot's timeZone isn't resolvable. Kept deliberately short (≤40 chars) to
 * fit Teams' button width on desktop and mobile.
 */
/**
 * Derive free slots from Graph's `getSchedule` availabilityView strings.
 *
 * Each user's `availabilityView` is a dense string where position `i`
 * represents the 30-minute slot starting at `windowStart + i*30min`, with:
 *   `0` = free, `1` = tentative, `2` = busy, `3` = oof,
 *   `4` = workingElsewhere.
 *
 * We find contiguous runs of `0` (or `0`+`1` below a strictness threshold)
 * where *enough* users are free to meet `minimumAttendeePercentage`, then
 * slide a window of the requested meeting duration across those runs to
 * emit candidate slots. First run gets the highest confidence; we degrade
 * linearly after that to give the Teams card sensible ordering.
 *
 * Why this path instead of `findMeetingTimes`: Graph's `findMeetingTimes`
 * endpoint returns `500 UnknownError` with an empty message on edge-cases
 * that `getSchedule` just handles gracefully (attendee without visible
 * free/busy → the slot is dropped, not an outright failure).
 */
interface DeriveSlotsArgs {
  schedule: ScheduleEntry[];
  windowStart: string;
  durationMinutes: number;
  maxSuggestions: number;
  minimumAttendeePercentage: number;
  timeZone: string;
}

function deriveSlotsFromSchedule(args: DeriveSlotsArgs): MeetingSlotSuggestion[] {
  const INTERVAL_MIN = 30;
  const slotsPerMeeting = Math.ceil(args.durationMinutes / INTERVAL_MIN);
  const requiredFreeUsers = Math.max(
    1,
    Math.ceil((args.schedule.length * args.minimumAttendeePercentage) / 100),
  );
  const views = args.schedule.map((s) => s.availabilityView ?? '');
  const maxLen = Math.max(0, ...views.map((v) => v.length));
  if (maxLen === 0) return [];

  const windowStartMs = Date.parse(args.windowStart);
  const out: MeetingSlotSuggestion[] = [];
  const emitted = new Set<number>();

  for (let i = 0; i <= maxLen - slotsPerMeeting; i++) {
    if (out.length >= args.maxSuggestions) break;
    // Stagger candidates by 1h to avoid 4×15min-apart slots. 2 = 2×30min.
    if (out.length > 0 && i - (emitted.values().next().value ?? 0) < 2) continue;

    let freeAcrossAll = true;
    let freeUsers = 0;
    for (const view of views) {
      let userFree = true;
      for (let k = 0; k < slotsPerMeeting; k++) {
        const ch = view[i + k];
        // Treat only `0` (free) as green; tentative/busy/oof/elsewhere all block.
        if (ch !== '0') {
          userFree = false;
          break;
        }
      }
      if (userFree) freeUsers++;
      else freeAcrossAll = false;
    }
    if (freeUsers < requiredFreeUsers) continue;

    const startMs = windowStartMs + i * INTERVAL_MIN * 60 * 1000;
    const endMs = startMs + args.durationMinutes * 60 * 1000;
    const start = new Date(startMs).toISOString();
    const end = new Date(endMs).toISOString();
    const confidence = freeAcrossAll
      ? 100 - out.length * 5
      : 80 - out.length * 5;

    out.push({
      start,
      end,
      timeZone: args.timeZone,
      confidence: Math.max(50, confidence),
      attendees: args.schedule.map((s) => ({
        email: s.user,
        availability: freeAcrossAll ? 'free' : 'partial',
      })),
    });
    emitted.add(i);
  }

  return out;
}

function formatSlotLabel(startIso: string, endIso: string, timeZone: string): string {
  try {
    const start = new Date(startIso);
    const end = new Date(endIso);
    const date = new Intl.DateTimeFormat('de-DE', {
      timeZone,
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
    }).format(start);
    const time = new Intl.DateTimeFormat('de-DE', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${date} ${time.format(start)}–${time.format(end)}`;
  } catch {
    return `${startIso} → ${endIso}`;
  }
}
