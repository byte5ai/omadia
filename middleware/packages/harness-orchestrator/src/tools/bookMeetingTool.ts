import { z } from 'zod';
import {
  isConsentRequiredError,
  isSsoUnavailableError,
  type GraphOboClient,
  type GraphCalendarClient,
  type SlotCacheAccessor,
} from '../microsoft365-shim.js';
import type { TurnAuthContext } from './findFreeSlotsTool.js';

export const BOOK_MEETING_TOOL_NAME = 'book_meeting';

const SUBJECT_MAX = 200;
const BODY_MAX = 10_000;
const LOCATION_MAX = 200;

const BookMeetingInputSchema = z.object({
  /** Opaque id from a prior `find_free_slots` call. */
  slotId: z.string().min(1).max(64),
  subject: z.string().min(1).max(SUBJECT_MAX),
  /** Optional HTML body. Plain text also works — Graph preserves it. */
  bodyHtml: z.string().max(BODY_MAX).optional(),
  location: z.string().max(LOCATION_MAX).optional(),
  /** Default true — most internal meetings want a Teams link. */
  createTeamsMeeting: z.boolean().default(true),
  /**
   * Override the attendees baked into the cached slot. Default: reuse the
   * list from `find_free_slots`. Useful when the user wants to *add* a
   * person to a slot that was computed for a smaller group.
   */
  additionalAttendees: z.array(z.string().email()).max(20).optional(),
});

export type BookMeetingInput = z.infer<typeof BookMeetingInputSchema>;

export const bookMeetingToolSpec = {
  name: BOOK_MEETING_TOOL_NAME,
  description:
    'Erstellt einen Kalendereintrag im M365-Kalender des Users für einen zuvor via `find_free_slots` gefundenen Slot. Optional mit Teams-Meeting-Link. Der User muss den Slot explizit gewählt haben (Klick auf Slot-Card ODER namentlich im Chat bestätigt) — niemals ohne Bestätigung buchen.\n' +
    '\n' +
    '**Wann nutzen:**\n' +
    '- User hat einen Slot aus `find_free_slots` gewählt (Klick oder Chat-Bestätigung).\n' +
    '\n' +
    '**Wann NICHT nutzen:**\n' +
    '- Ohne vorherigen `find_free_slots`-Call — du hast keinen gültigen `slotId`.\n' +
    '- Wenn der User zögert oder unsicher ist — stell lieber nochmal eine Rückfrage.\n' +
    '\n' +
    '**Regeln:**\n' +
    '- `slotId` muss aus einem `find_free_slots`-Call derselben Session stammen (max 15 min alt).\n' +
    '- `subject` ist Pflicht — formuliere ihn aus dem User-Intent, nicht generisch.\n' +
    '- Nach dem Buchen ist der Slot verbraucht — ein zweiter Call mit derselben `slotId` schlägt fehl.',
  input_schema: {
    type: 'object' as const,
    properties: {
      slotId: { type: 'string', description: 'Opaque id aus find_free_slots.' },
      subject: { type: 'string', maxLength: SUBJECT_MAX },
      bodyHtml: { type: 'string', maxLength: BODY_MAX },
      location: { type: 'string', maxLength: LOCATION_MAX },
      createTeamsMeeting: { type: 'boolean' },
      additionalAttendees: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 20,
        description: 'Zusätzliche Emails — optional. Default: Teilnehmer aus find_free_slots.',
      },
    },
    required: ['slotId', 'subject'],
  },
};

export class BookMeetingTool {
  private turnCtx: TurnAuthContext | undefined;
  private consentRequired = false;

  constructor(
    private readonly oboClient: GraphOboClient,
    private readonly calendar: GraphCalendarClient,
    private readonly slotCache: SlotCacheAccessor,
  ) {}

  setTurnContext(ctx: TurnAuthContext): void {
    this.turnCtx = ctx;
  }

  clearTurnContext(): void {
    this.turnCtx = undefined;
    this.consentRequired = false;
  }

  /** See `FindFreeSlotsTool.takeConsentRequired`. */
  takeConsentRequired(): boolean {
    const c = this.consentRequired;
    this.consentRequired = false;
    return c;
  }

  async handle(input: unknown): Promise<string> {
    const parsed = BookMeetingInputSchema.safeParse(input);
    if (!parsed.success) {
      return errorJson(
        'invalid_input',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    console.error(
      `[calendar] book_meeting called slotId=${parsed.data.slotId} sso=${this.turnCtx ? 'yes' : 'no'}`,
    );
    if (!this.turnCtx) {
      this.consentRequired = true;
      return errorJson('sso_unavailable', 'Kein SSO-Token verfügbar. OAuthCard wird angezeigt.');
    }

    const { slotId, subject, bodyHtml, location, createTeamsMeeting, additionalAttendees } = parsed.data;

    const slot = this.slotCache.get(slotId);
    if (!slot) {
      console.error(`[calendar] book_meeting slot_expired_or_unknown slotId=${slotId}`);
      return errorJson(
        'slot_expired_or_unknown',
        'Dieser Slot ist abgelaufen oder wurde nie erzeugt. Ruf find_free_slots erneut auf.',
      );
    }

    const attendees = uniqEmails([...slot.attendees, ...(additionalAttendees ?? [])]);

    let accessToken: string;
    try {
      accessToken = await this.oboClient.acquireTokenForUser(this.turnCtx.ssoAssertion);
    } catch (err) {
      if (isConsentRequiredError(err)) {
        console.error('[calendar] book_meeting consent_required');
        this.consentRequired = true;
        return errorJson('consent_required', 'Der User muss erst den Kalender-Zugriff autorisieren.');
      }
      if (isSsoUnavailableError(err)) {
        this.consentRequired = true;
        return errorJson('sso_unavailable', 'Kein SSO-Token verfügbar. OAuthCard wird angezeigt.');
      }
      console.error('[calendar] book_meeting auth_failed:', toErrMsg(err));
      return errorJson('auth_failed', toErrMsg(err));
    }

    try {
      console.error('[calendar] book_meeting calling Graph createEvent');
      const event = await this.calendar.createEvent({
        accessToken,
        subject,
        start: slot.start,
        end: slot.end,
        ...(slot.timeZone ? { timeZone: slot.timeZone } : {}),
        attendees: attendees.map((email) => ({ email, type: 'required' })),
        ...(bodyHtml ? { bodyHtml } : {}),
        ...(location ? { location } : {}),
        createTeamsMeeting,
      });
      // Consume only on success so a transient Graph 5xx keeps the slot
      // available for a retry by the LLM.
      this.slotCache.consume(slotId);
      console.error(`[calendar] book_meeting created eventId=${event.id}`);
      return JSON.stringify({
        status: 'booked',
        eventId: event.id,
        webLink: event.webLink,
        subject: event.subject,
        start: event.start,
        end: event.end,
        ...(event.onlineMeetingJoinUrl ? { teamsJoinUrl: event.onlineMeetingJoinUrl } : {}),
        attendees,
      });
    } catch (err) {
      console.error('[calendar] book_meeting create_event_failed:', toErrMsg(err));
      return errorJson('create_event_failed', toErrMsg(err));
    }
  }
}

function errorJson(code: string, message: string): string {
  return JSON.stringify({ status: 'error', code, message });
}

function toErrMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function uniqEmails(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
