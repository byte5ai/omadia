/**
 * #578 Phase 3 — keychain-asks: an agent requests a `personal` credential
 * from its owner; approval creates the grant.
 *
 * ## Why this is a NEW store, not `ConductorAwaitStore` reused
 *
 * The scoping prompt asks explicitly whether Conductor's await mechanism
 * (`middleware/src/conductor/awaitStore.ts` — TTL'd pending human actions,
 * `principal_kind`/`principal_ref`, atomic claim-then-act) "carries" this
 * before anything new gets built. It carries the PATTERN, not the table:
 * `conductor_awaits` is FK'd `NOT NULL` to `run_id`/`step_id` — every row
 * belongs to a workflow run and step. A keychain ask has neither; it is a
 * standalone request an agent makes mid-conversation, not a step inside a
 * Conductor workflow. Reusing the table would mean inventing a fake run and
 * step for every ask, which is not a reuse, it is a disguise.
 *
 * What DOES carry over, deliberately mirrored here:
 *  - a principal expressed as `(kind, ref)`, not a formatted string;
 *  - TTL evaluated against a caller-supplied `now`, not the row's own
 *    `now()` — the same #709/#710 anchor discipline `isGrantActive` already
 *    follows in `credentials.ts`;
 *  - "claim, then act": resolving an ask is one atomic UPDATE guarded by
 *    `WHERE status = 'pending'`, exactly like `ConductorAwaitStore.close`
 *    and `CredentialStore.markGrantConsumed` — the same defence against two
 *    concurrent approvals producing two grants.
 *
 * ## What this phase does NOT include
 *
 * Routing an ask into the requester's or owner's live chat thread requires
 * touching the orchestrator/channel messaging surface, which the binding
 * surface separation for this issue keeps out of reach (`agentBuilder.ts`,
 * existing skill routes). This phase delivers the full request → approve /
 * deny → grant lifecycle as a tested store + HTTP route; a human currently
 * discovers a pending ask by listing it (`listPendingForOwner`), not by
 * being pinged. Wiring that notification is a follow-up.
 *
 * ## #778 S1 — the rules both stores share
 *
 * An ask's owner is never the caller's say-so: it is DERIVED from the
 * credential's own `owner` ({@link resolveAskOwner}); a caller-supplied
 * owner is only checked against it (`owner_mismatch`). Askability
 * ({@link assertAskableCredential}) is enforced by BOTH stores at create
 * time — the Postgres store had drifted and only relied on the FK — and
 * re-checked at approve time: an ask created before its credential was
 * revoked closes as `expired` instead of minting a grant. Domain
 * rejections are {@link CredentialAskRejectedError}s with a typed
 * `reason`, so the route can tell a client mistake (400) from a store
 * failure (500) without matching message text.
 */

import {
  canonicalizePrincipalRef,
  principalRef,
  type Credential,
  type CredentialGrantMode,
  type CredentialId,
  type CredentialStore,
  type NewCredentialGrantInput,
  type Principal,
} from '@omadia/channel-sdk';

/** Why a store refused to create (or validate) an ask. */
export type CredentialAskRejection = 'invalid_input' | 'unknown_credential' | 'not_askable' | 'revoked' | 'owner_mismatch';

/**
 * A domain rejection — the caller asked for something the ask rules do not
 * allow. Anything else a store throws is an infrastructure failure.
 */
export class CredentialAskRejectedError extends Error {
  readonly reason: CredentialAskRejection;

  constructor(reason: CredentialAskRejection, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CredentialAskRejectedError';
    this.reason = reason;
  }
}

/** The credential facts the ask rules need — a full {@link Credential}
 *  satisfies it; the Postgres store selects just these columns. */
export type AskableCredentialFacts = Pick<Credential, 'id' | 'kind' | 'owner' | 'revokedAt'>;

export type CredentialAskId = string;

export type CredentialAskStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export const CREDENTIAL_ASK_STATUSES: readonly CredentialAskStatus[] = Object.freeze([
  'pending',
  'approved',
  'denied',
  'expired',
  'cancelled',
]);

