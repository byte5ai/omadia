/**
 * #2078 (spec 2043 §5.11) — kernel-issued grants for mail and calendar.
 *
 * An archetype agent holds no business capabilities. Three narrow ones exist
 * for closing and following up a process, each bound to ONE execution scope
 * (#2090) and to named recipients:
 *
 *   protocol_dispatch    under a `closing` scope: send that protocol by mail
 *   followup_scheduling  under a `scheduling` scope: free/busy and the
 *                        invitations of that one meeting
 *   followup_reminders   under a `follow_up` scope: reminders by mail
 *
 * Two services, for two parties:
 *  - the plugin that runs the process ISSUES and revokes grants
 *    ({@link ExecutionGrantsService}, `executionGrants`);
 *  - the integration that sends (the M365 connector) asks the kernel before
 *    EVERY operation whether the grant covers it
 *    ({@link GrantVerificationService}, `grantVerification`), and keeps its
 *    own recipient check as a second line.
 *
 * A grant is live only while its scope is: ending the scope (stop, abort,
 * end of service, uninstall of the plugin) ends its grants with it.
 */

import type { ExecutionRefusal } from './executionAuthorization.js';

export const EXECUTION_GRANTS_SERVICE_NAME = 'executionGrants';
export const GRANT_VERIFICATION_SERVICE_NAME = 'grantVerification';

export type ExecutionGrantKind = 'protocol_dispatch' | 'followup_scheduling' | 'followup_reminders';

/** What an integration may do under a grant. */
export type GrantOperation = 'send_mail' | 'free_busy' | 'create_invitation';

/** Which operations a kind covers, and under which scope kind it is issued. */
export const EXECUTION_GRANT_RULES: Readonly<
  Record<ExecutionGrantKind, { readonly scope: 'closing' | 'scheduling' | 'follow_up'; readonly operations: readonly GrantOperation[] }>
> = {
  protocol_dispatch: { scope: 'closing', operations: ['send_mail'] },
  followup_scheduling: { scope: 'scheduling', operations: ['free_busy', 'create_invitation'] },
  followup_reminders: { scope: 'follow_up', operations: ['send_mail'] },
};

export interface ExecutionGrant {
  readonly id: string;
  readonly scopeId: string;
  readonly processId: string;
  readonly kind: ExecutionGrantKind;
  /** The protocol document or the agreed meeting; `''` when the kind has one
   *  grant per scope. */
  readonly subject: string;
  /** Mail addresses, lower-cased. */
  readonly recipients: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
  readonly revokeReason?: string;
  /** Live right now: scope open and inside its deadline, not expired, not
   *  revoked. (An operator stop refuses the use, it does not end the grant.) */
  readonly live: boolean;
}

export interface IssueGrantRequest {
  readonly scopeId: string;
  readonly kind: ExecutionGrantKind;
  readonly subject?: string;
  /** Mail addresses the grant covers. Replaced by a later call for the same
   *  scope, kind and subject while the grant is live. */
  readonly recipients: readonly string[];
  /** ISO time; at most the scope's deadline, and for `protocol_dispatch` at
   *  most 7 days from now (spec 2043 §5.11). Absent: that maximum. */
  readonly expiresAt?: string;
}

export interface ExecutionGrantsService {
  /** Issue a grant under one of the caller's scopes, or replace the
   *  recipients of the live one for the same scope, kind and subject. */
  issueGrant(request: IssueGrantRequest): Promise<{ outcome: 'issued'; grant: ExecutionGrant } | ExecutionRefusal>;
  /** Revoke a grant now (its sends are confirmed, the invitations are out).
   *  Idempotent; a revoked grant is never live again. */
  revokeGrant(grantId: string, reason: string): Promise<void>;
  /** The grants of one of the caller's processes, with what was done under
   *  each (for the protocol's list of uses). */
  listGrants(processId: string): Promise<readonly (ExecutionGrant & { readonly uses: readonly ExecutionGrantUse[] })[]>;
}

export interface ExecutionGrantUse {
  readonly operation: GrantOperation;
  readonly recipients: readonly string[];
  readonly askedBy: string;
  readonly allowed: boolean;
  readonly refusal?: GrantRefusalCode;
  readonly usedAt: string;
}

export type GrantRefusalCode =
  | 'unknown_grant'
  | 'revoked'
  | 'expired'
  | 'scope_ended'
  | 'kill_switch'
  | 'operation_not_covered'
  | 'recipient_not_covered'
  | 'invalid_request'
  | 'unavailable';

export interface GrantVerificationRequest {
  readonly grantId: string;
  readonly operation: GrantOperation;
  /** Everybody the operation would reach (mail recipients, invitees, the
   *  people whose free/busy is read). All of them must be covered. */
  readonly recipients: readonly string[];
}

export type GrantVerificationOutcome =
  | { readonly allowed: true; readonly kind: ExecutionGrantKind; readonly processId: string }
  | { readonly allowed: false; readonly code: GrantRefusalCode; readonly message: string; readonly notCovered?: readonly string[] };

export interface GrantVerificationService {
  /** Asked before every operation. Every answer, allowed or refused, is
   *  recorded as a use of the grant. */
  verify(request: GrantVerificationRequest): Promise<GrantVerificationOutcome>;
}
