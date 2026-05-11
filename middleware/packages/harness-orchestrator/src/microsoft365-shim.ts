/**
 * Phase 5B: structural shims for the `@omadia/integration-microsoft365`
 * surface the orchestrator's calendar tools (FindFreeSlotsTool +
 * BookMeetingTool) consume. The actual integration plugin lives outside
 * this repo (`byte5ai/omadia-byte5-plugins`); the orchestrator stays
 * channel/integration-agnostic by typing against narrow shapes
 * structurally satisfied by the real plugin classes.
 *
 * Error names use duck-typing (`err.name === 'ConsentRequiredError'`)
 * instead of `instanceof`, so the orchestrator's `Error` shim and the
 * plugin's real class don't have to be the same JS object — only the
 * `name` field needs to match.
 */

export type AttendeeType = 'required' | 'optional' | 'resource';

export interface CachedSlot {
  slotId: string;
  start: string;
  end: string;
  attendees: string[];
  timeZone?: string;
  confidence?: number;
  expiresAt: number;
}

export interface SlotCacheAccessor {
  put(entry: Omit<CachedSlot, 'slotId' | 'expiresAt'>): CachedSlot;
  get(slotId: string): CachedSlot | undefined;
  consume(slotId: string): CachedSlot | undefined;
}

export interface MeetingSlotSuggestion {
  start: string;
  end: string;
  timeZone: string;
  confidence: number;
  attendees: Array<{ email: string; availability: string }>;
  reason?: string;
}

export interface ScheduleEntry {
  user: string;
  availabilityView: string;
  busy: Array<{ start: string; end: string; status: string }>;
}

export interface FindSlotsOptions {
  accessToken: string;
  attendees: Array<{ email: string; type?: AttendeeType }>;
  durationMinutes: number;
  windowStart?: string;
  windowEnd?: string;
  maxCandidates?: number;
  timeZone?: string;
  minimumAttendeePercentage?: number;
}

export interface GetScheduleOptions {
  accessToken: string;
  users: string[];
  windowStart: string;
  windowEnd: string;
  availabilityViewInterval?: number;
  timeZone?: string;
}

export interface CreateEventOptions {
  accessToken: string;
  subject: string;
  start: string;
  end: string;
  timeZone?: string;
  attendees: Array<{ email: string; type?: AttendeeType }>;
  bodyHtml?: string;
  location?: string;
  createTeamsMeeting?: boolean;
}

export interface CreatedEvent {
  id: string;
  webLink: string;
  onlineMeetingJoinUrl?: string;
  subject: string;
  start: string;
  end: string;
}

export interface GraphOboClient {
  acquireTokenForUser(ssoAssertion: string | undefined): Promise<string>;
}

export interface GraphCalendarClient {
  getSelfAddress(accessToken: string): Promise<string>;
  findMeetingTimes(opts: FindSlotsOptions): Promise<MeetingSlotSuggestion[]>;
  getSchedule(opts: GetScheduleOptions): Promise<ScheduleEntry[]>;
  createEvent(opts: CreateEventOptions): Promise<CreatedEvent>;
}

export class ConsentRequiredError extends Error {
  override readonly name = 'ConsentRequiredError';
  constructor(message?: string) {
    super(message ?? 'consent required');
  }
}

export class SsoUnavailableError extends Error {
  override readonly name = 'SsoUnavailableError';
  constructor(message?: string) {
    super(message ?? 'sso unavailable');
  }
}

/** Duck-typed catch-helper — works against the real plugin's class
 *  instances OR against this shim's own subclass instances. */
export function isConsentRequiredError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ConsentRequiredError';
}

export function isSsoUnavailableError(err: unknown): boolean {
  return err instanceof Error && err.name === 'SsoUnavailableError';
}

/**
 * Bundled accessor matching what the integration-microsoft365 plugin
 * publishes under `ctx.services.get('microsoft365.graph')`. Includes the
 * `app` field used by Teams attachment storage (kept generic — the
 * orchestrator never reads it). Plus the four sub-clients the calendar
 * tools consume.
 */
export interface Microsoft365Accessor {
  readonly app: unknown;
  readonly obo: GraphOboClient;
  readonly calendar: GraphCalendarClient;
  readonly slots: SlotCacheAccessor;
}
