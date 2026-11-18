// Facilitation contracts shared between the kernel, the facilitation engine
// plugin and integration plugins (#2043).

/**
 * Manifest capability a plugin declares under `provides` to be the instance's
 * facilitation engine. A facilitator-kind agent gets exactly the tools of the
 * one active plugin providing it; every other grant is refused by the kernel.
 */
export const FACILITATION_ENGINE_CAPABILITY = 'facilitationEngine@1';

/**
 * Follow-up operations for a closed facilitation ('facilitation.followup@1',
 * #2078): the only reach a facilitator has into mail and calendars. Published
 * by an integration plugin (M365 connector first), consumed by the engine.
 *
 * Every call carries the people it may touch. The provider refuses anyone
 * outside `allowed` and never reads mailbox or calendar contents.
 */
export const FACILITATION_FOLLOWUP_SERVICE_NAME = 'facilitation.followup';

export interface FollowupGrant {
  /** The facilitation the grant belongs to, for the provider's audit trail. */
  facilitationId: string;
  /** Mail addresses of participants and confirmed stakeholders. */
  allowed: readonly string[];
}

export type FollowupRefusal = {
  outcome: 'refused';
  code: 'recipient_not_allowed' | 'not_configured' | 'provider_error';
  message: string;
  /** The addresses that were outside the grant. */
  rejected?: readonly string[];
};

export interface FacilitationFollowupService {
  /** Busy intervals only; no subject, body, location or attendees. */
  freeBusy(
    grant: FollowupGrant,
    request: { attendees: readonly string[]; from: string; to: string },
  ): Promise<
    | {
        outcome: 'ok';
        busy: readonly { attendee: string; intervals: readonly { start: string; end: string }[] }[];
      }
    | FollowupRefusal
  >;
  createInvitation(
    grant: FollowupGrant,
    request: {
      attendees: readonly string[];
      subject: string;
      start: string;
      end: string;
      /** Agenda and protocol link, as agreed by the group. */
      body: string;
      online?: boolean;
    },
  ): Promise<{ outcome: 'created'; eventId: string; joinUrl?: string } | FollowupRefusal>;
  sendMail(
    grant: FollowupGrant,
    request: { recipients: readonly string[]; subject: string; body: string },
  ): Promise<{ outcome: 'sent' } | FollowupRefusal>;
}