export interface CredentialAsk {
  readonly id: CredentialAskId;
  readonly credentialId: CredentialId;
  /** Who wants to use the credential. */
  readonly requester: Principal;
  /** Who must approve — the credential's own owner at the time the ask was
   *  created. Captured on the ask rather than re-read from the credential at
   *  approval time, so a credential whose ownership later changes does not
   *  retroactively redirect who may answer an outstanding ask. */
  readonly owner: Principal;
  readonly purpose: string;
  /** What kind of grant approval would create. */
  readonly mode: CredentialGrantMode;
  /** Required when `mode` is `'once'` — mirrors `CredentialGrant`'s own
   *  invariant, see {@link validateNewAskInput}. */
  readonly requestedGrantExpiresAt?: Date;
  /** The ASK's own TTL — distinct from `requestedGrantExpiresAt`, which is
   *  the TTL of the grant approval would create. An unanswered ask must
   *  eventually stop being actionable even though nothing about the grant
   *  it would have created has anything to do with that. */
  readonly askExpiresAt: Date;
  readonly status: CredentialAskStatus;
  readonly createdAt: Date;
  readonly resolvedAt?: Date;
  readonly resolvedBy?: string;
  /** Set once `approve` succeeds. */
  readonly grantId?: string;
}

export interface NewCredentialAskInput {
  readonly credentialId: CredentialId;
  readonly requester: Principal;
  /** Optional since #778 S1: the stored owner is always the credential's
   *  own owner. When given, it must name that same principal, otherwise the
   *  store rejects with `owner_mismatch`. */
  readonly owner?: Principal;
  readonly purpose: string;
  readonly mode: CredentialGrantMode;
  readonly requestedGrantExpiresAt?: Date;
  readonly askExpiresAt: Date;
}

/**
 * Same two invariants `validateNewGrantInput` enforces for a grant, checked
 * again here because an ask's `mode`/`requestedGrantExpiresAt` pair becomes
 * a grant's `mode`/`expiresAt` pair verbatim on approval — an ask that
 * bypassed this would only fail later, at the point furthest from the
 * mistake.
 */
export function validateNewAskInput(input: NewCredentialAskInput): void {
  if (input.purpose.trim().length === 0) {
    throw new CredentialAskRejectedError('invalid_input', 'credential ask purpose must not be empty');
  }
  if (input.mode === 'once' && !input.requestedGrantExpiresAt) {
    throw new CredentialAskRejectedError('invalid_input', 'a "once" credential ask requires requestedGrantExpiresAt');
  }
  // #778 S1: an Invalid Date would otherwise reach the store — the in-memory
  // store keeps it silently, node-pg serialises it to "0NaN-…" and Postgres
  // rejects it with 22007, which surfaces as a 500 instead of a 400.
  if (input.requestedGrantExpiresAt !== undefined && !isValidDate(input.requestedGrantExpiresAt)) {
    throw new CredentialAskRejectedError('invalid_input', 'requestedGrantExpiresAt must be a valid date');
  }
  if (!isValidDate(input.askExpiresAt)) {
    throw new CredentialAskRejectedError('invalid_input', 'askExpiresAt must be a valid date');
  }
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * Whether an ask can still be approved or denied, evaluated against a
 * caller-supplied `now` — never the row's own clock, for the same
 * #709/#710 reason {@link isGrantActive} states in `credentials.ts`.
 */
export function isAskActionable(ask: CredentialAsk, now: Date): boolean {
  return ask.status === 'pending' && ask.askExpiresAt.getTime() > now.getTime();
}

export interface CredentialAskStore {
  createAsk(input: NewCredentialAskInput): Promise<CredentialAsk>;
  getAsk(id: CredentialAskId): Promise<CredentialAsk | undefined>;
  /** Only asks that are BOTH `status = 'pending'` AND unexpired at `now` —
   *  an owner's inbox should not show an ask that has quietly timed out. */
  listPendingForOwner(owner: Principal, now: Date): Promise<readonly CredentialAsk[]>;
  listForRequester(requester: Principal): Promise<readonly CredentialAsk[]>;
  /**
   * Atomically claims the ask (`pending` → `approved`, only if still
   * actionable at `now`) and, on a successful claim, creates the
   * corresponding `CredentialGrant`. Returns `undefined` — never throws —
   * when the ask was already resolved or had expired by `now`: that is an
   * ordinary outcome (a lost race, a slow approver), not a store failure.
   *
   * #778 S1: the claim re-checks the credential. If it has since been
   * revoked, deleted or otherwise stopped being askable, the ask is closed
   * as `expired`, no grant is created, and this also returns `undefined`.
   */
  approve(id: CredentialAskId, resolvedBy: string, now: Date): Promise<CredentialAsk | undefined>;
  /** Same claim semantics as {@link approve}, without creating a grant. */
  deny(id: CredentialAskId, resolvedBy: string, now: Date): Promise<CredentialAsk | undefined>;
  /** The requester withdrawing their own still-pending ask.
   *  @returns whether a row was actually cancelled. */
  cancel(id: CredentialAskId, requester: Principal): Promise<boolean>;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${String(idCounter)}_${String(Date.now())}`;
}

function principalsMatch(a: Principal, b: Principal): boolean {
  if (a.kind !== b.kind) return false;
  const refA = a.kind === 'user' ? a.userId : a.roleKey;
  const refB = b.kind === 'user' ? b.userId : b.roleKey;
  return refA.trim().toLowerCase() === refB.trim().toLowerCase();
}

/**
 * An in-memory {@link CredentialAskStore} for tests and pool-less
 * deployments — same explicit, documented trade-off as
 * `InMemoryCredentialStore`: asks and their resolutions do not survive a
 * restart.
 */
export class InMemoryCredentialAskStore implements CredentialAskStore {
  private readonly asks = new Map<string, CredentialAsk>();

  constructor(private readonly credentials: CredentialStore) {}

  async createAsk(input: NewCredentialAskInput): Promise<CredentialAsk> {
    validateNewAskInput(input);
    const credential = await this.credentials.getCredential(input.credentialId);
    if (!credential) {
      throw new CredentialAskRejectedError('unknown_credential', `unknown credential: ${input.credentialId}`);
    }
    assertAskableCredential(credential);
    const owner = resolveAskOwner(credential, input.owner);

    const id = nextId('ask');
    const ask: CredentialAsk = {
      id,
      credentialId: input.credentialId,
      requester: input.requester,
      owner,
      purpose: input.purpose,
      mode: input.mode,
      requestedGrantExpiresAt: input.requestedGrantExpiresAt,
      askExpiresAt: input.askExpiresAt,
      status: 'pending',
      createdAt: new Date(),
    };
    this.asks.set(id, ask);
    return ask;
  }

  async getAsk(id: CredentialAskId): Promise<CredentialAsk | undefined> {
    return this.asks.get(id);
  }

  async listPendingForOwner(owner: Principal, now: Date): Promise<readonly CredentialAsk[]> {
    return Array.from(this.asks.values()).filter(
      (ask) => principalsMatch(ask.owner, owner) && isAskActionable(ask, now),
    );
  }

  async listForRequester(requester: Principal): Promise<readonly CredentialAsk[]> {
    return Array.from(this.asks.values()).filter((ask) => principalsMatch(ask.requester, requester));
  }

  async approve(id: CredentialAskId, resolvedBy: string, now: Date): Promise<CredentialAsk | undefined> {
    const ask = this.asks.get(id);
    if (!ask || !isAskActionable(ask, now)) return undefined;
    // Claim first (single-threaded here, but the shape matches the
    // Postgres store's atomic UPDATE so both back ends have identical
    // semantics for a caller that races two approvals).
    const claimed: CredentialAsk = { ...ask, status: 'approved', resolvedAt: now, resolvedBy };
    this.asks.set(id, claimed);

    // #778 S1 — the credential may have been revoked since the ask was made.
    const credential = await this.credentials.getCredential(ask.credentialId);
    if (!isStillAskable(credential)) {
      this.asks.set(id, { ...claimed, status: 'expired' });
      return undefined;
    }

    const grantInput: NewCredentialGrantInput = {
      credentialId: ask.credentialId,
      principal: ask.requester,
      mode: ask.mode,
      purpose: ask.purpose,
      grantedBy: resolvedBy,
      expiresAt: ask.requestedGrantExpiresAt,
    };
    const grant = await this.credentials.createGrant(grantInput);
    const withGrant: CredentialAsk = { ...claimed, grantId: grant.id };
    this.asks.set(id, withGrant);
    return withGrant;
  }

  async deny(id: CredentialAskId, resolvedBy: string, now: Date): Promise<CredentialAsk | undefined> {
    const ask = this.asks.get(id);
    if (!ask || !isAskActionable(ask, now)) return undefined;
    const denied: CredentialAsk = { ...ask, status: 'denied', resolvedAt: now, resolvedBy };
    this.asks.set(id, denied);
    return denied;
  }

  async cancel(id: CredentialAskId, requester: Principal): Promise<boolean> {
    const ask = this.asks.get(id);
    if (!ask || ask.status !== 'pending' || !principalsMatch(ask.requester, requester)) return false;
    this.asks.set(id, { ...ask, status: 'cancelled', resolvedAt: new Date() });
    return true;
  }
}

/**
 * Asks only make sense against a `personal` credential: a `service`
 * credential has no single owner to ask, it is reached through the broker
 * (phase 2) under an administratively-issued grant. Shared by both store
 * implementations so the rule cannot drift between them.
 *
 * #778 S1: the owner must be a `user` principal. Approval is bound to the
 * session principal, which is always a user — an ask addressed to a `role`
 * owner could never be answered by anyone.
 */
export function assertAskableCredential(credential: AskableCredentialFacts): void {
  if (credential.kind !== 'personal') {
    throw new CredentialAskRejectedError(
      'not_askable',
      `credential ${credential.id} is not askable (kind=${credential.kind}, expected "personal")`,
    );
  }
  if (credential.owner?.kind !== 'user') {
    throw new CredentialAskRejectedError(
      'not_askable',
      `credential ${credential.id} is not askable (its owner is not a user who could approve)`,
    );
  }
  if (credential.revokedAt) {
    throw new CredentialAskRejectedError('revoked', `credential ${credential.id} is revoked`);
  }
}

/**
 * The owner an ask against `credential` is addressed to: always the
 * credential's own owner, canonicalised (`InMemoryCredentialStore` stores
 * owners verbatim). A `requested` owner is only a cross-check — naming
 * anyone else throws `owner_mismatch`, so a requester can never route an
 * ask (and with it the power to approve) to a principal of their choosing.
 */
export function resolveAskOwner(credential: AskableCredentialFacts, requested?: Principal): Principal {
  const owner = credential.owner;
  if (!owner) {
    throw new CredentialAskRejectedError('not_askable', `credential ${credential.id} has no owner`);
  }
  const canonical = canonicalPrincipal(owner);
  if (requested) {
    const wanted = canonicalPrincipal(requested);
    if (wanted.kind !== canonical.kind || principalRef(wanted) !== principalRef(canonical)) {
      throw new CredentialAskRejectedError(
        'owner_mismatch',
        `the requested owner is not the owner of credential ${credential.id}`,
      );
    }
  }
  return canonical;
}

function canonicalPrincipal(principal: Principal): Principal {
  const ref = canonicalizePrincipalRef(principal.kind, principalRef(principal));
  return principal.kind === 'user' ? { kind: 'user', userId: ref } : { kind: 'role', roleKey: ref };
}

/** The approve-time re-check: a missing credential, or one that fails
 *  {@link assertAskableCredential}, can no longer be granted. Any error
 *  that is NOT a domain rejection propagates. */
export function isStillAskable(credential: AskableCredentialFacts | undefined): boolean {
  if (!credential) return false;
  try {
    assertAskableCredential(credential);
    return true;
  } catch (err) {
    if (err instanceof CredentialAskRejectedError) return false;
    throw err;
  }
}
